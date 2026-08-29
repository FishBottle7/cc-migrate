# ZCode — 特征与存储

> 锚点：Electron 桌面应用 `ZCode.exe`（实测 v3.9.2）+ 内置 CLI 引擎 `<install>/resources/glm/zcode.cjs`（12.5 MB 压缩 bundle，源出 `apps/zcode-cli/packages/cli`）
> 权威数据：`~/.zcode/cli/db/db.sqlite`（SQLite, WAL）
> 本文基于引擎 bundle 反编译 + 本机实库取证（2026-08-29：27 sessions / 2037 messages / 7799 parts）
> 审计对照：`docs/session-formats-audit.md`

## 定位（谁是真理）

- **权威**：SQLite 单库 `~/.zcode/cli/db/db.sqlite`（WAL 模式）。会话、消息、part、输入队列、用量统计全部在库内，**没有 per-session 的对话正文文件**。
  - `ZCODE_HOME` 环境变量覆盖家目录（默认 `~/.zcode`）。
  - 引擎由 Electron 主进程 spawn（`GLM_BINARY_PATH` → `zcode.cjs`），宿主（`app.asar/out/host/index.js`）只做扫描/展示。
- **非权威附属**（可再生的旁证，非对话正文）：
  - `~/.zcode/cli/agents/<parentSessionId>/agent_<uuid>/` — subagent sidecar（见下）
  - `~/.zcode/cli/rollout/model-io-<sessionId>.jsonl` — 原始模型 IO 调试日志（**覆盖率不保证**：本机 27 会话只有 3 个文件）
  - `~/.zcode/cli/artifacts/<sessionId>/<uuid>-tool-result-<uuid>.json` — 超大工具结果溢出（`budgetStrategy:"artifact"` 时）
  - `~/.zcode/cli/exec/<sessionId>/call_<id>-stdout.log` — bash stdout 落盘
  - `~/.zcode/projects/<hash>/{fileHistory,snapshots}` — 编辑器层文件历史，**非对话数据**
  - `~/.zcode/v2/` — 应用配置 / `tasks-index.sqlite` / checkpoints / **credentials.json（敏感，勿 dump）**
    - `v2/config.json` = `{provider:{<uuid>:{name,kind,source,models{…},options{…含 apiKey}}}}` —— **providerID UUID → 可读名/协议族的注册表就在这**（含密钥，读时注意脱敏）
    - `zcode-artifact://<sessionId>/tool-result-<uuid>` URI 解析到 `~/.zcode/cli/artifacts/<sessionId>/<callId>-tool-result-<uuid>.json`
- **引擎 CLI 面**（真实分发，从 bundle switch 提取）：默认 `tui`；`agent-server`|`app-server --stdio`（宿主 spawn 参数，NDJSON 协议，见下节）；`doctor` / `login` / `logout` / `commands` / `plugins` / `skills` / `help` / `version`；headless 运行：位置参数或 `--prompt "…"`（**会调模型**），flags `--resume <id>` / `--continue` / `--output-format` / `--cwd` / `--json`。**没有会话导出命令**——迁移必须直读 DB。
- **DB 路径重定向**：配置 `storage.sessionDbPath`（默认 `~/.zcode/cli/db/db.sqlite`），env **`ZCODE_SESSION_DB_PATH`**（或 `ZCODE_SESSION_DB`）/ `ZCODE_STORAGE_DIR` 可覆盖（实测生效）——迁移工具隔离测试就用它。

## 表结构（18 个 migration：`0001_base_session_store` … `0018_session_input_failed_status`）

| 表 | 主键 | 关键列 | 说明 |
|----|------|--------|------|
| `session` | `id` | `project_id`, `workspace_id?`, **`parent_id?`**, `slug`, `directory`, `title`, **`task_type`**, **`title_source`**(default/first_input/generated/custom), **`revert`**(json), `time_*` | 会话元数据；`task_type` ∈ interactive/fork/selection_side_chat/workflow_parent/workflow_child/subagent_child/nested_workflow_child；`revert` 见「rewind 与活跃分支」 |
| `message` | `id` | `session_id`(FK CASCADE), `data`(json), **`sequence`** | 正文权威；`sequence` 会话内 0 起连续 |
| `part` | `id` | `message_id`(FK CASCADE), `session_id`, `data`(json), `sequence` | 消息内 0 起连续 |
| `session_entry` | `id` | `session_id`, `type`, `data`(json) | 旁记（本机实测：`runtime/workspace_checkpoint`×200、`runtime/bash_shell_selection`×22、`v4/command_fact`×8、`runtime/model_selection`×5） |
| `session_input` | `id` | `session_id`, `kind`(sendText/backgroundNotification/compact), `delivery`(startNow/guide/queue), `status`(admitted/promoted/cancelled/discarded/failed), `payload` | 输入队列 |
| `session_target` | `session_id` | `objective`, `status`, `token_budget` | 长任务目标 |
| `input_history` | `id` | `project_id`, `text` | 全局输入历史 |
| `turn_usage` / `model_usage` / `tool_usage` | — | token/耗时/错误统计 | 遥测，非正文 |
| `todo` | `(session_id,position)` | `content,status,priority` | 当前 todo 快照 |
| `workflow_*` | — | — | workflow 编排状态 |

**sequence 规则（实测验证）**：写侧 SQL 为 `(select coalesce(max(sequence),-1)+1 from … where session_id=?)`（0014/0015 起有 autofill trigger）；本机 27 会话 message sequence 全部 0..N-1 无空洞无重复，2041 条含 part 的 message 同样连续，零 NULL。读取排序：`ORDER BY sequence IS NULL, sequence, time_created, rowid`。

**ID 命名**：
- 会话 `sess_<uuid>`；subagent 子会话 `sess_subagent_agent_<uuid>`（**uuid 与 sidecar 目录名 `agent_<uuid>` 一致**）
- 消息 `msg_<base36>_<uuid>`；subagent 子会话内出现变体 `msg_part_<base36>_<uuid>_message`（本机 33 条，数量恰等于 Agent 工具调用数）
- part `part_<base36>_<uuid>`；tool callID `call_<hex>`

## message.data 格式（role 判别联合）

行 → 对象时注入 `id, sessionID`（`{...JSON.parse(data), id: row.id, sessionID: row.session_id}`），data 内**不含** id。

### user

```jsonc
{
  "role": "user",
  "time": {"created": 1786939335080},
  "agent": "zcode-agent",
  "model": {"providerID": "685c0ff0-…", "modelID": "GLM-5.3-1M", "variant": "max"},
  "contextSnapshot": {"envInfo": {"cwd": "…", "platform": "win32", "shell": "Git Bash",
      "gitBranch": "…", "gitStatus": "dirty", "gitStatusLines": [...], "recentCommits": [...]}},
  "semantics": {"origin": "real_user", "kind": "user_prompt",
      "uiVisibility": "visible", "providerVisibility": "visible", "transcriptVisibility": "visible"},
  "anchor": {"turnId": "turn_…", "origin": "realUser"},
  "tools": {"Bash": true, "Read": true, …},          // 本 turn 暴露的工具集
  "metadata": {"inputIntent": {"sourceCommandId": "…"}},  // 编辑框原始意图
  "synthetic": true,                                   // 仅合成消息有
  "source": "todo_reminder",                           // background_task / selection_side_chat / fork / …
  "visibility": "model-only"                           // 与 semantics.uiVisibility 冗余
}
```

- `semantics.origin` ∈ `real_user | agent_runtime | system | migration`；`kind` ∈ `user_prompt | slash_command | system_reminder | background_notification | subagent_notification | todo_reminder | rewind_notice | fork_notice | timeline_event | compact_summary | assistant_response`
- 本机 user 消息分布：真实输入 68、`todo_reminder` 合成 131、`background_task` 40、`selection_side_chat` 1 —— **合成 model-only 消息占大头**

### assistant

```jsonc
{
  "role": "assistant",
  "time": {"created": …, "completed": …},
  "parentID": "msg_…",                 // 通常指向触发它的 user 消息
  "modelID": "GLM-5.3-1M", "providerID": "685c0ff0-…", "variant": "max"?,
  "mode": "build" | "edit" | "yolo" | "plan" | "auto",
  "agent": "zcode-Explore"?,           // subagent 子会话内为 profile 名
  "path": {"cwd": "…", "root": "…"},
  "cost": 0, "tokens": {"input","output","reasoning","cache":{"read","write"}},
  "finish": "tool-calls" | "stop" | "completed" | "failed",
  "summary": true?,                    // 压缩摘要消息（回放时跳过）
  "error"?, "semantics"?
}
```

本机 finish 分布：`tool-calls` 1703 / `completed` 36 / `stop` 31 / null 22 / `failed` 6。mode：`edit` 1508 / `build` 153 / `yolo` 137。**注意 `providerID` 是 provider 注册表 UUID（如 `685c0ff0-78b6-4b58-b80c-934814d8f396`），不是可读名**；名字需查 provider 注册（`~/.zcode` 配置）或用 `modelID`。

## part.data 格式（type 判别联合，13 种）

注入 `id, sessionID, messageID`。本机 7799 个 part 的类型普查：

| type | 数量 | 说明 |
|------|------|------|
| `tool` | 2174 | **调用+结果融合在一个 part**（见下） |
| `step-start` | 1755 | LLM 步骤开始（无信息量，回放忽略） |
| `step-finish` | 1733 | `{"reason","cost","tokens":{"total","input","output","reasoning","cache":{"read","write"}}}` |
| `reasoning` | 1135 | `{"text","metadata":{"anthropic":{"signature":"…"}},"time"}` — 签名在 metadata 里 |
| `text` | 948 | `{"text","synthetic"?, "ignored"?, "time"}` — user 消息的 ignored 部分回放时跳过 |
| `timeline` | 42 | `timelineType` ∈ context_compaction/goal_verification/session_fork/model_change；`{"timelineType":"model_change","display","status","toModel":{providerID,modelID,variant,label}}` |
| `compaction` | 12 | 见下节 |
| `file` / `patch` / `snapshot` / `subagent` / `agent` / `retry` | 0 | schema 里存在；引擎 bundle 内**无创建点**（只有共享/同步格式的转换 case 分支），属休眠成员——实践中只会遇到前 7 种 |

### tool part（四态判别联合）

```jsonc
{
  "type": "tool", "callID": "call_…", "tool": "Bash",
  "state": {
    "status": "pending" | "running" | "completed" | "error",
    // pending:  {"input","raw"}                      running: {"input","title"?,"metadata"?,"startedAt"}
    "input": {"command": "…", "description": "…"},
    // completed 独有:
    "output": "…stdout/final report…", "title": "Bash",
    "metadata": {"schemaVersion":1, "serialization":{"truncated":false,"originalBytes":4515,
                  "returnedBytes":4515,"budgetStrategy":"artifact"}},
    // error 独有:
    "error": "File content (440.2KB) exceeds maximum allowed size (256KB). …",
    "time": {"start": …, "end": …}
  }
}
```

本机工具普查：Bash 1531 / Read 250 / Edit 194 / TodoWrite 92 / TaskOutput 53 / **Agent 33** / Write 22 / Skill 1。

**Agent 工具 = subagent 调用**：`state.input = {description, prompt}`，`state.output` = 子代理最终报告（markdown，本机样例 18.5 KB）。子会话链接的推导（引擎 `tDi`，工具名 ∈ `{Agent, Task, subagent}`）按优先级：

1. `state.output` 可解析为 JSON 时取 `childSessionId` / `agentId`
2. `state.metadata.childSessionId` / `state.metadata.agentId`
3. 运行时事件台账（仅活跃会话有；冷会话为空）
4. 兜底：`childSessionId = 'sess_subagent_' + (agentId ?? callID)`

本机真实数据的 agentId 只存在于 sidecar `metadata.json`（`agent_<uuid>`），tool part 的 metadata 里只有 serialization 信息——**因此引擎对冷会话从 DB 推不出真实链接**（兜底会算出 `sess_subagent_call_<hex>`，与真实子会话对不上）。**子会话 `session.parent_id` + id 约定 `sess_subagent_agent_<uuid>` 才是可靠的冷链接**，迁移适配器必须用它，sidecar 目录做辅助。

> **⚠ 0.16.5 补正（2026-08-29 逆向 bundle 实证，修正上面第 2 条优先级）**：`tDi` 实际为
> `agentId = output.agentId ?? output 的 launch-ack 行 ?? metadata.agentId ?? 事件台账`，
> 且 **completed Agent part 的 `state.output` 末尾一律带引擎追加的 launch-acknowledgement 行**
> `agentId: agent_<uuid> (use SendMessage with to: 'agent_<uuid>' …)`（本机 33/33）——引擎的
> `YOi agentIdFromLaunchAcknowledgement` 在 metadata **之前**生效，冷会话就是靠它推出真实
> agentId → `Cl('subagent_'+agentId)`（`Cl = 'sess_' + 字面拼接`）。**迁移写回时必须把 ack 行的
> agentId 重写为新 agent uuid**，否则该 part 会被重新链回源子会话（roundtrip 实证）。另：引擎
> 的 `o0` 第四参读 `revert.createdMessageID`（内存态字段），**持久化 JSON 的 `messageID` 引擎并不
> 消费**——裁剪实现照抄引擎时不要把 `messageID` 当 created 用。

### compaction part（本机 12 条真实样本，含 completed）

```jsonc
{
  "type": "compaction", "auto": false, "trigger": "manual", "phase": "standalone_turn",
  "compactReason": "user_requested",        // context_limit / model_downshift / provider_overflow
  "operationId": "cmp_…", "timelineStatus": "failed",   // 本样本是一次失败的压缩
  "timelineDisplay": "separator", "replace": true,
  "reason": "Provider rejected the model request.", "attempt": 1,
  "preCompactTokenCount": 93607, "time": {"start": …, "end": …}
}
```

completed 样本（auto/context_limit 与 manual/user_requested 各有）携带 `summaryMessageId` 与 `boundaryId`（`compact_<uuid>`）。**summaryMessageId 指向的是 `role:'user'` 消息**，紧邻 compaction part 所在消息的下一条 sequence：

```jsonc
// summary 消息（真实样本，body 21 KB）
{"role":"user", "summary":{"title":"Compact summary","body":"Summary:\n1. …","diffs":…},
 "semantics":{"origin":"agent_runtime","kind":"compact_summary",
              "uiVisibility":"hidden","providerVisibility":"visible","transcriptVisibility":"hidden"}}
```

引擎侧的压缩**边界事件**（BRt schema）字段更全：`operationId, messageId, status(started/retrying/skipped/completed/failed/interrupted), trigger(manual/auto/partial/reactive/session_memory), compactReason, boundaryId, summaryMessageId, tailStartMessageId`；fork-bundle 校验还引用 `tail_start_id`、`compactBoundary{lastSummarizedMessageId, summaryMessageIds[], attachmentMessageIds[], hookResultMessageIds[], preservedSegment{headMessageId,anchorMessageId,tailMessageId}}`。

### rewind 与活跃分支（session.revert）——解析必须裁剪

rewind（回退）**不删除**消息：被回退的消息仍物理留在库内，靠 `session.revert` JSON 决定活跃分支。真实样本（261 条消息的会话，仅 146 条 kept）：

```jsonc
{"kind":"conversation_rewind", "scope":"conversation",
 "targetMessageID":"msg_…",       // 回退目标（不保留）
 "messageID":"msg_…",             // kept 的最后一条
 "branchCutAfterMessageID":"msg_…", "branchGeneration":4,
 "keptMessageIDs":["msg_…", …]}   // 显式白名单
```

runtime 层用 `o0()` 裁剪出活跃分支（DB 读层返回全量，**裁剪不在 SQL 里**）：

```
o0(messages, {rewindTargetMessageId, rewindKeptMessageIds, branchCutAfterMessageId, rewindCreatedMessageId})
  无 rewindTargetMessageId → 全量
  base = keptMessageIds 按白名单取
       else 若 target 存在：messages.slice(0, targetIdx)      // target 本身不保留
       else 全量
  有 branchCutAfterMessageId → base + messages.slice(cutIdx+1) // cut 点之后全保留
  否则若有 rewindCreatedMessageId → base + messages.slice(createdIdx)
```

**迁移解析器必须实现 o0 等价逻辑**，否则会把用户已回退丢弃的对话迁移出去。

## 回放投影（引擎自己怎么读 = 兼容性金标准）

完整管线是**三层**，任何一层不实现都会多读或少读：

1. **DB 读层**（`cnn loadSessionTranscriptFromStore`）：`SELECT * FROM message WHERE session_id=? ORDER BY sequence`，part 按 `message_id` 分组 —— **返回全量，含被回退的消息**
2. **分支裁剪层**（`o0`）：按 `session.revert` 裁出活跃分支（见上节）
3. **分类过滤层**（`D2 getConversationMessageProjectionPolicy` → 五分类）：跳过 summary 消息（`fCi`）与分类 ≠ `realUserInput` 的 user 消息（`hCi`），part 按 id 去重，然后：
   - user → 拼接文本：`text`(非 ignored) + `file` part → `[Attached file: ${filename}]` + `agent` part → `[Selected agent: ${name}]`
   - assistant → 块序列：`text`→text、`reasoning`→`{type:'thought'}`、`tool`→`{type:'tool', input, toolCallId, toolName, output+title | error+status:'failed'}`；step-start/step-finish/snapshot/patch/timeline 全部丢弃

**D2 决策表**（从 bundle 完整提取，`realUserInput` 是唯一参与回放的 user 分类）：

```
1. semantics.kind==='compact_summary' || summary!==undefined      → providerContextOnly
2. 有 semantics 时：
   kind==='timeline_event'                                        → timelineOnly
   origin==='real_user' && !synthetic && visibility!=='model-only'→ realUserInput
   assistant && kind==='assistant_response' && ui/transcript 均 visible → visibleAssistant
   providerVisibility==='visible'                                 → providerContextOnly
   kind==='fork_notice'                                           → timelineOnly
   origin==='agent_runtime' || uiVisibility==='hidden'
     || transcriptVisibility==='hidden'                           → hiddenSynthetic
3. visibility==='model-only' || 任一 part visibility==='model-only' → providerContextOnly
4. isTimelineOnlyMessage（kind=timeline_event / source=fork /
   含 timeline part / forkContext.kind==='session_fork'）          → timelineOnly
5. source ∈ {fork} 或 16 种 agent-control source
   （agent_control_message/background_task/goal-continuation/todo_reminder/
     rewind/selection_side_chat/subagent/subagent_message/task_notification/
     target_continuation/…）或遗留文本嗅探
   （<system-reminder source="goal-continuation"> / <task-notification> /
     <subagent-notification> / "Conversation rewind applied."）    → providerContextOnly
6. synthetic（消息或任一 part）                                    → hiddenSynthetic
7. role==='assistant'                                             → visibleAssistant
8. 兜底                                                           → realUserInput
```

**结论：ZCode 官方回放本身就丢弃大量结构信息**（revert 分支、summary、合成消息、timeline、tokens）；迁移工具若要保真需要比引擎读得更多（semantics、tokens、tool error 文本、timeline 事件），但**分支裁剪这层必须照抄**。

## Subagent 双重存储

1. **DB 内**（完整）：子会话 `sess_subagent_agent_<uuid>`，`task_type='subagent_child'`，`parent_id` → 父会话；内部 message/part 与普通会话同构。`selection_side_chat`（选中文本旁聊）与 `workflow_*` 同理以 `parent_id` + `task_type` 表达。
2. **sidecar 目录**（事件溯源，含 DB 里没有的东西）：`~/.zcode/cli/agents/<parentSessionId>/agent_<uuid>/`
   - `metadata.json`：`agentId, childSessionId, parentSessionId, parentToolUseId(=callID), profileId, profileSnapshot{name,description,color,injectAgentsMd,source,systemPrompt,tools[]}, prompt, status, usage{inputTokens,outputTokens,cacheReadTokens,…}`
   - `transcript.jsonl`：事件流 `turn_started / model_request / model_network_status / model_streaming(start|reasoning_*|text_*|tool_input_*|tool_call|finish) / model_complete / streaming_tool_ledger_updated / tool_call_scheduled(parallelGroups) / tool_batch_complete / stream_recovery_anchor_created / turn_complete(payload.response=最终报告)`
   - `output.txt` / `task.output`：最终报告落盘
   - **`model_request` 事件含完整渲染后的 prompt（含 system prompt）** —— 这是全库唯一逐会话可恢复 system prompt 的地方（交互会话的 system prompt 不入 DB）

## 附属目录细节

- `rollout/model-io-<sessionId>.jsonl`：行 `{"completedAt","durationMs","requestId","attempt","model":{modelId,providerId,role,source,variant},"request":{body:{model,max_tokens,system[],…}}}`。宿主扫描条件 `type==='model_io' && sessionId`。**覆盖率 3/27，不能作为解析依赖。**
- `artifacts/<sessionId>/<uuid>-tool-result-<uuid>.json`：`serialization.budgetStrategy==='artifact'` 时工具输出溢出到此（对应 tool part `state.output` 里可能是截断/引用形式——本机样本 originalBytes==returnedBytes 且全文在库，未见引用形态的真实样本）。
- `exec/<sessionId>/call_<id>-stdout.log`：bash stdout 另存（Bash 工具）。

## 构造可 resume 会话（DB 直写最小集）

1. `session` 行：`id(sess_<uuid>), project_id(proj_<目录小写非字母数字→->), slug, directory, title, version, task_type='interactive', title_source, time_created/updated`
2. `message` 行：`id(msg_<b36>_<uuid>), session_id, data(role 判别 JSON), sequence` 0..N-1 连续（显式给或依赖 autofill trigger）
3. `part` 行：`id(part_<b36>_<uuid>), message_id, session_id, data, sequence` 每 message 从 0 连续
4. user assistant 成对即可构成最小可回放对话；assistant `finish:'stop'` 结尾
5. subagent 链接伪造：Agent tool part 的 `state.metadata` 放 `agentId: "agent_<uuid>"`，子会话 id 用 `sess_subagent_agent_<同一uuid>`（= 引擎 `Cl('subagent_'+agentId)` 约定，round-trip 已验证）；同时写子会话行 `parent_id` + `task_type='subagent_child'`
6. resume 判定：`session` 行存在即可 resume（无额外布尔列）；`session_input` 队列为空即无待处理输入

## 伪造可行性（诚实判定）

- **可（已实证）**：普通 sqlite3 客户端直写即可，无需启动引擎。data 列只有 JSON，无密钥/签名/校验和绑定。Round-trip 实测：直写 session+message+part 三表后，引擎 `session/list` / `resume` / `messages` / `subagents` 四条官方路径全部正常识别（见上节）。
- **注意**：DB 里 compaction/timeline 等 part 的真实字段是 bundle 内 zod schema 的**超集**（DB 写入不严格校验），解析器必须宽容未知字段；`retry` part 还会带 schema 外的 `time` 字段。
- **风险/前提**：
  - 应用运行时库处于 WAL 活跃态 → 用 `file:…?mode=ro` 读、写前拷贝备份；并发写会 `SQLITE_BUSY`
  - `data` JSON 引擎读取时宽容（round-trip 证明直写即认），但保持 schema 形状更稳（Mgn/Ogn/C8e）
  - FK：`message.session_id`/`part.message_id` 均 `ON DELETE CASCADE`，顺序不能错
  - 勿动 migrations 表；`sequence` 空洞会打乱回放
  - subagent 伪造需同时写 DB 子会话 + sidecar 目录，否则宿主 UI 显示不一致

## Round-trip 实证（2026-08-29，全部通过）

在沙箱 `ZCODE_SESSION_DB_PATH` 指向的 DB 拷贝里**纯 SQL 直写**了一个伪造会话（user+assistant 两条消息、text/tool part、Agent 工具 part 带 `state.metadata.agentId`、`sess_subagent_agent_<uuid>` 子会话），然后用引擎 `node zcode.cjs app-server --stdio` 走官方协议验证：

| 验证点 | 结果 |
|--------|------|
| `session/list` | ✅ 伪造会话出现在列表（投影字段 `sessionId/sessionKind/title/titleSource/mode/status/createdAt/workspace` 全部正确；`roots:true` 只列无父会话，子会话/selection_side_chat 不列） |
| `session/resume` | ✅ 从 DB 加载伪造会话并回放 |
| `session/messages` | ✅ 2 条消息、探针文本命中、Agent tool part completed |
| `session/subagents` | ✅ 从 tool part `metadata.agentId` 完整推导 childSessionId/agentId/toolCallId/status |

**结论：session/message/part 三表直写即可构造引擎完整识别、可 resume 的会话，subagent 链接按引擎约定伪造也被官方路径识别。** 伪造难度 = 低，无签名/校验和。

## 引擎协议（app-server --stdio）

- 传输：**NDJSON**（每行一个 JSON，`ZCodeProtocolNdjsonConnection`）
- 信封：请求 `{id, method, params?}`；通知 `{method, params?}`；响应 `{id, result}` / `{id, error:{code,message,data?}}`
- 关键方法：`session/list` / `session/resume` / `session/messages` / `session/read` / `session/subagents` / `session/create` / `session/send` / `session/fork` / `session/compact` / `session/events` / `session/subscribe` / `session/usage`
- **resume 是双向握手**：引擎会反问客户端 `session/requestRuntimePreferences`（15s 超时），应答 `{nativeSearchEnhancementsEnabled, memoryEnabled, askUserQuestionAutoResolutionEnabled, modelContextBudgetStrategy:"preflight-v1"}`（另有 `interaction/requestOfficialMcpAuthHeaders`）；不应答则 resume 超时失败
- 非活跃会话直接 `session/messages` 报 `Session is not active`——必须先 resume
- 协议可用于迁移工具的**写回后自检**（不依赖内部 API）

## 其他存储面（排查过，均非对话数据）

- `~/.zcode/v2/tasks-index.sqlite`：宿主自动化调度（cron automations），表 `automations`
- `~/.zcode/logs/<pid>.jsonl`：宿主 **ACP（Agent Client Protocol）流量日志**——ZCode 宿主通过 ACP 拉起外部 CLI agent（claude-code 经 `@zed-industries/claude-code-acp`、codex、gemini-cli），这些 agent 的会话由各自工具自己存储（`~/.claude`、`~/.codex`…），**不进 ZCode 的 db.sqlite**。db.sqlite 只存 ZCode 原生引擎会话
- `workflow_definition/run/activity/event` + `session_task_link`：schema 完整但本机全 0 行（编排功能未使用）；适配器可忽略
- 本机引擎实测版本：`session.version` = `0.16.3`（引擎 bundle），宿主 native spec 版本 `0.13.3`（app 3.9.2）

## 适配器实现清单（读取方向）

```text
parse(dbPath, sessionId):
 1. 打开 SQLite（ro；或先复制 db+wal+shm 三件套）
 2. session 行 → 元数据（title/titleSource/directory/task_type/time_created(ms)/revert）
 3. message WHERE session_id ORDER BY sequence          ← 全量，含被回退的
 4. part   WHERE session_id（按 message_id 分组, ORDER BY sequence）
 5. 若 session.revert 存在 → 实现 o0() 裁剪出活跃分支      ← 必做
 6. 逐消息展开：user/assistant 按 D2 同等规则分类（或直接信 semantics 字段）；
    role='user' 且 summary.body 存在 → IR compaction[].summary；
    tool part → tool_use + tool_result（callID 关联；error 态 → isError）；
    reasoning → thinking；text(synthetic/ignored) 跳过；
    step-start/finish/timeline/snapshot/patch/file → 丢弃或 extensions
 7. providerID → 查 v2/config.json provider.<uuid>.name（读时脱敏）
 8. 子会话（task_type='subagent_child' 且 parent_id=本会话）→ sidechains[]；
    agentType 取子会话消息 agent 字段（如 zcode-Explore → Explore）；
    sidecar metadata.json/transcript.jsonl 补 systemPrompt/usage
 9. model：assistant 行 modelID/variant + provider name
10. 可选自检：ZCODE_SESSION_DB_PATH 指向拷贝 → app-server --stdio 协议
    session/list + resume + messages + subagents 全绿即写回成功
```

## IR 映射

对齐：`messages` ← message/part 行按 sequence 展开（先过实现清单第 5-6 步裁剪与分类）；`cwd` ← `session.directory`（或 assistant.path.cwd）；`title` ← `session.title`；`createdAt` ← `session.time_created`（ms）；`model.id` ← `modelID`、`variant` ← `variant`；`stopReason` ← assistant `finish`；tool part completed → `tool_use`+`tool_result`、error → `tool_result(isError)`；reasoning → `thinking` 块；compaction `summaryMessageId` 的消息 → `compaction[].summary`；subagent 子会话 → `sidechains[]`（agentId=子会话 id，agentType=`agent` 字段，parentMessageId=父 Agent tool part 所属 message）。**turn 分组可用**：`message.data.anchor.turnId` ↔ `turn_usage.turn_id` 实测全量命中（1941/1941），需要按轮切分时以此 join。

### ⚠ 对齐难点（迁移工具需明确决策）

| # | 问题 | 建议 |
|---|------|------|
| 1 | **tool 调用+结果融合在单 part**，四态生命周期；IR 需拆 `tool_use`(assistant)+`tool_result`(tool)。error 态没有 output 只有 `error` 字符串 | 拆分时用 `callID` 关联；error → `tool_result{isError:true}` |
| 2 | **providerID 是注册表 UUID** 非可读名（`685c0ff0-…`） | 已解决：`~/.zcode/v2/config.json` 的 `provider.<uuid>.{name,kind}` 可完整映射（含 apiKey，注意脱敏）；IR `model.provider` 用 `name`，UUID 进 `extensions` |
| 3 | `reasoning.metadata.anthropic.signature` 无 IR 槽位（Claude 回传签名用） | 丢签名（迁出 ZCode 后签名失效）或存 `extensions` |
| 4 | **大量 model-only 合成 user 消息**（todo_reminder/background_task，本机占 71%）；IR 无对应概念 | 按 `semantics` 分类：`origin!=='real_user'` 且 `providerVisibility==='hidden'` 的丢进 `extensions` 或转 `role:'system'`；**绝不能当真实用户输入** |
| 5 | **system prompt 不入 DB**：只有 subagent sidecar 的 `model_request` / rollout 文件里有；交互会话拿不到且 rollout 覆盖率 3/27 | IR `systemPrompt` 只能尽力而为（subagent 可填），交互会话留空并在 `extensions` 标注来源缺失 |
| 6 | 多 assistant 消息共享同一 `parentID`（一 user 多轮回复）；父链不能当树遍历 | 一律按 `sequence` 排序，忽略 parentID 拓扑 |
| 7 | summary/compaction：摘要本体是 **user 消息**（`summary:{title,body,diffs}`，非 assistant），引擎回放跳过它；boundary 细节（preservedSegment/tailStartMessageId/summaryMessageIds[]）超出 IR compaction 字段 | `summary.body` → IR compaction[].summary；`diffs`/boundary 细节进 `extensions` |
| 13 | **rewind/revert：被回退消息仍在库中**，全量读会带入用户已丢弃的对话 | 必须实现 `o0()` 裁剪（keptMessageIDs 白名单 / branchCutAfterMessageID / rewindCreatedMessageId 拼接，见上）；IR 可把被裁分支放 `extensions` 或直接丢弃 |
| 8 | 13 种 part 类型远超 IR 4 种块：file/patch/snapshot/step-start/step-finish/timeline/subagent/agent/retry 无槽位 | step-start/finish 可丢（tokens 在 assistant 汇总里有）；file 拼进用户文本（引擎同款 `[Attached file: …]`）；其余按重要性决定丢弃或 extensions |
| 9 | `message.data.contextSnapshot`（envInfo/git status/recentCommits）、`tools` 记录、`mode`(plan/build/edit/yolo)、per-message tokens/cost 无 IR 槽位 | `extensions` 承接 |
| 10 | **活 WAL SQLite**：读必须 `mode=ro`；应用运行中 checkpoint 可能滞后 | 读取前复制 db + `-wal`/`-shm` 三件套再开，或接受只读连接 |
| 11 | 子会话消息 id 形状不同（`msg_part_*_message`）且首条消息 parentID 自指、role=assistant 却是 system/时间线载体 | 解析按 role+semantics 判断，不按 id 形状 |
| 12 | 父 Agent tool part 无 childSessionId（只有 serialization）；引擎冷启动兜底 `sess_subagent_call_<hex>` 与真实子会话对不上 | 适配器以 `session.parent_id` + 子会话 id 约定 `sess_subagent_agent_<uuid>` 为主链路（round-trip 已证 parent_id 链路可靠），sidecar metadata.json 做 agentId/systemPrompt 补充 |
