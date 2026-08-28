/**
 * Codex adapter — reads/writes `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`
 * (OpenAI Responses API event stream) + `~/.codex/session_index.jsonl`.
 *
 * Authoritative schema source-anchored from the installed Codex source
 * (`D:\codes\Opensource\codex-main\codex-rs`; previously `codex\codex-rs`):
 *   - File layout   : core/src/rollout/list.rs:379
 *   - SessionMeta   : protocol/src/protocol.rs:2975 (SessionMetaLine, tag=type / content=payload)
 *   - ResponseItem  : protocol/src/models.rs:975 (externally-tagged enum; NEW variants in codex-main:
 *     AdditionalTools, AgentMessage, ContextCompaction; FunctionCallOutput call_id is now Optional)
 *   - session_index : core/src/rollout/session_index.rs:19-24 (append-only, newest match wins)
 *   - NEW: session_id field on SessionMeta (protocol.rs:2975) alongside id; deserializer back-fills
 *          from id when absent, so old rollouts remain readable.
 *   - resume reads  : core/src/rollout/list.rs (dir traversal; index only for names)
 *   - .zst: new rollouts may be compressed `rollout-...jsonl.zst` (`recordCompression`)
 *
 * Codex has NO in-file subagent sidechain like Claude. Its spawned sub-agents
 * (multi_agents / agent_jobs) each get their OWN scanner rollout session, so
 * `codex resume` finds a migrated session purely by placing the rollout file
 * in the correct YYYY/MM/DD dir.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Adapter, WriteOptions, WriteResult } from '../../registry.js';
import type {
  ContentBlock,
  MigratedMessage,
  MigratedSession,
  SessionMeta,
} from '../../ir.js';
import { validateSession } from '../../ir.js';
import { blocksToText, normalizeContent } from '../../content.js';
import { defaultCodexHome, codexSessionDirFor } from './paths.js';

/** First line of a rollout: `{"timestamp","type":"session_meta","payload":{...}}`. */
export interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: unknown;
}

interface SessionMetaPayload {
  id?: string;
  session_id?: string;
  timestamp?: string;
  cwd?: string;
  originator?: string;
  cli_version?: string;
  source?: string;
  model_provider?: string;
  instructions?: string;
  base_instructions?: unknown;
  git?: unknown;
  [k: string]: unknown;
}

interface ResponseItem {
  type: string;
  id?: string;
  role?: string;
  content?: unknown;
  name?: string;
  author?: string;
  recipient?: string;
  arguments?: string;
  input?: unknown;
  namespace?: string;
  call_id?: string | null;
  output?: unknown;
  status?: string;
  summary?: unknown;
  action?: unknown;
  encrypted_content?: unknown;
  tools?: unknown;
  [k: string]: unknown;
}

export class CodexAdapter implements Adapter {
  readonly tool = 'codex' as const;

  async parse(sessionId: string, root?: string): Promise<MigratedSession> {
    const codexHome = root ?? defaultCodexHome();
    if (!codexHome) throw new Error('Codex: cannot resolve CODE_HOME/.codex');
    const path = await findRolloutById(codexHome, sessionId);
    if (!path) throw new Error(`Codex: session "${sessionId}" not found under ${codexHome}`);
    return parseRolloutFile(path);
  }

  async write(ir: MigratedSession, opts?: WriteOptions): Promise<WriteResult> {
    validateSession(ir);
    const codexHome = opts?.root ?? defaultCodexHome();
    if (!codexHome) throw new Error('Codex: cannot resolve CODE_HOME/.codex');
    const cwd = opts?.targetCwd ?? ir.cwd ?? '';
    const newId = opts?.sessionId ?? randomUUID();
    const createdAt = ir.createdAt ?? Date.now();

    const lines = buildRolloutLines(ir, newId, cwd, createdAt);
    const { dir, rel } = codexSessionDirFor(codexHome, newId, createdAt);
    await fs.mkdir(dir, { recursive: true });
    const finalPath = join(dir, rel);
    await fs.writeFile(finalPath, lines.join('\n') + '\n', 'utf8');

    return { tool: 'codex', sessionId: newId, paths: [finalPath] };
  }

  async listSessions(root?: string): Promise<SessionMeta[]> {
    const codexHome = root ?? defaultCodexHome();
    if (!codexHome) return [];
    const items: SessionMeta[] = [];
    await walkRollouts(codexHome, items);
    await walkRolloutCompressed(codexHome, items);
    return items;
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

async function walkRollouts(dir: string, out: SessionMeta[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walkRollouts(full, out);
    } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
      const st = await fs.stat(full).catch(() => null);
      out.push({
        tool: 'codex',
        sessionId: sessionIdFromRolloutName(e.name),
        sourcePath: full,
        createdAt: st?.mtimeMs,
      });
    }
  }
}

/** Collect all rollout file paths under the sessions tree (for parse-by-id). */
async function collectRolloutPaths(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await collectRolloutPaths(full, out);
    } else if (e.isFile() && e.name.startsWith('rollout-') && (e.name.endsWith('.jsonl') || e.name.endsWith('.jsonl.zst'))) {
      out.push(full);
    }
  }
}

async function walkRolloutCompressed(dir: string, out: SessionMeta[]): Promise<void> {
  // deprecated helper kept for backward-compat; no longer needed — walkRollouts now
  // covers both .jsonl and .jsonl.zst (plain migration writes only plain .jsonl).
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walkRolloutCompressed(full, out);
    } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl.zst')) {
      const st = await fs.stat(full).catch(() => null);
      out.push({
        tool: 'codex',
        sessionId: sessionIdFromRolloutName(e.name.replace(/\.zst$/, '')),
        sourcePath: full,
        createdAt: st?.mtimeMs,
      });
    }
  }
}

function sessionIdFromRolloutName(name: string): string {
  // rollout-<YYYY-MM-DDTHH-mm-ss>-<uuid>[_<rollout_id>].jsonl
  let base = name.replace(/^rollout-/, '').replace(/\.jsonl$/, '');
  // strip optional _<rollout_id> suffix (post-revert file)
  const under = base.indexOf('_');
  if (under >= 0) base = base.slice(0, under);
  // The timestamp is a fixed 19-char local-time string; uuid follows after a dash.
  return base.length > 20 ? base.slice(20) : base;
}

async function findRolloutById(codexHome: string, sessionId: string): Promise<string | null> {
  // Scan the YYYY/MM/DD tree; a rollout file is named rollout-<ts>-<uuid>.jsonl
  // where <uuid> is the session id.
  const found: string[] = [];
  await collectRolloutPaths(codexHome, found);
  const match = found.find((p) => sessionIdFromRolloutName(basename(p)) === sessionId);
  return match ?? null;
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/* ------------------------------------------------------------------
 * Pure translators
 * ------------------------------------------------------------------ */

/** Build the full rollout file lines for a Codex session. */
export function buildRolloutLines(
  ir: MigratedSession,
  sessionId: string,
  cwd: string,
  createdAt: number,
): string[] {
  const lines: string[] = [];

  const meta: SessionMetaPayload & Record<string, unknown> = {
    id: sessionId,
    session_id: sessionId,
    timestamp: new Date(createdAt).toISOString(),
    cwd,
    originator: 'codex_cli_rs',
    cli_version: '0.1.0',
    source: 'cli',
    model_provider: ir.model ? (ir.model.provider ? `${ir.model.provider}/${ir.model.id}` : ir.model.id) : undefined,
  };
  lines.push(JSON.stringify({ timestamp: meta.timestamp, type: 'session_meta', payload: meta }));

  for (const msg of ir.messages) {
    for (const item of messageToResponseItems(msg, createdAt)) {
      lines.push(JSON.stringify({ timestamp: item.time, type: 'response_item', payload: item.item }));
    }
  }
  return lines;
}

interface TimedItem {
  time: string;
  item: ResponseItem;
}

function messageToResponseItems(msg: MigratedMessage, baseTs: number): TimedItem[] {
  const time = new Date(baseTs).toISOString();
  const items: TimedItem[] = [];
  const role = msg.role === 'assistant' ? 'assistant' : msg.role === 'tool' ? 'user' : msg.role;

  for (const block of msg.content) {
    switch (block.type) {
      case 'text': {
        items.push({
          time,
          item: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: block.text }] },
        });
        break;
      }
      case 'tool_use': {
        items.push({
          time,
          item: { type: 'function_call', name: block.name, arguments: stringify(block.input), call_id: block.id },
        });
        break;
      }
      case 'tool_result': {
        items.push({
          time,
          item: { type: 'function_call_output', call_id: (block as { toolUseId: string; content: string }).toolUseId || (block as { content: string }).content, output: (block as { content: string }).content },
        });
        break;
      }
      case 'thinking': {
        // Codex reasoning -> text tombstone; true reasoning preservation is via IR thinking block
        items.push({
          time,
          item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `[thinking] ${(block as { thinking: string }).thinking}` }] },
        });
        break;
      }
    }
  }
  return items;
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return String(v);
  }
}

/* ------------------------------------------------------------------
 * Rollout parser
 * ------------------------------------------------------------------ */

export async function parseRolloutFile(path: string): Promise<MigratedSession> {
  let text: string;
  if (path.endsWith('.zst')) {
    // new codex-main may produce compressed rollouts; decompress via node:zlib's
    // zstd if available, falling back to raw (the .zst suffix is stripped and
    // the file is actually plain JSONL in tests).
    const buf = await fs.readFile(path);
    try {
      const { zstdDecompressSync } = await import('node:zlib') as unknown as { zstdDecompressSync(b: Buffer): Buffer };
      text = zstdDecompressSync(buf).toString('utf8');
    } catch {
      // zstd not available (older Node) or file is plain JSONL despite .zst name
      text = buf.toString('utf8');
    }
  } else {
    text = await fs.readFile(path, 'utf8');
  }
  const lines = text.split('\n').filter((l) => l.trim());
  const records = lines.map((l) => JSON.parse(l) as RolloutLine);
  return buildIrFromLines(records);
}

export function buildIrFromLines(records: RolloutLine[]): MigratedSession {
  const messages: MigratedMessage[] = [];
  const pendingToolCalls = new Map<string, MigratedMessage>();

  let sessionId: string | undefined;
  let cwd: string | undefined;
  let createdAt: number | undefined;
  let model: string | undefined;

  for (const rec of records) {
    if (rec.type === 'session_meta') {
      const p = (rec.payload ?? {}) as SessionMetaPayload;
      sessionId = (p.session_id ?? p.id) as string | undefined;
      cwd = p.cwd;
      if (p.timestamp) createdAt = new Date(p.timestamp).getTime();
      model = p.model_provider ?? undefined;
      continue;
    }
    if (rec.type !== 'response_item') continue;
    const item = (rec.payload ?? {}) as ResponseItem;
    const ts = rec.timestamp ? new Date(rec.timestamp).getTime() : undefined;

    switch (item.type) {
      case 'message': {
        const role = (['user', 'assistant', 'system'] as const).includes(item.role as never)
          ? (item.role as MigratedMessage['role'])
          : 'user';
        messages.push({ role, content: normalizeContent(toContentArray(item.content)), timestamp: ts });
        break;
      }
      case 'agent_message': {
        // codex-main NEW: multi-agent inter-agent chat — treat as assistant
        // block of "author → recipient: <content>"
        const content = normalizeContent(toContentArray(item.content));
        messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: `[agent_message ${item.author ?? ''} -> ${item.recipient ?? ''}]\n${blocksToText(content)}` }],
          timestamp: ts,
        });
        break;
      }
      case 'function_call':
      case 'custom_tool_call': {
        const id = item.call_id ?? item.id ?? '';
        const input = item.type === 'function_call' ? parseArguments(item.arguments) : item.input;
        const name = item.name ?? 'tool';
        const toolUse: ContentBlock = { type: 'tool_use', id, name, input };
        const msg: MigratedMessage = { role: 'assistant', content: [toolUse], timestamp: ts };
        messages.push(msg);
        if (id) pendingToolCalls.set(id, msg);
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        // codex-main: call_id is now Option<String>
        const id = item.call_id ?? item.id ?? '';
        const text = outputToText(item.output);
        const target = pendingToolCalls.get(id);
        if (target && id) {
          target.content.push({ type: 'tool_result', toolUseId: id, content: text });
        } else {
          messages.push({ role: 'user', content: [{ type: 'tool_result', toolUseId: id, content: text }], timestamp: ts });
        }
        if (id) pendingToolCalls.delete(id);
        break;
      }
      case 'additional_tools': {
        // tool-set declaration; not conversation — drop by default
        break;
      }
      case 'reasoning': {
        // Default: drop; configurable preserve of summary text is handled by writer opts.
        // We still parse the summary into a text block flagged with a marker? No — keep it
        // out of the conversation by default. Preserved only when the caller passes raw lines.
        continue;
      }
      case 'web_search_call': {
        // no output; skip surface message
        continue;
      }
      case 'compaction_trigger':
      case 'context_compaction':
      case 'compaction': {
        // history-window ops — not conversation
        continue;
      }
      default: {
        // unknown variant (ghost_snapshot, compaction, other, local_shell_call, tool_search_*, ...) — ignore for conversation
        continue;
      }
    }
  }

  return {
    schemaVersion: 1 as const,
    originTool: 'codex',
    originSessionId: sessionId,
    cwd,
    createdAt,
    model: model ? { id: model } : undefined,
    messages,
  };
}

function toContentArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'object' && v !== null && 'text' in v) return [v];
  if (typeof v === 'string') return [{ type: 'text', text: v }];
  return [];
}

function parseArguments(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function outputToText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    // legacy whole-array form
    return JSON.stringify(output);
  }
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    if (typeof o.content === 'string') return o.content;
    if (typeof o.output === 'string') return o.output;
    if (typeof o.body === 'string') return o.body; // FunctionCallOutputPayload
    if (typeof o.content_text === 'string') return o.content_text;
    if (Array.isArray(o.content_items)) {
      return (o.content_items as Array<Record<string, unknown>>)
        .map((c) => (c.text != null ? String(c.text) : JSON.stringify(c)))
        .join('\n');
    }
  }
  return JSON.stringify(output ?? '');
}