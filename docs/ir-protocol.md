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
| `compaction[].anchorIndex` | MigratedSession.compaction | 压缩摘要**同时投影为 messages[] 里的 user 消息**（`meta.zcode` 标记原生形状），桶条目用 `anchorIndex` 指向它——摘要文本随 messages 跨工具流动，结构化载荷（tokensBefore 等）留在桶里 | zcode 读+写回 |

`toolCalls` 的契约要点：`messages[]` 只承载**可回放**投影（completed/error → `tool_use`+`tool_result`，以 callID 关联）；非可回放态（pending/running）只存在于桶中，由源 `source.messageSequence` 在写回时回填到对应消息，保证 zcode→zcode 对融合 tool-part 模型无损，且不会在任何目标工具里产生悬空 tool_use。

`meta` 的契约要点：键是适配器命名空间；写回端只消费自己命名空间的键，未知键忽略。rawParts 还原时排在投影块之后（模型可见回放只来自 text/reasoning/tool part，块序已保真；raw 序只影响引擎记账部分）。extensions 里的 `zcode.messageExtras` / `zcode.compactions` / `zcode.compactionSummaries` 已随 #1/#2/#3 落地**废除**。

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
| dsh | ⚠️ **待适配新 IR 协议**（清单见下） |
| zcode | ✅ 已落地（toolCalls / signature / meta / FileBlock / compaction 锚，读写两端） |
| claude | ✅ 已跟进 #1/#4（normalizeContent + claudeNativeBlock：签名、图像、attachments、is_error） |
| pi / codex / opencode | ✅ 兼容——新桶均为可选字段，忽略即可；pi 已带 FileBlock 文本降级 |

### dsh 待适配清单

1. **读**：`tool/call` 类事件 + `tool/result` 事件 → 产出 `toolCalls` 记录（status 由结果事件存在性/isError 推导），使 dsh→zcode 等目标能拿到调用级精确状态，而不是只靠块词汇表回推。
2. **写**：消费 `ir.toolCalls`（与现有 tool-call 块 + tool/result 事件的融合视角等价，桶里有额外状态时以桶为准）。
3. **meta 槽位跟进**：header 级旁路信息（当前 `extensions['dsh.headerRaw']` 中属于消息实体的部分）迁移到 `MigratedMessage.meta`（命名空间 `meta.dsh`），消除源 id 旁路映射。
