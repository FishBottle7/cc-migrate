# Agents — 特征文档索引

> 一 agent 一档，权威源码锚点 + 可 resume 最小集合 + IR 映射 + 坑位。供 `docs/design.md` 与 `docs/session-formats-audit.md` 引用，迁移引擎按此实现 `Adapter.parse/write`。

| Agent | 文档 | 存储 | 真理 | 难度 |
|-------|------|------|------|------|
| DSH | [dsh.md](./dsh.md) | `~/.dsh/sessions/.../session.jsonl.zstd`（zstd 拼接帧） | 单文件 + `foldSurface` | 低（已 round-trip） |
| Claude Code | [claude.md](./claude.md) | `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` | 单文件 + `subagents/agent-*.jsonl` | 低 |
| Codex | [codex.md](./codex.md) | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]` | 单文件（`session_index.jsonl` 仅索引） | 低 |
| OpenCode | [opencode.md](./opencode.md) | `$XDG_DATA/opencode/opencode.db`（`message`+`part`） | DB 权威（`storage/*.json` 已遗留） | 中（实库读端 8/8 过 + 写端 INSERT 列已对实库 schema 核对；真实写回采样仍待做） |
| Pi | [pi.md](./pi.md) | `~/.pi/agent/sessions/--<path>--/<ts>_<uuid>.jsonl` | 单文件 JSONL 树 | 低 |
| Cursor / Windsurf | [cursor-windsurf.md](./cursor-windsurf.md) | 未落盘到本机（占位） | unknown | — |

约定：每档包含 `定位 → 物理格式 → 记录格式 → 发现/resume → 可 resume 最小集合 → IR 映射 → 约束/坑`。新增 agent 时在此表追加一行并新建同名 `*.md`。
