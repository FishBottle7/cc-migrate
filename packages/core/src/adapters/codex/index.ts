/**
 * Codex adapter — reads/writes `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]`
 * + `archived_sessions/` + append-only `session_index.jsonl`.
 *
 * 100%-lossless per docs/agents/codex.md (v3 deep-dive, codex-rs 0.146 tree):
 * all 11 rollout record types map to typed IR slots; the only legal drops are
 * `encrypted_content` / `encrypted_function_args` (placeholder-flagged).
 * Mapping tables: docs/agents/codex.md §8 (read) / §9 (write); IR slots
 * registered in docs/ir-protocol.md §v3.1.
 *
 * Iron rule (AGENT.md): this adapter only ever CREATES new files. It never
 * rewrites, truncates or deletes existing sessions; session_index.jsonl is
 * append-only (one line per write).
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Adapter, WriteOptions, WriteResult } from '../../registry.js';
import type { MigratedSession, MigratedSidechain, SessionMeta } from '../../ir.js';
import { validateSession } from '../../ir.js';
import { blocksToText } from '../../content.js';
import {
  defaultCodexHome,
  codexSessionPathFor,
  archivedDir,
  parseRolloutFileName,
  sessionIndexPath,
  uuidv7,
} from './paths.js';
import {
  findRolloutById,
  loadSessionIndexTitles,
  parseRolloutFile,
  rolloutRecordsToIr,
  parseRolloutLines,
  readRolloutText,
  scanRolloutHead,
  scanRolloutMeta,
} from './parse.js';
import { buildRolloutLines, sessionIndexTitle } from './write.js';
import type { CodexWriteOptions } from './write.js';

export class CodexAdapter implements Adapter {
  readonly tool = 'codex' as const;

  async parse(sessionId: string, root?: string): Promise<MigratedSession> {
    const codexHome = root ?? defaultCodexHome();
    if (!codexHome) throw new Error('Codex: cannot resolve CODEX_HOME/.codex');
    const path = await findRolloutById(codexHome, sessionId);
    if (!path) throw new Error(`Codex: session "${sessionId}" not found under ${codexHome}`);
    const titles = await loadSessionIndexTitles(codexHome);
    const text = await readRolloutText(path);
    const ir = rolloutRecordsToIr(parseRolloutLines(text), { titles, sourcePath: path });
    // Read side of the write-side subagent expansion: native codex subagent
    // threads are separate rollout files linked via session_meta thread_spawn
    // — stitch them into ir.sidechains (recursively for grandchildren).
    const byParent = await subagentChildIndex(codexHome);
    const stitched = await loadSubagentTree(sessionId, byParent, titles, new Set([sessionId]));
    if (stitched.length) ir.sidechains = stitched;
    return ir;
  }

  async write(ir: MigratedSession, opts?: WriteOptions): Promise<WriteResult> {
    validateSession(ir);
    const codexHome = opts?.root ?? defaultCodexHome();
    if (!codexHome) throw new Error('Codex: cannot resolve CODEX_HOME/.codex');
    const targetCwd = opts?.targetCwd ?? ir.cwd ?? '';
    const createdAt = ir.createdAt ?? Date.now();
    const wopts: CodexWriteOptions = {
      targetCwd,
      createdAt,
      threadId: '',
      systemPromptSource: (opts as { systemPromptSource?: 'source' | 'target' } | undefined)?.systemPromptSource,
      keepSynthetic: opts?.keepSynthetic,
    };

    // Fresh thread id; on a filename collision (path already exists) pick a
    // new id — never overwrite or append to an existing session (AGENT.md).
    // This applies even when opts.sessionId was requested explicitly.
    const main = await writeRolloutFile(ir, codexHome, wopts, targetCwd, createdAt, opts?.sessionId);
    await appendSessionIndex(codexHome, main.threadId, sessionIndexTitle(ir));

    // Native subagent form: sidechains expand to INDEPENDENT child rollout
    // files linked via session_meta source.subagent.thread_spawn.parent_thread_id
    // (docs/agents/codex.md §10) — never folded into the parent file.
    const paths: string[] = [main.path];
    for (const sc of ir.sidechains ?? []) {
      paths.push(...(await writeSidechainTree(sc, ir, codexHome, wopts, targetCwd, main.threadId, 1)));
    }
    return { tool: 'codex', sessionId: main.threadId, paths };
  }

  async listSessions(root?: string): Promise<SessionMeta[]> {
    const codexHome = root ?? defaultCodexHome();
    if (!codexHome) return [];
    const files = new Map<string, { path: string; mtime: number; createdAt: number | null; archived?: boolean }>();
    await walkRollouts(codexHome, files, false);
    await walkRollouts(archivedDir(codexHome), files, true);
    const titles = await loadSessionIndexTitles(codexHome);
    const items: SessionMeta[] = [];
    for (const [threadId, f] of files) {
      // One cheap head scan per file: cwd + subagent parent + first real user
      // prompt (codex naming convention). The index title, when present, wins
      // — same priority the write side uses.
      const head = await scanRolloutHead(f.path);
      const indexTitle = titles.get(threadId);
      items.push({
        tool: 'codex',
        sessionId: threadId,
        ...(indexTitle ? { title: indexTitle } : head.title ? { title: head.title } : {}),
        ...(head.cwd ? { cwd: head.cwd } : {}),
        createdAt: f.createdAt ?? (f.mtime || undefined),
        sourcePath: f.path,
        ...(f.archived ? { archived: true } : {}),
        ...(head.parentThreadId ? { parentSessionId: head.parentThreadId } : {}),
      });
    }
    // Deferred-creation threads: registered in the append-only index but no
    // rollout file on disk yet — nothing to migrate; listed so consumers can
    // account for them (SessionMeta.deferredCreation) and filter in the UI.
    for (const [threadId, title] of titles) {
      if (files.has(threadId)) continue;
      items.push({ tool: 'codex', sessionId: threadId, ...(title ? { title } : {}), deferredCreation: true });
    }
    items.sort((a, b) => (a.deferredCreation ? Number.MAX_SAFE_INTEGER : a.createdAt ?? 0) - (b.deferredCreation ? Number.MAX_SAFE_INTEGER : b.createdAt ?? 0));
    return items;
  }

  preview(session: MigratedSession): string {
    const main = session.messages.map((m) => `[${m.role}]\n${blocksToText(m.content)}`).join('\n\n');
    if (!session.sidechains?.length) return main;
    const branches = session.sidechains
      .map((sc) => `[sidechain: ${sc.agentId} (${sc.kind})]\n${sc.messages.map((m) => blocksToText(m.content)).join('\n')}`)
      .join('\n\n');
    return `${main}\n\n${branches}`;
  }
}

async function appendSessionIndex(codexHome: string, threadId: string, threadName: string): Promise<void> {
  const entry = {
    id: threadId,
    thread_name: threadName,
    updated_at: new Date().toISOString(),
  };
  await fs.appendFile(sessionIndexPath(codexHome), JSON.stringify(entry) + '\n', 'utf8');
}

/**
 * Write one rollout file with collision-safe id selection (AGENT.md): a fresh
 * uuidv7 per file; when the rendered path already exists, re-roll the id —
 * never overwrite or append to an existing session.
 */
async function writeRolloutFile(
  ir: MigratedSession,
  codexHome: string,
  wopts: CodexWriteOptions,
  targetCwd: string,
  createdAt: number,
  requestedId?: string,
): Promise<{ threadId: string; path: string }> {
  let threadId = requestedId ?? uuidv7();
  let finalPath = codexSessionPathFor(codexHome, threadId, createdAt);
  for (let attempt = 0; attempt < 8; attempt++) {
    const exists = await fs
      .stat(finalPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) break;
    if (attempt === 7) throw new Error(`Codex: cannot find a free rollout path for thread ${threadId}`);
    threadId = uuidv7();
    finalPath = codexSessionPathFor(codexHome, threadId, createdAt);
  }
  wopts.threadId = threadId;
  wopts.createdAt = createdAt;
  const lines = buildRolloutLines(ir, threadId, targetCwd, createdAt, wopts);
  await fs.mkdir(dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, lines.join('\n') + '\n', 'utf8');
  return { threadId, path: finalPath };
}

/**
 * Sidechains → independent child rollout files, recursively (grandchildren
 * link to their own parent). Children are mini-sessions (MigratedSidechain):
 * foreign-shaped messages ride the ordinary write projection; each gets its
 * own thread id and its own session_index line (append-only, one per file).
 */
async function writeSidechainTree(
  sc: MigratedSidechain,
  parentIr: MigratedSession,
  codexHome: string,
  wopts: CodexWriteOptions,
  targetCwd: string,
  parentThreadId: string,
  depth: number,
): Promise<string[]> {
  const child: MigratedSession = {
    schemaVersion: 2,
    originTool: parentIr.originTool,
    originSessionId: sc.originSessionId ?? sc.agentId,
    ...(sc.title ? { title: sc.title } : {}),
    createdAt: sc.createdAt ?? parentIr.createdAt ?? Date.now(),
    ...(sc.cwd ?? parentIr.cwd ? { cwd: sc.cwd ?? parentIr.cwd } : {}),
    messages: sc.messages,
    ...(sc.compaction?.length ? { compaction: sc.compaction } : {}),
    ...(sc.toolCalls?.length ? { toolCalls: sc.toolCalls } : {}),
    ...(sc.unmappedEvents?.length ? { unmappedEvents: sc.unmappedEvents } : {}),
    ...(sc.meta ? { meta: sc.meta } : {}),
  };
  const { threadId, path } = await writeRolloutFile(child, codexHome, { ...wopts, parentThreadId, subagentDepth: depth, agentNickname: sc.agentType }, targetCwd, child.createdAt ?? Date.now());
  await appendSessionIndex(codexHome, threadId, sessionIndexTitle(child));
  const out = [path];
  for (const kid of sc.sidechains ?? []) {
    out.push(...(await writeSidechainTree(kid, parentIr, codexHome, wopts, targetCwd, threadId, depth + 1)));
  }
  return out;
}

/* ── Read-side subagent stitching ────────────────────────────── */

interface SubagentChildInfo {
  threadId: string;
  path: string;
  agentNickname?: string;
  agentRole?: string;
  agentPath?: string;
  ts?: number;
}

/** Preview/migrate click arounds re-parse the same home — brief TTL cache. */
const SUBAGENT_INDEX_TTL_MS = 5_000;
const subagentIndexCache = new Map<string, { at: number; byParent: Map<string, SubagentChildInfo[]> }>();

/**
 * parent thread id → subagent child rollouts, by first-line meta scan of every
 * rollout in the home (session_meta is record #1, so this is cheap). Result is
 * a snapshot: sessions written while the TTL entry lives appear on the next
 * rebuild — fine for preview, and migrate re-checks nothing older than 5s.
 */
async function subagentChildIndex(codexHome: string): Promise<Map<string, SubagentChildInfo[]>> {
  const hit = subagentIndexCache.get(codexHome);
  if (hit && Date.now() - hit.at < SUBAGENT_INDEX_TTL_MS) return hit.byParent;
  const files = new Map<string, { path: string; mtime: number; createdAt: number | null }>();
  await walkRollouts(codexHome, files, false);
  await walkRollouts(archivedDir(codexHome), files, true);
  const byParent = new Map<string, SubagentChildInfo[]>();
  for (const [threadId, f] of files) {
    const meta = await scanRolloutMeta(f.path);
    if (!meta.parentThreadId || meta.parentThreadId === threadId) continue;
    const list = byParent.get(meta.parentThreadId) ?? [];
    list.push({
      threadId,
      path: f.path,
      agentNickname: meta.agentNickname,
      agentRole: meta.agentRole,
      agentPath: meta.agentPath,
      ts: f.createdAt ?? undefined,
    });
    byParent.set(meta.parentThreadId, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  subagentIndexCache.set(codexHome, { at: Date.now(), byParent });
  return byParent;
}

/** Parse one parent's subagent subtree into MigratedSidechain[] (visited-set cycle guard). */
async function loadSubagentTree(
  parentId: string,
  byParent: Map<string, SubagentChildInfo[]>,
  titles: Map<string, string>,
  visited: Set<string>,
): Promise<MigratedSidechain[]> {
  const out: MigratedSidechain[] = [];
  for (const info of byParent.get(parentId) ?? []) {
    if (visited.has(info.threadId)) continue;
    visited.add(info.threadId);
    const text = await readRolloutText(info.path);
    const child = rolloutRecordsToIr(parseRolloutLines(text), { titles, sourcePath: info.path });
    const label =
      info.agentNickname ?? info.agentRole ?? info.agentPath?.split('/').filter(Boolean).pop();
    const nested = await loadSubagentTree(info.threadId, byParent, titles, visited);
    out.push({
      agentId: info.threadId,
      kind: 'subagent',
      ...(label ? { agentType: label } : {}),
      messages: child.messages,
      ...(child.toolCalls?.length ? { toolCalls: child.toolCalls } : {}),
      originSessionId: info.threadId,
      ...(child.title ? { title: child.title } : {}),
      ...(child.createdAt ? { createdAt: child.createdAt } : {}),
      ...(child.cwd ? { cwd: child.cwd } : {}),
      ...(child.compaction?.length ? { compaction: child.compaction } : {}),
      ...(child.unmappedEvents?.length ? { unmappedEvents: child.unmappedEvents } : {}),
      ...(child.meta ? { meta: child.meta } : {}),
      ...(nested.length ? { sidechains: nested } : {}),
    });
  }
  return out;
}

/** Collect rollout files (thread id → newest mtime wins for revert variants). */async function walkRollouts(
  dir: string,
  out: Map<string, { path: string; mtime: number; createdAt: number | null; archived?: boolean }>,
  archived: boolean,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      // the home-root walk must not swallow archived_sessions — it is scanned
      // separately (with the archived flag) by the caller.
      if (!archived && e.name === 'archived_sessions') continue;
      await walkRollouts(full, out, archived);
    } else if (e.isFile() && e.name.startsWith('rollout-')) {
      const parsed = parseRolloutFileName(e.name);
      if (!parsed) continue;
      const st = await fs.stat(full).catch(() => null);
      const mtime = st?.mtimeMs ?? 0;
      const prev = out.get(parsed.threadId);
      if (prev && prev.mtime >= mtime) continue;
      out.set(parsed.threadId, { path: full, mtime, createdAt: parsed.createdAt, ...(archived ? { archived: true } : {}) });
    }
  }
}
