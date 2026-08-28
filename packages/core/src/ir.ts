/**
 * Unified Intermediate Representation (IR) v2 — breaking rewrite.
 *
 * Pivot of the engine: every tool adapter reads its native storage into an IR
 * session and writes an IR session back. This is the sole N-adapter pivot
 * (not N² pairwise converters).
 *
 * v2 breaking changes vs v1:
 *  - ToolId gains 'pi' | 'opencode'
 *  - ContentBlock gains {type:'thinking'}
 *  - MigratedMessage loses toolCalls/toolResults convenience fields; provider/model/stopReason added
 *  - MigratedSidechain gains kind: SidechainKind + parentMessageId
 *  - MigratedSession: model is now {provider?, id, variant?}, schemaVersion required,
 *    plus thinkingLevel / systemPrompt / compaction / branchSummaries / extensions
 *  - validateSession / isMigratedMessage / messageToText / inferTitle updated accordingly
 */

export type ToolId = 'dsh' | 'claude' | 'codex' | 'opencode' | 'pi' | 'unknown';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'thinking'; thinking: string };

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface MigratedMessage {
  role: MessageRole;
  content: ContentBlock[];
  timestamp?: number;
  provider?: string;
  model?: string;
  stopReason?: string;
}

export type SidechainKind = 'subagent' | 'teammate';

export interface MigratedSidechain {
  agentId: string;
  kind: SidechainKind;
  agentType?: string;
  parentMessageId?: string;
  messages: MigratedMessage[];
}

/** Light metadata for a listed session (for GUI pickers / CLI --list). */
export interface SessionMeta {
  tool: ToolId;
  sessionId: string;
  title?: string;
  createdAt?: number;
  /** Absolute path of the source artifact, when known. */
  sourcePath?: string;
  /** Absolute working directory the session ran under (source). */
  cwd?: string;
}

export interface MigratedSession {
  schemaVersion: 1;
  originTool: ToolId;
  originSessionId?: string;
  title?: string;
  createdAt?: number;
  cwd?: string;
  model?: { provider?: string; id: string; variant?: string };
  thinkingLevel?: string;
  systemPrompt?: string;
  messages: MigratedMessage[];
  sidechains?: MigratedSidechain[];
  compaction?: Array<{ summary: string; tokensBefore?: number; retainedTail?: unknown[]; firstKeptId?: string }>;
  branchSummaries?: Array<{ fromId: string; summary: string }>;
  extensions?: Record<string, unknown>;
  raw?: unknown;
}

/* ------------------------------------------------------------------
 * Validation helpers
 * ------------------------------------------------------------------ */

export function isMigratedMessage(v: unknown): v is MigratedMessage {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool' && m.role !== 'system') return false;
  if (!Array.isArray(m.content)) return false;
  return true;
}

function isValidSidechain(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  if (typeof s.agentId !== 'string' || !s.agentId) return false;
  if (s.kind !== 'subagent' && s.kind !== 'teammate') return false;
  if (!Array.isArray(s.messages)) return false;
  for (const msg of s.messages as unknown[]) {
    if (!isMigratedMessage(msg)) return false;
  }
  return true;
}

export function validateSession(ir: MigratedSession): MigratedSession {
  if (!ir || typeof ir !== 'object') throw new Error('validateSession: ir is not an object');
  if (
    (ir as unknown as Record<string, unknown>).schemaVersion !== undefined &&
    (ir as unknown as Record<string, unknown>).schemaVersion !== 1
  ) {
    throw new Error('validateSession: schemaVersion must be 1');
  }
  if (!Array.isArray(ir.messages)) throw new Error('validateSession: messages must be an array');
  for (const [i, msg] of ir.messages.entries()) {
    if (!isMigratedMessage(msg)) throw new Error(`validateSession: message[${i}] is malformed`);
  }
  if (ir.sidechains !== undefined) {
    if (!Array.isArray(ir.sidechains)) throw new Error('validateSession: sidechains must be an array');
    for (const [i, sc] of ir.sidechains.entries()) {
      if (!isValidSidechain(sc)) throw new Error(`validateSession: sidechains[${i}] is malformed`);
    }
  }
  if (ir.model !== undefined) {
    if (typeof ir.model !== 'object' || ir.model === null || Array.isArray(ir.model)) {
      throw new Error('validateSession: model must be an object { id }');
    }
    const m = ir.model as Record<string, unknown>;
    if (typeof m.id !== 'string' || !m.id) throw new Error('validateSession: model.id must be a non-empty string');
  }
  return ir;
}

/** Fold a message's blocks into a plain-text digest (for offline preview). */
export function messageToText(msg: MigratedMessage): string {
  return msg.content
    .map((b) => {
      switch (b.type) {
        case 'text':
          return b.text;
        case 'tool_use':
          return `[tool_use: ${b.name}] ${safeJson(b.input)}`;
        case 'tool_result':
          return `[tool_result] ${b.content}`;
        case 'thinking':
          return `[thinking] ${b.thinking}`;
        default:
          return '';
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

/** Produce a one-line title if absent (used by GUI list). */
export function inferTitle(ir: MigratedSession): string {
  if (ir.title) return ir.title;
  const firstUser = ir.messages.find((m) => m.role === 'user');
  if (!firstUser) return '(untitled)';
  const text = messageToText(firstUser).trim().replace(/\s+/g, ' ');
  return text.length > 60 ? `${text.slice(0, 60)}…` : text || '(untitled)';
}
