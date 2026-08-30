<script setup lang="ts">
/**
 * SpSessionRow — 会话树节点（递归：script setup SFC 按文件名自引用）。
 *
 * 自身行 + 可折叠的子会话容器。折叠/展开动效走 grid-template-rows
 * 0fr↔1fr + 透明度 —— 本 App 关闭硬件加速（软件渲染），FLIP transform
 * 重排大列表会卡（见 SessionPreview 头注），高度/透明度是最廉价的合法动效。
 * 折叠集合经 inject 下发、每节点只包一层 computed：点一次折叠只重渲染
 * 状态真正变化的那一个节点，而不是整棵树。
 */
import { computed, inject, ref } from 'vue';
import type { SessionNode } from './sessionTree.js';
import { SP_FOLDED_SUBS, fmtTime, truncate } from './sessionTree.js';

const props = defineProps<{
  node: SessionNode;
  depth: number;
  selectedId?: string | null;
}>();

const emit = defineEmits<{
  select: [meta: SessionNode['meta']];
  toggle: [id: string];
}>();

const foldedSubs = inject(SP_FOLDED_SUBS, ref(new Set<string>()));
const selfFolded = computed(() => foldedSubs.value.has(props.node.meta.sessionId));
</script>

<template>
  <div class="sp-node">
    <button
      type="button"
      class="sp-item"
      :class="{ 'is-active': props.selectedId === props.node.meta.sessionId, 'is-sub': props.depth > 0 }"
      @click="emit('select', props.node.meta)"
    >
      <span class="sp-title">
        <button
          v-if="props.node.children.length"
          type="button"
          class="sp-sub-toggle"
          :title="selfFolded ? '展开子会话' : '收起子会话'"
          @click.stop="emit('toggle', props.node.meta.sessionId)"
        >
          <svg class="chev" :class="{ closed: selfFolded }" viewBox="0 0 8 8" aria-hidden="true">
            <path d="M2 1l4 3-4 3" />
          </svg>
        </button>
        {{ props.node.meta.title ? truncate(props.node.meta.title, 60) : '(无标题)' }}
        <span v-if="props.node.meta.deferredCreation" class="sp-tag" title="已登记但无 rollout 文件（deferred creation）">空</span>
        <span v-else-if="props.node.meta.archived" class="sp-tag" title="位于归档目录">归档</span>
        <span v-else-if="props.depth > 0" class="sp-tag sp-tag--sub" title="子代理会话（thread_spawn）">子</span>
      </span>
      <span class="sp-meta">
        <span class="sp-time sm-mono">{{ fmtTime(props.node.meta.createdAt) }}</span>
        <span v-if="props.node.meta.cwd && props.depth === 0" class="sp-cwd sm-mono">{{ truncate(props.node.meta.cwd, 42) }}</span>
      </span>
      <span class="sp-bar" aria-hidden="true" />
    </button>

    <!-- 子会话容器：grid 0fr↔1fr 高度折叠 + 内容淡入下落 -->
    <div v-if="props.node.children.length" class="sp-clip" :class="{ closed: selfFolded }">
      <div class="sp-clip-inner">
        <SpSessionRow
          v-for="child in props.node.children"
          :key="child.meta.sessionId"
          :node="child"
          :depth="props.depth + 1"
          :selected-id="props.selectedId"
          @select="(m) => emit('select', m)"
          @toggle="(id) => emit('toggle', id)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.sp-node {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
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
.sp-tag--sub {
  color: var(--acc-ink);
  border-color: rgba(118, 99, 224, 0.4);
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
  transition: color var(--t-fast) ease;
}
.sp-sub-toggle:hover {
  color: var(--fg-0);
}
.chev {
  flex: none;
  width: 8px;
  height: 8px;
  transform: rotate(90deg);
  transition: transform var(--t-fast) var(--ease-spring);
}
.chev.closed {
  transform: rotate(0deg);
}
.chev path {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
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
/* 子会话卡片：整体随容器缩进（背景/色条/边框一起动），层级感靠容器 margin */
.sp-item.is-sub {
  border-left: 2px solid rgba(118, 99, 224, 0.35);
}
.sp-item.is-sub .sp-title {
  font-weight: 500;
  color: var(--fg-1);
}

/* 折叠 clip：grid 0fr↔1fr 高度过渡（180ms 收短减负）+ 内容淡入下落；
   关闭后 visibility 出焦点序（延迟到高度动画结束） */
.sp-clip {
  display: grid;
  grid-template-rows: 1fr;
  min-height: 0;
  visibility: visible;
  transition:
    grid-template-rows 180ms var(--ease-out),
    visibility 0s 0s;
}
.sp-clip.closed {
  grid-template-rows: 0fr;
  visibility: hidden;
  transition:
    grid-template-rows 180ms var(--ease-out),
    visibility 0s 180ms;
}
.sp-clip-inner {
  min-height: 0;
  overflow: hidden;
  margin-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  opacity: 1;
  transform: translateY(0);
  transition:
    opacity 150ms var(--ease-out),
    transform 180ms var(--ease-out);
}
.sp-clip.closed .sp-clip-inner {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
