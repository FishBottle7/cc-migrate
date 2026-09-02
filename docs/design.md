# session-migrate：AI 编码工具会话迁移引擎 — 设计文档

> 状态：架构设计 v2（2026-08-28，基于 6 工具真实格式逆向验证）
> 目标深度：**B 级** —— 迁移后的会话像原生 session 一样能 `continue`/`/resume` 接着原任务干，而不只是文本存档。
> 权威细则：`docs/session-formats-audit.md`（6 家总表 + DELTA）与 `docs/agents/*.md`（一 agent 一档）为字节级可 resume 依据，本档为架构与可行性论证。

## 1. 产品定位（一句话）

一个「任意 AI 编码工具 ⇄ 任意」的会话迁移引擎：**核心通用引擎**负责多向转换，**DSH 插件**薄封装引擎，只暴露「任意工具 → DSH」一条线。

```
                 ┌────────────────────────────┐
                 │        session-migrate 引擎       │
                 │     (通用, 任意 ⇄ 任意)         │
                 │                               │
                 │   ┌────────┐   ┌──────────┐   │
                 │   │ 统一IR  │◄─►│ 源/目标适配器 │   │
                 │   │(中间表示)│   │  每个工具一个  │   │
                 │   └────▲───┘   └──────────┘   │
                 └────────┼──────────────────────┘
              (核心层, 无 DSH 依赖)
                          │
        ┌─────────────────┼──────────────────────┐
        │                 │                      │
  ┌─────▼─────┐    ┌─────▼─────┐          ┌──────────────┐
  │ dsh 插件    │    │ Codex     │          │  OpenCode     │
  │(任意→DSH,   │    │ 适配器     │          │  适配器        │
  │ 一等公民)    │    │           │          │              │
  └────────────┘    └───────────┘          └──────────────┘
```

## 2. 为什么 B 级可达（可行性论证 — 已验证）

「像原生一样 resume」靠的是：**把目标工具认识的 session 文件，从字节层面伪造/还原到它自己也能读**。下面每家的最小可伪造集合已按源码锚点锁定：

### 2.1 DSH（已 100% 验证）— 目标最复杂也最可控

**存储位置**：`~/.dsh/sessions/--<projectKey>--/<encodeSegment(id)>/session.jsonl.zstd` 或 `~/.dsh/sessions/_no-cwd/<encodeSegment(id)>/session.jsonl.zstd`（`cwd===undefined` 分支，`format.ts:178`）

- **projectKey**（`format.ts:149`）：`:` `\` `/` 的**连续段压缩为单个 `-`**，安全码元 `A-Za-z0-9._-` 保留（`~` 转义），其余码元 `~XXXX`，去前导 `-`，截 251 字符，包成 `--...--`。例 `D:\codes\dshPlugins` → `--D-codes-dshPlugins--`，`/` → `--root--`。旧版“全部替换为 `-`”已纠正。
- **encodeSegment**（`format.ts:123`）：`.` → `~002E`，`..` → `~002E~002E`，`~` 转义，单射（含孤代理）。
- **文件**：`session.jsonl.zstd` = **多个独立 zstd frame 拼接**，每帧 `ZSTD_c_checksumFlag=1`（`zstd.ts:18`）。
  - frame 0 = header 单行 + `\n`（`assertZstdHeaderFrame:50` 强制恰好一行）
  - 后续每帧 = 一批事件行（`encodeMaterialization:635`）；扫描为**结构化帧解析**（`scanZstdFrames:48` 按 magic `0xFD2FB528` + descriptor + block header + checksum 逐帧界定，尾帧不完整返回 `tornStart`），非简单 magic 搜索。
  - `packChunks` 默认 `true`（`index.ts:39`）：连续 `assistant/chunk` 打包为 `text-chunks`/`reasoning-chunks`/`tool-call-chunks` 存储行（`chunk-rows.ts:9`），读对两种布局兼容。
- **header 行**（`format.ts:35/HeaderLine` + `types.ts:61`）：
  ```json
  {"type":"session","version":0,"id":"session-<uuid>","createdAt":1787844419631,"cwd":"D:\\codes\\dshPlugins","delegationDepth":0,"agentPreset":"standard","parentSession":"session-<parent>","seedLength":123,"origin":"subagent"}
  ```
  必需：`type`/`version:0`/`id`/`createdAt`/`delegationDepth`；可选：`cwd`/`parentSession`/`seedLength`/`origin:"subagent"`/`agentPreset`；退役 `sandboxMode`/`approvalPolicy` 出现即抛错（`format.ts:74`），外来 `version` 直接拒载（`refuseForeignFormatVersion:273`）。
- **事件行**：每条 `seq` 连续递增（`applySurfaceEvent:397` 校验）+ `time` + `data` + 可选 `surfaceOp`/`sourceEventSeqs`。**Surface 合格类型仅三者**（`surface.ts:15`）：`user/message` | `assistant/message` | `tool/result`；`surfaceOp` 为 `append` 或 `{op:'replace',start,end}` 闭区间替换，需 `sourceEventSeqs` 覆盖全部被遮蔽节点（`assertProvenance:211`）。

**模型可见对话 surface** = `foldSurface(events)` 重放 `surfaceOp` 得到 `nodes` + `replacements`，每节点经 `deriveEventMessage` 投影：
- `user/message` → `event.data` 本身（`{content:[{type:'text',text}],role:'user',source}`）
- `assistant/message` → `event.data.message`（`content.length>0` 才进 surface，否则 `null`）
- `tool/result` → `event.data.message`

**发现**：`listArtifacts:488` 仅读首 frame/header（`readFirstZstdLine` + `scanZstdFrames(...,1)`），校验 `header.id` 与路径一致性（含 `realpath` 大小写不敏感），拒绝 `oppositeCompression` 与 `legacy flat-file`。

**结论**：`loadStored(id)` → `foldSurface` → 重建模型上下文。只要在 `<root>/(--<cwd>--|_no-cwd)/<encodeSegment(id)>/session.jsonl.zstd` 写 header frame + 连续 `seq` 的 `surfaceOp:'append'` 事件，即为可 resume 会话；`node:zlib` 原生 zstd 已验证。详见 `docs/agents/dsh.md`。

### 2.2 Claude Code

```
~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
~/.claude/projects/<encoded-cwd>/subagents/agent-<id>.jsonl   # 旁链
```

- **编码**：cwd 中所有非字母数字（`:`, `\`, `/`, `_`, 空格）→ `-`（例 `D:\codes\foo_bar` → `D--codes-foo-bar--`）。
- **记录**：`parentUuid` 链串起 `user`/`assistant`，首尾控制行 `mode`/`last-prompt`（权威形 `{type:'last-prompt', lastPrompt:<≤200 chars>, sessionId}`，无 `leafUuid`，见 `reAppendSessionMetadata`），`message.content` 含 `tool_use`/`tool_result` 块。旁链在 `subagents/agent-*.jsonl`（`isSidechain:true` + `agentId` + 可选 `.meta.json`）。resume 读 jsonl 找最近 leaf。详见 `docs/agents/claude.md`。

### 2.3 Codex（新版权威 `codex-main/codex-rs`，2026-08-29 深查更新）

```
~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>[_<rolloutId>].jsonl[.zst]
~/.codex/archived_sessions/…   +  session_index.jsonl（name→id，append-only）
state_5.sqlite 等               = 从 rollout 回填的派生缓存（引擎不写）
```

- 每行 `{"timestamp","ordinal"?,"type","payload"}`，**11 类记录**：`session_meta`（24 字段 +
  `base_instructions{text,provenance}`；旧 `instructions` 已废）、`response_item`（17 变体，含
  developer 角色与 `reasoning`——仅 `encrypted_content` 可丢）、`event_msg`（持久化子集：turn 边界/
  回滚/设置/usage）、`turn_context`、`world_state`、`compacted`（`replacement_history` = resume 历史
  基点）、`inter_agent_communication`、`security_risk_score`、`realtime_item`。
- 旧版"Responses API 事件流"单一描述作废；全字段映射与写回配方见 `docs/agents/codex.md`。

### 2.4 OpenCode（DB 权威）

```
$XDG_DATA/opencode/opencode.db   # 默认 Global.Path.data = xdgData/opencode
~/.local/share/opencode/opencode.db  # Linux 展开
opencode-<channel>.db / $OPENCODE_DB / $OPENCODE_TEST_HOME  # channel 隔离与覆盖见 database.ts:path()
```

- **`opencode.db` 单一权威**，`storage/{session,message,part}/*.json` 为 v1 遗留（`MessageTable`/`PartTable` 仍双写兼容但 loader 不再以其为真理）。
- **正文权威**：`session_message` 序列表（`id`/`session_id`/`type`/`seq` `UNIQUE(session_id,seq)`/`data: Omit<Encoded,"id"|"type">`/`time_*`，按 `seq ASC` 排序）；`SessionHistory.load` 按 `latestCompaction.seq` + `session_context_epoch.baseline_seq` 做 compaction 感知加载（`history.ts:30`）。
- **最小写集**（同一 DB 事务，`WAL`/`FK=ON`/`busy_timeout=5000`）：`project` + `session`（`directory` 绝对路径）+ `session_message`（`seq` 0..N-1 连续，`id=msg_*`）(+ 可选 `session_context_epoch` / `event`/`event_sequence`)。可外部伪造（`better-sqlite3`/Drizzle 直写），需命中正确 `path()` 并符合 `msg_*` 校验。详见 `docs/agents/opencode.md`。

### 2.5 Pi（已落盘，单文件树）

```
~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl
```

- **编码**：`cwd` 去前导 `/`/`\` 后 `/` `\` `:` 全换 `-`，包 `--...--`（`session-manager.ts:479`，不做 `~XXXX` 转义）；文件名 `<ISO-ts 换 - >_<uuid>.jsonl`（`uuidv7`）。
- **JSONL 树**：首行 `session` header（`version:3` 当前，`CURRENT_SESSION_VERSION=3`），后续 `id`（8-char hex，`randomUUID slice 0,8` 碰撞重试）+ `parentId`（首条 `null`）的 entry 树；`leafId` 指针 + `branch`/`branchWithSummary`/`resetLeaf`/`createBranchedSession`。
- **Entry 类型**：`message`(`AgentMessage`: `user`/`assistant`/`toolResult`/`bashExecution`/`custom`/`branchSummary`/`compactionSummary`) | `compaction`(摘要+`firstKeptEntryId`+`tokensBefore`+可选 `retainedTail?:AgentMessage[]` 自包含 checkpoint) | `branch_summary` | `custom_message` | `model_change`/`thinking_level_change` | `custom` | `label` | `session_info`。Context 经 `buildContextEntries`/`buildSessionContext:418` 压缩感知重建。
- **发现**：`SessionManager.list(cwd)` 扫 `sessions/--<path>--/*.jsonl`，并发 10，仅读首行 header（`readSessionHeader:572`，4KB 块 + 1MB 扫描上限）。
- **落盘守卫**：首个 `assistant` 前不落盘（`_persist:1016` 的 `hasAssistant`/`flushed` 状态机），无 assistant 仅内存态。覆盖：`PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` / `--session-dir` / `settings.json:sessionDir`（`config.ts:520`）。详见 `docs/agents/pi.md`。

### 2.6 Cursor / Windsurf

未放入源码，未落盘到本机扫描范围，标记 `unknown` 占位（`docs/agents/cursor-windsurf.md`），`Adapter` 按 `no-op` 暴露。

> 四家单文件（DSH/Codex/Claude/Pi） + 一家 DB（OpenCode）已覆盖 `任意⇄任意` 的已验证矩阵；`session-formats-audit.md` 并有最小可伪造字段与 DELTA。

## 3. 统一中间表示（IR）设计

要让 `任意 ⇄ 任意` 只用 N 个适配器（而非 N² 个写死转换），必须有中立 IR。基于对 DSH surface 的验证，IR 为「**无损对话流水线**」—— 核心是跨工具可续的流水线，DSH 侧 v3 做到除加密外 100% 无损（`docs/plans/ir-v3-lossless-100.md`）：

```ts
// ir.ts  (v3 — schemaVersion: 2，见源码 ir.ts)
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'thinking'; thinking: string };

interface MigratedMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: ContentBlock[];
  timestamp?: number;
  provider?: string; model?: string; stopReason?: string;
}

interface MigratedSidechain {
  agentId: string;          // 目标工具侧的 agent 文件名 key（如 Claude agent-<id>.jsonl）
  kind: 'subagent' | 'teammate';
  agentType?: string;       // 原始 sub-agent 类型/preset，按需透传
  parentMessageId?: string;
  messages: MigratedMessage[];  // 分支内单调对话，新到旧
}

interface MigratedSession {
  schemaVersion: 2;
  originTool: ToolId;       // 'codex'|'claude'|'opencode'|'dsh'|'pi'|'unknown'
  originSessionId?: string;
  title?: string;           // DSH session/title | Pi session_info.name | codex session_index.thread_name
  createdAt?: number;
  cwd?: string;             // 原工作目录 → 目标适配器重映射
  model?: { provider?: string; id: string; variant?: string };
  thinkingLevel?: string; systemPrompt?: string;  // 源 base 系统提示词（见下方「系统提示词选择规范」）
  messages: MigratedMessage[];   // 按序，主链（v3.1 role 可为 'developer'）
  sidechains?: MigratedSidechain[]; // 旁链/子代理分支（完整搬运文件，非折叠文本）
  compaction?: MigratedCompaction[]; // v3.1 += replacementHistory? / meta?
  branchSummaries?: Array<{ fromId: string; summary: string }>;
  goals?: MigratedGoal[]; planModes?: MigratedPlanMode[]; todos?: MigratedTodo[]; // typed lossless (DSH)
  unmappedEvents?: MigratedUnmappedEvent[]; // 源 harness 事件日志（v3.1 泛化：DSH 事件/codex event_msg）
  meta?: Record<string, unknown>;   // v3.1 会话级适配器命名空间原生载荷（{codex:{sessionMetaLine,…}}）
  extensions?: Record<string, unknown>; raw?: unknown;
}
```

> v3 语义：`agent→IR` 零丢弃（除 `encrypted_content/encrypted` 占位 `[encrypted omitted]`），`goal/change→goals`、`plan/mode→planModes`、`todo/write→todos`、`session/title→title`，其余 `~40` 类 `known-event-type` 进 `unmappedEvents`（含 `surfaceOp/sourceEventSeqs`）；`IR→DSH` 按 `time` 合并重排 `seq 0..N-1` 全量保留，`IR→Claude/Codex/OpenCode/Pi` 按目标能力丢弃领域桶（见 `docs/plans/ir-v3-lossless-100.md §2.4`）。
>
> **v3.1 增量**（2026-08-29，codex 调查驱动，全部可选字段；登记与需同步适配器见 `docs/ir-protocol.md` §v3.1）：`MessageRole += 'developer'`；`MigratedSession.meta`（会话级命名空间原生载荷）；`compaction[].replacementHistory/meta`；`unmappedEvents` 泛化为源 harness 事件日志。

**系统提示词选择规范**（引擎级选项 `source` / `target`，2026-08-29 成文，机制细节 `docs/agents/codex.md` §7）：

1. **单一系统提示词原则**：目标端 canonical system-prompt 槽位里只放一份提示词。严禁把源系统提示词以 user/developer 消息形式**叠**在目标自己的系统提示词之上——两份系统提示词互相稀释指令，会劣化 agent 表现（codex resume 源码也证实其自身就是"config 覆盖 > 记录值 > 渲染默认"三选一，从不叠加）。
2. `source`：源方提示词写入目标的 canonical 槽位（codex → `base_instructions{provenance:custom}`；claude → system prompt；dsh/zcode → 各自 systemPrompt 载体）。
3. `target`：目标用自己原生提示词开场（codex → 不写 base_instructions，resume 回退渲染默认）。
4. **项目文档（AGENTS.md/CLAUDE.md）不参与本选项**：它们是 user 角色消息，随 messages[] 走。跨项目迁移时旧项目文档会成为历史噪音（codex 有 replace-diff 机制兜底），UI 需提示。
5. harness 运行时上下文（codex `<environment_context>`/`<permissions instructions>`/world_state、DSH runtime snapshot）默认视为 `synthetic` 注入内容：默认丢弃由目标自查自建，opt-in 才原样保真；**永远不**当作系统提示词搬运。

**设计要点**：IR 是「对话流水线」而非「事件日志」。不同工具内部状态机各异（DSH turn/step/compaction、Claude parentUuid 链、Codex Responses 流、Pi 树+compaction、OpenCode seq 序），跨工具**无损上限为消息级**，DSH↔DSH 额外做到领域状态 100% 无损。这是诚实边界：B 级 = 消息上下文 + 工具调用历史完整保留，目标工具能接着对话继续思考、继续调工具。

**子代理/旁链约定**（用户已选“完整搬运旁链子代理文件”）：

| 工具 | 原生形态 | IR 映射 |
|------|----------|---------|
| Claude | `subagents/agent-<id>.jsonl`（`isSidechain:true`）+ `.meta.json` | `sidechains[]` 每项一文件，`agentId` 保留，`agentType` 透传 |
| DSH | 独立 session 文件经 `parentSession`/`agent/inbox/spliced` 关联 | `sidechains[]` 或独立 session（`parentSession` 链），按目标 DSH 布局落盘 |
| Codex | 独立兄弟 rollout 文件，`session_meta.source = subagent.thread_spawn{parent_thread_id, depth, agent_path, agent_nickname}` + `parent_thread_id` 双重关联 | `sidechains[]`（agentId=threadId, agentType=agent_role）或独立会话 + `meta.codex` 链路，见 `docs/agents/codex.md` §8 |
| Pi | 同一文件树内分支（`branch`/`leafId`，`branch_summary`/`compaction`） | `sidechains[]` 暂不主用，分支在单文件内用 `parentId` 树表达 |
| OpenCode | `session.parent_id` 自引 | 隐式父子，`sidechains` 预留 |

推理默认丢弃，可配置保留 summary；保真度无上限、无限接近原生。

**适配器职责**（每工具一个，面向 CLI/插件/GUI 共用）：

- `Adapter.listSessions(root?) → SessionMeta[]`（标题/时间/id，供选择列表）
- `Adapter.preview(ir) → string`（离线预览，无需 LLM）
- `Adapter.parse(sessionId, root?) → MigratedSession`（读发言，含 sidechains）
- `Adapter.write(ir, opts) → WriteResult`（写回可 resume 文件，`targetCwd`/`sessionId` 可覆盖）
- `Adapter.resolveCwd?(targetRoot)`（cwd 重映射，目标适配器实现）

> GUI/engine 依赖这 5 个接口，三种前端（DSH 插件、独立 App、CLI）共用同一套 core。

## 4. 目录结构（monorepo）

```
D:\codes\dshPlugins\cc-migrate/
├── packages/core/                  # 引擎核心（无 DSH 依赖，Node ESM，零运行时依赖）
│   └── src/
│       ├── ir.ts                   # 统一 IR 类型 + 校验（含 MigratedSidechain）
│       ├── registry.ts             # 适配器注册表
│       ├── migrate.ts              # 编排：list/preview → parse → ir → write
│       └── adapters/
│           ├── dsh/                # DSH（zstd 拼接帧 + surface + _no-cwd）
│           ├── claude/             # Claude Code（jsonl 链 + sidechains）
│           ├── codex/              # Codex（rollout + session_index）
│           ├── opencode/           # OpenCode（db，读写端已按实库 v1.18 形状落地）
│           └── pi/                 # Pi（JSONL 树，Phase 2）
│
├── packages/cli/                   # CLI（任意 ⇄ 任意，脚本友好）
│   └── src/index.ts                # `session-migrate list/preview/migrate/demo`
│
├── packages/ui/                    # 跨端可复用 Vue 3 组件
│   └── src/components/             # SessionPicker / SessionPreview / MigrateWizard
│
├── apps/
│   ├── dsh-plugin/                 # DSH 插件（薄封装 core，只做 任意→DSH）
│   │   ├── src/index.ts
│   │   ├── plugin.json             # DSH cordis 插件元数据
│   │   └── package.json
│   └── desktop-app/                # 独立跨平台 App（任意 ⇄ 任意，Electron + Vue 3）
│       ├── src/main/               # Electron 主进程（Node，直接 import core）
│       ├── src/renderer/           # 渲染进程（复用 packages/ui）
│       └── package.json
│
├── docs/
│   ├── design.md                   # 本文档
│   ├── session-formats-audit.md    # 6 家格式全报告（含 DELTA，v2）
│   └── agents/                     # 一 agent 一档（权威锚点 + 最小可伪造集）
│       ├── README.md               # 索引
│       ├── dsh.md
│       ├── claude.md
│       ├── codex.md
│       ├── opencode.md
│       ├── pi.md
│       └── cursor-windsurf.md      # unknown 占位
└── package.json                    # workspace root
```

## 4.1 产品矩阵与技术栈

| 端 | 面向 | 框架 | 排期 |
|---|---|---|---|
| **CLI** | 脚本/高级用户 | Node CLI | Phase 0 起 |
| **DSH 插件** | DSH 用户（嵌入现有 GUI） | cordis 插件，前端复用 `packages/ui` | Phase 3 |
| **独立 App** | 所有 AI 工具用户 | Electron 主进程(Node) + Vue 3 渲染进程 | Phase 4 |

- **core / CLI / desktop-app 主进程**：TypeScript ESM for Node（`node:zlib` 原生 zstd，已验证，Node ≥22）。
- **渲染层**：Vue 3（DSH 前端同生态，`packages/ui` 可跨端复用）。
- **Electron 选型**：需原生文件系统访问（写目标工具存储目录）+ 直接复用 Node core，Tauri/纯 Web 短板；远期备选 Tauri。
- **不引入后端**：全部本地文件操作，无 server 依赖。

## 5. DSH 插件形态（任意→DSH 一等线）

DSH 插件 = `core` 的薄消费者。命令示例：

- `/session-migrate import claude <path或jsonl> [--cwd D:\xxx]` → 把一条外部对话写成 DSH 可 resume 的 session
- `/session-migrate list-sources` → 扫描各工具可用的历史会话，供 GUI/CLI 挑选

插件内独有映射（目标固定为 DSH）：

- `cwd` 重映射：源 cwd → 用户选的 DSH 工作区（`projectKey`/`_no-cwd` 分支）
- `request/header`：注入当前 agent 的 provider/model（不伪造旧的）
- 工具调用历史：作为 `tool/call` + `tool/result` 写入（`surfaceOp:'append'`），resume 后副作用不可重放但上下文完整
- 新 session id 用 `crypto.randomUUID()`，`delegationDepth:0`，`agentPreset:'standard'`

## 6. 首版（MVP）任务拆分

**Phase 0 —— 骨架与 DSH 线验证（最小可 endpoints）**
1. monorepo 初始化（pnpm workspace：core + cli + plugin）✅
2. `core/src/ir.ts` 类型（含 `MigratedSidechain`）✅
3. DSH 适配器 `parse`：解 zstd → 解析 header + `foldSurface` 出 messages（`node:zlib`，不依赖 DSH 内部包）✅
4. DSH 适配器 `write`：IR → 合法 `.jsonl.zstd`（header frame + 事件序列），落盘到 `~/.dsh/sessions/` ✅
5. **验收**：写入假会话 → DSH `/resume` 读回并继续 ✅（`--dst-root` 临时目录验证不污染真实 `~/.dsh`）
6. CLI `migrate --from dsh --to dsh --demotest` 自环 round-trip ✅

**Phase 1 —— Claude Code 打通**
7. Claude 适配器 parse/write（`encoded-cwd` + `parentUuid` 链 + `last-prompt` + `subagents/agent-*.jsonl` sidechains）✅
8. CLI 支持 `claude <-> dsh` 双向 ✅
9. 验收：DSH → Claude 目录 → `claude --resume` 能续；反向同理 ✅

**Phase 2 —— Codex + OpenCode + Pi**
10. 依据审计把 Codex rollout / OpenCode db / Pi 树格式定死（Codex 已适配 codex-main 增量：ResponseItem/FunctionCallOutput/SessionMeta/rollout zst/本地时间；OpenCode 2026-09-02 真实写采样复核完成——v1.18 实库正文权威 message/part、`session_message` 为空、写端形状逐列核对通过、`session.path` 语义修正；Pi v3.3 重写落地）— 全部 ✅
11. Codex / OpenCode / Pi 适配器 parse/write（Codex ✅，OpenCode/Pi 待落盘）
12. CLI 支持全矩阵 `任意 <-> 任意`；`list`/`preview` 齐全（Codex/Claude/DSH 已齐）

**Phase 3 —— DSH 插件打包 + GUI 集成**
13. ✅ 把 core 打进 DSH 插件（`apps/dsh-plugin`，cordis 薄封装）：注册 `/session-migrate list-sources|preview|import` 三命令 + `cordis.patch.yml` bundle 行 + 冒烟测试（mock ctx 全绿、import 恒 mint 新 id 不覆盖）。命令层与宿主解耦（结构类型 PluginContext，零 cordis 依赖）；GUI 接入点已在 `apply(config)` 预留
14. ✅ 建 `packages/ui`（SessionPicker / SessionPreview / MigrateWizard，Vue 3）
15. ✅ DSH GUI 向导（2026-09-03）：`apps/dsh-plugin/src/gui.ts` 挂载层——`GuiHost` 协议（mount + 三条数据通道，结构类型最小假设）桥接 ui 的 `MigrateWizard`（整用组件状态机，与 desktop-app 同款 `MigrationBackend` 契约）；GUI 层零 core import（沙箱纪律），目标钉死 any→dsh；无头协议冒烟 10 节全绿（挂载/dispose/数据通道真实走命令层/非 dsh 目标拒绝/可选服务降级）。真机宿主联调清单见 `apps/dsh-plugin/README.md`（容器形状、ui 打包、主题注入、IPC 转发）

**Phase 4 —— 独立 App（Electron）**
16. ✅ 初始化 `apps/desktop-app`（Electron 主进程 import core + Vue 3 渲染进程复用 `packages/ui`）
17. ✅ 完整 GUI 向导：选源/目录 → 浏览会话 + 离线预览 → 配置目标 + cwd 映射 → 一键写入
18. ✅ 跨平台打包分发（2026-09-02/03 落地 Windows 本机构建）：electron-builder——nsis 安装包 + portable + dir 三 target（88MB/88MB/318MB 实测产出）；打包核心约束成立（worker + core asarUnpack 到真实文件系统，系统 Node 加载——zstd 崩溃规避架构在打包形态完整成立，打包 exe 真解析 2011 条消息大 DSH 会话通过）；**应用图标**（2026-09-03：`gen:icon` 纯 JS 生成 SDF 栅格化 + 手写 PNG/ICO/ICNS 容器，零图像依赖，幂等；dist-check 字节级验证图标进包，负例旧包正确 FAIL）；**dist:win:check 一键链**（出包→产物齐全→冒烟→图标校验→汇总表）；mac(dmg)/linux(AppImage) 配置就绪未本机构建；代码签名/自动更新待配

**Phase 5 —— 健壮性**
19. ✅ 工具调用 id 重映射（2026-09-03，dsh 写端席位制：同会话重复 tool_use id 换 `call_<uuid>`、配对 result 同步 FIFO 重映射、乱序 IR 回退首席位无孤儿；IR 保持源值零丢弃——测试含乱序/交叉配对探针）+ ✅ 会话 id 碰撞防护（显式 `--session-id` 冲突即抛错拒绝（对齐 zcode UNIQUE 纪律），引擎自生成走 claim，`wx` 独占创建封 TOCTOU——AGENT.md「永不覆盖」铁律的写端卡点，5 项 `dsh-robustness.test`）；cwd 迁移、模型映射已随各适配器 resolveCwd/模型透传落地
20. 测试矩阵 + 损坏文件容错 + 幂等（不重复导入）（幂等 = 写端碰撞防护：显式 id 冲突拒绝 + wx 兜底，2026-09-03 随第 19 项落地）+ ~~OpenCode 真实写采样复核~~（✅ 2026-09-02 完成）——残余：更广的损坏文件容错测试矩阵（claude 读端已容忍断行，其余各家按需补）

## 7. 诚实的边界与风险

- **「原生 resume」≠「复现执行副作用」**：迁移后能接着对话往下聊、能重新调工具，但**不会**自动重跑之前的命令/文件改动（除非记录完整 shell trace 并重放，属执行沙箱范畴，超出对话迁移）。
- **工具版本漂移**：每家格式会随版本变化（Codex 已从纯 JSONL 迁到 `rollout_<id>.jsonl.zst` + `ResponseItem` 增量；DSH 50 种事件类型新增不 bump `version`）。适配器按 `version`/格式特征探测并拒绝不认识的版本而非静默损坏。
- **OpenCode 的 DB 单一权威**：按 `database.ts:path()` 命中正确库。v1.18 实库正文权威是 `message`+`part`（`session_message` 为空），写端按实库形状事务写 `project`+`session`+`message`+`part`；`session.path` 为 worktree 相对路径、git 根为空串（2026-09-02 采样修正）。`storage/*.json` 不可作真理。
- **Pi 的首 assistant 守卫**：`_persist:1016` 在首个 `assistant` 前不落盘，迁移时需保证至少一条 assistant 否则文件不创建。
- **不碰真实数据**：默认 dry-run + 输出到临时目录（`--dst-root`），用户确认后才写目标工具原地存储；DSH 写用新 session id，绝不覆盖已有会话。

## 8. 下一步

A. `session-formats-audit.md` v2 已扩到 6 工具（含 DELTA vs 旧版）并拆出 `docs/agents/*.md` 一 agent 一档。
B. 产品矩阵已定：CLI + DSH 插件 + **独立 App（Electron）**三端共用 core；技术栈 = TypeScript/Node(core) + Vue 3(渲染)。
C. **验证**：`cd packages/core; pnpm run build && node --test --test-isolation=none dist/test/*.test.js`（必须 `--test-isolation=none`，否则 sandbox EPERM）；`pnpm -r --sort build` 会 EPERM，逐包 build；`cli` 用 `node dist/index.js list/preview/migrate --root <tmp>` 验证真实数据，不污染 `~/.dsh`/`~/.claude`/`~/.codex`。
D. `Pi` 适配器（✅ v3.3 重写）与 `OpenCode` 真实写采样复核（✅ 2026-09-02）均已完成。Phase 3 插件骨架（`apps/dsh-plugin`，三命令 + 冒烟）与 Phase 4 Windows 打包（electron-builder 实测出包）已落地——剩余：DSH GUI 向导组件挂载（Phase 3 第 15 项）、mac/linux 真机构建、签名/自动更新。
