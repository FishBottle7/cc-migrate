/**
 * Claude Code adapter — reads/writes `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`.
 *
 * Source-anchored (from the installed claude-code-main source):
 *  - project directory = cwd with every non-alphanumeric → `-` (`sanitizePath`).
 *  - each line is one record (`user`/`assistant` carry `message:{role,content}`),
 *    chained by `parentUuid`; the file ends near-EOF with a `last-prompt` line
 *    `{type:'last-prompt', lastPrompt:<≤200 chars>, sessionId}` (display only —
 *    the chain is rebuilt purely by walking `parentUuid`).
 *  - resume/sidechain discovery is a pure directory scan; NO sessions-index needs
 *    touching (`/resume` filters out files whose first line has "isSidechain":true).
 *  - sub-agent sidechains live at `<sessionDir>/subagents/agent-<id>.jsonl`,
 *    records identical to main but with `isSidechain:true` + `agentId`, plus an
 *    optional `<id>.meta.json` sidecar {agentType, worktreePath?, description?}.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Adapter, WriteOptions, WriteResult } from '../../registry.js';
import type {
  ContentBlock,
  MigratedMessage,
  MigratedSession,
  MigratedSidechain,
  SessionMeta,
} from '../../ir.js';
import { validateSession } from '../../ir.js';
import { blocksToText, normalizeContent } from '../../content.js';
import { claudeProjectDirName, defaultClaudeProjectsRoot } from './path.js';

interface ClaudeRecord {
  type?: string;
  sessionId?: string;
  cwd?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
  isSidechain?: boolean;
  agentId?: string;
  leafUuid?: string;
}

export class ClaudeAdapter implements Adapter {
  readonly tool = 'claude' as const;

  /** Read one Claude session jsonl into IR. */
  async parse(sessionId: string, root?: string): Promise<MigratedSession> {
    const projectsRoot = root ?? defaultClaudeProjectsRoot();
    if (!projectsRoot) throw new Error('Claude: cannot resolve ~/.claude/projects');
    const path = await this.findJsonl(projectsRoot, sessionId);
    if (!path) throw new Error(`Claude: session "${sessionId}" not found under ${projectsRoot}`);
    return parseClaudeFile(path);
  }

  /** Write an IR session into a Claude-resumable jsonl (new session id). */
  async write(ir: MigratedSession, opts?: WriteOptions): Promise<WriteResult> {
    validateSession(ir);
    const projectsRoot = opts?.root ?? defaultClaudeProjectsRoot();
    if (!projectsRoot) throw new Error('Claude: cannot resolve ~/.claude/projects');
    const cwd = opts?.targetCwd ?? ir.cwd ?? '';
    const newId = opts?.sessionId ?? randomUUID();

    const records = buildClaudeRecords(ir, newId, cwd);
    const dir = join(projectsRoot, claudeProjectDirName(cwd));
    await fs.mkdir(dir, { recursive: true });
    const finalPath = join(dir, `${newId}.jsonl`);
    const lines = records.map((r) => JSON.stringify(r));
    await fs.writeFile(finalPath, lines.join('\n') + '\n');

    // Sub-agent / teammate sidechains: each under <sessionDir>/subagents/agent-<sanitized>.jsonl
    const paths = [finalPath];
    if (ir.sidechains?.length) {
      const sessionDir = join(dir, newId);
      const subagentsDir = join(sessionDir, 'subagents');
      await fs.mkdir(subagentsDir, { recursive: true });
      const usedNames = new Set<string>();
      for (const sc of ir.sidechains) {
        let sanitized = sanitizeAgentId(sc.agentId);
        let base = `agent-${sanitized}`;
        let finalBase = base;
        if (usedNames.has(finalBase)) {
          if (sc.kind === 'teammate') {
            finalBase = `${base}-teammate`;
            let idx = 1;
            while (usedNames.has(finalBase)) {
              idx += 1;
              finalBase = `${base}-teammate-${idx}`;
            }
          } else {
            let idx = 1;
            while (usedNames.has(finalBase)) {
              idx += 1;
              finalBase = `${base}-${idx}`;
            }
          }
        } else if (sc.kind === 'teammate') {
          // pre-check: sanitized collides with a prior subagent's sanitized name
          // already handled by usedNames; if no collision, keep base as-is
        }
        usedNames.add(finalBase);
        const scPath = join(subagentsDir, `${finalBase}.jsonl`);
        const scLines = buildClaudeSidechainRecords(sc, newId, cwd);
        await fs.writeFile(scPath, scLines.map((r) => JSON.stringify(r)).join('\n') + '\n');
        paths.push(scPath);
        if (sc.agentType) {
          const meta = { agentType: sc.agentType };
          await fs.writeFile(join(subagentsDir, `${finalBase}.meta.json`), JSON.stringify(meta));
        }
      }
    }

    return { tool: 'claude', sessionId: newId, paths };
  }

  /** Lightweight session listing from the Claude projects root. */
  async listSessions(root?: string): Promise<SessionMeta[]> {
    const projectsRoot = root ?? defaultClaudeProjectsRoot();
    if (!projectsRoot) return [];
    const metas: SessionMeta[] = [];
    let projects: string[];
    try {
      projects = await fs.readdir(projectsRoot);
    } catch {
      return [];
    }
    for (const proj of projects) {
      const projDir = join(projectsRoot, proj);
      // skip subagents/ memory/ directories non-jsonl entries
      let entries: string[];
      try {
        entries = await fs.readdir(projDir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue;
        const sid = name.slice(0, -'.jsonl'.length);
        const full = join(projDir, name);
        try {
          const st = await fs.stat(full);
          metas.push({ tool: 'claude', sessionId: sid, createdAt: st.mtimeMs, sourcePath: full });
        } catch {
          // skip
        }
      }
    }
    return metas;
  }

  /** Offline preview. */
  preview(session: MigratedSession): string {
    const main = session.messages.map((m) => `[${m.role}]\n${blocksToText(m.content)}`).join('\n\n');
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

/* ------------------------------------------------------------------
 * Pure translators
 * ------------------------------------------------------------------ */

/** Parse a Claude jsonl file (by path) into IR, including sub-agent sidechains. */
export async function parseClaudeFile(path: string): Promise<MigratedSession> {
  const text = await fs.readFile(path, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim());
  const records = lines.map((l) => JSON.parse(l) as ClaudeRecord);
  const messages: MigratedMessage[] = [];
  const teammateSidechains: MigratedSidechain[] = [];
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let createdAt: number | undefined;

  for (const rec of records) {
    if (rec.sessionId && !sessionId) sessionId = rec.sessionId;
    if (rec.cwd && !cwd) cwd = rec.cwd;
    if (rec.type === 'user' || rec.type === 'assistant') {
      const msg = recordToMessage(rec);
      if (msg) messages.push(msg);
      if (createdAt === undefined && rec.timestamp) createdAt = new Date(rec.timestamp).getTime();
      // teammate: <teammate-message teammate_id="name@team" color="...">\n...\n</teammate-message>
      // anchor print.ts:2601, xml.ts:51 — mirror as sidechain kind:'teammate', keep original in main chain
      if (rec.type === 'user' && rec.message) {
        const raw = rec.message.content;
        let combined = '';
        if (typeof raw === 'string') combined = raw;
        else if (Array.isArray(raw)) {
          for (const b of raw) {
            if (typeof b === 'string') combined += b + '\n';
            else if (b && typeof b === 'object') {
              const blk = b as Record<string, unknown>;
              if (blk.type === 'text' && typeof blk.text === 'string') combined += blk.text + '\n';
              else if (typeof blk.text === 'string') combined += String(blk.text) + '\n';
              else if (typeof blk.content === 'string') combined += String(blk.content) + '\n';
            }
          }
        }
        if (!combined && msg) {
          combined = msg.content
            .filter((c) => c.type === 'text')
            .map((c) => (c as { text: string }).text)
            .join('\n');
        }
        if (combined) {
          const re = /<teammate-message[^>]*teammate_id\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/teammate-message>/gi;
          let m: RegExpExecArray | null;
          while ((m = re.exec(combined)) !== null) {
            const teammateIdRaw = (m[1] ?? '').trim();
            const agentId = teammateIdRaw || 'unknown-teammate';
            let inner = m[2] ?? '';
            // 去首尾空行：trim outer blank lines, keep inner formatting as single text block
            inner = inner.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, '').trim();
            if (!inner) continue;
            teammateSidechains.push({
              agentId,
              kind: 'teammate' as const,
              parentMessageId: rec.uuid,
              messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: inner }] }],
            });
          }
        }
      }
    }
  }

  const ir: MigratedSession = { schemaVersion: 2, originTool: 'claude', originSessionId: sessionId, cwd, messages };
  if (createdAt !== undefined) ir.createdAt = createdAt;

  // Sidechains: <dirPath>/<sessionId>/subagents/agent-<id>.jsonl + inline teammate mirrors
  let sidechains: MigratedSidechain[] = [];
  if (sessionId) {
    const dirPath = dirnameOf(path);
    const subagentsDir = join(dirPath, sessionId, 'subagents');
    sidechains = await loadSidechains(subagentsDir);
  }
  if (teammateSidechains.length) sidechains = [...sidechains, ...teammateSidechains];
  if (sidechains.length) ir.sidechains = sidechains;

  return validateSession(ir);
}

function dirnameOf(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(0, idx) : '.';
}

/** Scan a session's `subagents/` dir and parse each `agent-<id>.jsonl`. */
async function loadSidechains(subagentsDir: string): Promise<MigratedSidechain[]> {
  let entries;
  try {
    entries = await fs.readdir(subagentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: MigratedSidechain[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.startsWith('agent-') || !e.name.endsWith('.jsonl')) continue;
    const agentId = e.name.slice('agent-'.length, -'.jsonl'.length);
    if (!agentId) continue;
    const scText = await fs.readFile(join(subagentsDir, e.name), 'utf8');
    const sidechain = parseSidechainFile(scText, agentId);
    if (sidechain) out.push(sidechain);
  }
  return out;
}

function parseSidechainFile(text: string, agentId: string): MigratedSidechain | null {
  const records = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as ClaudeRecord);
  const messages: MigratedMessage[] = [];
  for (const rec of records) {
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    if (!rec.isSidechain) continue;
    const msg = recordToMessage(rec);
    if (msg) messages.push(msg);
  }
  if (messages.length === 0) return null;
  return { agentId, kind: 'subagent' as const, messages };
}

/** Build the records for one sub-agent sidechain file (isSidechain:true + agentId). */
export function buildClaudeSidechainRecords(
  sc: MigratedSidechain,
  sessionId: string,
  cwd: string,
): unknown[] {
  const records: Record<string, unknown>[] = [];
  let now = Date.now();
  for (const msg of sc.messages) {
    now += 1;
    const type = msg.role === 'assistant' || msg.role === 'tool' ? 'assistant' : 'user';
    const contentArr = msg.content.map((b) => claudeNativeBlock(b));
    records.push({
      type,
      ...(cwd ? { cwd } : {}),
      message: { role: type === 'assistant' ? 'assistant' : 'user', content: contentArr },
      uuid: randomUUID(),
      parentUuid: records.length > 0 ? records[records.length - 1].uuid : null,
      timestamp: new Date(now).toISOString(),
      isSidechain: true,
      agentId: sc.agentId,
      sessionId,
    });
  }
  return records;
}

function recordToMessage(rec: ClaudeRecord): MigratedMessage | null {
  const m = rec.message;
  if (!m) return null;
  const role = (m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : (m.role as MigratedMessage['role'])) ?? 'assistant';
  const raw = m.content;
  const contentArr = Array.isArray(raw) ? raw : typeof raw === 'string' ? [{ type: 'text', text: raw }] : [];
  const content = normalizeContent(contentArr);
  if (content.length === 0) return null;
  return { role, content, timestamp: rec.timestamp ? new Date(rec.timestamp).getTime() : undefined };
}

/** Build the Claude record chain (mode + user/assistant + last-prompt). */
export function buildClaudeRecords(ir: MigratedSession, sessionId: string, cwd: string): unknown[] {
  const records: Record<string, unknown>[] = [];
  let now = ir.createdAt ?? Date.now();
  let lastUserText = '';
  for (const msg of ir.messages) {
    now += 1;
    const uuid = randomUUID();
    const type = msg.role === 'assistant' || msg.role === 'tool' ? 'assistant' : 'user';
    if (type === 'user') {
      const firstText = messageToPlainText(msg);
      if (firstText) lastUserText = firstText;
    }

    const contentArr = msg.content.map((b) => claudeNativeBlock(b));
    records.push({
      type,
      ...(cwd ? { cwd } : {}),
      message: {
        role: type === 'assistant' ? 'assistant' : 'user',
        content: contentArr,
      },
      uuid,
      parentUuid: records.length > 0 ? records[records.length - 1].uuid : null,
      timestamp: new Date(now).toISOString(),
      isSidechain: false,
      sessionId,
    });
  }
  // terminal control line — authoritative shape (source: reAppendSessionMetadata):
  // {type:'last-prompt', lastPrompt:<text>, sessionId}
  if (lastUserText.length > 200) lastUserText = lastUserText.slice(0, 200);
  const lp: Record<string, unknown> = { type: 'last-prompt', lastPrompt: lastUserText, sessionId };
  if (cwd) lp.cwd = cwd;
  records.push(lp);
  return records;
}

function messageToPlainText(msg: MigratedMessage): string {
  const parts: string[] = [];
  for (const b of msg.content) {
    if (b.type === 'text') parts.push(b.text);
  }
  return parts.join('\n').replace(/\s+/g, ' ').trim();
}

function claudeNativeBlock(block: ContentBlock): unknown {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
  if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking };
  return { type: 'tool_result', tool_use_id: (block as { toolUseId: string; content: string }).toolUseId, content: (block as { content: string }).content };
}

function sanitizeAgentId(agentId: string): string {
  let out = '';
  for (const ch of agentId) out += /^[A-Za-z0-9]$/.test(ch) ? ch : '-';
  // collapse and trim to keep filenames tidy; same intent as claudeProjectDirName but id-scoped
  out = out.replace(/-+/g, '-').replace(/^-|-$/g, '');
  return out || 'unknown-teammate';
}