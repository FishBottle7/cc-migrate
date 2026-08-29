/**
 * Codex storage path helpers.
 *
 * Source-anchored (`D:\codes\Opensource\codex-main\codex-rs`):
 *   - Sessions  : `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>[_<rolloutId>].jsonl[.zst]`
 *     (rollout/src/rollout_file_name.rs:39-74; `_rolloutId` suffix marks a reverted thread).
 *   - Archives  : `<CODEX_HOME>/archived_sessions/…` (same format; rollout/src/list.rs:1595).
 *   - Name index: `<CODEX_HOME>/session_index.jsonl` (append-only, newest match wins,
 *     rollout/src/session_index.rs:24-71; entry = {id, thread_name, updated_at}).
 *
 * Filename quirk kept verbatim (docs/agents/codex.md §4): the recorder renders the
 * filename timestamp in LOCAL time while the parser re-reads it as UTC
 * (rollout_file_name.rs:54 `assume_utc`). We render UTC + build dirs in local
 * time — same behavior Codex itself has, don't "fix" it.
 *
 * CODEX_HOME resolution mirrors the Codex CLI: `$CODEX_HOME`, else `~/.codex`.
 */

import { randomUUID } from 'node:crypto';
import { join, sep } from 'node:path';
import { homedir as osHomedir } from 'node:os';

export function defaultCodexHome(): string | undefined {
  if (process.env.CODEX_HOME && process.env.CODEX_HOME.trim()) {
    return process.env.CODEX_HOME;
  }
  const home = osHomedir();
  return home ? join(home, '.codex') : undefined;
}

/**
 * uuidv7-semantic thread id (Codex ThreadId/RolloutId are uuidv7: 48-bit
 * unix-ms prefix + version 7 + RFC variant). Hand-rolled so Node 22 works too.
 */
export function uuidv7(): string {
  const b = randomUUID()
    .replace(/-/g, '')
    .match(/../g)!
    .map((h) => parseInt(h, 16));
  const ts = Date.now();
  b[0] = (ts / 2 ** 40) & 0xff;
  b[1] = (ts / 2 ** 32) & 0xff;
  b[2] = (ts / 2 ** 24) & 0xff;
  b[3] = (ts / 2 ** 16) & 0xff;
  b[4] = (ts / 2 ** 8) & 0xff;
  b[5] = ts & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.map((n) => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `rollout-<YYYY-MM-DDTHH-mm-ss>-<id>.jsonl` (or `...-<threadId>_<rolloutId>.jsonl`). */
export function rolloutFileName(threadId: string, createdAt: number, rolloutId?: string): string {
  return `rollout-${formatRolloutTimestampUtc(createdAt)}-${threadId}${rolloutId && rolloutId !== threadId ? `_${rolloutId}` : ''}.jsonl`;
}

/**
 * Filename timestamp rendered in UTC (official format has no offset; the
 * recorder writes local time here, the parser reads it back as UTC — quirk
 * preserved, docs/agents/codex.md §4).
 */
export function formatRolloutTimestampUtc(createdAt: number): string {
  const d = new Date(createdAt);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}` +
    `T${p2(d.getUTCHours())}-${p2(d.getUTCMinutes())}-${p2(d.getUTCSeconds())}`
  );
}

/**
 * Parse a rollout file name → `{ createdAt, threadId, rolloutId, compressed }`
 * (rollout_file_name.rs:39-60: ts is 19 chars, parsed as UTC).
 * Returns null for non-rollout names.
 */
export function parseRolloutFileName(name: string): { createdAt: number; threadId: string; rolloutId: string; compressed: boolean } | null {
  const compressed = name.endsWith('.jsonl.zst');
  const core = compressed ? name.slice(0, -'.zst'.length) : name;
  if (!core.startsWith('rollout-') || !core.endsWith('.jsonl')) return null;
  const body = core.slice('rollout-'.length, -'.jsonl'.length);
  const ts = body.slice(0, 19);
  if (body[19] !== '-') return null;
  const ids = body.slice(20);
  const under = ids.indexOf('_');
  const threadId = under >= 0 ? ids.slice(0, under) : ids;
  const rolloutId = under >= 0 ? ids.slice(under + 1) : threadId;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/.exec(ts);
  if (!m || !threadId || !rolloutId) return null;
  const createdAt = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (!Number.isFinite(createdAt)) return null;
  return { createdAt, threadId, rolloutId, compressed };
}

/** `sessions/YYYY/MM/DD/` built from LOCAL time (recorder.rs:1630 `now_local`). */
export function sessionDirFor(codexHome: string, createdAt: number): string {
  const d = new Date(createdAt);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return join(codexHome, 'sessions', String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
}

/** Convenience: absolute path for a new rollout file. */
export function codexSessionPathFor(codexHome: string, threadId: string, createdAt: number, rolloutId?: string): string {
  return join(sessionDirFor(codexHome, createdAt), rolloutFileName(threadId, createdAt, rolloutId));
}

export function archivedDir(codexHome: string): string {
  return join(codexHome, 'archived_sessions');
}

export function sessionIndexPath(codexHome: string): string {
  return join(codexHome, 'session_index.jsonl');
}

/** Rollout session id for a file name: the thread id (before the `_rolloutId` variant). */
export function sessionIdFromRolloutName(name: string): string | null {
  return parseRolloutFileName(name)?.threadId ?? null;
}

/** Prefer native path separators for display but keep `sep` import used. */
export function toNative(p: string): string {
  return p.split(/[\\/]/).join(sep);
}
