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
 *
 * v3.1 additive changes (2026-08-29, codex 适配器调查驱动 — 全部为可选字段，旧适配器
 * 忽略即可，见 docs/ir-protocol.md「v3.1 登记」):
 *  - MessageRole 新增 'developer'（Codex/OpenAI Responses 的 developer 角色，
 *    与 system 不同——resume 回放时按原角色还原，跨工具由各写端自行降级）。
 *  - MigratedSession.meta?: 会话级适配器命名空间原生载荷（与 MigratedMessage.meta
 *    同契约），承载 codex session_meta 行（source/git/history_mode/…）等。
 *  - compaction[] 新增 replacementHistory?: MigratedMessage[]（codex
 *    CompactedItem.replacement_history 的类型化投影）与 meta?:（原生记录）。
 *  - unmappedEvents 语义泛化：不再限 DSH，泛指"源 harness 事件日志"
 *    （codex event_msg 行等），seq = 源日志位置。
 */

export type ToolId = 'dsh' | 'claude' | 'codex' | 'opencode' | 'pi' | 'zcode' | 'unknown';

/**
 * File / image attachment block. One type covers both: an image is a file with
 * an `image/*` mediaType. `data` (base64) when the source store inlines the
 * bytes, `url` when it references bytes stored elsewhere — either may be
 * absent when only the name is known. (Gap #4 in docs/ir-protocol.md.)
 */
export interface FileBlock {
  type: 'file';
  filename?: string;
  mediaType?: string;
  data?: string;
  url?: string;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean; attachments?: FileBlock[] }
  | { type: 'thinking'; thinking: string; signature?: string }
  | FileBlock;

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system' | 'developer';

export interface MigratedMessage {
  role: MessageRole;
  content: ContentBlock[];
  timestamp?: number;
  /** Original source-stream seq (DSH); enables exact order restoration on write-back. */
  seq?: number;
  provider?: string;
  model?: string;
  stopReason?: string;
  /**
   * Adapter-namespaced message-level payload with no cross-tool slot (native
   * semantics/cost/tokens/time/anchor/contextSnapshot, raw non-projected
   * parts, codex ResponseItem id/phase/passthrough/envelope-metadata, …),
   * keyed by adapter: `{ zcode: {...} }`. Attached to the message
   * entity itself — never a source-id side-table (gap #2 in
   * docs/ir-protocol.md). Adapters that don't need it ignore it.
   */
  meta?: Record<string, unknown>;
  /**
   * True when the message was injected by the SOURCE harness rather than
   * typed by a human (DSH persists runtime-context snapshots and
   * `<system-reminder>` payloads as ordinary user/message events with
   * `source.kind === 'plugin'`). Target adapters decide the fate: drop, or
   * keep flagged (e.g. OpenCode `ignored: true` text parts — hidden in the
   * timeline AND excluded from LLM replay by toModelMessagesEffect).
   */
  synthetic?: boolean;
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

/**
 * One compaction (context-compression) record. `summary` + `anchorIndex`
 * travel cross-tool; the rest is source-fidelity:
 *  - `replacementHistory` — codex `CompactedItem.replacement_history`: the
 *    full kept model history that REPLACES everything before it on resume
 *    (typed projection, same message mapping as messages[]). Absent for
 *    legacy-style compaction (Pi retainedTail / codex pre-replacement era).
 *  - `meta` — adapter-namespaced native record (codex: window_number /
 *    window ids / mcp_resource_origins / raw payload; zcode: boundary row).
 */
export interface MigratedCompaction {
  summary: string;
  tokensBefore?: number;
  retainedTail?: unknown[];
  firstKeptId?: string;
  /** index into messages[] of the projected compaction-summary message */
  anchorIndex?: number;
  /** full kept-history base that supersedes everything before it (codex) */
  replacementHistory?: MigratedMessage[];
  /** adapter-namespaced native record, same contract as MigratedMessage.meta */
  meta?: Record<string, unknown>;
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
  /**
   * The SOURCE session's base system prompt (the thing the source tool sends
   * as the model's instructions slot — codex `base_instructions`, Claude
   * system prompt, …). NOT project docs like AGENTS.md/CLAUDE.md: those live
   * in messages[] as user-role content and are carried as ordinary history.
   * Write-side rule (docs/agents/codex.md §系统提示词选择规范): map to the
   * target's ONE canonical system-prompt slot — never stack it on top of the
   * target's own system prompt as an extra developer/system/user message.
   */
  messages: MigratedMessage[];
  sidechains?: MigratedSidechain[];
  /**
   * Compaction (context-compression) records. The summary text is ALSO
   * projected as a role:'user' message in messages[] by adapters that store it
   * in-stream (that message is the canonical conversation carrier — it travels
   * to targets that ignore this bucket); `anchorIndex` points at that message.
   * Native boundary records stay on the summary message's `meta` (gap #3).
   */
  compaction?: MigratedCompaction[];
  /** Typed lossless tool-invocation bucket (zcode fused call+result parts). */
  toolCalls?: MigratedToolCall[];
  branchSummaries?: Array<{ fromId: string; summary: string }>;
  /** Typed lossless domain state from DSH (goal/change). */
  goals?: MigratedGoal[];
  /** Typed lossless domain state from DSH (plan/mode). */
  planModes?: MigratedPlanMode[];
  /** Typed lossless domain state from DSH (todo/write). */
  todos?: MigratedTodo[];
  /**
   * Catch-all for the source harness's event log — originally DSH's event
   * stream, now generic (v3.1): codex `event_msg` rollout lines, etc.
   * `seq` = position in the source log (file line order when the source has
   * no explicit sequence), `type` = source event type, `data` = raw payload
   * (minus encrypted fields). Resume-relevant codex events (turn boundaries,
   * rollback, settings) are replayed by the codex write side from here.
   */
  unmappedEvents?: MigratedUnmappedEvent[];
  /**
   * Adapter-namespaced session-level native payload with no cross-tool slot
   * (codex session_meta line: source/thread_source/git/originator/
   * cli_version/history_mode/fork linkage/…), keyed by adapter:
   * `{ codex: {...} }`. Session-level mirror of MigratedMessage.meta —
   * attached to the session entity itself, never a source-id side table
   * (v3.1, docs/ir-protocol.md). Adapters that don't need it ignore it.
   */
  meta?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
  raw?: unknown;
}

/* ------------------------------------------------------------------
 * Validation helpers
 * ------------------------------------------------------------------ */

const MESSAGE_ROLES = new Set(['user', 'assistant', 'tool', 'system', 'developer']);

export function isMigratedMessage(v: unknown): v is MigratedMessage {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  if (typeof m.role !== 'string' || !MESSAGE_ROLES.has(m.role)) return false;
  if (!Array.isArray(m.content)) return false;
  if (m.meta !== undefined && (typeof m.meta !== 'object' || m.meta === null || Array.isArray(m.meta))) return false;
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
  if (ir.compaction !== undefined) {
    if (!Array.isArray(ir.compaction)) throw new Error('validateSession: compaction must be an array');
    for (const [i, c] of ir.compaction.entries()) {
      if (typeof c !== 'object' || c === null || Array.isArray(c)) throw new Error(`validateSession: compaction[${i}] is malformed`);
      if (typeof (c as { summary?: unknown }).summary !== 'string') throw new Error(`validateSession: compaction[${i}].summary must be a string`);
      const comp = c as MigratedCompaction;
      if (comp.replacementHistory !== undefined) {
        if (!Array.isArray(comp.replacementHistory)) throw new Error(`validateSession: compaction[${i}].replacementHistory must be an array`);
        for (const [j, msg] of comp.replacementHistory.entries()) {
          if (!isMigratedMessage(msg)) throw new Error(`validateSession: compaction[${i}].replacementHistory[${j}] is malformed`);
        }
      }
      if (comp.meta !== undefined && (typeof comp.meta !== 'object' || comp.meta === null || Array.isArray(comp.meta))) {
        throw new Error(`validateSession: compaction[${i}].meta must be an object`);
      }
    }
  }
  if (ir.meta !== undefined && (typeof ir.meta !== 'object' || ir.meta === null || Array.isArray(ir.meta))) {
    throw new Error('validateSession: meta must be an object');
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
        case 'file':
          return `[file${b.filename ? `: ${b.filename}` : b.mediaType ? `: ${b.mediaType}` : ''}]`;
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
