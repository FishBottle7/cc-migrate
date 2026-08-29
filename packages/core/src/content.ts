/**
 * Shared content-normalization between tool formats and the IR v2.
 *
 * Each tool stores content blocks slightly differently (DSH/Claude use a
 * text/tool_use/tool_result/thinking block vocabulary; Codex uses Responses blocks).
 * These helpers fold those heterogeneous arrays into IR ContentBlock[] and
 * render IR blocks to plain text for offline preview.
 */

import type { ContentBlock, FileBlock } from './ir.js';

/**
 * Normalize an arbitrary content array into IR ContentBlock[].
 * Accepts: text strings, `{type:'text',text}`, `{type:'tool_use',id,name,input}`,
 * `{type:'tool_result',toolUseId/content[,content-array with images]}`,
 * `{type:'thinking',thinking[,signature]}`, image/file blocks, and best-effort
 * fallbacks. Images/files are preserved as FileBlocks (never flattened).
 */
export function normalizeContent(content: unknown[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const c of content) {
    if (typeof c === 'object' && c !== null && !Array.isArray(c)) {
      const block = c as Record<string, unknown>;
      const type = block.type as string;
      if (type === 'text') {
        out.push({ type: 'text', text: String(block.text ?? '') });
      } else if (type === 'thinking') {
        const thinking = String(block.thinking ?? block.text ?? '');
        const signature = typeof block.signature === 'string' && block.signature ? block.signature : undefined;
        out.push(signature ? { type: 'thinking', thinking, signature } : { type: 'thinking', thinking });
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
        let text: string;
        let attachments: FileBlock[] | undefined;
        if (typeof inner === 'string') {
          text = inner;
        } else if (Array.isArray(inner)) {
          const texts: string[] = [];
          attachments = [];
          for (const piece of inner) {
            if (typeof piece === 'string') { texts.push(piece); continue; }
            const p = piece as Record<string, unknown>;
            if (p.type === 'text' && typeof p.text === 'string') { texts.push(p.text); continue; }
            const file = toFileBlock(piece);
            if (file) attachments.push(file);
            else texts.push(JSON.stringify(piece));
          }
          if (!attachments.length) attachments = undefined;
          text = texts.join('\n');
        } else {
          text = JSON.stringify(inner ?? '');
        }
        out.push(attachments
          ? { type: 'tool_result', toolUseId, content: text, isError: Boolean(block.is_error ?? block.isError), attachments }
          : { type: 'tool_result', toolUseId, content: text, isError: Boolean(block.is_error ?? block.isError) });
      } else if (type === 'image' || type === 'file') {
        const file = toFileBlock(block);
        if (file) out.push(file);
        else out.push({ type: 'text', text: `[file omitted]` });
      } else {
        const maybe = block.text ?? block.content;
        if (typeof maybe === 'string') out.push({ type: 'text', text: maybe });
        else if (typeof block.thinking === 'string') out.push({ type: 'thinking', thinking: block.thinking });
        else out.push({ type: 'text', text: JSON.stringify(block) });
      }
    } else if (typeof c === 'string') {
      out.push({ type: 'text', text: c });
    }
  }
  return out;
}

/** Claude/anthropic image shapes + generic file blocks → IR FileBlock. */
function toFileBlock(v: unknown): FileBlock | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const b = v as Record<string, unknown>;
  if (b.type !== 'image' && b.type !== 'file') return undefined;
  const src = (b.source && typeof b.source === 'object' && !Array.isArray(b.source)) ? b.source as Record<string, unknown> : undefined;
  const mediaType = typeof b.mediaType === 'string' ? b.mediaType
    : typeof src?.media_type === 'string' ? src.media_type
    : typeof b.mime === 'string' ? b.mime
    : b.type === 'image' ? 'image/png' : undefined;
  const data = typeof b.data === 'string' ? b.data : typeof src?.data === 'string' ? src.data : undefined;
  const url = typeof b.url === 'string' ? b.url : typeof src?.url === 'string' ? src.url : undefined;
  const filename = typeof b.filename === 'string' ? b.filename : typeof b.name === 'string' ? b.name : undefined;
  const out: FileBlock = { type: 'file' };
  if (filename) out.filename = filename;
  if (mediaType) out.mediaType = mediaType;
  if (data) out.data = data;
  if (url) out.url = url;
  return (out.filename || out.mediaType || out.data || out.url) ? out : undefined;
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
          return b.attachments?.length
            ? `${`[tool_result] ${b.content}`}\n${b.attachments.map(fileLabel).join('\n')}`
            : `[tool_result] ${b.content}`;
        case 'thinking':
          return `[thinking] ${b.thinking}`;
        case 'file':
          return fileLabel(b);
      }
    })
    .filter(Boolean)
    .join('\n');
}

function fileLabel(b: { filename?: string; mediaType?: string; url?: string }): string {
  const name = b.filename ?? b.mediaType ?? (b.url ? 'file' : '');
  return `[file${name ? `: ${name}` : ''}]`;
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
    if (b.type === 'thinking') return b.signature ? { type: 'thinking', thinking: b.thinking, signature: b.signature } : { type: 'thinking', thinking: b.thinking };
    if (b.type === 'file') return fileToNative(b);
    const result: Record<string, unknown> = { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, is_error: b.isError };
    if (b.attachments?.length) {
      // anthropic-style: tool_result content may be an array carrying images
      result.content = [{ type: 'text', text: b.content }, ...b.attachments.map(fileToNative)];
    }
    return result;
  });
}

/** FileBlock → anthropic image block (inline base64 / url) or a text fallback. */
function fileToNative(b: FileBlock): unknown {
  const mediaType = b.mediaType ?? (b.data || b.url ? 'application/octet-stream' : undefined);
  if (b.data) return { type: 'image', source: { type: 'base64', media_type: mediaType, data: b.data } };
  if (b.url) return { type: 'image', source: { type: 'url', url: b.url } };
  return { type: 'text', text: `[file${b.filename ? `: ${b.filename}` : ''}]` };
}
