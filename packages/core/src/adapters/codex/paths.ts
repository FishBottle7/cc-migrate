/**
 * Codex storage path helpers.
 *
 * Layout (source-anchored, `core/src/rollout/list.rs:379`):
 *   - Sessions: `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`
 *   - Name index: `<CODEX_HOME>/session_index.jsonl` (append-only, optional for resume-by-id)
 *
 * CODEX_HOME resolution mirrors the Codex CLI: `CODEX_HOME` env, else `~/.codex`.
 */

import { homedir } from 'node:os';
import { sep, join } from 'node:path';

export function defaultCodexHome(): string | undefined {
  if (process.env.CODEX_HOME && process.env.CODEX_HOME.trim()) {
    return process.env.CODEX_HOME;
  }
  const home = homedir();
  return home ? join(home, '.codex') : undefined;
}

/** Return `{ dir, rel, name }` — the absolute dir, path relative to it, and filename. */
export function rolloutName(id: string, createdAt: number): string {
  const ts = formatRolloutTimestamp(new Date(createdAt));
  return `rollout-${ts}-${id}.jsonl`;
}

function formatRolloutTimestamp(d: Date): string {
  // Matches e.g. `2026-01-12T20-55-48` (no colons; seconds precision).
  const p2 = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
    `T${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`
  );
}

/** Build the per-session dir (YYYY/MM/DD) and the final relative file name. */
export function codexSessionDirFor(
  codexHome: string,
  id: string,
  createdAt: number,
): { dir: string; rel: string } {
  const d = new Date(createdAt);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const dir = join(codexHome, 'sessions', String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
  const rel = rolloutName(id, createdAt);
  return { dir, rel };
}

export function sessionIndexPath(codexHome: string): string {
  return join(codexHome, 'session_index.jsonl');
}

/** Prefer native path separators for display but keep `sep` import used. */
export function toNative(p: string): string {
  return p.split(/[\\/]/).join(sep);
}