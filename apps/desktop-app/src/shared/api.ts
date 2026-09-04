/**
 * 渲染进程可用的 API 面（preload 经 contextBridge 注入 window.api）。
 * 形状 = ui 组件的 MigrationBackend + 版本信息。
 */

import type { SessionMeta, ToolId } from '@cc-migrate/core';
import type { MigrateOutcome, MigrateParams, PreviewPayload, ToolInfo } from '../main/ipc-types.js';

export type { SessionMeta, ToolId, MigrateOutcome, MigrateParams, PreviewPayload, ToolInfo };

export interface DesktopApi {
  listTools(): Promise<ToolInfo[]>;
  listSessions(tool: ToolId, root?: string): Promise<SessionMeta[]>;
  preview(tool: ToolId, sessionId: string, root?: string): Promise<PreviewPayload>;
  migrate(params: MigrateParams): Promise<MigrateOutcome>;
  pickDirectory(defaultPath?: string): Promise<string | null>;
  openPath(path: string): Promise<void>;
  versions(): Promise<{ app: string; electron: string; node: string }>;
}
