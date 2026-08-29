<script setup lang="ts">
/**
 * PeakScrollbar —— 会话流右侧的山峰式消息定位条。
 *
 * 只有用户 prompt 消息打标记；标记线右缘对齐（悬停时只向左生长成山峰，
 * 衰减陡峭 —— 只有贴着鼠标的那几条明显变长），垂直方向按固定间距紧凑
 * 排列、整体居中；点击标记平滑滚动到对应消息，贴近单条弹出玻璃 tooltip。
 * 无滑块、无轨道底色 —— 滚轮即滚动，标记即跳转。
 *
 * 本 App 关闭硬件加速（软件渲染）：动效只用 opacity / 宽度，标记宽度由
 * 事件直改 DOM（绕开响应式 diff）。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { FlowItem } from './flow.js';

const props = defineProps<{
  /** 滚动容器（.transcript） */
  container: HTMLElement | null;
  /** 当前展示的会话流（仅 user 项打标记） */
  items: FlowItem[];
  /** 测量信号：懒挂载页数 / 视图切换后需要重测 */
  version?: number | string;
}>();

interface Tick {
  key: string;
  /** 内容内 y 偏移（px，用于滚动定位 / 视口高亮） */
  cy: number;
  /** 轨道内视觉 y（px，固定间距排列） */
  vy: number;
  preview: string;
}

const GAP = 13; // 固定间距（紧凑）
const PAD = 6; // 轨道上下留白
const FALL = 34; // 山峰衰减半径（陡：只有贴着鼠标的明显变长）
const MINW = 10;
const MAXW = 28;
const SIDE_CAP = 0.5; // 非最近标记的长度上限（比例）——保证最近的一条独占峰值

const root = ref<HTMLElement | null>(null);
const hover = ref(false);
const ticks = ref<Tick[]>([]);
const curSet = ref<Set<number>>(new Set());
const tipIdx = ref(-1);

let ro: ResizeObserver | null = null;
let curRaf = 0;
let measureRaf = 0;

/* ── 测量：内容位置 + 固定间距的视觉位置 ────────────────────── */

function measure() {
  const c = props.container;
  const trackH = root.value?.clientHeight ?? 0;
  if (!c || trackH <= 0) {
    ticks.value = [];
    return;
  }
  const found: Array<{ key: string; cy: number; preview: string }> = [];
  for (const it of props.items) {
    if (it.kind !== 'user') continue;
    const el = c.querySelector(`[data-key="${cssEscape(it.key)}"]`);
    if (!el) continue;
    found.push({ key: it.key, cy: (el as HTMLElement).offsetTop, preview: it.text.slice(0, 180) });
  }
  const n = found.length;
  const step = n > 1 ? Math.min(GAP, (trackH - 2 * PAD) / (n - 1)) : 0;
  const y0 = n > 0 ? Math.max(PAD, (trackH - (n - 1) * step) / 2) : 0;
  ticks.value = found.map((f, i) => ({ ...f, vy: y0 + i * step }));
  tickWidths(null);
  refresh();
}

function cssEscape(s: string): string {
  const g = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  return g?.escape ? g.escape(s) : s.replace(/"/g, '\\"');
}

function scheduleMeasure() {
  if (measureRaf) return;
  measureRaf = requestAnimationFrame(() => {
    measureRaf = 0;
    void nextTick(measure);
  });
}

/* ── 滚动同步（当前视口高亮）───────────────────────────────── */

function refresh() {
  const c = props.container;
  if (!c) return;
  const set = new Set<number>();
  ticks.value.forEach((t, i) => {
    if (t.cy >= c.scrollTop && t.cy <= c.scrollTop + c.clientHeight) set.add(i);
  });
  const sig = [...set].join(',');
  if (sig !== curSig) {
    curSig = sig;
    curSet.value = set;
  }
}

let curSig = '';

function scheduleCur() {
  if (curRaf) return;
  curRaf = requestAnimationFrame(() => {
    curRaf = 0;
    refresh();
  });
}

/* ── 山峰宽度（直改 DOM；右缘对齐，只向左生长）──────────────── */

function tickEls(): HTMLElement[] {
  return root.value ? Array.from(root.value.querySelectorAll<HTMLElement>('.pk-tick')) : [];
}

function tickWidths(my: number | null) {
  const ts = ticks.value;
  if (my === null) {
    tickEls().forEach((el) => {
      el.style.width = `${MINW}px`;
    });
    return;
  }
  // 最近的一条独占山峰峰值，其余压到半幅以下 —— 鼠标落在两条正中间时
  // 对称衰减会给出等长，必须按“最近”裁决才分得清
  let nearest = -1;
  let nd = Infinity;
  ts.forEach((t, i) => {
    const d = Math.abs(t.vy - my);
    if (d < nd) {
      nd = d;
      nearest = i;
    }
  });
  tickEls().forEach((el, i) => {
    const t = ts[i];
    if (!el || !t) return;
    const k = Math.max(0, 1 - Math.abs(t.vy - my) / FALL);
    let len = MINW + (MAXW - MINW) * k * k * (0.4 + 0.6 * k);
    if (i !== nearest) len = Math.min(len, MINW + (MAXW - MINW) * SIDE_CAP);
    el.style.width = `${len.toFixed(1)}px`;
  });
}

function onMove(e: MouseEvent) {
  if (!root.value) return;
  const my = e.clientY - root.value.getBoundingClientRect().top;
  hover.value = true;
  tickWidths(my);
  let best = -1;
  let bestD = 9;
  ticks.value.forEach((t, i) => {
    const d = Math.abs(t.vy - my);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  tipIdx.value = best;
}

function onLeave() {
  hover.value = false;
  tipIdx.value = -1;
  tickWidths(null);
}

/* ── 跳转 ───────────────────────────────────────────────────── */

function onClick(e: MouseEvent) {
  const c = props.container;
  if (!c || !root.value) return;
  const my = e.clientY - root.value.getBoundingClientRect().top;
  let best = -1;
  let bestD = 10;
  ticks.value.forEach((t, i) => {
    const d = Math.abs(t.vy - my);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  const t = ticks.value[best];
  if (best >= 0 && t) {
    c.scrollTo({ top: Math.max(0, t.cy - c.clientHeight * 0.3), behavior: 'smooth' });
  }
}

/* ── 生命周期 ───────────────────────────────────────────────── */

function onWindowResize() {
  scheduleMeasure();
}

onMounted(() => {
  window.addEventListener('resize', onWindowResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize);
  props.container?.removeEventListener('scroll', scheduleCur);
  ro?.disconnect();
  ro = null;
  if (curRaf) cancelAnimationFrame(curRaf);
  if (measureRaf) cancelAnimationFrame(measureRaf);
});

watch(
  () => props.container,
  (c, old) => {
    if (old) old.removeEventListener('scroll', scheduleCur);
    ro?.disconnect();
    ro = null;
    if (c) {
      c.addEventListener('scroll', scheduleCur, { passive: true });
      ro = new ResizeObserver(scheduleMeasure);
      if (c.firstElementChild) ro.observe(c.firstElementChild);
    }
    scheduleMeasure();
  },
  { immediate: true },
);

watch(
  () => [props.items, props.version],
  () => scheduleMeasure(),
);
</script>

<template>
  <div
    ref="root"
    class="pk"
    :class="{ hover }"
    @mouseenter="hover = true"
    @mousemove="onMove"
    @mouseleave="onLeave"
    @click="onClick"
  >
    <div
      v-for="(t, i) in ticks"
      :key="t.key"
      class="pk-tick"
      :class="{ cur: curSet.has(i), hot: tipIdx === i }"
      :style="{ top: t.vy.toFixed(1) + 'px' }"
    />
    <div
      v-if="tipIdx >= 0 && ticks[tipIdx]"
      class="pk-tip"
      :style="{ top: (ticks[tipIdx] as Tick).vy.toFixed(1) + 'px' }"
    >{{ (ticks[tipIdx] as Tick).preview }}</div>
  </div>
</template>

<style scoped>
.pk {
  position: absolute;
  top: 4px;
  bottom: 4px;
  right: 3px;
  width: 16px;
  z-index: 5;
}
/* 标记线右缘对齐（悬停只向左生长），固定间距布局由测量写入 top */
.pk-tick {
  position: absolute;
  right: 8px;
  height: 2px;
  width: 10px;
  border-radius: 1px;
  background: rgba(38, 32, 66, 0.25);
  transition:
    width 110ms ease-out,
    background-color 110ms ease;
}
.pk-tick.cur {
  background: var(--fg-0);
}
.pk-tick.hot {
  background: var(--acc-0);
}
.pk-tip {
  position: absolute;
  /* 最长标记伸到 36px 处，tip 从 44px 起完全让开标记列 */
  right: 44px;
  /* 显式宽度：绝对定位的 shrink-to-fit 会按 16px 父容器算可用空间，
     max-width 会塌成几个字的 min-content */
  width: 320px;
  transform: translateY(-50%);
  max-height: 170px;
  overflow: hidden;
  padding: 8px 11px;
  border-radius: 10px;
  background: rgba(252, 251, 255, 0.82);
  backdrop-filter: blur(14px) saturate(140%);
  border: 1px solid rgba(255, 255, 255, 0.6);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.7),
    0 8px 24px rgba(38, 32, 66, 0.16);
  font-size: 12px;
  line-height: 1.55;
  color: var(--fg-1);
  white-space: pre-wrap;
  pointer-events: none;
  z-index: 6;
}
</style>
