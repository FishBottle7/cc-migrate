/**
 * OpenCode adapter — reads/writes the canonical `opencode.db` SQLite store.
 *
 * Source-anchored from `opencode-dev` + a REAL v1.18.21 store (sampled):
 *  - DB path: packages/core/src/database/database.ts:43 `path()` — xdgData/opencode/opencode.db
 *    with channel isolation + $OPENCODE_DB / $OPENCODE_TEST_HOME overrides (global.ts:18).
 *  - Schema: in v1.18.21 stores the authority is `message` (envelope) + `part`
 *    (content blocks); `session_message` exists but is EMPTY (verified). Newer
 *    builds dual-write both via SessionProjector, so reading message/part
 *    covers both eras.
 *  - Task subagents are NATIVE CHILD SESSIONS: `session.parent_id = <parent>`,
 *    `agent = subagent_type`, `title = "<description> (@<agent> subagent)"`;
 *    the parent's task tool part links back via
 *    `state.metadata = { parentSessionId, sessionId, model, truncated }` and
 *    carries the final result wrapped in
 *    `<task id="ses_…" state="completed|error"><task_result|task_error>…</…></task>`
 *    (tool/task.ts renderOutput). The FULL intermediate process lives in the
 *    child session's own message/part rows — never folded into the parent.
 *    Some v1.18 stores shipped with `parent_id` NULL (backfillable from task
 *    part metadata — see .db-rescue/); the parse side self-heals via metadata.
 *  - Compaction: boundary = user row whose part list carries
 *    `{type:'compaction', auto, tail_start_id?}`; the paired summary assistant
 *    (`summary:true, mode:'compaction', agent:'compaction'`) parents to it.
 *  - History: src/session/history.ts SessionHistory.load / loadForRunner (compaction-aware).
 *
 * This adapter:
 *  - On parse: walks the session TREE — main session + every child session
 *    row — into MigratedSession.messages + MigratedSidechain[] with the full
 *    intermediate transcripts (never just prompt+output), unwraps task
 *    outputs into tool_result content (raw wrapper kept as rawResult), and
 *    projects compaction boundaries into ir.compaction.
 *  - On write: transactional INSERT into project + session + message + part.
 *    flatten=false (native, the same-tool default) rebuilds each sidechain as
 *    a child session row and links the parent's task part via
 *    state.metadata.sessionId; flatten=true (the cross-tool "展平为顶层消息"
 *    default) folds sidechain transcripts into top-level messages.
 *  - Tool parts map the NATIVE four-state union: completed (output/title/
 *    metadata — output keeps even-empty real results), error (state.error ⇄
 *    IR tool_result isError), pending (a call with NO result in the IR —
 *    never fabricated as completed+'', which would drift on every re-parse).
 *  - When no real opencode.db exists (tests with --root <tmp>`), falls back to a JSONL
 *    mirror at `<root>/opencode-mirror/<sessionId>.jsonl` so tests remain hermetic and
 *    do not require better-sqlite3.
 */

import { promises as fs } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Adapter, WriteOptions, WriteResult } from '../../registry.js';
import type { ContentBlock, FileBlock, MigratedCompaction, MigratedMessage, MigratedSession, MigratedSidechain, SessionMeta } from '../../ir.js';
import { IR_VERSION, validateSession } from '../../ir.js';
import { blocksToText, normalizeContent } from '../../content.js';

type OpRow = Record<string, unknown>;

interface DbHandle {
  exec(sql: string): void;
  prepare(sql: string): { all(...args: unknown[]): OpRow[]; get(...args: unknown[]): OpRow | undefined; run(...args: unknown[]): unknown };
  close(): void;
}

function resolveDbPath(root?: string): string | null {
  // Convention chosen for this adapter:
  //  - if root ends with .db => explicit file path
  //  - else if root is a dir => join(root, 'opencode.db')
  //  - else fallback to default xdg location
  if (root && root.trim()) {
    const t = root.trim();
    if (t.endsWith('.db')) return t;
    // heuristic: if t contains '.' and ends with .db.* allow? keep simple.
    return join(t, 'opencode.db');
  }
  const envDb = process.env.OPENCODE_DB;
  if (envDb && envDb.trim()) {
    if (envDb === ':memory:' || envDb.startsWith('/')) return envDb;
    // relative to xdgData/opencode
    const xdg = xdgDataDir();
    return xdg ? join(xdg, 'opencode', envDb) : null;
  }
  const xdg = xdgDataDir();
  if (!xdg) return null;
  return join(xdg, 'opencode', 'opencode.db');
}

function shouldUseDb(dbPath: string | null, rootExplicit: boolean): boolean {
  if (!dbPath) return false;
  if (dbPath === ':memory:') return true;
  // Explicit temp root that has never held a real opencode.db should stay
  // hermetic (mirror) rather than auto-creating an empty DB file.
  if (rootExplicit) {
    // explicit file path: if caller gave ".../something.db" and it exists, use it
    // explicit dir: dbPath is "<dir>/opencode.db" — only use DB if that file already exists
    return existsSync(dbPath);
  }
  // default location: use DB only if the file is present
  return existsSync(dbPath);
}

function xdgDataDir(): string | null {
  const testHome = process.env.OPENCODE_TEST_HOME;
  const home = testHome && testHome.trim() ? testHome.trim() : (process.env.HOME || (process.env.USERPROFILE ?? null));
  if (!home) return null;
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support');
  // linux/win via xdg: use ~/.local/share
  return join(home, '.local', 'share');
}

let __sqliteCtor: (new (p: string, opts?: unknown) => DbHandle) | null | undefined;
async function getSqliteCtor(): Promise<(new (p: string, opts?: unknown) => DbHandle) | null> {
  if (__sqliteCtor !== undefined) return __sqliteCtor;
  try {
    const mod = await import('node:sqlite') as unknown as Record<string, unknown>;
    const Ctor = mod.DatabaseSync as (new (p: string, opts?: unknown) => DbHandle) | undefined;
    if (typeof Ctor === 'function') { __sqliteCtor = Ctor as unknown as new (p: string, opts?: unknown) => DbHandle; return __sqliteCtor; }
  } catch { /* no node:sqlite */ }
  __sqliteCtor = null;
  return null;
}

function openDbSync(dbPath: string, opts?: { readOnly?: boolean }): DbHandle | null {
  // Node 24 node:sqlite rejects an explicitly-passed `undefined` options
  // argument ("The options argument must be an object") — normalize to {} so
  // open attempts never fail on argument shape.
  const ctorOpts = opts ?? {};
  if (__sqliteCtor) {
    try { return new (__sqliteCtor as new (p: string, opts?: unknown) => DbHandle)(dbPath, ctorOpts); } catch { /* fall through */ }
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createRequire } = require('node:module') as unknown as { createRequire(p: string): (id: string) => unknown };
    const req = createRequire(import.meta.url);
    const mod = req('node:sqlite') as Record<string, unknown>;
    const Ctor = mod.DatabaseSync as (new (p: string, opts?: unknown) => DbHandle) | undefined;
    if (typeof Ctor === 'function') {
      __sqliteCtor = Ctor as unknown as new (p: string, opts?: unknown) => DbHandle;
      return new (__sqliteCtor as new (p: string, opts?: unknown) => DbHandle)(dbPath, ctorOpts);
    }
  } catch { /* not available sync */ }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createRequire } = require('node:module') as unknown as { createRequire(p: string): (id: string) => unknown };
    const req2 = createRequire(import.meta.url);
    const Better = req2('better-sqlite3') as (new (p: string, opts?: unknown) => unknown) | undefined;
    if (typeof Better === 'function') {
      const raw = new (Better as new (p: string, opts?: unknown) => DbHandle)(dbPath, ctorOpts) as unknown as DbHandle;
      return raw;
    }
  } catch { /* no driver */ }
  return null;
}

async function openDb(dbPath: string, opts?: { readOnly?: boolean }): Promise<DbHandle | null> {
  const Ctor = await getSqliteCtor();
  if (Ctor) {
    try { return new (Ctor as new (p: string, opts?: unknown) => DbHandle)(dbPath, opts ?? {}); } catch { /* busy/locked */ }
  }
  return openDbSync(dbPath, opts);
}

export class OpenCodeAdapter implements Adapter {
  readonly tool = 'opencode' as const;
  readonly irVersion = IR_VERSION;

  async parse(sessionId: string, root?: string): Promise<MigratedSession> {
    const dbPath = resolveDbPath(root);
    const rootExplicit = !!(root && root.trim());
    // Only touch the real DB when the file is actually present at the resolved
    // path. Without this, explicit temp roots would auto-create an empty DB.
    if (shouldUseDb(dbPath, rootExplicit)) {
      const db = await openDb(dbPath!, { readOnly: true });
      if (db) {
        try {
          return parseFromDb(db, sessionId);
        } finally {
          try { db.close(); } catch { /* ignore */ }
        }
      }
    }
    // No DB driver or DB absent: fallback to mirror.
    if (!rootExplicit && !dbPath) throw new Error('OpenCode: cannot resolve opencode.db (no HOME/USERPROFILE and no --src-root)');
    const mirrorDir = root ? join(root.endsWith('.db') ? dirname(root) : root, 'opencode-mirror') : null;
    if (!mirrorDir) throw new Error(`OpenCode: cannot open opencode.db at ${dbPath ?? '<noresolve>'} (is the DB locked or missing sqlite driver?) and no mirror root is available`);
    const mirrorPath = join(mirrorDir, `${sessionId}.jsonl`);
    try {
      await fs.access(mirrorPath);
    } catch {
      throw new Error(`OpenCode: session "${sessionId}" not found (no db at ${dbPath ?? '<noresolve>'} and no mirror at ${mirrorPath})`);
    }
    return parseFromMirror(mirrorPath);
  }

  async write(ir: MigratedSession, opts?: WriteOptions): Promise<WriteResult> {
    validateSession(ir);
    const root = opts?.root;
    const rootExplicit = !!(root && root.trim());
    const targetCwd = opts?.targetCwd ?? ir.cwd ?? '';
    const newId = opts?.sessionId ?? `ses_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    // flatten semantics (CLI wizard wording): true = 展平为顶层消息 (cross-tool
    // default), false = 压回 task 工具块/保留隐藏语义 (same-tool default →
    // native child-session reconstruction).
    const flatten = opts?.flatten ?? true;

    const dbPath = resolveDbPath(root);
    const useDb = shouldUseDb(dbPath, rootExplicit);
    if (useDb && dbPath) {
      // Detect sandbox / permission before attempting SQLite write.
      // In DSH the workspace-write sandbox EPERM-surfaces as sqlite
      // "attempt to write a readonly database" (r+ open is denied).
      try {
        const { openSync, closeSync } = await import('node:fs') as unknown as { openSync(p: string, f: string): number; closeSync(fd: number): void };
        const fd = openSync(dbPath, 'r+');
        closeSync(fd);
      } catch (e) {
        const code = (e as { code?: string })?.code ?? '';
        if (code === 'EPERM' || code === 'EACCES') {
          throw new Error(
            `OpenCode: default DB is not writable in this sandbox (EPERM on r+ open of ${dbPath}). ` +
            `This is NOT an OpenCode lock — the DSH GUI sandbox blocked the write. ` +
            `Run the migration CLI outside the GUI sandbox (e.g. in a normal terminal: node packages/cli/dist/src/index.js migrate dsh <id> opencode --dst-root <tmp>) or add --dst-root <tmpDir> to write to a hermetic mirror for verification. ` +
            `If you need to write the real opencode.db, launch the CLI from a non-sandboxed shell.`,
          );
        }
        // other fs errors fall through to sqlite attempt for better diagnostics
      }
      const db = await openDb(dbPath);
      if (db) {
        try {
          // Probe write inside the opened DB — if sandbox still blocks, we
          // surface the EPERM hint rather than the opaque sqlite error.
          let probeFailed: Error | null = null;
          try {
            db.exec('SAVEPOINT _sm_probe');
            const now = Date.now();
            // Full column list — the real project table has NOT NULL sandboxes.
            db.prepare('INSERT OR IGNORE INTO project (id, worktree, vcs, name, icon_url, icon_url_override, icon_color, time_created, time_updated, time_initialized, sandboxes, commands) VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, ?, NULL)').run(`_sm_probe_${now}`, '/tmp/_sm_probe', now, now, '[]');
            db.exec('ROLLBACK TO SAVEPOINT _sm_probe');
            db.exec('RELEASE SAVEPOINT _sm_probe');
          } catch (e) {
            try { db.exec('ROLLBACK TO SAVEPOINT _sm_probe'); } catch {}
            try { db.exec('RELEASE SAVEPOINT _sm_probe'); } catch {}
            const msg = String((e as Error)?.message ?? e);
            if (msg.includes('readonly database') || msg.includes('EPERM')) probeFailed = e as Error;
            else throw e;
          }
          if (probeFailed) {
            throw new Error(
              `OpenCode: default DB is not writable (sqlite: ${probeFailed.message}). ` +
              `In the DSH GUI sandbox this surfaces as EPERM on r+ and sqlite readonly. ` +
              `Run the migration CLI outside the sandbox or use --dst-root <tmpDir> for a hermetic mirror. ` +
              `WP DB helpers are not applicable here (different sandbox domain).`,
            );
          }
          // Atomic write (opencode.md「BEGIN IMMEDIATE 事务写库」): the whole
          // project+session+message+part insert is one transaction, so a
          // mid-write failure leaves the store untouched instead of orphaned
          // half-session rows. node:sqlite accepts plain BEGIN/COMMIT syntax.
          db.exec('BEGIN IMMEDIATE');
          let written: string;
          try {
            written = writeToDb(db, ir, newId, targetCwd, flatten, opts?.keepSynthetic ?? false);
            db.exec('COMMIT');
          } catch (e) {
            try { db.exec('ROLLBACK'); } catch { /* no transaction was active */ }
            const msg = String((e as Error)?.message ?? e);
            if (msg.includes('SQLITE_BUSY') || msg.includes('database is locked')) {
              throw new Error(`OpenCode: ${dbPath} is locked (SQLITE_BUSY) — another process (the opencode app?) is mid-write. Retry or write to a sandbox copy via --dst-root.`);
            }
            throw e;
          }
          return { tool: 'opencode', sessionId: written, paths: [dbPath ?? '<db>'] };
        } finally {
          try { db.close(); } catch { /* ignore */ }
        }
      }
    }

    // Non-DB path: explicit root -> hermetic mirror; otherwise real-DB write
    // was required but unavailable — explain rather than silently mirroring.
    if (!rootExplicit) {
      const hint = dbPath ? `OpenCode: cannot open ${dbPath}` : 'OpenCode: cannot resolve opencode.db';
      const busy = dbPath?.includes('opencode.db') ? '（若在 DSH 沙箱内运行，会因 EPERM 被拦；请在普通终端运行 CLI，或加 --dst-root <dir> 迁到临时目录验证）' : '';
      throw new Error(`${hint}：未找到可用的 sqlite 驱动或数据库被占用/不存在${busy}。可用 --dst-root <tmpDir> 迁到临时 mirror 验证，或检查 Node 版本是否 ≥22 且 sqlite 驱动可用。`);
    }
    const mirrorDir = join(root!.endsWith('.db') ? dirname(root!) : root!, 'opencode-mirror');
    await fs.mkdir(mirrorDir, { recursive: true });
    const mirrorPath = join(mirrorDir, `${newId}.jsonl`);
    await writeToMirror(mirrorPath, ir, newId, targetCwd, flatten);
    return { tool: 'opencode', sessionId: newId, paths: [mirrorPath] };
  }

  async listSessions(root?: string): Promise<SessionMeta[]> {
    const dbPath = resolveDbPath(root);
    const rootExplicit = !!(root && root.trim());
    if (shouldUseDb(dbPath, rootExplicit)) {
      const db = await openDb(dbPath!, { readOnly: true });
      if (!db) {
        // The db file EXISTS (shouldUseDb checked) but will not open —
        // driver failure or a lock. That must surface as an error, not an
        // empty list ("nothing to migrate" would send the caller the wrong
        // way) and must not fall through to the mirror (a real store is
        // present; the mirror is only for explicit roots with no db).
        throw new Error(
          `OpenCode: cannot open ${dbPath} read-only to list sessions (no sqlite driver / locked — busy hint: close the opencode app or retry).`,
        );
      }
      try {
        // TOP-LEVEL sessions only: task subagents are native child session
        // rows (session.parent_id) and OpenCode's own UI groups them under
        // their parent — listing them as peers would flatten 955 subagent
        // sessions into the picker of a real store. Orphaned children whose
        // parent row vanished stay visible (nothing silently unlistable).
        const rows = db.prepare('SELECT id, title, time_created, directory FROM session WHERE parent_id IS NULL OR parent_id NOT IN (SELECT id FROM session) ORDER BY time_created DESC').all() as OpRow[];
        return rows.map((r) => ({
          tool: 'opencode' as const,
          sessionId: String(r.id ?? ''),
          title: r.title ? String(r.title) : undefined,
          createdAt: typeof r.time_created === 'number' ? r.time_created : undefined,
          cwd: r.directory ? String(r.directory) : undefined,
          sourcePath: dbPath ?? undefined,
        }));
      } finally {
        try { db.close(); } catch { /* ignore */ }
      }
    }
    // No DB at the resolved path (or a non-explicit default with no real
    // store): mirror listing for explicit roots only.
    const mirrorDir = root ? join(root.endsWith('.db') ? dirname(root) : root, 'opencode-mirror') : null;
    if (!mirrorDir) return [];
    let entries: string[];
    try {
      entries = await fs.readdir(mirrorDir);
    } catch {
      return [];
    }
    const out: SessionMeta[] = [];
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const sid = name.slice(0, -'.jsonl'.length);
      const full = join(mirrorDir, name);
      try {
        const st = await fs.stat(full);
        out.push({ tool: 'opencode', sessionId: sid, createdAt: st.mtimeMs, sourcePath: full });
      } catch { /* skip */ }
    }
    return out;
  }

  preview(session: MigratedSession): string {
    const main = session.messages.map((m) => `[${m.role}]\n${blocksToText(m.content)}`).join('\n\n');
    if (!session.sidechains?.length) return main;
    const sc = session.sidechains.map((s) => `[sidechain: ${s.agentId} (${s.kind})]\n${s.messages.map((m) => blocksToText(m.content)).join('\n')}`).join('\n\n');
    return `${main}\n\n${sc}`;
  }
}

/* ------------------------------------------------------------------ */
/* DB mode helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * DB row conventions — source-anchored from a REAL opencode v1.18.21 store:
 *  - messages live in `message` (envelope) + `part` (content blocks);
 *    `session_message` exists but is EMPTY in v1.18 stores.
 *  - message data user:   {role:'user', time:{created}, agent:'build',
 *                           model:{providerID, modelID}, summary:{diffs:[]}}
 *  - message data assist: {parentID, role:'assistant', mode:'build', agent:'build',
 *                           path:{cwd, root}, cost, tokens, modelID, providerID,
 *                           time:{created, completed}, finish?}
 *  - compaction: boundary user row with a `{type:'compaction', auto,
 *    tail_start_id?}` part + assistant summary row `{summary:true,
 *    mode:'compaction', agent:'compaction', parentID:<boundary>}`.
 *  - task subagent: child session row (session.parent_id) + parent task part
 *    `state.metadata = {parentSessionId, sessionId, model, truncated}`;
 *    output wrapped `<task id=… state=…><task_result>…</task_result></task>`.
 *  - part data types: text{text} | reasoning{text} | tool{tool,callID,
 *    state:{status,input,output,title,metadata,time}} | step-start |
 *    step-finish | patch | file{mime,filename,url} | compaction | ...
 *  - sessions attach to project_id='global' (worktree '/') in practice;
 *    per-directory projects exist too (worktree forward-slashed, vcs 'git',
 *    sandboxes '[]', id 40-hex).
 *  - tool results are NOT separate rows: the output lives inside the tool
 *    part's state.output.
 */

const OPENCODE_APP_VERSION = '1.18.21';

function fwdSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * `session.path` is the cwd RELATIVE to the project worktree — NEVER the
 * absolute directory (that lives in `session.directory`). The app writes it
 * via `sessionPath(worktree, cwd)` = path.relative(worktree, cwd) with
 * backslashes normalized to '/' (session.ts:171). cwd == worktree (the
 * common case: the repo root is the cwd) ⇒ ''. Relative paths only appear
 * when the cwd is nested inside a larger worktree — real-store samples:
 * 987/1055 rows are '' (cwd == git worktree), the rest like
 * 'codes/dshPlugins/cc-migrate' (worktree '/'). Sessions listing by subpath
 * (`like(path, '<sub>/%')`, session.ts:967) would never match an absolute
 * path, so writing `directory` here breaks the app's path scoping.
 */
function sessionPathColumn(worktree: string, cwd: string): string {
  if (!isAbsolute(cwd) || !isAbsolute(worktree)) return '';
  // path.relative drops the drive/root when from is '/' (win32: '/' → the
  // current drive root), which is exactly how the app's own sessionPath
  // produces 'codes/dshPlugins/cc-migrate' for worktree '/' on Windows.
  const rel = relative(worktree, cwd);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return '';
  return fwdSlash(rel);
}

/**
 * The worktree the app would resolve this cwd to (real-store 1.18 shape):
 * 1. a git repo root found by walking up for `.git` (hash-id projects are
 *    born from git discovery — their worktree IS the git root; 203/210
 *    git-project rows have path '' because cwd == that root);
 * 2. otherwise the 'global' project (worktree '/') — every non-git
 *    directory attaches there, and sessionPath('/', cwd) drops the drive
 *    root (win32 path.relative behavior), producing rows like
 *    'codes/dshPlugins/cc-migrate' (24 real rows sampled).
 * `session.directory` stays the absolute cwd either way.
 */
function resolveWorktree(cwd: string): string {
  let cur = cwd;
  for (let i = 0; i < 64 && cur; i++) {
    if (existsSync(join(cur, '.git'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return '/';
}

/**
 * Find the project row a migrated session should attach to.
 * 1. The app's own project for this worktree (the common real case — the
 *    directory has been opened in OpenCode before, so the row exists).
 * 2. Otherwise the app's 'global' project (worktree '/') — every production
 *    session row we sampled attaches there. Never fabricate a hash-style
 *    project id: the app's id derivation is opaque and a mismatched id would
 *    be orphaned from the app's project resolution.
 */
function resolveProjectRow(db: DbHandle, cwd: string): string {
  const worktree = fwdSlash(cwd || '/');
  const found = db.prepare('SELECT id FROM project WHERE worktree = ? LIMIT 1').get(worktree) as OpRow | undefined;
  if (found?.id) return String(found.id);
  ensureGlobalProject(db);
  return 'global';
}

function ensureGlobalProject(db: DbHandle): void {
  const now = Date.now();
  db.prepare(
    "INSERT OR IGNORE INTO project (id, worktree, vcs, name, icon_url, icon_url_override, icon_color, time_created, time_updated, time_initialized, sandboxes, commands) VALUES ('global', '/', NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, '[]', NULL)",
  ).run(now, now);
}

/* ------------------------------------------------------------------ */
/* Parse: session tree walk                                            */
/* ------------------------------------------------------------------ */

interface OpSessionRow {
  id: string;
  parent_id?: string | null;
  title?: string | null;
  agent?: string | null;
  time_created?: number | null;
  directory?: string | null;
}

const SESSION_COLS = 'id, parent_id, title, agent, time_created, directory';

function getSessionRow(db: DbHandle, id: string): OpSessionRow | undefined {
  return db.prepare(`SELECT ${SESSION_COLS} FROM session WHERE id=?`).get(id) as OpSessionRow | undefined;
}

function childSessionRows(db: DbHandle, parentId: string): OpSessionRow[] {
  return db.prepare(`SELECT ${SESSION_COLS} FROM session WHERE parent_id=? ORDER BY time_created ASC, rowid ASC`).all(parentId) as unknown as OpSessionRow[];
}

function parseRowData(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') {
    try { return JSON.parse(v) as Record<string, unknown>; } catch { return {}; }
  }
  return ((v as Record<string, unknown>) ?? {});
}

function loadPartsByMessage(db: DbHandle, sessionId: string): Map<string, Array<Record<string, unknown>>> {
  const partRows = db.prepare('SELECT message_id, data FROM part WHERE session_id=? ORDER BY rowid ASC').all(sessionId) as OpRow[];
  const map = new Map<string, Array<Record<string, unknown>>>();
  for (const pr of partRows) {
    const d = parseRowData(pr.data);
    const key = String(pr.message_id ?? '');
    const list = map.get(key) ?? [];
    list.push(d);
    map.set(key, list);
  }
  return map;
}

interface OpTaskLink {
  callId: string;
  /** task part state.metadata.sessionId — the native child session reference */
  childRef?: string;
  subagentType?: string;
  parentMessageRowId: string;
}

interface WalkResult {
  messages: MigratedMessage[];
  sidechains: MigratedSidechain[];
  compactions: MigratedCompaction[];
  model?: MigratedSession['model'];
}

/**
 * Walk ONE session's message/part rows into IR messages, then recurse into
 * its native sub-sessions as sidechains. Children come from
 * `session.parent_id` plus self-healing via task part
 * `state.metadata.sessionId` (v1.18 stores shipped with parent_id NULL —
 * backfillable only from the task part metadata).
 */
function walkSession(db: DbHandle, sessionId: string, seen: Set<string>): WalkResult {
  if (seen.has(sessionId)) return { messages: [], sidechains: [], compactions: [] };
  seen.add(sessionId);

  const msgRows = db.prepare('SELECT id, data, time_created FROM message WHERE session_id=? ORDER BY time_created ASC, rowid ASC').all(sessionId) as OpRow[];
  const partsByMessage = loadPartsByMessage(db, sessionId);

  // Compaction summary assistants pair to their boundary user row via
  // parentID (message-v2.ts filterCompacted contract) and are consumed into
  // the projected summary carrier — never emitted as ordinary assistants.
  const summaryRowByParent = new Map<string, string>();
  const summaryPartsByParent = new Map<string, Array<Record<string, unknown>>>();
  const summaryRowIds = new Set<string>();
  for (const r of msgRows) {
    const rowId = String(r.id ?? '');
    const d = parseRowData(r.data);
    if (d.summary === true && typeof d.parentID === 'string' && d.parentID) {
      summaryRowIds.add(rowId);
      summaryRowByParent.set(d.parentID, rowId);
      summaryPartsByParent.set(d.parentID, partsByMessage.get(rowId) ?? []);
    }
  }

  const messages: MigratedMessage[] = [];
  const compactions: MigratedCompaction[] = [];
  const taskLinks = new Map<string, OpTaskLink>();
  let model: MigratedSession['model'];

  for (const r of msgRows) {
    const rowId = String(r.id ?? '');
    const data = parseRowData(r.data);
    const role = String(data.role ?? 'assistant') as MigratedMessage['role'];
    const ts = typeof r.time_created === 'number' ? r.time_created : undefined;
    const parts = partsByMessage.get(rowId) ?? [];

    if (summaryRowIds.has(rowId)) continue;

    if (role === 'user') {
      const compactionPart = parts.find((p) => p.type === 'compaction');
      if (compactionPart) {
        const summaryText = (summaryPartsByParent.get(rowId) ?? [])
          .filter((p) => p.type === 'text' && typeof p.text === 'string')
          .map((p) => String(p.text))
          .join('\n');
        const ocMeta: Record<string, unknown> = { auto: compactionPart.auto === true, boundaryMessageId: rowId };
        if (typeof compactionPart.tail_start_id === 'string' && compactionPart.tail_start_id) ocMeta.tailStartId = compactionPart.tail_start_id;
        const summaryId = summaryRowByParent.get(rowId);
        if (summaryId) ocMeta.summaryMessageId = summaryId;
        if (summaryText) {
          // Canonical conversation carrier: the summary text travels as an
          // ordinary user message (targets that ignore compaction[] still see
          // it); the native boundary/summary rows are rebuilt from the
          // compaction entry on write.
          messages.push({ role: 'user', content: [{ type: 'text', text: summaryText }], timestamp: ts });
          compactions.push({ summary: summaryText, anchorIndex: messages.length - 1, meta: { opencode: ocMeta } });
          // NO continue here: 23/44 boundary rows in a real 1.18 store also
          // carry ordinary text/file parts (e.g. `[user interrupted]`) —
          // falling through projects them below so they do not evaporate.
        } else {
          // Boundary without a summary pair (failed compaction): keep the typed
          // record without an anchor — the conversational stream has nothing to
          // carry it on.
          compactions.push({ summary: '', meta: { opencode: ocMeta } });
        }
      }
      const content: ContentBlock[] = [];
      for (const p of parts) {
        if (p.type === 'text' && typeof p.text === 'string') content.push({ type: 'text', text: p.text });
        else if (p.type === 'file') {
          const f = fileFromPart(p);
          if (f) content.push(f);
        }
      }
      if (content.length) messages.push({ role: 'user', content, timestamp: ts });
      continue;
    }

    // assistant
    if (!model && typeof data.modelID === 'string') {
      model = { id: data.modelID, provider: typeof data.providerID === 'string' ? data.providerID : undefined };
    }
    const content: ContentBlock[] = [];
    const toolResults: MigratedMessage[] = [];
    for (const p of parts) {
      if (p.type === 'text' && typeof p.text === 'string') {
        content.push({ type: 'text', text: p.text });
      } else if (p.type === 'reasoning' && typeof p.text === 'string') {
        content.push({ type: 'thinking', thinking: p.text });
      } else if (p.type === 'file') {
        const f = fileFromPart(p);
        if (f) content.push(f);
      } else if (p.type === 'tool') {
        const callID = String(p.callID ?? randomUUID());
        const state = (p.state ?? {}) as Record<string, unknown>;
        const input = (state.input ?? {}) as Record<string, unknown>;
        content.push({ type: 'tool_use', id: callID, name: String(p.tool ?? 'tool'), input });
        const isTask = String(p.tool ?? '') === 'task';
        if (isTask) {
          const meta = (state.metadata ?? {}) as Record<string, unknown>;
          taskLinks.set(callID, {
            callId: callID,
            childRef: typeof meta.sessionId === 'string' && meta.sessionId ? meta.sessionId : undefined,
            subagentType: typeof input.subagent_type === 'string' ? input.subagent_type : undefined,
            parentMessageRowId: rowId,
          });
        }
        // opencode stores tool output inside the part — re-emit as IR tool_result.
        // Empty-string outputs are REAL (bash with empty stdout) and travel as
        // tool_result content ''; error parts carry their text in state.error
        // (isError); pending/running parts are calls without any result — no
        // tool_result is projected for them.
        if (state.output !== undefined && state.output !== null) {
          const raw = typeof state.output === 'string' ? state.output : JSON.stringify(state.output);
          const unwrapped = isTask ? unwrapTaskOutput(raw) : undefined;
          const block: { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean; rawResult?: unknown } = {
            type: 'tool_result',
            toolUseId: callID,
            content: unwrapped ? unwrapped.text : raw,
          };
          // keep the renderOutput wrapper (task id/state) as structured source payload
          if (unwrapped && unwrapped.text !== raw) block.rawResult = raw;
          toolResults.push({ role: 'tool', content: [block as ContentBlock], timestamp: ts });
        } else if (typeof state.error === 'string' && state.error) {
          toolResults.push({ role: 'tool', content: [{ type: 'tool_result', toolUseId: callID, content: state.error, isError: true }], timestamp: ts });
        }
      }
      // step-start / step-finish / patch: structural metadata, skipped
    }
    if (content.length) {
      messages.push({ role: 'assistant', content, timestamp: ts, provider: typeof data.providerID === 'string' ? data.providerID : undefined, model: typeof data.modelID === 'string' ? data.modelID : undefined });
      messages.push(...toolResults);
    }
  }

  // Native sub-sessions → sidechains (recursion covers grandchildren).
  const sidechains: MigratedSidechain[] = [];
  const linkByChild = new Map<string, OpTaskLink>();
  for (const link of taskLinks.values()) {
    if (link.childRef && !linkByChild.has(link.childRef)) linkByChild.set(link.childRef, link);
  }
  const childIds: string[] = [];
  const childSeen = new Set<string>();
  for (const row of childSessionRows(db, sessionId)) {
    if (!childSeen.has(row.id)) { childSeen.add(row.id); childIds.push(row.id); }
  }
  for (const childRef of linkByChild.keys()) {
    if (childSeen.has(childRef)) continue;
    if (getSessionRow(db, childRef)) { childSeen.add(childRef); childIds.push(childRef); }
  }
  for (const childId of childIds) {
    const row = getSessionRow(db, childId);
    if (!row) continue;
    const sub = walkSession(db, childId, seen);
    const link = linkByChild.get(childId);
    const ocMeta: Record<string, unknown> = { parentSessionId: sessionId };
    if (link) ocMeta.callId = link.callId;
    const sc: MigratedSidechain = {
      agentId: childId,
      kind: 'subagent',
      agentType: ((row.agent ? String(row.agent) : undefined) ?? link?.subagentType) || undefined,
      title: row.title ? String(row.title) : undefined,
      createdAt: typeof row.time_created === 'number' ? row.time_created : undefined,
      parentMessageId: link?.parentMessageRowId,
      messages: sub.messages,
      meta: { opencode: ocMeta },
    };
    if (sub.sidechains.length) sc.sidechains = sub.sidechains;
    if (sub.compactions.length) sc.compaction = sub.compactions;
    sidechains.push(sc);
  }

  return { messages, sidechains, compactions, model };
}

function parseFromDb(db: DbHandle, sessionId: string): MigratedSession {
  let sessionRow: OpSessionRow | undefined;
  try {
    sessionRow = getSessionRow(db, sessionId);
  } catch {
    sessionRow = undefined;
  }
  if (!sessionRow) throw new Error(`OpenCode: session "${sessionId}" not found in opencode.db`);
  const seen = new Set<string>();
  const walk = walkSession(db, String(sessionRow.id ?? sessionId), seen);
  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'opencode',
    originSessionId: String(sessionRow.id ?? sessionId),
    title: sessionRow.title ? String(sessionRow.title) : undefined,
    createdAt: typeof sessionRow.time_created === 'number' ? sessionRow.time_created : undefined,
    cwd: sessionRow.directory ? String(sessionRow.directory) : undefined,
    messages: walk.messages,
  };
  if (walk.model) ir.model = walk.model;
  if (walk.compactions.length) ir.compaction = walk.compactions;
  if (walk.sidechains.length) ir.sidechains = walk.sidechains;
  return validateSession(ir);
}

/* ------------------------------------------------------------------ */
/* Task output wrap/unwrap (tool/task.ts renderOutput wire format)     */
/* ------------------------------------------------------------------ */

const TASK_OUTPUT_RE = /^<task id="([^"]*)" state="([a-z]+)">\n<task_(result|error)>\n([\s\S]*)\n<\/task_\3>\n<\/task>$/;

function unwrapTaskOutput(raw: string | undefined): { text: string; taskId?: string; isError?: boolean } {
  if (!raw) return { text: '' };
  const m = TASK_OUTPUT_RE.exec(raw);
  if (!m) return { text: raw };
  return { text: m[4], taskId: m[1], isError: m[3] === 'error' };
}

function wrapTaskOutput(taskId: string, text: string, isError: boolean): string {
  const tag = isError ? 'task_error' : 'task_result';
  return `<task id="${taskId}" state="${isError ? 'error' : 'completed'}">\n<${tag}>\n${text}\n</${tag}>\n</task>`;
}

function fileFromPart(p: Record<string, unknown>): ContentBlock | undefined {
  const out: FileBlock = { type: 'file' };
  if (typeof p.filename === 'string' && p.filename) out.filename = p.filename;
  if (typeof p.mime === 'string' && p.mime) out.mediaType = p.mime;
  if (typeof p.url === 'string' && p.url) out.url = p.url;
  else if (typeof p.data === 'string' && p.data) out.data = p.data;
  return out.filename || out.mediaType || out.url || out.data ? out : undefined;
}

/* ------------------------------------------------------------------ */
/* Tool mapping: DSH (Claude-style) -> OpenCode                        */
/* ------------------------------------------------------------------ */

/**
 * The TUI dispatches tool parts by EXACT name (packages/tui
 * routes/session/index.tsx `toolDisplays`) and renders per-tool components
 * that read OpenCode's input keys. DSH uses Claude-style names/keys
 * ("Read" + `file_path`), so without this mapping every read/write/edit part
 * renders as a pending placeholder ("~ Reading file...").
 */
const OPENCODE_TOOL_NAMES = new Set([
  'bash', 'glob', 'read', 'grep', 'webfetch', 'websearch', 'write', 'edit',
  'task', 'apply_patch', 'todowrite', 'question', 'skill', 'execute',
]);
const TOOL_NAME_MAP: Record<string, string> = {
  read: 'read', write: 'write', edit: 'edit', multiedit: 'edit', bash: 'bash',
  grep: 'grep', glob: 'glob', webfetch: 'webfetch', websearch: 'websearch',
  task: 'task', todowrite: 'todowrite', todo_write: 'todowrite', todoread: 'todoread',
  notebookedit: 'edit', applypatch: 'apply_patch',
};

/** Input key renames per tool (Claude-style -> OpenCode-style). */
const FILE_PATH_TOOLS = new Set(['read', 'write', 'edit']);

function mapToolPart(tool: string, input: Record<string, unknown>, output: string | undefined): {
  tool: string;
  input: Record<string, unknown>;
  metadata: Record<string, unknown>;
  title: string;
} {
  const lower = tool.toLowerCase();
  const name = TOOL_NAME_MAP[lower] ?? (OPENCODE_TOOL_NAMES.has(lower) ? lower : lower);

  const mapped: Record<string, unknown> = { ...input };
  if (FILE_PATH_TOOLS.has(name)) {
    if (typeof mapped.file_path === 'string') { mapped.filePath = mapped.file_path; delete mapped.file_path; }
    else if (typeof mapped.path === 'string' && name === 'read' && typeof mapped.filePath !== 'string') {
      // some DSH variants pass `path`
      mapped.filePath = mapped.path;
    }
  }

  const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
  const filePath = str(mapped.filePath ?? mapped.file_path);

  // Per-tool state.title (production convention) + metadata the renderers use.
  let title = name;
  const metadata: Record<string, unknown> = {};
  switch (name) {
    case 'read':
      title = filePath;
      if (filePath) metadata.loaded = [filePath];
      break;
    case 'write':
    case 'edit':
      title = filePath;
      break;
    case 'bash':
      title = str(mapped.command).slice(0, 200);
      // The TUI renders the output block from metadata.output.
      if (output) metadata.output = output;
      break;
    case 'grep':
    case 'glob':
      title = str(mapped.pattern);
      break;
    case 'webfetch':
      title = str(mapped.url);
      break;
    case 'websearch':
      title = str(mapped.query);
      break;
    case 'task':
      title = str(mapped.description);
      break;
    case 'todowrite': {
      // TodoWrite renders the list block from metadata.todos ({status, content}).
      title = '# Todos';
      if (Array.isArray(mapped.todos)) metadata.todos = mapped.todos;
      break;
    }
    default:
      title = name;
  }
  if (!title) title = name;
  return { tool: name, input: mapped, metadata, title };
}

/* ------------------------------------------------------------------ */
/* Write: IR -> message/part rows                                      */
/* ------------------------------------------------------------------ */

const zeroTokens = { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

interface WriteShared {
  db: DbHandle;
  now: number;
  dir: string;
  path: { cwd: string; root: string };
  modelID: string;
  providerID: string;
  keepSynthetic: boolean;
  /** The TUI renders assistant content ONLY inside step boundaries. */
  snapshot: string;
  newMsgId(time: number): string;
  /** Part ids must sort in insertion order: MessageV2.hydrate() orders parts
   *  by id STRING, so a shared zero-padded counter keeps step-start first and
   *  step-finish last across the whole write (main + child sessions). */
  newPartId(time: number): string;
}

function makeWriteShared(db: DbHandle, opts: { now: number; dir: string; modelID: string; providerID: string; keepSynthetic: boolean }): WriteShared {
  let partCounter = 0;
  const idRand = (n: number): string => randomUUID().replace(/-/g, '').slice(0, n);
  const hexTime = (time: number): string => time.toString(16).padStart(10, '0');
  return {
    db,
    now: opts.now,
    dir: opts.dir,
    path: { cwd: opts.dir, root: opts.dir },
    modelID: opts.modelID,
    providerID: opts.providerID,
    keepSynthetic: opts.keepSynthetic,
    snapshot: '0'.repeat(40),
    newMsgId: (time) => `msg_${hexTime(time)}${idRand(14)}`,
    newPartId: (time) => `prt_${hexTime(time)}${String(partCounter++).padStart(4, '0')}${idRand(10)}`,
  };
}

function filePartFromBlock(b: Extract<ContentBlock, { type: 'file' }>): Record<string, unknown> {
  const fp: Record<string, unknown> = { type: 'file' };
  if (b.filename) fp.filename = b.filename;
  if (b.mediaType) fp.mime = b.mediaType;
  if (b.url) fp.url = b.url;
  else if (b.data) fp.url = `data:${b.mediaType ?? 'application/octet-stream'};base64,${b.data}`;
  return fp;
}

/**
 * Write an array of IR messages into ONE session's message/part rows.
 * Shared by the main session and every reconstructed child session.
 */
function writeMessages(
  scope: WriteShared,
  sessionRowId: string,
  messages: MigratedMessage[],
  opts: {
    compaction?: MigratedCompaction[];
    resolveTask?: (callId: string, input: Record<string, unknown>) => { childId: string } | undefined;
  } = {},
): void {
  const { db, now, path, modelID, providerID, keepSynthetic, snapshot } = scope;
  const insertMessage = (id: string, time: number, data: Record<string, unknown>): void => {
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(id, sessionRowId, time, now, JSON.stringify(data));
  };
  const insertPart = (messageId: string, data: Record<string, unknown>, time: number): void => {
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(scope.newPartId(time), messageId, sessionRowId, time, now, JSON.stringify(data));
  };

  // Pair tool-role IR messages into the preceding assistant's tool parts
  // (opencode stores tool output inside the part, not as separate rows).
  const pendingToolOutput = new Map<string, { text: string; isError?: boolean; raw?: unknown }>();
  const consumedToolMsgs = new Set<number>();
  messages.forEach((m, idx) => {
    if (m.role !== 'tool') return;
    for (const b of m.content) {
      if (b.type === 'tool_result' && b.toolUseId) {
        const prev = pendingToolOutput.get(b.toolUseId);
        pendingToolOutput.set(b.toolUseId, prev
          ? { text: `${prev.text}\n${b.content}`, isError: prev.isError || b.isError, raw: prev.raw ?? b.rawResult }
          : { text: b.content, isError: b.isError, raw: b.rawResult });
        consumedToolMsgs.add(idx);
      }
    }
  });

  // Compaction checkpoints map to OpenCode's NATIVE compaction boundary: a
  // user message carrying a `compaction` part plus an assistant `summary: true`
  // message. The `auto` flag round-trips through the opencode namespace
  // (falling back to the DSH sourceCommandId rule for claude-sourced anchors).
  const compactionByAnchor = new Map<number, { summary: string; auto: boolean }>();
  for (const c of opts.compaction ?? []) {
    if (typeof c.anchorIndex !== 'number') continue;
    const anchor = messages[c.anchorIndex];
    if (!anchor) continue;
    const ocMeta = (c.meta as { opencode?: { auto?: unknown } } | undefined)?.opencode;
    const anchorOc = (anchor.meta as { opencode?: { auto?: unknown } } | undefined)?.opencode;
    const dshSource = (anchor.meta as { dsh?: { source?: Record<string, unknown> } } | undefined)?.dsh?.source;
    compactionByAnchor.set(c.anchorIndex, {
      summary: c.summary,
      auto: typeof ocMeta?.auto === 'boolean' ? ocMeta.auto
        : typeof anchorOc?.auto === 'boolean' ? anchorOc.auto
        : !(dshSource && typeof dshSource.sourceCommandId === 'string'),
    });
  }

  // The TUI rebuilds the conversation as a TREE rooted at each user message:
  // every assistant step of a turn carries parentID = that turn's user id
  // (verified against real v1.18 rows — assistant messages never chain to
  // another assistant). A linear chain renders as a blank session.
  let currentUserId: string | undefined;

  messages.forEach((m, idx) => {
    if (consumedToolMsgs.has(idx) && m.role === 'tool') return; // merged into tool part
    // A compaction ANCHOR is exempt from both gates below: pi v3.3's official
    // anchor shape is a `synthetic: true` user projection, and other sources
    // project it as system-role. The anchor is the canonical carrier of the
    // compressed conversation — dropping it (or skipping it as a system row)
    // would lose the whole summary. Checkpoint exemption precedent: the DSH
    // read side marks compaction checkpoints NOT synthetic for the same
    // reason (ir-protocol「checkpoint 识别速查」). Anchor priority > role gate.
    const isCompactionAnchor = compactionByAnchor.has(idx);
    if (m.role === 'system' && !isCompactionAnchor) return; // system prompts are opencode config, not chat rows
    // Harness-injected messages (DSH runtime context / <system-reminder>):
    // default drop — OpenCode manages its own runtime context. With
    // keepSynthetic, keep them but write text parts `ignored: true` so the
    // TUI hides them (index.tsx) AND toModelMessagesEffect skips them on
    // LLM replay — lossless storage without polluting the model context.
    if (m.synthetic && !keepSynthetic && !isCompactionAnchor) return;
    const time = m.timestamp ?? now;
    const id = scope.newMsgId(time);

    if (m.role === 'user' || m.role === 'developer') {
      // developer (v3.1) degrades to a visible user row here — OpenCode has no
      // developer channel, and falling through to the assistant branch below
      // would put the text in the model's own mouth. system stays dropped.
      // Compaction checkpoint -> boundary pair (native OpenCode semantics).
      // tail_start_id is intentionally NOT re-emitted: message ids are
      // regenerated on write and a preserved source id would dangle — the
      // app recomputes it on the session's next compaction.
      if (compactionByAnchor.has(idx)) {
        const entry = compactionByAnchor.get(idx)!;
        const boundaryData: Record<string, unknown> = {
          role: 'user',
          time: { created: time },
          agent: 'build',
          model: { providerID, modelID },
          summary: { diffs: [] },
        };
        insertMessage(id, time, boundaryData);
        insertPart(id, { type: 'compaction', auto: entry.auto }, time);
        currentUserId = id;
        // summary assistant parented to the boundary user (message-v2.ts
        // filterCompacted: info.summary && info.finish && parentID match)
        const summaryId = scope.newMsgId(time + 1);
        const summaryData: Record<string, unknown> = {
          parentID: id,
          role: 'assistant',
          mode: 'compaction',
          agent: 'compaction',
          path,
          cost: 0,
          tokens: zeroTokens,
          modelID,
          providerID,
          time: { created: time + 1, completed: time + 1 },
          finish: 'stop',
          summary: true,
        };
        insertMessage(summaryId, time + 1, summaryData);
        insertPart(summaryId, { type: 'step-start', snapshot }, time + 1);
        insertPart(summaryId, { type: 'text', text: entry.summary }, time + 1);
        insertPart(summaryId, { type: 'step-finish', reason: 'stop', snapshot, tokens: zeroTokens, cost: 0 }, time + 1);
        return;
      }
      const data: Record<string, unknown> = {
        role: 'user',
        time: { created: time },
        agent: 'build',
        model: { providerID, modelID },
        summary: { diffs: [] },
      };
      insertMessage(id, time, data);
      for (const b of m.content) {
        if (b.type === 'text') insertPart(id, { type: 'text', text: b.text, ignored: m.synthetic ? true : undefined, synthetic: m.synthetic ? true : undefined }, time);
        else if (b.type === 'file') insertPart(id, filePartFromBlock(b), time);
      }
      currentUserId = id;
      return;
    }

    if (m.role === 'tool') {
      // Orphan tool result (no matching tool_use): emit as a user text row so
      // the content is not lost.
      const text = m.content.filter((b) => b.type === 'tool_result').map((b) => (b as { content: string }).content).join('\n');
      if (!text) return;
      const data: Record<string, unknown> = {
        role: 'user',
        time: { created: time },
        agent: 'build',
        model: { providerID, modelID },
        summary: { diffs: [] },
      };
      insertMessage(id, time, data);
      insertPart(id, { type: 'text', text: `[tool result] ${text}` }, time);
      return;
    }

    // assistant
    const hasToolCall = m.content.some((b) => b.type === 'tool_use');
    const data: Record<string, unknown> = {
      ...(currentUserId ? { parentID: currentUserId } : {}),
      role: 'assistant',
      mode: 'build',
      agent: 'build',
      path,
      cost: 0,
      tokens: zeroTokens,
      modelID,
      providerID,
      time: { created: time, completed: time },
      finish: hasToolCall ? 'tool-calls' : 'stop',
    };
    insertMessage(id, time, data);
    insertPart(id, { type: 'step-start', snapshot }, time);
    for (const b of m.content) {
      if (b.type === 'thinking') {
        // The IR does not carry per-block thinking durations (DSH streams
        // reasoning chunks without per-chunk wall-clock). Synthesize a
        // plausible span from text length (~200 chars/s streaming rate) so
        // the TUI shows "Thought · Ns" instead of 0s.
        const durMs = Math.min(600_000, Math.max(1_000, Math.round(b.thinking.length / 200) * 1000));
        insertPart(id, { type: 'reasoning', text: b.thinking, time: { start: time, end: time + durMs } }, time);
      }
      else if (b.type === 'text') insertPart(id, { type: 'text', text: b.text }, time);
      else if (b.type === 'file') insertPart(id, filePartFromBlock(b), time);
      else if (b.type === 'tool_use') {
        const outInfo = pendingToolOutput.get(b.id);
        const mappedTool = mapToolPart(b.name, (b.input ?? {}) as Record<string, unknown>, outInfo?.text);
        let output = outInfo?.text ?? '';
        let metadata = mappedTool.metadata;
        const isTask = mappedTool.tool === 'task' || String(b.name).toLowerCase() === 'task';
        let taskChildId: string | undefined;
        if (isTask) {
          const child = opts.resolveTask?.(b.id, mappedTool.input);
          if (child) {
            taskChildId = child.childId;
            // Native task-part linkage: metadata.sessionId points at the
            // reconstructed child session row; the output re-wraps in
            // renderOutput format with the NEW child id (the source wrapper,
            // kept as rawResult upstream, references the OLD session id).
            metadata = {
              parentSessionId: sessionRowId,
              sessionId: child.childId,
              model: { modelID, providerID },
              truncated: false,
            };
          }
        }
        // Native ToolState union (schema v1/session.ts): completed REQUIRES
        // output/title/metadata; error carries `error`; pending is
        // {status,input,raw}. A call without any IR result must NOT be
        // fabricated as completed+'' — that would re-parse into a phantom
        // empty tool_result and drift the transcript on every round-trip.
        let state: Record<string, unknown>;
        if (!outInfo) {
          state = { status: 'pending', input: mappedTool.input, raw: '' };
        } else if (outInfo.isError) {
          state = {
            status: 'error',
            input: mappedTool.input,
            error: isTask && taskChildId ? wrapTaskOutput(taskChildId, unwrapTaskOutput(output).text, true) : output,
            ...(isTask && taskChildId ? { metadata } : {}),
            time: { start: time, end: time },
          };
        } else {
          if (isTask && taskChildId) output = wrapTaskOutput(taskChildId, unwrapTaskOutput(output).text, false);
          state = {
            status: 'completed',
            title: mappedTool.title,
            input: mappedTool.input,
            output,
            metadata,
            time: { start: time, end: time },
          };
        }
        insertPart(id, { type: 'tool', tool: mappedTool.tool, callID: b.id, state }, time);
      }
    }
    insertPart(id, {
      type: 'step-finish',
      reason: hasToolCall ? 'tool-calls' : 'stop',
      snapshot,
      tokens: zeroTokens,
      cost: 0,
    }, time);
  });
}

/** Map a source subagent type onto OpenCode's lowercase agent vocabulary. */
function mapAgentType(agentType?: string): string | null {
  const t = (agentType ?? '').trim().toLowerCase();
  if (!t) return null;
  return t === 'general-purpose' ? 'general' : t;
}

function firstUserText(messages: MigratedMessage[]): string {
  const u = messages.find((m) => m.role === 'user');
  if (!u) return '';
  return u.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function matchByPrompt(input: Record<string, unknown>, queue: MigratedSidechain[]): MigratedSidechain | undefined {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (!prompt) return undefined;
  return queue.find((sc) => firstUserText(sc.messages) === prompt);
}

/**
 * Write an IR session into the REAL v1.18 schema: project + session +
 * message + part. No silent error swallowing — a failed insert throws.
 *
 * Sidechains (flatten=false, the hidden-semantics path): every sidechain
 * becomes a native CHILD SESSION row (session.parent_id) whose transcript is
 * written in full, and the matching task tool part in the parent gets
 * state.metadata.sessionId pointing at it — the exact shape opencode's own
 * task tool produces. Sidechains no task call claims are still written as
 * standalone child sessions so the transcript survives. Matching order:
 * meta.opencode.callId → agentId → first-user-prompt equality → FIFO (the
 * zcode adapter's proven chain).
 */
function writeToDb(db: DbHandle, ir: MigratedSession, newId: string, cwd: string, flatten: boolean, keepSynthetic: boolean): string {
  const now = Date.now();
  const dir = fwdSlash(cwd || '/');
  // Attach to the app's own project row when present, else 'global' (the
  // convention every production session row uses), else create one.
  ensureGlobalProject(db);
  const projectId = resolveProjectRow(db, dir);
  // session.path mirrors the app's sessionPath(worktree, cwd) — worktree
  // relative, '' at the worktree root (real-store sampled shape).
  const worktree = resolveWorktree(cwd || '/');
  const pathCol = sessionPathColumn(worktree, cwd || '/');

  const modelID = ir.model?.id ?? 'glm-5.3-flash';
  const providerID = ir.model?.provider ?? 'opencode';
  const scope = makeWriteShared(db, { now, dir, modelID, providerID, keepSynthetic });

  const insertSessionRow = (p: { id: string; parentId?: string; title: string; agent?: string | null; createdAt: number }): void => {
    const slug = `migrated-${p.id.replace(/[^a-z0-9]/gi, '').slice(-10).toLowerCase()}`;
    db.prepare(
      'INSERT INTO session (id, project_id, workspace_id, parent_id, slug, directory, path, title, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, metadata, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, revert, permission, agent, model, time_created, time_updated, time_compacting, time_archived) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 0, 0, 0, 0, NULL, NULL, ?, NULL, ?, ?, NULL, NULL)',
    ).run(p.id, projectId, p.parentId ?? null, slug, dir, pathCol, p.title, OPENCODE_APP_VERSION, p.agent ?? null, p.createdAt, now);
  };

  const freshSessionId = (): string => {
    for (let i = 0; i < 8; i++) {
      const id = `ses_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      if (!db.prepare('SELECT 1 AS x FROM session WHERE id=?').get(id)) return id;
    }
    return `ses_${randomUUID().replace(/-/g, '').slice(0, 24)}${now.toString(36)}`;
  };

  const created = new Map<MigratedSidechain, string>();
  const buildMatcher = (sidechains: MigratedSidechain[], parentRowId: string): {
    resolve: (callId: string, input: Record<string, unknown>) => { childId: string } | undefined;
    drain: () => void;
  } => {
    const queue = [...sidechains];
    const byKey = new Map<string, MigratedSidechain>();
    for (const sc of queue) {
      const oc = (sc.meta as { opencode?: { callId?: unknown } } | undefined)?.opencode;
      if (oc && typeof oc.callId === 'string' && oc.callId) byKey.set(oc.callId, sc);
      if (sc.agentId) byKey.set(sc.agentId, sc);
    }
    const ensureChildSession = (sc: MigratedSidechain): string => {
      const have = created.get(sc);
      if (have) return have;
      const childId = freshSessionId();
      const firstTs = sc.messages.find((m) => typeof m.timestamp === 'number' && m.timestamp)?.timestamp;
      insertSessionRow({
        id: childId,
        parentId: parentRowId,
        title: sc.title ?? (sc.agentType ? `${sc.agentType} (subagent)` : 'subagent (migrated)'),
        agent: mapAgentType(sc.agentType),
        createdAt: sc.createdAt ?? firstTs ?? now,
      });
      created.set(sc, childId);
      // nested delegation tree: the child's own task calls resolve against
      // its sidechains, creating grandchild session rows under it.
      const nested = buildMatcher(sc.sidechains ?? [], childId);
      writeMessages(scope, childId, sc.messages, { compaction: sc.compaction, resolveTask: sc.sidechains?.length ? nested.resolve : undefined });
      nested.drain();
      return childId;
    };
    const resolve = (callId: string, input: Record<string, unknown>): { childId: string } | undefined => {
      const linked = byKey.get(callId);
      const sc = (linked && queue.includes(linked) ? linked : undefined)
        ?? matchByPrompt(input, queue)
        ?? queue[0];
      if (!sc) return undefined;
      const at = queue.indexOf(sc);
      if (at >= 0) queue.splice(at, 1);
      return { childId: ensureChildSession(sc) };
    };
    const drain = (): void => {
      while (queue.length) ensureChildSession(queue.shift()!);
    };
    return { resolve, drain };
  };

  insertSessionRow({ id: newId, title: ir.title ?? '(migrated)', createdAt: ir.createdAt ?? now });

  if (flatten) {
    // 展平为顶层消息: sidechain transcripts are appended to the MAIN session's
    // timeline with fresh monotonic timestamps (the message table is read in
    // time_created order — original sub-session times would interleave back
    // into earlier turns). This view is intentionally lossy on re-parse.
    writeMessages(scope, newId, ir.messages, { compaction: ir.compaction });
    let t = now;
    for (const m of ir.messages) {
      if (typeof m.timestamp === 'number' && m.timestamp > t) t = m.timestamp;
    }
    t += 1;
    for (const sc of ir.sidechains ?? []) {
      writeMessages(scope, newId, sc.messages.map((m) => ({ ...m, timestamp: t++ })), { compaction: sc.compaction });
    }
  } else {
    const matcher = buildMatcher(ir.sidechains ?? [], newId);
    writeMessages(scope, newId, ir.messages, { compaction: ir.compaction, resolveTask: (ir.sidechains ?? []).length ? matcher.resolve : undefined });
    matcher.drain();
  }
  return newId;
}

/* ------------------------------------------------------------------ */
/* Mirror helpers (JSONL hermetic fallback)                              */
/* ------------------------------------------------------------------ */

const MIRROR_MESSAGE_ROLES = new Set(['user', 'assistant', 'tool', 'system', 'developer']);

function opencodeMessageFromMigrated(msg: MigratedMessage): Record<string, unknown> {
  // keep tool/developer roles verbatim so a mirror round-trip stays lossless
  // (older mirrors folded tool into system — new mirrors no longer do).
  return { type: MIRROR_MESSAGE_ROLES.has(msg.role) ? msg.role : 'system', content: msg.content, timestamp: msg.timestamp };
}

async function parseFromMirror(mirrorPath: string): Promise<MigratedSession> {
  const text = await fs.readFile(mirrorPath, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim());
  const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const header = records.find((r) => r.type === 'mirror-header') as { id?: string; cwd?: string; title?: string; createdAt?: number; model?: unknown } | undefined;
  const msgs = records.filter((r) => r.type !== 'mirror-header' && r.type !== 'mirror-sidechain').map((r) => {
    const role = (MIRROR_MESSAGE_ROLES.has(String(r.type)) ? String(r.type) : 'system') as MigratedMessage['role'];
    const content = normalizeContent((Array.isArray(r.content) ? r.content : []) as unknown[]);
    const ts = typeof r.timestamp === 'number' ? r.timestamp : undefined;
    return { role, content, timestamp: ts } as MigratedMessage;
  });

  // sidechains are encoded as records with type 'mirror-sidechain'
  const scRecs = records.filter((r) => r.type === 'mirror-sidechain') as Array<{ agentId: string; kind: string; agentType?: string; messages: unknown[] }>;
  const sidechains: MigratedSidechain[] | undefined = scRecs.length
    ? scRecs.map((r) => ({
        agentId: String(r.agentId ?? ''),
        kind: (r.kind === 'teammate' ? 'teammate' : 'subagent') as MigratedSidechain['kind'],
        agentType: r.agentType ? String(r.agentType) : undefined,
        messages: Array.isArray(r.messages) ? (r.messages as Array<{ role: string; content: unknown[]; timestamp?: number }>).map((m) => ({ role: (m.role as MigratedMessage['role']) ?? 'assistant', content: normalizeContent(m.content as unknown[]), timestamp: m.timestamp })) : [],
      }))
    : undefined;

  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'opencode',
    originSessionId: header?.id,
    cwd: header?.cwd,
    title: header?.title,
    createdAt: header?.createdAt,
    model: header?.model as MigratedSession['model'],
    messages: msgs,
  };
  if (sidechains?.length) ir.sidechains = sidechains;
  return validateSession(ir);
}

/**
 * The mirror is the lossless IR dump (sidechains stay sidechain records
 * regardless of flatten) — flatten only changes native DB reconstruction.
 */
async function writeToMirror(mirrorPath: string, ir: MigratedSession, newId: string, cwd: string, _flatten: boolean): Promise<void> {
  const header = { type: 'mirror-header', id: newId, cwd, title: ir.title, createdAt: ir.createdAt ?? Date.now(), model: ir.model };
  const lines: string[] = [JSON.stringify(header)];
  for (const msg of ir.messages) {
    lines.push(JSON.stringify(opencodeMessageFromMigrated(msg)));
  }
  for (const sc of ir.sidechains ?? []) {
    lines.push(JSON.stringify({ type: 'mirror-sidechain', agentId: sc.agentId, kind: sc.kind, agentType: sc.agentType, messages: sc.messages }));
  }
  await fs.writeFile(mirrorPath, lines.join('\n') + '\n', 'utf8');
}
