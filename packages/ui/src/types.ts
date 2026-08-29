/**
 * @session-migrate/ui — 前端与宿主（Electron 主进程 / DSH 插件）之间的契约。
 *
 * 组件是纯展示层：所有数据获取通过宿主注入的 `MigrationBackend` 完成，
 * 这是 core 五能力（listSessions / parse / preview / write / resolveCwd）
 * 在 GUI 侧的投影。DSH 插件与独立 App 各自提供一份 backend 实现，
 * 组件逻辑零改动复用。
 */

import type { SessionMeta, ToolId } from '@session-migrate/core';

/** 工具元数据（供工具选择卡片渲染）。 */
export interface ToolInfo {
  id: ToolId;
  /** 显示名，如 "Claude Code"。 */
  label: string;
  /** 默认存储位置（展示 + 默认值；"~" 由宿主展开）。 */
  defaultRoot: string;
}

/** 结构化预览的消息块（agent 内部视图的最小投影；长文本按块截断）。 */
export interface PreviewBlockDTO {
  t: 'text' | 'think' | 'tool_use' | 'tool_result' | 'file';
  text?: string;
  /** tool_use 的调用 id / tool_result 的配对 id（渲染层据此融合为一行） */
  callId?: string;
  name?: string;
  mediaType?: string;
  isError?: boolean;
  truncated?: boolean;
}

export interface PreviewMessageDTO {
  role: 'user' | 'assistant' | 'tool' | 'system' | 'developer';
  ts?: number;
  model?: string;
  synthetic?: boolean;
  blocks: PreviewBlockDTO[];
}

/** 子代理旁链（Task 派发的独立子会话；messages 与主消息同构）。 */
export interface PreviewSidechainDTO {
  agentId: string;
  agentType?: string;
  /** 派发该子代理的 tool_use 调用 id（渲染层据此把旁链挂到调用点下方） */
  parentCallId?: string;
  /** 超过投影上限时为 true（仅展示前 N 条） */
  truncated?: boolean;
  messages: PreviewMessageDTO[];
}

/** 会话离线预览载荷（主进程读取 IR 后投影出的摘要 + 结构化消息）。 */
export interface PreviewPayload {
  tool: ToolId;
  sessionId: string;
  title?: string;
  createdAt?: number;
  cwd?: string;
  model?: string;
  messageCount: number;
  sidechainCount: number;
  toolCallCount: number;
  hasSidechains: boolean;
  /** 结构化消息（懒加载视图的数据源；按块截断，非全文） */
  messages: PreviewMessageDTO[];
  /** 子代理旁链（预览尾部逐个披露展示） */
  sidechains?: PreviewSidechainDTO[];
}

/** 迁移执行参数（对应 core WriteOptions + 源会话定位）。 */
export interface MigrateParams {
  srcTool: ToolId;
  srcRoot?: string;
  sessionId: string;
  dstTool: ToolId;
  dstRoot?: string;
  targetCwd?: string;
  flatten?: boolean;
  keepSynthetic?: boolean;
}

export interface MigrateOutcome {
  tool: ToolId;
  sessionId: string;
  paths: string[];
}

/**
 * 宿主注入的后端。独立 App 用 Electron IPC 实现；DSH 插件直接调 core。
 * 方法语义与 core 对齐：listSessions/preview 只读，migrate 写入目标存储。
 */
export interface MigrationBackend {
  listTools(): Promise<ToolInfo[]>;
  listSessions(tool: ToolId, root?: string): Promise<SessionMeta[]>;
  preview(tool: ToolId, sessionId: string, root?: string): Promise<PreviewPayload>;
  migrate(params: MigrateParams): Promise<MigrateOutcome>;
  /** 原生目录选择对话框；取消返回 null。 */
  pickDirectory(defaultPath?: string): Promise<string | null>;
  /** 在文件管理器中展示文件 / 打开目录。 */
  openPath(path: string): Promise<void>;
}
