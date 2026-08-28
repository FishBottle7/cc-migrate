# 计划：IR v2 子代理全链路保真（5 家）

> 目标：`DSH / Claude Code / Codex / OpenCode / Pi` 的 subagent / teammate / 隐藏链路在 IR 中**完整搬运**，且 `OpenCode 隐藏 task → DSH/Claude 等可直接对话`时自动展平。
> 约束：开发阶段，**允许破环式重写** `packages/core/src/ir.ts`（不兼容旧 IR），发布后才冻结兼容。
> 关联：`docs/agents/*.md` 一 agent 一档为权威锚点；`docs/session-formats-audit.md` 为总表。

## 1. 现状与结论

| 工具 | 原生形态 | 盘上落点 | 隐藏/可对话 | 锚点 |
|------|----------|----------|-------------|------|
| **Claude subagent** | `AgentTool` 派生 | `~/.claude/projects/<enc-cwd>/<sid>/subagents/agent-<id>.jsonl` + `.meta.json:{agentType}` | 可独立打开，主链不混排 | `claude-code-main/src/utils/sessionStorage.ts:247` |
| **Claude teammate** | `swarm` / `in_process_teammate` | **无独立文件**；`AppState.teamContext.teammates` 内存 + 主链内 `<teammate-message teammate_id>` 标签 | 隐藏在主链 user 包裹文本中；任务对象不落盘 | `Task.ts:10` / `xml.ts:51` / `print.ts:2601` |
| **DSH subagent** | `origin:subagent` + `parentSession` + `seedLength` | **独立** `session.jsonl.zstd`（`--<projectKey>--/<id>/`），父子靠 header 四元组关联 | 独立可 resume 会话 | `packages/core/session/src/types.ts:61` / `format.ts:149` |
| **OpenCode subagent** | `assistant tool: task {description,prompt,subagent_type}` | 同一 `session_message.seq` 序列内，嵌在 `assistant.content[].tool.state.output` | **用户不能直接对话**（仅 tool 输出内嵌转录） | `opencode-dev/packages/core/src/session/history.ts` / `session-message.ts:30` |
| **Pi** | 无独立 subagent；同一文件树分支 | 单文件 `id/parentId(8hex)+leafId` 树 | 分支在同一 `.jsonl` 内 | `pi-main/.../session-manager.ts:479/1016` |
| **Codex** | spawned sibling rollout | **独立** `rollout-*.jsonl[.zst]` | 独立会话 | `codex-rs/core/src/rollout/list.rs:379` |

**关键洞察**
- Claude 的 `subagent` 与 `teammate` 是两套模型，但对迁移而言都应归一为 `sidechain`（teammate 以 `kind:'teammate'` 区分，`agentId=name@team`）。
- OpenCode 的“隐藏”不是 `hidden` 列，而是 **tool 嵌套**；迁移到 DSH/Claude/Pi 时必须**拆解展平**为顶层 `user→assistant` 链，否则目标用户无法直接对话。
- DSH/Codex 的子链是**独立文件**，发现靠扫全量 header（DSH 仅读首 frame，Codex 扫 `sessions/**`）。
- Pi 无侧车文件，所有分支在同一树内；`branch_summary` / `retainedTail` 已自包含 checkpoint。

## 2. IR v2 设计（破环式）

### 2.1 原则
1. **上限=消息级**：各家内部状态机（DSH `replace` 闭区间 / Claude `parentUuid` / Codex Responses / OpenCode `seq` / Pi `parentId` 树）不逐事件复刻；B 级 = `role+content` + `tool id 重映射` + `cwd/model` 可续。
2. 线性主链 `messages[]` 为对话真理；`seq`/`parentId`/`parentUuid`/`leafId` 由目标适配器在 `write` 时重建。
3. 旁链**完整搬运文件/嵌套转录**，不折叠为摘要文本。

### 2.2 类型（拟重写 `packages/core/src/ir.ts:23`）

```ts
export type ToolId = 'dsh'|'claude'|'codex'|'opencode'|'pi'|'unknown';

export type ContentBlock =
  | { type:'text'; text: string }
  | { type:'tool_use'; id: string; name: string; input: unknown }
  | { type:'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type:'thinking'; thinking: string }; // Codex reasoning / Pi thinking，可配置丢弃

export interface MigratedMessage {
  role: 'user'|'assistant'|'tool'|'system';
  content: ContentBlock[];
  timestamp?: number; // epoch ms 归一（Pi ISO / DSH time / Claude timestamp）
  // 归档用 provider/model/stopReason，预览/模型提示
  provider?: string; model?: string; stopReason?: string;
}

export type SidechainKind = 'subagent'|'teammate'; // teammate 仅 Claude 产生，但统一承载

export interface MigratedSidechain {
  agentId: string;        // Claude: agent-<id> / name@team；DSH: child session id；OpenCode: task id；Pi: branch leaf id
  kind: SidechainKind;    // 默认 subagent；Claude teammate 填 teammate
  agentType?: string;     // Claude .meta.json:agentType / OpenCode subagent_type / DSH agentPreset
  parentMessageId?: string; // 触发该旁链的父消息关联（Claude tool_use id / DSH seed 边界 / OpenCode task tool id）
  messages: MigratedMessage[]; // 分支内单调，新在后；OpenCode 的 task.output 展平后落此
}

export interface MigratedSession {
  schemaVersion: 1;
  originTool: ToolId;
  originSessionId?: string;
  title?: string;         // Pi session_info.name / DSH session/title / Codex thread_name
  createdAt?: number;
  cwd?: string;           // 目标适配器重算编码（DSH projectKey/_no-cwd、Claude enc、Pi --path--）
  model?: { provider?: string; id: string; variant?: string };
  thinkingLevel?: string; // Pi thinking_level_change
  systemPrompt?: string;  // Codex session_meta.instructions / DSH request/context
  messages: MigratedMessage[]; // 主链
  sidechains?: MigratedSidechain[];
  // 保真边车（可选，不影响最小可 resume）
  compaction?: Array<{ summary: string; tokensBefore?: number; retainedTail?: unknown[]; firstKeptId?: string }>;
  branchSummaries?: Array<{ fromId: string; summary: string }>; // Pi branch_summary
  extensions?: Record<string, unknown>; // DSH delegationDepth/parentSession/seedLength/origin、Pi custom/label 等透传
  raw?: unknown;
}
```

### 2.3 各家落点

| 特性 | IR 落点 | parse 动作 | write 动作 |
|------|---------|------------|------------|
| Claude `subagents/agent-*.jsonl` | `sidechains[kind=subagent]` | 扫 `subagents/`，`isSidechain:true & agentId` 入链 | 每条写 `subagents/agent-<id>.jsonl` + `.meta.json` |
| Claude `<teammate-message>` | `sidechains[kind=teammate]` | 正则解析主链 user 的 `<teammate-message teammate_id>` 标签 → 独立 sidechain；`agentId=name@team` | 同上写侧车文件（目标统一为可独立打开的 sidechain）；或按目标选择 inline 注释 |
| DSH `parentSession/seedLength/origin/delegationDepth` | `sidechains` + `extensions` | 扫全量 header，`header.parentSession===parentId` 聚合子会话；`foldSurface` 仅取 `append` 三类 | 每条 sidechain 落独立 `session.jsonl.zstd`（`parentSession=parentId, origin:subagent, delegationDepth=parent+1, seedLength`） |
| OpenCode `assistant.tool:task` 嵌套 | `sidechains`（flatten） | `SessionHistory.load` 按 `seq ASC`，筛 `assistant.content[].tool==='task'`，取 `state.input:{prompt,subagent_type}` + `state.output` 递归拆解为 `MigratedSidechain.messages` | **到交互式目标**：`sidechains → 子会话文件/侧车`（DSH/Claude/Pi）；**到 OpenCode**：`sidechains → 嵌回 task tool 块`（保隐藏语义） |
| Pi 树分支 | `messages`（主 leaf 路径）+ 可选 `sidechains`（非主分支） | `buildContextEntries(leafId)` 为主链；其余分支 `getTree()` 非主路径各分支导出为 sidechain | 主链写线性 `message` 链；sidechain 写为 `branch_summary` + 分支 `message` 链（或单独 `.jsonl` 若目标为 Claude/DSH） |
| Codex sibling rollout | `sidechains`（若存在父子关联） | 暂按独立会话；若上层编排有父子 id 约定则聚为 sidechain | 每条 sidechain 独立 `rollout-*.jsonl` |
| `compaction/branch_summary` | `compaction/branchSummaries` | Pi: `compaction.retainedTail` 自包含；DSH: `replace` 区间摘要 | 目标按本工具 `compaction` 语义重建或丢弃重放 |

### 2.4 交互性翻转（核心需求）

- **OpenCode → DSH/Claude/Pi**：`task.output` 内的完整转录（`user/assistant/tool` 子链）**必须展平为 `MigratedSidechain.messages`**，目标用户可直接 `/resume` 该 sidechain 继续对话（Claude 侧车可独立打开，DSH 为独立 session）。
- **DSH/Claude → OpenCode**：`sidechains` 可选择**压回**为 `assistant` 的 `task` 工具块（保留隐藏语义），或作为独立 `session` 行（取决于 `write` 选项 `flatten:false/true`）。
- 默认策略：跨到交互式框架一律 `flatten:true`；同为隐藏语义的目标可保留嵌套。

## 3. 适配器契约（5 家）

- `Adapter.parse(sessionId, root?) → MigratedSession`：含 `sidechains` 聚合；Claude 需额外解析 teammate 标签；OpenCode 需拆 `task` 嵌套；DSH 需扫子会话；Pi 需 `getTree()` 分支导出。
- `Adapter.write(ir, opts:{root?, targetCwd?, sessionId?, flatten?:boolean}) → WriteResult{tool, sessionId, paths}`：`flatten` 控制 OpenCode 嵌套 vs 展开；`cwd` 重算各自编码；`tool_use/tool_result` id 全局重映射；Pi 需满足 `_persist.hasAssistant`（至少 1 条 assistant）。
- `Adapter.listSessions / preview`：`preview` 需渲染 `sidechains` 摘要（`[sidechain: <agentId> (<kind>)]` + 首条文本）。

## 4. 实施步骤（顺序）

1. **IR 破环重写**：`packages/core/src/ir.ts:65` 按 §2.2 替换类型与 `validateSession`，`content.ts:18` 同步 `thinking` 块。
2. **Claude 适配器**：`packages/core/src/adapters/claude/index.ts` 增 teammate 标签解析（`xml.ts:51` 正则），`sidechains.kind` 透传，`write` 按 `kind` 同落 `subagents/`。
3. **DSH 适配器**：`packages/core/src/adapters/dsh/{index.ts,format.ts}` 增子会话聚合（扫 `root` 仅读首 frame header，`parentSession===id`），`write` 为每个 sidechain 落子 `session.jsonl.zstd`（`delegationDepth+1`）。
4. **OpenCode 适配器**：新增 `packages/core/src/adapters/opencode/`，`parse` 拆 `task` tool 嵌套为 sidechain，`write` 支持 `flatten` 双模式（`project+session+session_message` 事务，`seq 0..N-1`，`msg_*`）。
5. **Pi 适配器**：新增 `packages/core/src/adapters/pi/`，`parse` 主 leaf + 分支导出，`write` `id 8hex` 碰撞重试 + `hasAssistant` 守卫。
6. **Codex 适配器**：`packages/core/src/adapters/codex/` 适配 `_<rolloutId>.jsonl.zst` 与 `ResponseItem` 增量；sibling 预留 sidechain。
7. **CLI/GUI**：`preview` 渲染 sidechain；`migrate` 透传 `flatten`；`list` 标注 `sidechain count`。
8. **文档**：`docs/agents/*.md` 已一档一策；`docs/design.md#3` 同步 IR v2；本计划归档。

## 5. 验证

- `cd packages/core; pnpm run build && node --test --test-isolation=none dist/test/*.test.js`（`pnpm -r --sort build` 会 EPERM，逐包 build）。
- `node packages/cli/dist/index.js list/preview/migrate --root <tmp> --flatten` 在临时 `--dst-root` 上做 `claude↔dsh` / `opencode→claude/dsh` 真实数据 round-trip，不污染 `~/.dsh` 等。
- 用例：至少覆盖 `子代理分支完整保留`、`teammate 归一`、`OpenCode task 展平可对话` 三条。

## 6. 风险与取舍

- 隐藏链路展平会使目标会话条数膨胀，但满足“可直接对话”优于“保持隐藏”。
- DSH/Codex 子会话为独立文件，`migrate` 需返回 `paths[]` 含全部子文件；调用方需按 `parentSession` 维持父子关联。
- Pi 分支导出为 sidechain 时需决定 `parentMessageId` 锚点，默认锚到分支起点的父消息。
- OpenCode 的 `project/worktree` 绝对路径需按 `path.ts` 归一，Windows `\`→`/` 处理。

## 7. 相关文档

- `docs/agents/dsh.md` / `claude.md` / `codex.md` / `opencode.md` / `pi.md` / `cursor-windsurf.md`
- `docs/session-formats-audit.md` v2（含 DELTA）
- `docs/design.md` v2（IR 与 sidechain 章节待本计划合入）
