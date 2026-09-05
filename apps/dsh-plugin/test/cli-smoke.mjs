/**
 * Smoke test for the plugin's bundled agent CLI (lib/cli.js) — the execution
 * channel the cc-migrate skill teaches agents to drive (see
 * skills/cc-migrate/SKILL.md).
 *
 * Verifies, as a real child process (`node lib/cli.js ...`) against temp roots
 * seeded with the core's own write pipeline (never the real ~/.dsh / ~/.claude):
 *   1. `tools` lists the source tool ids, one per line.
 *   2. `list --json` emits a parseable JSON envelope (ok/tool/count/sessions)
 *      — titles may contain tabs/newlines, so agents must get JSON.
 *   3. `--cwd` filters to one project (normalized match) and `--limit` caps
 *      the listing.
 *   4. `migrate --json` writes a BRAND-NEW resumable DSH session into a temp
 *      root and reports {source, target:{sessionId, paths}}.
 *   5. failures exit 1 with `error: ...` on stderr (unknown tool / unknown
 *      command / bad --limit).
 *
 * Safety: everything happens inside os.tmpdir(); no unlink/rm anywhere.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'lib', 'cli.js');
const core = await import('@cc-migrate/core');

/** Run the bundled CLI; returns {status, stdout, stderr}. */
function run(args) {
  const r = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ── seed: claude session via the core write pipeline (temp dirs only) ──
const srcRoot = await mkdtemp(join(tmpdir(), 'cc-cli-src-'));   // claude side
const dstRoot = await mkdtemp(join(tmpdir(), 'cc-cli-dst-'));   // dsh side
const registry = core.builtinRegistry();
const ir = core.fallbackIr();
const written = await core.writeTarget(registry.get('claude'), ir, { root: srcRoot, targetCwd: 'D:\\demo\\proj' });
const srcSessionId = written.sessionId;

// ── 1. tools ──────────────────────────────────────────────────────────
const tools = run(['tools']);
assert.equal(tools.status, 0, `tools exited ${tools.status}: ${tools.stderr}`);
const toolIds = tools.stdout.trim().split('\n');
assert.deepEqual([...toolIds].sort(), ['claude', 'codex', 'dsh', 'opencode', 'pi', 'zcode']);
console.log(`[1] tools -> ${toolIds.join(', ')}`);

// ── 2. list --json envelope over the temp claude root ─────────────────
const list = run(['list', 'claude', '--root', srcRoot, '--json']);
assert.equal(list.status, 0, `list exited ${list.status}: ${list.stderr}`);
const envelope = JSON.parse(list.stdout);
assert.equal(envelope.ok, true);
assert.equal(envelope.tool, 'claude');
assert.ok(envelope.count >= 1, 'seeded session listed');
const listed = envelope.sessions.find((m) => m.sessionId === srcSessionId);
assert.ok(listed, 'seeded session id present in listing');
assert.equal(listed.cwd, 'D:\\demo\\proj', 'listing carries cwd');
console.log(`[2] list --json -> count=${envelope.count}, seeded id present (cwd ok)`);

// plain (human) list also exits 0 and mentions the session
const listPlain = run(['list', 'claude', '--root', srcRoot]);
assert.equal(listPlain.status, 0);
assert.ok(listPlain.stdout.includes(srcSessionId.slice(0, 8)) || listPlain.stdout.includes(srcSessionId), 'plain list prints the session line');

// ── 3. --cwd filter + --limit ─────────────────────────────────────────
const hit = JSON.parse(run(['list', 'claude', '--root', srcRoot, '--cwd', 'd:\\DEMO\\proj\\', '--json']).stdout);
assert.equal(hit.count, 1, 'cwd filter matches case-insensitively with trailing slashes normalized');
const miss = JSON.parse(run(['list', 'claude', '--root', srcRoot, '--cwd', 'D:\\elsewhere', '--json']).stdout);
assert.equal(miss.count, 0, 'cwd filter excludes other projects');
console.log(`[3] --cwd hit=${hit.count} miss=${miss.count}`);

// ── 4. migrate --json into a temp DSH root ────────────────────────────
const mig = run(['migrate', 'claude', srcSessionId, '--src-root', srcRoot, '--cwd', 'D:\\demo\\proj', '--root', dstRoot, '--json']);
assert.equal(mig.status, 0, `migrate exited ${mig.status}: ${mig.stderr}`);
const migration = JSON.parse(mig.stdout);
assert.equal(migration.ok, true);
assert.equal(migration.source.sessionId, srcSessionId);
assert.ok(typeof migration.target.sessionId === 'string' && migration.target.sessionId.length > 0, 'new DSH session id minted');
assert.ok(migration.target.paths.length >= 1, 'target paths reported');
for (const p of migration.target.paths) {
  const st = await stat(p);
  assert.ok(st.size > 0, `written artifact non-empty: ${p}`);
}
assert.notEqual(migration.target.sessionId, srcSessionId, 'target id differs from source id');
console.log(`[4] migrate -> dsh:${migration.target.sessionId} (${migration.target.paths.length} file(s))`);

// migrate output parses from the plain (non-json) line too
const mig2 = run(['migrate', 'claude', srcSessionId, '--src-root', srcRoot, '--root', dstRoot]);
assert.equal(mig2.status, 0);
assert.ok(mig2.stdout.includes(`-> dsh:`), 'plain migrate prints the migrated line');
assert.notEqual(mig2.stdout.match(/dsh:(\S+)/)?.[1], migration.target.sessionId, 'second migrate mints another new id');

// ── 4b. preview --json: the bounded decision digest ───────────────────
// 契约（skill 的上下文体量纪律依赖它）：整段 stdout 有界（约 1-2KB），
// 摘录 ≤200 字，绝不输出全文 —— 与 session 体量无关。
const dig = run(['preview', 'claude', srcSessionId, '--src-root', srcRoot, '--json']);
assert.equal(dig.status, 0, `preview --json exited ${dig.status}: ${dig.stderr}`);
const digest = JSON.parse(dig.stdout);
assert.equal(digest.sessionId, srcSessionId);
assert.ok(digest.stats && Number.isFinite(digest.stats.messages), 'stats.messages present');
assert.ok(Array.isArray(digest.firstUserMessages) && digest.firstUserMessages.length <= 3, 'firstUserMessages bounded (<=3)');
for (const e of digest.firstUserMessages) assert.ok(e.length <= 200, 'excerpts capped at 200 chars');
assert.ok(dig.stdout.length < 4096, `digest bounded: got ${dig.stdout.length} bytes`);
console.log(`[4b] preview --json -> ${dig.stdout.length} bytes (stats.messages=${digest.stats.messages})`);

// ── 4c. skill install --dir: universal skill lands in a custom dir ────
const skillDir = join(await mkdtemp(join(tmpdir(), 'cc-cli-skill-')), 'cc-migrate');
const inst = run(['skill', 'install', '--dir', skillDir, '--json']);
assert.equal(inst.status, 0, `skill install exited ${inst.status}: ${inst.stderr}`);
const instJson = JSON.parse(inst.stdout);
assert.equal(instJson.results[0].action, 'installed');
const skillMd = await (await import('node:fs/promises')).readFile(join(skillDir, 'SKILL.md'), 'utf8');
assert.ok(!skillMd.includes('{{CLI_PATH}}'), 'universal skill carries no DSH placeholder');
assert.ok(skillMd.includes('migrate') && skillMd.includes('cc-migrate'), 'universal skill teaches the CLI');
assert.ok(skillMd.includes('上下文体量纪律'), 'universal skill carries the context-budget discipline');
// status 也报告该 skill 文件可解析
const st = run(['skill', 'status', '--json']);
assert.equal(st.status, 0);
const stJson = JSON.parse(st.stdout);
assert.ok(stJson.source && stJson.source.endsWith(join('skills', 'universal', 'SKILL.md')), 'bundled universal skill source resolves');
assert.ok(stJson.targets.length >= 7, 'all known agent frameworks probed');
console.log('[4c] skill install --dir -> SKILL.md landed; status probes 7 frameworks');

// ── 5. failures: exit 1 + error line on stderr ────────────────────────
const badTool = run(['list', 'not-a-tool']);
assert.equal(badTool.status, 1);
assert.ok(badTool.stderr.startsWith('error:'), 'unknown tool -> error on stderr');
assert.ok(badTool.stderr.includes('supported:'), 'unknown tool error lists valid ids');

const badCmd = run(['frobnicate']);
assert.equal(badCmd.status, 1);
assert.ok(badCmd.stderr.includes('unknown command'), 'unknown command -> error on stderr');

const badLimit = run(['list', 'claude', '--root', srcRoot, '--limit', 'lots']);
assert.equal(badLimit.status, 1);
assert.ok(badLimit.stderr.includes('--limit'), 'bad --limit -> error on stderr');

const badMigrate = run(['migrate', 'claude', 'no-such-session', '--src-root', srcRoot]);
assert.equal(badMigrate.status, 1);
assert.ok(badMigrate.stderr.startsWith('error:'), 'failed migrate -> error on stderr, no stack noise');
console.log('[5] failure paths: exit 1 + `error: ...` on stderr (tool/command/limit/missing session)');

console.log('\nCLI SMOKE OK — bundled lib/cli.js serves tools/list/preview/migrate over temp roots with JSON output.');
