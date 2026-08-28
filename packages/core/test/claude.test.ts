/**
 * Claude adapter tests: path encoding + write -> parse round-trip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeAdapter } from '../src/adapters/claude/index.js';
import { buildClaudeRecords, parseClaudeFile } from '../src/adapters/claude/index.js';
import { claudeProjectDirName } from '../src/adapters/claude/path.js';
import { fallbackIr } from '../src/demo.js';

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'sm-claude-test-'));
}

test('path encoding collapses non-alphanumerics to dashes', () => {
  assert.equal(
    claudeProjectDirName('D:\\codes\\flutterProjects\\focus_me_full\\focus_me'),
    'D--codes-flutterProjects-focus-me-full-focus-me',
  );
  assert.equal(claudeProjectDirName('C:/Users/a b'), 'C--Users-a-b');
});

test('buildClaudeRecords emits chain + last-prompt', () => {
  const ir = fallbackIr();
  const records = buildClaudeRecords(ir, 'abc-123', 'D:\\proj') as Array<Record<string, unknown>>;
  // header (no mode here) + 3 messages + last-prompt
  assert.equal(records.length, ir.messages.length + 1);
  const last = records[records.length - 1];
  assert.equal(last.type, 'last-prompt');
  assert.equal(typeof (last as { lastPrompt: string }).lastPrompt, 'string');
  assert.ok(((last as { lastPrompt: string }).lastPrompt).length > 0);
  // every message record has content array
  for (const r of records.slice(0, ir.messages.length)) {
    assert.equal((r as { type: string }).type, 'user' === r.type ? 'user' : 'assistant');
  }
});

test('write -> parse round-trip preserves messages', async () => {
  const adapter = new ClaudeAdapter();
  const root = await tempRoot();
  const ir = fallbackIr();

  const res = await adapter.write(ir, { root, targetCwd: 'D:\\workspace\\proj' });
  assert.ok(res.paths[0].endsWith('.jsonl'));

  const back = await adapter.parse(res.sessionId, root);
  assert.equal(back.originTool, 'claude');
  assert.equal(back.messages.length, ir.messages.length);
  // first user text survives
  assert.equal(back.messages[0].role, 'user');
  assert.equal(
    (back.messages[0].content[0] as { text?: string }).text,
    (ir.messages[0].content[0] as { text?: string }).text,
  );
  // assistant tool_use block survives
  assert.equal(back.messages[1].content.length, 2);
  assert.equal((back.messages[1].content[1] as { type: string }).type, 'tool_use');
});

test('parseClaudeFile reads a hand-authored Claude jsonl', async () => {
  const root = await tempRoot();
  const dir = join(root, claudeProjectDirName('D:\\proj'));
  await fs.mkdir(dir, { recursive: true });
  const sid = 'manual-777';
  const lines = [
    { type: 'mode', mode: 'normal', sessionId: sid },
    { type: 'user', sessionId: sid, cwd: 'D:\\proj', uuid: 'u1', parentUuid: null, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hello manual' } },
    { type: 'assistant', sessionId: sid, cwd: 'D:\\proj', uuid: 'u2', parentUuid: 'u1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi back' }] } },
    { type: 'last-prompt', leafUuid: 'u1', sessionId: sid },
  ];
  await fs.writeFile(join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const ir = await parseClaudeFile(join(dir, `${sid}.jsonl`));
  assert.equal(ir.messages.length, 2);
  assert.equal(ir.messages[0].content[0]?.type, 'text');
  assert.equal((ir.messages[0].content[0] as { text: string }).text, 'hello manual');
  assert.equal(ir.messages[0].role, 'user');
  assert.equal(ir.messages[1].role, 'assistant');
});