/**
 * Phase 5 损坏文件容错矩阵（read-tolerance battery）。
 *
 * 范围：六家适配器读端（parse / listSessions）对损坏源文件的分类行为——
 * 每一档都在真实磁盘 fixture 上锚定，防止容错纪律随重构退化：
 *
 *  A. torn/corrupt JSONL 行（中间行坏 / 末行截断）
 *     - JSONL 家族（claude/codex/pi/dsh/mirror）逐行定性：好行存活、坏行按家
 *       纪律归档或跳过，绝不整份裸抛 SyntaxError；
 *     - dsh 是唯一「坏行以 (torn-line) 事件原样归档 unmappedEvents」的家
 *       （与它「无损事件日志」的 IR 定位一致）。
 *  B. 完全不是会话文件（垃圾字节 / 非法 zstd 流）
 *     - 必须显式报错且文案含文件定位（绝不能静默产出空会话或裸 zlib stack）；
 *     - DB 家（opencode/zcode）已锚定「坏 store 报错而非 []」，此处补 parse 侧。
 *  C. listSessions 单损坏文件不炸全列表
 *     - 多文件库里一个损坏文件，其余文件的行必须全部返回。
 *  D. 结构级损坏（dangling parent、环、非事件 JSON 行）走各家既有定性路径。
 *
 * 本文件不复制各家的正常形状测试（各 <tool>.test.ts 已覆盖），只锚定损坏面。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';

import { DshAdapter } from '../src/adapters/dsh/index.js';
import { compressFrame, decompressSessionBuffer } from '../src/adapters/dsh/format.js';
import { ClaudeAdapter } from '../src/adapters/claude/index.js';
import { claudeProjectDirName } from '../src/adapters/claude/path.js';
import { CodexAdapter } from '../src/adapters/codex/index.js';
import { uuidv7 } from '../src/adapters/codex/paths.js';
import { PiAdapter } from '../src/adapters/pi/index.js';
import { OpenCodeAdapter } from '../src/adapters/opencode/index.js';
import { ZcodeAdapter } from '../src/adapters/zcode/index.js';

async function tempRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), prefix));
}

function writeJsonl(lines: string[]): string {
  return lines.filter((l) => l.length > 0).join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* DSH — zstd 帧物理层 + JSONL 行级容错                                  */
/* ------------------------------------------------------------------ */

/** Build a DSH session artifact: header frame + N event frames.
 * Layout matches the native writer: header in its own frame, then one frame
 * per event batch — a torn event row inside frame k never kills rows in
 * frame k+1 (they are separately compressed). */
function buildDshLog(header: Record<string, unknown>, eventLines: string[]): Buffer {
  const parts = [compressFrame(`${JSON.stringify(header)}\n`)];
  for (const line of eventLines) parts.push(compressFrame(`${line}\n`));
  return Buffer.concat(parts);
}

function dshHeader(id: string, cwd = 'D:\\proj'): Record<string, unknown> {
  return { type: 'session', version: 0, id, createdAt: 1000, cwd };
}

/** A surface user/message event in the NATIVE data shape (verify.ts message
 * checks + eventToMessage read `data.id/role/source/content` directly — the
 * `{message:{…}}` wrapper shape does NOT project). */
function dshUserLine(seq: number, text: string): string {
  return JSON.stringify({
    seq, time: 1000 + seq, type: 'user/message', surfaceOp: 'append',
    data: { id: `msg_${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  });
}

test('dsh parse: torn event lines are archived as torn-line events, good rows survive', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot('sm-tol-dsh-');
  const dir = join(root, '--D-proj--', 'session-torn');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    join(dir, 'session.jsonl.zstd'),
    buildTornDshLog(dshHeader('session-torn'), [
      { line: dshUserLine(0, 'first') },
      { raw: '{"seq":1,"time":1001,"type":"user/message","surfaceOp":"append","data":{"message":{"role":"user"' }, // torn JSON
      { raw: '"just a string row"' }, // valid JSON, not an event envelope
      { line: dshUserLine(3, 'last') },
    ]),
  );

  const ir = await adapter.parse('session-torn', root);
  // good rows survive as messages
  const texts = ir.messages.map((m) => (m.content[0] as { text?: string }).text);
  assert.deepEqual(texts, ['first', 'last'], 'parseable rows around the damage survive');
  // torn rows ride unmappedEvents (zero-drop), raw preserved verbatim
  const torn = (ir.unmappedEvents ?? []).filter((e) => e.type === 'torn-line');
  assert.equal(torn.length, 2, 'both torn rows archived (bad JSON + non-event JSON)');
  const raws = torn.map((t) => String((t.data as Record<string, unknown>).raw));
  assert.ok(raws.some((r) => r.includes('user/message')), 'torn JSON raw preserved verbatim');
  assert.ok(raws.includes('"just a string row"'), 'non-event JSON raw preserved verbatim');
  // seqs assigned after the max existing unmapped seq (no collision)
  const seqs = (ir.unmappedEvents ?? []).map((e) => e.seq);
  assert.equal(new Set(seqs).size, seqs.length, 'archived seqs are unique');
});

test('dsh parse: torn TRAILING zstd frame is salvaged, prefix frames survive', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot('sm-tol-dsh-');
  const dir = join(root, '--D-proj--', 'session-tail');
  await fs.mkdir(dir, { recursive: true });
  // native dump shape: frame 0 = header, frame 1 = all events. Append a torn
  // trailing frame (valid magic + garbage body) — the copy-while-appending shape.
  const dump = buildDshLog(dshHeader('session-tail'), [dshUserLine(0, 'salvaged')]);
  const garbage = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x11, 0x22, 0x33, 0x44]); // magic + junk
  await fs.writeFile(join(dir, 'session.jsonl.zstd'), Buffer.concat([dump, garbage]));

  const ir = await adapter.parse('session-tail', root);
  const texts = ir.messages.map((m) => (m.content[0] as { text?: string }).text);
  assert.ok(texts.includes('salvaged'), 'complete frames before the torn tail survive');
});

test('dsh parse: the only frame being garbage → readable error, not a bare zlib stack', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot('sm-tol-dsh-');
  const dir = join(root, '--D-proj--', 'session-garbage');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'session.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x11, 0x22, 0x33, 0x44]));
  await assert.rejects(
    () => adapter.parse('session-garbage', root),
    (e: Error) => {
      assert.match(e.message, /session-garbage/);
      assert.match(e.message, /decompress|zstd|empty|damaged/i);
      return true;
    },
  );
});

test('dsh parse: non-JSON header line → readable error naming the session', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot('sm-tol-dsh-');
  const dir = join(root, '--D-proj--', 'session-badhdr');
  await fs.mkdir(dir, { recursive: true });
  // non-JSON header
  await fs.writeFile(join(dir, 'session.jsonl.zstd'), compressFrame('not json at all\n'));
  await assert.rejects(
    () => adapter.parse('session-badhdr', root),
    (e: Error) => {
      assert.match(e.message, /session-badhdr/);
      assert.match(e.message, /header line is not valid JSON/);
      return true;
    },
  );
  // JSON but not a header object (string line)
  await fs.writeFile(join(dir, 'session.jsonl.zstd'), compressFrame('"a plain json string"\n'));
  await assert.rejects(
    () => adapter.parse('session-badhdr', root),
    (e: Error) => {
      assert.match(e.message, /session-badhdr/);
      assert.match(e.message, /not a session header object/);
      return true;
    },
  );
});

/* ------------------------------------------------------------------ */
/* Claude — 断行容忍（NUL 剥离 + 坏行跳过）锚定                          */
/* ------------------------------------------------------------------ */

const CTS = '2026-01-01T00:00:00.000Z';

function claudeUser(uuid: string, parentUuid: string | null, text: string): Record<string, unknown> {
  return { type: 'user', uuid, parentUuid, timestamp: CTS, isSidechain: false, message: { role: 'user', content: text } };
}

function claudeAssistant(uuid: string, parentUuid: string | null, msgId: string, text: string): Record<string, unknown> {
  return { type: 'assistant', uuid, parentUuid, timestamp: CTS, isSidechain: false, message: { id: msgId, role: 'assistant', type: 'message', content: [{ type: 'text', text }] } };
}

test('claude parse: torn rows (bad JSON, NUL-prefixed, non-object) are skipped, chain intact', async () => {
  const root = await tempRoot('sm-tol-claude-');
  const dir = join(root, claudeProjectDirName('D:\\proj'));
  await fs.mkdir(dir, { recursive: true });
  const sid = randomUUID();
  const tornFile = [
    JSON.stringify(claudeUser('u0', null, 'q1')),
    '{"type":"user","uuid":"u1","parentUuid":"u0","message":{"role":"user"'.slice(0, 30), // torn middle row
    JSON.stringify(claudeAssistant('a1', 'u0', 'msg_1', 'answer')).replace('{', '\u0000{'), // NUL-prefixed (native torn-row marker)
    '42', // valid JSON, not an object
    JSON.stringify(claudeUser('u2', 'a1', 'q2')), // dangling parent (torn row above was its parent) — chain survives via parentUuid walk
  ].join('\n');
  await fs.writeFile(join(dir, `${sid}.jsonl`), tornFile);

  const ir = await new ClaudeAdapter().parse(sid, root);
  const texts = ir.messages
    .filter((m) => m.content[0]?.type === 'text')
    .map((m) => (m.content[0] as { text: string }).text);
  assert.ok(texts.includes('q1') && texts.includes('answer'), 'rows around the torn row survive');
  assert.equal(ir.messages.filter((m) => m.role === 'user').length, 2, 'both user rows parse');
  assert.equal(ir.messages.filter((m) => m.role === 'assistant').length, 1);
});

test('claude listSessions: a torn file does not kill the listing of its neighbours', async () => {
  const root = await tempRoot('sm-tol-claude-');
  const dir = join(root, claudeProjectDirName('D:\\proj'));
  await fs.mkdir(dir, { recursive: true });
  const goodSid = randomUUID();
  await fs.writeFile(
    join(dir, `${goodSid}.jsonl`),
    writeJsonl([JSON.stringify(claudeUser('u0', null, 'hello neighbor'))]),
  );
  // not even valid JSON lines — readClaudeLinesForList tolerates and still returns a head
  await fs.writeFile(join(dir, `${randomUUID()}.jsonl`), '{"type":"user","uuid":');
  const metas = await new ClaudeAdapter().listSessions(root);
  assert.equal(metas.length, 2, 'the torn file still lists (tolerant head scan), neighbours unaffected');
});

/* ------------------------------------------------------------------ */
/* Codex — (unparseable) 归档 + listSessions 单损坏 .zst 不炸全列表      */
/* ------------------------------------------------------------------ */

const XTS = '2026-08-20T02:14:08.083Z';

function codexMetaLine(id: string, cwd = 'D:\\proj'): Record<string, unknown> {
  return {
    timestamp: XTS, type: 'session_meta',
    payload: { id, session_id: id, cwd, originator: 'codex_cli_rs', source: 'cli', thread_source: 'user', history_mode: 'legacy' },
  };
}

function codexUserItem(text: string): Record<string, unknown> {
  return {
    timestamp: XTS, type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  };
}

function codexThreadFile(threadId: string): string {
  return `rollout-2026-08-20T10-14-07-${threadId}.jsonl`;
}

/** Fixture thread ids are real uuidv7 shapes (native ThreadId) — uuidv4
 * ids cannot be found by findRolloutById's filename parser. */
const CT1 = uuidv7();
const CT2 = uuidv7();
const CT3 = uuidv7();
const CT4 = uuidv7();

/** A torn-row DSH artifact: a NATIVE dump layout (frame 0 = header+events
 * batch, one row per event) where selected rows are replaced by damage.
 * This is the copy-while-appending shape — the plaintext is one contiguous
 * buffer, so a torn row and the rows after it share the same frame. */
function buildTornDshLog(
  header: Record<string, unknown>,
  rows: Array<{ line: string } | { raw: string }>,
): Buffer {
  const body = rows.map((r) => ('line' in r ? r.line : r.raw)).join('\n');
  return compressFrame(`${JSON.stringify(header)}\n${body}\n`);
}

async function codexWriteSession(codexHome: string, threadId: string, lines: string[], zst: boolean): Promise<void> {
  const dir = join(codexHome, 'sessions', '2026', '08', '20');
  await fs.mkdir(dir, { recursive: true });
  const text = writeJsonl(lines);
  const name = `${codexThreadFile(threadId)}${zst ? '.zst' : ''}`;
  await fs.writeFile(join(dir, name), zst ? zstdCompressSync(Buffer.from(text, 'utf8')) : text);
}

test('codex parse: torn rollout lines become (unparseable) archived rows, zero-drop', async () => {
  const root = await tempRoot('sm-tol-codex-');
  const threadId = CT1;
  const lines = [
    JSON.stringify(codexMetaLine(threadId)),
    JSON.stringify(codexUserItem('real question')),
    '{"timestamp":"2026-08-20T02:14:09.000Z","type":"response_item","payload":{"type":"mess', // torn
    JSON.stringify({ timestamp: XTS, type: 'event_msg', payload: { type: 'token_count', info: { total: 1 } } }),
  ];
  await codexWriteSession(root, threadId, lines, false);
  const ir = await new CodexAdapter().parse(threadId, root);
  assert.equal(ir.messages.filter((m) => m.role === 'user').length, 1, 'good rows parse');
  const unparseable = (ir.unmappedEvents ?? []).filter((e) => e.type === '(unparseable)');
  assert.equal(unparseable.length, 1, 'the torn line is archived, not dropped nor thrown');
  // IR shape: the raw line rides data.codexRolloutLine.payload.raw (the
  // write side re-emits it verbatim from that slot)
  const line = unparseable[0].data as { codexRolloutLine?: { payload?: { raw?: string } } };
  assert.match(String(line?.codexRolloutLine?.payload?.raw ?? ''), /response_item/, 'raw payload preserved');
  // event rows after the torn line survive as their own unmapped entries
  assert.ok((ir.unmappedEvents ?? []).some((e) => e.type === 'token_count'), 'rows after the torn line survive');
});

test('codex listSessions: one torn .zst in the yard, all other sessions still listed', async () => {
  const root = await tempRoot('sm-tol-codex-');
  const goodA = CT2;
  const goodB = CT3;
  const bad = CT4;
  await codexWriteSession(root, goodA, [JSON.stringify(codexMetaLine(goodA)), JSON.stringify(codexUserItem('A question'))], true);
  await codexWriteSession(root, goodB, [JSON.stringify(codexMetaLine(goodB)), JSON.stringify(codexUserItem('B question'))], true);
  // torn .zst: corrupt the frame descriptor right after the magic (a
  // plain truncation would still decompress — zstd streams tolerate missing
  // tails) — decompression must fail, listing must survive
  const dir = join(root, 'sessions', '2026', '08', '20');
  const goodZst = zstdCompressSync(Buffer.from(writeJsonl([JSON.stringify(codexMetaLine(bad))])));
  const tornZst = Buffer.concat([goodZst.subarray(0, 6), Buffer.from([0x99, 0x99]), goodZst.subarray(8)]);
  await fs.writeFile(join(dir, `${codexThreadFile(bad)}.zst`), tornZst);

  const metas = await new CodexAdapter().listSessions(root);
  const ids = metas.map((m) => m.sessionId);
  assert.ok(ids.includes(goodA) && ids.includes(goodB), 'neighbour sessions still listed');
  assert.ok(!ids.includes(bad), 'the unscannable file is skipped from the listing');
});

test('codex parse: a garbage .zst fails with the file path in the message', async () => {
  const root = await tempRoot('sm-tol-codex-');
  const threadId = uuidv7();
  const dir = join(root, 'sessions', '2026', '08', '20');
  await fs.mkdir(dir, { recursive: true });
  const zstPath = join(dir, `${codexThreadFile(threadId)}.zst`);
  await fs.writeFile(zstPath, Buffer.from('definitely not zstd'));
  await assert.rejects(
    () => new CodexAdapter().parse(threadId, root),
    (e: Error) => {
      assert.match(e.message, /rollout-.*\.zst/);
      assert.match(e.message, /zstd/i);
      return true;
    },
  );
});

/* ------------------------------------------------------------------ */
/* Pi — 断行 skip + 显式版本门（既有行为的矩阵锚定）                     */
/* ------------------------------------------------------------------ */

function piHeaderLine(id: string): string {
  return JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-08-20T02:14:08.083Z', cwd: '/tmp/proj' });
}

/** pi entries form a parentId chain; the LAST entry in file order is the leaf
 * and the main chain is the leaf's ancestor path — an unchained row becomes
 * its own root and rides a sidechain instead. */
function piMessageLine(role: 'user' | 'assistant', text: string, id: string, parentId: string | null): string {
  return JSON.stringify({
    type: 'message', id, parentId, timestamp: '2026-08-20T02:14:09.000Z',
    message: { role, content: [{ type: 'text', text }], timestamp: 1755641649000 },
  });
}

test('pi parse: torn rows are skipped, good rows survive (native loader parity)', async () => {
  const root = await tempRoot('sm-tol-pi-');
  const dir = join(root, '--tmp-proj--');
  await fs.mkdir(dir, { recursive: true });
  const sid = randomUUID();
  await fs.writeFile(
    join(dir, `1755641648_${sid}.jsonl`),
    writeJsonl([
      piHeaderLine(sid),
      piMessageLine('user', 'question', 'aaaaaaa0', null),
      '{"type":"message","id":"abc123","parentId":"aaaaaaa0","timestamp":"2026-08-20T02:14:09.000Z","message":{"role":"assistant","content":[{"type":"text","text":"an', // torn
      piMessageLine('assistant', 'answer', 'aaaaaaa1', 'aaaaaaa0'),
    ]),
  );
  const ir = await new PiAdapter().parse(sid, root);
  const texts = ir.messages.map((m) => (m.content[0] as { text?: string }).text);
  assert.deepEqual(texts, ['question', 'answer'], 'torn row skipped, good rows survive');
});

test('pi parse: file with no valid v3 header → explicit refusal naming the file', async () => {
  const root = await tempRoot('sm-tol-pi-');
  const dir = join(root, '--tmp-proj--');
  await fs.mkdir(dir, { recursive: true });
  const sid = randomUUID();
  // every line unparsable → no header → explicit error (never a silent empty session)
  await fs.writeFile(join(dir, `1755641648_${sid}.jsonl`), 'garbage\nnot json either\n');
  await assert.rejects(() => new PiAdapter().parse(sid, root), /not a pi session file|header/i);
});

/* ------------------------------------------------------------------ */
/* OpenCode — mirror 断行容忍 + DB 垃圾字节（既有锚定复述）              */
/* ------------------------------------------------------------------ */

test('opencode mirror parse: torn rows are skipped, good rows survive', async () => {
  const root = await tempRoot('sm-tol-oc-');
  const mirrorDir = join(root, 'opencode-mirror');
  await fs.mkdir(mirrorDir, { recursive: true });
  const sid = randomUUID();
  const header = { type: 'mirror-header', id: sid, cwd: 'D:\\proj', title: 't', createdAt: 1000, model: undefined };
  const userRow = { type: 'user', content: [{ type: 'text', text: 'q' }], timestamp: 1001 };
  await fs.writeFile(
    join(mirrorDir, `${sid}.jsonl`),
    [
      JSON.stringify(header),
      JSON.stringify(userRow),
      '{"type":"assistant","content":[{"type":"text","text":"an', // torn
      JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'a' }], timestamp: 1002 }),
    ].join('\n'),
  );
  const ir = await new OpenCodeAdapter().parse(sid, root);
  assert.equal(ir.messages.length, 2, 'torn row skipped, both good rows parse');
  assert.equal(ir.originSessionId, sid, 'mirror header still anchors the session');
});

/* ------------------------------------------------------------------ */
/* ZCode — DB 家 parse 侧：损坏 data 行归档不炸 + 空/坏 store 显式报错    */
/* ------------------------------------------------------------------ */

test('zcode parse: corrupted message data rows degrade per-row, the session still parses', async () => {
  const root = await tempRoot('sm-tol-zcode-');
  const dbDir = join(root, 'cli', 'db');
  await fs.mkdir(dbDir, { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(dbDir, 'db.sqlite'));
  const T0 = 1755641648000;
  try {
    db.exec(`CREATE TABLE session (
      id TEXT PRIMARY KEY, parent_id TEXT, project_id TEXT, slug TEXT, directory TEXT, path TEXT,
      title TEXT, version TEXT, permission TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      task_type TEXT NOT NULL, title_source TEXT NOT NULL, revert TEXT)`);
    db.exec(`CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL, sequence INTEGER)`);
    db.exec(`CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      data TEXT NOT NULL, sequence INTEGER)`);
    db.prepare(
      'INSERT INTO session (id, parent_id, project_id, slug, directory, path, title, version, permission, time_created, time_updated, task_type, title_source, revert) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run('sess_tol', null, 'proj_test', 'sess_tol', 'D:\\proj', 'D:\\proj', 'fixture', '0.16.5', '{"mode":"build"}', T0, T0, 'interactive', 'first_input', null);
    const vis = { uiVisibility: 'visible', providerVisibility: 'visible', transcriptVisibility: 'visible' };
    const good = { role: 'user', time: { created: T0 }, semantics: { origin: 'real_user', kind: 'user_prompt', ...vis } };
    // corrupted data JSON (not an object) → row degrades via tryParse, never throws
    const bad = 'not json at all';
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)')
      .run('m1', 'sess_tol', T0, T0, JSON.stringify(good), 0);
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)')
      .run('m2', 'sess_tol', T0, T0, bad, 1);
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)')
      .run('p1', 'm1', 'sess_tol', T0, T0, JSON.stringify({ type: 'text', text: 'real prompt' }), 0);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  const ir = await new ZcodeAdapter().parse('sess_tol', root);
  // the good user message survives with its part; the corrupted row degrades
  // (role-less → synthetic/archive path) instead of failing the parse
  assert.ok(ir.messages.length >= 1, 'session still parses around the corrupted row');
  const texts = ir.messages.flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text));
  assert.ok(texts.includes('real prompt'), 'good row content intact');
});

/* ------------------------------------------------------------------ */
/* Round-trip guard: dsh torn-line rows do NOT break dsh write          */
/* ------------------------------------------------------------------ */

test('dsh round-trip: an IR containing archived torn-line rows still writes (dsh drops the unknown type)', async () => {
  const adapter = new DshAdapter();
  const root = await tempRoot('sm-tol-dsh-');
  // parse the torn fixture from the first test, write it back as a new session
  const dir = join(root, '--D-proj--', 'session-torn');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    join(dir, 'session.jsonl.zstd'),
    buildTornDshLog(dshHeader('session-torn'), [
      { line: dshUserLine(0, 'first') },
      { raw: '{"seq":1,"time":1001,"type":"user/message","surfaceOp":"append","data":{"message":{"role":"user"' },
      { line: dshUserLine(3, 'last') },
    ]),
  );
  const ir = await adapter.parse('session-torn', root);

  const res = await adapter.write(ir, { root, sessionId: 'session-torn-rewritten', targetCwd: 'D:\\proj' });
  // written log loads back and never contains a torn-line event (write gate drops unknown types)
  const plain = decompressSessionBuffer(await fs.readFile(res.paths[0]));
  assert.ok(!plain.includes('"torn-line"'), 'archived torn rows are dropped on dsh write (DSH would refuse the log)');
  const back = await adapter.parse('session-torn-rewritten', root);
  assert.equal(back.messages.length, ir.messages.length, 'messages conserved across the round-trip');
});
