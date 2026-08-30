<script setup lang="ts">
import { computed, provide, ref } from 'vue';
import type { SessionMeta } from '@session-migrate/core';
import { SP_FOLDED_SUBS, buildNodes, countNodes, type SessionNode } from './sessionTree.js';
import SpSessionRow from './SpSessionRow.vue';

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
  nodes: SessionNode[];
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
    return { key, label: g.label, path: g.path, nodes: buildNodes(g.items) };
  });
  arr.sort((a, b) => (b.nodes[0]?.meta.createdAt ?? 0) - (a.nodes[0]?.meta.createdAt ?? 0));
  return arr;
});

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function replaceToggle(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** 工作区分组折叠（组容器 grid clip 动效）。 */
const collapsed = ref(new Set<string>());
function toggleGroup(key: string) {
  collapsed.value = replaceToggle(collapsed.value, key);
}

/** 子会话折叠（SpSessionRow 经 inject 消费；子会话默认展开）。
 *  走 provide 而不是 prop：集合换新时只有自自身状态变化的节点重渲染。 */
const foldedSubs = ref(new Set<string>());
provide(SP_FOLDED_SUBS, foldedSubs);
function toggleSub(id: string) {
  foldedSubs.value = replaceToggle(foldedSubs.value, id);
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
      <button class="sm-btn" type="button" :disabled="props.loading" @click="emit('refresh')">
        重新扫描
      </button>
    </div>
    <div class="sp-toolbar sp-toolbar--filters">
      <label class="sp-chip" :class="{ on: hideEmpty }" title="隐藏已登记但还没有 rollout 文件的会话（codex deferred creation，无可迁移内容）">
        <input v-model="hideEmpty" type="checkbox" />
        空会话
      </label>
      <label class="sp-chip" :class="{ on: archivedOnly }" title="只看归档目录（DSH 归档 / codex archived_sessions）里的会话">
        <input v-model="archivedOnly" type="checkbox" />
        只看归档
      </label>
      <span class="sp-count sm-mono">{{ filtered.length }}<i>/</i>{{ props.sessions.length }}</span>
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
          <span class="g-count sm-mono">{{ countNodes(g.nodes) }}</span>
        </button>
        <!-- 组容器 clip：grid 0fr↔1fr 高度折叠 + 淡入淡出（同 SpSessionRow 子树） -->
        <div class="sp-group-clip" :class="{ closed: collapsed.has(g.key) }">
          <div class="sp-group-items">
            <SpSessionRow
              v-for="root in g.nodes"
              :key="root.meta.sessionId"
              :node="root"
              :depth="0"
              :selected-id="props.selectedId"
              @select="(m) => emit('select', m)"
              @toggle="toggleSub"
            />
          </div>
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
/* 工具条两行：搜索+重新扫描 / 筛选 chip+计数（288px 默认列宽单行放不下） */
.sp-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
}
.sp-toolbar--filters {
  margin-top: -5px;
}
.sp-search {
  flex: 1;
  min-width: 0;
}
.sp-count {
  margin-left: auto;
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
  transition: transform var(--t-fast) var(--ease-spring);
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
/* 组容器折叠 clip：grid 0fr↔1fr 高度过渡（180ms 收短减负）+ 内容淡入下落；
   关闭后 visibility 出焦点序（延迟到高度动画结束） */
.sp-group-clip {
  display: grid;
  grid-template-rows: 1fr;
  min-height: 0;
  visibility: visible;
  transition:
    grid-template-rows 180ms var(--ease-out),
    visibility 0s 0s;
}
.sp-group-clip.closed {
  grid-template-rows: 0fr;
  visibility: hidden;
  transition:
    grid-template-rows 180ms var(--ease-out),
    visibility 0s 180ms;
}
.sp-group-items {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-left: 12px;
  opacity: 1;
  transform: translateY(0);
  transition:
    opacity 150ms var(--ease-out),
    transform 180ms var(--ease-out);
}
.sp-group-clip.closed .sp-group-items {
  opacity: 0;
  transform: translateY(-6px);
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
</style>
