/**
 * session-migrate DSH cordis plugin entry.
 *
 * Thin shell around `@session-migrate/core` (design.md §5): the plugin only
 * exposes the "any tool → DSH" line as slash commands. All migration logic
 * lives in the shared core; this file deals purely with registration,
 * argument parsing and fiber-clean disposal.
 *
 * Commands registered (design.md §5 conventions):
 *   /session-migrate list-sources [tool] [--root <dir>]
 *   /session-migrate preview <tool> <sessionId> [--root <dir>]
 *   /session-migrate import <tool> <sessionId> [--cwd <dir>] [--root <dstRoot>]
 *
 * Structural typing only — no cordis import, so the plugin stays
 * independent of the exact @deepseek-ai/cordis version DSH ships.
 */

import {
  importSession,
  listSources,
  preview,
  SOURCE_TOOLS,
} from './commands.js';
import type { GuiHost } from './gui.js';

/**
 * Minimal structural type against the DSH host ctx (same discipline as the
 * opencode2dsh plugin): keeps this package free of a hard cordis dependency.
 *
 * `commands` is the minimal assumption about DSH's command service: a
 * `register(name, handler)` returning an unregister function. If the real
 * DSH host service ends up named/ shaped differently, only this interface
 * and the single `ctx.commands` access point need adjusting — the command
 * layer itself is host-agnostic. (DSH host service names follow the host;
 * see README.)
 */
interface PluginContext {
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
  /** Minimal assumed shape of DSH's slash-command service. */
  commands?: { register(name: string, handler: (...args: string[]) => unknown): () => void };
  /**
   * Optional GUI service (design.md Phase 3 §15): when the host exposes one,
   * the session-migrate wizard mounts through it. Same structural-typing
   * discipline — see src/gui.ts's GuiHost for the full protocol. Hosts
   * without a GUI keep the commands-only behavior (backward compatible).
   */
  gui?: GuiHost;
  /** cordis fiber cleanup: the returned disposer runs on plugin unload. */
  effect?(fn: () => () => void): unknown;
}

/** Plugin config (bundle patch `config: {}` for now; reserved for GUI phase). */
export interface SessionMigrateConfig {
  /** Default DSH sessions root override (defaults to ~/.dsh/sessions). */
  dstRoot?: string;
}

export const name = 'session-migrate';
// `inject` declares the services this plugin consumes from the DSH host.
// DSH's command registry is provided by the 'commands' service (same pattern
// the llm plugin uses with 'llm'/'credentials'/'settings'). The access in
// apply() is still defensive: if the service is absent the plugin logs and
// stays a no-op instead of crashing the host.
export const inject = ['commands'] as const;

/** A slash-command invocation: argv-style tokens after the command name. */
interface CommandInvocation {
  /** Positional arguments (tool, sessionId, ...). */
  positionals: string[];
  /** --flag value pairs (--root X --cwd Y). */
  flags: Record<string, string | true>;
}

/** Parse `["claude", "--root", "X"]` into `{ positionals, flags }`. */
export function parseArgs(argv: string[]): CommandInvocation {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}

function flagString(flags: Record<string, string | true>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

/** Format a listed session for one-line display in the host. */
export function formatSessionLine(idx: number, m: { sessionId: string; title?: string; createdAt?: number; cwd?: string }): string {
  const iso = m.createdAt ? new Date(m.createdAt).toISOString().slice(0, 19).replace('T', ' ') : '—';
  const title = m.title ? truncate(m.title, 40) : '';
  const cwd = m.cwd ? truncate(m.cwd, 32) : '';
  const tail = [title, cwd].filter(Boolean).join(' | ');
  return `${String(idx + 1).padStart(3)}. ${m.sessionId}  ${iso}${tail ? '  ' + tail : ''}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Registered command names, for tests to assert against. */
export const COMMAND_NAMES = ['list-sources', 'preview', 'import'] as const;

/**
 * Plugin apply: registers the three /session-migrate subcommands.
 *
 * Each `commands.register` call returns an unregister function; every one is
 * routed through `ctx.effect` so the cordis fiber disposal unregisters all
 * of them on plugin reload/unload/shutdown. There are no timers and no
 * child processes — dispose is purely the unregister set.
 */
export function apply(ctx: PluginContext, config: SessionMigrateConfig = {}): void {
  const logger = ctx.logger;
  const defaultRoot = config.dstRoot;

  const register = (name: string, handler: (...args: string[]) => unknown): void => {
    const disposer = ctx.commands?.register(name, handler);
    if (disposer) {
      ctx.effect?.(() => disposer);
    }
  };

  // -- /session-migrate list-sources [tool] [--root <dir>] --
  register('list-sources', async (...argv: string[]) => {
    const { positionals, flags } = parseArgs(argv);
    const tool = positionals[0] ?? 'dsh';
    const root = flagString(flags, 'root') ?? flagString(flags, 'src-root');
    const res = await listSources(tool, root);
    if (!res.ok) return res;
    const lines = [`found ${res.sessions.length} session(s) in ${tool}${root ? ` @ ${root}` : ''}`];
    res.sessions.slice(0, 50).forEach((m, i) => lines.push(formatSessionLine(i, m)));
    if (res.sessions.length > 50) lines.push(`  ... ${res.sessions.length - 50} more (use preview/import with a session id)`);
    logger.info(lines.join('\n'));
    return res;
  });

  // -- /session-migrate preview <tool> <sessionId> [--root <dir>] --
  register('preview', async (...argv: string[]) => {
    const { positionals, flags } = parseArgs(argv);
    const [tool, sessionId] = positionals;
    if (!tool || !sessionId) {
      return { ok: false as const, error: `usage: /session-migrate preview <tool> <sessionId> [tool: ${SOURCE_TOOLS.join('|')}]` };
    }
    const root = flagString(flags, 'root') ?? flagString(flags, 'src-root');
    const res = await preview(tool, sessionId, root);
    if (res.ok) logger.info(res.text);
    return res;
  });

  // -- /session-migrate import <tool> <sessionId> [--src-root <dir>] [--cwd <dir>] [--root <dstRoot>] --
  register('import', async (...argv: string[]) => {
    const { positionals, flags } = parseArgs(argv);
    const [tool, sessionId] = positionals;
    if (!tool || !sessionId) {
      return { ok: false as const, error: `usage: /session-migrate import <tool> <sessionId> [--src-root <dir>] [--cwd <dir>] [tool: ${SOURCE_TOOLS.join('|')}]` };
    }
    const res = await importSession(tool, sessionId, {
      // --src-root points at the SOURCE tool's storage (e.g. a custom claude dir).
      srcRoot: flagString(flags, 'src-root'),
      targetCwd: flagString(flags, 'cwd'),
      sessionId: flagString(flags, 'session-id'),
      // The DSH write side: --root/--dst-root point at the DSH sessions dir.
      root: flagString(flags, 'root') ?? flagString(flags, 'dst-root') ?? defaultRoot,
    });
    if (res.ok) {
      logger.info(`imported ${res.source.tool}:${res.source.sessionId} -> dsh:${res.target.sessionId}\n  ${res.target.paths.join('\n  ')}`);
    } else {
      logger.error(res.error);
    }
    return res;
  });

  logger.info(`session-migrate: registered ${COMMAND_NAMES.length} commands (/session-migrate ${COMMAND_NAMES.join(' | ')})`);

  // -- optional GUI wizard: only when the host exposes a gui service --
  // 挂载走动态 import（src/gui.ts 再动态 import ui 组件），老宿主没有
  // ctx.gui 时这里完全零成本；unmount 也走 ctx.effect，和命令同一套 fiber 清理。
  if (ctx.gui) {
    ctx.effect?.(() => {
      let disposed = false;
      void (async () => {
        const { createSessionMigrateWizard } = await import('./gui.js');
        if (disposed) return;
        const handle = await createSessionMigrateWizard(ctx.gui!, {
          container: undefined,
          dstRoot: defaultRoot,
        });
        if (disposed) handle.dispose();
      })().catch((e) => {
        ctx.logger.warn(`session-migrate gui: wizard mount skipped/failed: ${e instanceof Error ? e.message : String(e)}`);
      });
      return () => {
        disposed = true;
      };
    });
  }
}

// Re-export the command layer so hosts/tests can import everything from the
// plugin entry without reaching into internals. The GUI layer stays on its own
// entry (`./gui`): importing this entry must not drag in the Vue-side module.
export { importSession, listSources, preview, SOURCE_TOOLS } from './commands.js';
export type {
  CommandError,
  ImportOptions,
  ImportOutcome,
  ImportResult,
  ListSourcesOutcome,
  ListSourcesResult,
  PreviewOutcome,
  PreviewResult,
} from './commands.js';
