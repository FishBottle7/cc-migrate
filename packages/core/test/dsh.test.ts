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
import { blocksToNative, normalizeContent } from '../src/content.js';
import type { ContentBlock } from '../src/ir.js';
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

test('normalizeContent/blocksToNative preserve images, attachments and thinking signatures (gaps #1/#4)', () => {
  // image blocks become FileBlocks — never '[image omitted]'
  const withImage = normalizeContent([
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'B64DATA' } },
  ]);
  assert.deepEqual(withImage, [{ type: 'file', mediaType: 'image/jpeg', data: 'B64DATA' }]);

  // tool_result content arrays keep their images as attachments
  const withAttachment = normalizeContent([
    { type: 'tool_result', tool_use_id: 't1', content: [
      { type: 'text', text: 'screenshot:' },
      { type: 'image', source: { type: 'url', url: 'https://x/img.png' } },
    ] },
  ]) as Array<{ type: string; content?: string; attachments?: Array<{ url?: string }> }>;
  assert.equal(withAttachment[0].content, 'screenshot:');
  assert.equal(withAttachment[0].attachments?.[0]?.url, 'https://x/img.png');

  // thinking signatures ride the block
  const withSig = normalizeContent([{ type: 'thinking', thinking: 'h', signature: 'sig-1' }]);
  assert.deepEqual(withSig, [{ type: 'thinking', thinking: 'h', signature: 'sig-1' }]);

  // and blocksToNative round-trips all three
  const native = blocksToNative([...withAttachment, ...withSig] as ContentBlock[]) as Array<Record<string, unknown>>;
  const toolResult = native[0] as { content: unknown; is_error?: boolean };
  assert.ok(Array.isArray(toolResult.content));
  assert.deepEqual((toolResult.content as Array<Record<string, unknown>>)[1], { type: 'image', source: { type: 'url', url: 'https://x/img.png' } });
  assert.deepEqual(native[1], { type: 'thinking', thinking: 'h', signature: 'sig-1' });
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

test('irToEvents re-points replace surfaceOps and sourceEventSeqs at the renumbered stream', () => {
  const msg = (id: string, text: string) => ({
    turn: 1,
    step: 1,
    message: { id, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text }] },
  });
  const raw = [
    { type: 'user/message', seq: 0, time: 10, surfaceOp: 'append', data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }] } },
    { type: 'assistant/message', seq: 1, time: 11, surfaceOp: 'append', data: msg('a1', 'v1') },
    // replace of assistant seq 1 with a regenerated answer
    { type: 'assistant/message', seq: 2, time: 12, surfaceOp: { op: 'replace', start: 1, end: 1 }, sourceEventSeqs: [1], data: msg('a2', 'v2') },
  ];
  const ir = buildIrFromEvents({ id: 's', createdAt: 10 }, raw as never);
  // the REPLACER surfaces as a message carrying its native op; the shadowed
  // original stays in messages[] flagged (full log preserved, fold visible)
  const a1 = ir.messages[1];
  const a2 = ir.messages[2];
  assert.equal(((a1.meta as { dsh?: { shadowed?: boolean } }).dsh)?.shadowed, true);
  assert.deepEqual(((a2.meta as { dsh?: { surfaceOp?: unknown } }).dsh)?.surfaceOp, { op: 'replace', start: 1, end: 1 });

  const events = irToEvents(ir, 10) as unknown as Array<Record<string, unknown>>;
  assert.equal(events.length, 3);
  const replaced = events[2];
  assert.equal(replaced.type, 'assistant/message');
  const rop = replaced.surfaceOp as Record<string, unknown>;
  assert.equal(rop.op, 'replace');
  // old seq 1 (assistant v1) is new seq 1 — remapped, valid, earlier than seq 2
  assert.equal(rop.start, 1);
  assert.equal(rop.end, 1);
  assert.deepEqual(replaced.sourceEventSeqs, [1]);
});

test('compacted session: shadowed span + checkpoint fold, round-trip byte-faithful', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const asst = (id: string, text: string) => ({
    turn: 1, step: 1,
    message: { id, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text }] },
  });
  const raw = [
    { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'old question' }] } },
    { type: 'assistant/message', seq: 1, time: 2, surfaceOp: 'append', data: asst('a1', 'old answer') },
    // log-only metering record for the compaction
    { type: 'compaction/summary', seq: 2, time: 3, data: { compactionId: 'c1', summary: [], shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1], shadowedTokenCount: 4321, provider: 'p', model: 'm' } },
    // the checkpoint shadows BOTH surface nodes (positions 0..1) and carries the summary
    { type: 'user/message', seq: 3, time: 4, surfaceOp: { op: 'replace', start: 0, end: 1 }, sourceEventSeqs: [2, 0, 1], data: { id: 'ck1', role: 'user', source: { kind: 'plugin', plugin: 'compact', compactionId: 'c1' }, content: [{ type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context.' }] } },
    { type: 'user/message', seq: 4, time: 5, surfaceOp: 'append', data: { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'new question' }] } },
    { type: 'assistant/message', seq: 5, time: 6, surfaceOp: 'append', data: asst('a2', 'new answer') },
  ];
  const ir = buildIrFromEvents({ id: 's', createdAt: 1 }, raw as never);
  // ALL surface messages survive (log keeps everything); compaction/summary
  // is log-only and lands in unmappedEvents.
  assert.equal(ir.messages.length, 5);
  const byId = (id: string) => ir.messages.find((m) => ((m.meta as { dsh?: { id?: string } }).dsh)?.id === id)!;
  // ...but the fold marks exactly the shadowed span
  assert.equal(((byId('u1').meta as { dsh?: { shadowed?: boolean } }).dsh)?.shadowed, true);
  assert.equal(((byId('a1').meta as { dsh?: { shadowed?: boolean } }).dsh)?.shadowed, true);
  assert.equal((byId('u2').meta as { dsh?: { shadowed?: boolean } }).dsh?.shadowed, undefined);
  assert.equal((byId('a2').meta as { dsh?: { shadowed?: boolean } }).dsh?.shadowed, undefined);
  // the checkpoint itself is a message, NOT synthetic (compaction exemption)
  assert.equal(byId('ck1').synthetic, undefined);
  // IR gap #3 compaction bucket: summary + anchor + tokensBefore from the paired metering event
  assert.equal(ir.compaction?.length, 1);
  assert.match(ir.compaction![0].summary, /automatically generated checkpoint/);
  assert.equal(ir.compaction![0].anchorIndex, ir.messages.indexOf(byId('ck1')));
  assert.equal(ir.compaction![0].tokensBefore, 4321);

  // write -> parse round-trip preserves the compacted shape byte-faithfully
  const res = await adapter.write(ir, { root, targetCwd: 'D:\\proj-compact' });
  const back = await adapter.parse(res.sessionId, root);
  assert.equal(back.messages.length, ir.messages.length);
  const backCk = back.messages.find((m) => ((m.meta as { dsh?: { id?: string } }).dsh)?.id === 'ck1')!;
  assert.deepEqual((backCk.meta as { dsh?: { surfaceOp?: unknown } }).dsh?.surfaceOp, { op: 'replace', start: 0, end: 1 });
  // sourceEventSeqs survive as the provenance SET (canonicalized sorted —
  // the fold only requires set membership over the shadowed surface nodes)
  assert.deepEqual((backCk.meta as { dsh?: { sourceEventSeqs?: number[] } }).dsh?.sourceEventSeqs, [0, 1, 2]);
  assert.equal(((back.messages.find((m) => ((m.meta as { dsh?: { id?: string } }).dsh)?.id === 'u1')!.meta as { dsh?: { shadowed?: boolean } }).dsh)?.shadowed, true);
  assert.equal(back.compaction?.length, 1);
});
test('synthetic flag: plugin-sourced injections marked, compaction checkpoints exempt', () => {
  const raw = [
    {
      type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
      data: { id: 'u1', role: 'user', source: { kind: 'user', rpcId: 'r1', clientTimeZone: 'Asia/Shanghai' }, content: [{ type: 'text', text: 'real question' }] },
    },
    {
      // runtime-context snapshot from the system-prompt plugin -> synthetic
      type: 'user/message', seq: 1, time: 2, surfaceOp: 'append',
      data: { id: 'u2', role: 'user', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' }, content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }] },
    },
    {
      // compaction checkpoint (plugin 'compact') is CONVERSATION CONTENT -> NOT synthetic
      type: 'user/message', seq: 2, time: 3, surfaceOp: 'append',
      data: { id: 'u3', role: 'user', source: { kind: 'plugin', plugin: 'compact', compactionId: 'c1' }, content: [{ type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context.' }] },
    },
  ];
  const ir = buildIrFromEvents({ id: 's', createdAt: 1 }, raw as never);
  assert.equal(ir.messages.length, 3);
  assert.equal(ir.messages[0].synthetic, undefined);
  assert.equal(ir.messages[1].synthetic, true);
  assert.equal(ir.messages[2].synthetic, undefined);
  // native source objects preserved under meta.dsh for lossless write-back
  const meta1 = (ir.messages[1].meta as { dsh?: { source?: Record<string, unknown> } })?.dsh;
  assert.equal(meta1?.source?.plugin, '@deepseek-ai/dsh-system-prompt');
});

test('write-back restores native id/source/turn/step from meta.dsh', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const sourceEvent = {
    type: 'user/message', seq: 0, time: 5, surfaceOp: 'append',
    data: { id: 'msg_orig_user', role: 'user', source: { kind: 'user', rpcId: 'rpc-77', clientTimeZone: 'Europe/Berlin' }, content: [{ type: 'text', text: 'q' }] },
  };
  const ir = buildIrFromEvents({ id: 's', createdAt: 5 }, [sourceEvent as never]);
  const res = await adapter.write(ir, { root, targetCwd: 'D:\\proj-native' });
  const buf = await fs.readFile(res.paths[0]);
  const plain = decompressSessionBuffer(buf);
  const events = plain.split('\n').filter((l) => l.trim()).slice(1).map((l) => JSON.parse(l)) as DshEventLike[];
  const user = events.find((e) => e.type === 'user/message');
  const d = user!.data as Record<string, unknown>;
  // exact id + full source object restored (previously regenerated rpcId + hardcoded tz)
  assert.equal(d.id, 'msg_orig_user');
  assert.deepEqual(d.source, { kind: 'user', rpcId: 'rpc-77', clientTimeZone: 'Europe/Berlin' });
});

test('DSH ImageBlocks project to FileBlock (dsh-attachment url) and round-trip via rawContent', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const imageAttachment = { attachmentId: 'att-123', mediaType: 'image/png', bytes: 100, width: 8, height: 8, name: 'shot.png' };
  const raw = [
    {
      type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
      data: { id: 'u-img', role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: imageAttachment }] },
    },
    {
      type: 'tool/result', seq: 1, time: 2, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { id: 't-img', role: 'user', source: { kind: 'tool', callId: 'call_1' }, content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'screenshot:' }, { type: 'image', attachment: imageAttachment }], isError: false }] } },
    },
  ];
  const ir = buildIrFromEvents({ id: 's', createdAt: 1 }, raw as never);
  // user image projected as FileBlock with attachment-store url
  const userFile = ir.messages.find((m) => m.role === 'user' && m.content.some((b) => b.type === 'file'));
  assert.ok(userFile, 'image should project to a FileBlock');
  const fb = userFile.content[0] as { url?: string; filename?: string; mediaType?: string };
  assert.equal(fb.url, 'dsh-attachment://att-123');
  assert.equal(fb.filename, 'shot.png');
  assert.equal(fb.mediaType, 'image/png');
  // tool-result interior image becomes a FileBlock attachment, not flattened text
  const toolMsg = ir.messages.find((m) => m.role === 'tool');
  const tr = toolMsg?.content[0] as { type: string; attachments?: Array<{ url?: string }> };
  assert.equal(tr.type, 'tool_result');
  assert.equal(tr.attachments?.[0]?.url, 'dsh-attachment://att-123');
  // lossless write-back: rawContent restores the original image blocks byte-faithfully
  const res = await adapter.write(ir, { root, targetCwd: 'D:\\proj-img' });
  const buf = await fs.readFile(res.paths[0]);
  const plain = decompressSessionBuffer(buf);
  const events = plain.split('\n').filter((l) => l.trim()).slice(1).map((l) => JSON.parse(l)) as DshEventLike[];
  const userEv = events.find((e) => e.type === 'user/message')!;
  const d = userEv.data as { content: Array<Record<string, unknown>> };
  assert.deepEqual(d.content[0], { type: 'image', attachment: imageAttachment });
});

test('toolCalls bucket: events typed on read, running without result, backfilled on result', () => {
  const raw = [
    {
      type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
      data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'run it' }] },
    },
    {
      type: 'assistant/message', seq: 1, time: 2, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'tool-call', id: 'call_ok', name: 'read', arguments: '{"path":"a.txt"}' }, { type: 'tool-call', id: 'call_bad', name: 'write', arguments: '{"path":"b.txt"}' }, { type: 'tool-call', id: 'call_lost', name: 'bash', arguments: '"ls"' }] } },
    },
    // call events (log-only) — typed into the bucket, NOT unmapped
    { type: 'tool/call', seq: 2, time: 3, data: { turn: 1, step: 1, callId: 'call_ok', name: 'read', arguments: '{"path":"a.txt"}' } },
    { type: 'tool/call', seq: 3, time: 4, data: { turn: 1, step: 1, callId: 'call_bad', name: 'write', arguments: '{"path":"b.txt"}' } },
    { type: 'tool/call', seq: 4, time: 5, data: { turn: 1, step: 1, callId: 'call_lost', name: 'bash', arguments: '"ls"' } },
    // results for two of them; call_lost is interrupted (no result)
    {
      type: 'tool/result', seq: 5, time: 6, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { role: 'user', source: { kind: 'tool', callId: 'call_ok' }, content: [{ type: 'tool-result', toolCallId: 'call_ok', content: [{ type: 'text', text: 'file body' }] }] } },
    },
    {
      type: 'tool/result', seq: 6, time: 7, surfaceOp: 'append',
      data: { turn: 1, step: 2, message: { role: 'user', source: { kind: 'tool', callId: 'call_bad' }, content: [{ type: 'tool-result', toolCallId: 'call_bad', content: [{ type: 'text', text: 'disk full' }], isError: true }] }, error: { name: 'WriteError', code: 'ENOSPC' } },
    },
  ];
  const ir = buildIrFromEvents({ id: 's', createdAt: 1 }, raw as never);
  assert.equal(ir.toolCalls?.length, 3);
  const byCall = (id: string) => ir.toolCalls!.find((t) => t.callId === id)!;
  // completed: output + time.end
  const ok = byCall('call_ok');
  assert.equal(ok.status, 'completed');
  assert.equal(ok.output, 'file body');
  assert.equal(ok.time?.start, 3);
  assert.equal(ok.time?.end, 6);
  assert.deepEqual(ok.input, { path: 'a.txt' });
  // error: error text + native error identity
  const bad = byCall('call_bad');
  assert.equal(bad.status, 'error');
  assert.equal(bad.error, 'disk full');
  assert.deepEqual((bad.metadata as { dsh?: { errorIdentity?: unknown } }).dsh?.errorIdentity, { name: 'WriteError', code: 'ENOSPC' });
  // interrupted call stays running — the only place it exists
  assert.equal(byCall('call_lost').status, 'running');
  // tool/call events are typed now — they must NOT also sit in unmapped
  assert.ok(!(ir.unmappedEvents ?? []).some((e) => e.type === 'tool/call'));
});

test('toolCalls write-back: running record emits a lone tool/call; native round-trip preserves raw arguments', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  // foreign-origin IR: a running invocation that has no block projection
  const ir = {
    schemaVersion: 2 as const,
    originTool: 'zcode' as const,
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'q' }], timestamp: 10 }],
    toolCalls: [{
      callId: 'call_x',
      tool: 'bash',
      status: 'running' as const,
      input: { command: 'sleep 100' },
      metadata: { dsh: { turn: 2, step: 3, seq: 7, time: 12, arguments: '{"command":"sleep 100"}' } },
    }],
  };
  const res = await adapter.write(ir as never, { root, targetCwd: 'D:\\proj-tc' });
  const buf = await fs.readFile(res.paths[0]);
  const plain = decompressSessionBuffer(buf);
  const events = plain.split('\n').filter((l) => l.trim()).slice(1).map((l) => JSON.parse(l)) as DshEventLike[];
  const calls = events.filter((e) => e.type === 'tool/call');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].data, { turn: 2, step: 3, callId: 'call_x', name: 'bash', arguments: '{"command":"sleep 100"}' });
  assert.ok(!events.some((e) => e.type === 'tool/result' && (e.data as { message?: { source?: { callId?: string } } }).message?.source?.callId === 'call_x'));
  // re-parse: the interrupted call comes back as a running bucket record
  const back = await adapter.parse(res.sessionId, root);
  assert.equal(back.toolCalls?.length, 1);
  assert.equal(back.toolCalls![0].status, 'running');
  assert.equal(back.toolCalls![0].callId, 'call_x');
});
