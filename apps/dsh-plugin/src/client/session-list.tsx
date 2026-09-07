/**
 * cc-migrate client 半 — 会话列表（工作区分组，侧栏高密度版）。
 *
 * 语义移植自 @cc-migrate/ui 的 Vue 实现（MIT，本仓库自有代码，允许语义
 * 移植）：
 *  - SessionPicker.vue `groups` computed —— 按 cwd 字符串分组、组内
 *    createdAt 降序、组间按组内最新会话排序；desktop 用 projectKey(cwd)
 *    做 key，client 侧不需要那么重，直接 cwd 字符串分组（同 key 同组）。
 * 与桌面版的差异（侧栏适配，为什么）：
 *  - 行高密度：单行 = 标题（截断）+ 标签 + 相对时间；cwd 副行删掉
 *    ——组头已表达 cwd（短名 + title 提示全路径），窄栏不再重复。
 *  - 组折叠是受控 props（collapsed/onToggleGroup）：折叠状态归 wizard 管
 *    （localStorage 记忆），本组件保持纯渲染，无头冒烟可直接断言折叠。
 *  - 桌面版的 0fr↔1fr grid clip 折叠动效不移植：内联样式没有 css-modules
 *    的 keyframes/transition 类，侧栏场景直接条件渲染（展开才进 DOM——
 *    大列表还省一层节点）。
 *  - 子会话树不移植（v0.3.5 移除，用户拍板「codex 会话列表只显示主
 *    会话」）：codex 适配器已在 listSessions 源头过滤子代理线程，其余
 *    工具的列表本来就不带 parentSessionId——平铺渲染，buildNodes/
 *    depth 缩进/「子」标签一并删除，孤儿挂根的特例也随之消失。
 */

import { createElement, type CSSProperties, type ReactNode } from 'react';
import type { SessionMeta } from '../commands.js';
import { T } from './theme.js';

/* ── 工作区分组（SessionPicker.vue groups computed 的同语义移植） ─────── */

export interface SessionGroup {
  /** cwd 原串（分组键；'' = 无工作目录组）。 */
  key: string;
  /** 组头短名：路径最后一段（title 提示全路径）。 */
  label: string;
  path?: string;
  /** 组内会话（createdAt 降序、平铺——树已在 v0.3.5 移除）。 */
  items: SessionMeta[];
  /** 组内会话总数（徽章显示的是可迁移数）。 */
  count: number;
}

/** 路径短名：最后一段目录名（正反斜杠都切——Windows/POSIX 混合源）。 */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
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
    groups.push({
      key,
      label: key ? baseName(key) : '（无工作目录）',
      path: key || undefined,
      items: list,
      count: list.length,
    });
  }
  // 组间按组内最新会话降序（root 顺序继承组内降序，第一项即最新）
  groups.sort((a, b) => (b.items[0]?.createdAt ?? 0) - (a.items[0]?.createdAt ?? 0));
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

/* ── 样式（窄栏高密度：行高 ~26px，对齐 better-sidebar 文件树密度） ─────── */

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
  row: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px 3px 8px', cursor: 'pointer', borderRadius: 6 } as CSSProperties,
  title: {
    flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontSize: 12,
  } as CSSProperties,
  tag: {
    flexShrink: 0, fontSize: 9.5, color: T.dim, border: `1px solid ${T.line2}`,
    borderRadius: 4, padding: '0 3px', lineHeight: '13px',
  } as CSSProperties,
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
 * 分组列表视图。组头点击折叠。selectedId 没做高亮：列表选中即跳预览
 * （不再回列表），高亮态没有消费方。
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
            {isCollapsed ? null : g.items.map((m) => renderRow(m, onOpen))}
          </div>
        );
      })}
    </div>
  );
}

function renderRow(m: SessionMeta, onOpen: (m: SessionMeta) => void): ReactNode {
  return (
    <div
      key={m.sessionId}
      style={L.row}
      title={m.title ?? m.sessionId}
      onClick={() => onOpen(m)}
    >
      <span style={L.title}>{m.title ? truncate(m.title, 40) : <span style={{ color: T.dim }}>（无标题）</span>}</span>
      {m.deferredCreation === true ? <span style={L.tag} title="已登记但无会话文件（无可迁移内容）">空</span> : null}
      {m.archived === true ? <span style={L.tag} title="位于归档目录">归档</span> : null}
      <span style={L.time} title={m.createdAt === undefined ? '' : new Date(m.createdAt).toISOString().slice(0, 16).replace('T', ' ')}>
        {relTime(m.createdAt)}
      </span>
    </div>
  );
}
