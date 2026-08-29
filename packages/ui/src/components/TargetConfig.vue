<script setup lang="ts">
import type { ToolInfo } from '../types.js';

const props = defineProps<{
  tools: ToolInfo[];
  selected: string | null;
  root?: string;
  rootPlaceholder?: string;
  sourceCwd?: string;
  targetCwd?: string;
  showFlatten?: boolean;
  flatten?: boolean;
  showKeepSynthetic?: boolean;
  keepSynthetic?: boolean;
}>();

const emit = defineEmits<{
  'update:selected': [id: string];
  'update:root': [v: string];
  'update:targetCwd': [v: string];
  'update:flatten': [v: boolean];
  'update:keepSynthetic': [v: boolean];
  browseRoot: [];
  browseCwd: [];
}>();
</script>

<template>
  <section class="target-config sm-stagger">
    <div class="tc-block sm-card" :style="{ '--i': 0 }">
      <p class="sm-tag tc-tag">目标工具 · TARGET</p>
      <div class="tc-tools" role="radiogroup" aria-label="目标工具">
        <button
          v-for="t in props.tools"
          :key="t.id"
          type="button"
          class="tc-tool"
          role="radio"
          :aria-checked="props.selected === t.id"
          :class="{ 'is-active': props.selected === t.id }"
          @click="emit('update:selected', t.id)"
        >
          {{ t.label }}
        </button>
      </div>
    </div>

    <div class="tc-block sm-card" :style="{ '--i': 1 }">
      <p class="sm-tag tc-tag">目标存储目录 · ROOT</p>
      <div class="tc-row">
        <input
          class="sm-input"
          :value="props.root"
          :placeholder="props.rootPlaceholder || '默认位置'"
          spellcheck="false"
          @input="emit('update:root', ($event.target as HTMLInputElement).value)"
        />
        <button class="sm-btn" type="button" @click="emit('browseRoot')">浏览…</button>
      </div>
      <p class="tc-hint">留空写入默认位置。写入的是<strong>全新会话</strong>，不会覆盖已有会话。</p>
    </div>

    <div class="tc-block sm-card" :style="{ '--i': 2 }">
      <p class="sm-tag tc-tag">目标工作目录 · CWD</p>
      <div class="tc-row">
        <input
          class="sm-input"
          :value="props.targetCwd"
          :placeholder="props.sourceCwd || '沿用源会话的工作目录'"
          spellcheck="false"
          @input="emit('update:targetCwd', ($event.target as HTMLInputElement).value)"
        />
        <button class="sm-btn" type="button" @click="emit('browseCwd')">浏览…</button>
      </div>
    </div>

    <div v-if="props.showFlatten || props.showKeepSynthetic" class="tc-block sm-card" :style="{ '--i': 3 }">
      <p class="sm-tag tc-tag">高级选项 · OPTIONS</p>
      <label v-if="props.showFlatten" class="tc-opt sm-switch">
        <input
          type="checkbox"
          :checked="props.flatten"
          @change="emit('update:flatten', ($event.target as HTMLInputElement).checked)"
        />
        <span class="sm-switch-track" aria-hidden="true" />
        <span class="tc-opt-text">展平旁链 / 子代理为顶层消息<em>不开启则按目标工具的原生旁链形态保留</em></span>
      </label>
      <label v-if="props.showKeepSynthetic" class="tc-opt sm-switch">
        <input
          type="checkbox"
          :checked="props.keepSynthetic"
          @change="emit('update:keepSynthetic', ($event.target as HTMLInputElement).checked)"
        />
        <span class="sm-switch-track" aria-hidden="true" />
        <span class="tc-opt-text">保留源工具注入的运行时上下文<em>默认丢弃 — 目标工具会自行管理运行时上下文</em></span>
      </label>
    </div>
  </section>
</template>

<style scoped>
.target-config {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tc-tag {
  margin: 0 0 12px;
}
.tc-block {
  padding: 16px 18px;
}
.tc-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.tc-tool {
  appearance: none;
  font: 500 13px/1.4 var(--sans);
  letter-spacing: 0.01em;
  color: var(--fg-1);
  background: transparent;
  border: 1px solid var(--line-1);
  border-radius: 999px;
  padding: 7px 16px;
  cursor: pointer;
  transition:
    color var(--t-fast) ease,
    border-color var(--t-fast) ease,
    background var(--t-fast) ease,
    transform var(--t-fast) var(--ease-out);
}
.tc-tool:hover {
  color: var(--fg-0);
  border-color: #c6bfdf;
}
.tc-tool:active {
  transform: scale(0.96);
}
.tc-tool.is-active {
  color: #ffffff;
  background: var(--acc-0);
  border-color: var(--acc-0);
  font-weight: 650;
  box-shadow: 0 2px 10px rgba(118, 99, 224, 0.3);
}
.tc-row {
  display: flex;
  gap: 8px;
}
.tc-row .sm-input {
  min-width: 0;
}
.tc-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--fg-2);
  line-height: 1.6;
}
.tc-hint strong {
  color: var(--warn);
  font-weight: 600;
}
.tc-opt {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 7px 0;
}
.tc-opt-text {
  font-size: 13px;
  color: var(--fg-0);
  line-height: 1.5;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tc-opt-text em {
  font-style: normal;
  font-size: 11.5px;
  color: var(--fg-2);
}
</style>
