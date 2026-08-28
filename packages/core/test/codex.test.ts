/**
 * Codex adapter tests: rollout round-trip + parsing real Data-shape records.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexAdapter, buildRolloutLines, buildIrFromLines } from '../src/adapters/codex/index.js';
import { defaultCodexHome, codexSessionDirFor, rolloutName, sessionIndexPath } from '../src/adapters/codex/paths.js';
import { fallbackIr } from '../src/demo.js';
import type { MigratedSession } from '../src/ir.js';

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'sm-codex-test-'));
}

test('paths: codex home resolution and rollout name/path', () => {
  assert.equal(typeof defaultCodexHome(), 'string');
  const createdAt = Date.parse('2026-01-12T20:55:48Z');
  const d = new Date(createdAt);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const localTs = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
    `T${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  const name = rolloutName('019bb246-abcd', createdAt);
  assert.equal(name, `rollout-${localTs}-019bb246-abcd.jsonl`);
  const { dir, rel } = codexSessionDirFor('C:/home/.codex', '019bb246-abcd', createdAt);
  assert.match(dir, new RegExp(`\\.codex[\\\\/]sessions[\\\\/]${d.getFullYear()}[\\\\/]${p2(d.getMonth() + 1)}[\\\\/]${p2(d.getDate())}$`));
  assert.equal(rel, name);
  assert.match(sessionIndexPath('C:/home/.codex'), /\.codex[\\/]session_index\.jsonl$/);
});

test('buildRolloutLines emits session_meta + response_item lines', () => {
  const ir = fallbackIr();
  const lines = buildRolloutLines(ir, 'sess-123', 'D:\\proj', Date.parse('2026-01-01T00:00:00Z'));
  const first = JSON.parse(lines[0]);
  assert.equal(first.type, 'session_meta');
  assert.equal(first.payload.cwd, 'D:\\proj');
  assert.equal(first.payload.id, 'sess-123');
  assert.ok(lines.length >= ir.messages.length + 1);
  for (const l of lines.slice(1)) {
    const rec = JSON.parse(l);
    assert.equal(rec.type, 'response_item');
    assert.ok(rec.payload && typeof rec.payload === 'object');
  }
});

test('write -> parse round-trip preserves messages', async () => {
  const adapter = new CodexAdapter();
  const root = await tempRoot();
  const ir = fallbackIr();

  const res = await adapter.write(ir, { root, targetCwd: 'D:\\workspace\\proj' });
  assert.ok(res.paths[0].endsWith('.jsonl'));
  assert.match(res.paths[0], /sessions[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}[\\/]/);

  const back = await adapter.parse(res.sessionId, root);
  assert.equal(back.originTool, 'codex');
  // Codex stores each block as its own response_item, so round-trip can emit
  // one IR message per block (native codex model), not one message with 2 blocks.
  assert.ok(back.messages.length >= ir.messages.length);
  // first user text survives
  assert.equal(back.messages[0].role, 'user');
  assert.equal(
    (back.messages[0].content[0] as { text?: string }).text,
    (ir.messages[0].content[0] as { text?: string }).text,
  );
  // assistant tool_use block survives (as a separate message, codex-faithful)
  const toolMsg = back.messages.find((m) => m.content.some((b) => b.type === 'tool_use'));
  assert.ok(toolMsg, 'expected a tool_use message after round-trip');
  assert.equal((toolMsg?.content[0] as { name: string }).name, (ir.messages[1].content[1] as { name: string }).name);
});

test('listSessions finds a written session under temp root', async () => {
  const adapter = new CodexAdapter();
  const root = await tempRoot();
  const ir = fallbackIr();
  const res = await adapter.write(ir, { root });
  const metas = await adapter.listSessions(root);
  assert.ok(metas.some((m) => m.sessionId === res.sessionId));
});

test('buildIrFromLines parses a real-shaped Codex rollout (message + function_call + output + reasoning + web_search)', () => {
  const sessionId = '019bb623-abcd';
  const cwd = 'D:\\codes\\AIgenerated\\FOCUS_Me\\focus_me';
  const lines = [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '请帮我优化渲染性能' }],
    },
    {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Considering optimization.' }],
      encrypted_content: 'gAAAAAB...',
    },
    { type: 'function_call', name: 'update_plan', arguments: '{"plan":[]}', call_id: 'call_abc' },
    { type: 'function_call_output', call_id: 'call_abc', output: { body: 'Plan updated' } },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '方案如下：' }],
    },
    { type: 'web_search_call', call_id: 'ws_1', status: 'completed' },
  ].map((payload) => ({
    timestamp: '2026-01-01T00:00:00Z',
    type: 'response_item',
    payload,
  }));
  const records = [
    {
      timestamp: '2026-01-01T00:00:00Z',
      type: 'session_meta',
      payload: { id: sessionId, timestamp: '2026-01-01T00:00:00Z', cwd, source: 'cli', model_provider: 'cch', git: { branch: 'main' } },
    },
    ...lines,
  ];

  const ir = buildIrFromLines(records);
  assert.equal(ir.originSessionId, sessionId);
  assert.equal(ir.cwd, cwd);
  assert.equal(ir.model, 'cch');

  const blockText = (b: { type: string; text?: string; content?: unknown; name?: string; input?: unknown }): string =>
    b.type === 'text' ? (b.text ?? '') : b.type === 'tool_use' ? `[tool_use:${b.name}]` : `[tool_result] ${String(b.content ?? '')}`;
  const texts = ir.messages.map((m) => m.content.map((b) => blockText(b as never)).join(''));
  // user message
  assert.ok(texts.some((t) => t.includes('渲染性能')));
  // assistant msg
  assert.ok(texts.some((t) => t.includes('方案如下')));
  // the function_call + its output folded into an assistant tool_use with a tool_result
  const toolMsg = ir.messages.find((m) => m.content.some((b) => b.type === 'tool_use'));
  assert.ok(toolMsg, 'expected a tool_use message');
  assert.equal(toolMsg?.content[0].type, 'tool_use');
  assert.equal((toolMsg?.content[0] as { name: string }).name, 'update_plan');
  assert.ok(toolMsg?.content.some((b) => b.type === 'tool_result'), 'expected paired tool_result');
  // reasoning and web_search are dropped from conversation surface
  assert.ok(!texts.some((t) => t.includes('Considering optimization')));
});