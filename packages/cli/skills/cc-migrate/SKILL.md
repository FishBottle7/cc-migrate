---
name: cc-migrate
description: Migrate AI coding sessions between tools (Claude Code / Codex / OpenCode / Pi / ZCode / DSH) via the cc-migrate CLI. Use when the user wants to move, import, or back up a conversation/session from one coding agent to another and continue it there.
whenToUse: 换工具接着聊、找回/搬家旧会话、迁移或导入 session、跨工具复制对话历史
---

# cc-migrate — 会话迁移

你（agent）通过 `cc-migrate` CLI 帮用户把一个 AI 编码工具的历史会话迁移到另一个工具，
迁移后在目标工具里像原生会话一样接着聊。支持 `dsh / claude / codex / opencode / pi / zcode`
之间的任意方向。

**铁律**：读旧写新 —— 源端只读；每次迁移在目标端生成**全新** session id，绝不覆盖、
修改或删除任何已有会话。迁移可安全重复（同一会话迁两次 = 两个新副本）。用户要求
「删掉原来的/去重」时：告知删除只能由人手动执行，然后停手。

## 上下文体量纪律（最高优先级）

你在替用户操作**聊天记录**，一条大会话可达数 MB —— 把它灌进上下文是事故：

- **列会话**永远带 `--limit`（默认就该 ≤20），程序化解析用 `--json`；
  不要无参数 `list` 大库。
- **看内容**先 `preview --json`（有界摘要：计数 + ≤200 字摘录，总计约 1-2KB），
  够用来确认「是不是这条会话」；`preview`（前 120 行文本）只在用户明确想看时用；
  `--full` 禁止主动使用 —— 仅当用户说「给我看全文」且会话体量已知较小时才用。
- **不要**把 list/preview 原样转述进回复；挑重点（时间 + 一行标题 + id 尾 8 位）。
- `migrate` 输出恒为一行（或小 JSON），安全。

## 执行器

```
cc-migrate <command> [args] [flags]
```

- 先 `cc-migrate tools` 确认可用；失败提示未安装时，安装方式：
  `npm i -g @cc-migrate/cli`（已发布时），或从仓库检出目录
  `npm i -g <仓库>/packages/cli`，随后 `cc-migrate skill install` 可把本 skill
  装进本机其他 agent 框架的 skill 目录。
- 成功输出人类可读行；`--json` 时整段 stdout 是合法 JSON。程序化解析一律 `--json`。
- 失败：stderr `error: ...`、退出码 1 —— 把原因转述给用户；写操作失败不要盲目重试。

## 工作流

1. **确认方向**：源工具 + 目标工具（用户没说就问一句；「搬进 X」= 迁移到 X）。
2. **找会话**：`cc-migrate list <srcTool> --limit 20 --json` 再按需收紧过滤
   （`--search <关键词|id片段>` 标题子串/id 片段大小写不敏感；`--since 7d`、
   `--since 2026-08-01` 时间窗；`--cwd <项目目录>` ——「同一项目」语义：cwd
   相等或互为祖先/后代，用户在子目录里问也能命中挂在仓库根的会话）。
   每条含 `sessionId / title / createdAt / cwd / sourcePath`（标题是各工具原生
   标题，claude 无标题时回退到最近/第一条用户 prompt；可能缺失或超长）。
   多个过滤可叠加：`list claude --search 413 --since 30d --json`。
3. **确认内容**：`cc-migrate preview <srcTool> <sessionId> --json` —— 用
   `stats`（消息/轮次/工具调用数、textChars 体量）和 `firstUserMessages` 摘录
   判断是不是目标会话；多候选时列摘要让用户挑。
4. **迁移**：`cc-migrate migrate <srcTool> <sessionId> <dstTool> [--target-cwd <dir>] --json`
   - migrate 前会自动查**迁移日志**（本机 `~/.cc-migrate/migrations.jsonl`，只追加）：
     该源会话迁过的话，stderr 会提示此前的目标会话（`--json` 在 `alreadyMigrated`
     字段）。这只是事实提示，**不阻止**再次迁移（重复迁移安全，恒写新副本）。
   - 用户问「这条迁过了吗」：`log check <srcTool> <sessionId> --json` 看 `migrated`
     字段；`log list` 回顾最近迁移（默认 20 条）。
   - `--target-cwd` 是新会话的工作目录，默认沿用源会话 cwd。
   - 成功输出新 session id 与写入文件路径。汇报：源标题 → 新 id，提示到目标工具
     resume（迁移复现对话历史，不重放之前的文件/shell 副作用）。
5. 批量需求先列清单让用户圈定，不要自行连续迁移多会话。

## 命令参考

```
tools                                        # 支持的工具 id
list <tool> [--root <dir>] [--cwd <dir>] [--search <kw|id>] [--since <7d|ISO>] [--before <...>] [--limit N] [--json]
                                             # 新到旧；默认 50 条封顶；--search 命中标题或 id 片段
preview <tool> <sessionId> [--json] [--messages K] [--lines N] [--full]
migrate <srcTool> <sessionId> <dstTool> [--src-root <dir>] [--dst-root <dir>]
        [--target-cwd <path>] [--flatten|--no-flatten] [--keep-runtime-context] [--json]
verify dsh [--root <dir>] [sessionId]        # 校验迁移产物（仅 dsh 目标）
reconcile dsh [--root <dir>]                 # 修复 dsh workspace.json 登记（仅 dsh 目标）
log check <srcTool> <sessionId> [--json]     # 「这条迁过了吗」——迁移日志查重
log list [--limit N] [--json]                # 最近迁移记录（默认 20 条，新到旧）
skill install [--agent <id,id>|--all] [--dir <path>] [--json]   # 把本 skill 装进其他 agent 框架
skill status [--json]                        # 查看各框架 skill 安装状态
```

- `--root`（list/preview）= 源工具存储根（默认各工具标准位置，如
  `~/.claude/projects`）；migrate 时 `--src-root` 指源端、`--dst-root` 指目标端。
- `--flatten`：把隐藏的子代理/旁链对话拍平成顶层消息（用户想连子代理对话一起带走时用）。
- `--keep-runtime-context`：保留源端注入的运行时上下文（默认丢弃，目标 harness 自管）。
- `list --json` 的 `title` 截到 120 字符；更完整的确认走 `preview --json`。
- `[archived]` 标记 = 源端归档会话，照常可迁移。

## 安装本 skill 到其他 agent 框架

`cc-migrate skill install` 探测本机已装的 agent（`~/.claude`、`~/.zcode`、
`~/.agents` 跨工具共享根、`~/.dsh`、`~/.pi`、`~/.codex`、`~/.config/opencode`）
并把本 SKILL.md 拷进各自的 skill 目录；`--agent <id>` 指定、`--dir <path>` 自定
位置、`--json` 机器可读。只写 `cc-migrate/` 这一个子目录，不碰其他 skill。

DSH 用户装了 cc-migrate DSH 插件时无需本文件 —— 插件会注册同名的运行时 skill
（执行器指向插件自带 CLI，目标钉死 dsh）。
