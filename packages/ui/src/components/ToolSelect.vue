<script setup lang="ts">
import type { ToolInfo } from '../types.js';

const props = defineProps<{
  tools: ToolInfo[];
  heading: string;
  subheading?: string;
  selected?: string | null;
  /** 工具列表尚未就绪：显示骨架卡片 */
  loading?: boolean;
}>();

const emit = defineEmits<{
  select: [tool: ToolInfo];
}>();
</script>

<template>
  <section class="tool-select">
    <div class="ts-head">
      <h2>{{ props.heading }}</h2>
      <p v-if="props.subheading">{{ props.subheading }}</p>
    </div>
    <!-- 骨架（worker 冷启动期间） -->
    <div v-if="props.loading" class="ts-grid" aria-hidden="true">
      <div v-for="i in 6" :key="i" class="ts-card ts-card--sk">
        <div class="sm-sk ts-sk-name" :style="{ width: 52 + ((i * 17) % 30) + '%' }" />
        <div class="sm-sk ts-sk-root" :style="{ width: 70 + ((i * 11) % 25) + '%' }" />
      </div>
    </div>
    <div v-else class="ts-grid sm-stagger">
      <button
        v-for="(t, i) in props.tools"
        :key="t.id"
        type="button"
        class="ts-card sm-card"
        :class="{ 'is-active': props.selected === t.id }"
        :style="{ '--i': i }"
        @click="emit('select', t)"
      >
        <span class="ts-num sm-tag">{{ String(i + 1).padStart(2, '0') }}</span>
        <span class="ts-name">{{ t.label }}</span>
        <span class="ts-root sm-mono">{{ t.defaultRoot }}</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.ts-head h2 {
  margin: 0 0 6px;
  font: 600 20px/1.4 var(--sans);
  letter-spacing: 0.02em;
  color: var(--fg-0);
}
.ts-head p {
  margin: 0 0 22px;
  font-size: 13px;
  color: var(--fg-2);
  letter-spacing: 0.01em;
}
.ts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 10px;
}
.ts-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 16px 14px;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: var(--fg-0);
  transition:
    transform var(--t-fast) var(--ease-out),
    border-color var(--t-fast) ease,
    background var(--t-fast) ease,
    box-shadow var(--t-fast) ease;
}
.ts-card:hover {
  transform: translateY(-2px);
  border-color: var(--line-1);
  background: var(--ink-1);
  box-shadow: 0 8px 20px rgba(38, 32, 66, 0.09);
}
.ts-card:active {
  transform: translateY(0) scale(0.99);
}
.ts-card.is-active {
  border-color: var(--acc-0);
  box-shadow: 0 0 0 3px var(--acc-soft);
}
.ts-card.is-active .ts-num {
  color: var(--acc-0);
}
.ts-num {
  position: absolute;
  top: 14px;
  right: 14px;
  transition: color var(--t-fast) ease;
}
.ts-name {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.ts-root {
  font-size: 11px;
  color: var(--fg-2);
  word-break: break-all;
  line-height: 1.6;
}
.ts-card--sk {
  gap: 12px;
  pointer-events: none;
}
.ts-sk-name,
.ts-sk-root {
  height: 13px;
}
</style>
