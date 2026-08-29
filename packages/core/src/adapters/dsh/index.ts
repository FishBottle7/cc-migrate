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
 * TODO(ir-protocol): this adapter predates the toolCalls typed bucket and the
 * per-message association rules — see docs/ir-protocol.md「dsh 待适配清单」:
 *  1. read: emit MigratedToolCall records from tool-call + tool-result events
 *  2. write: consume ir.toolCalls (state wins over the block-level view)
 *  3. after MigratedMessage.meta lands: move message-level fields out of the
 *     'dsh.headerRaw' side-table into per-message association
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Adapter, WriteOptions, WriteResult } from '../../registry.js';
import type {
  ContentBlock,
  MigratedMessage,
  MigratedSession,
  MessageRole,
  SessionMeta,
} from '../../ir.js';
import { validateSession } from '../../ir.js';
import { blocksToNative, blocksToText, normalizeContent } from '../../content.js';
import {
  compressFrame,
  decompressSessionBuffer,
  defaultDshRoot,
  encodeSegment,
  projectKey,
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
  data: {
    message?: unknown;
    role?: string;
    content?: unknown;
    title?: string;
  } & Record<string, unknown>;
}

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);
const PACKED_CHUNK_TYPES = new Set(['reasoning-chunks', 'text-chunks', 'tool-call-chunks']);

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

  private async collectSubagentSidechains(root: string, parentId: string): Promise<import('../../ir.js').MigratedSidechain[]> {
    const sidechains: Array<import('../../ir.js').MigratedSidechain & { _createdAt: number }> = [];
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
        let plaintext: string;
        try {
          plaintext = decompressSessionBuffer(buf);
        } catch {
          continue;
        }
        const nl = plaintext.indexOf('\n');
        const firstLine = (nl === -1 ? plaintext : plaintext.slice(0, nl)).trim();
        if (!firstLine) continue;
        let header: Record<string, unknown>;
        try {
          header = JSON.parse(firstLine) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (header.parentSession !== parentId) continue;
        const childId = typeof header.id === 'string' && header.id ? header.id : sessDir;
        const createdAt = typeof header.createdAt === 'number' && Number.isSafeInteger(header.createdAt) ? header.createdAt : 0;
        const agentPreset = typeof header.agentPreset === 'string' ? header.agentPreset : undefined;
        // decode full session for messages
        const lines = plaintext.split('\n').filter((l) => l.trim().length > 0);
        if (lines.length === 0) continue;
        let events: DshEvent[];
        try {
          events = lines.slice(1).map((l) => JSON.parse(l) as DshEvent);
        } catch {
          continue;
        }
        events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
        const childIr = buildIrFromEvents(header as unknown as { cwd?: string; createdAt?: number; id?: string }, events);
        sidechains.push({
          agentId: childId,
          kind: 'subagent',
          agentType: agentPreset,
          messages: childIr.messages,
          _createdAt: createdAt,
        } as import('../../ir.js').MigratedSidechain & { _createdAt: number });
      }
    }
    sidechains.sort((a, b) => a._createdAt - b._createdAt);
    return sidechains.map(({ _createdAt: _c, ...rest }) => rest);
  }

  /** Write an IR session into DSH's native resumable storage (new session id). */
  async write(ir: MigratedSession, opts?: WriteOptions): Promise<WriteResult> {
    validateSession(ir);
    const sessionsRoot = opts?.root ?? defaultDshRoot();
    if (!sessionsRoot) throw new Error('DSH: cannot resolve ~/.dsh/sessions');
    const cwd = opts?.targetCwd ?? ir.cwd ?? '';
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

    // header frame — build object conditionally so no empty `cwd` leaks in
    const headerObj: Record<string, unknown> = {
      type: 'session',
      version: 0,
      id: newId,
      createdAt,
      delegationDepth: 0,
      agentPreset: 'standard',
    };
    if (cwd) headerObj.cwd = cwd;
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

    const dir = join(sessionsRoot, projectKey(cwd), encodeSegment(newId));
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

    // subagent sidechains -> independent child sessions
    const subagents = (ir.sidechains ?? []).filter((s) => s.kind === 'subagent');
    const now = Date.now();
    for (let idx = 0; idx < subagents.length; idx++) {
      const sc = subagents[idx];
      const rawId = sc.agentId;
      const childId =
        typeof rawId === 'string' &&
        rawId.trim().length > 0 &&
        rawId !== '.' &&
        rawId !== '..' &&
        !rawId.includes('/') &&
        !rawId.includes('\\') &&
        !rawId.includes(':')
          ? rawId
          : `session-${randomUUID()}`;
      const childCreatedAt = now + idx + 1;
      const childHeaderObj: Record<string, unknown> = {
        type: 'session',
        version: 0,
        id: childId,
        createdAt: childCreatedAt,
        delegationDepth: 1,
        parentSession: newId,
        origin: 'subagent',
        agentPreset: sc.agentType ?? 'standard',
      };
      if (cwd) childHeaderObj.cwd = cwd;
      const childHeader = JSON.stringify(childHeaderObj);
      const childIr: MigratedSession = { schemaVersion: 2 as const, originTool: 'dsh', messages: sc.messages };
      const childEvents = irToEvents(childIr, childCreatedAt);
      const cFrame1 = buildSessionFrame(childHeader);
      const cFrame2 = buildEventsFrame(childEvents);
      const cDir = join(sessionsRoot, projectKey(cwd), encodeSegment(childId));
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
    }

    return { tool: 'dsh', sessionId: newId, paths };
  }

  /** Lightweight session listing from the DSH sessions root. */
  async listSessions(root?: string): Promise<SessionMeta[]> {
    const sessionsRoot = root ?? defaultDshRoot();
    if (!sessionsRoot) return [];
    const metas: SessionMeta[] = [];
    let projects: string[];
    try {
      projects = await fs.readdir(sessionsRoot);
    } catch {
      return [];
    }
    for (const proj of projects) {
      if (!proj.startsWith('--') || !proj.endsWith('--')) continue;
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
          metas.push({
            tool: 'dsh',
            sessionId: sid,
            // DSH stores the title as a `session/title` event inside the log;
            // lightweight listing does not decode it, so title stays undefined
            // and we expose the project dir key as cwd hint for display.
            cwd: cwdFromProjectKey(proj),
            createdAt: st.mtimeMs,
            sourcePath: log,
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
  const unmappedEvents: NonNullable<MigratedSession['unmappedEvents']> = [];
  let title: string | undefined;

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
    if (SURFACE_TYPES.has(ev.type) && ev.surfaceOp === 'append') {
      const msg = eventToMessage(ev.type, cleanData);
      if (msg) {
        // Preserve wall-clock + original seq so irToEvents can restore the
        // exact stream order (turn/start must precede its surface messages;
        // equal-ms ties break by original seq, matching the source log).
        // provider/model are already lifted inside normalizeMessageLike.
        msg.timestamp = ev.time;
        msg.seq = ev.seq;
        messages.push(msg);
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
    } as NonNullable<MigratedSession['unmappedEvents']>[number]);
  }

  const ir: MigratedSession = { schemaVersion: 2 as const, originTool: 'dsh', messages };
  if (title) ir.title = title;
  if (goals.length) ir.goals = goals;
  if (planModes.length) ir.planModes = planModes;
  if (todos.length) ir.todos = todos;
  if (unmappedEvents.length) ir.unmappedEvents = unmappedEvents;
  // preserve header for lossless same-tool round-trip
  ir.extensions = { 'dsh.headerRaw': { ...header } };
  return ir;
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
      if (isToolBridged) return { ...msg, role: 'tool' as const };
      return msg;
    }
    case 'assistant/message': {
      // DSH assistant/message shape: {turn,step,message:{id, role:"assistant", source:{kind:"model",...}, content:[]}}
      const m = (data as unknown as Record<string, unknown>).message as { content?: unknown } | undefined;
      if (!m || !Array.isArray(m.content) || m.content.length === 0) return null;
      return normalizeMessageLike(m);
    }
    case 'tool/result': {
      // Canonical DSH tool/result: {turn,step,message:{role,content,source:{kind:tool}}}
      // Preserve as role:'tool' so round-trip knows to emit tool/result.
      const m = (data as Record<string, unknown>).message as { content?: unknown } | undefined;
      if (!m || !Array.isArray(m.content)) return null;
      const msg = normalizeMessageLike(m);
      if (!msg) return null;
      // normalize to tool role
      return { ...msg, role: 'tool' as const };
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
    if ((rec.type === 'tool-result' || rec.type === 'tool_result') && Array.isArray(rec.content)) {
      const inner = rec.content as unknown[];
      const text = inner.map((c) => typeof c === 'object' && c !== null && typeof (c as Record<string, unknown>).text === 'string' ? String((c as Record<string, unknown>).text) : '').join('');
      return { type: 'tool_result', toolUseId: String(rec.toolCallId ?? rec.toolUseId ?? rec.id ?? ''), content: text, isError: Boolean(rec.isError) };
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

/**
 * Build IR back into DSH event rows (with seq + surfaceOp).
 *
 * v3: merges messages + goals + planModes + todos + unmappedEvents into a
 * single time-ordered stream, then reassigns contiguous seq 0..N-1. This is
 * the only path that makes `agent->IR->agent` lossless for DSH (see
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
  let msgFallback = baseTime;
  for (const msg of ir.messages) {
    const t = msg.timestamp;
    const time = typeof t === 'number' && Number.isFinite(t) ? t : msgFallback++;
    const seq = typeof msg.seq === 'number' && Number.isSafeInteger(msg.seq) ? msg.seq : FALLBACK_SEQ_BASE + fallbackIdx++;
    if (msg.role === 'tool') {
      // Rebuild DSH tool/result shape: {turn,step,message:{source,role,content}}
      // preserve the nested tool-result interior expected by DSH surface.
      const toolBlocks = msg.content.filter((b) => b.type === 'tool_result');
      const toolData: Record<string, unknown> = {
        turn: 1,
        step: 1,
        message: {
          role: 'user',
          source: { kind: 'tool', callId: (toolBlocks[0] as { toolUseId?: string })?.toolUseId ?? `call_${randomUUID()}` },
          content: msg.content.map((b) => {
            if (b.type === 'tool_result') return { type: 'tool-result', toolCallId: b.toolUseId, content: [{ type: 'text', text: b.content }], isError: !!b.isError };
            if (b.type === 'text') return { type: 'text', text: b.text };
            return { type: 'text', text: (b as { thinking?: string }).thinking ?? '' };
          }),
          id: `msg_${randomUUID()}`,
        },
      };
      raw.push({ time, type: 'tool/result', surfaceOp: 'append', data: toolData as unknown as DshEvent['data'], _msg: msg, _seq: seq });
      continue;
    }
    if (msg.role === 'user' || msg.role === 'system') {
      // DSH validates user/message data IS the message: must have {id, role:"user", source:{kind}, content:[]}
      // See assertMessageEventShape in dsh-session (≈ line 1252). Plain {role,content} fails with
      // "lacks an identified message".
      const data = {
        id: `msg_${randomUUID()}`,
        role: 'user' as const,
        source: { kind: 'user', rpcId: randomUUID(), clientTimeZone: 'Asia/Shanghai' },
        content: dshContentFromBlocks(msg.content),
      } as unknown as DshEvent['data'];
      raw.push({ time, type: 'user/message', surfaceOp: 'append', data, _msg: msg, _seq: seq });
    } else {
      // DSH validates assistant/message data as {turn,step,message:{id, role:"assistant", source:{kind:"model",provider,model}, content:[]}}
      const provider = (ir.model?.provider as string) ?? 'abrdns';
      const model = (ir.model?.id as string) ?? 'GLM-5.3-Flash';
      const data = {
        turn: 1,
        step: 1,
        message: {
          id: `msg_${randomUUID()}`,
          role: 'assistant' as const,
          source: { kind: 'model', provider, model },
          content: dshContentFromBlocks(msg.content),
        },
      } as unknown as DshEvent['data'];
      raw.push({ time, type: 'assistant/message', surfaceOp: 'append', data, _msg: msg, _seq: seq });
    }
  }
  for (const g of ir.goals ?? []) {
    const time = typeof g.time === 'number' && Number.isFinite(g.time) ? g.time : baseTime;
    raw.push({ time, type: 'goal/change', data: g.data as unknown as DshEvent['data'], _seq: g.seq });
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
  let curTurn = 1;
  let curStep = 1;
  for (const entry of merged) {
    if ((entry as { __packed?: boolean }).__packed) continue;
    const r = entry as Raw;
    const d = r.data as Record<string, unknown> | undefined;
    if (r.type === 'turn/start') {
      if (typeof d?.turn === 'number') curTurn = d.turn;
    } else if (r.type === 'step/start') {
      if (typeof d?.turn === 'number') curTurn = d.turn;
      if (typeof d?.step === 'number') curStep = d.step;
    } else if (r.type === 'assistant/message' || r.type === 'tool/result') {
      (r.data as Record<string, unknown>).turn = curTurn;
      (r.data as Record<string, unknown>).step = curStep;
    }
  }

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

function cwdFromProjectKey(proj: string): string | undefined {
  // best-effort: `--D-codes-foo--` -> `D:\codes\foo` here we keep as decoded-ish.
  // Real decoding is lossy for separators; we just return the inner key for display.
  const inner = proj.replace(/^--/, '').replace(/--$/, '');
  return inner.length ? inner : undefined;
}