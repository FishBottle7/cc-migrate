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
import { readDshAttachment } from '../src/adapters/dsh/attachments.js';

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
  // surface rows are plain appends; the synthesized turn/step skeleton rows
  // (foreign-origin IR) legitimately carry no surfaceOp.
  const surface = new Set(['user/message', 'assistant/message', 'tool/result']);
  assert.ok(events.every((e) => !surface.has(e.type) || e.surfaceOp === 'append'));
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
    { type: 'turn/start', seq: 0, time: 9, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 9, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: 10, surfaceOp: 'append', data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }] } },
    { type: 'assistant/message', seq: 3, time: 11, surfaceOp: 'append', data: msg('a1', 'v1') },
    // replace of assistant seq 3 with a regenerated answer
    { type: 'assistant/message', seq: 4, time: 12, surfaceOp: { op: 'replace', start: 3, end: 3 }, sourceEventSeqs: [3], data: msg('a2', 'v2') },
  ];
  const ir = buildIrFromEvents({ id: 's', createdAt: 10 }, raw as never);
  // the REPLACER surfaces as a message carrying its native op; the shadowed
  // original stays in messages[] flagged (full log preserved, fold visible)
  const a1 = ir.messages[1];
  const a2 = ir.messages[2];
  assert.equal(((a1.meta as { dsh?: { shadowed?: boolean } }).dsh)?.shadowed, true);
  assert.deepEqual(((a2.meta as { dsh?: { surfaceOp?: unknown } }).dsh)?.surfaceOp, { op: 'replace', start: 3, end: 3 });

  const events = irToEvents(ir, 10) as unknown as Array<Record<string, unknown>>;
  assert.equal(events.length, 5);
  const replaced = events[4];
  assert.equal(replaced.type, 'assistant/message');
  const rop = replaced.surfaceOp as Record<string, unknown>;
  assert.equal(rop.op, 'replace');
  // old seq 3 (assistant v1) keeps seq 3 — the native turn/step context makes
  // the renumbering identity, so the preserved op stays valid
  assert.equal(rop.start, 3);
  assert.equal(rop.end, 3);
  assert.deepEqual(replaced.sourceEventSeqs, [3]);
});

test('compacted session: shadowed span + checkpoint fold, round-trip byte-faithful', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const asst = (id: string, text: string) => ({
    turn: 1, step: 1,
    message: { id, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text }] },
  });
  const raw = [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 0, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: 1, surfaceOp: 'append', data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'old question' }] } },
    { type: 'assistant/message', seq: 3, time: 2, surfaceOp: 'append', data: asst('a1', 'old answer') },
    // log-only metering record for the compaction
    { type: 'compaction/summary', seq: 4, time: 3, data: { compactionId: 'c1', summary: [], shadowedRange: { start: 2, end: 3 }, shadowedSeqs: [2, 3], shadowedTokenCount: 4321, provider: 'p', model: 'm' } },
    // the checkpoint shadows BOTH surface nodes (positions 2..3) and carries the summary
    { type: 'user/message', seq: 5, time: 4, surfaceOp: { op: 'replace', start: 2, end: 3 }, sourceEventSeqs: [4, 2, 3], data: { id: 'ck1', role: 'user', source: { kind: 'plugin', plugin: 'compact', compactionId: 'c1' }, content: [{ type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context.' }] } },
    { type: 'user/message', seq: 6, time: 5, surfaceOp: 'append', data: { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'new question' }] } },
    { type: 'assistant/message', seq: 7, time: 6, surfaceOp: 'append', data: asst('a2', 'new answer') },
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
  assert.deepEqual((backCk.meta as { dsh?: { surfaceOp?: unknown } }).dsh?.surfaceOp, { op: 'replace', start: 2, end: 3 });
  // sourceEventSeqs survive as the provenance SET (canonicalized sorted —
  // the fold only requires set membership over the shadowed surface nodes)
  assert.deepEqual((backCk.meta as { dsh?: { sourceEventSeqs?: number[] } }).dsh?.sourceEventSeqs, [2, 3, 4]);
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

test('synthetic flag: every non-human source kind is injected (round-2 taxonomy)', () => {
  const msg = (id: string, source: Record<string, unknown>, text: string) => ({
    type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
    data: { id, role: 'user', source, content: [{ type: 'text', text }] },
  });
  const raw = [
    // skill catalog <system-reminder> (the <available_skills> block) — injected
    msg('a', { kind: 'skill-catalog', form: 'catalog', entries: [] }, '<available_skills>…</available_skills>'),
    // loaded <skill_content> block — injected
    msg('b', { kind: 'skill-invocation', name: 'find-skills', form: 'instructions' }, '<skill_content>…</skill_content>'),
    // AGENTS.md injections — injected
    msg('c', { kind: 'agent-instructions', form: 'instructions', changes: [] }, '# AGENTS.md instructions'),
    // goal continuation round — injected
    msg('d', { kind: 'goal', goalId: 'g1', revision: 2, round: 3 }, 'continue round 3'),
    // subagent lifecycle relay — injected
    msg('e', { kind: 'subagent-settled', form: 'notice', summary: 'child done', senderSessionId: 's1' }, 'child done'),
    msg('f', { kind: 'subagent-report', form: 'relay', senderSessionId: 's1' }, 'child report'),
    // multi-agent coordinator relay — injected
    msg('g', { kind: 'coordinator', form: 'relay', senderSessionId: 's2' }, 'teammate message'),
  ];
  const ir = buildIrFromEvents({ id: 's', createdAt: 1 }, raw as never);
  assert.equal(ir.messages.length, 7);
  for (const [i, m] of ir.messages.entries()) {
    assert.equal(m.synthetic, true, `message #${i} (${(m.content[0] as { text?: string })?.text?.slice(0, 20)}) should be synthetic`);
  }
  // a source-less user/message stays non-synthetic (never drop what cannot be classified)
  const noSource = buildIrFromEvents({ id: 's', createdAt: 1 }, [
    { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: { id: 'x', role: 'user', content: [{ type: 'text', text: 'no source' }] } },
  ] as never);
  assert.equal(noSource.messages[0].synthetic, undefined);
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

/* ------------------------------------------------------------------ */
/* 第二轮盘点 (2026-08-29): headerRaw / usage / interrupted /          */
/* tool-result error+meta / 嵌套子代理 / 防覆盖 / 列表标题 / 附件       */
/* ------------------------------------------------------------------ */

test('write consumes meta.dsh.headerRaw: subagent header fields ride through verbatim', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const events: DshEventLike[] = [
    { seq: 0, type: 'user/message', surfaceOp: 'append', time: 1, data: { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'child prompt' }] } },
  ];
  const ir = buildIrFromEvents(
    { id: 'src-child', createdAt: 1000, cwd: 'D:\\src', parentSession: 'src-parent', delegationDepth: 2, origin: 'subagent', agentPreset: 'explore', seedLength: 5 } as never,
    events as never,
  );
  const res = await adapter.write(ir, { root, sessionId: 'child-new', targetCwd: 'D:\\proj' });
  const buf = await fs.readFile(res.paths[0]);
  const header = JSON.parse(decompressSessionBuffer(buf).split('\n')[0]);
  assert.equal(header.id, 'child-new');
  assert.equal(header.cwd, 'D:\\proj');
  assert.equal(header.delegationDepth, 2, 'source delegationDepth preserved');
  assert.equal(header.origin, 'subagent');
  assert.equal(header.agentPreset, 'explore');
  assert.equal(header.seedLength, 5);
  assert.equal(header.parentSession, 'src-parent', 'standalone migration keeps the source parent link verbatim');
  assert.equal(header.version, 0);
});

test('assistant/message usage + interrupted round-trip via meta.dsh', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const events: DshEventLike[] = [
    { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
    { seq: 1, type: 'user/message', surfaceOp: 'append', time: 2, data: { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }] } },
    {
      seq: 2, type: 'assistant/message', surfaceOp: 'append', time: 3,
      data: { turn: 1, step: 1, interrupted: true, usage: { inputTokens: 10296, outputTokens: 212, cacheReadTokens: 1792 }, message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'partial' }] } },
    },
  ];
  const ir = buildIrFromEvents({ id: 's1', createdAt: 1 }, events as never);
  const native = (ir.messages[1].meta as { dsh?: { usage?: unknown; interrupted?: unknown } }).dsh;
  assert.deepEqual(native?.usage, { inputTokens: 10296, outputTokens: 212, cacheReadTokens: 1792 });
  assert.equal(native?.interrupted, true);
  const res = await adapter.write(ir, { root, targetCwd: 'D:\\proj' });
  const buf = await fs.readFile(res.paths[0]);
  const events2 = decompressSessionBuffer(buf).split('\n').filter((l) => l.trim()).slice(1).map((l) => JSON.parse(l)) as DshEventLike[];
  const asst = events2.find((e) => e.type === 'assistant/message')!;
  assert.deepEqual((asst.data as { usage?: unknown }).usage, { inputTokens: 10296, outputTokens: 212, cacheReadTokens: 1792 });
  assert.equal((asst.data as { interrupted?: unknown }).interrupted, true);
  // double round-trip: the next parse keeps them again
  const ir2 = buildIrFromEvents({ id: 's1', createdAt: 1 }, events2 as never);
  assert.equal(((ir2.messages[1].meta as { dsh?: { interrupted?: unknown } }).dsh)?.interrupted, true);
});

test('tool/result event-level error + meta round-trip via meta.dsh', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const resultMeta = { diff: '--- a/f.ts\n+++ b/f.ts' };
  const events: DshEventLike[] = [
    { seq: 0, type: 'tool/call', time: 1, data: { turn: 1, step: 1, callId: 'call_1', name: 'edit', arguments: '{}' } },
    {
      seq: 1, type: 'tool/result', surfaceOp: 'append', time: 2,
      data: { turn: 1, step: 1, error: { name: 'EditError', code: 'E_CONFLICT' }, meta: resultMeta, message: { id: 't1', role: 'user', source: { kind: 'tool', callId: 'call_1' }, content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'boom' }], isError: true }] } },
    },
  ];
  const ir = buildIrFromEvents({ id: 's1', createdAt: 1 }, events as never);
  const toolMsg = ir.messages.find((m) => m.role === 'tool')!;
  const native = (toolMsg.meta as { dsh?: { resultError?: unknown; resultMeta?: unknown } }).dsh;
  assert.deepEqual(native?.resultError, { name: 'EditError', code: 'E_CONFLICT' });
  assert.deepEqual(native?.resultMeta, resultMeta);
  const res = await adapter.write(ir, { root, targetCwd: 'D:\\proj' });
  const buf = await fs.readFile(res.paths[0]);
  const events2 = decompressSessionBuffer(buf).split('\n').filter((l) => l.trim()).slice(1).map((l) => JSON.parse(l)) as DshEventLike[];
  const tr = events2.find((e) => e.type === 'tool/result')!;
  assert.deepEqual((tr.data as { error?: unknown }).error, { name: 'EditError', code: 'E_CONFLICT' });
  assert.deepEqual((tr.data as { meta?: unknown }).meta, resultMeta);
});

test('nested subagent tree: grandchildren collected, full buckets, written with remapped parent links', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const childEvents: DshEventLike[] = [
    { seq: 0, type: 'tool/call', time: 1, data: { turn: 1, step: 1, callId: 'c9', name: 'read', arguments: '{"p":"x"}' } },
    { seq: 1, type: 'user/message', surfaceOp: 'append', time: 2, data: { id: 'cm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'child work' }] } },
    { seq: 2, type: 'todo/write', time: 3, data: { todos: ['a'] } },
  ];
  const childIr = buildIrFromEvents(
    { id: 'child-src', createdAt: 10, parentSession: 'parent-src', origin: 'subagent', delegationDepth: 1, agentPreset: 'explore', seedLength: 2 } as never,
    childEvents as never,
  );
  await adapter.write(childIr, { root, sessionId: 'child-src', targetCwd: 'D:\\proj' });
  const grandEvents: DshEventLike[] = [
    { seq: 0, type: 'user/message', surfaceOp: 'append', time: 2, data: { id: 'gm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'grandchild work' }] } },
  ];
  const grandIr = buildIrFromEvents(
    { id: 'grand-src', createdAt: 20, parentSession: 'child-src', origin: 'subagent', delegationDepth: 2, agentPreset: 'deep' } as never,
    grandEvents as never,
  );
  await adapter.write(grandIr, { root, sessionId: 'grand-src', targetCwd: 'D:\\proj' });
  const parentEvents: DshEventLike[] = [
    { seq: 0, type: 'user/message', surfaceOp: 'append', time: 1, data: { id: 'pm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'parent' }] } },
  ];
  const parentIrSrc = buildIrFromEvents({ id: 'parent-src', createdAt: 5 } as never, parentEvents as never);
  await adapter.write(parentIrSrc, { root, sessionId: 'parent-src', targetCwd: 'D:\\proj' });

  const parsed = await adapter.parse('parent-src', root);
  assert.equal(parsed.sidechains?.length, 1);
  const sc = parsed.sidechains![0];
  assert.equal(sc.agentId, 'child-src');
  assert.equal(sc.agentType, 'explore');
  assert.equal(sc.toolCalls?.length, 1, 'child toolCalls bucket filled');
  assert.deepEqual(sc.toolCalls![0].input, { p: 'x' });
  assert.equal(sc.todos?.length, 1, 'child todos bucket filled');
  assert.equal((sc.meta as { dsh?: { headerRaw?: { delegationDepth?: number } } }).dsh?.headerRaw?.delegationDepth, 1);
  assert.equal(sc.sidechains?.length, 1, 'grandchild nested');
  assert.equal(sc.sidechains![0].agentId, 'grand-src');
  assert.equal(sc.sidechains![0].agentType, 'deep');

  // write back: the source child/grandchild paths are occupied by the SOURCE
  // logs (they were written above into the same root+cwd), so both land on
  // fresh ids — linkage/depth/buckets must still hold on the fresh copies.
  const res = await adapter.write(parsed, { root, sessionId: 'parent-new', targetCwd: 'D:\\proj' });
  assert.ok(res.paths.length >= 3, 'parent + child + grandchild written');
  const projDir = join(root, '--D-proj--');
  const readHeader = async (dir: string): Promise<Record<string, unknown>> =>
    JSON.parse(decompressSessionBuffer(await fs.readFile(join(projDir, dir, 'session.jsonl.zstd'))).split('\n')[0]);
  // source logs untouched
  assert.equal((await readHeader('child-src')).parentSession, 'parent-src');
  const dirs = await fs.readdir(projDir);
  const headers = new Map<string, Record<string, unknown>>();
  for (const d of dirs) headers.set(d, await readHeader(d));
  const freshChild = [...headers.entries()].find(([, h]) => h.parentSession === 'parent-new');
  assert.ok(freshChild, 'fresh child dir written and relinked to written parent');
  const [childDir, childHeader] = freshChild;
  assert.notEqual(childDir, 'child-src');
  assert.equal(childHeader.delegationDepth, 1);
  assert.equal(childHeader.agentPreset, 'explore');
  const grand = [...headers.entries()].find(([d, h]) => d !== childDir && h.parentSession === childDir);
  assert.ok(grand, 'grandchild parentSession remapped to the fresh child id');
  assert.equal(grand[1].delegationDepth, 2);
  assert.equal(grand[1].agentPreset, 'deep');
  // full circle: the written parent parses back with the nested tree + buckets
  const reparsed = await adapter.parse('parent-new', root);
  assert.equal(reparsed.sidechains?.length, 1);
  assert.equal(reparsed.sidechains![0].toolCalls?.length, 1);
  assert.equal(reparsed.sidechains![0].sidechains?.length, 1);
});

test('write never clobbers an existing child log at the same path (fresh id on collision)', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const childEvents: DshEventLike[] = [
    { seq: 0, type: 'user/message', surfaceOp: 'append', time: 2, data: { id: 'cm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'child work' }] } },
  ];
  const childIr = buildIrFromEvents({ id: 'child-1', createdAt: 10, parentSession: 'p1', origin: 'subagent', delegationDepth: 1 } as never, childEvents as never);
  await adapter.write(childIr, { root, sessionId: 'child-1', targetCwd: 'D:\\proj' });
  const originalChild = await fs.readFile(join(root, '--D-proj--', 'child-1', 'session.jsonl.zstd'));

  const parentEvents: DshEventLike[] = [
    { seq: 0, type: 'user/message', surfaceOp: 'append', time: 1, data: { id: 'pm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'parent' }] } },
  ];
  const parsed = buildIrFromEvents({ id: 'p1', createdAt: 5 } as never, parentEvents as never);
  parsed.sidechains = [{
    agentId: 'child-1',
    kind: 'subagent',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'child work' }] }],
    meta: { dsh: { headerRaw: { version: 0, id: 'child-1', createdAt: 10, parentSession: 'p1', origin: 'subagent', delegationDepth: 1 } } },
  }];
  const res = await adapter.write(parsed, { root, sessionId: 'p1-new', targetCwd: 'D:\\proj' });
  // source child log untouched; the migrated child landed on a fresh id
  assert.deepEqual(await fs.readFile(join(root, '--D-proj--', 'child-1', 'session.jsonl.zstd')), originalChild);
  const projDir = join(root, '--D-proj--');
  const others = (await fs.readdir(projDir)).filter((d) => d !== 'child-1' && d !== 'p1-new');
  assert.equal(others.length, 1, 'exactly one fresh child dir');
  const freshHeader = JSON.parse(decompressSessionBuffer(await fs.readFile(join(projDir, others[0], 'session.jsonl.zstd'))).split('\n')[0]);
  assert.notEqual(freshHeader.id, 'child-1');
  assert.equal(freshHeader.parentSession, 'p1-new');
  assert.ok(res.paths.some((p) => p.includes(others[0])));
});

test('listSessions: title from projcache, log-scan fallback, archived flag, _no-cwd', async () => {
  const adapter = new DshAdapter();
  const tmp = await fs.mkdtemp(join(tmpdir(), 'sm-dsh-list-'));
  const root = join(tmp, 'sessions');
  const storages = join(tmp, 'storages');
  await fs.mkdir(storages, { recursive: true });

  // session A: title only in the log (e.g. a migrated session DSH never opened)
  const irA = { schemaVersion: 2 as const, originTool: 'dsh' as const, title: 'Logged Title', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'a' }] }] };
  const resA = await adapter.write(irA as never, { root, sessionId: 'sess-a', targetCwd: 'D:\\proj' });
  void resA;
  // session B: title only in projcache
  const irB = { schemaVersion: 2 as const, originTool: 'dsh' as const, messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'b' }] }] };
  await adapter.write(irB as never, { root, sessionId: 'sess-b', targetCwd: 'D:\\proj' });
  // session C: cwd-less (_no-cwd project dir)
  const irC = { schemaVersion: 2 as const, originTool: 'dsh' as const, messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'c' }] }] };
  await adapter.write(irC as never, { root, sessionId: 'sess-c', targetCwd: '' });
  await fs.writeFile(
    join(storages, 'session_projcache.json'),
    JSON.stringify({ unit: { name: 'session_projcache', version: 3 }, global: null, tables: { sessions: { 'sess-b': { rows: { title: { ver: 1, seq: 1, val: 'Cached Title' } } } } } }),
  );
  await fs.writeFile(
    join(storages, 'workspace.json'),
    JSON.stringify({ global: { archivedSessionIds: ['sess-b'] }, tables: { workspaces: {} } }),
  );

  const metas = await adapter.listSessions(root);
  const byId = new Map(metas.map((m) => [m.sessionId, m]));
  assert.equal(byId.get('sess-a')?.title, 'Logged Title', 'title scanned from log when projcache misses');
  assert.equal(byId.get('sess-b')?.title, 'Cached Title', 'title from projcache wins');
  assert.equal(byId.get('sess-b')?.archived, true, 'archive state from workspace.json');
  assert.equal(byId.get('sess-a')?.archived, undefined);
  assert.ok(byId.has('sess-c'), '_no-cwd sessions are listed');
  assert.equal(byId.get('sess-c')?.cwd, undefined, '_no-cwd has no cwd hint');
  assert.equal(byId.get('sess-a')?.cwd, 'D:\\proj', 'cwd is the real header value, not the project-key skeleton');
});

test('readDshAttachment resolves content-addressed bytes (sha256: ref and bare hex)', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'sm-dsh-att-'));
  const hash = 'ab'.repeat(32);
  const objPath = join(root, 'objects', 'ab', hash);
  await fs.mkdir(join(root, 'objects', 'ab'), { recursive: true });
  await fs.writeFile(objPath, 'PNGBYTES');
  assert.deepEqual(await readDshAttachment(`sha256:${hash}`, root), Buffer.from('PNGBYTES'));
  assert.deepEqual(await readDshAttachment(hash, root), Buffer.from('PNGBYTES'));
  assert.equal(await readDshAttachment('sha256:' + 'cd'.repeat(32), root), null, 'missing object -> null');
  assert.equal(await readDshAttachment('not-a-hash', root), null, 'malformed id -> null');
});

test('write drops a non-absolute cwd (encoded dir-name skeleton) instead of writing an unloadable header', async () => {
  // Regression: DSH validates header.cwd with path.isAbsolute and refuses the
  // whole session ("session header cwd must be an absolute path"). A listing
  // projection like "D-codes-foo" used to ride into the header verbatim.
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const ir = { schemaVersion: 2 as const, originTool: 'dsh' as const, messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'x' }] }] };
  const res = await adapter.write(ir as never, { root, sessionId: 'skel-1', targetCwd: 'D-codes-dshPlugins-opencode2dsh' });
  assert.ok(res.paths[0]!.includes('_no-cwd'), 'session lands in _no-cwd, not in a bogus project dir');
  const header = JSON.parse(decompressSessionBuffer(await fs.readFile(res.paths[0]!)).split('\n')[0]);
  assert.equal(header.cwd, undefined, 'header carries no cwd at all');
  assert.equal(header.version, 0);
  // parse back fine
  const back = await adapter.parse('skel-1', root);
  assert.equal(back.messages.length, 1);
});

test('foreign-origin IR gets a turn/start + step/start skeleton (DSH assembler requires the start match)', async () => {
  // DSH's conversation assembler treats assistant/message as an update of the
  // `assistant-step` context whose only start is step/start {turn,step} —
  // without it the assistant content never renders. claude/codex/… IRs have
  // no such events, so irToEvents synthesizes them.
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const ir = {
    schemaVersion: 2 as const,
    originTool: 'claude' as const,
    createdAt: 1000,
    messages: [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'hello' }] },
    ],
  };
  const res = await adapter.write(ir as never, { root, sessionId: 'skel-2', targetCwd: 'D:\\proj' });
  const events = decompressSessionBuffer(await fs.readFile(res.paths[0]!)).split('\n').filter((l) => l.trim()).slice(1).map((l) => JSON.parse(l)) as Array<{ seq: number; type: string; data: Record<string, unknown> }>;
  const ai = events.findIndex((e) => e.type === 'assistant/message');
  assert.ok(ai > 0, 'assistant message present');
  const before = events.slice(0, ai).map((e) => e.type);
  assert.ok(before.includes('turn/start'), 'turn/start precedes the assistant message');
  assert.ok(before.includes('step/start'), 'step/start precedes the assistant message');
  assert.equal(events.filter((e) => e.type === 'turn/start').length, 1, 'exactly one turn/start (no duplicate start match)');
  assert.equal(events.filter((e) => e.type === 'step/start').length, 1, 'exactly one step/start');
  const stepStart = events.find((e) => e.type === 'step/start');
  assert.deepEqual(stepStart?.data, { turn: 1, step: 1 });
  const assistant = events[ai];
  assert.equal(assistant.data.turn, 1, 'assistant carries explicit turn');
  assert.equal(assistant.data.step, 1, 'assistant carries explicit step');
  // seq contiguity over the expanded stream
  events.forEach((e, i) => assert.equal(e.seq, i, 'seq stays contiguous 0..n-1'));
});

test('dsh->dsh native turn/start + step/start are not duplicated by the skeleton pass', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const events: DshEventLike[] = [
    { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
    { seq: 1, type: 'step/start', time: 2, data: { turn: 1, step: 1 } },
    { seq: 2, type: 'user/message', surfaceOp: 'append', time: 3, data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }] } },
    { seq: 3, type: 'assistant/message', surfaceOp: 'append', time: 4, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'a' }] } } },
  ];
  const ir = buildIrFromEvents({ id: 'src-skel', createdAt: 1 } as never, events as never);
  const res = await adapter.write(ir, { root, sessionId: 'skel-3', targetCwd: 'D:\\proj' });
  const written = decompressSessionBuffer(await fs.readFile(res.paths[0]!)).split('\n').filter((l) => l.trim()).slice(1).map((l) => JSON.parse(l)) as Array<{ type: string }>;
  assert.equal(written.filter((e) => e.type === 'turn/start').length, 1, 'native turn/start kept, no synthesized twin');
  assert.equal(written.filter((e) => e.type === 'step/start').length, 1, 'native step/start kept, no synthesized twin');
  const turnIdx = written.findIndex((e) => e.type === 'turn/start');
  const stepIdx = written.findIndex((e) => e.type === 'step/start');
  const ai = written.findIndex((e) => e.type === 'assistant/message');
  assert.ok(turnIdx < stepIdx && stepIdx < ai, 'native order preserved');
});

test('write drops foreign unmapped events (unknown types make DSH refuse the whole log)', async () => {
  // DSH's assertEventsSupported refuses a WHOLE log containing any event type
  // outside KNOWN_SESSION_EVENT_TYPES, and its envelope allowlist
  // (assertSessionEventEnvelope) rejects extra keys — there is no per-row skip
  // marker to save unknown types with. codex event_msg rows (task_started,
  // token_count, ...) riding IR unmappedEvents must therefore be DROPPED on
  // write, while known non-surface types (approval/asked, ...) replay verbatim.
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const ir = {
    schemaVersion: 2 as const,
    originTool: 'codex' as const,
    createdAt: 1000,
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'q' }] }],
    unmappedEvents: [
      { seq: 1, time: 1001, type: 'task_started', data: { turn_id: 't1' } },
      { seq: 2, time: 1002, type: 'token_count', data: { info: { total: 42 } } },
      { seq: 3, time: 1003, type: 'approval/asked', data: { kind: 'bash' } },
    ],
  };
  const res = await adapter.write(ir as never, { root, sessionId: 'ign-1', targetCwd: 'D:\\proj' });
  const events = decompressSessionBuffer(await fs.readFile(res.paths[0]!)).split('\n').filter((l) => l.trim()).slice(1).map((l) => JSON.parse(l)) as Array<{ type: string }>;
  assert.equal(events.some((e) => e.type === 'task_started'), false, 'foreign task_started dropped');
  assert.equal(events.some((e) => e.type === 'token_count'), false, 'foreign token_count dropped');
  assert.ok(events.some((e) => e.type === 'approval/asked'), 'known non-surface type replayed');
  assert.ok(events.every((e) => !('ignorable' in e)), 'no envelope carries an ignorable key');
  const verdict = verifySessionLog(decompressSessionBuffer(await fs.readFile(res.paths[0]!)), 'ign-1', res.paths[0]!);
  assert.ok(verdict.ok, `verifySessionLog passes: ${JSON.stringify(verdict.issues ?? []).slice(0, 200)}`);
});

test('foreign-origin message shapes: tool_use pairs a tool/call, injections go plugin-source, empty assistant rows dropped', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const ir = {
    schemaVersion: 2 as const,
    originTool: 'codex' as const,
    createdAt: 1000,
    messages: [
      // developer harness instructions -> plugin-sourced user/message
      { role: 'developer' as const, content: [{ type: 'text' as const, text: '<permissions instructions>…' }] },
      // synthetic user injection -> plugin-sourced user/message
      { role: 'user' as const, synthetic: true, content: [{ type: 'text' as const, text: '<environment_context>…' }] },
      // real user turn
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'q' }] },
      // assistant carrying a tool_use block -> emits the paired tool/call event
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'call_x1', name: 'exec', input: 'do()' }] },
      // reasoning-only assistant (no durable content) -> dropped
      { role: 'assistant' as const, content: [] },
      { role: 'tool' as const, content: [{ type: 'tool_result' as const, toolUseId: 'call_x1', content: 'ok' }] },
    ],
  };
  const res = await adapter.write(ir as never, { root, sessionId: 'shape-1', targetCwd: 'D:\\proj' });
  const events = decompressSessionBuffer(await fs.readFile(res.paths[0]!)).split('\n').filter((l) => l.trim()).slice(1).map((l) => JSON.parse(l)) as Array<{ type: string; data: Record<string, unknown> }>;
  const tc = events.find((e) => e.type === 'tool/call');
  assert.ok(tc, 'tool/call event emitted for the tool_use block');
  assert.equal((tc.data as Record<string, unknown>).callId, 'call_x1');
  assert.equal((tc.data as Record<string, unknown>).name, 'exec');
  assert.equal((tc.data as Record<string, unknown>).arguments, 'do()');
  const trIdx = events.findIndex((e) => e.type === 'tool/result');
  const tcIdx = events.indexOf(tc);
  assert.ok(tcIdx < trIdx, 'tool/call precedes its tool/result');
  const sources = events.filter((e) => e.type === 'user/message').map((e) => (e.data as Record<string, unknown>).source as Record<string, unknown>);
  assert.equal(sources[0]?.kind, 'plugin', 'developer instructions are plugin-sourced injections');
  assert.equal(sources[1]?.kind, 'plugin', 'synthetic user rows are plugin-sourced injections');
  assert.equal(sources[2]?.kind, 'user', 'the real user turn stays human');
  assert.equal(events.filter((e) => e.type === 'assistant/message').length, 1, 'empty assistant row dropped, content row kept');
  const verdict = verifySessionLog(decompressSessionBuffer(await fs.readFile(res.paths[0]!)), 'shape-1', res.paths[0]!);
  assert.ok(verdict.ok, `verifySessionLog passes: ${JSON.stringify(verdict.issues ?? []).slice(0, 200)}`);
});

test('dsh->dsh: unknown-to-DSH source types are dropped, known types replay verbatim', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const events: DshEventLike[] = [
    { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
    { seq: 1, type: 'user/message', surfaceOp: 'append', time: 2, data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }] } },
    { seq: 2, type: 'approval/asked', time: 3, data: { kind: 'bash' } },
    { seq: 3, type: 'future/thing', time: 4, data: { hint: 'written by a newer harness' } },
  ];
  const ir = buildIrFromEvents({ id: 'src-ign', createdAt: 1 } as never, events as never);
  assert.ok(ir.unmappedEvents?.some((e) => e.type === 'approval/asked'), 'known type archived to unmappedEvents');
  assert.ok(ir.unmappedEvents?.some((e) => e.type === 'future/thing'), 'unknown type archived too (read side keeps everything)');
  const res = await adapter.write(ir, { root, sessionId: 'ign-2', targetCwd: 'D:\\proj' });
  const written = decompressSessionBuffer(await fs.readFile(res.paths[0]!)).split('\n').filter((l) => l.trim()).slice(1).map((l) => JSON.parse(l)) as Array<{ type: string }>;
  assert.ok(written.some((e) => e.type === 'approval/asked'), 'known non-surface type survives dsh->dsh');
  assert.equal(written.some((e) => e.type === 'future/thing'), false, 'unknown type dropped (would refuse DSH load)');
  const verdict = verifySessionLog(decompressSessionBuffer(await fs.readFile(res.paths[0]!)), 'ign-2', res.paths[0]!);
  assert.ok(verdict.ok, `verifySessionLog passes: ${JSON.stringify(verdict.issues ?? []).slice(0, 200)}`);
});

test('claude-style user tool_result carriers project as paired tool/results; orphan results are dropped', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const ir = {
    schemaVersion: 2 as const,
    originTool: 'claude' as const,
    createdAt: 1000,
    messages: [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'run it' }] },
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'callu_1', name: 'bash', input: 'ls' }] },
      // Anthropic shape: the result rides a USER message as a tool_result block
      { role: 'user' as const, content: [{ type: 'tool_result' as const, toolUseId: 'callu_1', content: 'file-a\nfile-b' }] },
      // orphan result: no tool/call exists for this id — emitting it would render
      // as a ghost "Tool call <callId>" fallback card
      { role: 'tool' as const, content: [{ type: 'tool_result' as const, toolUseId: 'call_missing', content: 'lost' }] },
    ],
  };
  const res = await adapter.write(ir as never, { root, sessionId: 'carrier-1', targetCwd: 'D:\\proj' });
  const events = decompressSessionBuffer(await fs.readFile(res.paths[0]!)).split('\n').filter((l) => l.trim()).slice(1).map((l) => JSON.parse(l)) as Array<{ type: string; data: Record<string, unknown> }>;
  const results = events.filter((e) => e.type === 'tool/result');
  assert.equal(results.length, 1, 'the user-carried tool_result becomes exactly one tool/result event');
  const msg = (results[0].data as Record<string, unknown>).message as Record<string, unknown>;
  const src = msg.source as Record<string, unknown>;
  assert.equal(src.kind, 'tool');
  assert.equal(src.callId, 'callu_1');
  const userRows = events.filter((e) => e.type === 'user/message');
  assert.equal(userRows.length, 1, 'the carrier user row does not render as a human turn');
  assert.ok(!JSON.stringify(userRows[0].data).includes('file-a'), 'tool output is not user speech');
  assert.ok(!events.some((e) => JSON.stringify(e.data).includes('call_missing')), 'orphan result not emitted');
  const verdict = verifySessionLog(decompressSessionBuffer(await fs.readFile(res.paths[0]!)), 'carrier-1', res.paths[0]!);
  assert.ok(verdict.ok, `verifySessionLog passes: ${JSON.stringify(verdict.issues ?? []).slice(0, 200)}`);
});

test('verifySessionLog flags an orphan tool/result as a tool-pairing issue', () => {
  const plain = [
    JSON.stringify({ type: 'session', version: 0, id: 'v-ghost', createdAt: 1, cwd: 'D:\\\\x' }),
    JSON.stringify({ seq: 0, time: 1, type: 'tool/result', surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'm1', role: 'user', source: { kind: 'tool', callId: 'call_ghost' }, content: [{ type: 'tool-result', toolCallId: 'call_ghost', content: [{ type: 'text', text: 'x' }] }] } } }),
  ].join('\n') + '\n';
  const verdict = verifySessionLog(plain, 'v-ghost', 'mem');
  assert.equal(verdict.ok, false);
  assert.ok(verdict.issues.some((i) => i.check === 'tool-pairing'), `tool-pairing issue raised: ${JSON.stringify(verdict.issues)}`);
  // the paired variant is clean
  const paired = [
    JSON.stringify({ type: 'session', version: 0, id: 'v-pair', createdAt: 1, cwd: 'D:\\\\x' }),
    JSON.stringify({ seq: 0, time: 1, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call_ok', name: 'bash', arguments: '{}' } }),
    JSON.stringify({ seq: 1, time: 2, type: 'tool/result', surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'm1', role: 'user', source: { kind: 'tool', callId: 'call_ok' }, content: [{ type: 'tool-result', toolCallId: 'call_ok', content: [{ type: 'text', text: 'x' }] }] } } }),
  ].join('\n') + '\n';
  const ok = verifySessionLog(paired, 'v-pair', 'mem');
  assert.ok(ok.ok, `paired log passes: ${JSON.stringify(ok.issues)}`);
});

/* ------------------------------------------------------------------ */
/* P1-A 回归：子 sidechain cwd 解析（sc.cwd > headerRaw.cwd > 父 cwd）    */
/* ------------------------------------------------------------------ */
test('child sidechain cwd: sc.cwd wins over parent cwd (own project dir + header)', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const ir = {
    schemaVersion: 2 as const,
    originTool: 'dsh' as const,
    createdAt: 1000,
    messages: [{ role: 'user' as const, timestamp: 1000, content: [{ type: 'text' as const, text: 'parent' }] }],
    sidechains: [{
      agentId: 'child-own-cwd',
      kind: 'subagent' as const,
      // IR 槽位（ir.ts MigratedSidechain.cwd）携带子会话自己的 cwd
      cwd: 'D:\\child-wt',
      messages: [{ role: 'user' as const, timestamp: 1001, content: [{ type: 'text' as const, text: 'child' }] }],
      meta: { dsh: { headerRaw: { version: 0, id: 'child-own-cwd', createdAt: 10, origin: 'subagent', delegationDepth: 1 } } },
    }],
  };
  const res = await adapter.write(ir as never, { root, sessionId: 'cwd-sc', targetCwd: 'D:\\proj' });
  // 子会话落在「子 cwd」自己的 project dir 下，不是父的
  const childPath = res.paths.find((p) => p.includes('child-own-cwd'))!;
  assert.ok(childPath.includes('--D-child-wt--'), 'child session lands under its OWN cwd project dir');
  const header = JSON.parse(decompressSessionBuffer(await fs.readFile(childPath)).split('\n')[0]);
  assert.equal(header.cwd, 'D:\\child-wt', 'child header.cwd is the sidechain cwd, not the parent override');
  // 父会话不受影响（仍在父 project dir）
  assert.ok(res.paths[0]!.includes('--D-proj--'), 'parent stays in its own project dir');
});

test('child sidechain cwd: headerRaw.cwd is the fallback when sc.cwd is absent', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const ir = {
    schemaVersion: 2 as const,
    originTool: 'dsh' as const,
    createdAt: 1000,
    messages: [{ role: 'user' as const, timestamp: 1000, content: [{ type: 'text' as const, text: 'parent' }] }],
    sidechains: [{
      agentId: 'child-hdr-cwd',
      kind: 'subagent' as const,
      messages: [{ role: 'user' as const, timestamp: 1001, content: [{ type: 'text' as const, text: 'child' }] }],
      // 无 sc.cwd——独立迁移子会话时 headerRaw 里保真的 cwd 兜底
      meta: { dsh: { headerRaw: { version: 0, id: 'child-hdr-cwd', createdAt: 10, origin: 'subagent', delegationDepth: 1, cwd: 'D:\\hdr-wt' } } },
    }],
  };
  const res = await adapter.write(ir as never, { root, sessionId: 'cwd-hdr', targetCwd: 'D:\\proj' });
  const childPath = res.paths.find((p) => p.includes('child-hdr-cwd'))!;
  const header = JSON.parse(decompressSessionBuffer(await fs.readFile(childPath)).split('\n')[0]);
  assert.equal(header.cwd, 'D:\\hdr-wt', 'headerRaw.cwd used when sc.cwd is absent');
  assert.ok(childPath.includes('--D-hdr-wt--'), 'child lands under the headerRaw cwd project dir');
});

test('child sidechain cwd: non-absolute candidates fall back to the parent cwd', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const ir = {
    schemaVersion: 2 as const,
    originTool: 'dsh' as const,
    createdAt: 1000,
    messages: [{ role: 'user' as const, timestamp: 1000, content: [{ type: 'text' as const, text: 'parent' }] }],
    sidechains: [{
      agentId: 'child-skel',
      kind: 'subagent' as const,
      // 列表投影的编码骨架（非绝对）——绝不能进 header（DSH isAbsolute 拒载）
      cwd: 'D-codes-someproj',
      messages: [{ role: 'user' as const, timestamp: 1001, content: [{ type: 'text' as const, text: 'child' }] }],
      meta: { dsh: { headerRaw: { version: 0, id: 'child-skel', createdAt: 10, origin: 'subagent', delegationDepth: 1, cwd: 'also-not-absolute' } } },
    }],
  };
  const res = await adapter.write(ir as never, { root, sessionId: 'cwd-skel', targetCwd: 'D:\\proj' });
  const childPath = res.paths.find((p) => p.includes('child-skel'))!;
  const header = JSON.parse(decompressSessionBuffer(await fs.readFile(childPath)).split('\n')[0]);
  assert.equal(header.cwd, 'D:\\proj', 'non-absolute candidates rejected; parent cwd used');
  assert.ok(childPath.includes('--D-proj--'), 'child lands under the parent cwd project dir');
});

/* ------------------------------------------------------------------ */
/* P1-B 回归：零投影 surface 行（空 content assistant）不蒸发，          */
/* 落 unmappedEvents 且往返存活                                         */
/* ------------------------------------------------------------------ */
test('zero-projection surface rows land in unmappedEvents and survive the round-trip', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  // 空 content 的 assistant/message 是 DSH deriveEventMessage 的合法 null
  // 形态（docs/agents/dsh.md「事件与 Surface」）——此前 buildIrFromEvents
  // 对它整行蒸发（既不进 messages 也不进 unmapped）。
  const raw: DshEventLike[] = [
    { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
    { seq: 1, type: 'step/start', time: 1, data: { turn: 1, step: 1 } },
    { seq: 2, type: 'user/message', surfaceOp: 'append', time: 2, data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }] } },
    { seq: 3, type: 'assistant/message', surfaceOp: 'append', time: 3, data: { turn: 1, step: 1, message: { id: 'a-empty', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [] } } },
    { seq: 4, type: 'assistant/message', surfaceOp: 'append', time: 4, data: { turn: 1, step: 1, message: { id: 'a-full', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'answer' }] } } },
  ];
  const ir = buildIrFromEvents({ id: 's1', createdAt: 1 }, raw as never);
  // 空投影行不进 messages，但必须在 unmappedEvents 里（零丢弃）
  assert.equal(ir.messages.length, 2, 'only the projected rows surface');
  const unmappedEmpty = (ir.unmappedEvents ?? []).find((e) => e.type === 'assistant/message');
  assert.ok(unmappedEmpty, 'empty assistant row archived to unmappedEvents (not vaporized)');
  assert.equal(unmappedEmpty!.seq, 3);
  const rawRow = unmappedEmpty!.data as { message?: { id?: string } };
  assert.equal(rawRow.message?.id, 'a-empty', 'payload preserved verbatim');

  // 写回：行存在（已知类型，写端照常重发）
  const res = await adapter.write(ir, { root, sessionId: 'empty-surface', targetCwd: 'D:\\proj' });
  const rows = decompressSessionBuffer(await fs.readFile(res.paths[0]!)).split('\n').filter((l) => l.trim()).slice(1).map((l) => JSON.parse(l)) as DshEventLike[];
  const emptyRow = rows.find((r) => r.type === 'assistant/message' && ((r.data as { message?: { id?: string } }).message?.id === 'a-empty'));
  assert.ok(emptyRow, 'empty assistant row re-emitted on write-back');
  // 双程回读：unmappedEvents 里还在
  const back = await adapter.parse('empty-surface', root);
  const backEmpty = (back.unmappedEvents ?? []).find((e) => e.type === 'assistant/message');
  assert.ok(backEmpty, 'empty assistant row survives the full round-trip');
  assert.equal(((backEmpty!.data as { message?: { id?: string } }).message?.id), 'a-empty');
  const verdict = verifySessionLog(decompressSessionBuffer(await fs.readFile(res.paths[0]!)), 'empty-surface', res.paths[0]!);
  assert.ok(verdict.ok, `verifySessionLog passes: ${JSON.stringify(verdict.issues ?? []).slice(0, 300)}`);
});

/* ------------------------------------------------------------------ */
/* P1-C 回归：teammate 侧链显式丢弃——写不炸、警告可见、产物无残留        */
/* ------------------------------------------------------------------ */
test('teammate sidechains: explicit drop with a visible warning, no teammate content in the artifacts', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const ir = {
    schemaVersion: 2 as const,
    originTool: 'claude' as const,
    createdAt: 1000,
    messages: [{ role: 'user' as const, timestamp: 1000, content: [{ type: 'text' as const, text: 'main thread' }] }],
    sidechains: [
      {
        agentId: 'tm-1',
        kind: 'teammate' as const,
        messages: [{ role: 'user' as const, timestamp: 1001, content: [{ type: 'text' as const, text: 'TEAMMATE SECRET PAYLOAD' }] }],
      },
      {
        agentId: 'sub-1',
        kind: 'subagent' as const,
        messages: [{ role: 'user' as const, timestamp: 1002, content: [{ type: 'text' as const, text: 'subagent content' }] }],
      },
    ],
  };
  // 警告路径可触发：console.warn 必须为 teammate 丢弃发出一条可见警告
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  let res: { sessionId: string; paths: string[] };
  try {
    res = await adapter.write(ir as never, { root, sessionId: 'tm-drop', targetCwd: 'D:\\proj' });
  } finally {
    console.warn = origWarn;
  }
  const dropped = warnings.find((w) => w.includes('teammate sidechain'));
  assert.ok(dropped, `a visible warning is emitted for dropped teammate sidechains: ${JSON.stringify(warnings)}`);
  assert.ok(dropped!.includes('1 teammate sidechain'), 'warning carries the drop count');
  assert.ok(dropped!.includes('docs/agents/dsh.md'), 'warning points at the documented rationale');

  // 不炸：写入成功；subagent 子会话照常写出，teammate 不落任何产物
  assert.equal(res.paths.length, 2, 'main + subagent child only (teammate dropped)');
  for (const p of res.paths) {
    const plain = decompressSessionBuffer(await fs.readFile(p));
    assert.ok(!plain.includes('TEAMMATE SECRET PAYLOAD'), `no teammate content leaks into artifact ${p}`);
  }
  const projDir = join(root, '--D-proj--');
  const dirs = await fs.readdir(projDir);
  assert.equal(dirs.length, 2, 'exactly main + subagent dirs (no teammate dir)');
  // teammate 与 subagent 的语义边界锁死：subagent 内容存活
  const back = await adapter.parse('tm-drop', root);
  assert.equal(back.sidechains?.length, 1);
  assert.equal(back.sidechains![0].kind, 'subagent');
  assert.equal((back.sidechains![0].messages[0].content[0] as { text: string }).text, 'subagent content');
});
