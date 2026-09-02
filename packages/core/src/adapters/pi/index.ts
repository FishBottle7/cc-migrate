/**
 * Pi adapter — reads/writes `~/.pi/agent/sessions/--<path>--/<ts>_<uuid>.jsonl`.
 *
 * Rewritten 2026-09-02 against the pi-main 0.84.3 deep-dive contract
 * (docs/agents/pi.md — binding). Highlights:
 *  - Read side is ZERO-DROP (v3「除加密外零丢弃」): all ten v3 entry types
 *    project into the IR (messages/compaction/branchSummaries/title/meta.pi.*).
 *    The seven pi message roles all project explicitly (bashExecution/custom/
 *    branchSummary/compactionSummary never fall through); assistant fields with
 *    no IR slot ride `meta.pi.message` on the message entity.
 *  - Leaf path = walk `parentId` from the LAST ENTRY in the file (pi's
 *    `_buildIndex` semantics), not the last *message* entry; off-path message
 *    entries group into sidechains by branch root.
 *  - compaction/branch_summary are dual-carrier (anchor contract): bucket
 *    entry + a synthetic user message in messages[] rendered with pi's native
 *    prefix/suffix; `anchorIndex` ties them. Write-back consumes the bucket and
 *    SKIPS the anchor message (no double write).
 *  - Write side consumes ir.compaction/ir.branchSummaries into native entries.
 *    Compaction `firstKeptEntryId` must point at an entry id that exists in the
 *    file (a fabricated pointer degrades buildContextEntries to the tail); the
 *    anchor message's own entry id is skipped. Cross-tool folded spans are
 *    archived in full (选 3, pi.md §8.2 — never fabricate a cut point).
 *  - System prompt: pi session files store no prompt text (runtime rebuilds
 *    from SYSTEM.md/APPEND_SYSTEM.md/AGENTS.md, pi.md §9). Read side leaves
 *    `ir.systemPrompt` empty; write side NEVER injects it (double-stack ban).
 *  - v4 harness files (`kind:'header'` first line) are detected and refused
 *    with an explicit "unsupported" error — never silently dropped or
 *    half-parsed (pi.md §7).
 *  - Red lines: read-only on source files (never pi's own `open` chain — it
 *    rewrites old files in place); no unlink/rm/trash anywhere; writes go to a
 *    brand-new file created exclusively (`wx`).
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Adapter, WriteOptions, WriteResult } from '../../registry.js';
import type { ContentBlock, FileBlock, MigratedBranchSummary, MigratedCompaction, MigratedMessage, MigratedSession, SessionMeta } from '../../ir.js';
import { IR_VERSION, validateSession } from '../../ir.js';
import { blocksToText, normalizeContent } from '../../content.js';

type PiEntryType =
  | 'session'
  | 'message'
  | 'compaction'
  | 'branch_summary'
  | 'custom_message'
  | 'model_change'
  | 'thinking_level_change'
  | 'custom'
  | 'label'
  | 'session_info';

interface PiHeader {
  type: 'session';
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

/** Any non-header v3 entry (the base fields + a union of the loose payloads). */
interface PiEntry {
  type: PiEntryType;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: { role?: string } & Record<string, unknown>;
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  retainedTail?: unknown;
  fromId?: string;
  customType?: string;
  data?: unknown;
  content?: unknown;
  display?: boolean;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  targetId?: string;
  /** LabelEntry: `undefined` = absent, `null` = explicit clear (appendLabelChange) */
  label?: string | null;
  name?: string;
  details?: unknown;
  usage?: unknown;
  fromHook?: boolean;
}

const PI_CURRENT_VERSION = 3;

/** pi's own context renderings (messages.ts:11-24) — the anchor message text must be byte-faithful to what pi's convertToLlm produces. */
const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;
const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;
const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/** marker under meta.pi.* identifying a bucket-projected anchor message. */
type PiAnchorKind = 'compaction' | 'branch_summary';

interface PiMessageMeta {
  toolName?: string;
  details?: unknown;
  message?: Record<string, unknown>;
  bash?: Record<string, unknown>;
  customMessage?: Record<string, unknown>;
  anchor?: { kind: PiAnchorKind; entryId: string };
  addedToolNames?: unknown;
  usage?: unknown;
}

interface PiSessionMeta {
  header?: Record<string, unknown>;
  settingsEvents?: Array<Record<string, unknown>>;
  labels?: Array<{ targetId: string; label?: string; time: number }>;
  customEntries?: Array<{ customType: string; data?: unknown; time: number }>;
  titleCleared?: boolean;
}

function piProjectKey(cwd: string): string {
  // session-manager.ts:479 : --<path with / \: : -> ->-- (leading separators stripped once)
  const inner = cwd.replace(/^[/\\]+/, '').replace(/[/\\:]/g, '-');
  return `--${inner}--`;
}

function generateId(existing: Set<string>): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8);
    if (!existing.has(id)) return id;
  }
  return randomUUID().slice(0, 8);
}

function toEpochMs(iso: unknown): number | undefined {
  if (typeof iso !== 'string' || !iso) return undefined;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class PiAdapter implements Adapter {
  readonly tool = 'pi' as const;
  readonly irVersion = IR_VERSION;

  async parse(sessionId: string, root?: string): Promise<MigratedSession> {
    const sessionsDir = root ?? defaultPiSessionsDir();
    if (!sessionsDir) throw new Error('Pi: cannot resolve ~/.pi/agent/sessions');
    const path = await findPiFile(sessionsDir, sessionId);
    if (!path) throw new Error(`Pi: session "${sessionId}" not found under ${sessionsDir}`);
    return parsePiFile(path);
  }

  async write(ir: MigratedSession, opts?: WriteOptions): Promise<WriteResult> {
    validateSession(ir);
    const sessionsDir = opts?.root ?? defaultPiSessionsDir();
    if (!sessionsDir) throw new Error('Pi: cannot resolve ~/.pi/agent/sessions');
    const cwd = opts?.targetCwd ?? ir.cwd ?? '';

    // v3.2 #8 / pi.md §9: pi has no session-level system-prompt slot — the
    // runtime rebuilds its prompt from SYSTEM.md/APPEND_SYSTEM.md/AGENTS.md on
    // every launch. Writing the source prompt into the body would stack it on
    // top of pi's own (double-stack ban). Never inject, whatever the source.
    void ir.systemPrompt;

    const newId = opts?.sessionId ?? randomUUID();
    const iso = new Date(ir.createdAt ?? Date.now()).toISOString();
    const fileTs = iso.replace(/[:.]/g, '-');
    const projectDir = join(sessionsDir, piProjectKey(cwd));

    await fs.mkdir(projectDir, { recursive: true });
    const filePath = join(projectDir, `${fileTs}_${newId}.jsonl`);

    const header: PiHeader = {
      type: 'session',
      version: PI_CURRENT_VERSION,
      id: newId,
      timestamp: iso,
      cwd: cwd || '',
    };
    // fork provenance (pi.md §8 #10): parentSession points at the SOURCE FILE
    // path (not a session id) — keep the pointer semantics pi itself uses.
    const piHeaderMeta = (ir.meta as { pi?: PiSessionMeta } | undefined)?.pi;
    const parentSession = typeof piHeaderMeta?.header?.parentSession === 'string' ? piHeaderMeta.header.parentSession : undefined;
    if (parentSession) header.parentSession = parentSession;

    const byId = new Set<string>();
    const lines: string[] = [JSON.stringify(header)];
    let parentId: string | null = null;
    const appendLine = (entry: PiEntry): void => {
      lines.push(JSON.stringify(entry));
    };
    const nextId = (): string => {
      const id = generateId(byId);
      byId.add(id);
      return id;
    };
    const entryTimestamp = (t: number | undefined, fallback = Date.now()): string =>
      new Date(typeof t === 'number' && Number.isFinite(t) ? t : fallback).toISOString();

    // --- main chain: messages → native entries --------------------------------
    // Write order = tree order, so the LAST entry is the leaf and pi's resume
    // picks up everything (pi.md §4 主链判定). Compaction/branch_summary from
    // the IR buckets are appended AFTER the main chain, at their anchorIndex
    // position — but their tree position is linear append, so we re-derive:
    // native files carry them inline at the source position; on write-back we
    // append them after the messages they follow (anchorIndex order), which
    // preserves their relative order. The bucket's native remnants (meta)
    // round-trip the details/usage/fromHook payload.
    const compactionByAnchor = new Map<number, MigratedCompaction>();
    for (const c of ir.compaction ?? []) {
      if (typeof c.anchorIndex === 'number') compactionByAnchor.set(c.anchorIndex, c);
    }
    const branchByAnchor = new Map<number, MigratedBranchSummary>();
    for (const bs of ir.branchSummaries ?? []) {
      if (typeof bs.anchorIndex === 'number') branchByAnchor.set(bs.anchorIndex, bs);
    }

    // Must contain at least one assistant message or Pi never flushes (_persist
    // guard, sm.ts:1019) — keep the placeholder-row fallback.
    const needsAssistant = !ir.messages.some((m) => m.role === 'assistant');
    const writeMessages = needsAssistant
      ? [...ir.messages, { role: 'assistant' as const, content: [{ type: 'text' as const, text: '(migrated session — continuation)' }] }]
      : ir.messages;

    // entry id → original message identity (for label target remapping)
    const entryIdByMsg = new Map<MigratedMessage, string>();

    for (const [msgIdx, msg] of writeMessages.entries()) {
      const pim = (msg.meta as { pi?: PiMessageMeta } | undefined)?.pi;
      if (!pim?.anchor) {
        const id = nextId();
        entryIdByMsg.set(msg, id);
        appendLine({
          type: 'message',
          id,
          parentId,
          timestamp: entryTimestamp(msg.timestamp),
          message: piMessageFromMigrated(msg),
        });
        parentId = id;
      }
      // An anchor message (meta.pi.anchor) is the rendered projection of a
      // bucket entry — writing BOTH would duplicate the summary in pi's
      // context. The bucket twin at this index is what becomes the native
      // entry (anchor contract, pi.md §8.2 写回 pi：桶→原生 entry，anchor 消息跳过);
      // bucket entries without an anchor twin (dsh/zcode/claude sources) also
      // land here at their recorded position.
      const comp = compactionByAnchor.get(msgIdx);
      if (comp) {
        const cid = nextId();
        const cMeta = comp.meta as { entryId?: string; details?: unknown; usage?: unknown; fromHook?: boolean; entryTimestamp?: string } | undefined;
        appendLine({
          type: 'compaction',
          id: cid,
          parentId,
          timestamp: cMeta?.entryTimestamp ?? entryTimestamp(undefined),
          summary: comp.summary,
          // firstKeptEntryId must reference an entry that EXISTS in this file
          // (sm.ts:418 buildContextEntries: a dangling pointer keeps
          // foundFirstKept forever false and the active surface degrades to
          // the post-compaction tail). Cross-tool compactions carry a source
          // cut point we cannot honestly replicate (选 3: full archive, no
          // fabricated cut) — so we anchor the "kept" span at the compaction's
          // own parent: everything from there on stays visible next to the
          // summary. That is a REAL entry id, keeping pi's fold machinery intact.
          firstKeptEntryId: parentId!,
          tokensBefore: typeof comp.tokensBefore === 'number' ? comp.tokensBefore : 0,
          ...(cMeta?.details !== undefined ? { details: cMeta.details } : {}),
          ...(cMeta?.usage !== undefined ? { usage: cMeta.usage } : {}),
          ...(cMeta?.fromHook !== undefined ? { fromHook: cMeta.fromHook } : {}),
        });
        parentId = cid;
      }
      const bs = branchByAnchor.get(msgIdx);
      if (bs) {
        const bid = nextId();
        const bMeta = bs.meta as { details?: unknown; usage?: unknown; fromHook?: boolean; entryId?: string; entryTimestamp?: string } | undefined;
        appendLine({
          type: 'branch_summary',
          id: bid,
          parentId,
          timestamp: bMeta?.entryTimestamp ?? entryTimestamp(undefined),
          fromId: bs.fromId,
          summary: bs.summary,
          ...(bMeta?.details !== undefined ? { details: bMeta.details } : {}),
          ...(bMeta?.usage !== undefined ? { usage: bMeta.usage } : {}),
          ...(bMeta?.fromHook !== undefined ? { fromHook: bMeta.fromHook } : {}),
        });
        parentId = bid;
      }
    }

    // --- settings events (model_change / thinking_level_change replay) --------
    // Full sequence from meta.pi.settingsEvents (pi.md §8 #4). Native files
    // replay them inline at their historical positions; the IR keeps the
    // sequence — write-back replays in order after the main chain. When the
    // session has no recorded events (cross-tool), the derived ir.model /
    // ir.thinkingLevel still get a final-state entry so resume derives them.
    const settingsEvents = piHeaderMeta?.settingsEvents;
    if (Array.isArray(settingsEvents) && settingsEvents.length > 0) {
      for (const ev of settingsEvents) {
        if (!isRecord(ev)) continue;
        const time = typeof ev.time === 'number' ? ev.time : undefined;
        if (ev.type === 'model_change' && typeof ev.provider === 'string' && typeof ev.modelId === 'string') {
          const id = nextId();
          appendLine({ type: 'model_change', id, parentId, timestamp: entryTimestamp(time), provider: ev.provider, modelId: ev.modelId });
          parentId = id;
        } else if (ev.type === 'thinking_level_change' && typeof ev.thinkingLevel === 'string') {
          const id = nextId();
          appendLine({ type: 'thinking_level_change', id, parentId, timestamp: entryTimestamp(time), thinkingLevel: ev.thinkingLevel });
          parentId = id;
        }
      }
    } else {
      // no sequence recorded — emit the derived final state (pre-v3.3 shape)
      if (ir.thinkingLevel) {
        const id = nextId();
        appendLine({ type: 'thinking_level_change', id, parentId, timestamp: entryTimestamp(undefined), thinkingLevel: ir.thinkingLevel });
        parentId = id;
      }
      if (ir.model?.provider || ir.model?.id) {
        const id = nextId();
        appendLine({ type: 'model_change', id, parentId, timestamp: entryTimestamp(undefined), provider: ir.model.provider ?? 'unknown', modelId: ir.model.id ?? 'unknown' });
        parentId = id;
      }
    }

    // --- sidechains → sibling branches (pi.md §6 写端契约) ---------------------
    // Each sidechain forks off the FIRST main-chain entry (append-order
    // siblings after the main branch — a legal tree shape in pi) and ends with
    // a branch_summary tagging it as migrated. Sibling branches stay out of
    // the leaf path, so pi's resume context keeps the main chain active.
    if (ir.sidechains?.length) {
      const mainFirstId = entryIdByMsg.get(writeMessages[0]) ?? null;
      for (const sc of ir.sidechains) {
        if (!sc.messages.length) continue;
        let branchParent = mainFirstId;
        let branchLeaf = branchParent;
        for (const msg of sc.messages) {
          const pim = (msg.meta as { pi?: PiMessageMeta } | undefined)?.pi;
          if (pim?.anchor) continue; // anchor twin — bucket side provides the entry
          const bid = nextId();
          appendLine({
            type: 'message',
            id: bid,
            parentId: branchParent,
            timestamp: entryTimestamp(msg.timestamp),
            message: piMessageFromMigrated(msg),
          });
          branchParent = bid;
          branchLeaf = bid;
        }
        const sid = nextId();
        const summaryText = sc.agentType ? `sidechain ${sc.agentId} (${sc.agentType})` : `sidechain ${sc.agentId} (${sc.kind})`;
        appendLine({
          type: 'branch_summary',
          id: sid,
          parentId: branchLeaf,
          timestamp: entryTimestamp(undefined),
          fromId: branchLeaf ?? sid,
          summary: summaryText,
        });
      }
    }

    // --- labels / custom entries / session_info --------------------------------
    const labels = piHeaderMeta?.labels;
    if (Array.isArray(labels)) {
      for (const l of labels) {
        if (!isRecord(l)) continue;
        // pi's appendLabelChange guards byId.has(targetId) — only write labels
        // whose target survived into this file (an entry id we generated).
        if (typeof l.targetId !== 'string' || !byId.has(l.targetId)) continue;
        const id = nextId();
        // clear semantics ride an explicit `label: null` row (pi.md §12 —
        // `undefined` and absent serialize identically, so the clear must be
        // a PRESENT null/empty value)
        const labelEntry: PiEntry = {
          type: 'label',
          id,
          parentId,
          timestamp: entryTimestamp(l.time),
          targetId: l.targetId,
          label: undefined,
        };
        labelEntry.label = typeof l.label === 'string' && l.label ? l.label : null;
        appendLine(labelEntry);
        parentId = id;
      }
    }
    const customEntries = piHeaderMeta?.customEntries;
    if (Array.isArray(customEntries)) {
      for (const ce of customEntries) {
        if (!isRecord(ce) || typeof ce.customType !== 'string') continue;
        const id = nextId();
        appendLine({
          type: 'custom',
          id,
          parentId,
          timestamp: entryTimestamp(ce.time),
          customType: ce.customType,
          ...(ce.data !== undefined ? { data: ce.data } : {}),
        });
        parentId = id;
      }
    }
    // title: latest non-empty session_info wins in pi (getSessionName walks in
    // reverse); explicit clears ride an empty-name row (pi.md §8 #3).
    if (ir.title) {
      const id = nextId();
      appendLine({ type: 'session_info', id, parentId, timestamp: entryTimestamp(undefined), name: ir.title });
      parentId = id;
    } else if (piHeaderMeta?.titleCleared === true) {
      const id = nextId();
      appendLine({ type: 'session_info', id, parentId, timestamp: entryTimestamp(undefined), name: '' });
      parentId = id;
    }

    // Exclusive create (wx): migration never overwrites anything — a colliding
    // name means something unexpected is already there; refuse loudly.
    await fs.writeFile(filePath, lines.join('\n') + '\n', { encoding: 'utf8', flag: 'wx' });
    return { tool: 'pi', sessionId: newId, paths: [filePath] };
  }

  async listSessions(root?: string): Promise<SessionMeta[]> {
    const sessionsDir = root ?? defaultPiSessionsDir();
    if (!sessionsDir) return [];
    const metas: SessionMeta[] = [];
    let projects: string[];
    try {
      projects = await fs.readdir(sessionsDir);
    } catch {
      return [];
    }
    for (const proj of projects) {
      const projDir = join(sessionsDir, proj);
      let entries: string[];
      try {
        entries = await fs.readdir(projDir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue;
        const full = join(projDir, name);
        try {
          const st = await fs.stat(full);
          // extract id from <ts>_<uuid>.jsonl -> uuid part
          const under = name.lastIndexOf('_');
          const sid = under >= 0 ? name.slice(under + 1, -'.jsonl'.length) : name.slice(0, -'.jsonl'.length);
          metas.push({ tool: 'pi', sessionId: sid, createdAt: st.mtimeMs, sourcePath: full });
        } catch { /* skip */ }
      }
    }
    return metas;
  }

  preview(session: MigratedSession): string {
    const main = session.messages.map((m) => `[${m.role}]\n${blocksToText(m.content)}`).join('\n\n');
    if (!session.sidechains?.length) return main;
    const branches = session.sidechains
      .map((sc) => `[sidechain: ${sc.agentId} (${sc.kind})]\n${sc.messages.map((m) => blocksToText(m.content)).join('\n')}`)
      .join('\n\n');
    return `${main}\n\n${branches}`;
  }
}

function defaultPiSessionsDir(): string | null {
  // Allow override via env (config.ts: PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR)
  const override = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (override && override.trim()) return override.trim();
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (agentDir && agentDir.trim()) return join(agentDir.trim(), 'sessions');
  const home = process.env.HOME || (process.env.USERPROFILE ?? null);
  if (!home) return null;
  // pi-main default: ~/.pi/agent/sessions (config.ts: getSessionsDir)
  return join(home, '.pi', 'agent', 'sessions');
}

async function findPiFile(sessionsDir: string, sessionId: string): Promise<string | null> {
  // fast: search by suffix _<sessionId>.jsonl across project dirs
  let projects: string[];
  try {
    projects = await fs.readdir(sessionsDir);
  } catch {
    return null;
  }
  for (const proj of projects) {
    const projDir = join(sessionsDir, proj);
    let files: string[];
    try {
      files = await fs.readdir(projDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const under = f.lastIndexOf('_');
      const id = under >= 0 ? f.slice(under + 1, -'.jsonl'.length) : f.slice(0, -'.jsonl'.length);
      if (id === sessionId) return join(projDir, f);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Read side: pi message payload → IR (all seven roles project explicitly)
 * ------------------------------------------------------------------ */

/**
 * pi's context renderings of bash executions (messages.ts:82 bashExecutionToText)
 * — the anchor/projection text must be identical to what pi itself feeds the LLM.
 */
function bashExecutionToText(msg: { command: string; output: string; exitCode?: number; cancelled: boolean; truncated: boolean; fullOutputPath?: string }): string {
  let text = `Ran \`${msg.command}\`\n`;
  if (msg.output) {
    text += `\`\`\`\n${msg.output}\n\`\`\``;
  } else {
    text += '(no output)';
  }
  if (msg.cancelled) {
    text += '\n\n(command cancelled)';
  } else if (typeof msg.exitCode === 'number' && msg.exitCode !== 0) {
    text += `\n\nCommand exited with code ${msg.exitCode}`;
  }
  if (msg.truncated && msg.fullOutputPath) {
    text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
  }
  return text;
}

/**
 * One pi message payload → IR. The seven pi roles each get an explicit branch
 * (pi.md §3 — no fall-through):
 *  - user/assistant fold via the shared block vocabulary (toolCall→tool_use,
 *    message-level pairing ids restored on toolResult);
 *  - bashExecution/custom → user rows (their native context shape) with the
 *    full native payload preserved under meta.pi + synthetic:true;
 *  - branchSummary/compactionSummary DO NOT project here — their entry-level
 *    twins go through the anchor path (entryToAnchorMessage); a stray message
 *    entry carrying one of these roles (hand-edited / extension-injected)
 *    degrades to a user text row rather than being dropped.
 */
function piMessageToIr(raw: Record<string, unknown>, entryMeta?: PiEntry): MigratedMessage | null {
  const ts = typeof raw.timestamp === 'number' ? raw.timestamp : undefined;
  const role = raw.role;

  if (role === 'toolResult') {
    const arr = Array.isArray(raw.content) ? raw.content : typeof raw.content === 'string' ? [{ type: 'text', text: raw.content }] : [];
    const inner = normalizeContent(arr);
    const text = inner
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const attachments = inner.filter((b): b is FileBlock => b.type === 'file');
    const block: ContentBlock & { attachments?: FileBlock[] } = {
      type: 'tool_result',
      toolUseId: String(raw.toolCallId ?? ''),
      content: text,
      isError: raw.isError === true,
    };
    if (attachments.length) block.attachments = attachments;
    const msg: MigratedMessage = { role: 'tool', content: [block] };
    if (ts !== undefined) msg.timestamp = ts;
    const meta: PiMessageMeta = {};
    if (typeof raw.toolName === 'string' && raw.toolName) meta.toolName = raw.toolName;
    if (raw.details !== undefined) meta.details = raw.details;
    // v3.3 (pi.md §8 #12): toolResult.usage + addedToolNames preserved
    if (raw.usage !== undefined) meta.usage = raw.usage;
    if (raw.addedToolNames !== undefined) meta.addedToolNames = raw.addedToolNames;
    if (Object.keys(meta).length) msg.meta = { pi: meta };
    return msg;
  }

  if (role === 'bashExecution') {
    // native context projection (messages.ts:152): user row with
    // bashExecutionToText — record even excludeFromContext rows (the IR keeps
    // them; write-back restores the flag, pi.md §8 #9).
    const text = bashExecutionToText({
      command: String(raw.command ?? ''),
      output: String(raw.output ?? ''),
      exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : undefined,
      cancelled: raw.cancelled === true,
      truncated: raw.truncated === true,
      fullOutputPath: typeof raw.fullOutputPath === 'string' ? raw.fullOutputPath : undefined,
    });
    const msg: MigratedMessage = { role: 'user', content: [{ type: 'text', text }] };
    if (ts !== undefined) msg.timestamp = ts;
    msg.synthetic = true;
    const bash: Record<string, unknown> = {};
    for (const key of ['command', 'output', 'exitCode', 'cancelled', 'truncated', 'fullOutputPath', 'excludeFromContext'] as const) {
      if (raw[key] !== undefined) bash[key] = raw[key];
    }
    msg.meta = { pi: { bash } };
    return msg;
  }

  if (role === 'custom') {
    // extension injection (messages.ts:162): custom content is LLM-visible as a
    // user row; customType/display/details stay under meta.pi.customMessage.
    const arr = Array.isArray(raw.content) ? raw.content : typeof raw.content === 'string' ? [{ type: 'text', text: raw.content }] : [];
    const content = normalizeContent(arr.map(foldPiBlock));
    if (!content.length) return null;
    const msg: MigratedMessage = { role: 'user', content };
    if (ts !== undefined) msg.timestamp = ts;
    msg.synthetic = true;
    const customMessage: Record<string, unknown> = {};
    if (typeof raw.customType === 'string') customMessage.customType = raw.customType;
    if (raw.display !== undefined) customMessage.display = raw.display;
    if (raw.details !== undefined) customMessage.details = raw.details;
    msg.meta = { pi: { customMessage } };
    return msg;
  }

  if (role === 'branchSummary' || role === 'compactionSummary') {
    // These are ENTRY-level twins in well-formed files (they arrive via the
    // anchor path, never as message entries). If one shows up here anyway
    // (hand-edited file, extension writing raw message rows), degrade to the
    // same rendered user row rather than dropping it.
    const summary = typeof raw.summary === 'string' ? raw.summary : '';
    const text = role === 'compactionSummary'
      ? COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX
      : BRANCH_SUMMARY_PREFIX + summary + BRANCH_SUMMARY_SUFFIX;
    const msg: MigratedMessage = { role: 'user', content: [{ type: 'text', text }] };
    if (ts !== undefined) msg.timestamp = ts;
    msg.synthetic = true;
    msg.meta = { pi: { anchor: { kind: role === 'compactionSummary' ? 'compaction' : 'branch_summary', entryId: '' } } };
    return msg;
  }

  // user / assistant (and unknown roles degrade to assistant-visible rows —
  // pi's own reader maps non-user messages back to assistant)
  const irRole: MigratedMessage['role'] = role === 'user' ? 'user' : 'assistant';
  const arr = Array.isArray(raw.content) ? raw.content : typeof raw.content === 'string' ? [{ type: 'text', text: raw.content }] : [];
  const content = normalizeContent(arr.map(foldPiBlock));
  if (!content.length && !entryMeta) return null;
  const msg: MigratedMessage = { role: irRole, content: content.length ? content : [] };
  if (ts !== undefined) msg.timestamp = ts;
  if (typeof raw.provider === 'string') msg.provider = raw.provider;
  if (typeof raw.model === 'string') msg.model = raw.model;
  if (typeof raw.stopReason === 'string') msg.stopReason = raw.stopReason;

  if (irRole === 'assistant') {
    // v3.3 (pi.md §8 #8): assistant fields with no IR slot ride meta.pi.message
    // — on the message entity, never an id side-table. stopReason/timestamp
    // already map; the remaining native fields are preserved verbatim.
    const native: Record<string, unknown> = {};
    for (const key of ['api', 'responseModel', 'responseId', 'deferred', 'errorMessage', 'rawStopReason', 'endTurn', 'diagnostics', 'usage'] as const) {
      if (raw[key] !== undefined) native[key] = raw[key];
    }
    if (Object.keys(native).length) msg.meta = { pi: { message: native } };
  }
  return msg;
}

/** pi {type:'toolCall', id, name, arguments} → generic tool_use block. */
function foldPiBlock(b: unknown): unknown {
  if (typeof b === 'object' && b !== null && !Array.isArray(b)) {
    const rec = b as Record<string, unknown>;
    if (rec.type === 'toolCall') {
      return { type: 'tool_use', id: String(rec.id ?? ''), name: String(rec.name ?? 'tool'), input: rec.arguments };
    }
  }
  return b;
}

/* ------------------------------------------------------------------ *
 * Read side: file → IR (ten entry types, zero drop)
 * ------------------------------------------------------------------ */

export async function parsePiFile(path: string): Promise<MigratedSession> {
  const text = await fs.readFile(path, 'utf8');
  const rawLines = text.split('\n');
  // pi's loadEntriesFromFile tolerates malformed lines silently; the last line
  // without a trailing newline is still an entry (sm.ts:555). We match that
  // tolerance but NEVER rewrite the source file.
  const entries: Array<PiHeader | PiEntry> = [];
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as PiHeader | PiEntry);
    } catch {
      // malformed line — skip like pi does (sm.ts:514), do not throw
    }
  }
  const first = entries[0];
  if (!first || (first as { kind?: string }).kind === 'header') {
    // v4 harness file (pi.md §7): kind:'header' is the v4 discriminator.
    // Explicit refusal — never a silent drop or half-parse.
    throw new Error(`Pi: "${path}" uses the v4 harness session format (kind:'header'), which is not supported yet — skipping explicitly`);
  }
  if (!isRecord(first) || (first as { type?: string }).type !== 'session') {
    // pi's loader rejects the whole file when line 1 is not a session header
    throw new Error(`Pi: "${path}" has no v3 session header as its first line — not a pi session file`);
  }
  const header = first as PiHeader;

  const sessionEntries = entries.slice(1).filter((e): e is PiEntry => (e as { type?: string }).type !== 'session') as PiEntry[];
  const cwd = header.cwd;
  const createdAt = toEpochMs(header.timestamp);
  const originSessionId = header.id;

  // ---- tree + leaf: the LAST ENTRY in file order is the leaf (sm.ts:964
  // _buildIndex walks every entry; append order ≠ tree order after branching).
  const byId = new Map<string, PiEntry>();
  for (const e of sessionEntries) byId.set(e.id, e);
  const leafId = sessionEntries.length ? sessionEntries[sessionEntries.length - 1].id : null;
  const leafPath = new Set<string>();
  {
    let cur: PiEntry | undefined = leafId ? byId.get(leafId) : undefined;
    while (cur) {
      leafPath.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }

  // ---- main-chain pass: leaf-path entries in path order (root→leaf) ----
  const mainPath: PiEntry[] = [];
  {
    const chain: PiEntry[] = [];
    let cur: PiEntry | undefined = leafId ? byId.get(leafId) : undefined;
    while (cur) {
      chain.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    chain.reverse();
    mainPath.push(...chain);
  }

  const messages: MigratedMessage[] = [];
  const compaction: MigratedCompaction[] = [];
  const branchSummaries: MigratedBranchSummary[] = [];
  const settingsEvents: Array<Record<string, unknown>> = [];
  const labels: Array<{ targetId: string; label?: string; time: number }> = [];
  const customEntries: Array<{ customType: string; data?: unknown; time: number }> = [];
  let title: string | undefined;
  let titleCleared = false;
  let thinkingLevel: string | undefined;
  let model: { provider?: string; id: string } | undefined;

  const epochOf = (e: PiEntry): number | undefined => {
    const msgTs = (e.message as { timestamp?: unknown } | undefined)?.timestamp;
    if (typeof msgTs === 'number' && Number.isFinite(msgTs)) return msgTs;
    return toEpochMs(e.timestamp);
  };

  for (const e of mainPath) {
    const time = epochOf(e);
    switch (e.type) {
      case 'message': {
        const raw = e.message;
        if (!isRecord(raw)) continue;
        const msg = piMessageToIr(raw, e);
        if (msg) {
          if (msg.timestamp === undefined) msg.timestamp = toEpochMs(e.timestamp);
          messages.push(msg);
          // settings derivation also honours assistant rows (sm.ts:362 three
          // sources last-wins: thinking/model changes + assistant provider/model)
          if (msg.role === 'assistant' && msg.provider && msg.model) {
            model = { provider: msg.provider, id: msg.model };
          }
        }
        break;
      }
      case 'compaction': {
        // dual carrier (pi.md §8.2): bucket entry + anchor user message
        // rendered with pi's native prefix/suffix; anchorIndex ties them.
        const summary = typeof e.summary === 'string' ? e.summary : '';
        const anchorText = COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX;
        const anchorMsg: MigratedMessage = {
          role: 'user',
          content: [{ type: 'text', text: anchorText }],
          synthetic: true,
          meta: { pi: { anchor: { kind: 'compaction', entryId: e.id } } },
        };
        if (time !== undefined) anchorMsg.timestamp = time;
        messages.push(anchorMsg);
        const meta: Record<string, unknown> = { entryId: e.id, timestamp: e.timestamp };
        if (e.details !== undefined) meta.details = e.details;
        if (e.usage !== undefined) meta.usage = e.usage;
        if (e.fromHook !== undefined) meta.fromHook = e.fromHook;
        compaction.push({
          summary,
          tokensBefore: typeof e.tokensBefore === 'number' ? e.tokensBefore : undefined,
          firstKeptId: typeof e.firstKeptEntryId === 'string' ? e.firstKeptEntryId : undefined,
          anchorIndex: messages.length - 1,
          meta,
        });
        break;
      }
      case 'branch_summary': {
        const summary = typeof e.summary === 'string' ? e.summary : '';
        const anchorText = BRANCH_SUMMARY_PREFIX + summary + BRANCH_SUMMARY_SUFFIX;
        const anchorMsg: MigratedMessage = {
          role: 'user',
          content: [{ type: 'text', text: anchorText }],
          synthetic: true,
          meta: { pi: { anchor: { kind: 'branch_summary', entryId: e.id } } },
        };
        if (time !== undefined) anchorMsg.timestamp = time;
        messages.push(anchorMsg);
        const meta: Record<string, unknown> = { entryId: e.id, timestamp: e.timestamp };
        if (e.details !== undefined) meta.details = e.details;
        if (e.usage !== undefined) meta.usage = e.usage;
        if (e.fromHook !== undefined) meta.fromHook = e.fromHook;
        branchSummaries.push({
          fromId: typeof e.fromId === 'string' ? e.fromId : '',
          summary,
          anchorIndex: messages.length - 1,
          time,
          meta,
        });
        break;
      }
      case 'custom_message': {
        // extension injection that DOES reach the LLM (sm.ts:383 custom
        // projection) → user row + synthetic + meta.pi.customMessage
        const arr = Array.isArray(e.content) ? e.content : typeof e.content === 'string' ? [{ type: 'text', text: e.content }] : [];
        const content = normalizeContent(arr.map(foldPiBlock));
        if (content.length) {
          const msg: MigratedMessage = { role: 'user', content, synthetic: true };
          if (time !== undefined) msg.timestamp = time;
          const customMessage: Record<string, unknown> = {};
          if (typeof e.customType === 'string') customMessage.customType = e.customType;
          if (e.display !== undefined) customMessage.display = e.display;
          if (e.details !== undefined) customMessage.details = e.details;
          msg.meta = { pi: { customMessage } };
          messages.push(msg);
        }
        break;
      }
      case 'model_change': {
        // derived state (last wins) + full sequence into settingsEvents
        model = { provider: e.provider, id: e.modelId ?? 'unknown' };
        settingsEvents.push({ type: 'model_change', provider: e.provider, modelId: e.modelId, time });
        break;
      }
      case 'thinking_level_change': {
        thinkingLevel = e.thinkingLevel;
        settingsEvents.push({ type: 'thinking_level_change', thinkingLevel: e.thinkingLevel, time });
        break;
      }
      case 'label': {
        // pi.md §8 #5: user-made bookmarks — targetId, label (undefined/null =
        // clear), time. Only labels on leaf-path entries are reachable in the
        // active surface, but record ALL of them (zero drop).
        labels.push({
          targetId: typeof e.targetId === 'string' ? e.targetId : '',
          label: typeof e.label === 'string' && e.label ? e.label : undefined,
          time: toEpochMs(e.timestamp) ?? 0,
        });
        break;
      }
      case 'session_info': {
        // display name: latest wins; an empty name is an EXPLICIT clear
        // (sm.ts:1150 getSessionName).
        const name = typeof e.name === 'string' ? e.name.trim() : '';
        if (name) {
          title = name;
          titleCleared = false;
        } else {
          title = undefined;
          titleCleared = true;
        }
        settingsEvents.push({ type: 'session_info', name: e.name, time });
        break;
      }
      case 'custom': {
        // extension state persistence (customType + data) — no context role
        customEntries.push({
          customType: typeof e.customType === 'string' ? e.customType : '',
          data: e.data,
          time: toEpochMs(e.timestamp) ?? 0,
        });
        break;
      }
      default:
        break;
    }
  }

  // Off-path entries: sibling branches → sidechains (pi.md §6). Non-message
  // off-path entries (labels/compactions on dead branches) also ride their
  // branch group's meta so nothing is dropped.
  const offPath = sessionEntries.filter((e) => !leafPath.has(e.id));
  const sidechains: import('../../ir.js').MigratedSidechain[] = [];
  if (offPath.length) {
    // group by branch root: walk up from each entry until hitting the leaf
    // path (or a dangling parent); the highest off-path ancestor is the root.
    const groups = new Map<string, PiEntry[]>();
    for (const e of offPath) {
      let anc: PiEntry | undefined = e;
      let branchRoot = e.id;
      while (anc?.parentId) {
        const p = byId.get(anc.parentId);
        if (!p || leafPath.has(p.id)) break;
        anc = p;
        branchRoot = anc.id;
      }
      const g = groups.get(branchRoot) ?? [];
      g.push(e);
      groups.set(branchRoot, g);
    }
    for (const [rootId, group] of groups) {
      group.sort((a, b) => (toEpochMs(a.timestamp) ?? 0) - (toEpochMs(b.timestamp) ?? 0));
      // order the branch's own chain linearly: follow parentId within group
      const groupById = new Map(group.map((e) => [e.id, e]));
      const ordered: PiEntry[] = [];
      const visited = new Set<string>();
      const walk = (e: PiEntry): void => {
        if (visited.has(e.id)) return;
        visited.add(e.id);
        for (const child of group) {
          if (child.parentId === e.id) walk(child);
        }
        ordered.push(e);
      };
      // roots first: entries whose parent is outside the group
      for (const e of group) {
        if (!e.parentId || !groupById.has(e.parentId)) walk(e);
      }
      for (const e of group) walk(e); // safety net for cycles

      const msgs: MigratedMessage[] = [];
      const childSettings: Array<Record<string, unknown>> = [];
      const childLabels: Array<{ targetId: string; label?: string; time: number }> = [];
      const childCustom: Array<{ customType: string; data?: unknown; time: number }> = [];
      const childCompactions: MigratedCompaction[] = [];
      const childBranches: MigratedBranchSummary[] = [];
      for (const e of ordered) {
        const time = epochOf(e);
        switch (e.type) {
          case 'message': {
            const raw = e.message;
            if (!isRecord(raw)) continue;
            const msg = piMessageToIr(raw, e);
            if (msg) {
              if (msg.timestamp === undefined) msg.timestamp = toEpochMs(e.timestamp);
              msgs.push(msg);
            }
            break;
          }
          case 'compaction': {
            const summary = typeof e.summary === 'string' ? e.summary : '';
            const anchorMsg: MigratedMessage = {
              role: 'user',
              content: [{ type: 'text', text: COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX }],
              synthetic: true,
              meta: { pi: { anchor: { kind: 'compaction', entryId: e.id } } },
            };
            if (time !== undefined) anchorMsg.timestamp = time;
            msgs.push(anchorMsg);
            const meta: Record<string, unknown> = { entryId: e.id, timestamp: e.timestamp };
            if (e.details !== undefined) meta.details = e.details;
            if (e.usage !== undefined) meta.usage = e.usage;
            if (e.fromHook !== undefined) meta.fromHook = e.fromHook;
            childCompactions.push({
              summary,
              tokensBefore: typeof e.tokensBefore === 'number' ? e.tokensBefore : undefined,
              firstKeptId: typeof e.firstKeptEntryId === 'string' ? e.firstKeptEntryId : undefined,
              anchorIndex: msgs.length - 1,
              meta,
            });
            break;
          }
          case 'branch_summary': {
            const summary = typeof e.summary === 'string' ? e.summary : '';
            const anchorMsg: MigratedMessage = {
              role: 'user',
              content: [{ type: 'text', text: BRANCH_SUMMARY_PREFIX + summary + BRANCH_SUMMARY_SUFFIX }],
              synthetic: true,
              meta: { pi: { anchor: { kind: 'branch_summary', entryId: e.id } } },
            };
            if (time !== undefined) anchorMsg.timestamp = time;
            msgs.push(anchorMsg);
            const meta: Record<string, unknown> = { entryId: e.id, timestamp: e.timestamp };
            if (e.details !== undefined) meta.details = e.details;
            if (e.usage !== undefined) meta.usage = e.usage;
            if (e.fromHook !== undefined) meta.fromHook = e.fromHook;
            childBranches.push({
              fromId: typeof e.fromId === 'string' ? e.fromId : '',
              summary,
              anchorIndex: msgs.length - 1,
              time,
              meta,
            });
            break;
          }
          case 'custom_message': {
            const arr = Array.isArray(e.content) ? e.content : typeof e.content === 'string' ? [{ type: 'text', text: e.content }] : [];
            const content = normalizeContent(arr.map(foldPiBlock));
            if (content.length) {
              const msg: MigratedMessage = { role: 'user', content, synthetic: true };
              if (time !== undefined) msg.timestamp = time;
              const customMessage: Record<string, unknown> = {};
              if (typeof e.customType === 'string') customMessage.customType = e.customType;
              if (e.display !== undefined) customMessage.display = e.display;
              if (e.details !== undefined) customMessage.details = e.details;
              msg.meta = { pi: { customMessage } };
              msgs.push(msg);
            }
            break;
          }
          case 'model_change':
            childSettings.push({ type: 'model_change', provider: e.provider, modelId: e.modelId, time });
            break;
          case 'thinking_level_change':
            childSettings.push({ type: 'thinking_level_change', thinkingLevel: e.thinkingLevel, time });
            break;
          case 'label':
            childLabels.push({
              targetId: typeof e.targetId === 'string' ? e.targetId : '',
              label: typeof e.label === 'string' && e.label ? e.label : undefined,
              time: toEpochMs(e.timestamp) ?? 0,
            });
            break;
          case 'custom':
            childCustom.push({
              customType: typeof e.customType === 'string' ? e.customType : '',
              data: e.data,
              time: toEpochMs(e.timestamp) ?? 0,
            });
            break;
          case 'session_info':
            // dead-branch title rows ride the branch's settingsEvents (same
            // archive the main path uses — zero drop)
            childSettings.push({ type: 'session_info', name: e.name, time });
            break;
          default:
            break;
        }
      }
      if (msgs.length) {
        const sc: import('../../ir.js').MigratedSidechain = {
          agentId: `pi-${rootId.slice(0, 8)}`,
          kind: 'subagent', // borrow-tag: pi sibling branches are exploration branches, not subagent tasks (pi.md §6)
          messages: msgs,
        };
        const childMeta: Record<string, unknown> = {};
        if (childSettings.length) childMeta.settingsEvents = childSettings;
        if (childLabels.length) childMeta.labels = childLabels;
        if (childCustom.length) childMeta.customEntries = childCustom;
        if (Object.keys(childMeta).length) sc.meta = { pi: childMeta };
        if (childCompactions.length) sc.compaction = childCompactions;
        if (childBranches.length) {
          // sidechain-level branchSummaries have no typed slot on
          // MigratedSidechain — archive under meta.pi.branchSummaries (same
          // contract as the session-level bucket, namespaced for pi only)
          childMeta.branchSummaries = childBranches;
          sc.meta = { pi: childMeta };
        }
        sidechains.push(sc);
      } else if (childSettings.length || childLabels.length || childCustom.length || childCompactions.length || childBranches.length) {
        // branch carries non-message state only — still archive it (zero drop)
        const childMeta: Record<string, unknown> = {};
        if (childSettings.length) childMeta.settingsEvents = childSettings;
        if (childLabels.length) childMeta.labels = childLabels;
        if (childCustom.length) childMeta.customEntries = childCustom;
        if (childCompactions.length) childMeta.compaction = childCompactions;
        if (childBranches.length) childMeta.branchSummaries = childBranches;
        const sc: import('../../ir.js').MigratedSidechain = {
          agentId: `pi-${rootId.slice(0, 8)}`,
          kind: 'subagent',
          messages: [],
          meta: { pi: childMeta },
        };
        sidechains.push(sc);
      }
    }
  }

  const piSessionMeta: PiSessionMeta = { header: { ...header } as unknown as Record<string, unknown> };
  if (settingsEvents.length) piSessionMeta.settingsEvents = settingsEvents;
  if (labels.length) piSessionMeta.labels = labels;
  if (customEntries.length) piSessionMeta.customEntries = customEntries;
  if (titleCleared) piSessionMeta.titleCleared = true;

  const ir: MigratedSession = {
    schemaVersion: 2,
    originTool: 'pi',
    originSessionId,
    cwd,
    createdAt,
    model,
    thinkingLevel,
    messages,
    meta: { pi: piSessionMeta },
  };
  if (title) ir.title = title;
  if (compaction.length) ir.compaction = compaction;
  if (branchSummaries.length) ir.branchSummaries = branchSummaries;
  if (sidechains.length) ir.sidechains = sidechains;
  return validateSession(ir);
}

/* ------------------------------------------------------------------ *
 * Write side: IR message → pi message payload
 * ------------------------------------------------------------------ */

function piMessageFromMigrated(msg: MigratedMessage): Record<string, unknown> {
  const piMeta = (msg.meta as { pi?: PiMessageMeta } | undefined)?.pi;
  // pi ToolResultMessage shape (pi-ai types.ts): role:'toolResult' with
  // toolCallId/toolName/isError at MESSAGE level and content limited to
  // (TextContent|ImageContent)[] — a nested toolResult block inside content is
  // invalid and reparses as garbled text. Anthropic-style IR (claude) carries
  // results as user-role tool_result carriers; route both here.
  const isToolResultCarrier =
    msg.role === 'user' && msg.content.length > 0 && msg.content.every((b) => b.type === 'tool_result');
  if (msg.role === 'tool' || isToolResultCarrier) {
    const tr = msg.content.find((b) => b.type === 'tool_result') as
      | Extract<ContentBlock, { type: 'tool_result' }>
      | undefined;
    const content: unknown[] = [];
    if (tr) {
      content.push({ type: 'text', text: tr.content });
      for (const att of tr.attachments ?? []) {
        if (att.data) content.push({ type: 'image', data: att.data, mimeType: att.mediaType ?? 'image/png' });
        else content.push({ type: 'text', text: `[file: ${att.filename ?? att.url ?? 'attachment'}]` });
      }
    }
    for (const b of msg.content) {
      if (b.type === 'text') content.push({ type: 'text', text: b.text });
      else if (b.type === 'file' && b.data) content.push({ type: 'image', data: b.data, mimeType: b.mediaType ?? 'image/png' });
    }
    const out: Record<string, unknown> = {
      role: 'toolResult',
      ...(tr ? { toolCallId: tr.toolUseId } : {}),
      toolName: piMeta?.toolName ?? 'tool',
      content: content.length ? content : [{ type: 'text', text: '' }],
      isError: tr?.isError ?? false,
      timestamp: msg.timestamp ?? Date.now(),
    };
    if (piMeta?.details !== undefined) out.details = piMeta.details;
    // v3.3: toolResult.usage + addedToolNames restored
    if (piMeta?.usage !== undefined) out.usage = piMeta.usage;
    if (piMeta?.addedToolNames !== undefined) out.addedToolNames = piMeta.addedToolNames;
    return out;
  }

  // bashExecution round-trip: the native shape is recoverable from meta.pi.bash
  // (IR came from pi) — restore it instead of degrading to plain text.
  if (msg.role === 'user' && piMeta?.bash && isRecord(piMeta.bash)) {
    const bash = piMeta.bash;
    const out: Record<string, unknown> = {
      role: 'bashExecution',
      command: typeof bash.command === 'string' ? bash.command : '',
      output: typeof bash.output === 'string' ? bash.output : '',
      exitCode: typeof bash.exitCode === 'number' ? bash.exitCode : undefined,
      cancelled: bash.cancelled === true,
      truncated: bash.truncated === true,
      timestamp: msg.timestamp ?? Date.now(),
    };
    if (typeof bash.fullOutputPath === 'string') out.fullOutputPath = bash.fullOutputPath;
    if (bash.excludeFromContext === true) out.excludeFromContext = true;
    return out;
  }

  // custom messages (extension injections from pi) restore their native shape
  if (msg.role === 'user' && piMeta?.customMessage && isRecord(piMeta.customMessage)) {
    const cm = piMeta.customMessage;
    const out: Record<string, unknown> = {
      role: 'custom',
      customType: typeof cm.customType === 'string' ? cm.customType : 'unknown',
      content: msg.content.map((b) => {
        if (b.type === 'file') {
          if (b.data) return { type: 'image', data: b.data, mimeType: b.mediaType ?? 'image/png' };
          return { type: 'text', text: `[file: ${b.filename ?? b.url ?? 'attachment'}]` };
        }
        if (b.type === 'text') return { type: 'text', text: b.text };
        return { type: 'text', text: b.type === 'thinking' ? b.thinking : (b.type === 'tool_use' ? `[tool_use: ${b.name}]` : b.content) };
      }),
      display: cm.display !== false,
      timestamp: msg.timestamp ?? Date.now(),
    };
    if (cm.details !== undefined) out.details = cm.details;
    return out;
  }

  // v3.1 developer-role rule: pi's native vocabulary is only
  // user/assistant/toolResult. Writing a raw 'developer'/'system' role would
  // produce a row pi cannot parse — and pi's own reader maps any non-user
  // message back to 'assistant', so the verbatim role both corrupts the store
  // and distorts on round-trip. Degrade to a visible user row instead.
  if (msg.role === 'system' || msg.role === 'developer') {
    const text = blocksToText(msg.content).trim();
    return {
      role: 'user',
      content: text,
      timestamp: msg.timestamp ?? Date.now(),
    };
  }

  const role: MigratedMessage['role'] = msg.role;
  const content = msg.content.map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking };
    if (b.type === 'tool_use') return { type: 'toolCall', id: b.id, name: b.name, arguments: b.input };
    if (b.type === 'tool_result') return { type: 'text', text: b.content };
    // FileBlock: no tool-result semantics — render as a text placeholder.
    return { type: 'text', text: `[file: ${b.filename ?? b.url ?? b.mediaType ?? 'attachment'}]` };
  });
  const out: Record<string, unknown> = {
    role,
    content: content.length === 1 && typeof (content[0] as { text?: string }).text === 'string' && (msg.role === 'user')
      ? (content[0] as { text: string }).text
      : content,
    timestamp: msg.timestamp ?? Date.now(),
  };
  if (msg.provider) out.provider = msg.provider;
  if (msg.model) out.model = msg.model;
  if (msg.stopReason) out.stopReason = msg.stopReason;
  // v3.3: assistant native fields (api/responseModel/responseId/deferred/…)
  // restored verbatim from meta.pi.message
  if (msg.role === 'assistant' && piMeta?.message && isRecord(piMeta.message)) {
    for (const [k, v] of Object.entries(piMeta.message)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

export { piProjectKey, defaultPiSessionsDir };
