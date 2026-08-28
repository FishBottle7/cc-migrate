# Codex — 特征与存储

> 源码：`codex-main/codex-rs` @ 新版 · 锚点：`protocol/src/models.rs:975` (`ResponseItem`) / `protocol/src/protocol.rs:2975` (`SessionMeta`) / `core/src/rollout/list.rs:379` / `core/src/rollout/session_index.rs`
> 审计对照：`docs/session-formats-audit.md#2`

## 定位

```
~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<sessionId>.jsonl[.zst]
~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<sessionId>_<rolloutId>.jsonl.zst  # 新版：_+rollout_id 后缀 + zstd 压缩可选
~/.codex/history.jsonl                 # 仅用户消息索引 {session_id, ts, text}
~/.codex/session_index.jsonl           # 仅 name→id 索引 {id:thread_id, thread_name, updated_at:ISO8601}
```

- 按创建时间分层 `YYYY/MM/DD`，`timestamp` 为本地时间落盘（`rollout/list.rs:379`）
- `history.jsonl` 非权威；`session_index.jsonl` 仅供 `codex resume` 列表搜索
- SQLite：`logs_2.sqlite` 仅应用日志，`queue_1.sqlite` 上报队列，`state_5.sqlite` 运行时线程树（被进程持锁）；**盘中权威 = rollout jsonl**（可增量重建）

## 记录格式（OpenAI Responses API 事件流，每行 JSON）

```json
{"timestamp":"...","type":"session_meta","payload":{"id":"...","session_id":"...","timestamp":...,"cwd":"...","originator":"codex_cli_rs","cli_version":"...","source":"...","model_provider":"...","instructions":"...","git":{...},"history_mode":"..."}}
{"timestamp":"...","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"..."}]}}
{"timestamp":"...","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"..."}]}}
```

- 首行 `type=session_meta` 必有：`id`/`session_id`（新版新增 `session_id` + `history_mode` @ `protocol.rs:2975`）、`timestamp`、`cwd`、`originator:"codex_cli_rs"`、`cli_version`、`model_provider`、`instructions`(系统提示/AGENTS.md)、`git`
- 后续 `type=response_item` 的 `payload` 为 Responses API 对象：
  - `message` (`role:"user"|"assistant"|"developer"`, `content:[{type:"input_text"|"output_text", text}]`)
  - `function_call` / `function_call_output`（新版 `call_id: Option`，可空）、`reasoning`、`computer_call` 等
  - 新版增量 `ResponseItem:975`：`AgentMessage` / `AdditionalTools` / `ContextCompaction`

## 发现与 resume

- 扫 `~/.codex/sessions/**/**/rollout-*.jsonl*`，解压（如 `.zst`）后顺序重放 `response_item`
- `session_index.jsonl` 仅加速 `thread_name→id` 搜索，不参与重建

## 可 resume 最小集合

1. `session_meta`（新 `session_id`/新 `id`、`cwd`、`instructions`、`cli_version`）
2. 若干 `response_item` message（`developer`/`user`/`assistant`，块用 `input_text`/`output_text`）
3. 文件置于 `~/.codex/sessions/<YYYY/MM/DD>/` 下，名 `rollout-<ts>-<newId>.jsonl`（或 `.jsonl.zst`）
4. 追加 `session_index.jsonl` 一行 `{"id":"<thread_id>","thread_name":"<标题>","updated_at":"<ISO8601>"}`

> `sessionIdFromRolloutName` 多段 UUID 截断坑已修：取最后一横前为 ts，前后切分

## IR 映射

- `MigratedSession.messages` ↔ `response_item` 的 `message` 流；`tool_use`/`tool_result` ↔ `function_call`/`function_call_output`（`call_id` 重映射）
- `cwd` 直接映射；`model`/`instructions` 透传到 `session_meta`
- 旁链：Codex 子代理为兄弟 rollout 会话（同目录另一文件），IR `sidechains` 暂不主用，预留

## 约束/坑

- 文件名后缀与压缩可变，读需同时兼容 `.jsonl` / `.jsonl.zst` / `_<rolloutId>` 变体
- `history.jsonl` 不可作真理，勿以它判定会话存在
- `FunctionCallOutput.call_id` 可空，写时需补或留空
