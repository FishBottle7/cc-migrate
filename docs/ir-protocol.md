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

`toolCalls` 的契约要点：`messages[]` 只承载**可回放**投影（completed/error → `tool_use`+`tool_result`，以 callID 关联）；非可回放态（pending/running）只存在于桶中，由源 `source.messageSequence` 在写回时回填到对应消息，保证 zcode→zcode 对融合 tool-part 模型无损，且不会在任何目标工具里产生悬空 tool_use。

## 已知同类问题（按共识待继续收敛）

| # | 问题 | 现状（违共识点） | 建议槽位 | 影响适配器 |
|---|------|------------------|----------|------------|
| 1 | anthropic thinking 签名（reasoning 回传签名） | zcode 寄存在 `extensions['zcode.messageExtras'].signatures`，按源 part 序号关联 | `ContentBlock.thinking` 加可选 `signature?: string`（claude 写回 resume 需要） | zcode 读 / claude 写 |
| 2 | 消息级附加信息（contextSnapshot/tools/anchor/per-message tokens/mode 等） | zcode 寄存在 `extensions['zcode.messageExtras']`，**以源消息 id 为键**——消息被过滤/重排/跨工具转换后关联即失联（典型"不好分清"） | `MigratedMessage.meta?: Record<string, unknown>`——挂在消息实体上，天然归属 | 全部（additive，旧适配器忽略） |
| 3 | compaction 无位置锚 | `compaction[]` 是会话级桶，类型里的 `firstKeptId` 无人填充；zcode 写回直接跳过 compaction | 给 compaction 条目补消息流锚点 + 写回支持 | zcode |
| 4 | tool_result 多块/图像内容 | `normalizeContent` 把非文本拍平为 `'[image omitted]'` | 块词汇表扩展（低优先级，当前工具链以文本为主） | 全部 |
| 5 | step-start / step-finish / timeline 等零信息 part | 读取时丢弃 | **决策：不保留**——引擎回放层（D2）本身就丢弃这些，保留只会扰动块序 | zcode（已按此实现） |

## 适配器适配状态

| 适配器 | 状态 |
|--------|------|
| dsh | ⚠️ **待适配新 IR 协议**（清单见下） |
| zcode | ✅ 已落地（toolCalls 读写两端） |
| claude / codex / pi / opencode | ✅ 兼容——新桶均为可选字段，忽略即可；待 #1/#2 落地后按需跟进 |

### dsh 待适配清单

1. **读**：`tool/call` 类事件 + `tool/result` 事件 → 产出 `toolCalls` 记录（status 由结果事件存在性/isError 推导），使 dsh→zcode 等目标能拿到调用级精确状态，而不是只靠块词汇表回推。
2. **写**：消费 `ir.toolCalls`（与现有 tool-call 块 + tool/result 事件的融合视角等价，桶里有额外状态时以桶为准）。
3. **#2 槽位落地后**：header 级旁路信息（当前 `extensions['dsh.headerRaw']` 中属于消息实体的部分）迁移到 `MigratedMessage.meta`，消除源 id 旁路映射。
