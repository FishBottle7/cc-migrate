/**
 * App 自有的 IPC 契约（主进程 ↔ 渲染进程）。
 *
 * 形状与 @session-migrate/ui 的组件契约（MigrationBackend）结构兼容，
 * 但独立定义：主进程只依赖 core 的 .d.ts，避免把 ui 的 .ts 源码拉进
 * 主进程的 emit 程序。渲染进程做结构对接。
 */

import type { SessionMeta, ToolId } from '@session-migrate/core';

export interface ToolInfo {
  id: ToolId;
  label: string;
  defaultRoot: string;
}

/**
 * 结构化预览的消息块（agent 内部视图的最小投影）。
 * 长文本按块截断（truncated 标记）——迁移本身仍无损。
 */
export interface PreviewBlockDTO {
  t: 'text' | 'think' | 'tool_use' | 'tool_result' | 'file';
  /** text/think 的正文、tool_use 的 input JSON、tool_result 的输出 */
  text?: string;
  /** tool_use 的调用 id / tool_result 的配对 id（渲染层据此融合为一行） */
  callId?: string;
  /** tool_use 工具名 / file 文件名 */
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

/** 子代理旁链（Task 派发的独立子会话）。 */
export interface PreviewSidechainDTO {
  agentId: string;
  agentType?: string;
  truncated?: boolean;
  messages: PreviewMessageDTO[];
}

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

export type { SessionMeta, ToolId };
