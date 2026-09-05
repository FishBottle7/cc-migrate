/**
 * cc-migrate client 半 — 富预览流（对齐独立程序 SessionPreview 的侧栏版）。
 *
 * 语义移植自 @cc-migrate/ui 的 Vue 实现（MIT，本仓库自有代码）：
 *  - flow.ts `computeFlow` —— tool_use/tool_result 按 callId 融合成一行、
 *    user+synthetic/injectionKind 归为注入行、思考块成披露行、system/
 *    developer 合并为注入（算法逐行同语义，见各分支注）。
 *  - SessionPreview.vue 的旁链交互（v0.3.1 起与桌面版同构）——头部
 *    「子代理 · N」切换按钮 → 树形菜单（顶部主会话节点 + 树枝下子代理
 *    节点，各带消息数），点击节点【整区切换】该旁链的完整消息流（不是
 *    内联展开——真机反馈否掉了 v0.3.0 的卡下内联挂载）；菜单里可定位的
 *    节点带「定位召唤处」准星，点击跳回主会话流中它的 tool_use 卡并闪烁
 *    高亮（召唤点 = parentCallId，缺失时退化到桌面版同款文本匹配：
 *    tool_result 内容含 "started subagent <agentId>" 即视为召唤点）。
 *  - 懒渲染 —— desktop 的 renderCount PAGE 分页语义（侧栏 PAGE=30），
 *    只作用于主会话流；旁链整区视图整流渲染（desktop 同款）。「显示更多」
 *    手动翻页，消息级虚拟化不做（DTO 层已有 10k/块截断）。
 * 刻意不移植 / 侧栏化调整：
 *  - markdown-it 渲染（零依赖纪律）——正文按纯文本 pre-wrap。
 *  - PeakScrollbar 山峰定位条、毛玻璃菜单 —— 依赖 DOM 测量与宿主视觉
 *    体系，侧栏收益低；菜单改为窄栏定宽 + borderLeft 树干示意。
 *  - 召唤点闪烁的 CSS 动画内联样式写不了 keyframes —— 组件树里渲染一个
 *    <style> 元素注入（仍零依赖，cm- 前缀防冲突）。
 */

import { createElement, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { PreviewBlockDto, PreviewMessageDto, PreviewPayload, PreviewSidechainDto } from '../commands.js';
import { T } from './theme.js';

/* ── flow 模型（flow.ts FlowItem 的 React 同语义移植） ─────────────────── */

export type FlowItem =
  | { kind: 'user'; key: string; ts?: number; text: string }
  | { kind: 'text'; key: string; ts?: number; text: string; truncated?: boolean }
  | { kind: 'think'; key: string; ts?: number; text: string; truncated?: boolean }
  | { kind: 'inject'; key: string; ts?: number; text: string; injKind?: string }
  | { kind: 'file'; key: string; ts?: number; label: string }
  | {
      kind: 'tool'; key: string; ts?: number;
      name: string; callId?: string;
      input: string | null; inputTruncated?: boolean;
      output: string | null; outputTruncated?: boolean; isError: boolean;
    };

export function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  return nl === -1 ? text : text.slice(0, nl);
}

/** 工具名 → 中性短标题（flow.ts TOOL_TITLES 的子集：侧栏行内宽度只放得下短词）。 */
const TOOL_TITLES: Record<string, string> = {
  Bash: '运行命令', Read: '读取文件', Write: '写入文件', Edit: '编辑文件',
  MultiEdit: '编辑文件', Grep: '搜索内容', Glob: '查找文件',
  WebSearch: '搜索网页', WebFetch: '抓取网页', Task: '派发子代理',
  TodoWrite: '更新待办', NotebookEdit: '编辑 Notebook', Skill: '调用技能',
  spawn_agent: '派发子代理', send_message: '发消息给子代理', wait: '等待子代理',
};

export function toolTitle(name: string): string {
  return TOOL_TITLES[name] ?? name;
}

/** input JSON 挑最有信息量的字段做单行摘要（flow.ts toolSummary 同语义）。 */
export function toolSummary(inputJson: string | null): string {
  if (!inputJson) return '';
  try {
    const o = JSON.parse(inputJson) as Record<string, unknown>;
    // file_path 是 claude 系工具的路径键（desktop 版只认 filePath——移植时补上）
    const pick = o.command ?? o.filePath ?? o.file_path ?? o.path ?? o.file ?? o.pattern ?? o.query
      ?? o.url ?? o.skill ?? o.description ?? o.prompt ?? o.todo ?? o.subject;
    const s = pick === undefined ? inputJson : typeof pick === 'string' ? pick : JSON.stringify(pick);
    return s.replace(/\s+/g, ' ').trim();
  } catch {
    return inputJson.replace(/\s+/g, ' ').trim();
  }
}

/** PreviewMessageDto[] → FlowItem[]（flow.ts computeFlow 逐行同语义）。 */
export function computeFlow(messages: PreviewMessageDto[], prefix = 'm'): FlowItem[] {
  // 1) 收集全部 tool_result，按 callId 配对（首见优先）
  const resultByCall = new Map<string, PreviewBlockDto>();
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.t === 'tool_result' && b.callId && !resultByCall.has(b.callId)) {
        resultByCall.set(b.callId, b);
      }
    }
  }
  const consumed = new Set<string>();

  const items: FlowItem[] = [];
  messages.forEach((m, mi) => {
    const ts = m.ts;
    if (m.role === 'user') {
      const text = m.blocks.filter((b) => b.t === 'text').map((b) => b.text ?? '').join('');
      const key = `${prefix}u${mi}`;
      // synthetic 之外，IR meta 的 harness 分类（codex contentKind 等）同样按注入渲染
      if (m.synthetic === true || m.injectionKind !== undefined) {
        items.push({ kind: 'inject', key, ts, text: text || '（空）', ...(m.injectionKind !== undefined ? { injKind: m.injectionKind } : {}) });
      } else if (text.trim()) {
        items.push({ kind: 'user', key, ts, text });
      }
      return;
    }
    if (m.role === 'system' || m.role === 'developer') {
      const text = m.blocks.filter((b) => b.t === 'text').map((b) => b.text ?? '').join('');
      if (text.trim()) items.push({ kind: 'inject', key: `${prefix}s${mi}`, ts, text });
      return;
    }
    m.blocks.forEach((b, bi) => {
      const key = `${prefix}m${mi}b${bi}`;
      if (b.t === 'text') {
        if (b.text?.trim()) items.push({ kind: 'text', key, ts, text: b.text, truncated: b.truncated });
      } else if (b.t === 'think') {
        if (b.text?.trim()) items.push({ kind: 'think', key, ts, text: b.text, truncated: b.truncated });
      } else if (b.t === 'tool_use') {
        const result = b.callId ? resultByCall.get(b.callId) : undefined;
        if (b.callId) consumed.add(b.callId);
        items.push({
          kind: 'tool', key, ts,
          name: b.name ?? 'tool', callId: b.callId,
          input: b.text ?? null, inputTruncated: b.truncated,
          output: result?.text ?? null, outputTruncated: result?.truncated,
          isError: result?.isError ?? false,
        });
      } else if (b.t === 'tool_result') {
        if (b.callId && consumed.has(b.callId)) return; // 已融合进调用行
        items.push({
          kind: 'tool', key, ts, name: 'result',
          input: null, output: b.text ?? null, outputTruncated: b.truncated,
          isError: b.isError ?? false,
        });
      } else if (b.t === 'file') {
        items.push({ kind: 'file', key, ts, label: b.name ?? b.mediaType ?? '附件' });
      }
    });
  });
  return items;
}

/**
 * 召唤点退化定位（SessionPreview.vue callByAgent 同语义）：DSH 系旁链可能
 * 没有 parentCallId，但派发它的 tool_result 文本含 agentId（"started
 * subagent <id>"）——文本匹配兜底，保证切换器里的准星尽量可用。
 */
function buildCallByAgent(messages: PreviewMessageDto[], sidechains: PreviewSidechainDto[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const sc of sidechains) {
    if (!sc.agentId) continue;
    for (const m of messages) {
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
}

/* ── 样式（窄栏：块卡 margin 2px、内边距 ≤6px，details 原生折叠） ───────── */

const P = {
  flow: { display: 'flex', flexDirection: 'column', gap: 7 } as CSSProperties,
  userRow: {
    display: 'flex', borderLeft: `2px solid ${T.accent}`, paddingLeft: 8,
  } as CSSProperties,
  userText: {
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12.5, lineHeight: 1.55,
    color: T.fgBright, fontWeight: 500,
  } as CSSProperties,
  text: {
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.55,
    color: T.fgBody,
  } as CSSProperties,
  thinkBody: {
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11.5, lineHeight: 1.5,
    color: T.think, fontStyle: 'italic', padding: '2px 4px 4px 16px',
  } as CSSProperties,
  inject: {
    display: 'flex', gap: 6, alignItems: 'baseline', padding: '1px 0',
    color: T.dimmer, fontSize: 11, fontStyle: 'italic',
  } as CSSProperties,
  injectTag: {
    flexShrink: 0, fontSize: 9.5, fontStyle: 'normal', color: T.think,
    border: `1px solid ${T.line2}`, borderRadius: 4, padding: '0 4px',
  } as CSSProperties,
  card: {
    border: `1px solid ${T.line1}`, borderRadius: 6, background: T.bg1, overflow: 'hidden',
  } as CSSProperties,
  cardTool: { borderColor: T.lineTool },
  cardErr: { borderColor: T.errBorder },
  cardSummary: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '3px 7px', cursor: 'pointer',
    listStyle: 'none', fontSize: 11, color: T.fg3, userSelect: 'none',
  } as CSSProperties,
  cardBody: { padding: '2px 8px 6px', fontSize: 11, lineHeight: 1.5 } as CSSProperties,
  pre: {
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 10.5,
    color: T.pre,
  } as CSSProperties,
  preErr: { color: T.err } as CSSProperties,
  cardLabel: { fontSize: 9.5, color: T.dimmer, margin: '4px 0 1px' } as CSSProperties,
  toolName: { color: T.toolName, flexShrink: 0 } as CSSProperties,
  summary: {
    flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  } as CSSProperties,
  truncBadge: {
    flexShrink: 0, fontSize: 9, color: T.warn, border: `1px solid ${T.warnBorder}`,
    borderRadius: 4, padding: '0 3px',
  } as CSSProperties,
  errBadge: { color: T.err, borderColor: T.errBg } as CSSProperties,
  attach: { fontSize: 11, color: T.dim, fontStyle: 'italic' } as CSSProperties,
  more: {
    alignSelf: 'center', marginTop: 4, padding: '4px 10px', fontSize: 11, color: T.fg3,
    background: T.bg2, border: `1px solid ${T.line2}`, borderRadius: 6, cursor: 'pointer',
  } as CSSProperties,
  chips: { display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6, alignItems: 'center' } as CSSProperties,
  chip: {
    fontSize: 10, color: T.think, border: `1px solid ${T.line1}`, borderRadius: 999,
    padding: '1px 8px', fontVariantNumeric: 'tabular-nums',
  } as CSSProperties,

  /* ── 子代理切换器（SessionPreview.vue sv-sc-btn / sc-menu 的侧栏版）── */
  scWrap: { position: 'relative', flexShrink: 0 } as CSSProperties,
  scBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: '100%',
    appearance: 'none', font: 'inherit', fontSize: 10.5, cursor: 'pointer',
    color: T.business, background: T.bg2, border: `1px solid ${T.businessBorder}`,
    borderRadius: 999, padding: '2px 9px', whiteSpace: 'nowrap',
  } as CSSProperties,
  scBtnSvg: { fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, flexShrink: 0 } as CSSProperties,
  scChev: (open: boolean): CSSProperties => ({
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const,
    flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .12s',
  }),
  scBackdrop: { position: 'fixed', inset: 0, zIndex: 30 } as CSSProperties,
  scMenu: {
    position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 31,
    width: 264, maxWidth: 'calc(100vw - 32px)', maxHeight: 340, overflowY: 'auto',
    padding: 5, borderRadius: 10, background: T.bg1, border: `1px solid ${T.line2}`,
    boxShadow: '0 8px 22px rgba(0,0,0,.35)',
  } as CSSProperties,
  scNode: (current: boolean): CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 7, width: '100%',
    appearance: 'none', border: 'none', background: current ? T.accentBg : 'none',
    padding: '5px 7px', borderRadius: 7, cursor: 'pointer', font: 'inherit',
    textAlign: 'left' as const, color: T.fg2,
  }),
  scNodeIcon: { fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, flexShrink: 0, color: T.fg3 } as CSSProperties,
  scNodeName: {
    flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontSize: 11.5, fontWeight: 500,
  } as CSSProperties,
  scNodeMain: { fontWeight: 600 } as CSSProperties,
  scNodeMeta: { flexShrink: 0, fontSize: 10, color: T.dim, fontVariantNumeric: 'tabular-nums' } as CSSProperties,
  scBranch: { marginLeft: 10, paddingLeft: 11, borderLeft: `1px solid ${T.line1}`, display: 'flex', flexDirection: 'column', gap: 1 } as CSSProperties,
  scJump: {
    flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 20, height: 20, borderRadius: 5, color: T.fg3, cursor: 'pointer',
  } as CSSProperties,
};

/* 召唤点闪烁动画（内联样式写不了 keyframes——<style> 注入，cm- 前缀防冲突） */
const FLASH_STYLE = '@keyframes cm-flash-kf{50%{background-color:rgba(118,99,224,.28)}}'
  + '.cm-flash{animation:cm-flash-kf .8s ease 2;border-radius:6px}';

/* ── 渲染小件 ─────────────────────────────────────────────────────────── */

const fmtChip = (ts?: number): string =>
  ts === undefined ? '—' : new Date(ts).toISOString().slice(0, 16).replace('T', ' ');

/** 属性选择器转义（cssEscape 退化实现——真浏览器走 CSS.escape）。 */
function cssEscape(s: string): string {
  const c = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  return c?.escape ? c.escape(s) : s.replace(/["\\]/g, '\\$&');
}

/** 折叠卡 summary 通用结构（chevron + 前缀 + 摘要 + 可选角标）。 */
function Card({
  kindStyle, prefix, summary, badges, children, open,
}: {
  kindStyle?: CSSProperties;
  prefix: ReactNode;
  summary: string;
  badges?: ReactNode;
  children?: ReactNode;
  open?: boolean;
}): ReactNode {
  return (
    <details open={open} style={{ ...P.card, ...kindStyle }}>
      <summary style={P.cardSummary}>
        <span style={{ ...P.toolName }}>{prefix}</span>
        <span style={P.summary}>{summary}</span>
        {badges}
      </summary>
      {children}
    </details>
  );
}

/* ── 流渲染（items → 视图；主会话流与旁链整区流共用） ───────────────────── */

function FlowItems({ items, compact }: { items: FlowItem[]; compact?: boolean }): ReactNode {
  return (
    <div style={P.flow}>
      {items.map((it) => {
        switch (it.kind) {
          case 'user':
            return (
              <div key={it.key} style={P.userRow} title={fmtChip(it.ts)}>
                <div style={P.userText}>{it.text}</div>
              </div>
            );
          case 'text':
            return (
              <div key={it.key} title={fmtChip(it.ts)}>
                <div style={P.text}>{it.text}</div>
                {it.truncated === true ? <TruncBadge /> : null}
              </div>
            );
          case 'think':
            return (
              <details key={it.key} style={{ ...P.card, background: 'transparent' }} title={fmtChip(it.ts)}>
                <summary style={P.cardSummary}>
                  <span style={P.toolName}>已思考</span>
                  <span style={{ ...P.summary, fontStyle: 'italic' }}>{firstLine(it.text)}</span>
                  {it.truncated === true ? <TruncBadge /> : null}
                </summary>
                <div style={P.thinkBody}>{it.text}</div>
              </details>
            );
          case 'inject':
            return (
              <div key={it.key} style={P.inject} title={fmtChip(it.ts)}>
                <span style={P.injectTag}>{it.injKind ?? '注入'}</span>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {firstLine(it.text)}
                </span>
              </div>
            );
          case 'file':
            return <div key={it.key} style={P.attach}>附件 · {it.label}</div>;
          case 'tool': {
            const title = it.name === 'result' ? '工具结果' : toolTitle(it.name);
            const summary = toolSummary(it.input) || (it.output !== null ? firstLine(it.output) : '');
            return (
              // data-call：子代理菜单「定位召唤处」的滚动锚点（desktop data-call 同语义）
              <div key={it.key} data-call={it.callId}>
                <Card
                  kindStyle={it.isError ? P.cardErr : P.cardTool}
                  prefix={title}
                  summary={summary.slice(0, 120) || '（无参数）'}
                  badges={it.isError ? <span style={{ ...P.truncBadge, ...P.errBadge }}>错误</span> : undefined}
                  open={compact && it.isError}
                >
                  <div style={P.cardBody}>
                    {it.input !== null ? (
                      <>
                        <div style={P.cardLabel}>输入{it.inputTruncated === true ? '（已截断）' : ''}</div>
                        <pre style={P.pre}>{it.input}</pre>
                      </>
                    ) : null}
                    {it.output !== null ? (
                      <>
                        <div style={P.cardLabel}>输出{it.outputTruncated === true ? '（已截断）' : ''}</div>
                        <pre style={{ ...P.pre, ...(it.isError ? P.preErr : {}) }}>{it.output}</pre>
                      </>
                    ) : null}
                  </div>
                </Card>
              </div>
            );
          }
          default:
            return null;
        }
      })}
    </div>
  );
}

function TruncBadge(): ReactNode {
  return <span style={{ ...P.truncBadge, marginTop: 2, display: 'inline-block' }} title="源内容超过 10k/块投影上限，导入后完整可见">已截断</span>;
}

/* ── 子代理切换器菜单（SessionPreview.vue sc-menu 的受控移植） ───────────── */

/**
 * 树形菜单：顶部主会话节点（点击回主会话）+ 树枝下子代理节点（点击整区
 * 切换）；主会话视图里可定位的旁链节点额外带「定位召唤处」准星。受控
 * 组件——开关状态在 PreviewFlowView，无头冒烟可直接渲染本组件断言树结构。
 */
export function SidechainMenu({
  payload, sidechains, currentIndex, onBack, onOpen, summonOf, onJump,
}: {
  payload: PreviewPayload;
  sidechains: PreviewSidechainDto[];
  /** 当前整区视图的旁链下标（main 视图为 -1）。 */
  currentIndex: number;
  onBack: () => void;
  onOpen: (i: number) => void;
  /** i → 召唤点 callId（不可定位为 undefined——准星不渲染）。 */
  summonOf: (i: number) => string | undefined;
  onJump: (i: number) => void;
}): ReactNode {
  return (
    <div role="menu">
      <button type="button" role="menuitem" style={P.scNode(currentIndex === -1)} onClick={onBack}>
        <svg width={13} height={13} viewBox="0 0 14 14" aria-hidden style={P.scNodeIcon}>
          <path d="M3.5 1.5h5l2 2v9h-7z" /><path d="M5.5 7h3M5.5 9.5h3" />
        </svg>
        <span style={{ ...P.scNodeName, ...P.scNodeMain }}>{payload.title || '主会话'}</span>
        <span style={P.scNodeMeta}>{payload.messageCount} 条</span>
      </button>
      <div style={P.scBranch}>
        {sidechains.map((sc, i) => {
          const summon = summonOf(i);
          return (
            <button key={sc.agentId} type="button" role="menuitem" style={P.scNode(currentIndex === i)} onClick={() => onOpen(i)}>
              <svg width={13} height={13} viewBox="0 0 14 14" aria-hidden style={P.scNodeIcon}>
                <rect x="1.5" y="1.5" width="5" height="5" rx="1" /><rect x="7.5" y="7.5" width="5" height="5" rx="1" /><path d="M6.5 4h2.5a1 1 0 011 1v2.5" />
              </svg>
              <span style={P.scNodeName}>{sc.agentType ?? sc.agentId.slice(0, 8)}</span>
              <span style={P.scNodeMeta}>{sc.messages.length} 条</span>
              {currentIndex === -1 && summon !== undefined ? (
                <span
                  role="button"
                  title="定位召唤处"
                  style={P.scJump}
                  onClick={(e: { stopPropagation: () => void }) => { e.stopPropagation(); onJump(i); }}
                >
                  <svg width={12} height={12} viewBox="0 0 14 14" aria-hidden style={P.scNodeIcon}>
                    <circle cx="7" cy="7" r="4" /><path d="M7 1v2.2M7 10.8V13M1 7h2.2M10.8 7H13" />
                  </svg>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── 主视图 ───────────────────────────────────────────────────────────── */

/** 每页渲染条数（desktop PAGE=50 的侧栏版——流条目含块卡，30 挡住首屏成本）。 */
const PAGE = 30;

type FlowView = { type: 'main' } | { type: 'agent'; index: number };

export interface PreviewFlowViewProps {
  payload: PreviewPayload;
  /** 初始整区视图（无头冒烟直染旁链流用；宿主正常走默认主视图）。 */
  initialAgentIndex?: number;
  /** 初始展开切换器菜单（无头冒烟直染树结构用）。 */
  initialMenuOpen?: boolean;
}

/**
 * 富预览：切换器 + 摘要 chips + 消息流（懒分页）。旁链 = desktop 同款
 * 「整区切换」：主视图 ↔ 旁链视图由头部菜单切换，不在流内内联渲染。
 * 纯展示组件——fetch/状态机在 wizard.tsx，本组件只吃 payload。
 */
export function PreviewFlowView({ payload, initialAgentIndex, initialMenuOpen }: PreviewFlowViewProps): ReactNode {
  const flow = useMemo(() => computeFlow(payload.messages, 'm'), [payload]);
  const scs = useMemo(() => payload.sidechains ?? [], [payload]);
  const agentFlows = useMemo(() => scs.map((sc, i) => computeFlow(sc.messages, `ag${i}-`)), [scs]);
  const callByAgent = useMemo(() => buildCallByAgent(payload.messages, scs), [payload.messages, scs]);

  const [view, setView] = useState<FlowView>(
    initialAgentIndex !== undefined ? { type: 'agent', index: initialAgentIndex } : { type: 'main' },
  );
  const [menuOpen, setMenuOpen] = useState<boolean>(initialMenuOpen === true);
  const [visibleCount, setVisibleCount] = useState(PAGE);
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 换会话重置（desktop 的 watch payload.sessionId → 主视图 + PAGE）
  useEffect(() => {
    setView({ type: 'main' });
    setMenuOpen(false);
    setVisibleCount(PAGE);
  }, [payload.sessionId]);

  // Esc 关菜单（desktop onEsc 同款）
  useEffect(() => {
    if (!menuOpen) return;
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [menuOpen]);

  // 闪烁定时器收尾（不挂在组件树上的副作用必须自清理）
  useEffect(() => () => {
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
  }, []);

  // 召唤点跳转：等主流全量渲染完成后定位 + 闪烁（desktop jumpToSummon 同语义）
  useEffect(() => {
    if (jumpTo === null) return;
    const el = rootRef.current?.querySelector(`[data-call="${cssEscape(jumpTo)}"]`);
    if (el !== null && el !== undefined) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('cm-flash');
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => el.classList.remove('cm-flash'), 1800);
    }
    setJumpTo(null);
  }, [jumpTo]);

  const agentLabel = (i: number): string => {
    const sc = scs[i];
    return sc === undefined ? '' : sc.agentType ?? sc.agentId.slice(0, 12);
  };
  const summonCallId = (i: number): string | undefined => {
    const sc = scs[i];
    if (sc === undefined) return undefined;
    return sc.parentCallId ?? callByAgent.get(sc.agentId);
  };

  const openAgent = (i: number): void => {
    setView({ type: 'agent', index: i });
    setMenuOpen(false);
  };
  const backToMain = (): void => {
    setView({ type: 'main' });
    setMenuOpen(false);
  };
  const jumpToSummon = (i: number): void => {
    setMenuOpen(false);
    const callId = summonCallId(i);
    if (callId === undefined) return;
    setView({ type: 'main' });
    setVisibleCount(flow.length); // 目标行可能还没懒挂载
    setJumpTo(callId);
  };

  const currentAgent = view.type === 'agent' ? scs[view.index] : undefined;
  const mainVisible = flow.slice(0, visibleCount);

  return (
    <div ref={rootRef} style={{ display: 'flex', flexDirection: 'column' }}>
      <style>{FLASH_STYLE}</style>

      {/* 切换器（desktop 的 sv-sc-btn：主视图显数量，旁链视图显当前标签） */}
      {scs.length > 0 ? (
        <span style={P.scWrap}>
          <button type="button" style={P.scBtn} onClick={() => setMenuOpen((o) => !o)}>
            <svg width={12} height={12} viewBox="0 0 14 14" aria-hidden style={P.scBtnSvg}>
              <rect x="1.5" y="1.5" width="5" height="5" rx="1" /><rect x="7.5" y="7.5" width="5" height="5" rx="1" /><path d="M6.5 4h2.5a1 1 0 011 1v2.5" />
            </svg>
            {view.type === 'agent' ? `子代理 · ${agentLabel(view.index)}` : `子代理 · ${scs.length}`}
            <svg width={8} height={8} viewBox="0 0 8 8" aria-hidden style={P.scChev(menuOpen)}>
              <path d="M1.5 2.5L4 5.5l2.5-3" />
            </svg>
          </button>
          {menuOpen ? (
            <>
              <div style={P.scBackdrop} onClick={() => setMenuOpen(false)} />
              <div style={P.scMenu}>
                <SidechainMenu
                  payload={payload}
                  sidechains={scs}
                  currentIndex={view.type === 'agent' ? view.index : -1}
                  onBack={backToMain}
                  onOpen={openAgent}
                  summonOf={summonCallId}
                  onJump={jumpToSummon}
                />
              </div>
            </>
          ) : null}
        </span>
      ) : null}

      {/* 摘要 chips 随视图切换（desktop svp-chips 同语义） */}
      <div style={P.chips}>
        {view.type === 'agent' && currentAgent !== undefined ? (
          <>
            <span style={P.chip}>{currentAgent.messages.length} 条消息</span>
            {currentAgent.truncated === true ? <span style={P.chip}>已截断</span> : null}
            <span style={P.chip} title={currentAgent.agentId}>{currentAgent.agentId.slice(0, 8)}</span>
          </>
        ) : (
          <>
            <span style={P.chip}>{payload.messageCount} 条消息</span>
            {payload.toolCallCount > 0 ? <span style={P.chip}>{payload.toolCallCount} 次工具调用</span> : null}
            {payload.model ? <span style={P.chip}>{payload.model}</span> : null}
            <span style={P.chip} title={payload.cwd ?? ''}>{payload.cwd ? `cwd: ${payload.cwd}` : '无 cwd'}</span>
          </>
        )}
      </div>

      {/* 整区流：主会话（懒分页）或某个旁链（整流渲染——desktop 同款） */}
      {view.type === 'agent' && currentAgent !== undefined
        ? <FlowItems items={agentFlows[view.index] ?? []} compact />
        : (
          <>
            <FlowItems items={mainVisible} />
            {visibleCount < flow.length ? (
              <button type="button" style={P.more} onClick={() => setVisibleCount((n) => Math.min(n + PAGE, flow.length))}>
                显示更多 · 已渲染 {visibleCount} / {flow.length}
              </button>
            ) : null}
          </>
        )}
    </div>
  );
}
