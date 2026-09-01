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
 *    (codex event_msg 行等)，seq = 源日志位置。
 *
 * v3.2 additive changes (2026-08-30, claude 适配器重写驱动 — 全部为可选字段，旧适配器
 * 忽略即可，见 docs/ir-protocol.md「v3.2 登记（claude）」):
 *  - ContentBlock.tool_result 新增 rawResult?: unknown（claude user.toolUseResult
 *    结构化工具结果原文，挂在块实体上，禁止按 toolUseId 旁表；zcode 可映射融合 output）。
 *  - MigratedSession 新增 tag? / permissionMode? / prLink? / worktreeSession? /
 *    costState?（claude 高频有语义的会话级元数据行提升为类型化字段）与
 *    sessionEvents?: MigratedUnmappedEvent[]（非对话的会话级行：claude system
 *    subtype 行等；seq = 源文件行号）。MigratedSidechain 同步获得 sessionEvents?。
 *  - systemPrompt 语义冻结进共识（#8）：源端无原生提示词则留空（claude 恒空）；
 *    目标端有原生通道走原生槽位（claude = 进程 flag --append-system-prompt），
 *    无通道才注入 IR 值；禁止把源提示词写进会话正文再叠加目标端系统提示词。
 *
 * v3.2 工程加固（同日，与形状无关——不改任何槽位，只收紧约束）：
 *  - IR_VERSION 协议版本常量 + Adapter.irVersion + registry 注册时硬闸门：
 *    每次协议变更（含加性扩展）必须 bump IR_VERSION，并同步全部内置适配器；
 *    落后版本的适配器无法注册（docs/ir-protocol.md「IR 版本与同步闸门」）。
 *  - validateSession 下探到块级（isContentBlock 闭集校验）、schemaVersion 严格必填
 *    =2、originTool 闭集、会话级 goals/planModes/todos/unmappedEvents/branchSummaries
 *    逐项校验（docs/ir-protocol.md「IR 加固清单」第一层）。
 *  - readSource 出口 / writeTarget 入口引擎级 validateSession 卡点（第三层）。
 */

export type ToolId = 'dsh' | 'claude' | 'codex' | 'opencode' | 'pi' | 'zcode' | 'unknown';

/**
 * IR protocol version — the sync contract between the IR and every adapter.
 *
 * NOT the same as `MigratedSession.schemaVersion` (that one discriminates the
 * serialized payload shape and only moves on a breaking data reshape; it has
 * been 2 since v3). IR_VERSION moves on EVERY protocol change, additive ones
 * included, because additive still obliges every write side (the v3.1
 * `developer` role was additive and all six write sides had to sync).
 *
 * Rule: bump IR_VERSION with the same commit that extends the IR, sync all
 * builtin adapters in that change (their `irVersion` field must reach the new
 * value), and register the change in docs/ir-protocol.md. The registry
 * refuses to register an adapter whose irVersion is older than this constant.
 */
export const IR_VERSION = '3.2';

/** Compare two dotted IR versions ('3.2' < '3.10' < '4.0'). */
export function compareIrVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

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
  | {
      type: 'tool_result';
      toolUseId: string;
      content: string;
      isError?: boolean;
      attachments?: FileBlock[];
      /**
       * Structured tool-result payload as the SOURCE tool stored it, beyond the
       * model-visible `content` text (claude `user.toolUseResult`: Bash
       * {stdout,stderr,interrupted,isImage,noOutputExpected}, rejection string,
       * per-tool structs). Attached to the block entity itself — never a
       * toolUseId side-table (gap #6 in docs/ir-protocol.md).
       */
      rawResult?: unknown;
    }
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
  /**
   * Mini-session extension (dsh 第二轮盘点): a session-backed sidechain can
   * carry the same optional buckets as MigratedSession so the child log
   * round-trips losslessly. Adapters for flat sidechains ignore them.
   * `sidechains` nests grandchildren (DSH subagent delegation trees).
   */
  originSessionId?: string;
  title?: string;
  createdAt?: number;
  cwd?: string;
  goals?: MigratedGoal[];
  planModes?: MigratedPlanMode[];
  todos?: MigratedTodo[];
  compaction?: MigratedCompaction[];
  unmappedEvents?: MigratedUnmappedEvent[];
  /** Non-conversation session-level rows (claude system subtype rows etc.) — see SessionEvents. */
  sessionEvents?: SessionEvent[];
  /** adapter-namespaced session-level native payload, same contract as MigratedSession.meta */
  meta?: Record<string, unknown>;
  /** nested delegation tree (subagent's own subagents) */
  sidechains?: MigratedSidechain[];
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
  /** True when the source store flags the session as archived (DSH workspace.json; codex archived_sessions/). */
  archived?: boolean;
  /** True when the native index registers the session but no rollout file exists yet (codex deferred creation — nothing to migrate). */
  deferredCreation?: boolean;
  /** Parent session when this session is a subagent (codex thread_spawn parent_thread_id). */
  parentSessionId?: string;
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
  /**
   * Source-harness forward-compat envelope marker, preserved as provenance
   * only. ⚠️ Current DSH (SESSION_FORMAT_VERSION 0) has NO such mechanism:
   * `assertEventsSupported` refuses a whole log on ANY unknown event type and
   * `assertSessionEventEnvelope` rejects the key itself — so a write side
   * must NOT emit `ignorable` into DSH logs. Instead, drop unmapped rows
   * whose type the target harness does not know (see DSH_KNOWN_EVENT_TYPES);
   * the IR bucket keeps them for transfers to harnesses that do.
   */
  ignorable?: boolean;
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

/** Linked pull request (claude `pr-link` metadata row). */
export interface MigratedPrLink {
  prNumber: number;
  prUrl: string;
  prRepository: string;
  timestamp?: string;
}

/**
 * One non-conversation session-level row from the source harness — claude
 * system records whose subtype has no conversational projection
 * (turn_duration, stop_hook_summary, microcompact_boundary, model_refusal_*,
 * informational, away_summary, …) and any other non-transcript row without a
 * typed slot. Same shape as `unmappedEvents`; `seq` = source file line index.
 * Rows WITH a conversational projection are not duplicated here (local_command
 * → synthetic user message; compact_boundary → compaction[] + meta).
 */
export type SessionEvent = MigratedUnmappedEvent;

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
  /** Non-conversation session-level rows (claude system subtype rows etc.) — see SessionEvents. */
  sessionEvents?: SessionEvent[];
  /** Source tag (claude `tag` metadata row). */
  tag?: string;
  /** Source permission mode (claude `permission-mode` metadata row). */
  permissionMode?: string;
  /** Linked pull request (claude `pr-link` metadata row). */
  prLink?: MigratedPrLink;
  /** Worktree session state (claude `worktree-state` row; null = exited). Opaque source shape. */
  worktreeSession?: unknown;
  /** Cumulative session cost state (claude `cost-state` row). Opaque source shape. */
  costState?: unknown;
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
const TOOL_IDS = new Set(['dsh', 'claude', 'codex', 'opencode', 'pi', 'zcode', 'unknown']);

/**
 * Block-level closed-set guard (hardening layer 1). Unknown block types are
 * REJECTED — new block vocabulary must go through the IR evolution process
 * (docs/ir-protocol.md 设计共识 #4); temporary payloads ride `meta`/`extensions`.
 */
function isValidFileBlock(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const f = v as Record<string, unknown>;
  if (f.type !== 'file') return false;
  for (const key of ['filename', 'mediaType', 'data', 'url'] as const) {
    if (f[key] !== undefined && typeof f[key] !== 'string') return false;
  }
  return f.filename !== undefined || f.data !== undefined || f.url !== undefined;
}

export function isContentBlock(v: unknown): v is ContentBlock {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const b = v as Record<string, unknown>;
  switch (b.type) {
    case 'text':
      return typeof b.text === 'string';
    case 'tool_use':
      return typeof b.id === 'string' && !!b.id && typeof b.name === 'string' && !!b.name && b.input !== undefined;
    case 'tool_result': {
      // Empty toolUseId is the sanctioned ORPHAN marker: the source stored a
      // result whose call row is gone (codex function_call_output without
      // call_id). Fabricating a non-empty id would falsely pair it (填空政策:
      // 关联指针宁缺勿错) — consumers must treat '' as "no pairing".
      if (typeof b.toolUseId !== 'string') return false;
      if (typeof b.content !== 'string') return false;
      if (b.isError !== undefined && typeof b.isError !== 'boolean') return false;
      if (b.attachments !== undefined) {
        if (!Array.isArray(b.attachments)) return false;
        for (const att of b.attachments as unknown[]) if (!isValidFileBlock(att)) return false;
      }
      return true;
    }
    case 'thinking':
      // signature is the byte-exact lossless key: when present it must be a
      // string, never a fabricated non-string placeholder
      return typeof b.thinking === 'string' && (b.signature === undefined || typeof b.signature === 'string');
    case 'file':
      return isValidFileBlock(b);
    default:
      return false;
  }
}

export function isMigratedMessage(v: unknown): v is MigratedMessage {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  if (typeof m.role !== 'string' || !MESSAGE_ROLES.has(m.role)) return false;
  if (!Array.isArray(m.content)) return false;
  for (const block of m.content as unknown[]) {
    if (!isContentBlock(block)) return false;
  }
  if (m.meta !== undefined && (typeof m.meta !== 'object' || m.meta === null || Array.isArray(m.meta))) return false;
  if (m.seq !== undefined && typeof m.seq !== 'number') return false;
  if (m.timestamp !== undefined && typeof m.timestamp !== 'number') return false;
  if (m.synthetic !== undefined && typeof m.synthetic !== 'boolean') return false;
  for (const key of ['provider', 'model', 'stopReason'] as const) {
    if (m[key] !== undefined && typeof m[key] !== 'string') return false;
  }
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
  if (s.toolCalls !== undefined) {
    if (!Array.isArray(s.toolCalls)) return false;
    for (const tc of s.toolCalls as unknown[]) if (!isValidToolCall(tc)) return false;
  }
  if (s.unmappedEvents !== undefined) {
    if (!Array.isArray(s.unmappedEvents)) return false;
    for (const e of s.unmappedEvents as unknown[]) if (!isValidUnmappedEvent(e)) return false;
  }
  if (s.sessionEvents !== undefined) {
    if (!Array.isArray(s.sessionEvents)) return false;
    for (const e of s.sessionEvents as unknown[]) if (!isValidUnmappedEvent(e)) return false;
  }
  for (const key of ['goals', 'planModes', 'todos'] as const) {
    const bucket = s[key];
    if (bucket === undefined) continue;
    if (!Array.isArray(bucket)) return false;
    for (const g of bucket as unknown[]) {
      if (typeof g !== 'object' || g === null || Array.isArray(g)) return false;
      const entry = g as Record<string, unknown>;
      if (typeof entry.seq !== 'number' || typeof entry.time !== 'number') return false;
      if (typeof entry.data !== 'object' || entry.data === null || Array.isArray(entry.data)) return false;
    }
  }
  if (s.compaction !== undefined) {
    if (!Array.isArray(s.compaction)) return false;
    for (const c of s.compaction as unknown[]) {
      if (typeof c !== 'object' || c === null || Array.isArray(c)) return false;
      if (typeof (c as { summary?: unknown }).summary !== 'string') return false;
    }
  }
  if (s.meta !== undefined && (typeof s.meta !== 'object' || s.meta === null || Array.isArray(s.meta))) return false;
  if (s.sidechains !== undefined) {
    if (!Array.isArray(s.sidechains)) return false;
    for (const nested of s.sidechains as unknown[]) if (!isValidSidechain(nested)) return false;
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
  for (const key of ['output', 'error', 'title'] as const) {
    if (t[key] !== undefined && typeof t[key] !== 'string') return false;
  }
  if (t.metadata !== undefined && (typeof t.metadata !== 'object' || t.metadata === null || Array.isArray(t.metadata))) return false;
  if (t.time !== undefined) {
    if (typeof t.time !== 'object' || t.time === null || Array.isArray(t.time)) return false;
    const time = t.time as Record<string, unknown>;
    if (time.start !== undefined && typeof time.start !== 'number') return false;
    if (time.end !== undefined && typeof time.end !== 'number') return false;
  }
  if (t.source !== undefined) {
    if (typeof t.source !== 'object' || t.source === null || Array.isArray(t.source)) return false;
    const src = t.source as Record<string, unknown>;
    if (typeof src.messageId !== 'string' || !src.messageId) return false;
    if (typeof src.messageSequence !== 'number' || typeof src.partSequence !== 'number') return false;
  }
  return true;
}

function isValidUnmappedEvent(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  if (typeof e.seq !== 'number' || typeof e.time !== 'number') return false;
  if (typeof e.type !== 'string') return false;
  if (e.surfaceOp !== undefined && typeof e.surfaceOp !== 'string') return false;
  if (e.ignorable !== undefined && typeof e.ignorable !== 'boolean') return false;
  if (e.sourceEventSeqs !== undefined) {
    if (!Array.isArray(e.sourceEventSeqs)) return false;
    for (const s of e.sourceEventSeqs as unknown[]) if (typeof s !== 'number') return false;
  }
  return true;
}

/** Best-effort pointer to WHICH block of a malformed message failed, for error paths. */
function firstBlockProblem(msg: unknown): string {
  if (typeof msg !== 'object' || msg === null) return '';
  const m = msg as Record<string, unknown>;
  if (typeof m.role !== 'string' || !MESSAGE_ROLES.has(m.role)) return ` (role=${JSON.stringify(m.role ?? null)})`;
  if (!Array.isArray(m.content)) return ' (content not an array)';
  for (const [j, block] of (m.content as unknown[]).entries()) {
    if (!isContentBlock(block)) {
      const preview = safeJson(typeof block === 'object' && block !== null ? { ...(block as Record<string, unknown>), ...(block as Record<string, unknown>).input !== undefined ? { input: '<…>' } : {} } : block);
      return ` (content[${j}] rejected: ${preview})`;
    }
  }
  return ' (field type violation)';
}

export function validateSession(ir: MigratedSession): MigratedSession {
  if (!ir || typeof ir !== 'object') throw new Error('validateSession: ir is not an object');
  if (ir.schemaVersion !== 2) {
    throw new Error('validateSession: schemaVersion must be 2');
  }
  if (typeof ir.originTool !== 'string' || !TOOL_IDS.has(ir.originTool)) {
    throw new Error(`validateSession: originTool must be a ToolId, got ${JSON.stringify((ir as { originTool?: unknown }).originTool)}`);
  }
  if (!Array.isArray(ir.messages)) throw new Error('validateSession: messages must be an array');
  for (const [i, msg] of ir.messages.entries()) {
    if (!isMigratedMessage(msg)) throw new Error(`validateSession: message[${i}] is malformed${firstBlockProblem(msg)}`);
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
      if (comp.anchorIndex !== undefined && typeof comp.anchorIndex !== 'number') {
        throw new Error(`validateSession: compaction[${i}].anchorIndex must be a number`);
      }
      if (comp.tokensBefore !== undefined && typeof comp.tokensBefore !== 'number') {
        throw new Error(`validateSession: compaction[${i}].tokensBefore must be a number`);
      }
      if (comp.firstKeptId !== undefined && typeof comp.firstKeptId !== 'string') {
        throw new Error(`validateSession: compaction[${i}].firstKeptId must be a string`);
      }
      if (comp.retainedTail !== undefined && !Array.isArray(comp.retainedTail)) {
        throw new Error(`validateSession: compaction[${i}].retainedTail must be an array`);
      }
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
  if (ir.branchSummaries !== undefined) {
    if (!Array.isArray(ir.branchSummaries)) throw new Error('validateSession: branchSummaries must be an array');
    for (const [i, bs] of ir.branchSummaries.entries()) {
      const b = bs as Record<string, unknown> | null;
      if (typeof b !== 'object' || b === null || typeof b.fromId !== 'string' || typeof b.summary !== 'string') {
        throw new Error(`validateSession: branchSummaries[${i}] must be { fromId: string, summary: string }`);
      }
    }
  }
  for (const key of ['goals', 'planModes', 'todos'] as const) {
    const bucket = ir[key];
    if (bucket === undefined) continue;
    if (!Array.isArray(bucket)) throw new Error(`validateSession: ${key} must be an array`);
    for (const [i, g] of bucket.entries()) {
      if (typeof g !== 'object' || g === null || Array.isArray(g)) throw new Error(`validateSession: ${key}[${i}] is malformed`);
      const entry = g as unknown as Record<string, unknown>;
      if (typeof entry.seq !== 'number' || typeof entry.time !== 'number') {
        throw new Error(`validateSession: ${key}[${i}] must carry numeric seq/time`);
      }
      if (typeof entry.data !== 'object' || entry.data === null || Array.isArray(entry.data)) {
        throw new Error(`validateSession: ${key}[${i}].data must be an object`);
      }
    }
  }
  for (const key of ['unmappedEvents', 'sessionEvents'] as const) {
    const bucket = ir[key];
    if (bucket === undefined) continue;
    if (!Array.isArray(bucket)) throw new Error(`validateSession: ${key} must be an array`);
    for (const [i, e] of bucket.entries()) {
      if (!isValidUnmappedEvent(e)) throw new Error(`validateSession: ${key}[${i}] is malformed`);
    }
  }
  if (ir.meta !== undefined && (typeof ir.meta !== 'object' || ir.meta === null || Array.isArray(ir.meta))) {
    throw new Error('validateSession: meta must be an object');
  }
  if (ir.prLink !== undefined) {
    if (typeof ir.prLink !== 'object' || ir.prLink === null || Array.isArray(ir.prLink)) {
      throw new Error('validateSession: prLink must be an object');
    }
    const pr = ir.prLink as unknown as Record<string, unknown>;
    if (typeof pr.prNumber !== 'number' || typeof pr.prUrl !== 'string' || typeof pr.prRepository !== 'string') {
      throw new Error('validateSession: prLink must carry prNumber/prUrl/prRepository');
    }
  }
  if (ir.tag !== undefined && typeof ir.tag !== 'string') throw new Error('validateSession: tag must be a string');
  if (ir.permissionMode !== undefined && typeof ir.permissionMode !== 'string') throw new Error('validateSession: permissionMode must be a string');
  if (ir.systemPrompt !== undefined && typeof ir.systemPrompt !== 'string') {
    throw new Error('validateSession: systemPrompt must be a string');
  }
  if (ir.extensions !== undefined) {
    if (typeof ir.extensions !== 'object' || ir.extensions === null || Array.isArray(ir.extensions)) {
      throw new Error('validateSession: extensions must be an object');
    }
    // Guard only namespaces registered with an object contract (v3.2: claude —
    // `{ recordsRaw: unknown[] }`). zcode's legacy `syntheticMessages` bucket is
    // an array; constrain it when zcode is migrated to the object shape.
    const claude = (ir.extensions as Record<string, unknown>).claude;
    if (claude !== undefined && (typeof claude !== 'object' || claude === null || Array.isArray(claude))) {
      throw new Error('validateSession: extensions.claude must be an object');
    }
    const claudeRecordsRaw = (claude as { recordsRaw?: unknown } | undefined)?.recordsRaw;
    if (claudeRecordsRaw !== undefined && !Array.isArray(claudeRecordsRaw)) {
      throw new Error('validateSession: extensions.claude.recordsRaw must be an array');
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
