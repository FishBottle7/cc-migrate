/**
 * IR hardening contract tests (docs/ir-protocol.md「IR 加固清单」第一/三/四层 +
 * 「IR 版本与同步闸门」):
 *  - validateSession rejects malformed IRs down to the BLOCK level, with a
 *    locating error message;
 *  - the registry refuses adapters whose irVersion is older than IR_VERSION;
 *  - the engine checkpoints (readSource exit / writeTarget entry) cannot be
 *    bypassed;
 *  - every write side honours the v3.1 developer-role rule (never assistant).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { validateSession, compareIrVersions, IR_VERSION } from '../src/ir.js';
import type { MigratedSession, MigratedMessage } from '../src/ir.js';
import { builtinRegistry, createRegistry, writeTarget } from '../src/index.js';
import type { Adapter, WriteOptions, WriteResult } from '../src/registry.js';
import { ClaudeAdapter } from '../src/adapters/claude/index.js';
import { buildMainRecords, buildSidechainRecords } from '../src/adapters/claude/write.js';
import { PiAdapter } from '../src/adapters/pi/index.js';
import { OpenCodeAdapter } from '../src/adapters/opencode/index.js';
import { ZcodeAdapter } from '../src/adapters/zcode/index.js';
import { DshAdapter } from '../src/adapters/dsh/index.js';

function irOf(messages: MigratedMessage[], extra: Partial<MigratedSession> = {}): MigratedSession {
  return { schemaVersion: 2, originTool: 'dsh', messages, ...extra };
}

/* ---------------- validateSession: bad-example battery ---------------- */

test('validateSession: schemaVersion is strictly required to be 2', () => {
  const noVersion = { originTool: 'dsh', messages: [] };
  assert.throws(() => validateSession(noVersion as unknown as MigratedSession), /schemaVersion must be 2/);
  const v1 = { ...(irOf([]) as { schemaVersion: number }), schemaVersion: 1 };
  assert.throws(() => validateSession(v1 as unknown as MigratedSession), /schemaVersion must be 2/);
});

test('validateSession: originTool is a closed set', () => {
  assert.throws(
    () => validateSession({ ...(irOf([]) as MigratedSession), originTool: 'not-a-tool' } as unknown as MigratedSession),
    /originTool must be a ToolId/,
  );
});

test('validateSession: block-level battery — each malformed block is rejected with its path', () => {
  const cases: Array<[string, MigratedMessage[]]> = [
    ['unknown block type', [{ role: 'user', content: [{ type: 'nonsense', x: 1 } as never] }]],
    ['text block without text', [{ role: 'user', content: [{ type: 'text' } as never] }]],
    ['tool_use without id/name', [{ role: 'assistant', content: [{ type: 'tool_use', input: {} } as never] }]],
    ['tool_result with non-string content', [{ role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 5 } as never] }]],
    ['tool_result attachments not FileBlocks', [{ role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'x', attachments: [{ type: 'nope' }] } as never] }]],
    ['file block with all fields absent', [{ role: 'user', content: [{ type: 'file' } as never] }]],
    ['thinking with non-string signature', [{ role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 3 } as never] }]],
    ['non-numeric timestamp', [{ role: 'user', content: [{ type: 'text', text: 'x' }], timestamp: 'yesterday' as never }]],
    ['non-boolean synthetic', [{ role: 'user', content: [{ type: 'text', text: 'x' }], synthetic: 'yes' as never }]],
  ];
  for (const [name, messages] of cases) {
    assert.throws(() => validateSession(irOf(messages)), /validateSession: message\[0\] is malformed/, name);
  }
  // tool_result with an EMPTY toolUseId is the sanctioned orphan marker — accepted
  validateSession(irOf([{ role: 'user', content: [{ type: 'tool_result', toolUseId: '', content: 'orphan' }] }]));
});

test('validateSession: session-level buckets are typed', () => {
  assert.throws(() => validateSession({ ...irOf([]), goals: 'oops' } as unknown as MigratedSession), /goals must be an array/);
  assert.throws(() => validateSession({ ...irOf([]), unmappedEvents: 42 } as unknown as MigratedSession), /unmappedEvents must be an array/);
  assert.throws(
    () => validateSession({ ...irOf([]), goals: [{ seq: 'a', time: 1, data: {} }] } as unknown as MigratedSession),
    /goals\[0\] must carry numeric seq\/time/,
  );
  assert.throws(
    () => validateSession({ ...irOf([]), compaction: [{ summary: 's', anchorIndex: 'abc' }] } as unknown as MigratedSession),
    /compaction\[0\]\.anchorIndex must be a number/,
  );
  assert.throws(
    () => validateSession({ ...irOf([]), sidechains: [{ agentId: 'a', kind: 'subagent', messages: [{ role: 'user', content: [{ type: 'bogus' } as never] }] }] }),
    /sidechains\[0\] is malformed/,
  );
});

test('compareIrVersions: dotted ordering', () => {
  assert.ok(compareIrVersions('3.2', '3.10') < 0);
  assert.ok(compareIrVersions('3.2', '3.2') === 0);
  assert.ok(compareIrVersions('4.0', '3.9') > 0);
});

/* ---------------- registry gate + engine checkpoints ---------------- */

function stubAdapter(tool: MigratedSession['originTool'], irVersion: string, calls: string[] = []): Adapter {
  return {
    tool,
    irVersion,
    listSessions: async () => [],
    parse: async () => irOf([]),
    write: async (ir: MigratedSession, _opts?: WriteOptions): Promise<WriteResult> => {
      calls.push('write');
      return { tool, sessionId: 'stub', paths: [] };
    },
    preview: () => '',
  };
}

test('registry: refuses an adapter whose irVersion is older than IR_VERSION', () => {
  const registry = createRegistry();
  registry.register(stubAdapter('dsh', IR_VERSION));
  assert.throws(() => registry.register(stubAdapter('pi', '3.0')), /adapter "pi" targets IR v3\.0 but this core speaks/);
});

test('registry: accepts equal irVersion and rejects a duplicate tool registration', () => {
  const registry = createRegistry();
  registry.register(stubAdapter('dsh', IR_VERSION));
  assert.throws(() => registry.register(stubAdapter('dsh', IR_VERSION)), /already registered/);
});

test('engine: writeTarget validates the IR before the adapter ever sees it', async () => {
  const calls: string[] = [];
  const adapter = stubAdapter('zcode', IR_VERSION, calls);
  const bad = irOf([{ role: 'user', content: [{ type: 'nonsense' } as never] }]);
  await assert.rejects(() => writeTarget(adapter, bad), /message\[0\] is malformed/);
  assert.deepEqual(calls, [], 'adapter.write must not run on an invalid IR');
});

/* ---------------- v3.1 developer-role contract (all write sides) ---------------- */

const DEV_IR: MigratedSession = {
  schemaVersion: 2,
  originTool: 'codex',
  cwd: 'D:\\proj',
  createdAt: 1756500000000,
  messages: [
    { role: 'developer', content: [{ type: 'text', text: 'DEV-MSG' }], timestamp: 1 },
    { role: 'system', content: [{ type: 'text', text: 'SYS-MSG' }], timestamp: 2 },
    { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 3 },
  ],
};

test('claude write: developer/system land as system rows, never user rows', () => {
  const built = buildMainRecords(DEV_IR, 'sess', { targetCwd: 'D:\\proj', nowMs: 1000 });
  const dev = built.records.find((r) => JSON.stringify(r).includes('DEV-MSG'));
  const sys = built.records.find((r) => JSON.stringify(r).includes('SYS-MSG'));
  assert.equal(dev?.type, 'system');
  assert.equal(sys?.type, 'system');
  assert.equal(built.records.filter((r) => r.type === 'user').length, 1, 'only the real user row');
});

test('claude write: a sidechain assistant message is written as an assistant record', () => {
  const sc = {
    agentId: 'agent-1',
    kind: 'subagent' as const,
    agentType: 'general-purpose',
    messages: [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'do it' }], timestamp: 1 },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'done' }], timestamp: 2 },
    ],
  };
  const { records } = buildSidechainRecords(sc, 'sess', { targetCwd: 'D:\\proj', nowMs: 1000 });
  const done = records.find((r) => JSON.stringify(r.message ?? r).includes('done'));
  assert.equal(done?.type, 'assistant', 'sidechain assistant output must stay assistant');
});

test('pi write: developer/system degrade to user rows and round-trip as user', async () => {
  const adapter = new PiAdapter();
  const root = await fs.mkdtemp(join(tmpdir(), 'sm-pi-devtest-'));
  const res = await adapter.write(DEV_IR, { root, targetCwd: 'D:\\proj' });
  const back = await adapter.parse(res.sessionId, root);
  const devBack = back.messages.find((m) => m.content.some((b) => b.type === 'text' && b.text.includes('DEV-MSG')));
  const sysBack = back.messages.find((m) => m.content.some((b) => b.type === 'text' && b.text.includes('SYS-MSG')));
  assert.equal(devBack?.role, 'user');
  assert.equal(sysBack?.role, 'user');
  await fs.rm(root, { recursive: true, force: true });
});

test('zcode write: developer is never an assistant row', async () => {
  const adapter = new ZcodeAdapter();
  const root = await fs.mkdtemp(join(tmpdir(), 'sm-zc-devtest-'));
  await fs.mkdir(join(root, 'storage', 'session'), { recursive: true });
  // isolate from a real ~/.zcode so the write bootstraps a clean db
  const prevHome = process.env.ZCODE_HOME;
  process.env.ZCODE_HOME = join(tmpdir(), `sm-zc-devtest-empty-${Date.now()}`);
  try {
    await adapter.write(DEV_IR, { root, targetCwd: 'D:\\proj' });
  } finally {
    if (prevHome === undefined) delete process.env.ZCODE_HOME;
    else process.env.ZCODE_HOME = prevHome;
  }
  // zcode parse intentionally hides engine-injected rows, so assert at the
  // storage level: the developer text must live on a user-role message row.
  const db = new DatabaseSync(join(root, 'cli', 'db', 'db.sqlite'), { readOnly: true });
  const rows = db
    .prepare("SELECT m.data FROM part p JOIN message m ON m.id = p.message_id WHERE p.data LIKE '%DEV-MSG%'")
    .all() as Array<{ data: string }>;
  db.close();
  assert.ok(rows.length, 'developer text part written');
  assert.equal(JSON.parse(rows[0].data).role, 'user');
  await fs.rm(root, { recursive: true, force: true });
});

/** Permissive v1.18-shaped OpenCode store (subset the adapter touches). */
function createOpencodeTestDb(dbPath: string): DatabaseSync {
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

test('opencode write (db path): developer degrades to a user row, not assistant', async () => {
  const adapter = new OpenCodeAdapter();
  const root = await fs.mkdtemp(join(tmpdir(), 'sm-oc-devtest-'));
  const dbPath = join(root, 'opencode.db');
  createOpencodeTestDb(dbPath).close();
  await adapter.write(DEV_IR, { root: dbPath, targetCwd: 'D:\\proj' });
  const db = new DatabaseSync(dbPath, { readOnly: true });
  // text lives in part rows; join to the owning message for its role
  const rows = db
    .prepare("SELECT m.data FROM part p JOIN message m ON m.id = p.message_id WHERE p.data LIKE '%DEV-MSG%'")
    .all() as Array<{ data: string }>;
  db.close();
  assert.ok(rows.length, 'developer text part written');
  const devRow = JSON.parse(rows[0].data);
  assert.notEqual(devRow?.role, 'assistant');
  assert.equal(devRow?.role, 'user');
  await fs.rm(root, { recursive: true, force: true });
});

test('opencode mirror write: developer row preserved verbatim', async () => {
  const adapter = new OpenCodeAdapter();
  const root = await fs.mkdtemp(join(tmpdir(), 'sm-oc-mirror-'));
  const res = await adapter.write(DEV_IR, { root, targetCwd: 'D:\\proj' });
  const text = await fs.readFile(res.paths[0], 'utf8');
  assert.ok(text.includes('"type":"developer"'), 'mirror keeps the developer role for lossless offline transfer');
  await fs.rm(root, { recursive: true, force: true });
});

test('dsh write: developer lands as an injected user message (synthetic), never assistant', async () => {
  const adapter = new DshAdapter();
  const root = await fs.mkdtemp(join(tmpdir(), 'sm-dsh-devtest-'));
  const res = await adapter.write(DEV_IR, { root, targetCwd: 'D:\\proj' });
  const back = await adapter.parse(res.sessionId, root);
  const devBack = back.messages.find((m) => m.content.some((b) => b.type === 'text' && b.text.includes('DEV-MSG')));
  assert.ok(devBack, 'developer message present after round-trip');
  assert.equal(devBack?.role, 'user');
  assert.equal(devBack?.synthetic, true, 'dsh classifies the foreign developer row as harness-injected');
  assert.notEqual(devBack?.role, 'assistant');
  await fs.rm(root, { recursive: true, force: true });
});

test('builtin registry: all six adapters are at the current IR version', () => {
  // builtinRegistry() running without throwing IS the assertion — the
  // registry gate rejects any stale adapter at register time.
  builtinRegistry();
});
