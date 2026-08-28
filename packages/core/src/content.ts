/**
 * Shared content-normalization between tool formats and the IR.
 *
 * Each tool stores content blocks slightly differently (DSH/Claude use a
 * text/tool_use/tool_result block vocabulary; Codex uses Responses blocks).
 * These helpers fold those heterogeneous arrays into IR ContentBlock[] and
 * render IR blocks to plain text for offline preview.
 */

import type { ContentBlock } from './ir.js';

/**
 * Normalize an arbitrary content array into IR ContentBlock[].
 * Accepts: text strings, `{type:'text',text}`, `{type:'tool_use',...}`,
 * `{type:'tool_result',...}` (both `tool_use_id` and `toolUseId` spellings),
 * and best-effort fallbacks for unknown shapes.
 */
export function normalizeContent(content: unknown[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const c of content) {
    if (typeof c === 'object' && c !== null && !Array.isArray(c)) {
      const block = c as Record<string, unknown>;
      const type = block.type as string;
      if (type === 'text') {
        out.push({ type: 'text', text: String(block.text ?? '') });
      } else if (type === 'tool_use') {
        out.push({
          type: 'tool_use',
          id: String(block.id ?? cryptoIdFallback(out)),
          name: String(block.name ?? 'tool'),
          input: block.input,
        });
      } else if (type === 'tool_result') {
        const toolUseId = String(block.tool_use_id ?? block.toolUseId ?? block.id ?? '');
        const inner = block.content;
        const text = typeof inner === 'string' ? inner : JSON.stringify(inner ?? '');
        out.push({
          type: 'tool_result',
          toolUseId,
          content: text,
          isError: Boolean(block.is_error ?? block.isError),
        });
      } else if (type === 'image') {
        // keep as text note; content bytes are not carried into IR
        out.push({ type: 'text', text: '[image block omitted]' });
      } else {
        const maybe = block.text ?? block.content;
        if (typeof maybe === 'string') out.push({ type: 'text', text: maybe });
        else out.push({ type: 'text', text: JSON.stringify(block) });
      }
    } else if (typeof c === 'string') {
      out.push({ type: 'text', text: c });
    }
  }
  return out;
}

let ___cryptoCounter = 0;
function cryptoIdFallback(blocks: ContentBlock[]): string {
  ___cryptoCounter += 1;
  return `blk_${___cryptoCounter}`;
}

/** Render IR blocks to plain text (used by preview + title inference). */
export function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'text':
          return b.text;
        case 'tool_use':
          return `[tool_use: ${b.name}] ${safeJson(b.input)}`;
        case 'tool_result':
          return `[tool_result] ${b.content}`;
      }
    })
    .filter(Boolean)
    .join('\n');
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s && s.length > 200 ? `${s.slice(0, 200)}…` : (s ?? '');
  } catch {
    return String(v);
  }
}

/** Convert IR blocks back into a tool's content shape (Claude/DSH vocabulary). */
export function blocksToNative(blocks: ContentBlock[]): unknown[] {
  return blocks.map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    return { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, is_error: b.isError };
  });
}