/**
 * cc-migrate DSH plugin — GUI wizard mounting layer (design.md Phase 3
 * 第 15 项：向导「选会话 → 预览 → 配置 → 写入」).
 *
 * DSH 宿主提供一个 `GuiHost`（挂载点 + 数据通道），本文件把宿主通道桥接成
 * ui 组件的 `MigrationBackend` 契约，再经宿主的 `mount()` 把 `MigrateWizard`
 * 挂进宿主容器。这是对 DSH 前端的最小假设——与 src/index.ts 的
 * `PluginContext` 同款结构类型纪律：宿主服务名/形状以宿主为准，只有这一处
 * 访问点需要跟着宿主调整。
 *
 * ── 沙箱边界纪律（不可违反）──────────────────────────────────────
 * 本层【绝不 import @cc-migrate/core】：GUI 层不知道迁移引擎的存在。
 * 所有数据经 GuiHost 注入的通道函数走宿主转发到命令层（src/commands.ts），
 * 宿主自行处理沙箱/线程边界（DSH 前端可能是 worker / iframe / 独立 VM，
 * core 的 zstd 解压只能跑在宿主的 Node 侧）。同理 ui 组件也是动态 import：
 * 老 DSH 宿主只有命令层时，主入口不引本文件，命令层冒烟不被 Vue 运行时拖累。
 *
 * dispose：挂载层返回卸载函数；apply() 侧经 ctx.effect 交给 cordis fiber
 * 统一清理，本层自身不留任何定时器/子进程。
 */

import type {
  ImportOptions,
  ListSourcesOutcome,
  PreviewOutcome,
  PreviewPayload,
  PreviewPayloadOutcome,
} from './commands.js';
import type { CommandError } from './commands.js';

/**
 * Minimal structural type for the DSH host's GUI service. The host provides:
 *  - a mount point protocol (any container the host understands — DOM
 *    element, web component slot, id string; the wizard never touches it
 *    directly, only `mount()` does), and
 *  - the data channel forwarding to the command layer (the host decides
 *    WHERE the commands run; the GUI layer stays sandbox-clean).
 */
export interface GuiHost {
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
  /**
   * Mount `component` (a Vue component from @cc-migrate/ui) with `props`
   * into `container` (host-defined: DOM element or equivalent). Returns an
   * unmount function.
   */
  mount(container: unknown, component: unknown, props: Record<string, unknown>): () => void;
  /**
   * Data channel — all forwarded by the host to the command layer
   * (src/commands.ts). Shapes are the command layer's result/outcome types;
   * the GUI layer never imports core.
   */
  listSources(tool: string, root?: string): Promise<ListSourcesOutcome>;
  preview(tool: string, sessionId: string, root?: string): Promise<PreviewOutcome | PreviewPayloadOutcome>;
  importSession(srcTool: string, srcSessionId: string, opts?: ImportOptions): Promise<import('./commands.js').ImportOutcome>;
}

/** Tool card metadata (ui `ToolInfo` shape; structural, no ui import needed). */
export interface GuiToolInfo {
  id: string;
  label: string;
  defaultRoot: string;
}

/** Wizard start options. */
export interface WizardMountOptions {
  /** Host-side container (DOM element or equivalent) to mount into. */
  container: unknown;
  /** Default DSH sessions root (from plugin config `dstRoot`). */
  dstRoot?: string;
}

/** Result of `createSessionMigrateWizard`. */
export interface WizardHandle {
  /** Runs the host unmount chain. Safe to call twice. */
  dispose(): void;
  /** The `MigrationBackend` object handed to MigrateWizard (host may reuse it). */
  backend: Record<string, unknown>;
}

/** Source tools the wizard offers (order = UI card order). */
export const GUI_SOURCE_TOOLS: GuiToolInfo[] = [
  { id: 'dsh', label: 'DSH', defaultRoot: '~/.dsh/sessions' },
  { id: 'claude', label: 'Claude Code', defaultRoot: '~/.claude/projects' },
  { id: 'codex', label: 'Codex', defaultRoot: '~/.codex/sessions' },
  { id: 'pi', label: 'Pi', defaultRoot: '~/.pi/agent/sessions' },
  { id: 'opencode', label: 'OpenCode', defaultRoot: '~/.local/share/opencode/opencode.db' },
  { id: 'zcode', label: 'ZCode', defaultRoot: '~/.zcode/cli/db/db.sqlite' },
];

/** ui `MigrateOutcome` shape: what the wizard shows on its done step. */
interface GuiMigrateOutcome {
  tool: string;
  sessionId: string;
  paths: string[];
}

/** ui `MigrateParams` shape: the wizard's target-step configuration. */
interface GuiMigrateParams {
  srcTool: string;
  srcRoot?: string;
  sessionId: string;
  dstTool: string;
  dstRoot?: string;
  targetCwd?: string;
  flatten?: boolean;
  keepSynthetic?: boolean;
}

/** Throw the structured error text — ui components render thrown messages. */
function fail(res: CommandError): never {
  throw new Error(res.error);
}

/**
 * Build the `MigrationBackend` bridge (ui 组件契约) from a `GuiHost`.
 *
 * Mapping notes:
 *  - `listTools` — static metadata, no host round-trip.
 *  - `listSessions` — host channel → command layer `listSources`; empty
 *    array on unknown tool (the wizard's tool cards are already gated).
 *  - `preview` — host channel → command layer `previewPayload` (structured
 *    DTO; the GUI never consumes the CLI's flat text).
 *  - `migrate` — host channel → command layer `importSession`; the target
 *    is pinned to `dsh` (this plugin's one line: any tool → DSH), the
 *    wizard's dstTool choice is validated but only 'dsh' is accepted.
 *  - `pickDirectory` / `openPath` — host dialog services, optional: absent
 *    services log a warning instead of crashing (headless hosts).
 */
export function createWizardBackend(host: GuiHost, opts: { dstRoot?: string } = {}): Record<string, unknown> {
  const dstRoot = opts.dstRoot?.trim() || undefined;

  const backend = {
    async listTools(): Promise<GuiToolInfo[]> {
      return GUI_SOURCE_TOOLS;
    },

    async listSessions(tool: string, root?: string): Promise<unknown[]> {
      const res = await host.listSources(tool, root);
      if (!res.ok) {
        // 列表失败对向导是「空结果 + 可见错误」而不是崩溃（SessionPicker 吃 error 文案）
        throw new Error(res.error);
      }
      return res.sessions;
    },

    async preview(tool: string, sessionId: string, root?: string): Promise<PreviewPayload> {
      const res = await host.preview(tool, sessionId, root);
      if ('ok' in res && res.ok === false) fail(res);
      if ('text' in res) {
        // Host channel routed to the CLI text preview — the GUI needs the
        // structured payload; surface as an explicit protocol error.
        throw new Error('host preview channel returned text; expected the structured payload (PreviewPayload)');
      }
      return res as PreviewPayload;
    },

    async migrate(params: GuiMigrateParams): Promise<GuiMigrateOutcome> {
      // 本插件只有一条线：任意工具 → DSH。向导目标步骤选了别的目标时在这里挡下。
      if (params.dstTool !== 'dsh') {
        throw new Error(`target "${params.dstTool}" is not supported by the DSH plugin — only "dsh"`);
      }
      const res = await host.importSession(params.srcTool, params.sessionId, {
        srcRoot: params.srcRoot,
        targetCwd: params.targetCwd,
        root: params.dstRoot ?? dstRoot,
        flatten: params.flatten,
        keepSynthetic: params.keepSynthetic,
      });
      if (res.ok === false) throw new Error(res.error);
      return {
        tool: res.target.tool,
        sessionId: res.target.sessionId,
        paths: res.target.paths,
      };
    },

    async pickDirectory(_defaultPath?: string): Promise<string | null> {
      const picker = (host as { pickDirectory?(defaultPath?: string): Promise<string | null> }).pickDirectory;
      if (!picker) {
        host.logger.warn('cc-migrate gui: host provides no directory picker — showing the raw input only');
        return null;
      }
      return picker(_defaultPath);
    },

    async openPath(path: string): Promise<void> {
      const opener = (host as { openPath?(path: string): Promise<void> }).openPath;
      if (!opener) {
        host.logger.warn(`cc-migrate gui: host provides no openPath — path not opened: ${path}`);
        return;
      }
      return opener(path);
    },
  };
  return backend as Record<string, unknown>;
}

/**
 * Mount the cc-migrate wizard into a host container.
 *
 * Composition choice: ui's ready-made `MigrateWizard` — it already assembles
 * ToolSelect → SessionPicker + SessionPreview → TargetConfig with the exact
 * 「选会话 → 预览 → 配置 → 写入」 flow this phase asks for (the desktop app
 * mounts it the same way with a `MigrationBackend` prop). Re-composing the
 * three pieces by hand would duplicate that flow state machine for zero gain.
 *
 * The component is loaded DYNAMICALLY so importing this module does not pull
 * `vue`/SFC sources at command-layer time: the host bundles the ui package
 * (source package), and a host without a bundled frontend just sees the
 * mount() promise reject with a clear reason. `opts.loadWizardComponent`
 * lets a host (or the headless smoke) inject its own bundled copy — the
 * default dynamic import is untouched.
 */
export async function createSessionMigrateWizard(
  host: GuiHost,
  opts: WizardMountOptions & { loadWizardComponent?: () => Promise<unknown> } = { container: undefined },
): Promise<WizardHandle> {
  const backend = createWizardBackend(host, { dstRoot: opts.dstRoot });

  // 动态 import：ui 是源码包（main: src/index.ts，.vue 由宿主构建编译）。
  // 任何失败（宿主没打包 ui / 沙箱不允许）都变成可读错误而不是炸宿主。
  const load = opts.loadWizardComponent ?? (async () => {
    const ui = (await import('@cc-migrate/ui')) as { MigrateWizard: unknown };
    return ui.MigrateWizard;
  });
  let MigrateWizard: unknown;
  try {
    MigrateWizard = await load();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `cc-migrate gui: cannot load @cc-migrate/ui (the host must bundle it — it is a source package): ${msg}`,
    );
  }
  if (!MigrateWizard || typeof MigrateWizard !== 'object') {
    throw new Error('cc-migrate gui: @cc-migrate/ui did not export a MigrateWizard component');
  }

  const unmount = host.mount(opts.container, MigrateWizard, { backend });

  let disposed = false;
  return {
    backend,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        unmount();
      } catch (e) {
        host.logger.warn(`cc-migrate gui: unmount threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}
