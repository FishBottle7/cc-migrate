/**
 * Interactive wizard for `session-migrate`.
 *
 * Runs in a terminal without extra dependencies. Flow:
 *   1) pick source tool (+ optional source root for DSH/Claude/Codex/Pi)
 *   2) list sessions, pick one (with offline preview + filtering)
 *   3) pick target tool (+ optional target root) and target cwd
 *   4) confirm and execute migrate
 *
 * The helpers are factored out of the TTY readline loop so the core
 * selection logic can be covered by hermetic tests without a terminal.
 */

import type { SessionMeta, ToolId } from '@session-migrate/core';

export const TOOLS: ToolId[] = ['dsh', 'claude', 'codex', 'pi', 'opencode'];

export interface WizardAnswers {
  srcTool: ToolId;
  srcRoot?: string;
  sessionId: string;
  dstTool: ToolId;
  dstRoot?: string;
  targetCwd?: string;
  flatten?: boolean;
}

/** Result of the wizard run. */
export interface WizardResult {
  sessionId: string;
  paths: string[];
}

/** Resolve default roots for display. */
export function defaultRootFor(tool: ToolId): string {
  switch (tool) {
    case 'dsh': return '~/.dsh/sessions';
    case 'claude': return '~/.claude/projects';
    case 'codex': return '~/.codex/sessions';
    case 'pi': return '~/.pi/agent/sessions';
    case 'opencode': return '~/.local/share/opencode/opencode.db';
    default: return '';
  }
}

/** Filter metas by substring (case-insensitive) on id/title/cwd/path. */
export function filterMetas(metas: SessionMeta[], query: string): SessionMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return metas;
  return metas.filter((m) =>
    String(m.sessionId).toLowerCase().includes(q) ||
    String(m.title ?? '').toLowerCase().includes(q) ||
    String(m.cwd ?? '').toLowerCase().includes(q) ||
    String(m.sourcePath ?? '').toLowerCase().includes(q),
  );
}

/** Parse a 1-based selection input (supports "3" or "3 " plus aliases like "q" for quit). */
export function parseSelection(input: string, max: number): { kind: 'quit' | 'filter' | 'select'; index?: number; query?: string } {
  const raw = input.trim();
  if (!raw) return { kind: 'filter', query: '' };
  if (/^(q|quit|exit)$/i.test(raw)) return { kind: 'quit' };
  if (/^f\s+/i.test(raw) || raw.startsWith('/')) {
    const q = raw.startsWith('/') ? raw.slice(1) : raw.slice(1).trim();
    return { kind: 'filter', query: q };
  }
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= max) return { kind: 'select', index: n - 1 };
  return { kind: 'filter', query: raw };
}

/** Format a meta for display in the picker list. */
export function formatMetaLine(idx: number, m: SessionMeta): string {
  const iso = m.createdAt ? new Date(m.createdAt).toISOString().slice(0, 19).replace('T', ' ') : '—';
  const title = m.title ? truncate(m.title, 40) : '';
  const cwd = m.cwd ? truncate(m.cwd, 32) : '';
  const tail = [title, cwd].filter(Boolean).join(' | ');
  return `${String(idx + 1).padStart(3)}. ${m.sessionId}  ${iso}${tail ? '  ' + tail : ''}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Totally pure ordering: sort metas newest-first then promptUuid-ish.
 * Mirrors typical gallery UX without touching adapters.
 */
export function sortMetas(metas: SessionMeta[]): SessionMeta[] {
  return [...metas].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

// ── IO abstraction so tests can inject fakes without a terminal ──────

export interface WizardIO {
  print(line: string): void;
  question(prompt: string): Promise<string>;
  close?(): void;
}

export interface WizardDeps {
  builtinRegistry(): { get(tool: ToolId): { listSessions(root?: string): Promise<SessionMeta[]>; preview(ir: unknown): string; parse(id: string, root?: string): Promise<unknown>; write(ir: unknown, opts?: unknown): Promise<{ sessionId: string; paths: string[] }> } };
  previewSession(adapter: unknown, ir: unknown): string;
  readSource(registry: unknown, tool: string, sessionId: string, root?: string): Promise<unknown>;
  writeTarget(adapter: unknown, ir: unknown, opts?: unknown): Promise<{ sessionId: string; paths: string[] }>;
  listSessions(adapter: unknown, root?: string): Promise<SessionMeta[]>;
}

async function tryFilterDshTopLevel(metas: SessionMeta[]): Promise<SessionMeta[]> {
  const topLevel: SessionMeta[] = [];
  for (const m of metas) {
    const p = m.sourcePath;
    if (!p) { topLevel.push(m); continue; }
    try {
      const { readFile } = await import('node:fs/promises');
      const buf = (await readFile(p)) as unknown as Buffer;
      let plain: string;
      try {
        const { zstdDecompressSync } = await import('node:zlib') as unknown as { zstdDecompressSync(b: Buffer): Buffer };
        // replicate scanZstdFrameRanges heuristic from dsh/format.ts
        const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
        const anchors: number[] = [];
        let pos = 0;
        for (;;) {
          const found = (buf as Buffer).indexOf(magic, pos);
          if (found === -1) break;
          anchors.push(found);
          pos = found + 4;
        }
        let acc = Buffer.alloc(0);
        for (let i = 0; i < anchors.length; i++) {
          const start = anchors[i];
          const end = i + 1 < anchors.length ? anchors[i + 1] : (buf as Buffer).length;
          acc = Buffer.concat([acc, zstdDecompressSync((buf as Buffer).subarray(start, end))]);
        }
        plain = acc.toString('utf8');
      } catch {
        plain = (buf as Buffer).toString('utf8');
      }
      const first = plain.split('\n').find((l: string) => l.trim());
      if (!first) { topLevel.push(m); continue; }
      const hdr = JSON.parse(first) as Record<string, unknown>;
      if (!hdr.parentSession) topLevel.push(m);
    } catch {
      topLevel.push(m);
    }
  }
  return topLevel;
}

/**
 * Run the wizard with given IO + deps. The outer `wizard` CLI command wires
 * this to a real readline IO and real core deps.
 */
export async function runWizard(io: WizardIO, deps: WizardDeps, pre?: Partial<WizardAnswers>): Promise<WizardResult | null> {
  const registry = deps.builtinRegistry();

  // 1) source tool
  let srcTool = pre?.srcTool;
  if (!srcTool) {
    io.print('');
    io.print('== session-migrate wizard ==');
    io.print(`源工具 (source): ${TOOLS.join(' / ')}  [默认 dsh]`);
    const ans = (await io.question('源工具 > ')).trim().toLowerCase() || 'dsh';
    if (!TOOLS.includes(ans as ToolId)) {
      io.print(`未知工具: ${ans}，可选: ${TOOLS.join(', ')}`);
      return null;
    }
    srcTool = ans as ToolId;
  }

  // optional source root
  let srcRoot = pre?.srcRoot;
  if (srcRoot === undefined && !pre?.srcTool) {
    const def = defaultRootFor(srcTool!);
    const ans = (await io.question(`源目录 (默认 ${def}，回车跳过) > `)).trim();
    if (ans) srcRoot = ans;
  }

  // 2) list + pick session
  let sessionId = pre?.sessionId;
  let pickedMeta: SessionMeta | undefined;
  if (!sessionId) {
    const adapter = registry.get(srcTool!);
    io.print(`\n正在扫描 ${srcTool}${srcRoot ? ` @ ${srcRoot}` : ''} ...`);
    let metas = await deps.listSessions(adapter, srcRoot);
    metas = sortMetas(metas);
    // DSH: hide subagent children (header.parentSession) from the top-level picker
    if (srcTool === 'dsh' && metas.length > 1) {
      const topLevel = await tryFilterDshTopLevel(metas);
      if (topLevel.length > 0 && topLevel.length < metas.length) {
        io.print(`（已隐藏 ${metas.length - topLevel.length} 个子代理会话，仅显示顶层会话）`);
        metas = topLevel;
      }
    }
    if (metas.length === 0) {
      io.print('未找到任何会话。可用 --src-root 指定目录，或先用 `list` 检查。');
      return null;
    }
    let filtered = metas;
    let filterQuery = '';
    for (;;) {
      const page = filtered.slice(0, 50);
      io.print('');
      io.print(`找到 ${metas.length} 个会话${filterQuery ? `，过滤 "${filterQuery}" 后 ${filtered.length} 个` : ''}（仅显示前 ${page.length} 个）：`);
      for (let i = 0; i < page.length; i++) io.print(formatMetaLine(i, page[i]));
      if (filtered.length > page.length) io.print(`  ... 还有 ${filtered.length - page.length} 个，输入过滤词缩小范围`);
      io.print('');
      io.print('输入编号选择会话；输入文字过滤；`/` 前缀或 `f <词>` 也可过滤；`q` 退出');
      const ans = await io.question('选择 > ');
      const sel = parseSelection(ans, filtered.length);
      if (sel.kind === 'quit') return null;
      if (sel.kind === 'select') {
        pickedMeta = filtered[sel.index!];
        sessionId = pickedMeta.sessionId;
        break;
      }
      const q = (sel.query ?? '').trim();
      filterQuery = q;
      filtered = filterMetas(metas, q);
      if (filtered.length === 0) {
        io.print(`无匹配 "${q}"，回车显示全部或输入其他关键词`);
        const again = await io.question('过滤 > ');
        if (!again.trim()) { filtered = metas; filterQuery = ''; }
        else filtered = filterMetas(metas, again);
      }
    }
    // preview
    if (pickedMeta || sessionId) {
      const sid = sessionId!;
      io.print(`\n—— 预览 ${srcTool}:${sid} ——`);
      try {
        const ir = await deps.readSource(registry, srcTool!, sid, srcRoot);
        const adapter = registry.get(srcTool!);
        const text = deps.previewSession(adapter, ir);
        const lines = text.split('\n');
        const head = lines.slice(0, 80).join('\n');
        io.print(head);
        if (lines.length > 80) io.print(`\n... 还有 ${lines.length - 80} 行（完整内容在迁移后仍保留）`);
      } catch (e) {
        io.print(`预览失败: ${String((e as Error)?.message ?? e)}`);
      }
      const ok = (await io.question('\n使用该会话继续？ [Y/n] > ')).trim().toLowerCase();
      if (ok === 'n' || ok === 'no') return null;
    }
  }

  // 3) target tool
  let dstTool = pre?.dstTool;
  if (!dstTool) {
    io.print(`\n目标工具 (target): ${TOOLS.join(' / ')}  [默认 dsh]`);
    const ans = (await io.question('目标工具 > ')).trim().toLowerCase() || 'dsh';
    if (!TOOLS.includes(ans as ToolId)) {
      io.print(`未知工具: ${ans}`);
      return null;
    }
    dstTool = ans as ToolId;
  }
  let dstRoot = pre?.dstRoot;
  if (dstRoot === undefined && !pre?.dstTool) {
    const def = defaultRootFor(dstTool!);
    const ans = (await io.question(`目标目录 (默认 ${def}，回车跳过) > `)).trim();
    if (ans) dstRoot = ans;
  }
  let targetCwd: string | undefined = pre?.targetCwd;
  if (targetCwd === undefined && !pre?.targetCwd) {
    const hint = pickedMeta?.cwd ? ` (源 cwd: ${pickedMeta.cwd})` : '';
    const ans = (await io.question(`目标 cwd${hint}（回车沿用源 cwd）> `)).trim();
    if (ans) targetCwd = ans;
  }

  // We need the IR once to decide whether flatten is relevant. Reuse preview
  // IR when possible; otherwise read once here before confirm.
  let cachedIr: unknown | null = null;
  // preview already read it — keep a handle if we captured it
  // (capture is done by stashing after preview; simplest: re-read once now)
  // Only prompt about flatten when it actually matters: at least one side is
  // opencode AND the session carries sidechains/hidden tasks.
  let flatten: boolean | undefined = pre?.flatten;
  if (flatten === undefined && (srcTool === 'opencode' || dstTool === 'opencode')) {
    try {
      cachedIr = await deps.readSource(registry, srcTool!, sessionId!, srcRoot);
    } catch {
      cachedIr = null;
    }
    const hasSidechains = !!(cachedIr && typeof cachedIr === 'object' && Array.isArray((cachedIr as { sidechains?: unknown[] }).sidechains) && ((cachedIr as { sidechains?: unknown[] }).sidechains!.length > 0));
    // opencode source always deserves the question even if parse didn't emit
    // sidechains — the hidden-task extraction might still be relevant. For
    // non-opencode sources, only ask when there is actually a sidechain to
    // decide about.
    const shouldAsk = srcTool === 'opencode' ? true : hasSidechains;
    if (shouldAsk) {
      let prompt: string;
      if (srcTool === 'opencode' && dstTool !== 'opencode') {
        prompt = '检测到 OpenCode hidden task，是否展平为目标工具的独立旁链（Y=可直接续聊）？ [Y/n] > ';
      } else if (srcTool !== 'opencode' && dstTool === 'opencode') {
        prompt = '目标为 OpenCode，是否将旁链展平为顶层消息（Y）还是压回 task 工具块（N，保留隐藏语义）？ [Y/n，默认 Y] > ';
      } else {
        prompt = 'OpenCode 间迁移，是否保持展平（Y）还是保留 hidden task 嵌套（N）？ [Y/n，默认 Y] > ';
      }
      const ans = (await io.question(prompt)).trim().toLowerCase();
      flatten = !(ans === 'n' || ans === 'no');
    }
  }

  // 4) confirm
  io.print('\n—— 即将执行 ——');
  io.print(`  ${srcTool}:${sessionId}  →  ${dstTool}${dstRoot ? ` @ ${dstRoot}` : ''}${targetCwd ? ` (cwd=${targetCwd})` : ''}${flatten !== undefined ? `  [flatten=${flatten}]` : ''}`);
  const confirm = (await io.question('确认迁移？ [Y/n] > ')).trim().toLowerCase();
  if (confirm === 'n' || confirm === 'no') {
    io.print('已取消。');
    return null;
  }

  const ir = (cachedIr as unknown) ?? await deps.readSource(registry, srcTool!, sessionId!, srcRoot);
  const dstAdapter = registry.get(dstTool!);
  // DSH self-migration titles collide (export filename is title-sanitized).
  // Opt into the adapter's disambiguation suffix so the migrated filename
  // is visibly distinct (e.g. "foo (migrated).md") without breaking the
  // lossless round-trip tests (which call write without this flag).
  const disambiguateTitle = srcTool === 'dsh' && dstTool === 'dsh';
  const res = await deps.writeTarget(dstAdapter, ir, { root: dstRoot, targetCwd: targetCwd ?? (ir as { cwd?: string }).cwd, flatten, ...(disambiguateTitle ? { disambiguateTitle: true } : {}) });
  io.print(`\n已迁移 ${srcTool}:${sessionId} → ${dstTool}:${res.sessionId}`);
  for (const p of res.paths) io.print(`  ${p}`);
  return res;
}
