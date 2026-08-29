/**
 * Unified Intermediate Representation (IR) v3 — 100% lossless (except encrypted).
 *
 * Pivot of the engine: every tool adapter reads its native storage into an IR
 * session and writes an IR session back. This is the sole N-adapter pivot
 * (not N² pairwise converters).
 *
 * Design consensus (docs/ir-protocol.md — binding for all adapters):
 *  - the IR is a LIVING protocol: when a source tool carries a concept the IR
 *    has no slot for, extending the IR (typed bucket / optional field) is the
 *    sanctioned move — never silent drops, extensions strings are a stopgap;
 *  - every piece of information must attach unambiguously to the entity it
 *    describes (session / message / block / single tool invocation) — no
 *    side-table keying by source ids that breaks under filter/reorder;
 *  - extensions are additive and optional; old adapters ignore new buckets.
 *
 * v3 breaking changes vs v2:
 *  - schemaVersion: 1 -> 2
 *  - Adds typed lossless buckets: goals / planModes / todos / unmappedEvents
 *    so DSH agent->IR is zero-loss (non-encrypted) and IR->agent discards
 *    only on the write side per target capability.
 *  - validateSession / messageToText updated; thinking preserved via
 *    ContentBlock.thinking; encrypted_content is the ONLY allowed drop.
 */

export type ToolId = 'dsh' | 'claude' | 'codex' | 'opencode' | 'pi' | 'zcode' | 'unknown';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'thinking'; thinking: string };

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface MigratedMessage {
  role: MessageRole;
  content: ContentBlock[];
  timestamp?: number;
  /** Original source-stream seq (DSH); enables exact order restoration on write-back. */
  seq?: number;
  provider?: string;
  model?: string;
  stopReason?: string;
}

export type SidechainKind = 'subagent' | 'teammate';

export interface MigratedSidechain {
  agentId: string;
  kind: SidechainKind;
  agentType?: string;
  parentMessageId?: string;
  messages: MigratedMessage[];
  /** typed lossless tool-invocation bucket, same contract as the session-level one */
  toolCalls?: MigratedToolCall[];
}

/**
 * Native tool-invocation record for stores that fuse call+result in ONE row
 * (zcode `tool` part: pending/running/completed/error four-state). This is a
 * typed lossless bucket alongside messages[]: messages carry the
 * interoperable projection (tool_use/tool_result pairs for completed/error
 * calls — replayable), the bucket carries every invocation in full native
 * fidelity (including non-replayable pending/running states and part-level
 * metadata/time). Adapters for stores without the concept simply ignore it.
 */
export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'error';

export interface MigratedToolCall {
  callId: string;
  tool: string;
  status: ToolCallStatus;
  input?: unknown;
  /** completed state: fused output text */
  output?: string;
  /** error state: the error text */
  error?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: { start?: number; end?: number };
  /** position in the source store, for exact part reconstruction on write-back */
  source?: { messageId: string; messageSequence: number; partSequence: number };
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

export interface MigratedGoal {
  seq: number;
  time: number;
  data: Record<string, unknown> & { kind?: string; version?: number };
}

export interface MigratedPlanMode {
  seq: number;
  time: number;
  data: unknown;
}

export interface MigratedTodo {
  seq: number;
  time: number;
  data: unknown;
}

export interface MigratedUnmappedEvent {
  seq: number;
  time: number;
  type: string;
  data: unknown;
  surfaceOp?: string;
  sourceEventSeqs?: number[];
}

export interface MigratedSession {
  schemaVersion: 2;
  originTool: ToolId;
  originSessionId?: string;
  title?: string;
  createdAt?: number;
  cwd?: string;
  model?: { provider?: string; id: string; variant?: string };
  thinkingLevel?: string;
  systemPrompt?: string;
  messages: MigratedMessage[];
  sidechains?: MigratedSidechain[];
  compaction?: Array<{ summary: string; tokensBefore?: number; retainedTail?: unknown[]; firstKeptId?: string }>;
  /** Typed lossless tool-invocation bucket (zcode fused call+result parts). */
  toolCalls?: MigratedToolCall[];
  branchSummaries?: Array<{ fromId: string; summary: string }>;
  /** Typed lossless domain state from DSH (goal/change). */
  goals?: MigratedGoal[];
  /** Typed lossless domain state from DSH (plan/mode). */
  planModes?: MigratedPlanMode[];
  /** Typed lossless domain state from DSH (todo/write). */
  todos?: MigratedTodo[];
  /** Catch-all for remaining non-encrypted DSH events. */
  unmappedEvents?: MigratedUnmappedEvent[];
  extensions?: Record<string, unknown>;
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

function isValidSidechain(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  if (typeof s.agentId !== 'string' || !s.agentId) return false;
  if (s.kind !== 'subagent' && s.kind !== 'teammate') return false;
  if (!Array.isArray(s.messages)) return false;
  for (const msg of s.messages as unknown[]) {
    if (!isMigratedMessage(msg)) return false;
  }
  return true;
}

const TOOL_CALL_STATUSES = new Set(['pending', 'running', 'completed', 'error']);

function isValidToolCall(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const t = v as Record<string, unknown>;
  if (typeof t.callId !== 'string' || !t.callId) return false;
  if (typeof t.tool !== 'string' || !t.tool) return false;
  if (typeof t.status !== 'string' || !TOOL_CALL_STATUSES.has(t.status)) return false;
  return true;
}

export function validateSession(ir: MigratedSession): MigratedSession {
  if (!ir || typeof ir !== 'object') throw new Error('validateSession: ir is not an object');
  if (
    (ir as unknown as Record<string, unknown>).schemaVersion !== undefined &&
    (ir as unknown as Record<string, unknown>).schemaVersion !== 2
  ) {
    throw new Error('validateSession: schemaVersion must be 2');
  }
  if (!Array.isArray(ir.messages)) throw new Error('validateSession: messages must be an array');
  for (const [i, msg] of ir.messages.entries()) {
    if (!isMigratedMessage(msg)) throw new Error(`validateSession: message[${i}] is malformed`);
  }
  if (ir.sidechains !== undefined) {
    if (!Array.isArray(ir.sidechains)) throw new Error('validateSession: sidechains must be an array');
    for (const [i, sc] of ir.sidechains.entries()) {
      if (!isValidSidechain(sc)) throw new Error(`validateSession: sidechains[${i}] is malformed`);
    }
  }
  if (ir.toolCalls !== undefined) {
    if (!Array.isArray(ir.toolCalls)) throw new Error('validateSession: toolCalls must be an array');
    for (const [i, tc] of ir.toolCalls.entries()) {
      if (!isValidToolCall(tc)) throw new Error(`validateSession: toolCalls[${i}] is malformed`);
    }
  }
  if (ir.model !== undefined) {
    if (typeof ir.model !== 'object' || ir.model === null || Array.isArray(ir.model)) {
      throw new Error('validateSession: model must be an object { id }');
    }
    const m = ir.model as Record<string, unknown>;
    if (typeof m.id !== 'string' || !m.id) throw new Error('validateSession: model.id must be a non-empty string');
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
        case 'thinking':
          return `[thinking] ${b.thinking}`;
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
  return text.length > 60 ? `${text.slice(0, 60)}…` : text || '(untitled)';
}
