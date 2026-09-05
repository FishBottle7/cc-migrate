/**
 * cc-migrate client 半 — 会话列表（工作区分组 + 子会话树，侧栏高密度版）。
 *
 * 语义移植自 @cc-migrate/ui 的 Vue 实现（MIT，本仓库自有代码，允许语义
 * 移植）：
 *  - sessionTree.ts `buildNodes` —— 主会话在上、子会话挂父节点下、父不在
 *    列表/本组的子会话按根处理（React 重写，算法逐行同语义）。
 *  - SessionPicker.vue `groups` computed —— 按 cwd 字符串分组、组内
 *    createdAt 降序、组间按组内最新会话排序；desktop 用 projectKey(cwd)
 *    做 key，client 侧不需要那么重，直接 cwd 字符串分组（同 key 同组）。
 * 与桌面版的差异（侧栏适配，为什么）：
 *  - 行高密度：单行 = 缩进 + 标题（截断）+ 标签 + 相对时间；cwd 副行删掉
 *    ——组头已表达 cwd（短名 + title 提示全路径），窄栏不再重复。
 *  - 组折叠是受控 props（collapsed/onToggleGroup）：折叠状态归 wizard 管
 *    （localStorage 记忆），本组件保持纯渲染，无头冒烟可直接断言折叠。
 *  - 桌面版的 0fr↔1fr grid clip 折叠动效不移植：内联样式没有 css-modules
 *    的 keyframes/transition 类，侧栏场景直接条件渲染（展开才进 DOM——
 *    大列表还省一层节点）。
 *  - 子会话不做逐节点折叠（desktop SpSessionRow 有）：实测数据嵌套一层且
 *    很少，侧栏保持「缩进树」一屏可见——组级折叠够用。
 */

import { createElement, type CSSProperties, type ReactNode } from 'react';
import type { SessionMeta } from '../commands.js';
import { T } from './theme.js';

/* ── 树模型（sessionTree.ts buildNodes 的 React 同语义移植） ─────────── */

export interface SessionNode {
  meta: SessionMeta;
  children: SessionNode[];
}

/** 主会话在下、子会话挂到父节点下；父不在列表/本组的子会话按根处理。 */
export function buildSessionNodes(items: SessionMeta[]): SessionNode[] {
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

/** 展开数（与折叠状态无关，组头徽章计数稳定——桌面版 countNodes 同语义）。 */
function countNodes(nodes: SessionNode[]): number {
  let n = 0;
  for (const node of nodes) n += 1 + countNodes(node.children);
  return n;
}

/* ── 工作区分组（SessionPicker.vue groups computed 的同语义移植） ─────── */

export interface SessionGroup {
  /** cwd 原串（分组键；'' = 无工作目录组）。 */
  key: string;
  /** 组头短名：路径最后一段（title 提示全路径）。 */
  label: string;
  path?: string;
  nodes: SessionNode[];
  /** 组内会话总数（含子会话——徽章显示的是可迁移数）。 */
  count: number;
}

/** 路径短名：最后一段目录名（正反斜杠都切——Windows/POSIX 混合源）。 */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function latestTs(nodes: SessionNode[]): number {
  let max = 0;
  for (const node of nodes) {
    if ((node.meta.createdAt ?? 0) > max) max = node.meta.createdAt ?? 0;
    const sub = latestTs(node.children);
    if (sub > max) max = sub;
  }
  return max;
}

export function groupSessions(items: SessionMeta[]): SessionGroup[] {
  const map = new Map<string, SessionMeta[]>();
  for (const m of items) {
    const key = m.cwd ?? '';
    const bucket = map.get(key);
    if (bucket) bucket.push(m);
    else map.set(key, [m]);
  }
  const groups: SessionGroup[] = [];
  for (const [key, list] of map) {
    list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const nodes = buildSessionNodes(list);
    groups.push({
      key,
      label: key ? baseName(key) : '（无工作目录）',
      path: key || undefined,
      nodes,
      count: countNodes(nodes),
    });
  }
  // 组间按组内最新会话降序（桌面版按 nodes[0].createdAt——root 顺序继承组内
  // 降序，但 root 未必是组内最新的那条（子会话可能更新）；直接取全组最大值）
  groups.sort((a, b) => latestTs(b.nodes) - latestTs(a.nodes));
  return groups;
}

/* ── 折叠状态持久化（localStorage，key 前缀 cc-migrate:） ─────────────── */

const COLLAPSE_KEY = 'cc-migrate:collapsed-cwds';

/**
 * 读折叠集合。Node 无头冒烟 / SSR 没有 localStorage——防御性降级为
 * 「全展开」（typeof 探测必须在调用时做，模块顶取值会把 SSR 的空环境
 * 固化进闭包）。坏 JSON 同样降级，不让存储污染炸掉列表。
 */
export function loadCollapsedCwds(): Set<string> {
  const store = typeof localStorage === 'undefined' ? undefined : localStorage;
  try {
    const raw = store?.getItem(COLLAPSE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((x): x is string => typeof x === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
}

/** 写折叠集合（cwd 数组）。写失败（隐私模式配额）静默——记忆是锦上添花。 */
export function saveCollapsedCwds(keys: Iterable<string>): void {
  const store = typeof localStorage === 'undefined' ? undefined : localStorage;
  try {
    store?.setItem(COLLAPSE_KEY, JSON.stringify([...keys]));
  } catch {
    /* 记忆失败不影响功能 */
  }
}

/* ── 显示小件 ────────────────────────────────────────────────────────── */

/** 相对时间（侧栏行内空间紧，绝对时间戳放 title 提示）。 */
export function relTime(ts?: number): string {
  if (ts === undefined || ts === 0) return '—';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(ts).toISOString().slice(0, 10);
}

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/* ── 样式（窄栏高密度：行高 ~26px，对齐 better-sidebar 文件树密度） ────── */

const L = {
  group: { marginBottom: 2 } as CSSProperties,
  groupHead: {
    display: 'flex', alignItems: 'center', gap: 6, width: '100%',
    padding: '3px 4px', border: 'none', background: 'none', cursor: 'pointer',
    font: 'inherit', textAlign: 'left' as const, color: T.fg3, borderRadius: 6,
  } as CSSProperties,
  chev: (closed: boolean): CSSProperties => ({
    flexShrink: 0, transform: closed ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform .12s',
  }),
  chevPath: { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const },
  groupName: {
    flexShrink: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontSize: 11.5, fontWeight: 600, color: T.fg2,
  } as CSSProperties,
  count: {
    marginLeft: 'auto', flexShrink: 0, fontSize: 10, color: T.dim,
    background: T.bg3, borderRadius: 999, padding: '0 7px', lineHeight: '16px',
  } as CSSProperties,
  row: (selected: boolean, depth: number): CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '3px 6px 3px 6px', paddingLeft: 8 + depth * 14,
    cursor: 'pointer', borderRadius: 6,
    background: selected ? T.accentBg : 'transparent',
  }),
  rowSub: { borderLeft: `2px solid ${T.businessBg}` } as CSSProperties,
  title: {
    flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontSize: 12,
  } as CSSProperties,
  tag: {
    flexShrink: 0, fontSize: 9.5, color: T.dim, border: `1px solid ${T.line2}`,
    borderRadius: 4, padding: '0 3px', lineHeight: '13px',
  } as CSSProperties,
  tagSub: { color: T.business, borderColor: T.businessBorder } as CSSProperties,
  time: { flexShrink: 0, fontSize: 10, color: T.dimmer, fontVariantNumeric: 'tabular-nums' } as CSSProperties,
  empty: { padding: '14px 8px', textAlign: 'center' as const, color: T.dim, fontSize: 12 } as CSSProperties,
};

/* ── 视图 ────────────────────────────────────────────────────────────── */

export interface SessionListViewProps {
  groups: SessionGroup[];
  /** 折叠的 cwd 集合（受控——状态与持久化在 wizard）。 */
  collapsed: ReadonlySet<string>;
  onToggleGroup: (key: string) => void;
  onOpen: (m: SessionMeta) => void;
  /** 全空时的占位文案。 */
  emptyHint: string;
}

/**
 * 分组列表视图。组头点击折叠；子会话随父缩进 14px/层。selectedId 没做
 * 高亮：列表选中即跳预览（不再回列表），高亮态没有消费方。
 */
export function SessionListView(props: SessionListViewProps): ReactNode {
  const { groups, collapsed, onToggleGroup, onOpen, emptyHint } = props;
  if (groups.length === 0) return <div style={L.empty}>{emptyHint}</div>;
  return (
    <div>
      {groups.map((g) => {
        const isCollapsed = collapsed.has(g.key);
        return (
          <div key={g.key || '__nocwd__'} style={L.group}>
            <button
              type="button"
              style={L.groupHead}
              title={g.path ?? '该工具的会话没有工作目录信息'}
              onClick={() => onToggleGroup(g.key)}
            >
              <svg width={8} height={8} viewBox="0 0 8 8" aria-hidden style={L.chev(isCollapsed)}>
                <path d="M2 1l4 3-4 3" style={L.chevPath} />
              </svg>
              <span style={L.groupName}>{g.label}</span>
              <span style={L.count}>{g.count}</span>
            </button>
            {isCollapsed ? null : g.nodes.map((n) => renderNode(n, 0, onOpen))}
          </div>
        );
      })}
    </div>
  );
}

function renderNode(node: SessionNode, depth: number, onOpen: (m: SessionMeta) => void): ReactNode {
  const m = node.meta;
  const isSub = depth > 0;
  return (
    <div key={m.sessionId}>
      <div
        style={{ ...L.row(false, depth), ...(isSub ? L.rowSub : {}) }}
        title={m.title ?? m.sessionId}
        onClick={() => onOpen(m)}
      >
        <span style={L.title}>{m.title ? truncate(m.title, 40) : <span style={{ color: T.dim }}>（无标题）</span>}</span>
        {m.deferredCreation === true ? <span style={L.tag} title="已登记但无会话文件（无可迁移内容）">空</span> : null}
        {m.archived === true ? <span style={L.tag} title="位于归档目录">归档</span> : null}
        {isSub ? <span style={{ ...L.tag, ...L.tagSub }} title="子代理会话">子</span> : null}
        <span style={L.time} title={m.createdAt === undefined ? '' : new Date(m.createdAt).toISOString().slice(0, 16).replace('T', ' ')}>
          {relTime(m.createdAt)}
        </span>
      </div>
      {node.children.map((c) => renderNode(c, depth + 1, onOpen))}
    </div>
  );
}
