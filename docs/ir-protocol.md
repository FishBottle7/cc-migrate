# IR 协议 — 设计共识与演进规则

> 适用范围：`packages/core/src/ir.ts` 与全部 `packages/core/src/adapters/*`
> 确立时间：2026-08-29（zcode 适配器接入后确立，见 `docs/agents/zcode.md` 与 commit `0d61eae`）

## 设计共识

1. **IR 是可修改的活协议，不是一次定稿的接口。** 所有 N 个工具互转都经 IR 枢纽（N 个适配器，不存在两两直转），IR 的形状直接决定迁移的保真上限。遇到新工具的新概念时，改 IR 是正当手段。
2. **目的是完整保全所有信息（加密内容除外）。** 源存储里存在、而 IR 没有槽位的信息，不允许静默丢弃，也不允许永远寄居在非类型化的 extensions 字符串里——extensions 是过渡方案，不是归宿。
3. **不允许"不好分清"的信息存在。** 任何信息必须能无歧义地归属到它描述的实体（会话 / 消息 / 块 / 单次工具调用），且关联方式必须跟随实体本身（挂在实体字段上），而不是靠源存储 id 的旁路映射表约定——旁路表在消息被过滤、重排、跨工具转换后即失联。
4. **扩展模式：typed bucket / 可选字段。** 新概念优先加类型化桶（参照 `goals` / `planModes` / `todos` / `toolCalls` 的既有模式）或实体上的可选字段；必须向后兼容——旧适配器不认识新桶时忽略即可，`validateSession` 同步校验。
5. **每次扩展三件事同步落地**：validateSession 校验、至少一个适配器完成读写两端、本文档登记（桶清单 + 适配器状态）。

## 已落地的 typed buckets

| 桶 | 载体 | 语义 | 产出/消费 |
|----|------|------|-----------|
| `goals` / `planModes` / `todos` / `unmappedEvents` | MigratedSession | DSH 事件流的领域状态 | dsh 读写 |
| `toolCalls: MigratedToolCall[]` | MigratedSession + MigratedSidechain | 融合 call+result 的四态工具调用（pending/running/completed/error，含 input/output/error/title/metadata/time 与源位置） | zcode 读写；其他适配器忽略 |
| `ContentBlock.thinking.signature?` | thinking 块 | anthropic thinking 回传签名——挂在块实体上（原 zcode 寄存在 `messageExtras.signatures` 按 part 序号关联，已废除） | zcode 读+写；claude 读写（`normalizeContent` / `blocksToNative` / `claudeNativeBlock`）；其他适配器忽略 |
| `MigratedMessage.meta?: Record<string, unknown>` | 每条消息（适配器命名空间，如 `{ zcode: {...} }`） | 消息级原生载荷：semantics/cost/tokens/time/anchor/contextSnapshot/tools/metadata + **所有无块投影的 part 行原文**（step-start/step-finish/timeline/compaction 边界/snapshot/agent…）。挂在消息实体上，绝不使用源 id 旁表 | zcode 读写两端（写回原样还原）；其他适配器忽略 |
| `ContentBlock` + `FileBlock`（`type:'file'`） | 块词汇表 | 文件/图像附件（`mediaType`/`data` base64/`url` 引用）；`tool_result.attachments?: FileBlock[]` 承载结果内嵌图像。不再有 `'[image omitted]'` 拍平 | zcode（file part）、claude（image 块、tool_result 内容数组）读写；pi/其他写端降级为文本占位 |
| `compaction[].anchorIndex` | MigratedSession.compaction | 压缩摘要**同时投影为 messages[] 里的 user 消息**（`meta.zcode` 标记原生形状），桶条目用 `anchorIndex` 指向它——摘要文本随 messages 跨工具流动，结构化载荷（tokensBefore 等）留在桶里 | zcode 读+写回；**dsh 读+写回**（checkpoint 即摘要载体，`meta.dsh` 另带原生 surfaceOp/sourceEventSeqs） |
| `MigratedMessage.synthetic?: boolean` | 每条消息 | 源 harness **注入**（非人类输入）的消息：DSH 把运行时上下文快照、`<system-reminder>` 指令/技能目录持久化为普通 user/message 事件（`source.kind === 'plugin'`），人类输入是 `source.kind === 'user'`。**压缩摘要（plugin `compact`）是对话内容，不属于此类**。目标端默认丢弃，opt-in 保留时打惰性标记（OpenCode：text part `ignored: true`——时间线隐藏且 `toModelMessagesEffect` 重放跳过） | dsh 读（判定）+ opencode 写（消费）；其他适配器忽略 |

`toolCalls` 的契约要点：`messages[]` 只承载**可回放**投影（completed/error → `tool_use`+`tool_result`，以 callID 关联）；非可回放态（pending/running）只存在于桶中，由源 `source.messageSequence` 在写回时回填到对应消息，保证 zcode→zcode 对融合 tool-part 模型无损，且不会在任何目标工具里产生悬空 tool_use。

`meta` 的契约要点：键是适配器命名空间；写回端只消费自己命名空间的键，未知键忽略。rawParts 还原时排在投影块之后（模型可见回放只来自 text/reasoning/tool part，块序已保真；raw 序只影响引擎记账部分）。extensions 里的 `zcode.messageExtras` / `zcode.compactions` / `zcode.compactionSummaries` 已随 #1/#2/#3 落地**废除**。

## v3.1 登记（2026-08-29，codex 适配器开发前调查驱动）

全部为**可选字段**——旧适配器读到时忽略即可，不破坏任何现有读写；但**写端**需按约定消费。依据：codex-main 源码深查（2026-08 版，本机实测 cli 0.146.0），完整字段映射见 `docs/agents/codex.md`。改动明细另见 `packages/core/src/ir.ts` 头注释。

| 扩展 | 载体 | 语义 | 产出/消费 | 需同步的适配器 |
|------|------|------|-----------|----------------|
| `MessageRole` 新增 `'developer'` | 每条消息 | OpenAI Responses 的 developer 角色（codex `<permissions instructions>`、client-authored developer 消息、`developer_instructions` 配置）。与 `system` 不同：resume 回放按原角色还原。**写端降级规则**：codex 写回保留原样；claude/dsh 并入或降为 `system`；zcode/pi/opencode 降为 `user` 可见行；禁止降为 assistant（模型会当成自己的话） | codex 读写两端；其余写端补一个 role 分支 | **全部**（写端） |
| `MigratedSession.meta?: Record<string, unknown>` | 会话级 | `MigratedMessage.meta` 的会话级镜像：适配器命名空间原生会话载荷。codex 命名空间放 `session_meta` 行原生 payload（`source`/`thread_source`/`git`/`originator`/`cli_version`/`history_mode`/fork/parent 链/`agent_*`/`dynamic_tools`/`context_window` 等）+ `sessionIndex` 标题行；dsh 的 header 级信息应从 `extensions['dsh.headerRaw']` 迁入 `meta.dsh`（消除最后一处旁路） | codex 读写两端；dsh 迁移跟进 | **codex**（新）、**dsh**（待迁移）；其余忽略 |
| `compaction[].replacementHistory?: MigratedMessage[]` | compaction 桶 | codex `CompactedItem.replacement_history`：压缩后**取代此前全部历史**的完整保留史（与 messages[] 同构投影）。区别于 Pi 的 `retainedTail`（Pi 是自包含保留尾） | codex 读写两端；其他忽略 | **codex**（新）；其余忽略 |
| `compaction[].meta?: Record<string, unknown>` | compaction 桶 | 压缩记录实体上的原生载荷（codex：`window_number`/`first_window_id`/`previous_window_id`/`window_id`/`mcp_resource_origins`），不开源 id 旁表 | codex 读写两端 | **codex**（新）；zcode 可选跟进（边界行迁 `meta.zcode`） |
| `unmappedEvents` 语义泛化 | 事件日志桶 | 原注释限定 DSH，现泛化为**源 harness 事件日志**（codex `event_msg` 行等）：`seq`=源日志位置（无显式序号时取行号），`type`=源事件类型，`data`=原始载荷（去加密字段）。codex 写回从桶重放 resume 相关事件（turn 边界/rollback/settings） | dsh 不变 + codex 读 | **codex**（新）；dsh 无动作 |

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

**checkpoint 识别速查（DSH）**：`source = {kind:'plugin', plugin:'compact', compactionId, sourceCommandId?}`——它是 `source.kind==='plugin'` 中**唯一**不算 `synthetic`（注入内容）的特例；其余 plugin 来源（`@deepseek-ai/dsh-system-prompt` 运行时快照、agent-instructions、技能目录等）均为注入内容，默认丢弃是安全默认。

## 已知同类问题（按共识待继续收敛）

| # | 问题 | 现状（违共识点） | 建议槽位 | 影响适配器 |
|---|------|------------------|----------|------------|
| 1 | ~~anthropic thinking 签名~~ | ✅ 已落地：`ContentBlock.thinking.signature`（zcode 读写、claude 读写） | — | — |
| 2 | ~~消息级附加信息~~ | ✅ 已落地：`MigratedMessage.meta`（zcode 读写两端；dsh 已跟进——消息级 `meta.dsh` + 会话级 `meta.dsh.headerRaw`，extensions 旁路消除） | — | — |
| 3 | ~~compaction 无位置锚~~ | ✅ 已落地：摘要投影进 messages[] + `anchorIndex`（zcode 写回还原原生 summary 行） | — | — |
| 4 | ~~tool_result 多块/图像内容~~ | ✅ 已落地：`FileBlock` + `tool_result.attachments`（claude/zcode 读写；dsh/codex 写端文本降级） | — | — |
| 5 | step-start / step-finish / timeline 等 part | **决策（修订版）**：part 行原文全部保留在 `meta.zcode.rawParts`（探针证实 step-finish 携带每步 tokens/cost/reason，旧「零信息」判断对它不成立；step-start 确为空对象，保留无成本）；但**不投影进块流**——引擎 D2 回放层本就不把它们喂给模型上下文，投影只会伪造目标工具里不存在的对话内容 | — | zcode（已按此实现） |

> 残留小项：sidechain 子会话里无块投影的 assistant 载体行（timeline-event 宿主等）目前仍整体丢弃（主会话同类行已进 `zcode.syntheticMessages` 原始档案桶，且档案桶不参与写回——它保存的是读端原始行，重新物化超出 IR 契约）。待 sidechain 获得独立 extensions/meta 槽位时一并收敛。

## 适配器适配状态

| 适配器 | 状态 |
|--------|------|
| dsh | ✅ **全部落地**（meta.dsh 消息级+会话级 / FileBlock 图像投影 + tool_result attachments / compaction 折叠 + 锚 / synthetic 判定 / toolCalls 桶读写） |
| zcode | ✅ 已落地（toolCalls / signature / meta / FileBlock / compaction 锚，读写两端） |
| claude | ✅ 已跟进 #1/#4（normalizeContent + claudeNativeBlock：签名、图像、attachments、is_error） |
| pi | ✅ 兼容——新桶均为可选字段，忽略即可；pi 已带 FileBlock 文本降级 |
| codex | ⚠️ **待重写**——现有实现按旧版格式假设（`instructions` 字段已不存在、`reasoning`/`web_search_call`/`turn_context`/`world_state`/`event_msg`/`compacted` 全部丢弃、无 `session_index` 写回），不能达标 100% 无损；按 `docs/agents/codex.md` 重做，消费上表 v3.1 槽位 |
| opencode | ✅ 已落地（写端消费 compaction 桶 → 原生边界对；synthetic 默认丢弃 / `--keep-runtime-context` 惰性保留；TUI 工具/思考渲染契约对齐） |

### dsh 待适配清单（✅ 已全部完成，留档）

1. ✅ **读**：`tool/call` 事件（log-only：`{turn, step, callId, name, arguments}`，arguments 为模型原始 JSON 串）→ `toolCalls` 记录。无结果事件 → `running`；有结果按块 `isError`/事件级 `error` 身份 → `completed`/`error`；原始 arguments 存 `metadata.dsh.arguments` 保真；事件级工具私有 `meta` 存 `metadata.dsh.resultMeta`。tool/call 事件不再进 unmapped（避免写回双发）。
2. ✅ **写**：每条桶记录重发一个 `tool/call` 事件。running/pending 记录只有孤立 call 事件——正是 DSH 中断调用的原生形态；completed/error 由消息侧 tool/result 事件配对，凑齐原生三元组（assistant 块 + tool/call + tool/result）。
