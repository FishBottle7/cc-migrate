# Cursor / Windsurf — 特征与存储（占位）

> 状态：`unknown`（本次未放入源码，未落盘到本机扫描范围）
> 审计对照：`docs/session-formats-audit.md#6` 汇总行

## 现状

- 本机扫描与 `D:\codes\Opensource\` 中均未放入 Cursor / Windsurf 的权威源码，暂无法逆向存储格式与 resume 路径。
- 迁移引擎中标记为 `unknown` 占位，不参与 `任意 ⇄ 任意` 的已验证矩阵（当前已验证：DSH / Claude / Codex / Pi 单文件；OpenCode DB）。

## 后续接入条件

1. 放入权威源码或抓真实落盘样本（类似 `session.jsonl.zstd` / `rollout-*.jsonl` / `opencode.db` 的最小样本）
2. 明确权威存储（单文件 vs DB）、记录格式（消息/事件/索引）、发现与 resume 方式
3. 补 `docs/agents/cursor.md` / `windsurf.md` 各自独立档，并更新 `docs/agents/README.md` 索引与 `docs/session-formats-audit.md` 总览表

## 占位 IR 约束

- 在 `ToolId` 中保留 `unknown` 分支，`Adapter` 按 `no-op` 姿态暴露（`listSessions` 返回空，`parse/write` 抛 `unsupported`），避免过度承诺。
