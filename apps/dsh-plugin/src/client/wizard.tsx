/**
 * cc-migrate client 半 — React 迁移向导 v0.3.0（「会话迁移」tab 的内容）。
 *
 * 为什么不用 @cc-migrate/ui 的 MigrateWizard：那是 Vue 3 SFC 组件包，DSH
 * 前端是 React——跨框架挂载（Vue-in-React 微前端）复杂且脆，不做。这里是
 * 轻量 React 重写，数据形状完全复用命令层 DTO（PreviewPayload/
 * SessionMeta——api.ts 的 fetch 通道原样回传）。
 *
 * v0.3.0 重构（对齐独立桌面程序的体验，见 packages/ui/src/components）：
 *  - 侧栏比例适配：DSH 右侧边栏是窄长竖栏（320-420px），桌面宽屏的
 *    「工具大卡片 + 双行会话行」不适配——工具切换改紧凑 chip 行、会话行
 *    高密度单行（标题 + 相对时间），分组列表/预览流拆到 session-list.tsx
 *    与 preview-flow.tsx（语义移植自 Vue 版，见各文件头注）。
 *  - 四步状态机：select（分组列表）→ preview（富预览）→ confirm（导入
 *    参数 + 目标根红线）→ done（结果行 + resume 提示）。
 *  - 确认页红线：不带 --root 时默认写入真实 ~/.dsh/sessions（命令层
 *    `opts.root ?? defaultRoot` 行为）——确认页必须显式展示目标根，
 *    数据来自 `defaults` 端点（routes.ts；老宿主降级为常识默认根）。
 *
 * UI 原语纪律：优先宿主 `@deepseek-ai/dsh-client-ui-primitives`（Button/
 * Input——better-sidebar client 同款用法），宿主模块图不提供时兜底原生
 * React 元素 + 内联样式（暗色、紧凑的 VSCode 侧栏风），不引任何第三方 UI
 * 库。所有样式走内联 style 对象：单文件无 style loader，内联是唯一不依赖
 * 构建链的选择（CSSProperties 常量表集中一处便于统一调密度）。
 *
 * 渲染边界：better-sidebar 的 TabBar 已给每个 tab 包错误边界，组件自身
 * 不再叠一层（爆炸时外层边界接住，侧栏不死）。
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { wizardApi, WIZARD_SOURCE_TOOLS, type WizardToolInfo } from './api.js';
import type { PreviewPayload, SessionMeta } from '../commands.js';
import { groupSessions, loadCollapsedCwds, saveCollapsedCwds, SessionListView } from './session-list.js';
import { PreviewFlowView } from './preview-flow.js';
import { T } from './theme.js';

/* ── 宿主 UI 原语解析（require 由 __ModuleLoader__ 工厂注入）──────────
 * better-sidebar 的 client bundle 在工厂顶 require("react") /
 * require("@deepseek-ai/dsh-client-ui-primitives")——我们同款：本模块不直接
 * import 原语包，而是消费注入的 components 对象（index.tsx 工厂顶 require
 * 后传进来）。缺哪个原语就用内联兜底，字段级降级。
 */
export interface HostPrimitives {
  Button?: (props: { children?: ReactNode; variant?: string; onClick?: () => void; disabled?: boolean; style?: CSSProperties }) => ReactNode;
  Input?: (props: { value?: string; onChange?: (v: string) => void; onEnter?: () => void; placeholder?: string; style?: CSSProperties }) => ReactNode;
  Tooltip?: (props: { children?: ReactNode; content?: ReactNode }) => ReactNode;
}

/**
 * 宿主 sessions 服务的结构镜像（dsh-client-runtime client ctx 的
 * `ctx.sessions: ISessions`，只取本插件消费的 open——better-sidebar 的
 * client inject 同款纪律：结构子集，不 import 宿主包）。open 语义：
 * 「Select a session as current；id 必须已在客户端会话列表里，未知 id
 * fail loud（同步 throw）」——刚导入的会话要等列表刷新，所以跳转必须
 * 带重试（openSessionWithRetry）。
 */
export interface MigrateSessionsPort {
  open(id: string): void;
}

/* ── 内联样式（主题 token 见 theme.ts：宿主浅/暗色自动跟随，暗色兜底） ──── */
const S = {
  root: {
    height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden',
    fontSize: 12.5, color: T.fg2, userSelect: 'none',
  } as CSSProperties,
  header: {
    padding: '7px 10px', borderBottom: `1px solid ${T.hairline}`, display: 'flex',
    alignItems: 'center', gap: 6, flexShrink: 0,
  } as CSSProperties,
  headerTool: { fontSize: 11, color: T.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
  stepStrip: {
    display: 'flex', gap: 3, marginLeft: 'auto', flexShrink: 0,
    alignItems: 'baseline', fontSize: 10,
  } as CSSProperties,
  /* 步骤指示用文字面包屑而非圆点（真机反馈「这俩点是干啥的」——圆点不自解释） */
  stepLabel: (active: boolean): CSSProperties => ({
    color: active ? T.accent : T.dim, fontWeight: active ? 600 : 400,
  }),
  stepSep: { color: T.dim } as CSSProperties,
  body: { flex: 1, overflowY: 'auto', padding: '8px 10px', minWidth: 0 } as CSSProperties,
  /* 工具切换：紧凑 chip 行（桌面大卡片在 320px 栏里一行放不下一个） */
  chipRow: { display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 } as CSSProperties,
  chip: (active: boolean): CSSProperties => ({
    padding: '2px 8px', borderRadius: 999, fontSize: 11, cursor: 'pointer',
    border: `1px solid ${active ? T.accent : T.line2}`,
    background: active ? T.accentBg : 'transparent',
    color: active ? T.fg : T.fg3,
  }),
  toolHint: {
    fontSize: 10.5, color: T.dimmer, marginBottom: 8,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  } as CSSProperties,
  row: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 } as CSSProperties,
  label: { fontSize: 11, color: T.fg3, flexShrink: 0, width: 52 } as CSSProperties,
  input: {
    flex: 1, minWidth: 0, background: T.bg1, color: T.fg, border: `1px solid ${T.line2}`,
    borderRadius: '6px', padding: '4px 8px', fontSize: 11.5, outline: 'none',
  } as CSSProperties,
  countLine: { fontSize: 10.5, color: T.dimmer, margin: '2px 2px 4px' } as CSSProperties,
  /* 预览头 */
  backRow: { marginBottom: 6 } as CSSProperties,
  titleLine: { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 } as CSSProperties,
  titleText: {
    fontWeight: 600, fontSize: 13, color: T.fgBright, overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1, minWidth: 0,
  } as CSSProperties,
  idChip: {
    flexShrink: 0, fontSize: 9.5, color: T.dim, border: `1px solid ${T.line1}`,
    borderRadius: 999, padding: '0 6px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  } as CSSProperties,
  cwdLine: {
    fontSize: 10.5, color: T.dimmer, margin: '3px 0 6px', overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  } as CSSProperties,
  /* 确认页：目标根红线框 + 参数行 + 开关 */
  confirmBox: {
    border: `1px solid ${T.warnBorder}`, borderRadius: 8, padding: '7px 9px',
    marginBottom: 8, background: T.warnBg,
  } as CSSProperties,
  confirmTitle: { fontSize: 11, color: T.warn, fontWeight: 600, marginBottom: 2 } as CSSProperties,
  confirmLine: { fontSize: 11, color: T.fgBody, lineHeight: 1.5 } as CSSProperties,
  confirmMono: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: T.warnText, wordBreak: 'break-all',
  } as CSSProperties,
  switchRow: { display: 'flex', gap: 7, alignItems: 'flex-start', padding: '4px 2px', cursor: 'pointer' } as CSSProperties,
  checkbox: { margin: 0, marginTop: 2, accentColor: T.accent, flexShrink: 0 } as CSSProperties,
  switchText: { minWidth: 0 } as CSSProperties,
  switchLabel: { fontSize: 11.5, color: T.fg2 } as CSSProperties,
  hint: { display: 'block', fontSize: 10, color: T.dimmer, marginTop: 1 } as CSSProperties,
  /* 结果页 */
  resultBox: {
    border: `1px solid ${T.okBorder}`, borderRadius: 8, padding: '9px 10px',
    background: T.okBg,
  } as CSSProperties,
  resultHead: { fontSize: 12.5, color: T.ok, fontWeight: 600, marginBottom: 4 } as CSSProperties,
  resultPath: {
    fontSize: 10, color: T.okSoft, margin: '1px 0', wordBreak: 'break-all',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  } as CSSProperties,
  resumeHint: { fontSize: 11, color: T.fg3, marginTop: 5, lineHeight: 1.5 } as CSSProperties,
  footer: {
    padding: '7px 10px', borderTop: `1px solid ${T.hairline}`, display: 'flex',
    alignItems: 'center', gap: 6, flexShrink: 0,
  } as CSSProperties,
  err: { color: T.err, fontSize: 11.5, flex: 1, minWidth: 0 } as CSSProperties,
  ok: { color: T.ok, fontSize: 11.5, flex: 1, minWidth: 0 } as CSSProperties,
  spinner: { fontSize: 11, color: T.dim, flexShrink: 0 } as CSSProperties,
};

/* ── 小件 ──────────────────────────────────────────────────────── */

const fmtTime = (ts?: number): string =>
  ts === undefined ? '—' : new Date(ts).toISOString().slice(0, 16).replace('T', ' ');

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/* ── 自动跳转（导入成功 → DSH 主界面切到新会话）──────────────────────────
 * 两个宿主语义（dsh-client-runtime 源码锚定）：
 *  1. ctx.sessions.open 对「不在客户端会话列表」的 id 同步 throw（SessionManager.select）；
 *  2. 新会话不会自动进列表——导入是宿主半直接写盘，客户端列表只靠
 *     session.list 重拉（reconnect）或 host 变更帧更新，ISessions 公开面
 *     没有刷新入口（真机反馈：不手动刷新列表，open 永远撞 throw）。
 * 因此每拍先走运行时桥主动重拉：SessionRuntime.manager 是 TS private 但
 * 运行时是普通属性，manager.refreshList() 即全量重拉（单飞）。字段更名时
 * 链式探测得 undefined → 优雅退化回被动重试，节拍耗尽回落 done 页提示行。
 */

/** 重试节拍（ms）：立即 + 3 次退避，总窗口 ~4.5s。 */
const JUMP_DELAYS_MS = [0, 600, 1400, 2500];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 宿主 SessionRuntime 的运行时桥（仅探测，不做硬依赖）。 */
interface SessionsRefreshBridge {
  manager?: {
    refreshList?: () => unknown;
  };
}

/** 主动重拉 session.list（失败静默——拉不动时仍有 open 的被动重试兜着）。 */
async function pullSessionList(port: MigrateSessionsPort): Promise<void> {
  const manager = (port as unknown as SessionsRefreshBridge).manager;
  const refreshList = manager?.refreshList;
  if (typeof refreshList !== 'function') return;
  try {
    await Promise.resolve(refreshList.call(manager)).catch(() => { /* 传输失败——下一拍再试 */ });
  } catch {
    /* 同步抛同样吞掉：刷新是尽力而为，不能阻塞 open 尝试 */
  }
}

/**
 * open-with-retry：每拍先重拉列表再尝试 open（撞上「会话未进列表」的
 * throw 就按节拍重来）。
 * @returns 'ok'（某次 open 未抛）| 'fail'（节拍内始终抛）。只吃 open 的
 * 同步异常；port 本身缺席由调用方判空。
 */
export async function openSessionWithRetry(port: MigrateSessionsPort, sessionId: string, delays: readonly number[] = JUMP_DELAYS_MS): Promise<'ok' | 'fail'> {
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await sleep(delays[i]);
    await pullSessionList(port);
    try {
      port.open(sessionId);
      return 'ok';
    } catch {
      /* 会话还没进客户端列表——等下一拍 */
    }
  }
  return 'fail';
}

/** 结果页跳转状态行（idle 不渲染）。 */
export type JumpState = 'idle' | 'jumping' | 'ok' | 'fail';

/* ── 向导本体（TabDescriptor.component 吃的组件） ─────────────────── */

export type WizardStep = 'select' | 'preview' | 'confirm' | 'done';

export interface WizardProps {
  /** 宿主 UI 原语（工厂顶 require 的结果；字段缺失走内联兜底）。 */
  ui: HostPrimitives;
  /** visible=false 时挂起重刷（TabComponentProps.visible——tab 非激活时省 fetch）。 */
  visible: boolean;
  /**
   * 宿主 sessions 服务（ctx.sessions 的结构子集，index.tsx resolveSessions
   * 探测传入）。缺席 = 自动跳转功能关闭（老宿主），其余功能不受影响。
   */
  sessions?: MigrateSessionsPort;
}

/**
 * 四步向导。状态机刻意扁平：step + 选中态 + busy + err，没有 reducer——
 * 流程是严格线性的（select → preview → confirm → done → 回 select），
 * 复杂状态机没有收益。失败恒回 err 显示 + 停在当前步（可重试），不静默
 * 跳步。分组折叠状态（localStorage 记忆，key 前缀 cc-migrate:）是唯一的
 * 跨会话状态，收敛在 collapsed 一处。
 */
export function MigrateWizardView({ ui, visible, sessions: sessionsPort }: WizardProps): ReactNode {
  const [step, setStep] = useState<WizardStep>('select');
  const [tool, setTool] = useState<WizardToolInfo>(WIZARD_SOURCE_TOOLS[0]);
  const [root, setRoot] = useState<string>(WIZARD_SOURCE_TOOLS[0].defaultRoot);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selected, setSelected] = useState<SessionMeta | null>(null);
  const [payload, setPayload] = useState<PreviewPayload | null>(null);
  const [busy, setBusy] = useState<string>('');
  const [err, setErr] = useState<string>('');
  const [query, setQuery] = useState<string>('');
  /* 确认页状态：目标根回显 + 导入参数 */
  const [defaults, setDefaults] = useState<{ dstRoot: string | null; dshDefaultRoot: string } | null>(null);
  const [targetCwd, setTargetCwd] = useState<string>('');
  const [flatten, setFlatten] = useState<boolean>(false);
  const [keepSynthetic, setKeepSynthetic] = useState<boolean>(false);
  /* 结果页状态 */
  const [done, setDone] = useState<{ sessionId: string; paths: string[] } | null>(null);
  /* 自动跳转状态（sessions port 缺席时恒 idle——结果页不渲染跳转行） */
  const [jump, setJump] = useState<JumpState>('idle');
  /* 跳转重试纪元：用户离开 done 页后，迟到的重试不再落地 setState */
  const jumpEpochRef = useRef(0);
  /* 分组折叠（localStorage 记忆——SSR/无头冒烟没有 localStorage，降级全展开） */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsedCwds());

  // 宿主原语或内联兜底的原素渲染函数：恒返回 ReactNode（不是组件——兜底
  // 闭包吃 props 直接渲染，宿主原语同样是 (props) => ReactNode 形态，二者
  // 都经 createElement 二次调用挂进树，避免「组件当 child 渲染」的 React 警告）。
  const renderButton = useCallback((props: {
    children?: ReactNode; onClick?: () => void; disabled?: boolean; style?: CSSProperties;
  }): ReactNode => ui.Button !== undefined
    ? ui.Button(props)
    : createElement('button', {
        type: 'button', onClick: props.onClick, disabled: props.disabled,
        style: { ...S.input, cursor: props.disabled ? 'default' : 'pointer', opacity: props.disabled ? 0.45 : 1, ...props.style },
      }, props.children), [ui]);

  // 宿主 Input 的签名是 onChange(value)（非 React 原生事件对象）——兜底闭包
  // 在这里统一翻译，调用方无感。
  const renderInput = useCallback((props: {
    value?: string; onChange?: (v: string) => void; onEnter?: () => void; placeholder?: string;
  }): ReactNode => ui.Input !== undefined
    ? ui.Input(props)
    : createElement('input', {
        value: props.value ?? '', placeholder: props.placeholder, style: props.style ?? S.input,
        onChange: (e: { target: { value: string } }) => props.onChange?.(e.target.value),
        onKeyDown: (e: { key: string }) => { if (e.key === 'Enter') props.onEnter?.(); },
      }), [ui]);

  const loadSessions = useCallback(async (): Promise<void> => {
    setBusy('listing');
    setErr('');
    try {
      const list = await wizardApi.listSessions(tool.id, root);
      setSessions(list);
    } catch (e) {
      setSessions([]);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }, [tool, root]);

  // 初始/切工具时拉列表 + 一次性拉目标根回显（都 visible 门控——tab 非激活不 fetch）
  useEffect(() => {
    if (!visible) return;
    void loadSessions();
    void wizardApi.defaults().then(setDefaults);
  }, [visible, loadSessions]);

  const openPreview = useCallback(async (m: SessionMeta): Promise<void> => {
    setBusy('preview');
    setErr('');
    try {
      const p = await wizardApi.preview(tool.id, m.sessionId, root);
      setPayload(p);
      setSelected(m);
      setStep('preview');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }, [tool, root]);

  const runImport = useCallback(async (): Promise<void> => {
    if (selected === null) return;
    setBusy('import');
    setErr('');
    try {
      // targetCwd 留空 = 不传（命令层回落 ir.cwd——确认页 hint 已说明）
      const cwd = targetCwd.trim() === '' ? undefined : targetCwd.trim();
      const outcome = await wizardApi.migrate({
        srcTool: tool.id,
        sessionId: selected.sessionId,
        srcRoot: root,
        targetCwd: cwd,
        flatten,
        keepSynthetic,
      });
      setDone({ sessionId: outcome.sessionId, paths: outcome.paths });
      setStep('done');
      // 自动跳转：导入成功即让 DSH 主界面切到新会话（port 缺席 = 功能关闭）
      if (sessionsPort !== undefined) {
        const epoch = ++jumpEpochRef.current;
        setJump('jumping');
        void openSessionWithRetry(sessionsPort, outcome.sessionId).then((result) => {
          if (jumpEpochRef.current === epoch) setJump(result === 'ok' ? 'ok' : 'fail');
        });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }, [selected, tool, root, targetCwd, flatten, keepSynthetic, sessionsPort]);

  const toggleGroup = useCallback((key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsedCwds(next);
      return next;
    });
  }, []);

  const backToSelect = useCallback((): void => {
    setStep('select');
    setPayload(null);
    setSelected(null);
    setDone(null);
    setErr('');
    jumpEpochRef.current += 1; // 迟到的跳转重试不再落地
    setJump('idle');
  }, []);

  /* ── 派生数据 ─────────────────────────────────────────────────── */

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((m) =>
      String(m.sessionId).toLowerCase().includes(q)
      || String(m.title ?? '').toLowerCase().includes(q)
      || String(m.cwd ?? '').toLowerCase().includes(q));
  }, [sessions, query]);

  const groups = useMemo(() => groupSessions(filtered), [filtered]);

  /* 确认页目标根（红线）：defaults 端点回显插件配置；未配置/老宿主显示 DSH
   * 常识默认根——与命令层 `opts.root ?? defaultRoot` 的实际行为一致。 */
  const targetRootText = defaults === null
    ? '…'
    : defaults.dstRoot !== null
      ? `${defaults.dstRoot}（插件配置）`
      : `${defaults.dshDefaultRoot}（DSH 默认）`;

  const toolChips = useMemo(() => WIZARD_SOURCE_TOOLS.map((t) => (
    <button
      key={t.id}
      type="button"
      style={S.chip(t.id === tool.id)}
      title={t.defaultRoot}
      onClick={() => { setTool(t); setRoot(t.defaultRoot); }}
    >{t.label}</button>
  )), [tool.id]);

  const selectView = (
    <>
      <div style={S.chipRow}>{toolChips}</div>
      <div style={S.toolHint} title={tool.defaultRoot}>{tool.defaultRoot}</div>
      <div style={S.row}>
        <span style={S.label}>源库地址</span>
        {renderInput({ value: root, onChange: setRoot, onEnter: () => void loadSessions(), placeholder: '源工具的会话存储根目录' })}
        {renderButton({ onClick: () => void loadSessions(), disabled: busy === 'listing', children: '刷新', style: { flex: 'none' } })}
      </div>
      {sessions.length > 0 ? (
        <div style={S.row}>
          {renderInput({
            value: query, onChange: setQuery, style: { flex: 1 },
            placeholder: '过滤：标题 / 会话 id / 工作目录…',
          })}
        </div>
      ) : null}
      {sessions.length > 0 ? (
        <div style={S.countLine}>{groups.length} 组 · {filtered.length} 会话</div>
      ) : null}
      {busy === 'listing'
        ? <div style={S.countLine}>正在加载会话…</div>
        : sessions.length === 0
          ? <div style={S.countLine}>该目录下没有找到会话（检查源库地址后重试）</div>
          : <SessionListView
              groups={groups}
              collapsed={collapsed}
              onToggleGroup={toggleGroup}
              onOpen={(m) => void openPreview(m)}
              emptyHint="无匹配结果。"
            />}
    </>
  );

  const previewView = payload === null ? null : (
    <>
      <div style={S.backRow}>
        {renderButton({ onClick: backToSelect, children: '← 返回列表', style: { flex: 'none' } })}
      </div>
      <div style={S.titleLine}>
        <span style={S.titleText} title={payload.title ?? ''}>{payload.title ?? '（无标题）'}</span>
        <span style={S.idChip} title={payload.sessionId}>{payload.sessionId.slice(0, 12)}</span>
      </div>
      <div style={S.cwdLine} title={payload.cwd ?? ''}>{fmtTime(payload.createdAt)}{payload.cwd ? ` · ${payload.cwd}` : ''}</div>
      <PreviewFlowView payload={payload} />
    </>
  );

  const confirmView = (
    <>
      <div style={S.backRow}>
        {renderButton({ onClick: () => { setStep('preview'); setErr(''); }, disabled: busy === 'import', children: '← 返回预览', style: { flex: 'none' } })}
      </div>
      <div style={S.confirmBox}>
        <div style={S.confirmTitle}>写入目标</div>
        <div style={S.confirmLine}><span style={S.confirmMono}>{targetRootText}</span></div>
        <div style={S.confirmLine}>写入的是全新会话，不会覆盖已有会话。</div>
      </div>
      <div style={S.row}>
        <span style={S.label}>工作目录</span>
        {renderInput({
          value: targetCwd,
          onChange: setTargetCwd,
          placeholder: payload?.cwd ?? '沿用源会话的工作目录',
        })}
      </div>
      <div style={{ ...S.hint, marginBottom: 6, paddingLeft: 2 }}>
        {payload?.cwd ? `源会话位于 ${payload.cwd}；留空沿用。` : '留空则沿用源会话的工作目录。'}
      </div>
      <label style={S.switchRow}>
        <input type="checkbox" style={S.checkbox} checked={flatten} onChange={(e: { target: { checked: boolean } }) => setFlatten(e.target.checked)} />
        <span style={S.switchText}>
          <span style={S.switchLabel}>拍平子代理旁链</span>
          <span style={S.hint}>隐藏的子代理会话转为主流消息（flatten）</span>
        </span>
      </label>
      <label style={S.switchRow}>
        <input type="checkbox" style={S.checkbox} checked={keepSynthetic} onChange={(e: { target: { checked: boolean } }) => setKeepSynthetic(e.target.checked)} />
        <span style={S.switchText}>
          <span style={S.switchLabel}>保留 harness 注入行</span>
          <span style={S.hint}>运行时上下文快照等注入行默认丢弃（keepSynthetic）</span>
        </span>
      </label>
    </>
  );

  const doneView = done === null ? null : (
    <>
      <div style={S.resultBox}>
        <div style={S.resultHead}>✓ 导入成功</div>
        <div style={S.confirmLine}>新会话 <span style={S.confirmMono}>dsh:{done.sessionId}</span></div>
        {done.paths.map((p) => <div key={p} style={S.resultPath}>{p}</div>)}
        {sessionsPort !== undefined && jump !== 'idle' ? (
          <div style={{ ...S.resumeHint, color: jump === 'fail' ? T.warn : jump === 'ok' ? T.ok : T.fg3 }}>
            {jump === 'jumping' ? '正在切换到新会话…'
              : jump === 'ok' ? '已切换到新会话 ✓'
              : '自动跳转失败（新会话还没出现在列表里），请在 DSH 会话列表手动选择。'}
          </div>
        ) : null}
        <div style={S.resumeHint}>新会话已进入 DSH 会话列表，选中即可 resume 接着聊（迁移复现对话历史，不重放文件/shell 副作用）。</div>
      </div>
      <div style={{ ...S.backRow, marginTop: 8 }}>
        {renderButton({ onClick: backToSelect, children: '再迁一个', style: { flex: 'none' } })}
      </div>
    </>
  );

  return (
    <div style={S.root}>
      <div style={S.header}>
        <span style={{ fontWeight: 600, flexShrink: 0 }}>会话迁移</span>
        <span style={S.headerTool}>{tool.label} → DSH</span>
        <span style={S.stepStrip}>
          <span style={S.stepLabel(step === 'select')}>列表</span>
          <span style={S.stepSep}>›</span>
          <span style={S.stepLabel(step === 'preview')}>预览</span>
          <span style={S.stepSep}>›</span>
          <span style={S.stepLabel(step === 'confirm' || step === 'done')}>导入</span>
        </span>
      </div>

      <div style={S.body}>
        {step === 'select' ? selectView : null}
        {step === 'preview' ? previewView : null}
        {step === 'confirm' ? confirmView : null}
        {step === 'done' ? doneView : null}
      </div>

      <div style={S.footer}>
        {busy === 'preview' ? <span style={S.spinner}>正在解析会话…</span> : null}
        {busy === 'import' ? <span style={S.spinner}>正在写入 DSH…</span> : null}
        {err ? <span style={S.err}>{err}</span> : null}
        {step === 'preview' && payload !== null && busy === '' ? (
          renderButton({
            onClick: () => { setStep('confirm'); setErr(''); },
            disabled: false,
            style: { marginLeft: 'auto', flex: 'none' },
            children: '下一步：导入设置',
          })
        ) : null}
        {step === 'confirm' && selected !== null ? (
          renderButton({
            onClick: () => void runImport(),
            disabled: busy !== '',
            style: { marginLeft: 'auto', flex: 'none' },
            children: '执行导入',
          })
        ) : null}
      </div>
    </div>
  );
}
