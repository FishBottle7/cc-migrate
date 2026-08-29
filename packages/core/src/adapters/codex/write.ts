/**
 * Codex rollout WRITE side — IR → `sessions/YYYY/MM/DD/rollout-*.jsonl` (docs/agents/codex.md §9).
 *
 * Codex-native IR (meta.codex present) is reconstructed field-for-field: native
 * payloads ride back verbatim, messages map back to their exact response_item
 * variants via meta.codex.itemType, turn_context/world_state rows re-emit
 * ahead of their turn's first message, compaction[] rebuilds the `compacted`
 * record (summary + replacement_history + window fields), and
 * unmappedEvents replay as event_msg / archived rollout rows in original
 * order (seq = source line number).
 *
 * Foreign IR (other tools) gets the §9 minimal synthesis: fresh session_meta,
 * blocks → response_items, compaction bucket → native `compacted` records
 * (replacement_history synthesized from post-anchor messages when the source
 * didn't preserve one). System-prompt choice per docs/agents/codex.md §7.2:
 * `systemPromptSource: 'source'` (default) writes ir.systemPrompt into
 * base_instructions {provenance: custom}; `'target'` writes none.
 *
 * Mode: write side always produces LEGACY-mode files (no ordinals) unless the
 * source session itself was paginated — then original ordinals (msg.seq /
 * meta.ordinal / unmapped.seq) are re-emitted so positional fields stay valid.
 *
 * Iron rule (AGENT.md): only NEW files are written; callers must not point
 * this at an existing session path (the adapter picks a fresh id on conflict).
 */

import type {
  ContentBlock,
  FileBlock,
  MigratedCompaction,
  MigratedMessage,
  MigratedSession,
  MigratedUnmappedEvent,
} from '../../ir.js';
import type { CodexMessageMeta, CodexNativeRow, RolloutLineRaw } from './parse.js';

const PLACEHOLDER_ENCRYPTED = '[encrypted_content omitted by cc-migrate]';
/** §9.2: cli_version carries the target-adapter identity for synthesized metas. */
const ADAPTER_CLI_VERSION = 'cc-migrate-1.0.0';
const ADAPTER_ORIGINATOR = 'cc-migrate';

export interface CodexWriteOptions {
  targetCwd: string;
  createdAt: number;
  threadId: string;
  /** docs/agents/codex.md §7.2 — 'source' (default) writes ir.systemPrompt, 'target' writes none. */
  systemPromptSource?: 'source' | 'target';
  /** Keep harness-injected (synthetic) messages; default drops them. */
  keepSynthetic?: boolean;
}

/* ------------------------------------------------------------------ */
/* Envelope helpers                                                    */
/* ------------------------------------------------------------------ */

/** ms-precision RFC3339 Z — the recorder's exact timestamp format. */
export function rolloutTimestamp(ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const p3 = (n: number) => String(n).padStart(3, '0');
  return (
    `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}` +
    `T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}.${p3(d.getUTCMilliseconds())}Z`
  );
}

function line(
  timestamp: string,
  ordinal: number | undefined,
  type: string,
  payload: unknown,
  metadata?: unknown,
): RolloutLineRaw {
  const out: Record<string, unknown> = { timestamp, type, payload };
  if (ordinal !== undefined) out.ordinal = ordinal;
  if (metadata !== undefined) out.metadata = metadata;
  return out as unknown as RolloutLineRaw;
}

/* ------------------------------------------------------------------ */
/* Top-level: IR → rollout lines                                       */
/* ------------------------------------------------------------------ */

export function buildRolloutLines(
  ir: MigratedSession,
  threadId: string,
  targetCwd: string,
  createdAt: number,
  opts: CodexWriteOptions,
): string[] {
  const sessionCodex = (ir.meta as Record<string, unknown> | undefined)?.codex as Record<string, unknown> | undefined;
  const ownRow = sessionCodex?.sessionMetaLine as CodexNativeRow | undefined;
  const inheritedRows = (sessionCodex?.inheritedMetaLines as CodexNativeRow[] | undefined) ?? [];
  const paginated = isPaginated(ir, ownRow);

  const lines: RolloutLineRaw[] = [];

  // 1. session_meta first line (§9.2), then the inherited prefix verbatim.
  lines.push(line(rolloutTimestamp(createdAt), undefined, 'session_meta', buildSessionMetaPayload(ir, threadId, targetCwd, createdAt, opts)));
  for (const row of inheritedRows) {
    lines.push(line(row.ts, paginated ? row.ordinal : undefined, 'session_meta', row.payload));
  }

  // 2. Compaction entries without an anchor land right after the metas.
  const compactions = ir.compaction ?? [];
  const anchored = new Map<number, MigratedCompaction>();
  const preamble: MigratedCompaction[] = [];
  for (const entry of compactions) {
    if (typeof entry.anchorIndex === 'number') anchored.set(entry.anchorIndex, entry);
    else preamble.push(entry);
  }
  for (const entry of preamble) {
    lines.push(line(rolloutTimestamp(createdAt), undefined, 'compacted', compactedPayload(entry, ir)));
  }

  // 3. Merge messages + turn-scoped rows + archived events in source order
  //    (seq = source line number). Turn rows keep their own source position —
  //    they sit just before their turn's first message in real rollouts, but
  //    interleaved events between the row and the message must stay in place.
  type Emitter =
    | { key: number; order: number; kind: 'message'; msg: MigratedMessage; index: number; inlineRows: CodexNativeRow[] }
    | { key: number; order: number; kind: 'event'; ev: MigratedUnmappedEvent }
    | { key: number; order: number; kind: 'turnRow'; row: CodexNativeRow };
  const emitters: Emitter[] = [];
  ir.messages.forEach((msg, index) => {
    const key = typeof msg.seq === 'number' ? msg.seq : Number.MAX_SAFE_INTEGER - ir.messages.length + index;
    const meta = (msg.meta as Record<string, unknown> | undefined)?.codex as CodexMessageMeta | undefined;
    const inlineRows: CodexNativeRow[] = [];
    for (const row of takeTurnBits(meta)) {
      // Rows with a source position emit there; position-less rows (hand-built
      // IR) fall back to the registered slot: right before the message.
      if (typeof (row as CodexNativeRow).seq === 'number') {
        emitters.push({ key: (row as CodexNativeRow).seq as number, order: index, kind: 'turnRow', row });
      } else {
        inlineRows.push(row);
      }
    }
    emitters.push({ key, order: index, kind: 'message', msg, index, inlineRows });
  });
  if (sessionCodex) {
    for (const [i, ev] of (ir.unmappedEvents ?? []).entries()) {
      emitters.push({ key: typeof ev.seq === 'number' ? ev.seq : Number.MAX_SAFE_INTEGER + i, order: i, kind: 'event', ev });
    }
  }
  emitters.sort((a, b) => a.key - b.key || a.order - b.order);

  for (const em of emitters) {
    if (em.kind === 'event') {
      emitUnmapped(lines, em.ev, paginated);
      continue;
    }
    if (em.kind === 'turnRow') {
      emitNativeRow(lines, em.row, paginated);
      continue;
    }
    const msg = em.msg;
    const meta = (msg.meta as Record<string, unknown> | undefined)?.codex as CodexMessageMeta | undefined;

    // Compaction anchor message → the native `compacted` record.
    const entry = anchored.get(em.index);
    if (entry) {
      for (const row of em.inlineRows) {
        emitNativeRow(lines, row, paginated);
      }
      const nativeTs = (entry.meta as Record<string, unknown> | undefined)?.codex
        ? ((entry.meta as Record<string, unknown>).codex as Record<string, unknown>).ts
        : undefined;
      lines.push(
        line(
          typeof nativeTs === 'string' && nativeTs ? nativeTs : rolloutTimestamp(createdAt),
          paginated ? messageOrdinal(msg) : undefined,
          'compacted',
          compactedPayload(entry, ir),
        ),
      );
      continue;
    }

    // Synthetic (harness-injected) messages: drop unless opted in. Their
    // turn-scoped rows still emit at their own source positions.
    if (msg.synthetic && !opts.keepSynthetic) {
      continue;
    }

    for (const row of em.inlineRows) {
      emitNativeRow(lines, row, paginated);
    }
    for (const item of messageToResponseItems(msg, ir, createdAt)) {
      lines.push(item);
    }
  }

  return lines.map((l) => JSON.stringify(l));
}

function isPaginated(ir: MigratedSession, ownRow: CodexNativeRow | undefined): boolean {
  const payload = ownRow?.payload as Record<string, unknown> | undefined;
  return payload?.history_mode === 'paginated';
}

function messageOrdinal(msg: MigratedMessage): number | undefined {
  const meta = (msg.meta as Record<string, unknown> | undefined)?.codex as CodexMessageMeta | undefined;
  return meta?.ordinal ?? (typeof msg.seq === 'number' ? msg.seq : undefined);
}

function takeTurnBits(meta: CodexMessageMeta | undefined): CodexNativeRow[] {
  if (!meta) return [];
  if (meta.turnRows?.length) return meta.turnRows;
  const turns = meta.turnContexts ?? (meta.turnContext ? [meta.turnContext] : []);
  return [...turns, ...(meta.worldState ?? [])];
}

function emitNativeRow(lines: RolloutLineRaw[], row: CodexNativeRow, paginated: boolean): void {
  lines.push(line(row.ts, paginated ? row.ordinal : undefined, row.kind ?? 'world_state', row.payload));
}

/* ------------------------------------------------------------------ */
/* session_meta                                                        */
/* ------------------------------------------------------------------ */

export function buildSessionMetaPayload(
  ir: MigratedSession,
  threadId: string,
  targetCwd: string,
  createdAt: number,
  opts: CodexWriteOptions,
): Record<string, unknown> {
  const sessionCodex = (ir.meta as Record<string, unknown> | undefined)?.codex as Record<string, unknown> | undefined;
  const ownRow = sessionCodex?.sessionMetaLine as CodexNativeRow | undefined;
  const wantSystemPrompt = (opts.systemPromptSource ?? 'source') === 'source' && typeof ir.systemPrompt === 'string' && ir.systemPrompt.length > 0;

  if (ownRow && typeof ownRow.payload === 'object' && ownRow.payload !== null) {
    const payload = { ...(ownRow.payload as Record<string, unknown>) };
    payload.id = threadId;
    payload.session_id = threadId;
    payload.cwd = targetCwd;
    payload.timestamp = rolloutTimestamp(createdAt);
    // The written file is legacy-mode; a stale paginated marker would make
    // resume expect ordinals that aren't there. When the source omitted the
    // field entirely (pre-history_mode codex versions — absence is the legacy
    // fingerprint) preserve that absence; Rust's #[serde(default)] reads it
    // as legacy either way.
    const sourcePayload = ownRow.payload as Record<string, unknown>;
    if ('history_mode' in sourcePayload) payload.history_mode = 'legacy';
    if ((opts.systemPromptSource ?? 'source') === 'target') {
      delete payload.base_instructions;
    } else if (!payload.base_instructions && wantSystemPrompt) {
      payload.base_instructions = { text: ir.systemPrompt, provenance: { type: 'custom' } };
    }
    return payload;
  }

  // Minimal synthesis (§9.2) for foreign IR.
  const payload: Record<string, unknown> = {
    session_id: threadId,
    id: threadId,
    timestamp: rolloutTimestamp(createdAt),
    cwd: targetCwd,
    originator: ADAPTER_ORIGINATOR,
    cli_version: ADAPTER_CLI_VERSION,
    source: 'cli',
    history_mode: 'legacy',
  };
  if (ir.model?.id) payload.model_provider = ir.model.id;
  if (wantSystemPrompt) payload.base_instructions = { text: ir.systemPrompt, provenance: { type: 'custom' } };
  return payload;
}

/* ------------------------------------------------------------------ */
/* compacted record                                                    */
/* ------------------------------------------------------------------ */

function compactedPayload(entry: MigratedCompaction, ir: MigratedSession): Record<string, unknown> {
  const native = (entry.meta as Record<string, unknown> | undefined)?.codex as Record<string, unknown> | undefined;
  const payload: Record<string, unknown> = { message: entry.summary };

  let replacementHistory = entry.replacementHistory;
  if (!replacementHistory && typeof entry.anchorIndex === 'number' && !native) {
    // Foreign compaction without preserved replacement history: the kept
    // history is everything after the anchor (docs/ir-protocol.md anchor
    // contract) — synthesize the native base so resume folds identically.
    replacementHistory = ir.messages.slice(entry.anchorIndex + 1);
  }
  if (replacementHistory) {
    payload.replacement_history = replacementHistory.map((m) => messageToSingleResponseItem(m, ir));
    const stored = native?.replacementHistoryMetadata;
    const derived = replacementHistory.some((m) => (m.meta as Record<string, unknown> | undefined)?.codex
      ? ((m.meta as Record<string, unknown>).codex as CodexMessageMeta).clientAuthored === true
      : false);
    if (stored !== undefined) {
      payload.replacement_history_metadata = stored;
    } else if (derived) {
      payload.replacement_history_metadata = replacementHistory.map((m) => {
        const meta = (m.meta as Record<string, unknown> | undefined)?.codex as CodexMessageMeta | undefined;
        return meta?.clientAuthored ? { client_authored: true } : {};
      });
    }
  }
  if (native?.mcpResourceOrigins !== undefined) payload.mcp_resource_origins = native.mcpResourceOrigins;
  if (native?.windowNumber !== undefined) payload.window_number = native.windowNumber;
  if (native?.firstWindowId !== undefined) payload.first_window_id = native.firstWindowId;
  if (native?.previousWindowId !== undefined) payload.previous_window_id = native.previousWindowId;
  if (native?.windowId !== undefined) payload.window_id = native.windowId;
  return payload;
}

/* ------------------------------------------------------------------ */
/* Messages → response_items                                           */
/* ------------------------------------------------------------------ */

function messageToResponseItems(msg: MigratedMessage, ir: MigratedSession, createdAt: number): RolloutLineRaw[] {
  const meta = (msg.meta as Record<string, unknown> | undefined)?.codex as CodexMessageMeta | undefined;
  const ts = meta?.ts || rolloutTimestamp(msg.timestamp ?? createdAt);
  const ordinal = meta?.ordinal;

  if (meta?.kind === 'iac') {
    const payload: Record<string, unknown> = {};
    if (meta.itemId) payload.id = meta.itemId;
    payload.author = meta.author ?? '';
    payload.recipient = meta.recipient ?? '';
    payload.other_recipients = meta.otherRecipients ?? [];
    payload.content = textOfBlocks(msg.content);
    if (meta.passthrough !== undefined) payload.internal_chat_message_metadata_passthrough = meta.passthrough;
    // encrypted_content is Option WITHOUT skip_serializing_if — null stays null.
    payload.encrypted_content = meta.encryptedDropped ? PLACEHOLDER_ENCRYPTED : null;
    payload.trigger_turn = meta.triggerTurn ?? false;
    return [line(ts, ordinal, 'inter_agent_communication', payload)];
  }
  if (meta?.kind === 'compaction_summary' && meta.itemType === 'compacted') {
    // Orphaned summary projection (its bucket entry lost): degrade to a plain
    // assistant message so the text is not silently gone.
  }

  const envelopeMetadata = meta?.clientAuthored ? { client_authored: true } : undefined;
  if (meta && meta.itemType !== 'compacted') {
    const payload = nativeResponseItemPayload(msg, meta, ir, createdAt);
    if (payload) {
      return [line(ts, ordinal, 'response_item', payload, envelopeMetadata)];
    }
  }
  // Foreign / degraded path: one response_item per block (codex-native shape).
  const items: RolloutLineRaw[] = [];
  for (const payload of foreignBlocksToPayloads(msg, ir, createdAt)) {
    items.push(line(ts, ordinal, 'response_item', payload, envelopeMetadata));
  }
  if (!items.length) {
    items.push(line(ts, ordinal, 'response_item', {
      type: 'message',
      role: irRoleToNative(msg.role),
      content: [{ type: irRoleToNative(msg.role) === 'assistant' ? 'output_text' : 'input_text', text: '' }],
    }, envelopeMetadata));
  }
  return items;
}

function irRoleToNative(role: MigratedMessage['role']): string {
  return role === 'tool' ? 'user' : role;
}

function passthroughOf(meta: CodexMessageMeta): Record<string, unknown> | undefined {
  return meta.passthrough === undefined ? undefined : { internal_chat_message_metadata_passthrough: meta.passthrough };
}

/** Native reconstruction via meta.codex (returns null when impossible). */
function nativeResponseItemPayload(
  msg: MigratedMessage,
  meta: CodexMessageMeta,
  ir: MigratedSession,
  createdAt: number,
): Record<string, unknown> | null {
  const tsFallback = rolloutTimestamp(msg.timestamp ?? createdAt);
  void tsFallback;
  switch (meta.itemType) {
    case 'message': {
      const role = meta.role ?? irRoleToNative(msg.role);
      const payload: Record<string, unknown> = { type: 'message' };
      if (meta.itemId) payload.id = meta.itemId;
      payload.role = role;
      payload.content = blocksToMessageContent(msg.content, role, meta);
      if (meta.phase !== undefined) payload.phase = meta.phase;
      const pt = passthroughOf(meta);
      if (pt) Object.assign(payload, pt);
      return payload;
    }
    case 'reasoning': {
      const blocks = msg.content.filter((b): b is { type: 'thinking'; thinking: string } => b.type === 'thinking');
      const summaryCount = meta.reasoningSummaryCount ?? blocks.length;
      const entryTypes = meta.reasoningEntryTypes ?? blocks.map(() => 'summary_text');
      const payload: Record<string, unknown> = { type: 'reasoning' };
      if (meta.itemId) payload.id = meta.itemId;
      payload.summary = blocks.slice(0, summaryCount).map((b) => ({ type: 'summary_text', text: b.thinking }));
      const contentEntries = blocks.slice(summaryCount).map((b, i) => ({ type: entryTypes[summaryCount + i] ?? 'reasoning_text', text: b.thinking }));
      if (contentEntries.length) payload.content = contentEntries;
      else if (meta.reasoningContentNull) payload.content = null; // older-codex explicit null preserved
      payload.encrypted_content = meta.encryptedDropped ? PLACEHOLDER_ENCRYPTED : null;
      const pt = passthroughOf(meta);
      if (pt) Object.assign(payload, pt);
      return payload;
    }
    case 'function_call': {
      const block = msg.content.find((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      if (!block) return null;
      const payload: Record<string, unknown> = { type: 'function_call' };
      if (meta.itemId) payload.id = meta.itemId;
      payload.name = block.name;
      if (meta.namespace !== undefined) payload.namespace = meta.namespace;
      payload.arguments = meta.argumentsRaw !== undefined ? meta.argumentsRaw : stableStringify(block.input);
      payload.call_id = block.id;
      const pt = passthroughOf(meta);
      if (pt) Object.assign(payload, pt);
      return payload;
    }
    case 'custom_tool_call': {
      const block = msg.content.find((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      if (!block) return null;
      const payload: Record<string, unknown> = { type: 'custom_tool_call' };
      if (meta.itemId) payload.id = meta.itemId;
      if (meta.status !== undefined) payload.status = meta.status;
      payload.call_id = block.id;
      payload.name = block.name;
      if (meta.namespace !== undefined) payload.namespace = meta.namespace;
      payload.input = typeof block.input === 'string' ? block.input : stableStringify(block.input);
      const pt = passthroughOf(meta);
      if (pt) Object.assign(payload, pt);
      return payload;
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const block = msg.content.find((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result');
      if (!block) return null;
      const payload: Record<string, unknown> = { type: meta.itemType };
      if (meta.itemId) payload.id = meta.itemId;
      if (typeof meta.callId === 'string') payload.call_id = meta.callId;
      if (meta.name !== undefined) payload.name = meta.name;
      if (meta.itemType === 'function_call_output' && meta.namespace !== undefined) payload.namespace = meta.namespace;
      payload.output = meta.outputRaw !== undefined ? meta.outputRaw : blockToOutputPayload(block);
      const pt = passthroughOf(meta);
      if (pt) Object.assign(payload, pt);
      return payload;
    }
    case 'local_shell_call': {
      const block = msg.content.find((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      if (!block) return null;
      const payload: Record<string, unknown> = { type: 'local_shell_call' };
      if (meta.itemId) payload.id = meta.itemId;
      // call_id is Option WITHOUT skip_serializing_if — null stays explicit null.
      if (meta.callId !== undefined) payload.call_id = meta.callId;
      payload.status = meta.status ?? 'completed';
      payload.action = block.input;
      const pt = passthroughOf(meta);
      if (pt) Object.assign(payload, pt);
      return payload;
    }
    case 'tool_search_call': {
      const block = msg.content.find((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      if (!block) return null;
      const payload: Record<string, unknown> = { type: 'tool_search_call' };
      if (meta.itemId) payload.id = meta.itemId;
      if (typeof meta.callId === 'string') payload.call_id = meta.callId;
      if (meta.status !== undefined) payload.status = meta.status;
      payload.execution = meta.execution ?? '';
      payload.arguments = block.input;
      const pt = passthroughOf(meta);
      if (pt) Object.assign(payload, pt);
      return payload;
    }
    case 'tool_search_output': {
      const block = msg.content.find((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result');
      if (!block) return null;
      const payload: Record<string, unknown> = { type: 'tool_search_output' };
      if (meta.itemId) payload.id = meta.itemId;
      // call_id is Option WITHOUT skip_serializing_if — null stays explicit null.
      if (meta.callId !== undefined) payload.call_id = meta.callId;
      payload.status = meta.status ?? 'completed';
      payload.execution = meta.execution ?? '';
      payload.tools = safeParse(block.content, []);
      const pt = passthroughOf(meta);
      if (pt) Object.assign(payload, pt);
      return payload;
    }
    case 'web_search_call': {
      const block = msg.content.find((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      if (!block) return null;
      const payload: Record<string, unknown> = { type: 'web_search_call' };
      if (meta.itemId) payload.id = meta.itemId;
      if (meta.status !== undefined) payload.status = meta.status;
      if (block.input && Object.keys(block.input as Record<string, unknown>).length) payload.action = block.input;
      const pt = passthroughOf(meta);
      if (pt) Object.assign(payload, pt);
      return payload;
    }
    case 'image_generation_call': {
      const useBlock = msg.content.find((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      const resultBlock = msg.content.find((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result');
      if (!useBlock || !resultBlock) return null;
      const data = resultBlock.attachments?.[0]?.data;
      const payload: Record<string, unknown> = { type: 'image_generation_call' };
      if (meta.itemId) payload.id = meta.itemId;
      payload.status = meta.status ?? 'completed';
      if (meta.revisedPrompt !== undefined) payload.revised_prompt = meta.revisedPrompt;
      payload.result = data ?? PLACEHOLDER_ENCRYPTED;
      const pt = passthroughOf(meta);
      if (pt) Object.assign(payload, pt);
      return payload;
    }
    case 'compaction':
    case 'context_compaction': {
      const payload: Record<string, unknown> = { type: meta.itemType };
      if (meta.itemId) payload.id = meta.itemId;
      if (meta.itemType === 'compaction' || meta.encryptedDropped) payload.encrypted_content = PLACEHOLDER_ENCRYPTED;
      const pt = passthroughOf(meta);
      if (pt) Object.assign(payload, pt);
      return payload;
    }
    case 'agent_message': {
      const payload: Record<string, unknown> = { type: 'agent_message' };
      if (meta.itemId) payload.id = meta.itemId;
      payload.author = meta.author ?? '';
      payload.recipient = meta.recipient ?? '';
      payload.content = (meta.contentRaw as unknown[] | undefined)
        ?? msg.content.filter((b) => b.type === 'text').map((b) => ({ type: 'input_text', text: (b as { text: string }).text }));
      const pt = passthroughOf(meta);
      if (pt) Object.assign(payload, pt);
      return payload;
    }
    default:
      return null;
  }
}

function blocksToMessageContent(blocks: ContentBlock[], role: string, meta: CodexMessageMeta): unknown[] {
  const textKind = role === 'assistant' ? 'output_text' : 'input_text';
  const out: unknown[] = [];
  blocks.forEach((b, i) => {
    if (b.type === 'text') {
      out.push({ type: textKind, text: b.text });
    } else if (b.type === 'file') {
      if (meta.audioBlocks?.includes(i)) {
        out.push({ type: 'input_audio', audio_url: b.url ?? '' });
      } else {
        const item: Record<string, unknown> = { type: 'input_image', image_url: b.url ?? '' };
        const detail = meta.imageDetails?.[i];
        if (detail) item.detail = detail;
        out.push(item);
      }
    }
    // tool blocks never occur in a native message item
  });
  return out;
}

function blockToOutputPayload(block: Extract<ContentBlock, { type: 'tool_result' }>): unknown {
  if (block.attachments?.length) {
    const items: unknown[] = [];
    if (block.content) items.push({ type: 'input_text', text: block.content });
    for (const f of block.attachments) {
      if (f.mediaType?.startsWith('audio/')) items.push({ type: 'input_audio', audio_url: f.data ? dataUrl(f) : (f.url ?? '') });
      else items.push({ type: 'input_image', image_url: f.data ? dataUrl(f) : (f.url ?? '') });
    }
    return items;
  }
  return block.content;
}

function dataUrl(f: FileBlock): string {
  return `data:${f.mediaType ?? 'application/octet-stream'};base64,${f.data}`;
}

/** Foreign (no meta.codex) message → codex-shaped payloads, one per block. */
function foreignBlocksToPayloads(msg: MigratedMessage, ir: MigratedSession, createdAt: number): Record<string, unknown>[] {
  void ir;
  void createdAt;
  const out: Record<string, unknown>[] = [];
  const role = irRoleToNative(msg.role);
  const textParts: unknown[] = [];
  const flushText = () => {
    if (textParts.length) {
      out.push({ type: 'message', role, content: textParts.splice(0) });
    }
  };
  for (const block of msg.content) {
    switch (block.type) {
      case 'text': {
        textParts.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: block.text });
        break;
      }
      case 'file': {
        textParts.push(block.type === 'file' && block.mediaType?.startsWith('audio/')
          ? { type: 'input_audio', audio_url: block.data ? dataUrl(block) : (block.url ?? '') }
          : { type: 'input_image', image_url: block.data ? dataUrl(block) : (block.url ?? '') });
        break;
      }
      case 'tool_use': {
        flushText();
        out.push({
          type: 'function_call',
          name: block.name,
          arguments: typeof block.input === 'string' ? block.input : stableStringify(block.input),
          call_id: block.id,
        });
        break;
      }
      case 'tool_result': {
        flushText();
        const payload: Record<string, unknown> = { type: 'function_call_output' };
        if (block.toolUseId) payload.call_id = block.toolUseId;
        payload.output = blockToOutputPayload(block);
        out.push(payload);
        break;
      }
      case 'thinking': {
        flushText();
        out.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: block.thinking }], encrypted_content: null });
        break;
      }
    }
  }
  flushText();
  return out;
}

/** Single-response-item projection used for replacement_history entries. */
function messageToSingleResponseItem(msg: MigratedMessage, ir: MigratedSession): Record<string, unknown> {
  const meta = (msg.meta as Record<string, unknown> | undefined)?.codex as CodexMessageMeta | undefined;
  if (meta && meta.itemType !== 'compacted') {
    const payload = nativeResponseItemPayload(msg, meta, ir, 0);
    if (payload) return payload;
  }
  return foreignBlocksToPayloads(msg, ir, 0)[0] ?? { type: 'message', role: 'assistant', content: [] };
}

/* ------------------------------------------------------------------ */
/* unmappedEvents replay                                               */
/* ------------------------------------------------------------------ */

function emitUnmapped(lines: RolloutLineRaw[], ev: MigratedUnmappedEvent, paginated: boolean): void {
  const ts = Number.isFinite(ev.time) ? rolloutTimestamp(ev.time as number) : rolloutTimestamp(0);
  const ordinal = paginated ? ev.seq : undefined;
  const data = ev.data as Record<string, unknown> | undefined;

  // Whole raw rollout line archived at read time (unknown outer record type).
  const rawLine = data?.codexRolloutLine as RolloutLineRaw | undefined;
  if (rawLine && typeof rawLine === 'object') {
    lines.push(line(rawLine.timestamp ?? ts, paginated ? (rawLine.ordinal ?? ev.seq) : undefined, rawLine.type ?? ev.type, rawLine.payload, rawLine.metadata));
    return;
  }
  // Turn-scoped row orphaned at read time (no following message).
  const orphanBit = data?.codexOrphanTurnBit as CodexNativeRow | undefined;
  if (orphanBit && typeof orphanBit === 'object') {
    lines.push(line(orphanBit.ts || ts, paginated ? orphanBit.ordinal : undefined, orphanBit.kind ?? ev.type, orphanBit.payload));
    return;
  }
  // response_item variant archived at read time (additional_tools /
  // compaction_trigger / other — not persisted by codex policy but replayed).
  const respItem = data?.codexResponseItem;
  if (respItem && typeof respItem === 'object') {
    const clientAuthored = data?.clientAuthored === true;
    lines.push(line(ts, ordinal, 'response_item', respItem, clientAuthored ? { client_authored: true } : undefined));
    return;
  }
  if (ROLLOUT_RECORD_TAGS.has(ev.type)) {
    lines.push(line(ts, ordinal, ev.type, data));
    return;
  }
  // Default: a persisted EventMsg — its payload (including the inner type tag)
  // was stored verbatim in `data`.
  lines.push(line(ts, ordinal, 'event_msg', data));
}

const ROLLOUT_RECORD_TAGS = new Set([
  'security_risk_score',
  'realtime_item',
  'inter_agent_communication_metadata',
  'turn_context',
  'world_state',
  'response_item',
]);

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function textOfBlocks(blocks: ContentBlock[]): string {
  return blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
}

function safeParse<T>(s: string, fallback: T): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

/** JSON.stringify with a stable guard (undefined → ''). */
function stableStringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return String(v);
  }
}

/** Title used for the session_index append row (docs/agents/codex.md §9.7). */
export function sessionIndexTitle(ir: MigratedSession): string {
  if (ir.title) return ir.title;
  const nativeIndex = ((ir.meta as Record<string, unknown> | undefined)?.codex as Record<string, unknown> | undefined)?.sessionIndex as
    | { thread_name?: unknown }
    | undefined;
  if (typeof nativeIndex?.thread_name === 'string' && nativeIndex.thread_name.trim()) return nativeIndex.thread_name;
  // Skip harness-injected / project-doc rows when inferring from history —
  // codex names sessions after the user's first real prompt.
  for (const m of ir.messages) {
    if (m.role !== 'user' || m.synthetic) continue;
    const codex = (m.meta as Record<string, unknown> | undefined)?.codex as Record<string, unknown> | undefined;
    if (codex?.contentKind || codex?.kind) continue;
    const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
    if (!text) continue;
    const one = text.replace(/\s+/g, ' ');
    return one.length > 60 ? `${one.slice(0, 60)}…` : one;
  }
  return '(untitled)';
}
