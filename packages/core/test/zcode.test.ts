import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ZcodeAdapter, zcodeProjectId, o0Trim, classifyUserMessage } from '../src/adapters/zcode/index.js';
import type { MigratedSession } from '../src/ir.js';

/* ------------------------------------------------------------------ */
/* Fixture helpers — a ZCODE_HOME-shaped sandbox with the 3-table store */
/* ------------------------------------------------------------------ */

const T0 = 1786000000000; // fixed ms epoch so ids/timestamps are deterministic-ish

function b36(n: number): string {
  return Math.max(0, Math.floor(n)).toString(36);
}

interface FixtureSessionRow {
  id: string;
  parent_id?: string | null;
  project_id?: string;
  directory?: string;
  title?: string;
  version?: string;
  permission?: string;
  time_created?: number;
  time_updated?: number;
  task_type?: string;
  title_source?: string;
  revert?: string | null;
}

interface Fixture {
  root: string;
  dbPath: string;
  db: DatabaseSync;
  insertSession(row: FixtureSessionRow): void;
  insertMessage(sessionId: string, sequence: number, data: unknown, opts?: { id?: string; time?: number }): string;
  insertPart(messageId: string, sessionId: string, sequence: number, data: unknown, opts?: { id?: string; time?: number }): string;
  close(): Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(join(tmpdir(), 'sm-zcode-test-'));
  const dbPath = join(root, 'cli', 'db', 'db.sqlite');
  await fs.mkdir(join(root, 'cli', 'db'), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT,
    slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL,
    version TEXT NOT NULL, revert TEXT, permission TEXT,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
    task_type TEXT NOT NULL, title_source TEXT NOT NULL)`);
  db.exec(`CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL, sequence INTEGER)`);
  db.exec(`CREATE TABLE part (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
    data TEXT NOT NULL, sequence INTEGER)`);
  return {
    root,
    dbPath,
    db,
    insertSession(row) {
      db.prepare(
        'INSERT INTO session (id, parent_id, project_id, slug, directory, path, title, version, permission, time_created, time_updated, task_type, title_source, revert) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        row.id, row.parent_id ?? null, row.project_id ?? 'proj_test', row.id, row.directory ?? 'D:\\proj',
        row.directory ?? 'D:\\proj', row.title ?? 'fixture', row.version ?? '0.16.5',
        row.permission ?? '{"mode":"build"}', row.time_created ?? T0, row.time_updated ?? T0,
        row.task_type ?? 'interactive', row.title_source ?? 'first_input', row.revert ?? null,
      );
    },
    insertMessage(sessionId, sequence, data, opts) {
      const id = opts?.id ?? `msg_${b36(opts?.time ?? T0)}_${sequence}-fixture`;
      db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)')
        .run(id, sessionId, opts?.time ?? T0, opts?.time ?? T0, JSON.stringify(data), sequence);
      return id;
    },
    insertPart(messageId, sessionId, sequence, data, opts) {
      const id = opts?.id ?? `part_${b36(opts?.time ?? T0)}_${messageId}_${sequence}`;
      db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)')
        .run(id, messageId, sessionId, opts?.time ?? T0, opts?.time ?? T0, JSON.stringify(data), sequence);
      return id;
    },
    async close() {
      db.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

const VIS = { uiVisibility: 'visible', providerVisibility: 'visible', transcriptVisibility: 'visible' };

function userData(text: string): Record<string, unknown> {
  return {
    role: 'user',
    time: { created: T0 },
    agent: 'zcode-agent',
    model: { providerID: '11111111-2222-3333-4444-555555555555', modelID: 'GLM-Test', variant: 'max' },
    semantics: { origin: 'real_user', kind: 'user_prompt', ...VIS },
    anchor: { turnId: 'turn_1', origin: 'realUser' },
  };
}

function assistantData(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'assistant',
    time: { created: T0, completed: T0 + 1 },
    modelID: 'GLM-Test',
    providerID: '11111111-2222-3333-4444-555555555555',
    mode: 'build',
    agent: 'zcode-agent',
    path: { cwd: 'D:\\proj', root: 'D:\\proj' },
    cost: 0,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: 'stop',
    semantics: { origin: 'agent_runtime', kind: 'assistant_response', ...VIS },
    ...extra,
  };
}

/** Isolate hermetic tests from a real ~/.zcode (snapshot bootstrapping) without leaking env. */
async function withoutRealZcodeHome<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.ZCODE_HOME;
  process.env.ZCODE_HOME = join(tmpdir(), `sm-zcode-empty-${Date.now()}`);
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.ZCODE_HOME;
    else process.env.ZCODE_HOME = prev;
  }
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

test('zcodeProjectId lowercases and dashes non-alphanumerics', () => {
  assert.equal(zcodeProjectId('D:\\codes\\dshPlugins\\cc-migrate'), 'proj_d-codes-dshplugins-cc-migrate');
  assert.equal(zcodeProjectId('/home/user/My Proj'), 'proj_-home-user-my-proj');
});

test('classifyUserMessage follows the D2 decision table', () => {
  assert.equal(classifyUserMessage({ semantics: { origin: 'real_user', kind: 'user_prompt', ...VIS } } as never), 'realUserInput');
  assert.equal(classifyUserMessage({ semantics: { origin: 'agent_runtime', kind: 'todo_reminder', uiVisibility: 'hidden', providerVisibility: 'visible', transcriptVisibility: 'hidden' } } as never), 'synthetic');
  assert.equal(classifyUserMessage({ semantics: { origin: 'real_user', kind: 'user_prompt', ...VIS }, synthetic: true } as never), 'synthetic');
  assert.equal(classifyUserMessage({ summary: { title: 'Compact summary', body: 'x' } } as never), 'compactSummary');
  assert.equal(classifyUserMessage({ semantics: { origin: 'system', kind: 'timeline_event', ...VIS } } as never), 'timelineOnly');
  // subagent child prompt: agent_runtime origin but provider+UI visible → real content
  assert.equal(classifyUserMessage({ semantics: { origin: 'agent_runtime', kind: 'user_prompt', ...VIS } } as never), 'realUserInput');
  // legacy rows without semantics
  assert.equal(classifyUserMessage({ visibility: 'model-only' } as never), 'synthetic');
  assert.equal(classifyUserMessage({} as never), 'realUserInput');
});

function row(id: string, sequence: number): { id: string; sequence: number; time_created: number; data: string } {
  return { id, sequence, time_created: T0 + sequence, data: '{}' };
}

test('o0Trim whitelist + branchCut (spec sample shape)', () => {
  const msgs = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'].map((id, i) => row(id, i));
  const revert = {
    kind: 'conversation_rewind', scope: 'conversation',
    targetMessageID: 'm3', branchCutAfterMessageID: 'm3', branchGeneration: 4,
    keptMessageIDs: ['m0', 'm1', 'm2'],
  };
  const out = o0Trim(msgs, revert as never);
  assert.deepEqual(out.messages.map((m) => m.id), ['m0', 'm1', 'm2', 'm4', 'm5']);
  assert.deepEqual(out.pruned.map((m) => m.id), ['m3']);
});

test('o0Trim target-slice path without whitelist', () => {
  const msgs = ['m0', 'm1', 'm2', 'm3', 'm4'].map((id, i) => row(id, i));
  const out = o0Trim(msgs, { targetMessageID: 'm3' } as never);
  assert.deepEqual(out.messages.map((m) => m.id), ['m0', 'm1', 'm2']);
  assert.deepEqual(out.pruned.map((m) => m.id), ['m3', 'm4']);
});

test('o0Trim no revert → full, and dedupes whitelist∩tail', () => {
  const msgs = ['m0', 'm1'].map((id, i) => row(id, i));
  assert.deepEqual(o0Trim(msgs, {} as never).messages.map((m) => m.id), ['m0', 'm1']);
  const out = o0Trim(['m0', 'm1', 'm2'].map((id, i) => row(id, i)), {
    targetMessageID: 'm1', keptMessageIDs: ['m0', 'm2'], branchCutAfterMessageID: 'm1',
  } as never);
  assert.deepEqual(out.messages.map((m) => m.id), ['m0', 'm2']); // m2 must appear exactly once
});

/* ------------------------------------------------------------------ */
/* Parse: tool split, classification, compaction, provider mapping     */
/* ------------------------------------------------------------------ */

test('zcode parse: tool part splits into tool_use + tool_result; synthetics stay out', async () => {
  await withoutRealZcodeHome(async () => {
    const fx = await makeFixture();
    try {
      fx.insertSession({ id: 'sess_p', project_id: 'proj_d-proj' });
      const m0 = fx.insertMessage('sess_p', 0, userData('run the probe'));
      fx.insertPart(m0, 'sess_p', 0, { type: 'text', text: 'run the probe' });
      const m1 = fx.insertMessage('sess_p', 1, assistantData({ finish: 'tool-calls' }));
      fx.insertPart(m1, 'sess_p', 0, { type: 'step-start' });
      fx.insertPart(m1, 'sess_p', 1, {
        type: 'tool', callID: 'call_abc123', tool: 'Bash',
        state: { status: 'completed', input: '{"command":"ls"}', output: 'file.txt', title: 'Bash', time: { start: T0, end: T0 + 2 } },
      });
      fx.insertPart(m1, 'sess_p', 2, { type: 'reasoning', text: 'thinking hard', metadata: { anthropic: { signature: 'sig-xyz' } } });
      fx.insertPart(m1, 'sess_p', 3, {
        type: 'tool', callID: 'call_err456', tool: 'Read',
        state: { status: 'error', input: { file_path: 'big.txt' }, error: 'File content exceeds maximum allowed size.' },
      });
      fx.insertPart(m1, 'sess_p', 4, { type: 'tool', callID: 'call_pend789', tool: 'Bash', state: { status: 'pending', input: { command: 'sleep' } } });
      fx.insertPart(m1, 'sess_p', 5, { type: 'step-finish', reason: 'tool-calls', cost: 0, tokens: {} });
      fx.insertMessage('sess_p', 2, {
        role: 'user', time: { created: T0 }, agent: 'zcode-agent',
        semantics: { origin: 'agent_runtime', kind: 'todo_reminder', source: 'todo_reminder', uiVisibility: 'hidden', providerVisibility: 'visible', transcriptVisibility: 'hidden' },
        metadata: { source: 'todo_reminder', visibility: 'model-only' },
      }, { id: 'msg_synth_1' });
      const m3 = fx.insertMessage('sess_p', 3, assistantData({ finish: 'stop' }));
      fx.insertPart(m3, 'sess_p', 0, { type: 'text', text: 'all done' });

      const adapter = new ZcodeAdapter();
      const ir = await adapter.parse('sess_p', fx.root);

      assert.equal(ir.originTool, 'zcode');
      assert.equal(ir.messages.length, 4); // user, assistant, tool, assistant
      assert.deepEqual(ir.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
      const asst = ir.messages[1];
      const uses = asst.content.filter((b) => b.type === 'tool_use');
      assert.equal(uses.length, 2); // pending skipped
      assert.deepEqual(uses.map((b) => (b as { id: string }).id), ['call_abc123', 'call_err456']);
      const toolMsg = ir.messages[2];
      const results = toolMsg.content.filter((b) => b.type === 'tool_result');
      assert.equal(results.length, 2);
      const okResult = results.find((b) => (b as { toolUseId: string }).toolUseId === 'call_abc123') as { content: string; isError?: boolean };
      assert.equal(okResult.content, 'file.txt');
      assert.ok(!okResult.isError);
      const errResult = results.find((b) => (b as { toolUseId: string }).toolUseId === 'call_err456') as { content: string; isError?: boolean };
      assert.equal(errResult.isError, true);
      assert.match(errResult.content, /exceeds maximum allowed size/);
      assert.ok(asst.content.some((b) => b.type === 'thinking' && (b as { thinking: string }).thinking === 'thinking hard'));
      // model/provider from registry name (no config in fixture → raw id fallback)
      assert.equal(ir.model?.id, 'GLM-Test');
      assert.equal(ir.model?.provider, '11111111-2222-3333-4444-555555555555');
      // extensions bookkeeping
      const ext = ir.extensions as Record<string, unknown>;
      assert.equal((ext['zcode.syntheticMessages'] as unknown[]).length, 1);
      // typed lossless bucket: every invocation, all four states
      const calls = ir.toolCalls ?? [];
      assert.deepEqual(calls.map((t) => t.status), ['completed', 'error', 'pending']);
      const completed = calls.find((t) => t.status === 'completed')!;
      assert.equal(completed.tool, 'Bash');
      assert.deepEqual(completed.input, { command: 'ls' });
      assert.equal(completed.output, 'file.txt');
      assert.equal(completed.title, 'Bash');
      assert.ok(completed.time?.start);
      assert.ok(completed.source && completed.source.messageSequence === 1);
      const errored = calls.find((t) => t.status === 'error')!;
      assert.equal(errored.error, 'File content exceeds maximum allowed size.');
      const pending = calls.find((t) => t.status === 'pending')!;
      assert.deepEqual(pending.input, { command: 'sleep' });
      assert.equal(calls.every((t) => typeof t.callId === 'string' && t.callId.startsWith('call_')), true);
      // gap #1: the anthropic signature rides the thinking block itself —
      // no source-id side-table (messageExtras is gone)
      const think = asst.content.find((b) => b.type === 'thinking') as { thinking: string; signature?: string };
      assert.equal(think.signature, 'sig-xyz');
      assert.equal('zcode.messageExtras' in (ir.extensions as Record<string, unknown>), false);
      // gap #5 (revised): step parts are preserved verbatim in msg.meta.zcode.rawParts
      const asstMeta = (asst.meta as { zcode?: { rawParts?: Array<{ data: { type: string } }> } }).zcode;
      assert.ok(asstMeta?.rawParts?.some((r) => r.data.type === 'step-start'));
      assert.ok(asstMeta?.rawParts?.some((r) => r.data.type === 'step-finish'));
      // gap #2: message-level native payload hangs off the message entity
      const userMeta = (ir.messages[0].meta as { zcode?: Record<string, unknown> }).zcode;
      assert.equal(userMeta?.agent, 'zcode-agent');
      assert.equal(userMeta?.modelID, 'GLM-Test');
      assert.equal((userMeta?.semantics as { origin?: string })?.origin, 'real_user');
      // string-form input must have been decoded to an object on tool_use
      assert.deepEqual((uses[0] as { input: unknown }).input, { command: 'ls' });
    } finally {
      await fx.close();
    }
  });
});

test('zcode parse: compaction summary projects as a message + anchored bucket entry', async () => {
  await withoutRealZcodeHome(async () => {
    const fx = await makeFixture();
    try {
      fx.insertSession({ id: 'sess_c' });
      const m0 = fx.insertMessage('sess_c', 0, userData('long conversation'));
      fx.insertPart(m0, 'sess_c', 0, { type: 'text', text: 'long conversation' });
      const m1 = fx.insertMessage('sess_c', 1, assistantData());
      fx.insertPart(m1, 'sess_c', 0, { type: 'text', text: 'answer' });
      fx.insertPart(m1, 'sess_c', 1, {
        type: 'compaction', auto: true, trigger: 'auto', compactReason: 'context_limit',
        timelineStatus: 'completed', summaryMessageId: 'msg_sum_1', boundaryId: 'compact_b1',
        preCompactTokenCount: 42000,
      });
      fx.insertMessage('sess_c', 2, {
        role: 'user', time: { created: T0 },
        summary: { title: 'Compact summary', body: 'Summary:\n1. did things', diffs: [] },
        semantics: { origin: 'agent_runtime', kind: 'compact_summary', uiVisibility: 'hidden', providerVisibility: 'visible', transcriptVisibility: 'hidden' },
      }, { id: 'msg_sum_1' });

      const ir = await new ZcodeAdapter().parse('sess_c', fx.root);
      // gap #3: the summary IS projected into messages[] (canonical carrier)
      assert.equal(ir.messages.length, 3);
      const sum = ir.messages[2];
      assert.equal(sum.role, 'user');
      assert.equal((sum.content[0] as { text: string }).text, 'Summary:\n1. did things'); // body fallback (no text part)
      const sumMeta = (sum.meta as { zcode?: Record<string, unknown> }).zcode;
      assert.equal((sumMeta?.summary as { body?: string })?.body, 'Summary:\n1. did things');
      assert.equal((sumMeta?.semantics as { kind?: string })?.kind, 'compact_summary');
      // bucket entry anchored to the projected message
      assert.equal(ir.compaction?.length, 1);
      assert.match(ir.compaction![0].summary, /did things/);
      assert.equal(ir.compaction![0].tokensBefore, 42000); // paired via summaryMessageId
      assert.equal(ir.compaction![0].anchorIndex, 2);
      // raw boundary part kept verbatim on the assistant's meta (no side-table extensions)
      const asstMeta = (ir.messages[1].meta as { zcode?: { rawParts?: Array<{ data: Record<string, unknown> }> } }).zcode;
      assert.equal(asstMeta?.rawParts?.[0]?.data.summaryMessageId, 'msg_sum_1');
      assert.equal(asstMeta?.rawParts?.[0]?.data.preCompactTokenCount, 42000);
      const ext = ir.extensions as Record<string, unknown>;
      assert.equal('zcode.compactions' in ext, false);
      assert.equal('zcode.compactionSummaries' in ext, false);
      assert.equal('zcode.messageExtras' in ext, false);

      // write-back restores the native summary row (not a real_user prompt)
      const dstRoot = await fs.mkdtemp(join(tmpdir(), 'sm-zcode-cmp-'));
      try {
        const adapter = new ZcodeAdapter();
        const res = await adapter.write(ir, { root: dstRoot, targetCwd: 'D:\\proj' });
        const db = new DatabaseSync(join(dstRoot, 'cli', 'db', 'db.sqlite'));
        try {
          const rows = db.prepare('SELECT data FROM message WHERE session_id=? ORDER BY sequence').all(res.sessionId) as Array<{ data: string }>;
          const sumRow = JSON.parse(rows[2].data);
          assert.equal(sumRow.role, 'user');
          assert.equal(sumRow.semantics.kind, 'compact_summary');
          assert.equal(sumRow.semantics.uiVisibility, 'hidden');
          assert.equal(sumRow.summary.body, 'Summary:\n1. did things');
          assert.equal(sumRow.summary.diffs.length, 0);
          const firstUser = JSON.parse(rows[0].data);
          assert.equal(firstUser.semantics.origin, 'real_user'); // normal prompts untouched
        } finally {
          db.close();
        }
      } finally {
        await fs.rm(dstRoot, { recursive: true, force: true });
      }
    } finally {
      await fx.close();
    }
  });
});

test('zcode parse: providerID resolves via v2/config.json, apiKey never surfaces', async () => {
  await withoutRealZcodeHome(async () => {
    const fx = await makeFixture();
    try {
      await fs.mkdir(join(fx.root, 'v2'), { recursive: true });
      await fs.writeFile(
        join(fx.root, 'v2', 'config.json'),
        JSON.stringify({ provider: { '11111111-2222-3333-4444-555555555555': { name: 'Test Provider', kind: 'anthropic', options: { apiKey: 'sk-SUPER-SECRET' } } } }),
      );
      fx.insertSession({ id: 'sess_prov' });
      const m0 = fx.insertMessage('sess_prov', 0, userData('hi'));
      fx.insertPart(m0, 'sess_prov', 0, { type: 'text', text: 'hi' });
      const m1 = fx.insertMessage('sess_prov', 1, assistantData());
      fx.insertPart(m1, 'sess_prov', 0, { type: 'text', text: 'hello' });

      const ir = await new ZcodeAdapter().parse('sess_prov', fx.root);
      assert.equal(ir.model?.provider, 'Test Provider');
      const ext = ir.extensions as Record<string, unknown>;
      assert.deepEqual(ext['zcode.providers'], { '11111111-2222-3333-4444-555555555555': 'Test Provider' });
      assert.equal(ir.systemPrompt, undefined);
      const dumped = JSON.stringify(ir);
      assert.ok(!dumped.includes('sk-SUPER-SECRET'), 'apiKey leaked into IR');
      assert.ok(!dumped.includes('apiKey'), 'apiKey key name leaked into IR');
    } finally {
      await fx.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Sidechains: parent_id + sess_subagent_agent_<uuid> cold link        */
/* ------------------------------------------------------------------ */

test('zcode parse+write: subagent sidechain round-trips with engine id conventions', async () => {
  await withoutRealZcodeHome(async () => {
    const fx = await makeFixture();
    try {
      const childUuid = '99999999-8888-7777-6666-555555555555';
      const childId = `sess_subagent_agent_${childUuid}`;
      fx.insertSession({ id: 'sess_parent' });
      const m0 = fx.insertMessage('sess_parent', 0, userData('spawn an explore agent'));
      fx.insertPart(m0, 'sess_parent', 0, { type: 'text', text: 'spawn an explore agent' });
      const m1 = fx.insertMessage('sess_parent', 1, assistantData({ finish: 'tool-calls' }));
      fx.insertPart(m1, 'sess_parent', 0, {
        type: 'tool', callID: 'call_agent1', tool: 'Agent',
        state: { status: 'completed', input: { description: 'probe', prompt: 'explore the repo' }, output: 'final report', title: 'Agent', metadata: { schemaVersion: 1, serialization: {} } },
      });
      // child session linked by parent_id + id convention (no sidecar available)
      fx.insertSession({ id: childId, parent_id: 'sess_parent', task_type: 'subagent_child', title: 'probe child' });
      const c0 = fx.insertMessage(childId, 0, {
        role: 'assistant', time: { created: T0 }, agent: 'zcode-Explore', finish: 'completed',
        semantics: { origin: 'system', kind: 'timeline_event', ...VIS },
      }, { id: 'msg_child_c0' });
      fx.insertPart(c0, childId, 0, { type: 'timeline', timelineType: 'session_fork' });
      const c1 = fx.insertMessage(childId, 1, {
        role: 'user', time: { created: T0 }, agent: 'zcode-Explore',
        semantics: { origin: 'agent_runtime', kind: 'user_prompt', ...VIS },
      }, { id: 'msg_child_c1' });
      fx.insertPart(c1, childId, 0, { type: 'text', text: 'explore the repo' });
      const c2 = fx.insertMessage(childId, 2, {
        role: 'assistant', time: { created: T0 }, agent: 'zcode-Explore', finish: 'stop',
      }, { id: 'msg_child_c2' });
      fx.insertPart(c2, childId, 0, { type: 'text', text: 'structure looks fine' });

      const adapter = new ZcodeAdapter();
      const ir = await adapter.parse('sess_parent', fx.root);
      assert.equal(ir.sidechains?.length, 1);
      const sc = ir.sidechains![0];
      assert.equal(sc.agentId, childId);
      assert.equal(sc.kind, 'subagent');
      assert.equal(sc.agentType, 'Explore'); // zcode- prefix stripped
      assert.equal(sc.messages.length, 2);   // timeline carrier dropped (no replayable part text)
      assert.equal((sc.messages[0].content[0] as { text: string }).text, 'explore the repo');
      // prompt-match fallback links the Agent call
      assert.equal(sc.parentMessageId, 'call_agent1');
      // the timeline carrier row (no block projection) is archived on the
      // sidechain meta slot instead of dropped — same contract as the main
      // session's zcode.syntheticMessages extension bucket
      const scSynthetics = (sc.meta as Record<string, unknown> | undefined)?.['zcode.syntheticMessages'] as
        Array<{ id: string; sequence: number | null; data: Record<string, unknown> }> | undefined;
      assert.ok(scSynthetics, 'timeline carrier row archived on sidechain.meta');
      assert.equal(scSynthetics!.length, 1);
      assert.equal(scSynthetics![0].id, 'msg_child_c0');
      assert.equal((scSynthetics![0].data as { semantics?: { kind?: string } }).semantics?.kind, 'timeline_event');

      // ---- write into a fresh sandbox and re-parse ----
      const dstRoot = await fs.mkdtemp(join(tmpdir(), 'sm-zcode-dst-'));
      try {
        const res = await adapter.write(ir, { root: dstRoot, targetCwd: 'D:\\proj' });
        assert.equal(res.sessionId.startsWith('sess_'), true);
        const dstDb = new DatabaseSync(join(dstRoot, 'cli', 'db', 'db.sqlite'));
        try {
          // session row shape. P1-B: extensions['zcode.session'] (read from
          // the source store) is now consumed on write-back, so the fixture's
          // own version/permission survive instead of the synthesized constants.
          const sess = dstDb.prepare('SELECT * FROM session WHERE id=?').get(res.sessionId) as Record<string, unknown>;
          assert.equal(sess.version, '0.16.5');
          assert.equal(sess.permission, '{"mode":"build"}');
          assert.equal(sess.slug, res.sessionId);
          assert.equal(sess.project_id, 'proj_d-proj');
          assert.equal(sess.task_type, 'interactive');
          // sequences contiguous 0..N-1; parts contiguous per message
          const seqs = (dstDb.prepare('SELECT sequence FROM message WHERE session_id=? ORDER BY sequence').all(res.sessionId) as Array<{ sequence: number }>).map((r) => r.sequence);
          assert.deepEqual(seqs, seqs.map((_, i) => i));
          for (const mid of (dstDb.prepare('SELECT id FROM message WHERE session_id=?').all(res.sessionId) as Array<{ id: string }>)) {
            const pseqs = (dstDb.prepare('SELECT sequence FROM part WHERE message_id=? ORDER BY sequence').all(mid.id) as Array<{ sequence: number }>).map((r) => r.sequence);
            assert.deepEqual(pseqs, pseqs.map((_, i) => i));
          }
          // Agent tool part fused with agentId metadata
          const agentPart = (dstDb.prepare("SELECT data FROM part WHERE session_id=? AND data LIKE '%\"tool\":\"Agent\"%'").all(res.sessionId) as Array<{ data: string }>)
            .map((r) => JSON.parse(r.data))[0];
          assert.ok(agentPart, 'Agent tool part missing after write');
          assert.equal(agentPart.state.metadata.agentId, `agent_${childUuid}`);
          // subagent Agent calls always get a fresh call_<hex24> so the
          // engine's launch-ack/sidecar index cannot re-link the source child
          assert.match(agentPart.callID, /^call_[0-9a-f]{24}$/);
          assert.equal(agentPart.state.output, 'final report');
          // child session row
          const child = dstDb.prepare('SELECT * FROM session WHERE id=?').get(childId) as Record<string, unknown>;
          assert.equal(child.parent_id, res.sessionId);
          assert.equal(child.task_type, 'subagent_child');
          // child messages replayable
          const childMsgs = dstDb.prepare('SELECT data FROM message WHERE session_id=? ORDER BY sequence').all(childId) as Array<{ data: string }>;
          assert.ok(childMsgs.length >= 2);
          const firstUser = JSON.parse(childMsgs.find((r) => JSON.parse(r.data).role === 'user')!.data);
          assert.equal(firstUser.agent, 'zcode-Explore');
        } finally {
          dstDb.close();
        }
        // and the written sandbox parses back into the same sidechain shape
        const back = await adapter.parse(res.sessionId, dstRoot);
        assert.equal(back.sidechains?.length, 1);
        assert.equal(back.sidechains![0].agentId, childId);
        assert.equal(back.sidechains![0].agentType, 'Explore');
        assert.equal((back.sidechains![0].messages.at(-1)!.content[0] as { text: string }).text, 'structure looks fine');
      } finally {
        await fs.rm(dstRoot, { recursive: true, force: true });
      }
    } finally {
      await fx.close();
    }
  });
});

test('zcode listSessions: roots only — parent-linked children are not listed standalone', async () => {
  await withoutRealZcodeHome(async () => {
    const fx = await makeFixture();
    try {
      fx.insertSession({ id: 'sess_root', title: 'root conversation', time_created: T0 });
      // two agent retries of the same prompt → identical titles, "duplicate" rows
      fx.insertSession({ id: 'sess_subagent_agent_11111111-2222-3333-4444-555555555555', parent_id: 'sess_root', task_type: 'subagent_child', title: 'same prompt', time_created: T0 + 1 });
      fx.insertSession({ id: 'sess_subagent_agent_66666666-2222-3333-4444-555555555555', parent_id: 'sess_root', task_type: 'subagent_child', title: 'same prompt', time_created: T0 + 2 });
      fx.insertSession({ id: 'sess_side_chat', parent_id: 'sess_root', task_type: 'selection_side_chat', title: 'side chat', time_created: T0 + 3 });

      const metas = await new ZcodeAdapter().listSessions(fx.root);
      assert.deepEqual(metas.map((m) => m.sessionId), ['sess_root']);
    } finally {
      await fx.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Write: IR shapes from OTHER tools fuse into zcode-native rows       */
/* ------------------------------------------------------------------ */

test('zcode write: claude-style tool_result user rows fuse into tool parts; errors map to error state', async () => {
  await withoutRealZcodeHome(async () => {
    const dstRoot = await fs.mkdtemp(join(tmpdir(), 'sm-zcode-dst2-'));
    try {
      const ir: MigratedSession = {
        schemaVersion: 2,
        originTool: 'claude',
        title: 'cross-tool',
        cwd: 'D:\\proj',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'please edit' }] },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls' } },
              { type: 'tool_use', id: 'toolu_02', name: 'Read', input: { file_path: 'x' } },
            ],
            stopReason: 'tool-calls',
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 'toolu_01', content: 'a.txt\nb.txt' },
              { type: 'tool_result', toolUseId: 'toolu_02', content: 'cannot read', isError: true },
            ],
          },
          { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' },
        ],
      };
      const adapter = new ZcodeAdapter();
      const res = await adapter.write(ir, { root: dstRoot, targetCwd: 'D:\\proj' });
      const db = new DatabaseSync(join(dstRoot, 'cli', 'db', 'db.sqlite'));
      try {
        const rows = db.prepare('SELECT data, sequence FROM message WHERE session_id=? ORDER BY sequence').all(res.sessionId) as Array<{ data: string; sequence: number }>;
        // the tool_result-only user row must not become a user message
        assert.equal(rows.length, 3);
        const firstRowId = (db.prepare('SELECT id FROM message WHERE session_id=? AND sequence=0').get(res.sessionId) as { id: string }).id;
        const asst = JSON.parse(rows[1].data);
        assert.equal(asst.parentID, firstRowId);
        assert.equal(asst.finish, 'tool-calls');
        const parts1 = db.prepare('SELECT data FROM part WHERE session_id=? AND message_id=? ORDER BY sequence')
          .all(res.sessionId, (db.prepare('SELECT id FROM message WHERE session_id=? AND sequence=1').get(res.sessionId) as { id: string }).id) as Array<{ data: string }>;
        const toolParts = parts1.map((p) => JSON.parse(p.data)).filter((d) => d.type === 'tool');
        assert.equal(toolParts.length, 2);
        const bash = toolParts.find((d) => d.tool === 'Bash');
        assert.equal(bash.state.status, 'completed');
        assert.equal(bash.state.output, 'a.txt\nb.txt');
        assert.match(bash.callID, /^call_[0-9a-f]{24}$/);
        const read = toolParts.find((d) => d.tool === 'Read');
        assert.equal(read.state.status, 'error');
        assert.equal(read.state.error, 'cannot read');
        assert.ok(!('output' in read.state));
      } finally {
        db.close();
      }
    } finally {
      await fs.rm(dstRoot, { recursive: true, force: true });
    }
  });
});

test('zcode four-state toolCalls survive write→read (pending/running re-injected)', async () => {
  await withoutRealZcodeHome(async () => {
    const fx = await makeFixture();
    try {
      fx.insertSession({ id: 'sess_4' });
      const m0 = fx.insertMessage('sess_4', 0, userData('go'));
      fx.insertPart(m0, 'sess_4', 0, { type: 'text', text: 'go' });
      const m1 = fx.insertMessage('sess_4', 1, assistantData({ finish: 'tool-calls' }));
      fx.insertPart(m1, 'sess_4', 0, {
        type: 'tool', callID: 'call_done1', tool: 'Bash',
        state: { status: 'completed', input: { command: 'ls' }, output: 'a.txt', title: 'Bash', metadata: { schemaVersion: 1, serialization: { truncated: false } }, time: { start: T0, end: T0 + 3 } },
      });
      fx.insertPart(m1, 'sess_4', 1, {
        type: 'tool', callID: 'call_pending1', tool: 'Bash',
        state: { status: 'pending', input: { command: 'sleep 100' } },
      });
      fx.insertPart(m1, 'sess_4', 2, {
        type: 'tool', callID: 'call_running1', tool: 'Bash',
        state: { status: 'running', input: { command: 'npm test' }, startedAt: T0 },
      });

      const adapter = new ZcodeAdapter();
      const ir = await adapter.parse('sess_4', fx.root);
      assert.deepEqual((ir.toolCalls ?? []).map((t) => t.status), ['completed', 'pending', 'running']);

      // write → read round-trip through a fresh sandbox
      const dstRoot = await fs.mkdtemp(join(tmpdir(), 'sm-zcode-dst3-'));
      try {
        const res = await adapter.write(ir, { root: dstRoot, targetCwd: 'D:\\proj' });
        const back = await adapter.parse(res.sessionId, dstRoot);
        assert.equal(back.toolCalls?.length, 3);
        assert.deepEqual(back.toolCalls!.map((t) => t.status), ['completed', 'pending', 'running']);
        const p = back.toolCalls!.find((t) => t.status === 'pending')!;
        assert.deepEqual(p.input, { command: 'sleep 100' });
        const r = back.toolCalls!.find((t) => t.status === 'running')!;
        assert.deepEqual(r.input, { command: 'npm test' });
        const c = back.toolCalls!.find((t) => t.status === 'completed')!;
        assert.equal(c.output, 'a.txt');
        assert.deepEqual(c.metadata, { schemaVersion: 1, serialization: { truncated: false } });
        // the sandbox db itself carries the non-replayable parts again
        const db = new DatabaseSync(join(dstRoot, 'cli', 'db', 'db.sqlite'));
        try {
          const statuses = (db.prepare("SELECT data FROM part WHERE session_id=? AND data LIKE '%\"type\":\"tool\"%'").all(res.sessionId) as Array<{ data: string }>)
            .map((r2) => (JSON.parse(r2.data) as { state: { status: string } }).state.status).sort();
          assert.deepEqual(statuses, ['completed', 'pending', 'running']);
        } finally {
          db.close();
        }
      } finally {
        await fs.rm(dstRoot, { recursive: true, force: true });
      }
    } finally {
      await fx.close();
    }
  });
});

test('zcode write: meta.zcode restores native message fields (gap #2) and thinking signatures (gap #1)', async () => {
  await withoutRealZcodeHome(async () => {
    const dstRoot = await fs.mkdtemp(join(tmpdir(), 'sm-zcode-meta-'));
    try {
      const ir: MigratedSession = {
        schemaVersion: 2,
        originTool: 'zcode',
        cwd: 'D:\\proj',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'with snapshot' }],
            meta: {
              zcode: {
                agent: 'zcode-Explore',
                providerID: '11111111-2222-3333-4444-555555555555',
                modelID: 'GLM-Test',
                variant: 'max',
                contextSnapshot: { files: ['a.ts'] },
                tools: { bash: true },
                anchor: { turnId: 'turn_fixed', origin: 'realUser' },
                metadata: { legacy: 1 },
                semantics: { origin: 'real_user', kind: 'user_prompt', uiVisibility: 'visible', providerVisibility: 'visible', transcriptVisibility: 'visible' },
              },
            },
          },
          {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig-abc' }, { type: 'text', text: 'ok' }],
            stopReason: 'stop',
            meta: {
              zcode: {
                mode: 'plan',
                agent: 'zcode-Explore',
                cost: 0.25,
                tokens: { input: 11, output: 7, reasoning: 2, cache: { read: 3, write: 0 } },
                finish: 'stop',
                time: { created: 1786000001000, completed: 1786000001999 },
                variant: 'max',
                providerID: '11111111-2222-3333-4444-555555555555',
                modelID: 'GLM-Test',
                semantics: { origin: 'agent_runtime', kind: 'assistant_response', uiVisibility: 'visible', providerVisibility: 'visible', transcriptVisibility: 'visible' },
              },
            },
          },
        ],
      };
      const adapter = new ZcodeAdapter();
      const res = await adapter.write(ir, { root: dstRoot, targetCwd: 'D:\\proj' });
      const db = new DatabaseSync(join(dstRoot, 'cli', 'db', 'db.sqlite'));
      try {
        const rows = db.prepare('SELECT data FROM message WHERE session_id=? ORDER BY sequence').all(res.sessionId) as Array<{ data: string }>;
        const u = JSON.parse(rows[0].data);
        assert.equal(u.agent, 'zcode-Explore');
        assert.deepEqual(u.model, { providerID: '11111111-2222-3333-4444-555555555555', modelID: 'GLM-Test', variant: 'max' });
        assert.deepEqual(u.contextSnapshot, { files: ['a.ts'] });
        assert.deepEqual(u.tools, { bash: true });
        assert.deepEqual(u.anchor, { turnId: 'turn_fixed', origin: 'realUser' });
        assert.deepEqual(u.metadata, { legacy: 1 });
        const a = JSON.parse(rows[1].data);
        assert.equal(a.mode, 'plan');
        assert.equal(a.cost, 0.25);
        assert.deepEqual(a.tokens, { input: 11, output: 7, reasoning: 2, cache: { read: 3, write: 0 } });
        assert.deepEqual(a.time, { created: 1786000001000, completed: 1786000001999 });
        assert.equal(a.modelID, 'GLM-Test');
        assert.equal(a.providerID, '11111111-2222-3333-4444-555555555555');
        assert.equal(a.variant, 'max');
        // signature lands back in the native reasoning-part slot
        const aid = (db.prepare('SELECT id FROM message WHERE session_id=? AND sequence=1').get(res.sessionId) as { id: string }).id;
        const parts = (db.prepare('SELECT data FROM part WHERE message_id=? ORDER BY sequence').all(aid) as Array<{ data: string }>)
          .map((r) => JSON.parse(r.data));
        const reasoning = parts.find((p) => p.type === 'reasoning');
        assert.equal(reasoning.metadata.anthropic.signature, 'sig-abc');

        // and re-parsing yields the same meta payload (round-trip stable)
        const back = await adapter.parse(res.sessionId, dstRoot);
        const backUser = (back.messages[0].meta as { zcode?: Record<string, unknown> }).zcode;
        assert.deepEqual(backUser?.contextSnapshot, { files: ['a.ts'] });
        assert.equal(backUser?.modelID, 'GLM-Test');
        const backThink = back.messages[1].content.find((b) => b.type === 'thinking') as { signature?: string };
        assert.equal(backThink.signature, 'sig-abc');
      } finally {
        db.close();
      }
    } finally {
      await fs.rm(dstRoot, { recursive: true, force: true });
    }
  });
});

test('zcode file parts round-trip as FileBlocks (gap #4)', async () => {
  await withoutRealZcodeHome(async () => {
    const fx = await makeFixture();
    try {
      fx.insertSession({ id: 'sess_f' });
      const m0 = fx.insertMessage('sess_f', 0, userData('see attachment'));
      fx.insertPart(m0, 'sess_f', 0, { type: 'file', filename: 'chart.png', mime: 'image/png', url: 'file:///storage/chart.png' });
      fx.insertPart(m0, 'sess_f', 1, { type: 'text', text: 'see attachment' });

      const adapter = new ZcodeAdapter();
      const ir = await adapter.parse('sess_f', fx.root);
      const file = ir.messages[0].content.find((b) => b.type === 'file') as { filename?: string; mediaType?: string; url?: string };
      assert.equal(file.filename, 'chart.png');
      assert.equal(file.mediaType, 'image/png');
      assert.equal(file.url, 'file:///storage/chart.png');

      const dstRoot = await fs.mkdtemp(join(tmpdir(), 'sm-zcode-file-'));
      try {
        const res = await adapter.write(ir, { root: dstRoot, targetCwd: 'D:\\proj' });
        const db = new DatabaseSync(join(dstRoot, 'cli', 'db', 'db.sqlite'));
        try {
          const mid = (db.prepare('SELECT id FROM message WHERE session_id=? AND sequence=0').get(res.sessionId) as { id: string }).id;
          const parts = (db.prepare('SELECT data FROM part WHERE message_id=? ORDER BY sequence').all(mid) as Array<{ data: string }>)
            .map((r) => JSON.parse(r.data));
          const fp = parts.find((p) => p.type === 'file');
          assert.equal(fp.filename, 'chart.png');
          assert.equal(fp.mime, 'image/png');
          assert.equal(fp.url, 'file:///storage/chart.png');
          // and it parses back identically
          const back = await adapter.parse(res.sessionId, dstRoot);
          const bfile = back.messages[0].content.find((b) => b.type === 'file') as { filename?: string };
          assert.equal(bfile.filename, 'chart.png');
        } finally {
          db.close();
        }
      } finally {
        await fs.rm(dstRoot, { recursive: true, force: true });
      }
    } finally {
      await fx.close();
    }
  });
});

test('zcode write: refuses to fabricate the default store without an explicit root', async () => {
  await withoutRealZcodeHome(async () => {
    const adapter = new ZcodeAdapter();
    const ir: MigratedSession = { schemaVersion: 2, originTool: 'claude', messages: [] };
    await assert.rejects(
      () => adapter.write(ir, { targetCwd: 'D:\\proj' }),
      /Refusing to fabricate/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Review fixes: orphan results, sidechain drain/nesting, pending     */
/* states, synthetic flag, session extensions, listSessions errors    */
/* ------------------------------------------------------------------ */

test('zcode write: orphan tool_result (empty toolUseId) degrades to a [tool result] user line, never silently dropped', async () => {
  await withoutRealZcodeHome(async () => {
    const dstRoot = await fs.mkdtemp(join(tmpdir(), 'sm-zcode-orph-'));
    try {
      const ir: MigratedSession = {
        schemaVersion: 2,
        originTool: 'claude',
        title: 'orphan result',
        cwd: 'D:\\proj',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'do things' }] },
          // user row carrying ONLY an orphan tool_result (call row lost in the source)
          { role: 'user', content: [{ type: 'tool_result', toolUseId: '', content: 'ORPHAN RESULT TEXT' }] },
        ],
      };
      const res = await new ZcodeAdapter().write(ir, { root: dstRoot, targetCwd: 'D:\\proj' });
      // whole-store search: the orphan content text must survive somewhere
      const db = new DatabaseSync(join(dstRoot, 'cli', 'db', 'db.sqlite'));
      try {
        const hit = (db.prepare("SELECT COUNT(*) AS n FROM part WHERE data LIKE '%ORPHAN RESULT TEXT%'").get() as { n: number }).n;
        assert.ok(hit >= 1, `orphan tool_result content must land in ≥1 part row, got ${hit}`);
        const carrier = JSON.parse((db.prepare("SELECT p.data FROM part p JOIN message m ON m.id = p.message_id WHERE p.data LIKE '%ORPHAN RESULT TEXT%'").get() as { data: string }).data);
        assert.equal(carrier.type, 'text');
        assert.match(carrier.text, /^\[tool result\] ORPHAN RESULT TEXT$/);
        // and the message row carrying it is a user row, not a phantom tool part
        const msgData = JSON.parse((db.prepare("SELECT m.data FROM part p JOIN message m ON m.id = p.message_id WHERE p.data LIKE '%ORPHAN RESULT TEXT%'").get() as { data: string }).data);
        assert.equal(msgData.role, 'user');
        const toolParts = (db.prepare("SELECT COUNT(*) AS n FROM part WHERE data LIKE '%\"type\":\"tool\"%'").get() as { n: number }).n;
        assert.equal(toolParts, 0, 'an orphan result must not fabricate a tool part');
      } finally {
        db.close();
      }
    } finally {
      await fs.rm(dstRoot, { recursive: true, force: true });
    }
  });
});

test('zcode write: unclaimed sidechain drains into a subagent_child session (transcript never dropped)', async () => {
  await withoutRealZcodeHome(async () => {
    const dstRoot = await fs.mkdtemp(join(tmpdir(), 'sm-zcode-drain-'));
    try {
      const ir: MigratedSession = {
        schemaVersion: 2,
        originTool: 'zcode',
        cwd: 'D:\\proj',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'just chatting, no agent call' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        ],
        sidechains: [{
          agentId: 'sess_subagent_agent_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          kind: 'subagent',
          agentType: 'Explore',
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'UNCLAIMED SIDECHAIN TEXT' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'did the exploring anyway' }] },
          ],
        }],
      };
      const res = await new ZcodeAdapter().write(ir, { root: dstRoot, targetCwd: 'D:\\proj' });
      const db = new DatabaseSync(join(dstRoot, 'cli', 'db', 'db.sqlite'));
      try {
        // the sidechain became a child session row parented at the main session
        const kids = db.prepare('SELECT id, parent_id, task_type FROM session WHERE parent_id=?').all(res.sessionId) as Array<Record<string, unknown>>;
        assert.equal(kids.length, 1, 'unclaimed sidechain must still write its child session');
        assert.equal(kids[0].task_type, 'subagent_child');
        assert.ok(String(kids[0].id).startsWith('sess_subagent_agent_'), 'child id follows the engine id convention');
        // and its unique text survives
        const hit = (db.prepare("SELECT COUNT(*) AS n FROM part WHERE data LIKE '%UNCLAIMED SIDECHAIN TEXT%'").get() as { n: number }).n;
        assert.ok(hit >= 1, 'drained sidechain transcript text must survive');
      } finally {
        db.close();
      }
    } finally {
      await fs.rm(dstRoot, { recursive: true, force: true });
    }
  });
});

test('zcode write: nested (grandchild) sidechains write sessions parented at their child level', async () => {
  await withoutRealZcodeHome(async () => {
    const dstRoot = await fs.mkdtemp(join(tmpdir(), 'sm-zcode-nest-'));
    try {
      const ir: MigratedSession = {
        schemaVersion: 2,
        originTool: 'zcode',
        cwd: 'D:\\proj',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'spawn' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_agentX', name: 'Agent', input: { description: 'probe', prompt: 'delegate further' } }],
            stopReason: 'tool-calls',
          },
        ],
        sidechains: [{
          agentId: 'sess_subagent_agent_11111111-2222-3333-4444-555555555555',
          kind: 'subagent',
          agentType: 'Explore',
          parentMessageId: 'call_agentX',
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'delegate further' }] },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'call_agentInner', name: 'Agent', input: { description: 'inner', prompt: 'inner work' } }],
              stopReason: 'tool-calls',
            },
          ],
          sidechains: [{
            agentId: 'sess_subagent_agent_99999999-8888-7777-6666-555555555555',
            kind: 'subagent',
            messages: [
              { role: 'user', content: [{ type: 'text', text: 'GRANDCHILD UNIQUE TEXT' }] },
              { role: 'assistant', content: [{ type: 'text', text: 'grandchild done' }] },
            ],
          }],
        }],
      };
      const res = await new ZcodeAdapter().write(ir, { root: dstRoot, targetCwd: 'D:\\proj' });
      const db = new DatabaseSync(join(dstRoot, 'cli', 'db', 'db.sqlite'));
      try {
        const mainId = res.sessionId;
        const child = db.prepare('SELECT id FROM session WHERE parent_id=?').get(mainId) as { id: string } | undefined;
        assert.ok(child, 'child session row exists');
        // grandchild session is parented at the CHILD (subagent delegation tree)
        const grand = db.prepare('SELECT id, task_type FROM session WHERE parent_id=?').get(child.id) as { id: string; task_type: string } | undefined;
        assert.ok(grand, 'grandchild session row must exist (previously dropped entirely)');
        assert.equal(grand.task_type, 'subagent_child');
        const hit = (db.prepare("SELECT COUNT(*) AS n FROM part WHERE data LIKE '%GRANDCHILD UNIQUE TEXT%'").get() as { n: number }).n;
        assert.ok(hit >= 1, 'grandchild transcript text must survive');
        // nesting depth is exactly main → child → grandchild (no accidental flat attach)
        const depthCheck = db.prepare('SELECT COUNT(*) AS n FROM session WHERE parent_id=? AND id=?').get(mainId, grand.id) as { n: number };
        assert.equal(depthCheck.n, 0, 'grandchild must not attach to the main session');
      } finally {
        db.close();
      }
    } finally {
      await fs.rm(dstRoot, { recursive: true, force: true });
    }
  });
});

test('zcode write: tool_use without record or result stays pending, never fabricated completed+\'\'', async () => {
  await withoutRealZcodeHome(async () => {
    const dstRoot = await fs.mkdtemp(join(tmpdir(), 'sm-zcode-pend-'));
    try {
      const ir: MigratedSession = {
        schemaVersion: 2,
        originTool: 'claude',
        cwd: 'D:\\proj',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'go' }] },
          // Bash call whose result never arrived (source interrupted)
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call_pendingXYZ', name: 'Bash', input: { command: 'sleep 1000' } }], stopReason: 'tool-calls' },
          { role: 'assistant', content: [{ type: 'text', text: '(interrupted)' }] },
        ],
      };
      const res = await new ZcodeAdapter().write(ir, { root: dstRoot, targetCwd: 'D:\\proj' });
      const db = new DatabaseSync(join(dstRoot, 'cli', 'db', 'db.sqlite'));
      try {
        const part = JSON.parse((db.prepare("SELECT data FROM part WHERE session_id=? AND data LIKE '%call_pendingXYZ%'").get(res.sessionId) as { data: string }).data);
        assert.equal(part.type, 'tool');
        assert.equal(part.state.status, 'pending', 'a call with no record and no result must write the native pending state');
        assert.equal(part.state.input.command, 'sleep 1000');
        assert.ok(!('output' in part.state), 'no fabricated output');
        assert.ok(!('title' in part.state), 'pending parts carry no title in the native shape');
      } finally {
        db.close();
      }
    } finally {
      await fs.rm(dstRoot, { recursive: true, force: true });
    }
  });
});

test('zcode write: synthetic messages drop by default; keepSynthetic writes hidden system_reminder semantics', async () => {
  await withoutRealZcodeHome(async () => {
    const mkIr = (): MigratedSession => ({
      schemaVersion: 2,
      originTool: 'dsh',
      cwd: 'D:\\proj',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'real question' }] },
        { role: 'user', content: [{ type: 'text', text: '<system-reminder>harness injection</system-reminder>' }], synthetic: true },
        { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      ],
    });
    const adapter = new ZcodeAdapter();

    // default: the synthetic row is dropped entirely
    const dropRoot = await fs.mkdtemp(join(tmpdir(), 'sm-zcode-synd-'));
    try {
      const res = await adapter.write(mkIr(), { root: dropRoot, targetCwd: 'D:\\proj' });
      const db = new DatabaseSync(join(dropRoot, 'cli', 'db', 'db.sqlite'));
      try {
        const hit = (db.prepare("SELECT COUNT(*) AS n FROM part WHERE session_id=? AND data LIKE '%harness injection%'").get(res.sessionId) as { n: number }).n;
        assert.equal(hit, 0, 'synthetic message must be dropped by default');
      } finally {
        db.close();
      }
    } finally {
      await fs.rm(dropRoot, { recursive: true, force: true });
    }

    // opt-in keepSynthetic: written with hidden system_reminder semantics
    const keepRoot = await fs.mkdtemp(join(tmpdir(), 'sm-zcode-synk-'));
    try {
      const res = await adapter.write(mkIr(), { root: keepRoot, targetCwd: 'D:\\proj', keepSynthetic: true });
      const db = new DatabaseSync(join(keepRoot, 'cli', 'db', 'db.sqlite'));
      try {
        const row = db.prepare("SELECT m.data FROM part p JOIN message m ON m.id = p.message_id WHERE p.data LIKE '%harness injection%'").get() as { data: string } | undefined;
        assert.ok(row, 'synthetic message kept with keepSynthetic');
        const d = JSON.parse(row.data);
        assert.equal(d.role, 'user');
        assert.equal(d.semantics.origin, 'system');
        assert.equal(d.semantics.kind, 'system_reminder');
        assert.equal(d.semantics.uiVisibility, 'hidden');
        assert.equal(d.semantics.providerVisibility, 'visible');
        assert.equal(d.synthetic, true);
        // the real prompt keeps its real_user semantics
        const realRow = JSON.parse((db.prepare("SELECT m.data FROM part p JOIN message m ON m.id = p.message_id WHERE p.data LIKE '%real question%'").get() as { data: string }).data);
        assert.equal(realRow.semantics.origin, 'real_user');
      } finally {
        db.close();
      }
    } finally {
      await fs.rm(keepRoot, { recursive: true, force: true });
    }
  });
});

test('zcode write: extensions["zcode.session"] store-level columns (version/permission) are honoured', async () => {
  await withoutRealZcodeHome(async () => {
    const dstRoot = await fs.mkdtemp(join(tmpdir(), 'sm-zcode-ext-'));
    try {
      const ir: MigratedSession = {
        schemaVersion: 2,
        originTool: 'zcode',
        title: 'ext session',
        cwd: 'D:\\proj',
        createdAt: T0,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        extensions: {
          'zcode.session': {
            // per-row identity fields (slug/taskType of the SOURCE row) are
            // deliberately NOT re-applied: the IR was parsed from one row but
            // written as a fresh root — re-grafting the child's taskType would
            // mislabel the new root as subagent_child.
            version: '0.21.7',
            permission: '{"mode":"plan"}',
            slug: 'stale-source-slug',
            taskType: 'subagent_child',
          },
        },
      };
      const res = await new ZcodeAdapter().write(ir, { root: dstRoot, targetCwd: 'D:\\proj' });
      const db = new DatabaseSync(join(dstRoot, 'cli', 'db', 'db.sqlite'));
      try {
        const row = db.prepare('SELECT version, permission, task_type, slug FROM session WHERE id=?').get(res.sessionId) as Record<string, unknown>;
        assert.equal(row.version, '0.21.7', 'engine version from the source extension');
        assert.equal(row.permission, '{"mode":"plan"}', 'permission JSON from the source extension');
        assert.equal(row.task_type, 'interactive', 'per-row task_type is NOT re-grafted from the source row');
        assert.equal(row.slug, res.sessionId, 'per-row slug is NOT re-grafted from the source row');
      } finally {
        db.close();
      }
    } finally {
      await fs.rm(dstRoot, { recursive: true, force: true });
    }
  });
});

test('zcode listSessions: absent file → [], a db that cannot be opened → throws', async () => {
  await withoutRealZcodeHome(async () => {
    // 1. no db at all → empty list, no error
    const emptyRoot = await fs.mkdtemp(join(tmpdir(), 'sm-zcode-ls1-'));
    try {
      assert.deepEqual(await new ZcodeAdapter().listSessions(emptyRoot), []);
    } finally {
      await fs.rm(emptyRoot, { recursive: true, force: true });
    }

    // 2. a CORRUPT store at the resolved path: read-only open succeeds but
    // the query fails ("file is not a database"). The old code swallowed that
    // into []; now the failure must surface — a broken store silently listed
    // as empty would read as "nothing to migrate".
    const badRoot = await fs.mkdtemp(join(tmpdir(), 'sm-zcode-ls2-'));
    const badDir = join(badRoot, 'cli', 'db');
    try {
      await fs.mkdir(badDir, { recursive: true });
      await fs.writeFile(join(badDir, 'db.sqlite'), 'this is definitely not a sqlite database'.repeat(50));
      await assert.rejects(
        () => new ZcodeAdapter().listSessions(badRoot),
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
});

/* ------------------------------------------------------------------ */
/* Real live store (skipped when ~/.zcode is absent)                   */
/* ------------------------------------------------------------------ */

const REAL_DB = join(process.env.ZCODE_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.zcode'), 'cli', 'db', 'db.sqlite');

test('zcode real db: interactive session with revert + subagents parses and validates', { skip: !existsSync(REAL_DB) && `no real zcode db at ${REAL_DB}` }, async () => {
  const probe = new DatabaseSync(REAL_DB, { readOnly: true });
  let parentSessionId: string;
  let childSessionId: string;
  let totalMessages: number;
  try {
    // newest interactive session that has subagent_child children
    const parent = probe.prepare(`
      SELECT s.id, (SELECT count(*) FROM message m WHERE m.session_id = s.id) AS n
      FROM session s
      WHERE s.task_type = 'interactive'
        AND EXISTS (SELECT 1 FROM session c WHERE c.parent_id = s.id AND c.task_type = 'subagent_child')
      ORDER BY s.time_created DESC LIMIT 1`).get() as { id: string; n: number };
    assert.ok(parent, 'no interactive session with subagent children in real db');
    parentSessionId = parent.id;
    totalMessages = parent.n;
    const child = probe.prepare(
      "SELECT id FROM session WHERE parent_id=? AND task_type='subagent_child' ORDER BY time_created LIMIT 1",
    ).get(parentSessionId) as { id: string };
    childSessionId = child.id;
  } finally {
    probe.close();
  }

  const adapter = new ZcodeAdapter();
  const ir = await adapter.parse(parentSessionId);

  // validateSession ran inside parse; structural sanity here
  assert.ok(ir.messages.length > 0);
  assert.ok(ir.messages.every((m) => ['user', 'assistant', 'tool'].includes(m.role)));
  // model-only synthetic content must never leak into IR messages
  // (extensions['zcode.syntheticMessages'] intentionally keeps their raw data)
  // Probe by the reminder's TEXT signature on user messages only — a bare
  // `todo_reminder` substring false-positives on legitimate assistant
  // tool_use inputs (e.g. docs that discuss the marker itself).
  const REMINDER_SIG = 'The TodoWrite tool hasn' + "'t been used recently";
  assert.ok(
    !ir.messages.some((m) =>
      m.role === 'user' && m.content.some((b) => b.type === 'text' && b.text.includes(REMINDER_SIG)),
    ),
    'todo_reminder synthetic leaked into IR messages',
  );
  // the provider bucket must carry only id→name pairs, never credentials
  const ext = ir.extensions as Record<string, unknown>;
  const provDump = JSON.stringify(ext['zcode.providers'] ?? {});
  assert.ok(!provDump.includes('apiKey') && !provDump.includes('options'), 'provider config leaked beyond names');
  // every real user message came through with text
  const firstUser = ir.messages.find((m) => m.role === 'user');
  assert.ok(firstUser && firstUser.content.some((b) => b.type === 'text'));
  // sidechains discovered through parent_id + sess_subagent_agent_<uuid>
  assert.ok((ir.sidechains?.length ?? 0) > 0, 'no sidechains discovered');
  assert.ok(ir.sidechains!.every((sc) => sc.agentId.startsWith('sess_subagent_agent_')));
  assert.ok(ir.sidechains!.every((sc) => sc.messages.length > 0));
  const childIc = ir.sidechains![0];
  assert.ok(childIc.agentType === undefined || typeof childIc.agentType === 'string');
  // revert trimming actually pruned (when this session was rewound)
  const reverted = !!(ext['zcode.session'] as { revertRaw?: unknown }).revertRaw;
  if (reverted) {
    const pruned = ext['zcode.prunedMessages'] as Array<{ id: string; sequence: number }>;
    assert.ok(pruned.length > 0, 'revert present but nothing pruned');
    assert.ok(pruned.length < totalMessages);
    // nothing pruned may appear in the active IR (seq-level check; role:'tool'
    // IR messages share the assistant's seq)
    const prunedSeqs = new Set(pruned.map((p) => p.sequence));
    assert.ok(
      ir.messages.every((m) => m.seq === undefined || !prunedSeqs.has(m.seq)),
      'a pruned message sequence survived into IR messages',
    );
  }
  // child session parses standalone
  const childIr = await adapter.parse(childSessionId);
  assert.ok(childIr.messages.length > 0);
  assert.equal(childIr.originTool, 'zcode');
});

test('zcode real db: listSessions returns SessionMeta rows', { skip: !existsSync(REAL_DB) && `no real zcode db at ${REAL_DB}` }, async () => {
  const metas = await new ZcodeAdapter().listSessions();
  assert.ok(metas.length > 0);
  assert.ok(metas.every((m) => m.tool === 'zcode' && m.sessionId.startsWith('sess_')));
  const withTitle = metas.find((m) => m.title);
  assert.ok(withTitle, 'no titled session in real db list');
  // roots only: no parent-linked child row may leak into the list
  const db = new DatabaseSync(REAL_DB, { readOnly: true });
  try {
    const total = (db.prepare('SELECT COUNT(*) AS n FROM session').get() as { n: number }).n;
    const children = (db.prepare('SELECT COUNT(*) AS n FROM session WHERE parent_id IS NOT NULL').get() as { n: number }).n;
    assert.equal(metas.length, total - children);
  } finally {
    db.close();
  }
});
