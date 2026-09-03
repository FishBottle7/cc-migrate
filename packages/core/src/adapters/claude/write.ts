/**
 * Claude Code adapter — WRITE side.
 *
 * Native-shape recipes, machine-verified by §12 (a hand-forged session built
 * with these stamps was loaded by the real 2.1.251 binary, replayed correctly
 * through a mock Anthropic API, and claude appended follow-up records natively
 * onto it):
 *
 *  - insertMessageChain stamp order (sessionStorage.ts:1039-1064):
 *    parentUuid → logicalParentUuid? → isSidechain → teamName? → agentName?
 *    → promptId?(user only) → agentId? → message → userType → entrypoint → cwd
 *    → sessionId → (session_id) → version → gitBranch → slug → sessionKind.
 *    2.1.251 real-file order confirmed: uuid/timestamp land right after
 *    message, stamp fields end the row.
 *  - EVERY tool_result becomes its OWN user record with parentUuid overridden
 *    to the assistant that emitted the tool_use (sourceToolAssistantUUID) —
 *    never one fat user record (§9#5).
 *  - terminal last-prompt carries leafUuid and NO cwd (§2.5/§7).
 *  - compaction = system/compact_boundary row (parentUuid=null, full
 *    compactMetadata) + isCompactSummary/isVisibleInTranscriptOnly user record.
 *  - IR.systemPrompt is ignored (红线 #3/#8): no system prompt ever enters the
 *    jsonl — the engine passes --append-system-prompt at process level.
 */

import { randomUUID } from 'node:crypto';
import type {
  ContentBlock,
  MigratedCompaction,
  MigratedMessage,
  MigratedSession,
  MigratedSidechain,
} from '../../ir.js';

/* ------------------------------------------------------------------
 * Stamp envelope
 * ------------------------------------------------------------------ */

export interface WriteStamp {
  sessionId: string;
  cwd: string;
  version: string;
  gitBranch?: string;
  slug?: string;
  userType?: string;
  entrypoint?: string;
  sessionKind?: string;
  /** write the snake_case session_id twin (2.1.227+ double-write) */
  snakeSessionId?: boolean;
}

interface ChainState {
  records: Record<string, unknown>[];
  /** sequential chain parent (last chain participant written) */
  parentUuid: string | null;
  /** toolUseId → assistant record uuid (for tool_result parent override) */
  toolUseOwner: Map<string, string>;
  /** original source-row uuids materialized by the projection — their
   *  recordsRaw ride-through copies are skipped (represented, not lost) */
  emittedUuids: Set<string>;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function stripUndefined(rec: Record<string, unknown>): void {
  for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
}

/* ------------------------------------------------------------------
 * IR blocks → native blocks
 * ------------------------------------------------------------------ */

export function claudeNativeBlock(block: ContentBlock): Record<string, unknown> {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'tool_use') {
    return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
  }
  if (block.type === 'thinking') {
    // signature 是签名不是密文：有则逐字节携带（红线 #2）
    return block.signature !== undefined
      ? { type: 'thinking', thinking: block.thinking, signature: block.signature }
      : { type: 'thinking', thinking: block.thinking };
  }
  if (block.type === 'file') {
    if (block.data) {
      return { type: 'image', source: { type: 'base64', media_type: block.mediaType ?? 'image/png', data: block.data } };
    }
    if (block.url) {
      return { type: 'image', source: { type: 'url', url: block.url } };
    }
    return { type: 'text', text: `[file${block.filename ? `: ${block.filename}` : ''}]` };
  }
  const out: Record<string, unknown> = {
    type: 'tool_result',
    tool_use_id: block.toolUseId,
    content: block.content,
    is_error: !!block.isError,
  };
  if (block.attachments?.length) {
    out.content = [{ type: 'text', text: block.content }, ...block.attachments.map(claudeNativeBlock)];
  }
  return out;
}

/* ------------------------------------------------------------------
 * Message → records
 * ------------------------------------------------------------------ */

interface EmitCtx {
  stamp: WriteStamp;
  state: ChainState;
  isSidechain: boolean;
  agentId?: string;
  /** monotonic timestamp source */
  at: () => number;
}

function normalizeLastPrompt(text: string): string {
  const flat = text.replace(/\n/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200).trim()}…` : flat;
}

/** getFirstMeaningfulUserMessageTextContent analog for the last-prompt row. */
function messageFirstText(msg: MigratedMessage): string {
  const parts: string[] = [];
  for (const b of msg.content) {
    if (b.type === 'text') parts.push(b.text);
  }
  return normalizeLastPrompt(parts.join(' '));
}

/** last-prompt.leafUuid: the final user/assistant uuid on the written chain. */
function lastLeafUuidOf(records: Record<string, unknown>[]): string | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if ((r.type === 'user' || r.type === 'assistant') && typeof r.uuid === 'string') return r.uuid;
  }
  return undefined;
}

/** Join a message's text blocks (file/attachments render as placeholders, mirroring claudeNativeBlock). */
function plainOf(msg: MigratedMessage): string {
  return msg.content
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'file') return `[file: ${b.filename ?? b.url ?? b.mediaType ?? 'attachment'}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function envelopeFromMeta(meta: Record<string, unknown>): Partial<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  // teamName/agentName/promptId precede the message in the native stamp order
  // (insertMessageChain); userType/entrypoint/version are stamped AFTER the
  // chain body below — never ride the early spread.
  for (const key of ['teamName', 'agentName', 'promptId'] as const) {
    if (meta[key] !== undefined) out[key] = meta[key];
  }
  return out;
}

/**
 * P1-C: native.content 透传前置校验——其 tool_use id 集合必须与 IR 块一致
 * （双向子集判定）。toolUseOwner 按 IR 块登记、tool_result 也按 IR id 配对，
 * 透传携带 IR 之外的 tool_use id（或缺失 IR id）会写出文件中不存在的
 * tool_use_id（配对断裂）。宁缺勿错：不一致则丢弃 native content 回退 IR 块重建。
 */
function nativeToolUseIdsConsistent(nativeContent: unknown[], blocks: ContentBlock[]): boolean {
  const irIds = new Set(
    blocks
      .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      .map((b) => b.id),
  );
  const nativeIds = new Set<string>();
  for (const b of nativeContent) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
    const blk = b as Record<string, unknown>;
    if (blk.type !== 'tool_use') continue;
    if (typeof blk.id !== 'string') return false; // 形状异常的 tool_use：宁缺勿错
    nativeIds.add(blk.id);
  }
  if (nativeIds.size !== irIds.size) return false;
  for (const id of nativeIds) if (!irIds.has(id)) return false;
  return true;
}

function emitMessage(ctx: EmitCtx, msg: MigratedMessage, opts: { compactSummary?: boolean } = {}): void {
  const { stamp: st, state } = ctx;
  // 红线 #2: original row timestamps ride IR (msg.timestamp) — only fabricate
  // when absent (cross-harness IR / synthesized rows)
  const ts = typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp)
    ? iso(msg.timestamp)
    : iso(ctx.at());
  const meta = (msg.meta?.claude ?? {}) as Record<string, unknown>;
  /** original source-row uuid — records its ride-through copy as represented */
  const trackEmitted = (): void => {
    if (typeof meta.uuid === 'string' && meta.uuid) state.emittedUuids.add(meta.uuid);
  };
  const native = (meta.message ?? undefined) as Record<string, unknown> | undefined;
  const env = envelopeFromMeta(meta);
  const sidechainFields = {
    ...(meta.teamName !== undefined ? { teamName: meta.teamName } : {}),
    ...(meta.agentName !== undefined ? { agentName: meta.agentName } : {}),
    ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
  };
  const isSidechain = ctx.isSidechain;

  if (msg.role === 'assistant') {
    // ---- assistant: tool_use blocks; tool_results are separate user rows ----
    // Applies to sidechains too: a sidechain assistant gated out of this
    // branch would fall into the user-family path below and be written as a
    // type:'user' record (subagent output re-read as human input).
    const content = msg.content.filter((b) => b.type !== 'tool_result').map(claudeNativeBlock);
    if (!content.length) return;
    let message: Record<string, unknown>;
    if (
      native &&
      Array.isArray(native.content) &&
      (native.content as unknown[]).length > 0 &&
      nativeToolUseIdsConsistent(native.content, msg.content)
    ) {
      // claude→claude: keep the native message object verbatim (id/model/usage/
      // stop_reason/context_management/redacted_thinking/caller/…)。
      // 前置一致性校验（P1-C）：透传的 tool_use id 必须与 IR 块一致——
      // 否则 tool_result 配对断裂，回退 IR 块重建（宁缺勿错）。
      message = { ...native };
    } else {
      message = {
        id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        container: null,
        model: msg.model ?? 'claude-sonnet-4-5',
        role: 'assistant',
        stop_reason: msg.stopReason ?? 'end_turn',
        stop_sequence: null,
        type: 'message',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        },
        content,
      };
    }
    const uuid = randomUUID();
    const record: Record<string, unknown> = {
      type: 'assistant',
      parentUuid: state.parentUuid,
      isSidechain,
      ...env,
      message,
      uuid,
      timestamp: ts,
      requestId: typeof meta.requestId === 'string' ? meta.requestId : undefined,
      ...(meta.isApiErrorMessage === true ? { isApiErrorMessage: true } : {}),
      userType: st.userType ?? 'external',
      entrypoint: st.entrypoint ?? 'cli',
      cwd: st.cwd,
      sessionId: st.sessionId,
      ...(st.snakeSessionId ? { session_id: st.sessionId } : {}),
      version: st.version,
      gitBranch: st.gitBranch,
      slug: st.slug,
      sessionKind: st.sessionKind,
    };
    stripUndefined(record);
    state.records.push(record);
    state.parentUuid = uuid;
    trackEmitted();
    for (const b of msg.content) {
      if (b.type === 'tool_use') state.toolUseOwner.set(b.id, uuid);
    }
    return;
  }

  // keepSynthetic write-back: native attachment / local_command rows restore
  // their ORIGINAL row shape (type:'attachment' + attachment object; system
  // local_command) instead of the text projection — the projection is for
  // display; the original structure is what a claude→claude round-trip needs.
  // (The keep-gate upstream drops these rows unless keepSynthetic, so reaching
  // here with meta.attachment / systemSubtype set means keepSynthetic is on.)
  if (meta.attachment !== undefined && typeof meta.attachment === 'object') {
    // native key order (real-file verified): parentUuid, isSidechain,
    // attachment, type, uuid, timestamp, envelope
    const uuid = randomUUID();
    const record: Record<string, unknown> = {
      parentUuid: state.parentUuid,
      isSidechain,
      attachment: meta.attachment,
      type: 'attachment',
      uuid,
      timestamp: ts,
      userType: st.userType ?? 'external',
      entrypoint: st.entrypoint ?? 'cli',
      cwd: st.cwd,
      sessionId: st.sessionId,
      ...(st.snakeSessionId ? { session_id: st.sessionId } : {}),
      version: st.version,
      gitBranch: st.gitBranch,
      slug: st.slug,
      sessionKind: st.sessionKind,
    };
    stripUndefined(record);
    state.records.push(record);
    state.parentUuid = uuid;
    trackEmitted();
    return;
  }
  if (meta.systemSubtype === 'local_command') {
    // native key order: parentUuid, isSidechain, type, subtype, content,
    // level, timestamp, uuid, isMeta, envelope
    const text = msg.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const uuid = randomUUID();
    const record: Record<string, unknown> = {
      parentUuid: state.parentUuid,
      isSidechain,
      type: 'system',
      subtype: 'local_command',
      content: text,
      ...(meta.level !== undefined ? { level: meta.level } : {}),
      timestamp: ts,
      uuid,
      ...(meta.isMeta === true ? { isMeta: true } : {}),
      userType: st.userType ?? 'external',
      entrypoint: st.entrypoint ?? 'cli',
      cwd: st.cwd,
      sessionId: st.sessionId,
      ...(st.snakeSessionId ? { session_id: st.sessionId } : {}),
      version: st.version,
      gitBranch: st.gitBranch,
      slug: st.slug,
      sessionKind: st.sessionKind,
    };
    stripUndefined(record);
    state.records.push(record);
    state.parentUuid = uuid;
    trackEmitted();
    return;
  }

  // v3.1 developer-role rule (docs/ir-protocol.md): claude 并入 system。A
  // foreign system/developer row must NOT reach the user-family below — that
  // would write it as a model-visible type:'user' row (the model reads it as
  // human input). type:'system' with an unknown subtype round-trips into the
  // sessionEvents bucket on re-parse (parse.ts classifies non-transcript
  // subtypes there), so the payload survives claude→claude.
  if (msg.role === 'system' || msg.role === 'developer') {
    const text = plainOf(msg);
    const uuid = randomUUID();
    const record: Record<string, unknown> = {
      parentUuid: state.parentUuid,
      isSidechain,
      type: 'system',
      subtype: typeof meta.systemSubtype === 'string' ? meta.systemSubtype : msg.role === 'developer' ? 'external_developer' : 'external',
      ...(text ? { content: text } : {}),
      ...(meta.level !== undefined ? { level: meta.level } : {}),
      timestamp: ts,
      uuid,
      ...(msg.synthetic === true ? { isMeta: true } : {}),
      userType: st.userType ?? 'external',
      entrypoint: st.entrypoint ?? 'cli',
      cwd: st.cwd,
      sessionId: st.sessionId,
      ...(st.snakeSessionId ? { session_id: st.sessionId } : {}),
      version: st.version,
      gitBranch: st.gitBranch,
      slug: st.slug,
      sessionKind: st.sessionKind,
    };
    stripUndefined(record);
    state.records.push(record);
    state.parentUuid = uuid;
    trackEmitted();
    return;
  }

  // ---- user-family rows ----
  const trBlocks = msg.content.filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result');
  const plain = msg.content.filter((b) => b.type !== 'tool_result');
  const nativeContent = Array.isArray(native?.content) ? (native!.content as Array<Record<string, unknown>>) : undefined;

  // 1) non-tool_result content → one user record
  if (plain.length) {
    let messageContent: unknown = plain.map(claudeNativeBlock);
    if (
      native &&
      typeof native.content === 'string' &&
      plain.length === 1 &&
      plain[0].type === 'text'
    ) {
      // claude→claude: restore the native string-content shape
      messageContent = native.content;
    }
    const uuid = randomUUID();
    const record: Record<string, unknown> = {
      type: 'user',
      parentUuid: state.parentUuid,
      isSidechain,
      ...env,
      message: { role: 'user', content: messageContent },
      ...(msg.synthetic === true ? { isMeta: true } : {}),
      ...(opts.compactSummary === true ? { isCompactSummary: true, isVisibleInTranscriptOnly: true } : {}),
      uuid,
      timestamp: ts,
      userType: st.userType ?? 'external',
      entrypoint: st.entrypoint ?? 'cli',
      cwd: st.cwd,
      sessionId: st.sessionId,
      ...(st.snakeSessionId ? { session_id: st.sessionId } : {}),
      version: st.version,
      gitBranch: st.gitBranch,
      slug: st.slug,
      sessionKind: st.sessionKind,
    };
    stripUndefined(record);
    state.records.push(record);
    state.parentUuid = uuid;
    trackEmitted();
  }

  // 2) each tool_result → its own user record, parentUuid overridden to the
  //    assistant that emitted the tool_use (DAG edge, not the sequential parent)
  let trPos = 0;
  for (const tr of trBlocks) {
    const owner = ctx.state.toolUseOwner.get(tr.toolUseId);
    const nativeTr = nativeContent?.find(
      (b) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_result' &&
        (b as Record<string, unknown>).tool_use_id === tr.toolUseId,
    ) as Record<string, unknown> | undefined;
    const block = nativeTr ? { ...nativeTr } : claudeNativeBlock(tr);
    if (tr.isError && block.is_error === undefined) block.is_error = true;
    trPos += 1;
    const uuid = randomUUID();
    const record: Record<string, unknown> = {
      type: 'user',
      parentUuid: owner ?? state.parentUuid,
      isSidechain,
      ...env,
      message: { role: 'user', content: [block] },
      uuid,
      timestamp: ts,
      toolUseResult: sanitizeToolUseResult((tr as { rawResult?: unknown }).rawResult),
      sourceToolAssistantUUID: owner ?? state.parentUuid,
      userType: st.userType ?? 'external',
      entrypoint: st.entrypoint ?? 'cli',
      cwd: st.cwd,
      sessionId: st.sessionId,
      ...(st.snakeSessionId ? { session_id: st.sessionId } : {}),
      version: st.version,
      gitBranch: st.gitBranch,
      slug: st.slug,
      sessionKind: st.sessionKind,
    };
    stripUndefined(record);
    state.records.push(record);
    // tool_result 不改变后续消息的链挂点语义：下一条消息按文件序接到它之后
    state.parentUuid = uuid;
    trackEmitted();
  }
  void trPos;
}

/** FHe() analog: toolUseResult must be JSON-serializable before persisting. */
function sanitizeToolUseResult(raw: unknown): unknown {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object') return raw;
  try {
    JSON.stringify(raw);
    return raw;
  } catch {
    return String(raw);
  }
}

/* ------------------------------------------------------------------
 * Main build
 * ------------------------------------------------------------------ */

export interface BuiltMain {
  records: Record<string, unknown>[];
  lastLeafUuid?: string;
}

/**
 * Build the main jsonl records: header metadata rows → conversation chain →
 * terminal last-prompt. Sidechains are built separately (buildSidechain).
 */
export function buildMainRecords(
  ir: MigratedSession,
  sessionId: string,
  opts: { targetCwd: string; keepSynthetic?: boolean; nowMs?: number },
): BuiltMain {
  const st: WriteStamp = {
    sessionId,
    cwd: opts.targetCwd || (ir.cwd ?? ''),
    version: '2.1.251',
    gitBranch: 'master',
    userType: 'external',
    entrypoint: 'cli',
    snakeSessionId: true,
  };
  let clock = opts.nowMs ?? Date.now();
  const at = (): number => (clock += 1);
  const ctx: EmitCtx = { stamp: st, state: { records: [], parentUuid: null, toolUseOwner: new Map(), emittedUuids: new Set() }, isSidechain: false, at };

  // ---- header rows (materializeSessionFile 实测头序: ai-title/agent-name/mode/…) ----
  const header: Record<string, unknown>[] = [];
  if (ir.title) header.push({ type: 'ai-title', aiTitle: ir.title, sessionId });
  const claudeMeta = (ir.meta?.claude ?? {}) as Record<string, unknown>;
  const md = (claudeMeta.metadata ?? {}) as Record<string, unknown>;
  // structurally-unknown B-class rows (relocated / isolated-latch / frame-link /
  // queue-operation / …) ride through verbatim; rewritten rows are not duplicated
  const metaRows = md.rows as Record<string, unknown>[] | undefined;
  if (Array.isArray(metaRows)) {
    for (const row of metaRows) {
      const t = row?.type;
      if (t === 'ai-title' || t === 'last-prompt') continue; // 重写的行不重复
      header.push({ ...row, sessionId } as Record<string, unknown>);
    }
  }
  if (typeof claudeMeta.mode === 'string') header.push({ type: 'mode', mode: claudeMeta.mode, sessionId });
  else if (typeof md.mode === 'string') header.push({ type: 'mode', mode: md.mode, sessionId });
  if (typeof md.agentName === 'string' && !header.some((h) => h.type === 'agent-name')) {
    header.push({ type: 'agent-name', agentName: md.agentName, sessionId });
  }
  if (typeof md.agentColor === 'string') header.push({ type: 'agent-color', agentColor: md.agentColor, sessionId });
  if (md.agentSetting !== undefined) header.push({ type: 'agent-setting', agentSetting: md.agentSetting, sessionId });
  if (md.atisLatch !== undefined && typeof md.atisLatch === 'object') {
    header.push({ ...(md.atisLatch as Record<string, unknown>), sessionId });
  }
  if (ir.tag) header.push({ type: 'tag', tag: ir.tag, sessionId });
  if (ir.permissionMode) header.push({ type: 'permission-mode', permissionMode: ir.permissionMode, sessionId });
  if (ir.worktreeSession !== undefined) {
    header.push({ type: 'worktree-state', worktreeSession: ir.worktreeSession, sessionId });
  }
  if (ir.prLink) {
    header.push({
      type: 'pr-link',
      sessionId,
      prNumber: ir.prLink.prNumber,
      prUrl: ir.prLink.prUrl,
      prRepository: ir.prLink.prRepository,
      ...(typeof ir.prLink.timestamp === 'string' ? { timestamp: ir.prLink.timestamp } : { timestamp: iso(clock) }),
    });
  }
  if (ir.costState) header.push({ ...(ir.costState as Record<string, unknown>), sessionId });

  // ---- conversation chain ----
  // compaction[] 需要转换成 boundary + isCompactSummary 记录对，插在 anchorIndex 位置
  const compactByAnchor = new Map<number, MigratedCompaction>();
  (ir.compaction ?? []).forEach((c) => {
    if (typeof c.anchorIndex === 'number' && c.anchorIndex >= 0 && c.anchorIndex < ir.messages.length) {
      compactByAnchor.set(c.anchorIndex, c);
    } else if (typeof c.anchorIndex === 'number') {
      // P1-D: 越界 anchorIndex 不再静默整条丢 —— boundary 失去锚定点就不能落盘
      // （不能伪造位置），显式警告；entry 本身留在 IR 桶不丢。非 number（遗留
      // summary 行缺 anchorIndex）保持静默跳过，那是合法的历史形状。
      console.warn(
        `[claude write] compaction anchorIndex ${c.anchorIndex} out of range (messages.length=${ir.messages.length}) — boundary skipped`,
      );
    }
  });
  // anchorIndex 指向 messages[] 中的摘要消息；重放时在它之前插入 boundary，
  // 摘要文本由 emitCompactionPair 的 isCompactSummary 行承载 —— anchor 消息里
  // 构成摘要的 text 块跳过（否则同一份摘要落盘两遍，真机 9c958067 实测复现），
  // 其余块（额外 text/tool_use/file）照常 emit（P1-D：不再整条丢弃——额外块
  // 属于对话内容，丢了即丢上下文）。
  // keep-gate: isMeta user rows replay into model context (§2.2, 红线 #2) —
  // keep them even when synthetic rows are otherwise dropped; local_command
  // 同族（§2.3：转用户文本进 API 回放，非 presentation-only，P1-A）；其余
  // synthetic family（attachment / runtime-injected rows）is presentation-only
  // and skips unless keepSynthetic is set.
  const keepGate = (m: MigratedMessage): boolean => {
    const cm = (m.meta?.claude ?? {}) as Record<string, unknown>;
    return (
      m.synthetic !== true ||
      opts.keepSynthetic === true ||
      (m.synthetic === true && cm.isMeta === true) ||
      cm.systemSubtype === 'local_command' ||
      m.content.some((b) => b.type === 'tool_result')
    );
  };
  for (let i = 0; i < ir.messages.length; i++) {
    const msg = ir.messages[i];
    const comp = compactByAnchor.get(i);
    if (comp) {
      emitCompactionPair(ctx, comp);
      const rest = stripSummaryBlocks(msg, comp.summary);
      if (rest.length && keepGate({ ...msg, content: rest })) {
        emitMessage(ctx, { ...msg, content: rest });
      }
      continue;
    }
    if (!keepGate(msg)) continue;
    emitMessage(ctx, msg);
  }

  // ---- sessionEvents: 非对话行直通重放（v3.2 登记：其余全部入桶、写端直通） ----
  for (const ev of ir.sessionEvents ?? []) {
    const rec = (ev.data ?? {}) as Record<string, unknown>;
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    const t = rec.type;
    if (typeof t !== 'string') continue;
    if (t === 'system') {
      // P0-A: 原生 system 行（turn_duration / stop_hook_summary /
      // microcompact_boundary / model_refusal_* / informational / …）原样重放
      // data。compact_boundary 例外：读端把它路由进 compaction 桶（与
      // isCompactSummary 摘要配对、parentUuid=null 截断链），正常 IR 的桶里不会
      // 出现；外来 IR 硬塞时重放会造出第二份无配对 boundary（双写），跳过。
      if (rec.subtype === 'compact_boundary') continue;
      // 换新 uuid + 重锚 parentUuid：跨工具 IR 的源 uuid/parentUuid 在本文件中
      // 不存在，悬挂行进不了 parentUuid 图，re-parse 时进不了链/尾随子树、回不
      // 了桶。原始 uuid 登记 emittedUuids —— recordsRaw 兜底副本按「已被投影
      // 代表」跳过，防双写。
      const uuid = randomUUID();
      const clone: Record<string, unknown> = { ...rec, parentUuid: ctx.state.parentUuid, uuid, sessionId };
      if (st.snakeSessionId && rec.session_id !== undefined) clone.session_id = sessionId;
      ctx.state.records.push(clone);
      ctx.state.parentUuid = uuid;
      if (typeof rec.uuid === 'string' && rec.uuid) ctx.state.emittedUuids.add(rec.uuid);
      continue;
    }
    if (TRANSCRIPT_ROW_TYPES.has(t)) ctx.state.records.push({ ...rec, sessionId });
  }

  // ---- terminal last-prompt (leafUuid = 末条 user/assistant; 不带 cwd) ----
  const leaf = lastLeafUuidOf(ctx.state.records); // chain-only — ride rows follow

  // ---- recordsRaw ride-through (§8#7): claude→claude byte-level branch ----
  // restoration. Rows the projection did not materialize ride verbatim —
  // folded compaction segments, dead rewind branches, historical boundaries,
  // system subtype rows — with only the session identity re-stamped, so every
  // parentUuid in the output resolves inside the file (native invariant) and
  // no non-encrypted source row is lost. Metadata rows re-emitted in the
  // header are skipped by type (last-prompt/ai-title ride too: the rewritten
  // terminal row is appended after and wins last-wins on re-read).
  const rawRecords = ((ir.extensions?.claude as Record<string, unknown> | undefined)?.recordsRaw ?? []) as Record<string, unknown>[];
  const headerTypes = new Set(header.map((h) => h.type));
  for (const raw of rawRecords) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const t = typeof r.type === 'string' ? r.type : undefined;
    if (typeof r.uuid === 'string' && r.uuid && ctx.state.emittedUuids.has(r.uuid)) continue; // represented by the projection
    if (t !== undefined && headerTypes.has(t) && t !== 'last-prompt' && t !== 'ai-title') continue;
    const clone: Record<string, unknown> = { ...r, sessionId };
    if (st.snakeSessionId && r.session_id !== undefined) clone.session_id = sessionId;
    ctx.state.records.push(clone);
  }

  const records = [...header, ...ctx.state.records];
  const lastUser = [...ir.messages].reverse().find(
    (m) => m.role === 'user' && m.synthetic !== true && m.content.some((b) => b.type === 'text'),
  );
  const lastPrompt = lastUser ? normalizeLastPrompt(messageFirstText(lastUser)) : undefined;
  if (lastPrompt !== undefined || leaf !== undefined) {
    const lp: Record<string, unknown> = { type: 'last-prompt', sessionId };
    if (lastPrompt) lp.lastPrompt = lastPrompt;
    if (leaf) lp.leafUuid = leaf;
    records.push(lp);
  }
  return { records, lastLeafUuid: leaf ?? undefined };
}

const TRANSCRIPT_ROW_TYPES = new Set(['last-prompt', 'ai-title']);

/**
 * P1-D: anchor 消息摘除构成 compaction 摘要的 text 块（emitCompactionPair 的
 * isCompactSummary 行已承载摘要全文，重放会落盘两遍），其余块原样保留。
 * 摘要块识别 = 等价文本块的拼接（其余实现如按 subsequence 精确切分，在
 * 摘要块与额外 text 交错/部分重叠时会把额外内容误判成摘要块整体丢弃）。
 */
function stripSummaryBlocks(msg: MigratedMessage, summary: string): ContentBlock[] {
  const summaryText = summary.trim();
  if (!summaryText) return [...msg.content];
  const rest: ContentBlock[] = [];
  let remaining = summaryText;
  for (const b of msg.content) {
    const text = b.type === 'text' ? b.text.trim() : '';
    const isSummaryBlock = text !== '' && remaining.includes(text);
    if (isSummaryBlock) {
      const idx = remaining.indexOf(text);
      remaining = (remaining.slice(0, idx) + remaining.slice(idx + text.length)).trim();
      continue;
    }
    rest.push(b);
  }
  return rest;
}

/** sidechain file records (isSidechain:true + agentId stamps). */
export function buildSidechainRecords(
  sc: MigratedSidechain,
  sessionId: string,
  opts: { targetCwd: string; keepSynthetic?: boolean; nowMs?: number },
): { records: Record<string, unknown>[]; meta: Record<string, unknown> } {
  const st: WriteStamp = {
    sessionId,
    cwd: opts.targetCwd || '',
    version: '2.1.251',
    gitBranch: undefined,
    userType: 'external',
    entrypoint: 'cli',
  };
  let clock = opts.nowMs ?? Date.now();
  const ctx: EmitCtx = {
    stamp: st,
    state: { records: [], parentUuid: null, toolUseOwner: new Map(), emittedUuids: new Set() },
    isSidechain: true,
    at: () => (clock += 1),
    agentId: sc.agentId,
  };
  for (const msg of sc.messages) {
    const scMeta = (msg.meta?.claude ?? {}) as Record<string, unknown>;
    // keep-gate 与主链同一规则（P1-A）：isMeta 与 local_command 参与 API 回放，
    // 非 presentation-only，不随 keepSynthetic 默认丢弃。
    const isReplayRow = scMeta.isMeta === true || scMeta.systemSubtype === 'local_command';
    if (msg.synthetic === true && opts.keepSynthetic !== true && !isReplayRow && !msg.content.some((b) => b.type === 'tool_result')) continue;
    emitMessage(ctx, msg);
  }
  // 红线 #2: the original .meta.json sidecar (toolUseId/name/color/agentType…)
  // rides IR as sc.meta.claude.agentMeta — write it back, target fields last
  const agentMeta = ((sc.meta?.claude as Record<string, unknown> | undefined)?.agentMeta ?? {}) as Record<string, unknown>;
  const meta: Record<string, unknown> = {
    ...agentMeta,
    agentType: sc.agentType ?? (typeof agentMeta.agentType === 'string' ? agentMeta.agentType : 'general-purpose'),
  };
  return { records: ctx.state.records, meta };
}

/** compaction entry → native boundary record + isCompactSummary user record. */
function emitCompactionPair(ctx: EmitCtx, c: MigratedCompaction): void {
  const claudeMeta = (c.meta?.claude ?? {}) as Record<string, unknown>;
  const cm = (claudeMeta.compactMetadata ?? {}) as Record<string, unknown>;
  const boundaryRecord = claudeMeta.boundaryRecord as Record<string, unknown> | undefined;
  const boundary: Record<string, unknown> =
    boundaryRecord &&
    typeof boundaryRecord === 'object' &&
    (boundaryRecord as { subtype?: string }).subtype === 'compact_boundary'
      ? { ...boundaryRecord, parentUuid: null }
      : {
          type: 'system',
          subtype: 'compact_boundary',
          content: 'Conversation compacted',
          level: 'info',
          compactMetadata: {
            trigger: 'manual',
            ...(typeof c.tokensBefore === 'number' ? { preTokens: c.tokensBefore } : {}),
            ...cm,
          },
          uuid: randomUUID(),
          timestamp: iso(ctx.at()),
        };
  boundary.parentUuid = null; // compact boundary 截断链（§4）
  if (typeof boundary.uuid !== 'string' || !boundary.uuid) boundary.uuid = randomUUID();
  // both the emitted boundary (original uuid on ride-through) and the source
  // isCompactSummary row count as represented — their raw copies are skipped
  ctx.state.emittedUuids.add(boundary.uuid as string);
  if (typeof claudeMeta.summaryUuid === 'string' && claudeMeta.summaryUuid) {
    ctx.state.emittedUuids.add(claudeMeta.summaryUuid);
  }
  // P0-B: 跨工具新 uuid 体系下，preservedSegment/preservedMessages 引用的
  // 旧 uuid 不在本文件内——claude 读端剪枝算法按这些 uuid 收集保留段并删除
  // "最后 boundary 之前"的其余行（实测 5 进 3 出）。因此引用未发射 uuid 时
  // 直接删除这两个字段：原生读端对缺 preserved 元数据的 boundary 是 no-op +
  // 全史加载，比悬挂引用更保真。不做全量 rekey（§8: rekey 需覆盖 7+ 类交叉
  // 引用，漏一类即静默丢上下文，宁缺勿错）。anchorUuid 例外：它按 §3 指向
  // boundary/摘要自身（本对刚登记），不参与存活判定；保留段若真被投影保留
  // （claude 源经 recordsRaw 或活跃链），其消息 uuid 已在 emittedUuids 中。
  {
    const emitted = ctx.state.emittedUuids;
    const cmAll = (boundary.compactMetadata ?? {}) as {
      preservedSegment?: { headUuid?: string; anchorUuid?: string; tailUuid?: string };
      preservedMessages?: { anchorUuid?: string; uuids?: string[] };
    };
    const live = (refs: unknown[]): boolean =>
      refs.every((u) => u === undefined || (typeof u === 'string' && emitted.has(u)));
    const seg = cmAll.preservedSegment;
    const pm = cmAll.preservedMessages;
    const segDead = seg !== undefined && !live([seg.headUuid, seg.tailUuid]);
    const pmDead = pm !== undefined && !live(Array.isArray(pm.uuids) ? pm.uuids : []);
    if (segDead || pmDead) {
      const cmClone = { ...(boundary.compactMetadata as Record<string, unknown>) };
      if (segDead) delete cmClone.preservedSegment;
      if (pmDead) delete cmClone.preservedMessages;
      boundary.compactMetadata = cmClone;
    }
  }
  if (typeof cm.logicalParentUuid === 'string') {
    boundary.logicalParentUuid = cm.logicalParentUuid;
  } else if (ctx.state.parentUuid) {
    boundary.logicalParentUuid = ctx.state.parentUuid;
  }
  ctx.state.records.push(boundary);
  // summary 文本作为 isCompactSummary user 记录接在 boundary 之后
  ctx.state.parentUuid = boundary.uuid as string;
  const sumMs = typeof claudeMeta.summaryTimestamp === 'string' ? Date.parse(claudeMeta.summaryTimestamp) : NaN;
  emitMessage(
    ctx,
    { role: 'user', content: [{ type: 'text', text: c.summary }], ...(Number.isFinite(sumMs) ? { timestamp: sumMs } : {}) },
    { compactSummary: true },
  );
}
