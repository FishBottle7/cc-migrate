/**
 * Codex rollout READ side — `.codex` sessions tree (rollout JSONL, plain or
 * zstd) into IR.
 *
 * Format authority: docs/agents/codex.md (v3 deep-dive), cross-checked against
 * codex-rs sources: history/src/lib.rs (RolloutLine envelope, CompactedItem),
 * history/src/rollout_payload.rs (wire shapes incl. response_item envelope
 * `metadata.client_authored`), protocol/src/protocol.rs (SessionMeta(Line),
 * TurnContextItem, WorldStateItem, InterAgentCommunication, EventMsg),
 * protocol/src/models.rs (ResponseItem + ContentItem variants),
 * rollout/src/policy.rs (persistence whitelist).
 *
 * Losslessness contract (docs/agents/codex.md §8):
 *  - every rollout record type lands in a typed IR slot; nothing is dropped
 *    except `encrypted_content` / `encrypted_function_args` (placeholder flag);
 *  - session_meta lines (own + inherited prefix) → `meta.codex.sessionMetaLine`
 *    / `inheritedMetaLines` (raw payload + envelope ts/ordinal);
 *  - each response_item → one MigratedMessage (codex-native 1 item = 1 line),
 *    native fields on `msg.meta.codex`; `msg.seq` = source line/ordinal so
 *    write-back can rebuild exact order;
 *  - turn_context / world_state rows attach to the NEXT created message
 *    (`meta.codex.turnContext(s)` / `worldState[]`); orphans (nothing follows)
 *    archive to unmappedEvents so replay still emits them verbatim;
 *  - compacted → `compaction[]` (summary + anchorIndex + replacementHistory +
 *    meta.codex window fields) with the summary ALSO projected as a message;
 *  - event_msg + security_risk_score + realtime_item + iac-metadata + unknown
 *    rows → `unmappedEvents[]` (seq = source line number, raw payload in data).
 */

import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type {
  ContentBlock,
  FileBlock,
  MigratedCompaction,
  MigratedMessage,
  MigratedSession,
  MigratedUnmappedEvent,
} from '../../ir.js';

/** Raw rollout JSONL line (history/src/lib.rs:205-212 + rollout_payload.rs:21-56). */
export interface RolloutLineRaw {
  timestamp: string;
  ordinal?: number | null;
  type?: string;
  payload?: unknown;
  /** response_item envelope metadata (history/src/lib.rs:44-51). */
  metadata?: { client_authored?: boolean } | null;
}

/** Envelope wrapper preserved for native rows (meta lines / turn_context / world_state). */
export interface CodexNativeRow {
  ts: string;
  ordinal?: number;
  payload: unknown;
  /** Record type the payload was read from ('turn_context' | 'world_state'); meta lines leave it unset. */
  kind?: string;
  /** Source line position (legacy ordering; ordinal is the paginated position). */
  seq?: number;
}

/** Adapter-namespaced per-message native payload (v3.1 `MigratedMessage.meta.codex`). */
export interface CodexMessageMeta {
  /** response_item payload.type — the discriminator for native write-back. */
  itemType: string;
  /** Raw envelope timestamp (ms-precision RFC3339 Z) — restored verbatim on write. */
  ts: string;
  ordinal?: number;
  itemId?: string;
  /** message native role (IR role is a projection; unknown roles project to 'user'). */
  role?: string;
  phase?: string;
  passthrough?: unknown;
  clientAuthored?: boolean;
  /** reasoning: per-thinking-block entry type + where summary ends / content begins. */
  reasoningEntryTypes?: string[];
  reasoningSummaryCount?: number;
  /** source serialized reasoning.content as explicit null (older codex versions). */
  reasoningContentNull?: boolean;
  /** reasoning.encrypted_content / compaction encrypted payloads were replaced by a placeholder. */
  encryptedDropped?: boolean;
  /** native call_id (string | null; absent = field absent on the wire). */
  callId?: string | null;
  /** *_call_output.name (optional on the wire). */
  name?: string;
  namespace?: string;
  /** function_call.arguments exact source string (only when re-serialization would differ). */
  argumentsRaw?: string;
  /** array-form function_call_output/custom_tool_call_output output (verbatim). */
  outputRaw?: unknown;
  author?: string;
  recipient?: string;
  otherRecipients?: string[];
  triggerTurn?: boolean;
  /** agent_message content array verbatim (only when encrypted entries were placeholdered). */
  contentRaw?: unknown;
  /** wire `status` — explicit null is preserved (custom_tool_call in-flight) */
  status?: string | null;
  execution?: string;
  revisedPrompt?: string;
  /** input_image detail values by content-block index. */
  imageDetails?: Record<number, string>;
  /** content-block indices that were input_audio items. */
  audioBlocks?: number[];
  /**
   * Harness-injected line classification — the official positional
   * `content_item_kinds` value when present (dotted, e.g. "goal.internal_context"),
   * else a legacy text-marker label derived like codex's own frozen predicate
   * (thread-store/src/local/rollout_migration/rollback.rs). Absent for plain
   * user/model content (kinds "user.*" / "unknown").
   */
  contentKind?: string;
  /** Verbatim positional content_item_kinds (mirror of the passthrough field). */
  contentItemKinds?: string[];
  /** inter_agent_communication record marker. */
  kind?: 'iac' | 'agent_message' | 'compaction_summary';
  /** turn-scoped rows flushed onto this message (write-back emits them first). */
  turnContext?: CodexNativeRow;
  turnContexts?: CodexNativeRow[];
  worldState?: CodexNativeRow[];
  /** Full encounter-ordered list across turn_context+world_state (when >1 row). */
  turnRows?: CodexNativeRow[];
}

const PLACEHOLDER_ENCRYPTED = '[encrypted_content omitted by cc-migrate]';

const IR_ROLES = new Set(['user', 'assistant', 'developer', 'system']);

/** EventMsg wire tags that ride in event_msg payloads (subset we route on replay). */
const ROLLOUT_RECORD_TAGS = new Set([
  'security_risk_score',
  'realtime_item',
  'inter_agent_communication_metadata',
  'turn_context',
  'world_state',
  'response_item',
]);

/* ------------------------------------------------------------------ */
/* File reading                                                        */
/* ------------------------------------------------------------------ */

export async function readRolloutText(path: string): Promise<string> {
  if (path.endsWith('.zst')) {
    const buf = await fs.readFile(path);
    const { zstdDecompressSync } = (await import('node:zlib')) as typeof import('node:zlib');
    if (typeof zstdDecompressSync !== 'function') {
      throw new Error(`Codex: cannot decompress ${path} — node:zlib zstdDecompressSync unavailable (needs Node >= 22.15)`);
    }
    return zstdDecompressSync(buf).toString('utf8');
  }
  return fs.readFile(path, 'utf8');
}

export function parseRolloutLines(text: string): RolloutLineRaw[] {
  const out: RolloutLineRaw[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as RolloutLineRaw);
    } catch {
      // tolerate a torn trailing line (codex opens with ensure_rollout_is_newline_terminated)
      out.push({ timestamp: '', type: '(unparseable)', payload: { raw: trimmed } });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* session_index title lookup (append-only, newest wins)               */
/* ------------------------------------------------------------------ */

export async function loadSessionIndexTitles(codexHome: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  let text: string;
  try {
    text = await fs.readFile(join(codexHome, 'session_index.jsonl'), 'utf8');
  } catch {
    return titles;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as { id?: string; thread_name?: string };
      if (entry.id && typeof entry.thread_name === 'string' && entry.thread_name.trim()) {
        titles.set(entry.id, entry.thread_name);
      }
    } catch {
      // ignore malformed index rows
    }
  }
  return titles;
}

/* ------------------------------------------------------------------ */
/* Cheap head scan (listSessions)                                      */
/* ------------------------------------------------------------------ */

export interface RolloutHeadScan {
  /** session_meta.cwd of the first meta line (the thread's own working dir). */
  cwd?: string;
  /** thread_spawn parent from the first meta line (subagent linkage). */
  parentThreadId?: string;
  /** First REAL user prompt — the codex session-naming convention (§9.7). */
  title?: string;
}

/** Stop scanning once the title is found; 2 MB covers even goal-steered
 *  sessions whose first real prompt sits behind large injected blocks. */
const HEAD_SCAN_BYTE_CAP = 2 * 1024 * 1024;

/**
 * Streaming head scan for the session LIST: cwd + thread_spawn parent + first
 * real user prompt, without a full parse. Title classification goes through
 * the SAME code path as the full parse (`responseItemToMessage` →
 * `markContentKind`), so list titles can never diverge from parse titles —
 * including `content_item_kinds` filtering and legacy text-marker sniffing.
 */
export async function scanRolloutHead(path: string): Promise<RolloutHeadScan> {
  const out: RolloutHeadScan = {};

  const consider = (env: RolloutLineRaw): boolean => {
    const payload = env.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') return false;
    if (env.type === 'session_meta') {
      if (out.cwd === undefined && typeof payload.cwd === 'string') out.cwd = payload.cwd;
      if (out.parentThreadId === undefined) {
        const spawn = (payload.source as Record<string, unknown> | undefined)?.subagent as
          | Record<string, unknown>
          | undefined;
        const parent = (spawn?.thread_spawn as Record<string, unknown> | undefined)?.parent_thread_id;
        if (typeof parent === 'string') out.parentThreadId = parent;
      }
      return false;
    }
    if (env.type !== 'response_item') return false;
    if (payload.type !== 'message' || payload.role !== 'user') return false;
    const msg = responseItemToMessage(payload, { ts: '', clientAuthored: false, lineSeq: 0 });
    if (!msg || msg.synthetic) return false;
    const meta = msg.meta!.codex as CodexMessageMeta;
    if (meta.contentKind || meta.kind) return false;
    const text = msg.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
    if (!text) return false;
    const one = text.replace(/\s+/g, ' ');
    out.title = one.length > 60 ? `${one.slice(0, 60)}…` : one;
    return true;
  };

  const tryLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    try {
      return consider(JSON.parse(trimmed) as RolloutLineRaw);
    } catch {
      return false;
    }
  };

  if (path.endsWith('.zst')) {
    for (const line of (await readRolloutText(path)).split('\n')) {
      if (tryLine(line)) break;
    }
    return out;
  }

  // Plain file: chunked reads with a StringDecoder so a UTF-8 rune split
  // across a chunk boundary (Chinese titles!) survives intact.
  const fh = await fs.open(path, 'r');
  try {
    const buf = Buffer.alloc(256 * 1024);
    const dec = new StringDecoder('utf8');
    let carry = '';
    let pos = 0;
    while (pos < HEAD_SCAN_BYTE_CAP) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const chunk = carry + dec.write(buf.subarray(0, bytesRead));
      const lines = chunk.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        if (tryLine(line)) return out;
      }
    }
  } finally {
    await fh.close();
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* First-line meta scan (subagent stitching)                           */
/* ------------------------------------------------------------------ */

export interface RolloutMetaScan {
  /** thread_spawn parent — present only for subagent threads (never forks). */
  parentThreadId?: string;
  agentNickname?: string;
  agentRole?: string;
  agentPath?: string;
}

/**
 * session_meta is always record #1, so the subagent linkage
 * (`source.subagent.thread_spawn`, plus the top-level mirror fields) is
 * answerable from the first line alone — cheap enough to run across every
 * rollout to build the parent→children map for read-side sidechain stitching.
 * Guarded on thread_source==='subagent'/'thread_spawn' so user forks
 * (forked_from_id) never count as subagent children.
 */
export async function scanRolloutMeta(path: string): Promise<RolloutMetaScan> {
  let head: string | undefined;
  if (path.endsWith('.zst')) {
    head = (await readRolloutText(path)).split('\n')[0];
  } else {
    const fh = await fs.open(path, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const chunks: Buffer[] = [];
      let total = 0;
      while (total < 512 * 1024) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, total);
        if (!bytesRead) break;
        chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
        total += bytesRead;
        const nl = Buffer.concat(chunks).indexOf(0x0a);
        if (nl >= 0) {
          head = Buffer.concat(chunks).toString('utf8', 0, nl);
          break;
        }
      }
      if (head === undefined) head = Buffer.concat(chunks).toString('utf8');
    } finally {
      await fh.close();
    }
  }
  if (!head?.trim()) return {};
  try {
    const env = JSON.parse(head) as RolloutLineRaw;
    if (env.type !== 'session_meta') return {};
    const payload = env.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') return {};
    const source = payload.source as Record<string, unknown> | undefined;
    const spawn = source?.subagent as Record<string, unknown> | undefined;
    const threadSpawn = spawn?.thread_spawn as Record<string, unknown> | undefined;
    if (!threadSpawn && payload.thread_source !== 'subagent') return {};
    const pick = (nested: unknown, top: unknown): string | undefined =>
      typeof nested === 'string' ? nested : typeof top === 'string' ? top : undefined;
    const parent = pick(threadSpawn?.parent_thread_id, payload.parent_thread_id);
    return {
      ...(parent ? { parentThreadId: parent } : {}),
      ...(pick(threadSpawn?.agent_nickname, payload.agent_nickname)
        ? { agentNickname: pick(threadSpawn?.agent_nickname, payload.agent_nickname) }
        : {}),
      ...(pick(threadSpawn?.agent_role, payload.agent_role)
        ? { agentRole: pick(threadSpawn?.agent_role, payload.agent_role) }
        : {}),
      ...(pick(threadSpawn?.agent_path, payload.agent_path)
        ? { agentPath: pick(threadSpawn?.agent_path, payload.agent_path) }
        : {}),
    };
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* Records → IR                                                        */
/* ------------------------------------------------------------------ */
export interface IrBuildContext {
  /** Newest-wins thread titles (session_index.jsonl). */
  titles?: Map<string, string>;
  /** Absolute path of the source rollout file — recorded into meta.codex. */
  sourcePath?: string;
  /** Paginated prefix files stitched into this parse (history_base chain). */
  stitchedChain?: PaginatedChainLink[];
}

/** One resolved `history_base` hop (docs/agents/codex.md §10). */
export interface PaginatedChainLink {
  /** Rollout id of the prefix file (HistoryPosition.thread_id). */
  rolloutId: string;
  endOrdinalExclusive?: number;
  endByteOffset: number;
  sourcePath: string;
}

export function rolloutRecordsToIr(records: RolloutLineRaw[], ctx: IrBuildContext = {}): MigratedSession {
  const messages: MigratedMessage[] = [];
  const compaction: MigratedCompaction[] = [];
  const unmapped: MigratedUnmappedEvent[] = [];
  const metaLines: CodexNativeRow[] = [];
  const pendingTurnBits: Array<{ kind: 'turnContext' | 'worldState'; row: CodexNativeRow; seq: number; time?: number }> = [];
  // Stitched chains merge several files' lineSeq spaces: ids synthesized from
  // a line position (`local_shell_<seq>` and friends) get a per-parse scope so
  // two segments cannot mint the same id for different items. Single-file
  // parses keep the legacy unscoped format byte-identically.
  const scope = ctx.stitchedChain?.length ? `s${ctx.stitchedChain.length}` : undefined;

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const ts = rec.timestamp ?? '';
    const time = ts ? Date.parse(ts) : undefined;
    const ordinal = typeof rec.ordinal === 'number' ? rec.ordinal : undefined;
    const row: CodexNativeRow = ordinal === undefined ? { ts, payload: rec.payload } : { ts, ordinal, payload: rec.payload };
    const clientAuthored = rec.metadata?.client_authored === true;

    switch (rec.type) {
      case 'session_meta': {
        metaLines.push(row);
        continue;
      }
      case 'response_item': {
        const payload = (rec.payload ?? {}) as Record<string, unknown>;
        const item = responseItemToMessage(payload, { ts, ordinal, clientAuthored, lineSeq: i, ...(scope ? { scope } : {}) });
        if (item) {
          flushTurnBits(item, pendingTurnBits);
          messages.push(item);
        } else {
          // additional_tools / compaction_trigger / other / unknown inner tags —
          // not persisted by codex policy, but archived for zero-loss replay.
          unmapped.push(
            unmappedEvent(ordinal ?? i, time !== undefined && Number.isFinite(time) ? time : undefined, 'response_item', {
              codexResponseItem: stripEncrypted(payload),
              ...(clientAuthored ? { clientAuthored: true } : {}),
            }),
          );
        }
        continue;
      }
      case 'event_msg': {
        const payload = (rec.payload ?? {}) as Record<string, unknown>;
        unmapped.push(
          unmappedEvent(
            ordinal ?? i,
            time !== undefined && Number.isFinite(time) ? time : undefined,
            typeof payload.type === 'string' ? payload.type : '(missing)',
            stripEncrypted(payload),
          ),
        );
        continue;
      }
      case 'turn_context':
      case 'world_state': {
        pendingTurnBits.push({
          kind: rec.type === 'turn_context' ? 'turnContext' : 'worldState',
          row: { ...row, kind: rec.type },
          seq: ordinal ?? i,
          ...(time !== undefined && Number.isFinite(time) ? { time } : {}),
        });
        continue;
      }
      case 'compacted': {
        const payload = (rec.payload ?? {}) as Record<string, unknown>;
        const entry = compactedToEntry(payload, { ts, ordinal, lineSeq: i, ...(scope ? { scope } : {}) }, messages);
        flushTurnBits(entry.summaryMessage, pendingTurnBits);
        // Anchor = the summary projection's index in messages[]; write-back
        // replaces that message with the native `compacted` record.
        entry.entry.anchorIndex = messages.length;
        compaction.push(entry.entry);
        messages.push(entry.summaryMessage);
        continue;
      }
      case 'inter_agent_communication': {
        const payload = (rec.payload ?? {}) as Record<string, unknown>;
        const msg = iacToMessage(payload, { ts, ordinal, lineSeq: i });
        if (msg) {
          flushTurnBits(msg, pendingTurnBits);
          messages.push(msg);
        }
        continue;
      }
      case 'inter_agent_communication_metadata':
      case 'security_risk_score':
      case 'realtime_item': {
        unmapped.push(
          unmappedEvent(ordinal ?? i, time !== undefined && Number.isFinite(time) ? time : undefined, rec.type, stripEncrypted(rec.payload ?? {})),
        );
        continue;
      }
      default: {
        // Unknown outer record type (or missing): archive the whole raw line;
        // write-back re-emits it verbatim from data.codexRolloutLine.
        unmapped.push(
          unmappedEvent(ordinal ?? i, time !== undefined && Number.isFinite(time) ? time : undefined, rec.type ?? '(missing)', { codexRolloutLine: rec }),
        );
        continue;
      }
    }
  }

  // Turn-scoped rows with no following message: archive so replay keeps them.
  for (const pending of pendingTurnBits) {
    unmapped.push(
      unmappedEvent(pending.seq, pending.time, pending.kind === 'turnContext' ? 'turn_context' : 'world_state', { codexOrphanTurnBit: pending.row }),
    );
  }

  const own = metaLines[0]?.payload as Record<string, unknown> | undefined;
  const inherited = metaLines.slice(1);
  const threadId = typeof own?.id === 'string' ? own.id : typeof own?.session_id === 'string' ? own.session_id : undefined;
  const baseInstructions = own?.base_instructions as { text?: string; provenance?: unknown } | undefined;
  const modelProvider = typeof own?.model_provider === 'string' ? own.model_provider : undefined;
  const createdAt = own && typeof own.timestamp === 'string' ? orEpoch(own.timestamp) : undefined;

  const sessionMeta: Record<string, unknown> = {
    sessionMetaLine: metaLines[0],
  };
  if (inherited.length) sessionMeta.inheritedMetaLines = inherited;
  if (baseInstructions?.provenance !== undefined) {
    sessionMeta.baseInstructionsProvenance = baseInstructions.provenance;
  }
  const indexTitle = threadId ? ctx.titles?.get(threadId) : undefined;
  if (indexTitle) sessionMeta.sessionIndex = { thread_name: indexTitle };
  // codex names sessions after the user's first real prompt — the index rarely
  // carries thread_name, so infer it here too (targets consume ir.title; the
  // same rule sessionIndexTitle applies on the write side).
  const title = indexTitle ?? titleFromMessages(messages);
  if (ctx.sourcePath) {
    sessionMeta.sourceFile = basename(ctx.sourcePath);
    sessionMeta.sourceDir = splitDir(ctx.sourcePath);
  }
  if (ctx.stitchedChain?.length) sessionMeta.historyChain = ctx.stitchedChain;

  return {
    schemaVersion: 2,
    originTool: 'codex',
    originSessionId: threadId,
    ...(title !== undefined ? { title } : {}),
    ...(createdAt !== undefined && Number.isFinite(createdAt) ? { createdAt } : {}),
    ...(typeof own?.cwd === 'string' ? { cwd: own.cwd } : {}),
    ...(modelProvider ? { model: { id: modelProvider } } : {}),
    ...(typeof baseInstructions?.text === 'string' && baseInstructions.text ? { systemPrompt: baseInstructions.text } : {}),
    messages,
    ...(compaction.length ? { compaction } : {}),
    ...(unmapped.length ? { unmappedEvents: unmapped } : {}),
    meta: { codex: sessionMeta },
  };
}


/**
 * First real user prompt, collapsed to one 60-char line — the codex session
 * naming convention. Harness-injected rows are skipped via the same fields the
 * classifier sets (synthetic / contentKind / kind). Shared with the write side
 * (sessionIndexTitle) so parse and write can never diverge on the rule.
 */
export function titleFromMessages(messages: MigratedMessage[]): string | undefined {
  for (const m of messages) {
    if (m.role !== 'user' || m.synthetic) continue;
    const codex = (m.meta as Record<string, unknown> | undefined)?.codex as Record<string, unknown> | undefined;
    if (codex?.contentKind || codex?.kind) continue;
    const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
    if (!text) continue;
    const one = text.replace(/\s+/g, ' ');
    return one.length > 60 ? `${one.slice(0, 60)}…` : one;
  }
  return undefined;
}

/** MigratedUnmappedEvent with optional time (spread keeps it absent, not undefined). */
function unmappedEvent(seq: number, time: number | undefined, type: string, data: unknown): MigratedUnmappedEvent {
  return { seq, ...(time !== undefined ? { time } : {}), type, data } as MigratedUnmappedEvent;
}

function orEpoch(ts: string): number {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : 0;
}

/** Directory portion of a path with forward slashes ('sessions/2026/08/20', 'archived_sessions'). */
function splitDir(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i > 0 ? norm.slice(0, i) : '.';
}

interface ItemCtx {
  ts: string;
  ordinal?: number;
  clientAuthored: boolean;
  lineSeq: number;
  /**
   * Per-file disambiguator for synthesized ids (`local_shell_<scope>_<seq>` …):
   * a stitched history_base chain concatenates several files' lineSeq spaces,
   * so two segments can mint the same synthetic id for DIFFERENT items — which
   * would falsely pair a tool_use with a foreign tool_result on write-back.
   * Absent (empty) = single unscoped file (ids stay byte-identical to the
   * legacy format for untouched sessions).
   */
  scope?: string;
}

function baseMeta(ctx: ItemCtx, itemType: string): CodexMessageMeta {
  const meta: CodexMessageMeta = { itemType, ts: ctx.ts };
  if (ctx.ordinal !== undefined) meta.ordinal = ctx.ordinal;
  return meta;
}

/** response_item payload → one MigratedMessage (or null when archived instead). */
function responseItemToMessage(payload: Record<string, unknown>, ctx: ItemCtx): MigratedMessage | null {
  const itemType = typeof payload.type === 'string' ? payload.type : '(unknown)';
  const itemId = typeof payload.id === 'string' ? payload.id : undefined;
  const ts = ctx.ts;
  const timestamp = orEpoch(ts);

  switch (itemType) {
    case 'message': {
      const nativeRole = typeof payload.role === 'string' ? payload.role : 'user';
      const irRole = IR_ROLES.has(nativeRole) ? (nativeRole as MigratedMessage['role']) : 'user';
      const meta = baseMeta(ctx, itemType);
      if (itemId) meta.itemId = itemId;
      meta.role = nativeRole;
      if (typeof payload.phase === 'string') meta.phase = payload.phase;
      if (payload.internal_chat_message_metadata_passthrough !== undefined) {
        meta.passthrough = payload.internal_chat_message_metadata_passthrough;
      }
      const kinds = passthroughKinds(payload.internal_chat_message_metadata_passthrough);
      if (kinds) meta.contentItemKinds = kinds;
      if (ctx.clientAuthored) meta.clientAuthored = true;
      const content = contentItemsToBlocks(payload.content, meta);
      const msg: MigratedMessage = { role: irRole, content, timestamp, seq: ctx.ordinal ?? ctx.lineSeq, meta: { codex: meta } };
      markContentKind(msg);
      return msg;
    }
    case 'agent_message': {
      const meta = baseMeta(ctx, itemType);
      if (itemId) meta.itemId = itemId;
      meta.kind = 'agent_message';
      meta.author = typeof payload.author === 'string' ? payload.author : '';
      meta.recipient = typeof payload.recipient === 'string' ? payload.recipient : '';
      if (payload.internal_chat_message_metadata_passthrough !== undefined) {
        meta.passthrough = payload.internal_chat_message_metadata_passthrough;
      }
      const rawContent = Array.isArray(payload.content) ? payload.content : [];
      const hasEncrypted = rawContent.some(
        (c) => typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'encrypted_content',
      );
      const content: ContentBlock[] = [];
      for (const part of rawContent) {
        if (typeof part === 'object' && part !== null && (part as Record<string, unknown>).type === 'input_text') {
          content.push({ type: 'text', text: String((part as Record<string, unknown>).text ?? '') });
        } else {
          content.push({ type: 'text', text: PLACEHOLDER_ENCRYPTED });
        }
      }
      if (hasEncrypted) {
        meta.encryptedDropped = true;
        meta.contentRaw = rawContent.map((c) =>
          typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'encrypted_content'
            ? { type: 'encrypted_content', encrypted_content: PLACEHOLDER_ENCRYPTED }
            : c,
        );
      }
      return { role: 'assistant', content, timestamp, seq: ctx.ordinal ?? ctx.lineSeq, meta: { codex: meta } };
    }
    case 'reasoning': {
      const meta = baseMeta(ctx, itemType);
      if (itemId) meta.itemId = itemId;
      if (payload.internal_chat_message_metadata_passthrough !== undefined) {
        meta.passthrough = payload.internal_chat_message_metadata_passthrough;
      }
      const summary = Array.isArray(payload.summary) ? payload.summary : [];
      if (payload.content === null) meta.reasoningContentNull = true;
      const content = Array.isArray(payload.content) ? payload.content : [];
      const entries = [...summary, ...content];
      const entryTypes: string[] = [];
      const blocks: ContentBlock[] = [];
      for (const e of entries) {
        const t = typeof e === 'object' && e !== null ? String((e as Record<string, unknown>).type ?? 'summary_text') : 'summary_text';
        const text = typeof e === 'object' && e !== null ? String((e as Record<string, unknown>).text ?? '') : '';
        entryTypes.push(t);
        blocks.push({ type: 'thinking', thinking: text });
      }
      meta.reasoningEntryTypes = entryTypes;
      meta.reasoningSummaryCount = summary.length;
      if (payload.encrypted_content !== undefined && payload.encrypted_content !== null) {
        meta.encryptedDropped = true;
      }
      return { role: 'assistant', content: blocks, timestamp, seq: ctx.ordinal ?? ctx.lineSeq, meta: { codex: meta } };
    }
    case 'function_call': {
      const meta = baseMeta(ctx, itemType);
      if (itemId) meta.itemId = itemId;
      if (typeof payload.namespace === 'string') meta.namespace = payload.namespace;
      if (payload.internal_chat_message_metadata_passthrough !== undefined) {
        meta.passthrough = payload.internal_chat_message_metadata_passthrough;
      }
      const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
      const argumentsRaw = typeof payload.arguments === 'string' ? payload.arguments : '';
      let input: unknown = argumentsRaw;
      try {
        input = JSON.parse(argumentsRaw);
      } catch {
        input = argumentsRaw;
      }
      if (JSON.stringify(input) !== argumentsRaw) meta.argumentsRaw = argumentsRaw;
      if (payload.encrypted_function_args !== undefined) meta.encryptedDropped = true;
      return {
        role: 'assistant',
        content: [{ type: 'tool_use', id: callId, name: String(payload.name ?? 'function'), input }],
        timestamp,
        seq: ctx.ordinal ?? ctx.lineSeq,
        meta: { codex: meta },
      };
    }
    case 'custom_tool_call': {
      const meta = baseMeta(ctx, itemType);
      if (itemId) meta.itemId = itemId;
      if (typeof payload.namespace === 'string') meta.namespace = payload.namespace;
      // status is Option WITH skip_serializing_if — null/absent both omit on write
      if (typeof payload.status === 'string') meta.status = payload.status;
      if (payload.internal_chat_message_metadata_passthrough !== undefined) {
        meta.passthrough = payload.internal_chat_message_metadata_passthrough;
      }
      const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
      return {
        role: 'assistant',
        content: [{ type: 'tool_use', id: callId, name: String(payload.name ?? 'custom'), input: String(payload.input ?? '') }],
        timestamp,
        seq: ctx.ordinal ?? ctx.lineSeq,
        meta: { codex: meta },
      };
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const meta = baseMeta(ctx, itemType);
      if (itemId) meta.itemId = itemId;
      if (typeof payload.name === 'string') meta.name = payload.name;
      if (typeof payload.namespace === 'string') meta.namespace = payload.namespace;
      if (payload.internal_chat_message_metadata_passthrough !== undefined) {
        meta.passthrough = payload.internal_chat_message_metadata_passthrough;
      }
      const hasCallId = typeof payload.call_id === 'string' && payload.call_id !== '';
      meta.callId = hasCallId ? (payload.call_id as string) : null;
      const output = payload.output;
      if (Array.isArray(output)) meta.outputRaw = output;
      const { text, attachments } = outputToTextAndAttachments(output);
      const block: ContentBlock = { type: 'tool_result', toolUseId: hasCallId ? (payload.call_id as string) : '', content: text };
      if (attachments.length) (block as { attachments: FileBlock[] }).attachments = attachments;
      return {
        role: 'tool',
        content: [block],
        timestamp,
        seq: ctx.ordinal ?? ctx.lineSeq,
        meta: { codex: meta },
      };
    }
    case 'local_shell_call': {
      const meta = baseMeta(ctx, itemType);
      if (itemId) meta.itemId = itemId;
      const hasCallId = typeof payload.call_id === 'string' && payload.call_id !== '';
      if (hasCallId) meta.callId = payload.call_id as string;
      else if (payload.call_id === null) meta.callId = null;
      meta.status = String(payload.status ?? '');
      if (payload.internal_chat_message_metadata_passthrough !== undefined) {
        meta.passthrough = payload.internal_chat_message_metadata_passthrough;
      }
      const callId = hasCallId ? (payload.call_id as string) : `local_shell_${ctx.scope ? `${ctx.scope}_${ctx.lineSeq}` : ctx.lineSeq}`;
      return {
        role: 'assistant',
        content: [{ type: 'tool_use', id: callId, name: 'local_shell', input: payload.action ?? {} }],
        timestamp,
        seq: ctx.ordinal ?? ctx.lineSeq,
        meta: { codex: meta },
      };
    }
    case 'tool_search_call': {
      const meta = baseMeta(ctx, itemType);
      if (itemId) meta.itemId = itemId;
      const hasCallId = typeof payload.call_id === 'string' && payload.call_id !== '';
      if (hasCallId) meta.callId = payload.call_id as string;
      else if (payload.call_id === null) meta.callId = null;
      if (typeof payload.status === 'string') meta.status = payload.status;
      meta.execution = String(payload.execution ?? '');
      if (payload.internal_chat_message_metadata_passthrough !== undefined) {
        meta.passthrough = payload.internal_chat_message_metadata_passthrough;
      }
      const callId = hasCallId ? (payload.call_id as string) : `tool_search_${ctx.scope ? `${ctx.scope}_${ctx.lineSeq}` : ctx.lineSeq}`;
      return {
        role: 'assistant',
        content: [{ type: 'tool_use', id: callId, name: 'tool_search', input: payload.arguments ?? {} }],
        timestamp,
        seq: ctx.ordinal ?? ctx.lineSeq,
        meta: { codex: meta },
      };
    }
    case 'tool_search_output': {
      const meta = baseMeta(ctx, itemType);
      if (itemId) meta.itemId = itemId;
      const hasCallId = typeof payload.call_id === 'string' && payload.call_id !== '';
      if (hasCallId) meta.callId = payload.call_id as string;
      else if (payload.call_id === null) meta.callId = null;
      meta.status = String(payload.status ?? '');
      meta.execution = String(payload.execution ?? '');
      if (payload.internal_chat_message_metadata_passthrough !== undefined) {
        meta.passthrough = payload.internal_chat_message_metadata_passthrough;
      }
      const callId = hasCallId ? (payload.call_id as string) : `tool_search_out_${ctx.scope ? `${ctx.scope}_${ctx.lineSeq}` : ctx.lineSeq}`;
      return {
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: callId, content: JSON.stringify(payload.tools ?? []) }],
        timestamp,
        seq: ctx.ordinal ?? ctx.lineSeq,
        meta: { codex: meta },
      };
    }
    case 'web_search_call': {
      const meta = baseMeta(ctx, itemType);
      if (itemId) meta.itemId = itemId;
      if (typeof payload.status === 'string') meta.status = payload.status;
      if (payload.internal_chat_message_metadata_passthrough !== undefined) {
        meta.passthrough = payload.internal_chat_message_metadata_passthrough;
      }
      return {
        role: 'assistant',
        content: [{ type: 'tool_use', id: itemId ?? `web_search_${ctx.scope ? `${ctx.scope}_${ctx.lineSeq}` : ctx.lineSeq}`, name: 'web_search', input: payload.action ?? {} }],
        timestamp,
        seq: ctx.ordinal ?? ctx.lineSeq,
        meta: { codex: meta },
      };
    }
    case 'image_generation_call': {
      const meta = baseMeta(ctx, itemType);
      if (itemId) meta.itemId = itemId;
      meta.status = String(payload.status ?? '');
      if (typeof payload.revised_prompt === 'string') meta.revisedPrompt = payload.revised_prompt;
      if (payload.internal_chat_message_metadata_passthrough !== undefined) {
        meta.passthrough = payload.internal_chat_message_metadata_passthrough;
      }
      const callId = itemId ?? `image_gen_${ctx.scope ? `${ctx.scope}_${ctx.lineSeq}` : ctx.lineSeq}`;
      const useBlock: ContentBlock = {
        type: 'tool_use',
        id: callId,
        name: 'image_generation',
        input: typeof payload.revised_prompt === 'string' ? { revised_prompt: payload.revised_prompt } : {},
      };
      const resultBlock: ContentBlock = {
        type: 'tool_result',
        toolUseId: callId,
        content: '',
        attachments: [{ type: 'file', mediaType: 'image/png', data: String(payload.result ?? '') }],
      };
      return {
        role: 'assistant',
        content: [useBlock, resultBlock],
        timestamp,
        seq: ctx.ordinal ?? ctx.lineSeq,
        meta: { codex: meta },
      };
    }
    case 'compaction':
    case 'context_compaction': {
      // Pure-encrypted compaction items — the only legal drop besides
      // encrypted_function_args. Placeholder message keeps the line position.
      const meta = baseMeta(ctx, itemType);
      if (itemId) meta.itemId = itemId;
      if (payload.internal_chat_message_metadata_passthrough !== undefined) {
        meta.passthrough = payload.internal_chat_message_metadata_passthrough;
      }
      meta.encryptedDropped = itemType === 'compaction' || payload.encrypted_content != null;
      return {
        role: 'assistant',
        content: [{ type: 'text', text: PLACEHOLDER_ENCRYPTED }],
        timestamp,
        seq: ctx.ordinal ?? ctx.lineSeq,
        meta: { codex: meta },
      };
    }
    default: {
      // additional_tools / compaction_trigger / other / unknown inner tags:
      // not persisted by codex policy, but archive for zero-loss anyway.
      return null;
    }
  }
}

function contentItemsToBlocks(content: unknown, meta: CodexMessageMeta): ContentBlock[] {
  const items = Array.isArray(content) ? content : content != null ? [content] : [];
  const blocks: ContentBlock[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      blocks.push({ type: 'text', text: item });
      continue;
    }
    if (typeof item !== 'object' || item === null) continue;
    const c = item as Record<string, unknown>;
    switch (c.type) {
      case 'input_text':
      case 'output_text': {
        blocks.push({ type: 'text', text: String(c.text ?? '') });
        break;
      }
      case 'input_image': {
        const url = String(c.image_url ?? '');
        const file: FileBlock = { type: 'file', url };
        const mime = /^data:([^;,]+)/.exec(url)?.[1];
        if (mime) file.mediaType = mime;
        if (typeof c.detail === 'string') {
          meta.imageDetails = meta.imageDetails ?? {};
          meta.imageDetails[blocks.length] = c.detail;
        }
        blocks.push(file);
        break;
      }
      case 'input_audio': {
        const url = String(c.audio_url ?? '');
        const file: FileBlock = { type: 'file', url };
        const mime = /^data:([^;,]+)/.exec(url)?.[1];
        file.mediaType = mime ?? 'audio/basic';
        meta.audioBlocks = meta.audioBlocks ?? [];
        meta.audioBlocks.push(blocks.length);
        blocks.push(file);
        break;
      }
      default: {
        blocks.push({ type: 'text', text: JSON.stringify(c) });
      }
    }
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/* Harness-injection classification (docs/agents/codex.md §7.2 rule 5)  */
/* ------------------------------------------------------------------ */

/**
 * Official channel: the positional `content_item_kinds` on
 * `internal_chat_message_metadata_passthrough` (codex-rs
 * context-fragments/src/annotated_content.rs — kinds zip with content items,
 * missing entries read as "unknown"; ContentItemKind is a String newtype so
 * the wire values are bare dotted strings, e.g. "goal.internal_context").
 *
 * Legacy rollouts without kinds fall back to the frozen text-marker list
 * codex itself uses for persisted history (thread-store/src/local/
 * rollout_migration/rollback.rs is_known_contextual_user_text + the
 * developer-message prefix list).
 */

/** Kinds carrying user- or agent-authored content — never harness-only. */
const NON_HARNESS_KINDS = new Set([
  'unknown',
  'shell.user_command',
  'multi_agent.inter_agent_message',
  'multi_agent.inter_agent_completion_message',
]);

function isHarnessContentKind(kind: string): boolean {
  if (kind.startsWith('user.')) return false;
  return !NON_HARNESS_KINDS.has(kind);
}

/** Kinds codex regenerates per run (droppable on write; `keepSynthetic` keeps them). */
const SYNTHETIC_KIND_PREFIXES = ['.internal_context', '.reminder', '.instructions', '.environment_context'];
const SYNTHETIC_KINDS = new Set([
  'token_budget.context_window',
  'token_budget.context_window_guidance',
  'token_budget.remaining_tokens',
  'rollout_budget.remaining_tokens',
  'images.preparation_error',
  'images.resize_notice',
  'images.unsupported',
  'audio.unsupported',
  'model_switch.legacy_mismatch_warning',
  'permissions.approved_command_prefix_saved',
  'network_proxy.rule_saved',
  'guardian.policy',
  'guardian.approved_action',
  'guardian.node_repl_policy',
  'guardian.review_evidence',
  'guardian.node_repl_review_evidence',
  'guardian.followup_review_reminder',
  'guardian.warning',
  'hooks.additional_context',
  'extension.internal_context',
  'generic.turn_aborted',
  'generic.developer_policy',
  'generic.developer_instructions',
  'compaction.summary',
  'compaction.auto_fallback_prompt',
  'apply_patch.legacy_exec_command_warning',
  'unified_exec.legacy_process_limit_warning',
  'multi_agent.usage_hint',
  'multi_agent.subagent_notification',
  'multi_agent.role_instructions',
  'multi_agent.mode_instructions',
  'plugins.recommendations',
  'tools.deferred_namespaces',
  'tools.instructions',
]);

function isSyntheticContentKind(kind: string): boolean {
  if (NON_HARNESS_KINDS.has(kind) || kind.startsWith('user.')) return false;
  // AGENTS.md rows are the documented non-synthetic injection (docs/agents/
  // codex.md §8/§11.2: 随历史保真迁移) — exempt them from the `.instructions`
  // prefix so the official channel agrees with the legacy marker table.
  if (kind === 'agents_md.instructions') return false;
  if (SYNTHETIC_KINDS.has(kind)) return true;
  return SYNTHETIC_KIND_PREFIXES.some((p) => kind.endsWith(p));
}

/** Positional kinds out of the passthrough (wire values are bare strings). */
function passthroughKinds(passthrough: unknown): string[] | undefined {
  if (typeof passthrough !== 'object' || passthrough === null) return undefined;
  const kinds = (passthrough as Record<string, unknown>).content_item_kinds;
  if (!Array.isArray(kinds) || !kinds.length) return undefined;
  const out = kinds.map((k) =>
    typeof k === 'string' ? k : typeof k === 'object' && k !== null ? String((k as Record<string, unknown>).value ?? 'unknown') : 'unknown',
  );
  return out.length ? out : undefined;
}

/**
 * Legacy text-marker tables — mirrors codex-rs thread-store/src/local/
 * rollout_migration/rollback.rs (frozen "alongside the legacy migration
 * adapter"). [start, end | null, kind, synthetic]; end=null means prefix-only.
 * The synthetic column must agree with isSyntheticContentKind for the same
 * content on the official channel (subagent_notification /
 * plugins.recommendations are runtime-relayed harness rows there;
 * skills.instructions hits the `.instructions` prefix) — rollouts without
 * kinds must not classify differently from rollouts with them. AGENTS.md is
 * the documented NON-synthetic injection (docs/agents/codex.md §8: 随历史保真
 * 迁移), non-synthetic on BOTH channels; `<user_shell_command>` and
 * `<external_*>` are user-initiated, hence non-synthetic on both.
 */
const LEGACY_USER_MARKERS: Array<[string, string | null, string, boolean]> = [
  ['# AGENTS.md instructions', '</INSTRUCTIONS>', 'agents_md.instructions', false],
  ['<environment_context>', '</environment_context>', 'environments.environment_context', true],
  ['<user_shell_command>', '</user_shell_command>', 'shell.user_command', false],
  ['<turn_aborted>', '</turn_aborted>', 'generic.turn_aborted', true],
  ['<subagent_notification>', '</subagent_notification>', 'multi_agent.subagent_notification', true],
  ['<recommended_plugins>', '</recommended_plugins>', 'plugins.recommendations', true],
  ['<skill>', '</skill>', 'skills.instructions', true],
  ['<goal_context>', '</goal_context>', 'goal.internal_context', true],
  ['Warning: The maximum number of unified exec processes', null, 'unified_exec.legacy_process_limit_warning', true],
  ['Warning: apply_patch was requested via ', null, 'apply_patch.legacy_exec_command_warning', true],
  ['Warning: Your account was flagged for potentially high-risk cyber activity', null, 'guardian.warning', true],
];

/** Developer-role harness injections (case-insensitive prefixes, all synthetic). */
const LEGACY_DEVELOPER_MARKERS: Array<[string, string]> = [
  ['<permissions instructions>', 'permissions.instructions'],
  ['<model_switch>', 'model_switch.instructions'],
  ['<managed_developer_instructions>', 'managed_config.developer_instructions'],
  ['<apps_instructions>', 'apps.instructions'],
  ['<collaboration_mode>', 'collaboration_mode.instructions'],
  ['<multi_agent_mode>', 'multi_agent.mode_instructions'],
  ['<environments_instructions>', 'environments.instructions'],
  ['<git_attribution>', 'generic.git_attribution'],
  ['<plugins_instructions>', 'plugins.instructions'],
  ['<realtime_conversation>', 'realtime_conversation.instructions'],
  ['<skills_instructions>', 'skills.instructions'],
  ['<tools>', 'tools.instructions'],
  ['<personality_spec>', 'personality.spec_instructions'],
  ['<token_budget>', 'token_budget.instructions'],
  ['<context_window_guidance>', 'token_budget.context_window_guidance'],
  ['<context_window>', 'token_budget.context_window'],
  ['<rollout_budget>', 'rollout_budget.instructions'],
];

function classifyLegacyText(text: string): { kind: string; synthetic: boolean } | null {
  const t = text.trim();
  for (const [start, end, kind, synthetic] of LEGACY_USER_MARKERS) {
    if (t.startsWith(start) && (end === null || t.endsWith(end))) return { kind, synthetic };
  }
  if (t.startsWith('<codex_internal_context')) {
    const m = /<codex_internal_context\s+source="([a-z][a-z0-9_]*)">/.exec(t);
    return { kind: `${m?.[1] ?? 'extension'}.internal_context`, synthetic: true };
  }
  if (t.startsWith('<external_')) {
    const gt = t.indexOf('>');
    const key = gt > 0 ? t.slice('<external_'.length, gt) : '';
    if (key && t.endsWith(`</external_${key}>`)) return { kind: `external.${key}`, synthetic: false };
  }
  const lower = t.toLowerCase();
  for (const [prefix, kind] of LEGACY_DEVELOPER_MARKERS) {
    if (lower.startsWith(prefix)) return { kind, synthetic: true };
  }
  return null;
}

/** Classify a message line as harness-injected when applicable. */
function markContentKind(msg: MigratedMessage): void {
  const meta = msg.meta!.codex as CodexMessageMeta;
  // Primary: official positional kinds — the first item's kind classifies the
  // line (harness fragments are single-purpose messages).
  const kinds = meta.contentItemKinds;
  if (kinds?.length) {
    const first = kinds[0] ?? 'unknown';
    if (isHarnessContentKind(first)) {
      meta.contentKind = first;
      if (isSyntheticContentKind(first)) msg.synthetic = true;
    }
    return;
  }
  // Fallback: legacy text-marker sniffing (rollouts predating kinds).
  const first = msg.content[0];
  if (!first || first.type !== 'text') return;
  const hit = classifyLegacyText(first.text);
  if (!hit) return;
  meta.contentKind = hit.kind;
  if (hit.synthetic) msg.synthetic = true;
}

function outputToTextAndAttachments(output: unknown): { text: string; attachments: FileBlock[] } {
  const attachments: FileBlock[] = [];
  if (typeof output === 'string') return { text: output, attachments };
  if (Array.isArray(output)) {
    const texts: string[] = [];
    for (const item of output) {
      if (typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'input_image') {
        const url = String((item as Record<string, unknown>).image_url ?? '');
        const file: FileBlock = { type: 'file', url };
        const mime = /^data:([^;,]+)/.exec(url)?.[1];
        if (mime) file.mediaType = mime;
        attachments.push(file);
      } else if (typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).text === 'string') {
        texts.push(String((item as Record<string, unknown>).text));
      } else {
        texts.push(JSON.stringify(item) ?? String(item));
      }
    }
    return { text: texts.join('\n'), attachments };
  }
  return { text: safeJson(output ?? ''), attachments };
}

function iacToMessage(payload: Record<string, unknown>, ctx: { ts: string; ordinal?: number | undefined; lineSeq: number }): MigratedMessage | null {
  const meta: CodexMessageMeta = { itemType: 'inter_agent_communication', ts: ctx.ts };
  if (ctx.ordinal !== undefined) meta.ordinal = ctx.ordinal;
  if (typeof payload.id === 'string') meta.itemId = payload.id;
  meta.kind = 'iac';
  meta.author = String(payload.author ?? '');
  meta.recipient = String(payload.recipient ?? '');
  if (Array.isArray(payload.other_recipients)) meta.otherRecipients = payload.other_recipients.map(String);
  if (typeof payload.trigger_turn === 'boolean') meta.triggerTurn = payload.trigger_turn;
  if (payload.internal_chat_message_metadata_passthrough !== undefined) {
    meta.passthrough = payload.internal_chat_message_metadata_passthrough;
  }
  if (payload.encrypted_content != null) meta.encryptedDropped = true;
  return {
    role: 'assistant',
    content: [{ type: 'text', text: String(payload.content ?? '') }],
    timestamp: orEpoch(ctx.ts),
    seq: ctx.ordinal ?? ctx.lineSeq,
    meta: { codex: meta },
  };
}

interface CompactedBuild {
  entry: MigratedCompaction;
  summaryMessage: MigratedMessage;
}

function compactedToEntry(
  payload: Record<string, unknown>,
  ctx: { ts: string; ordinal?: number | undefined; lineSeq: number; scope?: string },
  _messages: MigratedMessage[],
): CompactedBuild {
  const summary = String(payload.message ?? '');
  const rh = Array.isArray(payload.replacement_history) ? payload.replacement_history : undefined;

  const nativeMeta: Record<string, unknown> = { ts: ctx.ts };
  if (ctx.ordinal !== undefined) nativeMeta.ordinal = ctx.ordinal;
  for (const [src, dst] of [
    ['window_number', 'windowNumber'],
    ['first_window_id', 'firstWindowId'],
    ['previous_window_id', 'previousWindowId'],
    ['window_id', 'windowId'],
    ['mcp_resource_origins', 'mcpResourceOrigins'],
    ['replacement_history_metadata', 'replacementHistoryMetadata'],
  ] as const) {
    if (payload[src] !== undefined) nativeMeta[dst] = payload[src];
  }

  const entry: MigratedCompaction = { summary };
  if (rh) {
    const rhMessages: MigratedMessage[] = [];
    for (let i = 0; i < rh.length; i++) {
      const envelope = rh[i] as Record<string, unknown>;
      const itemCtx: ItemCtx = { ts: ctx.ts, ordinal: ctx.ordinal, clientAuthored: false, lineSeq: i, ...(ctx.scope ? { scope: ctx.scope } : {}) };
      const msg = responseItemToMessage(envelope, itemCtx) ?? placeholderMessage(envelope, i);
      rhMessages.push(msg);
    }
    entry.replacementHistory = rhMessages;
  }
  entry.meta = { codex: nativeMeta };

  // Summary projection: codex's own reconstruction renders the CompactedItem
  // as an assistant message (history/src/lib.rs:191-203); the legacy (no
  // replacement_history) rebuild surfaces it in user-summary form
  // (rollout_reconstruction.rs — build_compacted_history). Write-back is
  // native either way; the role only matters for cross-tool consumers.
  const summaryMessage: MigratedMessage = {
    role: rh ? 'assistant' : 'user',
    content: summary ? [{ type: 'text', text: summary }] : [],
    timestamp: orEpoch(ctx.ts),
    seq: ctx.ordinal ?? ctx.lineSeq,
    meta: { codex: { itemType: 'compacted', ts: ctx.ts, ...(ctx.ordinal !== undefined ? { ordinal: ctx.ordinal } : {}), kind: 'compaction_summary' } as CodexMessageMeta },
  };
  return { entry, summaryMessage };
}

function placeholderMessage(payload: unknown, index: number): MigratedMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    seq: index,
    meta: { codex: { itemType: 'replacement_history_unknown', ts: '' } as CodexMessageMeta },
  };
}

function flushTurnBits(
  msg: MigratedMessage,
  pending: Array<{ kind: 'turnContext' | 'worldState'; row: CodexNativeRow; seq: number; time?: number }>,
): void {
  if (!pending.length) return;
  const meta = msg.meta!.codex as CodexMessageMeta;
  const turns = pending.filter((p) => p.kind === 'turnContext').map((p) => p.row);
  const worlds = pending.filter((p) => p.kind === 'worldState').map((p) => p.row);
  if (turns.length === 1) meta.turnContext = turns[0];
  else if (turns.length > 1) {
    meta.turnContext = turns[0];
    meta.turnContexts = turns;
  }
  if (worlds.length) meta.worldState = worlds;
  // Encounter order across both kinds, for write-back emission order.
  if (pending.length > 1) meta.turnRows = pending.map((p) => p.row);
  // Stamp each row with its source line position so write-back can emit it at
  // the exact original spot in the merged stream (not just before the message).
  for (const p of pending) {
    if ((p.row as CodexNativeRow).seq === undefined) (p.row as CodexNativeRow).seq = p.seq;
  }
  pending.length = 0;
}

/** Deep-strip encrypted fields from archived payloads (v3.1: data 去加密字段). */
function stripEncrypted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripEncrypted);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'encrypted_content' || k === 'encrypted_function_args') {
        out[k] = PLACEHOLDER_ENCRYPTED;
      } else {
        out[k] = stripEncrypted(v);
      }
    }
    return out;
  }
  return value;
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s && s.length > 200 ? `${s.slice(0, 200)}…` : (s ?? '');
  } catch {
    return String(v);
  }
}

/* ------------------------------------------------------------------ */
/* Public file-level parse                                             */
/* ------------------------------------------------------------------ */

/**
 * Paginated continuation stitching (docs/agents/codex.md §10): a rollout whose
 * session_meta.history_base points at a prefix file inherits that file's
 * records — codex resume loads the chain, so a migrated session must carry it
 * too or the target sees a truncated history. Records are concatenated
 * chronologically (prefix first); the SUFFIX's session_meta stays the own
 * identity line. Missing links / cycles degrade gracefully to single-file.
 */
async function stitchRecords(
  records: RolloutLineRaw[],
  sourcePath: string,
  codexHome: string,
  chain: PaginatedChainLink[],
  visited: Set<string>,
): Promise<RolloutLineRaw[]> {
  const ownLine = records.find((r) => r.type === 'session_meta');
  const hb = (ownLine?.payload as Record<string, unknown> | undefined)?.history_base as Record<string, unknown> | undefined;
  const prefixRolloutId = typeof hb?.thread_id === 'string' ? hb.thread_id : undefined;
  const endByteOffset = typeof hb?.end_byte_offset === 'number' ? hb.end_byte_offset : undefined;
  const endOrdinalExclusive = typeof hb?.end_ordinal_exclusive === 'number' ? hb.end_ordinal_exclusive : undefined;
  if (!hb || !prefixRolloutId || typeof endByteOffset !== 'number' || visited.has(prefixRolloutId) || chain.length >= 32) return records;
  visited.add(prefixRolloutId);

  const prefixPath = await findRolloutById(codexHome, prefixRolloutId, sourcePath);
  if (!prefixPath || prefixPath === sourcePath) return records;
  chain.push({ rolloutId: prefixRolloutId, ...(endOrdinalExclusive !== undefined ? { endOrdinalExclusive } : {}), endByteOffset, sourcePath: prefixPath });

  const prefixRecords = recordsUpToByte(await readRolloutText(prefixPath), endByteOffset);
  // the prefix may itself continue an earlier file
  const stitched = await stitchRecords(prefixRecords, prefixPath, codexHome, chain, visited);

  const rest = records.filter((r) => r !== ownLine);
  return [ownLine!, ...stitched, ...rest];
}

/** Records wholly contained before a byte offset (the exact paginated cut). */
function recordsUpToByte(text: string, endByteOffset: number): RolloutLineRaw[] {
  const out: RolloutLineRaw[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    if (offset >= endByteOffset) break;
    offset += Buffer.byteLength(line, 'utf8') + 1; // + newline
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as RolloutLineRaw);
    } catch {
      // tolerate a torn line inside the prefix
    }
  }
  return out;
}

/** Parse one rollout file (.jsonl or .jsonl.zst) into IR. */
export async function parseRolloutFile(path: string, codexHome?: string): Promise<MigratedSession> {
  const text = await readRolloutText(path);
  let records = parseRolloutLines(text);
  // codexHome = sessions/YYYY/MM/DD → up 5 levels (file → day → month → year → sessions → home)
  const home = codexHome ?? dirname(dirname(dirname(dirname(dirname(path)))));
  const titles = await loadSessionIndexTitles(home);
  // Paginated history_base chains stitch the full logical thread.
  const chain: PaginatedChainLink[] = [];
  const visited = new Set<string>();
  const base = parseRolloutFileNameBasic(basename(path));
  if (base) visited.add(base.rolloutId);
  records = await stitchRecords(records, path, home, chain, visited);
  return rolloutRecordsToIr(records, { titles, sourcePath: path, ...(chain.length ? { stitchedChain: chain } : {}) });
}

/** Resolve a session id (thread id or rollout id) to a rollout file path. */
export async function findRolloutById(codexHome: string, sessionId: string, exclude?: string): Promise<string | null> {
  const candidates: Array<{ path: string; mtime: number; kind: 'rollout' | 'thread' }> = [];
  await scanForId(codexHome, sessionId, candidates, exclude);
  await scanForId(join(codexHome, 'archived_sessions'), sessionId, candidates, exclude);
  if (!candidates.length) return null;
  // An exact rollout-id match (revert variant `_<rolloutId>` filename) wins
  // over a thread-id match — paginated history_base points at a specific
  // rollout file, and a thread can own several of those.
  candidates.sort((a, b) => (a.kind === b.kind ? b.mtime - a.mtime : a.kind === 'rollout' ? -1 : 1));
  return candidates[0].path;
}

async function scanForId(dir: string, sessionId: string, out: Array<{ path: string; mtime: number; kind: 'rollout' | 'thread' }>, exclude?: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await scanForId(full, sessionId, out, exclude);
    } else if (full !== exclude && e.isFile() && e.name.startsWith('rollout-') && (e.name.endsWith('.jsonl') || e.name.endsWith('.jsonl.zst'))) {
      const parsed = parseRolloutFileNameBasic(e.name);
      if (!parsed) continue;
      const kind = parsed.rolloutId === sessionId && parsed.threadId !== sessionId ? 'rollout' : 'thread';
      if (parsed.threadId !== sessionId && parsed.rolloutId !== sessionId) continue;
      const st = await fs.stat(full).catch(() => null);
      out.push({ path: full, mtime: st?.mtimeMs ?? 0, kind });
    }
  }
}

function parseRolloutFileNameBasic(name: string): { threadId: string; rolloutId: string } | null {
  const stripped = name.endsWith('.zst') ? name.slice(0, -4) : name;
  if (!stripped.startsWith('rollout-') || !stripped.endsWith('.jsonl')) return null;
  const body = stripped.slice('rollout-'.length, -'.jsonl'.length);
  if (body.length < 21 || body[19] !== '-') return null;
  const ids = body.slice(20);
  const under = ids.indexOf('_');
  return under >= 0 ? { threadId: ids.slice(0, under), rolloutId: ids.slice(under + 1) } : { threadId: ids, rolloutId: ids };
}
