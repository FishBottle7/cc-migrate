# OpenCode — 特征与存储

> 源码：`opencode-dev` · 锚点：`packages/core/src/database/{database.ts,path.ts,schema.gen.ts}` · `src/session/{sql.ts,history.ts,store.ts,info.ts}` · `src/global.ts`
> 审计对照：`docs/session-formats-audit.md#4`

## 定位（谁是真理）

- **权威**：`$XDG_DATA/opencode/opencode.db`（`Global.Path.data = xdgData/opencode`）
  - Linux 常见展开：`~/.local/share/opencode/opencode.db`
  - macOS：`~/Library/Application Support/opencode/...`
  - `opencode-<channel>.db`：非 `latest`/`beta`/`prod` 时按 `InstallationChannel` 隔离（`database.ts:path()`）
  - 覆盖：`$OPENCODE_DB`（`Flag.OPENCODE_DB`，`:memory:` 或绝对路径直通，相对路径拼到 `Global.Path.data`）/ `$OPENCODE_TEST_HOME`（覆盖 `Global.Path.home`，per-test 隔离）
- **非权威**：`storage/{session,message,part}/*.json` 为 v1 遗留，`SessionTable/MessageTable/PartTable` 仍被 `SessionProjector` 双写兼容，但**会话正文已迁至 `session_message` 序列表**，loader 不再以文件镜像为真理

## 表结构（`schema.gen.ts` / `sql.ts`，当前权威）

| 表 | 主键 | 关键列 | 说明 |
|----|------|--------|------|
| `project` | `id` | `worktree`(绝对路径 `absoluteColumn`), `vcs`, `sandboxes`(json), `time_*` | 项目容器，`session.project_id` FK |
| `session` | `id` | `project_id`(FK→project,CASCADE), `workspace_id?`, `parent_id?`, `slug`, `directory`(绝对路径 `directoryColumn`), `title`, `version`, `agent`, `model:{id,providerID}`, `time_*` | 会话元数据 |
| `session_message` | `id` | `session_id`, `type`, `seq`(int, `UNIQUE(session_id,seq)`), `data`(json, `Omit<Encoded,"id"|"type">`), `time_*` | **正文权威**，按 `seq` 排序 |
| `session_input` | `id` | `session_id`, `prompt`(json), `delivery`, `admitted_seq`(unique per session), `promoted_seq?` | 输入队列 |
| `session_context_epoch` | `session_id` PK | `baseline`, `snapshot`(json), `baseline_seq` | context 基线，compaction 感知 |
| `event` / `event_sequence` | `id` / `aggregate_id` PK | `aggregate_id`, `seq`, `type`, `data` | 事件溯源（追加式） |
| `message` / `part` / `todo` | `id` | — | v1 遗留，旧 `message`/`part` 已被 `session_message` 取代 |

索引：`session_message(session_id,seq)` unique + `(session_id,type,seq)` + `(session_id,time_created,id)` + `(time_created)` 等；`session(project_id)` 等。

## 会话正文加载（`history.ts`）

```ts
SessionHistory.load(db, sessionID)
  // 1) epoch?.baselineSeq + latestCompaction?.seq（最新 type='compaction'）
  // 2) SELECT * FROM session_message
  //    WHERE session_id=? AND seq >= compaction.seq? AND (type!='system' OR seq>baselineSeq)
  // 3) ORDER BY seq ASC, decode({ ...row.data, id: row.id, type: row.type })
```

- `loadForRunner(db, sessionID, baselineSeq)` 同理但 `baselineSeq` 由调用方强制传入
- 解码失败抛 `MessageDecodeError`（`Schema.decodeUnknownEffect(SessionMessage.Message)`）
- `session_message.data` 形状（去 `id`/`type` 后）按 `type` 分 8 类 `TaggedUnion`（`session-message.ts:30-212`）：
  - `user`：`text, files, agents, metadata?, time:{created}`
  - `assistant`：`agent, model:{id,providerID,variant?}, content: (text|reasoning|tool)[] , snapshot?, finish?, cost?, tokens?, error?, time:{created,completed?}`
  - 其余：`system` / `shell` / `synthetic` / `compaction` / `agent-switched` / `model-switched`

## 构造可 resume 会话（DB 事务写）

> 需在同一 `opencode.db` 内事务性写入（Drizzle + SQLite，`journal_mode=WAL, busy_timeout=5000, foreign_keys=ON`）

1. `project` 行（`id, worktree`(绝对路径，`path.ts:absolute` 校验), `sandboxes:[]`, `time_created/updated`；已存在可 `onConflictDoNothing`）
2. `session` 行（`id, project_id, slug(Slug.create()), directory`(绝对路径), `title, version(InstallationVersion), time_created/updated, cost/tokens_*=0, agent/model` 等）
3. `session_message` 行（每条 `id=msg_*`, `session_id, type, seq` **从 0 连续**, `data=Omit(Encoded)`, `time_created/updated`）
4. 可选 `session_context_epoch`（`baseline/snapshot/baseline_seq`，空则 `load` 走 `baselineSeq=undefined` 分支亦可）
5. 可选 `event`/`event_sequence`（`aggregate_id=sessionID`，`seq` 追加）；**非 `context` 必需**（`load` 不读 `event`），但 `history/events` 与 `SystemContext.replace` 依赖它

> **seq 连续性**：DDL 仅 `UNIQUE(session_id,seq)`，无 CHECK 强制连续；但 `ORDER BY seq ASC` 重放，空洞会导致空档与 Runner 基线错位，**工程上必须 0..N-1 连续**。

## 发现与 resume

- `SessionV2.list({directory|project|workspaceID|search, limit, order, anchor{time,id}+direction})`：`SELECT * FROM session WHERE … ORDER BY time_created(+id)`，游标分页
- `SessionV2.get(sessionID)` / `context(sessionID)` → `SessionHistory.load`；`messages({sessionID,limit,order,cursor})` 分页预览
- 可 resume 判定：**只要 `session` 行存在**即可 `resume`（`SessionV2.resume → SessionExecution.resume`），无额外布尔列

## 伪造可行性（诚实判定）

- **可**：直接用 `better-sqlite3`/`drizzle-orm` 在 `Database.path()` 上以 `BEGIN IMMEDIATE` 事务写库，无需启动 `opencode` 进程或走 `Effect` 封装
- **风险/前提**：
  - 必须命中正确的 `path()`（channel/`OPENCODE_DB`/`OPENCODE_TEST_HOME` 解析，否则写错库）
  - `PRAGMA foreign_keys=ON` 违例即 `SQLITE_CONSTRAINT`；WAL 下并发 `SQLITE_BUSY` 需重试
  - `session_message.data` 必须符合 `SessionMessage.Message` 品牌/联合校验（含 `msg_*` 前缀）
  - 勿删 `__drizzle_migrations`，否则 `DatabaseMigration.apply` 判空库失败
  - 伴生 `-wal`/`-shm`，外部写后下次 `Database.Service` 启动 `PASSIVE` 检查点
  - 写前拷贝备份，避开活跃 `SessionRunner` 的 `resume` 竞态
  - `directory`/`worktree` 需绝对路径（`path.ts:directoryColumn/absoluteColumn`，win32 `\`→`/` 归一，空串仅兼容历史）

## IR 映射

- `MigratedSession.messages` ↔ `message`+`part` 行（v1.18.21 实库采样：`session_message` 为空，正文权威是 message/part；新版经 SessionProjector 双写，读 message/part 两种年代都覆盖）
- `tool` part 四态映射（`schema/v1/session.ts` ToolState union）：`completed`（output/title/metadata 必填）⇄ IR `tool_use`+配对 `tool_result`（**空串 output 是真实数据**，照发 tool_result）；`error`（`state.error`）⇄ `tool_result{isError:true}`；`pending`（无结果调用）⇄ 只有 `tool_use`、不伪造结果；`running` 写端不用
- task 子会话（原生形态，已实现往返）：子会话 = `session` 行 `parent_id`+`agent`+`title="<description> (@<agent> subagent)"`；父会话 task part `state.metadata={parentSessionId,sessionId,model,truncated}` 指向它，`output` 为 `<task id=… state=…><task_result>…</task_result></task>` 包装（读端解包进 tool_result，原文进 `rawResult`）。**完整中间过程在子会话自己的 message/part 行里**（实库样本 22 行），IR `sidechains[]`（agentId=子会话id，`meta.opencode.callId` 保留 task 关联键）承载全量转录；写端 flatten=false 原生重建子会话行+task part 回链（匹配链 callId→agentId→prompt→FIFO），flatten=true 展平为主会话顶层消息。v1.18 实库曾有 `parent_id` 全 NULL 的 bug（`.db-rescue/` 抢救记录），读端用 task part metadata 自愈
- `listSessions` 只列顶层（`parent_id IS NULL`，孤儿 parent 保留可见）——对齐 TUI 按 parentID 归组的行为
- compaction：边界 = 唯一 part 为 `{type:'compaction',auto,tail_start_id?}` 的 user 行 + summary assistant（`summary:true,mode:'compaction',agent:'compaction',parentID=边界`）⇄ IR `compaction[]`（summary 文本投影为锚点 user 消息；`meta.opencode.auto` 往返；无 summary 配对的边界只留类型化记录、写端不落行）。`tail_start_id` 读端保留在 meta、写端不重建（msg id 会重生成，写回必成悬空）
- `cwd` ↔ `session.directory`；`model` ↔ `session.model:{id,providerID,variant?}`；`file` part（mime/filename/url，data URL 图片）⇄ IR `FileBlock`
- 未确定项（待一次真实写采样锁定）：`data` 列的精确 `Encoded` 去 `id`/`type` 形状、`event_sequence.seq` 与 `session_message.seq` 的一致性细节
