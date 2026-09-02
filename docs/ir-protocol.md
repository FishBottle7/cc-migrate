# IR 协议 — 设计共识与演进规则

> 适用范围：`packages/core/src/ir.ts` 与全部 `packages/core/src/adapters/*`
> 确立时间：2026-08-29（zcode 适配器接入后确立，见 `docs/agents/zcode.md` 与 commit `0d61eae`）

## 设计共识

1. **IR 是可修改的活协议，不是一次定稿的接口。** 所有 N 个工具互转都经 IR 枢纽（N 个适配器，不存在两两直转），IR 的形状直接决定迁移的保真上限。遇到新工具的新概念时，改 IR 是正当手段。
2. **目的是完整保全所有信息（加密内容除外）。** 源存储里存在、而 IR 没有槽位的信息，不允许静默丢弃，也不允许永远寄居在非类型化的 extensions 字符串里——extensions 是过渡方案，不是归宿。
3. **不允许"不好分清"的信息存在。** 任何信息必须能无歧义地归属到它描述的实体（会话 / 消息 / 块 / 单次工具调用），且关联方式必须跟随实体本身（挂在实体字段上），而不是靠源存储 id 的旁路映射表约定——旁路表在消息被过滤、重排、跨工具转换后即失联。
4. **扩展模式：typed bucket / 可选字段。** 新概念优先加类型化桶（参照 `goals` / `planModes` / `todos` / `toolCalls` 的既有模式）或实体上的可选字段；必须向后兼容——旧适配器不认识新桶时忽略即可，`validateSession` 同步校验。
5. **每次扩展四件事同步落地**：validateSession 校验、**全部写端**按需补分支（v3.1 教训：只要求"至少一个适配器"会让其余写端静默腐烂）、`IR_VERSION` bump + 各适配器 `irVersion` 同步（registry 硬闸门强制，见「IR 版本与同步闸门」）、本文档登记。
6. **允许填空，但只在目标端写侧。** 源框架未记录的字段在 IR 里保持缺失（缺失 = 源端缺失 = 无损，禁止用猜测值污染 IR）；目标端为展示/回放所需，可按下方《填空（合成值）政策》合成可推导的近似值。

## 填空（合成值）政策

> 2026-08-30 确立，回答"源 agent 框架没记录某字段怎么办"。先例：opencode 写端用 chars/200 合成 thinking 时长以显示头部 `Thought · Ns`（commit `1b9f146`）——源端没记录时长、目标端展示需要，合成是正当的。

**两层分开判：**

| 层 | 政策 |
|----|------|
| IR 层（交换格式） | **禁止填空。** 源端没记录 → IR 保持缺失。IR 缺失 = 源端缺失 = 无损；填入猜测值会让消费端无法区分"源端真没有"和"适配器编的"，且猜测值会随轮转被当成真数据继续扩散 |
| 目标端写侧（投影层） | **允许填空。** 目标工具需要某字段才能正确展示/回放、而 IR 没有时，可合成 |

**写侧合成三规则：**

1. **可推导**——只能从同会话/同记录内的真实数据推导（字符数 ÷ 200 估时长、相邻时间戳插值、由块类型推默认媒体类型）；禁止凭空发明。
2. **不冒充**——合成值只存在于目标端原生存储里，不回写 IR；IR→源端 round-trip 的无损断言必须排除合成值，否则"无损"被合成值污染。
3. **语义字段宁缺勿错**——影响回放语义的字段缺失就缺失，绝不猜：`synthetic`/注入标记（claude `isMeta`、dsh `source.kind`）、关联指针（claude `parentUuid`/`sourceToolAssistantUUID`、IR `toolUseId` 关联）、thinking `signature`。猜错会改变回放行为，比缺失严重一个量级。

**边界澄清：**

- 加密内容（claude `redacted_thinking.data`）不是"没记录"，是"不可迁移"——单独归类（允许丢弃的唯一类别），不适用本政策。
- 目标端本来就要新生成的值（新 sessionId、迁移时刻的时间戳）是"生成"，不是填空，不受本政策约束。

## 已落地的 typed buckets

| 桶 | 载体 | 语义 | 产出/消费 |
|----|------|------|-----------|
| `goals` / `planModes` / `todos` / `unmappedEvents` | MigratedSession | DSH 事件流的领域状态 | dsh 读写 |
| `toolCalls: MigratedToolCall[]` | MigratedSession + MigratedSidechain | 融合 call+result 的四态工具调用（pending/running/completed/error，含 input/output/error/title/metadata/time 与源位置） | zcode 读写；其他适配器忽略 |
| `ContentBlock.thinking.signature?` | thinking 块 | anthropic thinking 回传签名——挂在块实体上（原 zcode 寄存在 `messageExtras.signatures` 按 part 序号关联，已废除） | zcode 读+写；claude 读写（`normalizeContent` / `blocksToNative` / `claudeNativeBlock`）；其他适配器忽略 |
| `MigratedMessage.meta?: Record<string, unknown>` | 每条消息（适配器命名空间，如 `{ zcode: {...} }`） | 消息级原生载荷：semantics/cost/tokens/time/anchor/contextSnapshot/tools/metadata + **所有无块投影的 part 行原文**（step-start/step-finish/timeline/compaction 边界/snapshot/agent…）。挂在消息实体上，绝不使用源 id 旁表 | zcode 读写两端（写回原样还原）；其他适配器忽略 |
| `ContentBlock` + `FileBlock`（`type:'file'`） | 块词汇表 | 文件/图像附件（`mediaType`/`data` base64/`url` 引用）；`tool_result.attachments?: FileBlock[]` 承载结果内嵌图像。不再有 `'[image omitted]'` 拍平 | zcode（file part）、claude（image 块、tool_result 内容数组）读写；pi/其他写端降级为文本占位 |
| `compaction[].anchorIndex` | MigratedSession.compaction | 压缩摘要**同时投影为 messages[] 里的 user 消息**（`meta.zcode` 标记原生形状），桶条目用 `anchorIndex` 指向它——摘要文本随 messages 跨工具流动，结构化载荷（tokensBefore 等）留在桶里 | zcode 读+写回；**dsh 读+写回**（checkpoint 即摘要载体，`meta.dsh` 另带原生 surfaceOp/sourceEventSeqs） |
| `MigratedMessage.synthetic?: boolean` | 每条消息 | 源 harness **注入**（非人类输入）的消息：DSH 把注入内容持久化为普通 user/message 事件，`source.kind` 区分人类与注入——**判据（08-30 修订）**：`kind === 'user'` 为人类；其余已知 kind 均为注入，`'plugin'`（system-prompt 快照 / schedule / plan-mode / user-approval / repeat-tool-reminder / tool-jobs…）、`'skill-catalog'`（`<available_skills>` 提醒）、`'skill-invocation'`（`<skill_content>` 块）、`'agent-instructions'`（AGENTS.md 注入）、`'goal'`（goal 续轮）、`'subagent-report'`/`'subagent-settled'`/`'coordinator'`（子代理/多代理转达）。**压缩摘要（plugin `compact`）是对话内容，唯一豁免**；未知 kind 与缺 source 保持非 synthetic（不丢无法分类的内容）。目标端默认丢弃，opt-in 保留时打惰性标记（OpenCode：text part `ignored: true`——时间线隐藏且 `toModelMessagesEffect` 重放跳过） | dsh 读（判定）+ opencode 写（消费）；其他适配器忽略 |

`toolCalls` 的契约要点：`messages[]` 只承载**可回放**投影（completed/error → `tool_use`+`tool_result`，以 callID 关联）；非可回放态（pending/running）只存在于桶中，由源 `source.messageSequence` 在写回时回填到对应消息，保证 zcode→zcode 对融合 tool-part 模型无损，且不会在任何目标工具里产生悬空 tool_use。

`meta` 的契约要点：键是适配器命名空间；写回端只消费自己命名空间的键，未知键忽略。rawParts 还原时排在投影块之后（模型可见回放只来自 text/reasoning/tool part，块序已保真；raw 序只影响引擎记账部分）。extensions 里的 `zcode.messageExtras` / `zcode.compactions` / `zcode.compactionSummaries` 已随 #1/#2/#3 落地**废除**。

## v3.3 登记（2026-09-01 pi 适配器重写前调查驱动；2026-09-02 ✅ **已随 pi 重写落地**——`IR_VERSION`=3.3，形状与理由详见 `docs/agents/pi.md` §8/§14）

> 落地状态：全部为可选字段/命名空间载荷，旧端读取忽略即可；dsh/claude/codex/zcode/opencode 写端行为不受影响（命名空间隔离），`irVersion` 已随闸门同步至 3.3。

| 槽位 | 类型 | 语义 | 读写端 |
|------|------|------|--------|
| `branchSummaries[]` 条目扩形 | `{fromId, summary, anchorIndex?, time?, meta?}` | pi `branch_summary` entry 全保真：`anchorIndex` 指向 messages[] 里的投影 user 消息（anchor 契约，同 compaction 模式）；`meta` 承原生残件（details/usage/fromHook/entryId/timestamp）。旧形状 `{fromId, summary}` 仍合法 | pi 读写两端；其余忽略 |
| `MigratedSession.meta.pi` | 会话级命名空间 | `header`（header 原文含 parentSession）、`settingsEvents`（model_change/thinking_level_change 全序列，写回按序重放）、`labels`（{targetId, label?, time}，含清除语义）、`customEntries`（{customType, data, time}）、`titleCleared`（session_info 显式清除） | pi 读写两端；其余忽略 |
| `MigratedMessage.meta.pi` 扩展 | 消息级命名空间 | `message`（assistant 无槽位字段：api/responseModel/responseId/deferred/errorMessage/rawStopReason/endTurn/diagnostics/usage 补全）、`bash`（bashExecution 全字段 + excludeFromContext）、`customMessage`（customType/display/details）、`anchor`（{kind:'compaction'\|'branch_summary', entryId}，标记桶投影消息）、`addedToolNames`/`usage`（toolResult 补全） | pi 读写两端；其余忽略 |
| pi `compaction[]` 消费 | 既有桶补全 | pi 写端开始消费 `compaction[]`（此前只 dsh/zcode/claude 消费）：桶 → 原生 compaction entry（summary/firstKeptEntryId/tokensBefore + meta 残件）；**anchor 消息跳过防双写**；v3 计划丢弃策略表「Pi 保留 branchSummaries/compaction」至此兑现 | pi 写端 |

**anchor 消息契约（pi 端具体化，通用规则延续 compaction[].anchorIndex 先例）**：pi 的 compaction/branch_summary 在原生 context 里是 user 消息（`convertToLlm` 加 prefix/suffix 渲染）。IR 双载体：messages[] 插渲染文本 user 消息（`synthetic:true` + `meta.pi.anchor`），桶条目 `anchorIndex` 指向它。写回 pi：桶→原生 entry（summary 字段存纯摘要，渲染是 pi 运行时行为），anchor 消息跳过。写往其他工具：只消费 anchor 消息（文本随 messages 流动）。

**pi 活跃面折叠选择（「压缩折叠坑」契约三选一的 pi 落点）**：选 3（完整归档）——IR messages[] 全量进 pi 文件，不伪造 compaction cut point。理由：pi 的 `firstKeptEntryId` 是 pi 运行时算出的 cut，迁移侧伪造会破坏摘要与保留段对应关系；代价是 pi resume 后上下文变大，属已知代价、语义诚实。

**pi 系统提示词契约（v3.2 #8 的 pi 端执行细则）**：pi 会话文件不存提示词正文（运行时由 `.pi/SYSTEM.md`→`~/.pi/agent/SYSTEM.md`（替换）/ `APPEND_SYSTEM.md`（追加）/ AGENTS.md 家族重建，`docs/agents/pi.md` §9 全链路）。读端 `ir.systemPrompt` 恒空；写端**恒不注入**（pi 无会话级原生槽位，写正文必双叠），源提示词的正确通道是用户在 pi 侧配置 SYSTEM.md/APPEND_SYSTEM.md——迁移工具只提示不代写。

## v3.2 登记（2026-08-30，claude 适配器重写驱动）

全部为可选字段，旧适配器忽略即可。登记范围 = `docs/agents/claude.md` §8 缺口 #6/#7/#8 的落地形状（`packages/core/src/ir.ts` 头注释 v3.2 节同步）。

| 槽位 | 类型 | 语义 | 读写端 |
|------|------|------|--------|
| `ContentBlock.tool_result.rawResult?: unknown` | 块实体 | claude `user.toolUseResult` 结构化工具结果原文（Bash `{stdout,stderr,interrupted,isImage,noOutputExpected}`、拒绝时字符串、各工具结构体）——模型可见 `tool_result.content` 之外的无损信息。**挂在块实体上，禁止按 toolUseId 旁表**；保持 `unknown` 原样透传（形状由各工具自定义，validateSession 不加强约束） | claude 读（`toolUseResult` → rawResult）+ 写（写前 sanitize：字符串/对象原样；禁止伪造）；zcode 可将融合 output 映射进来 |
| `MigratedSession.tag?` / `permissionMode?: string` | 会话 | claude `tag` / `permission-mode` 元数据行（B 类 last-wins） | claude 读写 |
| `MigratedSession.prLink?` | `{ prNumber, prUrl, prRepository, timestamp? }` | claude `pr-link` 元数据行 | claude 读写 |
| `MigratedSession.worktreeSession?: unknown` / `costState?: unknown` | 会话 | claude `worktree-state` / `cost-state` 行原样透传（opaque） | claude 读写 |
| `MigratedSession.sessionEvents?: MigratedUnmappedEvent[]`（alias `SessionEvent`） | 会话桶 | **非对话行桶（缺口 #7）**：claude system subtype 行（turn_duration / stop_hook_summary / model_refusal /…）原样存 `data`，`seq` = 源文件行号。**投影规则**：`local_command` 不进桶——投影为 user 文本 + `synthetic:true`（唯一参与回放的 subtype）；`compact_boundary` 走 compaction 桶（缺口 #3 形状）；其余全部入桶、写端直通重放 | claude 读 + 写端直通 |
| `MigratedSidechain.sessionEvents?` | 同上 | 旁链同款桶 | claude |
| `extensions.claude.recordsRaw?: unknown[]` | 保底 | **全文件原始行**（逐行 JSON 对象，含被 DAG 剪除的死枝/rewind 段/boundary 前折叠段）——字节级还原与跨工具投影之外的兜底（缺口 #7）。validateSession 守卫：`extensions` 出现时必须为对象；`extensions.claude` 必须为对象；`recordsRaw` 出现时必须为数组；`rawResult` 保持 `unknown`（toolUseResult 原样透传） | claude 读 + 写端不消费（防伪造） |
| `MigratedSession.systemPrompt` | 语义冻结（#8） | 源端无原生持久化提示词则**恒空**（claude transcript 不含系统提示词）；目标端有原生通道（claude = 进程 flag `--append-system-prompt`）走原生槽位，**写端显式忽略 IR 值**；禁止把源提示词写进会话正文再叠加目标端系统提示词（双叠劣化 agent 表现）。validateSession：出现时必须为 string，空串合法 | claude 写端 `void ir.systemPrompt`；全体适配器遵守 |

**claude 压缩语义补充（与通用 compaction 契约的差异）**：claude `compact_boundary.parentUuid=null` 截断父链——**活跃链只含 boundary 之后的行**，被折叠段不进 `messages[]`（`/resume` 原生行为即如此）；无损由 `extensions.claude.recordsRaw`（全文件原始行）兜底，preservedMessages/preservedSegment 保留段按 §3/§4 算法 relink 回活跃链。

## v3.1 登记（2026-08-29，codex 适配器开发前调查驱动）

全部为**可选字段**——旧适配器读到时忽略即可，不破坏任何现有读写；但**写端**需按约定消费。依据：codex-main 源码深查（2026-08 版，本机实测 cli 0.146.0），完整字段映射见 `docs/agents/codex.md`。改动明细另见 `packages/core/src/ir.ts` 头注释。

| 扩展 | 载体 | 语义 | 产出/消费 | 需同步的适配器 |
|------|------|------|-----------|----------------|
| `MessageRole` 新增 `'developer'` | 每条消息 | OpenAI Responses 的 developer 角色（codex `<permissions instructions>`、client-authored developer 消息、`developer_instructions` 配置）。与 `system` 不同：resume 回放按原角色还原。**写端降级规则**：codex 写回保留原样；claude/dsh 并入或降为 `system`；zcode/pi/opencode 降为 `user` 可见行；禁止降为 assistant（模型会当成自己的话） | codex 读写两端；其余写端补一个 role 分支 | **全部**（写端） |
| `MigratedSession.meta?: Record<string, unknown>` | 会话级 | `MigratedMessage.meta` 的会话级镜像：适配器命名空间原生会话载荷。codex 命名空间放 `session_meta` 行原生 payload（`source`/`thread_source`/`git`/`originator`/`cli_version`/`history_mode`/fork/parent 链/`agent_*`/`dynamic_tools`/`context_window` 等）+ `sessionIndex` 标题行；dsh 的 header 级信息应从 `extensions['dsh.headerRaw']` 迁入 `meta.dsh`（消除最后一处旁路） | codex 读写两端；dsh 迁移跟进 | **codex**（新）、**dsh**（待迁移）；其余忽略 |
| `compaction[].replacementHistory?: MigratedMessage[]` | compaction 桶 | codex `CompactedItem.replacement_history`：压缩后**取代此前全部历史**的完整保留史（与 messages[] 同构投影）。区别于 Pi 的 `retainedTail`（Pi 是自包含保留尾） | codex 读写两端；其他忽略 | **codex**（新）；其余忽略 |
| `compaction[].meta?: Record<string, unknown>` | compaction 桶 | 压缩记录实体上的原生载荷（codex：`window_number`/`first_window_id`/`previous_window_id`/`window_id`/`mcp_resource_origins`），不开源 id 旁表 | codex 读写两端 | **codex**（新）；zcode 可选跟进（边界行迁 `meta.zcode`） |
| `unmappedEvents` 语义泛化 | 事件日志桶 | 原注释限定 DSH，现泛化为**源 harness 事件日志**（codex `event_msg` 行等）：`seq`=源日志位置（无显式序号时取行号），`type`=源事件类型，`data`=原始载荷（去加密字段）。codex 写回从桶重放 resume 相关事件（turn 边界/rollback/settings） | dsh 不变 + codex 读 | **codex**（新）；dsh 无动作 |
| `SessionMeta.parentSessionId?/deferredCreation?` + `meta.codex.historyChain?/sourceDir?/sourceFile?` | 会话列表 + 会话级 meta | codex 会话拓扑与溯源三件套（2026-08-30 增补）：`parentSessionId`=子代理 thread_spawn 的父 thread（UI 树状嵌套用，`source.subagent.thread_spawn.parent_thread_id`）；`deferredCreation`=index 已登记但 rollout 文件不存在（无可迁移内容）；`sourceDir/sourceFile`=源 rollout 相对 CODEX_HOME 的文件夹/文件名；`historyChain[]`=paginated `history_base` 跨文件分叉的拼接链路（rolloutId/endOrdinalExclusive/endByteOffset/sourcePath），读端链式拼接、写端发自足单文件（去 history_base、ordinal 重编号） | codex 读写两端；UI 树消费 parentSessionId | **codex**（新）；其余忽略 |

**turn/事件级残条归属约定**（codex 特有，其他工具参考同型做法）：`turn_context`（每真实用户轮的 cwd/model/approval/sandbox/effort/personality 基线）与 `world_state`（全量/补丁快照）挂到该轮首条消息的 `meta.codex`（zcode 已有 contextSnapshot 挂消息 meta 的先例）；会话级基线随首条用户消息走。`event_msg` 整流进 `unmappedEvents`，不散挂。`ResponseItem` 级原生字段（id/phase/`internal_chat_message_metadata_passthrough`/envelope `client_authored`）挂对应消息的 `meta.codex`。

## ⚠️ 压缩折叠的坑（写给后来写适配器的人）

> 2026-08-29 实际踩坑：dsh 适配器第一版把 compacted 会话**两头都做反了**——
> 被折叠的旧内容全部当正常消息迁移，checkpoint 摘要反而掉进 unmapped 桶。
> 修复见 commit `f11f4ea`；本节把契约固化，防止重蹈。

**源日志 ≠ 模型可见面。** DSH（以及任何"压缩不重写日志"的源工具）压缩后：

- 被折叠的旧消息**原样留在日志里**（surfaceOp 仍是 `append`）；
- 模型可见面是**计算出来的**：checkpoint（`user/message`，`source.kind==='plugin' && plugin==='compact'`）携带 `surfaceOp: {op:'replace', start, end}`，DSH 用 `nodes.indexOf(start/end)` 定位——**start/end 是可见节点表中作为端点的两个节点 seq**（不是列表下标！`replacementRange` 的报错 "start seq 42 not found in surface" 即证据），两者之间（含端点）的全部当前节点被顶替为 checkpoint 自身；
- 精确的被遮蔽集合由 checkpoint 的 `sourceEventSeqs` 溯源（集合语义，顺序不重要，写回端可规范化排序）。

**因此，naive 适配器的两个典型错误**：

1. 只读 `append` 事件当全部对话 → 迁移出去的是**压缩前的完整旧内容**，且**没有摘要**（正是我们踩的坑）；
2. 把 checkpoint 当普通注入消息丢弃/或当普通 user 消息追加 → 前者丢上下文，后者造成"摘要 + 全量原文"重复。

**IR 契约（两层表达）：**

| 层 | 载体 | 语义 |
|----|------|------|
| 跨工具通用 | `compaction[]` 桶：`{summary, anchorIndex, tokensBefore?}` | 摘要文本 + 其在 messages[] 中的锚；**通用判定：anchorIndex 之前的消息属于被折叠区间**（多次压缩按时序嵌套，各条目有各自的锚） |
| 源原生保真 | `meta.dsh.shadowed` / `meta.dsh.surfaceOp` / `meta.dsh.sourceEventSeqs` | 精确被遮蔽集合、写回所需的原始折叠算子（跨工具消费方不应读它） |

messages[] 里**全量保留**（含被遮蔽消息）——无损原则；"哪些内容模型可见"由目标端表达。

**目标端义务（按目标能力三选一，禁止默认行为）：**

1. **目标有原生压缩**（如 OpenCode：boundary user 消息挂 `compaction` part + `summary: true` 且 `finish` 的 assistant 摘要消息，`filterCompacted` 重放时排除边界前内容但保留在存储）→ **镜像之**，shadowed span 照写存储，语义与源完全同构；
2. 目标无压缩且上下文有限 → **显式丢弃**被折叠 span（摘要已承载其信息），在适配器文档写明；
3. 目标无压缩但要做完整归档 → 显式保留为可见内容（撑上下文是已知代价），在适配器文档写明。

**写回端义务**：`surfaceOp`/`sourceEventSeqs` 逐字还原（否则源工具重载时折叠结构退化、出现"摘要 + 旧原文"双份）；`rawContent` 类有损投影的还原见 `meta.dsh`。

**checkpoint 识别速查（DSH）**：`source = {kind:'plugin', plugin:'compact', compactionId, sourceCommandId?}`——它是**全部**注入 kind 中**唯一**不算 `synthetic`（注入内容）的特例。注入不止 `plugin` 家族（08-30 修订，源码锚点：`packages/skill/tool-skill`、`context/agent-instructions`、`goal/goal-round-driver`、`subagent/continuation`）：`'skill-catalog'`/`'skill-invocation'`/`'agent-instructions'`/`'goal'`/`'subagent-report'`/`'subagent-settled'`/`'coordinator'` 同为注入——判据是**白名单人类发言**（`kind === 'user'`），不是"只认 plugin"。

## 已知同类问题（按共识待继续收敛）

| # | 问题 | 现状（违共识点） | 建议槽位 | 影响适配器 |
|---|------|------------------|----------|------------|
| 1 | ~~anthropic thinking 签名~~ | ✅ 已落地：`ContentBlock.thinking.signature`（zcode 读写、claude 读写） | — | — |
| 2 | ~~消息级附加信息~~ | ✅ 已落地：`MigratedMessage.meta`（zcode 读写两端；dsh 已跟进——消息级 `meta.dsh` + 会话级 `meta.dsh.headerRaw`，extensions 旁路消除） | — | — |
| 3 | ~~compaction 无位置锚~~ | ✅ 已落地：摘要投影进 messages[] + `anchorIndex`（zcode 写回还原原生 summary 行） | — | — |
| 4 | ~~tool_result 多块/图像内容~~ | ✅ 已落地：`FileBlock` + `tool_result.attachments`（claude/zcode 读写；dsh/codex 写端文本降级） | — | — |
| 5 | step-start / step-finish / timeline 等 part | **决策（修订版）**：part 行原文全部保留在 `meta.zcode.rawParts`（探针证实 step-finish 携带每步 tokens/cost/reason，旧「零信息」判断对它不成立；step-start 确为空对象，保留无成本）；但**不投影进块流**——引擎 D2 回放层本就不把它们喂给模型上下文，投影只会伪造目标工具里不存在的对话内容 | — | zcode（已按此实现） |
| 6 | ~~claude 结构化工具结果原文~~ | ✅ 已落地（v3.2）：`ContentBlock.tool_result.rawResult?: unknown`（claude 读写；挂在块实体上，禁止按 toolUseId 旁表） | — | — |
| 7 | ~~claude 非对话行~~ | ✅ 已落地（v3.2）：`sessionEvents` 桶（system subtype 行）+ 类型化字段（`tag`/`permissionMode`/`prLink`/`worktreeSession`/`costState`）+ `extensions.claude.recordsRaw` 保底；`local_command` 投影 user text + `synthetic:true`；`isMeta` → `synthetic:true`；attachment file → FileBlock | — | — |
| 8 | ~~系统提示词无契约~~ | ✅ 已落地（v3.2）：`ir.systemPrompt` 语义冻结——源端无原生提示词则留空（claude 恒空）；目标端有原生通道走原生槽位（claude = 进程 flag `--append-system-prompt`）；claude 写端显式忽略 IR 值；禁止写进会话正文双叠 | — | 全体适配器 |

> ~~残留小项~~（✅ 2026-08-31 收敛）：sidechain 子会话里无块投影的 assistant 载体行（timeline-event 宿主等）此前整体丢弃——现归档到 `MigratedSidechain.meta['zcode.syntheticMessages']`（`MigratedSidechain` 自带 meta 槽位），与主会话 `zcode.syntheticMessages` 扩展桶同契约；档案桶仍不参与写回（保存读端原始行，重新物化超出 IR 契约）。

## IR 版本与同步闸门（2026-08-30 落地）

> 背景：v3.1 `developer` 角色"需同步的适配器：全部（写端）"实际只有 dsh 落地，
> 其余 4 个写端静默违反（见下节登记）。版本配对此前只靠这张表的人工自觉，无机器约束。

**机制（三件套，全部机器强制）：**

1. **`IR_VERSION`**（ir.ts）——IR 协议版本常量。**每次协议变更（含加性扩展）必须随同 commit bump**。与数据面的 `schemaVersion`（序列化载荷判别符，破坏性改形才动）是两个概念。
2. **`Adapter.irVersion`**（registry.ts）——每个适配器声明"最近一次按哪个协议版本审计过"。**registry.register() 硬闸门：irVersion 落后于 IR_VERSION 的适配器直接拒绝注册**——未同步的适配器根本无法运行（CLI/GUI/plugin 全部经 registry 构造），不存在"先跑着再说"。
3. **契约测试**（test/ir-hardening.test.ts）——坏例电池 + 闸门测试 + developer 角色全端契约测试，由 CI（`.github/workflows/ci.yml`）执行。

**变更流程**：改 IR（类型/桶/角色/校验）→ 同 commit 内 bump `IR_VERSION` + 同步全部内置适配器（写端行为 + `irVersion` 字段）+ validateSession 校验 + 本文档登记。适配器想"先忽略新字段"？可以——读端本就忽略可选字段，但 `irVersion` 必须到位，即必须**审计过**而非实现过。

## 各端未同步问题登记（2026-08-30 调查驱动，✅ 已当日修复）

> 调查方法：代码分支核查 + 每个 IR 角色注入三端实测（`developer`/`system` 消息喂给各写端看原生产物）。
> 结论：v3.1 developer 降级规则 6 个写端只有 codex（原生）/dsh 落地；另发现 claude 旁链 assistant 独立 bug。

| 适配器 | 问题 | 实测证据 | 状态 |
|--------|------|----------|------|
| zcode | 写端只分支 `user\|system`+skip `tool`，**developer 落入 assistant fall-through**，写成 `role:'assistant'`+`assistant_response` 行——v3.1 明令禁止的降级 | 探针实测：DEV-MSG → assistant 行 | ✅ developer 并入 user/system 行（system_reminder 语义，provider 可见，引擎注入形态） |
| opencode | DB 写入路径同样 fall-through 成 assistant（只有 user/tool/system 分支）；mirror 路径无损保留 | 探针实测 | ✅ developer 并入 user 分支（可见 user 行）；mirror 分支本就原样保留 |
| pi | **把 `role:'developer'`/`role:'system'` 原样写进 pi 原生存储**——pi 词汇表只有 user/assistant/toolResult，属非法行；且 pi 自己的 parse 把非 user 角色读回 `assistant`，写入/读出自相矛盾，往返即失真 | 探针实测：round-trip roles = assistant, assistant | ✅ developer/system 降为 user 文本行，round-trip 稳定为 user |
| claude | ① developer/system 落入 user-family，写成模型可见的 `type:'user'` 行（协议要求"并入或降为 system"）；② **旁链 assistant 被写成 `type:'user'` 记录**——`emitMessage` assistant 分支误加 `isSidechain === false` 门（write.ts），旁链无独立 raw 通道（claude/index.ts:115 注释），claude→claude 旁链往返与跨工具→claude 子代理迁移全部损坏；测试无旁链 assistant 写回用例，未拦截 | 探针实测：旁链 "done" → user 行；DEV-MSG/SYS-MSG → user 行 | ✅ ① 新增 system/developer → `type:'system'` 行分支（未知 subtype 经 parse 回 sessionEvents 桶保数据）；② 去掉 isSidechain 门，旁链 assistant 正常走 assistant 分支 |
| codex | 读端 parse 出口不跑 validateSession（只有写端跑） | 代码核查 | ✅ parse 出口补 validateSession |
| dsh | 无问题（developer → plugin 注入 user 消息，代码有注释；与本文档"降为 system"措辞有出入，属有意选择，措辞以此为准） | — | ✅（补记措辞） |

**同一轮加固顺带发现**：codex 原生 rollout 存在**无 `call_id` 的孤儿 `function_call_output`**，codex 读端以空串 `toolUseId: ''` 表示"无配对"。按填空政策（关联指针宁缺勿错）**不得伪造非空 id**，故块级校验对 `tool_result.toolUseId` 放宽为"string 即可，空串 = 合法孤儿标记"，消费端必须把空串当"无配对"处理。

## IR 加固清单（2026-08-30 定稿，✅ 当日全部落地）

> 背景：现有三层约束（TS 类型 / `validateSession` / 每适配器 round-trip 测试）骨架成立，但有四个缺口：① 校验深度浅——`isMigratedMessage`（ir.ts:281）只查 role 合法 + content 是数组，**块级形状完全不查**，缺 `callId` 的 tool_result 也能过；② `extensions` 是 `Record<string, unknown>`（ir.ts:271），无任何形状；③ 引擎无统一卡点——`migrate.ts` 的 `readSource`/`writeTarget` 是纯透传（migrate.ts:17-28），校验全靠适配器自觉；④ 仓库无 CI。四层加固，**零新依赖**（不引 zod：ContentBlock 联合小而稳定，手写守卫贴合仓库风格；将来 IR 拆独立包对外发布给第三方适配器时再评估）。
>
> **执行结果（2026-08-30 当日）**：第一/二/三层全部落地于 `ir.ts`/`migrate.ts`；第四层坏例电池 + 闸门/契约测试落在 `test/ir-hardening.test.ts`，CI 为 `.github/workflows/ci.yml`。金丝雀如期奏效：codex 孤儿 tool_result（空 `toolUseId`）被块级校验拦下，按填空政策放宽为合法孤儿标记（见上节登记），其余 111 个既有测试零回归。唯一与原清单的差异：`tool_use.id/name` 非空、`tool_result.toolUseId` 允许空串（孤儿标记），其余照单全收。

### 第一层：校验下探到块级（✅ 已落地，只动了 `ir.ts`）

- 新增 `isContentBlock()`，按判别式逐型校验：
  - `text`：`text` 为 string
  - `tool_use`：`id`/`name` 非空 string，`input` 有定义
  - `tool_result`：`toolUseId` 为 string（**空串 = 合法孤儿标记**，见「各端未同步问题登记」末段——按填空政策不伪造非空 id），`content` 为 string，`isError` 出现时为 boolean，`attachments` 出现时为合法 FileBlock 数组（每块 `filename`/`mediaType`/`data`/`url` 出现时均为 string）
  - `thinking`：`thinking` 为 string；**`signature` 出现时必须为 string**（逐字节透传的无损关键件，绝不允许被换成非字符串占位）
  - `file`：`data`/`url`/`filename` 至少其一存在，四个字段出现时均为 string
  - 未知 `type` → **拒绝**（闭集：新块类型必须走 IR 演进流程登记，临时扩展走 extensions 桶——设计共识 #4）
- `isMigratedMessage` 加深：`synthetic`/`seq`/`timestamp` 类型校验、`meta` 必须是对象、块级全查
- `isValidToolCall` 加深：`output`/`error`/`title` 出现时为 string、`time.{start,end}` 为 number、`source` 形状完整
- 错误信息带完整定位路径（`message[i].content[j]...`，含坏块 JSON 预览）
- 兼作**金丝雀**：加深后现有 6 适配器的产出全部过检（codex 孤儿 tool_result 按"空串孤儿标记"放行）

### 第二层：扩展槽位最小形状（✅ 已随 claude 重写落地，见 v3.2 登记）

- `extensions` 守卫：已知命名空间（`claude` 等）出现时必须是对象；`recordsRaw` 必须是数组；**`rawResult` 保持 `unknown` 不加强约束**（toolUseResult 原样透传，形状由各工具自己定义）
- `systemPrompt`（ir.ts:224，语义已冻结于上表 #8）：出现时必须为 string，空串合法（= claude 源恒空的语义）

### 第三层：收口到引擎（✅ 已落地，`migrate.ts` 两处 + `ir.ts` 一处）

- `readSource` 出口、`writeTarget` 入口各加一次 `validateSession`——校验从"适配器自觉"升级为"引擎强制"，任何适配器无法绕过；适配器内部现有调用保留作双保险
- `schemaVersion` 改严格必填 `= 2`（"未定义放行"分支已删除）
- 附带：`originTool` 闭集校验、会话级 `goals`/`planModes`/`todos`/`unmappedEvents`/`sessionEvents`/`branchSummaries`/`compaction.*` 逐项校验（此前会话级这些桶完全不查）

### 第四层：测试与 CI（✅ 已落地）

- 坏例电池：`test/ir-hardening.test.ts`——每块型/每关键字段畸形 IR，断言 `validateSession` 抛错且错误信息带路径
- 契约测试：引擎卡点（喂毒 IR 给 `writeTarget`，断言适配器从未被执行）+ registry 版本闸门 + developer 角色全写端契约（claude/pi/zcode/opencode 各一）+ claude 旁链 assistant 契约
- `.github/workflows/ci.yml`：ubuntu + windows 矩阵，install + typecheck + test

### 执行顺序

第一/三/四层与 claude 重写完全解耦（只碰 `ir.ts`/`migrate.ts`/测试），**先做**——小 diff、现有测试立即验回归；第二层绑重写（依赖 #6/#7 落地时一并守卫）。

## 适配器适配状态

> 下表的"✅"不再是自述——`Adapter.irVersion` 已由 registry 硬闸门机器强制（落后 = 无法注册），契约测试锁定各写端行为。

| 适配器 | 状态 |
|--------|------|
| dsh | ✅ **全部落地**（meta.dsh 消息级+会话级，headerRaw 写回消费 / usage+interrupted / tool-result 事件级 error+meta / FileBlock 图像投影 + tool_result attachments / compaction 折叠 + 锚 / synthetic 判定 / toolCalls 桶读写 / 嵌套子代理（孙代+子会话全桶+深度保真+防覆盖）/ 列表标题 projcache→日志兜底 + 归档 + `_no-cwd` / 附件字节解析 `readDshAttachment`） |
| zcode | ✅ 已落地（toolCalls / signature / meta / FileBlock / compaction 锚，读写两端 / sidechain 载体行归档 `meta['zcode.syntheticMessages']`——2026-08-31 收敛，见上文残留小项） |
| claude | ✅ **已重写**（2026-08-30，消费 #6/#7/#8 槽位）：读侧 DAG 链重建（`parentUuid` 主链 + `sourceToolAssistantUUID` 回指 + 同 `message.id` 兄弟并行 tool_result 恢复 + compact 边界 preservedMessages/preservedSegment relink + 死枝剪除 + trailing 深度先序）；三类记录全收（transcript 消息 / B 类元数据行 last-wins / C 类结构化行 + `sessionEvents` 桶）；`isMeta`→`synthetic`；`local_command`→user 文本+synthetic；attachment 67 类型投影 + 原样 meta；`toolUseResult`→`rawResult`；`path.ts` 200 截断 + hash；listSessions §1.0 过滤（uuid 门 + 首行 isSidechain + head teamName + mtime 去重）；subagent（agentId+isSidechain 过滤→leaf→链，teammate 前缀聚合）；写侧双路径：**claude→claude 走 `recordsRaw` 字节级还原**（逐行回写仅重盖 sessionId/session_id，行 uuid 保留——取舍见 docs/agents/claude.md §13）；跨工具走投影 native 盖章（insertMessageChain 盖章顺序、原始 `msg.timestamp` 优先、每条 tool_result 独立 user 记录 + `sourceToolAssistantUUID` 回指、attachment/local_command 原生形状回写、last-prompt 带 leafUuid 不带 cwd、toolUseResult 写前 sanitize、compaction boundary 对回放不双写、sidecar agentMeta 合并、leafUuid 指认活跃 leaf、`wx` 原子写防覆盖拒绝） |
| pi | ✅ **已重写**（2026-09-02，v3.3 落地驱动，见 `docs/agents/pi.md` §13 清单）：读端十类条目全收（compaction/branch_summary 进桶 + anchor 消息、session_info→title、model/thinking_level 全序列进 `meta.pi.settingsEvents`、label/custom 进 `meta.pi`、header 含 parentSession 进 `meta.pi.header`）；七 role 消息词汇完整（bashExecution/custom→user 行+synthetic+`meta.pi.bash/customMessage`，toolResult 补 usage/addedToolNames，assistant 字段级进 `meta.pi.message`）；leaf=最后 entry 回溯；写端消费 compaction/branchSummaries 桶（firstKeptEntryId 指向文件内真实 id、summary 存纯摘要、anchor 跳过防双写、跨工具折叠选 3 完整归档）；settingsEvents/labels/customEntries/title 还原；systemPrompt 读端恒空写端恒不注入；v4（kind:'header'）显式报错跳过；`wx` 独占创建；sidechain 兄弟分支挂载 + branch_summary 标注 |
| codex | ✅ **全部落地**（11 类 rollout 记录全量读写 / response_item 17 变体 1:1 消息投影 + native payload 重建（reasoning summary+content、function/custom/local_shell/tool_search/web_search/image_generation、agent_message+inter_agent_communication 模型可见、developer 角色保留）/ turn_context+world_state 挂轮首消息、孤行归档重放 / compacted→compaction 桶（RH+窗口字段+锚）/ event_msg 全量→unmappedEvents（seq=行号）写回重放 / additional_tools、compaction_trigger、other 归档重放 / session_meta 继承链 + source/thread_source/git/agent_* 原生保真 / session_index append-only 写回 / .zst + `_<rolloutId>` revert 变体 + archived_sessions / **harness 注入行官方分类**：`content_item_kinds` 主通道 + codex rollback.rs 冻结文本标记 fallback——goal resume、system reminder、AGENTS.md、user_shell_command 等不再误判为用户提示词 / `meta.codex.sourceDir/sourceFile` 源文件夹捕获 / **paginated history_mode 按源保真 + history_base 跨文件链式拼接**（byte 精确截断、防环递归，写端自足单文件）+ `SessionMeta.parentSessionId` 子代理树 / `deferredCreation` 空会话 / 标题=首条真实用户 prompt / **外来轮边界合成**（§11.3 已落地：外来 IR 写 codex 时按真实用户 prompt 合成 task_started/task_complete，turn_id 确定性、时间戳取自源消息；codex 原生源事件重放不受影响） |
| opencode | ✅ 已落地（写端消费 compaction 桶 → 原生边界对；synthetic 默认丢弃 / `--keep-runtime-context` 惰性保留；TUI 工具/思考渲染契约对齐） |

### dsh 待适配清单（✅ 已全部完成，留档）

1. ✅ **读**：`tool/call` 事件（log-only：`{turn, step, callId, name, arguments}`，arguments 为模型原始 JSON 串）→ `toolCalls` 记录。无结果事件 → `running`；有结果按块 `isError`/事件级 `error` 身份 → `completed`/`error`；原始 arguments 存 `metadata.dsh.arguments` 保真；事件级工具私有 `meta` 存 `metadata.dsh.resultMeta`。tool/call 事件不再进 unmapped（避免写回双发）。
2. ✅ **写**：每条桶记录重发一个 `tool/call` 事件。running/pending 记录只有孤立 call 事件——正是 DSH 中断调用的原生形态；completed/error 由消息侧 tool/result 事件配对，凑齐原生三元组（assistant 块 + tool/call + tool/result）。

### dsh 第二轮盘点（2026-08-29 晚，源码 known-event-types 目录 + 36 会话实测驱动）

盘点报告见 `docs/session-formats-audit.md` §1「深度盘点 #2」（subagent 关联机制 / 51 种事件目录 vs 12 种显式映射 / 附属存储 / 保真缺口清单）。IR 侧登记：

| 变更 | 位置 | 说明 | 消费方 |
|------|------|------|--------|
| `MigratedSidechain` 桶扩充（子会话 = 迷你会话） | 侧链 | 新增可选 `originSessionId/title/createdAt/cwd/goals/planModes/todos/compaction/unmappedEvents/meta` 与嵌套 `sidechains`（孙代）。dsh 子会话从此全桶往返；`validateSession` 递归校验 | dsh 读写两端；其余适配器忽略 |
| `SessionMeta.archived?: boolean` | 列表元数据 | 源 store 的归档状态（DSH `workspace.json` 的 `global.archivedSessionIds`），列表/UI 可过滤 | dsh 读；其余适配器可选 |
| `meta.dsh` 消息级扩展 | 每条消息 | assistant 消息新增 `usage`（token 记账）与 `interrupted`（中断已交付前缀标记）；tool 角色消息新增 `resultError`/`resultMeta`（`tool/result` 事件级字段）——写回端重发到事件 | dsh 读写两端；其余忽略 |
| `readDshAttachment()` | dsh 适配器导出（非 IR 变更） | `~/.dsh/attachments/v1/objects/<sha256[0:2]>/<sha256>` 内容寻址字节解析（attachmentId 兼容 `sha256:<hex>` 与裸 hex）——`dsh-attachment://<id>` FileBlock url 的字节兑现路径 | 跨工具图像导出方 |
