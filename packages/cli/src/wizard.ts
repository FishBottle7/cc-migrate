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

  // flatten hint for OpenCode
  let flatten: boolean | undefined = pre?.flatten;
  if (flatten === undefined && (srcTool === 'opencode' || dstTool === 'opencode')) {
    const ans = (await io.question('OpenCode hidden task 展平为可对话消息？ [Y/n] > ')).trim().toLowerCase();
    flatten = !(ans === 'n' || ans === 'no');
  }

  // 4) confirm
  io.print('\n—— 即将执行 ——');
  io.print(`  ${srcTool}:${sessionId}  →  ${dstTool}${dstRoot ? ` @ ${dstRoot}` : ''}${targetCwd ? ` (cwd=${targetCwd})` : ''}`);
  const confirm = (await io.question('确认迁移？ [Y/n] > ')).trim().toLowerCase();
  if (confirm === 'n' || confirm === 'no') {
    io.print('已取消。');
    return null;
  }

  const ir = await deps.readSource(registry, srcTool!, sessionId!, srcRoot);
  const dstAdapter = registry.get(dstTool!);
  const res = await deps.writeTarget(dstAdapter, ir, { root: dstRoot, targetCwd: targetCwd ?? (ir as { cwd?: string }).cwd, flatten });
  io.print(`\n已迁移 ${srcTool}:${sessionId} → ${dstTool}:${res.sessionId}`);
  for (const p of res.paths) io.print(`  ${p}`);
  return res;
}
