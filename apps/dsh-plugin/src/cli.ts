/**
 * cc-migrate DSH plugin — bundled agent CLI (`lib/cli.js`).
 *
 * 对话式迁移的执行通道（skills/cc-migrate/SKILL.md 教 agent 用的就是它）：
 * DSH 用户只装了本插件 tgz（零依赖形态，`@cc-migrate/cli` 不随包分发），
 * agent 的 bash 拿不到独立 CLI —— 本文件把命令层（src/commands.ts 纯函数）
 * 包成一个 `node <插件目录>/lib/cli.js <cmd>` 可调的进程入口，宿主半 bundle
 * 时一起打进 lib/，skill 注册时把该文件的绝对路径替换进 skill 正文
 * （{{CLI_PATH}} 占位符），agent 无需任何全局安装即可驱动迁移。
 *
 * 与独立 CLI（packages/cli）的分工：本入口目标钉死 any→dsh（插件边界），
 * 只暴露对话式迁移够用的四个命令；verify/reconcile/wizard 等维护面仍在
 * 独立 CLI。flag 语义与独立 CLI 的 list/migrate 保持一致（--json/--cwd/
 * --limit），两边的 README 都写明。
 *
 * 输出契约（agent 友好）：
 *  - 成功：stdout 人类可读行；`--json` 时整段 stdout 是一个合法 JSON 值。
 *  - 失败：stderr 一行 `error: ...`，退出码 1。永不写源端，只写全新会话。
 */

import { homedir } from 'node:os';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { builtinRegistry, readSource, summarizeIr, findMigrationsBySource, readMigrationLog } from '@cc-migrate/core';

import { formatSessionLine, importSession, listSources, parseArgs, preview, SOURCE_TOOLS } from './index.js';

const USAGE = `cc-migrate dsh-plugin agent CLI — migrate any tool's session into DSH (read-old-write-new)

usage: node cli.js <command> [args] [flags]

commands:
  tools                                  list source tool ids (one per line)
  list <tool> [--root <dir>] [--cwd <dir>] [--search <kw|id>] [--since <7d|ISO>] [--before <...>] [--limit N] [--json]
                                         list a source tool's sessions (newest first; default cap 50, --limit 0 unlimited, titles capped at 120 chars; --cwd matches the same project = equal or ancestor/descendant; --search matches title substring or session-id fragment)
  preview <tool> <sessionId> [--root <dir>] [--json] [--messages K] [--lines N] [--full]
                                         --json: bounded decision digest (~1-2KB: counts + <=200-char excerpts)
                                         text: offline preview, first 120 lines (--lines N) unless --full
  migrate <tool> <sessionId> [--src-root <dir>] [--cwd <dir>] [--root <dstRoot>]
                  [--session-id <id>] [--flatten|--no-flatten] [--keep-runtime-context] [--json]
                                         write the session into DSH as a BRAND-NEW resumable session
  skill install [--agent <id,id>|--all] [--dir <path>] [--json]
                                         install the UNIVERSAL cc-migrate skill (standalone-CLI flavor) into agent frameworks' skill dirs
  skill status [--json]                  show per-framework install status
  log list [--limit N] [--json]          recent migrations (~/.cc-migrate/migrations.jsonl; CC_MIGRATE_LOG overrides)
  log check <tool> <sessionId> [--json]  has this source session been migrated? (JSON: migrated field)

tools: ${SOURCE_TOOLS.join(', ')}
target is always dsh; every migrate mints a fresh session id — nothing is ever overwritten or deleted.

context-window discipline: prefer list --limit 20 --json; confirm sessions with preview --json (bounded digest);
never pull a full transcript into context (--full only when the user explicitly asks for it).

examples:
  node cli.js list claude --cwd "D:\\codes\\myproj" --limit 10 --json
  node cli.js preview claude 84c74b02-5ad2-4226-831d-98dc2a10c2ff --json
  node cli.js migrate claude 84c74b02-5ad2-4226-831d-98dc2a10c2ff --cwd "D:\\codes\\myproj" --json`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** win32/darwin 路径大小写不敏感（与独立 CLI 同语义）。 */
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';

function normPath(p: string): string {
  const unified = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return CASE_INSENSITIVE_PATHS ? unified.toLowerCase() : unified;
}

function flagString(flags: Record<string, string | true>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function parseLimit(flags: Record<string, string | true>): number | undefined {
  const raw = flagString(flags, 'limit');
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) fail(`--limit expects a non-negative integer (0 = unlimited), got "${raw}"`);
  return n;
}

/** list 标题体量上限（与独立 CLI 同一预算：≤120 字符、压平空白）。 */
const TITLE_CAP = 120;

function capTitle(title: string | undefined): string | undefined {
  if (title === undefined) return undefined;
  const flat = title.replace(/\s+/g, ' ').trim();
  return flat.length > TITLE_CAP ? `${flat.slice(0, TITLE_CAP - 1)}…` : (flat || undefined);
}

/** list 默认条数上限（--limit 0 解除）。 */
const LIST_DEFAULT_LIMIT = 50;

/**
 * 「同一项目」判定（与独立 CLI 同语义）：归一化后相等或互为祖先/后代
 * （带路径边界，防 D:\demo 误命中 D:\demoX）。
 */
function sameProject(sessionCwd: string, queryCwd: string): boolean {
  const a = normPath(sessionCwd);
  const b = normPath(queryCwd);
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

/** --search：标题子串或 sessionId 片段（含尾 8 位这类形态），大小写不敏感。 */
function matchSearch(m: { title?: string; sessionId: string }, query: string): boolean {
  const q = query.toLowerCase();
  return (m.title !== undefined && m.title.toLowerCase().includes(q)) || m.sessionId.toLowerCase().includes(q);
}

/** --since/--before 时间表达式（12h / 7d / 2w 或 ISO 日期），epoch ms。 */
function parseTimeExpr(raw: string, flag: string): number {
  const rel = /^(\d+)(h|d|w)$/i.exec(raw);
  if (rel) {
    const n = Number.parseInt(rel[1], 10);
    const unitMs = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2].toLowerCase() as 'h' | 'd' | 'w'];
    return Date.now() - n * unitMs;
  }
  const abs = Date.parse(raw);
  if (Number.isFinite(abs)) return abs;
  fail(`${flag} expects a relative time (12h / 7d / 2w) or an ISO date (2026-08-01), got "${raw}"`);
}

/* ── skill install：通用 skill 安装器（与独立 CLI 同表，插件内也可用）────────
 * DSH 用户通常不需要（插件已注册运行时 skill），但保留同一入口让「插件 CLI」
 * 成为完整执行器：其他框架的 skill 也能由它安装。
 */
interface SkillTarget {
  id: string;
  homeCandidates: string[];
  skillDir: string;
}

const SKILL_TARGETS: SkillTarget[] = [
  { id: 'agents', homeCandidates: ['.agents'], skillDir: '.agents/skills' },
  { id: 'claude', homeCandidates: ['.claude'], skillDir: '.claude/skills' },
  { id: 'zcode', homeCandidates: ['.zcode'], skillDir: '.zcode/skills' },
  { id: 'dsh', homeCandidates: ['.dsh'], skillDir: '.dsh/skills' },
  { id: 'pi', homeCandidates: ['.pi'], skillDir: '.pi/agent/skills' },
  { id: 'codex', homeCandidates: ['.codex'], skillDir: '.codex/skills' },
  { id: 'opencode', homeCandidates: ['.config/opencode', '.opencode'], skillDir: '.config/opencode/skill' },
];

const SKILL_NAME = 'cc-migrate';

/** 随包分发的通用 SKILL.md 副本（lib/cli.js → ../skills/universal/...；build 期由 sync-universal-skill.mjs 从独立 CLI 同步）。 */
function bundledSkillPath(): string {
  return fileURLToPath(new URL('../skills/universal/SKILL.md', import.meta.url));
}

interface SkillInstallRow {
  id: string;
  action: 'installed' | 'skipped';
  path?: string;
  reason?: string;
}

/** 把通用 skill 装进目标框架的 skill 目录（只写 cc-migrate/ 子目录，绝不删除）。 */
function runSkillInstall(flags: Record<string, string | true>): void {
  const src = bundledSkillPath();
  if (!existsSync(src)) {
    fail(`bundled universal SKILL.md missing at ${src} — reinstall the plugin package (build syncs it from packages/cli)`);
  }
  const rows: SkillInstallRow[] = [];
  const dirFlag = flagString(flags, 'dir');
  if (dirFlag) {
    const dir = isAbsolute(dirFlag) ? dirFlag : resolve(dirFlag);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, 'SKILL.md');
    copyFileSync(src, dest);
    rows.push({ id: 'custom', action: 'installed', path: dest });
  } else {
    let targets: SkillTarget[];
    const agentFlag = flagString(flags, 'agent') ?? (flags.agent === true ? 'all' : undefined);
    if (agentFlag === 'all' || agentFlag === undefined) {
      // 默认与 --all 同义：所有「home 已存在」的框架（不为未装的框架凭空建 home）
      targets = SKILL_TARGETS.filter((t) => t.homeCandidates.some((h) => existsSync(join(homedir(), h))));
      if (agentFlag === undefined && targets.length === 0) {
        fail('no supported agent home detected (~/.claude ~/.zcode ~/.agents ~/.dsh ~/.pi ~/.codex ~/.config/opencode) — use --dir <path> or --agent <id>');
      }
    } else {
      targets = [];
      for (const id of agentFlag.split(',').map((s) => s.trim()).filter(Boolean)) {
        const t = SKILL_TARGETS.find((x) => x.id === id);
        if (!t) fail(`unknown agent "${id}" — available: ${SKILL_TARGETS.map((x) => x.id).join(', ')}`);
        targets.push(t);
      }
    }
    for (const t of targets) {
      const dir = join(homedir(), t.skillDir, SKILL_NAME);
      try {
        mkdirSync(dir, { recursive: true });
        copyFileSync(src, join(dir, 'SKILL.md'));
        rows.push({ id: t.id, action: 'installed', path: join(dir, 'SKILL.md') });
      } catch (e) {
        rows.push({ id: t.id, action: 'skipped', reason: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  if (flags.json) {
    console.log(JSON.stringify({ ok: true, source: src, results: rows }, null, 2));
    return;
  }
  console.log(`source: ${src}`);
  for (const r of rows) {
    if (r.action === 'installed') console.log(`installed ${r.id}: ${r.path}`);
    else console.log(`skipped  ${r.id}: ${r.reason ?? 'unknown reason'}`);
  }
}

async function main(argv: string[]): Promise<void> {
  const { positionals, flags } = parseArgs(argv);
  const [cmd, a, b, c] = positionals;

  switch (cmd) {
    case 'tools': {
      for (const t of SOURCE_TOOLS) console.log(t);
      return;
    }

    case 'list': {
      if (!a) fail(`list requires a tool id — one of: ${SOURCE_TOOLS.join(', ')}`);
      const res = await listSources(a, flagString(flags, 'root') ?? flagString(flags, 'src-root'));
      if (!res.ok) fail(res.error);
      let sessions = res.sessions;
      const search = flagString(flags, 'search');
      if (search) sessions = sessions.filter((m) => matchSearch(m, search));
      const cwd = flagString(flags, 'cwd');
      if (cwd) sessions = sessions.filter((m) => m.cwd !== undefined && sameProject(m.cwd, cwd));
      const sinceRaw = flagString(flags, 'since');
      const since = sinceRaw === undefined ? undefined : parseTimeExpr(sinceRaw, '--since');
      if (since !== undefined) sessions = sessions.filter((m) => (m.createdAt ?? 0) >= since);
      const beforeRaw = flagString(flags, 'before');
      const before = beforeRaw === undefined ? undefined : parseTimeExpr(beforeRaw, '--before');
      if (before !== undefined) sessions = sessions.filter((m) => (m.createdAt ?? 0) < before);
      sessions = [...sessions].sort((x, y) => (y.createdAt ?? 0) - (x.createdAt ?? 0));
      // 上下文体量预算（与独立 CLI 同款）：默认 50 条封顶（--limit 0 解除），标题 ≤120 字符
      const total = sessions.length;
      const limit = parseLimit(flags) ?? LIST_DEFAULT_LIMIT;
      if (limit > 0) sessions = sessions.slice(0, limit);
      const capped = sessions.map((m) => ({ ...m, ...(m.title !== undefined ? { title: capTitle(m.title) } : {}) }));
      if (flags.json) {
        console.log(JSON.stringify({ ok: true, tool: res.tool, count: capped.length, total, sessions: capped }, null, 2));
        return;
      }
      for (const [i, m] of capped.entries()) console.log(formatSessionLine(i, m));
      if (limit > 0 && total > capped.length) {
        console.error(`[list] 共 ${total} 条命中，已按默认上限显示 ${capped.length} 条 —— 收紧 --search/--cwd/--since 或 --limit 0 看全部`);
      }
      return;
    }

    case 'preview': {
      if (!a || !b) fail('usage: preview <tool> <sessionId> [--root <dir>] [--json] [--messages K] [--lines N] [--full]');
      if (flags.json) {
        // 上下文安全的决策摘要（≈1-2KB）：计数 + ≤200 字摘录，绝不输出全文。
        const registry = builtinRegistry();
        let ir;
        try {
          ir = await readSource(registry, a, b, flagString(flags, 'root') ?? flagString(flags, 'src-root'));
        } catch (e) {
          // --json 面向 agent：失败也保持一行 error（不吐 stack，省上下文）
          fail(e instanceof Error ? e.message : String(e));
        }
        const messagesRaw = flagString(flags, 'messages');
        const firstUser = messagesRaw === undefined ? undefined : Number.parseInt(messagesRaw, 10);
        if (firstUser !== undefined && (!Number.isFinite(firstUser) || firstUser < 0 || firstUser > 20)) {
          fail(`--messages expects an integer in 0..20, got "${messagesRaw}"`);
        }
        console.log(JSON.stringify(summarizeIr(ir, { ...(firstUser !== undefined ? { firstUserMessages: firstUser } : {}) }), null, 2));
        return;
      }
      const res = await preview(a, b, flagString(flags, 'root') ?? flagString(flags, 'src-root'));
      if (!res.ok) fail(res.error);
      if (flags.full) {
        process.stdout.write(res.text);
        return;
      }
      const linesRaw = flagString(flags, 'lines');
      const HEAD = linesRaw === undefined ? 120 : Number.parseInt(linesRaw, 10);
      if (!Number.isFinite(HEAD) || HEAD <= 0) fail(`--lines expects a positive integer, got "${linesRaw}"`);
      const lines = res.text.split('\n');
      for (const l of lines.slice(0, HEAD)) process.stdout.write(l + '\n');
      if (lines.length > HEAD) console.error(`[preview] 共 ${lines.length} 行，已显示前 ${HEAD} 行 —— agent 请改用 --json 摘要；--full 全文`);
      return;
    }

    case 'skill': {
      const sub = a;
      if (sub === 'install') {
        runSkillInstall(flags);
        return;
      }
      if (sub === 'status') {
        const src = bundledSkillPath();
        const rows = SKILL_TARGETS.map((t) => ({
          id: t.id,
          homeFound: t.homeCandidates.some((h) => existsSync(join(homedir(), h))),
          installed: existsSync(join(homedir(), t.skillDir, SKILL_NAME, 'SKILL.md')),
          path: join(homedir(), t.skillDir, SKILL_NAME),
        }));
        if (flags.json) {
          console.log(JSON.stringify({ ok: true, source: existsSync(src) ? src : null, targets: rows }, null, 2));
          return;
        }
        console.log(`source: ${src}${existsSync(src) ? '' : '  (MISSING — run the plugin build to sync it)'}`);
        for (const r of rows) {
          const state = r.installed ? 'installed' : r.homeFound ? 'not installed' : 'agent not detected';
          console.log(`${state.padEnd(18)} ${r.id.padEnd(9)} ${r.path}`);
        }
        return;
      }
      fail('usage: skill <install|status> [--agent <id,id>|--all] [--dir <path>] [--json]');
    }

    case 'migrate': {
      if (!a || !b) fail('usage: migrate <tool> <sessionId> [--src-root <dir>] [--cwd <dir>] [--root <dstRoot>] [--json]');
      // --no-flatten 显式关；--flatten [true] 开；--flatten false 也算关；
      // 两者都缺省 → 不传（命令层自选默认）。
      const flattenOpt = flags['no-flatten'] !== undefined
        ? false
        : flags.flatten === undefined
          ? undefined
          : flags.flatten !== 'false';
      const res = await importSession(a, b, {
        srcRoot: flagString(flags, 'src-root'),
        targetCwd: flagString(flags, 'cwd'),
        sessionId: flagString(flags, 'session-id'),
        root: flagString(flags, 'root') ?? flagString(flags, 'dst-root'),
        ...(flattenOpt !== undefined ? { flatten: flattenOpt } : {}),
        ...(flags['keep-runtime-context'] ? { keepSynthetic: true } : {}),
      });
      if (!res.ok) fail(res.error);
      if (flags.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(`migrated ${res.source.tool}:${res.source.sessionId} -> dsh:${res.target.sessionId}`);
      for (const p of res.target.paths) console.log(`  ${p}`);
      return;
    }

    case 'log': {
      // 迁移日志查询（与独立 CLI 同一份 ~/.cc-migrate/migrations.jsonl）
      if (a === 'list') {
        const records = await readMigrationLog();
        records.sort((x, y) => y.ts - x.ts);
        const limit = parseLimit(flags) ?? 20;
        const rows = limit > 0 ? records.slice(0, limit) : records;
        if (flags.json) {
          console.log(JSON.stringify({ ok: true, count: rows.length, total: records.length, records: rows }, null, 2));
          return;
        }
        for (const r of rows) {
          console.log(`${new Date(r.ts).toISOString()}\t${r.source.tool}:${r.source.sessionId} -> ${r.target.tool}:${r.target.sessionId}\t(via ${r.via})`);
        }
        if (limit > 0 && records.length > rows.length) console.error(`[log] 共 ${records.length} 条，已显示最近 ${rows.length} 条 —— --limit 0 看全部`);
        return;
      }
      if (a === 'check' && b && c) {
        const records = await findMigrationsBySource(b, c);
        if (flags.json) {
          console.log(JSON.stringify({ ok: true, migrated: records.length > 0, source: { tool: b, sessionId: c }, records }, null, 2));
          return;
        }
        if (records.length === 0) {
          console.log(`not migrated: ${b}:${c}（迁移日志无记录；桌面 App 迁移暂不进日志）`);
          return;
        }
        console.log(`migrated ${records.length} time(s):`);
        for (const r of records) console.log(`  -> ${r.target.tool}:${r.target.sessionId} @ ${new Date(r.ts).toISOString()} (via ${r.via})`);
        return;
      }
      fail('usage: log <list|check> [--limit N] [--json]\n  log check <srcTool> <srcSessionId> — "has this been migrated?" (--json: migrated field)');
    }

    case '--help':
    case '-h':
    case 'help':
    case undefined:
      console.log(USAGE);
      return;

    default:
      fail(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
