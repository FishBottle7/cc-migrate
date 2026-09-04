# 计划：IR v3 100% 无损（除加密）

> 目标：除 `encrypted_content / encrypted` 等不可逆密文外，`agent → IR` 零丢弃；`goal / plan / todo / title / compact / tool_stream` 全量复原；不支持的字段仅在 `IR → agent` 的 `write` 侧按目标能力丢弃（显式策略）。
> 约束：开发阶段允许 **breaking**，`schemaVersion` 升至 `2`；发布后冻结兼容。
> 前置：`ir-v2-subagent-fullchain` 已落全链侧链（subagent/teammate），本计划在其上增量至无损。

## 1. 差距（当前 v2 vs 100%）

| 工具 | v2 已保（可 resume） | v2 丢弃的非加密字段（需补） | 锚点 |
|------|----------------------|------------------------------|------|
| DSH | `foldSurface(append 3 类)` + `header` + 子文件聚 `parentSession` | `goal/change`（GoalSnapshot / tombstone）| `plan/mode` | `todo/write` 全量快照 | `session/title(-llm-request)` | `compaction/*` | `approval/*` | `hook/*` | `tool/call`/`tool/code-dispatch` | `turn/step` | `agent-preset/selected` | `request/*` | `schedule/change` 等 ~40 类 `known-event-types:33` 的 `data`；`surfaceOp:'replace'+sourceEventSeqs` 闭区间；`assistant/chunk` 的 `thinking` | `packages/core/session/src/known-event-types.ts:33` `docs/persistence-catalog.md:407` `docs/subsystems/goal.md:77` |
| Claude | 主链+侧链文件 | `system/mode/permission_mode` `file-history-snapshot` `image` 原字节 `isMeta/promptId/userType/entrypoint/responseId` | `claude-code-main/src/utils/sessionStorage.ts:1039` |
| Codex | `message/function_call/_output/agent_message` | `reasoning` 非加密 `summary` | `web_search_call` `additional_tools` `context_compaction/compaction` | `codex/index.ts:398` `protocol/src/models.rs:975` |
| OpenCode | `session_message` + `task` 拆 sidechain | `project`/`session` 全列 `session_input` `session_context_epoch` `event` 全量 | `database/schema.gen.ts` `session/history.ts:30` |
| Pi | 主链+分支 | `compaction.retainedTail:271` `branch_summary.details` `custom/custom_message` `label` `session_info` `model_change` 数值 | `session-manager.ts:418/1016` |

唯一不可逆：`reasoning.encrypted_content` / 可能的 `assistant/chunk` 加密负载；写时以 `[encrypted omitted]` 占位并在 `preview` 标注。

## 2. IR v3 设计（breaking，`schemaVersion: 2`）

### 2.1 原则
1. `agent → IR` **零过滤**：每一非加密字节必入 `messages / goals / planModes / todos / unmappedEvents / extensions` 之一。
2. `IR → agent` **按能力丢弃**：`write` 侧根据目标 `ToolId` 的能力表决定是否落盘该字段（例如 Claude 不支持 `goal/change` 则丢弃，但 IR 中仍保留，往返 DSH 可恢复）。
3. `messages` 保持跨工具流水线真理；`sidechains` 保持附链真理；新增 `goals / planModes / todos` 为跨工具可理解的领域状态（DSH 原生，其他工具在 `write` 侧可忽略或映射）。

### 2.2 类型（拟改 `packages/core/src/ir.ts:59`）

```ts
export interface MigratedGoal {
  seq: number; time: number;
  data: {
    kind: 'goal/change'; version: 1;
    operation: 'create'|'edit'|'pause'|'resume'|'complete'|'blocked'|'clear'|string;
    goal?: unknown; cleared?: unknown; roundsStarted?: number; createdAt?: number; updatedAt?: number; clearedAt?: number;
    [k:string]: unknown;
  };
}
export interface MigratedPlanMode { seq:number; time:number; data: unknown; }
export interface MigratedTodo { seq:number; time:number; data: unknown; }

export interface MigratedSession {
  schemaVersion: 2;
  originTool: ToolId;
  originSessionId?: string;
  title?: string; // 来自 DSH session/title 或 Pi session_info
  createdAt?: number; cwd?: string;
  model?: { provider?: string; id:string; variant?:string };
  thinkingLevel?: string; systemPrompt?: string;
  messages: MigratedMessage[];
  sidechains?: MigratedSidechain[];
  // Domain state — typed lossless
  goals?: MigratedGoal[];
  planModes?: MigratedPlanMode[];
  todos?: MigratedTodo[];
  compaction?: Array<{ summary:string; tokensBefore?:number; retainedTail?: unknown[]; firstKeptId?: string }>;
  branchSummaries?: Array<{ fromId:string; summary:string }>;
  // Catch-all for remaining non-encrypted DSH events (approval/hook/tool/call/turn/step/...).
  // Kept as raw DSH events so same-tool round-trip is byte-faithful.
  unmappedEvents?: Array<{ seq:number; time:number; type:string; data:unknown; surfaceOp?:string; sourceEventSeqs?:number[] }>;
  extensions?: Record<string, unknown>; // per-tool raw buckets (claude.recordsRaw, codex.itemsRaw, opencode.rowsRaw, pi.entriesRaw, dsh.headerRaw)
  raw?: unknown;
}
```

### 2.3 各家落点

| 字段 | 来源 | `parse` 入 IR | `write` 到目标 |
|------|------|---------------|----------------|
| `goals` | DSH `goal/change:33` 全量 `GoalChangeMeta` | `seq/time/data` 原样入 `goals`（去 `encrypted` 若有） | DSH：按 `seq` 重排写 `goal/change`；其他：**丢弃**（目标不支持）但 IR 保留，回 DSH 可恢复 |
| `planModes` | DSH `plan/mode` | 同上 | DSH 保留，其他丢弃 |
| `todos` | DSH `todo/write` | 同上 | DSH 保留，其他丢弃 |
| `unmappedEvents` | DSH 剩余 ~40 类 `known-event-types`（除已分类的 `user/message`/`assistant/message`/`tool/result`/`goal/change`/`plan/mode`/`todo/write`） | 去 `encrypted_content` 后原样入列 | DSH 回写时合并进事件流（`seq` 重排）；其他丢弃 |
| `messages` | 三类 surface `append` | 保持 v2 | 跨工具通用 |
| `compaction/branchSummaries` | Pi `compaction.retainedTail` / DSH `replace` 区间 | 已在 v2，v3 补 DSH `replace` 的 `sourceEventSeqs` 校验 | 按目标重建或丢弃 |
| 加密 | `reasoning.encrypted_content` 等 | **丢弃 + 占位** `[encrypted omitted]` | 不写 |

### 2.4 丢弃策略表（`IR → agent`）

| 目标 | 保留 | 丢弃（显式） |
|------|------|--------------|
| DSH | 全部（`messages+goals+planModes+todos+unmappedEvents+sidechains`） | 仅 `encrypted_content` |
| Claude | `messages+sidechains` | `goals/planModes/todos/unmappedEvents` |
| Codex | `messages+sidechains`（`reasoning` 非加密可入 `thinking` 若 `flatten` 保留） | `goals/planModes/todos/unmappedEvents` |
| OpenCode | `messages+sidechains`（`todos` 可映射为 `todo` 表若后续支持） | 默认丢弃 `goals/planModes/unmappedEvents` |
| Pi | `messages+sidechains+branchSummaries/compaction` | `goals/planModes/todos/unmappedEvents` |

## 3. 适配器改动

1. **DSH `adapters/dsh/index.ts:322`**：`buildIrFromEvents` 改为全量分拣（`SURFACE_TYPES` → `messages`；`goal/change` → `goals`；`plan/mode` → `planModes`；`todo/write` → `todos`；其余 `KNOWN` → `unmappedEvents`，剥 `encrypted_content`），`header` 入 `extensions.dsh.headerRaw`；`irToEvents` 改为按 `seq` 合并 `messages+goals+planModes+todos+unmappedEvents` 重排写回；`write` 头部补 `title`→`session/title` 事件。
2. **IR `ir.ts:59` + `content.ts:26`**：升 `schemaVersion:2`，加三 typed 数组 + `unmappedEvents`，`validateSession` 校验；`thinking` 透传；`messageToText` 标注 `[encrypted omitted]`。
3. **Claude/Codex/Pi/OpenCode**：`parse` 阶段若遇到目标不支持的领域状态，仅保留于 IR，`write` 阶段按上表丢弃（不报错）。
4. **测试**：补 `dsh.test.ts` 用例：`goal/change + plan/mode + todo/write + approval/asked` 往返 DSH 保留，往返 Claude 丢弃但回 DSH 可恢复。

## 4. 实施顺序

1. IR `ir.ts` + `content.ts` breaking（`schemaVersion:2`）。
2. DSH `adapters/dsh` 全量分拣 + `irToEvents` 合并写回。
3. 其他 4 适配器 `write` 丢弃策略（最小改动）。
4. 补测试 `dsh-goal-roundtrip.test` + `cross-tool-discard.test`。
5. 文档 `docs/agents/dsh.md` `docs/design.md#3` 同步 `goal` 与无损桶说明；`verify` 同 `build + node --test --test-isolation=none`。

## 5. 验证

- `pnpm --filter @cc-migrate/core build` OK
- `node --test --test-isolation=none dist/test/*.test.js` 含新增 goal 用例
- `cli` 用 `--dst-root <tmp>` 做 `dsh→dsh`（goal 保留）与 `dsh→claude→dsh`（goal 经 IR 中转恢复）双链路验证

## 6. 风险

- `goal/change` 的 `GoalRef` 修订连续性由 DSH `GoalService` 校验，IR 仅透传 `data`，不重算 `revision`；往返时 `seq` 重排但 `data.revision` 不变，满足 `strict fold` 的 `revision` 校验。
- `seq` 重排需保持 `time` 单调；写回时按 `ir.goals/planModes/todos/unmappedEvents` 的原 `time` 排序后重赋 `seq 0..N-1`。
- 加密占位不参与 `seq` 去重校验。
