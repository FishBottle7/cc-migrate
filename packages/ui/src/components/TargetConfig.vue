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
  /** 工具清单未就绪：整节骨架（正常流程到这一步时已就绪，防御性保留） */
  loading?: boolean;
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
    <!-- 骨架：复刻字段行的形 -->
    <template v-if="props.loading">
      <div v-for="i in 4" :key="'sk' + i" class="tc-item" aria-hidden="true">
        <div class="tc-label">
          <span class="sm-sk tc-sk-name" :style="{ width: 52 + ((i * 9) % 20) + 'px' }" />
          <span class="sm-sk tc-sk-tag" :style="{ width: 38 + ((i * 7) % 16) + 'px' }" />
        </div>
        <div class="tc-field">
          <template v-if="i === 1">
            <div class="tc-sk-pills">
              <span v-for="p in 4" :key="p" class="sm-sk tc-sk-pill" :style="{ width: 54 + p * 15 + 'px' }" />
            </div>
          </template>
          <template v-else>
            <span class="sm-sk tc-sk-line" :style="{ width: 58 + ((i * 17) % 32) + '%' }" />
            <span v-if="i === 2" class="sm-sk tc-sk-line tc-sk-line--tail" style="width: 42%" />
          </template>
        </div>
      </div>
    </template>

    <template v-else>
      <!-- 目标工具 -->
      <div class="tc-item" :style="{ '--i': 0 }">
        <div class="tc-label">
          <h3>目标工具</h3>
          <span class="sm-tag">TARGET</span>
        </div>
        <div class="tc-field">
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
      </div>

      <!-- 存储位置 -->
      <div class="tc-item" :style="{ '--i': 1 }">
        <div class="tc-label">
          <h3>存储位置</h3>
          <span class="sm-tag">ROOT</span>
        </div>
        <div class="tc-field">
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
      </div>

      <!-- 工作目录 -->
      <div class="tc-item" :style="{ '--i': 2 }">
        <div class="tc-label">
          <h3>工作目录</h3>
          <span class="sm-tag">CWD</span>
        </div>
        <div class="tc-field">
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
          <p v-if="props.sourceCwd" class="tc-hint">
            源会话位于 <code>{{ props.sourceCwd }}</code>
          </p>
        </div>
      </div>

      <!-- 迁移选项 -->
      <div v-if="props.showFlatten || props.showKeepSynthetic" class="tc-item" :style="{ '--i': 3 }">
        <div class="tc-label">
          <h3>迁移选项</h3>
          <span class="sm-tag">OPTIONS</span>
        </div>
        <div class="tc-field">
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
      </div>
    </template>
  </section>
</template>

<style scoped>
.target-config {
  display: flex;
  flex-direction: column;
}
/* 平级字段行：左标签列 + 右内容列，行间细分隔线。四个配置项无先后之分，
   故意不用序号 / 连线等流程暗示。 */
.tc-item {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 8px 18px;
  padding: 15px 0;
}
.tc-item + .tc-item {
  border-top: 1px solid var(--line-0);
}
.tc-item:first-child {
  padding-top: 2px;
}
.tc-item:last-child {
  padding-bottom: 2px;
}
.tc-label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-top: 2px;
}
.tc-label h3 {
  margin: 0;
  font: 600 13.5px/1.4 var(--sans);
  letter-spacing: 0.02em;
  color: var(--fg-0);
}
.tc-field {
  min-width: 0;
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
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
}
.tc-hint {
  margin: 9px 0 0;
  font-size: 12px;
  color: var(--fg-2);
  line-height: 1.6;
}
.tc-hint strong {
  color: var(--warn);
  font-weight: 600;
}
.tc-hint code {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--fg-1);
  word-break: break-all;
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

/* 骨架 */
.tc-label .sm-sk,
.tc-field .sm-sk {
  display: block;
}
.tc-sk-name {
  height: 13px;
}
.tc-sk-tag {
  height: 9px;
}
.tc-sk-line {
  height: 11px;
}
.tc-sk-line--tail {
  margin-top: 10px;
}
.tc-sk-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.tc-sk-pill {
  height: 31px;
  border-radius: 999px;
}
</style>
