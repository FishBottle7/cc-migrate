/**
 * 主进程侧 backend：一切 core 工作转发给系统 Node worker
 * （Electron 内置 Node 的 zstd 有原生崩溃 bug，见 worker-host.ts）。
 * 主进程只保留窗口/对话框/shell 这类必须由 Electron 完成的事。
 */

import type { SessionMeta, ToolId } from '@cc-migrate/core';
import type {
  MigrateOutcome,
  MigrateParams,
  PreviewPayload,
  ToolInfo,
} from './ipc-types.js';
import { WorkerHost } from './worker-host.js';

const worker = new WorkerHost();

export function shutdownWorker(): void {
  worker.shutdown();
}

export function listTools(): Promise<ToolInfo[]> {
  return worker.request<ToolInfo[]>('list-tools');
}

export function listToolSessions(tool: string, root?: string): Promise<SessionMeta[]> {
  return worker.request<SessionMeta[]>('list-sessions', { tool, root });
}

export function buildPreview(tool: string, sessionId: string, root?: string): Promise<PreviewPayload> {
  return worker.request<PreviewPayload>('preview', { tool, sessionId, root });
}

export function runMigrate(params: MigrateParams): Promise<MigrateOutcome> {
  return worker.request<MigrateOutcome>('migrate', params);
}

export type { ToolId };
