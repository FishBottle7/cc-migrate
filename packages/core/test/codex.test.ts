/**
 * Codex adapter tests — v3 lossless gate (docs/agents/codex.md §8/§9).
 *
 * Fixtures mirror real ~/.codex rollouts (cli 0.146.0): multi session_meta
 * inheritance, developer/system messages, function/custom/local_shell/tool_search/
 * web_search/image_generation items, reasoning summary+content, event_msg
 * persistence subset, turn_context/world_state, compacted (with and without
 * replacement_history), thread_rolled_back, paginated ordinals.
 *
 * The round-trip gate: fixture lines → IR → rollout lines → IR must be
 * deep-equal at every IR level (messages / compaction / unmappedEvents /
 * session meta modulo the §9.2 rewritten fields), and the re-written record
 * stream must preserve record types + payloads except encrypted placeholders.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdCompressSync } from 'node:zlib';
import { CodexAdapter } from '../src/adapters/codex/index.js';
import {
  buildRolloutLines,
  buildSessionMetaPayload,
  rolloutTimestamp,
  sessionIndexTitle,
} from '../src/adapters/codex/write.js';
import {
  parseRolloutLines,
  rolloutRecordsToIr,
  readRolloutText,
  parseRolloutFile,
} from '../src/adapters/codex/parse.js';
import {
  defaultCodexHome,
  codexSessionPathFor,
  parseRolloutFileName,
  rolloutFileName,
  sessionIndexPath,
  uuidv7,
} from '../src/adapters/codex/paths.js';
import { fallbackIr } from '../src/demo.js';
import type { MigratedMessage, MigratedSession } from '../src/ir.js';

const TS = '2026-08-20T02:14:08.083Z';

function metaLine(payload: Record<string, unknown>, timestamp = TS, ordinal?: number) {
  return { timestamp, ...(ordinal !== undefined ? { ordinal } : {}), type: 'session_meta', payload };
}

function item(payload: Record<string, unknown>, timestamp = TS, ordinal?: number, metadata?: unknown) {
  return {
    timestamp,
    ...(ordinal !== undefined ? { ordinal } : {}),
    type: 'response_item',
    payload,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function ev(type: string, data: Record<string, unknown>, timestamp = TS, ordinal?: number) {
  return { timestamp, ...(ordinal !== undefined ? { ordinal } : {}), type: 'event_msg', payload: { type, ...data } };
}

function baseMetaLines(overrides: Record<string, unknown> = {}) {
  return [
    metaLine({
      session_id: '019bb246-e05f-7f71-8d59-115a91aa293b',
      id: '019bb246-e05f-7f71-8d59-115a91aa293b',
      timestamp: '2026-01-12T12:55:47.732Z',
      cwd: 'D:\\proj',
      originator: 'codex_cli_rs',
      cli_version: '0.146.0',
      source: 'cli',
      thread_source: 'user',
      model_provider: 'openai',
      base_instructions: { text: 'You are Codex.', provenance: { type: 'model', model: 'gpt-5' } },
      history_mode: 'legacy',
      git: { branch: 'main', commit_hash: 'abc', repository_url: 'https://example.com/x' },
      ...overrides,
    }),
  ];
}

/** Rich legacy-mode fixture exercising every persisted record shape. */
function richFixture(): Array<Record<string, unknown>> {
  return [
    ...baseMetaLines(),
    ev('task_started', { turn_id: 't1', collaboration_mode_kind: 'regular' }),
    ev('token_count', { info: { total: 42 }, rate_limits: null }),
    item({
      type: 'message',
      id: 'msg_1',
      role: 'developer',
      content: [{ type: 'input_text', text: '<permissions instructions>\nsandbox: on\n</permissions instructions>' }],
    }),
    item({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '# AGENTS.md instructions for D:\\proj\n\n<INSTRUCTIONS>\nbe nice\n</INSTRUCTIONS>' }],
    }),
    { timestamp: TS, type: 'world_state', payload: { full: true, state: { agents_md: 'be nice', permissions: 'rw' } } },
    { timestamp: TS, type: 'turn_context', payload: {
      cwd: 'D:\\proj', model: 'gpt-5', approval_policy: 'on-request', sandbox_policy: { mode: 'read-only' },
      summary: 'auto', current_date: '2026-08-20', timezone: 'UTC', turn_id: 't1',
    } },
    item({ type: 'message', id: 'msg_2', role: 'user', content: [{ type: 'input_text', text: '你好，帮我看看' }] }),
    item({
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: ' Considering the request.' }],
      content: [{ type: 'reasoning_text', text: 'Deep thought here.' }],
      encrypted_content: 'gAAAAAB-reasoning',
    }),
    item({ type: 'function_call', id: 'fc_1', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'call_1' }),
    item({ type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: 'file1\nfile2' }),
    item({
      type: 'function_call_output',
      id: 'fco_2',
      output: [
        { type: 'input_text', text: 'mcp result' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' },
      ],
    }),
    item({ type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_c', name: 'patch', input: '*** Begin Patch' }),
    item({ type: 'custom_tool_call_output', id: 'ctco_1', call_id: 'call_c', output: [{ type: 'input_text', text: 'patched' }] }),
    item({ type: 'local_shell_call', id: 'lsc_1', call_id: null, status: 'completed', action: { type: 'exec', command: ['pwd'], timeout_ms: null, working_directory: null, env: null, user: null } }),
    item({ type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'codex rollout format' } }),
    item({ type: 'tool_search_call', id: 'tsc_1', call_id: 'call_ts', status: 'completed', execution: 'vector', arguments: { q: 'read' } }),
    item({ type: 'tool_search_output', id: 'tso_1', call_id: 'call_ts', status: 'completed', execution: 'vector', tools: [{ name: 'read' }] }),
    item({ type: 'image_generation_call', id: 'ig_1', status: 'completed', revised_prompt: 'a cat', result: 'QUJD' }),
    item({ type: 'message', id: 'msg_3', role: 'assistant', content: [{ type: 'output_text', text: '方案如下' }] }),
    ev('task_complete', { turn_id: 't1', last_agent_message: '方案如下' }),
    // agent_message (multi-agent collab) + its bookkeeping row
    item({ type: 'agent_message', id: 'am_1', author: '/root/a', recipient: '/root/b', content: [{ type: 'encrypted_content', encrypted_content: 'gAAAAAB-am' }] }),
    { timestamp: TS, type: 'inter_agent_communication_metadata', payload: { trigger_turn: false } },
    // inter_agent_communication record (model-visible)
    { timestamp: TS, type: 'inter_agent_communication', payload: {
      id: 'iac_1', author: '/root/a', recipient: '/root/b', other_recipients: ['/root/c'],
      content: 'handing over', encrypted_content: null, trigger_turn: true,
    } },
    // compaction with replacement_history
    { timestamp: TS, type: 'compacted', payload: {
      message: 'Earlier: user asked to look into things.',
      replacement_history: [
        { type: 'message', id: 'msg_2', role: 'user', content: [{ type: 'input_text', text: '你好，帮我看看' }] },
        { type: 'message', id: 'msg_3', role: 'assistant', content: [{ type: 'output_text', text: '方案如下' }] },
      ],
      window_number: 1,
      first_window_id: 'w0',
      previous_window_id: 'w0',
      window_id: 'w1',
      mcp_resource_origins: null,
    } },
    ev('thread_rolled_back', { num_turns: 1 }),
    // legacy compaction without replacement_history
    { timestamp: TS, type: 'compacted', payload: { message: 'legacy summary' } },
    { timestamp: TS, type: 'security_risk_score', payload: { scores: [{ risk: 1 }] } },
    // pure-encrypted response items (the only legal drops)
    item({ type: 'compaction', id: 'cp_1', encrypted_content: 'gAAAAAB-compaction' }),
    item({ type: 'context_compaction', id: 'cc_1' }),
    ev('turn_aborted', { turn_id: 't1', reason: 'interrupted' }),
    ev('thread_settings_applied', { thread_settings: { model: 'gpt-5', cwd: 'D:\\proj', approval_policy: 'on-request' } }),
    // goal resume steering — legacy <goal_context> marker (codex ext/goal)
    item({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<goal_context>\nContinue working toward: ship the adapter.\n</goal_context>' }],
    }),
    // modern internal steering with the official positional content_item_kinds
    item({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<codex_internal_context source="goal">\nObjective updated.\n</codex_internal_context>' }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['goal.internal_context'] },
    }),
    // additional_tools — not persisted by codex policy; archived + replayed
    item({ type: 'additional_tools', role: 'user', tools: [{ name: 'browser' }] }),
    // orphan turn rows at EOF (nothing follows → unmapped archive)
    { timestamp: TS, type: 'world_state', payload: { full: false, state: { permissions: 'rwx' } } },
    { timestamp: TS, type: 'turn_context', payload: {
      cwd: 'D:\\proj', model: 'gpt-5', approval_policy: 'on-request', sandbox_policy: { mode: 'read-only' }, summary: 'auto',
    } },
  ];
}

const ENCRYPTED_PLACEHOLDER = '[encrypted_content omitted by cc-migrate]';

/** Fixture records → raw JSONL text lines for the parser. */
function lines(records: Array<Record<string, unknown>>): ReturnType<typeof parseRolloutLines> {
  return parseRolloutLines(records.map((r) => JSON.stringify(r)).join('\n'));
}

function tempRoot(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'sm-codex-test-'));
}

/* ------------------------------------------------------------------ */
/* paths                                                               */
/* ------------------------------------------------------------------ */

test('paths: home resolution, filename render/parse, uuidv7 semantics', () => {
  assert.equal(typeof defaultCodexHome(), 'string');
  const createdAt = Date.parse('2026-01-12T20:55:48Z');
  const name = rolloutFileName('019bb246-abcd', createdAt);
  assert.equal(name, 'rollout-2026-01-12T20-55-48-019bb246-abcd.jsonl');
  // revert variant: distinct rollout id after the underscore
  assert.equal(rolloutFileName('t1', createdAt, 'r2'), 'rollout-2026-01-12T20-55-48-t1_r2.jsonl');
  const parsed = parseRolloutFileName('rollout-2026-08-20T10-14-07-01a01cf2-7792-7391-a0d1-a1a5b1314c88.jsonl.zst');
  assert.ok(parsed);
  assert.equal(parsed.threadId, '01a01cf2-7792-7391-a0d1-a1a5b1314c88');
  assert.equal(parsed.createdAt, Date.parse('2026-08-20T10:14:07Z')); // assume_utc quirk
  assert.equal(parsed.compressed, true);
  assert.equal(parseRolloutFileName('session_index.jsonl'), null);

  const id = uuidv7();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // bytes 0-3 = ts >> 16, bytes 4-5 = ts & 0xffff (48-bit unix-ms prefix)
  const ms = BigInt(parseInt(id.slice(0, 8), 16)) << 16n | BigInt(parseInt(id.slice(9, 13), 16));
  assert.ok(Math.abs(Number(ms) - Date.now()) < 10_000, 'uuidv7 embeds unix-ms prefix');

  // rollout envelope timestamp format: ms precision Z
  assert.equal(rolloutTimestamp(Date.parse('2026-08-20T02:14:08.083Z')), '2026-08-20T02:14:08.083Z');
  assert.match(sessionIndexPath('C:/home/.codex'), /\.codex[\\/]session_index\.jsonl$/);
});

/* ------------------------------------------------------------------ */
/* read side                                                           */
/* ------------------------------------------------------------------ */

test('read: 11 record types + 17 response_item variants map losslessly to IR', () => {
  const session = rolloutRecordsToIr(lines(richFixture()), {});

  // session-level promotions
  assert.equal(session.originTool, 'codex');
  assert.equal(session.originSessionId, '019bb246-e05f-7f71-8d59-115a91aa293b');
  assert.equal(session.cwd, 'D:\\proj');
  assert.equal(session.createdAt, Date.parse('2026-01-12T12:55:47.732Z'));
  assert.deepEqual(session.model, { id: 'openai' });
  assert.equal(session.systemPrompt, 'You are Codex.');
  const scodex = (session.meta as Record<string, unknown>).codex as Record<string, unknown>;
  assert.equal(((scodex.sessionMetaLine as Record<string, unknown>).payload as Record<string, unknown>).cli_version, '0.146.0');
  assert.deepEqual((scodex.sessionMetaLine as Record<string, unknown>).payload, richFixture()[0].payload);
  assert.deepEqual(scodex.baseInstructionsProvenance, { type: 'model', model: 'gpt-5' });

  // messages: 1 response_item = 1 message, native payload preserved.
  // Lookups are predicate-based so fixture order edits can't desync assertions.
  const msgs = session.messages;
  const byItem = (t: string, extra?: (m: MigratedMessage) => boolean) =>
    msgs.filter((m) => ((m.meta as Record<string, unknown>)?.codex as Record<string, unknown>)?.itemType === t && (!extra || extra(m)));
  const codexMetaOf = (m: MigratedMessage) => (m.meta as Record<string, unknown>).codex as Record<string, unknown>;

  // developer permissions line — synthetic, contentKind marked
  const devMsg = msgs[0];
  assert.equal(devMsg.role, 'developer');
  assert.equal(codexMetaOf(devMsg).contentKind, 'permissions.instructions');
  assert.equal(devMsg.synthetic, true);
  // AGENTS.md — carried as history, NOT synthetic
  const agentsMsg = msgs[1];
  assert.equal(codexMetaOf(agentsMsg).contentKind, 'agents_md.instructions');
  assert.equal(agentsMsg.synthetic, undefined);
  // real user message — carries the turn's world_state + turn_context rows
  const userMsg = byItem('message', (m) => !m.synthetic && !codexMetaOf(m).contentKind)[0];
  assert.ok(userMsg, 'plain user message present');
  assert.deepEqual(codexMetaOf(userMsg).worldState, [{ ts: TS, payload: { full: true, state: { agents_md: 'be nice', permissions: 'rw' } }, kind: 'world_state', seq: 5 }]);
  const turnContext = codexMetaOf(userMsg).turnContext as Record<string, unknown>;
  assert.equal((turnContext.payload as Record<string, unknown>).model, 'gpt-5');
  assert.equal(turnContext.kind, 'turn_context');
  // reasoning: summary + content preserved, encrypted flagged
  const reasoning = byItem('reasoning')[0];
  assert.deepEqual(reasoning.content.map((b) => (b as { thinking: string }).thinking), [' Considering the request.', 'Deep thought here.']);
  assert.deepEqual(codexMetaOf(reasoning).reasoningEntryTypes, ['summary_text', 'reasoning_text']);
  assert.equal(codexMetaOf(reasoning).reasoningSummaryCount, 1);
  assert.equal(codexMetaOf(reasoning).encryptedDropped, true);
  // function_call + output pair as separate codex-native messages
  const fnCall = byItem('function_call')[0];
  assert.equal((fnCall.content[0] as { name: string }).name, 'shell');
  const fnOut = byItem('function_call_output', (m) => (m.content[0] as { content: string }).content === 'file1\nfile2')[0];
  assert.equal(fnOut.role, 'tool');
  assert.equal(fnOut.content[0].type, 'tool_result');
  // bare-array output with image → tool_result + attachment, raw preserved
  const mcpOut = byItem('function_call_output', (m) => (m.content[0] as { content: string }).content === 'mcp result')[0];
  assert.equal(codexMetaOf(mcpOut).callId, null);
  const resultMcp = mcpOut.content[0] as { content: string; attachments?: Array<{ url?: string }> };
  assert.equal(resultMcp.attachments?.[0].url, 'data:image/png;base64,AAAA');
  assert.deepEqual(codexMetaOf(mcpOut).outputRaw, (richFixture()[11].payload as Record<string, unknown>).output);
  // custom tool pair
  const customCall = byItem('custom_tool_call')[0];
  assert.equal((customCall.content[0] as { input: string }).input, '*** Begin Patch');
  const customOut = byItem('custom_tool_call_output')[0];
  assert.deepEqual(codexMetaOf(customOut).outputRaw, [{ type: 'input_text', text: 'patched' }]);
  // local shell (call_id null preserved as null)
  const shell = byItem('local_shell_call')[0];
  assert.equal(codexMetaOf(shell).callId, null);
  assert.equal(codexMetaOf(shell).status, 'completed');
  // web_search_call → tool_use with action
  const webSearch = byItem('web_search_call')[0];
  assert.deepEqual((webSearch.content[0] as { input: unknown }).input, { type: 'search', query: 'codex rollout format' });
  // tool_search pair
  const tsOut = byItem('tool_search_output')[0];
  assert.equal(codexMetaOf(tsOut).execution, 'vector');
  // image_generation_call → fused tool_use + tool_result(attachment)
  const imgGen = byItem('image_generation_call')[0];
  assert.equal(codexMetaOf(imgGen).revisedPrompt, 'a cat');
  assert.equal((imgGen.content[1] as { attachments?: Array<{ data?: string }> }).attachments?.[0].data, 'QUJD');
  // agent_message with encrypted content part
  const agentMsg = byItem('agent_message')[0];
  assert.equal(codexMetaOf(agentMsg).kind, 'agent_message');
  assert.equal(codexMetaOf(agentMsg).encryptedDropped, true);
  assert.deepEqual(codexMetaOf(agentMsg).contentRaw, [{ type: 'encrypted_content', encrypted_content: ENCRYPTED_PLACEHOLDER }]);
  // inter_agent_communication → model-visible assistant message
  const iac = msgs.find((m) => codexMetaOf(m).kind === 'iac')!;
  assert.equal(codexMetaOf(iac).triggerTurn, true);
  assert.deepEqual(codexMetaOf(iac).otherRecipients, ['/root/c']);
  assert.equal((iac.content[0] as { text: string }).text, 'handing over');
  // compacted summary projections: assistant form (RH present) + user form (legacy)
  const summaries = msgs.filter((m) => codexMetaOf(m).kind === 'compaction_summary');
  assert.deepEqual(summaries.map((m) => m.role), ['assistant', 'user']);
  assert.deepEqual(summaries.map((m) => (m.content[0] as { text: string } | undefined)?.text),
    ['Earlier: user asked to look into things.', 'legacy summary']);
  // encrypted compaction response items → placeholders
  const compItems = byItem('compaction');
  assert.equal(compItems.length, 1);
  assert.equal(codexMetaOf(compItems[0]).encryptedDropped, true);
  assert.equal(byItem('context_compaction').length, 1);

  // goal resume / internal steering: legacy marker + official content_item_kinds
  // channel — both classify as harness-injected, never plain user prompts
  const goalLegacy = byItem('message', (m) => codexMetaOf(m).contentKind === 'goal.internal_context' && !codexMetaOf(m).contentItemKinds)[0];
  assert.ok(goalLegacy, 'legacy <goal_context> line classified');
  assert.equal(goalLegacy.role, 'user');
  assert.equal(goalLegacy.synthetic, true);
  const goalKinds = byItem('message', (m) => (codexMetaOf(m).contentItemKinds as string[] | undefined)?.[0] === 'goal.internal_context')[0];
  assert.equal(goalKinds.synthetic, true);
  assert.deepEqual(codexMetaOf(goalKinds).contentItemKinds, ['goal.internal_context']);
  // additional_tools (not persisted by codex policy) archived + replayable
  const archivedItem = session.unmappedEvents!.find((u) => u.type === 'response_item');
  assert.ok(archivedItem, 'additional_tools archived');
  assert.deepEqual((archivedItem!.data as Record<string, unknown>).codexResponseItem, {
    type: 'additional_tools', role: 'user', tools: [{ name: 'browser' }],
  });

  // compaction bucket
  const compaction = session.compaction!;
  assert.equal(compaction.length, 2);
  assert.equal(compaction[0].summary, 'Earlier: user asked to look into things.');
  assert.equal(compaction[0].anchorIndex, 17);
  assert.equal(compaction[0].replacementHistory?.length, 2);
  const compMeta = (compaction[0].meta as Record<string, unknown>).codex as Record<string, unknown>;
  assert.equal(compMeta.windowNumber, 1);
  assert.equal(compMeta.windowId, 'w1');
  assert.equal(compMeta.firstWindowId, 'w0');
  assert.equal(compMeta.previousWindowId, 'w0');
  assert.equal(compaction[1].summary, 'legacy summary');
  assert.equal(compaction[1].replacementHistory, undefined);

  // unmappedEvents: event_msg subset + archive rows + orphan turn rows
  const unmapped = session.unmappedEvents!;
  const types = unmapped.map((u) => u.type);
  assert.deepEqual(types.filter((t) => t === 'task_started' || t === 'task_complete' || t === 'thread_rolled_back' || t === 'turn_aborted' || t === 'thread_settings_applied' || t === 'token_count'),
    ['task_started', 'token_count', 'task_complete', 'thread_rolled_back', 'turn_aborted', 'thread_settings_applied']);
  assert.ok(types.includes('inter_agent_communication_metadata'));
  assert.ok(types.includes('security_risk_score'));
  const orphanTurn = unmapped.find((u) => u.data && (u.data as Record<string, unknown>).codexOrphanTurnBit);
  assert.ok(orphanTurn, 'orphan world_state/turn_context rows archived');
  // token_count data preserved verbatim (payload incl. inner type)
  const tokenCount = unmapped.find((u) => u.type === 'token_count')!;
  assert.deepEqual(tokenCount.data, { type: 'token_count', info: { total: 42 }, rate_limits: null });
  // seq = source line number
  assert.equal(unmapped.find((u) => u.type === 'task_started')!.seq, 1);

  // session naming: codex titles sessions after the user's FIRST REAL prompt —
  // injected rows (AGENTS.md, goal steering, permissions) must not win.
  assert.equal(sessionIndexTitle(session), '你好，帮我看看');
});

test('read: inherited session_meta prefix + legacy instructions field archived', () => {
  const session = rolloutRecordsToIr(lines([
    metaLine({ id: 'child', session_id: 'parent', source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1, agent_path: '/root/x', agent_nickname: 'Nick', agent_role: null } } }, thread_source: 'subagent', agent_nickname: 'Nick', agent_path: '/root/x', history_mode: 'legacy' }),
    metaLine({ id: 'parent', session_id: 'parent', instructions: 'OLD user_instructions', history_mode: 'legacy' }, '2026-08-17T12:08:58.339Z'),
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'child task' }] }),
  ]), {});
  assert.equal(session.originSessionId, 'child');
  const scodex = (session.meta as Record<string, unknown>).codex as Record<string, unknown>;
  const inherited = scodex.inheritedMetaLines as Array<{ payload: Record<string, unknown> }>;
  assert.equal(inherited.length, 1);
  assert.equal(inherited[0].payload.id, 'parent');
  // legacy `instructions` stays archived inside the native payload, never promoted
  assert.equal(inherited[0].payload.instructions, 'OLD user_instructions');
  assert.equal(session.systemPrompt, undefined);
});

test('read: paginated mode preserves ordinals as message seq', () => {
  const records = [
    metaLine({ id: 'p1', session_id: 'p1', history_mode: 'paginated' }, TS, 0),
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }, TS, 1),
    { timestamp: TS, ordinal: 2, type: 'world_state', payload: { full: true, state: {} } },
    item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'yo' }] }, TS, 3),
    ev('task_complete', { turn_id: 't' }, TS, 4),
  ];
  const session = rolloutRecordsToIr(lines(records), {});
  assert.equal(session.messages[0].seq, 1);
  const meta2 = (session.messages[1].meta as Record<string, unknown>).codex as Record<string, unknown>;
  assert.deepEqual(meta2.worldState, [{ ts: TS, ordinal: 2, payload: { full: true, state: {} }, kind: 'world_state', seq: 2 }]);
  assert.equal(session.unmappedEvents![0].seq, 4);
});

test('read: .jsonl.zst rollout decompresses via node:zlib', async () => {
  const root = await tempRoot();
  const dir = join(root, 'sessions', '2026', '08', '20');
  await fs.mkdir(dir, { recursive: true });
  const text = richFixture().map((l) => JSON.stringify(l)).join('\n') + '\n';
  const zst = join(dir, 'rollout-2026-08-20T10-14-07-01a01cf2-7792-7391-a0d1-a1a5b1314c88.jsonl.zst');
  await fs.writeFile(zst, zstdCompressSync(Buffer.from(text, 'utf8')));
  const ir = await parseRolloutFile(zst, root);
  assert.equal(ir.messages.length, 23);
  // source folder captured (sessions/YYYY/MM/DD relative to the codex home)
  const scodex = (ir.meta as Record<string, unknown>).codex as Record<string, unknown>;
  assert.match(scodex.sourceDir as string, /sessions\/2026\/08\/20$/);
  assert.match(scodex.sourceFile as string, /^rollout-.*\.jsonl\.zst$/);
  assert.equal(await readRolloutText(zst), text);
});

/* ------------------------------------------------------------------ */
/* write side                                                          */
/* ------------------------------------------------------------------ */

test('write: foreign IR synthesizes minimal session_meta + system prompt choice', () => {
  const ir = fallbackIr();
  ir.systemPrompt = 'Be helpful.';
  ir.createdAt = Date.parse('2026-01-12T20:55:48Z');
  const lines = buildRolloutLines(ir, '019b-test-id', 'D:\\workspace', ir.createdAt, { targetCwd: 'D:\\workspace', createdAt: ir.createdAt, threadId: '019b-test-id' });
  const first = JSON.parse(lines[0]);
  assert.equal(first.type, 'session_meta');
  assert.equal(first.payload.source, 'cli');
  assert.equal(first.payload.history_mode, 'legacy');
  assert.equal(first.payload.cwd, 'D:\\workspace');
  assert.equal(first.payload.originator, 'cc-migrate');
  assert.deepEqual(first.payload.base_instructions, { text: 'Be helpful.', provenance: { type: 'custom' } });
  // target option strips base_instructions
  const lines2 = buildRolloutLines(ir, 'x', 'D:\\w', 0, { targetCwd: 'D:\\w', createdAt: 0, threadId: 'x', systemPromptSource: 'target' });
  assert.equal('base_instructions' in JSON.parse(lines2[0]).payload, false);
  // blocks map to codex-native response_items
  const types = lines.map((l) => JSON.parse(l).type);
  assert.ok(types.includes('response_item'));
  const payloads = lines.map((l) => JSON.parse(l).payload);
  assert.ok(payloads.some((p) => p.type === 'function_call' && p.call_id === 'call-1'));
  assert.ok(payloads.some((p) => p.type === 'function_call_output' && p.call_id === 'call-1'));
});

test('write: foreign compaction bucket → native compacted record with synthesized replacement history', () => {
  const ir = fallbackIr();
  ir.createdAt = 0;
  ir.messages = [
    { role: 'user', content: [{ type: 'text', text: 'folded question' }] },
    { role: 'user', content: [{ type: 'text', text: 'SUMMARY: earlier stuff' }], meta: { zcode: { summary: true } } },
    { role: 'assistant', content: [{ type: 'text', text: 'kept answer' }] },
  ];
  ir.compaction = [{ summary: 'SUMMARY: earlier stuff', anchorIndex: 1 }];
  const lines = buildRolloutLines(ir, 'x', 'D:\\w', 0, { targetCwd: 'D:\\w', createdAt: 0, threadId: 'x' });
  const records = lines.map((l) => JSON.parse(l));
  const compacted = records.filter((r) => r.type === 'compacted');
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0].payload.message, 'SUMMARY: earlier stuff');
  // kept history (post-anchor) becomes the native replacement_history
  assert.deepEqual(compacted[0].payload.replacement_history, [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'kept answer' }] },
  ]);
  // the anchor summary message itself is not duplicated as a normal message
  const messages = records.filter((r) => r.type === 'response_item' && r.payload.type === 'message');
  assert.ok(!messages.some((m) => JSON.stringify(m.payload.content).includes('SUMMARY: earlier stuff')));
  // folded content is still archived in the file (codex resume skips it)
  assert.ok(messages.some((m) => JSON.stringify(m.payload.content).includes('folded question')));
});

test('write: session_index.jsonl gets exactly one appended line, never rewritten', async () => {
  const adapter = new CodexAdapter();
  const root = await tempRoot();
  const ir = fallbackIr();
  ir.title = '迁移测试会话';
  const res1 = await adapter.write(ir, { root, targetCwd: 'D:\\proj' });
  const res2 = await adapter.write(ir, { root, targetCwd: 'D:\\proj' });
  assert.notEqual(res1.sessionId, res2.sessionId);
  const idx = await fs.readFile(sessionIndexPath(root), 'utf8');
  const rows = idx.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].thread_name, '迁移测试会话');
  assert.equal(rows[1].id, res2.sessionId);
  assert.ok(rows[1].updated_at);
});

test('write: never overwrites an existing rollout on id conflict (AGENT.md)', async () => {
  const adapter = new CodexAdapter();
  const root = await tempRoot();
  const ir = fallbackIr();
  const createdAt = Date.parse('2026-01-12T20:55:48Z');
  ir.createdAt = createdAt;
  const res1 = await adapter.write(ir, { root, sessionId: 'fixed-thread-id', targetCwd: 'D:\\proj' });
  const original = await fs.readFile(res1.paths[0], 'utf8');
  const res2 = await adapter.write(ir, { root, sessionId: 'fixed-thread-id', targetCwd: 'D:\\proj' });
  // second write must land on a DIFFERENT file with a fresh id
  assert.notEqual(res2.sessionId, 'fixed-thread-id');
  assert.notEqual(res2.paths[0], res1.paths[0]);
  assert.equal(await fs.readFile(res1.paths[0], 'utf8'), original, 'existing session untouched');
  assert.equal(await fs.readFile(res2.paths[0], 'utf8').then((t) => t.includes('fixed-thread-id')), false);
});

/* ------------------------------------------------------------------ */
/* round-trip: zero-loss gate                                          */
/* ------------------------------------------------------------------ */

test('round-trip: legacy fixture → IR → rollout → IR is deep-equal except encrypted placeholders', () => {
  const records1 = richFixture();
  const ir1 = rolloutRecordsToIr(lines(records1), {});

  const lines2 = buildRolloutLines(
    ir1,
    '019b-new-thread',
    'D:\\proj',
    Date.parse('2026-01-12T12:55:47.732Z'),
    { targetCwd: 'D:\\proj', createdAt: Date.parse('2026-01-12T12:55:47.732Z'), threadId: '019b-new-thread', keepSynthetic: true },
  );
  const records2 = lines2.map((l) => JSON.parse(l) as Record<string, unknown>);
  const ir2 = rolloutRecordsToIr(lines(records2), {});

  // record type sequence identical
  assert.deepEqual(
    records2.map((r) => r.type),
    records1.map((r) => r.type),
  );

  // session meta: only the §9.2 rewrites differ (id/session_id/timestamp/history_mode)
  const meta1 = (ir1.meta as Record<string, unknown>).codex as Record<string, unknown>;
  const meta2 = (ir2.meta as Record<string, unknown>).codex as Record<string, unknown>;
  const payload1 = { ...((meta1.sessionMetaLine as Record<string, unknown>).payload as Record<string, unknown>) };
  const payload2 = { ...((meta2.sessionMetaLine as Record<string, unknown>).payload as Record<string, unknown>) };
  delete payload1.id;
  delete payload1.session_id;
  delete payload1.timestamp;
  delete payload2.id;
  delete payload2.session_id;
  delete payload2.timestamp;
  assert.deepEqual(payload2, payload1);

  // messages deep-equal
  assert.deepEqual(ir2.messages, ir1.messages);
  // compaction bucket deep-equal
  assert.deepEqual(ir2.compaction, ir1.compaction);
  // unmapped events deep-equal (seq = line numbers, identical stream)
  assert.deepEqual(ir2.unmappedEvents, ir1.unmappedEvents);
});

test('round-trip: response_item payloads byte-faithful except the encrypted fields', () => {
  const records1 = richFixture();
  const ir1 = rolloutRecordsToIr(lines(records1), {});
  const lines2 = buildRolloutLines(
    ir1,
    '019b-new-thread',
    'D:\\proj',
    Date.parse('2026-01-12T12:55:47.732Z'),
    { targetCwd: 'D:\\proj', createdAt: Date.parse('2026-01-12T12:55:47.732Z'), threadId: '019b-new-thread', keepSynthetic: true },
  );
  const records2 = lines2.map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(records2.length, records1.length);

  for (let i = 0; i < records1.length; i++) {
    const a = records1[i];
    const b = records2[i];
    assert.equal(b.type, a.type, `record ${i} type`);
    if (a.type === 'session_meta') continue; // checked in the other test
    if (a.type === 'response_item') {
      const pa = a.payload as Record<string, unknown>;
      const pb = b.payload as Record<string, unknown>;
      assert.equal(pb.type, pa.type, `record ${i} item type`);
      // encrypted reasoning content: the only placeholder substitution
      if (pa.type === 'reasoning') {
        assert.equal(pa.encrypted_content, 'gAAAAAB-reasoning');
        assert.equal(pb.encrypted_content, ENCRYPTED_PLACEHOLDER);
        const { encrypted_content: _a, ...restA } = pa;
        const { encrypted_content: _b, ...restB } = pb;
        assert.deepEqual(restB, restA, `record ${i} reasoning minus encrypted_content`);
        continue;
      }
      // function_call: encrypted_function_args dropped entirely (legal)
      if (pa.type === 'function_call') {
        assert.equal('encrypted_function_args' in pb, false);
      }
      // agent_message: encrypted content parts become placeholders
      if (pa.type === 'agent_message') {
        const swap = JSON.parse(JSON.stringify(pa).replaceAll('gAAAAAB-am', ENCRYPTED_PLACEHOLDER));
        assert.deepEqual(pb, swap, `record ${i} agent_message minus encrypted parts`);
        continue;
      }
      // compaction / context_compaction: encrypted placeholder
      if (pa.type === 'compaction' || pa.type === 'context_compaction') {
        // 'compaction' always carries encrypted_content (placeholder); an
        // unencrypted context_compaction omits the field entirely.
        if (pa.encrypted_content != null) assert.equal(pb.encrypted_content, ENCRYPTED_PLACEHOLDER);
        else assert.equal('encrypted_content' in pb, false);
        const { encrypted_content: _a, ...restA } = pa;
        const { encrypted_content: _b, ...restB } = pb;
        assert.deepEqual(restB, restA, `record ${i} compaction minus encrypted_content`);
        continue;
      }
      assert.deepEqual(pb, pa, `record ${i} payload deep-equal`);
    } else {
      // event_msg / turn_context / world_state / compacted / iac / srs: verbatim
      assert.deepEqual(b.payload, a.payload, `record ${i} payload deep-equal`);
    }
  }
});

test('round-trip: paginated fixture preserves ordinals end-to-end', () => {
  const records1: Array<Record<string, unknown>> = [
    metaLine({ id: 'p1', session_id: 'p1', history_mode: 'paginated', cwd: 'D:\\proj', originator: 'codex_cli_rs', cli_version: '0.146.0' }, TS, 0),
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }, TS, 1),
    { timestamp: TS, ordinal: 2, type: 'turn_context', payload: { cwd: 'D:\\proj', model: 'm', approval_policy: 'never', sandbox_policy: { mode: 'read-only' }, summary: 'auto' } },
    ev('task_started', { turn_id: 't' }, TS, 3),
    item({ type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' }, TS, 4),
    item({ type: 'function_call_output', call_id: 'c1', output: 'ok' }, TS, 5),
    ev('task_complete', { turn_id: 't' }, TS, 6),
  ];
  const ir1 = rolloutRecordsToIr(records1 as never, {});
  const lines2 = buildRolloutLines(ir1, 'p1-new', 'D:\\proj', Date.parse(TS), {
    targetCwd: 'D:\\proj', createdAt: Date.parse(TS), threadId: 'p1-new', keepSynthetic: true,
  });
  const records2 = lines2.map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(
    records2.map((r) => [r.type, (r.payload as Record<string, unknown> | undefined)?.type ?? null]),
    records1.map((r) => [r.type, (r.payload as Record<string, unknown> | undefined)?.type ?? null]),
  );
  // ordinals re-emitted and order-preserving
  assert.deepEqual(records2.slice(1).map((r) => r.ordinal), [1, 2, 3, 4, 5, 6]);
  const ir2 = rolloutRecordsToIr(lines(records2), {});
  assert.deepEqual(ir2.messages, ir1.messages);
  assert.deepEqual(ir2.unmappedEvents, ir1.unmappedEvents);
});

test('round-trip: adapter write→parse keeps messages + native meta + title', async () => {
  const adapter = new CodexAdapter();
  const root = await tempRoot();
  const records = richFixture();
  const ir1 = rolloutRecordsToIr(records as never, {});
  const res = await adapter.write(ir1, { root, targetCwd: 'D:\\proj', keepSynthetic: true });
  const ir2 = await adapter.parse(res.sessionId, root);
  assert.deepEqual(ir2.messages, ir1.messages);
  assert.deepEqual(ir2.compaction, ir1.compaction);
  assert.deepEqual(ir2.unmappedEvents, ir1.unmappedEvents);
  assert.equal(ir2.cwd, 'D:\\proj');

  // list finds it with the session_index title (fallback title inferred)
  const metas = await adapter.listSessions(root);
  const found = metas.find((m) => m.sessionId === res.sessionId);
  assert.ok(found, 'written session listed');
  assert.equal(found?.sourcePath, res.paths[0]);
});

test('listSessions: archived_sessions flagged + index-only threads listed as deferredCreation', async () => {
  const adapter = new CodexAdapter();
  const root = await tempRoot();
  const ir = fallbackIr();
  ir.createdAt = Date.parse('2026-01-12T20:55:48Z');
  const res = await adapter.write(ir, { root, targetCwd: 'D:\\proj' });

  // an archived rollout under archived_sessions/
  const archId = '019b-archived-thread';
  const archDir = join(root, 'archived_sessions');
  await fs.mkdir(archDir, { recursive: true });
  const archMeta = JSON.stringify({
    timestamp: '2026-01-12T12:55:47.732Z', type: 'session_meta',
    payload: { id: archId, session_id: archId, timestamp: '2026-01-12T12:55:47.732Z', cwd: 'D:\\proj', originator: 'codex_cli_rs', cli_version: '0.146.0' },
  });
  const archMsg = JSON.stringify({
    timestamp: '2026-01-12T12:55:48.000Z', type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'archived question' }] },
  });
  await fs.writeFile(join(archDir, `rollout-2026-01-12T20-55-48-${archId}.jsonl`), `${archMeta}\n${archMsg}\n`, 'utf8');

  // a deferred-creation thread: index entry with no rollout file
  await fs.appendFile(
    join(root, 'session_index.jsonl'),
    JSON.stringify({ id: 'ghost-thread', thread_name: '幽灵会话', updated_at: new Date().toISOString() }) + '\n',
    'utf8',
  );

  const metas = await adapter.listSessions(root);
  const mine = metas.find((m) => m.sessionId === res.sessionId);
  const arch = metas.find((m) => m.sessionId === archId);
  const ghost = metas.find((m) => m.sessionId === 'ghost-thread');
  assert.ok(mine && !mine.archived && !mine.deferredCreation, 'live session unflagged');
  assert.ok(arch?.archived, 'archived_sessions flagged');
  assert.equal(arch?.deferredCreation, undefined);
  assert.ok(ghost?.deferredCreation, 'index-only thread listed as deferredCreation');
  assert.equal(ghost?.title, '幽灵会话');
  assert.equal(ghost?.sourcePath, undefined);
  // deferred sessions sort last
  assert.equal(metas[metas.length - 1].sessionId, 'ghost-thread');
});

test('round-trip: synthetic drop default vs keepSynthetic', () => {
  const ir1 = rolloutRecordsToIr(lines(richFixture()), {});
  const dropped = buildRolloutLines(ir1, 'x', 'D:\\proj', 0, { targetCwd: 'D:\\proj', createdAt: 0, threadId: 'x' });
  const droppedTypes = dropped.map((l) => JSON.parse(l).payload?.role ?? JSON.parse(l).payload?.type ?? JSON.parse(l).type);
  // developer <permissions instructions> line gone, AGENTS.md kept
  // developer <permissions instructions> line + goal steering gone, AGENTS.md kept
  const droppedPayloads = dropped.map((l) => JSON.stringify(JSON.parse(l).payload));
  assert.ok(!droppedPayloads.some((p) => p.includes('<permissions instructions>')));
  assert.ok(!droppedPayloads.some((p) => p.includes('<goal_context>')));
  assert.ok(droppedPayloads.some((p) => p.includes('# AGENTS.md instructions')));
  void droppedTypes;

  const kept = buildRolloutLines(ir1, 'y', 'D:\\proj', 0, { targetCwd: 'D:\\proj', createdAt: 0, threadId: 'y', keepSynthetic: true });
  const keptPayloads = kept.map((l) => JSON.stringify(JSON.parse(l).payload));
  assert.ok(keptPayloads.some((p) => p.includes('<permissions instructions>')));
});

test('round-trip: turn_context/world_state rows re-emit ahead of their turn message', () => {
  const records1 = richFixture().map((l) => l as never);
  const ir1 = rolloutRecordsToIr(records1 as never, {});
  const lines2 = buildRolloutLines(ir1, 'z', 'D:\\proj', Date.parse(TS), {
    targetCwd: 'D:\\proj', createdAt: Date.parse(TS), threadId: 'z', keepSynthetic: true,
  });
  const types = lines2.map((l) => JSON.parse(l).type);
  const userMsgIdx = lines2.findIndex((l) => {
    const r = JSON.parse(l);
    return r.type === 'response_item' && r.payload?.id === 'msg_2';
  });
  assert.equal(types[userMsgIdx - 1], 'turn_context');
  assert.equal(types[userMsgIdx - 2], 'world_state');
});

test('write: buildSessionMetaPayload keeps native git/source and rewrites id/cwd/timestamp', () => {
  const ir = rolloutRecordsToIr(lines(richFixture()), {});
  const payload = buildSessionMetaPayload(ir, 'fresh-id', 'E:\\new\\cwd', 1234567, { targetCwd: 'E:\\new\\cwd', createdAt: 1234567, threadId: 'fresh-id' });
  assert.equal(payload.id, 'fresh-id');
  assert.equal(payload.session_id, 'fresh-id');
  assert.equal(payload.cwd, 'E:\\new\\cwd');
  assert.equal(payload.timestamp, rolloutTimestamp(1234567));
  assert.equal(payload.history_mode, 'legacy');
  assert.deepEqual(payload.git, { branch: 'main', commit_hash: 'abc', repository_url: 'https://example.com/x' });
  assert.equal(payload.originator, 'codex_cli_rs');
  assert.equal(payload.cli_version, '0.146.0');
  assert.equal(payload.model_provider, 'openai');
  assert.deepEqual(payload.base_instructions, { text: 'You are Codex.', provenance: { type: 'model', model: 'gpt-5' } });
  // source option: fill from ir.systemPrompt when native lacks it
  const ir2 = { ...ir, meta: { codex: { sessionMetaLine: { ts: TS, payload: { id: 'a', session_id: 'a', cli_version: '1', source: 'cli' } } } } } as MigratedSession;
  ir2.systemPrompt = 'carried prompt';
  const p2 = buildSessionMetaPayload(ir2, 'b', 'C:\\w', 0, { targetCwd: 'C:\\w', createdAt: 0, threadId: 'b' });
  assert.deepEqual(p2.base_instructions, { text: 'carried prompt', provenance: { type: 'custom' } });
});

/* ------------------------------------------------------------------ */
/* adapter surface                                                     */
/* ------------------------------------------------------------------ */

test('adapter: parse error for unknown id; validateSession runs on write', async () => {
  const adapter = new CodexAdapter();
  const root = await tempRoot();
  await assert.rejects(adapter.parse('does-not-exist', root), /not found/);
  await assert.rejects(
    adapter.write({ schemaVersion: 2, originTool: 'codex', messages: [{ role: 'bogus' as never, content: [] }] } as MigratedSession, { root }),
    /malformed/,
  );
});
