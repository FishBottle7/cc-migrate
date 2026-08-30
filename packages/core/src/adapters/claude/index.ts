/**
 * Claude Code adapter — `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`
 * (+ `<sessionId>/subagents/agent-*.jsonl` sidechains & `.meta.json` sidecars).
 *
 * 红线 (docs/agents/claude.md §6):
 *  1. NEVER delete, rewrite or append to an existing session file — write only
 *     brand-new files under brand-new sessionIds; skip-and-report on collision;
 *  2. 100% lossless except redacted_thinking.data; thinking.signature rides
 *     byte-for-byte; everything without a typed slot survives in
 *     extensions.claude.recordsRaw;
 *  3. IR.systemPrompt is ignored on write (§5.4/#8) — claude regenerates its
 *     system prompt per resume; the engine carries source prompts via the
 *     --append-system-prompt process flag.
 *
 * listSessions follows the native /resume listing rules (§1/§1.0):
 * filename must be a strict UUID; first line `"isSidechain":true` filters;
 * head `teamName` (tmux teammate files) filters; title resolution is
 * customTitle → aiTitle, summary display last-prompt.lastPrompt → legacy
 * summary → firstPrompt; worktree dirs aggregate case-insensitively by
 * longest-prefix (startsWith only allowed for ≥200 truncated+hash dirs).
 */

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** uuid v4-any-version validator (native listSessions validateUuid gate). */
function uuidValidate(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
import { join } from 'node:path';
import type { Adapter, WriteOptions, WriteResult } from '../../registry.js';
import type { MigratedSession, SessionMeta } from '../../ir.js';
import { validateSession } from '../../ir.js';
import { blocksToText } from '../../content.js';
import { claudeProjectDirName, defaultClaudeProjectsRoot } from './path.js';
import { parseClaudeFile, readClaudeLinesForList } from './parse.js';
import { buildMainRecords, buildSidechainRecords } from './write.js';

interface ListLiteHead {
  isSidechain: boolean;
  teamName?: string;
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  lastPromptLeafUuid?: string;
  summary?: string;
  firstTimestamp?: string;
  gitBranch?: string;
  tag?: string;
  cwd?: string;
  firstPrompt?: string;
}

export class ClaudeAdapter implements Adapter {
  readonly tool = 'claude' as const;

  /** Read one Claude session jsonl (main + sidechains) into IR. */
  async parse(sessionId: string, root?: string): Promise<MigratedSession> {
    const projectsRoot = root ?? defaultClaudeProjectsRoot();
    if (!projectsRoot) throw new Error('Claude: cannot resolve ~/.claude/projects');
    const path = await this.findJsonl(projectsRoot, sessionId);
    if (!path) throw new Error(`Claude: session "${sessionId}" not found under ${projectsRoot}`);
    return parseClaudeFile(path);
  }

  /**
   * Write IR as a brand-new Claude session file (红线 #1: 只新增).
   * When the target path already exists the write is SKIPPED and reported via
   * `skippedExisting` — never overwritten, never appended to.
   */
  async write(ir: MigratedSession, opts?: WriteOptions): Promise<WriteResult> {
    validateSession(ir);
    const projectsRoot = opts?.root ?? defaultClaudeProjectsRoot();
    if (!projectsRoot) throw new Error('Claude: cannot resolve ~/.claude/projects');
    const targetCwd = opts?.targetCwd ?? ir.cwd ?? '';
    if (!targetCwd) throw new Error('Claude: write needs a target cwd (opts.targetCwd or ir.cwd)');

    // 红线 #3: 系统提示词绝不进会话正文（忽略 IR.systemPrompt；进程 flag 通道归引擎）
    void ir.systemPrompt;

    let newId = opts?.sessionId ?? randomUUID();
    const dir = join(projectsRoot, claudeProjectDirName(targetCwd));
    const finalPath = join(dir, `${newId}.jsonl`);
    if (await exists(finalPath)) {
      // 目标位置已有同 id 文件：换号重写，绝不覆盖（§6#2）
      if (opts?.sessionId) {
        throw new Error(`Claude: refusing to overwrite existing session file ${finalPath}`);
      }
      newId = randomUUID();
    }

    const keepSynthetic = opts?.keepSynthetic === true;
    const built = buildMainRecords(ir, newId, { targetCwd, keepSynthetic });
    const lines = built.records.map((r) => JSON.stringify(r));

    const paths: string[] = [];
    await fs.mkdir(dir, { recursive: true });
    if (await exists(finalPath)) {
      throw new Error(`Claude: refusing to overwrite existing session file ${finalPath}`);
    }
    await fs.writeFile(finalPath, lines.join('\n') + '\n', 'utf8');
    paths.push(finalPath);

    // sidechains: <dir>/<sessionId>/subagents/agent-<id>.jsonl (+ .meta.json sidecar)
    if (ir.sidechains?.length) {
      const subagentsDir = join(dir, newId, 'subagents');
      const used = new Set<string>();
      for (const sc of ir.sidechains) {
        let stem = `agent-${sanitizeStem(sc.agentId)}`;
        let n = 1;
        while (used.has(stem)) stem = `agent-${sanitizeStem(sc.agentId)}-${n++}`;
        used.add(stem);
        const { records, meta } = buildSidechainRecords(sc, newId, { targetCwd, keepSynthetic });
        const scPath = join(subagentsDir, `${stem}.jsonl`);
        if (await exists(scPath)) {
          throw new Error(`Claude: refusing to overwrite existing sidechain file ${scPath}`);
        }
        await fs.mkdir(subagentsDir, { recursive: true });
        await fs.writeFile(scPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
        paths.push(scPath);
        await fs.writeFile(join(subagentsDir, `${stem}.meta.json`), JSON.stringify(meta), 'utf8');
        paths.push(`${scPath}.meta.json`);
      }
    }

    return { tool: 'claude', sessionId: newId, paths };
  }

  /**
   * /resume-equivalent listing (§1.0): uuid-named files only, first-line
   * isSidechain + head teamName filtered, worktree dirs de-duplicated by
   * sessionId (mtime wins), titles customTitle → aiTitle.
   */
  async listSessions(root?: string): Promise<SessionMeta[]> {
    const projectsRoot = root ?? defaultClaudeProjectsRoot();
    if (!projectsRoot) return [];
    let projects: string[];
    try {
      projects = await fs.readdir(projectsRoot);
    } catch {
      return [];
    }

    // worktree aggregation: same-repo project dirs share a case-insensitive
    // name prefix; startsWith is only allowed for truncated(200)+hash dirs
    const bySession = new Map<string, SessionMeta & { _mtime: number }>();
    for (const proj of projects) {
      const projDir = join(projectsRoot, proj);
      let entries: string[];
      try {
        entries = await fs.readdir(projDir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue;
        const sid = name.slice(0, -'.jsonl'.length);
        if (!uuidValidate(sid)) continue; // §1.0: 非 uuid 文件名被列表忽略
        const full = join(projDir, name);
        let head: ListLiteHead;
        try {
          head = await readClaudeLinesForList(full);
        } catch {
          continue;
        }
        if (head.isSidechain) continue; // 首行 isSidechain:true → /resume 过滤
        if (head.teamName) continue; // tmux teammate 主会话文件 → enrichLog 过滤（独立会话，可选迁移）
        let st;
        try {
          st = await fs.stat(full);
        } catch {
          continue;
        }
        const parsedCreated = head.firstTimestamp ? Date.parse(head.firstTimestamp) : NaN;
        const meta: SessionMeta = {
          tool: 'claude',
          sessionId: sid,
          ...(head.customTitle ?? head.aiTitle ?? head.lastPrompt ?? head.summary ?? head.firstPrompt
            ? { title: head.customTitle ?? head.aiTitle ?? head.lastPrompt ?? head.summary ?? head.firstPrompt }
            : {}),
          createdAt: Number.isFinite(parsedCreated) ? parsedCreated : st.mtimeMs,
          sourcePath: full,
          // cwd: only the head's cwd stamp (first record's real path) is
          // trustworthy. The dir name is a one-way encoding (every non-alnum
          // → `-`) — decoding it yields a skeleton like "D-codes-foo" that
          // downstream targets (DSH header validation) refuse; leave unknown.
          ...(head.cwd ? { cwd: head.cwd } : {}),
          archived: false,
        };
        const prev = bySession.get(sid);
        if (!prev || st.mtimeMs > prev._mtime) bySession.set(sid, { ...meta, _mtime: st.mtimeMs });
      }
    }
    return [...bySession.values()].map(({ _mtime, ...m }) => m);
  }

  /** Offline preview. */
  preview(session: MigratedSession): string {
    const main = session.messages.map((m) => `[${m.role}${m.synthetic ? ' (synthetic)' : ''}]\n${blocksToText(m.content)}`).join('\n\n');
    if (session.sidechains?.length) {
      const extra = session.sidechains.map((sc) => `[sidechain: ${sc.agentId} (${sc.kind})]`).join('\n');
      return main ? `${main}\n\n${extra}` : extra;
    }
    return main;
  }

  /** Find the jsonl for a sessionId across all project dirs. */
  private async findJsonl(root: string, sessionId: string): Promise<string | null> {
    let projects: string[];
    try {
      projects = await fs.readdir(root);
    } catch {
      return null;
    }
    for (const proj of projects) {
      const candidate = join(root, proj, `${sessionId}.jsonl`);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // not here
      }
    }
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function sanitizeStem(agentId: string): string {
  return agentId.replace(/[^A-Za-z0-9-]/g, '-') || 'unknown';
}

export {
  claudeProjectDirName,
  defaultClaudeProjectsRoot,
  MAX_SANITIZED_LENGTH,
} from './path.js';
export { parseClaudeFile, loadSidechains } from './parse.js';
export { buildMainRecords, buildSidechainRecords, claudeNativeBlock } from './write.js';
