<script setup lang="ts">
import { computed, ref } from 'vue';
import type { SessionMeta } from '@session-migrate/core';

const props = defineProps<{
  sessions: SessionMeta[];
  loading?: boolean;
  error?: string | null;
  selectedId?: string | null;
}>();

const emit = defineEmits<{
  select: [meta: SessionMeta];
  refresh: [];
}>();

const query = ref('');
const hideEmpty = ref(true);
const archivedOnly = ref(false);

function fmtTime(ts?: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  let sorted = [...props.sessions].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  if (hideEmpty.value) sorted = sorted.filter((m) => !m.deferredCreation);
  if (archivedOnly.value) sorted = sorted.filter((m) => m.archived);
  if (!q) return sorted;
  return sorted.filter((m) =>
    String(m.sessionId).toLowerCase().includes(q) ||
    String(m.title ?? '').toLowerCase().includes(q) ||
    String(m.cwd ?? '').toLowerCase().includes(q),
  );
});

/* ── 工作区分组（DSH：workspace 文件夹）+ 子会话树 ─────────── */

interface SessionGroup {
  key: string;
  label: string;
  path?: string;
  rows: FlatRow[];
}

interface SessionNode {
  meta: SessionMeta;
  children: SessionNode[];
}

interface FlatRow {
  meta: SessionMeta;
  depth: number;
  hasChildren: boolean;
}

/** 主会话在下、子会话挂到父节点下；父不在列表/本组的子会话按根处理。 */
function buildNodes(items: SessionMeta[]): SessionNode[] {
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

function flattenNodes(nodes: SessionNode[], collapsed: Set<string>, depth = 0, out: FlatRow[] = []): FlatRow[] {
  for (const n of nodes) {
    out.push({ meta: n.meta, depth, hasChildren: n.children.length > 0 });
    if (!collapsed.has(n.meta.sessionId)) flattenNodes(n.children, collapsed, depth + 1, out);
  }
  return out;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/** 按 cwd 分组；组内主会话优先，子会话嵌套在父会话下可展开。 */
const groups = computed<SessionGroup[]>(() => {
  const map = new Map<string, { label: string; path?: string; items: SessionMeta[] }>();
  for (const m of filtered.value) {
    const key = m.cwd ?? '';
    let g = map.get(key);
    if (!g) {
      g = { label: key ? baseName(key) : '（无工作目录）', path: key || undefined, items: [] };
      map.set(key, g);
    }
    g.items.push(m);
  }
  const arr = [...map.entries()].map(([key, g]) => {
    g.items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    return { key, label: g.label, path: g.path, rows: flattenNodes(buildNodes(g.items), collapsed.value) };
  });
  arr.sort((a, b) => (b.rows[0]?.meta.createdAt ?? 0) - (a.rows[0]?.meta.createdAt ?? 0));
  return arr;
});

const collapsed = ref(new Set<string>());

function toggleGroup(key: string) {
  const next = new Set(collapsed.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsed.value = next;
}

/** 子会话默认展开；按 sessionId 折叠。 */
const foldedSubs = ref(new Set<string>());

function toggleSub(id: string) {
  const next = new Set(foldedSubs.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  foldedSubs.value = next;
}
</script>

<template>
  <section class="session-picker">
    <div class="sp-toolbar">
      <input
        v-model="query"
        class="sm-input sp-search"
        type="text"
        placeholder="过滤：标题 / 会话 id / 工作目录…"
        spellcheck="false"
      />
      <label class="sp-chip" :class="{ on: hideEmpty }" title="隐藏已登记但还没有 rollout 文件的会话（codex deferred creation，无可迁移内容）">
        <input v-model="hideEmpty" type="checkbox" />
        空会话
      </label>
      <label class="sp-chip" :class="{ on: archivedOnly }" title="只看归档目录（DSH 归档 / codex archived_sessions）里的会话">
        <input v-model="archivedOnly" type="checkbox" />
        只看归档
      </label>
      <span class="sp-count sm-mono">{{ filtered.length }}<i>/</i>{{ props.sessions.length }}</span>
      <button class="sm-btn sm-btn--ghost" type="button" :disabled="props.loading" @click="emit('refresh')">
        重新扫描
      </button>
    </div>

    <!-- 骨架屏 -->
    <div v-if="props.loading" class="sp-list sp-list--sk" aria-hidden="true">
      <div class="sm-flow sp-flow" />
      <div v-for="i in 7" :key="i" class="sp-sk-item">
        <div class="sm-sk sp-sk-title" :style="{ width: 88 - i * 4 + '%' }" />
        <div class="sm-sk sp-sk-meta" :style="{ width: 46 + ((i * 13) % 30) + '%' }" />
      </div>
    </div>

    <div v-else-if="props.error" class="sp-state sp-state--err">
      <p>{{ props.error }}</p>
      <button class="sm-btn" type="button" @click="emit('refresh')">重试</button>
    </div>
    <div v-else-if="filtered.length === 0" class="sp-state">
      <p>{{ props.sessions.length === 0 ? '未找到任何会话 — 可尝试修改上方目录后重新扫描。' : '无匹配结果。' }}</p>
    </div>

    <ul v-else class="sp-list sm-stagger">
      <li v-for="(g, gi) in groups" :key="g.key" class="sp-group" :style="{ '--i': gi }">
        <button type="button" class="sp-group-head" :title="g.path" @click="toggleGroup(g.key)">
          <svg class="g-chev" :class="{ closed: collapsed.has(g.key) }" viewBox="0 0 8 8" aria-hidden="true">
            <path d="M2 1l4 3-4 3" />
          </svg>
          <span class="g-icon" aria-hidden="true">
            <svg viewBox="0 0 14 14"><path d="M1.5 3a1 1 0 011-1h3l1.4 1.6h4.6a1 1 0 011 1V11a1 1 0 01-1 1h-9a1 1 0 01-1-1z" /></svg>
          </span>
          <span class="g-name">{{ g.label }}</span>
          <span class="g-count sm-mono">{{ g.rows.length }}</span>
        </button>
        <div v-if="!collapsed.has(g.key)" class="sp-group-items">
          <button
            v-for="row in g.rows"
            :key="row.meta.sessionId"
            type="button"
            class="sp-item"
            :class="{ 'is-active': props.selectedId === row.meta.sessionId, 'is-sub': row.depth > 0 }"
            :style="row.depth ? { paddingLeft: 14 + row.depth * 18 + 'px' } : undefined"
            @click="emit('select', row.meta)"
          >
            <span class="sp-title">
              <button
                v-if="row.hasChildren"
                type="button"
                class="sp-sub-toggle"
                :title="foldedSubs.has(row.meta.sessionId) ? '展开子会话' : '收起子会话'"
                @click.stop="toggleSub(row.meta.sessionId)"
              >
                <svg class="g-chev" :class="{ closed: foldedSubs.has(row.meta.sessionId) }" viewBox="0 0 8 8" aria-hidden="true">
                  <path d="M2 1l4 3-4 3" />
                </svg>
              </button>
              {{ row.meta.title ? truncate(row.meta.title, 60) : '(无标题)' }}
              <span v-if="row.meta.deferredCreation" class="sp-tag" title="已登记但无 rollout 文件（deferred creation）">空</span>
              <span v-else-if="row.meta.archived" class="sp-tag" title="位于归档目录">归档</span>
              <span v-else-if="row.depth > 0" class="sp-tag" title="子代理会话（thread_spawn）">子</span>
            </span>
            <span class="sp-meta">
              <span class="sp-time sm-mono">{{ fmtTime(row.meta.createdAt) }}</span>
              <span v-if="row.meta.cwd" class="sp-cwd sm-mono">{{ truncate(row.meta.cwd, 42) }}</span>
            </span>
            <span class="sp-bar" aria-hidden="true" />
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.session-picker {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}
.sp-toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
}
.sp-search {
  flex: 1;
  min-width: 0;
}
.sp-count {
  font-size: 11px;
  color: var(--fg-2);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.sp-count i {
  font-style: normal;
  margin: 0 2px;
  color: var(--fg-2);
  opacity: 0.5;
}
.sp-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 32px 16px;
  color: var(--fg-1);
  font-size: 13px;
  border: 1px dashed var(--line-1);
  border-radius: 10px;
  text-align: center;
}
.sp-state p {
  margin: 0;
  line-height: 1.7;
}
.sp-state--err {
  color: var(--err);
  border-color: rgba(201, 54, 78, 0.4);
}
.sp-list {
  list-style: none;
  margin: 0;
  padding: 2px;
  overflow-y: auto;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.sp-flow {
  margin: 2px 0 4px;
}
.sp-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sp-group-head {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 26px;
  padding: 2px 6px;
  margin: 0 -6px;
  border: none;
  background: none;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
  text-align: left;
  color: var(--fg-1);
  user-select: none;
  transition: background var(--t-fast) ease;
}
.sp-group-head:hover {
  background: var(--ink-2);
}
.g-chev {
  flex: none;
  width: 8px;
  height: 8px;
  color: var(--fg-2);
  transform: rotate(90deg);
  transition: transform var(--t-fast) var(--ease-out);
}
.g-chev.closed {
  transform: rotate(0deg);
}
.g-chev path {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.g-icon {
  flex: none;
  display: inline-flex;
  width: 14px;
  height: 14px;
  color: var(--fg-2);
}
.g-icon svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.g-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--fg-0);
  letter-spacing: 0.01em;
}
.g-count {
  flex: none;
  margin-left: auto;
  font-size: 10.5px;
  color: var(--fg-2);
  background: var(--ink-2);
  border-radius: 999px;
  padding: 1px 8px;
  font-variant-numeric: tabular-nums;
}
.sp-group-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-left: 12px;
}
.sp-list--sk {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sp-sk-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 8px;
}
.sp-sk-title {
  height: 12px;
}
.sp-sk-meta {
  height: 9px;
}
.sp-item {
  position: relative;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 5px;
  text-align: left;
  padding: 9px 12px;
  background: transparent;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font: inherit;
  color: var(--fg-0);
  transition:
    background var(--t-fast) ease,
    transform var(--t-fast) var(--ease-out);
}
.sp-item:hover {
  background: var(--ink-2);
}
.sp-item:active {
  transform: scale(0.995);
}
.sp-item.is-active {
  background: var(--ink-3);
}
.sp-bar {
  position: absolute;
  left: -1px;
  top: 10px;
  bottom: 10px;
  width: 2px;
  border-radius: 2px;
  background: var(--acc-0);
  opacity: 0;
  transform: scaleY(0.4);
  transition:
    opacity var(--t-med) var(--ease-out),
    transform var(--t-med) var(--ease-spring);
}
.sp-item.is-active .sp-bar {
  opacity: 1;
  transform: scaleY(1);
}
.sp-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.45;
  letter-spacing: 0.01em;
}
.sp-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 0 5px;
  border: 1px solid var(--line-1);
  border-radius: 5px;
  font-size: 10px;
  font-weight: 500;
  color: var(--fg-2);
  vertical-align: 1px;
}
.sp-sub-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-right: 4px;
  padding: 0;
  border: none;
  background: none;
  color: var(--fg-2);
  cursor: pointer;
  vertical-align: -3px;
}
.sp-sub-toggle .g-chev {
  width: 8px;
  height: 8px;
}
.sp-item.is-sub {
  border-left: 2px solid var(--line-1);
}
.sp-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border: 1px solid var(--line-1);
  border-radius: 999px;
  font-size: 11px;
  color: var(--fg-2);
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  transition: color 0.15s, border-color 0.15s;
}
.sp-chip input {
  accent-color: currentcolor;
  margin: 0;
}
.sp-chip.on {
  color: var(--fg-1);
  border-color: var(--fg-2);
}
.sp-meta {
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: var(--fg-2);
}
.sp-time {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.sp-cwd {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  min-width: 0;
}
</style>
