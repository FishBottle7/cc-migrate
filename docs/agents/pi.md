# Pi — 特征与存储（2026-09-01 深度调查重写）

> 源码：`pi-main` 本地快照 @ `0.84.3`（`packages/coding-agent/package.json` version；上游为 pi-mono repo）· 现役格式 `version:3` · 锚点：`packages/coding-agent/src/core/session-manager.ts`（下称 `sm.ts`）、`src/config.ts`、`docs/session-format.md`、`src/core/messages.ts`、`src/core/system-prompt.ts`、`src/core/resource-loader.ts`、`src/core/agent-session.ts`。
>
> 本次重写由 v3「除加密外零丢弃」复审驱动：旧版调查（@ `0.0.3` 快照）过浅，且与代码有漂移。本文档为 pi 适配器重写的**契约基准**；IR 槽位变更已同步登记 `docs/ir-protocol.md` §「v3.3 登记（pi）」。

## 0. 上一版调查的错误与漂移（先读）

旧版文档（2026-08 基于上游 `0.0.3`）存在以下与现役代码不符的断言，重写适配器时一律以本文为准：

| # | 旧断言 | 现实（锚点） |
|---|--------|--------------|
| D1 | `list` 「仅读首行做 header 发现」 | v3 链的 `list`/`listAll` 走 `buildSessionInfo`：**createReadStream 流式读全文件**提取 name/messageCount/firstMessage/modified（`sm.ts:688`）。只读 header 的是 `findMostRecentSession`（`continueRecent` 的快路径，`sm.ts:572/636`） |
| D2 | 「`_no-cwd` 罕见分支」 | 现役代码已无 `_no-cwd` 分支（全仓 grep 无果）。旧会话若 header 无 cwd，`open` 走 `getMissingSessionCwdIssue` → 交互式让用户选 cwd（`main.ts:679`） |
| D3 | `retainedTail` 「`session-format.md:238` / `:322`，v3 自包含 checkpoint」 | **文档超前于 v3 实现**：v3 `CompactionEntry`（`sm.ts:69`）**没有 `retainedTail` 字段**；v3 的 `buildContextEntries`（`sm.ts:418`）只用 `firstKeptEntryId`。`retainedTail` 是 **v4 harness 层**（`packages/agent/src/harness`）的字段——该层另起炉灶（见 §7）。真实 v3 文件里出现 `retainedTail` 只可能来自 v4 harness 写入或扩展注入 |
| D4 | sidechain 「暂不主用（Pi 的分支在同一文件树内）」 | 半对半错，旧版没写清：pi 树内兄弟分支**本身**确实不等于跨工具侧链；但现适配器**已经在做**兄弟分支 ↔ `MigratedSidechain` 双向映射（读端 leaf-path 剥离、写端 sibling 挂载）。漂移在于文档没登记这个映射契约，见 §6 |
| D5 | 丢弃承诺：v3 计划的丢弃策略表写「Pi 保留 `branchSummaries`/`compaction`」 | 代码事实相反：pi 适配器 parse 连 `compaction`/`branch_summary` 都丢弃，写端也不消费 `ir.compaction`/`ir.branchSummaries`。承诺未兑现，见 §8 |

## 1. 定位与发现

```
~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl
```

- `path` 编码（`sm.ts:479` `getDefaultSessionDirPath`）：`cwd`（先 `resolvePath`）去**一个**前导 `/` 或 `\`（正则 `^[/\\]`，单字符——非全局），再把 `/` `\` `:` 全换 `-`，包成 `--...--`。⚠️ 现役实现与旧版描述「去前导 `/`/`\`（`+` 量词）」有细微差异：v4 jsonl repo（`harness/session/jsonl/repo.ts:29`）同样单字符。适配器保持现实现的 `/^[/\\]+/` 偏保守（多剥也无妨，目录名歧义极小），不改
- 文件名（`sm.ts:953`）：`new Date().toISOString().replace(/[:.]/g,"-")` + `_` + `uuidv7()` + `.jsonl`
- session id（header `id`）：**uuidv7 整串**（`sm.ts:208`），且 `assertValidSessionId`（`sm.ts:212`）限定 `[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]`。⚠️ 现适配器 write 用 `opts?.sessionId ?? randomUUID()`（v4 而非 v7，格式等价合法）——OK；但**读端条目 id 是另一套**（8-char hex），不要混淆
- 可覆盖（`config.ts:502` + `main.ts:670`）：`--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > `settings.json:sessionDir`；另有 `PI_CODING_AGENT_DIR`（换整个 agent 根）。适配器现实现两级 env 已对齐
- 发现/listing：`SessionManager.list(cwd, sessionDir?)`（单项目目录）/ `listAll()`（跨全部 `--...--` 目录）；并发 10（`sm.ts:770`），**流式读全文件**（D1）；`SessionInfo` 含 `name`（最新 `session_info`，含显式清除）、`parentSessionPath`、`messageCount`、`modified`（最后 user/assistant 活动时间 > header 时间 > mtime，`sm.ts:744`）
- resume：`SessionManager.open(path, sessionDir?, cwdOverride?)`；`--session <path|id>` 支持部分 id 匹配；`continueRecent`（`pi -c`）按 mtime + cwd 匹配取最近（`sm.ts:636`）

## 2. 记录格式（v3 JSONL 树，`docs/session-format.md` + `sm.ts:32-156`）

首行 header + N 条 entry。header 无 `id`/`parentId`（不进树）：

```json
{"type":"session","version":3,"id":"<uuidv7>","timestamp":"<ISO>","cwd":"/abs/path","parentSession":"/abs/path.jsonl"?}
```

entry 基座 `{type, id, parentId, timestamp(ISO)}`；`id` 8-char hex（`randomUUID().slice(0,8)` + `generateId` 100 次碰撞重试 + 全 uuid 兜底，`sm.ts:221`）；首条 `parentId:null`，其余指向父条目；**文件内 append 顺序 ≠ 树序**（分支后 append 的是兄弟，挂在旧节点下）。

### 2.1 十类条目 × pi 自身消费语义（迁移决策的依据）

| type | 进 LLM context | pi 内消费点（锚点） | 迁移动作 |
|------|----------------|---------------------|----------|
| `session` header | 否 | 元数据；`parentSession` 仅溯源展示 | → `meta.pi.header`（含 parentSession 指针） |
| `message` | 是 | `sessionEntryToContextMessages`（`sm.ts:383`）直通 | → `messages[]`（按 §3 词汇映射） |
| `compaction` | 是（投影为 `compactionSummary` user 消息） | `buildContextEntries`（`sm.ts:418`）按 `firstKeptEntryId` 折叠 | → `compaction[]` 桶 + anchor 消息（§8） |
| `branch_summary` | 是（投影为 `branchSummary` user 消息） | `/tree` 分支时生成；`convertToLlm` 注入 `BRANCH_SUMMARY_PREFIX` 包裹文本（`messages.ts:19`） | → `branchSummaries[]` + anchor 消息（§8） |
| `custom_message` | 是（投影为 `role:'custom'`，`convertToLlm` 再转 user 行） | 扩展注入；`display` 只控 TUI | → `messages[]` user 行 + `meta.pi`（`synthetic:true`） |
| `model_change` | 否（推导态） | `getSessionContextSettings`（`sm.ts:362`）last-wins 推导 `model` | → 写回重放；读端→`meta.pi.settingsEvents` |
| `thinking_level_change` | 否（推导态） | 同上推导 `thinkingLevel`（默认 `"off"`） | 同上 |
| `custom` | 否 | 扩展状态持久化（`customType`+`data`），reload 时扩展自扫 | → `meta.pi.customEntries` |
| `label` | 否 | 书签：`labelsById` 覆盖语义（`label:null` 清除）；`getTree` 解析进节点 | → `meta.pi.labels` |
| `session_info` | 否 | 显示名：`getSessionName` 倒序找最新，空名显式清除（`sm.ts:1150`） | → `title` + `meta.pi.settingsEvents` |

关键分界：`compaction`/`branch_summary`/`session_info` 不是「日志噪音」——它们分别是 pi 的上下文折叠锚、分支上下文恢复机制、显示名载体，全部参与 pi 的 resume 行为。**v3 读端只处理 `message`/`model_change`/`thinking_level_change` 三类是丢信息，不是合理简化**（8 类里 6 类静默丢弃，`unmappedEvents` 也没进——零丢弃原则双重违反）。

### 2.2 版本迁移（读端**显式拒绝**旧版本——2026-09-02 产品决策）

- v1→v2：补 `id`/`parentId` 链 + `firstKeptEntryIndex` → `firstKeptEntryId`（按**数组下标**换算，`sm.ts:246`；⚠️ 下标基准是**含 header 的全 entries 数组**——`migrateV1ToV2` 直接 `entries[comp.firstKeptEntryIndex]`，header 是 entries[0]）
- v2→v3：`hookMessage` role 改名 `custom`（`sm.ts:267`）
- `migrateToCurrentVersion`（`sm.ts:281`）在 `open` 时**原地改写文件**（`_rewriteFile`）
- **适配器决策（2026-09-02，与 v4 防线同款纪律）**：开发阶段只支持现役 `version:3`——v1/v2 文件 parse 时**显式报错跳过**（错误信息提示「用 pi open 一次让其原地迁移后再导出」），不做容忍解析。理由：旧树形（v1 无 id/parentId、firstKeptEntryIndex、v2 hookMessage）的半吊子容忍解析风险是**静默解析错**，比显式拒绝更糟；且 pi 自己的 open 迁移是官方通道，无需我们代劳。我们仍然**绝不自己触发 pi 的 open 迁移、绝不写源文件**（见 §10）
- `loadEntriesFromFile`（`sm.ts:514`）**跳过 malformed 行**（不报错）+ 末行无换行自动补 `\n`（`sm.ts:555`）+ 首行非 session header 则整体判非法返回空。适配器 parse 对**现役 v3 文件**同样宽容逐行、但**不能像 pi 一样静默重写源文件**

## 3. 消息词汇（`AgentMessage`，`docs/session-format.md` + `pi-ai/src/types.ts`）

`message` entry 的载荷是七种 role 的并集（pi-ai 基础 3 + coding-agent 扩展 4，declaration merging）：

| role | 载荷要点 | IR 投影 |
|------|----------|---------|
| `user` | `content: string \| (Text\|Image)[]`，`timestamp` epoch ms | → `user` 消息（FileBlock 承载 image） |
| `assistant` | `content: (Text\|Thinking\|ToolCall)[]`，另有 `api/provider/model/responseModel?/responseId?/usage/stopReason/deferred?/errorMessage?/rawStopReason?/endTurn?/diagnostics?`（`pi-ai/types.ts:427`） | 块→IR 块（toolCall→tool_use）；**字段级载荷→`meta.pi`**（见下） |
| `toolResult` | `toolCallId`/`toolName`/`content:(Text\|Image)[]`/`details?`/`usage?`/`addedToolNames?`/`isError` 全在**消息级**（非块内） | → `tool` 消息 + `tool_result` 块；`details`/`toolName`→`meta.pi`（现适配器已做） |
| `bashExecution` | `command/output/exitCode/cancelled/truncated/fullOutputPath?/excludeFromContext?`（`!!` 前缀命令不进 context） | → `user` 消息（`bashExecutionToText` 同构渲染，`messages.ts:82`）+ `meta.pi.bash` 保真 + `synthetic:true` |
| `custom` | `customType/content/display/details?`（`custom_message` entry 投影产物；`convertToLlm` 转为 user 行） | → `user` 消息 + `meta.pi.custom` + `synthetic:true` |
| `branchSummary` | `summary/fromId`（`branch_summary` entry 投影产物） | → 不直进 messages；见 §8 桶+锚 |
| `compactionSummary` | `summary/tokensBefore`（`compaction` entry 投影产物） | → 不直进 messages；见 §8 桶+锚 |

⚠️ 现适配器两个已修复的坑（保留知识，勿回退）：
1. `toolCall`/`toolResult` 词汇折叠（pi 原生块名 vs IR 块名；结果 id 在消息级）——2026-08 已修（`foldPiBlock` + `toolResult` 分支 + `meta.pi.toolName/details`）。
2. `developer`/`system` role 降级 user 文本行（pi 词汇表没有这两个 role；写原生行会非法 + pi 读回会当 assistant）——v3.1 契约，勿回退。

新增（本次登记，§8 汇总）：`bashExecution`/`custom`/`branchSummary`/`compactionSummary` 四个 pi 特有 role 之前在 `piMessageToIr` 的 else 分支被**静默按 user/assistant 折叠或丢弃**；`assistant` 的 `usage`/`stopReason` 之外的 9 个字段（`api`/`responseModel`/`responseId`/`deferred`/`errorMessage`/`rawStopReason`/`endTurn`/`diagnostics`/`timestamp` 精度）全丢。修法见 §8。

## 4. Context 构建（resume 语义，写端必须镜像）

- `buildContextEntries`（`sm.ts:418`）：从 leaf 沿 `parentId` 回溯到根得活跃路径；若路径上有 `compaction`：取**最后一个** compaction，context = `[compaction] + [firstKeptEntryId..compaction) 的条目 + compaction 之后的条目`（被摘要的旧段不出现在活跃面，但仍留在文件里——**日志 ≠ 模型可见面**，与 DSH 压缩同型，踩坑契约见 `docs/ir-protocol.md`「压缩折叠的坑」）
- `buildSessionContext`（`sm.ts:461`）= 路径设置推导（`getSessionContextSettings:362`：`thinking_level_change`/`model_change`/assistant 消息三源 last-wins）+ `sessionEntryToContextMessages` 逐条投影（`sm.ts:383`：message 直通（`content==null` 兜底 `[]`）→ compaction 投 `compactionSummary` → branch_summary 投 `branchSummary` → custom_message 投 `custom`；**v3 层不消费 `retainedTail`**，D3）
- **主链判定**：文件 append 顺序的最后一个 entry 是 leaf（`_buildIndex` 逐条覆盖 `leafId`，`sm.ts:964`）。现适配器读端「最后 message 的 id 回溯」与此等价；但 write 端**必须注意**：新写文件里 append 序 = 树序时 leaf 就是最后一条，pi resume 即取到全部（不丢尾部）
- 分支操作：`branch(entryId)` 只移动 leaf 指针（append-only，不改历史）；`branchWithSummary`（`sm.ts:1382`）从 leaf 移到目标并挂 `branch_summary`（`fromId` = 离开时的 leaf，可 `"root"`）；`createBranchedSession(leafId)`（`sm.ts:1414`）抽取 root→leaf 路径成**新文件**（剥离 label 条目再重挂链 + `parentSession` 指回原文件 + `_no-cwd` 不存在，无 cwd 时 fork 会失败）
- **多 root**：`getTree`（`sm.ts:1311`）把孤儿（断链/自指）也当 root。`resetLeaf()` 后 append 会造出 `parentId:null` 的第二 root——合法树形态，迁移时不可假设单 root

## 5. 落盘守卫（写端必须满足，否则 pi 拒绝/幽灵化）

1. **`_persist` hasAssistant 守卫**（`sm.ts:1019`）：首个 assistant 消息前**不落盘**（`flushed` 状态机）；无 assistant 的会话只有内存态。迁移写必须保证至少一条 assistant（现适配器补 `(migrated session — continuation)` 占位行——保留）。
2. **id 双体系**：header id = uuidv7（`assertValidSessionId` 门）；entry id = 8-hex（`generateId` 碰撞重试）。写端生成 entry id 需对同文件已有 id 做碰撞检测（现适配器 `byId` set 已做）。
3. **append-only**：pi 自己从不改历史（除 `open` 时的版本迁移整文件重写）。迁移写 = 一次性生成整文件，无此问题；但**严禁**对源文件做任何写操作。
4. 文件已存在时 pi `open` 的行为（`sm.ts:901`）：空文件 → 初始化 header；非空但非 pi 会话 → **抛错不修改**。迁移写总是新文件（时间戳文件名），无冲突。
5. `timestamp` 双层：entry 级 ISO 字符串、message 级 epoch ms——两层语义独立（entry 时间是「持久化时刻」，message 时间是「事件时刻」），往返都要保。

## 6. 树 ↔ sidechain 语义（漂移修复，D4）

**事实链**：pi 分支是**同文件内的树分叉**，不是 Claude 式侧车文件。`/tree` 导航 + `createBranchedSession`（抽路径成新文件）+ `/fork`（`forkFrom` 复制全部非 header 条目到新文件，`parentSession` 指源，`sm.ts:1581`）构成三种「分支」形态。

**适配器契约（现实现已做，本文正式登记）**：

- **读端**：leaf-path（`buildSessionPath` 语义）上的 message 进 `messages[]`（主链）；不在 leaf-path 上的 message 按分支根分组为 `MigratedSidechain[]`（`kind:'subagent'` 是**借位标注**——pi 兄弟分支是探索分支而非子代理任务，`agentId = pi-<branchRootId>`）。**注意**：主链判定的 leaf 是「文件里最后一条 message entry」，与 pi 的真实 leaf（最后 entry，可能非 message）在 label/compaction 尾随时有偏差——重写时改为「最后一条 entry 回溯」以精确对齐 `buildSessionPath`。
- **写端**：IR `messages[]` 链式挂载为主枝；`sidechains[]` 从首条主链消息的 id 分叉成兄弟枝（append 序上兄弟在主枝之后，树形合法）；每条侧链尾随一个 `branch_summary`（`fromId` 指该枝叶）标注「这是迁移来的侧链」，让 pi 用户在 `/tree` 里可辨识。
- **往返语义**：pi→IR→pi 时兄弟分支保真（树形 + 消息不丢）；跨工具→pi 时 IR 侧链降级为 pi 树内兄弟分支（上下文可见性语义不同——pi 兄弟分支不进主链 context，但分支摘要可由 pi 原生 `branchSummary` 机制恢复上下文，写端按上条挂 `branch_summary` 即可让 pi 用户手动 `branchWithSummary`）。

## 7. 双会话层现状：v3（coding-agent）与 v4 harness（packages/agent/src/harness）

pi-mono 内部正在长一套**新的 harness 会话层**（`packages/agent/src/harness`），与 v3 并存。迁移适配器必须知道它，但**当前不实现**：

- v4 JSONL：首行 `{kind:'header', version:4, id, createdAt(ms), cwd, parentSessionId?, legacyParentSessionPath?, metadata?}`；行带 `seq`（全文件递增）、`kind:'entry'|'record'|'lane'|'fact'`（`harness/session/jsonl/codec.ts`）；entry 词汇 7 类（v3 的 10 类去掉 `custom_message`/`label`/`session_info`，加 `active_tools_change`；label/name 变为 fact 变更而非树 entry）；record 词汇 9 类（operation_started 含 **`intent.systemPromptOverride`**、tool_started/usage 等记账记录）；**`compaction.retainedTail` 在 v4 是必填**（`harness/session/types.ts:47`），且 context 构建（`harness/session/context.ts:47`）确实消费它
- v4 存储：`JsonlSessionRepo`（同 `--cwd--` 目录约定，`repo.ts:29`）+ **sqlite 后端**（`packages/session-backends/sqlite-node`，含 FTS 搜索）；v4 `delete` 是真删（`repo.ts:138`）
- **接线现状**：`pi` CLI 主链（main.ts → createAgentSession → AgentSession/SessionManager）仍是 v3。v4 的消费方是 `coding-agent/src/server/create-harness.ts`（SDK server 场景）与 evals——**尚未成为默认落盘格式**。v3 现役 + v4 已有产物并存意味着：同目录下可能同时有 v3/v4 文件（v4 header `kind:'header'` 一眼可辨，v3 header `type:'session'`）
- **迁移决策**：适配器 parse 遇 `kind:'header'` 的文件→显式报「v4 harness 格式暂不支持」并跳过（不静默丢）；write 一律产 v3。v4 转正后再立独立调查（record/usage/lane 语义量大，值得单开一期，勿现在半吊子支持）

## 8. IR 槽位缺口与 v3.3 登记（本次调查的产出，落地形状以 `docs/ir-protocol.md` §「v3.3 登记（pi）」为准）

对照 §2.1/§3 全量盘点，pi 源有信息而 IR 无槽位的，按「优先加类型化字段，原生全量兜底进 meta.pi」分配：

| # | pi 源信息 | IR 落点 | 说明 |
|---|-----------|---------|------|
| 1 | `compaction` entry（summary/firstKeptEntryId/tokensBefore/details?/usage?/fromHook?/entryId/entryTimestamp） | `compaction[]`（已有桶补全：`firstKeptId`、`tokensBefore`、`retainedTail?` v4 兼容）+ 原生残件 `meta`（entryId/timestamp/details/usage/fromHook）+ **anchor 消息**（§8.2） | v3 计划承诺的「Pi 保留 compaction」兑现 |
| 2 | `branch_summary` entry（fromId/summary/details?/usage?/fromHook?） | `branchSummaries[]` 扩展为 `{fromId, summary, anchorIndex?, time?, meta?}` + anchor 消息 | v3 计划承诺的「Pi 保留 branchSummaries」兑现 |
| 3 | `session_info`（name，含显式清除语义） | `title`（最新非空即用；清除语义进 `meta.pi.titleCleared`） | |
| 4 | `model_change`/`thinking_level_change` 序列（历史变更，含位置） | 推导态（最后值）入既有 `model`/`thinkingLevel`；**全序列**进 `meta.pi.settingsEvents`（写回按序重放） | 现适配器只取 last，序列丢弃 |
| 5 | `label`（targetId/label/清除） | `meta.pi.labels: {targetId, label?, time}[]` | 书签是用户手工标记，丢=丢用户数据 |
| 6 | `custom` entry（customType/data） | `meta.pi.customEntries: {customType, data, time}[]` | 扩展状态持久化 |
| 7 | `custom_message` entry（customType/content/display/details） | `messages[]` user 行（content 按 §3 投影）+ `synthetic:true` + `meta.pi.customMessage`（customType/display/details） | 进 context 的扩展注入，必须随消息走 |
| 8 | `assistant` 消息 9 个无槽位字段 | `meta.pi.message`（api/responseModel/responseId/deferred/errorMessage/rawStopReason/endTurn/diagnostics/usage 中除已映射 stopReason 之外者） | 挂消息实体（勿 id 旁表）；IR 已有 `usage` 概念先例（`meta.dsh.usage`） |
| 9 | `bashExecution` 消息全字段 | `messages[]` user 行 + `meta.pi.bash`（command/exitCode/cancelled/truncated/fullOutputPath/excludeFromContext）+ `synthetic:true`（excludeFromContext 时照记，写回还原该标记） | |
| 10 | header `parentSession`（fork 溯源） | `meta.pi.header.parentSession`；`SessionMeta.parentSessionId?` 列表级已有槽位可复用（值=源文件路径非 id，登记语义） | |
| 11 | `thinking` 块的 pi 原生形态（`ThinkingContent` 无 signature） | 已有 `thinking` 块直通，无缺口 | 确认无遗漏 |
| 12 | `toolResult.details`/`addedToolNames`/`usage` | `meta.pi` 扩字段（details 已做；补 addedToolNames/usage） | |

### 8.2 anchor 消息契约（compaction/branch_summary 的双载体表达）

pi 的 compaction/branch_summary 在**原生 context 里是 user 消息**（`convertToLlm`：`COMPACTION_SUMMARY_PREFIX`/`BRANCH_SUMMARY_PREFIX` 包裹，`messages.ts:11-24`）。为保跨工具回放，IR 按 dsh/zcode 已确立的 anchor 模式处理：

- `messages[]` 插入一条 user 消息承载**渲染后的摘要文本**（按 pi 原生 prefix/suffix 同构渲染，`synthetic:true`，`meta.pi.anchor = {kind:'compaction'|'branch_summary', entryId}`）
- 桶条目 `anchorIndex` 指向该消息；结构化残件留在桶（v3 计划「摘要文本随 messages 流动，结构化载荷留桶」的通用契约）
- **写回 pi**：桶 → 原生 entry（不写渲染文本进 entry 的 summary 字段——summary 字段存纯摘要；渲染是 pi 运行时行为）；messages[] 里那条 anchor 消息**跳过**（防双写）
- **写回其他工具**（dsh/claude/zcode…）：只消费 anchor 消息（它们不认识 pi 桶），文本已在 messages[] 里流动——与其他工具的 compaction 契约天然兼容
- 活跃面折叠语义（§4）：pi 的旧段在原生是「留在文件但不进 context」。跨工具写 pi 时按「压缩折叠坑」契约三选一并在本文档登记选择：**选 3**（完整归档——IR messages[] 全量进 pi 文件；被折叠段进 pi 文件但不挂 compaction 的 firstKept 区间即恢复原状；代价是 pi resume 后上下文变大，但语义诚实且无损）。理由：pi 的 compaction 锚定 `firstKeptEntryId` 是 pi 运行时算出来的 cut point，迁移侧伪造一个 cut 只会破坏摘要与保留段的对应关系

## 9. 系统提示词（迁移必须明确的语义）

**pi 的系统提示词 100% 是运行时产物，会话文件里一个字节都不存。** 完整链路（本机 0.84.3 源码锚点）：

1. **构建**（`agent-session.ts:_rebuildSystemPrompt:1051` → `core/system-prompt.ts:buildSystemPrompt:28`）：
   - 基底：pi 内置开发者提示词（含工具清单、guidelines、pi 文档索引、`Current working directory: <cwd>`）
   - **替换**：`.pi/SYSTEM.md`（项目级，需 project trust）→ `~/.pi/agent/SYSTEM.md`（全局）——`customPrompt` 语义是**整体替换**内置基底（`resource-loader.ts:1023`）
   - **追加**：`APPEND_SYSTEM.md`（同两级发现，`resource-loader.ts:1037`）→ `appendSystemPrompt`
   - **项目上下文**：AGENTS.md 家族（`AGENTS.override.md`/`AGENTS.md`/`AGENTS.MD`/`CLAUDE.md`/`CLAUDE.MD`，cwd 向上逐级 + worktree 去重逻辑，`resource-loader.ts:72/108`）作为 `<project_context>` 块并入
   - skills 清单、工具增减都会实时重建（`setActiveToolsByName:950`）
2. **逐轮覆盖**：扩展 `before_agent_start` 可返回 `systemPrompt` 临时覆盖（仅本轮，`agent-session.ts:1278`，`_systemPromptOverride`），轮结束复位
3. **resume 不读取任何持久化提示词**：`switchSession`/`open` 只回放 messages；`agent.state.systemPrompt` 每次 runtime 创建时重建（`sdk.ts:308` 初始 `""`，会话建立后赋 `_rebuildSystemPrompt` 产物）
4. v4 harness 有 `intent.systemPromptOverride`（operation record，§7）——同样运行时态，不落系统提示词正文

**对迁移的三个直接结论**：

- **pi 读端：`ir.systemPrompt` 恒空。** pi 会话不含提示词正文；AGENTS.md 内容 pi 也不持久化进会话（每次启动重读文件——文件还在原项目里，迁移不该替它快照）。遵守 v3.2 #8 语义冻结。
- **pi 写端：忽略 `ir.systemPrompt`，绝不把它写进会话正文。** pi 没有任何「会话级系统提示词」原生槽位；若把源提示词写成 user/developer 消息，pi resume 后会在自己的运行时提示词（含 AGENTS.md 重读）**之下再叠一份**——双叠直接劣化 agent 表现。正确姿势：用户想让 pi 带上源提示词 → 写 `~/.pi/agent/SYSTEM.md` 或 `.pi/SYSTEM.md`（pi 的原生替换/追加通道，`customPrompt`/`appendSystemPrompt`），**由人在 pi 侧手工/半自动配置**，迁移工具最多提示这个通道，不代写会话内容。这与 v3.2 #8「目标端有原生通道走原生槽位」一致；pi 的原生通道是文件而非进程 flag，写端职责同构收敛为「不注入」。
- **明确登记（本次新增）**：cc-migrate 是「带哪方系统提示词」的可选功能——**IR 只携带，不裁决**；`ir.systemPrompt` 非空时，写端行为矩阵：claude=进程 flag 附加（已实现）、pi=不注入（恒）、其余各端按各自文档。**双叠禁令是全端红线**（源提示词 + 目标运行时提示词叠加），v3.2 #8 已冻结，pi 端按上述执行。

## 10. 删除与改动红线（不可协商）

- **pi 的删除通道**：TUI `/resume` 里 `Ctrl+D`（或 Ctrl+Backspace）→ 确认 → `deleteSessionFile`（`session-selector.ts:645`）：优先 `trash` CLI（回收站），无 trash 才 `unlink` 永删。`SessionManager` 类**没有 delete API**（v3）。v4 repo 有 `delete()`（真删）——同样不在我们路径上。
- **cc-migrate 红线**：引擎（`migrate.ts`/registry/adapters）**不含任何 unlink/rm/trash 调用**（2026-09-01 全仓 grep 复核：仅 claude/parse.ts 两处 `Map.delete` 内存操作）。迁移只读源、只写新文件。**会话删除只能由人执行**（在源工具 UI 里删，或用户手动删文件）——理由：迁移的 select/preview 面会话列表来自扫描，误判（例如 header 损坏、v4 文件、空文件）时删除是不可挽回的破坏；宁可多留一个「迁移过的旧会话」也不允许任何自动清理。此为产品级约束，任何后续「清理已迁移会话」功能提案都必须走人工确认 + trash 通道 + 源工具原生 UI，不走本引擎。
- 适配器写源文件 = 禁止。pi 的 `open` 会自动迁移旧版本文件（原地重写）——我们的适配器永远不要调用 pi 的 open 链，只自己只读解析。

## 11. 可 resume 最小集合（写端自检清单）

1. header `{type:'session', version:3, id:<合法uuidv7形态>, timestamp:ISO, cwd}`（cwd 必填——无 cwd 的旧会话 pi 会走 `MissingSessionCwdIssue` 交互补救；新写文件绝不该缺）
2. ≥1 条 assistant 消息（`_persist` 守卫，§5.1）
3. message 链：首条 `parentId:null`，后续链式；`message` 载荷七 role 任一（词汇表 §3；跨工具侧链/系统消息按 §3 投影规则降级）
4. 可选：`model_change`/`thinking_level_change`（推导态）、`compaction`（`firstKeptEntryId` 指向链上真实存在的 entry id——**伪造指针会让 `buildContextEntries` 的 `foundFirstKept` 永假，活跃面退化只剩 compaction 之后条目**）、`branch_summary`、`session_info`、`label`（`targetId` 必须存在，pi 的 `appendLabelChange` 有 `byId.has` 守卫）
5. 恢复行为验证锚点：resume 后 `buildSessionContext().messages` 应等于预期投影（§4）；`/session` 显示 messageCount/tokens；`/resume` 列表能见到该会话（name/mtime 正常）

## 12. 约束/坑速查（保留旧版 + 修订）

- entry id 仅 8 字符 → 需碰撞检测；header id 是 uuidv7 形态（`assertValidSessionId` 字符集门）
- 旧 `firstKeptEntryIndex` 已废弃，写一律 `firstKeptEntryId`（v1 文件读入时按下标换算）
- 无 assistant 不落盘（测试/迁移必须补 assistant 占位）
- header 扫描有 1MB 上限（`SessionHeaderScanLimitError`，`sm.ts:494`）：只影响 `findMostRecentSession`/`open` 的快路径，`open` 捕获后回退 `loadEntriesFromFile` 全量（`sm.ts:1541`）——适配器全量读不受影响
- `label:undefined` 与缺失序列化后无区别（`appendLabelChange` 传 undefined 清除）；`session_info` 空名清除同理——**清除语义靠「出现且为空」表达**，写回时要用显式空值行还原（`label: null`）
- `stopReason:"pending"` 只存在于流式事件，持久化的 assistant 必为终态（`docs/session-format.md:120`）；v4 层新增 `"deferred"`（延迟响应），v3 文件可能出现（StopReason 类型含它）——解析时未知 stopReason 照存 `meta.pi`，勿报错
- pi 的 `usage` 形状（input/output/cacheRead/cacheWrite/totalTokens/cost{...}，含 v4 扩展 `cacheWrite1h?/reasoning?`）——透传进 `meta.pi`，不做跨工具算术（填空政策：合成只发生在目标端写侧且可推导）

## 13. 适配器改造任务清单（重写 pi/index.ts 的验收标准）

1. **读端零丢弃**：§2.1 十类全部入 IR（messages/compaction/branchSummaries/title/meta.pi.*）；`parse` 出口 `validateSession`（引擎已卡点）
2. **词汇完整**：§3 七 role 全投影（bashExecution/custom/branchSummary/compactionSummary 不再走 fall-through）；assistant 字段级 `meta.pi`
3. **leaf 判定修正**：最后 **entry**（非最后 message）回溯 leaf-path（§6）
4. **anchor 契约**：§8.2 双载体 + 写回跳过 anchor 消息防双写
5. **写端消费桶**：`ir.compaction`/`ir.branchSummaries`/`meta.pi.*`（settingsEvents 按序重放 model_change/thinking_level_change；labels/session_info/custom entries 还原；`title` → `session_info`）
6. **写端红线**：`ir.systemPrompt` 忽略（§9）；无 assistant 补占位；`wx`-style 独占创建（文件名含时刻，重名覆盖风险极低但仍用一次性新文件）
7. **v4 检测**：`kind:'header'` → 显式报错跳过（§7）
8. **测试**：round-trip（含 compaction/branch_summary/label/session_info/custom/bashExecution）+ 跨工具投影（pi→dsh verify 干净）+ 旧版 pi.test.ts 既有用例全绿；IR 槽位变更随实现落地时按闸门 bump `IR_VERSION` + 同步各端 `irVersion` + 登记 `ir-protocol.md`

## 14. IR 变更登记摘要（✅ 2026-09-02 已随 pi 适配器重写落地——`IR_VERSION`=3.3，各端 `irVersion` 闸门同步）

v3.3（pi 适配器重写驱动，全部可选字段，旧端忽略）：`branchSummaries[]` 条目扩形 `{fromId, summary, anchorIndex?, time?, meta?}`；`MigratedSession.meta.pi` 命名空间（header/settingsEvents/labels/customEntries/titleCleared）；`MigratedMessage.meta.pi` 扩展（message/bash/customMessage/anchor/addedToolNames/usage）。**语义引用**：本表 §8；落地时 bump `IR_VERSION` 并同步全部适配器 `irVersion`（闸门强制）。dsh/claude/codex/zcode/opencode 的写端行为不受影响（可选字段 + 命名空间隔离）；读端忽略即可。
