/**
 * session-migrate core — public entry.
 */

export * from './ir.js';
export * from './content.js';
export * from './registry.js';
export * from './migrate.js';
export * from './demo.js';
export * from './adapters/dsh/index.js';
export * from './adapters/claude/index.js';
export * from './adapters/codex/index.js';
export { projectKey, encodeSegment } from './adapters/dsh/format.js';
export { claudeProjectDirName } from './adapters/claude/path.js';
export { defaultCodexHome, sessionIndexPath } from './adapters/codex/paths.js';

import { createRegistry } from './registry.js';
import { DshAdapter } from './adapters/dsh/index.js';
import { ClaudeAdapter } from './adapters/claude/index.js';
import { CodexAdapter } from './adapters/codex/index.js';
import { PiAdapter } from './adapters/pi/index.js';
import { OpenCodeAdapter } from './adapters/opencode/index.js';

/** Build a registry with all built-in adapters wired. */
export function builtinRegistry() {
  const registry = createRegistry();
  registry.register(new DshAdapter());
  registry.register(new ClaudeAdapter());
  registry.register(new CodexAdapter());
  registry.register(new PiAdapter());
  registry.register(new OpenCodeAdapter());
  return registry;
}