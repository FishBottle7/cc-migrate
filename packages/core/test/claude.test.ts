/**
 * Claude adapter tests: path encoding (incl. 200+hash), DAG chain rebuild with
 * parallel tool_result recovery, three record classes → IR, compaction,
 * write-side native stamps, round-trip, no-overwrite, listSessions filters.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ClaudeAdapter } from '../src/adapters/claude/index.js';
import { parseClaudeLines, buildConversationChain } from '../src/adapters/claude/parse.js';
import { buildMainRecords } from '../src/adapters/claude/write.js';
import { claudeProjectDirName, MAX_SANITIZED_LENGTH } from '../src/adapters/claude/path.js';
import type { ContentBlock, MigratedSession } from '../src/ir.js';

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'sm-claude-test-'));
}

function writeRecords(records: Record<string, unknown>[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

const TS0 = '2026-01-01T00:00:00.000Z';

function userRec(uuid: string, parentUuid: string | null, content: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'user', uuid, parentUuid, timestamp: TS0, isSidechain: false, message: { role: 'user', content }, ...extra };
}

function asstRec(uuid: string, parentUuid: string | null, msgId: string, content: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'assistant', uuid, parentUuid, timestamp: TS0, isSidechain: false,
    message: { id: msgId, role: 'assistant', type: 'message', content }, ...extra,
  };
}

/* ------------------------------------------------------------------
 * path.ts
 * ------------------------------------------------------------------ */

test('path encoding collapses non-alphanumerics to dashes', () => {
  assert.equal(
    claudeProjectDirName('D:\\codes\\flutterProjects\\focus_me_full\\focus_me'),
    'D--codes-flutterProjects-focus-me-full-focus-me',
  );
  assert.equal(claudeProjectDirName('C:/Users/a b'), 'C--Users-a-b');
});

test('path encoding truncates >200 with hash suffix (§1, missing before)', () => {
  const long = 'D:\\' + 'segment/'.repeat(60);
  const encoded = claudeProjectDirName(long);
  const sanitized = long.replace(/[^a-zA-Z0-9]/g, '-');
  assert.ok(sanitized.length > MAX_SANITIZED_LENGTH);
  assert.ok(encoded.startsWith(sanitized.slice(0, MAX_SANITIZED_LENGTH) + '-'));
  assert.ok(encoded.length > MAX_SANITIZED_LENGTH, 'hash suffix appended');
  assert.equal(encoded, claudeProjectDirName(long)); // deterministic
});

/* ------------------------------------------------------------------
 * read: parallel tool_result recovery (§3.6)
 * ------------------------------------------------------------------ */

test('parallel tool_result recovery: siblings sharing message.id + their results survive', async () => {
  // shape: asstA(tool_use t1) + asstB(tool_use t2, same msg.id) chained off asstA,
  // each with its own tool_result record → single-parent walk keeps one branch.
  const records = [
    userRec('u0', null, 'run both'),
    asstRec('aA', 'u0', 'msg_1', [{ type: 'tool_use', id: 'tu1', name: 'A', input: {} }]),
    asstRec('aB', 'u0', 'msg_1', [{ type: 'tool_use', id: 'tu2', name: 'B', input: {} }], { timestamp: '2026-01-01T00:00:00.100Z' }),
    userRec('trA', 'aA', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'result A' }], { sourceToolAssistantUUID: 'aA', timestamp: '2026-01-01T00:00:00.200Z' }),
    userRec('trB', 'aB', [{ type: 'tool_result', tool_use_id: 'tu2', content: 'result B' }], { sourceToolAssistantUUID: 'aB', timestamp: '2026-01-01T00:00:00.300Z' }),
    userRec('u2', 'trA', 'continue', { timestamp: '2026-01-01T00:00:00.400Z' }),
  ];
  const parsed = parseClaudeLines(writeRecords(records));
  const messages = new Map(parsed.records.map((r) => [r.uuid!, r]));
  // single-parent walk from u2 keeps only aA's branch (aB/trB orphaned)
  const seen = new Set<string>();
  const chain = walkAndRecover(messages, 'u2', seen);
  const uuids = chain.map((r) => r.uuid);
  assert.ok(uuids.includes('aB'), 'sibling assistant recovered');
  assert.ok(uuids.includes('trB'), 'parallel tool_result recovered');
  assert.ok(uuids.indexOf('aB') > uuids.indexOf('aA'), 'sibling spliced after anchor');
});

function walkAndRecover(
  messages: Map<string, ReturnType<typeof parseClaudeLines>['records'][number]>,
  leafUuid: string,
  seen: Set<string>,
): ReturnType<typeof buildConversationChain> {
  const leaf = messages.get(leafUuid)!;
  return buildConversationChain(messages, leaf);
}

/* ------------------------------------------------------------------
 * read side: three record classes, isMeta, compaction
 * ------------------------------------------------------------------ */

test('parse: transcript + metadata rows + system rows + isMeta + local_command', async () => {
  const root = await tempRoot();
  const dir = join(root, claudeProjectDirName('D:\\proj'));
  await fs.mkdir(dir, { recursive: true });
  const sid = randomUUID();
  const records: Record<string, unknown>[] = [
    { type: 'ai-title', aiTitle: 'AI 标题', sessionId: sid },
    { type: 'custom-title', customTitle: '用户标题', sessionId: sid },
    { type: 'tag', tag: 'demo', sessionId: sid },
    { type: 'permission-mode', permissionMode: 'acceptEdits', sessionId: sid },
    userRec('u1', null, 'hello', { sessionId: sid, cwd: 'D:\\proj' }),
    asstRec('a1', 'u1', 'msg_1', [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }], { sessionId: sid }),
    userRec('tr1', 'a1', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'out', is_error: false }], {
      sessionId: sid,
      sourceToolAssistantUUID: 'a1',
      toolUseResult: { stdout: 'out', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
    }),
    userRec('u2', 'tr1', '<system-reminder>ctx</system-reminder>', { sessionId: sid, isMeta: true, timestamp: '2026-01-01T00:00:02Z' }),
    { type: 'system', subtype: 'local_command', content: '$ ls\nfile.txt', level: 'info', uuid: 's1', parentUuid: 'u2', timestamp: '2026-01-01T00:00:03Z', sessionId: sid },
    { type: 'system', subtype: 'turn_duration', durationMs: 42, messageCount: 4, uuid: 's2', parentUuid: 's1', timestamp: '2026-01-01T00:00:03Z', sessionId: sid },
    { type: 'last-prompt', lastPrompt: 'hello', leafUuid: 'a1', sessionId: sid },
  ];
  await fs.writeFile(join(dir, `${sid}.jsonl`), writeRecords(records));

  const adapter = new ClaudeAdapter();
  const ir = await adapter.parse(sid, root);
  assert.equal(ir.originTool, 'claude');
  assert.equal(ir.title, '用户标题'); // customTitle 优先 aiTitle（§1.0）
  assert.equal(ir.tag, 'demo');
  assert.equal(ir.permissionMode, 'acceptEdits');

  // u1(user) → a1(assistant) → tr(user) → local_command(user, synthetic)
  const trMsg = ir.messages.find((m) => m.content.some((b) => b.type === 'tool_result'))!;
  const trBlock = trMsg.content.find((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')!;
  assert.equal(trBlock.rawResult && (trBlock.rawResult as { stdout: string }).stdout, 'out');

  const metaMsg = ir.messages.find((m) => m.role === 'user' && m.content.some((b) => b.type === 'text' && (b as { text: string }).text.includes('system-reminder')));
  assert.ok(metaMsg, 'isMeta 记录保留（模型上下文）');
  assert.equal(metaMsg.synthetic, true);

  const localCmd = ir.messages.find((m) => (m.meta?.claude as { systemSubtype?: string } | undefined)?.systemSubtype === 'local_command');
  assert.ok(localCmd, 'local_command 投影为 user 文本');
  assert.equal(localCmd.synthetic, true);

  assert.ok(ir.sessionEvents?.some((e) => e.type === 'turn_duration'), '非对话 system 行 → sessionEvents');
});

/* ---------------- compaction ---------------- */

test('compaction: boundary + isCompactSummary → compaction[] anchored; 活跃链进 messages，折叠段靠 recordsRaw 无损', async () => {
  const root = await tempRoot();
  const dir = join(root, claudeProjectDirName('D:\\proj'));
  await fs.mkdir(dir, { recursive: true });
  const sid = randomUUID();
  const records = writeRecords([
    userRec('u1', null, '被折叠的旧消息', { sessionId: sid }),
    asstRec('a1', 'u1', 'm0', [{ type: 'text', text: '旧回复' }], { sessionId: sid }),
    {
      type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', level: 'info',
      parentUuid: null, logicalParentUuid: 'a1', uuid: 'b1', timestamp: '2026-01-01T00:00:05Z',
      compactMetadata: { trigger: 'manual', preTokens: 1000, postTokens: 100 },
      sessionId: sid,
    },
    { type: 'user', uuid: 's1', parentUuid: 'b1', timestamp: '2026-01-01T00:00:06Z', isSidechain: false, isCompactSummary: true, isVisibleInTranscriptOnly: true, sessionId: sid, message: { role: 'user', content: 'This session is being continued from a previous conversation… 摘要' } },
    asstRec('a2', 's1', 'm2', [{ type: 'text', text: 'after compact' }], { sessionId: sid }),
    { type: 'last-prompt', lastPrompt: 'after compact', leafUuid: 'a2', sessionId: sid },
  ]);
  await fs.writeFile(join(dir, `${sid}.jsonl`), records);
  const ir = await new ClaudeAdapter().parse(sid, root);
  assert.ok(ir.compaction?.length === 1, 'compaction 桶登记');
  const anchorIdx = ir.compaction![0].anchorIndex!;
  const anchorMsg = ir.messages[anchorIdx];

  assert.ok(anchorMsg.content.some((b) => b.type === 'text' && (b as { text: string }).text.includes('continued from a previous')));
  // 无损（§8#7 诚实边界）：boundary parentUuid=null 截断父链，pre-boundary 段不进活跃链
  // → messages 只含 boundary 之后的投影；被折叠内容由 recordsRaw（全文件原始行）兜底。
  const recordsRaw = (ir.extensions?.claude as { recordsRaw?: unknown[] } | undefined)?.recordsRaw ?? [];
  assert.ok(
    recordsRaw.some((r) => typeof r === 'object' && r !== null &&
      (r as { message?: { content?: unknown } }).message?.content === '被折叠的旧消息'),
    '被折叠消息由 recordsRaw 无损保底',
  );
  assert.ok(!ir.messages.some((m) => m.content.some((b) => (b as { text?: string }).text === '被折叠的旧消息')), '活跃链不含 boundary 前折叠段');
});

/* ---------------- write side ---------------- */

test('write: native stamps, per-tool_result user records, last-prompt leafUuid', () => {
  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'claude',
    cwd: 'D:\\proj',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'run both' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }, { type: 'tool_use', id: 'tu2', name: 'Read', input: { path: 'x' } }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'tu1', content: 'out', rawResult: { stdout: 'out', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'tu2', content: 'file body', rawResult: 'plain string result' }] },
    ],
  };
  const built = buildMainRecords(ir, 'sid-1', { targetCwd: 'D:\\proj', nowMs: 1700000000000 });
  const records = built.records;
  const trs = records.filter(
    (r) => r.type === 'user' && Array.isArray((r.message as { content?: unknown[] })?.content) &&
      ((r.message as { content: unknown[] }).content as Array<{ type?: string }>).some((b) => b?.type === 'tool_result'),
  );
  assert.equal(trs.length, 2, '每条 tool_result 独立 user 记录');
  const asst = records.find((r) => r.type === 'assistant');
  assert.ok(asst);
  for (const tr of trs) {
    assert.equal(tr.parentUuid, (asst as { uuid: string }).uuid);
    assert.equal(tr.sourceToolAssistantUUID, (asst as { uuid: string }).uuid);
  }
  const withStruct = trs.find((r) => typeof r.toolUseResult === 'object') as { toolUseResult: { stdout: string } } | undefined;
  assert.equal(withStruct?.toolUseResult.stdout, 'out');
  const lp = records.at(-1) as Record<string, unknown>;
  assert.equal(lp.type, 'last-prompt');
  assert.ok(lp.leafUuid, 'last-prompt 带 leafUuid');
  assert.ok(!('cwd' in lp), 'last-prompt 不带 cwd');
  const firstKeys = Object.keys(records[0]);
  assert.ok(firstKeys.indexOf('message') < firstKeys.indexOf('userType'), 'message 本体在 userType 之前');
  assert.ok(firstKeys.indexOf('sessionId') < firstKeys.indexOf('version'), 'sessionId 在 version 之前');
  assert.ok(firstKeys.indexOf('session_id') > -1, 'snake_case session_id 双写');
});

/* ---------------- round-trip + no-overwrite ---------------- */

test('write → parse round-trip + refuse-overwrite', async () => {
  const adapter = new ClaudeAdapter();
  const root = await tempRoot();
  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'claude',
    cwd: 'D:\\proj',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '你好，迁移' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'call-1', name: 'read', input: { file_path: 'x.md' } }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call-1', content: '<内容>', rawResult: { stdout: 'ok' } }] },
    ],
  };
  const res = await adapter.write(ir, { root, targetCwd: 'D:\\proj' });
  assert.ok(res.paths[0].endsWith('.jsonl'));
  const back = await adapter.parse(res.sessionId, root);
  assert.equal(back.messages.length, ir.messages.length);
  assert.equal((back.messages[0].content[0] as { text: string }).text, '你好，迁移');
  const trMsg = back.messages.find((m) => m.content.some((b) => b.type === 'tool_result'))!;
  const trBlock = trMsg.content.find((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')! as { rawResult?: { stdout: string } };
  assert.equal(trBlock.rawResult?.stdout, 'ok');

  // 防覆盖红线：显式 sessionId 已存在 → 拒绝
  await assert.rejects(
    () => adapter.write(ir, { root, targetCwd: 'D:\\proj', sessionId: res.sessionId }),
    /refusing to overwrite/,
  );
});

/* ---------------- listSessions filters ---------------- */

test('listSessions: uuid gate + isSidechain/teamName filters', async () => {
  const adapter = new ClaudeAdapter();
  const root = await tempRoot();
  const dir = join(root, claudeProjectDirName('D:\\proj'));
  await fs.mkdir(dir, { recursive: true });
  const sid = randomUUID();
  await fs.writeFile(join(dir, `${sid}.jsonl`), writeRecords([
    { type: 'user', uuid: 'x1', parentUuid: null, isSidechain: false, sessionId: sid, timestamp: TS0, cwd: 'D:\\proj', message: { role: 'user', content: 'hello' } },
  ]));
  // same-directory sidechain (老版本布局): first line isSidechain:true
  await fs.writeFile(join(dir, `${randomUUID()}.jsonl`), writeRecords([
    { type: 'user', uuid: 'y1', parentUuid: null, isSidechain: true, message: { role: 'user', content: 'sub' } },
  ]));
  // tmux teammate main file: isSidechain:false but teamName stamp
  await fs.writeFile(join(dir, `${randomUUID()}.jsonl`), writeRecords([
    { type: 'user', uuid: 'y2', parentUuid: null, isSidechain: false, teamName: 'my-team', agentName: 'alice', message: { role: 'user', content: 'team' } },
  ]));
  // non-uuid filename
  await fs.writeFile(join(dir, 'not-a-uuid.jsonl'), writeRecords([{ type: 'user', uuid: 'z', message: { role: 'user', content: 'x' } }]));

  const metas = await adapter.listSessions(root);
  const ids = metas.map((m) => m.sessionId);
  assert.ok(ids.includes(sid));
  assert.ok(!ids.includes('not-a-uuid'));
});
