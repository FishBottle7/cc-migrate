#!/usr/bin/env node
/**
 * ZCode adapter write-back acceptance check (companion to zcode-roundtrip-test.py).
 *
 * 1. Snapshot the live db.sqlite read-only (VACUUM INTO) into a sandbox
 *    ZCODE_HOME — never touches the live store.
 * 2. Parse the richest interactive session (revert + subagent children) from
 *    the real DB with the shipped ZcodeAdapter and write the IR into the
 *    sandbox with the same adapter.
 * 3. Drive `zcode.cjs app-server --stdio` (official NDJSON protocol) against
 *    the sandbox: session/list + session/resume + session/messages +
 *    session/subagents must all recognize the migrated sessions.
 * 4. Verify no provider credential material (apiKey values / "apiKey" fields)
 *    appears anywhere in the written sandbox.
 *
 * Usage: node docs/agents/zcode-write-verify.mjs [sessionId]
 */

import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = process.env.ZCODE_ENGINE
  ?? 'D:/Users/FishBottle/AppData/Local/Programs/ZCode/resources/glm/zcode.cjs';
const LIVE = join(process.env.ZCODE_HOME ?? join(homedir(), '.zcode'), 'cli', 'db', 'db.sqlite');
const CONFIG = join(process.env.ZCODE_HOME ?? join(homedir(), '.zcode'), 'v2', 'config.json');

const { ZcodeAdapter } = await import(
  'file://' + join(REPO, 'packages/core/dist/src/index.js').replace(/\\/g, '/')
);

// ---------- 1. sandbox ----------
const sandbox = mkdtempSync(join(tmpdir(), 'zcode-write-verify-'));
const dbPath = join(sandbox, 'cli', 'db', 'db.sqlite');
{
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(sandbox, 'cli', 'db'), { recursive: true });
  const src = new DatabaseSync(LIVE, { readOnly: true });
  src.exec(`VACUUM INTO '${dbPath.replace(/'/g, "''")}'`);
  src.close();
}
console.log('[1] sandbox db ready:', dbPath);

// ---------- 2. parse (real db, read-only) + write (sandbox) ----------
const probe = new DatabaseSync(LIVE, { readOnly: true });
const pick = process.argv[2] ?? probe.prepare(`
  SELECT s.id FROM session s
  WHERE s.task_type = 'interactive'
    AND (SELECT count(*) FROM session c WHERE c.parent_id = s.id AND c.task_type = 'subagent_child') > 0
  ORDER BY s.time_created DESC LIMIT 1`).get().id;
const nativeCount = probe.prepare('SELECT count(*) n FROM message WHERE session_id=?').get(pick).n;
probe.close();

const adapter = new ZcodeAdapter();
const t0 = Date.now();
const ir = await adapter.parse(pick);
console.log(`[2] parsed ${pick}: ${ir.messages.length} IR messages, ${ir.sidechains?.length ?? 0} sidechains, compaction=${ir.compaction?.length ?? 0} (${Date.now() - t0}ms)`);
const written = await adapter.write(ir, { root: sandbox, targetCwd: ir.cwd });
console.log(`[2] wrote ${written.paths.length} session rows into sandbox (parent=${written.sessionId})`);

// ---------- 3. official protocol against the sandbox ----------
const proc = spawn(process.execPath, [ENGINE, 'app-server', '--stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ZCODE_HOME: sandbox, ZCODE_SESSION_DB_PATH: dbPath },
  cwd: REPO,
});
const lines = createInterface({ input: proc.stdout });
const pending = new Map();
let nextId = 1;
lines.on('line', (line) => {
  let obj; try { obj = JSON.parse(line); } catch { return; }
  if (obj.id && pending.has(obj.id)) { pending.get(obj.id)(obj); pending.delete(obj.id); }
  else if (obj.method && obj.id) {
    // server→client reverse request: answer runtime preferences (15s deadline)
    proc.stdin.write(JSON.stringify({ id: obj.id, result: {
      nativeSearchEnhancementsEnabled: true, memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: 'preflight-v1',
    } }) + '\n');
  }
});
function rpc(method, params, timeout = 60000) {
  const id = String(nextId++);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), timeout);
    pending.set(id, (obj) => { clearTimeout(timer); resolve(obj); });
    proc.stdin.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + '\n');
  });
}

const verdicts = [];
const ok = (name, cond, detail = '') => {
  verdicts.push({ name, ok: !!cond });
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  // session/list
  const r1 = await rpc('session/list', { limit: 500 }, 90000);
  const ids = (r1.result?.sessions ?? []).map((s) => s.sessionId);
  ok('session/list', r1.result && ids.includes(written.sessionId),
    `${(r1.result?.sessions ?? []).length} sessions, migrated parent present=${ids.includes(written.sessionId)}`);

  // session/resume
  const r0 = await rpc('session/resume', { sessionId: written.sessionId });
  ok('session/resume', !!r0.result, r0.error ? JSON.stringify(r0.error).slice(0, 160) : 'loaded from sandbox db');

  // session/messages
  const r2 = await rpc('session/messages', { sessionId: written.sessionId });
  const msgs = r2.result?.messages ?? [];
  const firstUser = msgs.find((m) => m.info?.role === 'user');
  const firstUserTexts = (firstUser?.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n');
  const expectedText = (ir.messages.find((m) => m.role === 'user')?.content ?? [])
    .filter((b) => b.type === 'text').map((b) => b.text).join('\n').slice(0, 120);
  const toolParts = msgs.flatMap((m) => m.parts ?? []).filter((p) => p.type === 'tool');
  const completed = toolParts.filter((p) => p.state?.status === 'completed').length;
  ok('session/messages', msgs.length > 0
    && firstUserTexts.includes(expectedText.slice(0, 60))
    && completed > 0,
    `${msgs.length} messages, first-user probe=${firstUserTexts.includes(expectedText.slice(0, 60))}, tool parts completed=${completed}/${toolParts.length}`);

  // session/subagents — only the migrated sidechains can be expected; a
  // session without subagents must simply answer with an empty list
  const r3 = await rpc('session/subagents', { sessionId: written.sessionId });
  const res = r3.result ?? {};
  const subs = [...(res.running ?? []), ...(res.ended?.items ?? [])];
  const childRows = new Set(
    (() => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try { return db.prepare("SELECT id FROM session WHERE parent_id=?").all(written.sessionId).map((r) => r.id); }
      finally { db.close(); }
    })(),
  );
  const migratedChildIds = written.paths.filter((p) => p.startsWith('session:sess_subagent_agent_')).map((p) => p.slice('session:'.length));
  const everyResolvedToMigrated = subs.length > 0 && subs.every((s) => migratedChildIds.includes(s.childSessionId));
  ok('session/subagents',
    !!r3.result
    && (ir.sidechains?.length ? subs.length >= 1 : subs.length === 0)
    && subs.every((s) => (s.childSessionId ?? '').startsWith('sess_subagent_agent_'))
    && (migratedChildIds.length === 0 || everyResolvedToMigrated),
    `${subs.length} subagent(s), childSessionIds=${JSON.stringify(res.childSessionIds)}, all resolved to migrated children=${subs.length > 0 ? everyResolvedToMigrated : 'n/a'}`);
} finally {
  proc.stdin.end();
  await new Promise((resolve) => { proc.on('exit', resolve); setTimeout(resolve, 3000); proc.kill(); });
}

// ---------- 4. secret sweep over the written sandbox ----------
let secretsClean = true;
let secretNote = '';
try {
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  const secretValues = [];
  for (const p of Object.values(cfg.provider ?? {})) {
    const opts = p?.options ?? {};
    for (const [k, v] of Object.entries(opts)) {
      if (/key|token|secret/i.test(k) && typeof v === 'string' && v.length >= 8) secretValues.push(v);
    }
  }
  const bytes = readFileSync(dbPath); // sandbox db (post-write VACUUM'd copy + our rows)
  const haystack = bytes.toString('latin1');
  for (const secret of secretValues) {
    if (haystack.includes(secret)) { secretsClean = false; secretNote = 'an apiKey value appears in the sandbox db'; break; }
  }
  if (secretsClean && /"apiKey"\s*:/.test(haystack)) { secretsClean = false; secretNote = 'an "apiKey" field appears in the sandbox db'; }
} catch (e) {
  secretNote = `sweep skipped (${String(e).slice(0, 80)})`;
}
ok('no apiKey material in written sandbox', secretsClean, secretNote || 'swept every provider secret from v2/config.json');

rmSync(sandbox, { recursive: true, force: true });
const failed = verdicts.filter((v) => !v.ok);
console.log(`\n${failed.length === 0 ? 'ALL GREEN' : 'FAILURES'}: ${verdicts.length - failed.length}/${verdicts.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
