/**
 * core 工作进程 —— 由系统 Node 运行（不是 Electron 的 Node）。
 *
 * 为什么存在：Electron 37 内置 Node 22.16 的实验性 node:zlib zstd 在部分
 * zstd 帧上会原生崩溃（crashpad not connected，进程直接消失），而系统
 * Node ≥22.15 的实现稳定。同时把解析/迁移这类重活移出 Electron 主进程，
 * GUI 不再因解析卡顿。协议：stdin/stdout ipc 上的 JSON
 * { id, method, params } → { id, ok, result | error }。
 */

import { builtinRegistry, listSessions, readSource, writeTarget, projectKey, defaultDshRoot, readFirstFrameLine } from '@session-migrate/core';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const registry = builtinRegistry();

const TOOL_ENTRIES = [
  { id: 'dsh', label: 'DSH', defaultRoot: '~/.dsh/sessions' },
  { id: 'claude', label: 'Claude Code', defaultRoot: '~/.claude/projects' },
  { id: 'codex', label: 'Codex', defaultRoot: '~/.codex/sessions' },
  { id: 'pi', label: 'Pi', defaultRoot: '~/.pi/agent/sessions' },
  { id: 'opencode', label: 'OpenCode', defaultRoot: '~/.local/share/opencode/opencode.db' },
  { id: 'zcode', label: 'ZCode', defaultRoot: '~/.zcode/cli/db/db.sqlite' },
];

function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return `${homedir()}${p.slice(1)}`;
  return p;
}

function assertTool(tool) {
  const hit = TOOL_ENTRIES.find((t) => t.id === tool);
  if (!hit) throw new Error(`未知工具: ${tool}`);
  return tool;
}

/**
 * DSH 子代理会话（header.parentSession 指向主会话）不作为顶层条目展示 ——
 * 与 DSH 自身选择器语义一致；它们经主会话预览的「子代理」披露行到达。
 * 只在能确凿读到 parentSession 时隐藏；读不到（文件缺失/格式变化）一律保留。
 */
async function filterDshChildSessions(metas, root) {
  const sessionsRoot = root ?? defaultDshRoot();
  if (!sessionsRoot) return metas;
  const kept = [];
  for (const m of metas) {
    const proj = m.cwd ? projectKey(m.cwd) : '_no-cwd';
    let isChild = false;
    try {
      const buf = await readFile(join(sessionsRoot, proj, m.sessionId, 'session.jsonl.zstd'));
      const headerLine = readFirstFrameLine(buf);
      if (headerLine) {
        const header = JSON.parse(headerLine);
        isChild = typeof header.parentSession === 'string' && header.parentSession.length > 0;
      }
    } catch {
      // 读不到 → 不隐藏
    }
    if (!isChild) kept.push(m);
  }
  return kept;
}

/* ── 结构化预览 DTO（与 src/main/ipc-types.ts 的形状一致）───── */
const CAP_TEXT = 10_000;
const CAP_AUX = 2_000;

function capText(s, n) {
  return s.length > n ? { text: s.slice(0, n), truncated: true } : { text: s };
}

function blockToDto(b) {
  switch (b.type) {
    case 'text': {
      if (!b.text) return null;
      const { text, truncated } = capText(b.text, CAP_TEXT);
      return { t: 'text', text, truncated };
    }
    case 'thinking': {
      if (!b.thinking) return null;
      const { text, truncated } = capText(b.thinking, CAP_AUX);
      return { t: 'think', text, truncated };
    }
    case 'tool_use': {
      let input;
      try {
        input = JSON.stringify(b.input, null, 2) ?? '';
      } catch {
        input = String(b.input);
      }
      const { text, truncated } = capText(input, CAP_AUX);
      return { t: 'tool_use', callId: b.id, name: b.name || 'tool', text, truncated };
    }
    case 'tool_result': {
      const { text, truncated } = capText(b.content ?? '', CAP_AUX);
      return { t: 'tool_result', callId: b.toolUseId, isError: b.isError, text, truncated };
    }
    case 'file':
      return { t: 'file', name: b.filename, mediaType: b.mediaType };
    default:
      return null;
  }
}

function messagesToDto(messages) {
  return messages.map((m) => ({
    role: m.role,
    ts: m.timestamp,
    model: m.model,
    synthetic: m.synthetic,
    blocks: m.content.map(blockToDto).filter((b) => b !== null),
  }));
}

// 每条子代理最多投影的消息数：预览用，防单个巨型 Task 把 IPC 载荷撑爆
const SC_MSG_CAP = 300;

async function buildPreview({ tool, sessionId, root }) {
  const t = assertTool(tool);
  const ir = await readSource(registry, t, sessionId, root ? expandHome(root) : undefined);
  return {
    tool: t,
    sessionId,
    title: ir.title,
    createdAt: ir.createdAt,
    cwd: ir.cwd,
    model: ir.model?.id,
    messageCount: ir.messages.length,
    sidechainCount: ir.sidechains?.length ?? 0,
    toolCallCount: ir.toolCalls?.length ?? 0,
    hasSidechains: (ir.sidechains?.length ?? 0) > 0,
    messages: messagesToDto(ir.messages),
    sidechains: (ir.sidechains ?? []).map((sc) => {
      const msgs = sc.messages ?? [];
      const capped = msgs.slice(0, SC_MSG_CAP);
      return {
        agentId: sc.agentId,
        agentType: sc.agentType,
        parentCallId: sc.parentMessageId,
        truncated: msgs.length > SC_MSG_CAP || undefined,
        messages: messagesToDto(capped),
      };
    }),
  };
}

// readSource 是 async —— worker 里直接 await，包一层保持 dispatch 简单
async function onMessage(msg) {
  const { id, method, params } = msg ?? {};
  if (typeof id !== 'number') return;
  try {
    let result;
    switch (method) {
      case 'list-tools':
        result = TOOL_ENTRIES.filter((t) => registry.has(t.id));
        break;
      case 'list-sessions': {
        const tool = assertTool(params.tool);
        const expandedRoot = params.root ? expandHome(params.root) : undefined;
        const metas = await listSessions(registry.get(tool), expandedRoot);
        result = tool === 'dsh' ? await filterDshChildSessions(metas, expandedRoot) : metas;
        break;
      }
      case 'preview':
        result = await buildPreview(params);
        break;
      case 'migrate': {
        const src = assertTool(params.srcTool);
        const dst = assertTool(params.dstTool);
        const ir = await readSource(registry, src, params.sessionId, params.srcRoot ? expandHome(params.srcRoot) : undefined);
        const disambiguateTitle = src === 'dsh' && dst === 'dsh';
        const res = await writeTarget(registry.get(dst), ir, {
          root: params.dstRoot ? expandHome(params.dstRoot) : undefined,
          targetCwd: params.targetCwd ? expandHome(params.targetCwd) : undefined,
          flatten: params.flatten,
          keepSynthetic: params.keepSynthetic,
          ...(disambiguateTitle ? { disambiguateTitle: true } : {}),
        });
        result = { tool: dst, sessionId: res.sessionId, paths: res.paths };
        break;
      }
      default:
        throw new Error(`unknown method: ${method}`);
    }
    process.send({ id, ok: true, result });
  } catch (e) {
    process.send({ id, ok: false, error: e?.message ?? String(e) });
  }
}

process.on('message', (msg) => void onMessage(msg));
process.on('disconnect', () => process.exit(0));
