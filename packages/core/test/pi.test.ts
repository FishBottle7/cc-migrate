import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiAdapter, parsePiFile } from '../src/adapters/pi/index.js';
import { fallbackIr } from '../src/demo.js';

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'sm-pi-test-'));
}

test('Pi write -> parse round-trip preserves messages and sidechains', async () => {
  const adapter = new PiAdapter();
  const root = await tempRoot();
  const ir = {
    ...fallbackIr(),
    cwd: '/tmp/proj',
    sidechains: [
      {
        agentId: 'side-1',
        kind: 'subagent' as const,
        agentType: 'explore',
        messages: [
          { role: 'user' as const, content: [{ type: 'text' as const, text: 'sub task' }] },
          { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'sub done' }] },
        ],
      },
    ],
  };
  const res = await adapter.write(ir, { root, targetCwd: '/tmp/proj' });
  assert.ok(res.paths[0].endsWith('.jsonl'));
  // hasAssistant guard: must contain assistant
  const raw = await fs.readFile(res.paths[0], 'utf8');
  assert.ok(raw.includes('"role":"assistant"'));

  const back = await adapter.parse(res.sessionId, root);
  assert.equal(back.originTool, 'pi');
  assert.ok(back.messages.length >= ir.messages.length);
  assert.ok((back.sidechains?.length ?? 0) >= 1);
});

test('parsePiFile tolerates minimal header', async () => {
  const root = await tempRoot();
  const dir = join(root, '--tmp-proj--');
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, '2024-12-03T14-00-00-000Z_testid1234.jsonl');
  await fs.writeFile(
    path,
    JSON.stringify({ type: 'session', version: 3, id: 'testid1234', timestamp: '2024-12-03T14:00:00.000Z', cwd: '/tmp/proj' }) + '\n' +
    JSON.stringify({ type: 'message', id: 'aaaaaaaa', parentId: null, timestamp: '2024-12-03T14:00:01.000Z', message: { role: 'user', content: 'hi', timestamp: 1733270000000 } }) + '\n' +
    JSON.stringify({ type: 'message', id: 'bbbbbbbb', parentId: 'aaaaaaaa', timestamp: '2024-12-03T14:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }], provider: 'anthropic', model: 'claude', timestamp: 1733270000001 } }) + '\n',
    'utf8',
  );
  const ir = await parsePiFile(path);
  assert.equal(ir.originTool, 'pi');
  assert.equal(ir.messages.length, 2);
});
