# Pi — 特征与存储

> 源码：`pi-main` @ `0.0.3` · 格式 `version:3` · 锚点：`packages/coding-agent/src/core/session-manager.ts` · `src/config.ts` · `docs/session-format.md` · `src/core/messages.ts`

## 定位

```
~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl
~/.pi/agent/sessions/_no-cwd/...                         # cwd 解析失败时罕见分支
```

- `path` 编码（`session-manager.ts:479`）：`cwd` 去前导 `/`/`\` 后把 `/` `\` `:` 全部换 `-`，包成 `--...--`；与 DSH 类似但**不做 `~XXXX` 转义**，更人可读
- 文件名（`session-manager.ts:954`）：`<ISO-ts 换 - >_<uuid>.jsonl`（`timestamp.replace(/[:.]/g,"-")` + `uuidv7()`）；例 `2024-12-03T14-00-00-000Z_<uuid>.jsonl`
- 可覆盖：`PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` / `--session-dir` / `settings.json:sessionDir`（`config.ts:520`，优先级 `--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > `settings.json:sessionDir`，见 `config.ts:671`）

## 记录格式（JSONL 树，`session-format.md`）

首行 header + 若干 entry，每行 `{type, id, parentId, timestamp, ...}`：

```json
{"type":"session","version":3,"id":"<uuid>","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","parentSession":"/path/to/original/session.jsonl"}
{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"...","message":{"role":"user","content":"Hello","timestamp":1733270000000}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"...","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"provider":"anthropic","model":"claude-sonnet-4-5","usage":{...},"stopReason":"stop","timestamp":...}}
{"type":"compaction","id":"f6g7h8i9","parentId":"b2c3d4e5","timestamp":"...","summary":"...","firstKeptEntryId":"b2c3d4e5","tokensBefore":50000}
{"type":"branch_summary","id":"g7h8i9j0","parentId":"a1b2c3d4","timestamp":"...","fromId":"f6g7h8i9","summary":"Branch explored approach A..."}
{"type":"session_info","id":"k1l2m3n4","parentId":"...","timestamp":"...","name":"Refactor auth module"}
```

### Entry 类型

| type | 进 LLM context | 说明 |
|------|----------------|------|
| `session` | 否 | 首行 header，`version:3` 当前，`parentSession?` 为 fork 源路径 |
| `message` | 是 | `message: AgentMessage`（`user`/`assistant`/`toolResult`/`bashExecution`/`custom`/`branchSummary`/`compactionSummary`），见 `messages.ts` |
| `compaction` | 是（化为 `compactionSummary`） | `summary` + `firstKeptEntryId` + `tokensBefore` + 可选 `retainedTail?: AgentMessage[]`（新版自包含 checkpoint，`session-format.md:238`）+ `usage?` + `details?` |
| `branch_summary` | 是 | `fromId` + `summary` + `usage?`/`details?`，由 `/tree` 分支时生成 |
| `custom_message` | 是 | 扩展注入的 `CustomMessage`（`display` 控制 TUI，`content: string|(TextContent|ImageContent)[]`） |
| `model_change` / `thinking_level_change` | 否（但影响 `buildSessionContext` 的 `model`/`thinkingLevel`） | 模型/思考档位切换 |
| `custom` | 否 | 扩展状态持久化（`customType` + `data`） |
| `label` | 否 | 书签（`targetId` + `label`） |
| `session_info` | 否 | 显示名（`name`，经 `appendSessionInfo:1138` 去换行） |

### 树结构

- `id`：8-char hex（`randomUUID().slice(0,8)`，碰撞重试 `generateId:221`，`byId.has` 守卫）
- `parentId`：首条 `null`，后续指向父 `id`；`leafId` 指向当前叶
- 操作：`branch(entryId)` / `branchWithSummary` / `resetLeaf()` 移动叶指针；`createBranchedSession(leafId)` 抽取 `root→leaf` 路径到新文件（`session-manager.ts:1414`）
- 版本迁移：`v1→v2` 补 `id`/`parentId` 树 + `firstKeptEntryIndex→firstKeptEntryId`（`migrateV1ToV2:230`）；`v2→v3` 将 `hookMessage` role 重命名为 `custom`（`migrateV2ToV3:259`）；`CURRENT_SESSION_VERSION=3`（`session-manager.ts:30`）

### Context 构建

- `buildContextEntries:418`：沿 `leafId→root` 路径收集；若含 `compaction` 则仅保留 `compaction` 本身 + `firstKeptEntryId` 起的条目 + compaction 后条目；新版 `retainedTail` 自包含则更简（`session-format.md:322`）
- `buildSessionContext:461`：`buildContextEntries` → `sessionEntryToContextMessages` 投影（`message` 直通、`compaction`→`compactionSummary` + `retainedTail`、`branch_summary`→`branchSummary`、`custom_message`→`custom`），同时推导 `thinkingLevel`/`model`（`getSessionContextSettings:362`）
- 旧/手改文件的 `content==null` 兜底为空数组（`sessionEntryToContextMessages:388`）

## 发现与 resume

- `SessionManager.list(cwd, sessionDir?)` 扫 `sessions/--<path>--/*.jsonl`，并发读 header（`MAX_CONCURRENT 10`，`772`），**仅读首行做 header 发现**（`readSessionHeader:572`，4KB 块 + 1MB 扫描上限 `MAX_SESSION_HEADER_SCAN_BYTES`）
- `SessionManager.open(path, sessionDir?, cwdOverride?)` / `continueRecent(cwd)` 加载全文件 → `migrateToCurrentVersion` → 建索引（`session-manager.ts:1532/1559`）
- `findMostRecentSession:636` 按 `mtime` 倒序取最近；`open` 时对空文件初始化 header（`_setSessionFile:904`）
- `forkFrom(sourcePath, targetCwd)` 复制源全部非 header entry 到新文件，`parentSession` 指向源路径（`session-manager.ts:1581`）
- `listAll` 跨全部 project 目录；删除：删 `.jsonl` 或 `/resume` 中 `Ctrl+D`（经 `trash` CLI）

## 落盘策略（易踩坑）

- `_persist:1016`：**首个 `assistant` 消息之前不落盘**（`hasAssistant` 守卫，`flushed` 状态机）；无 assistant 的 session 仅内存态，`createBranchedSession` 同理（`hasAssistant` 判断后才 `_rewriteFile`，`1484`）
- 迁移时需保证至少一条 `assistant` 消息，否则文件不会创建；`appendMessage` 等均经 `_appendEntry` → `_persist`

## 可 resume 最小集合

1. header `{type:'session', version:3, id:<uuid>, timestamp:ISO, cwd, parentSession?}`（`newSession:937`）
2. 若干 `message` entry（`id` 8-char hex，`parentId` 链，`timestamp` ISO，`message` 含完整 `AgentMessage`：`user`/`assistant`/`toolResult` 等，`timestamp` 为 epoch ms）
3. 可选 `model_change` / `thinking_level_change` / `compaction` / `branch_summary` / `session_info`（`retainedTail` 建议新版带上以自包含）

> 写一个 JSONL 到 `~/.pi/agent/sessions/--<encoded-cwd>--/<ts>_<uuid>.jsonl` 即为可 resume 会话；伪造难度低（单文件，纯 JSONL，无压缩，无 DB）。

## IR 映射

- `MigratedSession.messages` ↔ `message` 链（`toolResult`/`bashExecution` 归一到 `ContentBlock[]`）
- `MigratedSession.cwd` ↔ `header.cwd`（重映射时重算 `--<path>--` 目录）
- `MigratedSidechain` 暂不主用（Pi 的分支在同一文件树内，非 Claude 式侧车文件）；`compaction`/`branch_summary`/`custom` 可选透传，`label`/`session_info` 按需
- `model` / `thinkingLevel` 经 `model_change` / `thinking_level_change` 或 `assistant` 的 `provider`/`model` 携带

## 约束/坑

- `id` 仅 8 字符，需碰撞检测；勿用完整 uuid
- 旧 `firstKeptEntryIndex` 已废弃，写新文件一律用 `firstKeptEntryId` 或 `retainedTail`
- 落盘前无 `assistant` 不写文件，测试/迁移需补一条 assistant
- 头部扫描有 1MB 上限（`SessionHeaderScanLimitError`），`cwd` 过长或自定义元数据过大时 `readSessionHeader` 会抛，但 `loadEntriesFromFile` 仍权威（`open:1541` 回退到全量加载）
