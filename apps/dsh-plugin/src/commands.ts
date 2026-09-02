/**
 * session-migrate DSH plugin — command layer.
 *
 * Pure functions decoupled from the cordis host: they receive plain
 * arguments, call the shared `@session-migrate/core` engine, and return
 * result objects. The cordis side (src/index.ts) only deals with
 * interaction (argument parsing, logging, dispose); all migration logic
 * lives here so it stays testable without a DSH host.
 *
 * Safety (repo-wide iron rule, AGENT.md):
 *  - READ the source, WRITE brand-new files only. The DSH write side
 *    generates a fresh session id and never clobbers an existing session.
 *  - No unlink / rm / DELETE / TRUNCATE anywhere in this file.
 *  - The default DSH root (~/.dsh/sessions) is only touched when the
 *    caller explicitly leaves `root` unset in the real host; tests and
 *    smoke runs always pass a temp `root` (or `dstRoot`).
 *
 * Every operation is wrapped so an adapter/IO failure surfaces as
 * `{ ok: false, error }` instead of blowing up the host process.
 */

import {
  builtinRegistry,
  listSessions,
  previewSession,
  readSource,
  writeTarget,
} from '@session-migrate/core';
import type {
  AdapterRegistry,
  MigratedMessage,
  MigratedSidechain,
  SessionMeta,
  ToolId,
  WriteResult,
} from '@session-migrate/core';

/** Tools this plugin can import FROM (target is always DSH). */
export const SOURCE_TOOLS: ToolId[] = ['dsh', 'claude', 'codex', 'opencode', 'pi', 'zcode'];

export type { SessionMeta, ToolId, WriteResult };

/** Structured failure — commands never let exceptions escape to the host. */
export interface CommandError {
  ok: false;
  error: string;
}

export interface ListSourcesResult {
  ok: true;
  tool: ToolId;
  sessions: SessionMeta[];
}

export interface PreviewResult {
  ok: true;
  tool: ToolId;
  sessionId: string;
  /** Full offline text preview (host may truncate for display). */
  text: string;
}

export interface ImportResult {
  ok: true;
  source: { tool: ToolId; sessionId: string };
  target: WriteResult;
}

export type ListSourcesOutcome = ListSourcesResult | CommandError;
export type PreviewOutcome = PreviewResult | CommandError;
export type ImportOutcome = ImportResult | CommandError;

/** GUI structured preview: payload on success, structured error on failure. */
export type PreviewPayloadOutcome = PreviewPayload | CommandError;

export interface ImportOptions {
  /** Source root override (where the source tool's sessions live). */
  srcRoot?: string;
  /** Working directory to stamp on the new DSH session (defaults to IR cwd). */
  targetCwd?: string;
  /** Override the new DSH session id (core generates one when omitted). */
  sessionId?: string;
  /** DSH sessions root override — tests/smoke pass a temp dir here. */
  root?: string;
  /** Cross-tool flattening: true turns hidden subagent transcripts into top-level messages. */
  flatten?: boolean;
  /** Keep harness-injected (synthetic) messages in the target session. */
  keepSynthetic?: boolean;
}

/* ── GUI 预览 DTO 投影 ────────────────────────────────────────────
 *
 * ui 组件（SessionPreview）吃的结构化载荷 PreviewPayload 不是 IR 本身，而是
 * IR 的 GUI 投影（桌面 App 在 worker 里做的同一件事，见
 * apps/desktop-app/worker/worker.mjs —— 形状与上限原样对齐，组件零改动复用）。
 * 命令层是唯一允许 import core 的地方，所以投影放这里：GUI 层（src/gui.ts）
 * 拿到的是已投影好的纯数据，不触碰 IR 类型。
 */

/** 单块文本上限（超长截断 + truncated 标记，防大 transcript 撑爆宿主 IPC）。 */
const CAP_TEXT = 10_000;
/** 辅助块（thinking / tool 参数与结果）上限。 */
const CAP_AUX = 2_000;
/** 每条子代理旁链最多投影的消息数。 */
const SC_MSG_CAP = 300;

/** 结构化预览的消息块（IR ContentBlock 的 GUI 投影）。 */
export interface PreviewBlockDto {
  t: 'text' | 'think' | 'tool_use' | 'tool_result' | 'file';
  text?: string;
  callId?: string;
  name?: string;
  mediaType?: string;
  isError?: boolean;
  truncated?: boolean;
}

/** 结构化预览的单条消息（IR MigratedMessage 的 GUI 投影）。 */
export interface PreviewMessageDto {
  role: 'user' | 'assistant' | 'tool' | 'system' | 'developer';
  ts?: number;
  model?: string;
  synthetic?: boolean;
  /** harness 注入分类（codex AGENTS.md 指令、inter-agent 通信等非 synthetic 注入行）。 */
  injectionKind?: string;
  blocks: PreviewBlockDto[];
}

/** 子代理旁链（GUI 的子代理树：一层主干 + N 个节点，嵌套孙代已拍平）。 */
export interface PreviewSidechainDto {
  agentId: string;
  agentType?: string;
  /** 派发该子代理的 tool_use 调用 id（渲染层据此把旁链挂到调用点下方）。 */
  parentCallId?: string;
  truncated?: boolean;
  messages: PreviewMessageDto[];
}

/** GUI 预览载荷（MigratedSession 的摘要 + 结构化消息投影）。 */
export interface PreviewPayload {
  tool: ToolId;
  sessionId: string;
  title?: string;
  createdAt?: number;
  cwd?: string;
  model?: string;
  messageCount: number;
  sidechainCount: number;
  toolCallCount: number;
  hasSidechains: boolean;
  messages: PreviewMessageDto[];
  sidechains?: PreviewSidechainDto[];
}

function capText(s: string, n: number): { text: string; truncated?: boolean } {
  return s.length > n ? { text: s.slice(0, n), truncated: true } : { text: s };
}

/** IR ContentBlock → GUI DTO（与 desktop-app worker 的 blockToDto 同一形状）。 */
function blockToDto(b: MigratedMessage['content'][number]): PreviewBlockDto | null {
  switch (b.type) {
    case 'text':
      return b.text ? { t: 'text', ...capText(b.text, CAP_TEXT) } : null;
    case 'thinking':
      return b.thinking ? { t: 'think', ...capText(b.thinking, CAP_AUX) } : null;
    case 'tool_use': {
      let input: string;
      try {
        input = JSON.stringify(b.input, null, 2) ?? '';
      } catch {
        input = String(b.input);
      }
      return { t: 'tool_use', callId: b.id, name: b.name || 'tool', ...capText(input, CAP_AUX) };
    }
    case 'tool_result':
      return { t: 'tool_result', callId: b.toolUseId, isError: b.isError, ...capText(b.content ?? '', CAP_AUX) };
    case 'file':
      return { t: 'file', name: b.filename, mediaType: b.mediaType };
    default:
      return null;
  }
}

/**
 * Harness 注入分类投影（GUI 只吃 IR）：synthetic 之外，IR 消息 meta 里的
 * harness 分类也要带到 DTO —— codex 的 AGENTS.md 指令行是非 synthetic 的
 * contentKind，漏了它 GUI 就会把注入当用户提示词。
 */
function injectionKindOf(m: MigratedMessage): string | undefined {
  const cx = m.meta?.codex as { contentKind?: unknown; kind?: unknown } | undefined;
  if (typeof cx?.contentKind === 'string') return cx.contentKind;
  if (cx?.kind === 'compaction_summary' || cx?.kind === 'iac') return cx.kind as string;
  return undefined;
}

function messageToDto(m: MigratedMessage): PreviewMessageDto {
  const blocks: PreviewBlockDto[] = m.content.map(blockToDto).filter((b): b is PreviewBlockDto => b !== null);
  const injectionKind = injectionKindOf(m);
  return {
    role: m.role,
    ts: m.timestamp,
    model: m.model,
    synthetic: m.synthetic,
    ...(injectionKind ? { injectionKind } : {}),
    blocks,
  };
}

/** 嵌套旁链（孙代）拍平为顶层条目 —— GUI 的子代理树是一层主干 + N 个节点。 */
function flattenSidechains(list: MigratedSidechain[] | undefined, out: PreviewSidechainDto[] = []): PreviewSidechainDto[] {
  for (const sc of list ?? []) {
    const msgs = sc.messages ?? [];
    const capped = msgs.slice(0, SC_MSG_CAP);
    out.push({
      agentId: sc.agentId,
      agentType: sc.agentType,
      parentCallId: sc.parentMessageId,
      truncated: msgs.length > SC_MSG_CAP || undefined,
      messages: capped.map(messageToDto),
    });
    if (sc.sidechains?.length) flattenSidechains(sc.sidechains, out);
  }
  return out;
}

/** MigratedSession → GUI 预览载荷（IR 已读入，投影纯同步、无 IO）。 */
export function projectPreviewPayload(tool: ToolId, sessionId: string, ir: import('@session-migrate/core').MigratedSession): PreviewPayload {
  return {
    tool,
    sessionId,
    title: ir.title,
    createdAt: ir.createdAt,
    cwd: ir.cwd,
    model: ir.model?.id,
    messageCount: ir.messages.length,
    sidechainCount: ir.sidechains?.length ?? 0,
    toolCallCount: ir.toolCalls?.length ?? 0,
    hasSidechains: (ir.sidechains?.length ?? 0) > 0,
    messages: ir.messages.map(messageToDto),
    sidechains: flattenSidechains(ir.sidechains),
  };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isSourceTool(tool: string): tool is ToolId {
  return SOURCE_TOOLS.includes(tool as ToolId);
}

/**
 * `/session-migrate list-sources <tool> [--root <dir>]`
 *
 * Lists a source tool's sessions (title / time / id / cwd) via the shared
 * registry. Read-only.
 */
export async function listSources(tool: string, root?: string): Promise<ListSourcesOutcome> {
  try {
    if (!isSourceTool(tool)) {
      return { ok: false, error: `unknown tool "${tool}" — supported: ${SOURCE_TOOLS.join(', ')}` };
    }
    const registry = builtinRegistry();
    const sessions = await listSessions(registry.get(tool), root);
    return { ok: true, tool, sessions };
  } catch (e) {
    return { ok: false, error: `list-sources ${tool} failed: ${messageOf(e)}` };
  }
}

/**
 * `/session-migrate preview <tool> <sessionId> [--root <dir>]`
 *
 * Parses the source session into IR and renders the offline text preview.
 * Read-only.
 */
export async function preview(tool: string, sessionId: string, root?: string): Promise<PreviewOutcome> {
  try {
    if (!isSourceTool(tool)) {
      return { ok: false, error: `unknown tool "${tool}" — supported: ${SOURCE_TOOLS.join(', ')}` };
    }
    if (!sessionId) {
      return { ok: false, error: 'preview requires a session id (see list-sources)' };
    }
    const registry = builtinRegistry();
    const ir = await readSource(registry, tool, sessionId, root);
    const text = previewSession(registry.get(tool), ir);
    return { ok: true, tool, sessionId, text };
  } catch (e) {
    return { ok: false, error: `preview ${tool}:${sessionId} failed: ${messageOf(e)}` };
  }
}

/**
 * `/session-migrate preview <tool> <sessionId> [--root <dir>]` — GUI variant.
 *
 * Same read-only parse as the CLI preview, but returns the STRUCTURED payload
 * ui's SessionPreview eats (PreviewPayload DTO) instead of flat text. The
 * GUI wizard goes through this so the projection stays in the one layer that
 * may import core.
 */
export async function previewPayload(tool: string, sessionId: string, root?: string): Promise<PreviewOutcome | PreviewPayloadOutcome> {
  try {
    if (!isSourceTool(tool)) {
      return { ok: false, error: `unknown tool "${tool}" — supported: ${SOURCE_TOOLS.join(', ')}` };
    }
    if (!sessionId) {
      return { ok: false, error: 'preview requires a session id (see list-sources)' };
    }
    const registry = builtinRegistry();
    const ir = await readSource(registry, tool, sessionId, root);
    return projectPreviewPayload(tool, sessionId, ir);
  } catch (e) {
    return { ok: false, error: `preview ${tool}:${sessionId} failed: ${messageOf(e)}` };
  }
}

/**
 * `/session-migrate import <tool> <sessionId> [--src-root <dir>] [--cwd <dir>] [--root <dstRoot>]`
 *
 * Parses the source session into IR, then writes it into DSH's native
 * resumable storage as a BRAND-NEW session (fresh id; existing sessions
 * are never overwritten — core's write side guarantees this). The cwd
 * mapping is the DSH adapter's own: absolute target cwd → `--<projectKey>--`
 * layout, non-absolute/missing → `_no-cwd` (core degrades safely).
 */
export async function importSession(
  srcTool: string,
  srcSessionId: string,
  opts: ImportOptions = {},
): Promise<ImportOutcome> {
  try {
    if (!isSourceTool(srcTool)) {
      return { ok: false, error: `unknown tool "${srcTool}" — supported: ${SOURCE_TOOLS.join(', ')}` };
    }
    if (!srcSessionId) {
      return { ok: false, error: 'import requires a source session id (see list-sources)' };
    }
    const registry: AdapterRegistry = builtinRegistry();
    const ir = await readSource(registry, srcTool, srcSessionId, opts.srcRoot);
    const dsh = registry.get('dsh');
    const target = await writeTarget(dsh, ir, {
      root: opts.root,
      targetCwd: opts.targetCwd ?? ir.cwd,
      sessionId: opts.sessionId,
      flatten: opts.flatten,
      keepSynthetic: opts.keepSynthetic,
    });
    return { ok: true, source: { tool: srcTool, sessionId: srcSessionId }, target };
  } catch (e) {
    return { ok: false, error: `import ${srcTool}:${srcSessionId} failed: ${messageOf(e)}` };
  }
}
