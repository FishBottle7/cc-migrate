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

## ⚠️ 压缩折叠的坑（写给后来写适配器的人）

> 2026-08-29 实际踩坑：dsh 适配器第一版把 compacted 会话**两头都做反了**——
> 被折叠的旧内容全部当正常消息迁移，checkpoint 摘要反而掉进 unmapped 桶。
> 修复见 commit `f11f4ea`；本节把契约固化，防止重蹈。

**源日志 ≠ 模型可见面。** DSH（以及任何"压缩不重写日志"的源工具）压缩后：

- 被折叠的旧消息**原样留在日志里**（surfaceOp 仍是 `append`）；
- 模型可见面是**计算出来的**：checkpoint（`user/message`，`source.kind==='plugin' && plugin==='compact'`）携带 `surfaceOp: {op:'replace', start, end}`，对**当前可见节点列表的 [start,end] 位置区间**做拼接顶替——注意 start/end 是**节点列表位置**，不是事件 seq；
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
| 2 | ~~消息级附加信息~~ | ✅ 已落地：`MigratedMessage.meta`（zcode 读写两端；dsh 的 header 级旁路信息仍待迁移，见下） | dsh 跟进 | dsh |
| 3 | ~~compaction 无位置锚~~ | ✅ 已落地：摘要投影进 messages[] + `anchorIndex`（zcode 写回还原原生 summary 行） | — | — |
| 4 | ~~tool_result 多块/图像内容~~ | ✅ 已落地：`FileBlock` + `tool_result.attachments`（claude/zcode 读写；dsh/codex 写端文本降级） | — | — |
| 5 | step-start / step-finish / timeline 等 part | **决策（修订版）**：part 行原文全部保留在 `meta.zcode.rawParts`（探针证实 step-finish 携带每步 tokens/cost/reason，旧「零信息」判断对它不成立；step-start 确为空对象，保留无成本）；但**不投影进块流**——引擎 D2 回放层本就不把它们喂给模型上下文，投影只会伪造目标工具里不存在的对话内容 | — | zcode（已按此实现） |

> 残留小项：sidechain 子会话里无块投影的 assistant 载体行（timeline-event 宿主等）目前仍整体丢弃（主会话同类行已进 `zcode.syntheticMessages` 原始档案桶，且档案桶不参与写回——它保存的是读端原始行，重新物化超出 IR 契约）。待 sidechain 获得独立 extensions/meta 槽位时一并收敛。

## 适配器适配状态

| 适配器 | 状态 |
|--------|------|
| dsh | ✅ 大部分已落地（meta.dsh 原生字段 / FileBlock 图像投影 + tool_result attachments / compaction 位置替换折叠 + 锚 / synthetic 判定）；⚠️ `toolCalls` 桶仍待适配（清单见下） |
| zcode | ✅ 已落地（toolCalls / signature / meta / FileBlock / compaction 锚，读写两端） |
| claude | ✅ 已跟进 #1/#4（normalizeContent + claudeNativeBlock：签名、图像、attachments、is_error） |
| pi / codex | ✅ 兼容——新桶均为可选字段，忽略即可；pi 已带 FileBlock 文本降级 |
| opencode | ✅ 已落地（写端消费 compaction 桶 → 原生边界对；synthetic 默认丢弃 / `--keep-runtime-context` 惰性保留；TUI 工具/思考渲染契约对齐） |

### dsh 待适配清单

1. **读**：`tool/call` 类事件 + `tool/result` 事件 → 产出 `toolCalls` 记录（status 由结果事件存在性/isError 推导），使 dsh→zcode 等目标能拿到调用级精确状态，而不是只靠块词汇表回推。
2. **写**：消费 `ir.toolCalls`（与现有 tool-call 块 + tool/result 事件的融合视角等价，桶里有额外状态时以桶为准）。
