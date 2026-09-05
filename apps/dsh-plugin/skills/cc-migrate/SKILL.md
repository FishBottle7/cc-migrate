---
name: cc-migrate
description: 把其他 AI 编码工具（Claude Code / Codex / OpenCode / Pi / ZCode / DSH）的历史会话迁移成 DSH 原生可 resume 的新会话。当用户想「搬家 / 迁移 / 导入会话」「在 DSH 里继续之前在别的工具聊的对话」时使用。
whenToUse: 用户提到换工具接着聊、找回旧会话、迁移/导入 session、把 Claude Code/codex/opencode/pi/zcode 的对话带进 DSH
---

# cc-migrate — 对话式会话迁移

你（agent）通过本 skill 帮用户把源工具的历史会话迁移成 DSH 原生可 resume 的新会话。
引擎是 cc-migrate：**读旧写新** —— 源端只读；每次迁移都生成**全新**的 DSH session id，
绝不覆盖、修改或删除任何一侧已有数据。迁移可安全重复（同一会话迁两次 = 两个新会话副本）。

**铁律**：会话的删除/清理只能由人手动执行。用户要求「删掉原来的」时，告知这一规则并停手。

## 上下文体量纪律（最高优先级）

你在替用户操作**聊天记录**，一条大会话可达数 MB —— 把它灌进上下文是事故：

- **列会话**永远带 `--limit`（建议 ≤20）与 `--json`；不要无参 `list` 大库
  （默认 50 条封顶、标题截 120 字符，但别依赖兜底）。
- **看内容**先 `preview --json`（有界摘要：计数 + ≤200 字摘录，总计约 1-2KB），
  够确认「是不是这条会话」；`preview` 文本（前 120 行）只在用户明确想看时用；
  `--full` 禁止主动使用 —— 仅当用户说「给我看全文」且会话体量已知较小时才用。
- **不要**把 list/preview 原样转述进回复；挑重点（时间 + 一行标题 + id 尾 8 位）。
- `migrate` 输出恒为一行（或小 JSON），安全。

## 执行器

所有操作通过插件自带的 CLI（无依赖，`node` 直接跑）：

```
node "{{CLI_PATH}}" <command> [args] [flags]
```

- `{{CLI_PATH}}` 由插件注册时替换为本机绝对路径。若占位符未被替换或该文件不存在，
  依次回退：① PATH 上的 `cc-migrate`（独立 CLI，命令语义一致但 migrate 需显式给
  `<dstTool>`=dsh；它还带 `skill install`，可把通用版 skill 装进本机其他 agent
  框架的 skill 目录）；② 都没有 → 让用户重装 cc-migrate 插件（tgz）或从
  cc-migrate 仓库全局安装 `@cc-migrate/cli`，然后重试。
- 成功输出人类可读行；`--json` 时整段 stdout 是合法 JSON（标题可能含换行/制表符，
  **程序化解析一律用 `--json`**）。
- 失败时 stderr 打 `error: ...`、退出码 1 —— 把原因转述给用户，不要盲目重试写操作。

## 工作流

1. **确认源工具**。用户没说就用 `list` 逐个试，或直接问一句。工具 id：
   `claude` `codex` `opencode` `pi` `zcode` `dsh`（dsh→dsh 是同工具搬家/备份）。
2. **找目标会话**：`list <tool> --json --limit 20 [--cwd <用户项目目录>]`。
   每条含 `sessionId / title / createdAt / cwd / sourcePath`。`title` 是源工具的
   原生标题（通常 LLM 生成；claude 无标题时回退到最近/第一条用户 prompt），
   可能缺失或很长 —— 拿不准就用 `preview` 看内容再让用户确认。
   用户在某个项目里聊过的会话，优先传 `--cwd` 过滤（归一化后精确匹配）。
3. **（可选）确认内容**：`preview <tool> <sessionId> --json` —— 有界决策摘要
   （`stats` 消息/轮次/工具调用数、`textChars` 体量、`firstUserMessages` ≤200 字
   摘录），够判断「是不是这条会话」且不撑上下文；多候选时列摘要让用户挑。
   `preview <tool> <sessionId>` 打印前 120 行离线文本（`--lines N` 调行数），
   仅在用户明确想看内容时用；`--full` 全文不要主动用。
4. **迁移**：`migrate <tool> <sessionId> [--cwd <目标工作目录>] --json`。
   - `--cwd` 是新 DSH 会话的工作目录，**默认沿用源会话的 cwd** —— 用户想把会话
     落到别的项目时才需要传。
   - 成功输出新 `sessionId` 与写入文件路径。报告给用户：在 DSH 会话列表里直接
     resume 即可接着聊（迁移复现对话历史，不会重放之前的文件/shell 副作用）。
5. **汇报后结束**。除非用户要求，不要连续迁移多会话；批量需求先列清单让用户圈定。

## 命令参考

```
tools                                    # 列出源工具 id
list <tool> [--root <dir>] [--cwd <dir>] [--limit N] [--json]   # 新到旧；默认 50 条封顶，N=0 不限
preview <tool> <sessionId> [--root <dir>] [--json] [--messages K] [--lines N] [--full]
migrate <tool> <sessionId> [--src-root <dir>] [--cwd <dir>] [--root <dstRoot>]
        [--session-id <id>] [--flatten | --no-flatten] [--keep-runtime-context] [--json]
skill install [--agent <id,id>|--all] [--dir <path>] [--json]   # 把通用 cc-migrate skill 装进本机其他 agent 框架
skill status [--json]                    # 各框架 skill 安装状态
```

- `--json` 时整段 stdout 是合法 JSON；`list --json` 的标题截 120 字符，更完整的
  确认走 `preview --json`。

- `--root`（list/preview）= 源工具存储根，默认各工具标准位置（如 claude 的
  `~/.claude/projects`）；`--src-root`（migrate）同义。
- `--root`（migrate）= DSH sessions 根，默认 `~/.dsh/sessions`。
- `--flatten`：把隐藏的子代理/旁链对话拍平成顶层消息（用户想「连子代理的对话一起看」时用）。
- `--keep-runtime-context`：保留源端注入的运行时上下文（默认丢弃，由目标 harness 自管）。
- 源工具的自定义存储根、子代理会话、归档会话等边缘情况：list 结果里
  `[archived]` 标记归档；父会话字段缺失时直接按普通会话处理。

## 对话守则

- 列表给用户看时挑重点：时间 + 标题（截断到一行）+ id 后 8 位即可，别整屏 dump。
- 迁移完成后必须报出：源会话标题 → 新 DSH session id（短形式即可）+ 「可在会话列表 resume」。
- 用户描述模糊（「上周那个调 bug 的会话」）时，用 `list --cwd <项目>` + 标题关键词帮
  用户缩小范围，而不是一次迁移一堆。
- 写操作（migrate）前把将要做的事一句话说清（源 → 目标 + 落点目录）；migrate 本身
  无破坏性，无需逐次征求确认。
