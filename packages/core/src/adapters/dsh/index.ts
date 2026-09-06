/**
 * DSH adapter — reads/writes `~/.dsh/sessions/.../session.jsonl.zstd`.
 *
 * The model-visible conversation is the *surface fold* of the event log:
 * only events carrying `surfaceOp:'append'` and of the three surface types
 * (`user/message`, `assistant/message`, `tool/result`) produce messages. See
 * design doc §2.1 and `docs/session-formats-audit.md #1`.
 *
 * This adapter does NOT depend on `@deepseek-ai/dsh` internals — it re-derives
 * enough of the format to read/write resumable sessions using only `node:zlib`.
 *
 * IR protocol status (docs/ir-protocol.md「dsh 待适配清单」— all landed;
 * 第二轮盘点 2026-08-29 见 docs/session-formats-audit.md §1「深度盘点 #2」):
 *  1. read: `tool/call` + `tool/result` events → typed `toolCalls` records
 *     (status derived from result presence/isError; raw arguments preserved).
 *  2. write: `ir.toolCalls` → re-emitted `tool/call` events (a running record
 *     is a lone call event — native shape for interrupted calls).
 *  3. per-message native fields ride MigratedMessage.meta.dsh (IR gap #2); the
 *     session header rides session-level MigratedSession.meta.dsh (v3.1) —
 *     extensions no longer carries DSH state. headerRaw is CONSUMED by write()
 *     (delegationDepth/agentPreset/origin/parentSession/seedLength survive).
 *  4. assistant/message `usage`/`interrupted` and tool/result event-level
 *     `error`/`meta` round-trip via meta.dsh (round 2).
 *  5. subagent trees nest (MigratedSidechain.sidechains) with full child
 *     buckets; write-back relinks parents and never clobbers an existing log.
 *  6. listSessions titles via session_projcache.json → last `session/title`
 *     log-scan fallback; archive state via workspace.json; `_no-cwd` layout.
 *  7. claude teammate sidechains ride the SAME child-session path as
 *     subagents (content preserved, no team/* events — see write()) and the
 *     kind round-trips via the child header's `agentPreset` marker (2026-09-03
 *     调查结论：team/* 在安装产物里只有 catalog 条目、无 payload 契约，伪造
 *     team/message 行属瞎猜，故承载形态=独立子会话，见 docs/agents/dsh.md).
 *  8. foreign write-side conversation skeleton (2026-09-05 真机调查)：DSH GUI
 *     把同一 (turn,step) 的所有 assistant/message 折叠为一个节点且整块替换，
 *     子代理列表对无 subagent/descriptor 的子日志判「会话记录损坏」——故外来
 *     IR 落盘时合成完整 turn/step 生命周期（每人话一 turn、每 assistant 一
 *     step、step/end+turn/end 成对闭合）、claude 同响应相邻记录合并为一条
 *     assistant/message、子会话补 one-shot descriptor 身份行。
 */

/**
 * Native per-message DSH payload stored under MigratedMessage.meta.dsh
 * (IR gap #2 pattern, as zcode does with meta.zcode). `rawContent` carries
 * the ORIGINAL DSH content array only when the IR block projection is lossy
 * (DSH ImageBlock refs, non-text tool-result interiors) so write-back can
 * restore it byte-faithfully; ids/sources/turn/step are always restored
 * verbatim when present (they were previously regenerated with random ids
 * and a hardcoded clientTimeZone).
 */
interface DshMessageNative {
  id?: string;
  source?: unknown;
  turn?: number;
  step?: number;
  rawContent?: unknown[];
  /** Original surfaceOp for replace-surface events (compaction checkpoints). */
  surfaceOp?: unknown;
  /** Original sourceEventSeqs provenance for replace-surface events. */
  sourceEventSeqs?: number[];
  /** True when this message was shadowed by a later positional replace
   * (compaction): it stays in the DSH log but the model never sees it again.
   * Targets decide how to express that (OpenCode: compaction boundary pair). */
  shadowed?: boolean;
  /** assistant/message event-level `usage` (token accounting travels with the
   * message; SessionEventMap documents no separate usage record). */
  usage?: unknown;
  /** assistant/message event-level `interrupted: true` — a turn cancelled
   * mid-stream finalizes its delivered text/reasoning prefix as this event. */
  interrupted?: true;
  /** tool/result event-level `error` identity ({name, code}). */
  resultError?: unknown;
  /** tool/result event-level tool-private `meta` payload (e.g. dsh-tool-fs
   * result-time contextual diff) — opaque to the core, restored verbatim. */
  resultMeta?: unknown;
}

function withDshNative(msg: MigratedMessage, native: DshMessageNative): MigratedMessage {
  const prev = (msg.meta as { dsh?: DshMessageNative } | undefined)?.dsh ?? {};
  return { ...msg, meta: { ...(msg.meta ?? {}), dsh: { ...prev, ...native } } };
}

/** True when the raw DSH content array contains ImageBlock refs anywhere
 * (top level or inside tool-result interiors) — i.e. the IR projection loses
 * attachment bytes/dimensions and rawContent must be stashed. */
function dshContentHasImages(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((b) => {
    if (typeof b !== 'object' || b === null) return false;
    const rec = b as Record<string, unknown>;
    if (rec.type === 'image') return true;
    if (rec.type === 'tool-result' || rec.type === 'tool_result') return dshContentHasImages(rec.content);
    return false;
  });
}

/** Project a DSH ImageBlock ({type:'image', attachment:{attachmentId, mediaType, name?}})
 * into an IR FileBlock. The bytes live in DSH's attachment service keyed by
 * attachmentId — the reference rides FileBlock.url (gap #4 contract: "url when
 * it references bytes stored elsewhere"). */
function dshImageToFileBlock(rec: Record<string, unknown>): ContentBlock | undefined {
  const att = rec.attachment;
  if (typeof att !== 'object' || att === null || Array.isArray(att)) return undefined;
  const a = att as Record<string, unknown>;
  const id = typeof a.attachmentId === 'string' ? a.attachmentId : undefined;
  if (!id) return undefined;
  const out: ContentBlock = { type: 'file', url: `dsh-attachment://${id}` };
  if (typeof a.name === 'string' && a.name) out.filename = a.name;
  if (typeof a.mediaType === 'string' && a.mediaType) out.mediaType = a.mediaType;
  return out;
}

import { promises as fs } from 'node:fs';
import { isAbsolute, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Adapter, WriteOptions, WriteResult } from '../../registry.js';
import type {
  ContentBlock,
  FileBlock,
  MigratedMessage,
  MigratedSession,
  MigratedSidechain,
  MigratedToolCall,
  MessageRole,
  SessionMeta,
} from '../../ir.js';
import { IR_VERSION, validateSession } from '../../ir.js';
import { blocksToNative, blocksToText, normalizeContent } from '../../content.js';
import {
  compressFrame,
  decompressSessionBuffer,
  defaultDshRoot,
  encodeSegment,
  projectKey,
  readFirstFrameLine,
} from './format.js';
import { transpileCall, countTranspilableToolCalls } from './transpile.js';

interface DshHeader {
  id: string;
  cwd?: string;
  createdAt: number;
  title?: string;
}

interface DshEvent {
  seq: number;
  time?: number;
  type: string;
  surfaceOp?: string;
  /** Source-side forward-compat marker, preserved as IR provenance only (see
   * MigratedUnmappedEvent.ignorable) — current DSH never writes it and its
   * envelope allowlist would reject it, so the write side must not emit it. */
  ignorable?: true;
  data: {
    message?: unknown;
    role?: string;
    content?: unknown;
    title?: string;
  } & Record<string, unknown>;
}

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);
const PACKED_CHUNK_TYPES = new Set(['reasoning-chunks', 'text-chunks', 'tool-call-chunks']);

/**
 * teammate 子会话在 header.agentPreset 里的标识前缀（kind 往返保真，2026-09-03）。
 * 为什么用 agentPreset：DSH header 是 strict 白名单字段（fromHeaderLine 只透传
 * version/id/createdAt/cwd/parentSession/seedLength/origin/delegationDepth/
 * agentPreset，origin 闭集仅 'subagent'，retired 字段出现即抛错）——在 header
 * 里添加任何自定义 kind 字段都会被 DSH 加载器整份拒载，agentPreset 是唯一
 * 自由字符串原生槽位。前缀命名空间 `teammate/` 由本引擎私有约定：dsh 原生
 * preset 值（standard/explore/general-purpose 等）不携带 `/`，且读端用前缀
 * 判定 kind 后会把 agentType 还原为去前缀部分，两种 kind 的往返互不污染
 * （subagent 的 preset 撞上前缀的零概率由 dsh 原生词汇表保证）。
 */
const DSH_TEAMMATE_PRESET_PREFIX = 'teammate/';

/**
 * The event types the DSH harness knows — mirrored 1:1 from
 * `@deepseek-ai/dsh-session`'s generated `known-event-types.ts`
 * (SESSION_FORMAT_VERSION 0, 51 entries). DSH's loader
 * (`assertEventsSupported`) refuses a WHOLE log when it contains any other
 * type — there is no per-row skip mechanism, and the envelope key allowlist
 * (`assertSessionEventEnvelope`: type/seq/time/data/surfaceOp/sourceEventSeqs)
 * rejects extra keys like a hypothetical `ignorable` marker. So replayed
 * `ir.unmappedEvents` rows whose type is not in this set must be DROPPED on
 * write: keeping them (marked or not) makes the artifact unloadable, while
 * the IR bucket still carries them for cross-tool transfers.
 */
export const DSH_KNOWN_EVENT_TYPES = new Set([
  'agent-preset/selected',
  'agent/inbox/spliced',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'assistant/chunk',
  'assistant/message',
  'command/done',
  'command/run',
  'compaction/end',
  'compaction/prune',
  'compaction/start',
  'compaction/summary',
  'feedback/record',
  'goal/change',
  'hook/invoked',
  'hook/result',
  'llm/retry',
  'llm/retry-started',
  'model/selection',
  'permission/preset',
  'plan/mode',
  'request/context',
  'request/header',
  'sandbox/mode',
  'schedule/change',
  'session-log-deepseek/delivery-accepted',
  'session/end-seed',
  'session/title',
  'session/title-llm-request',
  'step/end',
  'step/start',
  'subagent/descriptor',
  'subagent/model-selection-policy',
  'team/member',
  'team/message/delivered',
  'team/message/queued',
  'team/task',
  'todo/write',
  'tool-workflow/agent-end',
  'tool-workflow/agent-start',
  'tool-workflow/run-end',
  'tool-workflow/run-start',
  'tool/call',
  'tool/code-dispatch',
  'tool/code-dispatch-start',
  'tool/result',
  'turn/end',
  'turn/start',
  'user/message',
  'web/deepseek-search-llm-request',
]);

function stripEncrypted(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripEncrypted);
  const rec = obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'encrypted_content' || k === 'encrypted') {
      out[k] = '[encrypted omitted]';
      continue;
    }
    out[k] = stripEncrypted(v);
  }
  return out;
}

function hasEncrypted(obj: unknown): boolean {
  if (obj === null || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) return obj.some(hasEncrypted);
  const rec = obj as Record<string, unknown>;
  if ('encrypted_content' in rec || 'encrypted' in rec) return true;
  return Object.values(rec).some(hasEncrypted);
}

export class DshAdapter implements Adapter {
  readonly tool = 'dsh' as const;
  readonly irVersion = IR_VERSION;

  /** Parse one DSH session artifact file into IR. */
  async parse(sessionId: string, root?: string): Promise<MigratedSession> {
    const sessionsRoot = root ?? defaultDshRoot();
    if (!sessionsRoot) throw new Error('DSH: cannot resolve ~/.dsh/sessions (HOME/USERPROFILE unset)');
    const path = await this.findLog(sessionsRoot, sessionId);
    if (!path) throw new Error(`DSH: session "${sessionId}" not found under ${sessionsRoot}`);
    const buf = await fs.readFile(path);
    const plaintext = decompressSessionBuffer(buf);
    const lines = plaintext.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) throw new Error(`DSH: session "${sessionId}" is empty`);

    const header = JSON.parse(lines[0]) as DshHeader;
    const events = lines.slice(1).map((l) => JSON.parse(l) as DshEvent);
    // events are stored in seq order; sort defensively
    events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

    const ir = buildIrFromEvents(header, events);
    // preserver origin session id
    ir.originSessionId = header.id;
    ir.cwd = header.cwd;
    ir.createdAt = header.createdAt;

    // Aggregate subagent sidechains: scan all project dirs for children whose header.parentSession === sessionId
    try {
      const sidechains = await this.collectSubagentSidechains(sessionsRoot, sessionId);
      if (sidechains.length > 0) {
        ir.sidechains = [...(ir.sidechains ?? []), ...sidechains];
      }
    } catch {
      // scanning is best-effort; keep main IR on failure
    }
    return validateSession(ir);
  }

  /** Aggregate subagent sidechains: one cheap first-frame pass over every
   * project dir (incl. `_no-cwd`) indexes children by header.parentSession,
   * then the delegation tree is walked from `parentId`. Grandchildren nest
   * under their parent's sidechain; each child carries its full mini-session
   * buckets and its original header under meta.dsh.headerRaw. */
  private async collectSubagentSidechains(root: string, parentId: string): Promise<MigratedSidechain[]> {
    interface ChildRef {
      id: string;
      header: Record<string, unknown>;
      createdAt: number;
      log: string;
    }
    const byParent = new Map<string, ChildRef[]>();
    let projects: string[];
    try {
      projects = await fs.readdir(root);
    } catch {
      return [];
    }
    for (const proj of projects) {
      const isProjectDir = proj === '_no-cwd' || (proj.startsWith('--') && proj.endsWith('--'));
      if (!isProjectDir) continue;
      const projDir = join(root, proj);
      let sessionDirs: string[];
      try {
        sessionDirs = await fs.readdir(projDir);
      } catch {
        continue;
      }
      for (const sessDir of sessionDirs) {
        const log = join(projDir, sessDir, 'session.jsonl.zstd');
        let buf: Buffer;
        try {
          buf = await fs.readFile(log);
        } catch {
          continue;
        }
        // 廉价预筛：只解压首帧读 header 行；不是任何人的子代理就跳过，
        // 绝不为他人的会话付全量解压的代价（全量解压留给命中者）。
        let firstLine: string | null;
        try {
          firstLine = readFirstFrameLine(buf);
        } catch {
          continue;
        }
        if (!firstLine) continue;
        let header: Record<string, unknown>;
        try {
          header = JSON.parse(firstLine) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (typeof header.parentSession !== 'string' || !header.parentSession) continue;
        const id = typeof header.id === 'string' && header.id ? header.id : sessDir;
        const createdAt = typeof header.createdAt === 'number' && Number.isSafeInteger(header.createdAt) ? header.createdAt : 0;
        const list = byParent.get(header.parentSession) ?? [];
        list.push({ id, header, createdAt, log });
        byParent.set(header.parentSession, list);
      }
    }
    const visited = new Set<string>([parentId]);
    const build = async (pid: string): Promise<MigratedSidechain[]> => {
      const refs = (byParent.get(pid) ?? []).slice().sort((a, b) => a.createdAt - b.createdAt);
      const out: MigratedSidechain[] = [];
      for (const ref of refs) {
        if (visited.has(ref.id)) continue; // cycle-defensive; DSH headers are acyclic
        visited.add(ref.id);
        let sc: MigratedSidechain;
        try {
          sc = await this.decodeSidechain(ref);
        } catch {
          continue; // corrupt child log — best-effort, keep the rest of the tree
        }
        const kids = await build(ref.id);
        if (kids.length > 0) sc.sidechains = kids;
        out.push(sc);
      }
      return out;
    };
    return build(parentId);
  }

  /** Fully decode one child log into a mini-session sidechain: messages plus
   * every typed bucket (toolCalls/goals/planModes/todos/compaction/title/
   * unmappedEvents) and the original header under meta.dsh.headerRaw —
   * write-back restores the child's delegationDepth/agentPreset/seedLength.
   * kind 往返保真：teammate 子会话的 header.agentPreset 带 `teammate/` 私有
   * 前缀（DSH_TEAMMATE_PRESET_PREFIX），此处按前缀还原 kind==='teammate' 并
   * 把 agentType 剥回去前缀的真值；无前缀的 preset 维持 kind==='subagent'
   * 原判定（dsh 原生子代理会话零回归）。title 侧的 `(migrated teammate)`
   * 前缀保留原样——读端不吞标识，title 是会话列表的可辨识位（有意保留）。 */
  private async decodeSidechain(ref: { id: string; header: Record<string, unknown>; createdAt: number; log: string }): Promise<MigratedSidechain> {
    const buf = await fs.readFile(ref.log);
    const plaintext = decompressSessionBuffer(buf);
    const lines = plaintext.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) throw new Error('empty child log');
    const events = lines.slice(1).map((l) => JSON.parse(l) as DshEvent);
    events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const childIr = buildIrFromEvents(ref.header as unknown as { cwd?: string; createdAt?: number; id?: string }, events);
    const rawPreset = typeof ref.header.agentPreset === 'string' ? ref.header.agentPreset : undefined;
    const isTeammate = rawPreset !== undefined && rawPreset.startsWith(DSH_TEAMMATE_PRESET_PREFIX);
    const sc: MigratedSidechain = {
      agentId: ref.id,
      kind: isTeammate ? 'teammate' : 'subagent',
      ...(rawPreset !== undefined ? { agentType: isTeammate ? rawPreset.slice(DSH_TEAMMATE_PRESET_PREFIX.length) || undefined : rawPreset } : {}),
      messages: childIr.messages,
      ...(childIr.toolCalls?.length ? { toolCalls: childIr.toolCalls } : {}),
      ...(childIr.goals?.length ? { goals: childIr.goals } : {}),
      ...(childIr.planModes?.length ? { planModes: childIr.planModes } : {}),
      ...(childIr.todos?.length ? { todos: childIr.todos } : {}),
      ...(childIr.compaction?.length ? { compaction: childIr.compaction } : {}),
      ...(childIr.unmappedEvents?.length ? { unmappedEvents: childIr.unmappedEvents } : {}),
      ...(childIr.title ? { title: childIr.title } : {}),
      ...(typeof ref.header.cwd === 'string' && ref.header.cwd ? { cwd: ref.header.cwd } : {}),
      originSessionId: ref.id,
      createdAt: ref.createdAt,
      // buildIrFromEvents already stashed the child header (headerRaw)
      meta: childIr.meta,
    };
    return sc;
  }

  /** Write an IR session into DSH's native resumable storage (new session id). */
  async write(ir: MigratedSession, opts?: WriteOptions): Promise<WriteResult> {
    validateSession(ir);
    const sessionsRoot = opts?.root ?? defaultDshRoot();
    if (!sessionsRoot) throw new Error('DSH: cannot resolve ~/.dsh/sessions');
    const requestedCwd = opts?.targetCwd ?? ir.cwd ?? '';
    // DSH validates header.cwd with path.isAbsolute and refuses the whole
    // session otherwise (SessionPersistenceCorruptionError). A cwd that came
    // from a listing projection (encoded project-dir skeleton like
    // "D-codes-foo") or a hand-typed relative path must never reach the
    // header — degrade to a cwd-less session (DSH parks it under `_no-cwd`)
    // instead of writing an unloadable artifact.
    const cwd = requestedCwd && isAbsolute(requestedCwd) ? requestedCwd : '';
    // 会话 id 碰撞防护（AGENT.md「读旧写新、永不覆盖」铁律的写端卡点）：
    // 主会话此前是「随机 id 直接落盘」，而调用方（dsh-plugin 的
    // --session-id flag）可以显式指定 id——一旦目标目录已有旧会话，
    // writeFile 会把真实会话静默覆盖掉。这里与 sidechain 的
    // claimFreeSessionId 同一纪律，但语义按 id 来源分流：
    //  - 引擎自生成（未传 sessionId）：照走 claim——randomUUID 撞上已有
    //    会话的概率≈0，但一次 access 的成本换来「永不覆盖」的硬保证，
    //    且不会让返回的 sessionId 与任何预期不符；
    //  - 调用方显式指定：占用即抛错，绝不静默 re-roll——write 返回的
    //    sessionId 必须与调用方传入的一致（隐式换 id 属于隐式失败，对齐
    //    zcode UNIQUE 冲突即抛错的纪律），也绝不覆盖旧会话。
    let newId: string;
    if (opts?.sessionId !== undefined) {
      const taken = await this.sessionLogExists(sessionsRoot, cwd, opts.sessionId);
      if (taken) {
        const takenPath = join(sessionsRoot, dshProjectDirName(cwd), encodeSegment(opts.sessionId), 'session.jsonl.zstd');
        throw new Error(
          `DSH: target session "${opts.sessionId}" already exists at ${takenPath} — refusing to overwrite an existing session (never clobber). Pass a different --session-id, or omit it to let the engine mint a fresh id.`,
        );
      }
      newId = opts.sessionId;
    } else {
      newId = await this.claimFreeSessionId(sessionsRoot, cwd, `session-${randomUUID()}`);
    }
    // Keep original wall-clock for fidelity. Sorting as "newest" is handled
    // by the (migrated) title suffix + header id ordering; don't bump
    // createdAt — that would break irToEvents time ordering and make
    // DSH→DSH look like a fresh session rather than a faithful copy.
    const createdAt = ir.createdAt ?? Date.now();
    // Opt-in disambiguation for DSH→DSH self-migrations: suffix title so the
    // export filename is visibly distinct from the source. Off by default to
    // keep `write->parse` lossless (see dsh.test "v3 write->parse ...").
    const migratedTitle =
      opts?.disambiguateTitle && ir.originTool === 'dsh' && ir.title && !ir.title.endsWith('(migrated)')
        ? `${ir.title} (migrated)`
        : undefined;

    // header frame — start from the preserved headerRaw (v3.1 session meta) so
    // delegationDepth/agentPreset/origin/parentSession/seedLength/version ride
    // through the round-trip verbatim; identity fields are overridden for the
    // new lifecycle (new id, wall-clock, effective cwd). Foreign-origin IRs
    // (claude/codex/…) have no headerRaw and keep the legacy defaults.
    const headerRaw = (ir.meta as { dsh?: { headerRaw?: Record<string, unknown> } } | undefined)?.dsh?.headerRaw;
    const headerObj: Record<string, unknown> =
      headerRaw && typeof headerRaw === 'object' && !Array.isArray(headerRaw)
        ? { ...headerRaw }
        : { type: 'session', version: 0, delegationDepth: 0, agentPreset: 'standard' };
    headerObj.type = 'session';
    headerObj.id = newId;
    headerObj.createdAt = createdAt;
    if (headerObj.version === undefined) headerObj.version = 0;
    // retired fields make DSH refuse the header outright (fromHeaderLine throws)
    delete headerObj.sandboxMode;
    delete headerObj.approvalPolicy;
    if (cwd) headerObj.cwd = cwd;
    else delete headerObj.cwd;
    const header = JSON.stringify(headerObj);

    // event rows -> surface messages (suffix title when migrating so export filename distinguishes).
    // Also patch the lossless unmapped session/title event so the written artifact
    // and the subsequent export filename both carry the suffix (otherwise
    // irToEvents would see an existing session/title and skip synthesizing).
    let irForWrite: import('../../ir.js').MigratedSession = ir;
    if (migratedTitle) {
      const patchedUnmapped = (ir.unmappedEvents ?? []).map((ev) =>
        ev.type === 'session/title' || ev.type.startsWith('session/title')
          ? { ...ev, data: { ...(ev.data as Record<string, unknown>), title: migratedTitle } as unknown as typeof ev.data }
          : ev,
      );
      // If there was no unmapped title, keep synthesized path (irForWrite.title handles it)
      // otherwise use the patched array.
      irForWrite = { ...ir, title: migratedTitle, ...(patchedUnmapped.length ? { unmappedEvents: patchedUnmapped } : {}) };
    }
    // 外来工具转译可见性（AGENT.md 纪律：语义改写绝不无声）：一次性统计本次
    // 落盘会改写多少外来工具调用（含子会话树），改写规则见 transpile.ts 与
    // docs/agents/dsh.md「外来工具转译」。IR 本身保持源值——这只是写端适配。
    if (opts?.transpileTools !== false) {
      const tstats = countTranspilableToolCalls(ir);
      if (tstats.count > 0) {
        // stderr 不是 stdout：CLI --json 的 stdout 契约是纯 JSON（b36bcde 同款
        // 纪律），adapter 内的信息行绝不能进 stdout。
        // eslint-disable-next-line no-console -- migration-time visibility contract: semantic rewrites must be announced, not silent
        console.error(
          `[cc-migrate/dsh] transpiled ${tstats.count} foreign tool call(s) to dsh-native equivalents (${tstats.breakdown}; see docs/agents/dsh.md)`,
        );
      }
    }
    const events = irToEvents(irForWrite, createdAt, { transpileTools: opts?.transpileTools });
    const frame1 = buildSessionFrame(header);
    const frame2 = buildEventsFrame(events);

    const dir = join(sessionsRoot, dshProjectDirName(cwd), encodeSegment(newId));
    await fs.mkdir(dir, { recursive: true });
    // DSH uses concatenated frames: header (own frame) + event batches (own frames)
    const payload = Buffer.concat([frame1, frame2]);
    const finalPath = join(dir, 'session.jsonl.zstd');
    // claim 之后的 TOCTOU 兜底（与 pi 写端同款纪律）：claim 检查与落盘之间
    // 目录可能被并发写入者占住，wx 独占创建保证这一步物理上不可能覆盖
    // 已有会话文件。EEXIST 时错误信息必须指向「已有会话、绝不覆盖」，
    // 而不是裸抛一个文件系统错误让调用方猜。
    try {
      await fs.writeFile(finalPath, payload, { flag: 'wx' });
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code === 'EEXIST') {
        throw new Error(
          `DSH: target session "${newId}" already exists at ${finalPath} — refusing to overwrite an existing session (never clobber). Pass a different --session-id, or omit it to let the engine mint a fresh id.`,
        );
      }
      throw e;
    }

    const paths: string[] = [finalPath];

    // Strong refresh: register in workspace.json so the GUI shows the session
    // on next refresh without restarting the harness. Best-effort — never
    // fail the migration if the workspace file is unavailable (sandbox, etc.).
    // Hermetic tmp roots (explicit --dst-root) must NOT mutate the real home.
    const isDefaultRoot = opts?.root === undefined;
    if (isDefaultRoot && cwd) {
      try {
        const { ensureWorkspaceRegistration } = await import('./workspace.js');
        await ensureWorkspaceRegistration(sessionsRoot, cwd, newId, { isDefaultRoot });
        // Child sessions are registered to the same cwd as well.
      } catch {
        // best-effort
      }
    }

    // Sidechains -> independent child sessions, written depth-first. Each
    // child keeps its source id unless that destination is already taken
    // (a dsh->dsh copy must never clobber the source log); nested sidechains
    // (grandchildren) link to the WRITTEN parent id. Child headerRaw rides
    // through verbatim (delegationDepth/seedLength/agentPreset/…); identity
    // and linkage fields are overridden per written lifecycle.
    // teammate 侧链承载（2026-09-03 裁定，方案 B）：claude teammate 是「并协作者
    // 的完整对话流」，与 subagent 同款落盘（独立子会话 + parentSession 链 +
    // agentPreset 用 teammate 标识），内容零丢弃。**不发任何 team/* 事件**：
    // 本机安装的 @deepseek-ai 全家桶里 team/member、team/message/queued、
    // team/message/delivered、team/task 只出现在 known-event-types catalog，
    // 没有任何生产者代码、没有 payload 类型声明（59 个真实会话实测 0 个 team
    // 事件）——没有 payload 契约就没有转译，伪造 team/message 行的 data 字段
    // 违反「不冒充」纪律。team/* 是运行时协作状态机（dsh-tool-cordis
    // agentTeams 服务）的产物，迁移侧没有等价物；语义上最贴近 dsh 的原生
    // 形态就是一份可独立 resume 的完整会话记录（语义登记见 docs/agents/dsh.md）。
    const teammateCount = (ir.sidechains ?? []).filter((s) => s.kind === 'teammate').length;
    if (teammateCount > 0) {
      // 内容承载说明（非警告——丢弃已成历史）：一次性告知用户 teammate 侧链的
      // 落盘形态与 team/* 不发的理由，语义边界保持可见，绝不无声改写。
      // stderr 不是 stdout：CLI --json 的 stdout 契约是纯 JSON（b36bcde 同款
      // 纪律，带 teammate 侧链的 --json 迁移曾会被此行炸掉 JSON.parse）。
      // eslint-disable-next-line no-console -- migration-time visibility contract: teammate carry-over must be announced, not silent
      console.error(
        `[cc-migrate/dsh] ${teammateCount} teammate sidechain(s) written as standalone child sessions (dsh team/* events are runtime-only state — content preserved, live-team semantics not translatable; see docs/agents/dsh.md)`,
      );
    }
    const now = Date.now();
    let childCounter = 0;
    const writeSidechain = async (sc: MigratedSidechain, parentWrittenId: string, parentDepth: number): Promise<void> => {
      const scHeaderRaw = (sc.meta as { dsh?: { headerRaw?: Record<string, unknown> } } | undefined)?.dsh?.headerRaw;
      const candidate =
        typeof sc.agentId === 'string' &&
        sc.agentId.trim().length > 0 &&
        sc.agentId !== '.' &&
        sc.agentId !== '..' &&
        !sc.agentId.includes('/') &&
        !sc.agentId.includes('\\') &&
        !sc.agentId.includes(':')
          ? sc.agentId
          : `session-${randomUUID()}`;
      const childId = await this.claimFreeSessionId(sessionsRoot, this.childCwd(sc, scHeaderRaw, cwd), candidate);
      const childCreatedAt = now + ++childCounter;
      const rawDepth = scHeaderRaw?.delegationDepth;
      // teammate 子会话的 agentPreset 一律带 teammate 标识（kind 往返保真的
      // 载体，见下方 marker 说明）；subagent 走原有 agentType ?? 'standard' 路径。
      const presetForChild = sc.kind === 'teammate'
        ? DSH_TEAMMATE_PRESET_PREFIX + (sc.agentType ?? 'teammate')
        : sc.agentType ?? 'standard';
      const childHeaderObj: Record<string, unknown> =
        scHeaderRaw && typeof scHeaderRaw === 'object' && !Array.isArray(scHeaderRaw)
          ? { ...scHeaderRaw }
          : { version: 0, agentPreset: presetForChild };
      childHeaderObj.type = 'session';
      childHeaderObj.id = childId;
      childHeaderObj.createdAt = childCreatedAt;
      if (childHeaderObj.version === undefined) childHeaderObj.version = 0;
      childHeaderObj.delegationDepth =
        typeof rawDepth === 'number' && Number.isSafeInteger(rawDepth) && rawDepth >= 0
          ? rawDepth
          : parentDepth + 1;
      // linkage is ours to own: the child always points at the WRITTEN parent
      childHeaderObj.parentSession = parentWrittenId;
      childHeaderObj.origin = 'subagent';
      // teammate 子会话的 agentPreset 强制覆盖为带标识值：即使 headerRaw 从源
      // 会话带入了旧 agentPreset（dsh→dsh 不存在 teammate 源，但防御性保留
      // 该覆盖——teammate 只可能来自 claude 等外部 IR），kind 标识绝不丢失。
      if (sc.kind === 'teammate') childHeaderObj.agentPreset = presetForChild;
      else if (childHeaderObj.agentPreset === undefined) childHeaderObj.agentPreset = sc.agentType ?? 'standard';
      delete childHeaderObj.sandboxMode;
      delete childHeaderObj.approvalPolicy;
      // 子会话 cwd 解析（此前被父 cwd 无条件覆盖）：优先 MigratedSidechain.cwd
      // （ir.ts:187 的槽位——dsh 读端在 decodeSidechain 里按 header.cwd 填充），
      // 其次子 headerRaw.cwd（独立迁移子代理会话时 header 保真携带），都非绝对
      // 时回退父 cwd。与主会话同一条 isAbsolute 校验纪律：DSH 的 header 验证
      // （path.isAbsolute）会拒绝相对 cwd——列表投影的编码骨架（"D-codes-foo"）
      // 绝不能进 header。
      const childCwd = this.childCwd(sc, scHeaderRaw, cwd);
      if (childCwd) childHeaderObj.cwd = childCwd;
      else delete childHeaderObj.cwd;
      const childHeader = JSON.stringify(childHeaderObj);
      // Full mini-session buckets — a child log round-trips like a main log.
      // teammate 子会话的 title 加 `(migrated teammate)` 前缀：DSH 会话列表里
      // 无 kind 维度，title 是唯一可辨识位（与主会话 `(migrated)` 后缀的
      // disambiguate 风格同族——前缀而非后缀，避免与源 title 语义混淆）。
      const childIr: MigratedSession = {
        schemaVersion: 2 as const,
        originTool: 'dsh',
        messages: sc.messages,
        ...(sc.toolCalls?.length ? { toolCalls: sc.toolCalls } : {}),
        ...(sc.goals?.length ? { goals: sc.goals } : {}),
        ...(sc.planModes?.length ? { planModes: sc.planModes } : {}),
        ...(sc.todos?.length ? { todos: sc.todos } : {}),
        ...(sc.compaction?.length ? { compaction: sc.compaction } : {}),
        ...(sc.unmappedEvents?.length ? { unmappedEvents: sc.unmappedEvents } : {}),
        // kind 保真的第二载体：title 前缀让往返后的 sidechain.title 也携带
        // teammate 标识（irToEvents 会据此合成 session/title 事件）。原有
        // title 有值则前缀附加，无值则用裸前缀兜底，保证标识必然可见。
        ...(sc.kind === 'teammate'
          ? { title: sc.title ? `(migrated teammate) ${sc.title}` : '(migrated teammate)' }
          : sc.title
            ? { title: sc.title }
            : {}),
      };
      // 子会话身份行：没有 subagent/descriptor 事件的子日志，DSH 子代理列表
      // 的 identity 折叠得 null，整行被判「会话记录损坏」。外来子会话源里没有
      // 这种事件，这里按 descriptor 契约（v2 / one-shot / provider+label）补
      // 权威身份行——one-shot 即「归档记录、不支持续发」，与迁移产物的实际
      // 生命周期一致（GUI 明确支持查看 one-shot 执行记录）。dsh→dsh 子会话已
      // 自带 descriptor（unmappedEvents 原样保留），绝不追加第二条——
      // establish 语义是「恰好一条」，重复行会让两次折叠结果取决于先后。
      const childLabel = (sc.title ?? sc.agentType ?? sc.agentId ?? childId).slice(0, 120);
      const hasNativeDescriptor = (sc.unmappedEvents ?? []).some((ev) => ev.type === 'subagent/descriptor');
      const childEvents = irToEvents(childIr, childCreatedAt, {
        transpileTools: opts?.transpileTools,
        ...(hasNativeDescriptor ? {} : {
          subagentDescriptor: { version: 2, mode: 'one-shot', provider: 'migrated', label: childLabel },
        }),
      });
      const cFrame1 = buildSessionFrame(childHeader);
      const cFrame2 = buildEventsFrame(childEvents);
      // 子会话目录布局按「子自己的 cwd」落 project dir（与 header.cwd 同源，
      // 上一行刚解析出的 childCwd）——此前用父 cwd 会让子会话在 DSH 的
      // 工作区视图里挂到错误的 project 下。
      const cDir = join(sessionsRoot, dshProjectDirName(childCwd), encodeSegment(childId));
      await fs.mkdir(cDir, { recursive: true });
      const cPayload = Buffer.concat([cFrame1, cFrame2]);
      const cPath = join(cDir, 'session.jsonl.zstd');
      // 子会话同样走 wx 独占创建：claimFree 只在落盘前检查，两个同名
      // agentId 的 sidechain（或与已有子会话撞名）会让 claim 先后都通过，
      // wx 保证后写者在这里失败而不是覆盖前者（AGENTS.md「绝不清理、
      // 绝不替换、永不覆盖」同样适用于子会话产物）。
      try {
        await fs.writeFile(cPath, cPayload, { flag: 'wx' });
      } catch (e) {
        const code = (e as { code?: string } | null)?.code;
        if (code === 'EEXIST') {
          throw new Error(
            `DSH: sidechain session "${childId}" already exists at ${cPath} — refusing to overwrite an existing session (never clobber).`,
          );
        }
        throw e;
      }
      paths.push(cPath);
      if (isDefaultRoot && childCwd) {
        try {
          const { ensureWorkspaceRegistration } = await import('./workspace.js');
          await ensureWorkspaceRegistration(sessionsRoot, childCwd, childId, { isDefaultRoot });
        } catch {
          // best-effort
        }
      }
      for (const nested of sc.sidechains ?? []) {
        const depth = typeof childHeaderObj.delegationDepth === 'number' ? childHeaderObj.delegationDepth : parentDepth + 1;
        await writeSidechain(nested, childId, depth);
      }
    };
    // 全部 sidechain 写出（subagent + teammate 同路径）：当前 IR 词汇表只有
    // subagent/teammate 两 kind（ir.ts SidechainKind 闭集），teammate 已按
    // 方案 B 承载；若未来 IR 扩出新 kind 且 dsh 未跟进，落到这里的兜底警告
    // 保证该类数据绝不无声蒸发。
    const unknownKinds = (ir.sidechains ?? []).filter((s) => s.kind !== 'subagent' && s.kind !== 'teammate');
    if (unknownKinds.length > 0) {
      // eslint-disable-next-line no-console -- migration-time visibility contract: silent drops are the bug class this guards
      console.warn(
        `[cc-migrate/dsh] ${unknownKinds.length} sidechain(s) of unknown kind(s) ${[...new Set(unknownKinds.map((s) => s.kind))].join(', ')} dropped (no dsh carry-over defined — see docs/agents/dsh.md)`,
      );
    }
    for (const sc of (ir.sidechains ?? []).filter((s) => s.kind === 'subagent' || s.kind === 'teammate')) {
      const baseDepth = typeof headerObj.delegationDepth === 'number' ? headerObj.delegationDepth : 0;
      await writeSidechain(sc, newId, baseDepth);
    }

    return { tool: 'dsh', sessionId: newId, paths };
  }

  /** Lightweight session listing from the DSH sessions root. Titles come from
   * DSH's own projection cache (`session_projcache.json`, one JSON read);
   * sessions it doesn't cover (e.g. migrated ones DSH never opened) fall back
   * to scanning the log for the LAST `session/title` event. Archive state
   * rides workspace.json's archivedSessionIds. `_no-cwd` sessions listed too. */
  async listSessions(root?: string): Promise<SessionMeta[]> {
    const sessionsRoot = root ?? defaultDshRoot();
    if (!sessionsRoot) return [];
    const [titles, archived] = await Promise.all([
      readProjcacheTitles(sessionsRoot),
      readArchivedSessionIds(sessionsRoot),
    ]);
    const metas: SessionMeta[] = [];
    let projects: string[];
    try {
      projects = await fs.readdir(sessionsRoot);
    } catch {
      return [];
    }
    for (const proj of projects) {
      const isProjectDir = proj === '_no-cwd' || (proj.startsWith('--') && proj.endsWith('--'));
      if (!isProjectDir) continue;
      const projDir = join(sessionsRoot, proj);
      let sessions: string[];
      try {
        sessions = await fs.readdir(projDir);
      } catch {
        continue;
      }
      for (const sid of sessions) {
        const sessDir = join(projDir, sid);
        const log = join(sessDir, 'session.jsonl.zstd');
        try {
          const st = await fs.stat(log);
          let title = titles.get(sid);
          // Real cwd comes from the header line (first zstd frame only).
          // The project dir name is a one-way encoding — deriving "cwd" from
          // it yields skeletons like "D-codes-foo" that DSH's header validator
          // (isAbsolute) rightly refuses if they ever reach a write.
          let headerCwd: string | undefined;
          const buf = await fs.readFile(log);
          if (title === undefined) title = scanTitleFromLog(buf);
          try {
            const headLine = readFirstFrameLine(buf);
            const parsed = headLine ? (JSON.parse(headLine) as { cwd?: unknown }) : undefined;
            if (parsed && typeof parsed.cwd === 'string' && parsed.cwd && isAbsolute(parsed.cwd)) {
              headerCwd = parsed.cwd;
            }
          } catch {
            // unreadable header → leave cwd unknown
          }
          metas.push({
            tool: 'dsh',
            sessionId: sid,
            ...(title !== undefined ? { title } : {}),
            ...(headerCwd !== undefined ? { cwd: headerCwd } : {}),
            createdAt: st.mtimeMs,
            sourcePath: log,
            ...(archived.has(sid) ? { archived: true } : {}),
          });
        } catch {
          // skip non-artifact entries
        }
      }
    }
    return metas;
  }

  /** Offline preview: fold messages to text (includes sidechains). */
  preview(session: MigratedSession): string {
    const main = session.messages.map((m) => `[${m.role}]\n${blocksToText(m.content)}`);
    if (!session.sidechains?.length) return main.join('\n\n');
    const branches = session.sidechains.map(
      (sc) => `[sidechain: ${sc.agentId} (${sc.kind})]\n${sc.messages.map((m) => blocksToText(m.content)).join('\n')}`,
    );
    return [...main, ...branches].join('\n\n');
  }

  /** Locate the log file for a session id by scanning project dirs. */
  private async findLog(root: string, id: string): Promise<string | null> {
    // Fast path: the canonical path from project dir key requires cwd, which we may not know.
    // Scan project dirs for a session dir whose encodeSegment == id.
    let projects: string[];
    try {
      projects = await fs.readdir(root);
    } catch {
      return null;
    }
    for (const proj of projects) {
      const projDir = join(root, proj);
      const candidate = join(projDir, encodeSegment(id));
      const log = join(candidate, 'session.jsonl.zstd');
      try {
        await fs.access(log);
        return log;
      } catch {
        // not here
      }
    }
    return null;
  }

  /** True when a session artifact already occupies the (root, cwd, id) slot —
   * the single occupancy test shared by the main-session collision gate and
   * claimFreeSessionId's re-roll loop. */
  private async sessionLogExists(root: string, cwd: string, id: string): Promise<boolean> {
    try {
      await fs.access(join(root, dshProjectDirName(cwd), encodeSegment(id), 'session.jsonl.zstd'));
      return true;
    } catch {
      return false;
    }
  }

  /** 子会话 cwd 解析：sc.cwd（IR 槽位，优先）> 子 headerRaw.cwd > 父 cwd。
   * 候选值必须通过 isAbsolute 校验（DSH header 契约），非绝对一律跳过取
   * 下一级——与主会话 cwd 的降级纪律同款。返回 '' 表示 cwd-less（落 _no-cwd）。 */
  private childCwd(sc: MigratedSidechain, scHeaderRaw: Record<string, unknown> | undefined, parentCwd: string): string {
    const candidates = [sc.cwd, typeof scHeaderRaw?.cwd === 'string' ? scHeaderRaw.cwd : undefined];
    for (const c of candidates) {
      if (typeof c === 'string' && isAbsolute(c)) return c;
    }
    return parentCwd;
  }

  /** Return `preferred` when its artifact path is free; otherwise mint a fresh
   * id. Writing over an existing log would clobber a real session (dsh->dsh
   * copies share root+cwd, so a preserved source id collides by design). */
  private async claimFreeSessionId(root: string, cwd: string, preferred: string): Promise<string> {
    if (!(await this.sessionLogExists(root, cwd, preferred))) return preferred;
    for (let i = 0; i < 5; i++) {
      const fresh = `session-${randomUUID()}`;
      if (!(await this.sessionLogExists(root, cwd, fresh))) return fresh;
    }
    throw new Error(`DSH: cannot find a free session dir for "${preferred}" under ${root}`);
  }
}

/* ------------------------------------------------------------------
 * Translators (kept pure for testability)
 * ------------------------------------------------------------------ */

/** Turn header + parsed events into a MigratedSession. agent->IR is zero-loss (except encrypted). */
export function buildIrFromEvents(header: { cwd?: string; createdAt?: number; id?: string }, events: DshEvent[]): MigratedSession {
  const messages: MigratedMessage[] = [];
  const goals: NonNullable<MigratedSession['goals']> = [];
  const planModes: NonNullable<MigratedSession['planModes']> = [];
  const todos: NonNullable<MigratedSession['todos']> = [];
  const toolCalls: NonNullable<MigratedSession['toolCalls']> = [];
  const toolCallByCallId = new Map<string, MigratedToolCall>();
  const unmappedEvents: NonNullable<MigratedSession['unmappedEvents']> = [];
  const compaction: NonNullable<MigratedSession['compaction']> = [];
  let title: string | undefined;

  // Surface fold with positional replace (mirrors DSH foldSurface): 'append'
  // adds a node; surfaceOp {op:'replace',start,end} splices the CURRENT node
  // list at those POSITIONS with the replacing event's seq. A compacted span
  // therefore stays in the log but leaves the model-visible surface — the
  // checkpoint (a user/message carrying the replace op) is the summary that
  // replaces it. Shadowed messages keep meta.dsh.shadowed; the checkpoint
  // becomes a message too (IR gap #3: the in-stream summary travels).
  const nodes: number[] = [];
  const compactionSummaries = new Map<number, Record<string, unknown>>(); // seq -> compaction/summary data
  const seqToMsg = new Map<number, MigratedMessage>();

  const stampAndPush = (ev: DshEvent, msg: MigratedMessage): void => {
    msg.timestamp = ev.time;
    msg.seq = ev.seq;
    messages.push(msg);
    seqToMsg.set(ev.seq, msg);
  };

  for (const ev of events) {
    // Packed chunk rows carry seq0/time0 (not seq/time); treat them as
    // lossless unmapped rather than tripping the surface fold. Their seq0
    // range is provenance for DSH's packChunks decoder.
    if (PACKED_CHUNK_TYPES.has(ev.type)) {
      const raw = ev as unknown as Record<string, unknown>;
      const cleanData = stripEncrypted(ev.data) as DshEvent['data'];
      const seq0 = typeof raw.seq0 === 'number' ? (raw.seq0 as number) : ev.seq;
      const time0 = typeof raw.time0 === 'number' ? (raw.time0 as number) : (ev.time ?? 0);
      unmappedEvents.push({
        seq: seq0,
        time: time0,
        type: ev.type,
        data: cleanData,
      } as NonNullable<MigratedSession['unmappedEvents']>[number]);
      continue;
    }
    if (hasEncrypted(ev.data)) {
      // encrypted_content is the only allowed drop — keep placeholder for audit
    }
    const cleanData = stripEncrypted(ev.data) as DshEvent['data'];
    // session/title is the DSH lossless title bucket (may appear with suffix variant)
    if (ev.type === 'session/title' || ev.type.startsWith('session/title')) {
      const t = (cleanData as Record<string, unknown>).title;
      if (typeof t === 'string' && t) title = t;
      // also keep the raw event in unmapped so a non-title consumer can see it,
      // but canonical title is promoted to ir.title
      unmappedEvents.push({
        seq: ev.seq,
        time: ev.time ?? 0,
        type: ev.type,
        data: cleanData,
        ...(ev.surfaceOp !== undefined ? { surfaceOp: ev.surfaceOp } : {}),
        ...(ev.surfaceOp !== undefined && (ev as { sourceEventSeqs?: number[] }).sourceEventSeqs ? { sourceEventSeqs: (ev as { sourceEventSeqs?: number[] }).sourceEventSeqs } : {}),
      } as NonNullable<MigratedSession['unmappedEvents']>[number]);
      continue;
    }
    if (ev.type === 'compaction/summary') {
      // log-only metering record; keep lossless AND index it so the shadowing
      // checkpoint below can pair with its shadowedTokenCount.
      compactionSummaries.set(ev.seq, cleanData as Record<string, unknown>);
      unmappedEvents.push({
        seq: ev.seq,
        time: ev.time ?? 0,
        type: ev.type,
        data: cleanData,
      } as NonNullable<MigratedSession['unmappedEvents']>[number]);
      continue;
    }
    if (ev.type === 'tool/call') {
      // toolCalls typed bucket (清单 #1): one record per invocation event.
      // `arguments` is the RAW model-produced JSON string — kept verbatim in
      // metadata.dsh for byte-faithful write-back; `input` carries the parsed
      // form for consumers. No result event (yet) → non-replayable 'running'.
      const d = cleanData as { turn?: number; step?: number; callId?: string; name?: string; arguments?: string };
      if (typeof d.callId === 'string' && d.callId) {
        const rec: MigratedToolCall = {
          callId: d.callId,
          tool: String(d.name ?? 'tool'),
          status: 'running',
          input: tryParseJson(d.arguments),
          time: { start: ev.time },
          metadata: {
            dsh: {
              ...(typeof d.turn === 'number' ? { turn: d.turn } : {}),
              ...(typeof d.step === 'number' ? { step: d.step } : {}),
              seq: ev.seq,
              ...(typeof d.arguments === 'string' ? { arguments: d.arguments } : {}),
              ...(ev.time !== undefined ? { time: ev.time } : {}),
            },
          },
        };
        toolCalls.push(rec);
        toolCallByCallId.set(rec.callId, rec);
      }
      continue;
    }
    if (SURFACE_TYPES.has(ev.type) && (ev.surfaceOp === 'append' || (typeof ev.surfaceOp === 'object' && ev.surfaceOp !== null && (ev.surfaceOp as Record<string, unknown>).op === 'replace'))) {
      const msg = eventToMessage(ev.type, cleanData);
      if (msg) {
        // Preserve wall-clock + original seq so irToEvents can restore the
        // exact stream order (turn/start must precede its surface messages;
        // equal-ms ties break by original seq, matching the source log).
        // provider/model are already lifted inside normalizeMessageLike.
        const native = (msg.meta as { dsh?: DshMessageNative } | undefined)?.dsh;
        if (ev.surfaceOp !== 'append') {
          // replace-surface event (compaction checkpoint): keep the op and its
          // provenance verbatim for byte-faithful write-back.
          const sourceSeqs = (ev as { sourceEventSeqs?: number[] }).sourceEventSeqs;
          const replacer = withDshNative(msg, { surfaceOp: ev.surfaceOp, ...(sourceSeqs ? { sourceEventSeqs: sourceSeqs } : {}) });
          stampAndPush(ev, replacer);
          // Surface fold: op.start/op.end are SURFACE NODE SEQs (DSH
          // replacementRange does nodes.indexOf(op.start)); the splice removes
          // every current node between them plus both endpoints. An invalid
          // reference never occurs in a log DSH itself would load — degrade to
          // append rather than fail the migration.
          const op = ev.surfaceOp as { op: 'replace'; start: number; end: number };
          const startIdx = nodes.indexOf(op.start);
          const endIdx = nodes.indexOf(op.end);
          if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
            nodes.push(ev.seq);
          } else {
            const shadowedSeqs = nodes.slice(startIdx, endIdx + 1);
            nodes.splice(startIdx, endIdx - startIdx + 1, ev.seq);
            for (const s of shadowedSeqs) {
              const shadowedMsg = seqToMsg.get(s);
              if (shadowedMsg) {
                const prev = (shadowedMsg.meta as { dsh?: DshMessageNative } | undefined)?.dsh ?? {};
                shadowedMsg.meta = { ...(shadowedMsg.meta ?? {}), dsh: { ...prev, shadowed: true } };
              }
            }
          }
          // IR gap #3 compaction bucket: summary text + anchor + token count
          const summaryText = replacer.content
            .filter((b) => b.type === 'text')
            .map((b) => (b as { text: string }).text)
            .join('\n');
          const tokensBefore = sourceSeqs
            ?.map((s) => compactionSummaries.get(s))
            .map((d) => (d ? d.shadowedTokenCount : undefined))
            .find((v): v is number => typeof v === 'number');
          compaction.push({
            summary: summaryText,
            anchorIndex: messages.length - 1,
            ...(tokensBefore !== undefined ? { tokensBefore } : {}),
          });
        } else {
          stampAndPush(ev, msg);
          nodes.push(ev.seq);
          if (ev.type === 'tool/result') backfillToolCall(toolCallByCallId, cleanData, ev.time);
        }
      } else {
        // 零投影 surface 行（content.length === 0 的 assistant/message 是 DSH
        // deriveEventMessage 的合法 null 形态；空投影 user 行同理）：不进
        // messages[]，但绝不能整行蒸发——它是已知事件类型，原样落
        // unmappedEvents 保住 dsh→dsh 往返（写端照常重发该行，零丢弃）。
        unmappedEvents.push({
          seq: ev.seq,
          time: ev.time ?? 0,
          type: ev.type,
          data: cleanData,
          ...(ev.surfaceOp !== undefined ? { surfaceOp: ev.surfaceOp as string } : {}),
          ...((ev as { sourceEventSeqs?: number[] }).sourceEventSeqs ? { sourceEventSeqs: (ev as { sourceEventSeqs?: number[] }).sourceEventSeqs } : {}),
        } as NonNullable<MigratedSession['unmappedEvents']>[number]);
      }
      continue;
    }
    if (ev.type === 'goal/change') {
      goals.push({ seq: ev.seq, time: ev.time ?? 0, data: cleanData as unknown as Record<string, unknown> });
      continue;
    }
    if (ev.type === 'plan/mode') {
      planModes.push({ seq: ev.seq, time: ev.time ?? 0, data: cleanData });
      continue;
    }
    if (ev.type === 'todo/write') {
      todos.push({ seq: ev.seq, time: ev.time ?? 0, data: cleanData });
      continue;
    }
    // catch-all lossless bucket (except encrypted)
    unmappedEvents.push({
      seq: ev.seq,
      time: ev.time ?? 0,
      type: ev.type,
      data: cleanData,
      ...(ev.surfaceOp !== undefined ? { surfaceOp: ev.surfaceOp } : {}),
      ...(ev.surfaceOp !== undefined && (ev as { sourceEventSeqs?: number[] }).sourceEventSeqs ? { sourceEventSeqs: (ev as { sourceEventSeqs?: number[] }).sourceEventSeqs } : {}),
      ...(ev.ignorable === true ? { ignorable: true } : {}),
    } as NonNullable<MigratedSession['unmappedEvents']>[number]);
  }

  const ir: MigratedSession = { schemaVersion: 2 as const, originTool: 'dsh', messages };
  if (title) ir.title = title;
  if (goals.length) ir.goals = goals;
  if (planModes.length) ir.planModes = planModes;
  if (todos.length) ir.todos = todos;
  if (toolCalls.length) ir.toolCalls = toolCalls;
  if (compaction.length) ir.compaction = compaction;
  if (unmappedEvents.length) ir.unmappedEvents = unmappedEvents;
  // Session header rides the SESSION-LEVEL meta namespace (v3.1: eliminates
  // the last extensions bypass; write-back prefers meta.dsh.headerRaw and
  // still honours the legacy extensions key from pre-v3.1 exported IRs).
  ir.meta = { dsh: { headerRaw: { ...header } } };
  return ir;
}

/** toolCalls 清单 #1（result 回填）：pair the result event with its bucket
 * record by callId — status flips to completed/error, output/error text is
 * extracted from the tool-result interior, time.end and DSH-native extras
 * (error identity, tool-private result meta) ride metadata.dsh. */
function backfillToolCall(
  map: Map<string, MigratedToolCall>,
  data: unknown,
  time: number | undefined,
): void {
  const d = data as {
    message?: { source?: { callId?: unknown }; content?: unknown[] };
    error?: { name?: string; code?: string };
    meta?: unknown;
  } | undefined;
  const callId = d?.message?.source?.callId;
  const rec = typeof callId === 'string' ? map.get(callId) : undefined;
  if (!rec) return;
  const block = (d?.message?.content ?? []).find(
    (b) => typeof b === 'object' && b !== null && ((b as Record<string, unknown>).type === 'tool-result' || (b as Record<string, unknown>).type === 'tool_result'),
  ) as Record<string, unknown> | undefined;
  const isError = Boolean(block?.isError) || d?.error !== undefined;
  const text = Array.isArray(block?.content)
    ? (block!.content as unknown[])
        .map((p) => (typeof p === 'object' && p !== null && (p as Record<string, unknown>).type === 'text' ? String((p as Record<string, unknown>).text ?? '') : JSON.stringify(p)))
        .join('')
    : typeof block?.content === 'string' ? block.content : '';
  rec.status = isError ? 'error' : 'completed';
  if (isError) rec.error = text;
  else rec.output = text;
  if (rec.time && time !== undefined) rec.time.end = time;
  rec.metadata = {
    ...(rec.metadata ?? {}),
    dsh: {
      ...(rec.metadata?.dsh ?? {}),
      ...(d?.error ? { errorIdentity: d.error } : {}),
      ...(d?.meta !== undefined ? { resultMeta: d.meta } : {}),
    },
  };
}

function eventToMessage(type: string, data: DshEvent['data']): MigratedMessage | null {
  switch (type) {
    case 'user/message': {
      // DSH user/message shape: data IS the message {id, role:"user", source:{kind,...}, content:[]}
      // Tool-bridged form also has source:{kind:"tool"} but still data-level.
      const maybe = data as unknown as Record<string, unknown>;
      const content = (maybe.content as unknown[]) ?? [];
      const source = maybe.source as Record<string, unknown> | undefined;
      const isToolBridged = source?.kind === 'tool' || (Array.isArray(content) && content.some((b) => typeof b === 'object' && b !== null && ((b as Record<string, unknown>).type === 'tool-result' || (b as Record<string, unknown>).type === 'tool_result')));
      const msg = normalizeMessageLike(data);
      if (!msg) return null;
      // Native fields for lossless write-back (gap #2): the exact id and the
      // FULL source object (kind/plugin/rpcId/clientTimeZone/...) — previously
      // these were regenerated with random ids and a hardcoded timezone.
      const native: DshMessageNative = { source };
      if (typeof maybe.id === 'string') native.id = maybe.id;
      if (dshContentHasImages(content)) native.rawContent = content;
      // Harness-injected content rides ordinary user/message events; the
      // source kind is what separates human turns from injections. Verified
      // against the dsh source's inject producers (packages/skill/tool-skill,
      // context/agent-instructions, goal/goal-round-driver,
      // subagent/continuation, compaction/checkpoint):
      //   'plugin' — system-prompt snapshots / schedule / plan-mode /
      //     user-approval / repeat-tool-reminder / tool-jobs / …
      //   'skill-catalog' — the <available_skills> <system-reminder>
      //   'skill-invocation' — a loaded <skill_content> block
      //   'agent-instructions' — AGENTS.md injections
      //   'goal' — goal continuation rounds
      //   'subagent-report' / 'subagent-settled' / 'coordinator' — child
      //     lifecycle relay / multi-agent notices
      // All of those are SYNTHETIC. COMPACTION CHECKPOINTS (plugin ===
      // 'compact', @deepseek-ai/dsh-compaction/checkpoint) are CONVERSATION
      // CONTENT — the in-stream summary travels as a message (IR gap #3) and
      // must survive migration, so they are NOT synthetic. Unknown kinds and
      // missing sources stay non-synthetic — never drop what cannot be
      // classified (new harness kinds keep appearing; human turns are always
      // stamped kind:'user') — EXCEPT rows whose text hits a known injection
      // marker (isMarkerInjection): DSH's own harness stamps several injection
      // families as kind:'user' (真机样本 52be3474), so the kind cannot be
      // trusted alone for those.
      const sourceKind = typeof source?.kind === 'string' ? source.kind : undefined;
      const isCompactionCheckpoint = sourceKind === 'plugin' && source?.plugin === 'compact';
      const synthetic = sourceKind !== undefined && sourceKind !== 'user' && !isCompactionCheckpoint;
      if (isToolBridged) return withDshNative({ ...msg, role: 'tool' as const }, native);
      // kind:'user' (and missing-source) rows can still be injections — DSH's
      // own harness stamps permissions / AGENTS.md / environment-context /
      // team-preamble / multi-agent-mode rows as ordinary kind:'user' messages
      // (真机样本 52be3474 锚定；2026-09 现网复验：2600 条 kind:'user' 中 46 条
      // 命中已知注入前缀). The marker list is the same one the title fallback
      // uses — a text hit classifies what the kind cannot, so it marks
      // synthetic instead of riding as a human turn. Delegation task prompts
      // (the child session's FIRST kind:'user' row) carry none of the prefixes
      // and stay user info.
      if (synthetic || isMarkerInjection(msg)) return withDshNative({ ...msg, synthetic: true }, native);
      return withDshNative(msg, native);
    }
    case 'assistant/message': {
      // DSH assistant/message shape: {turn,step,message:{id, role:"assistant", source:{kind:"model",...}, content:[]}}
      const d = data as unknown as Record<string, unknown>;
      const m = d.message as { id?: unknown; content?: unknown; source?: unknown } | undefined;
      if (!m || !Array.isArray(m.content) || m.content.length === 0) return null;
      const msg = normalizeMessageLike(m);
      if (!msg) return null;
      const native: DshMessageNative = { source: m.source };
      if (typeof m.id === 'string') native.id = m.id;
      if (typeof d.turn === 'number') native.turn = d.turn;
      if (typeof d.step === 'number') native.step = d.step;
      // Event-level usage rides the message (SessionEventMap: no separate
      // usage record) and interrupted marks a cancelled mid-stream prefix.
      if (d.usage !== undefined && typeof d.usage === 'object' && d.usage !== null) native.usage = d.usage;
      if (d.interrupted === true) native.interrupted = true;
      if (dshContentHasImages(m.content)) native.rawContent = m.content;
      // Canonical DSH ReasoningBlock carries no signature (llm/src/types.ts),
      // so IR thinking.signature stays undefined for dsh-origin sessions —
      // nothing to preserve here (gap #1 is zcode/claude-specific).
      return withDshNative(msg, native);
    }
    case 'tool/result': {
      // Canonical DSH tool/result: {turn,step,message:{role,content,source:{kind:tool}}}
      // Preserve as role:'tool' so round-trip knows to emit tool/result.
      const d = data as Record<string, unknown>;
      const m = d.message as { id?: unknown; content?: unknown; source?: unknown } | undefined;
      if (!m || !Array.isArray(m.content)) return null;
      const msg = normalizeMessageLike(m);
      if (!msg) return null;
      // normalize to tool role
      const native: DshMessageNative = { source: m.source };
      if (typeof m.id === 'string') native.id = m.id;
      if (typeof d.turn === 'number') native.turn = d.turn;
      if (typeof d.step === 'number') native.step = d.step;
      // Event-level error identity + tool-private meta live on the EVENT, not
      // the message — without stashing them here, write-back loses both.
      if (d.error !== undefined && typeof d.error === 'object' && d.error !== null) native.resultError = d.error;
      if (d.meta !== undefined) native.resultMeta = d.meta;
      if (dshContentHasImages(m.content)) native.rawContent = m.content;
      return withDshNative({ ...msg, role: 'tool' as const }, native);
    }
    default:
      return null;
  }
}

function normalizeMessageLike(v: unknown): MigratedMessage | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const role = (o.role as MessageRole) ?? 'assistant';
  const rawContent = Array.isArray(o.content) ? o.content : [];
  // DSH stores blocks as {type:"text"|"reasoning"|"tool-call"|"tool-result", ...}.
  // Normalize into the generic ContentBlock vocabulary consumed by IR.
  const normalizedForIR: unknown[] = rawContent.map((b: unknown) => {
    if (typeof b !== 'object' || b === null) return b;
    const rec = b as Record<string, unknown>;
    // DSH ImageBlock ({type:'image', attachment:ImageAttachmentRef}) projects to
    // an IR FileBlock; the attachment-store reference rides FileBlock.url and
    // the untouched original rides meta.dsh.rawContent for lossless write-back.
    if (rec.type === 'image') {
      const file = dshImageToFileBlock(rec);
      if (file) return file;
    }
    if ((rec.type === 'tool-result' || rec.type === 'tool_result') && Array.isArray(rec.content)) {
      // Pass the interior through (with images pre-projected) so the shared
      // normalizer builds text + FileBlock attachments — previously non-text
      // tool-result content was flattened away by text-joining (gap #4).
      const inner = (rec.content as unknown[]).map((piece) => {
        if (typeof piece === 'object' && piece !== null && !Array.isArray(piece)) {
          const p = piece as Record<string, unknown>;
          if (p.type === 'image') {
            const file = dshImageToFileBlock(p);
            if (file) return file;
          }
        }
        return piece;
      });
      return { type: 'tool_result', toolUseId: String(rec.toolCallId ?? rec.toolUseId ?? rec.id ?? ''), content: inner, isError: Boolean(rec.isError) };
    }
    if (rec.type === 'reasoning' && typeof rec.text === 'string') {
      return { type: 'thinking', thinking: rec.text };
    }
    if (rec.type === 'tool-call' && typeof rec.id === 'string') {
      return { type: 'tool_use', id: rec.id, name: String(rec.name ?? 'tool'), input: tryParseJson(rec.arguments) ?? rec.arguments };
    }
    return b;
  });
  const blocks: ContentBlock[] = normalizeContent(normalizedForIR);
  // Preserve LLM identity for faithful write-back (provider/model used to build source:{kind:"model"}).
  const source = o.source as Record<string, unknown> | undefined;
  const provider = typeof source?.provider === 'string' ? source.provider : undefined;
  const model = typeof source?.model === 'string' ? source.model : undefined;
  const msg: MigratedMessage = { role, content: blocks };
  if (blocks.length === 0) return null;
  if (provider || model) {
    msg.provider = provider;
    msg.model = model;
  }
  return msg;
}

function tryParseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function isSafeSeq(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/**
 * Build IR back into DSH event rows (with seq + surfaceOp).
 *
 * v3: merges messages + goals + planModes + todos + toolCalls + unmappedEvents
 * into a single time-ordered stream, then reassigns contiguous seq 0..N-1. This
 * is the only path that makes `agent->IR->agent` lossless for DSH (see
 * docs/plans/ir-v3-lossless-100.md §3). Domain buckets are merged by time so
 * the original wall-clock ordering survives. `session/title` is synthesized
 * from `ir.title` when no matching unmapped event already carries it.
 */
export interface IrToEventsOptions {
  /** 子会话身份行 payload（subagent/descriptor 的 data）。DSH 的子代理列表把
   * `values.subagent` 为 null 的子日志直接判「会话记录损坏」（identity 只能由
   * 合法 descriptor 事件建立），外来子会话必须补一条。 */
  subagentDescriptor?: Record<string, unknown>;
  /**
   * 外来工具转译（docs/agents/dsh.md「外来工具转译」）：把源 harness 的工具名
   * （claude/zcode 的 Read/Edit/…、opencode 的 filePath 方言等）改写为 DSH 原生
   * 词汇（read/edit/…），让 GUI 的 classifyTool 命中原生卡片变体、resume 回放
   * 看到与实际工具集一致的调用形状。形状门控 + 幂等（transpile.ts），dsh→dsh
   * 的原生行逐字节不受影响。默认 true；WriteOptions.transpileTools 透传。
   */
  transpileTools?: boolean;
}

export function irToEvents(ir: MigratedSession, baseTime: number, opts?: IrToEventsOptions): DshEvent[] {
  type Raw = { time: number; type: string; data: DshEvent['data']; surfaceOp?: string; sourceEventSeqs?: number[]; _msg?: MigratedMessage; _seq?: number; _blockCall?: boolean };
  const raw: Raw[] = [];
  const transpileTools = opts?.transpileTools !== false;
  // Foreign-origin IRs (claude/codex/...) carry no per-message seq; park them
  // after every real source seq so ties keep insertion order without stealing
  // earlier positions from genuine stream events.
  const FALLBACK_SEQ_BASE = 1e12;
  let fallbackIdx = 0;

  // Preserve wall-clock time faithfully — each bucket uses its own stored time
  // verbatim; only missing timestamps fall back to baseTime with a per-bucket
  // counter. This keeps cross-bucket ordering true to the original event stream
  // (goal@1000 before message@2000) and lets the final sort restore it.
  // Per-message native restoration (gap #2): when the IR carries meta.dsh the
  // original id/source/turn/step AND any lossy-projected raw content array are
  // restored verbatim; otherwise synthesized values keep legacy behavior.
  const nativeOf = (msg: MigratedMessage): DshMessageNative =>
    (msg.meta as { dsh?: DshMessageNative } | undefined)?.dsh ?? {};
  /** Restore the original surfaceOp ('append' or a replace object) plus its
   * sourceEventSeqs provenance — without this, compacted sessions would
   * round-trip as if nothing had been shadowed. */
  const surfaceOf = (msg: MigratedMessage): { surfaceOp: unknown; sourceEventSeqs?: number[] } => {
    const native = nativeOf(msg);
    return {
      surfaceOp: native.surfaceOp ?? 'append',
      ...(native.sourceEventSeqs ? { sourceEventSeqs: native.sourceEventSeqs } : {}),
    };
  };
  let msgFallback = baseTime;
  // callIds the toolCalls bucket will re-emit as tool/call rows (dsh-origin
  // sessions) — block-derived synthesis below must not duplicate them.
  const bucketCallIds = new Set((ir.toolCalls ?? []).map((r) => r.callId));
  // Every SOURCE callId that will exist as a tool/call row: bucket
  // re-emissions plus every assistant tool_use block (block-derived synthesis
  // below). A tool/result referencing anything else can never pair — DSH
  // renders it as a ghost "Tool call <callId>" fallback card — so such
  // results must not be emitted. This is the SOURCE-id gate; the written-id
  // resolution happens through the seat queues below.
  const plannedCallIds = new Set(bucketCallIds);
  for (const m of ir.messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use' && b.id) plannedCallIds.add(b.id);
    }
  }
  // 写端 callId 席位（同会话 tool_use id 去重）。IR 的 tool_use.id 跨工具
  // 直通（零丢弃原则——IR 保持源端原值），但跨工具合并（codex subagent
  // 展平、claude 子链并入主链）可能让两个不同调用共享同一 id；DSH 读回
  // 按 callId 配对 tool/call↔tool/result，GUI 还会对同一 callId 的第二个
  // start Match 直接中止加载——重复 id 落盘会让配对错乱甚至拒绝加载。
  // 席位规则：源 id 首次占席保留原值（无人占用时），之后每次出现都换
  // `call_<uuid>` 新值；配对的 tool_result 经席位 FIFO 取到「它那一行」的
  // 写端 id，配对不会因去重而断裂。只影响写回产物，不改 IR 本身。
  const writtenCallIds = new Set<string>();
  const callSeats = new Map<string, { first: string; pending: string[] }>();
  const claimCallSeat = (sourceId: string): string => {
    const written = writtenCallIds.has(sourceId) ? `call_${randomUUID()}` : sourceId;
    writtenCallIds.add(written);
    const seats = callSeats.get(sourceId);
    if (seats) seats.pending.push(written);
    else callSeats.set(sourceId, { first: written, pending: [written] });
    return written;
  };
  /** tool/result 配对解析：FIFO 出队该源 id 最旧未配对席位；队列已空
   * （同 id 结果多于调用，或结果先于调用到达的乱序 IR）时回退首席位——
   * 引用必须始终指向一个真实存在的 tool/call 行，绝不生成孤儿。 */
  const seatForPairing = (sourceId: string): string | undefined => {
    const seats = callSeats.get(sourceId);
    if (!seats) return undefined;
    return seats.pending.shift() ?? seats.first;
  };
  // toolCalls 桶 + tool_use 块席位预分配（与消息循环同序）：桶行先占
  // （桶序=源流序），其后各 assistant 的 tool_use 块按消息序占席（已被桶
  // 覆盖的 id 跳过——那一条调用由桶行代表）。预分配而不是在循环里即时
  // 占席，是因为配对的 tool/result 可能在乱序 IR 中先于调用出现——席位
  // 先行存在，配对解析永远有席可查，不会因去重机制把结果行丢掉。
  const bucketSeatIds = (ir.toolCalls ?? []).map((r) => claimCallSeat(r.callId));
  const blockSeatQueues = new Map<string, string[]>();
  for (const m of ir.messages) {
    for (const b of m.content) {
      if (b.type !== 'tool_use' || !b.id || bucketCallIds.has(b.id)) continue;
      const seat = claimCallSeat(b.id);
      const q = blockSeatQueues.get(b.id);
      if (q) q.push(seat);
      else blockSeatQueues.set(b.id, [seat]);
    }
  }
  // —— 外来 assistant 记录按「同一次模型响应」分组合并 ——
  // claude 的流式转写把一次 LLM 响应拆成多条 assistant 记录（reasoning/文本/
  // tool_use 各一条，共享 message.id）。DSH 的会话骨架是「一个 step 恰好一条
  // assistant/message」：同 step 内第二条 assistant/message 在客户端按整块替换
  // 语义覆盖第一条（update/fallbackState 都是全量替换 blocks），不合并的话
  // reasoning/文本在 GUI 上只剩同组最后一条。仅在「无 meta.dsh（非 dsh 原生）
  // + 相邻 + meta.claude.message.id 相同」时合并；dsh→dsh 与无 id 的外来消息
  // 一律保持原样，各自落到独立 step（骨架 pass 保证可见）。
  const claudeResponseIdOf = (msg: MigratedMessage): string | undefined => {
    const native = nativeOf(msg);
    if (native.id !== undefined || native.source !== undefined) return undefined;
    const id = (msg.meta as { claude?: { message?: { id?: unknown } } } | undefined)?.claude?.message?.id;
    return typeof id === 'string' && id ? id : undefined;
  };
  const displayMessages: MigratedMessage[] = [];
  {
    let group: { rid: string; msgs: MigratedMessage[] } | null = null;
    const flushGroup = (): void => {
      if (!group) return;
      const msgs = group.msgs;
      if (msgs.length === 1) {
        displayMessages.push(msgs[0]);
      } else {
        const [first] = msgs;
        const usage = [...msgs].reverse().map((m) => nativeOf(m).usage).find((u) => u !== undefined);
        const interrupted = msgs.some((m) => nativeOf(m).interrupted === true);
        displayMessages.push({
          ...first,
          content: msgs.flatMap((m) => m.content),
          meta: {
            ...(first.meta ?? {}),
            dsh: {
              ...nativeOf(first),
              ...(usage !== undefined ? { usage } : {}),
              ...(interrupted ? { interrupted: true as const } : {}),
            },
          },
        });
      }
      group = null;
    };
    for (const msg of ir.messages) {
      const rid = claudeResponseIdOf(msg);
      if (rid !== undefined) {
        if (group && group.rid === rid) group.msgs.push(msg);
        else {
          flushGroup();
          group = { rid, msgs: [msg] };
        }
        continue;
      }
      flushGroup();
      displayMessages.push(msg);
    }
    flushGroup();
  }
  for (const msg of displayMessages) {
    const t = msg.timestamp;
    const time = typeof t === 'number' && Number.isFinite(t) ? t : msgFallback++;
    const seq = typeof msg.seq === 'number' && Number.isSafeInteger(msg.seq) ? msg.seq : FALLBACK_SEQ_BASE + fallbackIdx++;
    const native = nativeOf(msg);
    // Anthropic-style harnesses (claude) carry tool results as USER messages
    // whose content is solely tool_result blocks; pi/codex/opencode/zcode use
    // role:'tool' rows. Both shapes must project as a tool/result event —
    // emitting them as human turns garbles the DSH view and leaves the paired
    // call card without a result.
    const isToolResultCarrier = msg.content.length > 0 && msg.content.every((b) => b.type === 'tool_result');
    if (msg.role === 'tool' || (msg.role === 'user' && isToolResultCarrier)) {
      // Rebuild DSH tool/result shape: {turn,step,message:{source,role,content}}
      // preserve the nested tool-result interior expected by DSH surface.
      const toolBlocks = msg.content.filter((b) => b.type === 'tool_result');
      // DSH's assertMessageEventShape demands a tool/result message carry
      // EXACTLY ONE tool-result block whose toolCallId equals source.callId.
      // Parallel tool calls arrive here as ONE carrier message with N blocks
      // (claude user tool_result rows, zcode fused tool parts), so the carrier
      // fans out into one event per block — each pairing through its own
      // toolUseId. Collapsing them into a single event (all blocks remapped to
      // the first block's seat id) aborts the whole session at load time with
      // "message must contain one tool-result block" and misattributes the
      // remaining results to the first call.
      // Resolve the pairing callId per block: native source first (byte-
      // faithful dsh→dsh), then the dsh-native block's toolCallId, then the
      // block's toolUseId — all SOURCE ids; the written id comes out of the
      // seat queue so the pairing survives duplicate-id remapping. A result
      // whose call has no planned tool/call row (or no callId at all) can
      // never pair and would render as a ghost card — skip that block; the
      // content stays in the IR.
      const nativeSrc = native.source as { callId?: unknown } | undefined;
      const nativeCallId = typeof nativeSrc?.callId === 'string' && nativeSrc.callId ? nativeSrc.callId : undefined;
      const rawToolBlocks = Array.isArray(native.rawContent)
        ? (native.rawContent as unknown[]).filter((b): b is Record<string, unknown> =>
            b !== null && typeof b === 'object' && !Array.isArray(b) && (b as Record<string, unknown>).type === 'tool-result')
        : [];
      const rawBlockOf = (i: number): Record<string, unknown> | undefined =>
        rawToolBlocks.length === toolBlocks.length ? rawToolBlocks[i] : undefined;
      let emitted = 0;
      for (let bi = 0; bi < toolBlocks.length; bi++) {
        const blk = toolBlocks[bi];
        if (blk.type !== 'tool_result') continue;
        const rawBlk = rawBlockOf(bi);
        const rawBlockCallId = typeof rawBlk?.toolCallId === 'string' && rawBlk.toolCallId ? rawBlk.toolCallId : undefined;
        const sourceCallId = nativeCallId ?? rawBlockCallId ?? (blk.toolUseId || undefined);
        if (!sourceCallId || !plannedCallIds.has(sourceCallId)) continue;
        const pairedWrittenId = seatForPairing(sourceCallId);
        if (pairedWrittenId === undefined) continue;
        const toolData: Record<string, unknown> = {
          ...(native.turn !== undefined || native.step !== undefined
            ? { turn: native.turn ?? 1, step: native.step ?? 1 }
            : { turn: 1, step: 1 }),
          // Event-level error identity + tool-private meta were stashed on the
          // message native at read time — re-emit or DSH loses the diff card.
          // (Native only, i.e. single-block carriers; foreign rows never set it.)
          ...(native.resultError !== undefined ? { error: native.resultError } : {}),
          ...(native.resultMeta !== undefined ? { meta: native.resultMeta } : {}),
          message: {
            // 多 block 拆分时只有首条沿用 native.id——消息 id 在会话内须唯一。
            id: native.id && emitted === 0 ? native.id : `msg_${randomUUID()}`,
            role: 'user',
            // 配对引用一律用席位解析出的写端 id。source 里若带着源 callId
            // （native.source 整体保留时）必须改写成写端 id——tool/result 的
            // 配对契约在 message.source.callId 上，源 id 在这里可能已被
            // tool/call 侧的席位重映射换掉，裸写源值会配对断裂。
            source: { ...(native.source as Record<string, unknown> ?? { kind: 'tool' }), kind: 'tool', callId: pairedWrittenId },
            content: [
              rawBlk
                ? { ...rawBlk, toolCallId: pairedWrittenId }
                : (() => {
                    const inner: unknown[] = [{ type: 'text', text: blk.content }];
                    for (const att of blk.attachments ?? []) {
                      const nativeImage = dshImageFromBlock(att);
                      if (nativeImage) inner.push(nativeImage);
                      else inner.push({ type: 'text', text: `[file: ${att.filename ?? att.url ?? 'attachment'}]` });
                    }
                    return { type: 'tool-result', toolCallId: pairedWrittenId, content: inner, isError: !!blk.isError };
                  })(),
            ],
          },
        };
        // 同 (time, _seq) 的多条事件由稳定排序保持 push 序（= 源 block 序），
        // 最终 seq 由连续重排统一赋值。
        raw.push({ time, type: 'tool/result', ...(surfaceOf(msg) as { surfaceOp: string; sourceEventSeqs?: number[] }), data: toolData as unknown as DshEvent['data'], _msg: msg, _seq: seq });
        emitted++;
      }
      continue;
    }
    if (msg.role === 'user' || msg.role === 'system' || msg.role === 'developer') {
      // DSH validates user/message data IS the message: must have {id, role:"user", source:{kind}, content:[]}
      // See assertMessageEventShape in dsh-session (≈ line 1252). Plain {role,content} fails with
      // "lacks an identified message".
      //
      // Foreign harness rows: system/developer roles and messages flagged
      // `synthetic` are harness injections (codex permissions/AGENTS.md/
      // collaboration-mode text, claude isMeta, ...). DSH has no developer
      // surface — projecting them as model output or human turns makes the
      // migrated session read as garbage; DSH's own convention for persisted
      // injections is a plugin-sourced user message instead.
      const injected = msg.role !== 'user' || msg.synthetic === true;
      const contentKind = (msg.meta as { codex?: { contentKind?: string } } | undefined)?.codex?.contentKind;
      const data = {
        ...(native.id ? { id: native.id } : { id: `msg_${randomUUID()}` }),
        role: 'user' as const,
        ...(native.source !== undefined
          ? { source: native.source }
          : injected
            ? { source: { kind: 'plugin', plugin: contentKind ?? 'external-harness' } }
            : { source: { kind: 'user', rpcId: randomUUID(), clientTimeZone: 'Asia/Shanghai' } }),
        content: native.rawContent ?? dshContentFromBlocks(msg.content, transpileTools),
      } as unknown as DshEvent['data'];
      raw.push({ time, type: 'user/message', ...(surfaceOf(msg) as { surfaceOp: string; sourceEventSeqs?: number[] }), data, _msg: msg, _seq: seq });
    } else {
      const content = native.rawContent ?? dshContentFromBlocks(msg.content, transpileTools);
      // Reasoning-only foreign assistant rows carry no durable content (the
      // encrypted reasoning text was dropped at read time) — an empty
      // assistant/message would just render as a dead step in the GUI.
      if (Array.isArray(content) && content.length === 0) continue;
      // DSH validates assistant/message data as {turn,step,message:{id, role:"assistant", source:{kind:"model",provider,model}, content:[]}}
      // source identity: per-message provider/model first (foreign harnesses
      // carry it on the message), then session-level, then legacy defaults.
      // claude 源会话的真实模型名住在 meta.claude.message.model —— 显示身份按
      // 真值提升为 provider 'claude'；其余维持 legacy 默认。
      const claudeModel = (msg.meta as { claude?: { message?: { model?: unknown } } } | undefined)?.claude?.message?.model;
      const claudeModelStr = typeof claudeModel === 'string' && claudeModel ? claudeModel : undefined;
      const provider = (msg.provider as string) ?? (ir.model?.provider as string) ?? (claudeModelStr ? 'claude' : 'abrdns');
      const model = (msg.model as string) ?? (ir.model?.id as string) ?? claudeModelStr ?? 'GLM-5.3-Flash';
      const nativeSource = native.source as Record<string, unknown> | undefined;
      const data = {
        ...(native.turn !== undefined || native.step !== undefined
          ? { turn: native.turn ?? 1, step: native.step ?? 1 }
          : { turn: 1, step: 1 }),
        // Token accounting + interrupted-prefix marker travel on the event.
        ...(native.usage !== undefined ? { usage: native.usage } : {}),
        ...(native.interrupted === true ? { interrupted: true } : {}),
        message: {
          ...(native.id ? { id: native.id } : { id: `msg_${randomUUID()}` }),
          role: 'assistant' as const,
          // per-message source first (exact provider/model/requestId), else
          // session-level, else legacy defaults
          source: nativeSource ?? { kind: 'model', provider, model },
          content,
        },
      } as unknown as DshEvent['data'];
      raw.push({ time, type: 'assistant/message', ...(surfaceOf(msg) as { surfaceOp: string; sourceEventSeqs?: number[] }), data, _msg: msg, _seq: seq });
      // Foreign harnesses (codex/claude/…) keep tool calls as tool_use blocks
      // inside the assistant content. Native DSH logs pair every tool-result
      // with a standalone tool/call event — without it the GUI renders ghost
      // "Tool call <callId>" fallback cards from the orphan tool/results. Emit
      // the missing half: written callIds come from the PRE-CLAIMED block seat
      // queues (duplicate source ids got fresh call_<uuid> seats up front), so
      // message order can never double-claim and blocks already covered by an
      // IR toolCalls-bucket seat are skipped (the bucket re-emission further
      // down owns that seat for dsh-origin sessions).
      for (const b of msg.content) {
        if (b.type !== 'tool_use' || !b.id || bucketCallIds.has(b.id)) continue;
        const seatQ = blockSeatQueues.get(b.id);
        if (!seatQ || seatQ.length === 0) continue;
        const writtenId = seatQ.shift()!;
        // 外来工具转译（形状门控，transpile.ts）：未命中规则时 t 为 null，
        // 逐字节走源名 + 源 arguments 的原路径。
        const t = transpileTools ? transpileCall(b.name, b.input) : null;
        const args = t
          ? t.arguments
          : b.input === undefined
            ? ''
            : typeof b.input === 'string'
              ? b.input
              : JSON.stringify(b.input);
        raw.push({
          time,
          type: 'tool/call',
          data: { turn: 1, step: 1, callId: writtenId, name: t ? t.name : (b.name ?? 'tool'), arguments: args } as unknown as DshEvent['data'],
          _seq: seq,
          // 块派生调用行的标记：turn/step 是占位值，骨架 pass 按游标 restamp；
          // toolCalls 桶重发行的行带保留原生坐标，绝不 restamp。
          _blockCall: true,
        });
      }
    }
  }
  for (const g of ir.goals ?? []) {
    const time = typeof g.time === 'number' && Number.isFinite(g.time) ? g.time : baseTime;
    raw.push({ time, type: 'goal/change', data: g.data as unknown as DshEvent['data'], _seq: g.seq });
  }
  // toolCalls 清单 #2：re-emit one tool/call event per bucket record. A record
  // without a result (running/pending) is the ONLY representation — native DSH
  // logs carry no result event for interrupted calls; completed/error records
  // additionally pair with the tool/result events emitted from tool-role
  // messages above, matching the native trio (assistant block + tool/call +
  // tool/result). metadata.dsh restores the exact turn/step/seq and the RAW
  // model-produced arguments string. 写端 callId 用消息循环前预分配的席位
  //（bucketSeatIds）——配对的 tool/result 在消息循环里已经按 FIFO 消费同一
  // 席位队列，这里必须出同一批 id 才能对上；同 id 的第二条桶记录由此
  // 自动获得去重后的新 id，不再产生 GUI 会拒绝加载的重复 callId。
  (ir.toolCalls ?? []).forEach((tc, i) => {
    const writtenId = bucketSeatIds[i];
    const dsh = (tc.metadata as { dsh?: { turn?: number; step?: number; seq?: number; time?: number; arguments?: string } } | undefined)?.dsh;
    const time = typeof dsh?.time === 'number' && Number.isFinite(dsh.time) ? dsh.time : baseTime;
    // 外来工具转译：native 形状的行幂等原样返回（保留 metadata.dsh.arguments
    // 原始字符串，dsh→dsh 逐字节无损）；真正命中外来方言时才改写。
    const rawArgs = typeof dsh?.arguments === 'string' ? dsh.arguments : undefined;
    const t = transpileTools ? transpileCall(tc.tool, tc.input, rawArgs) : null;
    raw.push({
      time,
      type: 'tool/call',
      data: {
        turn: dsh?.turn ?? 1,
        step: dsh?.step ?? 1,
        callId: writtenId,
        name: t ? t.name : tc.tool,
        arguments: t ? t.arguments : (rawArgs ?? JSON.stringify(tc.input ?? {})),
      } as unknown as DshEvent['data'],
      _seq: isSafeSeq(dsh?.seq) ? dsh.seq : undefined,
    });
  });
  for (const p of ir.planModes ?? []) {
    const time = typeof p.time === 'number' && Number.isFinite(p.time) ? p.time : baseTime;
    raw.push({ time, type: 'plan/mode', data: p.data as unknown as DshEvent['data'], _seq: p.seq });
  }
  for (const td of ir.todos ?? []) {
    const time = typeof td.time === 'number' && Number.isFinite(td.time) ? td.time : baseTime;
    raw.push({ time, type: 'todo/write', data: td.data as unknown as DshEvent['data'], _seq: td.seq });
  }
  for (const ev of ir.unmappedEvents ?? []) {
    const time = typeof ev.time === 'number' && Number.isFinite(ev.time) ? ev.time : baseTime;
    // Packed chunk rows (seq0/time0) are stored with seq==seq0 and time==time0
    // in buildIrFromEvents (source had seq0/time0, seq was undefined — seq got
    // back-filled to seq0 in the catch-all). irToEvents must re-emit them as
    // storage rows {seq0,time0}, never as {seq,time} — the latter fails
    // decodeStorageRecord's exact-key check.
    if (PACKED_CHUNK_TYPES.has(ev.type)) {
      // Preserve seq0/time0 exactly; DSH seq contiguity is NOT enforced via
      // these rows — seq0 is validated as safe integer and the overall seq
      // accounting uses the existing events' seq coverage. Don't remap them
      // through the contiguous reassignment below.
      raw.push({
        time,
        // Use a negative sentinel so the contiguous reassignment skips them
        // (they keep their original seq0). The final map handles this.
        type: ev.type,
        data: ev.data as unknown as DshEvent['data'],
        _seq: ev.seq,
      } as unknown as Raw & { __packed: true; __seq0: number; __time0: number });
      // Stash seq0/time0 via side-channel on raw entry for the final map.
      // We piggy-back on the Raw object without polluting the type.
      (raw[raw.length - 1] as any).__packed = true;
      (raw[raw.length - 1] as any).__seq0 = ev.seq;
      (raw[raw.length - 1] as any).__time0 = time;
      continue;
    }
    // Foreign event types (codex event_msg rows like task_started/token_count,
    // or rows a newer DSH harness wrote) would make the DSH loader refuse the
    // WHOLE log — assertEventsSupported rejects any type outside
    // KNOWN_SESSION_EVENT_TYPES, and the envelope allowlist leaves no room for
    // a skip marker. Drop them here; the IR bucket keeps them for transfers to
    // harnesses that do understand the source's event vocabulary.
    // 例外：packed 3 种存储行（text-chunks 等）不属 catalog
    // （docs/session-formats-audit.md 事件类型全表——catalog 51 种 vs packed 3
    // 种是两套词汇表），读端 :790 早就在区分这两个集合。闸门必须两边都放行：
    // 只查 catalog 会把含 packed 行的会话整份拒之门外（写出即拒载）。
    if (!DSH_KNOWN_EVENT_TYPES.has(ev.type) && !PACKED_CHUNK_TYPES.has(ev.type)) continue;
    raw.push({
      time,
      type: ev.type,
      data: ev.data as unknown as DshEvent['data'],
      ...(ev.surfaceOp !== undefined ? { surfaceOp: ev.surfaceOp } : {}),
      ...(ev.sourceEventSeqs ? { sourceEventSeqs: ev.sourceEventSeqs } : {}),
      _seq: ev.seq,
    });
  }

  // 子会话身份行：DSH 的 subagent 列表对折叠不出 identity 的子日志返回
  // diagnostic reason "corrupt"（dsh-subagent resolveColdIdentity → GUI 显示
  // 「会话记录损坏」）。native 语义：establishing provider 恰好追加一条，且是
  // 子日志的第一行。排在整条流最前：时间取全流最小值减一、_seq=-3 压过
  // session/title 合成行的 -1。
  if (opts?.subagentDescriptor) {
    const minTime = raw.length ? Math.min(baseTime, ...raw.map((r) => r.time)) : baseTime;
    raw.push({ time: minTime - 1, type: 'subagent/descriptor', data: opts.subagentDescriptor as unknown as DshEvent['data'], _seq: -3 });
  }

  // ir.title: if caller set a title and no session/title event already
  // carries it, synthesize one (earliest time so it sorts first among
  // title events). This keeps `ir.title -> session/title` lossless on
  // DSH->IR->DSH when the original store held title only as header meta.
  if (ir.title) {
    const hasTitleEvent = raw.some((r) => r.type === 'session/title' || r.type.startsWith('session/title'));
    if (!hasTitleEvent) {
      // place at baseTime so it precedes conversation; matches DSH's early
      // title emission. Use the smallest time among raw, or baseTime.
      const titleTime = raw.length ? Math.min(baseTime, ...raw.map((r) => r.time)) : baseTime;
      // if titleTime equals baseTime we still need it to be <= first raw time
      raw.push({ time: titleTime, type: 'session/title', data: { title: ir.title } as unknown as DshEvent['data'], _seq: -1 });
    }
  }

  // Preserve original stream ordering across buckets: sort by wall-clock,
  // ties broken by ORIGINAL source seq. Every bucket carries the seq it had
  // in the source log, so (time, seq) reproduces the exact event order —
  // this is what keeps turn/start ahead of its surface messages and step
  // context intact (the GUI conversation skeleton validates that order).
  raw.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    return (a._seq ?? 0) - (b._seq ?? 0);
  });

  // 乱序 IR 修正 pass：DSH 的 tool-pairing 契约要求每个 tool/result 引用的
  // callId 必须由更早的 tool/call 引入（孤儿 result 渲染为 ghost 兜底卡片，
  // verifySessionLog 也按此判违规）。上面的 (time, _seq) 总排序只还原源流
  // 顺序，不含「call 必须先于其 result」约束——跨工具合并或乱序 IR（result
  // 载体消息时间戳早于配对 assistant）会把 result 排到 call 之前。修正：对
  // 每个 tool/result，若其配对 call 行排在它之后，把该 call 行移到 result
  // 紧前（其余相对顺序不动；此处 callId 都是写端席位 id 且一对一，同一
  // result 不会配对多条 call）。seq 此刻尚未赋终值（连续重排在后），移动的
  // 只是数组位置——最终 seq 由下面的 contiguous 赋值统一决定。
  {
    const callIdxByWrittenId = new Map<string, number[]>();
    raw.forEach((r, i) => {
      if (r.type !== 'tool/call') return;
      const cid = (r.data as Record<string, unknown> | undefined)?.callId;
      if (typeof cid === 'string' && cid) {
        const list = callIdxByWrittenId.get(cid) ?? [];
        list.push(i);
        callIdxByWrittenId.set(cid, list);
      }
    });
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      if (r.type !== 'tool/result') continue;
      const src = ((r.data as { message?: { source?: { callId?: unknown } } } | undefined)?.message)?.source;
      const cid = typeof src?.callId === 'string' ? src.callId : undefined;
      if (!cid) continue;
      const candidates = (callIdxByWrittenId.get(cid) ?? []).filter((j) => j !== undefined);
      const callAfter = candidates.find((j) => j > i);
      if (callAfter === undefined) continue;
      // 配对 call 在 result 之后：把它（连同它占的席位）前移到 result 紧前。
      // 多条候选时取最早的（它是 seq 序上应紧跟该 result 的那条）。
      const [moved] = raw.splice(callAfter, 1);
      raw.splice(i, 0, moved);
      // 席位索引整体偏移 1（splice 掉一个再插回一个，之后的行索引不变，
      // 之前的行 +1）——刷新索引表，防止同 id 的后续配对错位。
      callIdxByWrittenId.clear();
      raw.forEach((rr, k) => {
        if (rr.type !== 'tool/call') return;
        const c = (rr.data as Record<string, unknown> | undefined)?.callId;
        if (typeof c === 'string' && c) {
          const l = callIdxByWrittenId.get(c) ?? [];
          l.push(k);
          callIdxByWrittenId.set(c, l);
        }
      });
      // moved 行现在恰好占据位置 i（result 紧前），继续扫描下一个 result。
    }
  }

  // Separate packed storage rows (seq0/time0) from seq-assigned events.
  // Packed rows must keep exactly {type, seq0, time0, data} — the decoder
  // expands them into multiple sequential events (seq0 + k). The overall
  // decoded seq must be contiguous 0..N-1, so seq0 must align with the dense
  // assignment, not the sparse source seq0.
  const packedRaw = (raw as Array<Raw & { __packed?: boolean; __seq0?: number; __time0?: number }>).filter((r) => r.__packed);
  const normal = (raw as Array<Raw & { __packed?: boolean }>).filter((r) => !r.__packed);

  // Build packed rows sorted by (time0, original seq0). We keep their data
  // verbatim (turn/step/index/dt/texts|args) but recompute seq0 to produce a
  // contiguous decoded stream. Merge with normal events by (time, _seq) so
  // chunk payloads land exactly where they did in the source stream.
  const merged: Array<(Raw & { __packed?: boolean; __seq0?: number; __time0?: number }) | Raw> = [];
  packedRaw.sort((a, b) => ((a.__time0 ?? 0) - (b.__time0 ?? 0)) || ((a._seq ?? 0) - (b._seq ?? 0)));
  {
    let pi = 0;
    let ni = 0;
    const key = (t: number, s: number | undefined) => t * 4294967296 + (s ?? 0);
    while (ni < normal.length || pi < packedRaw.length) {
      const n = normal[ni];
      const p = packedRaw[pi];
      const nKey = n ? key(n.time, n._seq) : Infinity;
      const pKey = p ? key(p.__time0 ?? 0, p._seq) : Infinity;
      if (nKey <= pKey) {
        merged.push(normal[ni++]);
      } else {
        merged.push(packedRaw[pi++]);
      }
    }
  }

  // Reconstruct turn/step coordinates for surface events from the restored
  // stream: the GUI conversation skeleton groups assistant/message and
  // tool/result by their data.turn/data.step, which must match the
  // turn/start + step/start context they appear under (a mismatch or an
  // event before its turn/start aborts history load with "received an
  // update before its start Match").
  //
  // Two regimes:
  //  - Native (dsh→dsh, log carries turn/start rows): mark seen coordinates
  //    and never synthesize duplicates — a second start match on one context
  //    is itself a hard load error ("received more than one start Match").
  //  - Foreign (claude/codex/opencode/zcode): synthesize the FULL lifecycle
  //    DSH itself would have written. The client folds every assistant/message
  //    of one (turn,step) into a single assistant node with whole-replace
  //    semantics, so the naive "everything is turn 1 step 1" shape collapses
  //    an entire migrated conversation into ONE node showing only the last
  //    message (typically a bare tool-call card) — agent text/thinking vanish.
  //    Native shape to reproduce: turn 1 opens before the first surface row;
  //    every human prompt closes the open turn and opens the next; every
  //    assistant/message gets its OWN step (native logs have exactly one
  //    assistant/message per step); open steps/turns close with step/end /
  //    turn/end {turn, reason:{kind:'completed'}} like native logs do.
  const hasNativeTurns = merged.some((e) => !((e as { __packed?: boolean }).__packed) && (e as Raw).type === 'turn/start');
  const withSkeleton: typeof merged = [];
  if (!hasNativeTurns) {
    let turnCounter = 0;
    let curTurn = 0;
    let curStep = 0;
    let turnHasAssistant = false;
    let stepHasAssistant = false;
    let lastTime = baseTime;
    const openTurn = (time: number): void => {
      turnCounter += 1;
      curTurn = turnCounter;
      curStep = 1;
      turnHasAssistant = false;
      stepHasAssistant = false;
      withSkeleton.push({ time, type: 'turn/start', data: { turn: curTurn } } as unknown as Raw);
      withSkeleton.push({ time, type: 'step/start', data: { turn: curTurn, step: curStep } } as unknown as Raw);
    };
    const closeStep = (time: number): void => {
      if (curStep === 0) return;
      withSkeleton.push({ time, type: 'step/end', data: { turn: curTurn, step: curStep } } as unknown as Raw);
      stepHasAssistant = false;
      curStep = 0;
    };
    const closeTurn = (time: number): void => {
      if (curTurn === 0) return;
      closeStep(time);
      withSkeleton.push({ time, type: 'turn/end', data: { turn: curTurn, reason: { kind: 'completed' } } } as unknown as Raw);
      curTurn = 0;
      turnHasAssistant = false;
    };
    for (const entry of merged) {
      if ((entry as { __packed?: boolean }).__packed) {
        // packed chunk rows only exist in dsh→dsh logs; foreign streams have none.
        withSkeleton.push(entry);
        continue;
      }
      const r = entry as Raw;
      const d = r.data as Record<string, unknown> | undefined;
      lastTime = r.time;
      if (r.type === 'user/message') {
        // A human prompt (source.kind 'user') begins a new turn — unless the
        // current turn has no assistant content yet, so session-start
        // injections and the first prompt share turn 1 like native logs.
        if (turnHasAssistant && (d?.source as Record<string, unknown> | undefined)?.kind === 'user') closeTurn(r.time);
        if (curTurn === 0) openTurn(r.time);
        withSkeleton.push(entry);
        continue;
      }
      if (r.type === 'assistant/message' || r.type === 'tool/result' || r.type === 'tool/call') {
        if (curTurn === 0) openTurn(r.time);
        else if (curStep === 0) {
          curStep = 1;
          withSkeleton.push({ time: r.time, type: 'step/start', data: { turn: curTurn, step: curStep } } as unknown as Raw);
        }
        if (r.type === 'assistant/message' && stepHasAssistant) {
          // one assistant/message per step: close the spent step, open the next
          const spent = curStep;
          closeStep(r.time);
          curStep = spent + 1;
          withSkeleton.push({ time: r.time, type: 'step/start', data: { turn: curTurn, step: curStep } } as unknown as Raw);
        }
        const restamp = r.type === 'assistant/message' || r.type === 'tool/result' || r._blockCall === true;
        if (restamp) {
          (r.data as Record<string, unknown>).turn = curTurn;
          (r.data as Record<string, unknown>).step = curStep;
        }
        if (r.type === 'assistant/message') {
          turnHasAssistant = true;
          stepHasAssistant = true;
        }
        withSkeleton.push(entry);
        continue;
      }
      withSkeleton.push(entry);
    }
    closeTurn(lastTime);
  } else {
    let curTurn = 1;
    let curStep = 1;
    const startedTurns = new Set<number>();
    const startedSteps = new Set<string>();
    for (const entry of merged) {
      if ((entry as { __packed?: boolean }).__packed) {
        // packed chunk rows only exist in dsh→dsh logs (native steps already
        // started); pass through untouched.
        withSkeleton.push(entry);
        continue;
      }
      const r = entry as Raw;
      const d = r.data as Record<string, unknown> | undefined;
      if (r.type === 'turn/start') {
        if (typeof d?.turn === 'number') {
          curTurn = d.turn;
          curStep = 1;
          startedTurns.add(curTurn);
        }
        withSkeleton.push(entry);
        continue;
      }
      if (r.type === 'step/start') {
        if (typeof d?.turn === 'number') curTurn = d.turn;
        if (typeof d?.step === 'number') curStep = d.step;
        startedTurns.add(curTurn);
        startedSteps.add(`${curTurn}:${curStep}`);
        withSkeleton.push(entry);
        continue;
      }
      // Effective coordinates of this event: tool/call rows carry explicit
      // turn/step in data; assistant/message + tool/result take the running
      // cursor (stamped below).
      let evTurn: number | undefined;
      let evStep: number | undefined;
      if (r.type === 'tool/call') {
        if (typeof d?.turn === 'number') evTurn = d.turn;
        if (typeof d?.step === 'number') evStep = d.step;
      } else if (r.type === 'assistant/message' || r.type === 'tool/result') {
        evTurn = curTurn;
        evStep = curStep;
      }
      if (evTurn !== undefined && !startedTurns.has(evTurn)) {
        startedTurns.add(evTurn);
        withSkeleton.push({ time: r.time, type: 'turn/start', data: { turn: evTurn } } as unknown as Raw);
      }
      if (evTurn !== undefined && evStep !== undefined && !startedSteps.has(`${evTurn}:${evStep}`)) {
        startedSteps.add(`${evTurn}:${evStep}`);
        withSkeleton.push({ time: r.time, type: 'step/start', data: { turn: evTurn, step: evStep } } as unknown as Raw);
      }
      if (r.type === 'assistant/message' || r.type === 'tool/result') {
        (r.data as Record<string, unknown>).turn = curTurn;
        (r.data as Record<string, unknown>).step = curStep;
      }
      withSkeleton.push(entry);
    }
  }
  merged.length = 0;
  merged.push(...withSkeleton);

  // Now assign seq contiguously over the *expanded* event stream.
  // Walk merged; normal events consume 1 seq, packed rows consume
  // payload length (texts/args) seqs starting at current cursor.
  // While assigning, record oldSeq -> newSeq for every decoded event so
  // preserved replace surfaceOps and sourceEventSeqs can be re-pointed at
  // the renumbered stream (stale references are hard load failures).
  let cursor = 0;
  const out: Array<Record<string, unknown>> = [];
  const seqMap = new Map<number, number>();
  const isSourceSeq = (s: number | undefined): s is number => typeof s === 'number' && s >= 0 && s < FALLBACK_SEQ_BASE;
  for (const entry of merged) {
    if ((entry as { __packed?: boolean }).__packed) {
      const packed = entry as Raw & { __packed: boolean; __seq0: number; __time0: number };
      const data = packed.data as unknown as Record<string, unknown>;
      const payloadLen = Array.isArray((data as any).texts) ? (data as any).texts.length : Array.isArray((data as any).args) ? (data as any).args.length : 0;
      const span = Math.max(1, payloadLen);
      // Rewrite seq0 to be contiguous.
      out.push({
        type: packed.type,
        seq0: cursor,
        time0: packed.__time0,
        data: packed.data,
      });
      if (isSourceSeq(packed.__seq0)) for (let k = 0; k < span; k++) seqMap.set(packed.__seq0 + k, cursor + k);
      cursor += span;
    } else {
      const r = entry as Raw;
      const ev: Record<string, unknown> = { seq: cursor, time: r.time, type: r.type, data: r.data };
      if (SURFACE_TYPES.has(r.type)) {
        // Preserve a replace op when the source carried one; otherwise the
        // surface marker is a plain append.
        ev.surfaceOp = r.surfaceOp !== undefined && typeof r.surfaceOp === 'object' ? r.surfaceOp : 'append';
      }
      // Non-surface types never carry surfaceOp (the loader rejects that).
      if (r.sourceEventSeqs !== undefined) ev.sourceEventSeqs = r.sourceEventSeqs;
      out.push(ev);
      if (isSourceSeq(r._seq)) seqMap.set(r._seq, cursor);
      cursor++;
    }
  }

  // Re-point preserved replace ops + provenance refs at the new numbering.
  for (const ev of out) {
    const op = ev.surfaceOp;
    if (op !== undefined && typeof op === 'object' && !Array.isArray(op)) {
      const rop = op as { op: string; start: number; end: number };
      const start = seqMap.get(rop.start);
      const end = seqMap.get(rop.end);
      if (rop.op === 'replace' && start !== undefined && end !== undefined && start <= end && end < (ev.seq as number)) {
        ev.surfaceOp = { op: 'replace', start, end };
      } else if (SURFACE_TYPES.has(ev.type as string)) {
        // Referenced events no longer exist — degrade to append so the
        // artifact stays loadable (the replacing content is still present).
        ev.surfaceOp = 'append';
        delete ev.sourceEventSeqs;
      } else {
        delete ev.surfaceOp;
        delete ev.sourceEventSeqs;
      }
    }
    if (Array.isArray(ev.sourceEventSeqs)) {
      const remapped = [...new Set((ev.sourceEventSeqs as number[]).map((s) => seqMap.get(s)).filter((s): s is number => s !== undefined && s < (ev.seq as number)))].sort((a, b) => a - b);
      if (remapped.length > 0) ev.sourceEventSeqs = remapped;
      else delete ev.sourceEventSeqs;
    }
  }

  return out as unknown as DshEvent[];
}

function messageToDshData(_msg: MigratedMessage): DshEvent['data'] {
  // Legacy plain {role,content} — not used for DSH write anymore; kept for
  // non-DSH adapters via blocksToNative shape. DSH write uses dshContentFromBlocks.
  return { role: _msg.role, content: blocksToNative(_msg.content) };
}

/** Inverse of dshImageToFileBlock: an IR FileBlock carrying a
 * `dsh-attachment://<id>` url becomes a DSH ImageBlock. Returns undefined for
 * foreign files that cannot map (callers fall back to a text placeholder). */
function dshImageFromBlock(b: FileBlock): Record<string, unknown> | undefined {
  const url = b.url ?? '';
  if (!url.startsWith('dsh-attachment://')) return undefined;
  const attachmentId = url.slice('dsh-attachment://'.length);
  if (!attachmentId) return undefined;
  const attachment: Record<string, unknown> = { attachmentId, mediaType: b.mediaType ?? 'image/png' };
  if (b.filename) attachment.name = b.filename;
  return { type: 'image', attachment };
}

function dshContentFromBlocks(blocks: ContentBlock[], transpileTools: boolean): unknown[] {
  return blocks.map((b) => {
    switch (b.type) {
      case 'text':
        return { type: 'text', text: b.text };
      case 'thinking':
        // DSH stores reasoning as {type:"reasoning", text}
        return { type: 'reasoning', text: b.thinking };
      case 'tool_use': {
        // 与块派生 tool/call 行同一 transpileCall（同参同结果，确定性一致）：
        // assistant 内容里的 tool-call 块与事件行的 name/arguments 必须一致，
        // 否则 GUI 折叠与 resume 回放看到两套工具名。
        const t = transpileTools ? transpileCall(b.name, b.input) : null;
        return {
          type: 'tool-call',
          id: b.id,
          name: t ? t.name : b.name,
          arguments: t
            ? t.arguments
            : typeof b.input === 'string'
              ? b.input
              : JSON.stringify(b.input ?? {}),
        };
      }
      case 'file': {
        // DSH ImageBlock projection (gap #4); non-mappable files degrade to text.
        const image = dshImageFromBlock(b);
        if (image) return image;
        return { type: 'text', text: `[file: ${b.filename ?? b.url ?? b.mediaType ?? 'attachment'}]` };
      }
      case 'tool_result':
        // Should not appear inside user/assistant content — tool/result is its own event type.
        // Fall back to a text wrapper so the block is not silently dropped.
        return { type: 'text', text: b.content };
    }
  });
}

function buildSessionFrame(headerJson: string): Buffer {
  // header must be exactly one line + trailing newline
  return compressFrame(`${headerJson}\n`);
}

function buildEventsFrame(events: DshEvent[]): Buffer {
  const lines = events.map((e) => JSON.stringify(e)).join('\n');
  return compressFrame(`${lines}\n`);
}

/** DSH side-store path derived from a sessions root (`<dshHome>/sessions`). */
function dshStoragesPath(sessionsRoot: string, file: string): string | null {
  const dshHome = dirname(sessionsRoot);
  if (!dshHome || dshHome === sessionsRoot) return null;
  return join(dshHome, 'storages', file);
}

/** Project directory name for a cwd — DSH parks cwd-less sessions under
 * `_no-cwd`, not under the projectKey of an empty string. */
function dshProjectDirName(cwd: string): string {
  return cwd ? projectKey(cwd) : '_no-cwd';
}

/** projcache title projection (`tables.sessions[id].rows.title.val`): one JSON
 * read covers every session DSH has opened. Corrupt/missing file → empty map
 * (callers fall back to per-log scans). */
async function readProjcacheTitles(sessionsRoot: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const p = dshStoragesPath(sessionsRoot, 'session_projcache.json');
  if (!p) return out;
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch {
    return out;
  }
  try {
    const doc = JSON.parse(raw) as { tables?: { sessions?: Record<string, { rows?: { title?: { val?: unknown } } }> } };
    for (const [id, rec] of Object.entries(doc.tables?.sessions ?? {})) {
      const val = rec?.rows?.title?.val;
      if (typeof val === 'string' && val) out.set(id, val);
    }
  } catch {
    // corrupt cache — per-log fallback covers everything
  }
  return out;
}

/** Archived session ids from workspace.json's global.archivedSessionIds. */
async function readArchivedSessionIds(sessionsRoot: string): Promise<Set<string>> {
  const out = new Set<string>();
  const p = dshStoragesPath(sessionsRoot, 'workspace.json');
  if (!p) return out;
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch {
    return out;
  }
  try {
    const doc = JSON.parse(raw) as { global?: { archivedSessionIds?: unknown } };
    if (Array.isArray(doc.global?.archivedSessionIds)) {
      for (const id of doc.global.archivedSessionIds) if (typeof id === 'string') out.add(id);
    }
  } catch {
    // best-effort
  }
  return out;
}

/** Title of the LAST `session/title` event in a decompressed log — renames
 * override earlier titles, so the last one wins. When the log carries no
 * title event at all (the host generates titles lazily; fresh/short sessions
 * never get one), fall back to the FIRST HUMAN user message text — the same
 * 「有标题显标题，无标题显 first prompt」contract claude/codex listings follow.
 * Human turns are always stamped `source.kind === 'user'` (真机验证锚定，见
 * parse() 的 user/message 注入分类) — stricter here than parse's
 * unknown-kind-stays-non-synthetic rule on purpose: an unclassified injected
 * row must never become a display title. Substring-prefilters lines so only
 * title/user-ish rows pay a JSON.parse. */
function scanTitleFromLog(buf: Buffer): string | undefined {
  let title: string | undefined;
  let firstUserText: string | undefined;
  try {
    for (const line of decompressSessionBuffer(buf).split('\n')) {
      if (title === undefined && line.includes('"session/title"')) {
        let ev: DshEvent;
        try {
          ev = JSON.parse(line) as DshEvent;
        } catch {
          continue;
        }
        const t = (ev.data as Record<string, unknown> | undefined)?.title;
        if (ev.type === 'session/title' && typeof t === 'string' && t) title = t;
      }
      if (firstUserText === undefined && line.includes('"user/message"')) {
        firstUserText = scanFirstHumanUserText(line);
      }
    }
  } catch {
    return undefined;
  }
  return title ?? firstUserText;
}

/** First human-turn text from one `user/message` log line, whitespace
 * flattened and excerpted (display-title budget, same 120 cap the CLI list
 * applies). Returns undefined for anything not unmistakably a human turn —
 * notably the harness's own runtime-context rows, which INJECTION_TEXT_PREFIXES
 * classifies (parse() marks them synthetic on the same list). */
function scanFirstHumanUserText(line: string): string | undefined {
  let ev: DshEvent;
  try {
    ev = JSON.parse(line) as DshEvent;
  } catch {
    return undefined;
  }
  if (ev.type !== 'user/message') return undefined;
  const data = ev.data as Record<string, unknown> | undefined;
  const source = data?.source as Record<string, unknown> | undefined;
  if (source?.kind !== 'user') return undefined;
  const content = data?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((b) => (typeof b === 'object' && b !== null ? (b as Record<string, unknown>) : undefined))
    .filter((b): b is Record<string, unknown> => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
  if (!text) return undefined;
  if (INJECTION_TEXT_PREFIXES.some((p) => text.startsWith(p))) return undefined;
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}

/** Injection text prefixes for user/message rows the source kind cannot
 * classify: DSH's own harness stamps permissions / team-preamble / AGENTS.md /
 * environment-context / multi-agent-mode rows as ordinary `kind:"user"`
 * messages (真机样本 52be3474 锚定), and migrated sessions land SOURCE-injected
 * rows the same way, so kind alone cannot separate them. Consumed twice —
 * parse() (`isMarkerInjection`) marks prefix hits `synthetic:true`, and the
 * title fallback skips them so an injected row never becomes a display title.
 * Delegation task prompts (a child session's first kind:'user' row) carry none
 * of these prefixes and stay human turns; the team-preamble marker is pinned
 * to the backtick ("You are `/root`, the primary agent…") so plain "You are …"
 * task text cannot false-positive. */
const INJECTION_TEXT_PREFIXES = [
  '<permissions instructions>',
  '<environment_context>',
  '<user_instructions>',
  '<multi_agent_mode>',
  '<system-reminder',
  '<turn-aborted>',
  '# AGENTS.md instructions',
  'You are `', // agent-teams preamble ("You are `/root`, the primary agent…")
];

/** Injection-marker sniff for a normalized user message: the first non-empty
 * text block decides (harness fragments are single-purpose rows). */
function isMarkerInjection(msg: MigratedMessage): boolean {
  for (const b of msg.content) {
    if (b.type !== 'text') continue;
    const text = b.text.trimStart();
    if (!text) continue;
    return INJECTION_TEXT_PREFIXES.some((p) => text.startsWith(p));
  }
  return false;
}