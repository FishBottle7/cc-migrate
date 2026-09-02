/**
 * session-migrate DSH plugin — command layer.
 *
 * Pure functions decoupled from the cordis host: they receive plain
 * arguments, call the shared `@session-migrate/core` engine, and return
 * result objects. The cordis side (src/index.ts) only deals with
 * interaction (argument parsing, logging, dispose); all migration logic
 * lives here so it stays testable without a DSH host.
 *
 * Safety (repo-wide iron rule, AGENT.md):
 *  - READ the source, WRITE brand-new files only. The DSH write side
 *    generates a fresh session id and never clobbers an existing session.
 *  - No unlink / rm / DELETE / TRUNCATE anywhere in this file.
 *  - The default DSH root (~/.dsh/sessions) is only touched when the
 *    caller explicitly leaves `root` unset in the real host; tests and
 *    smoke runs always pass a temp `root` (or `dstRoot`).
 *
 * Every operation is wrapped so an adapter/IO failure surfaces as
 * `{ ok: false, error }` instead of blowing up the host process.
 */

import {
  builtinRegistry,
  listSessions,
  previewSession,
  readSource,
  writeTarget,
} from '@session-migrate/core';
import type {
  AdapterRegistry,
  SessionMeta,
  ToolId,
  WriteResult,
} from '@session-migrate/core';

/** Tools this plugin can import FROM (target is always DSH). */
export const SOURCE_TOOLS: ToolId[] = ['dsh', 'claude', 'codex', 'opencode', 'pi', 'zcode'];

export type { SessionMeta, ToolId, WriteResult };

/** Structured failure — commands never let exceptions escape to the host. */
export interface CommandError {
  ok: false;
  error: string;
}

export interface ListSourcesResult {
  ok: true;
  tool: ToolId;
  sessions: SessionMeta[];
}

export interface PreviewResult {
  ok: true;
  tool: ToolId;
  sessionId: string;
  /** Full offline text preview (host may truncate for display). */
  text: string;
}

export interface ImportResult {
  ok: true;
  source: { tool: ToolId; sessionId: string };
  target: WriteResult;
}

export type ListSourcesOutcome = ListSourcesResult | CommandError;
export type PreviewOutcome = PreviewResult | CommandError;
export type ImportOutcome = ImportResult | CommandError;

export interface ImportOptions {
  /** Source root override (where the source tool's sessions live). */
  srcRoot?: string;
  /** Working directory to stamp on the new DSH session (defaults to IR cwd). */
  targetCwd?: string;
  /** Override the new DSH session id (core generates one when omitted). */
  sessionId?: string;
  /** DSH sessions root override — tests/smoke pass a temp dir here. */
  root?: string;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isSourceTool(tool: string): tool is ToolId {
  return SOURCE_TOOLS.includes(tool as ToolId);
}

/**
 * `/session-migrate list-sources <tool> [--root <dir>]`
 *
 * Lists a source tool's sessions (title / time / id / cwd) via the shared
 * registry. Read-only.
 */
export async function listSources(tool: string, root?: string): Promise<ListSourcesOutcome> {
  try {
    if (!isSourceTool(tool)) {
      return { ok: false, error: `unknown tool "${tool}" — supported: ${SOURCE_TOOLS.join(', ')}` };
    }
    const registry = builtinRegistry();
    const sessions = await listSessions(registry.get(tool), root);
    return { ok: true, tool, sessions };
  } catch (e) {
    return { ok: false, error: `list-sources ${tool} failed: ${messageOf(e)}` };
  }
}

/**
 * `/session-migrate preview <tool> <sessionId> [--root <dir>]`
 *
 * Parses the source session into IR and renders the offline text preview.
 * Read-only.
 */
export async function preview(tool: string, sessionId: string, root?: string): Promise<PreviewOutcome> {
  try {
    if (!isSourceTool(tool)) {
      return { ok: false, error: `unknown tool "${tool}" — supported: ${SOURCE_TOOLS.join(', ')}` };
    }
    if (!sessionId) {
      return { ok: false, error: 'preview requires a session id (see list-sources)' };
    }
    const registry = builtinRegistry();
    const ir = await readSource(registry, tool, sessionId, root);
    const text = previewSession(registry.get(tool), ir);
    return { ok: true, tool, sessionId, text };
  } catch (e) {
    return { ok: false, error: `preview ${tool}:${sessionId} failed: ${messageOf(e)}` };
  }
}

/**
 * `/session-migrate import <tool> <sessionId> [--src-root <dir>] [--cwd <dir>] [--root <dstRoot>]`
 *
 * Parses the source session into IR, then writes it into DSH's native
 * resumable storage as a BRAND-NEW session (fresh id; existing sessions
 * are never overwritten — core's write side guarantees this). The cwd
 * mapping is the DSH adapter's own: absolute target cwd → `--<projectKey>--`
 * layout, non-absolute/missing → `_no-cwd` (core degrades safely).
 */
export async function importSession(
  srcTool: string,
  srcSessionId: string,
  opts: ImportOptions = {},
): Promise<ImportOutcome> {
  try {
    if (!isSourceTool(srcTool)) {
      return { ok: false, error: `unknown tool "${srcTool}" — supported: ${SOURCE_TOOLS.join(', ')}` };
    }
    if (!srcSessionId) {
      return { ok: false, error: 'import requires a source session id (see list-sources)' };
    }
    const registry: AdapterRegistry = builtinRegistry();
    const ir = await readSource(registry, srcTool, srcSessionId, opts.srcRoot);
    const dsh = registry.get('dsh');
    const target = await writeTarget(dsh, ir, {
      root: opts.root,
      targetCwd: opts.targetCwd ?? ir.cwd,
      sessionId: opts.sessionId,
    });
    return { ok: true, source: { tool: srcTool, sessionId: srcSessionId }, target };
  } catch (e) {
    return { ok: false, error: `import ${srcTool}:${srcSessionId} failed: ${messageOf(e)}` };
  }
}
