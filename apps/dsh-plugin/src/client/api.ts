/**
 * cc-migrate client 半 — GUI 的 fetch 数据通道（对宿主半 fenced 路由的浏览器侧）。
 *
 * 为什么单独成文件：向导组件（wizard.tsx）只吃这个 api 对象，不感知
 * fetch/信封细节；宿主半 src/routes.ts 与本文件是同一 wire 协议的两端
 * （`/cc-migrate/api/<method>` POST JSON，`{ok:true,value}`/`{ok:false,error}`
 * 信封），改协议时两文件成对改。
 *
 * MigrationBackend 契约（MigrateWizard 同款语义，React 版）：
 *   listTools / listSessions / preview / migrate —— 前三者对宿主半路由；
 *   pickDirectory / openPath —— DSH 无宿主对话框服务，GUI 只提供手输路径，
 *   不做浏览器目录选择（Electron webkitdirectory 是桌面壳能力，别在 web
 *   profile 里留半行为）。
 */

import type {
  ImportOptions,
  ImportOutcome,
  ListSourcesOutcome,
  PreviewPayload,
  PreviewPayloadOutcome,
} from '../commands.js';

/** 工具卡片元数据（gui.ts 的 GuiToolInfo 同款；顺序 = UI 卡片顺序）。 */
export interface WizardToolInfo {
  id: string;
  label: string;
  defaultRoot: string;
}

/** 向导的工具卡列表（静态元数据，不走宿主——库地址是常识性默认值）。 */
export const WIZARD_SOURCE_TOOLS: WizardToolInfo[] = [
  { id: 'dsh', label: 'DSH', defaultRoot: '~/.dsh/sessions' },
  { id: 'claude', label: 'Claude Code', defaultRoot: '~/.claude/projects' },
  { id: 'codex', label: 'Codex', defaultRoot: '~/.codex/sessions' },
  { id: 'pi', label: 'Pi', defaultRoot: '~/.pi/agent/sessions' },
  { id: 'opencode', label: 'OpenCode', defaultRoot: '~/.local/share/opencode/opencode.db' },
  { id: 'zcode', label: 'ZCode', defaultRoot: '~/.zcode/cli/db/db.sqlite' },
];

/** Wire 信封（宿主半 routes.ts 的 {ok:true,value}/{ok:false,error}）。 */
interface WireOk<T> { ok: true; value: T }
type WireEnvelope<T> = WireOk<T> | { ok: false; error: { code: string; message: string } };

/**
 * 目标根回显（`defaults` 端点，v0.3.0 新增）：导入确认页红线「显式展示
 * 目标根」的数据源。dstRoot = 插件 bundle patch 的 config.dstRoot（未配置
 * null）；dshDefaultRoot = DSH 适配器的常识默认根（显示用）。
 */
export interface MigrateDefaults {
  dstRoot: string | null;
  dshDefaultRoot: string;
}

/**
 * 调一个宿主半 method。fetch 失败（网络/非 JSON）折成 Error 抛——向导的
 * React 状态机把异常渲染成可重试的错误行（组件层契约：失败走 throw）。
 */
async function call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/cc-migrate/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new Error(`cc-migrate: cannot reach the host route (${e instanceof Error ? e.message : String(e)})`);
  }
  let envelope: WireEnvelope<T>;
  try {
    envelope = (await response.json()) as WireEnvelope<T>;
  } catch {
    throw new Error(`cc-migrate: host route returned HTTP ${response.status} (not JSON)`);
  }
  if (!envelope.ok) {
    throw new Error(envelope.error?.message ?? `cc-migrate: ${method} failed`);
  }
  return envelope.value;
}

/** 命令层 outcome → 直接值或 throw（组件层吃异常文案）。 */
function unwrap<T extends { ok: boolean }>(outcome: T, pick: (o: Extract<T, { ok: true }>) => unknown): unknown {
  if (!outcome.ok) throw new Error((outcome as { error?: string }).error ?? 'cc-migrate: request failed');
  return pick(outcome as Extract<T, { ok: true }>);
}

/** fetch 版 MigrationBackend（gui.ts createWizardBackend 的 React 改写）。 */
export const wizardApi = {
  listTools(): Promise<WizardToolInfo[]> {
    return Promise.resolve(WIZARD_SOURCE_TOOLS);
  },

  async listSessions(tool: string, root?: string): Promise<unknown[]> {
    const value = await call<ListSourcesOutcome>('list-sources', { tool, root });
    return unwrap(value, (o) => o.sessions);
  },

  async preview(tool: string, sessionId: string, root?: string): Promise<PreviewPayload> {
    const value = await call<PreviewPayloadOutcome>('preview', { tool, sessionId, root });
    if ('ok' in value && value.ok === false) throw new Error(value.error);
    // 宿主半 preview 恒走 previewPayload（结构化 DTO），不会回平文本——防御
    return value as PreviewPayload;
  },

  /**
   * 目标根回显。展示性数据：老宿主（无 defaults method）/网络失败一律降级
   * 为 DSH 常识默认根——确认页照常渲染，只是少了插件配置路径的精确回显。
   * 吞错是刻意的：这个值只影响显示文案，不值得为它挡导入流程。
   */
  async defaults(): Promise<MigrateDefaults> {
    try {
      return await call<MigrateDefaults>('defaults', {});
    } catch {
      return { dstRoot: null, dshDefaultRoot: '~/.dsh/sessions' };
    }
  },

  async migrate(params: {
    srcTool: string;
    sessionId: string;
    srcRoot?: string;
    targetCwd?: string;
    flatten?: boolean;
    keepSynthetic?: boolean;
  }): Promise<{ tool: string; sessionId: string; paths: string[] }> {
    // 本插件只有一条线：任意工具 → DSH。目标恒 dsh，没有目标选择步骤。
    const outcome = await call<ImportOutcome>('import', {
      tool: params.srcTool,
      sessionId: params.sessionId,
      srcRoot: params.srcRoot,
      targetCwd: params.targetCwd,
      flatten: params.flatten,
      keepSynthetic: params.keepSynthetic,
    } satisfies Record<string, unknown> & Partial<ImportOptions>);
    if (!outcome.ok) throw new Error(outcome.error);
    return {
      tool: outcome.target.tool,
      sessionId: outcome.target.sessionId,
      paths: outcome.target.paths,
    };
  },
};
