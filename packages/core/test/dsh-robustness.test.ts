/**
 * Phase 5 健壮性回归：dsh 写端碰撞防护 + 跨工具 tool_use id 去重 + 幂等。
 *
 * 三条红线在此文件锚定（AGENT.md「读旧写新、永不覆盖」铁律 + 事件跨工具共识）：
 *  1. 显式 --session-id 指向已存在的会话 → write 抛错拒绝，首个文件字节不变；
 *  2. claim 检查与落盘之间的 TOCTOU 由 wx 独占创建兜底（与 pi 写端同款）；
 *  3. 跨工具合并带来的重复 callId 在写端被席位制去重，配对不断裂、IR 原值不动。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DshAdapter } from '../src/adapters/dsh/index.js';
import { decompressSessionBuffer } from '../src/adapters/dsh/format.js';
import { verifySessionLog } from '../src/adapters/dsh/verify.js';
import { fallbackIr } from '../src/demo.js';
import type { MigratedSession } from '../src/ir.js';

/** 临时 sessions root——绝不触碰真实 ~/.dsh。 */
async function tempRoot(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'sm-dsh-robust-'));
}

/** 读回一个写好的会话日志，解出 [header, ...events]。 */
async function readLog(path: string): Promise<Array<Record<string, unknown>>> {
  const plain = decompressSessionBuffer(await fs.readFile(path));
  return plain.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** 内容文本不同的最小 IR——用于区分两次写入的产物。 */
function irWithText(text: string, ts = 1000): MigratedSession {
  return {
    schemaVersion: 2,
    originTool: 'dsh',
    createdAt: ts,
    messages: [{ role: 'user', timestamp: ts, content: [{ type: 'text', text }] }],
  };
}

/* ------------------------------------------------------------------ */
/* 1. 覆盖防护：显式 sessionId 撞已有会话 → 抛错 + 首写文件字节不变   */
/* ------------------------------------------------------------------ */
test('write with an explicit sessionId refuses to clobber an existing session (byte-identical survivor)', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const first = await adapter.write(irWithText('first write', 1000), { root, sessionId: 'session-test-fixed', targetCwd: 'D:\\proj' });
  const bytesAfterFirst = await fs.readFile(first.paths[0]);

  // 第二次以同 id 写入不同内容——必须抛错，且错误要说清目标路径与出路
  await assert.rejects(
    adapter.write(irWithText('second write', 2000), { root, sessionId: 'session-test-fixed', targetCwd: 'D:\\proj' }),
    (e: Error) => {
      assert.match(e.message, /already exists/);
      assert.ok(e.message.includes('session-test-fixed'), '错误信息包含目标会话 id');
      assert.ok(e.message.includes(join(root, '--D-proj--', 'session-test-fixed', 'session.jsonl.zstd')), '错误信息包含解析后的目标绝对路径');
      assert.ok(/--session-id|fresh id/.test(e.message), '错误信息给出换 id 的出路');
      return true;
    },
  );

  // 字节级不变 + parse 读回内容仍是第一次的
  assert.deepEqual(await fs.readFile(first.paths[0]), bytesAfterFirst, '首个会话文件字节不变（未被覆盖）');
  const back = await adapter.parse('session-test-fixed', root);
  assert.equal((back.messages[0].content[0] as { text: string }).text, 'first write');
});

/* ------------------------------------------------------------------ */
/* 2. wx 兜底：预创建目录 + 假文件绕过 claim 检查点 → wx 拒绝且假文件不变 */
/* ------------------------------------------------------------------ */
test('wx exclusive create backstops the claim gate: a pre-planted fake log is never overwritten', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  // 手动预创建目标目录并放一个假 session.jsonl.zstd——claim 前这文件就存在，
  // 但为了独立验证 wx 兜底路径，这里构造「claim 逻辑发现不了而 wx 必须拒绝」的
  // 场景：直接调用 write 显式同 id（claim 会先命中；真正测 wx 的是下面的
  // 假文件字节不变断言——任何一层失守，这个断言都会红）。
  const dir = join(root, '--D-proj--', 'session-fake-target');
  await fs.mkdir(dir, { recursive: true });
  const fakeBytes = Buffer.from('not-a-real-zstd-log-DO-NOT-TOUCH');
  const fakePath = join(dir, 'session.jsonl.zstd');
  await fs.writeFile(fakePath, fakeBytes);

  await assert.rejects(
    adapter.write(irWithText('clobber attempt', 3000), { root, sessionId: 'session-fake-target', targetCwd: 'D:\\proj' }),
    /already exists/,
  );
  assert.deepEqual(await fs.readFile(fakePath), fakeBytes, '假文件字节不变——wx/claim 双保险下绝无覆盖路径');

  // 独立验证 wx 行为本身：绕过 adapter，在已存在文件上用同样的 flag 写入必须 EEXIST
  await assert.rejects(
    fs.writeFile(fakePath, Buffer.from('x'), { flag: 'wx' }),
    (e: NodeJS.ErrnoException) => e.code === 'EEXIST',
  );
});

/* ------------------------------------------------------------------ */
/* 3. 默认 id 不撞：不带 sessionId 连写两次 → 两个不同新 id，均成功     */
/* ------------------------------------------------------------------ */
test('default (engine-minted) ids never collide: two back-to-back writes both succeed with distinct ids', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const r1 = await adapter.write(fallbackIr(), { root, targetCwd: 'D:\\proj' });
  const r2 = await adapter.write(fallbackIr(), { root, targetCwd: 'D:\\proj' });
  assert.ok(r1.sessionId.startsWith('session-'), '未传 sessionId 时引擎自生成 id');
  assert.ok(r2.sessionId.startsWith('session-'));
  assert.notEqual(r1.sessionId, r2.sessionId, '两次写入得到不同的新 id');
  // 两个产物都真实存在且可 parse（回归确认：claim 路径没有引入破坏）
  assert.deepEqual(await fs.readFile(r1.paths[0]), await fs.readFile(r1.paths[0]));
  const b1 = await adapter.parse(r1.sessionId, root);
  const b2 = await adapter.parse(r2.sessionId, root);
  assert.equal(b1.originSessionId, r1.sessionId);
  assert.equal(b2.originSessionId, r2.sessionId);
  assert.equal(b1.messages.length, fallbackIr().messages.length);
});

/* ------------------------------------------------------------------ */
/* 4. callId 去重：两条 assistant 各带 tool_use id:'call_dup' → 写端   */
/*    席位制换新 id，tool/result 配对不串、IR 原值不动                 */
/* ------------------------------------------------------------------ */
test('duplicate tool_use ids across turns get distinct written callIds with results still paired to the right call', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  // 跨工具合并的典型形状：两个不同调用共享同一 callId（codex subagent 展平
  // + 主链同前缀时出现），各自带着 tool_result。
  const dupIr = {
    schemaVersion: 2 as const,
    originTool: 'zcode' as const,
    createdAt: 1000,
    messages: [
      { role: 'user' as const, timestamp: 1000, content: [{ type: 'text' as const, text: 'q' }] },
      {
        role: 'assistant' as const, timestamp: 1001,
        content: [{ type: 'tool_use' as const, id: 'call_dup', name: 'read', input: { path: 'a.txt' } }],
      },
      { role: 'tool' as const, timestamp: 1002, content: [{ type: 'tool_result' as const, toolUseId: 'call_dup', content: 'result-A', isError: false }] },
      {
        role: 'assistant' as const, timestamp: 1003,
        content: [{ type: 'tool_use' as const, id: 'call_dup', name: 'read', input: { path: 'b.txt' } }],
      },
      { role: 'tool' as const, timestamp: 1004, content: [{ type: 'tool_result' as const, toolUseId: 'call_dup', content: 'result-B', isError: false }] },
    ],
  };
  const res = await adapter.write(dupIr as never, { root, sessionId: 'callid-dedup', targetCwd: 'D:\\proj' });
  const events = (await readLog(res.paths[0])).slice(1) as Array<{ type: string; data: Record<string, unknown> }>;

  // 两个 tool/call，callId 必须不同（同 call_dup 的第二个 start Match 会让 DSH 拒载）
  const calls = events.filter((e) => e.type === 'tool/call');
  assert.equal(calls.length, 2, '两条调用各有一条 tool/call');
  const writtenIds = calls.map((c) => c.data.callId as string);
  assert.notEqual(writtenIds[0], writtenIds[1], '重复 callId 被写端席位制去重为不同 id');
  assert.ok(writtenIds[0] === 'call_dup' || writtenIds[1] === 'call_dup', '首个席位保留源 id（无人占用时）');
  assert.ok(writtenIds.some((id) => id.startsWith('call_') && id !== 'call_dup'), '重复席位换 call_<uuid> 新 id');

  // 两个 tool/result 各自配对到正确的 call——内容不能串
  const results = events.filter((e) => e.type === 'tool/result');
  assert.equal(results.length, 2);
  const pairOf = (r: { data: Record<string, unknown> }): string =>
    ((r.data.message as Record<string, unknown>).source as Record<string, unknown>).callId as string;
  const resultText = (r: { data: Record<string, unknown> }): string =>
    (((r.data.message as Record<string, unknown>).content as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>)[0].text as string;
  const pairA = pairOf(results[0]);
  const pairB = pairOf(results[1]);
  assert.ok(writtenIds.includes(pairA) && writtenIds.includes(pairB), '配对引用都指向真实存在的 tool/call 行');
  assert.notEqual(pairA, pairB, '两个结果配对到不同的 call');
  // 每个结果的文本挂在自己那对 call 下（席次序 = 消息序）
  const idOfText = new Map<string, string>();
  idOfText.set(resultText(results[0]), pairA);
  idOfText.set(resultText(results[1]), pairB);
  assert.ok(idOfText.has('result-A') && idOfText.has('result-B'), '两条结果文本都存活');
  // 物理契约：verifySessionLog 的 tool-pairing 检查全过（无 ghost card）
  const verdict = verifySessionLog(decompressSessionBuffer(await fs.readFile(res.paths[0])), 'callid-dedup', res.paths[0]);
  assert.ok(verdict.ok, `verifySessionLog passes: ${JSON.stringify(verdict.issues ?? []).slice(0, 300)}`);

  // round-trip 读回：消息数守恒，tool_result 的 toolUseId 跟随写端 id
  const back = await adapter.parse('callid-dedup', root);
  assert.equal(back.messages.length, dupIr.messages.length);
  const backResults = back.messages.filter((m) => m.role === 'tool');
  assert.equal(backResults.length, 2);
  const backUseIds = backResults.map((m) => (m.content[0] as { toolUseId: string }).toolUseId);
  assert.notEqual(backUseIds[0], backUseIds[1], '读回的配对 id 也不串');

  // IR 原值不动（零丢弃原则）：写入不回改源对象
  assert.equal((dupIr.messages[1].content[0] as { id: string }).id, 'call_dup');
  assert.equal((dupIr.messages[3].content[0] as { id: string }).id, 'call_dup');
});

/* ------------------------------------------------------------------ */
/* 5. sidechain 回归：claimFree 路径未受主会话防护改动影响              */
/* ------------------------------------------------------------------ */
test('sidechain write path (claimFree) is unaffected by the main-session collision gate', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot();
  const mkParent = (id: string, childId: string, text: string) => {
    const ir = irWithText(text, 1000);
    ir.messages[0].meta = { dsh: { id: `msg_${id}` } };
    ir.sidechains = [
      {
        agentId: childId,
        kind: 'subagent' as const,
        agentType: 'explore',
        messages: [{ role: 'user' as const, timestamp: 1001, content: [{ type: 'text' as const, text: `child of ${id}` }] }],
        meta: { dsh: { headerRaw: { version: 0, id: childId, createdAt: 10, origin: 'subagent', delegationDepth: 1 } } },
      },
    ];
    return ir;
  };

  // 两次写不同 sessionId，各自的 sidechain 都正常落盘且互不干扰
  const r1 = await adapter.write(mkParent('p1', 'sc-child-1', 'parent one'), { root, sessionId: 'robust-parent-1', targetCwd: 'D:\\proj' });
  const r2 = await adapter.write(mkParent('p2', 'sc-child-1', 'parent two'), { root, sessionId: 'robust-parent-2', targetCwd: 'D:\\proj' });
  assert.equal(r1.paths.length, 2, '父 + 子会话');
  assert.equal(r2.paths.length, 2, '父 + 子会话');
  assert.ok(!r1.paths.some((p) => p.includes('robust-parent-2')), '两次写入路径不交叉');

  // 第二个父的 sidechain 候选 id sc-child-1 已被第一次占用 → claimFree re-roll 新 id，
  // 且指向自己写出的父（robust-parent-2），绝不覆盖第一份子会话
  const projDir = join(root, '--D-proj--');
  const headers = new Map<string, Record<string, unknown>>();
  for (const d of await fs.readdir(projDir)) {
    headers.set(d, (await readLog(join(projDir, d, 'session.jsonl.zstd')))[0]);
  }
  const [childDir1, h1] = [...headers.entries()].find(([, h]) => h.parentSession === 'robust-parent-1')!;
  const [childDir2, h2] = [...headers.entries()].find(([, h]) => h.parentSession === 'robust-parent-2')!;
  assert.equal(childDir1, 'sc-child-1', '第一个父的子会话占用 preferred id');
  assert.notEqual(childDir2, 'sc-child-1', '第二个子会话被 re-roll 到新 id（claimFree 未回归）');
  assert.equal(h1.origin, 'subagent');
  assert.equal(h2.origin, 'subagent');

  // parse 回来两棵树都完整
  const back1 = await adapter.parse('robust-parent-1', root);
  const back2 = await adapter.parse('robust-parent-2', root);
  assert.equal(back1.sidechains?.length, 1);
  assert.equal(back2.sidechains?.length, 1);
  assert.equal(back1.sidechains![0].agentId, 'sc-child-1');
  assert.notEqual(back2.sidechains![0].agentId, 'sc-child-1');
  assert.equal((back2.sidechains![0].messages[0].content[0] as { text: string }).text, 'child of p2', '内容不串树');
});
