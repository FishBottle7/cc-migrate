/**
 * cc-migrate DSH cordis plugin entry.
 *
 * Thin shell around `@cc-migrate/core` (design.md §5): the plugin only
 * exposes the "any tool → DSH" line as slash commands. All migration logic
 * lives in the shared core; this file deals purely with registration,
 * argument parsing and fiber-clean disposal.
 *
 * Commands registered (design.md §5 conventions):
 *   /cc-migrate list-sources [tool] [--root <dir>]
 *   /cc-migrate preview <tool> <sessionId> [--root <dir>]
 *   /cc-migrate import <tool> <sessionId> [--cwd <dir>] [--root <dstRoot>]
 *
 * Structural typing only — no cordis import, so the plugin stays
 * independent of the exact @deepseek-ai/cordis version DSH ships.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  importSession,
  listSources,
  preview,
  SOURCE_TOOLS,
} from './commands.js';
import type { GuiHost } from './gui.js';
import { registerMigrateRoutes } from './routes.js';
import { registerSkill } from './skill.js';
import type { SkillHostContext } from './skill.js';

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
  /**
   * dsh-commands 宿主契约（真机加载验证锚定，@deepseek-ai/dsh-commands 的
   * normalizeDefinition/normalizeResult）：register(definition) 收
   * {name, description, input?, recordInput?, handler}——description 必填
   * 非空（缺失时 normalizeDefinition 抛 TypeError 炸整棵插件树），handler
   * 收单个 invocation（rawInput = 命令名后的原始文本）、必须返回
   * CommandResult {kind, text}。返回注销函数（fiber 清理用）。
   */
  commands?: { register(definition: { name: string; description: string; input?: { hint: string; images?: boolean }; recordInput?: boolean; handler: (invocation: CommandInvocation) => Promise<CommandResult> | CommandResult }): () => void };
  /**
   * Optional GUI service (design.md Phase 3 §15): when the host exposes one,
   * the cc-migrate wizard mounts through it. Same structural-typing
   * discipline — see src/gui.ts's GuiHost for the full protocol. Hosts
   * without a GUI keep the commands-only behavior (backward compatible).
   */
  gui?: GuiHost;
  /**
   * 宿主 webserver 服务（GUI 双半的数据通道，src/routes.ts）：better-sidebar
   * 同款 `register({kind, path, handler}) => disposer`。webRuntime 提供 fence
   * 用的 trustedHosts 活性值。两者都是结构类型——缺任一时 GUI 路由跳过，
   * 命令层照常（老宿主向后兼容）。
   */
  webServer?: import('./routes.js').MigrateWebServer;
  webRuntime?: import('./routes.js').MigrateWebRuntime;
  /**
   * 宿主 skill 注册表（@deepseek-ai/dsh-skill 的 ctx.skills，结构最小面）：
   * 对话式迁移的 agent skill（src/skill.ts + skills/cc-migrate/SKILL.md）经
   * register() 挂进宿主。缺服务时 warn 跳过（src/skill.ts 同款向后兼容纪律）。
   */
  skills?: import('./skill.js').HostSkillService;
  /** cordis fiber cleanup: the returned disposer runs on plugin unload. */
  effect?(fn: () => () => void): unknown;
}

/** Plugin config (bundle patch `config: {}` for now; reserved for GUI phase). */
export interface SessionMigrateConfig {
  /** Default DSH sessions root override (defaults to ~/.dsh/sessions). */
  dstRoot?: string;
}

export const name = 'cc-migrate';
// `inject` declares the services this plugin consumes from the DSH host.
// DSH's command registry is provided by the 'commands' service (same pattern
// the llm plugin uses with 'llm'/'credentials'/'settings'). The access in
// apply() is still defensive: if the service is absent the plugin logs and
// stays a no-op instead of crashing the host.
//
// 'webServer'/'webRuntime' 是 GUI 双半的 HTTP 通道（better-sidebar 同款）：
// webServer 挂 /cc-migrate/api fenced 路由，webRuntime 的 trustedHosts 是
// fence 的信任源（每请求现读）。'skills' 是对话式迁移的 agent skill 注册
// 面（src/skill.ts）：缺服务时 warn 跳过，不影响命令层。
export const inject = ['commands', 'webServer', 'webRuntime', 'skills'] as const;

/** A slash-command invocation: argv-style tokens after the command name. */
interface CommandInvocation {
  /** Positional arguments (tool, sessionId, ...). */
  positionals: string[];
  /** --flag value pairs (--root X --cwd Y). */
  flags: Record<string, string | true>;
}

/** Parse `["claude", "--root", "X"]` into `{ positionals, flags }`. */
export function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string | true> } {
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
export const COMMAND_NAMES = ['cc-migrate-list-sources', 'cc-migrate-preview', 'cc-migrate-import'] as const;

/**
 * dsh-commands 宿主契约（真机加载验证锚定，@deepseek-ai/dsh-commands/lib/index.js
 * 的 normalizeDefinition/normalizeResult/dispatch）：
 *  - 命令名是扁平小写 `^[a-z][a-z0-9_-]*$`——没有「插件名 子命令」的层级语法，
 *    三个子命令因此各自注册为独立命令，`cc-migrate-` 前缀即命名空间。
 *  - definition 必须 {name, description(非空 string), handler}——缺
 *    description 在 normalizeDefinition 直接抛 TypeError 并炸整棵插件树
 *    （真机首装时踩过：mock ctx 的宽松形状没拦住这个）。
 *  - handler 收单个 invocation {rawInput, agent, attachments, signal}，
 *    rawInput = 命令名之后的原始文本（含前导空格，dispatch 前自行 split）。
 *  - 返回值必须 {kind:'success'|'error', text}——裸返回命令层结果对象
 *    会被 normalizeResult 当 TypeError 拒绝。
 */
interface CommandInvocation {
  /** 命令名之后的原始输入（未分词，含前导空格）。 */
  rawInput: string;
  agent?: unknown;
  attachments?: unknown;
  signal?: AbortSignal;
}

interface CommandResult {
  kind: 'success' | 'error';
  text: string;
}

/**
 * Plugin apply: registers the three cc-migrate commands (flat dsh-command
 * names — see COMMAND_NAMES 头注的宿主契约)。
 *
 * Each `commands.register` call returns an unregister function; every one is
 * routed through `ctx.effect` so the cordis fiber disposal unregisters all
 * of them on plugin reload/unload/shutdown. There are no timers and no
 * child processes — dispose is purely the unregister set.
 */
export function apply(ctx: PluginContext, config: SessionMigrateConfig = {}): void {
  const logger = ctx.logger;
  const defaultRoot = config.dstRoot;

  const register = (name: string, description: string, run: (argv: string[]) => Promise<unknown>): void => {
    const disposer = ctx.commands?.register({
      name,
      description,
      handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
        const argv = String(invocation?.rawInput ?? '').trim().split(/\s+/).filter(Boolean);
        const res = (await run(argv)) as { ok?: boolean; error?: string } | undefined;
        if (res && res.ok === false) return { kind: 'error', text: res.error ?? 'command failed' };
        return { kind: 'success', text: typeof res === 'object' && res && 'summary' in res ? String((res as { summary?: string }).summary) : 'done' };
      },
    });
    if (disposer) {
      ctx.effect?.(() => disposer);
    }
  };

  // -- /cc-migrate-list-sources [tool] [--root <dir>] --
  register('cc-migrate-list-sources', 'list a source tool\'s sessions for migration (tool id, time, title)', async (argv) => {
    const { positionals, flags } = parseArgs(argv);
    const tool = positionals[0] ?? 'dsh';
    const root = flagString(flags, 'root') ?? flagString(flags, 'src-root');
    const res = await listSources(tool, root);
    if (!res.ok) return res;
    const lines = [`found ${res.sessions.length} session(s) in ${tool}${root ? ` @ ${root}` : ''}`];
    res.sessions.slice(0, 50).forEach((m, i) => lines.push(formatSessionLine(i, m)));
    if (res.sessions.length > 50) lines.push(`  ... ${res.sessions.length - 50} more (use cc-migrate-preview/cc-migrate-import with a session id)`);
    return { ...res, ok: true as const, summary: lines.join('\n') };
  });

  // -- /cc-migrate-preview <tool> <sessionId> [--root <dir>] --
  register('cc-migrate-preview', 'preview a source session as offline text before migrating', async (argv) => {
    const { positionals, flags } = parseArgs(argv);
    const [tool, sessionId] = positionals;
    if (!tool || !sessionId) {
      return { ok: false as const, error: `usage: /cc-migrate-preview <tool> <sessionId> [tool: ${SOURCE_TOOLS.join('|')}]` };
    }
    const root = flagString(flags, 'root') ?? flagString(flags, 'src-root');
    const res = await preview(tool, sessionId, root);
    if (res.ok) return { ...res, ok: true as const, summary: res.text };
    return res;
  });

  // -- /cc-migrate-import <tool> <sessionId> [--src-root <dir>] [--cwd <dir>] [--root <dstRoot>] --
  register('cc-migrate-import', 'import a source session into DSH as a resumable native session', async (argv) => {
    const { positionals, flags } = parseArgs(argv);
    const [tool, sessionId] = positionals;
    if (!tool || !sessionId) {
      return { ok: false as const, error: `usage: /cc-migrate-import <tool> <sessionId> [--src-root <dir>] [--cwd <dir>] [tool: ${SOURCE_TOOLS.join('|')}]` };
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
      return { ...res, ok: true as const, summary: `imported ${res.source.tool}:${res.source.sessionId} -> dsh:${res.target.sessionId}\n  ${res.target.paths.join('\n  ')}` };
    }
    return res;
  });

  logger.info(`cc-migrate: registered ${COMMAND_NAMES.length} commands (/${COMMAND_NAMES.join(' | /')})`);

  // -- 对话式迁移的 agent skill（src/skill.ts） --
  // 把 skills/cc-migrate/SKILL.md 注册进宿主 ctx.skills（正文 {{CLI_PATH}}
  // 替换为本机 lib/cli.js 绝对路径，agent 经 bash 零安装驱动迁移）。try/catch
  // 探测与 routes/gui 同款：宿主无 skills 服务时 warn 跳过，命令层照常。
  // ⚠ ctx 是按 inject 门禁的 Proxy——探测必须 try/catch 包裹，不能裸 if。
  let skillDisposer: (() => void) | undefined;
  try {
    const cliPath = join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
    skillDisposer = registerSkill(ctx as SkillHostContext & typeof ctx, cliPath);
  } catch (e) {
    logger.warn(`cc-migrate skill: skipped (${e instanceof Error ? e.message : String(e)})`);
    skillDisposer = undefined;
  }
  if (skillDisposer) {
    ctx.effect?.(() => skillDisposer as () => void);
  }

  // -- GUI 双半的宿主侧 HTTP 通道（src/routes.ts） --
  // better-sidebar 同款：fenced /cc-migrate/api 前缀路由 + 命令层实现。
  // ⚠ ctx 是按 inject 门禁的 Proxy：老宿主（无 webServer/webRuntime 服务）
  // 上访问直接抛——try/catch 探测，缺服务时命令层照常（向后兼容）。
  let routeDisposer: (() => void) | undefined;
  try {
    routeDisposer = registerMigrateRoutes(ctx as { webServer?: unknown; webRuntime?: unknown } & typeof ctx, { dstRoot: defaultRoot });
  } catch {
    routeDisposer = undefined; // 宿主无对应服务——GUI fetch 会 404，命令层不受影响
  }
  if (routeDisposer) {
    ctx.effect?.(() => routeDisposer as () => void);
  }

  // -- optional GUI wizard: only when the host exposes a gui service --
  // 挂载走动态 import（src/gui.ts 再动态 import ui 组件），老宿主没有
  // gui 服务时这里完全零成本；unmount 也走 ctx.effect，和命令同一套 fiber 清理。
  // ⚠ cordis 的 ctx 是按 inject 列表门禁的 Proxy：访问未 inject 的属性
  // 直接抛「cannot get property "gui" without inject」而不是返回 undefined
  // （真机首装验证踩过）——所以 gui 探测必须 try/catch 包裹，不能裸 if。
  let gui: GuiHost | undefined;
  try {
    gui = ctx.gui;
  } catch {
    gui = undefined; // 宿主未注入 gui 服务——命令层照常工作
  }
  if (gui) {
    const guiHost = gui;
    ctx.effect?.(() => {
      let disposed = false;
      void (async () => {
        const { createSessionMigrateWizard } = await import('./gui.js');
        if (disposed) return;
        const handle = await createSessionMigrateWizard(guiHost, {
          container: undefined,
          dstRoot: defaultRoot,
        });
        if (disposed) handle.dispose();
      })().catch((e) => {
        ctx.logger.warn(`cc-migrate gui: wizard mount skipped/failed: ${e instanceof Error ? e.message : String(e)}`);
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
export { loadSkillMd, parseSkillMd, registerSkill, renderSkillBody, skillDir } from './skill.js';
export type { ParsedSkillFile, SkillHostContext } from './skill.js';
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
