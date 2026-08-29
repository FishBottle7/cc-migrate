<script setup lang="ts">
/**
 * TranscriptFlow — 会话流的递归渲染器（DSH 视觉语法）。
 *
 * 顶层渲染主会话 FlowItem；遇到 subagent 项渲染「子代理」披露行，
 * 展开体内用自身递归渲染旁链的内部会话流（左缘竖线标示嵌套层级）。
 * 用户右对齐气泡、助手 markdown 流、思考/工具为 24px 披露行。
 */
import type { FlowItem } from './flow.js';
import { firstLine, fmtFull, toolIcon, toolSummary, toolTitle } from './flow.js';

withDefaults(
  defineProps<{
    items: FlowItem[];
    /** 嵌套模式（子代理内部）：左缘竖线 + 更紧的间距 */
    nested?: boolean;
  }>(),
  { nested: false },
);
</script>

<template>
  <div class="tf" :class="{ 'tf--nested': nested }">
    <template v-for="it in items" :key="it.key">
      <!-- 用户：右对齐气泡（DSH User_Bubble） -->
      <div v-if="it.kind === 'user'" class="user-row" :title="fmtFull(it.ts)">
        <div class="bubble">{{ it.text }}</div>
      </div>

      <!-- 助手正文：markdown 流，无外框 -->
      <div v-else-if="it.kind === 'md'" class="md-body" :title="fmtFull(it.ts)" v-html="it.html" />

      <!-- 思考：披露行 -->
      <details v-else-if="it.kind === 'think'" class="drow" :title="fmtFull(it.ts)">
        <summary>
          <svg class="chev" viewBox="0 0 8 8" aria-hidden="true"><path d="M2 1l4 3-4 3" /></svg>
          <span class="row-icon" aria-hidden="true">
            <svg viewBox="0 0 14 14"><path d="M7 1.5v11M2.5 4.2l9 5.6M11.5 4.2l-9 5.6" /></svg>
          </span>
          <span class="row-title">已思考</span>
          <span class="row-sep" aria-hidden="true" />
          <span class="row-sum">{{ firstLine(it.text) }}</span>
        </summary>
        <div class="think-body">{{ it.text }}</div>
      </details>

      <!-- 工具调用：披露行 + IN/OUT 卡 -->
      <details v-else-if="it.kind === 'tool'" class="drow tool-row" :class="{ 'is-err': it.isError }" :title="fmtFull(it.ts)">
        <summary>
          <svg class="chev" viewBox="0 0 8 8" aria-hidden="true"><path d="M2 1l4 3-4 3" /></svg>
          <span class="row-icon" aria-hidden="true">
            <svg v-if="toolIcon(it.name) === 'terminal'" viewBox="0 0 14 14"><path d="M1.5 2.5h11v9h-11z" /><path d="M4 6l2.2 1.7L4 9.4M7.5 9.7h3" /></svg>
            <svg v-else-if="toolIcon(it.name) === 'doc'" viewBox="0 0 14 14"><path d="M3.5 1.5h5l2 2v9h-7z" /><path d="M5.5 7h3M5.5 9.5h3" /></svg>
            <svg v-else-if="toolIcon(it.name) === 'search'" viewBox="0 0 14 14"><circle cx="6" cy="6" r="3.6" /><path d="M8.8 8.8L12 12" /></svg>
            <svg v-else viewBox="0 0 14 14"><rect x="2.5" y="2.5" width="9" height="9" rx="1.5" /><path d="M2.5 5.5h9" /></svg>
          </span>
          <span class="row-title">{{ it.name === 'result' ? '工具结果' : toolTitle(it.name) }}</span>
          <span class="row-sep" aria-hidden="true" />
          <span v-if="it.isError" class="row-sum is-err">{{ firstLine(it.output ?? '执行失败') }}</span>
          <span v-else class="row-sum">{{ toolSummary(it.input) || firstLine(it.output ?? '') }}</span>
        </summary>
        <div v-if="it.input !== null || it.output !== null" class="io-card">
          <div v-if="it.input !== null" class="io-section">
            <span class="io-label">输入</span>
            <span class="io-text sm-mono">{{ it.input }}<template v-if="it.inputTruncated">
…已截断</template></span>
          </div>
          <div v-if="it.input !== null && it.output !== null" class="io-divider" aria-hidden="true" />
          <div v-if="it.output !== null" class="io-section">
            <span class="io-label" :class="{ 'is-err': it.isError }">输出</span>
            <span class="io-text sm-mono" :class="{ 'is-err': it.isError }">{{ it.output }}<template v-if="it.outputTruncated">
…已截断</template></span>
          </div>
        </div>
      </details>

      <!-- 注入上下文：暗淡披露行 -->
      <details v-else-if="it.kind === 'inject'" class="drow inject-row" :title="fmtFull(it.ts)">
        <summary>
          <svg class="chev" viewBox="0 0 8 8" aria-hidden="true"><path d="M2 1l4 3-4 3" /></svg>
          <span class="row-icon" aria-hidden="true">
            <svg viewBox="0 0 14 14"><path d="M7 2v6.5M4.5 6L7 8.5 9.5 6" /><path d="M3 11.5h8" /></svg>
          </span>
          <span class="row-title">注入上下文</span>
          <span class="row-sep" aria-hidden="true" />
          <span class="row-sum">{{ firstLine(it.text) }}</span>
        </summary>
        <div class="think-body">{{ it.text }}</div>
      </details>

      <!-- 子代理旁链：披露行 + 递归嵌套会话流 -->
      <details v-else class="drow subagent-row">
        <summary>
          <svg class="chev" viewBox="0 0 8 8" aria-hidden="true"><path d="M2 1l4 3-4 3" /></svg>
          <span class="row-icon" aria-hidden="true">
            <svg viewBox="0 0 14 14"><rect x="1.5" y="1.5" width="5" height="5" rx="1" /><rect x="7.5" y="7.5" width="5" height="5" rx="1" /><path d="M6.5 4h2.5a1 1 0 011 1v2.5" /></svg>
          </span>
          <span class="row-title">子代理</span>
          <span class="row-sep" aria-hidden="true" />
          <span class="row-sum">
            {{ it.agentType ?? it.agentId }} · {{ it.items.length }} 条消息<template v-if="it.truncated">（已截断）</template>
          </span>
        </summary>
        <div class="sc-body">
          <TranscriptFlow :items="it.items" nested />
          <p v-if="it.truncated" class="sc-note">子代理消息过长，仅投影前 {{ it.items.length }} 条（迁移本身无损）</p>
        </div>
      </details>
    </template>
  </div>
</template>

<style scoped>
.tf {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.tf--nested {
  gap: 8px;
}

/* 用户气泡：右对齐（DSH User_Bubble：r22、10/16 padding、82%/525px 封顶） */
.user-row {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  min-width: 0;
}
.bubble {
  max-width: min(82%, 525px);
  background: var(--ink-3);
  border-radius: 22px;
  padding: 10px 16px;
  font-size: 13.5px;
  line-height: 22px;
  color: var(--fg-0);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* 助手 markdown：无外框纯流 */
.md-body {
  font-size: 13.5px;
  line-height: 22px;
  color: var(--fg-0);
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.md-body :deep(p) {
  margin: 0 0 8px;
}
.md-body :deep(p:last-child) {
  margin-bottom: 0;
}
.md-body :deep(h1),
.md-body :deep(h2),
.md-body :deep(h3),
.md-body :deep(h4) {
  margin: 14px 0 6px;
  font-size: 14px;
  font-weight: 600;
  line-height: 22px;
}
.md-body :deep(h1:first-child),
.md-body :deep(h2:first-child),
.md-body :deep(h3:first-child) {
  margin-top: 0;
}
.md-body :deep(ul),
.md-body :deep(ol) {
  margin: 0 0 8px;
  padding-left: 22px;
}
.md-body :deep(li) {
  margin: 2px 0;
}
.md-body :deep(code) {
  font-family: var(--mono);
  font-size: 12px;
  background: #f2effa;
  border: 1px solid rgba(38, 32, 66, 0.08);
  border-radius: 4px;
  padding: 1px 5px;
  color: #4c4570;
}
.md-body :deep(pre) {
  margin: 8px 0;
  padding: 10px 12px;
  background: var(--code-0);
  border: 1px solid var(--line-0);
  border-radius: 8px;
  overflow-x: auto;
  max-width: 100%;
  box-sizing: border-box;
}
.md-body :deep(pre code) {
  background: none;
  border: none;
  padding: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--fg-0);
}
.md-body :deep(blockquote) {
  margin: 8px 0;
  padding: 2px 0 2px 12px;
  border-left: 2px solid var(--line-1);
  color: var(--fg-1);
}
.md-body :deep(a) {
  color: var(--acc-ink);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.md-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--line-0);
  margin: 12px 0;
}
.md-body :deep(.pv-attach) {
  color: var(--fg-1);
  font-family: var(--mono);
  font-size: 12px;
}

/* ── 披露行（DSH ToolRow / ReasoningRow：24px 单行）────────── */
.drow {
  min-width: 0;
}
.drow summary {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 24px;
  padding: 2px 6px;
  margin: 0 -6px;
  border-radius: 6px;
  cursor: pointer;
  list-style: none;
  user-select: none;
  transition: background var(--t-fast) ease;
}
.drow summary::-webkit-details-marker {
  display: none;
}
.drow summary:hover {
  background: var(--ink-2);
}
.chev {
  flex: none;
  width: 8px;
  height: 8px;
  color: var(--fg-2);
  transition: transform var(--t-fast) var(--ease-out);
}
.chev path {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.drow[open] > summary .chev {
  transform: rotate(90deg);
}
.row-icon {
  flex: none;
  display: inline-flex;
  width: 14px;
  height: 14px;
  color: var(--fg-1);
}
.row-icon svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.row-title {
  flex: none;
  font-size: 13px;
  line-height: 20px;
  color: var(--fg-0);
}
.row-sep {
  flex: none;
  width: 2px;
  height: 2px;
  border-radius: 1px;
  margin: 0 6px;
  background: var(--fg-2);
  opacity: 0.7;
}
.row-sum {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 20px;
  color: var(--fg-2);
}
.row-sum.is-err {
  color: var(--err);
}
.tool-row.is-err .row-icon {
  color: var(--err);
}

/* 思考 / 注入的展开体（DSH：缩进 22 + 次级字号 + 三级色） */
.think-body {
  margin: 4px 0 4px 22px;
  font-size: 13px;
  line-height: 20px;
  color: var(--fg-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* IN/OUT 卡（DSH ioCard：r12、近贴左缘、code-block 面、粘性槽位标签、独立滚动） */
.io-card {
  display: flex;
  flex-direction: column;
  margin: 4px 0 4px 4px;
  border: 1px solid var(--line-0);
  border-radius: 12px;
  background: var(--code-0);
  overflow: hidden;
}
.io-section {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  column-gap: 14px;
  align-items: baseline;
  padding: 12px 16px;
  max-height: 150px;
  overflow-y: auto;
}
.io-label {
  position: sticky;
  top: 0;
  align-self: start;
  font-size: 10.5px;
  letter-spacing: 0.1em;
  color: var(--fg-2);
}
.io-label.is-err {
  color: var(--err);
}
.io-divider {
  flex: none;
  height: 1px;
  background: var(--line-0);
}
.io-text {
  min-width: 0;
  font-size: 11.5px;
  line-height: 17px;
  color: var(--fg-1);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.io-text.is-err {
  color: var(--err);
}

/* 子代理：嵌套会话流带左缘竖线，标示这是另一个会话的内部视角 */
.sc-body {
  margin: 4px 0 4px 10px;
  padding-left: 12px;
  border-left: 2px solid var(--line-1);
  min-width: 0;
}
.sc-note {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--fg-2);
}
</style>
