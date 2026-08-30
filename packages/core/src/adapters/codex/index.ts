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
import type { MigratedSession, SessionMeta } from '../../ir.js';
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
} from './parse.js';
import { buildRolloutLines, sessionIndexTitle } from './write.js';

export class CodexAdapter implements Adapter {
  readonly tool = 'codex' as const;

  async parse(sessionId: string, root?: string): Promise<MigratedSession> {
    const codexHome = root ?? defaultCodexHome();
    if (!codexHome) throw new Error('Codex: cannot resolve CODEX_HOME/.codex');
    const path = await findRolloutById(codexHome, sessionId);
    if (!path) throw new Error(`Codex: session "${sessionId}" not found under ${codexHome}`);
    const titles = await loadSessionIndexTitles(codexHome);
    const text = await readRolloutText(path);
    return rolloutRecordsToIr(parseRolloutLines(text), { titles, sourcePath: path });
  }

  async write(ir: MigratedSession, opts?: WriteOptions): Promise<WriteResult> {
    validateSession(ir);
    const codexHome = opts?.root ?? defaultCodexHome();
    if (!codexHome) throw new Error('Codex: cannot resolve CODEX_HOME/.codex');
    const targetCwd = opts?.targetCwd ?? ir.cwd ?? '';
    const createdAt = ir.createdAt ?? Date.now();

    // Fresh thread id; on a filename collision (path already exists) pick a
    // new id — never overwrite or append to an existing session (AGENT.md).
    // This applies even when opts.sessionId was requested explicitly.
    let threadId = opts?.sessionId ?? uuidv7();
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

    const lines = buildRolloutLines(ir, threadId, targetCwd, createdAt, {
      targetCwd,
      createdAt,
      threadId,
      systemPromptSource: (opts as { systemPromptSource?: 'source' | 'target' } | undefined)?.systemPromptSource,
      keepSynthetic: opts?.keepSynthetic,
    });
    await fs.mkdir(dirname(finalPath), { recursive: true });
    await fs.writeFile(finalPath, lines.join('\n') + '\n', 'utf8');

    // session_index.jsonl: append ONE line (append-only, newest wins).
    const title = sessionIndexTitle(ir);
    await appendSessionIndex(codexHome, threadId, title);

    return { tool: 'codex', sessionId: threadId, paths: [finalPath] };
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
      const parent = await parentThreadId(f.path);
      items.push({
        tool: 'codex',
        sessionId: threadId,
        ...(titles.get(threadId) ? { title: titles.get(threadId) } : {}),
        createdAt: f.createdAt ?? (f.mtime || undefined),
        sourcePath: f.path,
        ...(f.archived ? { archived: true } : {}),
        ...(parent ? { parentSessionId: parent } : {}),
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
 * Subagent linkage from the FIRST rollout line (always session_meta): the
 * thread_spawn parent — enough for the UI tree without parsing every file.
 * Plain files cost one small read; .zst files pay full decompression.
 */
async function parentThreadId(path: string): Promise<string | undefined> {
  try {
    let firstLine: string;
    if (path.endsWith('.zst')) {
      const text = await readRolloutText(path);
      const nl = text.indexOf('\n');
      firstLine = nl > 0 ? text.slice(0, nl) : text;
    } else {
      const fh = await fs.open(path, 'r');
      try {
        const buf = Buffer.alloc(65536);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        firstLine = buf.toString('utf8', 0, bytesRead).split('\n')[0];
      } finally {
        await fh.close();
      }
    }
    const env = JSON.parse(firstLine) as { type?: string; payload?: Record<string, unknown> };
    if (env.type !== 'session_meta') return undefined;
    const spawn = (env.payload?.source as Record<string, unknown> | undefined)?.subagent as Record<string, unknown> | undefined;
    const parent = (spawn?.thread_spawn as Record<string, unknown> | undefined)?.parent_thread_id;
    return typeof parent === 'string' ? parent : undefined;
  } catch {
    return undefined;
  }
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
