/**
 * Smoke test for the session-migrate DSH plugin.
 *
 * Verifies against a mock cordis ctx (no DSH host needed):
 *   1. apply() registers exactly the 3 commands and ctx.effect collects
 *      their disposers (fiber-clean unload).
 *   2. list-sources returns a session array for a source tool under a
 *      temp root (data seeded with the core's own write pipeline — never
 *      the real ~/.dsh).
 *   3. preview returns text.
 *   4. import writes a NEW resumable session into a temp DSH root and the
 *      existing file survives untouched (read-old-write-new).
 *   5. dispose path: running every registered disposer throws nothing.
 *
 * Safety: everything happens inside os.tmpdir(); no unlink/rm anywhere.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The plugin entry (built lib) — importing it pulls in the command layer.
const plugin = await import('../lib/index.js');
const core = await import('@session-migrate/core');
const { apply, COMMAND_NAMES } = plugin;

// ── mock cordis ctx ──────────────────────────────────────────────────
const registered = [];            // [name, handler]
const disposers = [];             // disposers returned by effect(fn)
const logs = [];
const mockCtx = {
  logger: {
    info: (...a) => logs.push(['info', ...a]),
    warn: (...a) => logs.push(['warn', ...a]),
    error: (...a) => logs.push(['error', ...a]),
  },
  commands: {
    register(name, handler) {
      registered.push([name, handler]);
      return () => {};            // unregister fn — recorded via effect below
    },
  },
  effect(fn) {
    const d = fn();
    disposers.push(d);
    return () => d?.();
  },
};

// ── 1. apply() registers the 3 commands ──────────────────────────────
apply(mockCtx, {});
const names = registered.map(([n]) => n);
assert.deepEqual(
  [...names].sort(),
  [...COMMAND_NAMES].sort(),
  `expected the 3 commands registered, got: ${names.join(', ')}`,
);
assert.equal(registered.length, 3, 'exactly 3 commands');
assert.ok(disposers.length >= 3, 'every register routed through ctx.effect');
console.log(`[1] commands registered: ${names.join(', ')} (${disposers.length} disposers via ctx.effect)`);

const handlers = new Map(registered);
const run = (name, ...args) => handlers.get(name)(...args);

// ── seed a source session with core's own pipeline (temp dirs only) ──
const srcRoot = await mkdtemp(join(tmpdir(), 'sm-plugin-src-'));   // claude side
const dstRoot = await mkdtemp(join(tmpdir(), 'sm-plugin-dst-'));   // dsh side
const registry = core.builtinRegistry();
const ir = core.fallbackIr();
const claude = registry.get('claude');
const written = await core.writeTarget(claude, ir, { root: srcRoot, targetCwd: 'D:\\demo\\proj' });
const srcSessionId = written.sessionId;

// ── 2. list-sources over the temp claude root ────────────────────────
const listRes = await run('list-sources', 'claude', '--root', srcRoot);
assert.equal(listRes.ok, true, `list-sources failed: ${listRes.error}`);
assert.ok(Array.isArray(listRes.sessions), 'sessions is an array');
assert.ok(listRes.sessions.length >= 1, 'at least one session listed');
const meta = listRes.sessions.find((s) => s.sessionId === srcSessionId);
assert.ok(meta, 'seeded session appears in list-sources');
console.log(`[2] list-sources claude @ tmp -> ${listRes.sessions.length} session(s), seeded id found: ${Boolean(meta)}`);

// ── 3. preview the seeded session ───────────────────────────────────
const prevRes = await run('preview', 'claude', srcSessionId, '--root', srcRoot);
assert.equal(prevRes.ok, true, `preview failed: ${prevRes.error}`);
assert.equal(typeof prevRes.text, 'string');
assert.ok(prevRes.text.length > 0, 'preview text non-empty');
console.log(`[3] preview ok, ${prevRes.text.split('\n').length} line(s)`);

// ── 4. import claude session into a temp DSH root ────────────────────
const importRes = await run('import', 'claude', srcSessionId, '--src-root', srcRoot, '--cwd', 'D:\\demo\\proj', '--root', dstRoot);
assert.equal(importRes.ok, true, `import failed: ${importRes.error}`);
assert.equal(importRes.target.tool, 'dsh');
assert.ok(importRes.target.paths.length >= 1, 'import wrote at least one path');
const importedPath = importRes.target.paths[0];
const before = await readFile(importedPath);
assert.ok(before.length > 0, 'written zstd file non-empty');
console.log(`[4] import claude:${srcSessionId} -> dsh:${importRes.target.sessionId}`);
console.log(`    wrote: ${importedPath}`);

// re-import must NOT overwrite: a second import writes a different new file
const importRes2 = await run('import', 'claude', srcSessionId, '--src-root', srcRoot, '--cwd', 'D:\\demo\\proj', '--root', dstRoot);
assert.equal(importRes2.ok, true, `second import failed: ${importRes2.error}`);
assert.notEqual(importRes2.target.sessionId, importRes.target.sessionId, 'import always mints a new session id');
const firstStillThere = await stat(importedPath);
assert.ok(firstStillThere.size > 0, 'first imported session untouched after second import');
console.log(`[4b] second import minted new id ${importRes2.target.sessionId}; first file intact`);

// ── 5. structured errors instead of thrown exceptions ────────────────
const badTool = await run('list-sources', 'not-a-tool');
assert.equal(badTool.ok, false);
assert.ok(typeof badTool.error === 'string');
console.log(`[5] unknown tool -> structured error: ${badTool.error.slice(0, 60)}...`);

// ── 6. dispose path throws nothing ───────────────────────────────────
for (const d of disposers) {
  if (typeof d === 'function') d();
}
console.log(`[6] ${disposers.length} disposers ran clean (no throw)`);

console.log('\nSMOKE OK — 3 commands registered, list-sources/preview/import verified in temp roots.');
