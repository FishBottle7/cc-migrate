# Claude Code — 会话存储深度调查（适配器开发权威依据）

> 状态：v3 深度版（2026-08-29）。替代本文件旧版浅层调查。
> 三方材料交叉验证：
> 1. **老版权源码** `D:\codes\Opensource\claude-code-main\claude-code-main\src`（Bun/TS 完整源码，核心 `src/utils/sessionStorage.ts` 5105 行已全文通读）
> 2. **新版 CLI 二进制** `~/.local/bin/claude.exe`（v2.1.251，Bun 编译，内嵌 minified bundle 定向抽取逆向）
> 3. **本机真实数据** `~/.claude/projects/`（63 个 jsonl / 27429 行 / 0 坏行，版本覆盖 2.1.206 → 2.1.251，字段全量枚举脚本在 `.tmp-claude-audit/`）
> 审计对照：`docs/session-formats-audit.md#3`（其中 §3 的 leafUuid 结论已被本调查修正）
> 调查目的：claude 适配器重写前置——**除加密外 100% 无损**、**绝不做删除操作**、系统提示词双端策略。

---

## 0. 结论速览（TL;DR）

1. **存储 = 追加式 JSONL + parentUuid 有向图（非链）**。`user`/`assistant`/`attachment`/`system` 四类记录进图，另有 30+ 种会话级元数据行散落其间。resume = 从最新 leaf 沿 parentUuid 回溯 + 一系列修复 pass。
2. **transcript 里没有系统提示词**。resume 时系统提示词由目标二进制当时代码 + 当次 flag 重新生成。迁移工具"选带哪方系统提示词"对 Claude 目标端**唯一正道是进程参数**（`--append-system-prompt`），往 jsonl 里塞提示词没有原生通道。
3. **唯一不可迁移负载是 `redacted_thinking.data`**（opaque 密文）。`thinking.signature` 是签名不是密文，必须逐字节保留。
4. 新版（2.1.251）相对老源码新增大量记录类型与 stamp 字段（§7 DELTA 表），其中 `permission-mode` / `cost-state` / `file-history-delta` / `last-prompt.leafUuid` 复活等直接影响适配器写端。
5. 现有 `adapters/claude/index.ts` 与 `path.ts` 有 **6 处会造成信息丢失或路径错误**的具体问题（§9），需按本文件重写。
6. 硬约束：适配器只新增文件（新 uuid），**永不删除、永不原地改写、永不 append 进已有会话文件**（§6）。
7. **round-trip 已真机验证**（§12）：手工伪造的会话被 2.1.251 原样加载回放（含 isMeta 记录进模型上下文），且 claude 自己以原生形状向其追加后续对话——写端配方成立。subagent/teammate 旁链的恢复链路深挖见 §11。

---

## 1. 存储布局

```
$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sessionId>.jsonl     # 主会话（默认 $CLAUDE_CONFIG_DIR=~/.claude，NFC 归一）
$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sessionId>/subagents/agent-<agentId>.jsonl        # 子代理旁链
$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sessionId>/subagents/workflows/<runId>/agent-*.jsonl  # workflow 分组旁链
$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sessionId>/subagents/agent-<agentId>.meta.json    # 旁链侧车
$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sessionId>/remote-agents/remote-agent-<taskId>.meta.json  # 远程任务侧车
```

- `getClaudeConfigHomeDir()`：`CLAUDE_CONFIG_DIR` 环境变量可整体覆盖根目录（`src/utils/envUtils.ts:7`）。适配器 `root` 参数应支持传入。
- **目录编码 `sanitizePath`**（`src/utils/sessionStoragePortable.ts:311`）：`name.replace(/[^a-zA-Z0-9]/g, '-')`，**且总长 >200 时截断到 200 再加 `-` + hash 后缀**（`Bun.hash(name).toString(36)`，非 Bun 用 `simpleHash`；`MAX_SANITIZED_LENGTH=200`，`sessionStoragePortable.ts:293`）。
  ⚠️ 现有 `adapters/claude/path.ts` **没有实现 200 截断 + hash**，深层路径 cwd 会写错目录。注意与 DSH `projectKey` 的区别：DSH 把连续分隔符压缩为单个 `-`，Claude 是**每个非字母数字字符各换一个 `-`**，两边不做归一化合并。
- 文件名 = sessionId（严格 uuid，读取端 `validateUuid` 校验，非 uuid 文件名被列表/加载忽略，`sessionStorage.ts:4547`）。
- `/resume` 列表 = 纯目录扫描（`getSessionFilesLite`，stat-only + 按需 enrich 头尾各 64KB）；**不存在 `sessions-index.json`**（新版二进制中 0 命中）。enrich 过滤规则：首行含 `"isSidechain":true` 或 head 里有 `teamName` 的文件不进列表（`enrichLog`，`sessionStorage.ts:5023-5070`）。
- worktree 跨目录：同 repo 多 worktree 的 project 目录按**大小写不敏感**名称匹配聚合（长前缀优先）；注意两个实现有精度差：`sessionStorage.ts:4164` 对任意前缀做 `dirName === prefix || dirName.startsWith(prefix + '-')`，而 SDK 的 `listSessionsImpl.ts:382-385` **只对 ≥200 截断 + hash 后缀的目录**才允许 startsWith，短前缀要求全等（防止 `/root/project` 误吞 `/root/project-foo`）。同 sessionId 按 mtime 去重（`getStatOnlyLogsForWorktrees`，`sessionStorage.ts:4113`）。

### 1.0 /resume 列表元数据提取的精确规则（`listSessionsImpl.ts:79-149`，SDK listSessions 与 CLI enrichLog 同构）

- 文件名必须过 `validateUuid`；首行含 `"isSidechain":true` → 过滤。
- 标题解析顺序：`customTitle`(tail→head) → `aiTitle`(tail→head)（字段名天然区分，用户改名永远赢）。
- 摘要显示顺序：`customTitle` → `last-prompt.lastPrompt`(tail) → legacy `summary`(tail) → head 扫描的 firstPrompt。
- `createdAt` 取**首条记录的 ISO timestamp**（比 stat.birthtime 可靠，部分文件系统不支持 birthtime）。
- `tag` 只在以 `{"type":"tag"` 开头的行上提取（避免 tool_use input 里同名 `tag` 参数污染）。
- gitBranch：tail 最后一值 → head 首值。

### 1.1 外围关联存储（非 transcript 本体，迁移可选搬运）

| 路径 | 内容 | 与会话正文的关系 |
|---|---|---|
| `~/.claude/file-history/<sessionId>/` | 被编辑文件的实际备份 | `file-history-snapshot`/`file-history-delta` 行里的 `backupFileName` 指到这里 |
| `~/.claude/plans/<slug>.md` | plan 模式产物 | `slug` stamp + `plan_mode_exit.planFilePath` 引用 |
| `~/.claude/session-env/<sessionId>/` | 会话环境 | 目前实测为空目录 |
| `~/.claude/tasks/session-<sid前8>/` | TaskCreate/TaskList 等任务态 | 独立 JSON，resume 不经 transcript |
| `~/.claude/teams/<teamName>/` | 团队注册表（`config.json`：leadAgentId/leadSessionId/members[]）+ 信箱 `inboxes/<agentName>.json` | teammate/swarm 协作态（§11.3） |
| `~/.claude/history.jsonl` | 全局 prompt 历史（`{display,pastedContents,timestamp,project,sessionId}`） | 仅 UI 输入历史，非权威 |
| `~/.claude/sessions/<pid>.json` | **活进程**注册（pid/cwd/version/name/status…） | 临时态，与会话文件无关 |
| `~/.claude/transcripts/ses_*.jsonl` | SDK 子进程 transcript（**另一种简化 schema**：首行直接 `{"type":"user","timestamp","content"}`） | 不与 projects/ 布局混用，适配器不要误读 |

---

## 2. 记录类型全集（Entry union，老源码 `src/types/logs.ts:297` + 2.1.251 增量）

真实数据实测计数（27429 行）：assistant 11217 / user 7182 / attachment 3212 / last-prompt 1228 / mode 1198 / permission-mode 1173 / ai-title 1143 / file-history-snapshot 371 / system 296 / queue-operation 214 / file-history-delta 177 / atis-latch 9 / agent-name 7 / cost-state 2。

三大类：

- **A. transcript 消息**（有 uuid、进 parentUuid 图）：`user` / `assistant` / `attachment` / `system`（+ legacy `progress`，读取端有 bridge 修复，`sessionStorage.ts:3623-3645`）。
- **B. 会话级元数据行**（无 uuid/parentUuid，不进图，读取端 last-wins 或 accumulate）。
- **C. 结构化桶行**（快照/替换/压缩等）。

### 2.1 A 类公共信封字段（`insertMessageChain` stamp，`sessionStorage.ts:1039-1064`；2.1.251 逆向同形 + `sessionKind`）

写入顺序（对象键序）固定为：

```
parentUuid → logicalParentUuid? → isSidechain → teamName? → agentName? → promptId?(仅user) → agentId?
→ ...message 本体展开 → userType → entrypoint → cwd → sessionId → version → gitBranch → slug?
```

2.1.251 额外：`sessionKind: C2()`（如 `"bg"` 后台会话）也作为 stamp 追加在 message 之后（老源码无）；`toolUseResult` 在写盘前经 `FHe()` 过滤函数消毒（新版行为，老源码直写）。

| 字段 | 语义 |
|---|---|
| `parentUuid` | 父记录 uuid；**compact boundary 行强制 null**（链在此截断），tool_result 行被 `sourceToolAssistantUUID` 覆盖（挂到对应 assistant 的 uuid 而非顺序前驱）→ 图/DAG，不是链 |
| `logicalParentUuid` | 仅 boundary 行有：被截断前的逻辑父（`sessionStorage.ts:1040-1041`） |
| `isSidechain` | 旁链标记；**首行 isSidechain:true 的文件被 /resume 过滤** |
| `agentId` | 旁链记录必带；写盘路由到 `subagents/agent-<id>.jsonl`（`appendEntry`，`sessionStorage.ts:1224-1228`） |
| `promptId` | 仅 user；OTel prompt.id 关联 |
| `teamName`/`agentName` | swarm/teammate 团队标识；teamName 非空的文件被 /resume 过滤 |
| `userType` | `process.env.USER_TYPE \|\| 'external'`（本机数据为 `ant`——影响 attachment 是否落盘，见 §2.4） |
| `entrypoint` | `CLAUDE_CODE_ENTRYPOINT`（cli/sdk-ts/sdk-py/…） |
| `cwd`/`sessionId`/`version`/`gitBranch`/`slug` | 写盘时强制重 stamp（fork/resume 防漂移） |
| `sessionKind`（新） | `"bg"` 等；2.1.227+ 实测出现 |

**uuid 去重**：主文件写消息时按 uuid 去重（`getSessionMessages` memoized 集合，`sessionStorage.ts:1242`）；旁链旁路此去重（fork seed 场景父子共享 uuid）。phantom parent 防护：`sourceToolAssistantUUID` 不在已知集合时回退顺序父并记 `tengu_phantom_parent_write`（2.1.251 逆向确认）。

### 2.2 user / assistant 记录的 message 本体

**user.message**：`{role:'user', content: string | blocks[]}`。
**assistant.message**：`{id, model, role:'assistant', type:'message', content: blocks[], usage, stop_reason, stop_sequence, stop_details?, context_management?, container?, diagnostics?, provider?}`。
`usage` 实测全字段：`input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, server_tool_use{web_search_requests,web_fetch_requests}, service_tier, cache_creation{ephemeral_1h_input_tokens, ephemeral_5m_input_tokens}, inference_geo, iterations, speed, output_tokens_details?`。

**user 专属顶层字段**（实测 + 老源码）：

| 字段 | 说明 |
|---|---|
| `toolUseResult` | **结构化工具结果原文**（与 tool_result 块的 `content` 字符串并行）：Bash → `{stdout,stderr,interrupted,isImage,noOutputExpected}`；拒绝 → 字符串 `"User rejected tool use"`；各工具各自结构。这是模型可见文本之外的无损信息，**必须进 IR** |
| `sourceToolAssistantUUID` | 本 tool_result 对应的 assistant uuid（= 图中真实父） |
| `isMeta` | 挂 harness 注入文本（`<local-command-caveat>`、`<system-reminder>` 等）；UI 隐藏但 **normalizeMessagesForAPI 保留、会进模型上下文** |
| `origin` | `{kind:'human'}` 等（输入来源分类） |
| `promptSource` | `"typed"` 等 |
| `permissionMode` | 用户消息发出时的 permission 模式 |
| `interruptedMessageId` | 打断消息所指向的 assistant message.id |
| `toolDenialKind` | `"user-rejected"` 等 |
| `isVisibleInTranscriptOnly` | 只在 transcript 视图显示 |

**agent-authored user 行定性（2026-09-05 真机裁定，迁移读端分类）**：有一类 user 行**不是人话**——
- **打断标记**：正文为 `[Request interrupted by user]` / `[Request interrupted by user for tool use]`（真机 57 行实测**全部 isMeta 缺失**、`userType` ant/external 皆有——不能靠 isMeta/userType 区分）；常与后续内容**同行混装**（打断标记 + teammate 信封，或打断标记 + 真人新输入，如 `["[Request interrupted by user for tool use]\n", "这个subagent已经完成切片了啊…"]`）。
- **跨代理消息信封**：`Another Claude session sent a message:\n<teammate-message …>`（队友/子代理之间的对话投递）。
- **子代理转写（`isSidechain:true`）的全部非 tool_result user 行**：spawn prompt（Task 工具的 prompt 参数，纯文本无任何标记）、teammate-message、system-reminder——真人无法在子代理转写里发言。
- 迁移定性：这些行/块 → IR `synthetic:true`（模型上下文红线照旧：内容零丢弃、claude 写端映回 isMeta 行重放进上下文）；**混装行按连续同源段拆成多条 IR 消息**（agent run → 注入，human run → 人话），DSH 写端把 agent run 映为 `source:{kind:'plugin'}` 注入行——它们不构成 turn 边界（打断不再把 DSH 会话骨架切碎），spawn prompt 也不再在子代理会话里显示成人话气泡。
| `isCompactSummary` | **压缩摘要载体标记**（§4） |
| `summarizeMetadata` | partial compact：`{messagesSummarized, userContext?, direction?}` |
| `sourceToolUseID` | 少见（实测 3 条） |
| `session_id` | snake_case 双写（2.1.227+，与 `sessionId` 并存，实测 7648 条） |

**assistant 专属顶层字段**：

| 字段 | 说明 |
|---|---|
| `requestId` | API 请求 id |
| `effort` | 推理档位（`"max"` 等，2.1.227+） |
| `isApiErrorMessage` + `error` + `apiErrorStatus` + `apiErrorIsTransient` | 合成错误消息（`model:'<synthetic>'`，正文是错误描述文本） |
| `isAbortedMidStream` | 流中断 |
| `isVirtual` | 显示层虚拟消息（外部构建写盘前剥除 `isVirtual` 键本身，`transformMessagesForExternalTranscript`，`sessionStorage.ts:4396`） |
| `attributionAgent` / `attributionSkill` / `attributionMcpServer` / `attributionMcpTool` | commit 归因 |

**content 块实测形态**：
- `assistant/text`：`{type:'text', text, citations?}`
- `assistant/thinking`：`{type:'thinking', thinking, signature}` —— **signature 恒在（可为空串）**；签名是"非密文"，API 回放必须原样携带
- `assistant/tool_use`：`{type:'tool_use', id, name, input, caller?}`（`caller` 2.1.227+，实测 1761 条）
- `assistant/redacted_thinking`：`{type:'redacted_thinking', data}` —— **opaque 加密，唯一不可迁移负载**（本机数据未见实例，仅在 skill 文档文本中提及）
- `user/tool_result`：`{type:'tool_result', tool_use_id, content, is_error}`（`content` 可为字符串或块数组，数组内可含 image）
- `user/content:<string>`：682 条纯字符串 content
- image/document 块：本机 2.7 万行未出现（用户未贴图）；类型上存在于 `hasVisibleUserContent`（`sessionStorage.ts:2414`）与 PDF/image 错误处理（`normalizeMessagesForAPI` 的 strip 表）

### 2.3 system 记录（subtype 全集，实测 + 老源码 create* 函数）

`{type:'system', subtype, ...payload, uuid, timestamp, isMeta?, level?}` + 信封。实测 subtype：

| subtype | payload 关键字段 | 回放语义（normalizeMessagesForAPI） |
|---|---|---|
| `compact_boundary` | `compactMetadata{trigger,preTokens,postTokens?,cumulativeDroppedTokens?,durationMs?,preCompactDiscoveredTools?,preservedSegment?,preservedMessages?}` + `logicalParentUuid` | **不进 API**；parentUuid=null 截断链（§4） |
| `microcompact_boundary` | `microcompactMetadata{trigger,preTokens,tokensSaved,compactedToolIds,clearedAttachmentUUIDs}` | 不进 API，纯标记 |
| `turn_duration` | `durationMs, messageCount`（resume 一致性校验用，`checkResumeConsistency`） | 不进 API |
| `stop_hook_summary` | `hookCount, hookInfos[], hookErrors, hookAdditionalContext, preventedContinuation, stopReason, hasOutput, toolUseID` | 不进 API |
| `local_command` | `content`（命令输出文本）, `level` | **例外：转成 user 文本进 API**（连续 user 合并） |
| `away_summary` | `content` | 不进 API |
| `model_refusal_no_fallback` | `apiRefusalCategory, apiRefusalExplanation, refusedUserMessageUuid` | 不进 API |
| `model_refusal_fallback` | `fallbackModel, direction` | 不进 API |
| `informational` | `content` | 不进 API |

### 2.4 attachment 记录

`{type:'attachment', attachment:{type,...}, ...}` + 信封，**进 parentUuid 图**（挂在产生它的消息后）。

**落盘门控（关键！）**：`isLoggableMessage`（`sessionStorage.ts:4351-4367`）——`userType !== 'ant'` 时 **attachment 全部不落盘**，唯一例外 `hook_additional_context` 且 `CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT` 开启。外部用户 transcript 里几乎不会有 attachment 行；本机数据有 3212 条是因为 `userType=ant`。**迁移读端：有则保、无则不造；写端按目标默认（写与不写都合法）。**

Attachment union（老源码 `attachments.ts:295-737`，**字段级形状已全文核录**；实测落盘的标 ★）：
`file`★（`{filename, content: FileReadToolOutput, truncated?, displayPath}`）、`compact_file_reference`★（`{filename, displayPath}`）、`pdf_reference`（`{filename, pageCount, fileSize, displayPath}`）、`already_read_file`、`edited_text_file`★（`{filename, snippet}`）、`edited_image_file`、`directory`（`{path, content, displayPath}`）、`selected_lines_in_ide`、`opened_file_in_ide`、`todo_reminder`、`task_reminder`★（`{content: Task[], itemCount}`）、`nested_memory`★（CLAUDE.md `{path, content: MemoryFileInfo, displayPath}`）、`relevant_memories`（含 `header`/`limit` 防 prompt cache bust 字段）、`dynamic_skill`、`skill_listing`★（`{content, skillCount, isInitial}`）、`skill_discovery`、`queued_command`★（`{prompt: string|blocks, source_uuid?, imagePasteIds?, commandMode?, origin?, isMeta?}`）、`output_style`、`diagnostics`、`plan_mode`★ / `plan_mode_reentry` / `plan_mode_exit`★（`{planFilePath, planExists, reminderType?, isSubAgent?}`）、`plan_file_reference`、`auto_mode`/`auto_mode_exit`、`critical_system_reminder`、`mcp_resource`、`command_permissions`★、`agent_mention`、`task_status`、`async_hook_response`、`token_usage`、`budget_usd`、`output_token_usage`、`structured_output`、`teammate_mailbox`（`{messages:[{from,text,timestamp,color?,summary?}]}`）、`team_context`（`{agentId, agentName, teamName, teamConfigPath, taskListPath}`）、hook 族 9 种（`hook_success`★/`hook_blocking_error`/`hook_non_blocking_error`★?/`hook_error_during_execution`/`hook_stopped_continuation`/`hook_additional_context`★/`hook_cancelled`★/`hook_permission_decision`/`hook_system_message`★）、`invoked_skills`★、`verify_plan_reminder`、`max_turns_reached`、`current_session_memory`、`teammate_shutdown_batch`、`compaction_reminder`、`context_efficiency`、`date_change`★、`ultrathink_effort`、`deferred_tools_delta`★（`{addedNames, addedLines, removedNames}`）、`agent_listing_delta`★（`{addedTypes, addedLines, removedTypes, isInitial, showConcurrencyNote}`）、`mcp_instructions_delta`★（`{addedNames, addedBlocks, removedNames}`）、`companion_intro`、`bagel_console` 等；另有实测出现但属新版新增的 `total_tokens_reminder`★（`<total_tokens>N tokens left</total_tokens>` 提醒）、`read_truncation_notice`★。

> attachment 在模型回放中经 `reorderAttachmentsForAPI` 重排（冒泡到 tool_result/assistant 前）后进 API——它们是**模型上下文的一部分**，迁移丢弃即丢上下文。

**回放语义实测补正 + 纯状态提醒不投影（2026-09-07，mock 请求体捕获法）**：

1. **`total_tokens_reminder` 是逐轮落盘、全量回放的**——每个 regular user prompt 写一条（门控 `isRegularUserPrompt && 设置≠off`），resume/继续时 24/24 全部回放进模型上下文（035064cf 真机会话实测，按数值逐一比对；合并内嵌进相邻 user/tool_result 文本，GUI 不可见）。**不是"只给最新一条"**。与不落盘的 per-request userContext（`# currentDate`/CLAUDE.md，每次请求现算、永远只有最新一份，§5.2）是两类机制。原生靠两点容忍堆积：每条仅 ~20 token；compaction 截断链时整段清掉（段内堆积、段间不叠加）。
2. **迁移裁定（用户拍板"全部不投影"）**：`total_tokens_reminder` / `token_usage` / `budget_usd` / `output_token_usage` 四类**纯状态提醒**（过期计量快照，语义价值≈0）跨工具迁移**不再投影为 IR 消息**——读端（`parse.ts` `PURE_STATUS_ATTACHMENT_TYPES`）把原行整体进 `sessionEvents` 桶保真；claude→claude 走 `recordsRaw` 字节直通零影响；跨工具写端不再为它们生成注入行。动机：真机迁移产物实测注入比严重失衡（79492f69：444 条 user 行仅 13 条人话，提醒文本占 surface 18.7%），且 DSH 侧 `user/message` 无条件逐字回放进模型上下文（`surface.ts` deriveEventMessage），纯污染。有语义负载的 attachment（`skill_listing`/`deferred_tools_delta`/`file`/`task_reminder`/hook additional context 等）照旧投影——它们是模型上下文的真实组成部分。§2.4 顶部"迁移丢弃即丢上下文"的红线自此以"语义负载"划界：纯状态计量快照例外。
3. 遗留观察（未处置）：claude 原生 compaction 截断语义（每段只回放本段）在 claude→DSH 写端尚无对应物——`irToEvents` 不消费 `ir.compaction`，迁移产物 resume 时全历史段复活。DSH 的原生对应机制是 `surfaceOp:'replace'` 检查点（+`shadowed`），可作为后续增强（P1）。

### 2.5 B/C 类元数据行全集（B=last-wins 等合并语义；含 2.1.251 reAppend 顺序逆向）

老源码权威 union：`src/types/logs.ts:297-317`。2.1.251 二进制中的**完整合并语义表**（逆向）：

```
last-wins: custom-title, ai-title, tag, pr-link, attribution-snapshot, mode, permission-mode(新),
           isolation-latch(新), atis-latch(新), worktree-state, cost-state(新), queue-operation,
           observer-ref(新), artifact-autoreact-ledger(新), bridge-session(新), history-suppression(新)
accumulate: artifact-comment-monitor(新), file-history-snapshot/delta, …(其余默认)
route-by-agent: content-replacement, fork-context-ref(新), observer-ref(新)
```

| 记录 | 形状 | 说明 |
|---|---|---|
| `last-prompt` | `{type, lastPrompt?(≤200,换行折空格,`…`截断), leafUuid?, explicit?, rewound?, sessionId}` | **新版复活 leafUuid**（读取端消费：`if(bn.type==="last-prompt"){if(bn.leafUuid)We=bn.leafUuid…}`）。`explicit:true` 由显式用户动作写（rewind 等，`Ube`）；`rewound:true` 标记回退。`normalizeLastPrompt` 逆向确认 200 上限 |
| `custom-title` / `ai-title` / `tag` | `{type, customTitle/aiTitle/tag, sessionId}` | 用户改名永远赢 AI 改名（字段名区分）；**2.1.251 起 ai-title 也参与 reAppend**（老版不） |
| `relocated`（新） | `{type, relocatedCwd, sessionId}` | 会话迁移目录（`beginTranscriptRelocation`/relocationBuffer 机制） |
| `agent-name` / `agent-color` / `agent-setting` | 同形 | agentSetting = 启动 agent 定义（resume 路由用） |
| `mode` | `{type, mode:'coordinator'\|'normal', sessionId}` | |
| `permission-mode`（新） | `{type, permissionMode, sessionId}` | 实测 1173 条，acceptEdits 等 |
| `isolation-latch`（新） | `{type, side, sessionId}` | one-shot 闩状态（`HY(cell, onLatch)` 工厂 + `saveIsolationLatch`，latch 触发一次后解绑回调），与 rewind/restore 流程的 `latchActive/clearLatch` 同族；`side` 的值域未能从压缩代码完全解出（开放问题残余），**按原样搬运**即可（读取端 restore 进 session 状态） |
| `atis-latch`（新） | `{type, atis, sessionId}`，读取端校验 `atis` 必须全可打印 ASCII（`/^[\x21-\x7e]*$/`） | **ATIS = Anthropic API 请求头机制**（二进制中 `ATIS_REQUEST_HEADER` / `getClientDataAtis` / `latchConversationAtis`）：会话开始时锁定的 attestation/路由头值，落盘以便 resume 后复用同一值。迁移无需理解内容，原样携带或省略均合法（本机实测恒为空串） |
| `worktree-state` | `{type, worktreeSession: PersistedWorktreeSession\|null, sessionId}` | null=已退出；resume 时仅当 worktreePath 仍存在才恢复 |
| `pr-link` | `{type, prNumber, prUrl, prRepository, timestamp, sessionId}` | |
| `frame-link`（新） | `{type, artifactCount, sessionId, timestamp}` | artifact 计数锚 |
| `history-suppression`（新） | `{type, sessionId, cause, vetoedAgainstAccountUuid?, ts}` | 逆向自 `S5()` |
| `bridge-session`（新） | `{type, sessionId, bridgeSessionId, lastSequenceNum, declaredDialogKinds?, sessionGroupingId?, noHistoryBackfill?, ownerAccountUuid?, ownerOrganizationUuid?}` | 远程桥接锚 |
| `cost-state`（新） | `{type, sessionId, totalCostUSD, totalAPIDuration, totalAPIDurationWithoutRetries, totalToolDuration, totalLinesAdded, totalLinesRemoved, totalDuration, startTime, modelUsage:{<model>:{inputTokens,outputTokens,cacheReadInputTokens,cacheCreationInputTokens,webSearchRequests,costUSD}}, hasUnknownModelCost}` | 会话累计成本（`claude ps` 用） |
| `queue-operation` | `{type, operation:'enqueue'\|'dequeue'\|'remove', timestamp, sessionId, content?}` | 排队输入审计（dequeue 为 round-trip 实测补充） |
| `task-summary` | `{type, summary, timestamp, sessionId}` | `claude ps` 滚动摘要 |
| `summary` | `{type, leafUuid, summary}` | **遗留行**：compact 已不再写它（见 §4），读取端仍兼容 |
| `speculation-accept` | `{type, timestamp, timeSavedMs}` | **2.1.251 已移除**（二进制 0 命中） |
| `file-history-snapshot` | `{type, messageId, snapshot:{messageId, trackedFileBackups:{path:{backupFileName,version,backupTime,realParentDir?}}, …}, isSnapshotUpdate}` | C 类 |
| `file-history-delta`（新） | `{type, messageId, snapshotMessageId, trackingPath, backup:{backupFileName,version,backupTime,realParentDir}, timestamp}` | 增量文件历史 |
| `attribution-snapshot` | `{type, messageId, surface, fileStates:{path:{contentHash,claudeContribution,mtime}}, promptCount?, …}` | commit 归因 |
| `content-replacement` | `{type, sessionId, agentId?, replacements:[{kind:'tool-result', toolUseId, replacement}]}` | 超长 tool_result 落盘替换；resume 逐字节重放保证 prompt cache 稳定（`toolResultStorage.ts:447-463`） |
| `marble-origami-commit` / `-snapshot` / `-reset`（新） | 见老源码 `ContextCollapseCommitEntry/SnapshotEntry` | 上下文折叠（feature-gated）；boundary 处清空 |

**reAppendSessionMetadata（2.1.251 逆向，顺序即写入顺序）**：
`last-prompt(带leafUuid)` → `custom-title` → `ai-title` → `tag` → `relocated` → `agent-name` → `agent-color` → `agent-setting` → `mode` → `permission-mode` → `isolation-latch` → `atis-latch` → `worktree-state` → `pr-link` → `frame-link` → `history-suppression` → `bridge-session`；并与 tail 64KB 窗口内已有同类型行做去重比较（timestamp/ts 字段除外），相同则跳过。触发时机：compaction 前 + 会话退出清理 + materializeSessionFile（首条消息落盘时把启动期缓存 mode/permission-mode/atis-latch 等写到**文件头**，真实文件头实测顺序：`ai-title, agent-name, mode, permission-mode, atis-latch, file-history-snapshot…`）。

**读取窗口**：列表 enrich 只读头尾各 64KB（`LITE_READ_BUF_SIZE`）；这就是 reAppend 存在的原因。**撕裂行容错**：读取端跳过前导 NUL 字节（`mU()/eVt()`，逆向确认）——外部写端不要产生 NUL。

---

## 3. resume 链重建权威算法（读端必须对齐的语义）

`loadTranscriptFile`（`sessionStorage.ts:3472-3813`）+ 三个修复 pass + leaf 回溯：

1. **预扫描跳过**（>5MB）：`readTranscriptForLoad` 字节级定位 `"compact_boundary"`；无 `preservedSegment` 的 boundary **直接丢弃其之前全部字节**；有则不截断只标记。随后 `scanPreBoundaryMetadata` 从被丢弃区间回捞 9 种元数据行（summary/custom-title/tag/agent-name/agent-color/agent-setting/mode/worktree-state/pr-link）。
2. `walkChainBeforeParse`：>5MB 再按 `{"parentUuid":` 行前缀 + uuid 索引预剪死分叉（rewind 孤枝）。
3. `applyPreservedSegmentRelinks`：保留段有**两种表达**（2.1.251 读取端优先级已逆向确认）——优先 `compactMetadata.preservedMessages`（**显式 uuid 列表** `{anchorUuid, uuids, allUuids}`，直接按列表收集保留段 + 各自的 tool_result 子消息），回退老式 `preservedSegment`（`{headUuid, anchorUuid, tailUuid}` 区间描述符，从 tailUuid 沿 parentUuid 走到 headUuid 收集）；两者可同时出现在同一 boundary（实测如此）。重连规则：`head.parentUuid = anchorUuid`（anchor=boundary 或最后 summary）；锚点其他子改指 tail；**保留段 assistant 的 usage 全部清零**（防 resume 后 autocompact 死循环）；删除"绝对最后 boundary 之前"的非保留消息。远程持久化路径（CCR）也用 `preservedMessages.uuids` 作为 `preservedEventIds`。
4. `applySnipRemovals`：按 boundary 的 `snipMetadata.removedUuids` 删除中段并 relink（feature-gated，旧 boundary 无此字段则跳过）。
5. **leaf 计算**：终端消息（无子）沿 parentUuid 回溯到最近 user/assistant 祖先 → leafUuids。resume 取最新 leaf（`/insights` 用 `keepAllLeaves` 全 leaf）。
6. `buildConversationChain`：leaf→root 回溯（环检测）+ **`recoverOrphanedParallelToolResults`**：流式产出把 N 个并行 tool_use 拆成 N 条 assistant（同 `message.id`），各 tool_result 挂各自 assistant → 单链回溯只留一支；修复 pass 按同 `message.id` 兄弟组 + `toolResultsByAsst(parentUuid)` 索引把掉队的兄弟块与 tool_result 按时间序插回锚点之后。**适配器读端必须实现等价合并，否则并行工具调用会丢结果。**
7. 列表过滤：`isSidechain:true` 首行 / `teamName` 非空 → 不进 /resume。

**回放进 API**（`normalizeMessagesForAPI`，`messages.ts`）：剔除 progress、system（**local_command 例外，转 user 文本**）、synthetic API error、`isVirtual`；attachment 冒泡重排；user/assistant 保留（**isMeta 的 user 消息保留**——`<system-reminder>`/caveat 是模型上下文的一部分）；连续 user 合并（Bedrock 兼容）；tool_reference 按工具可用性剥离。

---

## 4. compaction 全链（落盘序列 + resume 重建）

**最小充分落盘序列**（手动/自动全量 compact）：

1. `system/compact_boundary` 行：`parentUuid=null`（截断）+ `logicalParentUuid=<压缩前链尾>` + `compactMetadata`。2.1.251 实测还带 `postTokens / cumulativeDroppedTokens / durationMs / preCompactDiscoveredTools / preservedSegment{headUuid,anchorUuid,tailUuid} / preservedMessages{anchorUuid,uuids,allUuids}`（后两组为新增）。
2. `user` 行 + **`isCompactSummary:true`** + `isVisibleInTranscriptOnly:true`，content 为摘要全文（模板含 "This session is being continued from a previous conversation…" 与 transcriptPath 引用），正常接在 boundary 的 parentUuid 上。
3. （partial/session-memory compact）`messagesToKeep` 原行不重写（uuid 已在盘上被去重跳过），靠 boundary 的 `preservedSegment` 元数据在 resume 时拼回摘要之后（§3 第 3 步）。
4. （ant）post-compact attachment（file 恢复 ≤5 个/50K token、plan_file_reference、invoked_skills 等）；external 不落盘。
5. `reAppendSessionMetadata()` 把元数据行重写到文件尾。

**`type:'summary'` 行是遗留格式**，现行 compact 路径一律不写（全仓 grep 无写入点）；读取端兼容。适配器**读**要兼容它，**写**不要产出它。

**IR 映射建议**（对齐 zcode 适配器已落地的 compaction 模式）：`isCompactSummary` user 消息 = 投影进 `messages[]` 的摘要载体（`compaction[].anchorIndex` 指向它）；boundary 的 `compactMetadata` 整体进该消息 `meta.claude.compactMetadata`；`logicalParentUuid`/`preservedSegment` 原样进 meta（claude→claude 写回时用 raw 行还原，见 §8）。

---

## 5. 系统提示词与上下文注入（双端策略的依据）

### 5.1 构建（老源码 `systemPrompt.ts:41-123` 权威）

`buildEffectiveSystemPrompt` 优先级（互斥替换，除 append）：

```
0. overrideSystemPrompt（loop 模式，REPLACE 一切）
1. coordinator（CLAUDE_CODE_COORDINATOR_MODE）
2. mainThreadAgentDefinition（--agent / settings.agent）——REPLACE default（proactive 模式例外：追加）
3. customSystemPrompt（--system-prompt / --system-prompt-file）
4. defaultSystemPrompt（内置提示词 + output style）
+ appendSystemPrompt（--append-system-prompt / --append-system-prompt-file）恒追加末尾（override 时除外）
```

新版二进制确认两组 flag 与 `--system-prompt-file` / `--append-system-prompt-file`（file 变体互斥校验）都在。每次 API 请求：`fullSystemPrompt = systemPrompt ++ appendSystemContext(systemPrompt, systemContext)`——`systemContext` = gitStatus（+可选 cacheBreaker），**拼成 system prompt 的最后一个块**（`utils/api.ts:437`）。

### 5.2 user 上下文注入（CLAUDE.md 等）

`getUserContext()` = 全部 CLAUDE.md 内容 + `currentDate`。注入方式：`prependUserContext` 在**每次 query 发送时**构造一条 `<system-reminder>…</system-reminder>` **user 消息（isMeta:true）插到消息数组最前**（`utils/api.ts:449-465`）。这条消息**不落盘**（query 时的内存注入，非 transcript 记录）；落盘的 CLAUDE.md 内容只出现在 `nested_memory` attachment（ant 门控）。

### 5.3 持久化结论（回答"系统提示词在哪"）

**transcript JSONL 完全不含系统提示词**——没有 systemPrompt/system prompt 相关字段（27429 行实测 + 老源码 + 二进制三重确认）。resume/`--continue` 时：系统提示词 = **当前二进制的 default prompt（含当前 output style）+ 用户当次 flag（--system-prompt/--agent/--append-system-prompt）+ 当时重算的 gitStatus/CLAUDE.md**。旧会话里"当时的提示词"任何组件都不持久化。

> **round-trip 实证**（§12 的 mock 捕获）：resume 一个伪造会话时捕获到的请求体里，`system` 数组 = 3 个全新组装的块（billing header / agent 身份 / 29K default prompt），`messages[0]` 是当次新注入的 `<system-reminder># currentDate…` userContext——磁盘上的记录原样跟在后面。系统提示词与 CLAUDE.md 上下文**每次请求重新生成**是直接可观测的行为。

### 5.4 对迁移引擎"选带哪方系统提示词"功能的明确文档化

- **Claude 作为源**：`IR.systemPrompt` 无原生来源，**必须留空**。可把 `version`/`agentSetting`/`outputStyle` 线索放进 `meta.claude` 供展示，但不要伪造提示词正文。
- **Claude 作为目标**：适配器**忽略 `IR.systemPrompt`**（jsonl 无注入通道；写了也不被读）。用户想带源方提示词时，唯一正道 = 引擎在**启动 claude 进程时**传 `--append-system-prompt <源提示词>`（进程参数层面，不属于会话文件格式）；DSH→Claude 线应在 CLI/插件层支持该透传。
- **双层提示词风险（写入协议文档）**：源方提示词若同时被写入目标会话正文（如 DSH 的 `agentPreset`/header 提示词、ZCode 的 profileSnapshot.systemPrompt），目标 agent 再叠加自己的 default prompt，会出现**两套系统提示词叠加**——重复规范、冲突人格、token 浪费，实测会劣化 agent 表现。规则：`IR.systemPrompt` 只允许注入"目标端无系统提示词通道"的场景；有通道的目标端（Claude flag / DSH header / ZCode profile）走目标端原生槽位，二选一，不叠加。此约束需在 `docs/ir-protocol.md` 登记（§8）。

---

## 6. 删除与安全策略（硬约束，适配器红线）

1. **引擎/适配器永远不执行删除**：不 unlink 会话文件、不清理"目标目录已存在文件"、不做 tombstone（Claude 自己的 `removeMessageByUuid` 是其内部机制，迁移工具不得模仿）。删除界面只能由人操作。
2. **只新增**：写入一律 `新 sessionId（crypto.randomUUID）→ 新 jsonl`；目标已存在同 id 文件时——调用方显式指定 id 则拒绝并报告，自动生成 id 则换号重写，绝不覆盖不追加；写文件用 `wx` flag 兜底（文件系统级防覆盖）。行级 uuid 随 claude→claude 字节级还原保留原值，取舍详见 §13。
3. **禁止 append-to-existing**：Claude 主文件有 uuid 去重 + phantom-parent + last-prompt 状态机，向"活着"的会话文件追加会触发其内部一致性逻辑；迁移产出的文件必须是"已结束"形态（尾部 last-prompt）。
4. `--dst-root` dry-run 优先，用户确认后才写真实 `~/.claude/projects/`。
5. 读端对损坏行容错（真实读取端 `parseJSONL` 跳坏行、容忍 NUL 前缀、容忍截断尾行）；写端产出的必须是完整合法行（\n 结尾、UTF-8、无 NUL）。

---

## 7. 新旧版本 DELTA 表（老源码 claude-code-main ↔ 2.1.251 实测/逆向）

| 项 | 老源码 | 2.1.251 | 适配器影响 |
|---|---|---|---|
| `last-prompt.leafUuid` | 无（reAppend 写 `{lastPrompt,sessionId}`） | **复活**，且读取端消费；另有 `explicit`/`rewound` 变体 | 写端带上 leafUuid（指向末条 user/assistant leaf）更接近原生 |
| `ai-title` reAppend | 不 reAppend | reAppend | 写端可选 |
| `permission-mode` 行 | 无 | 有（1173 条实测） | 写端建议按目标 permission 模式写一行 |
| `mode` 行 | 有 | 有 | 同上 |
| `sessionKind` stamp | 无 | 每条消息 stamp | 读端保留进 meta；写端可省 |
| `session_id`（snake） | 无 | 与 sessionId 双写 | 读端保留；写端可双写以贴近新版形状 |
| `effort`/`requestId` | effort 无 | 有 | 读端保留 |
| `tool_use.caller` | 无 | 有（1761 条） | 读端保留 |
| `toolUseResult` 直写 | 直写 | **写盘前过滤（FHe）** | 读端保留结构化原文 |
| `origin`/`promptSource` | 无 | 有 | 读端保留（synthetic 推导依据） |
| `cost-state` / `atis-latch` / `isolation-latch` / `relocated` / `frame-link` / `history-suppression` / `bridge-session` / `file-history-delta` / `observer-ref` / `fork-context-ref` / `marble-origami-reset` / `artifact-*` | 无 | 有 | 读端进原样桶；写端不产出（可选） |
| `speculation-accept` | 有类型 | **移除** | 忽略 |
| compact boundary 元数据 | `{trigger,preTokens,userContext?,messagesSummarized?}` | + `postTokens/cumulativeDroppedTokens/durationMs/preCompactDiscoveredTools/preservedSegment/preservedMessages` | 读端整体进 meta |
| `subagents/workflows/<runId>/` | 无 subdir 机制 | 有 | 旁链发现要递归 |
| `agent-*.meta.json` | `{agentType, worktreePath?, description?}` | + `toolUseId, spawnDepth` | 旁链侧车照搬 |
| storage v5 | — | `storageV5` env-pin 可选后端 | 经典 jsonl 仍是默认与权威，无需理会 |
| `sessions-index.json` | — | 不存在（0 命中） | 沿用目录扫描 |
| 并行 tool_result 修复 | 已有（recoverOrphaned…） | 同 | 读端必须实现 |

> 审计文档修正：`docs/session-formats-audit.md` §3 的"**末尾必有 last-prompt，无 leafUuid，勿按旧 shape 写**"应更正为"**last-prompt 可带 leafUuid（新版读取端消费），lastPrompt ≤200 为展示字段；写端带 leafUuid 更接近 2.1.251 原生**"。

---

## 8. IR 缺口清单（按 `docs/ir-protocol.md` 共识，扩展需三同步：validateSession + 一适配器读写 + 文档登记）

| # | 缺口 | 建议槽位 | 影响适配器 |
|---|---|---|---|
| 1 | 结构化工具结果原文（`toolUseResult`：stdout/stderr/isImage… 或字符串）只存在于 tool_result 块旁，IR 的 `tool_result` 只有 `content:string` | `ContentBlock.tool_result.rawResult?: unknown`（挂在块实体上，符合"归属实体"共识；zcode 可映射 `output` 对象） | claude 读+写；zcode 可跟进 |
| 2 | assistant API 消息级字段：`message.id`、`requestId`、`usage`、`stop_details`、`provider`、`context_management` 等 | `MigratedMessage.meta.claude`（既有 meta 机制，无需新桶）+ `MigratedMessage.provider/model/stopReason` 已有槽位填上 | claude |
| 3 | `isMeta`（UI 隐藏但进模型上下文的 harness 注入）与 `origin.kind`/`promptSource` | `MigratedMessage.synthetic:true`（已有）映射 isMeta；`origin/promptSource` 进 meta.claude | claude；与 dsh `source.kind` 语义对齐 |
| 4 | system 记录（8+ subtype；local_command 参与回放） | local_command → 投影 user text + `synthetic:true` + `meta.claude.systemSubtype:'local_command'`（写回还原 system 行）；其余 subtype → `unmappedEvents` 式新桶 **`sessionEvents?: MigratedUnmappedEvent[]`**（泛化 DSH 桶，承载"非对话的会话级行"） | claude 先行；其他工具的同类行（元数据行）可复用 |
| 5 | attachment 21+ 种（模型上下文的一部分） | 有块投影的（file→FileBlock、edited_text_file/nested_memory/invoked_skills/skill_listing→text 块 + meta）+ 全部原样进 `meta.claude.attachment`；**不要新建 union**，原样保真由 raw 层兜底 | claude |
| 6 | B/C 类元数据行（last-prompt/custom-title/ai-title/tag/mode/permission-mode/pr-link/worktree-state/cost-state/…） | 高频有语义的提为 `MigratedSession` 可选字段：`title`（customTitle 优先，aiTitle 兜底）、`tag?`、`permissionMode?`、`prLink?`、`worktreeSession?`、`costState?`；其余进 **`extensions.claude.recordsRaw`**（ir-v3 计划预留位） | claude |
| 7 | parentUuid DAG / rewind 死枝 / preservedSegment 拼接（分支结构信息） | 活跃链投影进 messages；**全文件原始行进 `extensions.claude.recordsRaw`**——claude→claude 写回要字节级还原分支必须靠它；跨工具迁移只投影活跃链（诚实边界） | claude |
| 8 | `IR.systemPrompt` 的语义与"不叠加"规则 | ir-protocol.md 登记：源无原生提示词留空；目标有原生通道走原生（Claude=进程 flag），没有才注入 IR 值；绝不双重注入 | 全体适配器 |
| 9 | compaction boundary 细节（compactMetadata/preservedSegment） | boundary 消息投影（anchorIndex 模式）+ 细节进 `meta.claude.compactMetadata`（桶的 tokensBefore 可从 preTokens 填） | claude；对齐 zcode |
| 10 | legacy `type:'summary'` 行 | 读入 `compaction[]`（leafUuid 关联摘要）；写端不产出 | claude |

---

## 9. 现有 `adapters/claude/index.ts` + `path.ts` 的具体问题（重写清单）

1. **`path.ts` 缺 200 截断 + hash 后缀**（§1）——长 cwd 写错目录。
2. **读端线性化丢 DAG**：只按文件序 push user/assistant，未实现 `sourceToolAssistantUUID` 父挂接与并行兄弟恢复 → 同 assistant 多 tool_use 的会话会丢 tool_result（§3.6）。
3. **丢 system/attachment/全部 B/C 类行** → 大量非加密信息无法进 IR（§2.3/2.4/2.5）。
4. `recordToMessage` 丢 `toolUseResult`/`sourceToolAssistantUUID`/`isMeta`/`message.id`/`usage` 等；user/assistant 之外的 role 处理缺失。
5. **写端形状不原生**：所有 tool_result 塞进一条 user 记录的 content 数组（原生是每个 tool_use 独立 assistant 记录 + 独立 user tool_result 记录、parentUuid 挂 sourceToolAssistantUUID）；`last-prompt` 多写了 `cwd` 字段（无害但不忠实）；`last-prompt` 应带 `leafUuid`。
6. `listSessions` 未用 `validateUuid` 过滤、未读首行区分 isSidechain/teammate（会把旁链误列为主会话——当前实现只扫 `<proj>/*.jsonl` 文件名恰好避开子目录，但对**同目录旁链文件**（老版本布局 `isSidechain:true` 且与主链同目录）没有过滤）。

---

## 10. 开放问题（2026-08-29 二轮补查后剩余）

- `isolation-latch.side` 的值域：确认了它是 one-shot 闩（`onLatch` 回调触发一次后解绑）并与 rewind/restore 同族，但压缩代码里未能锁定 `side` 的取值集合；对迁移无影响（原样搬运）。
- attachment 60+ 种中**未在本机数据出现过的类型**（pdf_reference/directory/selected_lines_in_ide/teammate_mailbox/task_status 等）只有老源码 union 的字段级定义（`attachments.ts:295-737` 已全文核录），没有实测样本；适配器遇到时以源码 union 为准即可。
- teammate 侧 `teammate_shutdown_batch` / swarm 权限桥（leaderPermissionBridge）等协作细节未深挖（不影响会话文件格式）。
- external 用户 attachment 不落盘：跨工具迁移（zcode→claude）会写出的 attachment 形状在 external 端"异常丰富"——合法（读取端逐行解析，多余行不报错），但与原生 external 文件统计形状不同。
- `storageV5` 后端细节（env-pin 可选，经典 jsonl 为权威；若未来默认切换需重查）。

> 已解决（二轮补查）：`atis-latch`=ATIS 请求头闩、`preservedMessages`=优先于 preservedSegment 的显式 uuid 列表、`listSessionsImpl` 元数据提取规则、worktree 前缀匹配精度、subagent/teammate 恢复链路（§11）、round-trip 双向验证（§12）。

---

## 11. subagent / teammate 会话的恢复（深挖补充——两者都是迁移对象）

> 旁链（subagent/teammate）不是附属品：`getAgentTranscript` + `resumeAgent.ts` 构成与主会话同级的恢复链路，`--resume` 之外还有 Agent 工具的 resume。迁移必须完整搬运。

### 11.1 旁链文件与侧车

- 路径：`<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl`（workflow 分组：`subagents/workflows/<runId>/agent-*.jsonl`，`agentTranscriptSubdirs` map 注册）。
- 每条记录：主链同形 + `isSidechain:true` + `agentId`（`appendEntry` 按这两个字段路由到旁链文件，`sessionStorage.ts:1224-1228`）。**旁链写旁路 uuid 去重**（fork seed 与父会话共享 uuid 的场景依赖此旁路）。
- 侧车 `agent-<agentId>.meta.json`：老版 `{agentType, worktreePath?, description?}`，2.1.251 实测新增 **`toolUseId`、`spawnDepth`**。`agentType` 是恢复路由的关键——缺了会静默降级 general-purpose（丢 agent 专属系统提示词与工具池）。
- `agentId` 命名规则（实测）：AgentTool/普通子代理 = 纯随机 hex（如 `a8feed524f42025e4`）；**in-process teammate = `a<名字sanitized>-<随机hex>`**（如 `aD2-queue-head-fix-a221c8a287cf36cb`、`arecon-chat-69d1ca5df1cdc8e5`），**每个 teammate turn 换一个随机 agentId**——同一 teammate 的记录可能散落在多个旁链文件（`extractTeammateTranscriptsFromTasks` 注释明说磁盘不如 AppState 可靠）。

### 11.2 subagent resume 权威流程（`tools/AgentTool/resumeAgent.ts`）

1. `getAgentTranscript(agentId)`（`sessionStorage.ts:4190`）：loadTranscriptFile 读旁链文件 → 过滤 `msg.agentId === agentId && msg.isSidechain` → 最近 leaf → buildConversationChain → 剥 `isSidechain/parentUuid`。
2. resume 前三重过滤：`filterUnresolvedToolUses`（无 result 的 tool_use 剔除——中断的调用不回放）、`filterOrphanedThinkingOnlyMessages`（孤儿 thinking 剔除）、`filterWhitespaceOnlyAssistantMessages`。
3. `reconstructForSubagentResume`：按旁链的 `content-replacement` 记录逐字节重放替换（prompt cache 稳定）。
4. `readAgentMetadata` 路由 agent 定义；`worktreePath` 存在则 chdir 回 worktree（不存在则回退父 cwd 并 bump mtime 防误清理）。
5. fork 型旁链特殊：复用父会话的 rendered system prompt（cache-identical prefix），非 fork 在新 cwd 下重算。

### 11.3 teammate（swarm）两种形态

| | in-process teammate | tmux/process teammate |
|---|---|---|
| 运行方式 | 同进程 AsyncLocalStorage 隔离（`teammateContext.ts`） | 独立 claude 进程（`--teammate-mode` 等旗标 + `CLAUDE_CODE_AGENT_ID` 等环境变量传播身份，`teammate.ts:44-67` dynamicTeamContext） |
| 身份 | `{agentId, agentName, teamName, color, parentSessionId, planModeRequired}` | 同左，经 CLI 参数/环境变量 |
| 自己的 transcript | 经 `recordSidechainTranscript` 写旁链文件，但**每 turn 随机 agentId** → 碎片化；AppState `task.messages` 才是完整视图 | **就是一个正常主会话 jsonl**（isSidechain:false），但每条记录带 `teamName` + `agentName` stamp；`/resume` 列表按 head 中的 teamName 过滤掉 |
| 与 leader 的消息通道 | 文件信箱：`~/.claude/teams/<team>/inboxes/<agentName>.json`（`teammateMailbox.ts:54`，带 `.lock` 文件） | 同左 |
| 进入 leader 上下文的形态 | `formatAsTeammateMessage`（`inProcessRunner.ts:454`）：`<teammate-message teammate_id="名字" color=".." summary="..">\n正文\n</teammate-message>` 作为 user 消息注入并**随 leader transcript 落盘**（实测 36 个文件含此 XML） | 同左（tmux teammate 同格式） |

- 团队注册表：`~/.claude/teams/<teamName>/config.json` = `{name, description, createdAt, leadAgentId, leadSessionId, members:[{agentId:"名字@team", name, agentType, model, joinedAt, tmuxPaneId, cwd, subscriptions}]}`（本机 20+ 个团队实测；另有 `session-*` 自动团队）。
- **迁移含义**：① leader 侧的 `<teammate-message>` XML 记录是**主链的一部分**（模型上下文），现有适配器的 teammate 正则提取作为"旁链镜像"是补充视图，主链记录本身必须保留；② in-process teammate 的旁链文件按 `agentId` 前缀 `a<name>-` 可聚合同一 teammate 的碎片（写回时按名聚合或逐文件保留均可，恢复读取端只按 agentId 精确匹配）；③ process teammate 的主会话文件带 teamName stamp，`listSessions` 要能列出它们（现在按"首行 isSidechain"过滤会漏掉——它们 isSidechain:false，只是 enrichLog 里被 teamName 过滤），迁移工具应视为独立会话可选迁移。

---

## 12. round-trip 双向验证记录（2026-08-29，mock API 捕获法）

**方法**：伪造 6 条记录的会话（user→assistant→isMeta user→assistant + ai-title/mode 头 + last-prompt 尾，uuid 链手工构造）写入临时 `CLAUDE_CONFIG_DIR`（不触碰真实 `~/.claude`）→ 本地 mock Anthropic API（127.0.0.1:8399，记录请求体并返回最小合法响应）→ `claude --resume <id> -p "…" --max-turns 2` 真机 2.1.251 运行。网关 503 时 mock 兜底，与真实网关行为无关。脚本：`.tmp-claude-audit/rt-write.cjs` / `mock-server.cjs`，捕获：`rt-captured-requests.jsonl`。

**读侧验证（捕获的请求体）**：
1. 4 条伪造 transcript 记录**全部按序回放**进 `messages`，parentUuid 链重建正确；
2. **isMeta 的 `<system-reminder>` 记录回放为模型可见 user 消息**（证实 §2.2：isMeta = UI 隐藏但进上下文）；
3. `messages[0]` 是当次新注入的 `<system-reminder># currentDate…` userContext（证实 §5.2：不落盘、每次请求重注入）；
4. `system` = 3 块全新组装（billing header / agent 身份 / 29K default prompt）（证实 §5.3：transcript 无系统提示词）；
5. 伪造的 `ai-title`/`mode` 被读取（运行后 reAppend 到文件尾）。

**写侧验证（会话文件 6 → 81 条）**：claude 自己的每次运行都向伪造会话**原生地追加**：新 user 消息（parentUuid 正确接前 leaf）+ assistant 回复 + attachment（deferred_tools_delta/skill_listing/task_reminder/total_tokens_reminder…）+ queue-operation(enqueue/dequeue) + `Continue from where you left off`（isMeta）+ 失败重试的 API Error assistant（`model:'<synthetic>'`）+ 每轮末尾重写 last-prompt（lastPrompt=最新提问、leafUuid=最新 assistant）+ 退出时 atis-latch/ai-title/mode reAppend。**结论：伪造会话与原生会话在读写两端行为完全一致；§2.7 最小可 resume 集合经真机验证成立。**

**验证附带产物**：一份完整的"503 重试落盘"真实样本（错误恢复的记录序列），以及 dequeue 操作值、`Continue from where you left off` isMeta 续跑注入等细节确认。

---

## 13. 写端策略：claude→claude 字节级还原 + 行 uuid 取舍（2026-08-30）

**决策**：`originTool==='claude'` 且 `extensions.claude.recordsRaw` 非空时，写端**不做投影重写**，把 recordsRaw（= 全文件原始行，§8#7）逐行回写，仅重盖行内会话身份字段（`sessionId`/`session_id` → 新 id）。跨工具迁移（zcode→claude 等，无 claude recordsRaw）仍走投影路径（活跃链 + native 盖章 + keepSynthetic 门控）。真机验证（9c958067，6778 行 / 5 次压缩 / 1864 attachment / 6 旁链）：行数 1:1、uuid 行全部 verbatim 存活、`parse(write(x)) ≡ parse(x)`、0 伪造时间戳。

**为什么"投影重写 + 折叠行 ride-back"不可行**（实测翻车记录，2026-08-30）：该方案使输出文件出现两条平行谱系，而读端 `applyPreservedSegmentRelinks` 的收尾剪枝语义是「map 序最后一个 boundary 之前的全部非 preserved 行删除」——ride 回来的旧 boundary（文件后部）触发剪枝，把新链整条剪没（9c958067 re-parse 得 0 消息）。该机制假设文件只有一条谱系，这是原生文件的不变式，迁移文件必须遵守。

**行 uuid 保留原值的取舍**（红线 §6.2「全新 sessionId/uuid」按**文件级身份**解读：全新 sessionId + 全新文件名 + 逐行 sessionId 重盖 + 存在即拒绝 + `wx` 原子写；行级 uuid 是 DAG 节点 id，随字节还原保留）：

保留原 uuid 的收益：
1. 文件内 7+ 类交叉引用天然自洽——`parentUuid` / `sourceToolAssistantUUID` / `last-prompt.leafUuid` / boundary `logicalParentUuid` / `compactMetadata.preservedSegment`+`preservedMessages` / `snipMetadata.removedUuids` / legacy `summary.leafUuid`。全量 rekey 漏映射任何一类的后果**不是报错而是静默丢上下文**（悬挂引用触发读端剪枝或 native no-op，surface 上只是"会话变空/变短"）。
2. `diff 迁移文件 源文件` 仅 sessionId 字段差异 → 无损可审计（rekey 后失去此验证手段）。
3. `--resume` 行为与源会话逐字节等价（§12 真机验证的等价性直接继承）。

代价（实测影响≈0）：
1. 同一源会话迁移两次 → 两文件行 uuid 相同。`loadTranscriptFile` 按文件独立索引 uuid，无跨文件 uuid 机制（2.1.251 核实），功能零影响；仅影响人类 diff/去重。
2. 行 uuid 构成源会话指纹——但会话内容本身是更强指纹，rekey 无实质匿名收益。
3. 同机同 projects root 迁移时 /resume 列表出现两个内容相同的会话（不同 sessionId）——人类困惑，claude 不出错。

**何时需要 rekey**：出现跨文件全局 uuid 索引机制、或需将会话作为全新身份分发时，在写端加一致性 rekey（`uuid` + `parentUuid` + `sourceToolAssistantUUID` + `leafUuid` + `logicalParentUuid` + `preservedSegment.headUuid/tailUuid/anchorUuid` + `preservedMessages.uuids` + `removedUuids` + `summary.leafUuid` 全量映射）；rekey 是纯写端增量，可与字节还原并存。

**残余边界**：sidechain 文件无 recordsRaw 槽位（`MigratedSidechain` 未含），旁链仍走投影回写（死枝不回写）；sidecar `.meta.json` 合并原 `agentMeta` 回写。

---

## 附：调查工件

- 字段全量枚举脚本：`.tmp-claude-audit/enumerate.ts`（63 文件 / 27429 行 / 0 坏行）
- 记录采样脚本：`.tmp-claude-audit/sample2.mjs` / `filter-type.mjs` / `attach-sample.mjs` / `ismeta-sample.mjs` / `redacted2.mjs` / `teammate-check.mjs`
- 新版二进制 bundle 整体抽取：`.tmp-claude-audit/extract-bundle.cjs` → `bundle-0..23.txt`（minified JS ~12.5MB；bundle-0 = session storage 模块）；定向上下文抽取 `extract-context.cjs`
- **round-trip 验证**：`rt-write.cjs`（伪造会话生成）+ `mock-server.cjs`（本地 mock Anthropic API，捕获请求体）+ `rt-captured-requests.jsonl`（捕获记录，§12 的证据）
- 关键源码锚点索引：`sessionStorage.ts`（getProjectDir:436 / insertMessageChain:993 / appendEntry:1128 / loadTranscriptFile:3472 / buildConversationChain:2069 / recoverOrphanedParallelToolResults:2118 / applyPreservedSegmentRelinks:1839 / applySnipRemovals:1982 / reAppendSessionMetadata:721 / isLoggableMessage:4351 / enrichLog:5023 / getAgentTranscript:4190 / sanitizePath→sessionStoragePortable.ts:311 / MAX_SANITIZED_LENGTH:293 / listSessionsImpl.ts:79 parseSessionInfoFromLite / attachments.ts:295-737 attachment union / resumeAgent.ts / teammate.ts / teammateMailbox.ts:54 / swarm/inProcessRunner.ts:454 formatAsTeammateMessage）
