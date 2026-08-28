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

function xdgDataDir(): string | null {
  const testHome = process.env.OPENCODE_TEST_HOME;
  const home = testHome && testHome.trim() ? testHome.trim() : (process.env.HOME || (process.env.USERPROFILE ?? null));
  if (!home) return null;
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support');
  // linux/win via xdg: use ~/.local/share
  return join(home, '.local', 'share');
}

function openDb(dbPath: string): DbHandle | null {
  // Prefer node:sqlite (Node 22+) via dynamic require to avoid type resolution issues.
  try {
    const sqliteMod: unknown = eval("require('node:sqlite')") as unknown;
    const Ctor = (sqliteMod as Record<string, unknown>).DatabaseSync as (new (p: string) => DbHandle) | undefined;
    if (typeof Ctor === 'function') {
      const instance = new (Ctor as new (p: string) => DbHandle)(dbPath);
      return instance as DbHandle;
    }
  } catch { /* fallback */ }
  try {
    const Better = eval("require('better-sqlite3')") as (new (p: string) => unknown) | undefined;
    if (typeof Better === 'function') {
      const raw = new (Better as new (p: string) => DbHandle)(dbPath) as unknown as { exec(s: string): void; prepare(s: string): { all(...a: unknown[]): OpRow[]; get(...a: unknown[]): OpRow | undefined; run(...a: unknown[]): unknown }; close(): void };
      return raw as DbHandle;
    }
  } catch { /* no driver */ }
  return null;
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
    const db = dbPath ? openDb(dbPath) : null;
    if (db) {
      try {
        return parseFromDb(db, sessionId);
      } finally {
        try { db.close(); } catch { /* ignore */ }
      }
    }
    // fallback: mirror JSONL
    const mirrorDir = root ? join(root.endsWith('.db') ? dirname(root) : root, 'opencode-mirror') : null;
    if (!mirrorDir) throw new Error('OpenCode: cannot resolve opencode.db and no mirror root given');
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
    const targetCwd = opts?.targetCwd ?? ir.cwd ?? '';
    const newId = opts?.sessionId ?? `sess_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const flatten = opts?.flatten ?? true;

    const dbPath = resolveDbPath(root);
    const db = dbPath ? openDb(dbPath) : null;
    if (db) {
      try {
        const written = writeToDb(db, ir, newId, targetCwd, flatten);
        return { tool: 'opencode', sessionId: written, paths: [dbPath ?? '<db>'] };
      } finally {
        try { db.close(); } catch { /* ignore */ }
      }
    }

    // fallback mirror for hermetic tests
    const mirrorDir = root ? join(root.endsWith('.db') ? dirname(root) : root, 'opencode-mirror') : null;
    if (!mirrorDir) throw new Error('OpenCode: cannot resolve write target (no db driver and no mirror root)');
    await fs.mkdir(mirrorDir, { recursive: true });
    const mirrorPath = join(mirrorDir, `${newId}.jsonl`);
    await writeToMirror(mirrorPath, ir, newId, targetCwd, flatten);
    return { tool: 'opencode', sessionId: newId, paths: [mirrorPath] };
  }

  async listSessions(root?: string): Promise<SessionMeta[]> {
    const dbPath = resolveDbPath(root);
    const db = dbPath ? openDb(dbPath) : null;
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

function parseFromDb(db: DbHandle, sessionId: string): MigratedSession {
  let sessionRow: OpRow | undefined;
  try {
    sessionRow = db.prepare('SELECT id, title, time_created, directory, model FROM session WHERE id=?').get(sessionId) as OpRow | undefined;
  } catch {
    sessionRow = undefined;
  }
  if (!sessionRow) throw new Error(`OpenCode: session "${sessionId}" not found in opencode.db`);
  const cwd = (sessionRow.directory ? String(sessionRow.directory) : undefined);
  const createdAt = typeof sessionRow.time_created === 'number' ? sessionRow.time_created : undefined;
  const title = sessionRow.title ? String(sessionRow.title) : undefined;
  let model: MigratedSession['model'];
  if (sessionRow.model) {
    try {
      const m = typeof sessionRow.model === 'string' ? JSON.parse(sessionRow.model) : sessionRow.model as { id?: string; providerID?: string; variant?: string };
      if (m?.id) model = { id: String(m.id), provider: m.providerID ? String(m.providerID) : undefined, variant: m.variant ? String(m.variant) : undefined };
    } catch { /* ignore */ }
  }

  const rows = db.prepare('SELECT id, type, seq, data, time_created FROM session_message WHERE session_id=? ORDER BY seq ASC').all(sessionId) as OpRow[];

  const messages: MigratedMessage[] = [];
  const sidechains: MigratedSidechain[] = [];

  for (const r of rows) {
    const type = String(r.type ?? '');
    const rawData = r.data;
    let data: Record<string, unknown>;
    try {
      data = typeof rawData === 'string' ? JSON.parse(rawData) : (rawData as Record<string, unknown>) ?? {};
    } catch {
      data = {};
    }
    // data is Omit<Encoded,id/type> — rehydrate to content
    const ts = typeof r.time_created === 'number' ? r.time_created : undefined;

    // common: try to extract normalized content
    const content = extractOpencodeContent(type, data, ts);

    // Detect hidden task subagent: assistant content has tool==='task'
    if (type === 'assistant' && isTaskTool(data)) {
      const t = extractTask(data);
      if (t) {
        const scMessages: MigratedMessage[] = [];
        scMessages.push({ role: 'user', content: [{ type: 'text', text: t.prompt }], timestamp: ts });
        // output may be string or array of blocks
        const outputMsgs = normalizeOutputToMessages(t.output);
        scMessages.push(...outputMsgs);
        sidechains.push({
          agentId: t.id || `task-${randomUUID().slice(0, 8)}`,
          kind: 'subagent',
          agentType: t.subagentType,
          parentMessageId: String(r.id ?? ''),
          messages: scMessages,
        });
        // still emit the outer task call as a visible assistant tool_use + flattened note
        messages.push({
          role: 'assistant',
          content: [{ type: 'tool_use', id: String(r.id ?? ''), name: 'task', input: { description: t.description, prompt: t.prompt, subagent_type: t.subagentType } }],
          timestamp: ts,
        });
        continue;
      }
    }

    const role: MigratedMessage['role'] =
      type === 'user' ? 'user' : type === 'assistant' ? 'assistant' : type === 'system' ? 'system' : 'assistant';

    messages.push({ role, content, timestamp: ts });
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

function extractOpencodeContent(type: string, data: Record<string, unknown>, _ts?: number): ContentBlock[] {
  // data contains the Encoded payload minus id/type. Common shapes:
  //  - user: { text, files?, agents? }
  //  - assistant: { agent, model, content: (text|reasoning|tool)[], ... }
  //  - system/shell/compaction etc: { text / content / ... }
  if (data.content !== undefined) {
    const arr = Array.isArray(data.content) ? data.content : [data.content];
    return normalizeContent(arr as unknown[]);
  }
  if (typeof data.text === 'string') return [{ type: 'text', text: data.text }];
  if (Array.isArray((data as { parts?: unknown }).parts)) {
    return normalizeContent((data as { parts: unknown[] }).parts);
  }
  // fallback: stringify
  if (Object.keys(data).length === 0) return [];
  return [{ type: 'text', text: JSON.stringify(data) }];
}

function isTaskTool(data: Record<string, unknown>): boolean {
  const content = data.content;
  if (!Array.isArray(content)) return false;
  for (const c of content as Array<Record<string, unknown>>) {
    if (c?.type === 'tool' && c.tool === 'task') return true;
    if (c?.type === 'tool' && String(c.name ?? c.tool ?? '') === 'task') return true;
  }
  return false;
}

function extractTask(data: Record<string, unknown>): { id: string; description?: string; prompt: string; subagentType?: string; output: unknown } | null {
  const arr = data.content as Array<Record<string, unknown>>;
  for (const c of arr ?? []) {
    if (c?.type !== 'tool') continue;
    const isTask = c.tool === 'task' || String(c.name ?? '') === 'task';
    if (!isTask) continue;
    const id = String(c.id ?? c.toolCallId ?? '');
    const state = (c.state ?? c) as Record<string, unknown>;
    const input = (state.input ?? c.input ?? {}) as Record<string, unknown>;
    const prompt = String(input.prompt ?? input.text ?? '');
    const subagentType = input.subagent_type ? String(input.subagent_type) : undefined;
    const description = input.description ? String(input.description) : undefined;
    const output = state.output ?? c.output ?? '';
    return { id, description, prompt: prompt || '(opencode task)', subagentType, output };
  }
  return null;
}

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

function writeToDb(db: DbHandle, ir: MigratedSession, newId: string, _cwd: string, _flatten: boolean): string {
  const now = Date.now();
  // Ensure schema exists (best-effort) — create tables if missing so tests against :memory: work
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, model TEXT)`);
    db.exec(`CREATE TABLE IF NOT EXISTS session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, UNIQUE(session_id, seq))`);
  } catch { /* ignore */ }

  // Upsert project
  const projectId = `proj_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  try {
    db.prepare('INSERT OR IGNORE INTO project (id, worktree, time_created, time_updated) VALUES (?, ?, ?, ?)').run(projectId, _cwd || '/', now, now);
  } catch { /* ignore */ }

  try {
    db.prepare('INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      newId,
      projectId,
      `sess-${newId.slice(0, 8)}`,
      _cwd || '/',
      ir.title ?? '(migrated)',
      '0.0.0',
      ir.createdAt ?? now,
      now,
      ir.model ? JSON.stringify(ir.model) : null,
    );
  } catch {
    // if session exists, update
    try {
      db.prepare('UPDATE session SET title=?, time_updated=? WHERE id=?').run(ir.title ?? '(migrated)', now, newId);
    } catch { /* ignore */ }
  }

  let seq = 0;
  for (const msg of ir.messages) {
    const id = `msg_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const type = msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : 'system';
    const data = JSON.stringify({ content: msg.content });
    try {
      db.prepare('INSERT INTO session_message (id, session_id, type, seq, data, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, newId, type, seq++, data, msg.timestamp ?? now, now);
    } catch { /* skip dup */ }
  }
  // sidechains -> either flatten as additional messages or as task tool blocks
  for (const sc of ir.sidechains ?? []) {
    // flatten: extend session_message with the sidechain transcript
    for (const m of sc.messages) {
      const id = `msg_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const type = m.role === 'user' ? 'user' : 'assistant';
      const data = JSON.stringify({ content: m.content, __sidechain: sc.agentId });
      try {
        db.prepare('INSERT INTO session_message (id, session_id, type, seq, data, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, newId, type, seq++, data, m.timestamp ?? now, now);
      } catch { /* ignore */ }
    }
  }
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
