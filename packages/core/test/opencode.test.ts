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
