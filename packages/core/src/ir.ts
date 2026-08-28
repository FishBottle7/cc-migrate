/**
 * Unified Intermediate Representation (IR) for session migration.
 *
 * This is the pivot of the whole engine: every tool adapter reads its native
 * storage into an IR session, and every tool adapter writes an IR session back
 * into its native store. There are only N adapters (not N² pairwise converters).
 *
 * The IR intentionally keeps the *smallest* set of fields that preserves
 * resume semantics across tools:
 *  - role + content blocks (text, tool_use, tool_result)
 *  - tool calls / tool results (with rewritten ids per target tool)
 *  - cwd (remapped to the target tool's working directory on write)
 *  - model (best-effort, optional)
 *
 * It is a "conversation pipeline", NOT a tool-specific event log: the
 * internal state machines of each tool (turn/step/compaction, sidechains,
 * sqlite event sourcing) are NOT replicated. The honest ceiling of lossless
 * migration is message-level fidelity — the target tool can continue the
 * thread, re-call tools, and keep reasoning, but cannot replay the original
 * tool side effects.
 */

export type ToolId = 'dsh' | 'claude' | 'codex' | 'opencode' | 'unknown';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface MigratedMessage {
  role: MessageRole;
  /** Normalized content blocks. Text lives here; tool interactions fold in too. */
  content: ContentBlock[];
  /** Convenience extractor of tool_use blocks; kept for adapters that model them separately. */
  toolCalls?: { id: string; name: string; input: unknown }[];
  /** Convenience extractor of tool_result blocks. */
  toolResults?: { toolUseId: string; content: string; isError?: boolean }[];
  /** Epoch ms. Optional; used to preserve ordering hints across tools. */
  timestamp?: number;
}

/** Light metadata for a listed session (for GUI pickers / CLI --list). */
export interface SessionMeta {
  tool: ToolId;
  sessionId: string;
  title?: string;
  createdAt?: number;
  /** Absolute path of the source artifact, when known. */
  sourcePath?: string;
  /** Absolute working directory the session ran under (source). */
  cwd?: string;
}

/** A sub-agent / sidechain branch attached to a session.
 *
 * Different tools model this differently (Claude: `isSidechain` messages in a
 * sibling `subagents/agent-<id>.jsonl`; DSH: separate session files referenced
 * by `parentSession`/`agent/inbox/spliced`; Codex spawned agents: sibling
 * rollout sessions). The IR carries the branch's messages so an adapter can
 * byte-faithfully migrate it, together with enough id/metadata to preserve the
 * parent→sub-agent link.
 */
export interface MigratedSidechain {
  /** Agent identifier as stored by the target tool (e.g. Claude `agent-<id>.jsonl`). */
  agentId: string;
  /** Original provider/slug/type of the sub-agent, when known (best-effort). */
  agentType?: string;
  /** Monotonic conversation inside the sub-agent, newest last. */
  messages: MigratedMessage[];
}

export interface MigratedSession {
  originTool: ToolId;
  originSessionId?: string;
  title?: string;
  createdAt?: number;
  /** Source working directory. Remapped to the target by the writer adapter. */
  cwd?: string;
  /** Best-effort original model, carried for reference / optional mapping. */
  model?: string;
  /** Ordered conversation, newest last. */
  messages: MigratedMessage[];
  /** Sub-agent / sidechain branches attached to this session. */
  sidechains?: MigratedSidechain[];
  /** Source tool's original parsed record(s), kept for lossless fallback / audit. */
  raw?: unknown;
}

/* ------------------------------------------------------------------
 * Validation helpers
 * ------------------------------------------------------------------ */

export function isMigratedMessage(v: unknown): v is MigratedMessage {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool' && m.role !== 'system') return false;
  if (!Array.isArray(m.content)) return false;
  return true;
}

export function validateSession(ir: MigratedSession): MigratedSession {
  if (!ir || typeof ir !== 'object') throw new Error('validateSession: ir is not an object');
  if (!Array.isArray(ir.messages)) throw new Error('validateSession: messages must be an array');
  for (const [i, msg] of ir.messages.entries()) {
    if (!isMigratedMessage(msg)) throw new Error(`validateSession: message[${i}] is malformed`);
  }
  return ir;
}

/** Fold a message's blocks into a plain-text digest (for offline preview). */
export function messageToText(msg: MigratedMessage): string {
  return msg.content
    .map((b) => {
      switch (b.type) {
        case 'text':
          return b.text;
        case 'tool_use':
          return `[tool_use: ${b.name}] ${safeJson(b.input)}`;
        case 'tool_result':
          return `[tool_result] ${b.content}`;
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n');
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s && s.length > 200 ? `${s.slice(0, 200)}…` : (s ?? '');
  } catch {
    return String(v);
  }
}

/** Produce a one-line title if absent (used by GUI list). */
export function inferTitle(ir: MigratedSession): string {
  if (ir.title) return ir.title;
  const firstUser = ir.messages.find((m) => m.role === 'user');
  if (!firstUser) return '(untitled)';
  const text = messageToText(firstUser).trim().replace(/\s+/g, ' ');
  return text.length > 60 ? `${text.slice(0, 60)}…` : (text || '(untitled)');
}