# Codex — 特征与存储（v3 深查版，适配器开发前调查）

> 调查日期：2026-08-29。源码：`D:\codes\Opensource\codex-main\codex-rs`（2026-08 树，rollout 已独立成
> `codex-rs/rollout` crate，`history` crate 承载 RolloutItem 域类型）。本机真实数据实测 CLI 版本
> **0.146.0**（`~/.codex`，1665 个 rollout），与源码交叉验证。
> **本文取代旧版**（旧版基于的假设已过时：`instructions` 字段已不存在、`turn_context`/`world_state`/
> `compacted`/`event_msg`/`ordinal`/子代理语义均为旧版未覆盖）。锚点均为该树内 `path:line`。
> 审计对照：`docs/session-formats-audit.md` §2（已同步改写）。IR 槽位登记：`docs/ir-protocol.md` §v3.1。

## 0. 权威与派生（先记住这一句）

**盘中权威 = rollout JSONL。** 其余全部可重建或仅为索引：

| 路径 | 角色 | 迁移引擎的态度 |
|------|------|----------------|
| `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>[_<rolloutId>].jsonl[.zst]` | **权威**（会话正文） | 读：全量解析；写：只写**新文件**，永不改写既有 rollout（AGENT.md 会话不可删除铁律） |
| `~/.codex/archived_sessions/…` | 归档 rollout（同格式） | 列表要扫；`find_archived_thread_path_by_id_str`（rollout/src/list.rs:1595） |
| `~/.codex/session_index.jsonl` | thread_name→id 索引，append-only，**新条目胜出**（rollout/src/session_index.rs:24-71） | 写：**追加一行** `{id, thread_name, updated_at}`，绝不 rewrite/删行 |
| `~/.codex/state_5.sqlite`（`state/` crate） | threads/thread_spawn_edges/threads_preview 等——**从 rollout 回填的派生缓存**（migrations `0008_backfill_state`、`0047_rollout_migration_state`） | 不写。resume 查询 DB 未命中会回退文件扫描（list.rs:1344 "Prefer DB lookup, then fall back"） |
| `~/.codex/history.jsonl` | 用户消息索引（非权威） | 忽略 |
| `logs_2/queue_1/goals_1/memories_1.sqlite` | 日志/队列/运行时状态 | 忽略 |

- `$CODEX_HOME` 环境变量覆盖 `~/.codex`（core/src/config/mod.rs:4717 → `codex_utils_home_dir`）；`$CODEX_SQLITE_HOME` 单独覆盖 state DB（config_toml.rs:330）。适配器 `paths.ts` 现有实现一致。
- **deferred creation**：新会话的 rollout 文件在首个 persist/flush 前**不落盘**（recorder.rs:906-915 `deferred_creation`）——空会话（0 轮）没有文件是正常现象，列表不要报错。

## 1. RolloutLine 信封与 11 种记录类型

每行：`{"timestamp":"2026-08-20T02:14:08.083Z","ordinal":<u64可选>,"type":"<tag>","payload":{…}}`
（history/src/lib.rs:205-212 `RolloutLine`；timestamp 为 UTC 毫秒精度 `Z` 结尾，recorder.rs:1971-1976；
`ordinal` 仅 Paginated 模式存在，Legacy 模式为 `null`/缺省——见 §4。）

`type` ← `RolloutItem`（history/src/rollout_payload.rs:21-56，snake_case tag）：

| # | type | payload | 持久化 | resume 语义 |
|---|------|---------|--------|-------------|
| 1 | `session_meta` | `SessionMetaLine`（=SessionMeta 扁平 + `git?`） | 必有 | **每个文件可出现多条**：子代理 rollout 首行是自己的 meta，其后是**拷贝继承的祖先 meta**（本机 0.146.0 实测：line0=child, line1-2=parent/grandparent）。resume 时 `InitialHistory::get_base_instructions` 等取**匹配 thread_id 的那条**（history/lib.rs:400-411 反向找） |
| 2 | `response_item` | Responses API `ResponseItem` + 可选 `metadata:{client_authored}` | 见 §3 policy | 模型可见对话主体 |
| 3 | `event_msg` | `EventMsg`（90+ 变体，tag snake_case） | 子集，见 §5 | turn 分段/回滚/设置的载体；UI 事件仅归档 |
| 4 | `turn_context` | `TurnContextItem` | 总是 | 每真实用户轮的基线：resume 恢复 previous_turn_settings(model/comp_hash/realtime) + reference_context_item（rollout_reconstruction.rs:221-246） |
| 5 | `world_state` | `{full:bool, state:map}` | 总是 | 全量建 baseline / merge-patch 更新；有 baseline 时 resume 首轮**只发 diff**（无则重新注入全量 `<environment_context>`）（rollout_reconstruction.rs:396-422） |
| 6 | `compacted` | `CompactedItem` | 总是 | 带 `replacement_history` 时：它是**新的历史基点**，基点之前的所有 rollout 记录不再参与重建（rollout_reconstruction.rs:155-187 反向扫描 + 345-349）；不带时走 legacy 重建（清除 reference baseline，重注入 canonical context，temporary out-of-distribution——源码原话） |
| 7 | `inter_agent_communication` | `InterAgentCommunication{author,recipient,other_recipients,content,encrypted_content?,trigger_turn}` | 总是 | **模型可见**：`to_model_input_item()` 进历史（rollout_reconstruction.rs:337-343），并算 user-turn 边界 |
| 8 | `inter_agent_communication_metadata` | `{trigger_turn}` | 总是 | 记账 |
| 9 | `security_risk_score` | `{scores,call_id?,action?,sampled_at?}` | 总是 | 明确**不进模型上下文、不给用户看**（security_risk.rs 注释）——纯归档 |
| 10 | `realtime_item` | `RealtimeItem` | 仅 Paginated | realtime 展示重建 |
| 11 | （外层 `type` 缺失/未知） | — | — | `#[serde(other)]` 兜底；读端按未知行归档 |

写回端义务：上述 11 类**全部**要能原样写回（除加密字段），否则 codex→codex 不达标。

## 2. session_meta 全字段（protocol/src/protocol.rs:2975-3036）

```json
{"session_id":"…","id":"…","forked_from_id":"…?","forked_from_ordinal_exclusive":42?,
 "parent_thread_id":"…?","timestamp":"2026-08-20T02:14:07.732Z","cwd":"D:\\…",
 "originator":"codex_cli_rs","cli_version":"0.146.0","source":"cli"|"vscode"|…,
 "thread_source":"user"|"subagent"|…?,"agent_nickname":"…?","agent_role":"…?",
 "agent_path":"/root/…?","model_provider":"openai"|…,"base_instructions":{"text":"…","provenance":…}?,
 "dynamic_tools":[…]?,"selected_capability_roots":[…],"memory_mode":"disabled"?,
 "history_mode":"legacy"|"paginated","history_base":{…}?,
 "subagent_history_start_ordinal":N?,"multi_agent_version":"v1"|"v2"|"disabled"?,
 "context_window":{"window_id":"uuidv7"}?, "git":{"commit_hash","branch","repository_url"}?}
```

要点：
- `id`（thread id）与 `session_id`：新版两个都有且相等；**读端兼容只有 `id` 的老文件**（SessionMetaLine 自定义反序列化回填，protocol.rs:3078-3105）。老版本还有个 `instructions` 字段存 user_instructions——**已废弃**，反序列化时被静默忽略（未知字段宽容，无 deny_unknown_fields）。
- `base_instructions: Option<BaseInstructions>`，`BaseInstructions = {text, provenance: Option<Custom|Model{model}>}`（models.rs:1490-1510）。**语义：本会话的 base 系统提示词全文**——只含 base，不含 AGENTS.md/environment_context（旧版 `instructions` 存的是 user_instructions，这是语义变迁的关键，见 §7）。
- `source`（SessionSource，protocol.rs:2676-2725）：`cli` / `vscode`（serde default）/ `exec` / `mcp` / `Custom(str)`（如 "atlas"、"chatgpt"）/ `Internal(memory_consolidation|guardian)`（列表过滤掉）/ `SubAgent(review|compact|thread_spawn{parent_thread_id,depth,agent_path,agent_nickname,agent_role}|memory_consolidation|other)` / Unknown。**子代理判定就靠它**：`{"subagent":{"thread_spawn":{…}}}`（嵌套对象，实测如此）。
- `thread_source`：字符串 `"user" | "subagent" | "guardian_review" | "memory_consolidation" | <其他自由串>`。
- `git`：`{commit_hash?, branch?, repository_url?}`（repository_url 反序列化时脱敏，sanitized_git_url）。
- `history_base: HistoryPosition = {thread_id, end_ordinal_exclusive, end_byte_offset}`——fork/继承时指向**另一个 rollout 文件**的 ordinal 截断点（不拷贝全量的分叉形态也存在）。

## 3. ResponseItem 全变体（models.rs:975-1215，tag snake_case）

| 变体 | 关键字段 | IR 投影 | 备注 |
|------|----------|---------|------|
| `message` | `id?`(msg_…), `role`(user/assistant/**developer**/system), `content: ContentItem[]`, `phase?`(commentary/final_answer…), `internal_chat_message_metadata_passthrough?` | role→IR role（**developer 保留**）；content→块；其余进 `meta.codex` | developer 角色实测存在：`<permissions instructions>` 开发者行、client 注入行 |
| `agent_message` | `author`, `recipient`, `content: AgentMessageInputContent[]` | assistant 消息 + `meta.codex`（author/recipient） | 多代理 agent 间消息 |
| `reasoning` | `summary: [{summary_text}]`, `content?: [{reasoning_text\|text}]`, **`encrypted_content?`** | thinking 块（summary/content→`thinking` 文本；`meta.codex.reasoningShape` 记形状） | **`encrypted_content` 是唯一允许的丢弃**；summary/content 非加密必须保 |
| `function_call` | `name`, `namespace?`, `arguments`(JSON 字符串), `encrypted_function_args?: [str]`, `call_id`, `id?` | tool_use 块 | `encrypted_function_args` 丢弃 |
| `function_call_output` | `call_id?`(可空!), `name?`, `namespace?`, `output`(=纯串 **或裸数组** content_items), `id?` | tool_result 块；content_items 的 `input_image`→`tool_result.attachments` FileBlock | wire 形态双态（models.rs:2194-2204）；**`success` 字段反序列化即丢**（rollout 里不保真，天然例外）；MCP 结果走 content_items（`{"content":…,"is_error":…}` 已被展平成 items） |
| `custom_tool_call` / `custom_tool_call_output` | `call_id`, `name`, `input`(自由串)/`output` | 同上 | freeform 工具 |
| `local_shell_call` | `call_id?`, `status`, `action:{type:exec\|…,command[],…}` | tool_use（name 虚拟为 `local_shell`/`shell`） | Responses 内建 shell |
| `web_search_call` | `status?`, `action?{search{query,queries}|open_page{url}|find_in_page{url,pattern}|other}` | tool_use/tool_result 对（无独立 output） | 现适配器直接丢弃——不达标 |
| `tool_search_call` / `tool_search_output` | `execution`, `arguments`/`tools[]` | tool_use/tool_result 对 | 工具检索 |
| `image_generation_call` | `status`, `revised_prompt?`, `result`(**base64 图**) | tool_use + tool_result(attachments=FileBlock data) | result 是生成图，可走 FileBlock |
| `compaction`（alias `compaction_summary`） | `encrypted_content` | **整条丢弃**（纯加密） | 唯一例外之一 |
| `context_compaction` | `encrypted_content?` | 有非加密投影则保（当前 payload 基本全加密→占位） | 与 `compacted` 记录（§1#6）是两回事 |
| `compaction_trigger` | `{}` | 丢弃（请求控制，不持久化） | policy.rs:59-60 明确不持久化，文件里不应出现 |
| `additional_tools` | `tools[]` | 丢弃（不持久化） | 同上 |
| `other` | — | 归档 `unmappedEvents`/`meta.codex.raw` | serde catch-all |

- 持久化白名单（rollout/src/policy.rs:42-62）：message/agent_message/reasoning/local_shell_call/function_call/tool_search_call/function_call_output/custom_tool_call/custom_tool_call_output/tool_search_output/web_search_call/image_generation_call/compaction/context_compaction **持久**；additional_tools/compaction_trigger/other **不持久**。
- `internal_chat_message_metadata_passthrough`：`{turn_id?, create_time?, content_item_kinds?, …}`，随 item 全程透传（set_turn_id_if_missing 等，models.rs:1295-1334）——resume 分段用 turn_id 匹配，**必须原样保真**。挂在消息 `meta.codex.passthrough`。
- envelope `metadata.client_authored`（history/src/lib.rs:44-51）：标记 developer 消息由 app-server 客户端注入。挂 `meta.codex.clientAuthored`。
- `ContentItem`：`input_text`/`output_text`/`input_image{image_url,detail?}`/`input_audio{audio_url}`（models.rs ContentItem enum）→ FileBlock（image_url 可能是 data: URL 或本机路径；本机路径归 `url` 并在写回时容忍缺失文件）。

## 4. 文件名、目录与 ordinal

- 目录 `sessions/<YYYY>/<MM>/<DD>/`，**本地时间**（recorder.rs:1630 `now_local`）；文件名 `rollout-<YYYY-MM-DDTHH-mm-ss>-<threadId>[_<rolloutId>].jsonl`（rollout_file_name.rs:39-74）。`_rolloutId` 后缀 = revert 过的线程（threadId 稳定，rolloutId 换新）。
- 文件名里的 ts 解析按 **UTC** `assume_utc`（rollout_file_name.rs:54）而写入用本地时间——Codex 自己的 quirk，解析保持同款行为即可，别"纠正"。
- **ordinal**（ordinal.rs）：`history_mode=legacy` → 无 ordinal；`paginated` → 每行递增 u64（从 0 或 `history_base.end_ordinal_exclusive` 起）。子代理继承父记录时校验 `subagent_history_start_ordinal` 前缀完整。本机 0.146.0 常规会话均为 legacy（无 ordinal）；**读端两种都要支持；写端 foreign/新会话默认 legacy（与官方 CLI 默认一致），paginated 源按源保真（见 §11.2）**。
- 压缩（rollout/src/compression.rs）：后台 worker 定期把"冷" rollout 转成 `rollout-….jsonl.zst`（zstd stream encoder，level 3，单帧；被引用/fork-base 的跳过；run marker 在 `~/.codex/.tmp`）。**读端必须同时支持 .jsonl 与 .jsonl.zst**（Node ≥24 `node:zlib` `zstdDecompressSync` 可解；现有 `parseRolloutFile` 已有该分支）；追加时 codex 会 materialize 回 plain——我们只写新文件，无此问题。

## 5. event_msg：持久化子集与载荷

持久化（policy.rs:90-135）：`item_completed`（Paginated 全存；Legacy 只存 function_call_output/plan/sleep/sub_agent_activity(completed)）、`token_count`、`thread_goal_updated`、`thread_rolled_back`、`turn_aborted`、`turn_started`(wire 名 `task_started`, alias `turn_started`, protocol.rs:1377)、`turn_complete`(`task_complete`)、`thread_settings_applied`；Legacy 模式才持久：`user_message`/`agent_message`/`agent_reasoning(+raw)`/`entered/exited_review_mode`/`patch_apply_end`/`context_compacted`/`mcp_tool_call_end`/`web_search_end`/`image_generation_end`/`sub_agent_activity`(非 completed)。
**不持久化**（transient，写端不生成）：exec begin/end/delta、审批请求、stream_error、plan delta、collab begin/end、realtime 会话、raw_response_item 等约 60 类。

关键载荷（resume 直接消费）：
- `thread_rolled_back {num_turns}` → 重建时丢最新 N 个用户轮（rollout_reconstruction.rs:189-192, 370-372）——**必须保真**。
- `turn_started {turn_id, trace_id?, started_at?, model_context_window?, collaboration_mode_kind}` / `turn_complete {turn_id, last_agent_message?, error?, started_at?, completed_at?, duration_ms?, time_to_first_token_ms?}` / `turn_aborted {turn_id?, reason:interrupted|replaced|review_ended|budget_limited, …}` → 反向回放的分段依据。
- `thread_settings_applied {thread_settings:{model, model_provider_id, service_tier?, approval_policy, approvals_reviewer, permission_profile, cwd, reasoning_effort?, reasoning_summary?, personality?, collaboration_mode}}`。
- `token_count {info?, rate_limits?}`（tokens/费用/限额快照，纯归档）。
- `thread_goal_updated {thread_id, turn_id?, goal}`。

## 6. 发现与 resume 机制

1. 按 id 找文件：`find_thread_path_by_id_str`（list.rs:1586）——state DB 优先、未命中回退 `sessions/**` 扫描；也支持 `archived_sessions/`。DB 里 threads.rollout_path 指向文件。
2. 按名字：`session_index.jsonl` 从尾扫描，同名取**最新条目**再落到文件。
3. resume = `InitialHistory::Resumed` 追加打开同一文件（recorder.rs:917-928），**不写第二条自己的 session_meta**；打开时 `ensure_rollout_is_newline_terminated`（容忍断行尾）。
4. 重建（rollout_reconstruction.rs）：反向扫描分段（turn_id 匹配）→ 取最新 `compacted.replacement_history` 为基点 → suffix 正向灌 ContextManager（response_item 逐条；IAC 转 model input）→ WorldState baseline 全量/补丁 → TurnContext 恢复 previous_turn_settings + reference baseline → rollback 丢轮。
5. resume 后 base 系统提示词取**记录值**（见 §7 优先级）。

> 最小可 resume 集合（官方 external-agent-migration 导入器实证，app-server/src/external_agent_migration/session_importer.rs:457-497）：`session_meta` + 若干 `response_item` + 伪造 `task_started/task_complete/user_message/agent_message/token_count` 事件即可（它不写 turn_context/world_state/compacted，resume 照样工作——只是首轮会重注入全量 environment_context）。我们的目标是 100% 保真，以上全写。

## 7. 系统提示词管线（本次调查重点）

### 7.1 Codex 侧机制

- **base 系统提示词**：默认文本 = `models-manager/prompt.md`（编译进二进制）或服务端模型目录的 `instructions_template`（可含 `{{ personality }}` 占位）；`BaseInstructions = {text, provenance: Custom|Model{model}}`。
- **每轮请求**：base prompt 走 Responses API 的 `instructions` 字段，**每次都新鲜发送，不存在"叠进历史"**（client.rs:891-997）；`use_responses_lite` 模型改为 position-0 的 developer 消息注入。**任何时刻只有一个 base prompt 生效**。
- **AGENTS.md（项目文档）不是系统提示词**：以 user 角色片段进上下文，包裹格式 ``# AGENTS.md instructions for <cwd>\n\n<INSTRUCTIONS>\n…\n</INSTRUCTIONS>``（context/user_instructions.rs:23-34）；从 cwd 向上收集到项目根，`AGENTS.override.md` 优先；变化时下一轮只发 diff（"These AGENTS.md instructions replace all previously provided…"）。旧版的 `<user_instructions>` 包裹已无引用。
- **environment_context**：user 角色 `<environment_context>…</environment_context>`（cwd/shell/日期/时区/网络/文件系统权限），由 world_state diff 机制管理；`<permissions instructions>` 是 developer 消息。
- **resume 优先级**（session/mod.rs:663-681，源码注释原文）：`config.base_instructions 覆盖 > rollout 记录的 session_meta.base_instructions > 按当前模型渲染`。**resume 不会把新渲染的 prompt 和旧记录叠起来**——单选。换模型 resume 只警告，仍用记录值。
- `developer_instructions` 配置 → developer 消息（session/mod.rs:3676-3682）。

### 7.2 迁移引擎的选择规范（明确立规，此前未成文）

引擎提供"系统提示词来源"选项：**`source`（带源方的）/ `target`（用目标方的）**。规则：

1. **单一系统提示词原则**：写入目标后，目标的 canonical system-prompt 槽位里只有一份提示词。**严禁**把源系统提示词再以 user/developer 消息形式叠在目标自己的系统提示词之上——双重系统提示词互相稀释指令，实测会劣化 agent 行为（这正是该选项存在的原因）。
2. 选 `source`：codex 写回 = `ir.systemPrompt` → `session_meta.base_instructions = {text, provenance:{custom:true}}`（resume 优先级第二位，无 config 覆盖时生效）；claude 写回 = system prompt；以此类推。跨工具携带时接受"提示词是给别家 agent 写的"这一降质——用户显式选的。
3. 选 `target`：codex 写回**不写 base_instructions**（或写渲染默认），目标工具用自己原生提示词开场。
4. **AGENTS.md/CLAUDE.md 类项目文档永远不进系统提示词选项**：它们本来就以 user 消息形态活在对话历史里（codex 的 `# AGENTS.md instructions…` 行、claude 的 CLAUDE.md 注入行），随 messages[] 自然迁移。**跨项目迁移警告**：源项目的项目文档会随历史回放 + 目标项目自己的文档又会注入 → 旧文档变成"历史噪音"（codex 的 diff 机制会把磁盘上的新文档标记为 replace，不算双份系统提示词，但要提示用户）。
5. codex 的 `<permissions instructions>`/`<environment_context>`/world_state 属于**harness 运行时上下文**，默认视为 `synthetic` 类注入内容（引擎现有语义）：不迁移则由目标 harness 自己生成；`--keep-runtime-context` 时按原样落盘保真。**不要**把它们当系统提示词搬。

## 8. codex→IR 映射总表

| 源（rollout） | IR 槽位 | 备注 |
|------|---------|------|
| `session_meta` 首行（匹配 id 的那条）整行 | `session.meta.codex.sessionMetaLine`（原生 payload + git）+ 结构化提升：`cwd`/`createdAt`(timestamp)/`originSessionId`(id)/`model{provider→model_provider}`/`systemPrompt`(base_instructions.text) + `session.meta.codex.baseInstructionsProvenance` | v3.1 `MigratedSession.meta`；结构化提升仅为列表/预览便利，**写回以 meta 原生为准** |
| 后续继承的 session_meta 行 | `session.meta.codex.inheritedMetaLines[]`（按序） | 子代理 rollout 前缀 |
| `response_item.message` | `messages[]`（role 保留，含 developer） | `meta.codex = {itemId, phase, passthrough, clientAuthored}` |
| AGENTS.md 行 | user 消息 + `meta.codex = {contentKind:'agents_md.instructions'}` | 供写端识别/标题推断跳过；**非 synthetic**（随历史保真迁移） |
| `<environment_context>` / `<permissions instructions>` / `<goal_context>` / `<codex_internal_context source=…>` 等注入行 | user/developer 消息 + `meta.codex = {contentKind:<官方点分 kind>}`；运行时再生成类标 `synthetic:true` | §7.2 规则 5 + §11 分类机制；`goal.internal_context` 等绝不投影为普通用户提示词 |
| `agent_message` / IAC | assistant 消息 + `meta.codex = {kind:'agent_message'|'iac', author, recipient, otherRecipients?, triggerTurn?}` | 模型可见 |
| `reasoning` | thinking 块（`signature` 无此概念不填；`meta.codex = {reasoningEntryTypes[], reasoningSummaryCount}` 精确保留 summary/content 边界与每块 entry type） | encrypted_content 丢弃（唯一例外） |
| function_call/custom_tool_call/local_shell_call/tool_search_call/web_search_call | tool_use 块（call_id→block.id） | arguments 保持源字符串→parse；encrypted_function_args 丢 |
| *_output（含 content_items） | tool_result 块；input_image→`attachments` FileBlock | `success` 字段源端已不保真 |
| `turn_context` | 该轮首条消息 `meta.codex.turnContext`（原生） | §v3.1 归属约定 |
| `world_state` full/patch | 同上 `meta.codex.worldState[]`（按序） | 写回时重放 full/patch 序列 |
| `compacted` | `compaction[]`：summary→summary；anchorIndex 指向投影的 summary 消息（codex 里 CompactedItem→assistant 消息，投影 role 以实际文件中的投影为准：legacy 重建是 user 摘要形态，写回按 native）；`replacementHistory`→replacementHistory；窗口/mcp 载荷→`meta.codex` | messages[] 同时全量保留被折叠前内容（无损原则，目标端按能力裁剪） |
| `event_msg`（全部持久化子集） | `unmappedEvents[]`（seq=行号） | resume 相关事件写回端重放 |
| `security_risk_score` / `realtime_item` / 未知行 | `unmappedEvents[]`（type 保留） | 归档不投影 |
| 文件名 ts / 目录层级 | 写回按 `createdAt` 本地时间重建目录；文件名 ts 用 UTC 渲染同款格式 | §4 |
| session_index 标题 | `session.title`；写回时 `session.meta.codex.sessionIndex = {thread_name, updated_at}` | **追加**一行，不改既有行 |
| 子代理 rollout（`source.subagent.thread_spawn`） | 同层独立会话（`session.meta.codex` 带 parent_thread_id）；选装聚合为 `sidechains[]`（agentId=threadId, kind='subagent', agentType=agent_role） | 深度/昵称/agent_path 均在 meta |

## 9. IR→codex 写回配方

1. 新 threadId（uuidv7 语义，现 `randomUUID()` 可用）；`session_id=id`。文件 `sessions/<Y>/<M>/<D>/rollout-<UTC渲染ts>-<id>.jsonl`（默认 legacy 模式：无 ordinal）。
2. 首行 session_meta：原生字段从 `meta.codex.sessionMetaLine` 取（`session_id`/`id` 换新，`cwd` 按 targetCwd 重映射，`base_instructions` 按 §7.2 选项写或不写，`cli_version` 写目标适配器标识，`timestamp` 重算），否则按最小集合成造（fork/parent 链有则带）。
3. messages[] → response_item 流：逐块映射（§8 反向）；developer 原样；`meta.codex` 原生字段逐条还原（id/phase/passthrough/clientAuthored）；tool_use/tool_result 以 block.id=call_id 关联；FileBlock→input_image（data→data: URL 或回退文本占位）。
4. `compaction[]` → `compacted` 记录：summary + `replacementHistory`→replacement_history（逐条 ResponseItem 化）+ `meta.codex` 窗口字段；随后 messages 从锚点后正常写。
5. `unmappedEvents` 里 resume 相关事件（task_started/task_complete/turn_aborted/thread_rolled_back/thread_settings_applied/sub_agent_activity(completed)/…）按原序重放为 event_msg 行；纯归档类（token_count 等）一并原样回写（无损）。
6. `meta.codex.turnContext`/`worldState` 挂在消息上，写消息行前先写对应 turn_context/world_state 行。
7. **追加** session_index.jsonl 一行（thread_name=title 或推断标题）；**不碰** state DB（回填自动）。
8. 冲突处理：目标路径已存在同名文件 → 换新 id 重写，**绝不覆盖/追加到既有会话**（AGENT.md 铁律）。

## 10. 坑清单（实现时对照）

- `session_id` 可能缺席（老文件）；`instructions` 字段老语义已废，读到时忽略并归档。
- function_call_output.output 双态（串/裸数组）；call_id 可空；`success` 不保真。
- reasoning 的 encrypted_content 是唯一合法丢弃；summary/content 必须保。
- 文件名 ts 本地写入/UTC 解析的官方 quirk。
- `.zst` 与 `_rolloutId` 文件名变体；deferred creation 空会话无文件。
- 同文件多条 session_meta（继承前缀）；history_base 指向**外部文件**的 ordinal 截断——读端已实现跨文件链式拼接（见 §11.2）。
- EventMsg wire 名 `task_started`/`task_complete`（alias turn_*）。
- `world_state.state` 里的 agents_md 全文 = 项目文档的权威快照，读端从中识别 AGENTS.md 内容。
- codex 官方导入器（external-agent-migration）是"最小导入"参照：只带 text、丢 thinking/tool 详文、伪造 turn 事件、无 turn_context/world_state、用 ledger 防重导（`~/.codex/external_agent_session_imports.json`，key=path+sha256）。我们方向相反（导出方），但它的 rollout 构造路径验证了最小可 resume 集。

## 11. 实现状态与偏差记录（2026-08-29 重写落地）

`packages/core/src/adapters/codex/{parse,write,paths,index}.ts` 已按本文档重写完成：17 适配器测试 + round-trip 零丢失门（消息/compaction/unmappedEvents 深等 + 逐行 payload 审计）+ 真实 `~/.codex` 全量 1665 会话只读表征审计全绿。与文档正文的偏差/细化如下：

### 11.1 harness 注入行分类（对 §7.2 规则 5 的落地机制）

分类有**两级通道**，均已在 `parse.ts` 实现：

1. **官方主通道**：`internal_chat_message_metadata_passthrough.content_item_kinds`（`ContentItemKind(String)` newtype，线上为裸点分字符串；`context-fragments/src/annotated_content.rs` 的 `to_annotated_content` 按位置与 content zip，缺失补 `"unknown"`）。逐条 verbatim 保真在 `meta.codex.contentItemKinds[]`（passthrough 本身也已保真），首个 item 的 kind 决定整行分类：`user.*`/`unknown`/`shell.user_command`/`multi_agent.inter_agent_message(-completion)` 视为真实内容，其余为 harness 注入 → `meta.codex.contentKind = <kind>`；其中运行时再生成类（`*.instructions`/`*.reminder`/`*.internal_context`/`*.environment_context`/token_budget/rollout_budget/images/audio/model_switch/permissions 前缀保存/turn_aborted/compaction.summary 等）加标 `synthetic:true`。
2. **Legacy fallback**：无 kinds 的旧 rollout 用文本标记嗅探，词表 = codex 自家冻结判定 `thread-store/src/local/rollout_migration/rollback.rs` 的 `is_known_contextual_user_text` + developer 前缀清单（`<goal_context>`、`<codex_internal_context source="X">` → `X.internal_context`、`# AGENTS.md instructions`、`<user_shell_command>`、`<turn_aborted>`、`<subagent_notification>`、`<recommended_plugins>`、`<skill>`、`<environment_context>`、`<external_*>`、三条 Warning 前缀、`<permissions instructions>`/`<model_switch>`/`<token_budget>`/`<context_window(_guidance)>`/`<rollout_budget>`/`<personality_spec>`/`<tools>` 等 developer 注入）。

真实数据分布（1665 会话实测，kind:条数）：`goal.internal_context:14696`、`generic.turn_aborted:8177`、`multi_agent.subagent_notification:6595`、`environments.environment_context:3451`、`permissions.instructions:3368`、`agents_md.instructions:2600`、`multi_agent.mode_instructions:693`、`apply_patch.legacy_exec_command_warning:598`、`collaboration_mode.instructions:575`、`model_switch.instructions:114`、`skills.instructions:62`、`personality.spec_instructions:3`。**goal resume / system reminder 从此不再出现在用户提示词里**。

### 11.2 与正文的其他偏差

- **history_mode 按源保真**（取代原"写端强制 legacy"）：源是 paginated 写回仍是 paginated；源无 `history_mode` 字段（legacy 指纹）写回也不添加——`history_mode` 仅在源已声明时 verbatim 转发。跨文件 `history_base` 分叉读端**链式拼接**（`stitchRecords`）：按 `history_base.end_byte_offset` 对前缀 rollout 文件做 byte 精确截断，递归上溯（防环：visited 集 + 32 层深度；`findRolloutById` 按 rollout-id 精确匹配并排除自身与下游文件，防 mtime 更新的后缀文件误选），前缀记录插到 own session_meta 之后、正文之前，链路存 `meta.codex.historyChain[]`（rolloutId/endOrdinalExclusive/endByteOffset/sourcePath）。拼接后写端发**自足单文件**：session_meta 载荷删去 `history_base`，全流 ordinal 按发射顺序重编号连续。已知局限：前缀侧行内嵌的 `subagent_history_start_ordinal` 校验域跨文件后仍 verbatim 保留（对应原文件 ordinal 空间，读回拼接视图时无碍，官方 CLI 校验器视角可能需重算）。
- **`additional_tools` / `compaction_trigger` / `other`（§3 未持久变体）**：读端归档 `unmappedEvents[]`（`type:'response_item'`，`data.codexResponseItem` = 去加密原始 payload，`data.clientAuthored` 随行），写端按原位重放 response_item 行——比正文"归档不投影"更进一步，零丢弃。
- **`meta.codex.sourceDir` / `sourceFile`**：读端记录源 rollout 所属文件夹（相对 CODEX_HOME，`sessions/YYYY/MM/DD` 或 `archived_sessions`）与文件名——列表/审计/溯源用；写回新文件路径由 `createdAt` 本地时间重建，不沿用该字段。
- **session_index 标题推断**（§9.7）：codex 惯例 = **用户第一条真实 prompt 的前缀**。实现顺序：`ir.title` → 原生 `sessionIndex.thread_name` → 首条 `role=user && !synthetic && 无 contentKind && 无 kind` 消息首行文本（60 字符截断）→ `'(untitled)'`。注入行（goal/AGENTS.md/shell 命令/压缩摘要投影）全部跳过。
- **turn_context / world_state verbatim 重放**：仅 `session_meta.cwd` 按 targetCwd 重映射；turn 行内嵌的 cwd 不改写（保留源轮次原貌）。
- **client_authored 信封**：response_item 行的 `metadata.client_authored` 读端入 `meta.codex.clientAuthored`，写端逐行还原。
- **§8 表格更新**：AGENTS.md 行 `contentKind:'agents_md.instructions'`（非 synthetic）；注入行 contentKind 一律用官方点分 kind 值。
- **event_msg 回写门控**（§5 持久化子集的写端落实）：`unmappedEvents` 重放默认分支只发内层 `type` 命中**持久化变体名单**的载荷（`task_started`/`token_count`/`thread_rolled_back` 等两模式持久项 + legacy-only 项，两种 wire 拼写都收）；官方已退役的类型（`thread_name_updated`/`guardian_assessment`/`undo_completed`，codex line_parser 以 `Ok(None)` 跳过）和非 codex tag 一律不回写——不发注定被官方工具链丢弃的行（AGENT.md 事件跨工具共识）。另注：unmappedEvents 重放整体包在 `sessionCodex` 守卫内，**外来 IR 的事件本来就不写进 codex 文件**。

### 11.3 待办：外来→codex 的轮边界合成（条件触发，未实现）

外来 IR（dsh/claude/…）写 codex 时，消息投影为裸 `response_item` 流，**不含任何 `task_started`/`task_complete`**（源侧轮边界事件在 `unmappedEvents` 里且被 `sessionCodex` 守卫拦下）。codex resume 重建按 turn 事件对分段（rollout_reconstruction.rs 反向扫描），没有这些事件 = 整个迁移会话被当作**一整轮**：resume/加载正常，但粒度全错——`thread_rolled_back {num_turns:1}` 会回滚整个会话（本应只回滚最后一个 prompt），UI 轮次分组也是一坨。

**方案**（= 给 codex 写端补上 dsh 骨架合成器的对等能力，官方 external-agent-migration 导入器同款做法，见 §6 最小可 resume 集）：写端遍历 `ir.messages`，**真实**用户 prompt（非 synthetic、无 contentKind/kind，与标题推断同规则）开启新轮 `task_started {turn_id: N}`（N 从 1 递增），下一条真实用户 prompt 或流末尾收轮 `task_complete {turn_id: N, last_agent_message: <末条 assistant 文本>}`。是否同时伪造 `user_message`/`agent_message`/`token_count`（官方导入器连这些也伪造）待定——它们是 legacy-only 持久项，paginated 目标不需要。

**触发条件**：迁移会话在 codex 里实际使用后发现轮次粒度影响回滚/展示，再做；实现前须拿真实迁移文件验证 resume 行为（反向扫描对合成事件的接受度）。
