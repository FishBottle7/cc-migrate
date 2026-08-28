/**
 * Claude Code path-encoding helpers.
 *
 * Verified rule (real data): a session's project directory is the source cwd
 * with every non-alphanumeric character collapsed to a single `-`.
 *   D:\codes\flutterProjects\focus_me_full\focus_me
 *     -> D--codes-flutterProjects-focus-me-full-focus-me
 */

/** Encode an absolute cwd into Claude's project directory name. */
export function claudeProjectDirName(cwd: string): string {
  let out = '';
  for (const ch of cwd) {
    // Every non-alphanumeric char maps to exactly one `-` (verified:
    // `D:\codes\...` -> `D--codes`, i.e. `:` and `\` each yield a dash).
    out += /^[A-Za-z0-9]$/.test(ch) ? ch : '-';
  }
  return out;
}

/** Default Claude projects root. */
export function defaultClaudeProjectsRoot(): string | null {
  const home = process.env.HOME || (process.env.USERPROFILE ?? null);
  return home ? `${home}\\.claude\\projects` : null;
}