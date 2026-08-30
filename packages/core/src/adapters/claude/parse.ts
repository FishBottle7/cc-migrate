/**
 * Claude Code adapter — READ side (docs/agents/claude.md §2/§3/§4 authoritative).
 *
 * Mirrors the native loadTranscriptFile pipeline so a migrated session carries
 * the same conversation the real resume rebuilds:
 *   1. tolerant JSONL parse (bad lines skipped, leading-NUL torn rows tolerated);
 *   2. B/C-class metadata rows collected last-wins/accumulate;
 *   3. legacy progress bridge (progress left the chain — children relink);
 *   4. compact-boundary relinks (preservedMessages uuid list preferred over the
 *      legacy preservedSegment tail→head walk; stale usage zeroed; pre-boundary
 *      non-preserved rows pruned) + snip removals;
 *   5. leaf = terminal message walked back to the nearest user/assistant;
 *      chain = parentUuid walk (a boundary's parentUuid=null truncates it, so
 *      the active chain holds only post-boundary rows — the folded segment's
 *      fidelity is carried by extensions.claude.recordsRaw, §8#7) +
 *      parallel tool_result recovery (siblings share message.id) + trailing
 *      children of the leaf.
 *
 * Projection (docs/ir-protocol.md gaps #6/#7): user/assistant keep their native
 * message object on `meta.claude.message` (block-level fidelity incl.
 * redacted_thinking, caller, citations, usage); `toolUseResult` rides the
 * tool_result block as `rawResult`; isMeta → synthetic; attachment rows project
 * blocks + full raw payload on meta; system rows → sessionEvents (local_command
 * → synthetic user text; compact_boundary → compaction anchor).
 */

import type {
  ContentBlock,
  FileBlock,
  MigratedCompaction,
  MigratedMessage,
  MigratedSession,
  MigratedSidechain,
  MigratedUnmappedEvent,
} from '../../ir.js';
import { normalizeContent } from '../../content.js';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { readdir } from 'node:fs/promises';

/* ------------------------------------------------------------------
 * Raw record types
 * ------------------------------------------------------------------ */

export interface ClaudeRawRecord {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  logicalParentUuid?: string;
  timestamp?: string;
  sessionId?: string;
  session_id?: string;
  isSidechain?: boolean;
  agentId?: string;
  teamName?: string;
  agentName?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  isApiErrorMessage?: boolean;
  isAbortedMidStream?: boolean;
  isVirtual?: boolean;
  sourceToolAssistantUUID?: string;
  toolUseResult?: unknown;
  message?: {
    id?: string;
    model?: string;
    role?: string;
    type?: string;
    content?: unknown;
    usage?: Record<string, unknown>;
    stop_reason?: string;
    [key: string]: unknown;
  };
  attachment?: Record<string, unknown>;
  content?: unknown;
  level?: string;
  compactMetadata?: ClaudeCompactMetadata & Record<string, unknown>;
  snipMetadata?: { removedUuids?: string[] };
  [key: string]: unknown;
}

export interface ClaudeCompactMetadata {
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
  cumulativeDroppedTokens?: number;
  durationMs?: number;
  preCompactDiscoveredTools?: string[];
  preservedSegment?: { headUuid: string; anchorUuid: string; tailUuid: string };
  preservedMessages?: { anchorUuid: string; uuids: string[]; allUuids?: string[] };
  userContext?: unknown;
  messagesSummarized?: number;
}

/** One parsed line, position retained for sessionEvents/recordsRaw ordering. */
export interface IndexedRecord {
  rec: ClaudeRawRecord;
  /** 0-based index of the line in the source file */
  line: number;
}

export interface ParsedLines {
  records: ClaudeRawRecord[];
  lineIndex: number[];
}

/** Tolerant JSONL parse: skip blanks, leading-NUL tear markers, and bad lines. */
export function parseClaudeLines(text: string): ParsedLines {
  const records: ClaudeRawRecord[] = [];
  const lineIndex: number[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!line) continue;
    let start = 0;
    while (start < line.length && line.charCodeAt(start) === 0) start++;
    if (start > 0) line = line.slice(start);
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as ClaudeRawRecord;
      if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
        records.push(rec);
        lineIndex.push(i);
      }
    } catch {
      // torn/corrupt line — native reader skips it too
    }
  }
  return { records, lineIndex };
}

/* ------------------------------------------------------------------
 * /resume listing metadata (enrichLog head-scan equivalent, §1.0)
 * ------------------------------------------------------------------ */

export interface ClaudeListHead {
  isSidechain: boolean;
  teamName?: string;
  customTitle?: string;
  aiTitle?: string;
  tag?: string;
  lastPrompt?: string;
  summary?: string;
  firstTimestamp?: string;
  gitBranch?: string;
  /** first transcript row's cwd stamp — the reliable cwd for listing (dir name is one-way) */
  cwd?: string;
  /** first non-meta user text — display fallback when no title rows exist (command-only sessions) */
  firstPrompt?: string;
}

/**
 * Head-scan one session file for list metadata (enrichLog 64KB 窗口的精简等价):
 * first line's isSidechain, first customTitle/ai-title/tag/last-prompt row,
 * first transcript timestamp. File-name uuid validation is the caller's job.
 */
export async function readClaudeLinesForList(path: string): Promise<ClaudeListHead> {
  const text = await readFile(path, 'utf8');
  const head: ClaudeListHead = { isSidechain: false };
  const lines = text.split('\n');
  const scanLimit = Math.min(lines.length, 400);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!line) continue;
    let start = 0;
    while (start < line.length && line.charCodeAt(start) === 0) start++;
    if (start > 0) line = line.slice(start);
    if (!line.trim()) continue;
    if (i === 0) {
      if (line.includes('"isSidechain":true')) {
        head.isSidechain = true;
        break; // 旁链文件直接过滤，无需更多信息
      }
      const tm = line.match(/"teamName":"([^"]*)"/);
      if (tm && tm[1]) head.teamName = tm[1];
    }
    try {
      const rec = JSON.parse(line) as ClaudeRawRecord;
      if (!head.firstTimestamp && typeof rec.timestamp === 'string') head.firstTimestamp = rec.timestamp;
      if (!head.customTitle && rec.type === 'custom-title' && typeof rec.customTitle === 'string') head.customTitle = rec.customTitle;
      if (!head.aiTitle && rec.type === 'ai-title' && typeof rec.aiTitle === 'string') head.aiTitle = rec.aiTitle;
      if (!head.tag && rec.type === 'tag' && typeof rec.tag === 'string') head.tag = rec.tag;
      if (!head.lastPrompt && rec.type === 'last-prompt') {
        if (typeof rec.lastPrompt === 'string') head.lastPrompt = rec.lastPrompt;
      }
      if (!head.summary && rec.type === 'summary' && typeof rec.summary === 'string') head.summary = rec.summary;
      if (!head.gitBranch && typeof rec.gitBranch === 'string' && rec.gitBranch) head.gitBranch = rec.gitBranch;
      if (!head.cwd && typeof rec.cwd === 'string' && rec.cwd) head.cwd = rec.cwd;
      // fallback title for command-only/empty sessions (55dd… real case: a
      // session that only ran /model etc. has no title rows and no real prompt)
      if (!head.firstPrompt && rec.type === 'user' && !rec.isMeta && !rec.isCompactSummary) {
        const c = rec.message?.content;
        const text =
          typeof c === 'string' ? c : Array.isArray(c) ? (c as Array<{ type?: string; text?: string }>).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join(' ') : '';
        const flat = text.replace(/\s+/g, ' ').trim();
        if (flat) head.firstPrompt = flat.slice(0, 120);
      }
      if (i > 200 && head.customTitle && (head.lastPrompt || head.firstTimestamp)) break;
    } catch {
      // tolerate bad rows while scanning
    }
    if (i > 400) break; // enough for list purposes
  }
  return head;
}

export interface ClaudeMetadata {
  lastPrompt?: string;
  lastPromptLeafUuid?: string;
  customTitle?: string;
  aiTitle?: string;
  tag?: string;
  mode?: string;
  permissionMode?: string;
  agentName?: string;
  agentColor?: string;
  agentSetting?: unknown;
  worktreeSession?: unknown;
  prLink?: ClaudeRawRecord;
  costState?: ClaudeRawRecord;
  atisLatch?: ClaudeRawRecord;
  teamName?: string;
  agentSettingStamp?: unknown;
  /** legacy type:'summary' rows (compact 已不写；读端兼容) */
  legacySummaries: ClaudeRawRecord[];
  /** content-replacement rows (accumulate, 按文件序) */
  contentReplacements: ClaudeRawRecord[];
  /** every non-transcript row in file order (rebuild re-append + recordsRaw 兜底之外的结构化副本) */
  rows: ClaudeRawRecord[];
}

const TRANSCRIPT_TYPES = new Set(['user', 'assistant', 'attachment', 'system']);

function collectMetadata(records: ClaudeRawRecord[]): ClaudeMetadata {
  const meta: ClaudeMetadata = { legacySummaries: [], contentReplacements: [], rows: [] };
  for (const rec of records) {
    switch (rec.type) {
      case 'user':
      case 'assistant':
      case 'attachment':
      case 'system':
      case 'progress':
        break; // transcript / progress — not metadata
      case 'summary':
        meta.legacySummaries.push(rec);
        break;
      case 'last-prompt':
        if (typeof rec.lastPrompt === 'string') meta.lastPrompt = rec.lastPrompt;
        if (typeof rec.leafUuid === 'string') meta.lastPromptLeafUuid = rec.leafUuid;
        break;
      case 'custom-title':
        if (typeof rec.customTitle === 'string') meta.customTitle = rec.customTitle;
        break;
      case 'ai-title':
        if (typeof rec.aiTitle === 'string') meta.aiTitle = rec.aiTitle;
        break;
      case 'tag':
        if (typeof rec.tag === 'string') meta.tag = rec.tag;
        break;
      case 'mode':
        if (typeof rec.mode === 'string') meta.mode = rec.mode;
        break;
      case 'permission-mode':
        if (typeof rec.permissionMode === 'string') meta.permissionMode = rec.permissionMode;
        break;
      case 'agent-name':
        if (typeof rec.agentName === 'string') meta.agentName = rec.agentName;
        break;
      case 'agent-color':
        if (typeof rec.agentColor === 'string') meta.agentColor = rec.agentColor;
        break;
      case 'agent-setting':
        meta.agentSetting = rec.agentSetting;
        break;
      case 'worktree-state':
        meta.worktreeSession = rec.worktreeSession;
        break;
      case 'pr-link':
        meta.prLink = rec;
        break;
      case 'cost-state':
        meta.costState = rec;
        break;
      case 'atis-latch':
        meta.atisLatch = rec;
        break;
      case 'content-replacement':
        meta.contentReplacements.push(rec);
        break;
      default:
        // relocated / isolated-latch / frame-link / queue-operation / …
        meta.rows.push(rec);
        break;
    }
    // teamName/agentName stamps ride transcript records; remember them session-wide
    if (typeof rec.teamName === 'string' && rec.teamName && !meta.teamName) meta.teamName = rec.teamName;
    if (typeof rec.agentName === 'string' && rec.agentName && !meta.agentName) meta.agentName = rec.agentName;
  }
  return meta;
}

/* ------------------------------------------------------------------
 * Transcript load: progress bridge + relinks
 * ------------------------------------------------------------------ */

export interface LoadedTranscript {
  messages: Map<string, ClaudeRawRecord>;
  meta: ClaudeMetadata;
  rawRecords: ClaudeRawRecord[];
  lineIndex: number[];
}

export function loadTranscriptRecords(records: ClaudeRawRecord[], lineIndex: number[]): LoadedTranscript {
  const messages = new Map<string, ClaudeRawRecord>();
  const progressBridge = new Map<string, string | null>();

  for (const rec of records) {
    if (rec.type === 'progress' && typeof rec.uuid === 'string') {
      // legacy progress bridge: chain-resolve consecutive progress entries so a
      // message whose parentUuid lands on progress still reaches its ancestor
      const parent = (rec.parentUuid ?? null) as string | null;
      progressBridge.set(rec.uuid, parent && progressBridge.has(parent) ? (progressBridge.get(parent) ?? null) : parent);
      continue;
    }
    if (!TRANSCRIPT_TYPES.has(rec.type ?? '') || typeof rec.uuid !== 'string') continue;
    const parent = rec.parentUuid;
    if (parent && progressBridge.has(parent)) {
      messages.set(rec.uuid, { ...rec, parentUuid: progressBridge.get(parent) ?? null });
    } else {
      messages.set(rec.uuid, rec);
    }
  }

  applyPreservedSegmentRelinks(messages);
  applySnipRemovals(messages);
  return { messages, meta: collectMetadata(records), rawRecords: records, lineIndex };
}

export function isCompactBoundary(rec: ClaudeRawRecord): boolean {
  return rec.type === 'system' && rec.subtype === 'compact_boundary';
}

/**
 * preservedSegment/preservedMessages relink (sessionStorage.ts:1839, 2.1.251
 * priority: explicit preservedMessages uuid list first, preservedSegment walk
 * fallback). head→anchor relink, anchor's other children→tail, stale usage
 * zeroed, non-preserved pre-boundary rows pruned.
 */
export function applyPreservedSegmentRelinks(messages: Map<string, ClaudeRawRecord>): void {
  let absoluteLastBoundaryIdx = -1;
  let lastSegBoundaryIdx = -1;
  let lastSeg: ClaudeCompactMetadata['preservedSegment'] | undefined;
  let lastList: ClaudeCompactMetadata['preservedMessages'] | undefined;
  const entryIndex = new Map<string, number>();
  let i = 0;
  for (const entry of messages.values()) {
    entryIndex.set(entry.uuid!, i);
    if (isCompactBoundary(entry)) {
      absoluteLastBoundaryIdx = i;
      const cm = (entry.compactMetadata ?? {}) as ClaudeCompactMetadata;
      if (cm.preservedSegment || cm.preservedMessages) {
        lastSegBoundaryIdx = i;
        lastSeg = cm.preservedSegment;
        lastList = cm.preservedMessages;
      }
    }
    i++;
  }
  if (!lastSeg && !lastList) return;
  const segIsLive = lastSegBoundaryIdx === absoluteLastBoundaryIdx;
  if (!segIsLive) return;

  // resolve the preserved uuid set
  const preserved = new Set<string>();
  let anchorUuid: string | undefined;
  let headUuid: string | undefined;
  let tailUuid: string | undefined;
  if (lastList) {
    anchorUuid = lastList.anchorUuid;
    preserved.add(anchorUuid);
    for (const u of lastList.uuids ?? []) {
      if (!messages.has(u)) return; // broken metadata → native no-op (full history loads)
      preserved.add(u);
      for (const tr of toolResultChildrenOf(messages, u)) preserved.add(tr);
    }
    headUuid = lastList.uuids?.[0];
    tailUuid = lastList.uuids?.[lastList.uuids.length - 1];
  } else if (lastSeg) {
    const seen = new Set<string>();
    let cur = messages.get(lastSeg.tailUuid);
    let reachedHead = false;
    while (cur && cur.uuid && !seen.has(cur.uuid)) {
      seen.add(cur.uuid);
      if (cur.uuid === lastSeg.headUuid) {
        reachedHead = true;
        break;
      }
      cur = cur.parentUuid ? messages.get(cur.parentUuid) : undefined;
    }
    if (!reachedHead) return;
    anchorUuid = lastSeg.anchorUuid;
    headUuid = lastSeg.headUuid;
    tailUuid = lastSeg.tailUuid;
    for (const u of seen) preserved.add(u);
  } else {
    return;
  }
  if (!anchorUuid) return;

  if (headUuid && messages.has(headUuid)) {
    messages.set(headUuid, { ...messages.get(headUuid)!, parentUuid: anchorUuid });
  }
  if (tailUuid) {
    for (const [u, msg] of messages) {
      if (u !== headUuid && msg.parentUuid === anchorUuid) {
        messages.set(u, { ...msg, parentUuid: tailUuid });
      }
    }
  }
  // zero stale usage on preserved assistants (resume → autocompact spiral guard)
  for (const u of preserved) {
    const msg = messages.get(u);
    if (msg?.type !== 'assistant' || !msg.message) continue;
    messages.set(u, {
      ...msg,
      message: {
        ...msg.message,
        usage: {
          ...(msg.message.usage ?? {}),
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
  }
  const toDelete: string[] = [];
  for (const [u] of messages) {
    const idx = entryIndex.get(u);
    if (idx !== undefined && idx < absoluteLastBoundaryIdx && !preserved.has(u)) toDelete.push(u);
  }
  for (const u of toDelete) messages.delete(u);
}

function toolResultChildrenOf(messages: Map<string, ClaudeRawRecord>, assistantUuid: string): string[] {
  const out: string[] = [];
  for (const m of messages.values()) {
    if (
      m.type === 'user' &&
      m.parentUuid === assistantUuid &&
      Array.isArray(m.message?.content) &&
      (m.message!.content as Array<{ type?: string }>).some((b) => b?.type === 'tool_result')
    ) {
      if (m.uuid) out.push(m.uuid);
    }
  }
  return out;
}

/** Snip removals: delete removedUuids and relink survivors across the gap. */
export function applySnipRemovals(messages: Map<string, ClaudeRawRecord>): void {
  const toDelete = new Set<string>();
  for (const entry of messages.values()) {
    const removed = (entry.snipMetadata as { removedUuids?: string[] } | undefined)?.removedUuids;
    if (Array.isArray(removed)) for (const u of removed) toDelete.add(u);
  }
  if (!toDelete.size) return;
  const deletedParent = new Map<string, string | null>();
  for (const u of toDelete) {
    const e = messages.get(u);
    if (!e) continue;
    deletedParent.set(u, e.parentUuid ?? null);
    messages.delete(u);
  }
  const resolve = (start: string): string | null => {
    let cur: string | null = start;
    while (cur && toDelete.has(cur)) {
      const next = deletedParent.get(cur);
      cur = next === undefined ? null : next;
    }
    return cur;
  };
  for (const [u, msg] of [...messages]) {
    if (msg.parentUuid && toDelete.has(msg.parentUuid)) {
      messages.set(u, { ...msg, parentUuid: resolve(msg.parentUuid) });
    }
  }
}

/* ------------------------------------------------------------------
 * Leaf selection + chain walk + parallel tool_result recovery
 * ------------------------------------------------------------------ */

export function computeLeafUuids(messages: Map<string, ClaudeRawRecord>): Set<string> {
  const all = [...messages.values()];
  const parents = new Set(all.map((m) => m.parentUuid).filter((u): u is string => !!u));
  const leaves = new Set<string>();
  for (const terminal of all.filter((m) => !parents.has(m.uuid!))) {
    const seen = new Set<string>();
    let cur: ClaudeRawRecord | undefined = terminal;
    while (cur) {
      if (cur.uuid && seen.has(cur.uuid)) break;
      if (cur.uuid) seen.add(cur.uuid);
      if (cur.type === 'user' || cur.type === 'assistant') {
        leaves.add(cur.uuid!);
        break;
      }
      cur = cur.parentUuid ? messages.get(cur.parentUuid) : undefined;
    }
  }
  return leaves;
}

export function buildConversationChain(
  messages: Map<string, ClaudeRawRecord>,
  leaf: ClaudeRawRecord,
): ClaudeRawRecord[] {
  const chain: ClaudeRawRecord[] = [];
  const seen = new Set<string>();
  let cur: ClaudeRawRecord | undefined = leaf;
  while (cur) {
    if (cur.uuid && seen.has(cur.uuid)) break;
    if (cur.uuid) seen.add(cur.uuid);
    chain.push(cur);
    cur = cur.parentUuid ? messages.get(cur.parentUuid) : undefined;
  }
  chain.reverse();
  return recoverOrphanedParallelToolResults(messages, chain, seen);
}

/**
 * Streaming splits N parallel tool_uses into N assistant records sharing
 * message.id; each tool_result's parentUuid points at its own one-block
 * assistant. A single-parent walk keeps one branch — off-chain siblings (same
 * message.id) and their tool_results splice back after the last on-chain group
 * member, timestamp order (sessionStorage.ts:2118).
 */
export function recoverOrphanedParallelToolResults(
  allMessages: Map<string, ClaudeRawRecord>,
  chain: ClaudeRawRecord[],
  seen: Set<string>,
): ClaudeRawRecord[] {
  const chainAssistants = chain.filter((m) => m.type === 'assistant');
  if (!chainAssistants.length) return chain;

  const anchorByMsgId = new Map<string, ClaudeRawRecord>();
  for (const a of chainAssistants) {
    const id = typeof a.message?.id === 'string' ? a.message.id : undefined;
    if (id) anchorByMsgId.set(id, a);
  }

  const siblingsByMsgId = new Map<string, ClaudeRawRecord[]>();
  const toolResultsByAsst = new Map<string, ClaudeRawRecord[]>();
  for (const m of allMessages.values()) {
    if (m.type === 'assistant' && typeof m.message?.id === 'string') {
      const g = siblingsByMsgId.get(m.message.id);
      if (g) g.push(m);
      else siblingsByMsgId.set(m.message.id, [m]);
    } else if (m.type === 'user' && m.parentUuid && hasToolResultBlock(m)) {
      const g = toolResultsByAsst.get(m.parentUuid);
      if (g) g.push(m);
      else toolResultsByAsst.set(m.parentUuid, [m]);
    }
  }

  const processed = new Set<string>();
  const inserts = new Map<string, ClaudeRawRecord[]>();
  for (const asst of chainAssistants) {
    const msgId = typeof asst.message?.id === 'string' ? asst.message.id : undefined;
    if (!msgId || processed.has(msgId)) continue;
    processed.add(msgId);
    const group = siblingsByMsgId.get(msgId) ?? [asst];
    const orphanSiblings = group.filter((s) => s.uuid && !seen.has(s.uuid));
    const orphanTRs: ClaudeRawRecord[] = [];
    for (const member of group) {
      for (const tr of toolResultsByAsst.get(member.uuid!) ?? []) {
        if (tr.uuid && !seen.has(tr.uuid)) orphanTRs.push(tr);
      }
    }
    if (!orphanSiblings.length && !orphanTRs.length) continue;
    orphanSiblings.sort(cmpTimestamp);
    orphanTRs.sort(cmpTimestamp);
    const anchor = anchorByMsgId.get(msgId)!;
    const recovered = [...orphanSiblings, ...orphanTRs];
    for (const r of recovered) if (r.uuid) seen.add(r.uuid);
    inserts.set(anchor.uuid!, recovered);
  }
  if (!inserts.size) return chain;
  const out: ClaudeRawRecord[] = [];
  for (const m of chain) {
    out.push(m);
    const add = inserts.get(m.uuid!);
    if (add) out.push(...add);
  }
  return out;
}

function cmpTimestamp(a: ClaudeRawRecord, b: ClaudeRawRecord): number {
  return String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? ''));
}

function hasToolResultBlock(rec: ClaudeRawRecord): boolean {
  return (
    Array.isArray(rec.message?.content) &&
    (rec.message!.content as Array<{ type?: string }>).some((b) => b && typeof b === 'object' && b.type === 'tool_result')
  );
}

/** Index tool_result-bearing user records by parentUuid (= the assistant uuid). */
export function toolResultChildrenByAsst(messages: Map<string, ClaudeRawRecord>): Map<string, ClaudeRawRecord[]> {
  const out = new Map<string, ClaudeRawRecord[]>();
  for (const m of messages.values()) {
    if (m.type === 'user' && m.parentUuid && hasToolResultBlock(m)) {
      const g = out.get(m.parentUuid);
      if (g) g.push(m);
      else out.set(m.parentUuid, [m]);
    }
  }
  return out;
}

/**
 * Trailing messages hanging off the conversation tail: the native loader keeps
 * the chain ending at the leaf, then appends each subsequent child subtree
 * depth-first (children of the leaf, then their children, …) — the shape after
 * `Continue from where you left off` where queue/attachment/system records
 * follow the final assistant (sessionStorage.ts:4630-4645, timestamp-sorted at
 * each level).
 */
export function trailingChildrenOf(
  messages: Map<string, ClaudeRawRecord>,
  leafUuid: string,
): ClaudeRawRecord[] {
  const out: ClaudeRawRecord[] = [];
  const walk = (parent: string): void => {
    const kids = [...messages.values()]
      .filter((m) => m.parentUuid === parent)
      .sort(cmpTimestamp);
    for (const kid of kids) {
      out.push(kid);
      if (kid.uuid) walk(kid.uuid);
    }
  };
  walk(leafUuid);
  return out;
}

/* ------------------------------------------------------------------
 * Raw records → IR projection
 * ------------------------------------------------------------------ */

export interface ClaudeProjection {
  messages: MigratedMessage[];
  compaction: MigratedCompaction[];
  sessionEvents: MigratedUnmappedEvent[];
}

function isoToMs(iso: unknown): number | undefined {
  if (typeof iso !== 'string') return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

/** Envelope fields that ride `meta.claude` (message-level native payload). */
function envelopeMeta(rec: ClaudeRawRecord): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  for (const key of [
    'parentUuid', 'logicalParentUuid', 'isSidechain', 'teamName', 'agentName',
    'promptId', 'agentId', 'userType', 'entrypoint', 'cwd', 'version',
    'gitBranch', 'slug', 'sessionKind', 'session_id', 'origin', 'promptSource',
    'permissionMode', 'requestId', 'effort', 'isAbortedMidStream', 'isVirtual',
    'sourceToolAssistantUUID', 'interruptedMessageId', 'toolDenialKind',
    'summarizeMetadata', 'isVisibleInTranscriptOnly',
    'attributionAgent', 'attributionSkill', 'attributionMcpServer', 'attributionMcpTool',
  ] as const) {
    if (rec[key] !== undefined) m[key] = rec[key];
  }
  return m;
}

function firstTextOf(v: unknown): string | undefined {
  if (typeof v === 'string' && v) return v;
  if (Array.isArray(v)) {
    const parts = v.filter((x): x is string => typeof x === 'string');
    if (parts.length) return parts.join('\n');
  }
  if (v !== undefined && v !== null && typeof v !== 'string') return safeJson(v);
  return undefined;
}

function attachmentBlocks(att: Record<string, unknown>): ContentBlock[] {
  const t = typeof att.type === 'string' ? att.type : undefined;
  const asFile = (): FileBlock => {
    const f: FileBlock = { type: 'file' };
    if (typeof att.filename === 'string') f.filename = att.filename;
    if (typeof att.displayPath === 'string') f.url = att.displayPath;
    return f;
  };
  switch (t) {
    case 'file':
    case 'compact_file_reference':
    case 'pdf_reference':
    case 'plan_file_reference':
      return [asFile()];
    case 'edited_text_file':
      return [{ type: 'text', text: `[edited file: ${String(att.filename ?? '')}]\n${typeof att.snippet === 'string' ? att.snippet : ''}` }];
    case 'deferred_tools_delta':
    case 'agent_listing_delta': {
      // tool/agent listing deltas: the human-readable lines ARE the payload
      const parts = [att.addedLines, att.removedLines, att.readdedLines].flatMap((v) =>
        Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && !!s) : [],
      );
      if (parts.length) return [{ type: 'text', text: parts.join('\n') }];
      const names = namesOf(att);
      if (names.length) return [{ type: 'text', text: `[${t}] ${names.join(', ')}` }];
      // all-empty delta (e.g. only failed MCP servers): still carry the payload
      const json = safeJson(att);
      return json && json !== '{}' ? [{ type: 'text', text: `[${t}] ${json}` }] : [];
    }
    case 'nested_memory':
    case 'relevant_memories':
    case 'dynamic_skill':
    case 'skill_listing':
    case 'skill_discovery':
    case 'invoked_skills':
    case 'current_session_memory':
    case 'read_truncation_notice':
    case 'total_tokens_reminder':
    case 'task_reminder': {
      // content may be string, string[], or other JSON
      const c = att.content ?? att.text;
      if (typeof c === 'string' && c) return [{ type: 'text', text: c }];
      const joined = stringsOf(c);
      if (joined) return [{ type: 'text', text: joined }];
      return c !== undefined && c !== null ? [{ type: 'text', text: safeJson(c) }] : [];
    }
    case 'hook_additional_context':
    case 'hook_system_message': {
      // content may be string OR string[] (multiple hook outputs)
      const c = att.content;
      if (typeof c === 'string' && c) return [{ type: 'text', text: c }];
      const joined = stringsOf(c);
      return joined ? [{ type: 'text', text: joined }] : [];
    }
    case 'hook_success':
    case 'hook_non_blocking_error': {
      // hook output rows: silent no-ops (empty output, exit 0, hook_success) skip
      const hasOut =
        (typeof att.content === 'string' && att.content) ||
        (typeof att.stdout === 'string' && att.stdout) ||
        (typeof att.stderr === 'string' && att.stderr);
      if (!hasOut && att.exitCode === 0 && t === 'hook_success') return [];
      const parts: string[] = [];
      if (typeof att.hookName === 'string') {
        parts.push(`[hook ${att.hookName}${att.exitCode !== undefined ? ` exit=${att.exitCode}` : ''}]`);
      }
      if (typeof att.content === 'string' && att.content) parts.push(att.content);
      if (typeof att.stderr === 'string' && att.stderr) parts.push(att.stderr);
      if (typeof att.stdout === 'string' && att.stdout) parts.push(att.stdout);
      return parts.length ? [{ type: 'text', text: parts.join('\n') }] : [];
    }
    case 'queued_command': {
      const p = att.prompt;
      if (typeof p === 'string' && p) return [{ type: 'text', text: p }];
      if (Array.isArray(p)) return normalizeContent(p);
      return [];
    }
    case 'date_change': {
      const text = typeof att.newDate === 'string' ? att.newDate : typeof att.content === 'string' ? att.content : '';
      return text ? [{ type: 'text', text }] : [];
    }
    case 'plan_mode_exit': {
      const p = typeof att.planFilePath === 'string' ? att.planFilePath : '';
      return p ? [{ type: 'text', text: `[plan_mode_exit: ${p}${att.planExists === false ? ' (no plan file)' : ''}]` }] : [];
    }
    default: {
      // unknown attachment type: never drop the row silently — carry the whole
      // payload as text (红线 #2: 注入上下文也是模型上下文的一部分)
      const body = att.content ?? att.text ?? att.prompt ?? att.newDate;
      if (typeof body === 'string' && body) return [{ type: 'text', text: body }];
      const joined = stringsOf(body);
      if (joined) return [{ type: 'text', text: joined }];
      const json = safeJson(att);
      return json && json !== '{}' ? [{ type: 'text', text: `[attachment: ${t ?? 'unknown'}] ${json}` }] : [];
    }
  }
}

/** join a string[] payload (non-strings JSON-encoded), '' when empty. */
function stringsOf(v: unknown): string {
  return Array.isArray(v)
    ? v.map((x) => (typeof x === 'string' ? x : safeJson(x))).filter(Boolean).join('\n')
    : '';
}

/** all delta name lists of a tools/agents delta attachment, flattened. */
function namesOf(att: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ['addedNames', 'removedNames', 'readdedNames', 'addedTypes', 'removedTypes'] as const) {
    if (Array.isArray(att[k])) {
      for (const v of att[k] as unknown[]) {
        if (typeof v === 'string' && v) out.push(v);
        else if (v !== null && v !== undefined) out.push(safeJson(v));
      }
    }
  }
  return out;
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s && s.length > 400 ? `${s.slice(0, 400)}…` : (s ?? '');
  } catch {
    return String(v);
  }
}

/**
 * Project one reconstructed chain into IR messages + compaction + sessionEvents.
 */
export function projectChain(
  chain: IndexedRecord[],
  meta: ClaudeMetadata,
): ClaudeProjection {
  const messages: MigratedMessage[] = [];
  const compaction: MigratedCompaction[] = [];
  const sessionEvents: MigratedUnmappedEvent[] = [];
  const uuidToIndex = new Map<string, number>();
  let pendingBoundary: ClaudeRawRecord | null = null;

  for (const { rec, line } of chain) {
    const ts = isoToMs(rec.timestamp);
    if (rec.type === 'user' || rec.type === 'assistant') {
      const blocks = normalizeContent(
        Array.isArray(rec.message?.content)
          ? (rec.message!.content as unknown[])
          : typeof rec.message?.content === 'string'
            ? [{ type: 'text', text: rec.message!.content as string }]
            : [],
      );
      // structured tool-result payload rides the block entity (gap #6)
      const toolUseResult = rec.toolUseResult;
      if (toolUseResult !== undefined) {
        const trBlock = blocks.find((b) => b.type === 'tool_result') as
          | Extract<ContentBlock, { type: 'tool_result' }>
          | undefined;
        if (trBlock) (trBlock as { rawResult?: unknown }).rawResult = toolUseResult;
      }
      // synthetic API error messages are stripped (claude drops them at replay too)
      if (rec.type === 'assistant' && rec.isApiErrorMessage === true) continue;

      const msg: MigratedMessage = {
        role: rec.type === 'assistant' ? 'assistant' : 'user',
        content: blocks,
        timestamp: ts,
      };
      const m = envelopeMeta(rec);
      if (rec.isMeta === true) {
        msg.synthetic = true;
        m.isMeta = true; // write-side keep-gate: isMeta rows replay into model context (§2.2)
      }
      if (rec.message) m.message = rec.message;
      if (rec.toolUseResult !== undefined && !blocks.some((b) => b.type === 'tool_result')) {
        m.toolUseResult = rec.toolUseResult;
      }
      if (Object.keys(m).length) msg.meta = { claude: m };
      uuidToIndex.set(rec.uuid!, messages.length);
      if (rec.isCompactSummary === true) {
        // the isCompactSummary user record is the projected summary carrier;
        // its boundary (chain parent) supplies compactMetadata
        const boundary = pendingBoundary && isCompactBoundary(pendingBoundary) ? pendingBoundary : null;
        const cm = (boundary?.compactMetadata ?? {}) as ClaudeCompactMetadata;
        const claudeMeta: Record<string, unknown> = {};
        if (boundary) claudeMeta.boundaryRecord = boundary;
        if (Object.keys(cm).length) claudeMeta.compactMetadata = cm;
        const entry: MigratedCompaction = {
          summary: blocks
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
            .join('\n'),
          meta: { claude: claudeMeta },
          anchorIndex: messages.length,
        };
        compaction.push(entry);
        pendingBoundary = null;
      }
      messages.push(msg);
      continue;
    }

    if (rec.type === 'attachment') {
      const att = (rec.attachment ?? {}) as Record<string, unknown>;
      const msg: MigratedMessage = {
        role: 'user',
        content: attachmentBlocks(att),
        timestamp: ts,
        synthetic: true,
      };
      const m = envelopeMeta(rec);
      m.attachment = rec.attachment;
      m.systemSubtype = 'attachment';
      msg.meta = { claude: m };
      messages.push(msg);
      continue;
    }

    if (rec.type === 'system') {
      const subtype = typeof rec.subtype === 'string' ? rec.subtype : 'unknown';
      if (subtype === 'local_command') {
        // the ONE system subtype that participates in model replay (→ user text)
        const text = typeof rec.content === 'string' ? rec.content : safeJson(rec.content);
        const msg: MigratedMessage = {
          role: 'user',
          content: [{ type: 'text', text }],
          timestamp: ts,
          synthetic: true,
          meta: { claude: { ...envelopeMeta(rec), systemSubtype: 'local_command', level: rec.level } },
        };
        messages.push(msg);
        continue;
      }
      if (isCompactBoundary(rec)) {
        pendingBoundary = rec; // paired with the isCompactSummary record that follows
        continue;
      }
      sessionEvents.push({ seq: line, time: ts ?? 0, type: subtype, data: rec });
      continue;
    }

    // progress / anything else unprojected → sessionEvents
    sessionEvents.push({ seq: line, time: ts ?? 0, type: String(rec.type ?? 'unknown'), data: rec });
  }

  // legacy type:'summary' rows → compaction entries anchored at their leafUuid
  for (const s of meta.legacySummaries) {
    if (typeof s.summary !== 'string') continue;
    const leafUuid = typeof s.leafUuid === 'string' ? s.leafUuid : undefined;
    const anchor = leafUuid ? uuidToIndex.get(leafUuid) : undefined;
    compaction.push({
      summary: s.summary,
      ...(anchor !== undefined ? { anchorIndex: anchor } : {}),
      meta: { claude: { legacySummary: true, ...(leafUuid ? { leafUuid } : {}) } },
    });
  }

  return { messages, compaction, sessionEvents };
}

/** Enrich an IR session from a loaded transcript (projection + session-level fields). */
export function loadedTranscriptToIr(
  loaded: LoadedTranscript,
  opts: { sourcePath?: string } = {},
): { ir: MigratedSession; rawRecords: unknown[] } {
  const { messages: messageMap, meta } = loaded;
  const leaves = computeLeafUuids(messageMap);
  const leafCandidates = [...messageMap.values()].filter(
    (m) => leaves.has(m.uuid!) && (m.type === 'user' || m.type === 'assistant'),
  );
  let chain: ClaudeRawRecord[] = [];
  if (leafCandidates.length) {
    const latest = leafCandidates.reduce((a, b) =>
      String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? '')) > 0 ? a : b,
    );
    chain = buildConversationChain(messageMap, latest);
    const trailing = trailingChildrenOf(messageMap, latest.uuid!);
    chain.push(...trailing);
  }
  const indexed: IndexedRecord[] = chain.map((rec, i) => ({
    rec,
    line: rawLineOf(loaded, rec, i),
  }));
  const projection = projectChain(indexed, meta);

  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'claude',
    originSessionId: sessionUuidOf(loaded),
    messages: projection.messages,
  };
  const createdAt = chain.length ? isoToMs(chain[0]!.timestamp) : undefined;
  if (createdAt !== undefined) ir.createdAt = createdAt;
  const cwd = chain.map((r) => r.cwd).find((c): c is string => typeof c === 'string' && !!c);
  if (cwd) ir.cwd = cwd;

  // high-frequency metadata rows → typed slots (§8#6)
  if (meta.customTitle || meta.aiTitle) ir.title = meta.customTitle ?? meta.aiTitle;
  if (meta.tag) ir.tag = meta.tag;
  if (meta.permissionMode) ir.permissionMode = meta.permissionMode;
  if (meta.worktreeSession !== undefined) ir.worktreeSession = meta.worktreeSession;
  if (meta.prLink) {
    ir.prLink = {
      prNumber: Number(meta.prLink.prNumber ?? 0),
      prUrl: String(meta.prLink.prUrl ?? ''),
      prRepository: String(meta.prLink.prRepository ?? ''),
      ...(typeof meta.prLink.timestamp === 'string' ? { timestamp: meta.prLink.timestamp } : {}),
    };
  }
  if (meta.costState) ir.costState = meta.costState;
  if (projection.compaction.length) ir.compaction = projection.compaction;
  if (projection.sessionEvents.length) ir.sessionEvents = projection.sessionEvents;

  // session-level native payload
  const sessionClaude: Record<string, unknown> = { metadata: meta };
  if (meta.teamName) sessionClaude.teamName = meta.teamName;
  if (meta.agentName) sessionClaude.agentName = meta.agentName;
  ir.meta = { claude: sessionClaude };

  const rawRecords = loaded.rawRecords;
  return { ir, rawRecords };
}

function rawLineOf(loaded: LoadedTranscript, rec: ClaudeRawRecord, chainIdx: number): number {
  // find the line for this record via identity in the raw array
  const idx = loaded.rawRecords.indexOf(rec);
  return idx >= 0 ? loaded.lineIndex[idx] ?? chainIdx : chainIdx;
}

function sessionUuidOf(loaded: LoadedTranscript): string | undefined {
  for (const rec of loaded.rawRecords) {
    if (typeof rec.sessionId === 'string' && rec.sessionId) return rec.sessionId;
  }
  return undefined;
}

/* ------------------------------------------------------------------
 * Full-file parse (main session + subagent sidechains + teammate)
 * ------------------------------------------------------------------ */

export interface AgentMetaSidecar {
  agentType?: string;
  worktreePath?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
  [key: string]: unknown;
}

/** Read one main-file transcript (by path) → IR with sidechains attached. */
export async function parseClaudeFile(path: string): Promise<MigratedSession> {
  const text = await readFile(path, 'utf8');
  const parsed = parseClaudeLines(text);
  const loaded = loadTranscriptRecords(parsed.records, parsed.lineIndex);
  const { ir, rawRecords } = loadedTranscriptToIr(loaded, { sourcePath: path });

  if (rawRecords.length) {
    ir.extensions ??= {};
    ir.extensions.claude = {
      ...(ir.extensions.claude as Record<string, unknown> | undefined),
      recordsRaw: rawRecords,
    };
  }

  const dir = dirname(path);
  // sidechains live at <projectDir>/<sessionId>/subagents/agent-*.jsonl;
  // pass the leader transcript so each sidechain's spawn point (召唤位置)
  // resolves into parentMessageId
  const sid = ir.originSessionId;
  if (sid) {
    const subagentsDir = join(dir, sid, 'subagents');
    const sidechains = await loadSidechains(subagentsDir, loaded);
    if (sidechains.length) ir.sidechains = sidechains;
  }
  return ir;
}

/**
 * Scan `<sessionId>/subagents/**` for `agent-<id>.jsonl` (+ `.meta.json`
 * sidecars), recursing into workflow subdirs (§11.1). In-process teammate
 * fragments (agentId `a<name>-<hex>`, one per turn) are aggregated by name
 * prefix into a single teammate sidechain so the transcript travels whole.
 */
export async function loadSidechains(subagentsDir: string, leader?: LoadedTranscript): Promise<MigratedSidechain[]> {
  let files: string[];
  try {
    files = await listFilesRecursive(subagentsDir);
  } catch {
    return [];
  }
  const jsonls = files.filter((f) => basename(f).startsWith('agent-') && f.endsWith('.jsonl'));
  const parsed: Array<{ agentId: string; path: string; sc: MigratedSidechain | null; prefix: string | null; meta?: AgentMetaSidecar }> = [];
  for (const file of jsonls) {
    const agentId = basename(file).slice('agent-'.length, -'.jsonl'.length);
    if (!agentId) continue;
    const sidechain = await parseSidechainFile(file, agentId);
    if (sidechain) {
      parsed.push({ agentId, path: file, sc: sidechain.sc, prefix: teammatePrefix(agentId), meta: sidechain.meta });
      if (sidechain.meta) {
        sidechain.sc.meta = { claude: { agentMeta: sidechain.meta } };
      }
    }
  }

  // ---- spawn-point resolution (召唤位置) ----
  // Two channels, both resolved against the leader transcript when available:
  //  1. plain subagent: sidecar toolUseId names the exact Agent tool_use block
  //     in the leader chain → the assistant record carrying it;
  //  2. in-process teammate: sidecar toolUseId is EMPTY; the anchor is the
  //     leader's spawn tool_result (toolUseResult.status === 'teammate_spawned',
  //     `name`/`agent_id` match the teammate name) — anchored on the assistant
  //     that emitted the spawning Agent call.
  if (leader) resolveSpawnAnchors(parsed, leader);

  // aggregate in-process teammate fragments: agentId `a<name>-<hex16+>` —
  // every teammate turn gets a fresh random agentId (docs/agents/claude.md §11.1)
  const byPrefix = new Map<string, Array<{ agentId: string; path: string; sc: MigratedSidechain }>>();
  const out: MigratedSidechain[] = [];
  for (const item of parsed) {
    if (item.prefix && item.sc?.kind === 'teammate') {
      const list = byPrefix.get(item.prefix) ?? [];
      list.push({ agentId: item.agentId, path: item.path, sc: item.sc });
      byPrefix.set(item.prefix, list);
      continue;
    }
    if (item.sc) out.push(item.sc);
  }
  for (const [prefix, group] of byPrefix) {
    if (group.length === 1) {
      out.push(group[0].sc);
      continue;
    }
    // merge fragments in timestamp order into one teammate sidechain
    const merged: MigratedSidechain = {
      agentId: prefix,
      kind: 'teammate',
      messages: [],
      ...(group[0].sc.agentType ? { agentType: group[0].sc.agentType } : {}),
    };
    for (const g of group) {
      merged.messages.push(...g.sc.messages);
      if (g.sc.meta) merged.meta = g.sc.meta;
    }
    out.push(merged);
  }
  return out;
}

/** `aD2-queue-head-fix-a221c8a287cf36cb` → prefix `D2-queue-head-fix`; plain hex → null. */
function teammatePrefix(agentId: string): string | null {
  const m = agentId.match(/^a(.+?)-[0-9a-f]{16,17}$/);
  return m ? m[1] : null;
}

/**
 * Fill each sidechain's `parentMessageId` with the leader-chain uuid that
 * SPAWNED it (召唤位置). Channel 1: sidecar `toolUseId` → the assistant record
 * whose message.content contains that tool_use block id. Channel 2 (teammate,
 * sidecar toolUseId empty): the leader user row whose toolUseResult has
 * `status:'teammate_spawned'` and `name`/`agent_id` matching the teammate
 * name → the assistant that emitted the spawning tool_use (its source
 * tool_use block carries `input.name === teammateName`).
 */
function resolveSpawnAnchors(
  parsed: Array<{ agentId: string; sc: MigratedSidechain | null; meta?: AgentMetaSidecar; prefix: string | null }>,
  leader: LoadedTranscript,
): void {
  // Anchor against the UNPRUNED raw rows: the spawn tool_result may predate the
  // last compact boundary and be pruned from the active map (preserved relink),
  // but its leader uuid is still the authoritative spawn anchor.
  const recs = leader.rawRecords;
  const toolUseOwner = new Map<string, string>(); // tool_use_id → assistant uuid
  for (const r of recs) {
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
    for (const b of r.message!.content as Array<Record<string, unknown>> ?? []) {
      if (b && typeof b === 'object' && (b as { type?: string }).type === 'tool_use' && typeof (b as { id?: string }).id === 'string') {
        toolUseOwner.set((b as { id: string }).id, r.uuid!);
      }
    }
  }
  // teammate spawn index: name → assistant uuid carrying the spawn tool_use
  const teammateSpawnOwner = new Map<string, string>();
  for (const rec of recs) {
    if (rec.type !== 'user') continue;
    const tur = rec.toolUseResult as Record<string, unknown> | undefined;
    if (!tur || typeof tur !== 'object' || (tur as { status?: string }).status !== 'teammate_spawned') continue;
    const name = typeof (tur as { name?: unknown }).name === 'string' ? (tur as { name: string }).name : null;
    const tr = Array.isArray(rec.message?.content)
      ? (rec.message!.content as Array<{ type?: string; tool_use_id?: string }>).find((b) => b?.type === 'tool_result')
      : null;
    if (name && tr?.tool_use_id) {
      const owner = toolUseOwner.get(tr.tool_use_id!);
      if (owner) teammateSpawnOwner.set(name, owner);
    }
  }

  for (const item of parsed) {
    if (!item.sc) continue;
    // channel 1: sidecar toolUseId (plain subagents)
    const tid = item.meta?.toolUseId;
    if (typeof tid === 'string' && tid) {
      const owner = toolUseOwner.get(tid);
      if (owner) {
        item.sc.parentMessageId = owner;
        continue;
      }
    }
    if (item.sc.kind !== 'teammate') continue;
    // channel 2: teammate — sidecar toolUseId is EMPTY; the sidecar agentType
    // doubles as the teammate name and the spawn tool_result carries that name
    const displayName = teammateDisplayName(item);
    const anchor = teammateSpawnOwner.get(displayName);
    if (anchor) {
      item.sc.parentMessageId = anchor;
      continue;
    }
    // last resort: first teammate spawn whose name appears in the sidechain id
    const stem = item.prefix ?? item.sc.agentId;
    for (const [n, owner] of teammateSpawnOwner) {
      if (stem.includes(n)) {
        item.sc.parentMessageId = owner;
        break;
      }
    }
  }
}

/** the human teammate name behind a sidechain: prefix for fragments, sidecar agentType otherwise. */
function teammateDisplayName(item: { agentId: string; prefix: string | null; meta?: AgentMetaSidecar }): string {
  return item.prefix ?? item.meta?.agentType ?? item.agentId;
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFilesRecursive(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Parse one sidechain file → MigratedSidechain (+ optional sidecar meta). */
export async function parseSidechainFile(
  path: string,
  agentId: string,
): Promise<{ sc: MigratedSidechain; meta?: AgentMetaSidecar } | null> {
  const text = await readFile(path, 'utf8');
  const parsed = parseClaudeLines(text);
  const loaded = loadTranscriptRecords(parsed.records, parsed.lineIndex);
  const { messages: messageMap } = loaded;

  const agentRecords = [...messageMap.values()].filter(
    (m) => m.agentId === agentId && m.isSidechain === true,
  );
  if (!agentRecords.length) return null;
  // sidechain resume semantics: filter agentId+isSidechain → latest leaf → chain
  const parentUuids = new Set(agentRecords.map((m) => m.parentUuid));
  const leaf = agentRecords
    .filter((m) => !parentUuids.has(m.uuid!) && m.type !== 'system')
    .sort(cmpTimestamp)
    .at(-1);
  if (!leaf) return null;
  let chain = buildConversationChain(messageMap, leaf);
  chain = chain.filter((m) => m.agentId === agentId);

  const { ir: sessionIr } = loadedTranscriptToIr(
    loadTranscriptRecords(parsed.records, parsed.lineIndex),
  );
  void sessionIr;
  const projection = projectChain(
    chain.map((rec, i) => ({ rec, line: i })),
    loaded.meta,
  );
  const kind: 'teammate' | 'subagent' = /^a.+?-[0-9a-f]{16,17}$/.test(agentId) ? 'teammate' : 'subagent';
  const sc: MigratedSidechain = {
    agentId,
    kind,
    messages: projection.messages,
  };
  const first = chain.find((m) => m.agentId === agentId);
  if (first) {
    if (typeof first.cwd === 'string' && first.cwd) sc.cwd = first.cwd;
  }
  if (projection.compaction.length) sc.compaction = projection.compaction;
  if (projection.sessionEvents.length) sc.sessionEvents = projection.sessionEvents;

  // sidecar: agentType 恢复路由的关键；worktreePath 不存在时由写端回退父 cwd
  let meta: AgentMetaSidecar | undefined;
  try {
    const metaPath = path.replace(/\.jsonl$/, '.meta.json');
    const metaText = await readFile(metaPath, 'utf8');
    meta = JSON.parse(metaText) as AgentMetaSidecar;
    if (meta && typeof meta === 'object' && typeof meta.agentType === 'string') {
      sc.agentType = meta.agentType;
    }
  } catch {
    // no sidecar → 写端按缺失降级 general-purpose（§11.1）
  }
  if (meta?.description !== undefined) {
    const m = (sc.meta ??= {});
    const claudeNs = (m.claude ??= {}) as Record<string, unknown>;
    claudeNs.agentDescription = meta.description;
  }
  return { sc, meta };
}

