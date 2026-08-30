/**
 * Claude Code path-encoding helpers.
 *
 * Authoritative rule (src/utils/sessionStoragePortable.ts:293-318, cross-checked
 * against 2.1.251 — docs/agents/claude.md §1): the project directory name is the
 * source cwd with EVERY non-alphanumeric character replaced by one `-`, and —
 * when the result exceeds MAX_SANITIZED_LENGTH — truncated to 200 chars plus a
 * `-` + hash suffix (Bun.hash(name).toString(36); non-Bun: djb2-based simpleHash).
 *
 *   D:\codes\flutterProjects\focus_me_full\focus_me
 *     -> D--codes-flutterProjects-focus-me-full-focus-me
 *
 * Note the difference from DSH `projectKey`: DSH collapses runs of separators
 * into a single `-`; Claude maps each character individually. Never normalize
 * between the two.
 */

import { join } from 'node:path';

/** sessionStoragePortable.ts:293 — leaves room for the hash suffix within 255-byte name limits. */
export const MAX_SANITIZED_LENGTH = 200;

/** src/utils/hash.ts:7 — djb2, 32-bit truncated. */
function djb2Hash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

/** sessionStoragePortable.ts:296 — the non-Bun fallback for the truncation suffix. */
function simpleHash(str: string): string {
  return Math.abs(djb2Hash(str)).toString(36);
}

/** Bun.hash(name).toString(36) when running under Bun; simpleHash otherwise. */
function hashSuffix(name: string): string {
  const bunGlobal = (globalThis as { Bun?: { hash?: (s: string) => number | bigint } }).Bun;
  if (typeof bunGlobal?.hash === 'function') {
    return bunGlobal.hash(name).toString(36);
  }
  return simpleHash(name);
}

/** Encode an absolute cwd into Claude's project directory name (sessionStoragePortable.sanitizePath). */
export function claudeProjectDirName(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hashSuffix(cwd)}`;
}

/**
 * Default Claude projects root. `CLAUDE_CONFIG_DIR` overrides the whole config
 * home (src/utils/envUtils.ts:7), so the projects root is `$CLAUDE_CONFIG_DIR/projects`.
 */
export function defaultClaudeProjectsRoot(): string | null {
  const envDir = process.env.CLAUDE_CONFIG_DIR;
  if (envDir) return join(envDir, 'projects');
  const home = process.env.HOME || (process.env.USERPROFILE ?? null);
  return home ? join(home, '.claude', 'projects') : null;
}
