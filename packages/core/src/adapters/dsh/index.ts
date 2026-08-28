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
    const createdAt = ir.createdAt ?? Date.now();

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

    // event rows -> surface messages
    const events = irToEvents(ir, createdAt);
    const frame1 = buildSessionFrame(header);
    const frame2 = buildEventsFrame(events);

    const dir = join(sessionsRoot, projectKey(cwd), encodeSegment(newId));
    await fs.mkdir(dir, { recursive: true });
    // DSH uses concatenated frames: header (own frame) + event batches (own frames)
    const payload = Buffer.concat([frame1, frame2]);
    const finalPath = join(dir, 'session.jsonl.zstd');
    await fs.writeFile(finalPath, payload);

    const paths: string[] = [finalPath];

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
      const childIr: MigratedSession = { schemaVersion: 1 as const, originTool: 'dsh', messages: sc.messages };
      const childEvents = irToEvents(childIr, childCreatedAt);
      const cFrame1 = buildSessionFrame(childHeader);
      const cFrame2 = buildEventsFrame(childEvents);
      const cDir = join(sessionsRoot, projectKey(cwd), encodeSegment(childId));
      await fs.mkdir(cDir, { recursive: true });
      const cPayload = Buffer.concat([cFrame1, cFrame2]);
      const cPath = join(cDir, 'session.jsonl.zstd');
      await fs.writeFile(cPath, cPayload);
      paths.push(cPath);
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

/** Turn header + parsed events into a MigratedSession using the surface fold. */
export function buildIrFromEvents(header: { cwd?: string; createdAt?: number; id?: string }, events: DshEvent[]): MigratedSession {
  const messages: MigratedMessage[] = [];
  const surfaceSeqs: number[] = []; // model-visible order (append-only fold)

  for (const ev of events) {
    if (!SURFACE_TYPES.has(ev.type)) continue;
    if (ev.surfaceOp !== 'append') continue; // replacement copies stay model-only
    const msg = eventToMessage(ev.type, ev.data);
    if (!msg) continue;
    messages.push(msg);
    surfaceSeqs.push(ev.seq);
  }

  return { schemaVersion: 1 as const, originTool: 'dsh', messages };
}

function eventToMessage(type: string, data: DshEvent['data']): MigratedMessage | null {
  switch (type) {
    case 'user/message':
      // data IS the message (has role/content)
      return normalizeMessageLike(data);
    case 'assistant/message': {
      const m = data.message as { content?: unknown } | undefined;
      if (!m || !Array.isArray(m.content) || m.content.length === 0) return null;
      return normalizeMessageLike(m);
    }
    case 'tool/result': {
      const m = data.message as { content?: unknown } | undefined;
      if (!m || !Array.isArray(m.content)) return null;
      return normalizeMessageLike(m);
    }
    default:
      return null;
  }
}

function normalizeMessageLike(v: unknown): MigratedMessage | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const role = (o.role as MessageRole) ?? 'assistant';
  const content = Array.isArray(o.content) ? o.content : [];
  const blocks: ContentBlock[] = normalizeContent(content);
  return { role, content: blocks };
}

/** Build IR messages back into DSH event rows (with seq + surfaceOp). */
export function irToEvents(ir: MigratedSession, baseTime: number): DshEvent[] {
  const events: DshEvent[] = [];
  let seq = 0;
  let time = baseTime;
  for (const msg of ir.messages) {
    const t = (msg.timestamp ?? time) || time;
    time = t + (t === time ? 1 : 0); // avoid duplicated timestamps breaking ordering hints
    const data = messageToDshData(msg);
    if (msg.role === 'user' || msg.role === 'system') {
      events.push({ seq: seq++, time, type: 'user/message', surfaceOp: 'append', data });
    } else {
      events.push({ seq: seq++, time, type: 'assistant/message', surfaceOp: 'append', data: { message: data } });
    }
  }
  return events;
}

function messageToDshData(msg: MigratedMessage): DshEvent['data'] {
  return { role: msg.role, content: blocksToNative(msg.content) };
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