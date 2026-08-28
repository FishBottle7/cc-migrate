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