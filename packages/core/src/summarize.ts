/**
 * Context-safe session digest.
 *
 * Agents that drive cc-migrate conversationally must decide「是不是这条会话？」
 * without pulling a transcript into their context window (a large session can
 * be MBs — that is a context blowout, not a preview). This module projects an
 * already-parsed IR into a strictly bounded digest: counts, small excerpts,
 * no tool payloads. Every string field is capped; the whole digest stays in
 * the low KBs regardless of session size.
 *
 * This is engine-level (not CLI sugar) so the standalone CLI, the DSH plugin's
 * agent CLI and any future GUI share one bounded contract.
 */

import type { MigratedSession, ContentBlock, MessageRole } from './ir.js';

/** 单条摘录上限（字符）——保证摘要整体在低 KB 量级。 */
export const DIGEST_EXCERPT_CAP = 200;
/** 默认携带的「开头用户消息」条数。 */
export const DIGEST_FIRST_USER_DEFAULT = 3;

export interface DigestOptions {
  /** 开头用户消息摘录条数（0-20；默认 3）。 */
  firstUserMessages?: number;
  /** 单条摘录字符上限（默认/上限 200，最大允许 1000 —— 调大也不该放进上下文）。 */
  excerptCap?: number;
}

export interface SessionDigest {
  tool: string;
  sessionId: string;
  title?: string;
  createdAt?: number;
  /** 最后一条带文本消息的时间（约等于会话结束时间；缺序时缺失）。 */
  endedAt?: number;
  cwd?: string;
  model?: string;
  stats: {
    messages: number;
    /** 非 synthetic 且带正文的用户输入条数（即「人说了几句话」）。 */
    userTurns: number;
    toolUseBlocks: number;
    /** 主干之外的子代理/队友旁链条数。 */
    sidechains: number;
    /** 全部文本块字符总量 —— 体量感知：该迁移而不是该预览全文。 */
    textChars: number;
  };
  /** 开头几条人类输入摘录（跳过 synthetic 注入与 tool_result 行）。 */
  firstUserMessages: string[];
  /** 收尾摘录（最后一条带文本、非 synthetic 的消息）。 */
  lastMessage?: { role: MessageRole; text: string };
}

/** 提取一条消息里人类可读的文本（text 块拼接；tool_result/thinking/file 不算话术）。 */
function readableText(blocks: ContentBlock[]): string {
  let out = '';
  for (const b of blocks) {
    if (b.type === 'text' && b.text) {
      if (out) out += '\n';
      out += b.text;
    }
  }
  return out;
}

/** 摘录用截断：压平空白（标题里的换行/缩进最占上下文），超长加省略号。 */
function excerpt(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > cap ? `${flat.slice(0, Math.max(0, cap - 1))}…` : flat;
}

/** IR → 有界摘要。纯同步、零 IO；ir 必须已 parse（readSource 之后）。 */
export function summarizeIr(ir: MigratedSession, opts: DigestOptions = {}): SessionDigest {
  const cap = Math.min(Math.max(opts.excerptCap ?? DIGEST_EXCERPT_CAP, 20), 1000);
  const firstCount = Math.min(Math.max(opts.firstUserMessages ?? DIGEST_FIRST_USER_DEFAULT, 0), 20);

  const firstUser: string[] = [];
  let last: { role: MessageRole; text: string } | undefined;
  let textChars = 0;
  let toolUseBlocks = 0;
  let userTurns = 0;
  let endedAt: number | undefined;

  for (const m of ir.messages) {
    for (const b of m.content) {
      if (b.type === 'text') textChars += b.text.length;
      else if (b.type === 'tool_use') toolUseBlocks++;
    }
    const text = readableText(m.content);
    if (m.timestamp !== undefined) endedAt = m.timestamp;
    if (!text.trim()) continue;
    if (!m.synthetic && m.role === 'user') {
      userTurns++;
      if (firstUser.length < firstCount) firstUser.push(excerpt(text, cap));
    }
    if (!m.synthetic) last = { role: m.role, text: excerpt(text, cap) };
  }

  let sidechains = ir.sidechains?.length ?? 0;
  for (const sc of ir.sidechains ?? []) {
    // 孙代拍平计数（与 GUI 的旁链树同一口径：一层主干 + N 节点）
    sidechains += countNested(sc.sidechains);
  }

  return {
    tool: ir.originTool,
    sessionId: ir.originSessionId ?? '',
    ...(ir.title ? { title: excerpt(ir.title, Math.max(cap, 120)) } : {}),
    ...(ir.createdAt !== undefined ? { createdAt: ir.createdAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(ir.cwd ? { cwd: ir.cwd } : {}),
    ...(ir.model?.id ? { model: ir.model.id } : {}),
    stats: {
      messages: ir.messages.length,
      userTurns,
      toolUseBlocks,
      sidechains,
      textChars,
    },
    firstUserMessages: firstUser,
    ...(last ? { lastMessage: last } : {}),
  };
}

function countNested(list: MigratedSession['sidechains']): number {
  let n = list?.length ?? 0;
  for (const sc of list ?? []) n += countNested(sc.sidechains);
  return n;
}
