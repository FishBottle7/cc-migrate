<script setup lang="ts">
/**
 * MigrateWizard — 迁移向导（独立 App 与 DSH 插件共用）。
 *
 * 流程对齐 CLI wizard：
 *   1) 选源工具 → 2) 扫描/过滤/选择会话 + 离线预览 →
 *   3) 配置目标（工具/目录/cwd/选项）并确认 → 4) 执行并展示结果。
 *
 * 数据全部经 props.backend 注入，组件不知道宿主是 Electron 还是插件。
 * 视觉：左侧竖排进度轨 + 右侧步骤舞台；步骤切换带方向感知滑动。
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import type { SessionMeta, ToolId } from '@session-migrate/core';
import type { MigrateOutcome, MigrationBackend, PreviewPayload, ToolInfo } from '../types.js';
import ToolSelect from './ToolSelect.vue';
import SessionPicker from './SessionPicker.vue';
import SessionPreview from './SessionPreview.vue';
import TargetConfig from './TargetConfig.vue';

const props = defineProps<{ backend: MigrationBackend }>();

type Step = 'source' | 'sessions' | 'target' | 'done';

const STEP_LABELS: Array<{ key: Step; label: string; en: string }> = [
  { key: 'source', label: '源工具', en: 'SOURCE' },
  { key: 'sessions', label: '选择会话', en: 'SESSION' },
  { key: 'target', label: '目标配置', en: 'TARGET' },
  { key: 'done', label: '完成', en: 'DONE' },
];

const step = ref<Step>('source');
const navDir = ref<'fwd' | 'back'>('fwd');
function navTo(s: Step, dir: 'fwd' | 'back' = 'fwd') {
  navDir.value = dir;
  step.value = s;
}

const tools = ref<ToolInfo[]>([]);
const loadError = ref<string | null>(null);

// 源侧
const srcTool = ref<ToolId | null>(null);
const srcToolInfo = computed(() => tools.value.find((t) => t.id === srcTool.value) ?? null);
const srcRoot = ref('');
const sessions = ref<SessionMeta[]>([]);
const sessionsLoading = ref(false);
const sessionsError = ref<string | null>(null);
const selected = ref<SessionMeta | null>(null);

// 预览
const preview = ref<PreviewPayload | null>(null);
const previewLoading = ref(false);
const previewError = ref<string | null>(null);

// 目标侧
const dstTool = ref<ToolId | null>(null);
const dstToolInfo = computed(() => tools.value.find((t) => t.id === dstTool.value) ?? null);
const dstRoot = ref('');
const targetCwd = ref('');
const flatten = ref(true);
const keepSynthetic = ref(false);

// 执行
const running = ref(false);
const runError = ref<string | null>(null);
const result = ref<MigrateOutcome | null>(null);

const dstToolDefaultRoot = computed(() => dstToolInfo.value?.defaultRoot ?? '');

const showFlatten = computed(() => {
  const sc = srcTool.value;
  const dt = dstTool.value;
  return sc === 'opencode' || sc === 'zcode' || dt === 'opencode' || dt === 'zcode' || !!preview.value?.hasSidechains;
});

const SIDECHAIN_TOOL_NAMES: Record<string, string> = {
  opencode: 'OpenCode hidden task',
  zcode: 'ZCode subagent',
};

/* ── 步骤 1：源工具 ─────────────────────────────────────────── */

async function ensureTools(): Promise<ToolInfo[]> {
  if (tools.value.length) return tools.value;
  loadError.value = null;
  try {
    tools.value = await props.backend.listTools();
  } catch (e) {
    loadError.value = errMsg(e);
  }
  return tools.value;
}
void ensureTools();

async function pickSource(t: ToolInfo) {
  if (running.value) return;
  srcTool.value = t.id;
  srcRoot.value = '';
  sessions.value = [];
  selected.value = null;
  preview.value = null;
  // 先切页再扫描：会话列表立刻显示骨架 + 流动条，扫描在后台完成，
  // 绝不在源工具页原地等（大库扫描数秒会像卡死）。
  navTo('sessions');
  await rescan();
}

async function rescan() {
  if (!srcTool.value) return;
  sessionsLoading.value = true;
  sessionsError.value = null;
  selected.value = null;
  preview.value = null;
  try {
    const root = srcRoot.value.trim();
    sessions.value = await props.backend.listSessions(srcTool.value, root || undefined);
  } catch (e) {
    sessions.value = [];
    sessionsError.value = errMsg(e);
  } finally {
    sessionsLoading.value = false;
  }
}

/* ── 步骤 2：会话 + 预览 ───────────────────────────────────── */

async function pickSession(m: SessionMeta) {
  selected.value = m;
  preview.value = null;
  previewError.value = null;
  previewLoading.value = true;
  try {
    preview.value = await props.backend.preview(
      srcTool.value!,
      m.sessionId,
      srcRoot.value.trim() || undefined,
    );
  } catch (e) {
    previewError.value = errMsg(e);
  } finally {
    previewLoading.value = false;
  }
}

function toTarget() {
  if (!selected.value) return;
  dstTool.value = null;
  dstRoot.value = '';
  targetCwd.value = selected.value.cwd ?? '';
  runError.value = null;
  navTo('target');
}

/* ── 步骤 3：目标 + 执行 ───────────────────────────────────── */

async function browseRoot() {
  const dir = await props.backend.pickDirectory(dstRoot.value.trim() || undefined);
  if (dir) dstRoot.value = dir;
}

async function browseCwd() {
  const dir = await props.backend.pickDirectory(targetCwd.value.trim() || undefined);
  if (dir) targetCwd.value = dir;
}

async function runMigrate() {
  if (!selected.value || !dstTool.value || running.value) return;
  running.value = true;
  runError.value = null;
  startRunTimer();
  try {
    result.value = await props.backend.migrate({
      srcTool: srcTool.value!,
      srcRoot: srcRoot.value.trim() || undefined,
      sessionId: selected.value.sessionId,
      dstTool: dstTool.value,
      dstRoot: dstRoot.value.trim() || undefined,
      targetCwd: targetCwd.value.trim() || undefined,
      flatten: showFlatten.value ? flatten.value : undefined,
      keepSynthetic: keepSynthetic.value,
    });
    navTo('done');
  } catch (e) {
    runError.value = errMsg(e);
  } finally {
    stopRunTimer();
    running.value = false;
  }
}

/* 迁移计时（凭单「打印中」状态显示已运行秒数） */
const runElapsed = ref(0);
let runTimer: ReturnType<typeof setInterval> | null = null;
function startRunTimer(): void {
  runElapsed.value = 0;
  runTimer = setInterval(() => {
    runElapsed.value += 1;
  }, 1000);
}
function stopRunTimer(): void {
  if (runTimer) {
    clearInterval(runTimer);
    runTimer = null;
  }
}

/* 凭单序列号：源会话 id 的前 8 位大写 */
const ticketSerial = computed(() => {
  const id = (selected.value?.sessionId ?? '').replace(/^session-/, '');
  return id ? `No. ${id.slice(0, 8).toUpperCase()}` : 'No. ————';
});

/* ── 目标库现状扫描：写入前的实地确认（独立于迁移执行，不阻塞） ── */

const dstScan = ref<{ loading: boolean; count: number | null; latest: number | null; error: string | null }>({
  loading: false,
  count: null,
  latest: null,
  error: null,
});
let dstScanSeq = 0;
let dstScanTimer: ReturnType<typeof setTimeout> | null = null;

async function scanTarget(tool: ToolId, root: string): Promise<void> {
  const seq = ++dstScanSeq;
  dstScan.value = { loading: true, count: null, latest: null, error: null };
  try {
    const metas = await props.backend.listSessions(tool, root.trim() || undefined);
    if (seq !== dstScanSeq) return;
    let latest = 0;
    for (const m of metas) {
      const ts = m.createdAt ?? 0;
      if (ts > latest) latest = ts;
    }
    dstScan.value = { loading: false, count: metas.length, latest: latest || null, error: null };
  } catch (e) {
    if (seq !== dstScanSeq) return;
    dstScan.value = { loading: false, count: null, latest: null, error: errMsg(e) };
  }
}

watch([dstTool, dstRoot], ([tool, root], [prevTool, prevRoot]) => {
  if (dstScanTimer) {
    clearTimeout(dstScanTimer);
    dstScanTimer = null;
  }
  if (!tool) {
    dstScanSeq++;
    dstScan.value = { loading: false, count: null, latest: null, error: null };
    return;
  }
  if (tool === prevTool && root === prevRoot) return;
  // 输入防抖；大库扫描在 worker 里跑，UI 侧凭单行只显示流动条
  dstScanTimer = setTimeout(() => void scanTarget(tool, root), 320);
});

function fmtAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

onUnmounted(() => {
  if (dstScanTimer) clearTimeout(dstScanTimer);
  stopRunTimer();
});

async function openResultPath(p: string) {
  await props.backend.openPath(p);
}

/* ── 通用 ──────────────────────────────────────────────────── */

function resetAll() {
  srcTool.value = null;
  srcRoot.value = '';
  sessions.value = [];
  selected.value = null;
  preview.value = null;
  dstTool.value = null;
  dstRoot.value = '';
  targetCwd.value = '';
  keepSynthetic.value = false;
  flatten.value = true;
  result.value = null;
  runError.value = null;
  navTo('source', 'back');
}

function backSource() {
  selected.value = null;
  preview.value = null;
  navTo('source', 'back');
}

function backSessions() {
  runError.value = null;
  navTo('sessions', 'back');
}

function stepIndex(s: Step): number {
  return STEP_LABELS.findIndex((x) => x.key === s);
}

/** 进度轨允许点回已走过的步骤（完成页/迁移进行中除外）。 */
function railClick(s: { key: Step }, i: number) {
  if (step.value === 'done' || running.value) return;
  if (i < stepIndex(step.value)) navTo(s.key, 'back');
}

function errMsg(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  return m.length > 300 ? m.slice(0, 300) + '…' : m;
}

/* ── 会话/预览分栏拖拽 ─────────────────────────────────────── */

const SPLIT_KEY = 'sm.split.left';

function clampSplit(v: number): number {
  return Math.min(Math.max(Number.isFinite(v) ? Math.round(v) : 288, 236), 560);
}

function readSplit(): number {
  try {
    const raw = localStorage.getItem(SPLIT_KEY);
    return raw === null ? 288 : clampSplit(Number(raw));
  } catch {
    return 288;
  }
}

const splitEl = ref<HTMLElement | null>(null);
const splitLeft = ref(readSplit());

function startDrag(e: MouseEvent) {
  e.preventDefault();
  const rect = splitEl.value?.getBoundingClientRect();
  if (!rect) return;
  const max = Math.max(rect.width - 430, 300);
  const move = (ev: MouseEvent) => {
    splitLeft.value = clampSplit(ev.clientX - rect.left);
  };
  const up = () => {
    try {
      localStorage.setItem(SPLIT_KEY, String(splitLeft.value));
    } catch {
      /* 无 localStorage 时仅会话内生效 */
    }
    document.body.classList.remove('sv-resizing');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  document.body.classList.add('sv-resizing');
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}
</script>

<template>
  <div class="wizard">
    <!-- ── 左侧进度轨 ── -->
    <aside class="wz-rail">
      <div class="brand">
        <span class="seal" aria-hidden="true">迁</span>
        <span class="brand-text">
          <b class="sm-mono">session-migrate</b>
          <i>AI 编码会话迁移</i>
        </span>
      </div>

      <ol class="rail-steps">
        <li
          v-for="(s, i) in STEP_LABELS"
          :key="s.key"
          class="rail-step"
          :class="{
            'is-current': s.key === step,
            'is-done': stepIndex(step) > i,
            'is-clickable': i < stepIndex(step) && step !== 'done',
          }"
          @click="railClick(s, i)"
        >
          <span class="rs-node sm-mono">
            <svg v-if="stepIndex(step) > i" viewBox="0 0 12 12" class="rs-check" aria-hidden="true">
              <path d="M2.5 6.5l2.5 2.5 4.5-5.5" />
            </svg>
            <template v-else>{{ String(i + 1).padStart(2, '0') }}</template>
          </span>
          <span class="rs-text">
            <span class="rs-label">{{ s.label }}</span>
            <span class="rs-en sm-tag">{{ s.en }}</span>
          </span>
          <span class="rs-line" aria-hidden="true" />
        </li>
      </ol>

      <footer class="rail-foot">
        <span class="rf-dot" aria-hidden="true" />
        本地处理 · 数据不出本机
      </footer>
    </aside>

    <!-- ── 右侧步骤舞台 ── -->
    <main class="wz-stage">
      <Transition :name="navDir === 'fwd' ? 'wz-fwd' : 'wz-back'" mode="out-in">
        <div :key="step" class="wz-pane">
          <!-- 步骤 1：源工具 -->
          <div v-if="step === 'source'" class="pane pane--center">
            <div v-if="loadError" class="pane-error">{{ loadError }}</div>
            <ToolSelect
              heading="从哪里迁出？"
              subheading="选择源工具后自动扫描其默认存储位置，之后可修改目录重新扫描。"
              :tools="tools"
              :selected="srcTool"
              :loading="tools.length === 0 && !loadError"
              @select="pickSource"
            />
          </div>

          <!-- 步骤 2：会话 + 预览 -->
          <div v-else-if="step === 'sessions'" class="pane pane--fill">
            <div class="root-bar">
              <span class="sm-tag root-tag">存储目录</span>
              <input
                v-model="srcRoot"
                class="sm-input"
                :placeholder="srcToolInfo?.defaultRoot || '默认位置'"
                spellcheck="false"
                @keyup.enter="rescan"
              />
              <button class="sm-btn" type="button" :disabled="sessionsLoading" @click="rescan">扫描</button>
              <button class="sm-btn sm-btn--ghost" type="button" @click="backSource">← 换源工具</button>
            </div>
            <div ref="splitEl" class="split">
              <SessionPicker
                class="split-left"
                :style="{ width: splitLeft + 'px' }"
                :sessions="sessions"
                :loading="sessionsLoading"
                :error="sessionsError"
                :selected-id="selected?.sessionId ?? null"
                @select="pickSession"
                @refresh="rescan"
              />
              <div class="split-divider" title="拖动调节宽度" @mousedown="startDrag" />
              <SessionPreview
                class="split-right"
                :payload="preview"
                :loading="previewLoading"
                :error="previewError"
              />
            </div>
            <button
              class="sm-btn sm-btn--primary next-fab"
              type="button"
              :disabled="!selected"
              @click="toTarget"
            >
              下一步 · 配置目标 →
            </button>
          </div>

          <!-- 步骤 3：目标配置（宽窗双栏：左配置轨道 · 右迁移凭单；窄窗单列） -->
          <div v-else-if="step === 'target'" class="pane target-pane">
            <div class="target-scroll">
              <div class="target-grid sm-stagger">
                <div class="tc-main" :style="{ '--i': 0 }" :inert="running">
                  <TargetConfig
                    v-model:selected="dstTool"
                    v-model:root="dstRoot"
                    v-model:target-cwd="targetCwd"
                    v-model:flatten="flatten"
                    v-model:keep-synthetic="keepSynthetic"
                    :tools="tools"
                    :root-placeholder="dstToolDefaultRoot"
                    :source-cwd="selected?.cwd"
                    :show-flatten="showFlatten"
                    :show-keep-synthetic="true"
                    :loading="tools.length === 0 && !loadError"
                    @browse-root="browseRoot"
                    @browse-cwd="browseCwd"
                  />
                </div>

                <!-- 迁移凭单：票根质感（打孔线 + 条码），需要与配置区整体分隔 -->
                <aside class="ticket" :style="{ '--i': 1 }">
                  <header class="tk-head">
                    <span class="sm-tag">迁移凭单 · MANIFEST</span>
                    <span class="tk-serial sm-mono">{{ ticketSerial }}</span>
                  </header>
                  <div class="tk-perf" aria-hidden="true">
                    <i class="tk-notch tk-notch--l" /><i class="tk-notch tk-notch--r" />
                  </div>

                  <div v-if="!running" class="tk-body">
                    <div class="confirm-flow">
                      <span class="cf-tool">
                        <i class="sm-tag">源</i>
                        {{ srcToolInfo?.label ?? srcTool }}
                      </span>
                      <svg class="cf-arrow" viewBox="0 0 40 10" aria-hidden="true">
                        <path d="M0 5h34" /><path d="M30 1l5 4-5 4" />
                      </svg>
                      <span class="cf-tool cf-tool--dst">
                        <i class="sm-tag">目标</i>
                        {{ dstToolInfo?.label ?? '—' }}
                      </span>
                    </div>
                    <dl class="confirm-rows">
                      <div class="cr">
                        <dt>会话</dt>
                        <dd class="sm-mono">{{ selected?.title || selected?.sessionId }}</dd>
                      </div>
                      <div class="cr">
                        <dt>写入</dt>
                        <dd class="sm-mono">{{ dstRoot.trim() || dstToolDefaultRoot }}</dd>
                      </div>
                      <div class="cr">
                        <dt>cwd</dt>
                        <dd class="sm-mono">{{ targetCwd.trim() || selected?.cwd || '（沿用源 cwd）' }}</dd>
                      </div>
                      <div v-if="dstTool" class="cr">
                        <dt>目标库</dt>
                        <dd v-if="dstScan.loading" class="tk-scan-live">
                          <span class="sm-flow tk-scan-flow" aria-label="正在读取目标存储" />
                        </dd>
                        <dd v-else-if="dstScan.error" class="tk-scan-err" :title="dstScan.error">
                          无法读取该位置 · 不影响写入
                        </dd>
                        <dd v-else-if="dstScan.count !== null">
                          <b class="sm-mono tk-scan-n">{{ dstScan.count }}</b> 个会话<template v-if="dstScan.latest"> · 最近 {{ fmtAgo(dstScan.latest) }}</template>
                        </dd>
                        <dd v-else>—</dd>
                      </div>
                      <div v-if="showFlatten || keepSynthetic" class="cr">
                        <dt>选项</dt>
                        <dd>
                          <template v-if="showFlatten">旁链：{{ flatten ? '展平' : '保留原生' }}</template>
                          <template v-if="showFlatten && keepSynthetic"> · </template>
                          <template v-if="keepSynthetic">保留运行时上下文</template>
                        </dd>
                      </div>
                    </dl>
                    <p v-if="!dstRoot.trim()" class="confirm-warn">
                      ※ 未指定自定义目录，将写入目标工具的默认真实存储位置（新会话，不覆盖已有数据）。
                    </p>
                  </div>

                  <!-- 迁移中：凭单进入「打印」状态 — 骨架 + 流动条 + 计时，绝不静止卡住 -->
                  <div v-else class="tk-run" aria-live="polite">
                    <div class="sm-flow" />
                    <div class="tk-run-sk" aria-hidden="true">
                      <span class="sm-sk" style="width: 74%" />
                      <span class="sm-sk" style="width: 90%" />
                      <span class="sm-sk" style="width: 42%" />
                    </div>
                    <p class="tk-run-hint">
                      正在写入 {{ dstToolInfo?.label ?? '目标' }} 存储<span class="sm-mono tk-run-sec">· {{ runElapsed }}s</span>
                    </p>
                  </div>

                  <footer class="tk-foot" aria-hidden="true">
                    <span class="tk-bar" />
                    <span class="tk-foot-serial sm-mono">{{ ticketSerial }}</span>
                  </footer>
                </aside>

                <div v-if="showFlatten && dstTool && srcTool && dstTool !== srcTool" class="side-note" :style="{ '--i': 2 }">
                  <span class="sn-mark" aria-hidden="true">※</span>
                  <span>
                    检测到{{ SIDECHAIN_TOOL_NAMES[srcTool] ? ` ${SIDECHAIN_TOOL_NAMES[srcTool]}` : '' }}旁链语义。
                    {{ dstTool === 'opencode' || dstTool === 'zcode'
                      ? '默认展平为顶层消息（可直接续聊）；关闭则压回目标工具的隐藏任务 / 子会话形态。'
                      : '默认按目标工具的原生旁链形态保留；开启则展平为顶层消息。' }}
                  </span>
                </div>
              </div>

              <div v-if="runError" class="pane-error">{{ runError }}</div>
            </div>

            <footer class="pane-foot">
              <button class="sm-btn sm-btn--ghost" type="button" :disabled="running" @click="backSessions">
                ← 上一步
              </button>
              <button
                class="sm-btn sm-btn--primary run-btn"
                type="button"
                :disabled="!dstTool || running"
                @click="runMigrate"
              >
                <span v-if="running" class="sm-spin" />
                {{ running ? '正在迁移…' : '开始迁移' }}
              </button>
            </footer>
          </div>

          <!-- 步骤 4：完成 -->
          <div v-else class="pane pane--center">
            <div class="result">
              <svg class="rv-check" viewBox="0 0 52 52" aria-hidden="true">
                <circle cx="26" cy="26" r="24" />
                <path d="M15 27l8 8 15-17" />
              </svg>
              <h2 class="rv-title">迁移完成</h2>
              <p class="rv-sub">
                新会话 <code class="sm-mono rv-id">{{ result?.tool }}:{{ result?.sessionId }}</code>
                已可在目标工具中 resume 继续对话。
              </p>
              <ul class="rv-paths sm-stagger">
                <li v-for="(p, i) in result?.paths ?? []" :key="p" class="rv-path" :style="{ '--i': i }">
                  <code class="sm-mono rv-path-text">{{ p }}</code>
                  <button class="sm-btn sm-btn--ghost" type="button" @click="openResultPath(p)">打开位置</button>
                </li>
              </ul>
            </div>
            <div class="rv-actions">
              <button class="sm-btn sm-btn--primary" type="button" @click="resetAll">再迁移一个</button>
            </div>
          </div>
        </div>
      </Transition>
    </main>
  </div>
</template>

<style scoped>
.wizard {
  display: grid;
  grid-template-columns: 232px 1fr;
  height: 100%;
  min-height: 0;
}

/* ── 进度轨 ───────────────────────────────────────────────── */
.wz-rail {
  display: flex;
  flex-direction: column;
  gap: 36px;
  padding: 22px 18px 18px 22px;
  border-right: 1px solid var(--line-0);
  background: linear-gradient(180deg, rgba(118, 99, 224, 0.05), transparent 32%), #fbfaff;
  user-select: none;
}
.brand {
  display: flex;
  align-items: center;
  gap: 11px;
}
.seal {
  flex: none;
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  background: var(--acc-0);
  color: #ffffff;
  font: 700 19px/1 var(--serif);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.3), 0 2px 10px rgba(118, 99, 224, 0.35);
}
.brand-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.brand-text b {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-0);
  letter-spacing: 0.03em;
}
.brand-text i {
  font-style: normal;
  font-size: 11px;
  color: var(--fg-2);
}

.rail-steps {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.rail-step {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 0 0 26px 0;
  cursor: default;
}
.rail-step.is-clickable {
  cursor: pointer;
}
.rail-step.is-clickable:hover .rs-label {
  color: var(--fg-0);
}
.rs-node {
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 1px solid var(--line-1);
  display: grid;
  place-items: center;
  font-size: 10px;
  color: var(--fg-2);
  background: var(--ink-2);
  transition:
    border-color var(--t-med) ease,
    color var(--t-med) ease,
    background var(--t-med) ease,
    box-shadow var(--t-med) ease;
}
.rs-check {
  width: 11px;
  height: 11px;
}
.rs-check path {
  fill: none;
  stroke: var(--ok);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 20;
  stroke-dashoffset: 20;
  animation: rs-draw 0.35s var(--ease-out) forwards;
}
@keyframes rs-draw {
  to {
    stroke-dashoffset: 0;
  }
}
.rs-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-top: 3px;
  min-width: 0;
}
.rs-label {
  font-size: 13px;
  color: var(--fg-1);
  letter-spacing: 0.02em;
  transition: color var(--t-med) ease;
}
.rs-en {
  font-size: 9.5px;
}
.rs-line {
  position: absolute;
  left: 13px;
  top: 28px;
  bottom: 2px;
  width: 1px;
  background: var(--line-0);
  overflow: hidden;
}
.rs-line::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, var(--ok), rgba(47, 158, 99, 0.35));
  transform: scaleY(0);
  transform-origin: top;
  transition: transform var(--t-slow) var(--ease-out);
}
.rail-step.is-done .rs-line::after {
  transform: scaleY(1);
}
.rail-step:last-child .rs-line {
  display: none;
}

.rail-step.is-current .rs-node {
  border-color: var(--acc-0);
  color: var(--acc-0);
  box-shadow: 0 0 0 3px var(--acc-soft);
}
.rail-step.is-current .rs-label {
  color: var(--fg-0);
  font-weight: 600;
}
.rail-step.is-done .rs-node {
  border-color: rgba(47, 158, 99, 0.45);
  background: rgba(47, 158, 99, 0.08);
}

.rail-foot {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--fg-2);
  letter-spacing: 0.02em;
}
.rf-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 6px rgba(47, 158, 99, 0.5);
}

/* ── 舞台 ─────────────────────────────────────────────────── */
.wz-stage {
  min-width: 0;
  min-height: 0;
  display: flex;
}
.wz-pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
}
.pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 24px 26px 20px;
  position: relative;
}
.pane--center {
  justify-content: center;
}
.pane--fill {
  min-height: 0;
}

/* 步骤切换动效 */
.wz-fwd-enter-active,
.wz-back-enter-active {
  transition: opacity var(--t-med) var(--ease-out), transform var(--t-med) var(--ease-out);
}
.wz-fwd-leave-active,
.wz-back-leave-active {
  transition: opacity 110ms ease, transform 110ms ease;
}
.wz-fwd-enter-from {
  opacity: 0;
  transform: translateX(22px);
}
.wz-fwd-leave-to {
  opacity: 0;
  transform: translateX(-14px);
}
.wz-back-enter-from {
  opacity: 0;
  transform: translateX(-22px);
}
.wz-back-leave-to {
  opacity: 0;
  transform: translateX(14px);
}

/* 会话步骤布局 */
.root-bar {
  display: flex;
  gap: 8px;
  align-items: center;
}
.root-tag {
  flex: none;
  padding-right: 4px;
}
.root-bar .sm-input {
  flex: 1;
  min-width: 0;
}
.split {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
}
.split-left {
  flex: none;
  min-height: 0;
  min-width: 0;
}
.split-divider {
  flex: none;
  width: 5px;
  margin: 0 3px;
  border-radius: 3px;
  cursor: col-resize;
  transition: background var(--t-fast) ease;
}
.split-divider:hover,
body.sv-resizing .split-divider {
  background: var(--acc-soft);
}
.split-right {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0 2px 0 12px;
}

/* ── 目标步骤：宽窗双栏（左配置轨道 · 右凭单），窄窗单列 ───── */
.target-pane {
  gap: 10px;
}
.target-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}
.target-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 6px 40px;
  padding: 2px 0 8px;
}
.tc-main {
  min-width: 0;
}
.side-note {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: var(--fg-1);
  line-height: 1.7;
  padding: 2px 2px 0;
}
.sn-mark {
  flex: none;
  color: var(--warn);
}

@media (min-width: 1100px) {
  .target-grid {
    grid-template-columns: minmax(0, 1fr) 336px;
  }
  .tc-main {
    grid-column: 1;
    grid-row: 1;
  }
  .ticket {
    grid-column: 2;
    grid-row: 1;
    position: sticky;
    top: 2px;
  }
  .side-note {
    grid-column: 1;
  }
}

/* 迁移凭单：票根质感（打孔线 + 条码），替代通用计划卡片 */
.ticket {
  position: relative;
  display: flex;
  flex-direction: column;
  max-width: 420px;
  background: var(--ink-0);
  border: 1px solid var(--line-1);
  border-radius: 12px;
  padding: 13px 16px 12px;
}
.tk-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
.tk-serial {
  font-size: 10.5px;
  color: var(--fg-1);
  letter-spacing: 0.08em;
}
.tk-perf {
  position: relative;
  margin: 12px -16px;
  border-top: 1px dashed var(--line-1);
}
.tk-notch {
  position: absolute;
  top: -6px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #ffffff;
  border: 1px solid var(--line-1);
}
.tk-notch--l {
  left: -6px;
}
.tk-notch--r {
  right: -6px;
}
.tk-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 2px;
}
.tk-run {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 6px 0 2px;
}
.tk-run-sk {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.tk-run-sk .sm-sk {
  display: block;
  height: 11px;
  border-radius: 5px;
}
.tk-run-hint {
  margin: 0;
  font-size: 12px;
  color: var(--fg-1);
  line-height: 1.6;
}
.tk-run-sec {
  margin-left: 6px;
  color: var(--fg-2);
  font-size: 11px;
}
.tk-foot {
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px dashed var(--line-1);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
}
.tk-bar {
  width: 82%;
  height: 20px;
  opacity: 0.62;
  background: repeating-linear-gradient(
    90deg,
    var(--fg-0) 0 1px,
    transparent 1px 4px,
    var(--fg-0) 4px 5px,
    transparent 5px 7px,
    var(--fg-0) 7px 10px,
    transparent 10px 12px,
    var(--fg-0) 12px 13px,
    transparent 13px 17px
  );
}
.tk-foot-serial {
  font-size: 9px;
  letter-spacing: 0.34em;
  color: var(--fg-2);
}
.tk-scan-live {
  display: flex;
}
.tk-scan-flow {
  width: 120px;
  margin-top: 7px;
}
.tk-scan-err {
  color: var(--fg-2);
}
.tk-scan-n {
  color: var(--acc-ink);
  font-weight: 600;
}

.confirm-flow {
  display: flex;
  align-items: center;
  gap: 12px;
}
.cf-tool {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--fg-0);
}
.cf-tool i {
  font-style: normal;
}
.cf-tool--dst {
  color: var(--acc-ink);
}
.cf-arrow {
  width: 40px;
  height: 10px;
  flex: none;
}
.cf-arrow path {
  fill: none;
  stroke: var(--fg-2);
  stroke-width: 1.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.confirm-rows {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.cr {
  display: flex;
  gap: 14px;
  align-items: baseline;
}
.cr dt {
  flex: none;
  width: 42px;
  font-size: 12px;
  color: var(--fg-2);
}
.cr dd {
  margin: 0;
  font-size: 12px;
  color: var(--fg-1);
  word-break: break-all;
  line-height: 1.6;
}
.confirm-warn {
  margin: 0;
  font-size: 12px;
  color: var(--warn);
  line-height: 1.7;
}

/* 结果（无卡片，仪式感靠对勾动效本身） */
.result {
  max-width: 640px;
  width: 100%;
  padding: 12px 4px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}
.rv-check {
  width: 52px;
  height: 52px;
}
.rv-check circle {
  fill: none;
  stroke: var(--ok);
  stroke-width: 1.5;
  stroke-dasharray: 151;
  stroke-dashoffset: 151;
  animation: rv-draw 0.7s var(--ease-out) 0.1s forwards;
}
.rv-check path {
  fill: none;
  stroke: var(--ok);
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 36;
  stroke-dashoffset: 36;
  animation: rv-draw 0.4s var(--ease-out) 0.65s forwards;
}
@keyframes rv-draw {
  to {
    stroke-dashoffset: 0;
  }
}
.rv-title {
  margin: 6px 0 0;
  font: 600 22px/1.4 var(--sans);
  letter-spacing: 0.02em;
  color: var(--fg-0);
}
.rv-sub {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--fg-1);
  line-height: 1.7;
}
.rv-id {
  color: var(--acc-ink);
  font-size: 12px;
}
.rv-paths {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rv-path {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  background: var(--code-0);
  border: 1px solid var(--line-0);
  border-radius: 7px;
  padding: 8px 12px;
}
.rv-path-text {
  font-size: 11px;
  color: var(--fg-1);
  word-break: break-all;
  min-width: 0;
}
.rv-actions {
  margin-top: 16px;
}

/* 页脚操作 */
.pane-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 4px;
}
.foot-info {
  font-size: 12px;
  color: var(--fg-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
/* 会话步骤：右下角悬浮的下一步按钮（浮在预览内容区上方，不占行） */
.next-fab {
  position: absolute;
  right: 22px;
  bottom: 14px;
  z-index: 6;
  border-radius: 999px;
  padding: 9px 18px;
  box-shadow:
    0 6px 18px rgba(118, 99, 224, 0.35),
    0 2px 6px rgba(38, 32, 66, 0.2);
}
.run-btn {
  min-width: 132px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

/* 错误条 */
.pane-error {
  font-size: 12.5px;
  color: var(--err);
  background: rgba(201, 54, 78, 0.06);
  border: 1px solid rgba(201, 54, 78, 0.35);
  border-radius: 8px;
  padding: 10px 14px;
  line-height: 1.6;
  word-break: break-all;
}
</style>
