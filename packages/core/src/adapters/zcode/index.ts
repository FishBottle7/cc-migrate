/**
 * ZCode adapter — reads/writes the canonical `~/.zcode/cli/db/db.sqlite` (live WAL SQLite).
 *
 * Source-anchored from the engine bundle reverse-engineering in `docs/agents/zcode.md`:
 *  - Authority is the SQLite store; there are NO per-session transcript files.
 *    Three tables matter: `session` (metadata incl. `revert` JSON), `message`
 *    (role-discriminated `data` JSON + per-session `sequence` 0..N-1), `part`
 *    (type-discriminated `data` JSON + per-message `sequence`).
 *  - Message order is `sequence` only — `parentID` is NOT a tree to walk
 *    (multiple assistants share one parent; spec alignment pitfall #6).
 *  - `session.revert` (conversation rewind): pruned messages stay physically in
 *    the DB; the active branch is derived by the engine's `o0()` — this adapter
 *    reimplements it, otherwise rewound conversations get migrated (pitfall #13).
 *  - user messages are classified by `data.semantics` (D2 policy): only
 *    `origin==='real_user'` is real input; compaction-summary user messages are
 *    projected INTO messages[] (marked by `meta.zcode`, so write-back restores
 *    their native shape) and registered in IR `compaction[]` with an
 *    `anchorIndex` into messages[] (gap #3); todo_reminder/background_task
 *    & co are model-only synthetics (→ extensions, never `messages[]`).
 *  - a `tool` part fuses call+result in one row (4-state). It is split by
 *    `callID` into IR `tool_use` + following role:'tool' `tool_result`;
 *    `state.status==='error'` uses `state.error` (isError:true); pending/running
 *    states are not projected into messages (a tool_use without result would
 *    break provider replay) but ALL four states are recorded losslessly in the
 *    IR `toolCalls` typed bucket and re-injected on write-back.
 *    `state.input` may be a JSON string (older engine writes) or an object.
 *  - reasoning parts carry their anthropic signature directly on the IR
 *    thinking block (`signature`), so claude-target resume keeps signed
 *    thinking (gap #1). Message-level native payload (semantics/cost/tokens/
 *    time/anchor/contextSnapshot + every non-projected part row verbatim)
 *    lives on `msg.meta.zcode` — attached to the message entity, never a
 *    source-id side-table (gap #2); write-back consumes it to restore the
 *    native rows exactly.
 *  - `providerID` is the provider-registry id (uuid or `builtin:*`); the
 *    readable name lives in `~/.zcode/v2/config.json` `provider.<id>.name` —
 *    that file also contains apiKeys, so only `name` is ever read and raw ids
 *    are kept in extensions (pitfall #2 + secret ban).
 *  - subagent children: `sess_subagent_agent_<uuid>` rows with
 *    `task_type='subagent_child'` + `parent_id` are the reliable cold link
 *    (pitfall #12); sidecar `~/.zcode/cli/agents/<parent>/agent_<uuid>/metadata.json`
 *    supplements agentId/systemPrompt/usage/parentToolUseId. Write-back
 *    additionally rewrites the engine's launch-acknowledgement footer in the
 *    Agent tool output (`agentId: agent_<uuid> …`) — the cold-read derivation
 *    prefers that line over `state.metadata.agentId`, so a stale uuid would
 *    re-bind the migrated part to the SOURCE child session.
 *  - write-back is a direct 3-table INSERT (spec「构造可 resume 会话」):
 *    `sess_<uuid>` / `msg_<base36>_<uuid>` / `part_<base36>_<uuid>` /
 *    `call_<hex>`, contiguous sequences, ms timestamps, `version:'0.16.3'`,
 *    `permission:'{"mode":"build"}'`, `slug=id`, `project_id=proj_<dir slug>`.
 *    Verified against the engine's official `app-server --stdio` NDJSON path
 *    (session/list + resume + messages + subagents) — see zcode.md round-trip.
 *  - `part.data` fields are a superset of the bundle zod schemas (pitfall #8):
 *    parsing is tolerant, unknown fields are preserved (in `meta.zcode.rawParts`
 *    per message / extensions for whole dropped rows).
 *  - IR `systemPrompt` is never read (engine injects it per agent profile at
 *    runtime; only sidecar snapshots have it → extensions) and never written.
 *
 * Root semantics (mirrors the OpenCode adapter):
 *  - `root` ending in `.sqlite`/`.db` → that exact file
 *  - `root` a directory → `<root>/cli/db/db.sqlite` (a ZCODE_HOME-shaped tree)
 *  - no root → `$ZCODE_SESSION_DB_PATH` / `$ZCODE_SESSION_DB` → `$ZCODE_HOME` → `~/.zcode`
 *
 * Safety: the live WAL store is opened read-only on read (with a physical
 * db+wal+shm copy fallback). On write, when the target file does not exist and
 * an explicit root/env override was given, the sandbox is bootstrapped from a
 * consistent `VACUUM INTO` snapshot of the live db (keeps the engine's 18
 * migrations); the default real location is never auto-created.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Adapter, WriteOptions, WriteResult } from '../../registry.js';
import type {
  ContentBlock,
  FileBlock,
  MigratedMessage,
  MigratedSession,
  MigratedSidechain,
  MigratedToolCall,
  SessionMeta,
} from '../../ir.js';
import { validateSession } from '../../ir.js';
import { blocksToText } from '../../content.js';

/* ------------------------------------------------------------------ */
/* Native row / payload shapes (permissive — pitfall #8)               */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

interface ZcodeSemantics {
  origin?: string;
  kind?: string;
  source?: string;
  uiVisibility?: string;
  providerVisibility?: string;
  transcriptVisibility?: string;
  [k: string]: unknown;
}

interface ZcodeUserData {
  role: 'user';
  time?: { created?: number };
  agent?: string;
  model?: { providerID?: string; modelID?: string; variant?: string };
  semantics?: ZcodeSemantics;
  anchor?: Record<string, unknown>;
  tools?: Record<string, unknown>;
  contextSnapshot?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  synthetic?: boolean;
  source?: string;
  visibility?: string;
  summary?: { title?: string; body?: string; diffs?: unknown };
  [k: string]: unknown;
}

interface ZcodeAssistantData {
  role: 'assistant';
  time?: { created?: number; completed?: number };
  parentID?: string;
  modelID?: string;
  providerID?: string;
  variant?: string;
  mode?: string;
  agent?: string;
  path?: { cwd?: string; root?: string };
  cost?: number;
  tokens?: Record<string, unknown>;
  finish?: string | null;
  summary?: boolean;
  error?: unknown;
  semantics?: ZcodeSemantics;
  [k: string]: unknown;
}

interface ZcodeToolPart {
  type: 'tool';
  callID?: string;
  tool?: string;
  state?: {
    status?: 'pending' | 'running' | 'completed' | 'error';
    input?: unknown;
    output?: unknown;
    title?: string;
    metadata?: Record<string, unknown>;
    error?: unknown;
    time?: Record<string, unknown>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

interface ZcodeRevert {
  kind?: string;
  scope?: string;
  targetMessageID?: string;
  messageID?: string;
  createdMessageID?: string;
  branchCutAfterMessageID?: string;
  branchGeneration?: number;
  keptMessageIDs?: string[];
  [k: string]: unknown;
}

interface SidecarMeta {
  agentId?: string;
  childSessionId?: string;
  parentSessionId?: string;
  parentToolUseId?: string;
  profileId?: string;
  profileSnapshot?: { name?: string; description?: string; systemPrompt?: string; tools?: unknown };
  prompt?: string;
  status?: string;
  usage?: Record<string, unknown>;
  [k: string]: unknown;
}

/** DB-level message row (data not yet parsed). */
interface ZcodeMessageRow {
  id: string;
  sequence: number | null;
  time_created: number | null;
  data: string;
}

interface ZcodePartRow {
  id: string;
  message_id: string;
  sequence: number | null;
  time_created: number | null;
  data: string;
}

/* ------------------------------------------------------------------ */
/* Path resolution                                                     */
/* ------------------------------------------------------------------ */

const DB_REL = join('cli', 'db', 'db.sqlite');
/** Engine version the write-back shape was protocol-verified against (zcode.md round-trip). */
const ENGINE_VERSION = '0.16.3';
const DEFAULT_PERMISSION = '{"mode":"build"}';

function zcodeHome(): string {
  const env = process.env.ZCODE_HOME;
  if (env && env.trim()) return env.trim();
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(home, '.zcode');
}

function isDbFilePath(t: string): boolean {
  return t.endsWith('.sqlite') || t.endsWith('.db');
}

function resolveDbPath(root?: string): string | null {
  if (root && root.trim()) {
    const t = root.trim();
    if (isDbFilePath(t)) return t;
    // a ZCODE_HOME-shaped dir; also accept a dir that directly holds db.sqlite
    return join(t, DB_REL);
  }
  const envDb = process.env.ZCODE_SESSION_DB_PATH || process.env.ZCODE_SESSION_DB;
  if (envDb && envDb.trim()) return envDb.trim();
  return join(zcodeHome(), DB_REL);
}

/** `<home>/v2/config.json` — provider registry (contains apiKeys: never dumped). */
function resolveConfigPath(root?: string): string {
  if (root && root.trim()) {
    const t = root.trim();
    if (isDbFilePath(t)) return join(dirname(dirname(dirname(t))), 'v2', 'config.json');
    return join(t, 'v2', 'config.json');
  }
  return join(zcodeHome(), 'v2', 'config.json');
}

function resolveAgentsRoot(root?: string): string {
  if (root && root.trim()) {
    const t = root.trim();
    if (isDbFilePath(t)) return join(dirname(dirname(dirname(t))), 'cli', 'agents');
    return join(t, 'cli', 'agents');
  }
  return join(zcodeHome(), 'cli', 'agents');
}

/* ------------------------------------------------------------------ */
/* SQLite open (node:sqlite → better-sqlite3), read-only safe          */
/* ------------------------------------------------------------------ */

interface DbHandle {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...args: unknown[]): Row[];
    get(...args: unknown[]): Row | undefined;
    run(...args: unknown[]): unknown;
  };
  close(): void;
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

function openDbSync(dbPath: string, readOnly: boolean): DbHandle | null {
  const open = (Ctor: new (p: string, opts?: unknown) => DbHandle, opts: Record<string, unknown>): DbHandle | null => {
    try { return new Ctor(dbPath, opts); } catch { return null; }
  };
  if (__sqliteCtor) return open(__sqliteCtor, readOnly ? { readOnly: true } : {});
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createRequire } = require('node:module') as unknown as { createRequire(p: string): (id: string) => unknown };
    const req = createRequire(import.meta.url);
    const mod = req('node:sqlite') as Record<string, unknown>;
    const Ctor = mod.DatabaseSync as (new (p: string, opts?: unknown) => DbHandle) | undefined;
    if (typeof Ctor === 'function') {
      __sqliteCtor = Ctor as unknown as new (p: string, opts?: unknown) => DbHandle;
      return open(__sqliteCtor, readOnly ? { readOnly: true } : {});
    }
  } catch { /* not available sync */ }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createRequire } = require('node:module') as unknown as { createRequire(p: string): (id: string) => unknown };
    const req2 = createRequire(import.meta.url);
    const Better = req2('better-sqlite3') as (new (p: string, opts?: unknown) => unknown) | undefined;
    if (typeof Better === 'function') {
      const Ctor = Better as unknown as new (p: string, opts?: unknown) => DbHandle;
      return open(Ctor, readOnly ? { readonly: true, fileMustExist: true } : {});
    }
  } catch { /* no driver */ }
  return null;
}

async function openDb(dbPath: string, readOnly: boolean): Promise<DbHandle | null> {
  const Ctor = await getSqliteCtor();
  if (Ctor) {
    try { return new Ctor(dbPath, readOnly ? { readOnly: true } : {}); } catch { /* busy/locked */ }
  }
  return openDbSync(dbPath, readOnly);
}

/**
 * Open the live WAL store read-only. If a read-only handle is refused
 * (locked shm / sandboxed volume), fall back to a consistent physical copy of
 * db + `-wal` + `-shm` in a temp dir and open the copy (spec pitfall #10).
 */
async function openLiveReadOnly(dbPath: string): Promise<{ db: DbHandle; dbPath: string } | null> {
  const direct = await openDb(dbPath, true);
  if (direct) return { db: direct, dbPath };
  const copyDir = join(tmpdir(), `zcode-readonly-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`);
  try {
    await fs.mkdir(copyDir, { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) {
      const src = dbPath + suffix;
      if (!existsSync(src)) continue;
      await fs.copyFile(src, join(copyDir, 'db.sqlite' + suffix));
    }
    const copyPath = join(copyDir, 'db.sqlite');
    const db = await openDb(copyPath, true);
    if (db) return { db, dbPath: copyPath };
  } catch { /* fall through */ }
  return null;
}

/* ------------------------------------------------------------------ */
/* Small utils                                                         */
/* ------------------------------------------------------------------ */

function tryParse(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

function parseJsonObject(raw: unknown): Row {
  const v = tryParse(raw);
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v as Row : {};
}

function base36(n: number): string {
  return Math.max(0, Math.floor(n)).toString(36);
}

function freshCallId(): string {
  return `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/**
 * `proj_<dir lowercased, non-alphanumeric runs → '-'>` (spec「构造可 resume
 * 会话」). Runs collapse so `D:\proj` yields `proj_d-proj`, matching real rows.
 */
export function zcodeProjectId(directory: string): string {
  return 'proj_' + directory.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** zcode profile name (`zcode-Explore`) → agent type (`Explore`). */
function agentTypeOf(agent: string | undefined): string | undefined {
  if (!agent) return undefined;
  return agent.startsWith('zcode-') ? agent.slice('zcode-'.length) : agent;
}

function isSubagentToolName(name: string): boolean {
  return name === 'Agent' || name === 'Task' || name === 'subagent';
}

function looksLikeCallId(id: string): boolean {
  return /^call_\w{4,}$/.test(id);
}

/**
 * Provider-registry reader. Only `provider.<id>.name` is extracted — the file
 * also holds `options.apiKey`, which must never be read out or logged.
 */
async function readProviderRegistry(configPath: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const cfg = JSON.parse(raw) as { provider?: Record<string, { name?: unknown }> };
    const out: Record<string, string> = {};
    for (const [id, p] of Object.entries(cfg.provider ?? {})) {
      if (p && typeof p.name === 'string') out[id] = p.name;
    }
    return out;
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

export class ZcodeAdapter implements Adapter {
  readonly tool = 'zcode' as const;

  async parse(sessionId: string, root?: string): Promise<MigratedSession> {
    const dbPath = resolveDbPath(root);
    if (!dbPath || !existsSync(dbPath)) {
      throw new Error(`Zcode: session db not found at ${dbPath ?? '<unresolved>'} (pass --src-root pointing at a ZCode home or the db.sqlite file)`);
    }
    const opened = await openLiveReadOnly(dbPath);
    if (!opened) throw new Error(`Zcode: cannot open ${dbPath} read-only (live WAL locked and copy failed)`);
    try {
      return await parseFromDb(opened.db, sessionId, root);
    } finally {
      try { opened.db.close(); } catch { /* ignore */ }
    }
  }

  async listSessions(root?: string): Promise<SessionMeta[]> {
    const dbPath = resolveDbPath(root);
    if (!dbPath || !existsSync(dbPath)) return [];
    const opened = await openLiveReadOnly(dbPath);
    if (!opened) return [];
    try {
      const rows = opened.db.prepare(
        'SELECT id, title, time_created, directory FROM session ORDER BY time_created DESC',
      ).all() as Row[];
      return rows.map((r) => ({
        tool: 'zcode' as const,
        sessionId: String(r.id ?? ''),
        title: r.title ? String(r.title) : undefined,
        createdAt: typeof r.time_created === 'number' ? r.time_created : undefined,
        cwd: r.directory ? String(r.directory) : undefined,
        sourcePath: dbPath ?? undefined,
      }));
    } catch {
      return [];
    } finally {
      try { opened.db.close(); } catch { /* ignore */ }
    }
  }

  async write(ir: MigratedSession, opts?: WriteOptions): Promise<WriteResult> {
    validateSession(ir);
    const root = opts?.root;
    const targetCwd = opts?.targetCwd ?? ir.cwd ?? '';
    const newId = opts?.sessionId ?? `sess_${randomUUID()}`;
    const dbPath = resolveDbPath(root);
    if (!dbPath) throw new Error('Zcode: cannot resolve target db path (no root and no HOME)');

    const targetPinned = !!(root && root.trim()) ||
      !!(process.env.ZCODE_SESSION_DB_PATH || process.env.ZCODE_SESSION_DB);
    if (!existsSync(dbPath)) {
      if (!targetPinned) {
        throw new Error(
          `Zcode: target db ${dbPath} does not exist. ` +
          `Refusing to fabricate the real ZCode store — pass --dst-root <zcodeHome-shaped dir> (a sandbox copy is created) or snapshot the live db first.`,
        );
      }
      // Explicit sandbox root/env: bootstrap the session-store file. Prefer a
      // consistent VACUUM snapshot of the live db when one exists (keeps the
      // 18 engine migrations), else the minimal 3-table schema.
      await fs.mkdir(dirname(dbPath), { recursive: true });
      const liveDb = join(zcodeHome(), DB_REL);
      if (existsSync(liveDb)) {
        await snapshotLiveDb(liveDb, dbPath);
      } else {
        await createMinimalDb(dbPath);
      }
    }

    const db = await openDb(dbPath, false);
    if (!db) throw new Error(`Zcode: no sqlite driver available to write ${dbPath} (need node:sqlite on Node ≥22 or better-sqlite3)`);
    try {
      ensureMinimalSchema(db);
      let paths: string[];
      try {
        db.exec('BEGIN IMMEDIATE');
        paths = writeToDb(db, ir, newId, targetCwd);
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        const msg = String((e as Error)?.message ?? e);
        if (msg.includes('SQLITE_BUSY') || msg.includes('database is locked')) {
          throw new Error(`Zcode: ${dbPath} is locked (SQLITE_BUSY) — the ZCode app is mid-write. Retry, or write to a sandbox copy via --dst-root.`);
        }
        if (msg.includes('readonly database') || msg.includes('EPERM') || msg.includes('EACCES')) {
          throw new Error(`Zcode: ${dbPath} is not writable in this sandbox (EPERM/readonly). Run the CLI outside the sandbox or use --dst-root <tmpDir>.`);
        }
        throw e;
      }
      return { tool: 'zcode', sessionId: newId, paths };
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  }

  preview(session: MigratedSession): string {
    const main = session.messages.map((m) => `[${m.role}]\n${blocksToText(m.content)}`).join('\n\n');
    if (!session.sidechains?.length) return main;
    const sc = session.sidechains
      .map((s) => `[sidechain: ${s.agentId} (${s.kind}${s.agentType ? ` / ${s.agentType}` : ''})]\n${s.messages.map((m) => blocksToText(m.content)).join('\n')}`)
      .join('\n\n');
    return `${main}\n\n${sc}`;
  }
}

/* ------------------------------------------------------------------ */
/* Read pipeline                                                       */
/* ------------------------------------------------------------------ */

interface ParseCtx {
  providerNames: Record<string, string>;
  agentsRoot: string;
}

/**
 * Per-message native payload with no cross-tool IR slot → `msg.meta.zcode`
 * (gap #2 — attached to the message entity itself; write-back consumes it to
 * restore native rows). rawParts keeps every part row that has no block
 * projection verbatim (step/timeline/compaction/snapshot/agent/…).
 */
interface ZcodeMessageMeta {
  agent?: string;
  variant?: string;
  providerID?: string;
  modelID?: string;
  mode?: string;
  cost?: number;
  tokens?: Record<string, unknown>;
  finish?: string | null;
  time?: Record<string, unknown>;
  contextSnapshot?: Record<string, unknown>;
  tools?: Record<string, unknown>;
  anchor?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  semantics?: Record<string, unknown>;
  /** user compact-summary rows: {title, body, diffs} */
  summary?: Record<string, unknown>;
  /** origin row id — lets write-back/tooling correlate back to the source store */
  sourceId?: string;
  synthetic?: boolean;
  source?: string;
  visibility?: string;
  rawParts?: Array<{ sequence: number | null; data: Row }>;
  raw?: unknown;
}

interface ExpandedMessage {
  ir: MigratedMessage[];
  meta?: ZcodeMessageMeta;
  synthetic?: { id: string; sequence: number | null; data: Row };
  compaction?: { summary: string; sourceId: string };
  compactionParts?: Row[];
  toolCalls?: MigratedToolCall[];
  droppedToolState?: string;
}

async function parseFromDb(db: DbHandle, sessionId: string, root?: string): Promise<MigratedSession> {
  const sessionRow = db.prepare('SELECT * FROM session WHERE id=?').get(sessionId) as Row | undefined;
  if (!sessionRow) throw new Error(`Zcode: session "${sessionId}" not found in db`);
  const ctx: ParseCtx = {
    providerNames: await readProviderRegistry(resolveConfigPath(root)),
    agentsRoot: resolveAgentsRoot(root),
  };

  const messages = loadMessagesOrdered(db, sessionId);
  const partsByMessage = loadPartsByMessage(db, sessionId);

  // --- active-branch trim (engine o0()) — REQUIRED, see zcode.md rewind ---
  const revert = parseJsonObject(sessionRow.revert) as ZcodeRevert;
  const trimmed = o0Trim(messages, revert);

  const irMessages: MigratedMessage[] = [];
  const providerIdMap: Record<string, string> = {};   // raw providerID → readable name
  const syntheticMessages: Array<{ id: string; sequence: number | null; data: Row }> = [];
  const compactionParts: Row[] = [];        // assistant-hosted compaction part rows (for tokensBefore pairing)
  const summaryCandidates: Array<{ sourceId: string; summary: string }> = [];
  const summaryAnchors = new Map<string, number>();   // source summary row id → index in irMessages
  const toolCalls: MigratedToolCall[] = [];
  let lastModel: { providerID?: string; modelID?: string; variant?: string } | undefined;

  const ctx2: ExpandCtx = { ...ctx, providerIdMap };
  for (const m of trimmed.messages) {
    const parts = partsByMessage.get(m.id) ?? [];
    const exp = expandMessageRow(m, parts, ctx2);
    if (exp.compaction) summaryAnchors.set(exp.compaction.sourceId, irMessages.length);
    irMessages.push(...exp.ir);
    if (exp.synthetic) syntheticMessages.push(exp.synthetic);
    if (exp.toolCalls) toolCalls.push(...exp.toolCalls);
    if (exp.compactionParts) compactionParts.push(...exp.compactionParts);
    if (exp.compaction?.summary) summaryCandidates.push({ sourceId: exp.compaction.sourceId, summary: exp.compaction.summary });
    // session model = latest assistant model (model_change timelines are real)
    if (exp.ir[0]?.role === 'assistant' && exp.meta?.modelID) {
      lastModel = { providerID: exp.meta.providerID, modelID: exp.meta.modelID, variant: exp.meta.variant };
    }
  }

  // pair assistant-hosted compaction parts with their summary message
  // (summaryMessageId → preCompactTokenCount) to fill IR compaction[].tokensBefore
  const tokensBeforeBySummaryId = new Map<string, number>();
  for (const cp of compactionParts) {
    const sumId = typeof cp.summaryMessageId === 'string' ? cp.summaryMessageId : undefined;
    if (sumId && typeof cp.preCompactTokenCount === 'number') tokensBeforeBySummaryId.set(sumId, cp.preCompactTokenCount);
  }
  const compactions: NonNullable<MigratedSession['compaction']> = summaryCandidates.map((s) => ({
    summary: s.summary,
    ...(tokensBeforeBySummaryId.get(s.sourceId) !== undefined ? { tokensBefore: tokensBeforeBySummaryId.get(s.sourceId) } : {}),
    // gap #3: the summary message is projected in messages[]; anchorIndex points at it
    ...(summaryAnchors.has(s.sourceId) ? { anchorIndex: summaryAnchors.get(s.sourceId) } : {}),
  }));

  // --- subagent sidechains (parent_id + sess_subagent_agent_<uuid> = the reliable cold link) ---
  const { sidechains, agentLinks, otherChildren, sidecarPrompts } = await buildSidechains(db, sessionId, ctx2);

  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'zcode',
    originSessionId: String(sessionRow.id ?? sessionId),
    messages: irMessages,
  };
  if (sessionRow.title) ir.title = String(sessionRow.title);
  if (typeof sessionRow.time_created === 'number') ir.createdAt = sessionRow.time_created;
  if (sessionRow.directory) ir.cwd = String(sessionRow.directory);
  if (lastModel?.modelID) {
    ir.model = {
      ...(lastModel.providerID && providerIdMap[lastModel.providerID] ? { provider: providerIdMap[lastModel.providerID] } : {}),
      id: lastModel.modelID,
      ...(lastModel.variant ? { variant: lastModel.variant } : {}),
    };
  }
  if (sidechains.length) ir.sidechains = sidechains;
  if (compactions.length) ir.compaction = compactions;
  if (toolCalls.length) ir.toolCalls = toolCalls;

  // extensions (namespaced like 'dsh.headerRaw') — session-level lossless
  // buckets; per-message payload lives on msg.meta.zcode instead (gap #2)
  const extensions: Record<string, unknown> = {
    'zcode.session': {
      projectId: sessionRow.project_id ?? null,
      workspaceId: sessionRow.workspace_id ?? null,
      parentId: sessionRow.parent_id ?? null,
      slug: sessionRow.slug ?? null,
      path: sessionRow.path ?? null,
      version: sessionRow.version ?? null,
      permission: sessionRow.permission ?? null,
      taskType: sessionRow.task_type ?? null,
      titleSource: sessionRow.title_source ?? null,
      titleMessageId: sessionRow.title_message_id ?? null,
      timeUpdated: typeof sessionRow.time_updated === 'number' ? sessionRow.time_updated : null,
      revertRaw: Object.keys(revert).length ? revert : null,
    },
    'zcode.providers': providerIdMap,
  };
  if (syntheticMessages.length) extensions['zcode.syntheticMessages'] = syntheticMessages;
  if (trimmed.pruned.length) {
    extensions['zcode.prunedMessages'] = trimmed.pruned.map((m) => ({ id: m.id, sequence: m.sequence, data: parseJsonObject(m.data) }));
  }
  if (Object.keys(agentLinks).length) extensions['zcode.agentLinks'] = agentLinks;
  if (otherChildren.length) extensions['zcode.childSessions'] = otherChildren;
  if (Object.keys(sidecarPrompts).length) extensions['zcode.sidecars'] = sidecarPrompts;
  ir.extensions = extensions;

  return validateSession(ir);
}

interface ExpandCtx extends ParseCtx {
  /** collected raw providerID → name (written back into extensions). */
  providerIdMap: Record<string, string>;
}

function loadMessagesOrdered(db: DbHandle, sessionId: string): ZcodeMessageRow[] {
  const rows = db.prepare(
    'SELECT id, sequence, time_created, data FROM message WHERE session_id=? ORDER BY sequence IS NULL, sequence, time_created, rowid',
  ).all(sessionId) as Row[];
  return rows.map((r) => ({
    id: String(r.id ?? ''),
    sequence: typeof r.sequence === 'number' ? r.sequence : null,
    time_created: typeof r.time_created === 'number' ? r.time_created : null,
    data: String(r.data ?? '{}'),
  }));
}

function loadPartsByMessage(db: DbHandle, sessionId: string): Map<string, ZcodePartRow[]> {
  const rows = db.prepare(
    'SELECT id, message_id, sequence, time_created, data FROM part WHERE session_id=? ORDER BY sequence IS NULL, sequence, time_created, rowid',
  ).all(sessionId) as Row[];
  const out = new Map<string, ZcodePartRow[]>();
  for (const r of rows) {
    const mid = String(r.message_id ?? '');
    if (!mid) continue;
    const list = out.get(mid) ?? [];
    list.push({
      id: String(r.id ?? ''),
      message_id: mid,
      sequence: typeof r.sequence === 'number' ? r.sequence : null,
      time_created: typeof r.time_created === 'number' ? r.time_created : null,
      data: String(r.data ?? '{}'),
    });
    out.set(mid, list);
  }
  return out;
}

/**
 * Engine `o0()` branch trim (zcode.md「rewind 与活跃分支」): the DB layer
 * returns everything; the runtime slices the active branch from
 * `session.revert`. Parameter mapping is the engine's own (`eDi`):
 * `branchCutAfterMessageID` / `keptMessageIDs` / `targetMessageID` /
 * `createdMessageID`. The persisted JSON carries `messageID`, but the engine
 * only ever reads `createdMessageID` (an in-memory runtime field), so a
 * persisted `messageID` is deliberately NOT consumed here — engine-exact.
 * The appended tail is deduped against the base (whitelist ∩ after-cut is
 * empty in practice; duplicate ids would corrupt the replay).
 */
export function o0Trim(
  messages: ZcodeMessageRow[],
  revert: ZcodeRevert,
): { messages: ZcodeMessageRow[]; pruned: ZcodeMessageRow[] } {
  const target = typeof revert.targetMessageID === 'string' ? revert.targetMessageID : undefined;
  if (!target) return { messages, pruned: [] };
  const byId = new Map(messages.map((m) => [m.id, m]));
  const keptIds = new Set<string>();

  const whitelist = Array.isArray(revert.keptMessageIDs)
    ? revert.keptMessageIDs.filter((x): x is string => typeof x === 'string')
    : undefined;
  let base: ZcodeMessageRow[];
  if (whitelist) {
    base = whitelist.map((id) => byId.get(id)).filter((m): m is ZcodeMessageRow => !!m);
  } else {
    const targetIdx = messages.findIndex((m) => m.id === target);
    base = targetIdx >= 0 ? messages.slice(0, targetIdx) : messages.slice(); // target itself is NOT kept
  }
  for (const m of base) keptIds.add(m.id);

  const cut = typeof revert.branchCutAfterMessageID === 'string' ? revert.branchCutAfterMessageID : undefined;
  const created = typeof revert.createdMessageID === 'string' ? revert.createdMessageID : undefined;
  let tail: ZcodeMessageRow[] = [];
  if (cut) {
    const cutIdx = messages.findIndex((m) => m.id === cut);
    if (cutIdx >= 0) tail = messages.slice(cutIdx + 1);
  } else if (created) {
    const createdIdx = messages.findIndex((m) => m.id === created);
    if (createdIdx >= 0) tail = messages.slice(createdIdx);
  }
  const merged = [...base];
  for (const m of tail) {
    if (keptIds.has(m.id)) continue; // dedupe guard, see above
    keptIds.add(m.id);
    merged.push(m);
  }

  return { messages: merged, pruned: messages.filter((m) => !keptIds.has(m.id)) };
}

/**
 * D2 projection policy (zcode.md「回放投影 D2 决策表」), simplified by trusting
 * `data.semantics` — the fields the engine itself writes. Real user input and
 * provider-visible prompts become IR user messages; compact summaries go to
 * IR compaction[]; model-only synthetics (todo_reminder, background_task & co
 * — hidden from UI AND transcript, or explicitly synthetic) must NOT enter
 * messages[].
 */
type UserClass = 'realUserInput' | 'compactSummary' | 'synthetic' | 'timelineOnly';

export function classifyUserMessage(d: ZcodeUserData): UserClass {
  const sem = d.semantics ?? {};
  if (d.summary !== undefined || sem.kind === 'compact_summary') return 'compactSummary';
  if (sem.kind === 'timeline_event' || sem.kind === 'fork_notice') return 'timelineOnly';
  const modelOnly = d.synthetic === true
    || d.visibility === 'model-only'
    || (sem.uiVisibility === 'hidden' && sem.transcriptVisibility === 'hidden');
  if (modelOnly) return 'synthetic';
  if (sem.origin === 'real_user') return 'realUserInput';
  // provider-visible prompts that are not real keystrokes: the subagent child
  // session's prompt message (origin agent_runtime, kind user_prompt)
  if (sem.kind === 'user_prompt' || sem.kind === 'slash_command') return 'realUserInput';
  if (!sem.origin && !sem.kind) {
    // legacy rows without semantics (older engine versions)
    if (d.visibility === 'model-only' || d.synthetic || d.source === 'todo_reminder' || d.source === 'background_task') return 'synthetic';
    return 'realUserInput';
  }
  return 'synthetic';
}

/** Expand one native message row (+ its parts) into IR messages. */
function expandMessageRow(m: ZcodeMessageRow, parts: ZcodePartRow[], ctx: ExpandCtx): ExpandedMessage {
  const data = parseJsonObject(m.data) as ZcodeUserData | ZcodeAssistantData;
  const ts = (data.time && typeof data.time.created === 'number') ? data.time.created : (m.time_created ?? undefined);

  if (data.role === 'user') {
    const d = data as ZcodeUserData;
    const cls = classifyUserMessage(d);
    if (cls === 'compactSummary') {
      // gap #3: the summary IS a message — project it into messages[] (its
      // text part is exactly what the engine feeds the next context) and mark
      // it via meta.zcode so write-back restores the native summary row; the
      // IR compaction[] entry anchors to it by index.
      const { blocks, rawParts } = userPartsToBlocks(parts);
      const meta = zcodeMetaForUser(d);
      meta.sourceId = m.id;
      if (rawParts.length) meta.rawParts = rawParts;
      const body = typeof d.summary?.body === 'string' ? d.summary.body : '';
      const content: ContentBlock[] = blocks.length ? blocks : body ? [{ type: 'text', text: body }] : [];
      if (!content.length) return { ir: [], meta };
      const msg: MigratedMessage = { role: 'user', content, seq: m.sequence ?? undefined, meta: { zcode: meta } };
      if (ts !== undefined) msg.timestamp = ts;
      return { ir: [msg], meta, compaction: { summary: body, sourceId: m.id } };
    }
    if (cls !== 'realUserInput') {
      return { ir: [], synthetic: { id: m.id, sequence: m.sequence, data: d as Row } };
    }
    const { blocks, rawParts } = userPartsToBlocks(parts);
    if (!blocks.length) return { ir: [], synthetic: { id: m.id, sequence: m.sequence, data: d as Row } };
    const meta = zcodeMetaForUser(d);
    meta.sourceId = m.id;
    if (rawParts.length) meta.rawParts = rawParts;
    const msg: MigratedMessage = { role: 'user', content: blocks, seq: m.sequence ?? undefined, meta: { zcode: meta } };
    if (ts !== undefined) msg.timestamp = ts;
    if (d.model?.modelID) {
      msg.model = String(d.model.modelID);
      if (d.model.providerID) msg.provider = rememberProviderName(d.model.providerID, ctx);
    }
    return { ir: [msg], meta };
  }

  if (data.role === 'assistant') {
    const d = data as ZcodeAssistantData;
    const { blocks, toolResults, meta, compactionParts, toolCalls, droppedToolState } = assistantPartsToBlocks(
      parts, d, { messageId: m.id, messageSequence: m.sequence ?? -1 },
    );
    if (!blocks.length) {
      // no replayable projection (timeline-event carriers, failed compaction
      // hosts, …) — archive the raw row in the session-level bucket; only its
      // compaction parts (pairing channel) and tool records survive structured
      return {
        ir: [],
        meta,
        synthetic: { id: m.id, sequence: m.sequence, data: d as Row },
        compactionParts,
        toolCalls,
        droppedToolState,
      };
    }
    meta.sourceId = m.id;
    const msg: MigratedMessage = { role: 'assistant', content: blocks, seq: m.sequence ?? undefined, meta: { zcode: meta } };
    if (ts !== undefined) msg.timestamp = ts;
    if (d.modelID) msg.model = String(d.modelID);
    if (d.providerID) msg.provider = rememberProviderName(d.providerID, ctx);
    if (d.finish) msg.stopReason = String(d.finish);
    const out: MigratedMessage[] = [msg];
    if (toolResults.length) out.push({ role: 'tool', content: toolResults, seq: m.sequence ?? undefined, timestamp: ts });
    return { ir: out, meta, compactionParts, toolCalls, droppedToolState };
  }

  // unknown role — keep losslessly as synthetic
  return { ir: [], synthetic: { id: m.id, sequence: m.sequence, data: data as Row } };
}

/** Map a raw providerID to its registry name (fallback: the raw id itself). */
function rememberProviderName(providerId: string, ctx: ExpandCtx): string {
  const name = ctx.providerNames[providerId];
  ctx.providerIdMap[providerId] = name ?? providerId;
  return name ?? providerId;
}

/** user message `data` → msg.meta.zcode payload (gap #2). */
function zcodeMetaForUser(d: ZcodeUserData): ZcodeMessageMeta {
  const meta: ZcodeMessageMeta = {};
  if (d.agent) meta.agent = d.agent;
  if (d.model?.providerID) meta.providerID = d.model.providerID;
  if (d.model?.modelID) meta.modelID = d.model.modelID;
  if (d.model?.variant) meta.variant = d.model.variant;
  if (d.contextSnapshot) meta.contextSnapshot = d.contextSnapshot;
  if (d.tools) meta.tools = d.tools;
  if (d.anchor) meta.anchor = d.anchor;
  if (d.metadata) meta.metadata = d.metadata;
  if (d.semantics) meta.semantics = d.semantics as Row;
  if (d.summary) meta.summary = d.summary as Row;
  if (d.synthetic !== undefined) meta.synthetic = d.synthetic === true;
  if (d.source) meta.source = d.source;
  if (d.visibility) meta.visibility = d.visibility;
  return meta;
}

/** Read back the zcode namespace of a message's meta (write side). */
function zcodeMetaOf(msg: MigratedMessage): ZcodeMessageMeta | undefined {
  const z = (msg.meta as Record<string, unknown> | undefined)?.zcode;
  return (z && typeof z === 'object' && !Array.isArray(z)) ? z as ZcodeMessageMeta : undefined;
}

/** Append meta.zcode.rawParts (verbatim non-projected part rows) to a part list. */
function appendRawParts(parts: Array<{ data: Row; ts: number }>, zmeta: ZcodeMessageMeta | undefined, ts: number): void {
  const raw = [...(zmeta?.rawParts ?? [])]
    .sort((a, b) => (typeof a.sequence === 'number' ? a.sequence : Number.MAX_SAFE_INTEGER) - (typeof b.sequence === 'number' ? b.sequence : Number.MAX_SAFE_INTEGER));
  for (const rp of raw) {
    if (!rp.data || typeof rp.data !== 'object' || Array.isArray(rp.data)) continue;
    parts.push({ data: rp.data, ts });
  }
}

/**
 * user message parts → IR blocks + rawParts, using the engine's own replay
 * concatenation for the meaningful part types: text (non-ignored) → text,
 * file → FileBlock (image attachments included — gap #4), agent →
 * `[Selected agent: …]` (D2 layer rules) with the row kept in rawParts.
 * Everything else is engine bookkeeping → rawParts verbatim.
 */
function userPartsToBlocks(parts: ZcodePartRow[]): { blocks: ContentBlock[]; rawParts: Array<{ sequence: number | null; data: Row }> } {
  const blocks: ContentBlock[] = [];
  const rawParts: Array<{ sequence: number | null; data: Row }> = [];
  for (const p of parts) {
    const d = parseJsonObject(p.data);
    if (d.type === 'text') {
      if (d.ignored === true || d.synthetic === true) continue;
      if (typeof d.text === 'string' && d.text) blocks.push({ type: 'text', text: d.text });
    } else if (d.type === 'file') {
      const file: FileBlock = { type: 'file' };
      if (typeof d.filename === 'string') file.filename = d.filename;
      else if (typeof d.name === 'string') file.filename = d.name;
      if (typeof d.mime === 'string') file.mediaType = d.mime;
      if (typeof d.url === 'string') file.url = d.url;
      if (file.filename || file.mediaType || file.url) blocks.push(file);
      else rawParts.push({ sequence: p.sequence, data: d }); // no usable fields — keep raw
    } else if (d.type === 'agent') {
      blocks.push({ type: 'text', text: `[Selected agent: ${String(d.name ?? 'agent')}]` });
      rawParts.push({ sequence: p.sequence, data: d }); // the text is only the D2 rendering
    } else {
      rawParts.push({ sequence: p.sequence, data: d });
    }
  }
  return { blocks, rawParts };
}

/**
 * assistant message parts → IR blocks. `tool` parts split by callID into a
 * `tool_use` (kept on the assistant) + `tool_result` blocks (emitted as the
 * following role:'tool' IR message). completed → output; error →
 * state.error with isError:true; pending/running are NOT projected into
 * messages (a tool_use without result would break provider replay after
 * migration) but every invocation — all four states — is recorded losslessly
 * in the `toolCalls` bucket with its source position.
 */
function assistantPartsToBlocks(
  parts: ZcodePartRow[],
  d: ZcodeAssistantData,
  source: { messageId: string; messageSequence: number },
): { blocks: ContentBlock[]; toolResults: ContentBlock[]; meta: ZcodeMessageMeta; compactionParts?: Row[]; toolCalls?: MigratedToolCall[]; droppedToolState?: string } {
  const blocks: ContentBlock[] = [];
  const toolResults: ContentBlock[] = [];
  const meta: ZcodeMessageMeta = {};
  let compactionParts: Row[] | undefined;
  let toolCalls: MigratedToolCall[] | undefined;
  let droppedToolState: string | undefined;

  if (d.agent) meta.agent = d.agent;
  if (d.providerID) meta.providerID = d.providerID;
  if (d.modelID) meta.modelID = d.modelID;
  if (d.variant) meta.variant = d.variant;
  if (d.mode) meta.mode = d.mode;
  if (d.cost !== undefined) meta.cost = d.cost;
  if (d.tokens) meta.tokens = d.tokens;
  if (d.finish !== undefined) meta.finish = d.finish;
  if (d.time) meta.time = d.time;
  if (d.semantics) meta.semantics = d.semantics as Row;
  if (d.error !== undefined) meta.raw = { error: d.error };

  for (const p of parts) {
    const pd = parseJsonObject(p.data);
    switch (pd.type) {
      case 'text': {
        if (pd.ignored === true || pd.synthetic === true) break;
        if (typeof pd.text === 'string' && pd.text) blocks.push({ type: 'text', text: pd.text });
        break;
      }
      case 'reasoning': {
        // gap #1: the anthropic signature rides ON the thinking block, not in
        // a source-id side-table — claude-target write-back needs it
        const anth = parseJsonObject(parseJsonObject(pd.metadata).anthropic);
        const signature = typeof anth.signature === 'string' ? anth.signature : undefined;
        const text = typeof pd.text === 'string' ? pd.text : '';
        if (text || signature) {
          blocks.push(signature ? { type: 'thinking', thinking: text, signature } : { type: 'thinking', thinking: text });
        }
        break;
      }
      case 'tool': {
        const tool = pd as unknown as ZcodeToolPart;
        const callId = String(tool.callID ?? '');
        const name = String(tool.tool ?? 'tool');
        const state = tool.state ?? {};
        const status = state.status;
        // typed lossless record for EVERY invocation, whatever its state
        if (callId) {
          toolCalls = toolCalls ?? [];
          toolCalls.push({
            callId,
            tool: name,
            status: status === 'running' || status === 'pending' || status === 'error' ? status : 'completed',
            ...(state.input !== undefined ? { input: tryParse(state.input) } : {}),
            ...(status === 'error' ? { error: String(state.error ?? 'tool call failed') } : { output: stringOutput(state.output) }),
            ...(state.title ? { title: String(state.title) } : {}),
            ...(state.metadata && Object.keys(state.metadata).length ? { metadata: state.metadata } : {}),
            ...(state.time ? { time: state.time as { start?: number; end?: number } } : {}),
            source: { messageId: source.messageId, messageSequence: source.messageSequence, partSequence: p.sequence ?? -1 },
          });
        }
        if (status === 'pending' || status === 'running') {
          droppedToolState = `${status}:${name}:${callId}`;
          break;
        }
        if (!callId) break;
        blocks.push({ type: 'tool_use', id: callId, name, input: tryParse(state.input) });
        if (status === 'error') {
          toolResults.push({ type: 'tool_result', toolUseId: callId, content: String(state.error ?? 'tool call failed'), isError: true });
        } else {
          toolResults.push({ type: 'tool_result', toolUseId: callId, content: stringOutput(state.output), isError: false });
        }
        break;
      }
      case 'compaction': {
        // boundary record (operationId/tail_start_id/compactBoundary/
        // summaryMessageId/preCompactTokenCount …): collected for tokensBefore
        // pairing AND kept verbatim in the message's rawParts (gap #3)
        compactionParts = compactionParts ?? [];
        compactionParts.push(pd);
        meta.rawParts = meta.rawParts ?? [];
        meta.rawParts.push({ sequence: p.sequence, data: pd });
        break;
      }
      default:
        // everything without a block projection (step-start / step-finish /
        // timeline / snapshot / agent / retry / …) — verbatim lossless bucket.
        // step-finish carries per-step tokens/cost/reason, so dropping it (the
        // old "zero-information" call) was wrong; see docs/ir-protocol.md #5.
        meta.rawParts = meta.rawParts ?? [];
        meta.rawParts.push({ sequence: p.sequence, data: pd });
        break;
    }
  }
  return { blocks, toolResults, meta, compactionParts, toolCalls, droppedToolState };
}

function stringOutput(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  try { return JSON.stringify(v); } catch { return String(v); }
}

/* ------------------------------------------------------------------ */
/* Sidechains (subagent children)                                      */
/* ------------------------------------------------------------------ */

async function buildSidechains(
  db: DbHandle,
  parentSessionId: string,
  ctx: ExpandCtx,
): Promise<{
  sidechains: MigratedSidechain[];
  agentLinks: Record<string, { childSessionId: string; agentId: string }>;
  otherChildren: Array<{ id: string; taskType: string; title: string | null }>;
  sidecarPrompts: Record<string, unknown>;
}> {
  const childRows = db.prepare(
    'SELECT id, task_type, title FROM session WHERE parent_id=? ORDER BY time_created',
  ).all(parentSessionId) as Row[];

  const sidechains: MigratedSidechain[] = [];
  const agentLinks: Record<string, { childSessionId: string; agentId: string }> = {};
  const otherChildren: Array<{ id: string; taskType: string; title: string | null }> = [];
  const sidecars = await loadSidecars(ctx.agentsRoot, parentSessionId);
  const sidecarPrompts: Record<string, unknown> = {};
  const usedCallIds = new Set<string>();

  for (const row of childRows) {
    const childId = String(row.id ?? '');
    const taskType = String(row.task_type ?? '');
    if (taskType !== 'subagent_child') {
      // selection_side_chat / workflow_* are parent-linked too but out of the
      // subagent sidechain contract — recorded for losslessness only.
      otherChildren.push({ id: childId, taskType, title: row.title ? String(row.title) : null });
      continue;
    }
    const childMessages = loadMessagesOrdered(db, childId);
    const childParts = loadPartsByMessage(db, childId);
    const childRevert = parseJsonObject(
      (db.prepare('SELECT revert FROM session WHERE id=?').get(childId) as Row | undefined)?.revert,
    ) as ZcodeRevert;
    const trimmed = o0Trim(childMessages, childRevert);

    const irMessages: MigratedMessage[] = [];
    const childToolCalls: MigratedToolCall[] = [];
    let agentType: string | undefined;
    for (const m of trimmed.messages) {
      const parts = childParts.get(m.id) ?? [];
      const exp = expandMessageRow(m, parts, ctx);
      irMessages.push(...exp.ir);
      if (exp.toolCalls) childToolCalls.push(...exp.toolCalls);
      if (!agentType) {
        const d = parseJsonObject(m.data) as { agent?: string };
        if (d.agent) agentType = agentTypeOf(d.agent);
      }
    }
    if (!irMessages.length) continue;

    // sidecar supplement: agentId / parentToolUseId / systemPrompt / usage
    const scUuid = childId.startsWith('sess_subagent_agent_') ? childId.slice('sess_subagent_agent_'.length) : childId;
    const sidecar = sidecars.get(`agent_${scUuid}`);
    if (!agentType && sidecar?.profileSnapshot?.name) agentType = agentTypeOf(sidecar.profileSnapshot.name);
    if (sidecar) {
      sidecarPrompts[`agent_${scUuid}`] = {
        ...(sidecar.profileSnapshot?.systemPrompt ? { systemPrompt: sidecar.profileSnapshot.systemPrompt } : {}),
        ...(sidecar.profileId ? { profileId: sidecar.profileId } : {}),
        ...(sidecar.status ? { status: sidecar.status } : {}),
        ...(sidecar.usage ? { usage: sidecar.usage } : {}),
        ...(sidecar.parentToolUseId ? { parentToolUseId: sidecar.parentToolUseId } : {}),
      };
    }

    // parent Agent tool part match: sidecar parentToolUseId, else prompt equality
    let parentCallId = sidecar?.parentToolUseId ? String(sidecar.parentToolUseId) : undefined;
    if (parentCallId && !callIdExistsInSession(db, parentSessionId, parentCallId)) parentCallId = undefined;
    if (!parentCallId) {
      const prompt = firstUserText(irMessages);
      const fromPrompt = prompt ? findAgentCallByPrompt(db, parentSessionId, prompt) : undefined;
      if (fromPrompt) parentCallId = fromPrompt;
    }
    if (parentCallId) {
      usedCallIds.add(parentCallId);
      agentLinks[parentCallId] = { childSessionId: childId, agentId: sidecar?.agentId ? String(sidecar.agentId) : `agent_${scUuid}` };
    }

    sidechains.push({
      agentId: childId,
      kind: 'subagent',
      ...(agentType ? { agentType } : {}),
      ...(parentCallId ? { parentMessageId: parentCallId } : {}),
      messages: irMessages,
      ...(childToolCalls.length ? { toolCalls: childToolCalls } : {}),
    });
  }

  // sidecar entries whose child session row is gone — still record link info
  for (const [key, meta] of sidecars) {
    if (meta.parentToolUseId && !usedCallIds.has(meta.parentToolUseId)) {
      agentLinks[meta.parentToolUseId] = {
        childSessionId: meta.childSessionId ?? `sess_subagent_${key}`,
        agentId: meta.agentId ?? key,
      };
    }
  }

  return { sidechains, agentLinks, otherChildren, sidecarPrompts };
}

/** Load sidecar metadata.json files for one parent session (best-effort). */
async function loadSidecars(agentsRoot: string, parentSessionId: string): Promise<Map<string, SidecarMeta>> {
  const out = new Map<string, SidecarMeta>();
  const dir = join(agentsRoot, parentSessionId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.startsWith('agent_')) continue;
    try {
      const raw = await fs.readFile(join(dir, name, 'metadata.json'), 'utf8');
      out.set(name, JSON.parse(raw) as SidecarMeta);
    } catch { /* skip broken sidecar */ }
  }
  return out;
}

function callIdExistsInSession(db: DbHandle, sessionId: string, callId: string): boolean {
  const row = db.prepare(
    'SELECT 1 AS x FROM part WHERE session_id=? AND data LIKE ? LIMIT 1',
  ).get(sessionId, `%"callID":"${callId}"%`) as Row | undefined;
  return !!row;
}

function findAgentCallByPrompt(db: DbHandle, parentSessionId: string, prompt: string): string | undefined {
  if (prompt.length < 16) return undefined;
  const rows = db.prepare(
    "SELECT data FROM part WHERE session_id=? AND data LIKE '%\"tool\":\"Agent\"%' LIMIT 50",
  ).all(parentSessionId) as Row[];
  for (const r of rows) {
    const d = parseJsonObject(r.data) as ZcodeToolPart;
    if (d.type !== 'tool' || !isSubagentToolName(String(d.tool ?? ''))) continue;
    const input = parseJsonObject(tryParse(d.state?.input)) as Row;
    const p = String(input.prompt ?? '');
    if (p && p === prompt) return String(d.callID ?? '');
  }
  return undefined;
}

function firstUserText(messages: MigratedMessage[]): string {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const text = m.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (text) return text;
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* Write pipeline                                                      */
/* ------------------------------------------------------------------ */

/** Consistent snapshot of a live WAL db via SQLite's `VACUUM INTO`. */
async function snapshotLiveDb(srcPath: string, dstPath: string): Promise<void> {
  const src = await openDb(srcPath, true);
  if (!src) throw new Error(`Zcode: cannot snapshot live db ${srcPath} (no sqlite driver / locked)`);
  try {
    const escaped = `'${dstPath.replace(/'/g, "''")}'`;
    src.exec(`VACUUM INTO ${escaped}`);
  } finally {
    try { src.close(); } catch { /* ignore */ }
  }
}

/** Minimal session-store schema for fresh sandbox targets (hermetic tests). */
async function createMinimalDb(dbPath: string): Promise<void> {
  // go through the async open (dynamic import works in ESM; the sync require
  // fallback does not)
  const db = await openDb(dbPath, false);
  if (!db) throw new Error(`Zcode: cannot bootstrap fresh db ${dbPath}`);
  try {
    ensureMinimalSchema(db);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

function ensureMinimalSchema(db: DbHandle): void {
  // Best-effort: real stores already carry the engine's 18 migrations; fresh
  // sandbox targets created without a live db get the 3-table minimal shape.
  db.exec(`CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT,
    slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL,
    version TEXT NOT NULL, revert TEXT, permission TEXT,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
    task_type TEXT NOT NULL, title_source TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL, sequence INTEGER)`);
  db.exec(`CREATE TABLE IF NOT EXISTS part (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
    data TEXT NOT NULL, sequence INTEGER)`);
  db.exec('CREATE INDEX IF NOT EXISTS message_session_seq ON message(session_id, sequence)');
  db.exec('CREATE INDEX IF NOT EXISTS part_message_seq ON part(message_id, sequence)');
}

interface WriteContext {
  db: DbHandle;
  cwd: string;
  providerIds: Record<string, string>;   // readable name → raw providerID
  agentLinks: Record<string, { childSessionId: string; agentId: string }>;
  callIdRemap: Map<string, string>;      // foreign tool_use id → call_<hex>
  results: Map<string, { content: string; isError: boolean }>;
  subagentSlots: Array<{ toolUseId: string; childId: string; agentUuid: string; sidechain: MigratedSidechain }>;
  usedChildIds: Set<string>;
}

function writeToDb(db: DbHandle, ir: MigratedSession, newId: string, cwd: string): string[] {
  const now = Date.now();
  const extensions = (ir.extensions ?? {}) as Record<string, unknown>;
  const providers = (extensions['zcode.providers'] ?? {}) as Record<string, string>;
  const agentLinks = (extensions['zcode.agentLinks'] ?? {}) as Record<string, { childSessionId: string; agentId: string }>;

  // readable provider name → raw registry id (raw ids also survive as msg.provider verbatim)
  const providerIds: Record<string, string> = {};
  for (const [raw, name] of Object.entries(providers)) {
    if (typeof name === 'string') providerIds[name] = raw;
  }

  const ctx: WriteContext = { db, cwd, providerIds, agentLinks, callIdRemap: new Map(), results: new Map(), subagentSlots: [], usedChildIds: new Set() };

  // pass 1: collect tool_result blocks (they always follow their call) — main
  // messages and sidechain transcripts alike.
  const collectResults = (messages: MigratedMessage[]): void => {
    for (const msg of messages) {
      for (const b of msg.content) {
        if (b.type === 'tool_result') ctx.results.set(b.toolUseId, { content: b.content, isError: !!b.isError });
      }
    }
  };
  collectResults(ir.messages);
  for (const sc of ir.sidechains ?? []) collectResults(sc.messages);

  // pass 2: re-shape foreign call ids and bind sidechains to Agent tool_use
  // slots (extension link → prompt equality → order). Each bound sidechain is
  // consumed so multiple Agent calls don't all resolve to the first child.
  // Agent calls always get a FRESH call id: the engine indexes subagent
  // sidecars/ledgers by parentToolUseId globally, so a preserved original
  // callID would re-link the migrated part to the SOURCE child session.
  const queue = [...(ir.sidechains ?? [])];
  for (const msg of ir.messages) {
    for (const b of msg.content) {
      if (b.type !== 'tool_use' || !isSubagentToolName(b.name)) continue;
      const callId = remapCallId(ctx, b.id);
      const slot = pickSidechainForCall(ctx, b, queue);
      if (slot) ctx.subagentSlots.push({ toolUseId: callId, childId: slot.childId, agentUuid: slot.agentUuid, sidechain: slot.sidechain });
    }
  }

  const createdAt = ir.createdAt && ir.createdAt > 0 ? ir.createdAt : now;
  const paths: string[] = [];
  insertSessionRow(db, {
    id: newId,
    parentId: null,
    directory: cwd,
    title: ir.title ?? '(migrated)',
    createdAt,
    updatedAt: now,
    taskType: 'interactive',
    titleSource: 'first_input',
  });
  paths.push(`session:${newId}`);
  writeMessages(db, ir.messages, newId, ctx, createdAt, 'zcode-agent', ir.toolCalls);

  // pass 3: sidechains → subagent_child sessions (+ parent_id, engine's
  // Cl('subagent_'+agentId) id convention).
  for (const slot of ctx.subagentSlots) {
    const sc = slot.sidechain;
    const childAgent = sc.agentType ? `zcode-${sc.agentType}` : 'zcode-agent';
    insertSessionRow(db, {
      id: slot.childId,
      parentId: newId,
      directory: cwd,
      title: firstUserText(sc.messages).split('\n')[0]?.slice(0, 120) || '(subagent)',
      createdAt,
      updatedAt: now,
      taskType: 'subagent_child',
      titleSource: 'first_input',
    });
    paths.push(`session:${slot.childId}`);
    writeMessages(db, sc.messages, slot.childId, ctx, createdAt, childAgent, sc.toolCalls);
  }
  return paths;
}

function remapCallId(ctx: WriteContext, foreignId: string): string {
  const existing = ctx.callIdRemap.get(foreignId);
  if (existing) return existing;
  const fresh = freshCallId();
  ctx.callIdRemap.set(foreignId, fresh);
  return fresh;
}

function pickSidechainForCall(
  ctx: WriteContext,
  block: { type: 'tool_use'; id: string; name: string; input: unknown },
  queue: MigratedSidechain[],
): { childId: string; agentUuid: string; sidechain: MigratedSidechain } | undefined {
  const chosen =
    matchByLink(ctx, block.id, queue) ??
    matchByPrompt(block, queue) ??
    queue[0];
  if (!chosen) return undefined;
  queue.splice(queue.indexOf(chosen), 1);
  // the preferred child id follows the source agentId, but migrating back
  // into a store that already holds the source session must not collide —
  // re-derive with a fresh uuid until the id is free (metadata and child row
  // always share the same uuid, engine Cl('subagent_'+agentId) convention).
  let identity = deriveChildIdentity(chosen);
  for (let attempt = 0; attempt < 8 && (ctx.usedChildIds.has(identity.childId) || sessionIdExists(ctx.db, identity.childId)); attempt++) {
    const freshUuid = randomUUID();
    identity = { childId: `sess_subagent_agent_${freshUuid}`, agentUuid: freshUuid };
  }
  ctx.usedChildIds.add(identity.childId);
  return { ...identity, sidechain: chosen };
}

function sessionIdExists(db: DbHandle, id: string): boolean {
  return !!db.prepare('SELECT 1 AS x FROM session WHERE id=?').get(id);
}

function matchByLink(ctx: WriteContext, callId: string, queue: MigratedSidechain[]): MigratedSidechain | undefined {
  const link = ctx.agentLinks[callId];
  if (!link) return undefined;
  return queue.find((s) => s.agentId === link.childSessionId || s.agentId === link.agentId);
}

function matchByPrompt(block: { input: unknown }, queue: MigratedSidechain[]): MigratedSidechain | undefined {
  const input = (block.input && typeof block.input === 'object') ? block.input as Row : {};
  const prompt = String(input.prompt ?? '');
  if (!prompt) return undefined;
  return queue.find((s) => firstUserText(s.messages) === prompt);
}

/** child session id follows `sess_subagent_agent_<uuid>`; agentId metadata = `agent_<same uuid>`. */
function deriveChildIdentity(sc: MigratedSidechain): { childId: string; agentUuid: string } {
  let agentUuid: string;
  if (sc.agentId.startsWith('sess_subagent_agent_')) {
    agentUuid = sc.agentId.slice('sess_subagent_agent_'.length);
  } else if (sc.agentId.startsWith('agent_')) {
    agentUuid = sc.agentId.slice('agent_'.length);
  } else {
    agentUuid = randomUUID();
  }
  return { childId: `sess_subagent_agent_${agentUuid}`, agentUuid };
}

function insertSessionRow(
  db: DbHandle,
  s: { id: string; parentId: string | null; directory: string; title: string; createdAt: number; updatedAt: number; taskType: string; titleSource: string },
): void {
  try {
    db.prepare(
      'INSERT INTO session (id, parent_id, project_id, slug, directory, path, title, version, permission, time_created, time_updated, task_type, title_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      s.id,
      s.parentId,
      zcodeProjectId(s.directory || '/'),
      s.id,
      s.directory || '/',
      s.directory || '/',
      s.title,
      ENGINE_VERSION,
      DEFAULT_PERMISSION,
      s.createdAt,
      s.updatedAt,
      s.taskType,
      s.titleSource,
    );
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (msg.includes('UNIQUE')) throw new Error(`Zcode: session id ${s.id} already exists in the target db — pick a new --session-id / sandbox root instead of overwriting.`);
    throw e;
  }
}

/**
 * IR messages → native message/part rows. Ordering is positional (message
 * sequence 0..N-1, part sequence per message 0..M); tool_use/tool_result
 * blocks are fused back into single 4-state tool parts — a matching
 * `toolCalls` record (typed lossless bucket) restores the exact native state
 * (status/title/metadata/time) and re-injects pending/running invocations
 * that have no replayable block; IR system messages become hidden
 * system_reminder user rows; role:'tool' messages carry no row of their own
 * (results live in the tool parts).
 */
function writeMessages(
  db: DbHandle,
  messages: MigratedMessage[],
  sessionId: string,
  ctx: WriteContext,
  baseTime: number,
  defaultAgent: string,
  toolCalls?: MigratedToolCall[],
): void {
  let sequence = 0;
  let prevId: string | null = null;
  let clock = baseTime;
  const recordByCallId = new Map((toolCalls ?? []).map((t) => [t.callId, t]));
  // pending/running records keyed by their source message sequence for re-injection
  const nonReplayable = (toolCalls ?? []).filter((t) => t.status === 'pending' || t.status === 'running');

  for (const msg of messages) {
    clock += 1;
    const ts = msg.timestamp && msg.timestamp > 0 ? msg.timestamp : clock;
    const zmeta = zcodeMetaOf(msg);

    if (msg.role === 'tool') continue; // fused into the preceding assistant's tool parts

    if (msg.role === 'user' || msg.role === 'system') {
      const isSystem = msg.role === 'system' && !zmeta?.semantics;
      // compaction-summary rows carry their native semantics in meta.zcode —
      // restore them as the engine wrote them, not as real_user prompts (gap #3)
      const isSummary = !isSystem &&
        !!(zmeta?.summary || (zmeta?.semantics as Row | undefined)?.kind === 'compact_summary');
      const textBlocks = msg.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text');
      const fileBlocks = msg.content.filter((b): b is FileBlock => b.type === 'file');
      if (!textBlocks.length && !fileBlocks.length && !isSummary) continue; // e.g. claude-style tool_result-only user rows
      const parts: Array<{ data: Row; ts: number }> = textBlocks.map((b) => ({
        data: { type: 'text', text: b.text, time: { start: ts, end: ts } },
        ts,
      }));
      for (const b of fileBlocks) {
        parts.push({
          data: {
            type: 'file',
            ...(b.filename ? { filename: b.filename } : {}),
            ...(b.mediaType ? { mime: b.mediaType } : {}),
            ...(b.url ? { url: b.url } : {}),
            ...(b.data ? { data: b.data } : {}),
          },
          ts,
        });
      }
      appendRawParts(parts, zmeta, ts);
      const data: Row = {
        role: 'user',
        time: { created: ts },
        agent: zmeta?.agent ?? defaultAgent,
        semantics: zmeta?.semantics
          ? zmeta.semantics
          : isSystem
            ? { origin: 'system', kind: 'system_reminder', uiVisibility: 'hidden', providerVisibility: 'visible', transcriptVisibility: 'hidden' }
            : { origin: 'real_user', kind: 'user_prompt', uiVisibility: 'visible', providerVisibility: 'visible', transcriptVisibility: 'visible' },
        anchor: zmeta?.anchor ?? { turnId: `turn_${randomUUID()}`, origin: 'realUser' },
      };
      if (isSummary || zmeta?.summary) {
        data.summary = zmeta?.summary ?? { body: textBlocks.map((b) => b.text).join('\n') };
      }
      if (zmeta?.contextSnapshot) data.contextSnapshot = zmeta.contextSnapshot;
      if (zmeta?.tools) data.tools = zmeta.tools;
      if (zmeta?.metadata) data.metadata = zmeta.metadata;
      if (zmeta?.synthetic) data.synthetic = true;
      if (zmeta?.source) data.source = zmeta.source;
      if (zmeta?.visibility) data.visibility = zmeta.visibility;
      if (!isSystem) {
        const model = zmeta?.modelID
          ? { modelID: zmeta.modelID, ...(zmeta.providerID ? { providerID: zmeta.providerID } : {}), ...(zmeta.variant ? { variant: zmeta.variant } : {}) }
          : resolveProviderModel(msg, ctx);
        if (model) data.model = { providerID: model.providerID, modelID: model.modelID, ...(model.variant ? { variant: model.variant } : {}) };
      }
      const userId = insertMessageWithParts(db, sessionId, sequence, ts, data, parts);
      sequence += 1;
      // assistants triggered by this turn chain their parentID to the user row
      prevId = userId;
      continue;
    }

    // assistant
    const toolUses = msg.content.filter((b): b is { type: 'tool_use'; id: string; name: string; input: unknown } => b.type === 'tool_use');
    const parts: Array<{ data: Row; ts: number }> = [];
    for (const b of msg.content) {
      if (b.type === 'text') {
        parts.push({ data: { type: 'text', text: b.text, time: { start: ts, end: ts } }, ts });
      } else if (b.type === 'thinking') {
        const rdata: Row = { type: 'reasoning', text: b.thinking, time: { start: ts, end: ts } };
        // gap #1: native reasoning parts keep the anthropic signature in
        // metadata.anthropic — required for signed-thinking replay
        if (b.signature) rdata.metadata = { anthropic: { signature: b.signature } };
        parts.push({ data: rdata, ts });
      } else if (b.type === 'file') {
        parts.push({
          data: {
            type: 'file',
            ...(b.filename ? { filename: b.filename } : {}),
            ...(b.mediaType ? { mime: b.mediaType } : {}),
            ...(b.url ? { url: b.url } : {}),
            ...(b.data ? { data: b.data } : {}),
          },
          ts,
        });
      } else if (b.type === 'tool_use') {
        // subagent Agent calls always get a fresh call id (see pass 2) so the
        // engine's global sidecar index cannot re-link them to the source child
        const callId = isSubagentToolName(b.name) ? remapCallId(ctx, b.id)
          : (looksLikeCallId(b.id) ? b.id : remapCallId(ctx, b.id));
        const record = recordByCallId.get(b.id) ?? recordByCallId.get(callId);
        const result = ctx.results.get(b.id) ?? ctx.results.get(callId);
        const state: Row = {
          status: record?.status ?? (result?.isError ? 'error' : 'completed'),
          input: record?.input !== undefined ? record.input : ((b.input && typeof b.input === 'object') ? b.input : tryParse(b.input)),
          title: record?.title ?? b.name,
          time: record?.time ?? { start: ts, end: ts + 1 },
        };
        if (state.status === 'error') state.error = record?.error ?? result?.content ?? 'tool call failed';
        else state.output = record?.output ?? result?.content ?? '';
        const metadata: Row = { schemaVersion: 1, ...(record?.metadata ?? {}) };
        if (isSubagentToolName(b.name)) {
          const slot = ctx.subagentSlots.find((s) => s.toolUseId === callId);
          if (slot) {
            metadata.agentId = `agent_${slot.agentUuid}`;
            // The engine appends a launch-acknowledgement footer to subagent
            // outputs (`agentId: agent_<uuid> (use SendMessage …)`) and its
            // cold-read derivation prefers that line over state.metadata
            // (bundle: YOi agentIdFromLaunchAcknowledgement runs before the
            // metadata fallback). Rewriting it to the new agent uuid is what
            // re-binds the migrated part to OUR child session; leaving the
            // source uuid in place would silently re-link the original child.
            if (typeof state.output === 'string' && state.output.includes('agentId:')) {
              state.output = rewriteLaunchAck(state.output, slot.agentUuid);
            }
          }
        }
        state.metadata = metadata;
        parts.push({ data: { type: 'tool', callID: callId, tool: b.name, state }, ts });
      }
      // tool_result blocks on the assistant row are folded into ctx.results already
    }
    // re-inject parts that have no replayable block, at their source part
    // positions: pending/running invocations from the lossless bucket + every
    // non-projected part row (step/timeline/compaction/…) from meta.zcode.
    // Model-visible replay comes only from text/reasoning/tool parts, whose
    // relative order the blocks already preserve, so appending after them is
    // replay-exact; raw positions only order engine bookkeeping.
    const reinject: Array<{ seq: number; data: Row }> = [];
    if (msg.seq !== undefined) {
      for (const rec of nonReplayable) {
        if (rec.source?.messageSequence !== msg.seq) continue;
        const state: Row = {
          status: rec.status,
          ...(rec.input !== undefined ? { input: rec.input } : {}),
          ...(rec.title ? { title: rec.title } : {}),
          ...(rec.time ? { time: rec.time } : {}),
          metadata: { schemaVersion: 1, ...(rec.metadata ?? {}) },
        };
        reinject.push({ seq: rec.source.partSequence, data: { type: 'tool', callID: rec.callId, tool: rec.tool, state } });
      }
    }
    for (const rp of zmeta?.rawParts ?? []) {
      reinject.push({ seq: typeof rp.sequence === 'number' ? rp.sequence : Number.MAX_SAFE_INTEGER, data: rp.data });
    }
    reinject.sort((a, b) => a.seq - b.seq);
    for (const r of reinject) parts.push({ data: r.data, ts });
    if (!parts.length) continue; // nothing replayable in this message

    const ztime = (zmeta?.time && typeof zmeta.time === 'object') ? zmeta.time as Row : undefined;
    const data: Row = {
      role: 'assistant',
      time: {
        created: typeof ztime?.created === 'number' ? ztime.created : ts,
        completed: typeof ztime?.completed === 'number' ? ztime.completed : ts + 1,
      },
      mode: zmeta?.mode ?? 'build',
      agent: zmeta?.agent ?? defaultAgent,
      path: { cwd: ctx.cwd, root: ctx.cwd },
      cost: typeof zmeta?.cost === 'number' ? zmeta.cost : 0,
      tokens: zmeta?.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: zmeta?.finish !== undefined ? zmeta.finish : normalizeFinish(msg, toolUses.length > 0),
      semantics: zmeta?.semantics ?? { origin: 'agent_runtime', kind: 'assistant_response', uiVisibility: 'visible', providerVisibility: 'visible', transcriptVisibility: 'visible' },
    };
    if (prevId) data.parentID = prevId;
    // meta carries the RAW registry ids captured at read time — prefer them
    // over name→id re-resolution for exact zcode→zcode round-trips
    const model = zmeta?.modelID
      ? { modelID: zmeta.modelID, ...(zmeta.providerID ? { providerID: zmeta.providerID } : {}) }
      : resolveProviderModel(msg, ctx);
    if (model) {
      data.modelID = model.modelID;
      if (model.providerID) data.providerID = model.providerID;
    }
    if (zmeta?.variant) data.variant = zmeta.variant;
    insertMessageWithParts(db, sessionId, sequence, ts, data, parts);
    sequence += 1;
    // keep prevId: back-to-back assistant rows share the same user parent
    // (spec pitfall #6 — the parent chain is not a tree)
  }
}

function insertMessageWithParts(
  db: DbHandle,
  sessionId: string,
  sequence: number,
  ts: number,
  data: Row,
  parts: Array<{ data: Row; ts: number }>,
): string {
  const messageId = `msg_${base36(ts)}_${randomUUID()}`;
  db.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)',
  ).run(messageId, sessionId, ts, ts, JSON.stringify(data), sequence);
  let pIndex = 0;
  for (const p of parts) {
    db.prepare(
      'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)',
    ).run(`part_${base36(p.ts)}_${randomUUID()}`, messageId, sessionId, p.ts, p.ts, JSON.stringify(p.data), pIndex);
    pIndex += 1;
  }
  return messageId;
}

/** Resolve {providerID, modelID, variant} for a message, tolerating missing info. */
function resolveProviderModel(msg: MigratedMessage, ctx: WriteContext): { modelID: string; providerID?: string; variant?: string } | undefined {
  if (!msg.model) return undefined;
  let providerId: string | undefined;
  if (msg.provider) {
    if (ctx.providerIds[msg.provider]) providerId = ctx.providerIds[msg.provider];
    else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(msg.provider) || msg.provider.startsWith('builtin:')) {
      providerId = msg.provider; // already a raw registry id
    }
  }
  return {
    modelID: msg.model,
    ...(providerId ? { providerID: providerId } : {}),
  };
}

/** Rewrite the launch-acknowledgement footer's agent id to the migrated child's uuid. */
function rewriteLaunchAck(output: string, agentUuid: string): string {
  return output
    .replace(/(^|\n)agentId:\s*agent_[0-9a-fA-F-]+/g, (_m, p1: string) => `${p1}agentId: agent_${agentUuid}`)
    .replace(/to:\s*['"]agent_[0-9a-fA-F-]+['"]/g, `to: 'agent_${agentUuid}'`);
}

function normalizeFinish(msg: MigratedMessage, hasToolUse: boolean): string {
  const known = new Set(['tool-calls', 'stop', 'completed', 'failed']);
  if (msg.stopReason && known.has(msg.stopReason)) return msg.stopReason;
  return hasToolUse ? 'tool-calls' : 'stop';
}
