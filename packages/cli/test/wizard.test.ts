/**
 * Wizard hermetic tests — exercises the interactive selection logic via a
 * fake IO and fake core deps (no TTY, no real filesystem).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinRegistry, fallbackIr } from '@session-migrate/core';
import {
  filterMetas,
  formatMetaLine,
  parseSelection,
  runWizard,
  sortMetas,
  type WizardIO,
} from '../src/wizard.js';

test('filterMetas matches id/title/cwd/path', () => {
  const metas = [
    { tool: 'dsh' as const, sessionId: 'abc-1', title: 'hello world', cwd: 'D:\\proj\\a' },
    { tool: 'dsh' as const, sessionId: 'xyz-2', title: 'foo', cwd: 'D:\\proj\\b' },
  ];
  assert.equal(filterMetas(metas, 'abc').length, 1);
  assert.equal(filterMetas(metas, 'hello').length, 1);
  assert.equal(filterMetas(metas, 'proj\\b').length, 1);
  assert.equal(filterMetas(metas, '').length, 2);
});

test('parseSelection', () => {
  assert.deepEqual(parseSelection('3', 5), { kind: 'select', index: 2 });
  assert.deepEqual(parseSelection('q', 5), { kind: 'quit' });
  assert.deepEqual(parseSelection('quit', 5), { kind: 'quit' });
  assert.deepEqual(parseSelection('/foo', 5), { kind: 'filter', query: 'foo' });
  assert.deepEqual(parseSelection('f bar', 5), { kind: 'filter', query: 'bar' });
  assert.deepEqual(parseSelection('hello', 5), { kind: 'filter', query: 'hello' });
});

test('formatMetaLine / sortMetas', () => {
  const metas = [
    { tool: 'dsh' as const, sessionId: 'old', createdAt: 1 },
    { tool: 'dsh' as const, sessionId: 'new', createdAt: 99, title: 't' },
  ];
  assert.equal(sortMetas(metas)[0].sessionId, 'new');
  const line = formatMetaLine(0, metas[0]);
  assert.ok(line.includes('old'));
});

function makeFakeIO(answers: string[]): WizardIO & { out: string[] } {
  const out: string[] = [];
  let idx = 0;
  return {
    out,
    print(line: string) { out.push(line); },
    async question(prompt: string) {
      out.push(`Q: ${prompt}`);
      const a = answers[idx++] ?? '';
      out.push(`A: ${a}`);
      return a;
    },
  };
}

test('runWizard happy path (src dsh -> dst dsh, picks first session, confirms)', async () => {
  const io = makeFakeIO([
    'dsh',        // srcTool
    '',           // srcRoot (default)
    '1',          // pick first session
    '',           // accept preview (Y)
    'dsh',        // dstTool
    '',           // dstRoot
    '',           // targetCwd (keep src cwd)
    '',           // confirm Y
  ]);

  // Build a tiny registry with one fake dsh session in a tmp dir by actually
  // writing one via the real adapters (hermetic, in memory tmp via core).
  const { mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const srcRoot = await mkdtemp(join(tmpdir(), 'wiz-src-'));
  const dstRoot = await mkdtemp(join(tmpdir(), 'wiz-dst-'));
  const registry = builtinRegistry();
  const dsh = registry.get('dsh');
  const ir = fallbackIr();
  const { writeTarget, previewSession, readSource, listSessions } = await import('@session-migrate/core');
  const seed = await writeTarget(dsh, ir, { root: srcRoot, targetCwd: 'D:\\proj' });
  // ensure list finds it
  const metas = await listSessions(dsh, srcRoot);
  assert.ok(metas.some((m) => m.sessionId === seed.sessionId));

  const deps = {
    builtinRegistry: () => registry,
    previewSession: previewSession as never,
    readSource: readSource as never,
    writeTarget: writeTarget as never,
    listSessions: listSessions as never,
  };

  // patch IO to inject dstRoot via pre? actually step asks for dstRoot, we gave ''.
  // To actually write into hermetic dstRoot, pass pre.
  const res = await runWizard(io, deps, { srcRoot, dstRoot });
  assert.ok(res, 'wizard should succeed');
  assert.ok(res!.paths[0].length > 0);
  // dstRoot should contain at least one session
  const dstMetas = await listSessions(dsh, dstRoot);
  assert.equal(dstMetas.length, 1);
  assert.equal(dstMetas[0].sessionId, res!.sessionId);
});

test('runWizard cancel at preview returns null', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const srcRoot = await mkdtemp(join(tmpdir(), 'wiz-cancel-'));
  const registry = builtinRegistry();
  const dsh = registry.get('dsh');
  const { writeTarget, previewSession, readSource, listSessions } = await import('@session-migrate/core');
  await writeTarget(dsh, fallbackIr(), { root: srcRoot, targetCwd: 'D:\\proj' });

  const io = makeFakeIO([
    'dsh',
    '',
    '1',
    'n', // reject preview -> wizard returns null
  ]);
  const deps = {
    builtinRegistry: () => registry,
    previewSession: previewSession as never,
    readSource: readSource as never,
    writeTarget: writeTarget as never,
    listSessions: listSessions as never,
  };
  const res = await runWizard(io, deps, { srcRoot });
  assert.equal(res, null);
});
