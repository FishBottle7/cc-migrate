/**
 * 会话选择器的树模型（主会话在上、子会话挂父节点下）+ 行内小工具。
 * 渲染在 SessionPicker（工作区分组 + 递归 SpSessionRow）。
 */
import type { SessionMeta } from '@session-migrate/core';

export interface SessionNode {
  meta: SessionMeta;
  children: SessionNode[];
}

/** 主会话在下、子会话挂到父节点下；父不在列表/本组的子会话按根处理。 */
export function buildNodes(items: SessionMeta[]): SessionNode[] {
  const byId = new Map<string, SessionNode>();
  for (const m of items) byId.set(m.sessionId, { meta: m, children: [] });
  const roots: SessionNode[] = [];
  for (const node of byId.values()) {
    const parent = node.meta.parentSessionId ? byId.get(node.meta.parentSessionId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** 展开数（与折叠状态无关，计数稳定）。 */
export function countNodes(nodes: SessionNode[]): number {
  let n = 0;
  for (const node of nodes) n += 1 + countNodes(node.children);
  return n;
}

export function fmtTime(ts?: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
