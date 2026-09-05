/**
 * Orchestration: parse(source) -> IR -> write(target).
 *
 * The CLI, DSH plugin and desktop app all call these helpers. GUI flows are
 * naturally supported: listSessions/preview come from the same adapters.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { MigratedSession, SessionMeta } from './ir.js';
import { validateSession } from './ir.js';
import type { Adapter, AdapterRegistry, WriteOptions, WriteResult } from './registry.js';

export interface MigrateOptions extends WriteOptions {
  /** Session id in the *source* tool. */
  sourceSessionId: string;
}

/**
 * Expand a leading `~`/`~/` in a user-supplied root path to the real home
 * directory. Adapters treat `root` as a literal filesystem path, so a `~`
 * that survives to them resolves against the process CWD (a literal `~`
 * directory) instead — the recurring "list works, preview fails" bug: GUI
 * inputs default to display-friendly `~/.claude/projects` strings.
 *
 * THE chokepoint: this file's readSource/writeTarget/listSessions are the
 * last stop before every root touches the filesystem. Expanding here covers
 * every frontend (standalone CLI, DSH plugin commands, desktop app, GUI)
 * once and for all — frontends must NOT pre-expand (double expansion is
 * idempotent-safe, but one canonical spot beats N copies drifting).
 *
 * Idempotent: an already-absolute path passes through untouched; `~user`
 * stays literal (that's shell territory, not ours).
 */
export function expandHomeRoot(p: string | undefined): string | undefined {
  if (p === undefined || p === '') return undefined;
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Parse a source session into IR. The engine validates the adapter's output
 * at this chokepoint — validation is enforced here, not left to adapter
 * discipline (hardening layer 3).
 */
export async function readSource(registry: AdapterRegistry, sourceTool: string, sessionId: string, sourceRoot?: string): Promise<MigratedSession> {
  const adapter = registry.get(sourceTool as never);
  return validateSession(await adapter.parse(sessionId, expandHomeRoot(sourceRoot)));
}

/** Write IR into the target tool. Adapter-internal validateSession calls stay as a second net. */
export async function writeTarget(
  adapter: Adapter,
  ir: MigratedSession,
  opts?: WriteOptions,
): Promise<WriteResult> {
  validateSession(ir);
  return adapter.write(ir, { ...opts, ...(opts?.root !== undefined ? { root: expandHomeRoot(opts.root) } : {}) });
}

/** Preview a session as pure offline text (no LLM). */
export function previewSession(adapter: Adapter, ir: MigratedSession): string {
  return adapter.preview(ir);
}

/** List sessions of a tool. */
export function listSessions(adapter: Adapter, root?: string): Promise<SessionMeta[]> {
  return adapter.listSessions(expandHomeRoot(root));
}