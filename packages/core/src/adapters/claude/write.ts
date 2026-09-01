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
    if (native && Array.isArray(native.content) && (native.content as unknown[]).length > 0) {
      // claude→claude: keep the native message object verbatim (id/model/usage/
      // stop_reason/context_management/redacted_thinking/caller/…)
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
    }
  });
  // anchorIndex 指向 messages[] 中的摘要消息；重放时在它之前插入 boundary，
  // 摘要本身由 emitCompactionPair 的 isCompactSummary 行承载 —— 随后的投影
  // 摘要消息必须跳过，否则同一份摘要落盘两遍（真机 9c958067 实测复现）
  for (let i = 0; i < ir.messages.length; i++) {
    const msg = ir.messages[i];
    const comp = compactByAnchor.get(i);
    if (comp) {
      emitCompactionPair(ctx, comp);
      continue;
    }
    // keep-gate: isMeta user rows replay into model context (§2.2, 红线 #2) —
    // keep them even when synthetic rows are otherwise dropped; the OTHER
    // synthetic family (attachment / local_command / runtime-injected rows) is
    // presentation-only and skips unless keepSynthetic is set.
    const isMetaRow = msg.synthetic === true && (msg.meta?.claude as Record<string, unknown> | undefined)?.isMeta === true;
    const keep = msg.synthetic !== true || opts.keepSynthetic === true || isMetaRow || msg.content.some((b) => b.type === 'tool_result');
    if (!keep) continue;
    emitMessage(ctx, msg);
  }

  // ---- sessionEvents: non-conversation system rows ride through verbatim ----
  for (const ev of ir.sessionEvents ?? []) {
    const rec = (ev.data ?? {}) as Record<string, unknown>;
    if (rec && typeof rec === 'object' && typeof rec.type === 'string' && TRANSCRIPT_ROW_TYPES.has(rec.type)) {
      ctx.state.records.push({ ...rec, sessionId });
    }
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
    const isMetaRow = msg.synthetic === true && scMeta.isMeta === true;
    if (msg.synthetic === true && opts.keepSynthetic !== true && !isMetaRow && !msg.content.some((b) => b.type === 'tool_result')) continue;
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
