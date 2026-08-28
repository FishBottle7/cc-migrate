# 6 家 AI 编码工具会话存储格式审计（基于真实数据逆向）

> 状态：完整（v2，2026-08-28 增补 DSH/OpenCode/Pi 的权威源码锚点 + DELTA）。
> 全部字段基于本机真实文件 + 三套新放入的权威源码（`deepseek-harness-master` / `opencode-dev` / `pi-main`）交叉验证，未依赖文档假设。
> 目的：为会话迁移引擎提供「字节级构造可 resume session」的最小字段集，并记录与旧版审计的 DELTA。
> 旧版：v1（4 家）见 git 历史；本版扩到 6 工具（新增 Pi，Codex 已按 `codex-main` 增量更新）。

## 0. 总览表

| 工具 | 权威存储 | 记录格式 | 单文件 or 关系 | resume 方式 | 最小可伪造性 |
|------|---------|---------|--------------|------------|-------------|
| **DSH** | `~/.dsh/sessions/--<proj>--/<id>/session.jsonl.zstd`（或 `/_no-cwd/<id>/`） | 事件日志（zstd 拼接帧，可选 `packChunks` 打包 `text-chunks` 行） | 单文件+顺序 seq | `loadStored`→`foldSurface`→`deriveEventMessage` | ✅ 已 round-trip |
| **Codex** | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl[.zst]` | OpenAI Responses API 事件流 | 单文件 + `session_index.jsonl`（仅 name→id 索引） | 读 rollout 重建 | ✅ 公开格式 |
| **Claude Code** | `~/.claude/projects/<编码路径>/<uuid>.jsonl` | Anthropic JSONL 消息流（`parentUuid` 链 + 末尾 `last-prompt`） | 单文件（首尾控制行）+ `subagents/agent-*.jsonl` | 读 jsonl 找 leaf | ✅ 结构简单 |
| **OpenCode** | `~/.local/share/opencode/opencode.db`（`$XDG_DATA/opencode/opencode.db`，channel 变体见 `database.ts:path()`）| SQLite（Drizzle）权威；会话正文在 `session_message` 序列表 | 关系（`session` + `session_message` + `session_context_epoch` + `project` + `event`）| `SessionHistory.load(sessionID)` 读 `session_message` 按 seq 排序，compaction 感知 | ⚠️ 需 DB 事务写 3+ 表，无文件镜像 |
| **Pi** | `~/.pi/agent/sessions/--<path>--/<ts>_<uuid>.jsonl` | JSONL 树（`id`/`parentId` 8-char hex，`leafId` 指针）| 单文件，树在文件内 | `SessionManager.open(path)` / `continueRecent(cwd)` 读树→`buildSessionContext()` | ✅ 单文件，易伪造（需首个 assistant 才落盘）|
| **Cursor / Windsurf** | 未落盘到本机扫描范围（本次未放入源码）| — | — | — | `unknown`（占位）|

> 关键洞察：**DSH/Codex/Claude/Pi 四家都有一条单一权威文件线**（zstd 拼接 / rollout / jsonl / Pi JSONL 树），**OpenCode 是唯一 DB 权威**。因此 `任意⇄任意` 的 IR 只需保住 `role + content 块 + 工具调用 + cwd + model` 五元组即可无损覆盖前四家；OpenCode 需 DB 适配器单独处理。

---

## 1. DSH — `session.jsonl.zstd`

> 源码锚点：`deepseek-harness-master/packages/session/session-persistence-jsonl/src/format.ts`、`src/zstd.ts`、`src/index.ts`、`packages/core/session/src/types.ts`、`src/surface.ts`

### 存储位置

```
<root>/--<projectKey>--/<encodeSegment(id)>/session.jsonl.zstd   # cwd 有值
<root>/_no-cwd/<encodeSegment(id)>/session.jsonl.zstd             # cwd === undefined
```

- `root` = 持久化配置的 `root`（默认 `~/.dsh/sessions`），**解析一次后冻结**，不跟随 `process.cwd()` 漂移（`JsonlSessionPersistence:153`）。
- `projectKey(cwd)`（`format.ts:149`）：把 `:`, `\`, `/` 的**连续段**压缩为单个 `-`，安全码元 `A-Za-z0-9._-` 保留（`~` 本身转义），其余码元转 `~XXXX`，去前导 `-`，截 251 字符，包成 `--...--`。例 `D:\codes\dshPlugins` → `--D-codes-dshPlugins--`，`/` → `--root--`，空串抛错。
- `encodeSegment(id)`（`format.ts:123`）：`~` 也转义，`.` / `..` 特判为 `~002E`，单射于全部 UTF-16（含孤代理）。
- `sessionDir` / `logPath` 见 `format.ts:178/203`；文件名固定 `session.jsonl.zstd`（`compression:'zstd'`，默认）或 `session.jsonl`（`'none'`）。

### 物理格式

**一个文件 = 多个独立 zstd frame 拼接**，每帧 `ZSTD_c_checksumFlag=1` 独立压缩（`zstd.ts:18`）。

- frame 0 = **header 一行**（`JSON.stringify(toHeaderLine(header)) + '\n'`），必须是**恰好一行**且以 `\n` 结尾（`assertZstdHeaderFrame:50`）。
- 后续每帧 = 一批事件行（`eventLines(events, packChunks) + '\n'`），`packChunks`（默认 `true`）会把连续 `assistant/chunk` 打成 `text-chunks`/`reasoning-chunks`/`tool-call-chunks` 存储行（`format.ts:223`）；读取对两种布局都兼容（`scanLog` 统一经 `decodeStorageRecord`）。
- 扫描用**结构化帧解析**（`zstd.ts:scanZstdFrames`）：按 magic `0xFD2FB528` + descriptor + block header 逐帧界定，尾帧不完整时返回 `tornStart` 供修复；不是简单的 magic 字节搜索。

### Header 行（`format.ts:35/HeaderLine` + `types.ts:61/SessionHeader`）

```json
{"type":"session","version":0,"id":"session-<uuid>","createdAt":1787844419631,"cwd":"D:\\codes\\dshPlugins","parentSession":"session-<parent>","seedLength":123,"origin":"subagent","delegationDepth":1,"agentPreset":"standard"}
```

必需/可选（`toHeaderLine:53` / `fromHeaderLine:73` / `isHeaderLine:91`）：

| 字段 | 必需 | 说明 |
|------|------|------|
| `type` | ✅ | 固定 `"session"` |
| `version` | ✅ | `SESSION_FORMAT_VERSION`（当前 `0`，`packages/core/session/src/types.ts:56`）。**外来版本直接拒载**（`refuseForeignFormatVersion:273`） |
| `id` | ✅ | `SessionId`（brand string） |
| `createdAt` | ✅ | 非负 safe int，epoch ms，`-0` 非法 |
| `delegationDepth` | ✅ | 非负 safe int，顶层 0，子代理 = parent+1（用于递归预算跨重启） |
| `cwd` | 可选 | 缺省进 `_no-cwd`；有则参与 `logPath` 计算 |
| `parentSession` | 可选 | fork/seed 链的父 session id |
| `seedLength` | 可选 | 继承事件数（resume/fork 时区分父历史与子增量） |
| `origin` | 可选 | 仅允许 `"subagent"`（子代理会话的展示分类，非 continuable 证明） |
| `agentPreset` | 可选 | 组成该 session 的 agent preset id（决定工具与提示词，resume 需一致）|

> **退役字段**：`sandboxMode` / `approvalPolicy` 若出现在 header 直接抛错（`fromHeaderLine:74`）。

### 事件行

每条事件含**连续 `seq`**（从 0 递增，`applySurfaceEvent:397` 校验）+ `time`(epoch ms) + `data` + 可选 `surfaceOp` / `sourceEventSeqs`。

- **Surface 合格类型**仅三者（`surface.ts:15`）：`user/message` | `assistant/message` | `tool/result`。只有它们可携 `surfaceOp` 与 `sourceEventSeqs`，其余事件携了直接抛错（`surfaceOpOf:188`）。
- `surfaceOp`（`types.ts:364`）：`'append'`（追加到尾）或 `{op:'replace', start, end}`（替换 surface 上 `[start,end]` 闭区间，需 `sourceEventSeqs` 含全部被遮蔽 seq，`assertProvenance:211`）。compaction 用 `replace` 实现“摘要替换旧范围”。
- `sourceEventSeqs`：引用的**更早** seq，去重、非空（除 `assistant/message` 可空数组表示已知空流）。
- 其余事件（`turn/start`、`turn/end`、`step/start`/`end`、`assistant/chunk`、`request/header`/`request/context`、`session/end-seed`、`tool/call` 等）是**log-only**，不进 surface。
- `assistant/message` 若 `content.length===0` 则 `deriveEventMessage` 返回 `null`（仅为承载 usage 的空消息，不进模型上下文）。

### 模型可见对话 surface（resume 真正喂给模型的）

`foldSurface(events)` 按 seq 重放 `surfaceOp`，得到 `nodes: number[]`（model-visible 顺序）+ `replacements`。每节点经 `deriveEventMessage` 投影：

- `user/message` → `event.data` 本身即 `UserMessage`（`{content:[{type:'text',text}], role, source:{kind:'user'|'plugin'|...}}`）
- `assistant/message` → `event.data.message`（`content.length>0` 才 surface）
- `tool/result` → `event.data.message`

### 列表发现（`index.ts:listArtifacts:488`）

扫描 `<root>` 下所有 project 目录 → session 目录，**仅读首 frame/header 行**（`readFirstZstdLine` / `readFirstLine`），不解析全日志；校验 `header.id` 与路径一致性（含大小写不敏感 `realpath` 比对）；拒绝 `oppositeCompression` 混用与旧 `flat-file` 布局；重复 id 抛错。

### 构造可 resume 会话的最小集合（供迁移引擎）

写一个拼接 zstd 文件到 `<root>/_no-cwd 或 --<cwd>--/<encodeSegment(id)>/session.jsonl.zstd`：

1. header frame（`type:'session', version:0, id, createdAt, delegationDepth:0, cwd?, parentSession?, seedLength?, origin?, agentPreset?`，单行 `\n`）
2. 事件 frame：若干 `user/message` + `assistant/message` + `tool/result`（均带 `surfaceOp:'append'`，seq 从 0 连续；`assistant/message` 需 `content.length>0`）
3. 可选 `turn/start`/`turn/end`、`tool/call` 等 trace 事件（log-only，不影响 surface）

> **DELTA vs 旧版审计**：
> - 旧版未提 `seedLength`、`origin`/`parentSession` 的校验与语义（本版补齐，见 `types.ts:75/85`）。
> - 旧版未提 `_no-cwd` 分支（`cwd===undefined` 时的 project 目录）。
> - 旧版将 `projectKey` 描述为“`:` `\` `/` 全替换为 `-`”，本版纠正为“**连续分隔符压缩为单个 `-`** + 去前导 `-` + 251 截断”（`format.ts:149`）。
> - 旧版 `scanZstdFrameRanges` 用 magic 搜索启发式，本版纠正为**结构化帧解析**（descriptor / block header / checksum 校验，`zstd.ts:48`）。
> - 旧版未提 `packChunks` 打包行（`text-chunks`）与读写兼容性。
> - 旧版未提 `list` 仅读 header 行的规模优化与 `oppositeCompression` / `legacy flat-file` 拒绝。

---

## 2. Codex — `rollout-<ts>-<id>.jsonl`

> 源码锚点：`codex-main/codex-rs`（`core/src/rollout/list.rs:379`、`protocol/src/protocol.rs:2975`、`protocol/src/models.rs:975`、`core/src/rollout/session_index.rs`）

### 存储位置

```
~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<sessionId>.jsonl[.zst]
```

按创建时间分层：`2026/01/12/rollout-2026-01-12T20-55-48-019bb246-....jsonl`。
另有 `history.jsonl`（每行 `{session_id, ts, text}`，仅用户消息索引，非权威）。
SQLite（`logs_2.sqlite` 等）主存日志/记忆，会话正文在 rollout jsonl。**权威 = rollout jsonl。**

### 记录格式（OpenAI Responses API 事件流）

每行一个 JSON，`{"timestamp","type","payload"}`：
- **type=`session_meta`**（首行）payload 含：`id`, `session_id`（新）、`timestamp`, `cwd`, `originator:"codex_cli_rs"`, `cli_version`, `source`, `model_provider`, `instructions`(系统提示/AGENTS.md), `git`。
- **type=`response_item`** payload 是 Responses API 对象：
  - `{type:"message", role:"user"|"assistant", content:[{type:"input_text"|"output_text", text}]}`
  - 另有 `function_call`, `function_call_output`, `reasoning`, `computer_call`, ... (工具/RAG)

### 构造可 resume 会话

写一个 rollout jsonl：
1. `session_meta`（新 id、cwd、instructions、`cli_version`）
2. 若干 `response_item` message（developer/user/assistant），内容块用 `input_text`/`output_text`
3. 放在 `~/.codex/sessions/<YYYY/MM/DD>/` 下，文件名 `rollout-<ts>-<newId>.jsonl`
4. 在 `~/.codex/session_index.jsonl` 追加一行 `{"id":"<thread_id>","thread_name":"<标题>","updated_at":"<ISO8601>"}` 供 `codex resume` 列表搜到
> SQLite 角色确认：`logs_2.sqlite`=仅应用日志；`queue_1.sqlite`=上报/同步队列；`goals_1.sqlite`/`memories_1.sqlite`=运行时状态；`state_5.sqlite`=运行期线程树（被进程持锁）。**盘中权威 = rollout 文件**，DB/索引可增量重建。伪造难度：低。

---

## 3. Claude Code — `projects/<编码路径>/<uuid>.jsonl`

### 存储位置

```
~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
```

- **编码规则（已验真）**：不是 base64。把 cwd 中所有**非字母数字字符**（`:`, `\`, `/`, `_`, 空 等）替换成 `-`。
  例 `D:\codes\flutterProjects\focus_me_full\focus_me` → `D--codes-flutterProjects-focus-me-full-focus-me`。
- 文件名 = sessionId uuid。每个 project 目录可多个 jsonl（主 + sidechains/子代理在同一目录）。

### 记录格式（每条一行 JSON，归档权威 = 单文件）

最小 resume 所需典型行：
```json
{"type":"mode","mode":"normal","sessionId":"55dded76-..."}
{"type":"user","parentUuid":"...","isSidechain":false,"promptId":"...",
 "message":{"role":"user","content":"提问文本..."},"isMeta":false,"uuid":"...","timestamp":"...",
 "userType":"ant","entrypoint":"cli","cwd":"D:\\...","sessionId":"55dded76-..."}
{"type":"assistant","parentUuid":"...","message":{"role":"assistant","content":[...]},
 "responseId":"...","uuid":"...","timestamp":"...","sessionId":"55dded76-..."}
{"type":"last-prompt","leafUuid":"<末条 user 的 uuid>","sessionId":"55dded76-..."}
```
- **首尾是控制行**：开头可选 `mode`/`permission-mode`；**末尾必有 `last-prompt`，`leafUuid` 指向当前等待继续的叶子 user 消息**。
- 中间是 `user`/`assistant` 链，`parentUuid` 串起父子关系；`message.content` 支持文本块 + `tool_use`/`tool_result` 块。
- `file-history-snapshot` 行记录文件快照，**可省略/空，不影响基础 resume**。

### 构造可 resume 会话

写一个 jsonl，文件名 `<uuid>.jsonl`放在 `~/.claude/projects/<编码cwd>/`：
1. 若干 `system`/`user`/`assistant` 记录，role/content 构造好
2. 保证每个 sessionId 一致、cwd 匹配、末尾有最近的 user leaf
> 不依赖 `.claude/projects/sessions-index.json`（那是空索引）；Claude 直接扫 jsonl。伪造难度：低。

---

## 4. OpenCode — `opencode.db`（Drizzle + SQLite，权威）

> 源码锚点：`opencode-dev/packages/core/src/database/{database.ts,path.ts,schema.gen.ts}`、`src/session/{sql.ts,history.ts,store.ts,info.ts}`、`src/global.ts`、`drizzle.config.ts`

### 存储位置

```
$XDG_DATA/opencode/opencode.db              # 默认（Global.Path.data = xdgData/opencode）
~/.local/share/opencode/opencode.db         # Linux 常见展开
~/Library/Application Support/opencode/…     # macOS xdgData 变体
opencode-<channel>.db                       # 非 latest/beta/prod channel 时按 InstallationChannel 隔离
$OPENCODE_DB / $OPENCODE_TEST_HOME          # 环境变量覆盖（Flag.OPENCODE_DB / Global.Path.home）
```

`storage/{session,message,part}/*.json` **不是当前权威**（v1 遗留，`SessionTable/MessageTable/PartTable` 仍在 schema 中但会话正文已迁至 `session_message` 序列表；`storage/*.json` 镜像在新版代码中不再作为 loader 真理）。

### 表结构（当前权威，`schema.gen.ts` / `sql.ts`）

| 表 | 主键 | 关键列 | 说明 |
|----|------|--------|------|
| `project` | `id` | `worktree`(绝对路径), `vcs`, `sandboxes`(json), `time_*` | 项目容器，`session.project_id` 外键 |
| `session` | `id` | `project_id`, `workspace_id?`, `parent_id?`, `slug`, `directory`(绝对路径，`directoryColumn`), `title`, `version`, `agent`, `model:{id,providerID}`, `time_*` | 会话元数据 |
| `session_message` | `id` | `session_id`, `type`, `seq`(int, unique per session), `data`(json, Omit id/type), `time_*` | **会话正文权威**（按 `seq` 排序，`SessionHistory.load` 读取） |
| `session_input` | `id` | `session_id`, `prompt`(json), `delivery`, `admitted_seq`, `promoted_seq?` | 输入队列 |
| `session_context_epoch` | `session_id` PK | `baseline`, `snapshot`(json), `baseline_seq` | context 基线（compaction 感知）|
| `event` / `event_sequence` | `id` / `aggregate_id` PK | `aggregate_id`, `seq`, `type`, `data` | 事件溯源（追加式） |
| `message` / `part` / `todo` | `id` | （v1 遗留）| 旧版 `message`/`part` 已被 `session_message` 取代 |

索引：`session_message(session_id,seq)` unique，`session_message(session_id,type,seq)`，`session_message(time_created)`，`session(project_id)` 等。

### 会话正文加载（`history.ts`）

```ts
SessionHistory.load(db, sessionID)
  // 1) 取 epoch?.baselineSeq + latestCompaction?.seq
  // 2) SELECT * FROM session_message WHERE session_id=? AND seq >= compaction.seq? AND (type!='system' OR seq>baselineSeq)
  // 3) ORDER BY seq ASC, decode({ ...row.data, id: row.id, type: row.type })
```

`loadForRunner(db, sessionID, baselineSeq)` 同理但强制 `baselineSeq` 过滤。

### 构造可 resume 会话（DB 事务写）

需在同一 `opencode.db` 中事务性写入（`Effect` + Drizzle）：

1. `project` 行（`id`, `worktree`(绝对路径，`path.ts:absolute` 校验)，`directory` 等）
2. `session` 行（`id`, `project_id`, `slug`, `directory`(绝对路径), `title`, `version`, `time_created/updated`）
3. `session_message` 行（每条 `id` 唯一, `session_id`, `type`, `seq` 从 0 连续, `data` 为消息 JSON（`{...row.data}`），`time_created/updated`）
4. 可选 `session_context_epoch`（若有 compaction 基线）
5. 可选 `event` / `event_sequence`（事件溯源一致性；部分部署依赖）

> **未确定项（需一次真实写采样锁定）**：`session_message.data` 列的精确 JSON 形状（`SessionMessage.Message` 的 `Encoded` 去 `id`/`type`）、`agent`/`model` 列的序列化、`seq` 是否必须从 0 连续（`load` 按 seq 排序但 unique 约束暗示连续）。**最稳做法 = 起一次真实 opencode 会话，抓 DB 增量 + `session_message` 行样本**（Phase 2 做）。
>
> **DELTA vs 旧版审计**：旧版称“`storage/*.json` 镜像是权威/双写”，本版纠正为**DB 权威**（`session_message` 序列表），`storage/*.json` 为 v1 遗留；旧版未提 `session_context_epoch` / `session_input` / `event` 表；旧版未提 `Global.Path.data` 的 xdg 定位与 `OPENCODE_DB` 覆盖。

---

## 5. Pi — `~/.pi/agent/sessions/--<path>--/<ts>_<uuid>.jsonl`

> 源码锚点：`pi-main/packages/coding-agent/src/core/session-manager.ts`、`docs/session-format.md`、`src/config.ts`

### 存储位置

```
~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl
~/.pi/agent/sessions/_no-cwd/…   # 罕见（cwd 解析失败时）
```

- `path` = `cwd` 去前导 `/`/`\` 后把 `/` `\` `:` 全换 `-`，包成 `--...--`（`session-manager.ts:479`），与 DSH 类似但**不做 `~XXXX` 转义**，更简单、人可读。
- 文件名 = `<ISO-ts 换 - >_<uuid>.jsonl`（`newSession:954`，`uuidv7`）。
- 可通过 `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` / `--session-dir` / `settings.json:sessionDir` 覆盖（`config.ts:520`）。

### 记录格式（JSONL 树，`session-format.md`）

首行 header + 若干 entry，每行 `{type, id, parentId, timestamp, ...}`：

```json
{"type":"session","version":3,"id":"<uuid>","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","parentSession":"/path/to/original/session.jsonl"}
{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"...","message":{"role":"user","content":"Hello","timestamp":...}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"...","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"provider":"anthropic","model":"claude-sonnet-4-5","usage":{...},"stopReason":"stop","timestamp":...}}
{"type":"compaction","id":"f6g7h8i9","parentId":"b2c3d4e5","timestamp":"...","summary":"...","firstKeptEntryId":"b2c3d4e5","tokensBefore":50000}
{"type":"branch_summary","id":"g7h8i9j0","parentId":"a1b2c3d4","timestamp":"...","fromId":"f6g7h8i9","summary":"Branch explored approach A..."}
{"type":"session_info","id":"k1l2m3n4","parentId":"...","timestamp":"...","name":"Refactor auth module"}
```

Entry 类型：

| type | 参与 LLM context | 说明 |
|------|----------------|------|
| `session` | 否 | 首行 header，`version:3` 当前，`parentSession?` 为 fork 源路径 |
| `message` | 是 | `message: AgentMessage`（`user`/`assistant`/`toolResult`/`bashExecution`/`custom`/`branchSummary`/`compactionSummary`）|
| `compaction` | 是（化为 `compactionSummary`）| 摘要 + `firstKeptEntryId` + `tokensBefore` + `retainedTail?`（新）、`usage?` |
| `branch_summary` | 是 | `fromId` + `summary`，由 `/tree` 分支时生成 |
| `custom_message` | 是 | 扩展注入的 `CustomMessage`（`display` 控制 TUI） |
| `model_change` / `thinking_level_change` | 否（但影响 `buildSessionContext` 的 model/thinkingLevel）| 模型/思考档位切换 |
| `custom` | 否 | 扩展状态持久化 |
| `label` | 否 | 书签（`targetId` + `label`） |
| `session_info` | 否 | 显示名（`name`） |

- **树结构**：`id`（8-char hex，`randomUUID slice 0,8`，碰撞重试）+ `parentId`（首条 `null`），`leafId` 指向当前叶；`branch(entryId)` / `branchWithSummary` / `resetLeaf()` 移动叶指针；`createBranchedSession(leafId)` 抽取路径到新文件。
- **Context 构建**（`buildContextEntries` / `buildSessionContext:418`）：沿 `leafId→root` 路径收集；若含 `compaction` 则仅保留 `compaction` 本身 + `firstKeptEntryId` 起的条目 + compaction 后的条目（新版 `retainedTail` 自包含则更简）。
- **落盘策略**（`_persist:1016`）：**首个 `assistant` 消息之前不落盘**（`hasAssistant` 守卫，`flushed` 状态机）；无 assistant 的 session 仅内存态。迁移时需保证至少一条 assistant 消息，否则文件不会创建（`createBranchedSession` 同理）。
- **版本迁移**：`v1→v2` 补 `id`/`parentId` 树、`v2→v3` 将 `hookMessage` role 重命名为 `custom`（`migrateV1ToV2:230`）。

### 发现与 resume

- `SessionManager.list(cwd)` 扫 `sessions/--<path>--/*.jsonl`，并发读 header（`MAX_CONCURRENT 10`），**仅读首行做 header 发现**（`readSessionHeader:572`，4KB 块 + 1MB 扫描上限）。
- `SessionManager.open(path)` / `continueRecent(cwd)` 加载全文件 → `migrateToCurrentVersion` → 建索引。
- 删除：删 `.jsonl` 文件或 `/resume` 中 `Ctrl+D`（经 `trash` CLI）。

### 构造可 resume 会话

写一个 JSONL 到 `~/.pi/agent/sessions/--<encoded-cwd>--/<ts>_<uuid>.jsonl`：

1. header `{type:'session', version:3, id:<uuid>, timestamp:ISO, cwd, parentSession?}`
2. 若干 `message` entry（`id` 8-char hex，`parentId` 链，`timestamp` ISO，`message` 含完整 `AgentMessage`）
3. 可选 `model_change` / `thinking_level_change` / `compaction` / `branch_summary` / `session_info`

> 伪造难度：低（单文件，纯 JSONL，无压缩，无 DB）。

---

## 6. 对迁移引擎的含义（最小可伪造字段汇总）

| 工具 | 写一个可 resume 会话要造什么 | 难度 |
|------|------------------------------|------|
| DSH | 1 个 zstd 拼接文件（header frame + 消息事件 frame，`surfaceOp:'append'` + 连续 seq，`_no-cwd` 分支按 `cwd===undefined` 处理）| 低（已验证）|
| Codex | 1 个 rollout jsonl（`session_meta` + `response_item`）+ `session_index` 一行 | 低 |
| Claude | 1 个 jsonl（`user`/`assistant` 链 + `last-prompt`）+ 正确编码目录 + 可选 `subagents/agent-*.jsonl` | 低 |
| Pi | 1 个 JSONL 树（`session` header + `message` 链，`id`/`parentId` 8-char hex，至少 1 条 assistant 才落盘）| 低 |
| OpenCode | DB 事务写 `project` + `session` + `session_message`（`seq` 连续）(+ `session_context_epoch` / `event`) | 中（待一次真实写采样）|

> **IR 设计含义**：`MigratedSession.messages`（role+content 流水线）可无损覆盖 DSH/Claude/Codex/Pi 四家；OpenCode 需 `session_message` 适配器做 `MigratedMessage ↔ session_message.data` 映射；Pi 需 `id`/`parentId` 树链生成与 `compaction`/`branch_summary`/`custom` 的可选透传。

---

## 附：已实测的环境事实

- Node `v24.12.0`（`node:zlib` 原生 zstd，DSH 同款技术栈）
- Python `3.14`（`C:\Python314`，可用来读 OpenCode/Codex 的 SQLite）
- 本机装齐：codex.ps1 / claude.cmd / opencode.exe / dsh.ps1
- DSH 版本 `@deepseek-ai/dsh@0.1.2-alpha.1`（`deepseek-harness-master` 当前），session 格式 `version:0`
- 真实 DSH session 解出 460 条记录、19 种事件类型（上表）
- Pi 版本 `0.0.3`（`pi-main` 当前），session 格式 `version:3`，树结构
- OpenCode 当前 `session_message` 为权威（`message`/`part` 为 v1 遗留）
