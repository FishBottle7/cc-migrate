# 问题报告：claude → DSH 迁移显示异常（2026-09-05）

> 影响版本：cc-migrate 0.3.2 及之前 · 修复：0.3.3（commit `49002fc`）
> 排查方法：真机产物（`~/.dsh/sessions`）+ DSH 安装本体源码（`@deepseek-ai/dsh@0.1.1-rc.2` 全家桶）对照裁定

## 现象

用户把 claude code 会话迁移到 DSH 后，在 DSH GUI 里：

1. **agent 的文本和思考全部不可见**——只能看到 tool call 卡片和一些上下文注入，感觉信息大量缺失；
2. **子代理（subagent/teammate）显示「会话记录损坏」**，无法查看；
3. **打断标记、跨代理消息、子代理任务提示被显示成用户发言**（真人气泡）。

关键事实：迁移产物在磁盘上**内容并不缺失**——用 DSH 本体的 `foldSurface` 折叠，文本/reasoning 块都在。坏的是**形状**（问题 1/2）和**分类**（问题 3）。

## 问题 1：agent 文本/思考不可见 —— DSH 适配器写端

**根因**（`packages/core/src/adapters/dsh/index.ts` → `irToEvents`）：turn/step 骨架合成的游标**从不前进**——整场会话只发一次 `turn/start` + `step/start`，所有 assistant/message 全部钉在 `(turn:1, step:1)`。而 DSH GUI 把同一 `(turn,step)` 的所有 assistant/message 折叠成**一个**节点、update 语义是**整块替换**（client `assistant-step` + `fallbackState`）——于是整场会话只剩同组最后一条 assistant。真机证据：OpenCray 迁移产物 450 条 assistant/message 全是 `1:1`，最后一条恰好是裸 tool-call 记录（渲染成工具卡片）→ 文本/思考全灭。tool 卡片和注入消息各自独立编号，反而都看得见——与现象完全吻合。

**修复**：按 native 形状合成完整生命周期（真机原生日志实测 41 turn / 968 step，**一个 step 恰好一条 assistant/message**）：

- turn 1 开于首个 surface 行前；**人话（`source.kind==='user'`）关旧开新 turn**（当前 turn 尚无 assistant 时不关，会话起始注入与首个 prompt 同属 turn 1）；
- **每条 assistant/message 独占 step**；流尾补 `step/end` + `turn/end {completed}` 成对闭合；
- 块派生 `tool/call` 行随游标 restamp（`_blockCall` 标记），toolCalls 桶重发行保留原生坐标绝不 restamp；
- claude 流式转写把一次响应拆成共享 `message.id` 的多条记录（reasoning/文本/tool_use 各一条）——**相邻同响应记录合并为一条 assistant/message**（不相邻的各自成 step）；
- 顺手把 assistant source 提升为真实身份（`provider:'claude'` + `meta.claude.message.model`）。

## 问题 2：子代理「会话记录损坏」 —— DSH 适配器写端

**根因**：DSH 子代理列表（`dsh-subagent resolveColdIdentity`）要求子日志能折叠出非 null 的 `values.subagent` 身份，而身份**只能由 `subagent/descriptor` 事件建立**（`foldSubagentDescriptor`，first-wins、恰好一条）；折叠为 null 的子日志直接返回 diagnostic `corrupt`。claude 子代理源文件没有这种事件，我们写出的子日志也就没有。

**修复**：外来子会话日志**首行**补 `{version:2, mode:'one-shot', provider:'migrated', label:<title ?? agentType ?? agentId>}` 的 descriptor（one-shot = 归档记录、不支持续发，GUI 明确支持查看 one-shot 记录）；dsh→dsh 子会话自带 descriptor 的绝不追加第二条。

## 问题 3：打断/跨代理消息显示成人话 —— claude 适配器读端

**根因**（`packages/core/src/adapters/claude/parse.ts` → `projectChain`）：这些行在 claude transcript 里就是 `type:"user"` 记录，读端投影时没把它们和真人发言区分开：

- **打断标记** `[Request interrupted by user]` / `[…for tool use]`——真机 57 行实测**全部没有 isMeta**，不能靠 isMeta 兜；
- **混装行**——打断标记常与后续内容同行：队友消息信封，甚至真人打断后接着打的新输入；
- **子代理转写（`isSidechain:true`）的 user 行**——spawn prompt 是 Task 工具的 prompt 参数，纯文本无任何标记；真人根本无法在子代理转写里发言。

IR 一旦标错，DSH 写端只是如实翻译（`synthetic` → plugin 注入的映射本身是对的），所以这轮病灶在读端。

**修复**（读端定性，内容零丢弃）：

- 侧链全部非 tool_result user 行 → 整行 `synthetic:true`；
- 主转写按文本块匹配打断标记 / teammate 信封（`<teammate-message` / `Another Claude session sent a message:`），**混装行按连续同源段拆成多条 IR 消息**（agent run → 注入，human run → 人话）；
- claude 写端把 synthetic 映回 isMeta 行，模型上下文照旧完整（红线 #2 不动）；claude→claude 主文件走 recordsRaw 字节直通，零影响；
- 注入不构成 turn 边界——顺带修掉了打断行把 DSH 会话骨架切碎的隐性 bug。

## 验证

- core 197 测试全绿（新增 7：生命周期 / 同响应合并 / descriptor / 注入不切 turn / claude 分类等）；
- 真机重迁 live-agents `c6b21e5d`（15 个子代理）：DSH 本体 `foldSurface` + `foldSubagentDescriptor` 逐份校验 **16/16 产物全绿**；主会话 52 turn / 291 step、零同 step 碰撞；
- 定性修复后主会话 turn 数 **52 → 32**——打断行此前制造的 20 个假 turn 边界消失；子代理日志人话为 0、spawn prompt 全部为注入。

## 备注

- 两侧根因一句话：上轮是「翻译成 DSH 的话写错了」（DSH 写端），这轮是「读 claude 时就把身份认错了」（claude 读端）。
- 已装产物不受影响的部分：旧迁移文件还是坏形状，DSH 不会自动修正——重装插件后需**重新迁移**一次。
- 语义登记：`docs/agents/dsh.md`（外来写端骨架/合并/descriptor）、`docs/agents/claude.md`（agent-authored 行定性）。
