/**
 * summarizeIr 单测 —— 上下文安全的决策摘要（skill 教 agent 用的 digest）。
 *
 * 契约：所有字符串字段有界（≤ cap），摘要整体与 session 体量无关；
 * synthetic 注入与 tool_result-only 行不算「人类输入」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeIr, DIGEST_EXCERPT_CAP } from '../src/summarize.js';
import type { MigratedSession } from '../src/ir.js';

function msg(role: MigratedSession['messages'][number]['role'], text: string, opts: { synthetic?: boolean; ts?: number } = {}): MigratedSession['messages'][number] {
  return {
    role,
    content: text ? [{ type: 'text', text }] : [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }],
    ...(opts.synthetic ? { synthetic: true } : {}),
    ...(opts.ts !== undefined ? { timestamp: opts.ts } : {}),
  };
}

function session(messages: MigratedSession['messages'], extra: Partial<MigratedSession> = {}): MigratedSession {
  return {
    schemaVersion: 2,
    originTool: 'claude',
    originSessionId: 's-1',
    messages,
    ...extra,
  };
}

test('digest is bounded regardless of session size', () => {
  const long = 'x'.repeat(100_000);
  const ir = session([
    msg('user', long, { ts: 1 }),
    msg('assistant', long, { ts: 2 }),
    msg('user', long, { ts: 3 }),
  ]);
  const digest = summarizeIr(ir);
  assert.equal(digest.stats.textChars, 300_000, 'stats report the true size');
  assert.ok(digest.stats.messages === 3);
  for (const e of digest.firstUserMessages) assert.ok(e.length <= DIGEST_EXCERPT_CAP, `excerpt capped, got ${e.length}`);
  assert.ok((digest.lastMessage?.text.length ?? 0) <= DIGEST_EXCERPT_CAP);
  assert.equal(digest.lastMessage?.role, 'user', 'lastMessage is the last non-synthetic text message');
});

test('digest skips synthetic injections and tool_result-only user rows', () => {
  const ir = session([
    msg('user', 'runtime-context snapshot…', { synthetic: true, ts: 0 }),
    msg('user', '', { ts: 1 }),                       // tool_result-only（claude 把工具结果存成 user 行）
    msg('user', 'first real prompt', { ts: 2 }),
    msg('user', 'second real prompt', { ts: 3 }),
  ]);
  const digest = summarizeIr(ir, { firstUserMessages: 5 });
  assert.deepEqual(digest.firstUserMessages, ['first real prompt', 'second real prompt']);
  assert.equal(digest.stats.userTurns, 2, 'synthetic + tool_result rows are not human turns');
  assert.equal(digest.lastMessage?.text, 'second real prompt');
});

test('digest carries ids/counts and respects --messages 0', () => {
  const ir = session(
    [msg('user', 'hello', { ts: 1 }), msg('assistant', 'hi', { ts: 2 })],
    { title: 'T'.repeat(500), cwd: 'D:\\p', sidechains: [{ agentId: 'a', kind: 'subagent', messages: [] }] },
  );
  const d0 = summarizeIr(ir, { firstUserMessages: 0 });
  assert.deepEqual(d0.firstUserMessages, []);
  assert.ok((d0.title?.length ?? 0) <= 200, 'title excerpted');
  assert.equal(d0.stats.sidechains, 1);
  assert.equal(d0.cwd, 'D:\\p');
  assert.equal(d0.sessionId, 's-1');
});
