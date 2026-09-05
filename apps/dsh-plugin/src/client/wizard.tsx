/**
 * cc-migrate client 半 — React 迁移向导（「会话迁移」tab 的内容）。
 *
 * 为什么不用 @cc-migrate/ui 的 MigrateWizard：那是 Vue 3 SFC 组件包，DSH
 * 前端是 React——跨框架挂载（Vue-in-React 微前端）复杂且脆，不做。这里是
 * 轻量 React 重写，三步流程对齐 MigrateWizard 的信息架构（工具+会话 →
 * 预览 → 导入确认），数据形状完全复用命令层 DTO（PreviewPayload/
 * SessionMeta——api.ts 的 fetch 通道原样回传）。
 *
 * UI 原语纪律：优先宿主 `@deepseek-ai/dsh-client-ui-primitives`（Button/
 * Input/Tooltip——better-sidebar client 同款用法），但宿主模块图不提供时
 * 兜底原生 React 元素 + 内联样式（与 better-sidebar 审美一致：暗色、紧凑
 * 的 VSCode 侧栏风），不引任何第三方 UI 库。文件里所有样式走内联 style
 * 对象：better-sidebar 用 css-modules + 宿主打包管线，我们单文件无 style
 * loader，内联是唯一不依赖构建链的选择。
 *
 * 渲染边界：better-sidebar 的 TabBar 已给每个 tab 包错误边界，组件自身
 * 不再叠一层（爆炸时外层边界接住，侧栏不死）。
 */

import { createElement, useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { wizardApi, WIZARD_SOURCE_TOOLS, type WizardToolInfo } from './api.js';
import type { PreviewPayload, SessionMeta } from '../commands.js';

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

/* ── 内联样式（暗色紧凑侧栏风；变量集中一处便于统一调） ──────────────── */
const S = {
  root: {
    height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden',
    fontSize: 13, color: '#c8c8d0', userSelect: 'none',
  } as CSSProperties,
  header: {
    padding: '8px 12px', borderBottom: '1px solid #2a2a33', display: 'flex',
    alignItems: 'center', gap: '8px', flexShrink: 0,
  } as CSSProperties,
  stepStrip: { display: 'flex', gap: '6px', marginLeft: 'auto', fontSize: 11, color: '#7a7a88' } as CSSProperties,
  stepDot: (active: boolean): CSSProperties => ({
    width: 8, height: 8, borderRadius: '50%',
    background: active ? '#4f6ef7' : '#3a3a44',
  }),
  body: { flex: 1, overflowY: 'auto', padding: '10px 12px' } as CSSProperties,
  toolGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', marginBottom: '10px' } as CSSProperties,
  toolCard: (active: boolean): CSSProperties => ({
    padding: '8px', borderRadius: '8px', border: `1px solid ${active ? '#4f6ef7' : '#2e2e38'}`,
    background: active ? 'rgba(79,110,247,.14)' : '#22222b', cursor: 'pointer',
    textAlign: 'center' as const, transition: 'border-color .15s',
  }),
  toolLabel: { fontSize: 12, fontWeight: 500 } as CSSProperties,
  toolHint: { fontSize: 10, color: '#7a7a88', marginTop: 2 } as CSSProperties,
  row: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' } as CSSProperties,
  label: { fontSize: 12, color: '#9a9aa8', flexShrink: 0, width: 64 } as CSSProperties,
  input: {
    flex: 1, minWidth: 0, background: '#1b1b23', color: '#dcdce4', border: '1px solid #2e2e38',
    borderRadius: '6px', padding: '5px 8px', fontSize: 12, outline: 'none',
  } as CSSProperties,
  list: { border: '1px solid #26262f', borderRadius: '8px', overflow: 'hidden' } as CSSProperties,
  sessionRow: (selected: boolean): CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 10px', cursor: 'pointer',
    background: selected ? 'rgba(79,110,247,.16)' : 'transparent',
    borderBottom: '1px solid #26262f',
  }),
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 } as CSSProperties,
  dim: { color: '#7a7a88' } as CSSProperties,
  empty: { padding: '18px 8px', textAlign: 'center' as const, color: '#7a7a88', fontSize: 12 } as CSSProperties,
  msgRow: (role: string): CSSProperties => ({
    display: 'flex', gap: '8px', padding: '6px 2px',
    borderLeft: `2px solid ${role === 'user' ? '#4f6ef7' : role === 'assistant' ? '#35b26a' : '#6a6a78'}`,
    paddingLeft: 8,
  }),
  msgRole: { fontSize: 10, color: '#7a7a88', width: 52, flexShrink: 0, paddingTop: 2 } as CSSProperties,
  msgBody: { flex: 1, minWidth: 0 } as CSSProperties,
  blockText: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12.5, lineHeight: 1.5 } as CSSProperties,
  blockThink: { color: '#8a8a9a', fontStyle: 'italic' } as CSSProperties,
  blockTool: {
    background: '#1b1b23', borderRadius: '6px', padding: '4px 8px', margin: '3px 0',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11,
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  } as CSSProperties,
  footer: {
    padding: '8px 12px', borderTop: '1px solid #2a2a33', display: 'flex',
    alignItems: 'center', gap: '8px', flexShrink: 0,
  } as CSSProperties,
  err: { color: '#f2a1a1', fontSize: 12, flex: 1, minWidth: 0 } as CSSProperties,
  ok: { color: '#7fd49a', fontSize: 12, flex: 1, minWidth: 0 } as CSSProperties,
  spinner: { fontSize: 12, color: '#7a7a88' } as CSSProperties,
};

/* ── 小件 ──────────────────────────────────────────────────────── */

const fmtTime = (ts?: number): string =>
  ts === undefined ? '—' : new Date(ts).toISOString().slice(0, 16).replace('T', ' ');

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/* ── 向导本体（TabDescriptor.component 吃的组件） ─────────────────── */

export type WizardStep = 'select' | 'preview' | 'importing';

export interface WizardProps {
  /** 宿主 UI 原语（工厂顶 require 的结果；字段缺失走内联兜底）。 */
  ui: HostPrimitives;
  /** visible=false 时挂起重刷（TabComponentProps.visible——tab 非激活时省 fetch）。 */
  visible: boolean;
}

/**
 * 三步向导。状态机刻意扁平：step + 选中态 + busy + err/ok，没有 reducer——
 * 流程是严格线性的（select → preview → importing → 回 select），复杂状态
 * 机没有收益。失败恒回 err 显示 + 停在当前步（可重试），不静默跳步。
 */
export function MigrateWizardView({ ui, visible }: WizardProps): ReactNode {
  const [step, setStep] = useState<WizardStep>('select');
  const [tool, setTool] = useState<WizardToolInfo>(WIZARD_SOURCE_TOOLS[0]);
  const [root, setRoot] = useState<string>(WIZARD_SOURCE_TOOLS[0].defaultRoot);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selected, setSelected] = useState<SessionMeta | null>(null);
  const [payload, setPayload] = useState<PreviewPayload | null>(null);
  const [busy, setBusy] = useState<string>('');
  const [err, setErr] = useState<string>('');
  const [done, setDone] = useState<string>('');

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
        value: props.value ?? '', placeholder: props.placeholder, style: S.input,
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

  // 初始/切工具时拉列表（visible 门控——tab 非激活不 fetch）
  useEffect(() => {
    if (!visible) return;
    void loadSessions();
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
    setStep('importing');
    setErr('');
    try {
      const outcome = await wizardApi.migrate({
        srcTool: tool.id,
        sessionId: selected.sessionId,
        srcRoot: root,
        targetCwd: payload?.cwd,
      });
      setDone(`已导入 dsh:${outcome.sessionId}（${outcome.paths.length} 个文件）`);
      setStep('select');
      setPayload(null);
      setSelected(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setStep('preview');
    }
  }, [selected, tool, root, payload]);

  const toolCards = useMemo(() => WIZARD_SOURCE_TOOLS.map((t) => (
    <div key={t.id} style={S.toolCard(t.id === tool.id)} onClick={() => { setTool(t); setRoot(t.defaultRoot); }}>
      <div style={S.toolLabel}>{t.label}</div>
      <div style={S.toolHint}>{t.defaultRoot}</div>
    </div>
  )), [tool.id]);

  const sessionList = useMemo(() => {
    if (busy === 'listing') return <div style={S.empty}>正在加载会话…</div>;
    if (sessions.length === 0) return <div style={S.empty}>该目录下没有找到会话（检查源库地址后重试）</div>;
    return sessions.map((m, i) => (
      <div key={m.sessionId} style={S.sessionRow(false)} onClick={() => void openPreview(m)}>
        <span style={{ ...S.mono, ...S.dim }}>{String(i + 1).padStart(2)}</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {m.title ? truncate(m.title, 42) : <span style={S.dim}>（无标题）</span>}
          </span>
          <span style={{ ...S.mono, ...S.dim, display: 'block' }}>
            {fmtTime(m.createdAt)} · {truncate(m.sessionId, 26)}
          </span>
        </span>
      </div>
    ));
  }, [sessions, busy, openPreview]);

  const previewBody = useMemo(() => {
    if (payload === null) return null;
    return (
      <>
        <div style={{ ...S.row, marginBottom: '10px' }}>
          <span style={S.label}>会话</span>
          <span style={S.mono}>{truncate(payload.sessionId, 40)}</span>
        </div>
        <div style={{ ...S.row, marginBottom: '10px' }}>
          <span style={S.label}>信息</span>
          <span style={S.dim}>
            {payload.messageCount} 条消息 · {payload.toolCallCount} 次工具调用
            {payload.hasSidechains ? ` · ${payload.sidechainCount} 条子代理链` : ''}
            {payload.cwd ? ` · ${payload.cwd}` : ''}
          </span>
        </div>
        <div style={{ ...S.dim, fontSize: 11, marginBottom: '6px' }}>
          预览前 30 条（完整内容导入后可见）
        </div>
        {payload.messages.slice(0, 30).map((m, i) => (
          <div key={i} style={S.msgRow(m.role)}>
            <span style={S.msgRole}>{m.role}</span>
            <span style={S.msgBody}>
              {m.synthetic === true || m.injectionKind !== undefined ? (
                <span style={{ ...S.dim, fontSize: 10 }}>[{m.injectionKind ?? 'synthetic'} 注入行]</span>
              ) : null}
              {m.blocks.map((b, j) => {
                if (b.t === 'text') return <div key={j} style={S.blockText}>{b.truncated ? `${b.text}…` : b.text}</div>;
                if (b.t === 'think') return <div key={j} style={{ ...S.blockText, ...S.blockThink }}>{b.truncated ? `${b.text}…` : b.text}</div>;
                if (b.t === 'tool_use') return <div key={j} style={{ ...S.blockTool, color: '#8fb7f2' }}>{b.name}({b.callId ?? ''})</div>;
                if (b.t === 'tool_result') return <div key={j} style={{ ...S.blockTool, ...S.dim, color: b.isError ? '#f2a1a1' : '#8a9a8a' }}>{b.isError ? '✗ ' : '→ '}{b.truncated ? `${b.text}…` : b.text}</div>;
                return null;
              })}
            </span>
          </div>
        ))}
      </>
    );
  }, [payload]);

  return (
    <div style={S.root}>
      <div style={S.header}>
        <span style={{ fontWeight: 600 }}>会话迁移</span>
        <span style={{ ...S.dim, fontSize: 11 }}>{tool.label} → DSH</span>
        <span style={S.stepStrip}>
          <span style={S.stepDot(step === 'select')} />
          <span style={S.stepDot(step === 'preview' || step === 'importing')} />
        </span>
      </div>

      <div style={S.body}>
        {step === 'select' ? (
          <>
            <div style={S.toolGrid}>{toolCards}</div>
            <div style={S.row}>
              <span style={S.label}>源库地址</span>
              {renderInput({ value: root, onChange: setRoot, onEnter: () => void loadSessions(), placeholder: '源工具的会话存储根目录' })}
              {renderButton({ onClick: () => void loadSessions(), disabled: busy === 'listing', children: '刷新' })}
            </div>
            <div style={S.list}>{sessionList}</div>
          </>
        ) : null}

        {step === 'preview' || step === 'importing' ? (
          <>
            <div style={{ marginBottom: '8px' }}>
              {renderButton({ onClick: () => { setStep('select'); setPayload(null); setSelected(null); setErr(''); }, disabled: step === 'importing', children: '← 返回列表' })}
            </div>
            {previewBody}
          </>
        ) : null}
      </div>

      <div style={S.footer}>
        {busy === 'preview' ? <span style={S.spinner}>正在解析会话…</span> : null}
        {step === 'importing' ? <span style={S.spinner}>正在写入 DSH…</span> : null}
        {err ? <span style={S.err}>{err}</span> : null}
        {!err && done ? <span style={S.ok}>{done}</span> : null}
        {step === 'preview' && selected !== null ? (
          renderButton({ onClick: () => void runImport(), disabled: busy !== '', style: { marginLeft: 'auto' }, children: '导入到 DSH' })
        ) : null}
      </div>
    </div>
  );
}
