/**
 * 工具元数据表 + "~" 展开。展示顺序即 UI 卡片顺序。
 */

import { homedir } from 'node:os';
import type { ToolId } from '@cc-migrate/core';
import type { ToolInfo } from './ipc-types.js';

export const TOOL_ENTRIES: ToolInfo[] = [
  { id: 'dsh', label: 'DSH', defaultRoot: '~/.dsh/sessions' },
  { id: 'claude', label: 'Claude Code', defaultRoot: '~/.claude/projects' },
  { id: 'codex', label: 'Codex', defaultRoot: '~/.codex/sessions' },
  { id: 'pi', label: 'Pi', defaultRoot: '~/.pi/agent/sessions' },
  { id: 'opencode', label: 'OpenCode', defaultRoot: '~/.local/share/opencode/opencode.db' },
  { id: 'zcode', label: 'ZCode', defaultRoot: '~/.zcode/cli/db/db.sqlite' },
];

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return `${homedir()}${p.slice(1)}`;
  return p;
}

export function isToolId(v: string): v is ToolId {
  return TOOL_ENTRIES.some((t) => t.id === v);
}
