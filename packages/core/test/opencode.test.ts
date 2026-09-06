import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { OpenCodeAdapter } from '../src/adapters/opencode/index.js';
import { fallbackIr } from '../src/demo.js';
import type { MigratedSession } from '../src/ir.js';

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'sm-opencode-test-'));
}

/** Directory values are stored forward-slashed by the adapter. */
function fwd(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Permissive v1.18-shaped store — only the columns the adapter touches. */
function createTestDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE project (
    id TEXT PRIMARY KEY, worktree TEXT, vcs TEXT, name TEXT, icon_url TEXT,
    icon_url_override TEXT, icon_color TEXT, time_created INTEGER, time_updated INTEGER,
    time_initialized INTEGER, sandboxes TEXT, commands TEXT)`);
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, parent_id TEXT,
    slug TEXT, directory TEXT, path TEXT, title TEXT, version TEXT, share_url TEXT,
    summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
    summary_diffs INTEGER, metadata TEXT, cost INTEGER, tokens_input INTEGER,
    tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER,
    tokens_cache_write INTEGER, revert TEXT, permission TEXT, agent TEXT, model TEXT,
    time_created INTEGER, time_updated INTEGER, time_compacting INTEGER, time_archived INTEGER)`);
  db.exec(`CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)`);
  db.exec(`CREATE TABLE part (
    id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER,
    time_updated INTEGER, data TEXT)`);
  return db;
}

const T0 = 1784252446000;

/** Main session with one Task call whose sidechain carries the FULL subagent
 *  transcript (prompt + intermediate tool steps + final report). */
function subagentIr(): MigratedSession {
  return {
    schemaVersion: 2,
    originTool: 'claude',
    title: 'main',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'do the thing' }], timestamp: T0 },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'task', input: { description: 'explore stuff', prompt: 'explore the repo', subagent_type: 'general' } }], timestamp: T0 + 1 },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'final report' }], timestamp: T0 + 2 },
    ],
    sidechains: [{
      agentId: 'ses_sourcechild',
      kind: 'subagent',
      agentType: 'general',
      meta: { opencode: { callId: 'call_1', parentSessionId: 'ses_old' } },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'explore the repo' }], timestamp: T0 + 1 },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c2', name: 'read', input: { file_path: '/x' } }, { type: 'text', text: 'intermediate thought' }], timestamp: T0 + 2 },
        { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'c2', content: 'file body' }], timestamp: T0 + 2 },
        { role: 'assistant', content: [{ type: 'text', text: 'final report' }], timestamp: T0 + 3 },
      ],
    }],
  };
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
  // sidechain records must not leak into the message stream as empty rows
  assert.equal(back.messages.length, fallbackIr().messages.length);
});

test('OpenCode DB write rebuilds native task sub-sessions + linked task part (flatten=false)', async () => {
  const adapter = new OpenCodeAdapter();
  const root = await tempRoot();
  const dbPath = join(root, 'opencode.db');
  createTestDb(dbPath);

  const res = await adapter.write(subagentIr(), { root: dbPath, targetCwd: '/tmp/proj', flatten: false });
  const mainId = res.sessionId;

  // native child session row (parent_id + agent + title)
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const kids = db.prepare('SELECT id, parent_id, agent, title FROM session WHERE parent_id=?').all(mainId) as Array<Record<string, unknown>>;
  assert.equal(kids.length, 1);
  const childId = String(kids[0].id);
  assert.equal(kids[0].agent, 'general');
  assert.match(String(kids[0].title), /subagent|explore stuff/);

  // FULL intermediate process lives in the child session: 4 IR messages -> 3
  // native rows (the tool result merges into its tool part) with the read
  // tool part carrying its output.
  const childMsgs = db.prepare('SELECT data FROM message WHERE session_id=? ORDER BY time_created').all(childId) as Array<Record<string, unknown>>;
  assert.ok(childMsgs.length >= 3, `child session must carry the whole transcript, got ${childMsgs.length}`);
  const childReadPart = JSON.parse((db.prepare("SELECT data FROM part WHERE session_id=? AND data LIKE '%\"tool\":\"read\"%'").get(childId) as { data: string }).data);
  assert.equal(childReadPart.state.output, 'file body');

  // task part links to the child + renderOutput-wrapped output
  const taskPart = JSON.parse((db.prepare("SELECT data FROM part WHERE session_id=? AND data LIKE '%\"tool\":\"task\"%'").get(mainId) as { data: string }).data);
  assert.equal(taskPart.state.metadata.sessionId, childId);
  assert.equal(taskPart.state.metadata.parentSessionId, mainId);
  assert.equal(taskPart.state.title, 'explore stuff');
  assert.match(String(taskPart.state.output), /^<task id="/);
  assert.ok(String(taskPart.state.output).includes('final report'));
  db.close();

  // parse back: sidechain = full child transcript, linkage preserved,
  // task tool_result content unwrapped with the raw wrapper as rawResult
  const back = await adapter.parse(mainId, root);
  assert.equal(back.sidechains?.length, 1);
  const sc = back.sidechains![0];
  assert.equal(sc.agentType, 'general');
  assert.equal((sc.meta?.opencode as { callId?: string }).callId, 'call_1');
  assert.ok(sc.messages.length >= 4, 'intermediate steps must survive parse');
  assert.equal((sc.messages[0].content[0] as { text: string }).text, 'explore the repo');
  assert.ok(sc.messages.some((m) => m.content.some((b) => b.type === 'text' && (b as { text: string }).text === 'intermediate thought')));
  const tr = back.messages.find((m) => m.role === 'tool')!.content[0] as { content: string; rawResult?: unknown };
  assert.equal(tr.content, 'final report');
  assert.equal(tr.rawResult, taskPart.state.output);

  // second hop: opencode IR -> opencode again stays native (1 child each)
  const res2 = await adapter.write(back, { root: dbPath, targetCwd: '/tmp/proj', flatten: false });
  const db2 = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal((db2.prepare('SELECT COUNT(*) c FROM session WHERE parent_id=?').get(res2.sessionId) as { c: number }).c, 1);
  const task2 = JSON.parse((db2.prepare("SELECT data FROM part WHERE session_id=? AND data LIKE '%\"tool\":\"task\"%'").get(res2.sessionId) as { data: string }).data);
  assert.notEqual(task2.state.metadata.sessionId, childId, 'second hop must mint a fresh child id');
  db2.close();
});

test('OpenCode DB flatten=true folds sidechain transcripts into top-level messages', async () => {
  const adapter = new OpenCodeAdapter();
  const root = await tempRoot();
  const dbPath = join(root, 'opencode.db');
  createTestDb(dbPath);

  const res = await adapter.write(subagentIr(), { root: dbPath, targetCwd: '/tmp/proj', flatten: true });
  const db = new DatabaseSync(dbPath, { readOnly: true });
  // no child session rows at all
  assert.equal((db.prepare('SELECT COUNT(*) c FROM session WHERE parent_id IS NOT NULL').get() as { c: number }).c, 0);
  // sidechain content present as top-level messages in the main session
  const texts = (db.prepare("SELECT data FROM part WHERE session_id=? AND data LIKE '%\"type\":\"text\"%'").all(res.sessionId) as Array<{ data: string }>)
    .map((r) => String(JSON.parse(r.data).text));
  assert.ok(texts.includes('intermediate thought'));
  assert.ok(texts.includes('final report'));
  // and the unlinked task part keeps the raw (unwrapped) output
  const taskPart = JSON.parse((db.prepare("SELECT data FROM part WHERE session_id=? AND data LIKE '%\"tool\":\"task\"%'").get(res.sessionId) as { data: string }).data);
  assert.equal(taskPart.state.metadata.sessionId, undefined);
  db.close();
});

test('OpenCode DB compaction boundary round-trips (write + parse)', async () => {
  const adapter = new OpenCodeAdapter();
  const root = await tempRoot();
  const dbPath = join(root, 'opencode.db');
  createTestDb(dbPath);

  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'opencode',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'early work' }], timestamp: T0 },
      { role: 'assistant', content: [{ type: 'text', text: 'early reply' }], timestamp: T0 + 1 },
      { role: 'user', content: [{ type: 'text', text: 'compact summary text' }], timestamp: T0 + 2 },
      { role: 'user', content: [{ type: 'text', text: 'after compaction' }], timestamp: T0 + 3 },
    ],
    compaction: [{ summary: 'compact summary text', anchorIndex: 2, meta: { opencode: { auto: false } } }],
  };
  const res = await adapter.write(ir, { root: dbPath, targetCwd: '/tmp/proj' });

  // native shape in the DB: boundary part + summary:true assistant parented to it
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const boundaryPart = JSON.parse((db.prepare("SELECT data FROM part WHERE session_id=? AND data LIKE '%\"type\":\"compaction\"%'").get(res.sessionId) as { data: string }).data);
  assert.equal(boundaryPart.auto, false);
  const summaryRow = db.prepare("SELECT data FROM message WHERE session_id=? AND data LIKE '%\"summary\":true%'").get(res.sessionId) as { data: string };
  const sd = JSON.parse(summaryRow.data);
  assert.equal(sd.mode, 'compaction');
  assert.ok(sd.parentID, 'summary assistant must parent to the boundary user row');
  db.close();

  // parse back: carrier user message + typed compaction record, summary
  // assistant consumed (not duplicated into messages)
  const back = await adapter.parse(res.sessionId, root);
  assert.equal(back.compaction?.length, 1);
  const entry = back.compaction![0];
  assert.equal(entry.summary, 'compact summary text');
  assert.equal((entry.meta?.opencode as { auto?: boolean }).auto, false);
  const carrier = back.messages[entry.anchorIndex!];
  assert.equal(carrier.role, 'user');
  assert.equal((carrier.content[0] as { text: string }).text, 'compact summary text');
  assert.ok(!back.messages.some((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'text' && (b as { text: string }).text === 'compact summary text')));
});

test('OpenCode DB file part round-trips (parse + write)', async () => {
  const adapter = new OpenCodeAdapter();
  const root = await tempRoot();
  const dbPath = join(root, 'opencode.db');
  createTestDb(dbPath);

  const dataUrl = 'data:image/jpeg;base64,AAAA';
  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'opencode',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'look at this' }, { type: 'file', filename: 'pic.jpg', mediaType: 'image/jpeg', url: dataUrl }], timestamp: T0 },
    ],
  };
  const res = await adapter.write(ir, { root: dbPath, targetCwd: '/tmp/proj' });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const filePart = JSON.parse((db.prepare("SELECT data FROM part WHERE session_id=? AND data LIKE '%\"type\":\"file\"%'").get(res.sessionId) as { data: string }).data);
  assert.equal(filePart.mime, 'image/jpeg');
  assert.equal(filePart.filename, 'pic.jpg');
  assert.equal(filePart.url, dataUrl);
  db.close();

  const back = await adapter.parse(res.sessionId, root);
  const file = back.messages[0].content.find((b) => b.type === 'file') as { filename?: string; mediaType?: string; url?: string };
  assert.equal(file.filename, 'pic.jpg');
  assert.equal(file.mediaType, 'image/jpeg');
  assert.equal(file.url, dataUrl);
});

test('OpenCode DB tool part four-state: pending/error round-trip without fabricating results', async () => {
  const adapter = new OpenCodeAdapter();
  const root = await tempRoot();
  const dbPath = join(root, 'opencode.db');
  createTestDb(dbPath);

  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'opencode',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: T0 },
      // completed with a genuinely empty output (real: bash with no stdout)
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'true' } }], timestamp: T0 + 1 },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'c1', content: '' }], timestamp: T0 + 1 },
      // error result
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c2', name: 'read', input: { filePath: '/missing' } }], timestamp: T0 + 2 },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'c2', content: 'File not found', isError: true }], timestamp: T0 + 2 },
      // call with NO result (interrupted in the source)
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c3', name: 'grep', input: { pattern: 'x' } }], timestamp: T0 + 3 },
    ],
  };
  const res = await adapter.write(ir, { root: dbPath, targetCwd: '/tmp/proj' });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const byStatus: Record<string, Record<string, unknown>> = {};
  for (const r of db.prepare("SELECT data FROM part WHERE session_id=? AND data LIKE '%\"type\":\"tool\"%'").all(res.sessionId) as Array<{ data: string }>) {
    const s = JSON.parse(r.data).state;
    byStatus[String(s.status)] = s;
  }
  assert.equal(byStatus.completed.output, '');
  assert.equal(byStatus.error.error, 'File not found');
  assert.equal(byStatus.pending.raw, '');
  db.close();

  const back = await adapter.parse(res.sessionId, root);
  assert.equal(back.messages.length, ir.messages.length, 'no phantom results on re-parse');
  const results = back.messages.filter((m) => m.role === 'tool').flatMap((m) => m.content);
  assert.ok(results.some((b) => b.type === 'tool_result' && b.toolUseId === 'c1' && b.content === ''), 'real empty output keeps its tool_result');
  const errResult = results.find((b) => b.type === 'tool_result' && b.toolUseId === 'c2') as { isError?: boolean } | undefined;
  assert.equal(errResult?.isError, true);
  assert.ok(!results.some((b) => b.type === 'tool_result' && b.toolUseId === 'c3'), 'unpaired call must not fabricate a result');
});

test('OpenCode DB listSessions does not flatten subagent children into the top level', async () => {
  const adapter = new OpenCodeAdapter();
  const root = await tempRoot();
  const dbPath = join(root, 'opencode.db');
  createTestDb(dbPath);

  const res = await adapter.write(subagentIr(), { root: dbPath, targetCwd: '/tmp/proj', flatten: false });
  const metas = await adapter.listSessions(root);
  assert.equal(metas.length, 1, 'only the top-level session is listable');
  assert.equal(metas[0].sessionId, res.sessionId);
});

/* ------------------------------------------------------------------ */
/* Review fixes: anchor exemption, transaction atomicity, boundary    */
/* parts surviving parse, listSessions error surfacing                */
/* ------------------------------------------------------------------ */

test('OpenCode DB write: compaction anchor on a synthetic message is exempt from the synthetic gate (pi v3.3 shape)', async () => {
  const adapter = new OpenCodeAdapter();
  const root = await tempRoot();
  const dbPath = join(root, 'opencode.db');
  createTestDb(dbPath);

  // pi v3.3 official anchor shape: the projected compaction summary is a
  // synthetic:true user message the anchorIndex points at.
  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'pi',
    title: 'pi compacted',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'before compaction' }], timestamp: T0 },
      { role: 'assistant', content: [{ type: 'text', text: 'early reply' }], timestamp: T0 + 1 },
      { role: 'user', content: [{ type: 'text', text: 'PI SUMMARY PAYLOAD' }], timestamp: T0 + 2, synthetic: true },
      { role: 'user', content: [{ type: 'text', text: 'after compaction' }], timestamp: T0 + 3 },
    ],
    compaction: [{ summary: 'PI SUMMARY PAYLOAD', anchorIndex: 2, meta: { pi: { anchor: { kind: 'compaction', entryId: 'src-comp-1' } } } }],
  };
  const res = await adapter.write(ir, { root: dbPath, targetCwd: '/tmp/proj' });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  // the boundary part + the summary:true assistant both exist
  const boundaryPart = JSON.parse((db.prepare("SELECT data FROM part WHERE session_id=? AND data LIKE '%\"type\":\"compaction\"%'").get(res.sessionId) as { data: string }).data);
  assert.ok(boundaryPart, 'compaction boundary part written despite the synthetic anchor');
  const summaryRow = db.prepare("SELECT data FROM message WHERE session_id=? AND data LIKE '%\"summary\":true%'").get(res.sessionId) as { data: string };
  assert.ok(summaryRow, 'summary assistant row written');
  const sd = JSON.parse(summaryRow.data);
  assert.equal(sd.mode, 'compaction');
  assert.ok(sd.parentID, 'summary assistant parents to the boundary user row');
  db.close();

  // parse back: both the compaction record and its summary survive
  const back = await adapter.parse(res.sessionId, root);
  assert.equal(back.compaction?.length, 1);
  assert.equal(back.compaction![0].summary, 'PI SUMMARY PAYLOAD');
  const carrier = back.messages[back.compaction![0].anchorIndex!];
  assert.equal((carrier.content[0] as { text: string }).text, 'PI SUMMARY PAYLOAD');
});

test('OpenCode DB write: system-role compaction anchor is exempt from the system drop too', async () => {
  const adapter = new OpenCodeAdapter();
  const root = await tempRoot();
  const dbPath = join(root, 'opencode.db');
  createTestDb(dbPath);

  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'dsh',
    title: 'system anchor',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q' }], timestamp: T0 },
      // system-role anchor (some sources project the checkpoint as system)
      { role: 'system', content: [{ type: 'text', text: 'SYS ANCHOR SUMMARY' }], timestamp: T0 + 1 },
    ],
    compaction: [{ summary: 'SYS ANCHOR SUMMARY', anchorIndex: 1 }],
  };
  const res = await adapter.write(ir, { root: dbPath, targetCwd: '/tmp/proj' });
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const hit = (db.prepare("SELECT COUNT(*) AS n FROM part WHERE session_id=? AND data LIKE '%SYS ANCHOR SUMMARY%'").get(res.sessionId) as { n: number }).n;
  db.close();
  assert.ok(hit >= 1, 'a system-role anchor must still write its summary (anchor priority > role gate)');
});

test('OpenCode DB write: mid-write failure rolls the whole transaction back (zero residue)', async () => {
  const adapter = new OpenCodeAdapter();
  const root = await tempRoot();
  const dbPath = join(root, 'opencode.db');
  const setup = createTestDb(dbPath);
  // occupy the exact session id the write will target — the INSERT fails
  // mid-transaction, after the global project row was already ensured.
  setup.prepare("INSERT INTO session (id, project_id) VALUES ('ses_doomed', 'global')").run();
  setup.close();

  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'claude',
    title: 'will fail',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: T0 },
      { role: 'assistant', content: [{ type: 'text', text: 'world' }], timestamp: T0 + 1 },
    ],
  };
  await assert.rejects(
    () => adapter.write(ir, { root: dbPath, targetCwd: '/tmp/proj', sessionId: 'ses_doomed' }),
    /UNIQUE constraint failed/,
  );

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const count = (t: string): number => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
  // only the pre-inserted placeholder row remains — the transaction rolled
  // back everything else (project row, messages, parts)
  assert.equal(count('project'), 0, 'no residue: project table untouched');
  assert.equal(count('session'), 1, 'no residue: only the pre-existing placeholder session');
  assert.equal(count('message'), 0, 'no residue: message table untouched');
  assert.equal(count('part'), 0, 'no residue: part table untouched');
  db.close();
});

test('OpenCode DB parse: boundary user row keeps its own text parts (they no longer evaporate)', async () => {
  const adapter = new OpenCodeAdapter();
  const root = await tempRoot();
  const dbPath = join(root, 'opencode.db');
  const db = createTestDb(dbPath);
  try {
    // build the native shape directly: boundary user row carrying BOTH a
    // compaction part and its own [user interrupted] text part, plus the
    // summary assistant parented to it (real-store shape, 23/44 boundary rows)
    const insMsg = (id: string, time: number, data: Record<string, unknown>): void => {
      db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(id, 'ses_b1', time, time, JSON.stringify(data));
    };
    const insPart = (mid: string, seq: number, data: Record<string, unknown>): void => {
      db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(`prt_${mid}_${seq}`, mid, 'ses_b1', T0 + seq, T0 + seq, JSON.stringify(data));
    };
    db.prepare('INSERT OR IGNORE INTO project (id, worktree) VALUES (\'global\', \'/\')').run();
    db.prepare('INSERT INTO session (id, project_id, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)').run('ses_b1', 'global', 'boundary text', T0, T0);
    insMsg('msg_b1', T0, { role: 'user', time: { created: T0 }, agent: 'build' });
    insPart('msg_b1', 0, { type: 'compaction', auto: false });
    insPart('msg_b1', 1, { type: 'text', text: '[user interrupted]' });
    insMsg('msg_b2', T0 + 1, { parentID: 'msg_b1', role: 'assistant', mode: 'compaction', agent: 'compaction', summary: true, time: { created: T0 + 1, completed: T0 + 1 } });
    insPart('msg_b2', 0, { type: 'text', text: 'summary of the compacted run' });
    insMsg('msg_b3', T0 + 2, { role: 'user', time: { created: T0 + 2 }, agent: 'build' });
    insPart('msg_b3', 0, { type: 'text', text: 'after the boundary' });
  } finally {
    db.close();
  }

  const ir = await adapter.parse('ses_b1', root);
  const dumped = JSON.stringify(ir.messages);
  assert.ok(dumped.includes('[user interrupted]'), 'the boundary row own text part must survive the parse');
  assert.equal(ir.compaction?.length, 1);
  assert.match(ir.compaction![0].summary, /summary of the compacted run/);
  const after = ir.messages.find((m) => (m.content[0] as { text?: string } | undefined)?.text === 'after the boundary');
  assert.ok(after, 'messages after the boundary unaffected');
});

test('OpenCode DB listSessions: absent db → [] or mirror; a db that fails to open or query throws', async () => {
  const adapter = new OpenCodeAdapter();

  // 1. explicit root with NO db file → [] (hermetic, no store exists)
  const emptyRoot = await tempRoot();
  try {
    assert.deepEqual(await adapter.listSessions(emptyRoot), []);
  } finally {
    await fs.rm(emptyRoot, { recursive: true, force: true });
  }

  // 2. corrupt db file at the path: open succeeds but the query fails — must
  // throw, never silently return [] (and never fall back to the mirror).
  const badRoot = await tempRoot();
  const badPath = join(badRoot, 'opencode.db');
  await fs.writeFile(badPath, 'certainly not a sqlite database'.repeat(100));
  try {
    await assert.rejects(
      () => adapter.listSessions(badRoot),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /not a database|cannot open/i);
        return true;
      },
      'a corrupt store must surface as an error, never as []',
    );
  } finally {
    await fs.rm(badRoot, { recursive: true, force: true });
  }
});

test('OpenCode DB session.path is worktree-relative, never the absolute directory (real-store shape)', async () => {
  const adapter = new OpenCodeAdapter();

  // Case 1: cwd is a .git root itself — the app's own dominant shape
  // (203/210 git-project rows in the sampled 1.18 store): path = ''.
  const root1 = await tempRoot();
  const dbPath1 = join(root1, 'opencode.db');
  createTestDb(dbPath1);
  await fs.mkdir(join(root1, 'proj', '.git'), { recursive: true });
  const r1 = await adapter.write(subagentIr(), { root: dbPath1, targetCwd: join(root1, 'proj'), flatten: true });
  const db1 = new DatabaseSync(dbPath1, { readOnly: true });
  const row1 = db1.prepare('SELECT path, directory FROM session WHERE id=?').get(r1.sessionId) as { path: string; directory: string };
  assert.equal(row1.path, '', 'cwd == git worktree root must write the empty string, not the absolute dir');
  assert.equal(row1.directory, fwd(join(root1, 'proj')), 'directory stays the absolute cwd');
  db1.close();

  // Case 2: non-git cwd — the app attaches to the 'global' project
  // (worktree '/'); sessionPath drops the drive root, so the relative
  // remainder is written (24 real rows sampled: 'codes/dshPlugins/cc-migrate').
  const root2 = await tempRoot();
  const dbPath2 = join(root2, 'opencode.db');
  createTestDb(dbPath2);
  const r2 = await adapter.write(subagentIr(), { root: dbPath2, targetCwd: '/tmp/proj', flatten: true });
  const db2 = new DatabaseSync(dbPath2, { readOnly: true });
  const row2 = db2.prepare('SELECT path, directory FROM session WHERE id=?').get(r2.sessionId) as { path: string; directory: string };
  assert.equal(row2.path, 'tmp/proj', 'non-git cwd writes the worktree-relative remainder (no absolute path ever)');
  assert.equal(row2.directory, '/tmp/proj');
  db2.close();

  // Case 3: cwd nested UNDER a .git root — git discovery makes the repo root
  // the worktree and path is the remainder below it.
  const root3 = await tempRoot();
  const dbPath3 = join(root3, 'opencode.db');
  createTestDb(dbPath3);
  await fs.mkdir(join(root3, 'repo', '.git'), { recursive: true });
  const r3 = await adapter.write(subagentIr(), { root: dbPath3, targetCwd: join(root3, 'repo', 'sub'), flatten: true });
  const db3 = new DatabaseSync(dbPath3, { readOnly: true });
  const row3 = db3.prepare('SELECT path, directory FROM session WHERE id=?').get(r3.sessionId) as { path: string; directory: string };
  assert.equal(row3.path, 'sub', 'cwd nested under a .git root writes the repo-relative subpath');
  db3.close();
});

test('OpenCode parse consumes native part-level synthetic/ignored flags — injections never read back as human turns', async () => {
  const adapter = new OpenCodeAdapter();
  const root = await tempRoot();
  const dbPath = join(root, 'opencode.db');
  createTestDb(dbPath);
  const db = new DatabaseSync(dbPath);
  db.prepare('INSERT INTO project (id, worktree) VALUES (?, ?)').run('proj_flag', '/tmp/proj');
  db.prepare('INSERT INTO session (id, project_id, directory, title, time_created) VALUES (?, ?, ?, ?, ?)')
    .run('ses_flag', 'proj_flag', '/tmp/proj', 'flag test', T0);
  const insMsg = db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)');
  const insPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)');
  // msg_mixed: real text + flagged steering sibling (real corpus: 12 such rows)
  insMsg.run('msg_mixed', 'ses_flag', T0, JSON.stringify({ role: 'user' }));
  insPart.run('p_m1', 'msg_mixed', 'ses_flag', T0, JSON.stringify({ type: 'text', text: 'my real question' }));
  insPart.run('p_m2', 'msg_mixed', 'ses_flag', T0, JSON.stringify({ type: 'text', text: 'Called the Read tool with the following', synthetic: true }));
  // msg_pure: every text part synthetic — the message IS an injection
  insMsg.run('msg_pure', 'ses_flag', T0 + 1, JSON.stringify({ role: 'user' }));
  insPart.run('p_p1', 'msg_pure', 'ses_flag', T0 + 1, JSON.stringify({ type: 'text', text: '[search-mode]\nMAXIMIZE SEARCH EFFORT.', synthetic: true }));
  // msg_ignored: ignored flag counts the same
  insMsg.run('msg_ignored', 'ses_flag', T0 + 2, JSON.stringify({ role: 'user' }));
  insPart.run('p_i1', 'msg_ignored', 'ses_flag', T0 + 2, JSON.stringify({ type: 'text', text: '[user interrupted]', ignored: true }));
  db.close();

  const back = await adapter.parse('ses_flag', dbPath);
  const users = back.messages.filter((m) => m.role === 'user');
  assert.equal(users.length, 3, 'all three rows project — nothing evaporates');
  const mixed = users.find((m) => (m.content[0] as { text?: string }).text === 'my real question');
  assert.ok(mixed, 'mixed message keeps the real part');
  assert.equal(mixed!.synthetic, undefined, 'mixed message stays a human turn');
  assert.equal((mixed!.content as Array<{ text?: string }>).length, 1, 'flagged sibling part is not projected as user text');
  const pure = users.find((m) => (m.content[0] as { text?: string }).text?.startsWith('[search-mode]'));
  assert.ok(pure, 'pure-synthetic message is preserved');
  assert.equal(pure!.synthetic, true, 'pure-synthetic message is marked as injection, not a human turn');
  const ignored = users.find((m) => (m.content[0] as { text?: string }).text === '[user interrupted]');
  assert.ok(ignored, 'ignored-flag message is preserved');
  assert.equal(ignored!.synthetic, true, 'ignored flag marks the message synthetic');
});

test('OpenCode write(keepSynthetic) -> parse round-trip keeps synthetic marking stable', async () => {
  const adapter = new OpenCodeAdapter();
  const root = await tempRoot();
  const ir: MigratedSession = {
    ...fallbackIr(),
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'real human turn' }], timestamp: T0 },
      { role: 'user', content: [{ type: 'text', text: '[search-mode]\nMAXIMIZE SEARCH EFFORT.' }], timestamp: T0 + 1, synthetic: true },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: T0 + 2 },
    ],
  };
  const res = await adapter.write(ir, { root, targetCwd: '/tmp/proj', keepSynthetic: true });
  const back = await adapter.parse(res.sessionId, root);
  const users = back.messages.filter((m) => m.role === 'user');
  assert.equal(users.length, 2);
  assert.equal(users[0].synthetic, undefined);
  assert.equal(users[1].synthetic, true, 'synthetic message round-trips marked');
  assert.equal((users[1].content[0] as { text: string }).text, '[search-mode]\nMAXIMIZE SEARCH EFFORT.');
});
