# 6 家 AI 编码工具会话存储格式审计（基于真实数据逆向）

> 状态：完整（v2，2026-08-28 增补 DSH/OpenCode/Pi 的权威源码锚点 + DELTA；2026-08-29 增补 ZCode 行，细节见 `docs/agents/zcode.md`）。
> 全部字段基于本机真实文件 + 三套新放入的权威源码（`deepseek-harness-master` / `opencode-dev` / `pi-main`）交叉验证，未依赖文档假设。
> 目的：为会话迁移引擎提供「字节级构造可 resume session」的最小字段集，并记录与旧版审计的 DELTA。
> 旧版：v1（4 家）见 git 历史；本版扩到 6 工具（新增 Pi，Codex 已按 `codex-main` 增量更新）。

## 0. 总览表

| 工具 | 权威存储 | 记录格式 | 单文件 or 关系 | resume 方式 | 最小可伪造性 |
|------|---------|---------|--------------|------------|-------------|
| **DSH** | `~/.dsh/sessions/--<proj>--/<id>/session.jsonl.zstd`（或 `/_no-cwd/<id>/`） | 事件日志（zstd 拼接帧，可选 `packChunks` 打包 `text-chunks` 行） | 单文件+顺序 seq | `loadStored`→`foldSurface`→`deriveEventMessage` | ✅ 已 round-trip |
| **Codex** | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl[.zst]` | 混合事件流：`session_meta`/`response_item`/`event_msg`/`turn_context`/`world_state`/`compacted` 等 11 类记录（v3.1 深查） | 单文件 + `session_index.jsonl`（name→id）+ `archived_sessions/`；state DB 为派生缓存 | 读 rollout 反向重建（compacted.replacement_history 为历史基点） | ✅ 公开格式（详见 `docs/agents/codex.md`） |
| **Claude Code** | `~/.claude/projects/<编码路径>/<uuid>.jsonl` | Anthropic JSONL 消息流（`parentUuid` 链 + 末尾 `last-prompt`） | 单文件（首尾控制行）+ `subagents/agent-*.jsonl` | 读 jsonl 找 leaf | ✅ 结构简单 |
| **OpenCode** | `~/.local/share/opencode/opencode.db`（`$XDG_DATA/opencode/opencode.db`，channel 变体见 `database.ts:path()`）| SQLite（Drizzle）权威；会话正文在 `session_message` 序列表 | 关系（`session` + `session_message` + `session_context_epoch` + `project` + `event`）| `SessionHistory.load(sessionID)` 读 `session_message` 按 seq 排序，compaction 感知 | ⚠️ 需 DB 事务写 3+ 表，无文件镜像 |
| **Pi** | `~/.pi/agent/sessions/--<path>--/<ts>_<uuid>.jsonl` | JSONL 树（`id`/`parentId` 8-char hex，`leafId` 指针）| 单文件，树在文件内 | `SessionManager.open(path)` / `continueRecent(cwd)` 读树→`buildSessionContext()` | ✅ 单文件，易伪造（需首个 assistant 才落盘）|
| **ZCode** | `~/.zcode/cli/db/db.sqlite`（`ZCODE_HOME` 覆盖）| SQLite（WAL）权威，正文在 `message`/`part` 行的 `data` JSON + 双 sequence | 关系（`session`+`message`+`part`，附属 sidecar `cli/agents/`、`rollout/`、`artifacts/`）| 按 `sequence` 排序回放（官方投影跳过 summary 与 model-only 合成 user）| ⚠️ 需 DB 写 3 表 + 活 WAL；详见 `docs/agents/zcode.md` |
| **Cursor / Windsurf** | 未落盘到本机扫描范围（本次未放入源码）| — | — | — | `unknown`（占位）|

> 关键洞察：**DSH/Codex/Claude/Pi 四家都有一条单一权威文件线**（zstd 拼接 / rollout / jsonl / Pi JSONL 树），**OpenCode 与 ZCode 是 DB 权威**。因此 `任意⇄任意` 的 IR 只需保住 `role + content 块 + 工具调用 + cwd + model` 五元组即可无损覆盖前四家；OpenCode/ZCode 需 DB 适配器单独处理。

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

### 深度盘点 #2（2026-08-29 第二轮：源码目录树 + 36 会话全量实测）

> 源码锚点新增：`packages/core/session/src/known-event-types.ts`（持久化事件目录，**生成文件**）、`packages/subagent/subagent/src/{child-agent,descriptor,list-children,depth,continuation}.ts`、`packages/attachment/attachment-local/src/{store,request-image}.ts`、`packages/api/session-controller/src/client/sessions/lineage.ts`。实测样本：本机 `~/.dsh` 36 个会话（13 个带 `parentSession`、11 个带 `origin`）。

#### Subagent 关联机制（有，= header 三字段 + 子日志 descriptor 事件）

- 派生时子会话 header 写 `parentSession`（父 id）+ `origin:'subagent'` + `delegationDepth`（父+1）（`child-agent.ts:148-153`）；`seedLength > 0` 时一并写入——它是**继承事件数**（seq 计数），`source.events.slice(header.seedLength)` 即"父历史 | 子增量"分界（`continuation.ts:974`），整流重写且不丢事件时逐字保留即可。
- DSH 自己的子代列表与 UI lineage 树均按 `header.parentSession` 建树（`list-children.ts:88`、session-controller `lineage.ts:flattenLineage`）；生命周期见证字段为 `version,id,createdAt,cwd,parentSession,seedLength,delegationDepth,origin,agentPreset`（`list-children.ts:388`）。
- 子会话日志内另有 log-only `subagent/descriptor` 事件（descriptor v3：`{version, mode:'one-shot'|'continuable', provider, label?, agentProvider?, agentModel?, …}`）——continuable 子代理冷恢复的组成快照，模型不可见、compaction 后仍存活。
- **适配器结论**：`collectSubagentSidechains` 的 `parentSession === 当前 id` 判据与 DSH 原生同款，方向正确；漏的是孙代、子会话桶与 header 保真（见下）。

#### 事件类型全表（catalog 51 种 vs 适配器显式映射 12 种）

`KNOWN_SESSION_EVENT_TYPES`（known-event-types.ts:18，`pnpm run gen-persistence-catalog` 生成）共 **51 种**；适配器显式映射 9 种 + packed 3 种（`text-chunks`/`reasoning-chunks`/`tool-call-chunks` 存储行，不属 catalog），其余落 `unmappedEvents`——dsh→dsh 无损，跨工具迁移按契约丢弃。

本机 36 会话实测出现 31 种 catalog 类型 + 3 种 packed；**21 种 catalog 类型实测未出现**（`plan/mode`、`agent-preset/selected`、`model/selection`、`feedback/record`、`hook/invoked`、`hook/result`、`schedule/change`、`subagent/model-selection-policy`、`team/*`×4、`tool-workflow/*`×4、`tool/code-dispatch*`×2、`web/deepseek-search-llm-request`、`session-log-deepseek/delivery-accepted`），同样靠 unmapped 兜底。unmapped 按实测数量排序：`assistant/chunk` 23817、`step/start`+`end` 4106、`llm/retry`(+`-started`) 1953、`agent/inbox/spliced` 502、`approval/*` 198、`request/header`+`context` 133、`turn/*` 440、`session/end-seed` 53、`compaction/prune` 53、`sandbox/mode` 37、`permission/preset` 26、`compaction/start`+`end` 24、`session/title-llm-request` 15、`subagent/descriptor` 11、`command/*` 4。

#### 附属存储（适配器此前零接触）

| 路径 | 内容 | 迁移价值 |
|------|------|----------|
| `storages/session_projcache.json` | 会话投影缓存 `tables.sessions[id].rows.{title,goal,tokenUsage,contextPressure,sessionStats}` | **标题的廉价来源**（GUI 列表即用它），一次文件读覆盖全部会话；未经 DSH 打开的会话（含迁移写入的）无条目 |
| `storages/workspace.json` | 工作区注册表 + `global.archivedSessionIds`（归档状态）+ `workspaces[].sessionIds` 顺序 | 归档/工作区归属的权威读取源；写入侧已有 `ensureWorkspaceRegistration` |
| `attachments/v1/objects/<sha256[0:2]>/<sha256>` | 图片字节按内容寻址；`attachmentId` 形如 `sha256:<64hex>`（`store.ts:22,53,115`），另有 `request-images/` 变体桶 | 跨工具迁移图像时可本地解出真字节，`dsh-attachment://` FileBlock 引用不再悬空 |
| `profiles/` | web 预览资源，非会话数据 | 无 |

#### 保真缺口清单（本轮盘点 → 处置）

1. ✅已修 **`meta.dsh.headerRaw` 只存不读**：write() 硬编码 `delegationDepth:0, agentPreset:'standard'`，从不写 `parentSession/origin/seedLength/version`（与 buildIrFromEvents 尾注 "write-back prefers meta.dsh.headerRaw" 相悖）。独立迁移子代理会话时父子链断裂、非标准 preset 被归一。
2. ✅已修 **`assistant/message` 的 `usage` 与 `interrupted` 读写全丢**（token 记账随消息走；`interrupted:true` 标记中断时已交付前缀）。
3. ✅已修 **`tool/result` 事件级 `error`/`meta` 写回端不重发**（读端存进 toolCalls 桶 metadata，但事件字段消失——meta 承载 dsh-tool-fs 结果时 diff 卡片等工具私有载荷）。
4. ✅已修 **孙代子代理整体丢失**：只扫直接子代、IR sidechain 无嵌套。
5. ✅已修 **子会话只带 messages**：childIr 的 toolCalls/todos/goals/planModes/compaction/unmappedEvents/title 全部丢弃（IR `sidechain.toolCalls` 槽位从未填过）。
6. ✅已修 **写回子会话沿用源 id 且同 root+cwd 时直接覆盖源日志**（破坏性）：目标路径已存在时改用新 id，孙代 `parentSession` 随 id 映射重指。
7. ✅已修 **listSessions 从不读标题**（注释自认）且漏扫 `_no-cwd` 项目目录：现在 projcache 优先、日志扫最后一条 `session/title` 兜底（重命名覆盖 → 必须取最后），并暴露归档状态。
8. ✅已修 **附件字节无解析器**（FileBlock 只有 `dsh-attachment://<id>` 引用）：新增 `readDshAttachment()`。
9. 📋按契约记录（不修）：其余 unmapped 事件的 IR 语义化（approval 流、hook、team、workflow 等）——`unmappedEvents` 契约下跨工具丢弃是设计内行为；`subagent/descriptor` 经子会话 unmapped 桶无损往返，IR 不设专用槽。
10. ✅已修（08-30 第二轮收尾）**`synthetic` 判据只认 `source.kind==='plugin'`，漏掉非 plugin 的注入 kind**：实测 36 会话中 76 条注入被当人类发言——skill-catalog 35（`<available_skills>` 目录 reminder）、subagent-settled 26、agent-instructions 7、goal 6、subagent-report 2。判据改为**白名单人类发言**（`source.kind==='user'` 或无 source），`{kind:'plugin', plugin:'compact'}` 压缩检查点仍是唯一豁免（对话内容，IR 缺口 #3）。源码锚点：`packages/skill/tool-skill/src/index.ts:259`（skill-catalog 戳记）、`packages/subagent/subagent/src/continuation.ts`、`packages/context/agent-instructions/src/state.ts:84`、`packages/goal/goal-round-driver/src/index.ts:178`。

---

## 2. Codex — `rollout-<ts>-<id>.jsonl`

> ⚠️ **2026-08-29 深查重写**（`docs/agents/codex.md` 为权威细节版，含全字段表/锚点/映射）。旧版本节的
> `instructions` 字段、`session_meta` 单行假设、"Responses API 事件流"单描述均已过时。

### 存储位置

```
~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>[_<rolloutId>].jsonl[.zst]
~/.codex/archived_sessions/…                    # 归档同格式
~/.codex/session_index.jsonl                    # name→id，append-only 新条目胜出
~/.codex/state_5.sqlite 等                      # 从 rollout 回填的派生缓存（迁移引擎不写）
```

`$CODEX_HOME` 覆盖 `~/.codex`。**权威 = rollout 文件**；新会话首轮前不落盘（deferred creation）。

### 记录格式（11 类记录，每行 `{"timestamp","ordinal"?,"type","payload"}`）

- `session_meta`：24 字段（`id`/`session_id`/`forked_from_id`/`parent_thread_id`/`source`(含
  `subagent.thread_spawn`)/`thread_source`/`agent_*`/`model_provider`/`base_instructions{text,provenance}`/
  `history_mode`/`history_base`/`context_window`…）+ `git`。**旧版 `instructions` 字段已废弃**；
  子代理 rollout 可含多条继承的 session_meta 行。
- `response_item`：Responses API 对象 17 变体——`message`(含 **developer** role)/`agent_message`/`reasoning`
  (summary+content 必保，仅 `encrypted_content` 可丢)/`function_call`/`function_call_output`(output=串或裸数组，
  call_id 可空)/`custom_tool_call(+-output)`/`local_shell_call`/`web_search_call`/`tool_search_*`/
  `image_generation_call`(result=base64 图)/`compaction`(纯加密)/`context_compaction`/`compaction_trigger`/`additional_tools`。
- `event_msg`：90+ 变体的持久化子集（`task_started`/`task_complete`/`token_count`/`thread_rolled_back`/
  `thread_settings_applied`/`thread_goal_updated`/`turn_aborted`…）；UI/transient 类不落盘。
- `turn_context`（每真实用户轮的 cwd/model/approval/sandbox/effort/personality 基线）、
  `world_state`（full/patch 快照，含 agents_md 全文）、`compacted`（`replacement_history` 完整保留史 +
  窗口 id）、`inter_agent_communication`（模型可见）、`security_risk_score`、`realtime_item`。

### 构造可 resume 会话

最小集（官方 external-agent-migration 导入器实证）：`session_meta` + 若干 `response_item` message + 伪造
`task_started`/`task_complete`/`token_count` 事件，放对 `YYYY/MM/DD` 目录 + 追加 `session_index.jsonl` 一行。
100% 保真写回另需 `turn_context`/`world_state`/`compacted`/持久化 `event_msg` 全量（配方见 `docs/agents/codex.md` §9）。

> **DELTA vs 旧版审计**：旧版只识别 `session_meta`+`response_item` 两类记录；漏 `event_msg`/
> `turn_context`/`world_state`/`compacted`/IAC/ordinal/zst 后台压缩/`_rolloutId` revert 变体/子代理
> session_meta 前缀/`base_instructions` 语义变迁；`model_provider` 之外的 20+ 元字段全部缺失。

---

## 3. Claude Code — `projects/<编码路径>/<uuid>.jsonl`

> ⚠️ **2026-08-29 深度调查修正**：本节为 v2 浅层结论，权威细节已由深度调查重写至 **`docs/agents/claude.md`**（三方交叉：老版源码 sessionStorage.ts 全文 + 2.1.251 二进制逆向 + 27429 行真实数据枚举）。关键修正：
> - **`last-prompt` 的 `leafUuid` 在新版（2.1.251）复活且读取端消费**——本节下文"无 leafUuid"系旧版 `reAppendSessionMetadata` 形状，已不成立；另有 `explicit`/`rewound` 变体。
> - 记录类型远不止 user/assistant/summary：**A 类 transcript 消息**（user/assistant/attachment/system，`parentUuid` 构成 **DAG 不是链**——tool_result 由 `sourceToolAssistantUUID` 挂到对应 assistant 的 uuid，并行 tool_use 拆多条 assistant 同 `message.id`）+ **B/C 类 30+ 种元数据行**（新版新增 `permission-mode`/`cost-state`/`atis-latch`/`isolation-latch`/`file-history-delta`/`relocated`/`bridge-session`/`history-suppression`/`frame-link` 等）。
> - **transcript 不含系统提示词**：resume 时由目标二进制 + 当次 flag 重新生成；迁移"带源方提示词"对 Claude 目标唯一正道是进程参数 `--append-system-prompt`，禁止双系统提示词叠加。
> - 目录编码有 **200 字符截断 + hash 后缀**（`sanitizePath` 的 `MAX_SANITIZED_LENGTH=200`），长 cwd 场景"全替换为 -"规则不完整。
> - 唯一不可迁移负载 = `redacted_thinking.data`；`thinking.signature` 是签名非加密，必须逐字节保留。
> - resume 链重建含多个修复 pass（parallel tool_result 恢复、preservedSegment 重连、usage 清零、死枝剪枝），读端必须对齐，详见 `docs/agents/claude.md` §3。

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
| Codex | 最小：1 个 rollout jsonl（`session_meta`+`response_item`）+ `session_index` 追加一行；100% 保真另需 `turn_context`/`world_state`/`compacted`/持久化 `event_msg`（`docs/agents/codex.md` §9） | 低 |
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
