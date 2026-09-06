# DSH — 特征与存储

> 源码：`deepseek-harness-master` @ `0.1.2-alpha.1` · 格式 `version:0`
> 锚点：`packages/session/session-persistence-jsonl/src/format.ts` · `zstd.ts` · `index.ts` · `packages/core/session/src/types.ts` · `surface.ts` · `chunk-rows.ts`

## 定位

- 默认根：`~/.dsh/sessions`（解析后冻结，`index.ts:153`）
- 路径：
  - `cwd` 有值：`<root>/--<projectKey>--/<encodeSegment(id)>/session.jsonl.zstd`
  - `cwd===undefined`：`<root>/_no-cwd/<encodeSegment(id)>/session.jsonl.zstd`（`format.ts:178`）

## 物理格式

- 单文件 = 多 zstd frame 拼接，每帧 `ZSTD_c_checksumFlag=1`（`zstd.ts:18`）
- frame 0 = header 单行 + `\n`（`assertZstdHeaderFrame:50` 强制恰好一行）
- 后续帧 = 事件批（`encodeMaterialization:635` / `encodeEventBatch`）
- 扫描为结构化帧解析（magic `0xFD2FB528` + descriptor + block header + checksum，`zstd.ts:48`），尾帧不完整返回 `tornStart`；非简单 magic 搜索
- `packChunks` 默认 `true`（`index.ts:39`）：连续 `assistant/chunk` 打包为 `text-chunks`/`reasoning-chunks`/`tool-call-chunks` 存储行（`chunk-rows.ts:9/100`），读对两种布局兼容（`decodeStorageRecord`）

## 路径编码

- `projectKey(cwd)`（`format.ts:149`）：`:`/`\`/`/` 的连续段压缩为单个 `-`，安全码元 `A-Za-z0-9._-` 保留，`~` 转义，其余 `~XXXX`，去前导 `-`，截 251，包 `--...--`；空串抛错；`/`→`--root--`
- `encodeSegment(id)`（`format.ts:123`）：`~` 转义，`.`→`~002E` / `..`→`~002E~002E`，单射（含孤代理）

## Header 行

```json
{"type":"session","version":0,"id":"session-<uuid>","createdAt":1787844419631,"cwd":"D:\\...","delegationDepth":0,"agentPreset":"standard","parentSession":"session-...","seedLength":123,"origin":"subagent"}
```

| 字段 | 约束 |
|------|------|
| `type` | `session` |
| `version` | `SESSION_FORMAT_VERSION=0`（`types.ts:56`），外来版本直接拒载 `refuseForeignFormatVersion:273` |
| `id` | brand string |
| `createdAt` | 非负 safe int，`-0` 非法 |
| `delegationDepth` | 必需，非负 safe int，顶层 0 子=`parent+1` |
| `cwd` | 可选，缺省走 `_no-cwd`，有则参与 `logPath` |
| `parentSession`/`seedLength`/`origin`/`agentPreset` | 可选；`origin` 仅 `subagent`；退役 `sandboxMode`/`approvalPolicy` 出现即抛错 `format.ts:74` |

## 事件与 Surface

- 每事件 `seq` 连续（`applySurfaceEvent:397` 校验）+ `time` + `data` + 可选 `surfaceOp`/`sourceEventSeqs`
- Surface 仅三类（`surface.ts:15`）：`user/message` | `assistant/message` | `tool/result`；其余携 `surfaceOp` 即抛错
- `surfaceOp`：`append` 或 `{op:'replace',start,end}` 闭区间替换，需 `sourceEventSeqs` 覆盖全部被遮蔽节点（`assertProvenance:211`），`tool/result` 替换仅改 `content`（`assertToolResultRewrite:287`）
- `foldSurface(events)` 重放得到 `nodes` + `replacements`；`deriveEventMessage`：`assistant/message` 的 `content.length===0` 视为 `null` 不进 surface
- 模型可见 surface（三类 `deriveEventMessage` 投影）是 resume 真实输入

## 发现与校验

- `listArtifacts:488` 仅读首 frame/header（`readFirstZstdLine/scanZstdFrames(...,1)`），校验 `header.id` 与路径一致性（含 `realpath` 大小写不敏感 `sameFile:854`），拒绝 `oppositeCompression` 与 `legacy flat-file`（`checkRootEncoding:894`）

## 可 resume 最小集合

1. header frame（`type/version/id/createdAt/delegationDepth`）
2. 事件 frame：若干 `user/message`+`assistant/message`(需 `content.length>0`)+`tool/result` 且 `surfaceOp:'append'`，`seq` 从 0 连续
3. 可选 `turn/step/tool/call` 等 log-only 事件

## IR 映射（v3 无损）

- **kind:"user" 注入行的文本判定（2026-09-06）**：DSH 自家 harness 把 permissions / team-preamble / AGENTS.md / environment-context / multi-agent-mode 注入盖成普通 `source.kind:"user"` 消息（真机样本 52be3474 锚定；2026-09 现网复验：2600 条 `kind:"user"` 中 46 条命中已知注入前缀）——parse 端对 `kind:"user"`/无 source 行按 `INJECTION_TEXT_PREFIXES` 嗅探首个非空 text 块，命中即标 `IR synthetic:true`（此前该前缀表只用于标题兜底，注入行随人话迁移）。委派任务消息（子会话首条 `kind:"user"`）不带前缀、不受影响；team-preamble 标记钉死反引号（``You are ` ``），普通 "You are …" 开头的任务文本不会误判。
- `MigratedMessage` ↔ surface 三类；`cwd` 参与 `projectKey`；`model` 仅提示；旁链为独立 session 文件（`parentSession` 引用）
- **v3 breaking（`schemaVersion: 2`）**：`agent→IR` 零过滤（除 `encrypted_content/encrypted` 占位 `[encrypted omitted]`），`goal/change → goals`、`plan/mode → planModes`、`todo/write → todos`，其余 `~40` 类 `known-event-type` 进 `unmappedEvents`（含 `surfaceOp/sourceEventSeqs`），`session/title` 促升为 `ir.title` + 保留原事件；`IR→DSH` 按 `time` 合并重排 `seq 0..N-1` 写回，全量保留。`IR→Claude/Codex/OpenCode/Pi` 按能力表丢弃领域桶（见 `docs/plans/ir-v3-lossless-100.md §2.4`）。
- claude teammate 侧链承载（2026-09-03 调查+裁定，方案 B）：承载形态=**独立子会话**（与 subagent 同款 `parentSession` 链 + 子会话文件；`agentPreset` 写 `teammate/<agentType ?? 'teammate'>` 标识，title 带 `(migrated teammate)` 前缀）；**不转译为 `team/*` 事件**——`team/member`、`team/message/queued`、`team/message/delivered`、`team/task` 在安装产物（`@deepseek-ai` 全家桶）里仅存在于持久化事件 catalog（`known-event-types.ts` 51 类），无任何生产者代码与 payload 类型声明（59 个真实会话实测 0 个 team 事件；team 功能经 dsh-tool-cordis `agentTeams` 服务的运行时内部机制发射，payload 形状未在产物中可见）——**没有 payload 契约就没有转译**，伪造 data 字段违反「不冒充」纪律。写端发一次性 console.log 说明（`N teammate sidechain(s) written as standalone child sessions … content preserved, live-team semantics not translatable`）；kind 往返保真经 header.agentPreset 前缀判定（读端 `decodeSidechain` 按 `teammate/` 前缀还原 `kind==='teammate'`，前缀即引擎私有命名空间，dsh 原生 preset 值不含 `/`，两种 kind 互不污染）
- 外来写端会话骨架（2026-09-05 真机调查，两起 GUI 事故的根因）：
  - **turn/step 生命周期**：GUI 会话视图把同一 `(turn,step)` 的全部 `assistant/message` 折叠为一个 assistant 节点，且 update 语义是**整块替换**（client `assistant-step` 定义 + `fallbackState`）——「全场钉在 1:1、只发一次 start」的旧合成会让整场会话只剩同组最后一条 assistant（通常是裸 tool-call 卡片），agent 文本/thinking 全部不可见。native 形状（真机 41 turn/968 step 实测：**一个 step 恰好一条 `assistant/message`**，`turn/start` 先于人话，`step/end`/`turn/end {turn,reason:{kind:'completed'}}` 成对闭合）→ 外来 IR 落盘按此合成：turn 1 开于首个 surface 行前；**人话（`source.kind==='user'`）关闭当前 turn 并开新 turn**（当前 turn 尚无 assistant 时不关——会话起始注入与首个 prompt 同属 turn 1，同 native）；**每条 `assistant/message` 独占一个 step**；流尾补 `step/end`+`turn/end`。块派生 `tool/call` 行随游标 restamp，toolCalls 桶重发行保留原生坐标绝不 restamp。dsh→dsh（日志自带 `turn/start`）走原样透传，零合成。
  - **同响应合并**：claude 流式转写把一次 LLM 响应拆成共享 `message.id` 的多条 assistant 记录（reasoning/文本/tool_use 各一条）；不合并则同 step 整块替换照样吞内容。写端把**相邻且 `meta.claude.message.id` 相同**的外来 assistant 记录合并为一条 `assistant/message`（usage 取组内最后非空、interrupted 取或）；不相邻（并行 tool_use 与 result 交错）各自成 step，不强行拼接。
  - **子会话身份行**：子代理列表（`dsh-subagent resolveColdIdentity`）对 `values.subagent` 折叠为 null 的子日志返回 diagnostic `corrupt`（GUI 显示「会话记录损坏」），而 identity **只能由 `subagent/descriptor` 事件建立**（`foldSubagentDescriptor`，v2 契约；first-wins：establishing provider 恰好一条）。外来子会话（claude subagent/teammate）源里没有该事件 → 写端在子日志首行补 `{version:2, mode:'one-shot', provider:'migrated', label:<title ?? agentType ?? agentId 截 120>}`（one-shot=「归档记录、不支持续发」，GUI 明确支持查看 one-shot 执行记录）；dsh→dsh 子会话自带 descriptor（unmappedEvents 原样保留），绝不追加第二条。
  - 助手 source 身份按真值提升：claude 源会话写 `provider:'claude', model:<meta.claude.message.model>`（此前误标为引擎默认 `abrdns/GLM-5.3-Flash`）。
