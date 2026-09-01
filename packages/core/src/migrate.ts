/**
 * Orchestration: parse(source) -> IR -> write(target).
 *
 * The CLI, DSH plugin and desktop app all call these helpers. GUI flows are
 * naturally supported: listSessions/preview come from the same adapters.
 */

import type { MigratedSession, SessionMeta } from './ir.js';
import { validateSession } from './ir.js';
import type { Adapter, AdapterRegistry, WriteOptions, WriteResult } from './registry.js';

export interface MigrateOptions extends WriteOptions {
  /** Session id in the *source* tool. */
  sourceSessionId: string;
}

/**
 * Parse a source session into IR. The engine validates the adapter's output
 * at this chokepoint — validation is enforced here, not left to adapter
 * discipline (hardening layer 3).
 */
export async function readSource(registry: AdapterRegistry, sourceTool: string, sessionId: string, sourceRoot?: string): Promise<MigratedSession> {
  const adapter = registry.get(sourceTool as never);
  return validateSession(await adapter.parse(sessionId, sourceRoot));
}

/** Write IR into the target tool. Adapter-internal validateSession calls stay as a second net. */
export async function writeTarget(
  adapter: Adapter,
  ir: MigratedSession,
  opts?: WriteOptions,
): Promise<WriteResult> {
  validateSession(ir);
  return adapter.write(ir, opts);
}

/** Preview a session as pure offline text (no LLM). */
export function previewSession(adapter: Adapter, ir: MigratedSession): string {
  return adapter.preview(ir);
}

/** List sessions of a tool. */
export function listSessions(adapter: Adapter, root?: string): Promise<SessionMeta[]> {
  return adapter.listSessions(root);
}