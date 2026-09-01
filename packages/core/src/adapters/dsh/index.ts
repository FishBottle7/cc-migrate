/**
 * DSH adapter — reads/writes `~/.dsh/sessions/.../session.jsonl.zstd`.
 *
 * The model-visible conversation is the *surface fold* of the event log:
 * only events carrying `surfaceOp:'append'` and of the three surface types
 * (`user/message`, `assistant/message`, `tool/result`) produce messages. See
 * design doc §2.1 and `docs/session-formats-audit.md #1`.
 *
 * This adapter does NOT depend on `@deepseek-ai/dsh` internals — it re-derives
 * enough of the format to read/write resumable sessions using only `node:zlib`.
 *
 * IR protocol status (docs/ir-protocol.md「dsh 待适配清单」— all landed;
 * 第二轮盘点 2026-08-29 见 docs/session-formats-audit.md §1「深度盘点 #2」):
 *  1. read: `tool/call` + `tool/result` events → typed `toolCalls` records
 *     (status derived from result presence/isError; raw arguments preserved).
 *  2. write: `ir.toolCalls` → re-emitted `tool/call` events (a running record
 *     is a lone call event — native shape for interrupted calls).
 *  3. per-message native fields ride MigratedMessage.meta.dsh (IR gap #2); the
 *     session header rides session-level MigratedSession.meta.dsh (v3.1) —
 *     extensions no longer carries DSH state. headerRaw is CONSUMED by write()
 *     (delegationDepth/agentPreset/origin/parentSession/seedLength survive).
 *  4. assistant/message `usage`/`interrupted` and tool/result event-level
 *     `error`/`meta` round-trip via meta.dsh (round 2).
 *  5. subagent trees nest (MigratedSidechain.sidechains) with full child
 *     buckets; write-back relinks parents and never clobbers an existing log.
 *  6. listSessions titles via session_projcache.json → last `session/title`
 *     log-scan fallback; archive state via workspace.json; `_no-cwd` layout.
 */

/**
 * Native per-message DSH payload stored under MigratedMessage.meta.dsh
 * (IR gap #2 pattern, as zcode does with meta.zcode). `rawContent` carries
 * the ORIGINAL DSH content array only when the IR block projection is lossy
 * (DSH ImageBlock refs, non-text tool-result interiors) so write-back can
 * restore it byte-faithfully; ids/sources/turn/step are always restored
 * verbatim when present (they were previously regenerated with random ids
 * and a hardcoded clientTimeZone).
 */
interface DshMessageNative {
  id?: string;
  source?: unknown;
  turn?: number;
  step?: number;
  rawContent?: unknown[];
  /** Original surfaceOp for replace-surface events (compaction checkpoints). */
  surfaceOp?: unknown;
  /** Original sourceEventSeqs provenance for replace-surface events. */
  sourceEventSeqs?: number[];
  /** True when this message was shadowed by a later positional replace
   * (compaction): it stays in the DSH log but the model never sees it again.
   * Targets decide how to express that (OpenCode: compaction boundary pair). */
  shadowed?: boolean;
  /** assistant/message event-level `usage` (token accounting travels with the
   * message; SessionEventMap documents no separate usage record). */
  usage?: unknown;
  /** assistant/message event-level `interrupted: true` — a turn cancelled
   * mid-stream finalizes its delivered text/reasoning prefix as this event. */
  interrupted?: true;
  /** tool/result event-level `error` identity ({name, code}). */
  resultError?: unknown;
  /** tool/result event-level tool-private `meta` payload (e.g. dsh-tool-fs
   * result-time contextual diff) — opaque to the core, restored verbatim. */
  resultMeta?: unknown;
}

function withDshNative(msg: MigratedMessage, native: DshMessageNative): MigratedMessage {
  const prev = (msg.meta as { dsh?: DshMessageNative } | undefined)?.dsh ?? {};
  return { ...msg, meta: { ...(msg.meta ?? {}), dsh: { ...prev, ...native } } };
}

/** True when the raw DSH content array contains ImageBlock refs anywhere
 * (top level or inside tool-result interiors) — i.e. the IR projection loses
 * attachment bytes/dimensions and rawContent must be stashed. */
function dshContentHasImages(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((b) => {
    if (typeof b !== 'object' || b === null) return false;
    const rec = b as Record<string, unknown>;
    if (rec.type === 'image') return true;
    if (rec.type === 'tool-result' || rec.type === 'tool_result') return dshContentHasImages(rec.content);
    return false;
  });
}

/** Project a DSH ImageBlock ({type:'image', attachment:{attachmentId, mediaType, name?}})
 * into an IR FileBlock. The bytes live in DSH's attachment service keyed by
 * attachmentId — the reference rides FileBlock.url (gap #4 contract: "url when
 * it references bytes stored elsewhere"). */
function dshImageToFileBlock(rec: Record<string, unknown>): ContentBlock | undefined {
  const att = rec.attachment;
  if (typeof att !== 'object' || att === null || Array.isArray(att)) return undefined;
  const a = att as Record<string, unknown>;
  const id = typeof a.attachmentId === 'string' ? a.attachmentId : undefined;
  if (!id) return undefined;
  const out: ContentBlock = { type: 'file', url: `dsh-attachment://${id}` };
  if (typeof a.name === 'string' && a.name) out.filename = a.name;
  if (typeof a.mediaType === 'string' && a.mediaType) out.mediaType = a.mediaType;
  return out;
}

import { promises as fs } from 'node:fs';
import { isAbsolute, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Adapter, WriteOptions, WriteResult } from '../../registry.js';
import type {
  ContentBlock,
  FileBlock,
  MigratedMessage,
  MigratedSession,
  MigratedSidechain,
  MigratedToolCall,
  MessageRole,
  SessionMeta,
} from '../../ir.js';
import { IR_VERSION, validateSession } from '../../ir.js';
import { blocksToNative, blocksToText, normalizeContent } from '../../content.js';
import {
  compressFrame,
  decompressSessionBuffer,
  defaultDshRoot,
  encodeSegment,
  projectKey,
  readFirstFrameLine,
} from './format.js';

interface DshHeader {
  id: string;
  cwd?: string;
  createdAt: number;
  title?: string;
}

interface DshEvent {
  seq: number;
  time?: number;
  type: string;
  surfaceOp?: string;
  /** Source-side forward-compat marker, preserved as IR provenance only (see
   * MigratedUnmappedEvent.ignorable) — current DSH never writes it and its
   * envelope allowlist would reject it, so the write side must not emit it. */
  ignorable?: true;
  data: {
    message?: unknown;
    role?: string;
    content?: unknown;
    title?: string;
  } & Record<string, unknown>;
}

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);
const PACKED_CHUNK_TYPES = new Set(['reasoning-chunks', 'text-chunks', 'tool-call-chunks']);

/**
 * The event types the DSH harness knows — mirrored 1:1 from
 * `@deepseek-ai/dsh-session`'s generated `known-event-types.ts`
 * (SESSION_FORMAT_VERSION 0, 51 entries). DSH's loader
 * (`assertEventsSupported`) refuses a WHOLE log when it contains any other
 * type — there is no per-row skip mechanism, and the envelope key allowlist
 * (`assertSessionEventEnvelope`: type/seq/time/data/surfaceOp/sourceEventSeqs)
 * rejects extra keys like a hypothetical `ignorable` marker. So replayed
 * `ir.unmappedEvents` rows whose type is not in this set must be DROPPED on
 * write: keeping them (marked or not) makes the artifact unloadable, while
 * the IR bucket still carries them for cross-tool transfers.
 */
export const DSH_KNOWN_EVENT_TYPES = new Set([
  'agent-preset/selected',
  'agent/inbox/spliced',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'assistant/chunk',
  'assistant/message',
  'command/done',
  'command/run',
  'compaction/end',
  'compaction/prune',
  'compaction/start',
  'compaction/summary',
  'feedback/record',
  'goal/change',
  'hook/invoked',
  'hook/result',
  'llm/retry',
  'llm/retry-started',
  'model/selection',
  'permission/preset',
  'plan/mode',
  'request/context',
  'request/header',
  'sandbox/mode',
  'schedule/change',
  'session-log-deepseek/delivery-accepted',
  'session/end-seed',
  'session/title',
  'session/title-llm-request',
  'step/end',
  'step/start',
  'subagent/descriptor',
  'subagent/model-selection-policy',
  'team/member',
  'team/message/delivered',
  'team/message/queued',
  'team/task',
  'todo/write',
  'tool-workflow/agent-end',
  'tool-workflow/agent-start',
  'tool-workflow/run-end',
  'tool-workflow/run-start',
  'tool/call',
  'tool/code-dispatch',
  'tool/code-dispatch-start',
  'tool/result',
  'turn/end',
  'turn/start',
  'user/message',
  'web/deepseek-search-llm-request',
]);

function stripEncrypted(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripEncrypted);
  const rec = obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'encrypted_content' || k === 'encrypted') {
      out[k] = '[encrypted omitted]';
      continue;
    }
    out[k] = stripEncrypted(v);
  }
  return out;
}

function hasEncrypted(obj: unknown): boolean {
  if (obj === null || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) return obj.some(hasEncrypted);
  const rec = obj as Record<string, unknown>;
  if ('encrypted_content' in rec || 'encrypted' in rec) return true;
  return Object.values(rec).some(hasEncrypted);
}

export class DshAdapter implements Adapter {
  readonly tool = 'dsh' as const;
  readonly irVersion = IR_VERSION;

  /** Parse one DSH session artifact file into IR. */
  async parse(sessionId: string, root?: string): Promise<MigratedSession> {
    const sessionsRoot = root ?? defaultDshRoot();
    if (!sessionsRoot) throw new Error('DSH: cannot resolve ~/.dsh/sessions (HOME/USERPROFILE unset)');
    const path = await this.findLog(sessionsRoot, sessionId);
    if (!path) throw new Error(`DSH: session "${sessionId}" not found under ${sessionsRoot}`);
    const buf = await fs.readFile(path);
    const plaintext = decompressSessionBuffer(buf);
    const lines = plaintext.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) throw new Error(`DSH: session "${sessionId}" is empty`);

    const header = JSON.parse(lines[0]) as DshHeader;
    const events = lines.slice(1).map((l) => JSON.parse(l) as DshEvent);
    // events are stored in seq order; sort defensively
    events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

    const ir = buildIrFromEvents(header, events);
    // preserver origin session id
    ir.originSessionId = header.id;
    ir.cwd = header.cwd;
    ir.createdAt = header.createdAt;

    // Aggregate subagent sidechains: scan all project dirs for children whose header.parentSession === sessionId
    try {
      const sidechains = await this.collectSubagentSidechains(sessionsRoot, sessionId);
      if (sidechains.length > 0) {
        ir.sidechains = [...(ir.sidechains ?? []), ...sidechains];
      }
    } catch {
      // scanning is best-effort; keep main IR on failure
    }
    return validateSession(ir);
  }

  /** Aggregate subagent sidechains: one cheap first-frame pass over every
   * project dir (incl. `_no-cwd`) indexes children by header.parentSession,
   * then the delegation tree is walked from `parentId`. Grandchildren nest
   * under their parent's sidechain; each child carries its full mini-session
   * buckets and its original header under meta.dsh.headerRaw. */
  private async collectSubagentSidechains(root: string, parentId: string): Promise<MigratedSidechain[]> {
    interface ChildRef {
      id: string;
      header: Record<string, unknown>;
      createdAt: number;
      log: string;
    }
    const byParent = new Map<string, ChildRef[]>();
    let projects: string[];
    try {
      projects = await fs.readdir(root);
    } catch {
      return [];
    }
    for (const proj of projects) {
      const isProjectDir = proj === '_no-cwd' || (proj.startsWith('--') && proj.endsWith('--'));
      if (!isProjectDir) continue;
      const projDir = join(root, proj);
      let sessionDirs: string[];
      try {
        sessionDirs = await fs.readdir(projDir);
      } catch {
        continue;
      }
      for (const sessDir of sessionDirs) {
        const log = join(projDir, sessDir, 'session.jsonl.zstd');
        let buf: Buffer;
        try {
          buf = await fs.readFile(log);
        } catch {
          continue;
        }
        // 廉价预筛：只解压首帧读 header 行；不是任何人的子代理就跳过，
        // 绝不为他人的会话付全量解压的代价（全量解压留给命中者）。
        let firstLine: string | null;
        try {
          firstLine = readFirstFrameLine(buf);
        } catch {
          continue;
        }
        if (!firstLine) continue;
        let header: Record<string, unknown>;
        try {
          header = JSON.parse(firstLine) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (typeof header.parentSession !== 'string' || !header.parentSession) continue;
        const id = typeof header.id === 'string' && header.id ? header.id : sessDir;
        const createdAt = typeof header.createdAt === 'number' && Number.isSafeInteger(header.createdAt) ? header.createdAt : 0;
        const list = byParent.get(header.parentSession) ?? [];
        list.push({ id, header, createdAt, log });
        byParent.set(header.parentSession, list);
      }
    }
    const visited = new Set<string>([parentId]);
    const build = async (pid: string): Promise<MigratedSidechain[]> => {
      const refs = (byParent.get(pid) ?? []).slice().sort((a, b) => a.createdAt - b.createdAt);
      const out: MigratedSidechain[] = [];
      for (const ref of refs) {
        if (visited.has(ref.id)) continue; // cycle-defensive; DSH headers are acyclic
        visited.add(ref.id);
        let sc: MigratedSidechain;
        try {
          sc = await this.decodeSidechain(ref);
        } catch {
          continue; // corrupt child log — best-effort, keep the rest of the tree
        }
        const kids = await build(ref.id);
        if (kids.length > 0) sc.sidechains = kids;
        out.push(sc);
      }
      return out;
    };
    return build(parentId);
  }

  /** Fully decode one child log into a mini-session sidechain: messages plus
   * every typed bucket (toolCalls/goals/planModes/todos/compaction/title/
   * unmappedEvents) and the original header under meta.dsh.headerRaw —
   * write-back restores the child's delegationDepth/agentPreset/seedLength. */
  private async decodeSidechain(ref: { id: string; header: Record<string, unknown>; createdAt: number; log: string }): Promise<MigratedSidechain> {
    const buf = await fs.readFile(ref.log);
    const plaintext = decompressSessionBuffer(buf);
    const lines = plaintext.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) throw new Error('empty child log');
    const events = lines.slice(1).map((l) => JSON.parse(l) as DshEvent);
    events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const childIr = buildIrFromEvents(ref.header as unknown as { cwd?: string; createdAt?: number; id?: string }, events);
    const sc: MigratedSidechain = {
      agentId: ref.id,
      kind: 'subagent',
      agentType: typeof ref.header.agentPreset === 'string' ? ref.header.agentPreset : undefined,
      messages: childIr.messages,
      ...(childIr.toolCalls?.length ? { toolCalls: childIr.toolCalls } : {}),
      ...(childIr.goals?.length ? { goals: childIr.goals } : {}),
      ...(childIr.planModes?.length ? { planModes: childIr.planModes } : {}),
      ...(childIr.todos?.length ? { todos: childIr.todos } : {}),
      ...(childIr.compaction?.length ? { compaction: childIr.compaction } : {}),
      ...(childIr.unmappedEvents?.length ? { unmappedEvents: childIr.unmappedEvents } : {}),
      ...(childIr.title ? { title: childIr.title } : {}),
      ...(typeof ref.header.cwd === 'string' && ref.header.cwd ? { cwd: ref.header.cwd } : {}),
      originSessionId: ref.id,
      createdAt: ref.createdAt,
      // buildIrFromEvents already stashed the child header (headerRaw)
      meta: childIr.meta,
    };
    return sc;
  }

  /** Write an IR session into DSH's native resumable storage (new session id). */
  async write(ir: MigratedSession, opts?: WriteOptions): Promise<WriteResult> {
    validateSession(ir);
    const sessionsRoot = opts?.root ?? defaultDshRoot();
    if (!sessionsRoot) throw new Error('DSH: cannot resolve ~/.dsh/sessions');
    const requestedCwd = opts?.targetCwd ?? ir.cwd ?? '';
    // DSH validates header.cwd with path.isAbsolute and refuses the whole
    // session otherwise (SessionPersistenceCorruptionError). A cwd that came
    // from a listing projection (encoded project-dir skeleton like
    // "D-codes-foo") or a hand-typed relative path must never reach the
    // header — degrade to a cwd-less session (DSH parks it under `_no-cwd`)
    // instead of writing an unloadable artifact.
    const cwd = requestedCwd && isAbsolute(requestedCwd) ? requestedCwd : '';
    const newId = opts?.sessionId ?? `session-${randomUUID()}`;
    // Keep original wall-clock for fidelity. Sorting as "newest" is handled
    // by the (migrated) title suffix + header id ordering; don't bump
    // createdAt — that would break irToEvents time ordering and make
    // DSH→DSH look like a fresh session rather than a faithful copy.
    const createdAt = ir.createdAt ?? Date.now();
    // Opt-in disambiguation for DSH→DSH self-migrations: suffix title so the
    // export filename is visibly distinct from the source. Off by default to
    // keep `write->parse` lossless (see dsh.test "v3 write->parse ...").
    const migratedTitle =
      opts?.disambiguateTitle && ir.originTool === 'dsh' && ir.title && !ir.title.endsWith('(migrated)')
        ? `${ir.title} (migrated)`
        : undefined;

    // header frame — start from the preserved headerRaw (v3.1 session meta) so
    // delegationDepth/agentPreset/origin/parentSession/seedLength/version ride
    // through the round-trip verbatim; identity fields are overridden for the
    // new lifecycle (new id, wall-clock, effective cwd). Foreign-origin IRs
    // (claude/codex/…) have no headerRaw and keep the legacy defaults.
    const headerRaw = (ir.meta as { dsh?: { headerRaw?: Record<string, unknown> } } | undefined)?.dsh?.headerRaw;
    const headerObj: Record<string, unknown> =
      headerRaw && typeof headerRaw === 'object' && !Array.isArray(headerRaw)
        ? { ...headerRaw }
        : { type: 'session', version: 0, delegationDepth: 0, agentPreset: 'standard' };
    headerObj.type = 'session';
    headerObj.id = newId;
    headerObj.createdAt = createdAt;
    if (headerObj.version === undefined) headerObj.version = 0;
    // retired fields make DSH refuse the header outright (fromHeaderLine throws)
    delete headerObj.sandboxMode;
    delete headerObj.approvalPolicy;
    if (cwd) headerObj.cwd = cwd;
    else delete headerObj.cwd;
    const header = JSON.stringify(headerObj);

    // event rows -> surface messages (suffix title when migrating so export filename distinguishes).
    // Also patch the lossless unmapped session/title event so the written artifact
    // and the subsequent export filename both carry the suffix (otherwise
    // irToEvents would see an existing session/title and skip synthesizing).
    let irForWrite: import('../../ir.js').MigratedSession = ir;
    if (migratedTitle) {
      const patchedUnmapped = (ir.unmappedEvents ?? []).map((ev) =>
        ev.type === 'session/title' || ev.type.startsWith('session/title')
          ? { ...ev, data: { ...(ev.data as Record<string, unknown>), title: migratedTitle } as unknown as typeof ev.data }
          : ev,
      );
      // If there was no unmapped title, keep synthesized path (irForWrite.title handles it)
      // otherwise use the patched array.
      irForWrite = { ...ir, title: migratedTitle, ...(patchedUnmapped.length ? { unmappedEvents: patchedUnmapped } : {}) };
    }
    const events = irToEvents(irForWrite, createdAt);
    const frame1 = buildSessionFrame(header);
    const frame2 = buildEventsFrame(events);

    const dir = join(sessionsRoot, dshProjectDirName(cwd), encodeSegment(newId));
    await fs.mkdir(dir, { recursive: true });
    // DSH uses concatenated frames: header (own frame) + event batches (own frames)
    const payload = Buffer.concat([frame1, frame2]);
    const finalPath = join(dir, 'session.jsonl.zstd');
    await fs.writeFile(finalPath, payload);

    const paths: string[] = [finalPath];

    // Strong refresh: register in workspace.json so the GUI shows the session
    // on next refresh without restarting the harness. Best-effort — never
    // fail the migration if the workspace file is unavailable (sandbox, etc.).
    // Hermetic tmp roots (explicit --dst-root) must NOT mutate the real home.
    const isDefaultRoot = opts?.root === undefined;
    if (isDefaultRoot && cwd) {
      try {
        const { ensureWorkspaceRegistration } = await import('./workspace.js');
        await ensureWorkspaceRegistration(sessionsRoot, cwd, newId, { isDefaultRoot });
        // Child sessions are registered to the same cwd as well.
      } catch {
        // best-effort
      }
    }

    // subagent sidechains -> independent child sessions, written depth-first.
    // Each child keeps its source id unless that destination is already taken
    // (a dsh->dsh copy must never clobber the source log); nested sidechains
    // (grandchildren) link to the WRITTEN parent id. Child headerRaw rides
    // through verbatim (delegationDepth/seedLength/agentPreset/…); identity
    // and linkage fields are overridden per written lifecycle.
    const subagents = (ir.sidechains ?? []).filter((s) => s.kind === 'subagent');
    const now = Date.now();
    let childCounter = 0;
    const writeSidechain = async (sc: MigratedSidechain, parentWrittenId: string, parentDepth: number): Promise<void> => {
      const scHeaderRaw = (sc.meta as { dsh?: { headerRaw?: Record<string, unknown> } } | undefined)?.dsh?.headerRaw;
      const candidate =
        typeof sc.agentId === 'string' &&
        sc.agentId.trim().length > 0 &&
        sc.agentId !== '.' &&
        sc.agentId !== '..' &&
        !sc.agentId.includes('/') &&
        !sc.agentId.includes('\\') &&
        !sc.agentId.includes(':')
          ? sc.agentId
          : `session-${randomUUID()}`;
      const childId = await this.claimFreeSessionId(sessionsRoot, cwd, candidate);
      const childCreatedAt = now + ++childCounter;
      const rawDepth = scHeaderRaw?.delegationDepth;
      const childHeaderObj: Record<string, unknown> =
        scHeaderRaw && typeof scHeaderRaw === 'object' && !Array.isArray(scHeaderRaw)
          ? { ...scHeaderRaw }
          : { version: 0, agentPreset: sc.agentType ?? 'standard' };
      childHeaderObj.type = 'session';
      childHeaderObj.id = childId;
      childHeaderObj.createdAt = childCreatedAt;
      if (childHeaderObj.version === undefined) childHeaderObj.version = 0;
      childHeaderObj.delegationDepth =
        typeof rawDepth === 'number' && Number.isSafeInteger(rawDepth) && rawDepth >= 0
          ? rawDepth
          : parentDepth + 1;
      // linkage is ours to own: the child always points at the WRITTEN parent
      childHeaderObj.parentSession = parentWrittenId;
      childHeaderObj.origin = 'subagent';
      if (childHeaderObj.agentPreset === undefined) childHeaderObj.agentPreset = sc.agentType ?? 'standard';
      delete childHeaderObj.sandboxMode;
      delete childHeaderObj.approvalPolicy;
      if (cwd) childHeaderObj.cwd = cwd;
      else delete childHeaderObj.cwd;
      const childHeader = JSON.stringify(childHeaderObj);
      // Full mini-session buckets — a child log round-trips like a main log.
      const childIr: MigratedSession = {
        schemaVersion: 2 as const,
        originTool: 'dsh',
        messages: sc.messages,
        ...(sc.toolCalls?.length ? { toolCalls: sc.toolCalls } : {}),
        ...(sc.goals?.length ? { goals: sc.goals } : {}),
        ...(sc.planModes?.length ? { planModes: sc.planModes } : {}),
        ...(sc.todos?.length ? { todos: sc.todos } : {}),
        ...(sc.compaction?.length ? { compaction: sc.compaction } : {}),
        ...(sc.unmappedEvents?.length ? { unmappedEvents: sc.unmappedEvents } : {}),
        ...(sc.title ? { title: sc.title } : {}),
      };
      const childEvents = irToEvents(childIr, childCreatedAt);
      const cFrame1 = buildSessionFrame(childHeader);
      const cFrame2 = buildEventsFrame(childEvents);
      const cDir = join(sessionsRoot, dshProjectDirName(cwd), encodeSegment(childId));
      await fs.mkdir(cDir, { recursive: true });
      const cPayload = Buffer.concat([cFrame1, cFrame2]);
      const cPath = join(cDir, 'session.jsonl.zstd');
      await fs.writeFile(cPath, cPayload);
      paths.push(cPath);
      if (isDefaultRoot && cwd) {
        try {
          const { ensureWorkspaceRegistration } = await import('./workspace.js');
          await ensureWorkspaceRegistration(sessionsRoot, cwd, childId, { isDefaultRoot });
        } catch {
          // best-effort
        }
      }
      for (const nested of sc.sidechains ?? []) {
        const depth = typeof childHeaderObj.delegationDepth === 'number' ? childHeaderObj.delegationDepth : parentDepth + 1;
        await writeSidechain(nested, childId, depth);
      }
    };
    for (const sc of subagents) {
      const baseDepth = typeof headerObj.delegationDepth === 'number' ? headerObj.delegationDepth : 0;
      await writeSidechain(sc, newId, baseDepth);
    }

    return { tool: 'dsh', sessionId: newId, paths };
  }

  /** Lightweight session listing from the DSH sessions root. Titles come from
   * DSH's own projection cache (`session_projcache.json`, one JSON read);
   * sessions it doesn't cover (e.g. migrated ones DSH never opened) fall back
   * to scanning the log for the LAST `session/title` event. Archive state
   * rides workspace.json's archivedSessionIds. `_no-cwd` sessions listed too. */
  async listSessions(root?: string): Promise<SessionMeta[]> {
    const sessionsRoot = root ?? defaultDshRoot();
    if (!sessionsRoot) return [];
    const [titles, archived] = await Promise.all([
      readProjcacheTitles(sessionsRoot),
      readArchivedSessionIds(sessionsRoot),
    ]);
    const metas: SessionMeta[] = [];
    let projects: string[];
    try {
      projects = await fs.readdir(sessionsRoot);
    } catch {
      return [];
    }
    for (const proj of projects) {
      const isProjectDir = proj === '_no-cwd' || (proj.startsWith('--') && proj.endsWith('--'));
      if (!isProjectDir) continue;
      const projDir = join(sessionsRoot, proj);
      let sessions: string[];
      try {
        sessions = await fs.readdir(projDir);
      } catch {
        continue;
      }
      for (const sid of sessions) {
        const sessDir = join(projDir, sid);
        const log = join(sessDir, 'session.jsonl.zstd');
        try {
          const st = await fs.stat(log);
          let title = titles.get(sid);
          // Real cwd comes from the header line (first zstd frame only).
          // The project dir name is a one-way encoding — deriving "cwd" from
          // it yields skeletons like "D-codes-foo" that DSH's header validator
          // (isAbsolute) rightly refuses if they ever reach a write.
          let headerCwd: string | undefined;
          const buf = await fs.readFile(log);
          if (title === undefined) title = scanTitleFromLog(buf);
          try {
            const headLine = readFirstFrameLine(buf);
            const parsed = headLine ? (JSON.parse(headLine) as { cwd?: unknown }) : undefined;
            if (parsed && typeof parsed.cwd === 'string' && parsed.cwd && isAbsolute(parsed.cwd)) {
              headerCwd = parsed.cwd;
            }
          } catch {
            // unreadable header → leave cwd unknown
          }
          metas.push({
            tool: 'dsh',
            sessionId: sid,
            ...(title !== undefined ? { title } : {}),
            ...(headerCwd !== undefined ? { cwd: headerCwd } : {}),
            createdAt: st.mtimeMs,
            sourcePath: log,
            ...(archived.has(sid) ? { archived: true } : {}),
          });
        } catch {
          // skip non-artifact entries
        }
      }
    }
    return metas;
  }

  /** Offline preview: fold messages to text (includes sidechains). */
  preview(session: MigratedSession): string {
    const main = session.messages.map((m) => `[${m.role}]\n${blocksToText(m.content)}`);
    if (!session.sidechains?.length) return main.join('\n\n');
    const branches = session.sidechains.map(
      (sc) => `[sidechain: ${sc.agentId} (${sc.kind})]\n${sc.messages.map((m) => blocksToText(m.content)).join('\n')}`,
    );
    return [...main, ...branches].join('\n\n');
  }

  /** Locate the log file for a session id by scanning project dirs. */
  private async findLog(root: string, id: string): Promise<string | null> {
    // Fast path: the canonical path from project dir key requires cwd, which we may not know.
    // Scan project dirs for a session dir whose encodeSegment == id.
    let projects: string[];
    try {
      projects = await fs.readdir(root);
    } catch {
      return null;
    }
    for (const proj of projects) {
      const projDir = join(root, proj);
      const candidate = join(projDir, encodeSegment(id));
      const log = join(candidate, 'session.jsonl.zstd');
      try {
        await fs.access(log);
        return log;
      } catch {
        // not here
      }
    }
    return null;
  }

  /** Return `preferred` when its artifact path is free; otherwise mint a fresh
   * id. Writing over an existing log would clobber a real session (dsh->dsh
   * copies share root+cwd, so a preserved source id collides by design). */
  private async claimFreeSessionId(root: string, cwd: string, preferred: string): Promise<string> {
    const logFor = (id: string): string => join(root, dshProjectDirName(cwd), encodeSegment(id), 'session.jsonl.zstd');
    try {
      await fs.access(logFor(preferred));
    } catch {
      return preferred;
    }
    for (let i = 0; i < 5; i++) {
      const fresh = `session-${randomUUID()}`;
      try {
        await fs.access(logFor(fresh));
      } catch {
        return fresh;
      }
    }
    throw new Error(`DSH: cannot find a free session dir for "${preferred}" under ${root}`);
  }
}

/* ------------------------------------------------------------------
 * Translators (kept pure for testability)
 * ------------------------------------------------------------------ */

/** Turn header + parsed events into a MigratedSession. agent->IR is zero-loss (except encrypted). */
export function buildIrFromEvents(header: { cwd?: string; createdAt?: number; id?: string }, events: DshEvent[]): MigratedSession {
  const messages: MigratedMessage[] = [];
  const goals: NonNullable<MigratedSession['goals']> = [];
  const planModes: NonNullable<MigratedSession['planModes']> = [];
  const todos: NonNullable<MigratedSession['todos']> = [];
  const toolCalls: NonNullable<MigratedSession['toolCalls']> = [];
  const toolCallByCallId = new Map<string, MigratedToolCall>();
  const unmappedEvents: NonNullable<MigratedSession['unmappedEvents']> = [];
  const compaction: NonNullable<MigratedSession['compaction']> = [];
  let title: string | undefined;

  // Surface fold with positional replace (mirrors DSH foldSurface): 'append'
  // adds a node; surfaceOp {op:'replace',start,end} splices the CURRENT node
  // list at those POSITIONS with the replacing event's seq. A compacted span
  // therefore stays in the log but leaves the model-visible surface — the
  // checkpoint (a user/message carrying the replace op) is the summary that
  // replaces it. Shadowed messages keep meta.dsh.shadowed; the checkpoint
  // becomes a message too (IR gap #3: the in-stream summary travels).
  const nodes: number[] = [];
  const compactionSummaries = new Map<number, Record<string, unknown>>(); // seq -> compaction/summary data
  const seqToMsg = new Map<number, MigratedMessage>();

  const stampAndPush = (ev: DshEvent, msg: MigratedMessage): void => {
    msg.timestamp = ev.time;
    msg.seq = ev.seq;
    messages.push(msg);
    seqToMsg.set(ev.seq, msg);
  };

  for (const ev of events) {
    // Packed chunk rows carry seq0/time0 (not seq/time); treat them as
    // lossless unmapped rather than tripping the surface fold. Their seq0
    // range is provenance for DSH's packChunks decoder.
    if (PACKED_CHUNK_TYPES.has(ev.type)) {
      const raw = ev as unknown as Record<string, unknown>;
      const cleanData = stripEncrypted(ev.data) as DshEvent['data'];
      const seq0 = typeof raw.seq0 === 'number' ? (raw.seq0 as number) : ev.seq;
      const time0 = typeof raw.time0 === 'number' ? (raw.time0 as number) : (ev.time ?? 0);
      unmappedEvents.push({
        seq: seq0,
        time: time0,
        type: ev.type,
        data: cleanData,
      } as NonNullable<MigratedSession['unmappedEvents']>[number]);
      continue;
    }
    if (hasEncrypted(ev.data)) {
      // encrypted_content is the only allowed drop — keep placeholder for audit
    }
    const cleanData = stripEncrypted(ev.data) as DshEvent['data'];
    // session/title is the DSH lossless title bucket (may appear with suffix variant)
    if (ev.type === 'session/title' || ev.type.startsWith('session/title')) {
      const t = (cleanData as Record<string, unknown>).title;
      if (typeof t === 'string' && t) title = t;
      // also keep the raw event in unmapped so a non-title consumer can see it,
      // but canonical title is promoted to ir.title
      unmappedEvents.push({
        seq: ev.seq,
        time: ev.time ?? 0,
        type: ev.type,
        data: cleanData,
        ...(ev.surfaceOp !== undefined ? { surfaceOp: ev.surfaceOp } : {}),
        ...(ev.surfaceOp !== undefined && (ev as { sourceEventSeqs?: number[] }).sourceEventSeqs ? { sourceEventSeqs: (ev as { sourceEventSeqs?: number[] }).sourceEventSeqs } : {}),
      } as NonNullable<MigratedSession['unmappedEvents']>[number]);
      continue;
    }
    if (ev.type === 'compaction/summary') {
      // log-only metering record; keep lossless AND index it so the shadowing
      // checkpoint below can pair with its shadowedTokenCount.
      compactionSummaries.set(ev.seq, cleanData as Record<string, unknown>);
      unmappedEvents.push({
        seq: ev.seq,
        time: ev.time ?? 0,
        type: ev.type,
        data: cleanData,
      } as NonNullable<MigratedSession['unmappedEvents']>[number]);
      continue;
    }
    if (ev.type === 'tool/call') {
      // toolCalls typed bucket (清单 #1): one record per invocation event.
      // `arguments` is the RAW model-produced JSON string — kept verbatim in
      // metadata.dsh for byte-faithful write-back; `input` carries the parsed
      // form for consumers. No result event (yet) → non-replayable 'running'.
      const d = cleanData as { turn?: number; step?: number; callId?: string; name?: string; arguments?: string };
      if (typeof d.callId === 'string' && d.callId) {
        const rec: MigratedToolCall = {
          callId: d.callId,
          tool: String(d.name ?? 'tool'),
          status: 'running',
          input: tryParseJson(d.arguments),
          time: { start: ev.time },
          metadata: {
            dsh: {
              ...(typeof d.turn === 'number' ? { turn: d.turn } : {}),
              ...(typeof d.step === 'number' ? { step: d.step } : {}),
              seq: ev.seq,
              ...(typeof d.arguments === 'string' ? { arguments: d.arguments } : {}),
              ...(ev.time !== undefined ? { time: ev.time } : {}),
            },
          },
        };
        toolCalls.push(rec);
        toolCallByCallId.set(rec.callId, rec);
      }
      continue;
    }
    if (SURFACE_TYPES.has(ev.type) && (ev.surfaceOp === 'append' || (typeof ev.surfaceOp === 'object' && ev.surfaceOp !== null && (ev.surfaceOp as Record<string, unknown>).op === 'replace'))) {
      const msg = eventToMessage(ev.type, cleanData);
      if (msg) {
        // Preserve wall-clock + original seq so irToEvents can restore the
        // exact stream order (turn/start must precede its surface messages;
        // equal-ms ties break by original seq, matching the source log).
        // provider/model are already lifted inside normalizeMessageLike.
        const native = (msg.meta as { dsh?: DshMessageNative } | undefined)?.dsh;
        if (ev.surfaceOp !== 'append') {
          // replace-surface event (compaction checkpoint): keep the op and its
          // provenance verbatim for byte-faithful write-back.
          const sourceSeqs = (ev as { sourceEventSeqs?: number[] }).sourceEventSeqs;
          const replacer = withDshNative(msg, { surfaceOp: ev.surfaceOp, ...(sourceSeqs ? { sourceEventSeqs: sourceSeqs } : {}) });
          stampAndPush(ev, replacer);
          // Surface fold: op.start/op.end are SURFACE NODE SEQs (DSH
          // replacementRange does nodes.indexOf(op.start)); the splice removes
          // every current node between them plus both endpoints. An invalid
          // reference never occurs in a log DSH itself would load — degrade to
          // append rather than fail the migration.
          const op = ev.surfaceOp as { op: 'replace'; start: number; end: number };
          const startIdx = nodes.indexOf(op.start);
          const endIdx = nodes.indexOf(op.end);
          if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
            nodes.push(ev.seq);
          } else {
            const shadowedSeqs = nodes.slice(startIdx, endIdx + 1);
            nodes.splice(startIdx, endIdx - startIdx + 1, ev.seq);
            for (const s of shadowedSeqs) {
              const shadowedMsg = seqToMsg.get(s);
              if (shadowedMsg) {
                const prev = (shadowedMsg.meta as { dsh?: DshMessageNative } | undefined)?.dsh ?? {};
                shadowedMsg.meta = { ...(shadowedMsg.meta ?? {}), dsh: { ...prev, shadowed: true } };
              }
            }
          }
          // IR gap #3 compaction bucket: summary text + anchor + token count
          const summaryText = replacer.content
            .filter((b) => b.type === 'text')
            .map((b) => (b as { text: string }).text)
            .join('\n');
          const tokensBefore = sourceSeqs
            ?.map((s) => compactionSummaries.get(s))
            .map((d) => (d ? d.shadowedTokenCount : undefined))
            .find((v): v is number => typeof v === 'number');
          compaction.push({
            summary: summaryText,
            anchorIndex: messages.length - 1,
            ...(tokensBefore !== undefined ? { tokensBefore } : {}),
          });
        } else {
          stampAndPush(ev, msg);
          nodes.push(ev.seq);
          if (ev.type === 'tool/result') backfillToolCall(toolCallByCallId, cleanData, ev.time);
        }
      }
      continue;
    }
    if (ev.type === 'goal/change') {
      goals.push({ seq: ev.seq, time: ev.time ?? 0, data: cleanData as unknown as Record<string, unknown> });
      continue;
    }
    if (ev.type === 'plan/mode') {
      planModes.push({ seq: ev.seq, time: ev.time ?? 0, data: cleanData });
      continue;
    }
    if (ev.type === 'todo/write') {
      todos.push({ seq: ev.seq, time: ev.time ?? 0, data: cleanData });
      continue;
    }
    // catch-all lossless bucket (except encrypted)
    unmappedEvents.push({
      seq: ev.seq,
      time: ev.time ?? 0,
      type: ev.type,
      data: cleanData,
      ...(ev.surfaceOp !== undefined ? { surfaceOp: ev.surfaceOp } : {}),
      ...(ev.surfaceOp !== undefined && (ev as { sourceEventSeqs?: number[] }).sourceEventSeqs ? { sourceEventSeqs: (ev as { sourceEventSeqs?: number[] }).sourceEventSeqs } : {}),
      ...(ev.ignorable === true ? { ignorable: true } : {}),
    } as NonNullable<MigratedSession['unmappedEvents']>[number]);
  }

  const ir: MigratedSession = { schemaVersion: 2 as const, originTool: 'dsh', messages };
  if (title) ir.title = title;
  if (goals.length) ir.goals = goals;
  if (planModes.length) ir.planModes = planModes;
  if (todos.length) ir.todos = todos;
  if (toolCalls.length) ir.toolCalls = toolCalls;
  if (compaction.length) ir.compaction = compaction;
  if (unmappedEvents.length) ir.unmappedEvents = unmappedEvents;
  // Session header rides the SESSION-LEVEL meta namespace (v3.1: eliminates
  // the last extensions bypass; write-back prefers meta.dsh.headerRaw and
  // still honours the legacy extensions key from pre-v3.1 exported IRs).
  ir.meta = { dsh: { headerRaw: { ...header } } };
  return ir;
}

/** toolCalls 清单 #1（result 回填）：pair the result event with its bucket
 * record by callId — status flips to completed/error, output/error text is
 * extracted from the tool-result interior, time.end and DSH-native extras
 * (error identity, tool-private result meta) ride metadata.dsh. */
function backfillToolCall(
  map: Map<string, MigratedToolCall>,
  data: unknown,
  time: number | undefined,
): void {
  const d = data as {
    message?: { source?: { callId?: unknown }; content?: unknown[] };
    error?: { name?: string; code?: string };
    meta?: unknown;
  } | undefined;
  const callId = d?.message?.source?.callId;
  const rec = typeof callId === 'string' ? map.get(callId) : undefined;
  if (!rec) return;
  const block = (d?.message?.content ?? []).find(
    (b) => typeof b === 'object' && b !== null && ((b as Record<string, unknown>).type === 'tool-result' || (b as Record<string, unknown>).type === 'tool_result'),
  ) as Record<string, unknown> | undefined;
  const isError = Boolean(block?.isError) || d?.error !== undefined;
  const text = Array.isArray(block?.content)
    ? (block!.content as unknown[])
        .map((p) => (typeof p === 'object' && p !== null && (p as Record<string, unknown>).type === 'text' ? String((p as Record<string, unknown>).text ?? '') : JSON.stringify(p)))
        .join('')
    : typeof block?.content === 'string' ? block.content : '';
  rec.status = isError ? 'error' : 'completed';
  if (isError) rec.error = text;
  else rec.output = text;
  if (rec.time && time !== undefined) rec.time.end = time;
  rec.metadata = {
    ...(rec.metadata ?? {}),
    dsh: {
      ...(rec.metadata?.dsh ?? {}),
      ...(d?.error ? { errorIdentity: d.error } : {}),
      ...(d?.meta !== undefined ? { resultMeta: d.meta } : {}),
    },
  };
}

function eventToMessage(type: string, data: DshEvent['data']): MigratedMessage | null {
  switch (type) {
    case 'user/message': {
      // DSH user/message shape: data IS the message {id, role:"user", source:{kind,...}, content:[]}
      // Tool-bridged form also has source:{kind:"tool"} but still data-level.
      const maybe = data as unknown as Record<string, unknown>;
      const content = (maybe.content as unknown[]) ?? [];
      const source = maybe.source as Record<string, unknown> | undefined;
      const isToolBridged = source?.kind === 'tool' || (Array.isArray(content) && content.some((b) => typeof b === 'object' && b !== null && ((b as Record<string, unknown>).type === 'tool-result' || (b as Record<string, unknown>).type === 'tool_result')));
      const msg = normalizeMessageLike(data);
      if (!msg) return null;
      // Native fields for lossless write-back (gap #2): the exact id and the
      // FULL source object (kind/plugin/rpcId/clientTimeZone/...) — previously
      // these were regenerated with random ids and a hardcoded timezone.
      const native: DshMessageNative = { source };
      if (typeof maybe.id === 'string') native.id = maybe.id;
      if (dshContentHasImages(content)) native.rawContent = content;
      // Harness-injected content rides ordinary user/message events; the
      // source kind is what separates human turns from injections. Verified
      // against the dsh source's inject producers (packages/skill/tool-skill,
      // context/agent-instructions, goal/goal-round-driver,
      // subagent/continuation, compaction/checkpoint):
      //   'plugin' — system-prompt snapshots / schedule / plan-mode /
      //     user-approval / repeat-tool-reminder / tool-jobs / …
      //   'skill-catalog' — the <available_skills> <system-reminder>
      //   'skill-invocation' — a loaded <skill_content> block
      //   'agent-instructions' — AGENTS.md injections
      //   'goal' — goal continuation rounds
      //   'subagent-report' / 'subagent-settled' / 'coordinator' — child
      //     lifecycle relay / multi-agent notices
      // All of those are SYNTHETIC. COMPACTION CHECKPOINTS (plugin ===
      // 'compact', @deepseek-ai/dsh-compaction/checkpoint) are CONVERSATION
      // CONTENT — the in-stream summary travels as a message (IR gap #3) and
      // must survive migration, so they are NOT synthetic. Unknown kinds and
      // missing sources stay non-synthetic: never drop what cannot be
      // classified (new harness kinds keep appearing; human turns are always
      // stamped kind:'user').
      const sourceKind = typeof source?.kind === 'string' ? source.kind : undefined;
      const isCompactionCheckpoint = sourceKind === 'plugin' && source?.plugin === 'compact';
      const synthetic = sourceKind !== undefined && sourceKind !== 'user' && !isCompactionCheckpoint;
      if (isToolBridged) return withDshNative({ ...msg, role: 'tool' as const }, native);
      if (synthetic) return withDshNative({ ...msg, synthetic: true }, native);
      return withDshNative(msg, native);
    }
    case 'assistant/message': {
      // DSH assistant/message shape: {turn,step,message:{id, role:"assistant", source:{kind:"model",...}, content:[]}}
      const d = data as unknown as Record<string, unknown>;
      const m = d.message as { id?: unknown; content?: unknown; source?: unknown } | undefined;
      if (!m || !Array.isArray(m.content) || m.content.length === 0) return null;
      const msg = normalizeMessageLike(m);
      if (!msg) return null;
      const native: DshMessageNative = { source: m.source };
      if (typeof m.id === 'string') native.id = m.id;
      if (typeof d.turn === 'number') native.turn = d.turn;
      if (typeof d.step === 'number') native.step = d.step;
      // Event-level usage rides the message (SessionEventMap: no separate
      // usage record) and interrupted marks a cancelled mid-stream prefix.
      if (d.usage !== undefined && typeof d.usage === 'object' && d.usage !== null) native.usage = d.usage;
      if (d.interrupted === true) native.interrupted = true;
      if (dshContentHasImages(m.content)) native.rawContent = m.content;
      // Canonical DSH ReasoningBlock carries no signature (llm/src/types.ts),
      // so IR thinking.signature stays undefined for dsh-origin sessions —
      // nothing to preserve here (gap #1 is zcode/claude-specific).
      return withDshNative(msg, native);
    }
    case 'tool/result': {
      // Canonical DSH tool/result: {turn,step,message:{role,content,source:{kind:tool}}}
      // Preserve as role:'tool' so round-trip knows to emit tool/result.
      const d = data as Record<string, unknown>;
      const m = d.message as { id?: unknown; content?: unknown; source?: unknown } | undefined;
      if (!m || !Array.isArray(m.content)) return null;
      const msg = normalizeMessageLike(m);
      if (!msg) return null;
      // normalize to tool role
      const native: DshMessageNative = { source: m.source };
      if (typeof m.id === 'string') native.id = m.id;
      if (typeof d.turn === 'number') native.turn = d.turn;
      if (typeof d.step === 'number') native.step = d.step;
      // Event-level error identity + tool-private meta live on the EVENT, not
      // the message — without stashing them here, write-back loses both.
      if (d.error !== undefined && typeof d.error === 'object' && d.error !== null) native.resultError = d.error;
      if (d.meta !== undefined) native.resultMeta = d.meta;
      if (dshContentHasImages(m.content)) native.rawContent = m.content;
      return withDshNative({ ...msg, role: 'tool' as const }, native);
    }
    default:
      return null;
  }
}

function normalizeMessageLike(v: unknown): MigratedMessage | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const role = (o.role as MessageRole) ?? 'assistant';
  const rawContent = Array.isArray(o.content) ? o.content : [];
  // DSH stores blocks as {type:"text"|"reasoning"|"tool-call"|"tool-result", ...}.
  // Normalize into the generic ContentBlock vocabulary consumed by IR.
  const normalizedForIR: unknown[] = rawContent.map((b: unknown) => {
    if (typeof b !== 'object' || b === null) return b;
    const rec = b as Record<string, unknown>;
    // DSH ImageBlock ({type:'image', attachment:ImageAttachmentRef}) projects to
    // an IR FileBlock; the attachment-store reference rides FileBlock.url and
    // the untouched original rides meta.dsh.rawContent for lossless write-back.
    if (rec.type === 'image') {
      const file = dshImageToFileBlock(rec);
      if (file) return file;
    }
    if ((rec.type === 'tool-result' || rec.type === 'tool_result') && Array.isArray(rec.content)) {
      // Pass the interior through (with images pre-projected) so the shared
      // normalizer builds text + FileBlock attachments — previously non-text
      // tool-result content was flattened away by text-joining (gap #4).
      const inner = (rec.content as unknown[]).map((piece) => {
        if (typeof piece === 'object' && piece !== null && !Array.isArray(piece)) {
          const p = piece as Record<string, unknown>;
          if (p.type === 'image') {
            const file = dshImageToFileBlock(p);
            if (file) return file;
          }
        }
        return piece;
      });
      return { type: 'tool_result', toolUseId: String(rec.toolCallId ?? rec.toolUseId ?? rec.id ?? ''), content: inner, isError: Boolean(rec.isError) };
    }
    if (rec.type === 'reasoning' && typeof rec.text === 'string') {
      return { type: 'thinking', thinking: rec.text };
    }
    if (rec.type === 'tool-call' && typeof rec.id === 'string') {
      return { type: 'tool_use', id: rec.id, name: String(rec.name ?? 'tool'), input: tryParseJson(rec.arguments) ?? rec.arguments };
    }
    return b;
  });
  const blocks: ContentBlock[] = normalizeContent(normalizedForIR);
  // Preserve LLM identity for faithful write-back (provider/model used to build source:{kind:"model"}).
  const source = o.source as Record<string, unknown> | undefined;
  const provider = typeof source?.provider === 'string' ? source.provider : undefined;
  const model = typeof source?.model === 'string' ? source.model : undefined;
  const msg: MigratedMessage = { role, content: blocks };
  if (blocks.length === 0) return null;
  if (provider || model) {
    msg.provider = provider;
    msg.model = model;
  }
  return msg;
}

function tryParseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function isSafeSeq(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/**
 * Build IR back into DSH event rows (with seq + surfaceOp).
 *
 * v3: merges messages + goals + planModes + todos + toolCalls + unmappedEvents
 * into a single time-ordered stream, then reassigns contiguous seq 0..N-1. This
 * is the only path that makes `agent->IR->agent` lossless for DSH (see
 * docs/plans/ir-v3-lossless-100.md §3). Domain buckets are merged by time so
 * the original wall-clock ordering survives. `session/title` is synthesized
 * from `ir.title` when no matching unmapped event already carries it.
 */
export function irToEvents(ir: MigratedSession, baseTime: number): DshEvent[] {
  type Raw = { time: number; type: string; data: DshEvent['data']; surfaceOp?: string; sourceEventSeqs?: number[]; _msg?: MigratedMessage; _seq?: number };
  const raw: Raw[] = [];
  // Foreign-origin IRs (claude/codex/...) carry no per-message seq; park them
  // after every real source seq so ties keep insertion order without stealing
  // earlier positions from genuine stream events.
  const FALLBACK_SEQ_BASE = 1e12;
  let fallbackIdx = 0;

  // Preserve wall-clock time faithfully — each bucket uses its own stored time
  // verbatim; only missing timestamps fall back to baseTime with a per-bucket
  // counter. This keeps cross-bucket ordering true to the original event stream
  // (goal@1000 before message@2000) and lets the final sort restore it.
  // Per-message native restoration (gap #2): when the IR carries meta.dsh the
  // original id/source/turn/step AND any lossy-projected raw content array are
  // restored verbatim; otherwise synthesized values keep legacy behavior.
  const nativeOf = (msg: MigratedMessage): DshMessageNative =>
    (msg.meta as { dsh?: DshMessageNative } | undefined)?.dsh ?? {};
  /** Restore the original surfaceOp ('append' or a replace object) plus its
   * sourceEventSeqs provenance — without this, compacted sessions would
   * round-trip as if nothing had been shadowed. */
  const surfaceOf = (msg: MigratedMessage): { surfaceOp: unknown; sourceEventSeqs?: number[] } => {
    const native = nativeOf(msg);
    return {
      surfaceOp: native.surfaceOp ?? 'append',
      ...(native.sourceEventSeqs ? { sourceEventSeqs: native.sourceEventSeqs } : {}),
    };
  };
  let msgFallback = baseTime;
  // callIds the toolCalls bucket will re-emit as tool/call rows (dsh-origin
  // sessions) — block-derived synthesis below must not duplicate them.
  const bucketCallIds = new Set((ir.toolCalls ?? []).map((r) => r.callId));
  // Every callId that will exist as a tool/call row: bucket re-emissions plus
  // every assistant tool_use block (block-derived synthesis below). A
  // tool/result referencing anything else can never pair — DSH renders it as
  // a ghost "Tool call <callId>" fallback card — so such results must not be
  // emitted.
  const plannedCallIds = new Set(bucketCallIds);
  for (const m of ir.messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use' && b.id) plannedCallIds.add(b.id);
    }
  }
  // Runtime guard against duplicate tool/call rows for one callId (the GUI
  // aborts on a second start Match for the same context key).
  const emittedCallIds = new Set<string>();
  for (const msg of ir.messages) {
    const t = msg.timestamp;
    const time = typeof t === 'number' && Number.isFinite(t) ? t : msgFallback++;
    const seq = typeof msg.seq === 'number' && Number.isSafeInteger(msg.seq) ? msg.seq : FALLBACK_SEQ_BASE + fallbackIdx++;
    const native = nativeOf(msg);
    // Anthropic-style harnesses (claude) carry tool results as USER messages
    // whose content is solely tool_result blocks; pi/codex/opencode/zcode use
    // role:'tool' rows. Both shapes must project as a tool/result event —
    // emitting them as human turns garbles the DSH view and leaves the paired
    // call card without a result.
    const isToolResultCarrier = msg.content.length > 0 && msg.content.every((b) => b.type === 'tool_result');
    if (msg.role === 'tool' || (msg.role === 'user' && isToolResultCarrier)) {
      // Rebuild DSH tool/result shape: {turn,step,message:{source,role,content}}
      // preserve the nested tool-result interior expected by DSH surface.
      const toolBlocks = msg.content.filter((b) => b.type === 'tool_result');
      // Resolve the pairing callId: native source first (byte-faithful
      // dsh→dsh), then the block's toolUseId. A result whose call has no
      // planned tool/call row (or no callId at all) can never pair and would
      // render as a ghost card — skip it; the content stays in the IR.
      const nativeSrc = native.source as { callId?: unknown } | undefined;
      const nativeCallId = typeof nativeSrc?.callId === 'string' && nativeSrc.callId ? nativeSrc.callId : undefined;
      const blockCallId = (toolBlocks[0] as { toolUseId?: string } | undefined)?.toolUseId;
      const callId = nativeCallId ?? (blockCallId || undefined);
      if (!callId || !plannedCallIds.has(callId)) continue;
      const toolData: Record<string, unknown> = {
        ...(native.turn !== undefined || native.step !== undefined
          ? { turn: native.turn ?? 1, step: native.step ?? 1 }
          : { turn: 1, step: 1 }),
        // Event-level error identity + tool-private meta were stashed on the
        // message native at read time — re-emit or DSH loses the diff card.
        ...(native.resultError !== undefined ? { error: native.resultError } : {}),
        ...(native.resultMeta !== undefined ? { meta: native.resultMeta } : {}),
        message: {
          ...(native.id ? { id: native.id } : { id: `msg_${randomUUID()}` }),
          role: 'user',
          ...(native.source !== undefined ? { source: native.source } : { source: { kind: 'tool', callId } }),
          ...(native.rawContent ? { content: native.rawContent } : {
            content: msg.content.map((b) => {
              if (b.type === 'tool_result') {
                const inner: unknown[] = [{ type: 'text', text: b.content }];
                for (const att of b.attachments ?? []) {
                  const nativeImage = dshImageFromBlock(att);
                  if (nativeImage) inner.push(nativeImage);
                  else inner.push({ type: 'text', text: `[file: ${att.filename ?? att.url ?? 'attachment'}]` });
                }
                return { type: 'tool-result', toolCallId: b.toolUseId, content: inner, isError: !!b.isError };
              }
              if (b.type === 'text') return { type: 'text', text: b.text };
              return { type: 'text', text: (b as { thinking?: string }).thinking ?? '' };
            }),
          }),
        },
      };
      raw.push({ time, type: 'tool/result', ...(surfaceOf(msg) as { surfaceOp: string; sourceEventSeqs?: number[] }), data: toolData as unknown as DshEvent['data'], _msg: msg, _seq: seq });
      continue;
    }
    if (msg.role === 'user' || msg.role === 'system' || msg.role === 'developer') {
      // DSH validates user/message data IS the message: must have {id, role:"user", source:{kind}, content:[]}
      // See assertMessageEventShape in dsh-session (≈ line 1252). Plain {role,content} fails with
      // "lacks an identified message".
      //
      // Foreign harness rows: system/developer roles and messages flagged
      // `synthetic` are harness injections (codex permissions/AGENTS.md/
      // collaboration-mode text, claude isMeta, ...). DSH has no developer
      // surface — projecting them as model output or human turns makes the
      // migrated session read as garbage; DSH's own convention for persisted
      // injections is a plugin-sourced user message instead.
      const injected = msg.role !== 'user' || msg.synthetic === true;
      const contentKind = (msg.meta as { codex?: { contentKind?: string } } | undefined)?.codex?.contentKind;
      const data = {
        ...(native.id ? { id: native.id } : { id: `msg_${randomUUID()}` }),
        role: 'user' as const,
        ...(native.source !== undefined
          ? { source: native.source }
          : injected
            ? { source: { kind: 'plugin', plugin: contentKind ?? 'external-harness' } }
            : { source: { kind: 'user', rpcId: randomUUID(), clientTimeZone: 'Asia/Shanghai' } }),
        content: native.rawContent ?? dshContentFromBlocks(msg.content),
      } as unknown as DshEvent['data'];
      raw.push({ time, type: 'user/message', ...(surfaceOf(msg) as { surfaceOp: string; sourceEventSeqs?: number[] }), data, _msg: msg, _seq: seq });
    } else {
      const content = native.rawContent ?? dshContentFromBlocks(msg.content);
      // Reasoning-only foreign assistant rows carry no durable content (the
      // encrypted reasoning text was dropped at read time) — an empty
      // assistant/message would just render as a dead step in the GUI.
      if (Array.isArray(content) && content.length === 0) continue;
      // DSH validates assistant/message data as {turn,step,message:{id, role:"assistant", source:{kind:"model",provider,model}, content:[]}}
      // source identity: per-message provider/model first (foreign harnesses
      // carry it on the message), then session-level, then legacy defaults.
      const provider = (msg.provider as string) ?? (ir.model?.provider as string) ?? 'abrdns';
      const model = (msg.model as string) ?? (ir.model?.id as string) ?? 'GLM-5.3-Flash';
      const nativeSource = native.source as Record<string, unknown> | undefined;
      const data = {
        ...(native.turn !== undefined || native.step !== undefined
          ? { turn: native.turn ?? 1, step: native.step ?? 1 }
          : { turn: 1, step: 1 }),
        // Token accounting + interrupted-prefix marker travel on the event.
        ...(native.usage !== undefined ? { usage: native.usage } : {}),
        ...(native.interrupted === true ? { interrupted: true } : {}),
        message: {
          ...(native.id ? { id: native.id } : { id: `msg_${randomUUID()}` }),
          role: 'assistant' as const,
          // per-message source first (exact provider/model/requestId), else
          // session-level, else legacy defaults
          source: nativeSource ?? { kind: 'model', provider, model },
          content,
        },
      } as unknown as DshEvent['data'];
      raw.push({ time, type: 'assistant/message', ...(surfaceOf(msg) as { surfaceOp: string; sourceEventSeqs?: number[] }), data, _msg: msg, _seq: seq });
      // Foreign harnesses (codex/claude/…) keep tool calls as tool_use blocks
      // inside the assistant content. Native DSH logs pair every tool-result
      // with a standalone tool/call event — without it the GUI renders ghost
      // "Tool call <callId>" fallback cards from the orphan tool/results. Emit
      // the missing half (deduped against the IR toolCalls bucket, which is
      // re-emitted further down for dsh-origin sessions).
      for (const b of msg.content) {
        if (b.type !== 'tool_use' || !b.id || bucketCallIds.has(b.id) || emittedCallIds.has(b.id)) continue;
        emittedCallIds.add(b.id);
        const args = b.input === undefined ? '' : typeof b.input === 'string' ? b.input : JSON.stringify(b.input);
        raw.push({
          time,
          type: 'tool/call',
          data: { turn: 1, step: 1, callId: b.id ?? `call_${randomUUID()}`, name: b.name ?? 'tool', arguments: args } as unknown as DshEvent['data'],
          _seq: seq,
        });
      }
    }
  }
  for (const g of ir.goals ?? []) {
    const time = typeof g.time === 'number' && Number.isFinite(g.time) ? g.time : baseTime;
    raw.push({ time, type: 'goal/change', data: g.data as unknown as DshEvent['data'], _seq: g.seq });
  }
  // toolCalls 清单 #2：re-emit one tool/call event per bucket record. A record
  // without a result (running/pending) is the ONLY representation — native DSH
  // logs carry no result event for interrupted calls; completed/error records
  // additionally pair with the tool/result events emitted from tool-role
  // messages above, matching the native trio (assistant block + tool/call +
  // tool/result). metadata.dsh restores the exact turn/step/seq and the RAW
  // model-produced arguments string.
  for (const tc of ir.toolCalls ?? []) {
    if (emittedCallIds.has(tc.callId)) continue;
    emittedCallIds.add(tc.callId);
    const dsh = (tc.metadata as { dsh?: { turn?: number; step?: number; seq?: number; time?: number; arguments?: string } } | undefined)?.dsh;
    const time = typeof dsh?.time === 'number' && Number.isFinite(dsh.time) ? dsh.time : baseTime;
    raw.push({
      time,
      type: 'tool/call',
      data: {
        turn: dsh?.turn ?? 1,
        step: dsh?.step ?? 1,
        callId: tc.callId,
        name: tc.tool,
        arguments: typeof dsh?.arguments === 'string' ? dsh.arguments : JSON.stringify(tc.input ?? {}),
      } as unknown as DshEvent['data'],
      _seq: isSafeSeq(dsh?.seq) ? dsh.seq : undefined,
    });
  }
  for (const p of ir.planModes ?? []) {
    const time = typeof p.time === 'number' && Number.isFinite(p.time) ? p.time : baseTime;
    raw.push({ time, type: 'plan/mode', data: p.data as unknown as DshEvent['data'], _seq: p.seq });
  }
  for (const td of ir.todos ?? []) {
    const time = typeof td.time === 'number' && Number.isFinite(td.time) ? td.time : baseTime;
    raw.push({ time, type: 'todo/write', data: td.data as unknown as DshEvent['data'], _seq: td.seq });
  }
  for (const ev of ir.unmappedEvents ?? []) {
    const time = typeof ev.time === 'number' && Number.isFinite(ev.time) ? ev.time : baseTime;
    // Packed chunk rows (seq0/time0) are stored with seq==seq0 and time==time0
    // in buildIrFromEvents (source had seq0/time0, seq was undefined — seq got
    // back-filled to seq0 in the catch-all). irToEvents must re-emit them as
    // storage rows {seq0,time0}, never as {seq,time} — the latter fails
    // decodeStorageRecord's exact-key check.
    if (PACKED_CHUNK_TYPES.has(ev.type)) {
      // Preserve seq0/time0 exactly; DSH seq contiguity is NOT enforced via
      // these rows — seq0 is validated as safe integer and the overall seq
      // accounting uses the existing events' seq coverage. Don't remap them
      // through the contiguous reassignment below.
      raw.push({
        time,
        // Use a negative sentinel so the contiguous reassignment skips them
        // (they keep their original seq0). The final map handles this.
        type: ev.type,
        data: ev.data as unknown as DshEvent['data'],
        _seq: ev.seq,
      } as unknown as Raw & { __packed: true; __seq0: number; __time0: number });
      // Stash seq0/time0 via side-channel on raw entry for the final map.
      // We piggy-back on the Raw object without polluting the type.
      (raw[raw.length - 1] as any).__packed = true;
      (raw[raw.length - 1] as any).__seq0 = ev.seq;
      (raw[raw.length - 1] as any).__time0 = time;
      continue;
    }
    // Foreign event types (codex event_msg rows like task_started/token_count,
    // or rows a newer DSH harness wrote) would make the DSH loader refuse the
    // WHOLE log — assertEventsSupported rejects any type outside
    // KNOWN_SESSION_EVENT_TYPES, and the envelope allowlist leaves no room for
    // a skip marker. Drop them here; the IR bucket keeps them for transfers to
    // harnesses that do understand the source's event vocabulary.
    if (!DSH_KNOWN_EVENT_TYPES.has(ev.type)) continue;
    raw.push({
      time,
      type: ev.type,
      data: ev.data as unknown as DshEvent['data'],
      ...(ev.surfaceOp !== undefined ? { surfaceOp: ev.surfaceOp } : {}),
      ...(ev.sourceEventSeqs ? { sourceEventSeqs: ev.sourceEventSeqs } : {}),
      _seq: ev.seq,
    });
  }

  // ir.title: if caller set a title and no session/title event already
  // carries it, synthesize one (earliest time so it sorts first among
  // title events). This keeps `ir.title -> session/title` lossless on
  // DSH->IR->DSH when the original store held title only as header meta.
  if (ir.title) {
    const hasTitleEvent = raw.some((r) => r.type === 'session/title' || r.type.startsWith('session/title'));
    if (!hasTitleEvent) {
      // place at baseTime so it precedes conversation; matches DSH's early
      // title emission. Use the smallest time among raw, or baseTime.
      const titleTime = raw.length ? Math.min(baseTime, ...raw.map((r) => r.time)) : baseTime;
      // if titleTime equals baseTime we still need it to be <= first raw time
      raw.push({ time: titleTime, type: 'session/title', data: { title: ir.title } as unknown as DshEvent['data'], _seq: -1 });
    }
  }

  // Preserve original stream ordering across buckets: sort by wall-clock,
  // ties broken by ORIGINAL source seq. Every bucket carries the seq it had
  // in the source log, so (time, seq) reproduces the exact event order —
  // this is what keeps turn/start ahead of its surface messages and step
  // context intact (the GUI conversation skeleton validates that order).
  raw.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    return (a._seq ?? 0) - (b._seq ?? 0);
  });

  // Separate packed storage rows (seq0/time0) from seq-assigned events.
  // Packed rows must keep exactly {type, seq0, time0, data} — the decoder
  // expands them into multiple sequential events (seq0 + k). The overall
  // decoded seq must be contiguous 0..N-1, so seq0 must align with the dense
  // assignment, not the sparse source seq0.
  const packedRaw = (raw as Array<Raw & { __packed?: boolean; __seq0?: number; __time0?: number }>).filter((r) => r.__packed);
  const normal = (raw as Array<Raw & { __packed?: boolean }>).filter((r) => !r.__packed);

  // Build packed rows sorted by (time0, original seq0). We keep their data
  // verbatim (turn/step/index/dt/texts|args) but recompute seq0 to produce a
  // contiguous decoded stream. Merge with normal events by (time, _seq) so
  // chunk payloads land exactly where they did in the source stream.
  const merged: Array<(Raw & { __packed?: boolean; __seq0?: number; __time0?: number }) | Raw> = [];
  packedRaw.sort((a, b) => ((a.__time0 ?? 0) - (b.__time0 ?? 0)) || ((a._seq ?? 0) - (b._seq ?? 0)));
  {
    let pi = 0;
    let ni = 0;
    const key = (t: number, s: number | undefined) => t * 4294967296 + (s ?? 0);
    while (ni < normal.length || pi < packedRaw.length) {
      const n = normal[ni];
      const p = packedRaw[pi];
      const nKey = n ? key(n.time, n._seq) : Infinity;
      const pKey = p ? key(p.__time0 ?? 0, p._seq) : Infinity;
      if (nKey <= pKey) {
        merged.push(normal[ni++]);
      } else {
        merged.push(packedRaw[pi++]);
      }
    }
  }

  // Reconstruct turn/step coordinates for surface events from the restored
  // stream: the GUI conversation skeleton groups assistant/message and
  // tool/result by their data.turn/data.step, which must match the
  // turn/start + step/start context they appear under (a mismatch or an
  // event before its turn/start aborts history load with "received an
  // update before its start Match").
  //
  // Foreign-origin IRs (claude/codex/opencode/zcode) carry no turn/step
  // lifecycle events, so synthesize the skeleton on the fly: `turn/start
  // {turn}` before the first event of each turn, `step/start {turn,step}`
  // before the first event of each (turn, step). Sources that already carry
  // native starts (dsh→dsh) mark their turns/steps as seen and get no
  // duplicates — a second start match on one context is itself a hard load
  // error ("received more than one start Match").
  let curTurn = 1;
  let curStep = 1;
  const startedTurns = new Set<number>();
  const startedSteps = new Set<string>();
  const withSkeleton: typeof merged = [];
  for (const entry of merged) {
    if ((entry as { __packed?: boolean }).__packed) {
      // packed chunk rows only exist in dsh→dsh logs (native steps already
      // started); pass through untouched.
      withSkeleton.push(entry);
      continue;
    }
    const r = entry as Raw;
    const d = r.data as Record<string, unknown> | undefined;
    if (r.type === 'turn/start') {
      if (typeof d?.turn === 'number') {
        curTurn = d.turn;
        curStep = 1;
        startedTurns.add(curTurn);
      }
      withSkeleton.push(entry);
      continue;
    }
    if (r.type === 'step/start') {
      if (typeof d?.turn === 'number') curTurn = d.turn;
      if (typeof d?.step === 'number') curStep = d.step;
      startedTurns.add(curTurn);
      startedSteps.add(`${curTurn}:${curStep}`);
      withSkeleton.push(entry);
      continue;
    }
    // Effective coordinates of this event: tool/call rows carry explicit
    // turn/step in data; assistant/message + tool/result take the running
    // cursor (stamped below).
    let evTurn: number | undefined;
    let evStep: number | undefined;
    if (r.type === 'tool/call') {
      if (typeof d?.turn === 'number') evTurn = d.turn;
      if (typeof d?.step === 'number') evStep = d.step;
    } else if (r.type === 'assistant/message' || r.type === 'tool/result') {
      evTurn = curTurn;
      evStep = curStep;
    }
    if (evTurn !== undefined && !startedTurns.has(evTurn)) {
      startedTurns.add(evTurn);
      withSkeleton.push({ time: r.time, type: 'turn/start', data: { turn: evTurn } } as unknown as Raw);
    }
    if (evTurn !== undefined && evStep !== undefined && !startedSteps.has(`${evTurn}:${evStep}`)) {
      startedSteps.add(`${evTurn}:${evStep}`);
      withSkeleton.push({ time: r.time, type: 'step/start', data: { turn: evTurn, step: evStep } } as unknown as Raw);
    }
    if (r.type === 'assistant/message' || r.type === 'tool/result') {
      (r.data as Record<string, unknown>).turn = curTurn;
      (r.data as Record<string, unknown>).step = curStep;
    }
    withSkeleton.push(entry);
  }
  merged.length = 0;
  merged.push(...withSkeleton);

  // Now assign seq contiguously over the *expanded* event stream.
  // Walk merged; normal events consume 1 seq, packed rows consume
  // payload length (texts/args) seqs starting at current cursor.
  // While assigning, record oldSeq -> newSeq for every decoded event so
  // preserved replace surfaceOps and sourceEventSeqs can be re-pointed at
  // the renumbered stream (stale references are hard load failures).
  let cursor = 0;
  const out: Array<Record<string, unknown>> = [];
  const seqMap = new Map<number, number>();
  const isSourceSeq = (s: number | undefined): s is number => typeof s === 'number' && s >= 0 && s < FALLBACK_SEQ_BASE;
  for (const entry of merged) {
    if ((entry as { __packed?: boolean }).__packed) {
      const packed = entry as Raw & { __packed: boolean; __seq0: number; __time0: number };
      const data = packed.data as unknown as Record<string, unknown>;
      const payloadLen = Array.isArray((data as any).texts) ? (data as any).texts.length : Array.isArray((data as any).args) ? (data as any).args.length : 0;
      const span = Math.max(1, payloadLen);
      // Rewrite seq0 to be contiguous.
      out.push({
        type: packed.type,
        seq0: cursor,
        time0: packed.__time0,
        data: packed.data,
      });
      if (isSourceSeq(packed.__seq0)) for (let k = 0; k < span; k++) seqMap.set(packed.__seq0 + k, cursor + k);
      cursor += span;
    } else {
      const r = entry as Raw;
      const ev: Record<string, unknown> = { seq: cursor, time: r.time, type: r.type, data: r.data };
      if (SURFACE_TYPES.has(r.type)) {
        // Preserve a replace op when the source carried one; otherwise the
        // surface marker is a plain append.
        ev.surfaceOp = r.surfaceOp !== undefined && typeof r.surfaceOp === 'object' ? r.surfaceOp : 'append';
      }
      // Non-surface types never carry surfaceOp (the loader rejects that).
      if (r.sourceEventSeqs !== undefined) ev.sourceEventSeqs = r.sourceEventSeqs;
      out.push(ev);
      if (isSourceSeq(r._seq)) seqMap.set(r._seq, cursor);
      cursor++;
    }
  }

  // Re-point preserved replace ops + provenance refs at the new numbering.
  for (const ev of out) {
    const op = ev.surfaceOp;
    if (op !== undefined && typeof op === 'object' && !Array.isArray(op)) {
      const rop = op as { op: string; start: number; end: number };
      const start = seqMap.get(rop.start);
      const end = seqMap.get(rop.end);
      if (rop.op === 'replace' && start !== undefined && end !== undefined && start <= end && end < (ev.seq as number)) {
        ev.surfaceOp = { op: 'replace', start, end };
      } else if (SURFACE_TYPES.has(ev.type as string)) {
        // Referenced events no longer exist — degrade to append so the
        // artifact stays loadable (the replacing content is still present).
        ev.surfaceOp = 'append';
        delete ev.sourceEventSeqs;
      } else {
        delete ev.surfaceOp;
        delete ev.sourceEventSeqs;
      }
    }
    if (Array.isArray(ev.sourceEventSeqs)) {
      const remapped = [...new Set((ev.sourceEventSeqs as number[]).map((s) => seqMap.get(s)).filter((s): s is number => s !== undefined && s < (ev.seq as number)))].sort((a, b) => a - b);
      if (remapped.length > 0) ev.sourceEventSeqs = remapped;
      else delete ev.sourceEventSeqs;
    }
  }

  return out as unknown as DshEvent[];
}

function messageToDshData(_msg: MigratedMessage): DshEvent['data'] {
  // Legacy plain {role,content} — not used for DSH write anymore; kept for
  // non-DSH adapters via blocksToNative shape. DSH write uses dshContentFromBlocks.
  return { role: _msg.role, content: blocksToNative(_msg.content) };
}

/** Inverse of dshImageToFileBlock: an IR FileBlock carrying a
 * `dsh-attachment://<id>` url becomes a DSH ImageBlock. Returns undefined for
 * foreign files that cannot map (callers fall back to a text placeholder). */
function dshImageFromBlock(b: FileBlock): Record<string, unknown> | undefined {
  const url = b.url ?? '';
  if (!url.startsWith('dsh-attachment://')) return undefined;
  const attachmentId = url.slice('dsh-attachment://'.length);
  if (!attachmentId) return undefined;
  const attachment: Record<string, unknown> = { attachmentId, mediaType: b.mediaType ?? 'image/png' };
  if (b.filename) attachment.name = b.filename;
  return { type: 'image', attachment };
}

function dshContentFromBlocks(blocks: ContentBlock[]): unknown[] {
  return blocks.map((b) => {
    switch (b.type) {
      case 'text':
        return { type: 'text', text: b.text };
      case 'thinking':
        // DSH stores reasoning as {type:"reasoning", text}
        return { type: 'reasoning', text: b.thinking };
      case 'tool_use':
        // DSH tool-call block inside assistant content
        return { type: 'tool-call', id: b.id, name: b.name, arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}) };
      case 'file': {
        // DSH ImageBlock projection (gap #4); non-mappable files degrade to text.
        const image = dshImageFromBlock(b);
        if (image) return image;
        return { type: 'text', text: `[file: ${b.filename ?? b.url ?? b.mediaType ?? 'attachment'}]` };
      }
      case 'tool_result':
        // Should not appear inside user/assistant content — tool/result is its own event type.
        // Fall back to a text wrapper so the block is not silently dropped.
        return { type: 'text', text: b.content };
    }
  });
}

function buildSessionFrame(headerJson: string): Buffer {
  // header must be exactly one line + trailing newline
  return compressFrame(`${headerJson}\n`);
}

function buildEventsFrame(events: DshEvent[]): Buffer {
  const lines = events.map((e) => JSON.stringify(e)).join('\n');
  return compressFrame(`${lines}\n`);
}

/** DSH side-store path derived from a sessions root (`<dshHome>/sessions`). */
function dshStoragesPath(sessionsRoot: string, file: string): string | null {
  const dshHome = dirname(sessionsRoot);
  if (!dshHome || dshHome === sessionsRoot) return null;
  return join(dshHome, 'storages', file);
}

/** Project directory name for a cwd — DSH parks cwd-less sessions under
 * `_no-cwd`, not under the projectKey of an empty string. */
function dshProjectDirName(cwd: string): string {
  return cwd ? projectKey(cwd) : '_no-cwd';
}

/** projcache title projection (`tables.sessions[id].rows.title.val`): one JSON
 * read covers every session DSH has opened. Corrupt/missing file → empty map
 * (callers fall back to per-log scans). */
async function readProjcacheTitles(sessionsRoot: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const p = dshStoragesPath(sessionsRoot, 'session_projcache.json');
  if (!p) return out;
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch {
    return out;
  }
  try {
    const doc = JSON.parse(raw) as { tables?: { sessions?: Record<string, { rows?: { title?: { val?: unknown } } }> } };
    for (const [id, rec] of Object.entries(doc.tables?.sessions ?? {})) {
      const val = rec?.rows?.title?.val;
      if (typeof val === 'string' && val) out.set(id, val);
    }
  } catch {
    // corrupt cache — per-log fallback covers everything
  }
  return out;
}

/** Archived session ids from workspace.json's global.archivedSessionIds. */
async function readArchivedSessionIds(sessionsRoot: string): Promise<Set<string>> {
  const out = new Set<string>();
  const p = dshStoragesPath(sessionsRoot, 'workspace.json');
  if (!p) return out;
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch {
    return out;
  }
  try {
    const doc = JSON.parse(raw) as { global?: { archivedSessionIds?: unknown } };
    if (Array.isArray(doc.global?.archivedSessionIds)) {
      for (const id of doc.global.archivedSessionIds) if (typeof id === 'string') out.add(id);
    }
  } catch {
    // best-effort
  }
  return out;
}

/** Title of the LAST `session/title` event in a decompressed log — renames
 * override earlier titles, so the last one wins. Substring-prefilters lines
 * so only title-ish rows pay a JSON.parse. */
function scanTitleFromLog(buf: Buffer): string | undefined {
  let title: string | undefined;
  try {
    for (const line of decompressSessionBuffer(buf).split('\n')) {
      if (!line.includes('"session/title"')) continue;
      let ev: DshEvent;
      try {
        ev = JSON.parse(line) as DshEvent;
      } catch {
        continue;
      }
      const t = (ev.data as Record<string, unknown> | undefined)?.title;
      if (ev.type === 'session/title' && typeof t === 'string' && t) title = t;
    }
  } catch {
    return undefined;
  }
  return title;
}