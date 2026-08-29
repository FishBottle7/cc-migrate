<script setup lang="ts">
/**
 * 结构化会话预览 —— DSH 会话视图的外壳：头部（标题/元信息芯片）+
 * 懒挂载滚动容器。会话流本体（气泡/markdown/披露行/子代理嵌套）由
 * TranscriptFlow 递归渲染。滚动到附近增量挂载（懒加载）。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { PreviewPayload } from '../types.js';
import { computeFlow, type FlowItem } from './flow.js';
import TranscriptFlow from './TranscriptFlow.vue';

const props = defineProps<{
  payload: PreviewPayload | null;
  loading?: boolean;
  error?: string | null;
}>();

/* ── flow 模型：主会话 + 子代理旁链（追加在流尾部）──────────── */

const flow = computed<FlowItem[]>(() => {
  const items = computeFlow(props.payload?.messages ?? [], 'm');
  const scs = props.payload?.sidechains ?? [];
  if (scs.length === 0) return items;
  return [
    ...items,
    ...scs.map((sc, i) => ({
      kind: 'subagent' as const,
      key: `sc${i}`,
      agentId: sc.agentId,
      agentType: sc.agentType,
      truncated: sc.truncated,
      items: computeFlow(sc.messages, `sc${i}`),
    })),
  ];
});

/* ── 懒挂载 ─────────────────────────────────────────────────── */

const PAGE = 50;
const renderCount = ref(PAGE);
const transcript = ref<HTMLElement | null>(null);

watch(
  () => props.payload?.sessionId,
  async () => {
    renderCount.value = PAGE;
    await nextTick();
    transcript.value?.scrollTo({ top: 0 });
  },
);

const visible = computed(() => flow.value.slice(0, renderCount.value));

function onScroll(e: Event) {
  const el = e.target as HTMLElement;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 600) {
    renderCount.value = Math.min(renderCount.value + PAGE, flow.value.length);
  }
}

/* ── 加载计时（大会话解析提示）──────────────────────────────── */

const elapsed = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;

watch(
  () => props.loading,
  (on) => {
    if (on && !timer) {
      elapsed.value = 0;
      timer = setInterval(() => elapsed.value++, 1000);
    } else if (!on && timer) {
      clearInterval(timer);
      timer = null;
    }
  },
);
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

/* ── 杂项 ───────────────────────────────────────────────────── */

function fmtChip(ts?: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
</script>

<template>
  <section class="session-preview">
    <Transition name="svp-swap" mode="out-in">
      <!-- 骨架 -->
      <div v-if="props.loading" key="loading" class="svp-sk">
        <div class="sm-flow" aria-hidden="true" />
        <p class="svp-sk-note sm-tag">正在离线解析会话 · {{ elapsed }}s</p>
        <div v-for="i in 6" :key="i" class="sm-sk svp-sk-line" :style="{ width: 92 - i * 9 + '%' }" />
      </div>

      <!-- 错误 -->
      <div v-else-if="props.error" key="error" class="svp-state svp-state--err">
        <p>{{ props.error }}</p>
      </div>

      <!-- 空态 -->
      <div v-else-if="!props.payload" key="empty" class="svp-state">
        <div class="svp-empty-mark" aria-hidden="true">◦</div>
        <p>选择左侧会话，查看离线预览<br /><span>只读 · 不启动模型 · 不写入任何数据</span></p>
      </div>

      <!-- 内容 -->
      <div v-else :key="props.payload.sessionId" class="svp-content">
        <header class="svp-head">
          <p class="sm-tag svp-tag">预览 · PREVIEW</p>
          <h3 class="svp-title">{{ props.payload.title || '(无标题)' }}</h3>
          <div class="svp-chips">
            <span class="svp-chip sm-mono">{{ fmtChip(props.payload.createdAt) }}</span>
            <span class="svp-chip">{{ props.payload.messageCount }} 条消息</span>
            <span v-if="props.payload.sidechainCount" class="svp-chip svp-chip--acc">
              {{ props.payload.sidechainCount }} 条子代理
            </span>
            <span v-if="props.payload.toolCallCount" class="svp-chip">
              {{ props.payload.toolCallCount }} 次工具调用
            </span>
            <span v-if="props.payload.model" class="svp-chip sm-mono">{{ props.payload.model }}</span>
          </div>
          <div v-if="props.payload.cwd" class="svp-cwd sm-mono" :title="props.payload.cwd">
            {{ props.payload.cwd }}
          </div>
        </header>

        <div ref="transcript" class="transcript" @scroll="onScroll">
          <div class="column">
            <TranscriptFlow :items="visible" />

            <div v-if="renderCount < flow.length" class="pv-more">
              <button class="sm-btn" type="button" @click="renderCount = Math.min(renderCount + PAGE, flow.length)">
                显示更多 · 已加载 {{ visible.length }} / {{ flow.length }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.session-preview {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.svp-content {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
  min-height: 0;
}
.svp-sk {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 2px;
}
.svp-sk .sm-flow {
  margin-bottom: 2px;
}
.svp-sk-note {
  color: var(--fg-2);
  font-variant-numeric: tabular-nums;
}
.svp-sk-line {
  height: 14px;
}
.svp-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--fg-1);
  font-size: 13px;
  text-align: center;
  line-height: 1.8;
  border: 1px dashed var(--line-1);
  border-radius: 10px;
}
.svp-state p {
  margin: 0;
}
.svp-state p span {
  font-size: 11.5px;
  color: var(--fg-2);
}
.svp-empty-mark {
  font-size: 26px;
  color: var(--fg-2);
}
.svp-state--err {
  color: var(--err);
  border-color: rgba(201, 54, 78, 0.4);
}
.svp-tag {
  margin: 0 0 8px;
}
.svp-head {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: none;
}
.svp-title {
  margin: 0;
  font: 600 16px/1.5 var(--sans);
  color: var(--fg-0);
  letter-spacing: 0.01em;
  word-break: break-all;
}
.svp-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.svp-chip {
  font-size: 11px;
  color: var(--fg-1);
  border: 1px solid var(--line-0);
  background: var(--ink-1);
  border-radius: 999px;
  padding: 3px 10px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.svp-chip--acc {
  color: var(--acc-ink);
  border-color: rgba(118, 99, 224, 0.4);
  background: var(--acc-soft);
}
.svp-cwd {
  font-size: 11px;
  color: var(--fg-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 会话流滚动容器（居中窄栏 + 横向溢出保护）──────────────── */
.transcript {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 10px 8px 4px;
}
.column {
  width: 100%;
  max-width: 760px;
  margin: 0 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 懒加载 */
.pv-more {
  display: flex;
  justify-content: center;
  padding: 6px 0 2px;
}

/* 内容切换动效 */
.svp-swap-enter-active {
  transition: opacity var(--t-med) var(--ease-out), transform var(--t-med) var(--ease-out);
}
.svp-swap-leave-active {
  transition: opacity 110ms ease;
}
.svp-swap-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.svp-swap-leave-to {
  opacity: 0;
}
</style>
