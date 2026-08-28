import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenCodeAdapter } from '../src/adapters/opencode/index.js';
import { fallbackIr } from '../src/demo.js';

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'sm-opencode-test-'));
}

test('OpenCode mirror write -> parse round-trip (hermetic)', async () => {
  const adapter = new OpenCodeAdapter();
  const root = await tempRoot();
  const ir = fallbackIr();
  const res = await adapter.write(ir, { root, targetCwd: '/tmp/proj' });
  assert.ok(res.paths[0].includes('opencode-mirror'));

  const back = await adapter.parse(res.sessionId, root);
  assert.equal(back.originTool, 'opencode');
  assert.equal(back.messages.length, ir.messages.length);
  assert.equal((back.messages[0].content[0] as { text: string }).text, (ir.messages[0].content[0] as { text: string }).text);
});

test('OpenCode sidechain survives mirror (flatten)', async () => {
  const adapter = new OpenCodeAdapter();
  const root = await tempRoot();
  const ir = {
    ...fallbackIr(),
    sidechains: [
      { agentId: 'task-1', kind: 'subagent' as const, agentType: 'explore', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'sub prompt' }] }, { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'sub output' }] }] },
    ],
  };
  const res = await adapter.write(ir, { root, flatten: true });
  const back = await adapter.parse(res.sessionId, root);
  assert.ok((back.sidechains?.length ?? 0) >= 1);
  assert.equal(back.sidechains![0].messages[0].content[0].type, 'text');
});
