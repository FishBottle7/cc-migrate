/**
 * Pi adapter — reads/writes `~/.pi/agent/sessions/--<path>--/<ts>_<uuid>.jsonl`.
 *
 * Source-anchored from `pi-main` v0.0.3 (session-manager.ts, session-format.md):
 *  - Path: cwd stripped leading /\\ then / \\ : -> -, wrapped --...-- (no ~XXXX escape).
 *  - Filename: <ISO ts with :. -> ->_<uuidv7>.jsonl.
 *  - Version: 3 (CURRENT_SESSION_VERSION=3).
 *  - Entries: id=8-char hex (randomUUID slice 0,8 + collision retry) + parentId (first null),
 *    leafId pointer + buildContextEntries/buildSessionContext compaction-aware projection.
 *  - Entry types: session header | message(AgentMessage) | compaction | branch_summary |
 *    custom_message | model_change | thinking_level_change | custom | label | session_info.
 *  - _persist guard: flushed stays false until first assistant; no file without assistant.
 *
 * Discovery: scan sessions project dir, read only header (4KB + 1MB limit). Listed via
 * SessionManager.list(cwd, sessionDir?). We fall back to directory scan + header decode.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Adapter, WriteOptions, WriteResult } from '../../registry.js';
import type { MigratedMessage, MigratedSession, SessionMeta } from '../../ir.js';
import { validateSession } from '../../ir.js';
import { blocksToText, normalizeContent } from '../../content.js';

type PiEntryType = 'session' | 'message' | 'compaction' | 'branch_summary' | 'custom_message' | 'model_change' | 'thinking_level_change' | 'custom' | 'label' | 'session_info';

interface PiHeader {
  type: 'session';
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

interface PiEntry {
  type: PiEntryType;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: { role?: string; content?: unknown; timestamp?: number } & Record<string, unknown>;
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  retainedTail?: unknown;
  fromId?: string;
  customType?: string;
  content?: unknown;
  display?: boolean;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  targetId?: string;
  label?: string;
  name?: string;
  details?: unknown;
  usage?: unknown;
  fromHook?: boolean;
}

const PI_CURRENT_VERSION = 3;

function piProjectKey(cwd: string): string {
  // session-manager.ts:479 : --<path with / \: : -> ->--
  const inner = cwd.replace(/^[/\\]+/, '').replace(/[/\\:]/g, '-');
  return `--${inner}--`;
}

function generateId(existing: Set<string>): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8);
    if (!existing.has(id)) return id;
  }
  return randomUUID().slice(0, 8);
}

export class PiAdapter implements Adapter {
  readonly tool = 'pi' as const;

  async parse(sessionId: string, root?: string): Promise<MigratedSession> {
    const sessionsDir = root ?? defaultPiSessionsDir();
    if (!sessionsDir) throw new Error('Pi: cannot resolve ~/.pi/agent/sessions');
    const path = await findPiFile(sessionsDir, sessionId);
    if (!path) throw new Error(`Pi: session "${sessionId}" not found under ${sessionsDir}`);
    return parsePiFile(path);
  }

  async write(ir: MigratedSession, opts?: WriteOptions): Promise<WriteResult> {
    validateSession(ir);
    const sessionsDir = opts?.root ?? defaultPiSessionsDir();
    if (!sessionsDir) throw new Error('Pi: cannot resolve ~/.pi/agent/sessions');
    const cwd = opts?.targetCwd ?? ir.cwd ?? '';

    const newId = opts?.sessionId ?? randomUUID();
    const iso = new Date(ir.createdAt ?? Date.now()).toISOString();
    const fileTs = iso.replace(/[:.]/g, '-');
    const projectDir = join(sessionsDir, piProjectKey(cwd));

    await fs.mkdir(projectDir, { recursive: true });
    const filePath = join(projectDir, `${fileTs}_${newId}.jsonl`);

    // Must contain at least one assistant message or Pi never flushes (_persist guard)
    const needsAssistant = !ir.messages.some((m) => m.role === 'assistant');
    const writeMessages = needsAssistant
      ? [...ir.messages, { role: 'assistant' as const, content: [{ type: 'text' as const, text: '(migrated session — continuation)' }] }]
      : ir.messages;

    const header: PiHeader = {
      type: 'session',
      version: PI_CURRENT_VERSION,
      id: newId,
      timestamp: iso,
      cwd: cwd || '',
    };

    const byId = new Set<string>();
    const entries: PiEntry[] = [];
    let parentId: string | null = null;
    for (const msg of writeMessages) {
      const id = generateId(byId);
      byId.add(id);
      const entry: PiEntry = {
        type: 'message',
        id,
        parentId,
        timestamp: new Date(msg.timestamp ?? Date.now()).toISOString(),
        message: piMessageFromMigrated(msg),
      };
      entries.push(entry);
      parentId = id;
    }

    // Optional: thinkingLevel / model_change
    if (ir.thinkingLevel) {
      const id = generateId(byId); byId.add(id);
      entries.push({ type: 'thinking_level_change', id, parentId, timestamp: new Date().toISOString(), thinkingLevel: ir.thinkingLevel });
      parentId = id;
    }
    if (ir.model?.provider || ir.model?.id) {
      const id = generateId(byId); byId.add(id);
      entries.push({ type: 'model_change', id, parentId, timestamp: new Date().toISOString(), provider: ir.model.provider ?? 'unknown', modelId: ir.model.id ?? 'unknown' });
      parentId = id;
    }

    // Sidechains: pi has no separate sidecar file, so we append branch_summary + branch messages as tree off an earlier node.
    // Simplest: create sibling branches off the leaf by branching once then appending sidechain messages.
    const paths = [filePath];
    const allLines: string[] = [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))];

    // If there are sidechains, we materialize them as sibling branches (leaf stays on main).
    // Pi's leafId points to last entry, but siblings are valid tree branches regardless of leaf.
    if (ir.sidechains?.length) {
      // For each sidechain, branch from the first message id and append its messages as a separate chain
      const mainFirstId = entries[0]?.id ?? null;
      for (const sc of ir.sidechains) {
        let branchParent: string | null = mainFirstId;
        for (const msg of sc.messages) {
          const bid = generateId(byId); byId.add(bid);
          const bEntry: PiEntry = {
            type: 'message',
            id: bid,
            parentId: branchParent,
            timestamp: new Date(msg.timestamp ?? Date.now()).toISOString(),
            message: piMessageFromMigrated(msg),
          };
          allLines.push(JSON.stringify(bEntry));
          // chain sibling branch linearly (branch off same root but extend sibling chain)
          branchParent = bid;
        }
        // optional: emit a branch_summary + label to mark the sidechain
        const sid = generateId(byId); byId.add(sid);
        const summaryText = sc.agentType ? `sidechain ${sc.agentId} (${sc.agentType})` : `sidechain ${sc.agentId} (${sc.kind})`;
        allLines.push(JSON.stringify({ type: 'branch_summary', id: sid, parentId, timestamp: new Date().toISOString(), fromId: branchParent ?? sid, summary: summaryText } as PiEntry));
      }
    }

    await fs.writeFile(filePath, allLines.join('\n') + '\n', 'utf8');
    return { tool: 'pi', sessionId: newId, paths };
  }

  async listSessions(root?: string): Promise<SessionMeta[]> {
    const sessionsDir = root ?? defaultPiSessionsDir();
    if (!sessionsDir) return [];
    const metas: SessionMeta[] = [];
    let projects: string[];
    try {
      projects = await fs.readdir(sessionsDir);
    } catch {
      return [];
    }
    for (const proj of projects) {
      const projDir = join(sessionsDir, proj);
      let entries: string[];
      try {
        entries = await fs.readdir(projDir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue;
        const full = join(projDir, name);
        try {
          const st = await fs.stat(full);
          // extract id from <ts>_<uuid>.jsonl -> uuid part
          const under = name.lastIndexOf('_');
          const sid = under >= 0 ? name.slice(under + 1, -'.jsonl'.length) : name.slice(0, -'.jsonl'.length);
          metas.push({ tool: 'pi', sessionId: sid, createdAt: st.mtimeMs, sourcePath: full });
        } catch { /* skip */ }
      }
    }
    return metas;
  }

  preview(session: MigratedSession): string {
    const main = session.messages.map((m) => `[${m.role}]\n${blocksToText(m.content)}`).join('\n\n');
    if (!session.sidechains?.length) return main;
    const branches = session.sidechains
      .map((sc) => `[sidechain: ${sc.agentId} (${sc.kind})]\n${sc.messages.map((m) => blocksToText(m.content)).join('\n')}`)
      .join('\n\n');
    return `${main}\n\n${branches}`;
  }
}

function defaultPiSessionsDir(): string | null {
  // Allow override via env (config.ts: PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR)
  const override = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (override && override.trim()) return override.trim();
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (agentDir && agentDir.trim()) return join(agentDir.trim(), 'sessions');
  const home = process.env.HOME || (process.env.USERPROFILE ?? null);
  if (!home) return null;
  // pi-main default: ~/.pi/agent/sessions (config.ts: getSessionsDir)
  return join(home, '.pi', 'agent', 'sessions');
}

async function findPiFile(sessionsDir: string, sessionId: string): Promise<string | null> {
  // fast: search by suffix _<sessionId>.jsonl across project dirs
  let projects: string[];
  try {
    projects = await fs.readdir(sessionsDir);
  } catch {
    return null;
  }
  for (const proj of projects) {
    const projDir = join(sessionsDir, proj);
    let files: string[];
    try {
      files = await fs.readdir(projDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const under = f.lastIndexOf('_');
      const id = under >= 0 ? f.slice(under + 1, -'.jsonl'.length) : f.slice(0, -'.jsonl'.length);
      if (id === sessionId) return join(projDir, f);
    }
  }
  return null;
}

export async function parsePiFile(path: string): Promise<MigratedSession> {
  const text = await fs.readFile(path, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim());
  const entries = lines.map((l) => JSON.parse(l) as PiEntry | PiHeader);
  const header = entries.find((e) => e.type === 'session') as PiHeader | undefined;
  const cwd = header?.cwd;
  const createdAt = header?.timestamp ? new Date(header.timestamp).getTime() : undefined;
  const originSessionId = header?.id;

  // Collect message entries in file order (tree order; for main chain we follow parentId chain from leaf)
  const msgEntries = entries.filter((e): e is PiEntry => e.type === 'message') as PiEntry[];
  const allMessages: MigratedMessage[] = [];
  let thinkingLevel: string | undefined;
  let model: { provider?: string; id: string; variant?: string } | undefined;

  for (const e of entries) {
    if (e.type === 'thinking_level_change') thinkingLevel = (e as PiEntry).thinkingLevel;
    if (e.type === 'model_change') {
      const me = e as PiEntry;
      model = { provider: me.provider, id: me.modelId ?? 'unknown' };
    }
  }

  for (const e of msgEntries) {
    const raw = e.message as unknown;
    if (!raw || typeof raw !== 'object') continue;
    const roleRaw = (raw as { role?: string }).role;
    const role: MigratedMessage['role'] =
      roleRaw === 'user' ? 'user' : roleRaw === 'assistant' ? 'assistant' : roleRaw === 'toolResult' ? 'tool' : 'assistant';
    const contentSrc = (raw as { content?: unknown }).content;
    const arr = Array.isArray(contentSrc) ? contentSrc : typeof contentSrc === 'string' ? [{ type: 'text', text: contentSrc }] : [];
    const content = normalizeContent(arr);
    const ts = (raw as { timestamp?: number }).timestamp ?? (e.timestamp ? new Date(e.timestamp).getTime() : undefined);
    const provider = (raw as { provider?: string }).provider;
    const modelId = (raw as { model?: string }).model;
    allMessages.push({ role, content, timestamp: ts, provider, model: modelId });
  }

  // Derive tree siblings as sidechains: group messages that are not on the leaf path.
  // Leaf path = follow parentId from last message's id back to null.
  let sidechains: import('../../ir.js').MigratedSidechain[] | undefined;
  if (msgEntries.length > 0) {
    const byId = new Map<string, PiEntry>();
    for (const e of msgEntries) byId.set(e.id, e);
    const leafId = msgEntries[msgEntries.length - 1]?.id ?? null;
    const leafPath = new Set<string>();
    let cur: PiEntry | undefined = leafId ? byId.get(leafId) : undefined;
    while (cur) {
      leafPath.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    const siblingEntries = msgEntries.filter((e) => !leafPath.has(e.id));
    if (siblingEntries.length > 0) {
      // group by branch root (first sibling's parent subtree); simplest: one sidechain per disconnected root
      const groups = new Map<string, PiEntry[]>();
      for (const e of siblingEntries) {
        // walk up until hitting leafPath or null, that ancestor's child is the root
        let anc: PiEntry | undefined = e;
        let branchRoot = e.id;
        while (anc?.parentId && !leafPath.has(anc.parentId)) {
          const p = byId.get(anc.parentId);
          if (!p || leafPath.has(p.id)) break;
          anc = p; branchRoot = anc.id;
        }
        const g = groups.get(branchRoot) ?? [];
        g.push(e); groups.set(branchRoot, g);
      }
      sidechains = [];
      for (const [rootId, group] of groups) {
        // order by timestamp
        group.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        const msgs: MigratedMessage[] = group.map((e) => {
          const raw2 = e.message as { role?: string; content?: unknown; timestamp?: number; provider?: string; model?: string };
          const role2: MigratedMessage['role'] = raw2.role === 'user' ? 'user' : 'assistant';
          const arr2 = Array.isArray(raw2.content) ? raw2.content : typeof raw2.content === 'string' ? [{ type: 'text', text: raw2.content }] : [];
          return { role: role2, content: normalizeContent(arr2), timestamp: raw2.timestamp ?? new Date(e.timestamp).getTime(), provider: raw2.provider, model: raw2.model };
        });
        sidechains.push({ agentId: `pi-${rootId.slice(0, 8)}`, kind: 'subagent', messages: msgs });
      }
    }
  }

  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'pi',
    originSessionId,
    cwd,
    createdAt,
    model,
    thinkingLevel,
    messages: allMessages,
  };
  if (sidechains?.length) ir.sidechains = sidechains;
  return validateSession(ir);
}

function piMessageFromMigrated(msg: MigratedMessage): Record<string, unknown> {
  const role = msg.role === 'tool' ? 'toolResult' : msg.role;
  const content = msg.content.map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking };
    if (b.type === 'tool_use') return { type: 'toolCall', id: b.id, name: b.name, arguments: b.input };
    if (b.type === 'tool_result') return { type: 'toolResult', toolCallId: b.toolUseId, content: b.content, isError: b.isError ?? false };
    // FileBlock: no tool-result semantics — render as a text placeholder.
    return { type: 'text', text: `[file: ${b.filename ?? b.url ?? b.mediaType ?? 'attachment'}]` };
  });
  const out: Record<string, unknown> = {
    role,
    content: content.length === 1 && typeof (content[0] as { text?: string }).text === 'string' && (msg.role === 'user')
      ? (content[0] as { text: string }).text
      : content,
    timestamp: msg.timestamp ?? Date.now(),
  };
  if (msg.provider) out.provider = msg.provider;
  if (msg.model) out.model = msg.model;
  if (msg.stopReason) out.stopReason = msg.stopReason;
  return out;
}

export { piProjectKey, defaultPiSessionsDir };
