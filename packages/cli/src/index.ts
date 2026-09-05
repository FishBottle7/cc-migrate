#!/usr/bin/env node
/**
 * cc-migrate CLI.
 *
 * Usage:
 *   cc-migrate tools
 *   cc-migrate list <tool> [--root <dir>] [--cwd <dir>] [--limit N] [--json]
 *   cc-migrate preview <tool> <sessionId> [--root <dir>] [--json] [--messages K] [--lines N] [--full]
 *   cc-migrate migrate <srcTool> <srcSessionId> <dstTool>
 *                    [--src-root <dir>] [--dst-root <dir>] [--target-cwd <path>]
 *                    [--keep-runtime-context] [--json]
 *   cc-migrate skill install [--agent <id,id>|--all] [--dir <path>] [--json]
 *   cc-migrate skill status [--json]
 *   cc-migrate skill path
 *   cc-migrate wizard [--src-root <dir>] [--dst-root <dir>]  # interactive
 *   cc-migrate reconcile dsh [--root <dir>]  # fix workspace.json registration
 *   cc-migrate verify dsh [--root <dir>] [sessionId]  # validate artifacts
 *   cc-migrate demo      # dsh->dsh self round-trip
 *   cc-migrate demo2     # claude<->dsh round-trip in a temp dir
 *
 * Agent-facing surface (the skill at skills/cc-migrate/SKILL.md teaches this):
 * `--json` everywhere emits machine-readable output; `preview --json` is a
 * strictly bounded digest (~1-2KB) so an agent can confirm "is this the
 * session" without pulling a transcript into its context window; `list` caps
 * at 50 items / 120-char titles unless `--limit 0` lifts the cap; `--cwd`
 * filters a listing to one project.
 */

import { homedir } from 'node:os';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { builtinRegistry } from '@cc-migrate/core';
import type { AdapterRegistry, SessionMeta } from '@cc-migrate/core';
import {
  previewSession,
  readSource,
  writeTarget,
  listSessions,
  fallbackIr,
  summarizeIr,
} from '@cc-migrate/core';

interface Flags {
  srcRoot?: string;
  dstRoot?: string;
  targetCwd?: string;
  root?: string;
  flatten?: boolean;
  keepSynthetic?: boolean;
  systemPromptSource?: 'source' | 'target';
  /** list: 只看这个项目（cwd 归一化后匹配；无 cwd 信息的会话被排除） */
  cwd?: string;
  /** list: 最多显示 N 条（createdAt 降序；0 = 不限；缺省 50） */
  limit?: number;
  /** list/migrate/preview/skill: 机器可读 JSON 输出 */
  json?: boolean;
  /** preview --json: 摘要携带的开头用户消息条数（默认 3，0-20） */
  messages?: number;
  /** preview 文本模式的行数上限（默认 120） */
  lines?: number;
  /** preview: 打印全文（默认仅前 120 行 —— 终端渲染 MB 级文本极慢） */
  full?: boolean;
  /** skill install: 指定目标框架 id（逗号分隔）或 --all */
  agent?: string;
  /** skill install: 自定义安装目录（安装为 <dir>/SKILL.md） */
  dir?: string;
}

/** win32/darwin 路径大小写不敏感；posix 保留大小写。 */
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';

function normPath(p: string): string {
  const unified = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return CASE_INSENSITIVE_PATHS ? unified.toLowerCase() : unified;
}

/** list 输出的标题体量上限：压平空白 + 截断（上下文预算：50 条 × ≤120 字符标题）。 */
const TITLE_CAP = 120;

function capTitle(title: string | undefined): string | undefined {
  if (title === undefined) return undefined;
  const flat = title.replace(/\s+/g, ' ').trim();
  return flat.length > TITLE_CAP ? `${flat.slice(0, TITLE_CAP - 1)}…` : (flat || undefined);
}

/** list 的默认条数上限（--limit 0 解除）。 */
const LIST_DEFAULT_LIMIT = 50;

function parseFlags(argv: string[]): { flags: Flags; positionals: string[] } {
  const f: Flags = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const value = (name: string) => (i + 1 < argv.length ? argv[++i] : undefined);
    if (tok === '--root') f.root = value('root');
    else if (tok === '--src-root') f.srcRoot = value('src-root');
    else if (tok === '--dst-root') f.dstRoot = value('dst-root');
    else if (tok === '--target-cwd') f.targetCwd = value('target-cwd');
    else if (tok === '--cwd') f.cwd = value('cwd');
    else if (tok === '--agent') f.agent = value('agent');
    else if (tok === '--dir') f.dir = value('dir');
    else if (tok === '--limit') {
      const n = Number.parseInt(value('limit') ?? '', 10);
      if (!Number.isFinite(n) || n < 0) {
        console.error('--limit expects a non-negative integer (0 = unlimited)');
        process.exit(1);
      }
      f.limit = n;
    } else if (tok === '--messages') {
      const n = Number.parseInt(value('messages') ?? '', 10);
      if (!Number.isFinite(n) || n < 0 || n > 20) {
        console.error('--messages expects an integer in 0..20');
        process.exit(1);
      }
      f.messages = n;
    } else if (tok === '--lines') {
      const n = Number.parseInt(value('lines') ?? '', 10);
      if (!Number.isFinite(n) || n <= 0) {
        console.error('--lines expects a positive integer');
        process.exit(1);
      }
      f.lines = n;
    } else if (tok === '--json') f.json = true;
    else if (tok === '--flatten') f.flatten = value('flatten') !== 'false';
    else if (tok === '--no-flatten') f.flatten = false;
    else if (tok === '--keep-runtime-context') f.keepSynthetic = true;
    else if (tok === '--system-prompt') {
      const v = value('system-prompt');
      if (v !== 'source' && v !== 'target') {
        console.error(`--system-prompt must be "source" or "target", got "${v}"`);
        process.exit(1);
      }
      f.systemPromptSource = v;
    } else if (tok === '--full') f.full = true;
    else positionals.push(tok);
  }
  return { flags: f, positionals };
}

/* ── skill install：把通用 SKILL.md 装进各 agent 框架的 skill 目录 ────────
 *
 * 通用 skill 是跨框架的（Claude Code / ZCode / DSH / pi / codex / opencode
 * 都读「目录 + SKILL.md + frontmatter」这一约定），差别只在各自的用户级根
 * 目录。目标表只做「探测 + 安装到我们的 cc-migrate/ 子目录」：绝不碰其他
 * skill，也绝不删除任何东西（卸载 = 人手动删目录，README 有说明）。
 */
interface SkillTarget {
  id: string;
  /** 探测框架是否存在的 home 子目录候选（任一存在即视为已装该框架）。 */
  homeCandidates: string[];
  /** 该框架用户级 skill 根（相对 home）。 */
  skillDir: string;
  note: string;
}

const SKILL_TARGETS: SkillTarget[] = [
  { id: 'agents', homeCandidates: ['.agents'], skillDir: '.agents/skills', note: '跨工具共享 skill 根（ZCode/DSH/Claude 等都读）' },
  { id: 'claude', homeCandidates: ['.claude'], skillDir: '.claude/skills', note: 'Claude Code 用户级 skills' },
  { id: 'zcode', homeCandidates: ['.zcode'], skillDir: '.zcode/skills', note: 'ZCode 用户级 skills' },
  { id: 'dsh', homeCandidates: ['.dsh'], skillDir: '.dsh/skills', note: 'DSH 用户级 skills（装了 cc-migrate 插件时其运行时 skill 优先生效）' },
  { id: 'pi', homeCandidates: ['.pi'], skillDir: '.pi/agent/skills', note: 'pi 用户级 skills' },
  { id: 'codex', homeCandidates: ['.codex'], skillDir: '.codex/skills', note: 'Codex CLI skills' },
  { id: 'opencode', homeCandidates: ['.config/opencode', '.opencode'], skillDir: '.config/opencode/skill', note: 'OpenCode 全局 skill（目录名为单数）' },
];

const SKILL_NAME = 'cc-migrate';

/** 随包分发的通用 SKILL.md。仓库布局（bundle/index.js → ../../skills）与
 * npm 安装布局（node_modules/@cc-migrate/cli/bundle/index.js → ../skills）
 * 深度不同 —— 依次探测两个候选。 */
function bundledSkillPath(): string {
  const here = import.meta.url;
  for (const rel of ['../../skills/cc-migrate/SKILL.md', '../skills/cc-migrate/SKILL.md']) {
    const p = fileURLToPath(new URL(rel, here));
    if (existsSync(p)) return p;
  }
  return fileURLToPath(new URL('../skills/cc-migrate/SKILL.md', here));
}

function targetSkillDir(t: SkillTarget): string {
  return join(homedir(), t.skillDir, SKILL_NAME);
}

interface SkillInstallRow {
  id: string;
  action: 'installed' | 'skipped';
  path?: string;
  reason?: string;
}

function runSkillInstall(flags: Flags, subArgs: string[]): void {
  if (subArgs.length > 0) {
    console.error('usage: cc-migrate skill install [--agent <id,id>|--all] [--dir <path>] [--json]');
    process.exit(1);
  }
  const src = bundledSkillPath();
  if (!existsSync(src)) {
    console.error(`error: bundled SKILL.md missing at ${src} — reinstall the CLI package`);
    process.exit(1);
  }
  const rows: SkillInstallRow[] = [];

  // --dir：自定义目录（用户/agent 明确指定的落点，装为 <dir>/SKILL.md）
  if (flags.dir) {
    const dir = isAbsolute(flags.dir) ? flags.dir : resolve(flags.dir);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, 'SKILL.md');
    copyFileSync(src, dest);
    rows.push({ id: 'custom', action: 'installed', path: dest });
  } else {
    let targets: SkillTarget[];
    if (flags.agent === 'all' || flags.agent === undefined) {
      // 默认与 --all 同义：所有「home 已存在」的框架（不为未装的框架凭空建 home）
      targets = SKILL_TARGETS.filter((t) => t.homeCandidates.some((h) => existsSync(join(homedir(), h))));
      if (flags.agent === undefined && targets.length === 0) {
        console.error('error: no supported agent home detected (~/.claude ~/.zcode ~/.agents ~/.dsh ~/.pi ~/.codex ~/.config/opencode) — use --dir <path> or --agent <id>');
        process.exit(1);
      }
    } else {
      targets = [];
      for (const id of flags.agent.split(',').map((s) => s.trim()).filter(Boolean)) {
        const t = SKILL_TARGETS.find((x) => x.id === id);
        if (!t) {
          console.error(`unknown agent "${id}" — available: ${SKILL_TARGETS.map((x) => x.id).join(', ')}`);
          process.exit(1);
        }
        targets.push(t);
      }
    }
    for (const t of targets) {
      const dir = targetSkillDir(t);
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

function runSkillStatus(flags: Flags): void {
  const src = bundledSkillPath();
  const rows = SKILL_TARGETS.map((t) => {
    const homeFound = t.homeCandidates.some((h) => existsSync(join(homedir(), h)));
    const path = targetSkillDir(t);
    return {
      id: t.id,
      homeFound,
      installed: existsSync(join(path, 'SKILL.md')),
      path,
      note: t.note,
    };
  });
  if (flags.json) {
    console.log(JSON.stringify({ ok: true, source: existsSync(src) ? src : null, targets: rows }, null, 2));
    return;
  }
  console.log(`source: ${src}${existsSync(src) ? '' : '  (MISSING — reinstall the CLI package)'}`);
  for (const r of rows) {
    const state = r.installed ? 'installed' : r.homeFound ? 'not installed' : 'agent not detected';
    console.log(`${state.padEnd(18)} ${r.id.padEnd(9)} ${r.path}`);
  }
  console.log('\ninstall: cc-migrate skill install [--agent <id>|--all] [--dir <path>]');
}

async function main(argv: string[]) {
  // Separate named flags from positional args FIRST so flags never occupy
  // positional slots (e.g. `list dsh --root X` must keep X out of positionals).
  const { flags, positionals } = parseFlags(argv);
  const [cmd, ...args] = positionals;
  const [a, b, c] = args;
  const registry = builtinRegistry();

  /** registry.get with an agent-friendly unknown-tool error (usage + valid ids). */
  function resolveAdapter(reg: AdapterRegistry, tool: string) {
    try {
      return reg.get(tool as never);
    } catch {
      console.error(`unknown tool "${tool}" — available: ${reg.tools().join(', ')}`);
      process.exit(1);
    }
  }

  switch (cmd) {
    case 'tools': {
      for (const t of registry.tools()) console.log(t);
      return;
    }
    case 'list': {
      if (!a) {
        console.error(`usage: cc-migrate list <tool> [--root <dir>] [--cwd <dir>] [--limit N] [--json]\n  tools: ${registry.tools().join(', ')}`);
        process.exit(1);
      }
      const adapter = resolveAdapter(registry, a);
      let metas = await listSessions(adapter, flags.root ?? flags.srcRoot);
      if (flags.cwd) {
        const needle = normPath(flags.cwd);
        metas = metas.filter((m) => m.cwd !== undefined && normPath(m.cwd) === needle);
      }
      metas = [...metas].sort((x, y) => (y.createdAt ?? 0) - (x.createdAt ?? 0));
      // 上下文体量预算：默认 50 条封顶（--limit 0 解除），标题统一 ≤120 字符
      const total = metas.length;
      const limit = flags.limit === undefined ? LIST_DEFAULT_LIMIT : flags.limit;
      if (limit > 0) metas = metas.slice(0, limit);
      const capped = metas.map((m) => ({ ...m, ...(m.title !== undefined ? { title: capTitle(m.title) } : {}) }));
      if (flags.json) {
        console.log(JSON.stringify(capped, null, 2));
        return;
      }
      for (const m of capped) {
        const archived = m.archived ? '[archived] ' : '';
        console.log(`${archived}${m.sessionId}\t${m.title ?? ''}\t${m.createdAt ? new Date(m.createdAt).toISOString() : ''}\t${m.sourcePath ?? ''}`);
      }
      if (limit > 0 && total > metas.length) {
        console.error(`[list] 共 ${total} 条，已按默认上限显示 ${metas.length} 条 —— 用 --cwd 缩小范围或 --limit 0 看全部`);
      }
      return;
    }
    case 'preview': {
      if (!a || !b) {
        console.error('usage: cc-migrate preview <tool> <sessionId> [--json] [--messages K] [--lines N] [--full]');
        process.exit(1);
      }
      const adapter = resolveAdapter(registry, a);
      const ir = await readSource(registry, a, b, flags.root ?? flags.srcRoot);
      if (flags.json) {
        // 上下文安全的决策摘要（≈1-2KB）：计数 + ≤200 字摘录，绝不输出全文。
        const digest = summarizeIr(ir, {
          ...(flags.messages !== undefined ? { firstUserMessages: flags.messages } : {}),
        });
        console.log(JSON.stringify(digest, null, 2));
        return;
      }
      const text = previewSession(adapter, ir);
      const lines = text.split('\n');
      const HEAD = flags.lines ?? 120;
      if (flags.full || lines.length <= HEAD) {
        if (flags.full && lines.length > HEAD) {
          console.error(`[preview] --full：共 ${lines.length} 行 / ${text.length} 字符 —— 注意上下文体量`);
        }
        process.stdout.write(text);
        return;
      }
      for (const l of lines.slice(0, HEAD)) process.stdout.write(l + '\n');
      console.error(`\n[preview] 共 ${lines.length} 行，已显示前 ${HEAD} 行 —— agent 请改用 --json 摘要；--lines N 调行数；--full 全文`);
      return;
    }
    case 'skill': {
      const sub = a;
      if (sub === 'install') {
        runSkillInstall(flags, args.slice(1));
        return;
      }
      if (sub === 'status') {
        runSkillStatus(flags);
        return;
      }
      if (sub === 'path') {
        console.log(bundledSkillPath());
        return;
      }
      console.error('usage: cc-migrate skill <install|status|path> [--agent <id,id>|--all] [--dir <path>] [--json]');
      process.exit(1);
    }
    case 'migrate': {
      if (!a || !b || !c) {
        console.error('usage: cc-migrate migrate <srcTool> <srcSessionId> <dstTool> [--json]');
        process.exit(1);
      }
      const ir = await readSource(registry, a, b, flags.root ?? flags.srcRoot);
      const adapter = resolveAdapter(registry, c);
      const disambiguateTitle = a === 'dsh' && c === 'dsh';
      const res = await writeTarget(adapter, ir, {
        root: flags.dstRoot,
        targetCwd: flags.targetCwd ?? ir.cwd,
        flatten: flags.flatten,
        keepSynthetic: flags.keepSynthetic,
        ...(flags.systemPromptSource ? { systemPromptSource: flags.systemPromptSource } : {}),
        ...(disambiguateTitle ? { disambiguateTitle: true } : {}),
      });
      if (flags.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(`migrated ${a}:${b} -> ${c}:${res.sessionId}`);
      for (const p of res.paths) console.log(`  ${p}`);
      return;
    }
    case 'reconcile': {
      if (a === 'dsh' || !a) {
        const { reconcileWorkspaces } = await import('@cc-migrate/core/workspace');
        const { defaultDshRoot } = await import('@cc-migrate/core');
        const root = (flags.root ?? flags.dstRoot ?? (defaultDshRoot as unknown as () => string | null)()) as string;
        if (!root) { console.error('cannot resolve DSH sessions root'); process.exit(1); }
        const res = await (reconcileWorkspaces as any)(root);
        console.log(`reconciled ${res.scanned} sessions, registered ${res.registered} orphan(s), pruned ${res.pruned ?? 0} dangling`);
        if (res.errors?.length) for (const e of res.errors) console.error('  ' + e);
        return;
      }
      console.error('usage: cc-migrate reconcile [dsh] [--root <dir>]');
      process.exit(1);
    }
    case 'verify': {
      if (a === 'dsh' || !a) {
        const { verifySessionById, verifyAllSessions } = await import('@cc-migrate/core/verify');
        const { defaultDshRoot } = await import('@cc-migrate/core');
        const root = (flags.root ?? flags.dstRoot ?? (defaultDshRoot as unknown as () => string | null)()) as string | undefined;
        const sid = b;
        const results = sid ? [await verifySessionById(sid, root)] : await verifyAllSessions(root);
        let failed = 0;
        for (const r of results) {
          if (r.ok) {
            const s = r.stats;
            console.log(`OK   ${r.sessionId || '(root)'}  events=${s.events} assistant=${s.assistantMessages} text=${s.textBlocks} reasoning=${s.reasoningBlocks} toolCalls=${s.toolCalls} turns=${s.turns}`);
          } else {
            failed++;
            console.log(`FAIL ${r.sessionId || '(root)'}`);
            for (const issue of r.issues) {
              const at = [issue.line !== undefined ? `line ${issue.line}` : null, issue.seq !== undefined ? `seq ${issue.seq}` : null].filter(Boolean).join(', ');
              console.log(`     [${issue.check}]${at ? ' ' + at : ''}: ${issue.message}`);
            }
          }
        }
        console.log(`verified ${results.length} session(s), ${failed} failing`);
        if (failed > 0) process.exit(1);
        return;
      }
      console.error('usage: cc-migrate verify [dsh] [--root <dir>] [sessionId]');
      process.exit(1);
    }
    case 'wizard':
    case 'interactive':
    case 'wiz': {
      const { runWizard } = await import('./wizard.js');
      const { createInterface } = await import('node:readline');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const io = {
        print: (line: string) => console.log(line),
        question: (prompt: string) => new Promise<string>((resolve) => rl.question(prompt, resolve)),
        close: () => rl.close(),
      };
      // allow preseed via flags for non-TTY callers: e.g. wizard --src-root X uses flags.srcRoot
      const pre: Record<string, unknown> = {};
      if (flags.srcRoot ?? flags.root) pre.srcRoot = flags.srcRoot ?? flags.root;
      if (flags.dstRoot) pre.dstRoot = flags.dstRoot;
      if (flags.targetCwd) pre.targetCwd = flags.targetCwd;
      if (flags.flatten !== undefined) pre.flatten = flags.flatten;
      try {
        const res = await runWizard(io, {
          builtinRegistry,
          previewSession: (await import('@cc-migrate/core')).previewSession as never,
          readSource: (await import('@cc-migrate/core')).readSource as never,
          writeTarget: (await import('@cc-migrate/core')).writeTarget as never,
          listSessions: (await import('@cc-migrate/core')).listSessions as never,
        }, pre as never);
        if (!res) process.exit(1);
      } finally {
        io.close();
      }
      return;
    }
    case 'demo': {
      await runDemo(registry);
      return;
    }
    case 'demo2': {
      await runDemoClaude(registry);
      return;
    }
    default:
      console.error(`usage: cc-migrate <tools|list|preview|migrate|verify|reconcile|wizard|demo|demo2> [...]
  tools: ${registry.tools().join(', ')}`);
      process.exit(1);
  }
}

async function runDemo(registry: ReturnType<typeof builtinRegistry>) {
  const { mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  const ir = fallbackIr();
  const dsh = registry.get('dsh');
  console.log('--- demo: dsh -> dsh self round-trip (temp dir) ---');
  const tmp = await mkdtemp(join(tmpdir(), 'sm-demo-'));
  const res = await writeTarget(dsh, ir, { root: tmp, targetCwd: process.cwd() });
  console.log('wrote:', res.paths);
  const back = await readSource(registry, 'dsh', res.sessionId, tmp);
  console.log('round trip sessionId:', back.originSessionId);
  console.log('messages back:', back.messages.length);
  console.log('first msg role:', back.messages[0]?.role, '\ntext:', (back.messages[0]?.content[0] as { text?: string })?.text);
}

async function runDemoClaude(registry: ReturnType<typeof builtinRegistry>) {
  const { mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  console.log('--- demo2: claude -> dsh -> claude round-trip (temp dirs) ---');
  const claudeRoot = await mkdtemp(join(tmpdir(), 'sm-claude-'));
  const dshRoot = await mkdtemp(join(tmpdir(), 'sm-dsh-'));

  const ir = fallbackIr();

  // IR -> Claude
  const claude = registry.get('claude');
  const w1 = await writeTarget(claude, ir, { root: claudeRoot, targetCwd: 'D:\\demo\\proj' });
  console.log('claude wrote:', w1.paths[0]);
  // Claude -> IR
  const back1 = await readSource(registry, 'claude', w1.sessionId, claudeRoot);
  console.log('claude->ir messages:', back1.messages.length, 'sessionId:', back1.originSessionId);

  // IR(claude-derived) -> DSH
  const dsh = registry.get('dsh');
  const w2 = await writeTarget(dsh, back1, { root: dshRoot, targetCwd: 'D:\\demo\\proj' });
  console.log('dsh wrote:', w2.paths[0]);
  // DSH -> IR
  const back2 = await readSource(registry, 'dsh', w2.sessionId, dshRoot);
  console.log('dsh->ir messages:', back2.messages.length);

  // verify text survives full loop
  const t0 = (ir.messages[0].content[0] as { text: string }).text;
  const t2 = (back2.messages[0].content[0] as { text: string }).text;
  console.log('first msg preserved across claude->dsh loop:', t0 === t2);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e);
  process.exit(1);
});