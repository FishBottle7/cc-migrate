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
import { parseClaudeLines, buildConversationChain, projectChain } from '../src/adapters/claude/parse.js';
import type { ClaudeRawRecord } from '../src/adapters/claude/parse.js';
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

/* ---------------- 纯状态提醒 attachment（2026-09-07 真机裁定） ---------------- */

test('parse: token/budget 计量提醒不投影为消息，原行进 sessionEvents；语义 attachment 照旧', async () => {
  // 真机实测（mock 请求体捕获）：total_tokens_reminder 每个用户 prompt 落一条、
  // resume 时 24/24 全量回放——但内容是过期倒计时快照，语义价值为零。跨工具
  // 迁移不再为它们生成对话消息（用户拍板「全部不投影」）；原行进 sessionEvents
  // 保真，claude→claude 走 recordsRaw 字节直通不受影响。有语义负载的
  // attachment（skill_listing 等）是模型上下文的真实组成部分，照旧投影。
  const root = await tempRoot();
  const dir = join(root, claudeProjectDirName('D:\\proj'));
  await fs.mkdir(dir, { recursive: true });
  const sid = randomUUID();
  const attRow = (uuid: string, attachment: Record<string, unknown>): Record<string, unknown> => ({
    type: 'attachment', uuid, parentUuid: 'a1', timestamp: TS0, isSidechain: false, sessionId: sid, attachment,
  });
  const records: Record<string, unknown>[] = [
    userRec('u1', null, 'hello', { sessionId: sid, cwd: 'D:\\proj' }),
    asstRec('a1', 'u1', 'msg_1', [{ type: 'text', text: 'ok' }], { sessionId: sid }),
    attRow('at1', { type: 'total_tokens_reminder', text: '<total_tokens>15000000 tokens left</total_tokens>' }),
    attRow('at2', { type: 'token_usage', used: 100, total: 200, remaining: 100 }),
    attRow('at3', { type: 'budget_usd', used: 1, total: 10, remaining: 9 }),
    attRow('at4', { type: 'output_token_usage', turn: 5, session: 50, budget: null }),
    attRow('at5', { type: 'skill_listing', content: 'skill lines', skillCount: 1 }),
    { type: 'last-prompt', lastPrompt: 'hello', leafUuid: 'a1', sessionId: sid },
  ];
  await fs.writeFile(join(dir, `${sid}.jsonl`), writeRecords(records));

  const adapter = new ClaudeAdapter();
  const ir = await adapter.parse(sid, root);

  const attTypeOf = (m: (typeof ir.messages)[number]) =>
    (m.meta?.claude as { attachment?: { type?: string } } | undefined)?.attachment?.type;
  const PURE = ['total_tokens_reminder', 'token_usage', 'budget_usd', 'output_token_usage'];
  assert.equal(
    ir.messages.filter((m) => PURE.includes(String(attTypeOf(m)))).length, 0,
    '纯状态提醒不投影为 IR 消息',
  );
  for (const t of PURE) {
    const ev = ir.sessionEvents?.find((e) =>
      (e.data as { attachment?: { type?: string } } | undefined)?.attachment?.type === t);
    assert.ok(ev, `${t} 原行 → sessionEvents 保真`);
    assert.equal(ev!.type, 'attachment');
  }
  const skillMsg = ir.messages.find((m) => attTypeOf(m) === 'skill_listing');
  assert.ok(skillMsg, '有语义的 attachment 照旧投影');
  assert.equal(skillMsg!.synthetic, true);
});

/* ---------------- agent-authored user rows（2026-09-05 真机裁定） ---------------- */

test('agent-authored user rows: 打断标记/teammate 信封/侧链 prompt → synthetic；混装行按 run 拆分', () => {
  // 真机样本：打断行全部 isMeta 缺失（57 行实测），是 harness 行不是人话；
  // 打断标记可与真人新输入同行混装（["[Request interrupted by user for tool
  // use]\n", "这个subagent已经完成切片了啊…"]），必须拆开分别定性；
  // 子代理转写（isSidechain）的 user 行全部是 spawn prompt / teammate 消息。
  const records: ClaudeRawRecord[] = [
    userRec('u1', null, '正常人类提问') as ClaudeRawRecord,
    userRec('u2', 'a1', '[Request interrupted by user]') as ClaudeRawRecord,
    userRec('u3', 'u2', [
      { type: 'text', text: '[Request interrupted by user for tool use]\n' },
      { type: 'text', text: '这个subagent已经完成切片了啊，要不你去看看？' },
    ]) as ClaudeRawRecord,
    userRec('u4', 'u3', 'Another Claude session sent a message:\n<teammate-message teammate_id="P2a" color="blue">\n{"type":"idle_notification"}\n</teammate-message>\n\nThis came from another Claude session — not typed by your user.') as ClaudeRawRecord,
    userRec('u5', 'u4', '研读源码，确认 session.jsonl.zstd 存储格式（子代理 spawn prompt，纯文本无标记）', { isSidechain: true }) as ClaudeRawRecord,
  ];
  const chain = records.map((rec, line) => ({ rec, line }));
  const { messages } = projectChain(chain, { legacySummaries: [], contentReplacements: [], rows: [] });

  const byText = (needle: string) => messages.filter((m) => m.content.some((b) => b.type === 'text' && (b as { text: string }).text.includes(needle)));
  assert.equal(byText('正常人类提问').length, 1);
  assert.equal(byText('正常人类提问')[0].synthetic, undefined, '纯人话行零回归');

  const interrupt = byText('[Request interrupted by user]')[0];
  assert.ok(interrupt, '打断行保留（模型上下文红线）');
  assert.equal(interrupt.synthetic, true, '纯打断行 → agent-authored 注入');
  assert.equal(interrupt.content.length, 1, '内容零丢弃');

  const mixed = messages.filter((m) => (m.meta?.claude as { uuid?: string } | undefined)?.uuid === 'u3');
  assert.equal(mixed.length, 2, '混装行拆成两条 IR 消息');
  assert.equal(mixed[0].synthetic, true, '打断标记 run → 注入');
  assert.equal((mixed[0].content[0] as { text: string }).text, '[Request interrupted by user for tool use]\n');
  assert.equal(mixed[1].synthetic, undefined, '真人新输入 run → 人话');
  assert.equal((mixed[1].content[0] as { text: string }).text, '这个subagent已经完成切片了啊，要不你去看看？');

  const teammate = byText('<teammate-message')[0];
  assert.ok(teammate, 'teammate 信封行保留');
  assert.equal(teammate.synthetic, true, '跨代理消息 → 注入（子代理之间的对话不是用户信息）');

  const spawn = byText('研读源码')[0];
  assert.equal(spawn.synthetic, true, '侧链 spawn prompt（纯文本无标记）→ 注入');

  // 打断标记/teammate 行的 toolUseResult 侧载荷不丢（interrupt-for-tool-use 行携带）
  assert.ok(byText('[Request interrupted by user]')[0].meta?.claude, 'envelope meta 随行保留');
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

/* ------------------------------------------------------------------
 * 审查缺陷修复（P0/P1）
 * ------------------------------------------------------------------ */

async function rowsOf(path: string): Promise<Record<string, unknown>[]> {
  const text = await fs.readFile(path, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test('P0-A: 投影写直通重放 sessionEvents 原生 system 行，re-parse 回桶', async () => {
  // dsh IR 的 sessionEvents 桶携带 claude 原生 system 行（claude→dsh 迁移残留）——
  // 投影写必须落盘这两行，否则桶整桶静默丢失（v3.2 登记：写端直通重放）。
  const root = await tempRoot();
  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'dsh',
    cwd: 'D:\\proj',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'run' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ],
    sessionEvents: [
      {
        seq: 5,
        time: 1760000000000,
        type: 'turn_duration',
        data: { type: 'system', subtype: 'turn_duration', durationMs: 42, messageCount: 4, uuid: 's-old-1', parentUuid: 'a-old', timestamp: '2026-01-01T00:00:00.050Z' },
      },
      {
        seq: 6,
        time: 1760000000100,
        type: 'stop_hook_summary',
        data: { type: 'system', subtype: 'stop_hook_summary', hookCount: 2, hookErrors: null, preventedContinuation: false, uuid: 's-old-2', parentUuid: 's-old-1', timestamp: '2026-01-01T00:00:00.060Z' },
      },
    ],
  };
  const adapter = new ClaudeAdapter();
  const res = await adapter.write(ir, { root, targetCwd: 'D:\\proj' });
  const rows = await rowsOf(res.paths[0]);

  const td = rows.find((r) => r.type === 'system' && r.subtype === 'turn_duration');
  const shs = rows.find((r) => r.type === 'system' && r.subtype === 'stop_hook_summary');
  assert.ok(td, 'turn_duration 行落盘');
  assert.ok(shs, 'stop_hook_summary 行落盘');
  assert.equal(td!.durationMs, 42, 'payload 原样重放');
  assert.equal(td!.messageCount, 4);
  assert.equal(shs!.hookCount, 2);
  // 源 uuid 体系不进文件：换新 uuid + parentUuid 重锚到本文件链
  assert.notEqual(td!.uuid, 's-old-1');
  assert.ok(typeof td!.uuid === 'string' && td!.uuid, '新 uuid');
  assert.ok(typeof td!.parentUuid === 'string' && td!.parentUuid, 'parentUuid 重锚（非悬挂）');

  // re-parse：两行回到 sessionEvents 桶（读端把非对话 subtype 行归桶）
  const back = await adapter.parse(res.sessionId, root);
  assert.ok(back.sessionEvents?.some((e) => e.type === 'turn_duration'), 'turn_duration 回桶');
  assert.ok(back.sessionEvents?.some((e) => e.type === 'stop_hook_summary'), 'stop_hook_summary 回桶');
  // 会话主体不受重放行干扰
  assert.equal(back.messages.length, 2);
});

test('P0-A: compact_boundary subtype 与 compaction 桶重叠，sessionEvents 不双写', () => {
  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'dsh',
    cwd: 'D:\\proj',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
    compaction: [{ summary: 'S', anchorIndex: 0 }],
    // 外来 IR 硬塞 compact_boundary 行进桶：compaction 桶已承载 boundary，
    // 重放会造成第二份无配对 boundary（双写），必须跳过
    sessionEvents: [
      { seq: 3, time: 1, type: 'compact_boundary', data: { type: 'system', subtype: 'compact_boundary', uuid: 'dup-b', timestamp: TS0 } },
      { seq: 4, time: 1, type: 'informational', data: { type: 'system', subtype: 'informational', content: 'info', uuid: 'info-b', timestamp: TS0 } },
    ],
  };
  const built = buildMainRecords(ir, 'sess-a', { targetCwd: 'D:\\proj', nowMs: 1000 });
  const boundaries = built.records.filter((r) => r.subtype === 'compact_boundary');
  assert.equal(boundaries.length, 1, 'boundary 只由 compaction 桶产出一份');
  assert.ok(built.records.some((r) => r.subtype === 'informational'), '非重叠 subtype 照常重放');
});

test('P0-B: 跨工具 compaction 的 stale preservedMessages 不落盘，re-parse 消息不缩水', async () => {
  const root = await tempRoot();
  const SUMMARY = 'This session is being continued from a previous conversation… 摘要';
  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'dsh',
    cwd: 'D:\\proj',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'r1' }] },
      { role: 'user', content: [{ type: 'text', text: SUMMARY }] },
      { role: 'user', content: [{ type: 'text', text: 'after compact' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'post-compact reply' }] },
    ],
    compaction: [
      {
        summary: SUMMARY,
        anchorIndex: 2,
        meta: {
          claude: {
            compactMetadata: {
              trigger: 'manual',
              preTokens: 1000,
              preservedMessages: { anchorUuid: 'b-old', uuids: ['u1', 'a1'] }, // 旧 uuid 体系
            },
          },
        },
      },
    ],
  };
  const adapter = new ClaudeAdapter();
  const res = await adapter.write(ir, { root, targetCwd: 'D:\\proj' });
  const boundary = (await rowsOf(res.paths[0])).find((r) => r.subtype === 'compact_boundary') as
    | { compactMetadata?: { preservedMessages?: unknown; preservedSegment?: unknown; trigger?: string; preTokens?: number } }
    | undefined;
  assert.ok(boundary, 'boundary 落盘');
  // 引用未发射 uuid 的 preserved* 删除——原生读端对缺 preserved 元数据是 no-op + 全史
  assert.equal(boundary!.compactMetadata?.preservedMessages, undefined, 'stale preservedMessages 删除');
  assert.equal(boundary!.compactMetadata?.preservedSegment, undefined, 'stale preservedSegment 删除');
  assert.equal(boundary!.compactMetadata?.trigger, 'manual', '其余 compactMetadata 保留');
  assert.equal(boundary!.compactMetadata?.preTokens, 1000);

  // re-parse：消息数不缩水（boundary 后 3 行 + compaction 登记）
  const back = await adapter.parse(res.sessionId, root);
  assert.ok(back.messages.length >= 3, `re-parse 消息不缩水（got ${back.messages.length}）`);
  assert.equal(back.compaction?.length, 1, 'compaction 桶登记');
  assert.ok(back.messages.some((m) => m.content.some((b) => b.type === 'text' && (b as { text: string }).text === 'after compact')));
  assert.ok(back.messages.some((m) => m.content.some((b) => b.type === 'text' && (b as { text: string }).text === 'post-compact reply')));
});

test('P1-A: local_command 归 isMeta 族——默认写保留，re-parse 回 user 文本', async () => {
  // claude.md §2.3: local_command 转用户文本进 API 回放，不是 presentation-only，
  // 不随 keepSynthetic=false 丢弃（丢弃 = 丢模型上下文）。
  const root = await tempRoot();
  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'dsh',
    cwd: 'D:\\proj',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'run' }] },
      {
        role: 'user',
        synthetic: true,
        content: [{ type: 'text', text: '$ ls\nfile.txt' }],
        meta: { claude: { systemSubtype: 'local_command', level: 'info' } },
      },
    ],
  };
  const adapter = new ClaudeAdapter();
  const res = await adapter.write(ir, { root, targetCwd: 'D:\\proj' }); // 默认不开 keepSynthetic
  const lc = (await rowsOf(res.paths[0])).find((r) => r.type === 'system' && r.subtype === 'local_command');
  assert.ok(lc, 'local_command 行默认写保留');
  assert.equal(lc!.content, '$ ls\nfile.txt');

  const back = await adapter.parse(res.sessionId, root);
  const lcMsg = back.messages.find(
    (m) => (m.meta?.claude as { systemSubtype?: string } | undefined)?.systemSubtype === 'local_command',
  );
  assert.ok(lcMsg, 're-parse 回 user 文本形态（回放语义）');
  assert.equal((lcMsg!.content[0] as { text: string }).text, '$ ls\nfile.txt');
});

test('P1-C: native.content 的 tool_use id 与 IR 块不一致 → 回退合成，无孤儿 tool_use_id', () => {
  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'dsh',
    cwd: 'D:\\proj',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'IR-ID', name: 'Bash', input: {} }],
        meta: {
          claude: {
            message: {
              id: 'msg_native', role: 'assistant', type: 'message',
              content: [{ type: 'tool_use', id: 'NATIVE-ONLY-ID', name: 'Bash', input: {} }],
            },
          },
        },
      },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'IR-ID', content: 'ok' }] },
    ],
  };
  const built = buildMainRecords(ir, 'sess-c', { targetCwd: 'D:\\proj', nowMs: 1700000000000 });
  const json = JSON.stringify(built.records);
  assert.ok(!json.includes('NATIVE-ONLY-ID'), '不一致的 native tool_use id 不落盘（回退合成）');
  assert.ok(json.includes('IR-ID'), 'IR 块重建的 id 落盘');
  // 配对自洽：文件内每个 tool_result.tool_use_id 都有对应 tool_use 块
  const toolUseIds = new Set<string>();
  for (const r of built.records) {
    if (r.type !== 'assistant') continue;
    for (const b of (r.message as { content: Array<{ type?: string; id?: string }> }).content ?? []) {
      if (b.type === 'tool_use' && b.id) toolUseIds.add(b.id);
    }
  }
  for (const r of built.records) {
    if (r.type !== 'user') continue;
    const c = (r.message as { content?: unknown }).content;
    if (!Array.isArray(c)) continue;
    for (const b of c as Array<{ type?: string; tool_use_id?: string }>) {
      if (b?.type === 'tool_result') {
        assert.ok(toolUseIds.has(b.tool_use_id!), `孤儿 tool_use_id: ${b.tool_use_id}`);
      }
    }
  }
});

test('P1-C 回归: native.content 与 IR 块一致时仍逐字节透传', () => {
  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'dsh',
    cwd: 'D:\\proj',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'TU-1', name: 'Bash', input: { command: 'ls' } }],
        meta: {
          claude: {
            message: {
              id: 'msg_native_2', role: 'assistant', type: 'message', model: 'claude-sonnet-4-5',
              content: [{ type: 'tool_use', id: 'TU-1', name: 'Bash', input: { command: 'ls' }, caller: 'subagent-1' }],
            },
          },
        },
      },
    ],
  };
  const built = buildMainRecords(ir, 'sess-c2', { targetCwd: 'D:\\proj', nowMs: 1700000000000 });
  const asst = built.records.find((r) => r.type === 'assistant') as
    | { message?: { id?: string; content?: Array<{ caller?: string }> } }
    | undefined;
  assert.ok(asst, 'assistant 记录落盘');
  assert.equal(asst!.message?.id, 'msg_native_2', 'native message 透传');
  assert.equal(asst!.message?.content?.[0]?.caller, 'subagent-1', 'native 块级字段（caller）无损');
});

test('P1-D: anchor 消息的非摘要块照常 emit（不再整条丢）+ 摘要不双写', async () => {
  const root = await tempRoot();
  const SUMMARY = 'This session is being continued from a previous conversation… 摘要';
  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'dsh',
    cwd: 'D:\\proj',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { role: 'user', content: [{ type: 'text', text: SUMMARY }, { type: 'text', text: 'ANCHOR-EXTRA-BLOCK' }] },
      { role: 'user', content: [{ type: 'text', text: 'after' }] },
    ],
    compaction: [{ summary: SUMMARY, anchorIndex: 1 }],
  };
  const adapter = new ClaudeAdapter();
  const res = await adapter.write(ir, { root, targetCwd: 'D:\\proj' });
  const back = await adapter.parse(res.sessionId, root);
  assert.ok(
    back.messages.some((m) => m.content.some((b) => b.type === 'text' && (b as { text: string }).text === 'ANCHOR-EXTRA-BLOCK')),
    'anchor 消息的额外 text 块存活',
  );
  const summaryCount = back.messages.filter((m) =>
    m.content.some((b) => b.type === 'text' && (b as { text: string }).text === SUMMARY),
  ).length;
  assert.equal(summaryCount, 1, '摘要只落盘一遍（emitCompactionPair 承载，不双写）');
  assert.equal(back.compaction?.length, 1);
});

test('P1-D: 越界 anchorIndex 显式警告，boundary 不静默落盘', () => {
  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'dsh',
    cwd: 'D:\\proj',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
    compaction: [{ summary: 'S', anchorIndex: 99 }, { summary: 'legacy-no-anchor' }],
  };
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
  try {
    const built = buildMainRecords(ir, 'sess-d', { targetCwd: 'D:\\proj', nowMs: 1000 });
    const boundaries = built.records.filter((r) => r.subtype === 'compact_boundary');
    // 越界 entry 无锚定点不能伪造位置 → 不落盘；缺 anchorIndex 的遗留形状保持静默跳过
    assert.equal(boundaries.length, 0);
    assert.equal(warnings.length, 1, '恰好一条警告');
    assert.match(warnings[0]!, /anchorIndex 99 out of range/);
  } finally {
    console.warn = origWarn;
  }
});

/* ------------------------------------------------------------------
 * preserved 段有限 rekey（P0-B 升级）
 * ------------------------------------------------------------------ */

// 构造 claude 源投影形态的 IR：消息 meta.claude 携带源行 uuid（parse.ts
// envelopeMeta 登记），compaction.preservedMessages.uuids 引用同一批源 uuid。
function claudeSourcedIr(preservedUuids: string[]): MigratedSession {
  const SUMMARY = 'This session is being continued from a previous conversation… 摘要';
  const mk = (role: 'user' | 'assistant', text: string, srcUuid: string): {
    role: 'user' | 'assistant';
    content: ContentBlock[];
    meta: { claude: { uuid: string } };
  } => ({ role, content: [{ type: 'text', text }], meta: { claude: { uuid: srcUuid } } });
  return {
    schemaVersion: 2,
    originTool: 'claude',
    cwd: 'D:\\proj',
    messages: [
      mk('user', '旧问题1', 'src-u1'),
      mk('assistant', '旧回复1', 'src-a1'),
      mk('user', '旧问题2', 'src-u2'),
      mk('assistant', '旧回复2', 'src-a2'),
      { role: 'user', content: [{ type: 'text', text: SUMMARY }] },
      mk('user', 'after compact', 'src-u3'),
      mk('assistant', 'post-compact reply', 'src-a3'),
    ],
    compaction: [
      {
        summary: SUMMARY,
        anchorIndex: 4,
        meta: {
          claude: {
            compactMetadata: {
              trigger: 'manual',
              preTokens: 1000,
              preservedMessages: { anchorUuid: 'src-boundary', uuids: preservedUuids },
            },
          },
        },
      },
    ],
  };
}

function findBoundary(records: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return records.find((r) => r.subtype === 'compact_boundary');
}

test('P0-B rekey 全命中: preserved 引用真实源 uuid → 换新后落盘，re-parse 折叠语义恢复', async () => {
  const root = await tempRoot();
  const ir = claudeSourcedIr(['src-u1', 'src-a1', 'src-u2', 'src-a2']);
  const adapter = new ClaudeAdapter();
  const res = await adapter.write(ir, { root, targetCwd: 'D:\\proj' });
  const rows = await rowsOf(res.paths[0]);
  const boundary = findBoundary(rows) as
    | { uuid?: string; compactMetadata?: { preservedMessages?: { anchorUuid?: string; uuids?: string[] } } }
    | undefined;
  assert.ok(boundary, 'boundary 落盘');
  const pm = boundary!.compactMetadata?.preservedMessages;
  assert.ok(pm, '全命中：preservedMessages 字段存活（不再整删）');
  assert.equal(pm!.uuids!.length, 4, '四个引用全部保留');
  // 全部换新：文件里能找到每个新 uuid，且不再有 src- 旧引用
  const uuidsInFile = new Set(rows.map((r) => String(r.uuid)).filter(Boolean));
  for (const u of pm!.uuids!) {
    assert.ok(uuidsInFile.has(u), `rekey 后的新 uuid 在文件中存在: ${u}`);
    assert.ok(!u.startsWith('src-'), '旧 uuid 不落盘');
  }
  // anchorUuid 指向本 boundary 自身的新 uuid
  assert.equal(pm!.anchorUuid, boundary!.uuid);

  // re-parse：读端 applyPreservedSegmentRelinks 按 preservedMessages 收集保留段
  // + 剪掉最后 boundary 前的其余行 → 折叠语义（保留 4 条 + 摘要 + 2 条新对话）
  const back = await adapter.parse(res.sessionId, root);
  assert.ok(back.messages.some((m) => m.content.some((b) => (b as { text?: string }).text === '旧问题1')), '保留段消息1 在 re-parse 后存活');
  assert.ok(back.messages.some((m) => m.content.some((b) => (b as { text?: string }).text === '旧回复2')), '保留段消息4 在 re-parse 后存活');
  assert.ok(back.messages.some((m) => m.content.some((b) => (b as { text?: string }).text === 'after compact')), 'boundary 后消息存活');
  assert.ok(!back.messages.some((m) => m.content.some((b) => (b as { text?: string }).text === '不存在的消息')), 'sanity');
  assert.equal(back.compaction?.length, 1, 'compaction 桶登记');
});

test('P0-B rekey 零命中: 引用不存在的旧 uuid → 字段删除（既有行为保持）', async () => {
  const root = await tempRoot();
  const ir = claudeSourcedIr(['ghost-1', 'ghost-2']);
  const adapter = new ClaudeAdapter();
  const res = await adapter.write(ir, { root, targetCwd: 'D:\\proj' });
  const boundary = findBoundary(await rowsOf(res.paths[0])) as
    | { compactMetadata?: { preservedMessages?: unknown; trigger?: string; preTokens?: number } }
    | undefined;
  assert.ok(boundary, 'boundary 落盘');
  assert.equal(boundary!.compactMetadata?.preservedMessages, undefined, '零命中：字段删除');
  assert.equal(boundary!.compactMetadata?.trigger, 'manual', '其余 compactMetadata 保留');
  assert.equal(boundary!.compactMetadata?.preTokens, 1000);
  // re-parse 不缩水（无 preserved → no-op + 全史加载）
  const back = await adapter.parse(res.sessionId, root);
  assert.ok(back.messages.length >= 3, 're-parse 消息不缩水');
});

test('P0-B rekey 部分命中: 只保留命中项（数组过滤），未命中项不悬挂', async () => {
  const root = await tempRoot();
  const ir = claudeSourcedIr(['src-u1', 'ghost-2', 'src-a2']);
  const adapter = new ClaudeAdapter();
  const res = await adapter.write(ir, { root, targetCwd: 'D:\\proj' });
  const rows = await rowsOf(res.paths[0]);
  const boundary = findBoundary(rows) as
    | { uuid?: string; compactMetadata?: { preservedMessages?: { anchorUuid?: string; uuids?: string[] } } }
    | undefined;
  assert.ok(boundary, 'boundary 落盘');
  const pm = boundary!.compactMetadata?.preservedMessages;
  assert.ok(pm, '部分命中：字段存活');
  assert.equal(pm!.uuids!.length, 2, '只保留两个命中项');
  const uuidsInFile = new Set(rows.map((r) => String(r.uuid)).filter(Boolean));
  for (const u of pm!.uuids!) {
    assert.ok(uuidsInFile.has(u), `保留项的新 uuid 在文件中存在: ${u}`);
  }
  assert.equal(pm!.anchorUuid, boundary!.uuid);
});
