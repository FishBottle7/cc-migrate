import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiAdapter, parsePiFile } from '../src/adapters/pi/index.js';
import { fallbackIr } from '../src/demo.js';
import type { MigratedSession } from '../src/ir.js';

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'sm-pi-test-'));
}

test('Pi write -> parse round-trip preserves messages and sidechains', async () => {
  const adapter = new PiAdapter();
  const root = await tempRoot();
  const ir = {
    ...fallbackIr(),
    cwd: '/tmp/proj',
    sidechains: [
      {
        agentId: 'side-1',
        kind: 'subagent' as const,
        agentType: 'explore',
        messages: [
          { role: 'user' as const, content: [{ type: 'text' as const, text: 'sub task' }] },
          { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'sub done' }] },
        ],
      },
    ],
  };
  const res = await adapter.write(ir, { root, targetCwd: '/tmp/proj' });
  assert.ok(res.paths[0].endsWith('.jsonl'));
  // hasAssistant guard: must contain assistant
  const raw = await fs.readFile(res.paths[0], 'utf8');
  assert.ok(raw.includes('"role":"assistant"'));

  const back = await adapter.parse(res.sessionId, root);
  assert.equal(back.originTool, 'pi');
  assert.ok(back.messages.length >= ir.messages.length);
  assert.ok((back.sidechains?.length ?? 0) >= 1);
});

test('parsePiFile tolerates minimal header', async () => {
  const root = await tempRoot();
  const dir = join(root, '--tmp-proj--');
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, '2024-12-03T14-00-00-000Z_testid1234.jsonl');
  await fs.writeFile(
    path,
    JSON.stringify({ type: 'session', version: 3, id: 'testid1234', timestamp: '2024-12-03T14:00:00.000Z', cwd: '/tmp/proj' }) + '\n' +
    JSON.stringify({ type: 'message', id: 'aaaaaaaa', parentId: null, timestamp: '2024-12-03T14:00:01.000Z', message: { role: 'user', content: 'hi', timestamp: 1733270000000 } }) + '\n' +
    JSON.stringify({ type: 'message', id: 'bbbbbbbb', parentId: 'aaaaaaaa', timestamp: '2024-12-03T14:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }], provider: 'anthropic', model: 'claude', timestamp: 1733270000001 } }) + '\n',
    'utf8',
  );
  const ir = await parsePiFile(path);
  assert.equal(ir.originTool, 'pi');
  assert.equal(ir.messages.length, 2);
});

import { DshAdapter } from '../src/adapters/dsh/index.js';
import { decompressSessionBuffer } from '../src/adapters/dsh/format.js';
import { verifySessionLog } from '../src/adapters/dsh/verify.js';

test('pi toolCall/toolResult fold into tool_use/tool_result blocks; pi->dsh renders a paired tool stream', async () => {
  const root = await tempRoot();
  const dir = join(root, '--tmp-proj--');
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, '2024-12-03T14-00-00-000Z_piid1234.jsonl');
  await fs.writeFile(
    path,
    [
      JSON.stringify({ type: 'session', version: 3, id: 'piid1234', timestamp: '2024-12-03T14:00:00.000Z', cwd: '/tmp/proj' }),
      JSON.stringify({ type: 'message', id: 'aaaaaaaa', parentId: null, timestamp: '2024-12-03T14:00:01.000Z', message: { role: 'user', content: 'list', timestamp: 1733270000000 } }),
      JSON.stringify({ type: 'message', id: 'bbbbbbbb', parentId: 'aaaaaaaa', timestamp: '2024-12-03T14:00:02.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: { cmd: 'ls' } }], provider: 'anthropic', model: 'claude', timestamp: 1733270000001 } }),
      JSON.stringify({ type: 'message', id: 'cccccccc', parentId: 'bbbbbbbb', timestamp: '2024-12-03T14:00:03.000Z', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'out' }], isError: false, timestamp: 1733270000002 } }),
    ].join('\n') + '\n',
    'utf8',
  );
  const ir = await parsePiFile(path);
  const asst = ir.messages.find((m) => m.role === 'assistant')!;
  assert.deepEqual(asst.content[0], { type: 'tool_use', id: 'call_1', name: 'bash', input: { cmd: 'ls' } }, 'toolCall block folds to tool_use');
  const toolMsg = ir.messages.find((m) => m.role === 'tool')!;
  const tr = toolMsg.content[0] as { type: string; toolUseId: string; content: string; isError: boolean };
  assert.equal(tr.type, 'tool_result');
  assert.equal(tr.toolUseId, 'call_1', 'message-level toolCallId restored onto the block');
  assert.equal(tr.content, 'out');
  assert.equal(tr.isError, false);
  assert.equal((toolMsg.meta as { pi?: { toolName?: string } } | undefined)?.pi?.toolName, 'bash');

  // pi -> dsh E2E: the paired call+result stream, verifier clean (no ghost cards)
  const dsh = new DshAdapter();
  const droot = await tempRoot();
  const res = await dsh.write(ir, { root: droot, sessionId: 'pi2dsh-1', targetCwd: 'D:\\proj' });
  const rows = decompressSessionBuffer(await fs.readFile(res.paths[0]!)).split('\n').filter((l) => l.trim()).slice(1).map((l) => JSON.parse(l)) as Array<{ type: string; data: Record<string, unknown> }>;
  const calls = rows.filter((e) => e.type === 'tool/call');
  assert.equal(calls.length, 1);
  assert.equal((calls[0].data as Record<string, unknown>).callId, 'call_1');
  assert.equal((calls[0].data as Record<string, unknown>).name, 'bash');
  assert.equal(rows.filter((e) => e.type === 'tool/result').length, 1);
  const verdict = verifySessionLog(decompressSessionBuffer(await fs.readFile(res.paths[0]!)), 'pi2dsh-1', res.paths[0]!);
  assert.ok(verdict.ok, `verifySessionLog passes: ${JSON.stringify(verdict.issues ?? []).slice(0, 200)}`);

  // pi -> pi round trip: toolResult row restored with toolCallId + toolName
  const pi = new PiAdapter();
  const proot = await tempRoot();
  const back = await pi.write(ir, { root: proot, targetCwd: '/tmp/proj' });
  const reparsed = await pi.parse(back.sessionId, proot);
  const toolBack = reparsed.messages.find((m) => m.role === 'tool')!;
  const trBack = toolBack.content[0] as { toolUseId: string };
  assert.equal(trBack.toolUseId, 'call_1', 'pi write-back keeps the pairing id');
});

/* ------------------------------------------------------------------ *
 * v3.3 rewrite scenarios (docs/agents/pi.md §13 checklist)
 * ------------------------------------------------------------------ */

/** A full-fat pi fixture exercising every v3 entry type on the leaf path. */
function fullPiFixtureLines(): string[] {
  const H = (type: string, id: string, parentId: string | null, extra: Record<string, unknown>): string =>
    JSON.stringify({ type, id, parentId, timestamp: `2024-12-03T14:00:${10 + Number(id.charCodeAt(0) % 40)}.000Z`, ...extra });
  return [
    JSON.stringify({ type: 'session', version: 3, id: 'fixt0001-0000-7000-8000-000000000001', timestamp: '2024-12-03T14:00:00.000Z', cwd: '/tmp/proj', parentSession: '/elsewhere/src.jsonl' }),
    H('message', 'aaaaaaaa', null, { message: { role: 'user', content: 'early work', timestamp: 1733229600000 } }),
    H('message', 'bbbbbbbb', 'aaaaaaaa', { message: { role: 'assistant', content: [{ type: 'text', text: 'folded old answer' }], provider: 'anthropic', model: 'claude', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', api: 'anthropic', timestamp: 1733229601000 } }),
    // compaction cuts the folded span: firstKeptEntryId points at cccccccc
    H('compaction', 'cccccccc', 'bbbbbbbb', { summary: 'sum of early work', firstKeptEntryId: 'cccccccc', tokensBefore: 1200, details: { k: 1 }, usage: { input: 40, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 60, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
    H('message', 'dddddddd', 'cccccccc', { message: { role: 'user', content: 'keep me', timestamp: 1733229602000 } }),
    H('message', 'eeeeeeee', 'dddddddd', { message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call_9', name: 'bash', arguments: { cmd: 'ls' } }], provider: 'anthropic', model: 'claude', timestamp: 1733229603000 } }),
    H('message', 'ffffffff', 'eeeeeeee', { message: { role: 'toolResult', toolCallId: 'call_9', toolName: 'bash', content: [{ type: 'text', text: 'files' }], isError: false, addedToolNames: ['extra'], timestamp: 1733229604000 } }),
    H('message', '99999999', 'ffffffff', { message: { role: 'bashExecution', command: 'npm test', output: 'ok', exitCode: 0, cancelled: false, truncated: false, timestamp: 1733229605000 } }),
    H('custom_message', '88888888', '99999999', { customType: 'ext-x', content: 'injected context line', display: false, details: { who: 'ext' } }),
    H('message', '77777777', '88888888', { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'after compaction' }], provider: 'anthropic', model: 'claude-3', responseModel: 'claude-3-real', responseId: 'resp_1', deferred: { provider: 'p', modelId: 'm', api: 'a', id: 'd1' }, endTurn: true, stopReason: 'stop', usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } }, timestamp: 1733229606000 } }),
    H('model_change', '66666666', '77777777', { provider: 'openai', modelId: 'gpt-5' }),
    H('thinking_level_change', '55555555', '66666666', { thinkingLevel: 'high' }),
    H('label', '44444444', '55555555', { targetId: '77777777', label: 'checkpoint' }),
    H('custom', '33333333', '44444444', { customType: 'state-keeper', data: { v: 2 } }),
    H('session_info', '22222222', '33333333', { name: 'My Fixture Session' }),
    H('branch_summary', '11111111', '22222222', { fromId: 'root', summary: 'explored branch A', details: { d: 1 } }),
    // sibling branch (off leaf path): forked from bbbbbbbb — appended BEFORE
    // the final tail message, so the LAST ENTRY stays on the main chain (pi
    // semantics: leafId = last appended entry; the active path follows it)
    H('message', '1a1a1a1a', 'bbbbbbbb', { message: { role: 'user', content: 'sibling try', timestamp: 1733229601500 } }),
    H('message', '1b1b1b1b', '1a1a1a1a', { message: { role: 'assistant', content: [{ type: 'text', text: 'sibling answer' }], provider: 'anthropic', model: 'claude', timestamp: 1733229601600 } }),
    // malformed line (tolerated, skipped like pi's loader)
    '{not json',
    // trailing empty-name session_info = explicit title clear (dead branch — off path)
    H('session_info', '1c1c1c1c', '1b1b1b1b', { name: '' }),
    H('message', '0a0a0a0a', '11111111', { message: { role: 'user', content: 'tail', timestamp: 1733229607000 } }),
  ];
}

async function writeFixture(root: string, name = '2024-12-03T14-00-00-000Z_fixtur100.jsonl'): Promise<string> {
  const dir = join(root, '--tmp-proj--');
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await fs.writeFile(path, fullPiFixtureLines().join('\n') + '\n', 'utf8');
  return path;
}

test('v3.3 read: all ten entry types project into the IR (zero drop)', async () => {
  const root = await tempRoot();
  const path = await writeFixture(root);
  const ir = await parsePiFile(path);

  // header → meta.pi.header (incl. parentSession), title from session_info
  const pim = ir.meta as { pi: Record<string, unknown> };
  const header = pim.pi.header as Record<string, unknown>;
  assert.equal(header.parentSession, '/elsewhere/src.jsonl');
  assert.equal(ir.title, 'My Fixture Session');
  assert.equal(ir.model?.id, 'gpt-5', 'last model_change wins the derived state');
  assert.equal(ir.model?.provider, 'openai');
  assert.equal(ir.thinkingLevel, 'high');

  // settings sequence: model_change + thinking_level_change (+ session_info rows)
  const events = pim.pi.settingsEvents as Array<Record<string, unknown>>;
  assert.ok(events.some((e) => e.type === 'model_change' && e.modelId === 'gpt-5'));
  assert.ok(events.some((e) => e.type === 'thinking_level_change' && e.thinkingLevel === 'high'));

  // labels + custom entries
  const labels = pim.pi.labels as Array<{ targetId: string; label?: string; time: number }>;
  assert.equal(labels.length, 1);
  assert.equal(labels[0]!.targetId, '77777777');
  assert.equal(labels[0]!.label, 'checkpoint');
  const customs = pim.pi.customEntries as Array<{ customType: string }>;
  assert.equal(customs[0]?.customType, 'state-keeper');

  // compaction bucket: summary + firstKeptId + anchor message in messages[]
  assert.equal(ir.compaction?.length, 1);
  const comp = ir.compaction![0]!;
  assert.equal(comp.summary, 'sum of early work');
  assert.equal(comp.tokensBefore, 1200);
  assert.equal(comp.firstKeptId, 'cccccccc');
  const compAnchor = ir.messages[comp.anchorIndex!]!;
  assert.equal(compAnchor.role, 'user');
  assert.equal(compAnchor.synthetic, true);
  assert.ok((compAnchor.content[0] as { text: string }).text.includes('The conversation history before this point was compacted'));
  assert.equal((compAnchor.meta as { pi: { anchor: { kind: string; entryId: string } } }).pi.anchor.entryId, 'cccccccc');

  // branchSummaries bucket with v3.3 extended shape
  assert.equal(ir.branchSummaries?.length, 1);
  const bs = ir.branchSummaries![0]!;
  assert.equal(bs.fromId, 'root');
  assert.equal(bs.summary, 'explored branch A');
  assert.equal(typeof bs.anchorIndex, 'number');
  assert.equal(typeof bs.time, 'number');
  const bsAnchor = ir.messages[bs.anchorIndex!]!;
  assert.ok((bsAnchor.content[0] as { text: string }).text.includes('The following is a summary of a branch'));
  assert.equal((bsAnchor.meta as { pi: { anchor: { kind: string } } }).pi.anchor.kind, 'branch_summary');

  // seven message roles all project
  const roles = ir.messages.map((m) => m.role);
  assert.ok(roles.includes('user') && roles.includes('assistant') && roles.includes('tool'));
  // bashExecution → user row + meta.pi.bash + synthetic
  const bashMsg = ir.messages.find((m) => (m.meta as { pi?: { bash?: { command?: string } } } | undefined)?.pi?.bash?.command === 'npm test');
  assert.ok(bashMsg, 'bashExecution projects as a user row');
  assert.equal(bashMsg!.role, 'user');
  assert.equal(bashMsg!.synthetic, true);
  assert.ok((bashMsg!.content[0] as { text: string }).text.includes('Ran `npm test`'), 'renders with pi native bashExecutionToText');
  // custom_message entry → user row + meta.pi.customMessage
  const cmMsg = ir.messages.find((m) => (m.meta as { pi?: { customMessage?: { customType?: string } } } | undefined)?.pi?.customMessage?.customType === 'ext-x');
  assert.ok(cmMsg, 'custom_message projects');
  assert.equal(cmMsg!.role, 'user');
  assert.equal(cmMsg!.synthetic, true);
  // toolResult addedToolNames (v3.3 #12)
  const toolMsg = ir.messages.find((m) => m.role === 'tool')!;
  assert.deepEqual((toolMsg.meta as { pi: { addedToolNames?: string[] } }).pi.addedToolNames, ['extra']);
  // assistant field-level meta (v3.3 #8): responseModel/deferred/endTurn/usage ride meta.pi.message
  const asst = ir.messages.find((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'text' && b.text === 'after compaction'))!;
  const asstNative = (asst.meta as { pi: { message: Record<string, unknown> } }).pi.message;
  assert.equal(asstNative.responseModel, 'claude-3-real');
  assert.equal((asstNative.deferred as { id: string }).id, 'd1');
  assert.equal(asstNative.endTurn, true);
  assert.ok(asstNative.usage, 'usage preserved');
  assert.ok(!('stopReason' in asstNative), 'stopReason already maps to the IR field');

  // sibling branch → sidechain (leaf = LAST ENTRY, tail message is on path)
  assert.ok((ir.sidechains?.length ?? 0) >= 1, 'sibling branch groups into a sidechain');
  const sc = ir.sidechains![0]!;
  assert.equal(sc.agentId, 'pi-1a1a1a1a');
  assert.equal(sc.messages.length, 2, 'sibling user+assistant both kept');
  // the dead-branch session_info clear (1c) rides the sidechain meta
  const scMeta = sc.meta as { pi: { labels?: unknown[] } } | undefined;
  assert.ok(scMeta, 'sidechain carries its branch-level meta');

  // systemPrompt stays empty (pi stores no prompt text)
  assert.ok(!ir.systemPrompt);
});

test('v3.3 read: leaf = LAST ENTRY, not last message (label/compaction tail shifts the path)', async () => {
  const root = await tempRoot();
  const dir = join(root, '--tmp-proj--');
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, '2024-12-03T14-00-00-000Z_leafy0000.jsonl');
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 'leafy0000', timestamp: '2024-12-03T14:00:00.000Z', cwd: '/tmp/proj' }),
    JSON.stringify({ type: 'message', id: 'aaaaaaaa', parentId: null, timestamp: '2024-12-03T14:00:01.000Z', message: { role: 'user', content: 'main', timestamp: 1 } }),
    JSON.stringify({ type: 'message', id: 'bbbbbbbb', parentId: 'aaaaaaaa', timestamp: '2024-12-03T14:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'main reply' }], timestamp: 2 } }),
    // sibling off-path message: branches from aaaaaaaa
    JSON.stringify({ type: 'message', id: 'c1c1c1c1', parentId: 'aaaaaaaa', timestamp: '2024-12-03T14:00:03.000Z', message: { role: 'user', content: 'sibling', timestamp: 3 } }),
    // LEAF = a non-message entry (label) appended after the last message: the
    // last message in the file is the sibling c1c1c1c1 — a "last message" walk
    // would wrongly pick the sibling branch as the main chain.
    JSON.stringify({ type: 'label', id: 'dddddddd', parentId: 'bbbbbbbb', timestamp: '2024-12-03T14:00:04.000Z', targetId: 'bbbbbbbb', label: 'L' }),
  ].join('\n') + '\n';
  await fs.writeFile(path, lines, 'utf8');
  const ir = await parsePiFile(path);
  const texts = ir.messages.map((m) => (m.content[0] as { text?: string } | undefined)?.text ?? '');
  assert.ok(texts.includes('main') && texts.includes('main reply'), 'main chain = bbbbbbbb path (last ENTRY walk)');
  assert.ok(!texts.includes('sibling') || (ir.sidechains?.length ?? 0) === 1, 'sibling stays a sidechain');
  if (ir.sidechains?.length) {
    const sc = ir.sidechains[0]!;
    const scTexts = sc.messages.map((m) => (m.content[0] as { text?: string } | undefined)?.text ?? '');
    assert.ok(scTexts.includes('sibling'), 'sibling message lives in the sidechain');
  }
});

test('v3.3 read: v4 harness file (kind:header) is refused explicitly, not silently', async () => {
  const root = await tempRoot();
  const dir = join(root, '--tmp-proj--');
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, '2024-12-03T14-00-00-000Z_v4format00.jsonl');
  await fs.writeFile(
    path,
    JSON.stringify({ kind: 'header', version: 4, id: 'v4', createdAt: 1733229600000, cwd: '/tmp/proj' }) + '\n',
    'utf8',
  );
  await assert.rejects(() => parsePiFile(path), /v4 harness session format.*not supported|not supported yet/i);
});

test('v3.3 round-trip: write consumes buckets/labels/title/settings and skips anchor messages', async () => {
  const adapter = new PiAdapter();
  const root = await tempRoot();
  const path = await writeFixture(root);
  const ir = await parsePiFile(path);

  const res = await adapter.write(ir, { root: join(root, 'out'), targetCwd: '/tmp/proj' });
  const back = await parsePiFile(res.paths[0]!);

  // title / model / thinkingLevel derived state survives
  assert.equal(back.title, 'My Fixture Session');
  assert.equal(back.model?.id, 'gpt-5');
  assert.equal(back.thinkingLevel, 'high');

  // compaction + branch_summary entries restored as NATIVE entries (bucket
  // consumed, anchor message skipped → exactly one summary each, no double)
  const backComp = back.compaction!;
  assert.equal(backComp.length, 1);
  const nativeCompText = await fs.readFile(res.paths[0]!, 'utf8');
  const compEntries = nativeCompText.split('\n').filter((l) => l.includes('"type":"compaction"')).map((l) => JSON.parse(l));
  assert.equal(compEntries.length, 1, 'compaction entry written once (anchor skipped)');
  const compEntry = compEntries[0] as { summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown; usage: unknown };
  assert.equal(compEntry.summary, 'sum of early work', 'summary field carries the PURE summary (rendering is a runtime concern)');
  assert.equal(compEntry.tokensBefore, 1200);
  assert.equal((compEntry.details as { k: number }).k, 1, 'details remnant round-trips');
  assert.ok(compEntry.usage, 'usage remnant round-trips');
  const idsInFile = new Set(
    nativeCompText.split('\n').map((l) => { try { return (JSON.parse(l) as { id?: string }).id; } catch { return undefined; } }).filter(Boolean) as string[],
  );
  assert.ok(idsInFile.has(compEntry.firstKeptEntryId), 'firstKeptEntryId points at an entry id that EXISTS in the file (no dangling pointer)');

  const bsEntries = nativeCompText.split('\n').filter((l) => l.includes('"type":"branch_summary"')).map((l) => JSON.parse(l));
  const fixtureBs = bsEntries.find((e) => (e as { summary?: string }).summary === 'explored branch A') as { fromId: string; summary: string } | undefined;
  assert.ok(fixtureBs, 'branch_summary entry restored from the bucket');
  assert.equal(fixtureBs!.fromId, 'root');

  // anchor messages did not double: the rendered compaction text appears once
  const renderedCompCount = back.messages.filter((m) =>
    m.content.some((b) => b.type === 'text' && b.text.includes('The conversation history before this point was compacted'))).length;
  assert.equal(renderedCompCount, 1, 'exactly one compaction anchor message after round-trip');

  // labels / custom entries / bashExecution / custom_message survive
  const backPim = (back.meta as { pi: Record<string, unknown> }).pi;
  assert.equal((backPim.customEntries as Array<{ customType: string }>)[0]?.customType, 'state-keeper');
  const backBash = back.messages.find((m) => (m.meta as { pi?: { bash?: { command?: string } } } | undefined)?.pi?.bash?.command === 'npm test');
  assert.ok(backBash, 'bashExecution round-trips through meta.pi.bash');
  const backCm = back.messages.find((m) => (m.meta as { pi?: { customMessage?: { customType?: string } } } | undefined)?.pi?.customMessage?.customType === 'ext-x');
  assert.ok(backCm, 'custom_message round-trips');

  // settingsEvents replay: sequence restored in order
  const backEvents = backPim.settingsEvents as Array<Record<string, unknown>>;
  const mcIdx = backEvents.findIndex((e) => e.type === 'model_change');
  const tlcIdx = backEvents.findIndex((e) => e.type === 'thinking_level_change');
  assert.ok(mcIdx >= 0 && tlcIdx >= 0 && tlcIdx > mcIdx, 'settings events replay in sequence');

  // sidechain branch survives with its messages
  assert.ok((back.sidechains?.length ?? 0) >= 1, 'sibling branch preserved');
});

test('v3.3 cross-tool: pi (compaction/branch_summary/bashExecution) -> dsh verify stays clean', async () => {
  const root = await tempRoot();
  const path = await writeFixture(root, '2024-12-03T14-00-00-000Z_e2efixtu.jsonl');
  const ir = await parsePiFile(path);
  const dsh = new DshAdapter();
  const droot = await tempRoot();
  const res = await dsh.write(ir, { root: droot, sessionId: 'pi-e2e-v33', targetCwd: 'D:\\proj' });
  const verdict = verifySessionLog(decompressSessionBuffer(await fs.readFile(res.paths[0]!)), 'pi-e2e-v33', res.paths[0]!);
  assert.ok(verdict.ok, `verifySessionLog passes: ${JSON.stringify(verdict.issues ?? []).slice(0, 300)}`);
  // the anchor messages must have flown into the dsh log as ordinary user rows
  const rows = decompressSessionBuffer(await fs.readFile(res.paths[0]!)).split('\n').filter((l) => l.trim()).slice(1).map((l) => JSON.parse(l) as { type: string; data: unknown });
  const userTexts = rows.filter((r) => r.type === 'user/message').map((r) => JSON.stringify(r.data));
  assert.ok(userTexts.some((t) => t.includes('The conversation history before this point was compacted')), 'compaction anchor text flows to dsh');
  assert.ok(userTexts.some((t) => t.includes('The following is a summary of a branch')), 'branch_summary anchor text flows to dsh');
  assert.ok(userTexts.some((t) => t.includes('Ran \`npm test\`')), 'bashExecution text flows to dsh as a user row');
});

test('v3.3 write: systemPrompt is never injected into the pi session file', async () => {
  const adapter = new PiAdapter();
  const root = await tempRoot();
  const ir: MigratedSession = {
    ...fallbackIr(),
    systemPrompt: 'SOURCE PROMPT BODY — must not appear in the pi file',
  };
  const res = await adapter.write(ir, { root, targetCwd: '/tmp/proj' });
  const raw = await fs.readFile(res.paths[0]!, 'utf8');
  assert.ok(!raw.includes('SOURCE PROMPT BODY'), 'pi write side ignores ir.systemPrompt (double-stack ban)');
});

test('v3.3 write: wx exclusive create refuses to overwrite an existing file', async () => {
  const adapter = new PiAdapter();
  const root = await tempRoot();
  const ir = { ...fallbackIr(), cwd: '/tmp/proj' };
  const first = await adapter.write(ir, { root, targetCwd: '/tmp/proj', sessionId: 'same-uuid-1' });
  // second write with the SAME sessionId + same createdAt-derived filename must
  // refuse rather than overwrite (append-only discipline on our own output too)
  await assert.rejects(
    () => adapter.write({ ...fallbackIr(), createdAt: ir.createdAt }, { root, targetCwd: '/tmp/proj', sessionId: 'same-uuid-1' }),
    /EEXIST|file already exists/i,
  );
  assert.ok(first.paths[0]!.endsWith('.jsonl'));
});

test('v3.3 read: session_info empty name is an explicit title clear', async () => {
  const root = await tempRoot();
  const dir = join(root, '--tmp-proj--');
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, '2024-12-03T14-00-00-000Z_cleartitl.jsonl');
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 'cleartitl', timestamp: '2024-12-03T14:00:00.000Z', cwd: '/tmp/proj' }),
    JSON.stringify({ type: 'message', id: 'aaaaaaaa', parentId: null, timestamp: '2024-12-03T14:00:01.000Z', message: { role: 'user', content: 'hi', timestamp: 1 } }),
    JSON.stringify({ type: 'message', id: 'bbbbbbbb', parentId: 'aaaaaaaa', timestamp: '2024-12-03T14:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'yo' }], timestamp: 2 } }),
    JSON.stringify({ type: 'session_info', id: 'cccccccc', parentId: 'bbbbbbbb', timestamp: '2024-12-03T14:00:03.000Z', name: 'Named' }),
    JSON.stringify({ type: 'session_info', id: 'dddddddd', parentId: 'cccccccc', timestamp: '2024-12-03T14:00:04.000Z', name: '' }),
  ].join('\n') + '\n';
  await fs.writeFile(path, lines, 'utf8');
  const ir = await parsePiFile(path);
  assert.ok(!ir.title, 'latest empty session_info clears the title');
  assert.equal((ir.meta as { pi: { titleCleared?: boolean } }).pi.titleCleared, true, 'clear semantics recorded');
});

test('v1/v2 legacy files are refused explicitly (development policy: current format only)', async () => {
  const root = await tempRoot();
  const dir = join(root, '--tmp-proj--');
  await fs.mkdir(dir, { recursive: true });
  // v1: header has NO version field; entries carry no id/parentId
  const v1Path = join(dir, '2024-12-03T14-00-00-000Z_legacyv100.jsonl');
  const v1Lines = [
    JSON.stringify({ type: 'session', id: 'legacyv100', timestamp: '2024-12-03T14:00:00.000Z', cwd: '/tmp/proj' }),
    JSON.stringify({ type: 'message', timestamp: '2024-12-03T14:00:01.000Z', message: { role: 'user', content: 'v1 question', timestamp: 1 } }),
    JSON.stringify({ type: 'message', timestamp: '2024-12-03T14:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'v1 answer' }], timestamp: 2 } }),
  ].join('\n') + '\n';
  await fs.writeFile(v1Path, v1Lines, 'utf8');
  await assert.rejects(
    () => parsePiFile(v1Path),
    /legacy v1 session file.*not supported.*migrate it in place/s,
    'v1 (no version field) is refused with a migration hint, never half-parsed',
  );
  // v2: header version 2 (hookMessage era)
  const v2Path = join(dir, '2024-12-03T14-00-00-000Z_legacyv200.jsonl');
  const v2Lines = [
    JSON.stringify({ type: 'session', version: 2, id: 'legacyv200', timestamp: '2024-12-03T14:00:00.000Z', cwd: '/tmp/proj' }),
    JSON.stringify({ type: 'message', id: 'aaaaaaaa', parentId: null, timestamp: '2024-12-03T14:00:01.000Z', message: { role: 'hookMessage', customType: 'old-hook', content: 'hook payload', timestamp: 1 } }),
  ].join('\n') + '\n';
  await fs.writeFile(v2Path, v2Lines, 'utf8');
  await assert.rejects(
    () => parsePiFile(v2Path),
    /legacy v2 session file.*not supported/s,
    'v2 is refused the same way',
  );
  // both source files stay untouched (no in-place migration by us, ever)
  const v1Raw = await fs.readFile(v1Path, 'utf8');
  assert.ok(v1Raw.includes('"type":"session"') && !v1Raw.includes('"version"'), 'v1 source untouched');
  const v2Raw = await fs.readFile(v2Path, 'utf8');
  assert.ok(v2Raw.includes('"version":2'), 'v2 source untouched');
});

test('stray summary-role message rows survive pi→pi round-trip (no bucket twin, no anchor skip)', async () => {
  const root = await tempRoot();
  const dir = join(root, '--tmp-proj--');
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, '2024-12-03T14-00-00-000Z_stray0000.jsonl');
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 'stray0000', timestamp: '2024-12-03T14:00:00.000Z', cwd: '/tmp/proj' }),
    // hand-edited / extension-written raw message row carrying a summary role
    // — NOT an entry twin, so it must NOT get the anchor marker (an anchor
    // marker would make write-back skip it with no bucket entry to restore it)
    JSON.stringify({ type: 'message', id: 'aaaaaaaa', parentId: null, timestamp: '2024-12-03T14:00:01.000Z', message: { role: 'compactionSummary', summary: 'stray inline fold', tokensBefore: 12, timestamp: 1 } }),
    JSON.stringify({ type: 'message', id: 'bbbbbbbb', parentId: 'aaaaaaaa', timestamp: '2024-12-03T14:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: 2 } }),
  ].join('\n') + '\n';
  await fs.writeFile(path, lines, 'utf8');
  const adapter = new PiAdapter();
  const ir = await parsePiFile(path);
  const stray = ir.messages.find((m) => m.content.some((b) => b.type === 'text' && b.text.includes('stray inline fold')));
  assert.ok(stray, 'stray summary row projected as a user row');
  assert.ok(!(stray!.meta as { pi?: { anchor?: unknown } }).pi?.anchor, 'no anchor marker — nothing in the bucket is paired with it');
  const res = await adapter.write(ir, { root: join(root, 'out'), targetCwd: '/tmp/proj' });
  const back = await parsePiFile(res.paths[0]!);
  const backStray = back.messages.find((m) => m.content.some((b) => b.type === 'text' && b.text.includes('stray inline fold')));
  assert.ok(backStray, 'stray summary row SURVIVES the round-trip (no silent drop)');
});

test('multi-root / orphan entries: dangling parentId never crashes, orphans archive as sidechains', async () => {
  const root = await tempRoot();
  const dir = join(root, '--tmp-proj--');
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, '2024-12-03T14-00-00-000Z_orphan000.jsonl');
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 'orphan000', timestamp: '2024-12-03T14:00:00.000Z', cwd: '/tmp/proj' }),
    JSON.stringify({ type: 'message', id: 'aaaaaaaa', parentId: null, timestamp: '2024-12-03T14:00:01.000Z', message: { role: 'user', content: 'main', timestamp: 1 } }),
    JSON.stringify({ type: 'message', id: 'bbbbbbbb', parentId: 'aaaaaaaa', timestamp: '2024-12-03T14:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'main reply' }], timestamp: 2 } }),
    // resetLeaf-style second root (parentId:null mid-file) + a dangling-parent
    // orphan — both are legal tree shapes (pi.md §4 multi-root)
    JSON.stringify({ type: 'message', id: 'c1c1c1c1', parentId: null, timestamp: '2024-12-03T14:00:03.000Z', message: { role: 'user', content: 'second root', timestamp: 3 } }),
    JSON.stringify({ type: 'message', id: 'd1d1d1d1', parentId: 'ghost000', timestamp: '2024-12-03T14:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'orphan reply' }], timestamp: 4 } }),
  ].join('\n') + '\n';
  await fs.writeFile(path, lines, 'utf8');
  const ir = await parsePiFile(path);
  // pi semantics (buildSessionPath, sm.ts:340): the leaf is the LAST entry —
  // here the dangling orphan d1d1d1d1 — and its broken walk yields a
  // one-entry "main chain". The REAL original chain (aaaaaaaa→bbbbbbbb) and
  // the second root both land off-path, archived as sidechains. Zero drop,
  // no crash, faithful to what pi's own resume would see.
  const allTexts = [
    ...ir.messages.map((m) => (m.content[0] as { text?: string } | undefined)?.text ?? ''),
    ...(ir.sidechains ?? []).flatMap((sc) => sc.messages.map((m) => (m.content[0] as { text?: string } | undefined)?.text ?? '')),
  ];
  assert.ok(allTexts.includes('main') && allTexts.includes('main reply') && allTexts.includes('second root') && allTexts.includes('orphan reply'),
    'every message survives somewhere (main chain or sidechain archive) — zero drop, no crash');
  assert.ok(ir.messages.length >= 1, 'the leaf walk produced a (degenerate) main chain instead of throwing');
});

test('round-trip symmetry: session_info sequence replays without duplicate final rows', async () => {
  const adapter = new PiAdapter();
  const root = await tempRoot();
  const dir = join(root, '--tmp-proj--');
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, '2024-12-03T14-00-00-000Z_seqinfo00.jsonl');
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 'seqinfo00', timestamp: '2024-12-03T14:00:00.000Z', cwd: '/tmp/proj' }),
    JSON.stringify({ type: 'message', id: 'aaaaaaaa', parentId: null, timestamp: '2024-12-03T14:00:01.000Z', message: { role: 'user', content: 'hi', timestamp: 1 } }),
    JSON.stringify({ type: 'message', id: 'bbbbbbbb', parentId: 'aaaaaaaa', timestamp: '2024-12-03T14:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'yo' }], timestamp: 2 } }),
    JSON.stringify({ type: 'session_info', id: 'cccccccc', parentId: 'bbbbbbbb', timestamp: '2024-12-03T14:00:03.000Z', name: 'First Name' }),
    JSON.stringify({ type: 'model_change', id: 'dddddddd', parentId: 'cccccccc', timestamp: '2024-12-03T14:00:04.000Z', provider: 'openai', modelId: 'gpt-5' }),
    JSON.stringify({ type: 'session_info', id: 'eeeeeeee', parentId: 'dddddddd', timestamp: '2024-12-03T14:00:05.000Z', name: 'Final Name' }),
  ].join('\n') + '\n';
  await fs.writeFile(path, lines, 'utf8');
  const ir = await parsePiFile(path);
  const events = (ir.meta as { pi: { settingsEvents?: Array<Record<string, unknown>> } }).pi.settingsEvents ?? [];
  assert.equal(events.filter((e) => e.type === 'session_info').length, 2, 'both session_info rows ride the sequence');
  const res = await adapter.write(ir, { root: join(root, 'out'), targetCwd: '/tmp/proj' });
  const raw = await fs.readFile(res.paths[0]!, 'utf8');
  const siRows = raw.split('\n').filter((l) => l.includes('"type":"session_info"'));
  assert.equal(siRows.length, 2, 'session_info sequence replays exactly once per row (no duplicate final title row)');
  const names = siRows.map((l) => (JSON.parse(l) as { name?: string }).name);
  assert.deepEqual(names, ['First Name', 'Final Name'], 'order preserved');
  const back = await parsePiFile(res.paths[0]!);
  assert.equal(back.title, 'Final Name', 'last-wins title after replay');
});
