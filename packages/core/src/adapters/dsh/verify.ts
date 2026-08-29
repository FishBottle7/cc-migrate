/**
 * DSH session-artifact verifier.
 *
 * Validates a `session.jsonl.zstd` artifact against the physical and
 * conversation contracts DSH enforces at load time, so a migration can be
 * checked BEFORE the GUI ever opens it:
 *
 *  1. header envelope       — {type:'session',version:0,id,createdAt,cwd}
 *  2. row envelopes         — exact-key rules incl. packed `{seq0,time0}` rows
 *  3. seq contiguity        — decoded stream must be 0..N-1
 *  4. surface rules         — surface-eligible types require surfaceOp;
 *                             non-surface types must not carry surfaceOp /
 *                             sourceEventSeqs; replace ops reference earlier
 *                             existing seqs
 *  5. turn-tail ordering    — exact replica of the GUI conversation matcher:
 *                             turn/start must be the FIRST match of its
 *                             turn-tail context (updates before start are the
 *                             "received an update before its start Match" load
 *                             failure)
 *  6. message shapes        — user/message | assistant/message | tool/result
 *                             must carry the identified-message fields
 *                             (id + source.kind) the loader asserts
 *
 * Dependency-free by design: this mirrors the host contracts but never
 * imports host packages, so the CLI can verify on any machine.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { decompressSessionBuffer, defaultDshRoot } from './format.js';

export const SURFACE_ELIGIBLE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);
export const PACKED_ROW_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks']);

export interface VerifyIssue {
  /** 1-based physical line in the decompressed log (header = line 1). */
  line?: number;
  /** Decoded seq when known. */
  seq?: number;
  check: 'header' | 'envelope' | 'seq' | 'surface' | 'turn-tail' | 'message-shape';
  message: string;
}

export interface VerifyStats {
  lines: number;
  events: number;
  assistantMessages: number;
  textBlocks: number;
  reasoningBlocks: number;
  toolCalls: number;
  turns: number;
}

export interface VerifyResult {
  sessionId: string;
  path: string;
  ok: boolean;
  stats: VerifyStats;
  issues: VerifyIssue[];
}

function isSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

/** Exact turn-tail matcher replica from the DSH GUI conversation skeleton. */
function turnTailMatch(ev: Record<string, unknown>): { id: string; role: 'start' | 'update' } | null {
  const type = ev.type as string;
  const data = ev.data as Record<string, unknown> | undefined;
  if (type === 'turn/start') return { id: String(data?.turn), role: 'start' };
  if (type === 'turn/end') return { id: String(data?.turn), role: 'update' };
  if (type === 'tool/call' || type === 'tool/result') return { id: String(data?.turn), role: 'update' };
  if (type === 'assistant/message' || type === 'assistant/chunk' || type === 'step/end' || type === 'llm/retry') {
    if (data && data.turn !== undefined) return { id: String(data.turn), role: 'update' };
  }
  return null;
}

/** Expand one storage row into its decoded events (packed rows fan out). */
function expandRow(ev: Record<string, unknown>): Array<{ seq: number }> {
  if (PACKED_ROW_TYPES.has(ev.type as string)) {
    const data = ev.data as Record<string, unknown> | undefined;
    const len = Array.isArray(data?.texts) ? data.texts.length : Array.isArray(data?.args) ? data.args.length : 1;
    const seq0 = ev.seq0 as number;
    return Array.from({ length: Math.max(1, len) }, (_, k) => ({ seq: seq0 + k }));
  }
  return [{ seq: ev.seq as number }];
}

/** Validate one decompressed session log (header line + event rows). */
export function verifySessionLog(plain: string, sessionId: string, path: string): VerifyResult {
  const issues: VerifyIssue[] = [];
  const lines = plain.split('\n').filter((l) => l.trim());
  const stats: VerifyStats = { lines: Math.max(0, lines.length - 1), events: 0, assistantMessages: 0, textBlocks: 0, reasoningBlocks: 0, toolCalls: 0, turns: 0 };

  if (lines.length === 0) {
    return { sessionId, path, ok: false, stats, issues: [{ check: 'header', message: 'empty session log' }] };
  }

  // 1. header
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(lines[0]);
  } catch (e) {
    return { sessionId, path, ok: false, stats, issues: [{ line: 1, check: 'header', message: `header is not JSON: ${(e as Error).message}` }] };
  }
  if (header.type !== 'session') issues.push({ line: 1, check: 'header', message: `header.type expected "session", got ${JSON.stringify(header.type)}` });
  if (header.version !== 0) issues.push({ line: 1, check: 'header', message: `header.version expected 0, got ${JSON.stringify(header.version)}` });
  if (typeof header.id !== 'string' || !header.id) issues.push({ line: 1, check: 'header', message: 'header.id missing' });
  if (!isSafeInt(header.createdAt)) issues.push({ line: 1, check: 'header', message: 'header.createdAt missing' });
  if (typeof header.cwd !== 'string' || !header.cwd) issues.push({ line: 1, check: 'header', message: 'header.cwd missing' });
  if (typeof header.id === 'string' && header.id !== sessionId) issues.push({ line: 1, check: 'header', message: `header.id ${header.id} does not match artifact session ${sessionId}` });

  // 2..6 per row
  const decodedSeqs = new Set<number>();
  const startedTurns = new Map<string, number>();
  const updateTurns = new Set<string>();
  const turnIds = new Set<string>();
  let expected = 0;

  for (let i = 1; i < lines.length; i++) {
    const lineNo = i + 1;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(lines[i]);
    } catch (e) {
      issues.push({ line: lineNo, check: 'envelope', message: `row is not JSON: ${(e as Error).message}` });
      break;
    }
    const type = ev.type as string;
    const keys = new Set(Object.keys(ev));
    const fail = (check: VerifyIssue['check'], message: string) => issues.push({ line: lineNo, seq: isSafeInt(ev.seq) ? (ev.seq as number) : isSafeInt(ev.seq0) ? (ev.seq0 as number) : undefined, check, message });

    if (PACKED_ROW_TYPES.has(type)) {
      // storage rows must be exactly {type, seq0, time0, data}
      const wanted = new Set(['type', 'seq0', 'time0', 'data']);
      for (const k of keys) if (!wanted.has(k)) fail('envelope', `packed row has unexpected key "${k}" (envelope must be exactly {type, seq0, time0, data})`);
      for (const k of wanted) if (!keys.has(k)) fail('envelope', `packed row missing key "${k}"`);
      if (!isSafeInt(ev.seq0) || (ev.seq0 as number) < 0) fail('envelope', 'packed row seq0 must be a non-negative safe integer');
      if (!isSafeInt(ev.time0)) fail('envelope', 'packed row time0 must be a safe integer');
      const data = ev.data as Record<string, unknown> | undefined;
      if (typeof data !== 'object' || data === null) fail('envelope', 'packed row data must be an object');
    } else {
      const allowed = new Set(['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs', 'ignorable']);
      for (const k of keys) if (!allowed.has(k)) fail('envelope', `unexpected event key "${k}"`);
      for (const k of ['type', 'seq', 'time', 'data'] as const) if (!keys.has(k)) fail('envelope', `event missing key "${k}"`);
      if (!isSafeInt(ev.seq) || (ev.seq as number) < 0) fail('envelope', 'seq must be a non-negative safe integer');
      if (!isSafeInt(ev.time)) fail('envelope', 'time must be a safe integer');
      if (keys.has('data') && ev.data === undefined) fail('envelope', 'data must not be undefined');
      if (keys.has('ignorable') && ev.ignorable !== true) fail('envelope', 'ignorable must be true when present');

      // surface rules
      const eligible = SURFACE_ELIGIBLE_TYPES.has(type);
      const op = ev.surfaceOp;
      if (eligible) {
        if (op === undefined) fail('surface', `${type} is surface-eligible and requires a surfaceOp`);
        else if (op === 'append') { /* ok */ }
        else if (typeof op === 'object' && op !== null && !Array.isArray(op)) {
          const rop = op as Record<string, unknown>;
          if (rop.op !== 'replace' || !isSafeInt(rop.start) || !isSafeInt(rop.end) || Object.keys(rop).length !== 3) {
            fail('surface', 'replace surfaceOp must be exactly {op:"replace", start, end}');
          } else {
            if ((rop.start as number) > (rop.end as number)) fail('surface', `replace start ${rop.start} > end ${rop.end}`);
            if ((rop.end as number) >= (ev.seq as number)) fail('surface', `replace references non-earlier seq ${rop.end} >= ${ev.seq}`);
          }
        } else fail('surface', `invalid surfaceOp ${JSON.stringify(op)}`);
      } else if (op !== undefined) {
        fail('surface', `${type} is not surface-eligible and cannot carry surfaceOp`);
      }
      if (ev.sourceEventSeqs !== undefined) {
        if (!eligible) fail('surface', `${type} is not surface-eligible and cannot carry sourceEventSeqs`);
        else {
          const arr = ev.sourceEventSeqs;
          if (!Array.isArray(arr)) fail('surface', 'sourceEventSeqs must be an array');
          else {
            if (arr.length === 0 && type !== 'assistant/message') fail('surface', 'sourceEventSeqs must not be empty except on assistant/message');
            const seen = new Set<number>();
            for (const s of arr) {
              if (!isSafeInt(s) || (s as number) < 0) { fail('surface', 'sourceEventSeqs must contain non-negative safe integers'); break; }
              if (seen.has(s as number)) fail('surface', 'sourceEventSeqs must not contain duplicates');
              seen.add(s as number);
              if ((s as number) >= (ev.seq as number)) { fail('surface', `sourceEventSeqs must reference earlier events: ${s} >= ${ev.seq}`); break; }
            }
          }
        }
      }
    }

    // seq contiguity over the decoded (expanded) stream
    for (const d of expandRow(ev)) {
      if (d.seq !== expected) {
        issues.push({ line: lineNo, seq: d.seq, check: 'seq', message: `decoded seq gap: expected ${expected}, got ${d.seq}` });
        expected = -1;
        break;
      }
      decodedSeqs.add(d.seq);
      expected++;
    }
    if (expected === -1) break;
    stats.events += expandRow(ev).length;

    // stats
    if (type === 'assistant/message') {
      stats.assistantMessages++;
      const content = (ev.data as any)?.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'text') stats.textBlocks++;
          if (b?.type === 'reasoning') stats.reasoningBlocks++;
        }
      }
    }
    if (type === 'tool/call') stats.toolCalls++;
    if (type === 'turn/start') turnIds.add(String((ev.data as any)?.turn));

    // message shapes (the loader asserts identified messages)
    const data = ev.data as Record<string, unknown> | undefined;
    if (type === 'user/message') {
      const d = data as Record<string, unknown> | undefined;
      if (typeof d?.id !== 'string' || !d.id) fail('message-shape', 'user/message data lacks an identified message (data.id)');
      const src = d?.source as Record<string, unknown> | undefined;
      if (typeof src?.kind !== 'string' || !src.kind) fail('message-shape', 'user/message data.source.kind missing');
      if (!Array.isArray(d?.content)) fail('message-shape', 'user/message data.content must be an array');
    } else if (type === 'assistant/message') {
      const m = data?.message as Record<string, unknown> | undefined;
      if (typeof m?.id !== 'string' || !m.id) fail('message-shape', 'assistant/message lacks identified message (message.id)');
      const src = m?.source as Record<string, unknown> | undefined;
      if (typeof src?.kind !== 'string' || !src.kind) fail('message-shape', 'assistant/message message.source.kind missing');
      if (!Array.isArray(m?.content)) fail('message-shape', 'assistant/message message.content must be an array');
    } else if (type === 'tool/result') {
      const m = data?.message as Record<string, unknown> | undefined;
      const src = m?.source as Record<string, unknown> | undefined;
      if (src?.kind !== 'tool') fail('message-shape', 'tool/result message.source.kind must be "tool"');
      if (typeof src?.callId !== 'string' || !src.callId) fail('message-shape', 'tool/result message.source.callId missing');
      if (!Array.isArray(m?.content)) fail('message-shape', 'tool/result message.content must be an array');
    }

    // turn-tail ordering (exact GUI matcher semantics):
    // a start arriving after any update of the same turn is the hard load
    // failure ("received an update before its start Match"); updates with no
    // start at all are tolerated by the GUI (turn renders as "unknown").
    const m = turnTailMatch(ev);
    if (m) {
      if (m.role === 'start') {
        if (startedTurns.has(m.id)) fail('turn-tail', `duplicate turn/start for turn ${m.id}`);
        else if (updateTurns.has(m.id)) fail('turn-tail', `turn/start for turn ${m.id} arrives after its first update — GUI load fails with "received an update before its start Match"`);
        else startedTurns.set(m.id, i);
      } else {
        updateTurns.add(m.id);
      }
    }
  }

  stats.turns = turnIds.size;
  return { sessionId, path, ok: issues.length === 0, stats, issues };
}

/** Verify one session artifact by session id (optionally under a custom root). */
export async function verifySessionById(sessionId: string, root?: string): Promise<VerifyResult> {
  const sessionsRoot = root ?? defaultDshRoot();
  if (!sessionsRoot) throw new Error('cannot resolve DSH sessions root');
  // The artifact lives under the project dir derived from its header cwd;
  // locate it by scanning project dirs for the id (cheap, avoids cwd guess).
  let projects: string[];
  try {
    projects = await readdir(sessionsRoot);
  } catch (e) {
    throw new Error(`cannot read sessions root: ${(e as Error).message}`);
  }
  for (const proj of projects) {
    if (!(proj.startsWith('--') && proj.endsWith('--'))) continue;
    const p = join(sessionsRoot, proj, sessionId, 'session.jsonl.zstd');
    try {
      await stat(p);
    } catch {
      continue;
    }
    const buf = await readFile(p);
    const plain = decompressSessionBuffer(buf as unknown as Buffer);
    return verifySessionLog(plain, sessionId, p);
  }
  throw new Error(`session artifact not found for ${sessionId}`);
}

/** Verify every session artifact under a sessions root (default: real DSH root). */
export async function verifyAllSessions(root?: string): Promise<VerifyResult[]> {
  const sessionsRoot = root ?? defaultDshRoot();
  if (!sessionsRoot) {
    return [{ sessionId: '', path: '', ok: false, stats: { lines: 0, events: 0, assistantMessages: 0, textBlocks: 0, reasoningBlocks: 0, toolCalls: 0, turns: 0 }, issues: [{ check: 'header', message: 'cannot resolve DSH sessions root' }] }];
  }
  const out: VerifyResult[] = [];
  let projects: string[];
  try {
    projects = await readdir(sessionsRoot);
  } catch (e) {
    return [{ sessionId: '', path: sessionsRoot, ok: false, stats: { lines: 0, events: 0, assistantMessages: 0, textBlocks: 0, reasoningBlocks: 0, toolCalls: 0, turns: 0 }, issues: [{ check: 'header', message: `cannot read root: ${(e as Error).message}` }] }];
  }
  for (const proj of projects) {
    if (!(proj.startsWith('--') && proj.endsWith('--'))) continue;
    const dir = join(sessionsRoot, proj);
    let sids: string[];
    try {
      sids = await readdir(dir);
    } catch {
      continue;
    }
    for (const sid of sids) {
      const p = join(dir, sid, 'session.jsonl.zstd');
      try {
        await stat(p);
      } catch {
        continue;
      }
      try {
        const buf = await readFile(p);
        const plain = decompressSessionBuffer(buf as unknown as Buffer);
        out.push(verifySessionLog(plain, sid, p));
      } catch (e) {
        out.push({ sessionId: sid, path: p, ok: false, stats: { lines: 0, events: 0, assistantMessages: 0, textBlocks: 0, reasoningBlocks: 0, toolCalls: 0, turns: 0 }, issues: [{ check: 'envelope', message: `cannot decompress: ${(e as Error).message}` }] });
      }
    }
  }
  return out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}
