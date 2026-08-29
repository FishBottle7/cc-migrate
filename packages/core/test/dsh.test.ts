/**
 * DSH adapter round-trip + surface-fold tests.
 *
 * These validate the acceptance gate for Phase 0: writing an IR session into
 * DSH-format on disk, then parsing it back, must yield the same messages.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DshAdapter } from '../src/adapters/dsh/index.js';
import {
  buildIrFromEvents,
  irToEvents,
} from '../src/adapters/dsh/index.js';
import { normalizeContent } from '../src/content.js';
import { fallbackIr } from '../src/demo.js';
import { decompressSessionBuffer } from '../src/adapters/dsh/format.js';
import { verifySessionLog } from '../src/adapters/dsh/verify.js';

/** Minimal loose shape for test fixture events. */
interface DshEventLike {
  seq: number;
  type: string;
  surfaceOp?: string;
  time?: number;
  data: Record<string, unknown>;
}

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'sm-dsh-test-'));
}

test('buildIrFromEvents folds the model-visible surface', () => {
  // Setup events and a packed text-chunks container row must NOT surface;
  // only surfaceOp:'append' user/assistant messages become IR messages.
  const raw = [
    { type: 'permission/preset', seq: 0, time: 1, data: { preset: 'workspace-write' } },
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    {
      type: 'user/message', seq: 2, time: 2, surfaceOp: 'append',
      data: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    },
    {
      type: 'assistant/message', seq: 3, time: 3, surfaceOp: 'append',
      data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] } },
    },
    // replace copy (no surfaceOp) + packed chunk container row — both excluded
    { type: 'user/message', seq: 4, time: 4, data: { role: 'user', content: [{ type: 'text', text: 'edited' }] } },
    { type: 'text-chunks', seq: 5, time: 5, data: { turn: 1, step: 1, index: 0, texts: ['x'] } },
  ];

  const ir = buildIrFromEvents({ id: 's1', createdAt: 1 }, raw as any);
  // Only the 2 append surface events survive
  assert.equal(ir.messages.length, 2);
  assert.equal((ir.messages[0].content[0] as { text: string }).text, 'hello');
  assert.equal(ir.messages[1].role, 'assistant');
  assert.equal((ir.messages[1].content[0] as { text: string }).text, 'hi there');
});

test('write -> read round-trip preserves messages', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const ir = fallbackIr();

  const res = await adapter.write(ir, { root, targetCwd: 'D:\\workspace\\proj' });
  assert.ok(res.paths[0].endsWith('session.jsonl.zstd'));

  const back = await adapter.parse(res.sessionId, root);
  assert.equal(back.originSessionId, res.sessionId);
  assert.equal(back.cwd, 'D:\\workspace\\proj');
  assert.equal(back.messages.length, ir.messages.length);

  // first message text survives the full write/parse cycle
  const firstBack = back.messages[0];
  const firstOrig = ir.messages[0];
  assert.equal(firstBack.role, firstOrig.role);
  assert.equal(
    (firstBack.content[0] as { text?: string }).text,
    (firstOrig.content[0] as { text?: string }).text,
  );

  // assistant tool_use block survived
  const asst = back.messages[1];
  assert.equal(asst.content.length, 2);
  assert.equal((asst.content[1] as { type: string }).type, 'tool_use');
});

test('written artifact is readable by the DSH physical contract', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const ir = fallbackIr();
  const res = await adapter.write(ir, { root, targetCwd: 'D:\\proj' });

  const buf = await fs.readFile(res.paths[0]);
  const plaintext = decompressSessionBuffer(buf);
  const lines = plaintext.split('\n').filter((l) => l.trim());
  assert.ok(lines.length >= 2, 'header + at least one event line');

  const header = JSON.parse(lines[0]);
  assert.equal(header.type, 'session');
  assert.equal(header.version, 0);
  assert.equal(typeof header.id, 'string');
  assert.equal(typeof header.createdAt, 'number');
  assert.equal(header.cwd, 'D:\\proj');

  // all event rows have contiguous seq
  const seqs = lines.slice(1).map((l) => JSON.parse(l).seq);
  seqs.forEach((s, i) => assert.equal(s, i, `seq[${i}] should be ${i}`));
});

test('normalizeContent handles text/tool_use/tool_result blobs', () => {
  const blocks = normalizeContent([
    { type: 'text', text: 'a' },
    { type: 'tool_use', id: 't1', name: 'read', input: { f: 'x' } },
    { type: 'tool_result', tool_use_id: 't1', content: 'result', is_error: false },
  ]);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[1], { type: 'tool_use', id: 't1', name: 'read', input: { f: 'x' } });
  assert.deepEqual(blocks[2], { type: 'tool_result', toolUseId: 't1', content: 'result', isError: false });
});

test('irToEvents emits surfaceOp append + contiguous seq', () => {
  const now = Date.now();
  const events = irToEvents(fallbackIr(), now) as DshEventLike[];
  assert.ok(events.every((e) => e.surfaceOp === 'append'));
  events.forEach((e, i) => assert.equal(e.seq, i));
});

test('buildIrFromEvents is zero-loss: goals/planModes/todos/unmappedEvents', () => {
  const raw = [
    { type: 'user/message', seq: 0, time: 10, surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'goal/change', seq: 1, time: 11, data: { kind: 'goal/change', version: 1, operation: 'create', goal: { title: 'g' } } },
    { type: 'plan/mode', seq: 2, time: 12, data: { enabled: true } },
    { type: 'todo/write', seq: 3, time: 13, data: { items: [{ text: 'a', status: 'pending' }] } },
    { type: 'approval/asked', seq: 4, time: 14, data: { id: 'ask-1' } },
    { type: 'session/title', seq: 5, time: 15, data: { title: 'my-title' } },
    // encrypted bucket — must be sanitized to [encrypted omitted]
    { type: 'assistant/message', seq: 6, time: 16, surfaceOp: 'append', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } },
  ];
  const ir = buildIrFromEvents({ id: 's1', createdAt: 10 }, raw as any);
  assert.equal(ir.messages.length, 2);
  assert.equal(ir.goals?.length, 1);
  assert.equal(ir.planModes?.length, 1);
  assert.equal(ir.todos?.length, 1);
  assert.equal(ir.title, 'my-title');
  // approval is in unmapped, title is captured as unmapped + promoted to title
  assert.ok((ir.unmappedEvents ?? []).some((e) => e.type === 'approval/asked'));
  assert.ok((ir.unmappedEvents ?? []).some((e) => e.type === 'session/title'));
});

test('encrypted_content is stripped to placeholder', () => {
  const raw = [
    { type: 'goal/change', seq: 0, time: 1, data: { kind: 'goal/change', version: 1, operation: 'create', encrypted_content: 'secret', goal: { title: 'g' } } },
  ];
  const ir = buildIrFromEvents({ id: 's1', createdAt: 1 }, raw as any);
  assert.equal((ir.goals![0].data as Record<string, unknown>).encrypted_content, '[encrypted omitted]');
});

test('v3 write -> parse round-trip preserves domain buckets (DSH lossless)', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const base = fallbackIr();
  base.title = 'my-title';
  base.goals = [{ seq: 99, time: 1001, data: { kind: 'goal/change', version: 1, operation: 'create', goal: { title: 'g' } } as Record<string, unknown> }];
  base.planModes = [{ seq: 98, time: 1002, data: { enabled: true } }];
  base.todos = [{ seq: 97, time: 1003, data: { items: [{ text: 't', status: 'pending' }] } }];
  base.unmappedEvents = [{ seq: 96, time: 1000, type: 'approval/asked', data: { id: 'ask-1' } }, { seq: 95, time: 1004, type: 'session/title', data: { title: 'my-title' } }];
  const res = await adapter.write(base, { root, targetCwd: 'D:\\proj-v3' });
  const back = await adapter.parse(res.sessionId, root);
  assert.equal(back.title, 'my-title');
  assert.equal(back.goals?.length, 1);
  assert.equal(back.planModes?.length, 1);
  assert.equal(back.todos?.length, 1);
  assert.ok((back.unmappedEvents ?? []).some((e) => e.type === 'approval/asked'));
  assert.equal(back.messages.length, base.messages.length);

  // physical contract: seq contiguous + title event present
  const buf = await fs.readFile(res.paths[0]);
  const plain = decompressSessionBuffer(buf);
  const lines = plain.split('\n').filter((l) => l.trim());
  const events = lines.slice(1).map((l) => JSON.parse(l));
  events.forEach((e: DshEventLike, i: number) => assert.equal(e.seq, i, `seq[${i}] should be contiguous`));
  assert.ok(events.some((e: DshEventLike) => e.type === 'goal/change'));
  assert.ok(events.some((e: DshEventLike) => e.type === 'session/title'));
});

test('pure translator: irToEvents merges buckets by time and reassigns seq', () => {
  const ir = {
    schemaVersion: 2 as const,
    originTool: 'dsh' as const,
    messages: [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }], timestamp: 2000 },
    ],
    goals: [{ seq: 10, time: 1000, data: { kind: 'goal/change', version: 1 } as Record<string, unknown> }],
    unmappedEvents: [{ seq: 11, time: 1001, type: 'turn/start', data: { turn: 1 } }],
  };
  const events = irToEvents(ir as never, 999);
  // domain bucket (1000) should sort before message (2000)
  assert.equal(events[0].type, 'goal/change');
  assert.equal(events[1].type, 'turn/start');
  assert.equal(events[2].type, 'user/message');
  events.forEach((e, i) => assert.equal(e.seq, i));
});

test('irToEvents synthesizes session/title from ir.title when no title event exists', () => {
  const ir = {
    schemaVersion: 2 as const,
    originTool: 'dsh' as const,
    title: 'my-title',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }], timestamp: 2000 }],
  };
  const events = irToEvents(ir as never, 999);
  assert.ok(events.some((e) => e.type === 'session/title' && (e.data as Record<string, unknown>).title === 'my-title'));
  events.forEach((e, i) => assert.equal(e.seq, i));
});

test('verifySessionLog accepts a written artifact and catches corruption', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const res = await adapter.write(fallbackIr(), { root, targetCwd: 'D:\\proj-verify' });

  // written artifact must pass all layers
  const buf = await fs.readFile(res.paths[0]);
  const plain = decompressSessionBuffer(buf);
  const good = verifySessionLog(plain, res.sessionId, res.paths[0]);
  assert.equal(good.ok, true, `expected OK, issues: ${JSON.stringify(good.issues)}`);
  assert.ok(good.stats.events > 0);

  // corrupt the row envelope: packed row written as {seq,time} must be caught
  const lines = plain.split('\n').filter((l) => l.trim());
  const bad = [...lines];
  bad[1] = JSON.stringify({ seq: 0, time: 1, type: 'reasoning-chunks', data: { texts: ['x'] } });
  const badPlain = bad.join('\n');
  const badResult = verifySessionLog(badPlain, res.sessionId, res.paths[0]);
  assert.equal(badResult.ok, false);
  assert.ok(badResult.issues.some((i) => i.check === 'envelope' && i.message.includes('seq0')));

  // corrupt turn-tail: turn/start arriving AFTER an update of the same turn
  // must be caught (the hard GUI load failure)
  const bad2 = [...lines];
  bad2.splice(1, 0, JSON.stringify({ seq: 0, time: 1, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 't', arguments: '{}' } }));
  bad2.splice(2, 0, JSON.stringify({ seq: 1, time: 2, type: 'turn/start', data: { turn: 1 } }));
  for (let i = 3; i < bad2.length; i++) {
    const ev = JSON.parse(bad2[i]);
    if (ev.seq !== undefined) ev.seq = i;
    bad2[i] = JSON.stringify(ev);
  }
  const bad2Result = verifySessionLog(bad2.join('\n'), res.sessionId, res.paths[0]);
  assert.equal(bad2Result.ok, false);
  assert.ok(bad2Result.issues.some((i) => i.check === 'turn-tail' && i.message.includes('after its first update')));
});