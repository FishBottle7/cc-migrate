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

import { DshAdapter } from '../src/adapters/dsh/index.js';
import { decompressSessionBuffer } from '../src/adapters/dsh/format.js';
import { verifySessionLog } from '../src/adapters/dsh/verify.js';

test('pi toolCall/toolResult fold into tool_use/tool_result blocks; pi->dsh renders a paired tool stream', async () => {
  const root = await tempRoot();
  const dir = join(root, '--tmp-proj--');
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, '2024-12-03T14-00-00-000Z_piid1234.jsonl');
  await fs.writeFile(
    path,
    [
      JSON.stringify({ type: 'session', version: 3, id: 'piid1234', timestamp: '2024-12-03T14:00:00.000Z', cwd: '/tmp/proj' }),
      JSON.stringify({ type: 'message', id: 'aaaaaaaa', parentId: null, timestamp: '2024-12-03T14:00:01.000Z', message: { role: 'user', content: 'list', timestamp: 1733270000000 } }),
      JSON.stringify({ type: 'message', id: 'bbbbbbbb', parentId: 'aaaaaaaa', timestamp: '2024-12-03T14:00:02.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: { cmd: 'ls' } }], provider: 'anthropic', model: 'claude', timestamp: 1733270000001 } }),
      JSON.stringify({ type: 'message', id: 'cccccccc', parentId: 'bbbbbbbb', timestamp: '2024-12-03T14:00:03.000Z', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'out' }], isError: false, timestamp: 1733270000002 } }),
    ].join('\n') + '\n',
    'utf8',
  );
  const ir = await parsePiFile(path);
  const asst = ir.messages.find((m) => m.role === 'assistant')!;
  assert.deepEqual(asst.content[0], { type: 'tool_use', id: 'call_1', name: 'bash', input: { cmd: 'ls' } }, 'toolCall block folds to tool_use');
  const toolMsg = ir.messages.find((m) => m.role === 'tool')!;
  const tr = toolMsg.content[0] as { type: string; toolUseId: string; content: string; isError: boolean };
  assert.equal(tr.type, 'tool_result');
  assert.equal(tr.toolUseId, 'call_1', 'message-level toolCallId restored onto the block');
  assert.equal(tr.content, 'out');
  assert.equal(tr.isError, false);
  assert.equal((toolMsg.meta as { pi?: { toolName?: string } } | undefined)?.pi?.toolName, 'bash');

  // pi -> dsh E2E: the paired call+result stream, verifier clean (no ghost cards)
  const dsh = new DshAdapter();
  const droot = await tempRoot();
  const res = await dsh.write(ir, { root: droot, sessionId: 'pi2dsh-1', targetCwd: 'D:\\proj' });
  const rows = decompressSessionBuffer(await fs.readFile(res.paths[0]!)).split('\n').filter((l) => l.trim()).slice(1).map((l) => JSON.parse(l)) as Array<{ type: string; data: Record<string, unknown> }>;
  const calls = rows.filter((e) => e.type === 'tool/call');
  assert.equal(calls.length, 1);
  assert.equal((calls[0].data as Record<string, unknown>).callId, 'call_1');
  assert.equal((calls[0].data as Record<string, unknown>).name, 'bash');
  assert.equal(rows.filter((e) => e.type === 'tool/result').length, 1);
  const verdict = verifySessionLog(decompressSessionBuffer(await fs.readFile(res.paths[0]!)), 'pi2dsh-1', res.paths[0]!);
  assert.ok(verdict.ok, `verifySessionLog passes: ${JSON.stringify(verdict.issues ?? []).slice(0, 200)}`);

  // pi -> pi round trip: toolResult row restored with toolCallId + toolName
  const pi = new PiAdapter();
  const proot = await tempRoot();
  const back = await pi.write(ir, { root: proot, targetCwd: '/tmp/proj' });
  const reparsed = await pi.parse(back.sessionId, proot);
  const toolBack = reparsed.messages.find((m) => m.role === 'tool')!;
  const trBack = toolBack.content[0] as { toolUseId: string };
  assert.equal(trBack.toolUseId, 'call_1', 'pi write-back keeps the pairing id');
});
