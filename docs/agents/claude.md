# Claude Code — 特征与存储

> 源码：`claude-code-main` · 锚点：`src/utils/sessionStorage.ts:1039` (`insertMessageChain`) / `3472` (`loadTranscriptFile`) / `2069` (`buildConversationChain`)
> 审计对照：`docs/session-formats-audit.md#3`

## 定位

```
~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
~/.claude/projects/<encoded-cwd>/subagents/agent-<id>.jsonl   # 旁链（可选）
```

- `encoded-cwd`：把 cwd 中所有**非字母数字**字符（`:`, `\`, `/`, `_`, 空格等）替换成 `-`
  - 例 `D:\codes\flutterProjects\focus_me_full\focus_me` → `D--codes-flutterProjects-focus-me-full-focus-me`
- 文件名 = `sessionId` (uuid)；同一 project 目录可多 jsonl（主 + 旁链）
- 不依赖 `sessions-index.json`（空索引），直接扫 jsonl

## 记录格式（JSONL，每行一 record）

- 首/尾控制行：开头可选 `mode`/`permission-mode`；**末尾必有 `last-prompt`**：
  ```json
  {"type":"last-prompt","lastPrompt":"<≤200 chars 的末条 user 文本>","sessionId":"55dded76-..."}
  ```
  - 权威 shape 为 `reAppendSessionMetadata` 写入的 `{type:'last-prompt', lastPrompt, sessionId}`（无 `leafUuid`，旧版 `leafUuid` 已废弃，`last-prompt` 仅展示/定位）
- 中间链：`type: "user" | "assistant" | "system"`，由 `parentUuid` 串起父子链
  - `user`：`{type:'user', parentUuid, isSidechain:false, promptId, message:{role:'user', content:"..."/[blocks]}, isMeta, uuid, timestamp, userType, entrypoint, cwd, sessionId}`
  - `assistant`：`{type:'assistant', parentUuid, message:{role:'assistant', content:[...]}, responseId, uuid, timestamp, sessionId}`
  - `content` 块：文本块 + `tool_use`/`tool_result`；`file-history-snapshot` 行可省略不影响 resume
- 旁链：`subagents/agent-<id>.jsonl` 内记录与主链同形，但 `isSidechain:true` + `agentId`，可选同名 `.meta.json` 侧车 `{agentType, worktreePath?, description?}`

## 发现与 resume

- resume 读 jsonl → 按 `parentUuid` 重建链，找最近 leaf（`/resume` 过滤掉首行 `isSidechain:true` 的文件）
- `insertMessageChain` / `buildConversationChain` / `loadTranscriptFile` 为权威读链路

## 可 resume 最小集合（供迁移引擎）

1. 若干 `user`/`assistant` 记录（`parentUuid` 连续、`sessionId`/`cwd` 一致）
2. 末尾 `last-prompt`（`lastPrompt` 截 200，`sessionId` 必带）
3. 目录用 `encoded-cwd`，文件名 `<uuid>.jsonl`；可选旁链 `subagents/agent-*.jsonl`

## IR 映射

- `MigratedSession.messages` ↔ `user`/`assistant` 链；`tool_use`/`tool_result` 块归一到 `ContentBlock[]`
- `MigratedSidechain[]` ↔ `subagents/agent-*.jsonl`（完整搬运旁链文件，非折叠文本；`agentId` 保留）
- `cwd` 重映射到目标 `encoded-cwd`；`model` 仅提示；`reasoning` 丢弃可配置

## 约束/坑

- `cwd` 编码非 base64，注意 `_` 也变 `-`
- `last-prompt` 无 `leafUuid`，勿按旧 shape 写
- 旁链与主链同目录扫描，需正确打 `isSidechain` 标记避免被当主会话列出
