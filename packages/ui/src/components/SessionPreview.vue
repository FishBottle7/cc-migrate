<script setup lang="ts">
/**
 * 结构化会话预览 —— DSH 会话视图的外壳，两级视图：
 *   main  → 主会话流（懒挂载）
 *   agent → 某个子代理的内部会话流（整区切换）
 * 右上角「子代理」按钮弹出一棵任务树（DSH 样式）：顶部主会话节点 +
 * 树枝下的子代理节点；点主会话节点即回主会话。可定位的节点悬停出现
 * 十字准星，跳回主会话中召唤它的调用点（平滑滚动 + 闪烁高亮）。
 * 预览区无卡片包裹。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { PreviewPayload } from '../types.js';
import { computeFlow, type FlowItem } from './flow.js';
import TranscriptFlow from './TranscriptFlow.vue';
import PeakScrollbar from './PeakScrollbar.vue';

const props = defineProps<{
  payload: PreviewPayload | null;
  loading?: boolean;
  error?: string | null;
}>();

/* ── 视图状态 ───────────────────────────────────────────────── */

type View = { type: 'main' } | { type: 'agent'; index: number };
const view = ref<View>({ type: 'main' });
const menuOpen = ref(false);

watch(
  () => props.payload?.sessionId,
  () => {
    view.value = { type: 'main' };
    menuOpen.value = false;
    renderCount.value = PAGE;
  },
);

const scs = computed(() => props.payload?.sidechains ?? []);

/* ── flow 模型 ──────────────────────────────────────────────── */

const flow = computed<FlowItem[]>(() => computeFlow(props.payload?.messages ?? [], 'm'));
const agentFlows = computed<FlowItem[][]>(() =>
  scs.value.map((sc, i) => computeFlow(sc.messages, `ag${i}`)),
);

// callId → 主流条目下标（召唤点锚定用）
const idxByCall = computed(() => {
  const map = new Map<string, number>();
  flow.value.forEach((it, i) => {
    if (it.kind === 'tool' && it.callId) map.set(it.callId, i);
  });
  return map;
});

// agentId → 召唤 callId（DSH 的旁链没有 parentMessageId，
// 但 Task 结果文本含 "started subagent <agentId>"，退化到任意结果含 agentId）
const callByAgent = computed(() => {
  const map = new Map<string, string>();
  for (const sc of scs.value) {
    if (!sc.agentId) continue;
    for (const m of props.payload?.messages ?? []) {
      for (const b of m.blocks) {
        if (b.t !== 'tool_result' || !b.callId || !b.text) continue;
        if (b.text.includes(`started subagent ${sc.agentId}`) || b.text.includes(sc.agentId)) {
          map.set(sc.agentId, b.callId);
          break;
        }
      }
      if (map.has(sc.agentId)) break;
    }
  }
  return map;
});

function summonCallId(i: number): string | undefined {
  const sc = scs.value[i];
  if (!sc) return undefined;
  return sc.parentCallId ?? callByAgent.value.get(sc.agentId);
}

const currentAgent = computed(() =>
  view.value.type === 'agent' ? (scs.value[view.value.index] ?? null) : null,
);
const currentAgentFlow = computed<FlowItem[]>(() =>
  view.value.type === 'agent' ? (agentFlows.value[view.value.index] ?? []) : [],
);

function agentLabel(i: number): string {
  const sc = scs.value[i];
  if (!sc) return '';
  return sc.agentType ?? sc.agentId.slice(0, 12);
}

/* ── 懒挂载（主会话）────────────────────────────────────────── */

const PAGE = 50;
const renderCount = ref(PAGE);
const transcript = ref<HTMLElement | null>(null);

watch(
  () => props.payload?.sessionId,
  async () => {
    await nextTick();
    transcript.value?.scrollTo({ top: 0 });
  },
);

const mainVisible = computed(() => flow.value.slice(0, renderCount.value));
const displayItems = computed<FlowItem[]>(() =>
  view.value.type === 'agent' ? currentAgentFlow.value : mainVisible.value,
);

function onScroll(e: Event) {
  if (view.value.type !== 'main') return;
  const el = e.target as HTMLElement;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 600) {
    renderCount.value = Math.min(renderCount.value + PAGE, flow.value.length);
  }
}

/* ── 子代理树 ───────────────────────────────────────────────── */

function toggleMenu() {
  menuOpen.value = !menuOpen.value;
}
function openAgent(i: number) {
  view.value = { type: 'agent', index: i };
  menuOpen.value = false;
}
function backToMain() {
  view.value = { type: 'main' };
  menuOpen.value = false;
}
function onEsc(e: KeyboardEvent) {
  if (e.key === 'Escape') menuOpen.value = false;
}
watch(menuOpen, (on) => {
  if (on) window.addEventListener('keydown', onEsc);
  else window.removeEventListener('keydown', onEsc);
});

/* ── 召唤点跳转 ─────────────────────────────────────────────── */

let flashTimer: ReturnType<typeof setTimeout> | null = null;

async function jumpToSummon(i: number) {
  menuOpen.value = false;
  const callId = summonCallId(i);
  view.value = { type: 'main' };
  if (!callId) return;
  renderCount.value = flow.value.length; // 目标行可能还没懒挂载
  await nextTick();
  const el = transcript.value?.querySelector(`[data-call="${cssEscape(callId)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('sc-flash');
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('sc-flash'), 1800);
}

function cssEscape(s: string): string {
  const c = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  return c?.escape ? c.escape(s) : s.replace(/"/g, '\\"');
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onEsc);
  if (flashTimer) clearTimeout(flashTimer);
});

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
        <p>选择左侧会话，查看离线预览<br /><span>只读 · 不启动模型 · 不写入任何数据</span></p>
      </div>

      <!-- 内容 -->
      <div v-else :key="props.payload.sessionId" class="svp-content">
        <!-- ── 头部 ── -->
        <header class="svp-head">
          <div class="svp-head-row">
            <h3 v-if="view.type === 'agent' && currentAgent" class="svp-title">
              子代理 · {{ agentLabel(view.index) }}
            </h3>
            <template v-else>
              <h3 class="svp-title" :title="props.payload.title || ''">
                {{ props.payload.title || '(无标题)' }}
              </h3>
              <span class="svp-id sm-mono" :title="props.payload.sessionId">
                {{ props.payload.sessionId.slice(0, 15) }}
              </span>
            </template>

            <!-- 任务树开关 -->
            <span v-if="scs.length" class="sv-sc-wrap">
              <button type="button" class="sv-sc-btn" :class="{ open: menuOpen }" @click="toggleMenu">
                <svg viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="1.5" width="5" height="5" rx="1" /><rect x="7.5" y="7.5" width="5" height="5" rx="1" /><path d="M6.5 4h2.5a1 1 0 011 1v2.5" /></svg>
                {{ view.type === 'agent' ? `子代理 · ${agentLabel(view.index)}` : `子代理 · ${scs.length}` }}
                <svg class="sv-sc-chev" viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 2.5L4 5.5l2.5-3" /></svg>
              </button>

              <Transition name="scm">
                <div v-if="menuOpen" class="sc-menu" role="menu">
                  <!-- 主会话节点（点它回主会话） -->
                  <button
                    type="button"
                    class="sc-node sc-node--main"
                    :class="{ 'is-current': view.type === 'main' }"
                    role="menuitem"
                    @click="backToMain"
                  >
                    <span class="scm-ic" aria-hidden="true">
                      <svg viewBox="0 0 14 14"><path d="M3.5 1.5h5l2 2v9h-7z" /><path d="M5.5 7h3M5.5 9.5h3" /></svg>
                    </span>
                    <span class="scm-name">{{ props.payload.title || '主会话' }}</span>
                    <span class="scm-meta sm-mono">{{ props.payload.messageCount }} 条</span>
                  </button>
                  <!-- 树枝：子代理节点 -->
                  <div class="sc-branch">
                    <button
                      v-for="(sc, i) in scs"
                      :key="sc.agentId"
                      type="button"
                      class="sc-node"
                      :class="{ 'is-current': view.type === 'agent' && view.index === i }"
                      role="menuitem"
                      @click="openAgent(i)"
                    >
                      <span class="scm-ic" aria-hidden="true">
                        <svg viewBox="0 0 14 14"><rect x="1.5" y="1.5" width="5" height="5" rx="1" /><rect x="7.5" y="7.5" width="5" height="5" rx="1" /><path d="M6.5 4h2.5a1 1 0 011 1v2.5" /></svg>
                      </span>
                      <span class="scm-name">{{ sc.agentType ?? sc.agentId.slice(0, 8) }}</span>
                      <span class="scm-meta sm-mono">{{ sc.messages.length }} 条</span>
                      <!-- 只在主会话视图提供定位：子代理视图里点跳转会中断当前视图 -->
                      <span
                        v-if="view.type === 'main' && summonCallId(i) !== undefined"
                        class="scm-jump"
                        title="跳转到召唤处"
                        role="button"
                        @click.stop="jumpToSummon(i)"
                      >
                        <svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="4" /><path d="M7 1v2.2M7 10.8V13M1 7h2.2M10.8 7H13" /></svg>
                      </span>
                    </button>
                  </div>
                </div>
              </Transition>
            </span>
          </div>
          <div v-if="menuOpen" class="sc-menu-backdrop" @click="menuOpen = false" />

          <div class="svp-chips">
            <template v-if="view.type === 'agent' && currentAgent">
              <span class="svp-chip">{{ currentAgent.messages.length }} 条消息</span>
              <span v-if="currentAgent.truncated" class="svp-chip">已截断</span>
              <span class="svp-chip sm-mono" :title="currentAgent.agentId">{{ currentAgent.agentId.slice(0, 8) }}</span>
            </template>
            <template v-else>
              <span class="svp-chip sm-mono">{{ fmtChip(props.payload.createdAt) }}</span>
              <span class="svp-chip">{{ props.payload.messageCount }} 条消息</span>
              <span v-if="props.payload.toolCallCount" class="svp-chip">
                {{ props.payload.toolCallCount }} 次工具调用
              </span>
              <span v-if="props.payload.model" class="svp-chip sm-mono">{{ props.payload.model }}</span>
            </template>
          </div>
          <div v-if="view.type === 'main' && props.payload.cwd" class="svp-cwd sm-mono" :title="props.payload.cwd">
            {{ props.payload.cwd }}
          </div>
        </header>

        <!-- ── 会话流 ── -->
        <div class="transcript-wrap">
          <div ref="transcript" class="transcript" @scroll="onScroll">
            <div class="column">
              <TranscriptFlow :items="displayItems" />

              <div v-if="view.type === 'main' && renderCount < flow.length" class="pv-more">
                <button
                  class="sm-btn"
                  type="button"
                  @click="renderCount = Math.min(renderCount + PAGE, flow.length)"
                >
                  显示更多 · 已加载 {{ mainVisible.length }} / {{ flow.length }}
                </button>
              </div>
            </div>
          </div>
          <PeakScrollbar
            :container="transcript"
            :items="displayItems"
            :version="renderCount + ':' + view.type + (view.type === 'agent' ? view.index : '')"
          />
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
  gap: 8px;
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
}
.svp-state p {
  margin: 0;
}
.svp-state p span {
  font-size: 11.5px;
  color: var(--fg-2);
}
.svp-state--err {
  color: var(--err);
}

/* ── 头部 ─────────────────────────────────────────────────── */
.svp-head {
  display: flex;
  flex-direction: column;
  gap: 7px;
  flex: none;
  padding: 2px 2px 8px;
  border-bottom: 1px solid var(--line-0);
}
.svp-head-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
/* 标题只占内容宽（编号紧贴其右），树按钮推到最右 */
.svp-head-row .svp-title {
  flex: 0 1 auto;
}
.svp-head-row .sv-sc-wrap {
  margin-left: auto;
}
.svp-title {
  margin: 0;
  flex: 1 1 auto;
  min-width: 0;
  font: 600 15px/1.5 var(--sans);
  color: var(--fg-0);
  letter-spacing: 0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.svp-id {
  flex: none;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--fg-2);
  border: 1px solid var(--line-0);
  border-radius: 999px;
  padding: 2px 8px;
  cursor: default;
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
  background: transparent;
  border-radius: 999px;
  padding: 3px 10px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.svp-cwd {
  font-size: 11px;
  color: var(--fg-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 任务树开关 + 液体毛玻璃树 ─────────────────────────────── */
.sv-sc-wrap {
  position: relative;
  flex: none;
}
.sv-sc-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  appearance: none;
  font: 500 12px/1 var(--sans);
  color: var(--acc-ink);
  background: var(--acc-soft);
  border: 1px solid rgba(118, 99, 224, 0.35);
  border-radius: 999px;
  padding: 5px 11px;
  cursor: pointer;
  transition: background var(--t-fast) ease, border-color var(--t-fast) ease;
}
.sv-sc-btn > svg:first-child {
  width: 13px;
  height: 13px;
}
.sv-sc-btn > svg:first-child path,
.sv-sc-btn > svg:first-child rect {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.3;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.sv-sc-btn:hover {
  background: rgba(118, 99, 224, 0.22);
  border-color: var(--acc-0);
}
.sv-sc-chev {
  width: 8px;
  height: 8px;
  transition: transform var(--t-fast) var(--ease-out);
}
.sv-sc-chev path {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.sv-sc-btn.open .sv-sc-chev {
  transform: rotate(180deg);
}
.sc-menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
}
/* 液体毛玻璃：半透明底 + 背景模糊增饱和 + 顶缘内高光做「厚度」。
   注意本 App 关闭了硬件加速（软件渲染），所以弹出动画只动 opacity、
   阴影半径收敛 —— transform 缩放/大阴影会让每帧全量重绘，看起来卡。 */
.sc-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 31;
  width: 344px;
  max-height: 420px;
  overflow-y: auto;
  padding: 6px;
  border-radius: 14px;
  background: rgba(252, 251, 255, 0.66);
  backdrop-filter: blur(16px) saturate(150%);
  border: 1px solid rgba(255, 255, 255, 0.55);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.7),
    inset 0 -1px 1px rgba(118, 99, 224, 0.08),
    0 10px 26px rgba(38, 32, 66, 0.16),
    0 2px 6px rgba(38, 32, 66, 0.1);
  scrollbar-width: none;
}
.sc-menu::-webkit-scrollbar {
  display: none;
}
.scm-enter-active {
  transition: opacity 130ms ease;
}
.scm-leave-active {
  transition: opacity 90ms ease;
}
.scm-enter-from,
.scm-leave-to {
  opacity: 0;
}

/* 树：主会话节点在顶，树枝下挂子代理节点 */
.sc-node {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  appearance: none;
  border: none;
  background: none;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
  font: inherit;
  text-align: left;
  color: var(--fg-0);
  transition: background var(--t-fast) ease;
}
.sc-node:hover {
  background: rgba(255, 255, 255, 0.55);
}
.sc-node.is-current {
  background: rgba(118, 99, 224, 0.16);
}
.sc-node.is-current .scm-name {
  color: var(--acc-ink);
}
.sc-node--main .scm-name {
  font-weight: 600;
}
.sc-branch {
  position: relative;
  margin: 2px 0 2px 14px;
  padding-left: 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
/* 树干：裁到最后一节的中心为止，不在面板底部冒尖 */
.sc-branch::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  bottom: 14px;
  width: 1px;
  background: rgba(38, 32, 66, 0.14);
}
.sc-branch .sc-node::before {
  content: "";
  position: absolute;
  left: -12px;
  top: 50%;
  width: 9px;
  height: 1px;
  background: rgba(38, 32, 66, 0.14);
}
.scm-ic {
  flex: none;
  display: inline-flex;
  width: 14px;
  height: 14px;
  color: var(--fg-1);
}
.sc-node.is-current .scm-ic {
  color: var(--acc-ink);
}
.scm-ic svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.3;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.scm-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 550;
}
.scm-meta {
  flex: none;
  font-size: 11px;
  color: var(--fg-2);
  font-variant-numeric: tabular-nums;
}
.scm-jump {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  color: var(--fg-1);
  opacity: 0;
  transition: opacity var(--t-fast) ease, background var(--t-fast) ease, color var(--t-fast) ease;
}
.scm-jump svg {
  width: 13px;
  height: 13px;
}
.scm-jump svg path,
.scm-jump svg circle {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.3;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.sc-node:hover .scm-jump {
  opacity: 1;
}
.scm-jump:hover {
  background: rgba(118, 99, 224, 0.18);
  color: var(--acc-ink);
}

/* ── 会话流滚动容器 ───────────────────────────────────────── */
.transcript-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
}
.transcript {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  /* 原生滚动条让位给山峰定位条；底部留出悬浮按钮的空间 */
  padding: 8px 26px 60px 2px;
  scrollbar-width: none;
}
.transcript::-webkit-scrollbar {
  display: none;
}
.column {
  position: relative;
  width: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 0 2px;
}

/* 召唤点闪烁 */
.transcript :deep(details.sc-flash) > summary {
  animation: sc-flash 0.8s ease 2;
  border-radius: 6px;
}
@keyframes sc-flash {
  50% {
    background: rgba(118, 99, 224, 0.25);
  }
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
