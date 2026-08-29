/**
 * OpenCode adapter — reads/writes the canonical `opencode.db` SQLite store.
 *
 * Source-anchored from `opencode-dev`:
 *  - DB path: packages/core/src/database/database.ts:43 `path()` — xdgData/opencode/opencode.db
 *    with channel isolation + $OPENCODE_DB / $OPENCODE_TEST_HOME overrides (global.ts:18).
 *  - Schema: packages/core/src/database/schema.gen.ts + src/session/sql.ts
 *    Authority is `session_message` ordered table; storage/*.json is v1-legacy.
 *  - History: src/session/history.ts SessionHistory.load / loadForRunner (compaction-aware).
 *
 * This adapter:
 *  - Opens SQLite with Node's `node:sqlite` (Node 22.12+: `DatabaseSync`), falling back to
 *    `better-sqlite3` if present, otherwise degrades to file-mirror mode for test portability.
 *  - On parse: SELECT session + session_message WHERE session_id=? ORDER BY seq ASC, decodes
 *    each row's data (Omit<Encoded,id/type>) + type/id into MigratedMessage[], and extracts
 *    `assistant.tool==='task'` nested transcripts into MigratedSidechain[] (flatten for
 *    interactive targets).
 *  - On write: transactional INSERT into project + session + session_message (seq 0..N-1,
 *    id=msg_...), seq/unique handling, and sidechain flatten/pmapped back.
 *  - When no real opencode.db exists (tests with --root <tmp>`), falls back to a JSONL
 *    mirror at `<root>/opencode-mirror/<sessionId>.jsonl` so tests remain hermetic and
 *    do not require better-sqlite3.
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Adapter, WriteOptions, WriteResult } from '../../registry.js';
import type { ContentBlock, MigratedMessage, MigratedSession, MigratedSidechain, SessionMeta } from '../../ir.js';
import { validateSession } from '../../ir.js';
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

function mirrorDirFor(root: string | undefined): string | null {
  if (!root) return null;
  const t = root.endsWith('.db') ? dirname(root) : root;
  return join(t, 'opencode-mirror');
}

export class OpenCodeAdapter implements Adapter {
  readonly tool = 'opencode' as const;

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
          const written = writeToDb(db, ir, newId, targetCwd, flatten, opts?.keepSynthetic ?? false);
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
      if (db) {
        try {
          const rows = db.prepare('SELECT id, title, time_created, directory FROM session ORDER BY time_created DESC').all() as OpRow[];
          return rows.map((r) => ({
            tool: 'opencode' as const,
            sessionId: String(r.id ?? ''),
            title: r.title ? String(r.title) : undefined,
            createdAt: typeof r.time_created === 'number' ? r.time_created : undefined,
            cwd: r.directory ? String(r.directory) : undefined,
            sourcePath: dbPath ?? undefined,
          }));
        } catch {
          return [];
        } finally {
          try { db.close(); } catch { /* ignore */ }
        }
      }
    }
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
 *  - part data types: text{text} | reasoning{text} | tool{tool,callID,
 *    state:{status,input,output,time}} | step-start | step-finish | patch | ...
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

function parseFromDb(db: DbHandle, sessionId: string): MigratedSession {
  let sessionRow: OpRow | undefined;
  try {
    sessionRow = db.prepare('SELECT id, title, time_created, directory, version FROM session WHERE id=?').get(sessionId) as OpRow | undefined;
  } catch {
    sessionRow = undefined;
  }
  if (!sessionRow) throw new Error(`OpenCode: session "${sessionId}" not found in opencode.db`);
  const cwd = sessionRow.directory ? String(sessionRow.directory) : undefined;
  const createdAt = typeof sessionRow.time_created === 'number' ? sessionRow.time_created : undefined;
  const title = sessionRow.title ? String(sessionRow.title) : undefined;

  const msgRows = db.prepare('SELECT id, data, time_created, time_updated FROM message WHERE session_id=? ORDER BY time_created ASC, rowid ASC').all(sessionId) as OpRow[];
  const partRows = db.prepare('SELECT message_id, data FROM part WHERE session_id=? ORDER BY rowid ASC').all(sessionId) as OpRow[];
  const partsByMessage = new Map<string, Array<Record<string, unknown>>>();
  for (const pr of partRows) {
    let d: Record<string, unknown>;
    try { d = typeof pr.data === 'string' ? JSON.parse(pr.data) : (pr.data as Record<string, unknown>) ?? {}; } catch { continue; }
    const key = String(pr.message_id ?? '');
    const list = partsByMessage.get(key) ?? [];
    list.push(d);
    partsByMessage.set(key, list);
  }

  const messages: MigratedMessage[] = [];
  const sidechains: MigratedSidechain[] = [];
  let model: MigratedSession['model'];

  for (const r of msgRows) {
    let data: Record<string, unknown>;
    try { data = typeof r.data === 'string' ? JSON.parse(r.data) : (r.data as Record<string, unknown>) ?? {}; } catch { data = {}; }
    const role = String(data.role ?? 'assistant') as MigratedMessage['role'];
    const ts = typeof r.time_created === 'number' ? r.time_created : undefined;
    const parts = partsByMessage.get(String(r.id ?? '')) ?? [];

    if (role === 'user') {
      const content: ContentBlock[] = [];
      for (const p of parts) {
        if (p.type === 'text' && typeof p.text === 'string') content.push({ type: 'text', text: p.text });
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
      } else if (p.type === 'tool') {
        const callID = String(p.callID ?? randomUUID());
        const state = (p.state ?? {}) as Record<string, unknown>;
        const input = (state.input ?? {}) as Record<string, unknown>;
        content.push({ type: 'tool_use', id: callID, name: String(p.tool ?? 'tool'), input });
        // opencode stores tool output inside the part — re-emit as IR tool_result
        if (state.output !== undefined && state.output !== null) {
          const outText = typeof state.output === 'string' ? state.output : JSON.stringify(state.output);
          toolResults.push({ role: 'tool', content: [{ type: 'tool_result', toolUseId: callID, content: outText }], timestamp: ts });
        }
        // hidden task subagent: flatten the transcript into a sidechain
        if (String(p.tool ?? '') === 'task') {
          const taskInput = input as Record<string, unknown>;
          const out = state.output;
          if (out !== undefined && out !== null) {
            const scMessages: MigratedMessage[] = [
              { role: 'user', content: [{ type: 'text', text: String(taskInput.prompt ?? taskInput.description ?? '(task)') }], timestamp: ts },
              ...normalizeOutputToMessages(out),
            ];
            sidechains.push({
              agentId: callID,
              kind: 'subagent',
              agentType: typeof taskInput.subagent_type === 'string' ? taskInput.subagent_type : undefined,
              parentMessageId: String(r.id ?? ''),
              messages: scMessages,
            });
          }
        }
      }
      // step-start / step-finish / patch / file / compaction: structural metadata, skipped
    }
    if (content.length) {
      messages.push({ role: 'assistant', content, timestamp: ts, provider: typeof data.providerID === 'string' ? data.providerID : undefined, model: typeof data.modelID === 'string' ? data.modelID : undefined });
      messages.push(...toolResults);
    }
  }

  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'opencode',
    originSessionId: String(sessionRow.id ?? sessionId),
    title,
    createdAt,
    cwd,
    model,
    messages,
  };
  if (sidechains.length) ir.sidechains = sidechains;
  return validateSession(ir);
}

/** Convert an opencode task tool output into IR messages (for sidechains). */
function normalizeOutputToMessages(output: unknown): MigratedMessage[] {
  if (typeof output === 'string') {
    return [{ role: 'assistant', content: [{ type: 'text', text: output }] }];
  }
  if (Array.isArray(output)) {
    return [{ role: 'assistant', content: normalizeContent(output as unknown[]) }];
  }
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    if (typeof o.text === 'string') return [{ role: 'assistant', content: [{ type: 'text', text: o.text }] }];
    return [{ role: 'assistant', content: [{ type: 'text', text: JSON.stringify(o) }] }];
  }
  return [];
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

/**
 * Write an IR session into the REAL v1.18 schema: project + session +
 * message + part. No silent error swallowing — a failed insert throws.
 */
function writeToDb(db: DbHandle, ir: MigratedSession, newId: string, cwd: string, _flatten: boolean, keepSynthetic: boolean): string {
  const now = Date.now();
  const dir = fwdSlash(cwd || '/');
  // Attach to the app's own project row when present, else 'global' (the
  // convention every production session row uses), else create one.
  ensureGlobalProject(db);
  const projectId = resolveProjectRow(db, dir);

  db.prepare(
    'INSERT INTO session (id, project_id, workspace_id, parent_id, slug, directory, path, title, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, metadata, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, revert, permission, agent, model, time_created, time_updated, time_compacting, time_archived) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)',
  ).run(
    newId,
    projectId,
    `migrated-${newId.replace(/[^a-z0-9]/gi, '').slice(-10).toLowerCase()}`,
    dir,
    dir,
    ir.title ?? '(migrated)',
    OPENCODE_APP_VERSION,
    ir.createdAt ?? now,
    now,
  );

  const modelID = ir.model?.id ?? 'glm-5.3-flash';
  const providerID = ir.model?.provider ?? 'opencode';
  const path = { cwd: dir, root: dir };
  const zeroTokens = { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  // The TUI renders assistant content ONLY inside step boundaries: every real
  // assistant message opens with a step-start part and closes with a
  // step-finish part (reason + tokens + cost + snapshot). Without them the
  // conversation renders blank even though storage reads back fine.
  const snapshot = '0'.repeat(40);

  // Pair tool-role IR messages into the preceding assistant's tool parts
  // (opencode stores tool output inside the part, not as separate rows).
  const pendingToolOutput = new Map<string, string>();
  const consumedToolMsgs = new Set<number>();
  ir.messages.forEach((m, idx) => {
    if (m.role !== 'tool') return;
    for (const b of m.content) {
      if (b.type === 'tool_result' && b.toolUseId) {
        const prev = pendingToolOutput.get(b.toolUseId);
        pendingToolOutput.set(b.toolUseId, prev ? `${prev}\n${b.content}` : b.content);
        consumedToolMsgs.add(idx);
      }
    }
  });

  // The TUI rebuilds the conversation as a TREE rooted at each user message:
  // every assistant step of a turn carries parentID = that turn's user id
  // (verified against real v1.18 rows — assistant messages never chain to
  // another assistant). A linear chain renders as a blank session.
  let currentUserId: string | undefined;
  // Part ids must sort in insertion order: MessageV2.hydrate() orders parts by
  // id STRING, so a per-message zero-padded sequence suffix keeps step-start
  // first and step-finish last.
  let partCounter = 0;
  const idRand = (n: number): string => randomUUID().replace(/-/g, '').slice(0, n);
  const newMsgId = (time: number): string => `msg_${time.toString(16).padStart(10, '0')}${idRand(14)}`;
  const newPartId = (time: number): string => `prt_${time.toString(16).padStart(10, '0')}${String(partCounter++).padStart(4, '0')}${idRand(10)}`;
  const insertPart = (messageId: string, data: Record<string, unknown>, time: number): void => {
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(
      newPartId(time), messageId, newId, time, now, JSON.stringify(data),
    );
  };

  // DSH compaction checkpoints (IR gap #3 bucket) map to OpenCode's NATIVE
  // compaction boundary: a user message carrying a `compaction` part plus an
  // assistant `summary: true` message. OpenCode keeps the shadowed
  // pre-compaction messages in storage but filterCompacted() excludes them
  // from model replay — exactly DSH's "原文还在日志里,模型只见摘要+后文".
  const compactionByAnchor = new Map<number, { summary: string; auto: boolean }>();
  for (const [i, c] of (ir.compaction ?? []).entries()) {
    if (typeof c.anchorIndex !== 'number') continue;
    const anchor = ir.messages[c.anchorIndex];
    const nativeSource = (anchor?.meta as { dsh?: { source?: Record<string, unknown> } } | undefined)?.dsh?.source;
    compactionByAnchor.set(c.anchorIndex, {
      summary: c.summary,
      auto: !(nativeSource && typeof nativeSource.sourceCommandId === 'string'),
    });
  }

  ir.messages.forEach((m, idx) => {
    if (consumedToolMsgs.has(idx) && m.role === 'tool') return; // merged into tool part
    if (m.role === 'system') return; // system prompts are opencode config, not chat rows
    // Harness-injected messages (DSH runtime context / <system-reminder>):
    // default drop — OpenCode manages its own runtime context. With
    // keepSynthetic, keep them but write text parts `ignored: true` so the
    // TUI hides them (index.tsx) AND toModelMessagesEffect skips them on
    // LLM replay — lossless storage without polluting the model context.
    if (m.synthetic && !keepSynthetic) return;
    const time = m.timestamp ?? now;
    const id = newMsgId(time);

    if (m.role === 'user') {
      // Compaction checkpoint -> boundary pair (native OpenCode semantics).
      if (compactionByAnchor.has(idx)) {
        const entry = compactionByAnchor.get(idx)!;
        const boundaryData: Record<string, unknown> = {
          role: 'user',
          time: { created: time },
          agent: 'build',
          model: { providerID, modelID },
          summary: { diffs: [] },
        };
        db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
          id, newId, time, now, JSON.stringify(boundaryData),
        );
        insertPart(id, { type: 'compaction', auto: entry.auto }, time);
        currentUserId = id;
        // summary assistant parented to the boundary user (message-v2.ts
        // filterCompacted: info.summary && info.finish && parentID match)
        const summaryId = newMsgId(time + 1);
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
        db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
          summaryId, newId, time + 1, now, JSON.stringify(summaryData),
        );
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
      db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
        id, newId, time, now, JSON.stringify(data),
      );
      for (const b of m.content) {
        if (b.type === 'text') insertPart(id, { type: 'text', text: b.text, ignored: m.synthetic ? true : undefined, synthetic: m.synthetic ? true : undefined }, time);
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
      db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
        id, newId, time, now, JSON.stringify(data),
      );
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
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
      id, newId, time, now, JSON.stringify(data),
    );
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
      else if (b.type === 'tool_use') {
        const output = pendingToolOutput.get(b.id);
        const mappedTool = mapToolPart(b.name, (b.input ?? {}) as Record<string, unknown>, output);
        // ToolStateCompleted schema: output, title and metadata are REQUIRED
        // fields; a part missing any of them fails the API part union and the
        // conversation renders blank.
        insertPart(id, {
          type: 'tool',
          tool: mappedTool.tool,
          callID: b.id,
          state: {
            status: 'completed',
            title: mappedTool.title,
            input: mappedTool.input,
            output: output ?? '',
            metadata: mappedTool.metadata,
            time: { start: time, end: time },
          },
        }, time);
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
  return newId;
}

/* ------------------------------------------------------------------ */
/* Mirror helpers (JSONL hermetic fallback)                              */
/* ------------------------------------------------------------------ */

function opencodeMessageFromMigrated(msg: MigratedMessage): Record<string, unknown> {
  const type = msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : 'system';
  return { type, content: msg.content, timestamp: msg.timestamp };
}

async function parseFromMirror(mirrorPath: string): Promise<MigratedSession> {
  const text = await fs.readFile(mirrorPath, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim());
  const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const header = records.find((r) => r.type === 'mirror-header') as { id?: string; cwd?: string; title?: string; createdAt?: number; model?: unknown } | undefined;
  const msgs = records.filter((r) => r.type !== 'mirror-header').map((r) => {
    const role = (r.type === 'user' ? 'user' : r.type === 'assistant' ? 'assistant' : 'system') as MigratedMessage['role'];
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

// sidechain helper unused externally
void existsSync;
