/**
 * 会话流计算：PreviewMessageDTO[] → 展示项（FlowItem[]）。
 *
 * 融合规则照 DSH 会话视图：tool_use/tool_result 按 callId 融合成一行、
 * user+synthetic 归为注入、思考块成披露行。主会话与子代理旁链共用同一
 * 计算（TranscriptFlow 递归渲染时形状一致）。
 */
import MarkdownIt from 'markdown-it';
import type { PreviewBlockDTO, PreviewMessageDTO } from '../types.js';

export const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

export type FlowItem =
  | { kind: 'user'; key: string; ts?: number; text: string }
  | { kind: 'md'; key: string; ts?: number; html: string }
  | { kind: 'think'; key: string; ts?: number; text: string }
  | {
      kind: 'tool'; key: string; ts?: number;
      name: string; input: string | null; inputTruncated?: boolean;
      output: string | null; outputTruncated?: boolean; isError: boolean;
      /** tool_use 的调用 id（子代理「定位召唤处」按它滚动定位） */
      callId?: string;
    }
  | { kind: 'inject'; key: string; ts?: number; text: string };

export function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  return nl === -1 ? text : text.slice(0, nl);
}

const TOOL_TITLES: Record<string, string> = {
  Bash: '运行命令', Read: '读取文件', Write: '写入文件', Edit: '编辑文件',
  MultiEdit: '编辑文件', Grep: '搜索内容', Glob: '查找文件',
  WebSearch: '搜索网页', WebFetch: '抓取网页', Task: '派发子代理',
  TodoWrite: '更新待办', TodoRead: '读取待办', Computer: '控制电脑',
  Browser: '操作浏览器', NotebookEdit: '编辑 Notebook', Skill: '调用技能',
};

export function toolTitle(name: string): string {
  return TOOL_TITLES[name] ?? name;
}

/** 从 input JSON 里挑最有信息量的字段做单行摘要（DSH 的 summary 位）。 */
export function toolSummary(inputJson: string | null): string {
  if (!inputJson) return '';
  try {
    const o = JSON.parse(inputJson) as Record<string, unknown>;
    const pick = o.command ?? o.filePath ?? o.path ?? o.file ?? o.pattern ?? o.query
      ?? o.url ?? o.skill ?? o.description ?? o.prompt ?? o.todo ?? o.subject;
    const s = typeof pick === 'string' ? pick : inputJson;
    return s.replace(/\s+/g, ' ').trim();
  } catch {
    return inputJson.replace(/\s+/g, ' ').trim();
  }
}

export function toolIcon(name: string): 'terminal' | 'doc' | 'search' | 'box' {
  if (name === 'Bash') return 'terminal';
  if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') return 'doc';
  if (name === 'Grep' || name === 'Glob' || name === 'WebSearch' || name === 'WebFetch') return 'search';
  return 'box';
}

export function fmtFull(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function computeFlow(messages: PreviewMessageDTO[], prefix = 'm'): FlowItem[] {
  // 1) 收集全部 tool_result，按 callId 配对
  const resultByCall = new Map<string, PreviewBlockDTO>();
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
      if (m.synthetic) items.push({ kind: 'inject', key, ts, text: text || '（空）' });
      else if (text.trim()) items.push({ kind: 'user', key, ts, text });
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
        if (b.text?.trim()) items.push({ kind: 'md', key, ts, html: md.render(b.text) });
      } else if (b.t === 'think') {
        if (b.text?.trim()) items.push({ kind: 'think', key, ts, text: b.text });
      } else if (b.t === 'tool_use') {
        const result = b.callId ? resultByCall.get(b.callId) : undefined;
        if (b.callId) consumed.add(b.callId);
        items.push({
          kind: 'tool', key, ts,
          name: b.name ?? 'tool',
          input: b.text ?? null, inputTruncated: b.truncated,
          output: result?.text ?? null, outputTruncated: result?.truncated,
          isError: result?.isError ?? false,
          callId: b.callId,
        });
      } else if (b.t === 'tool_result') {
        if (b.callId && consumed.has(b.callId)) return; // 已融合进调用行
        items.push({
          kind: 'tool', key, ts, name: 'result',
          input: null, output: b.text ?? null, outputTruncated: b.truncated,
          isError: b.isError ?? false,
        });
      } else if (b.t === 'file') {
        const label = b.name ?? b.mediaType ?? '附件';
        items.push({ kind: 'md', key, ts, html: `<p class="pv-attach">附件 · ${md.utils.escapeHtml(label)}</p>` });
      }
    });
  });
  return items;
}
