# @cc-migrate/cli

cc-migrate 命令行：在 AI 编码工具（dsh / claude / codex / opencode / pi / zcode）
之间迁移会话，读旧写新 —— 源端只读，目标端永远写全新 session id。

## 安装

```bash
# 自包含 tgz（仓库内打包，零依赖，离线可装）
npm i -g packages/cli/cc-migrate-cli-0.2.0.tgz     # pnpm run pack 产出

# 开发态（本仓库内）
pnpm --filter @cc-migrate/cli run build
alias cc-migrate='node packages/cli/bundle/index.js'   # 或 pnpm link --global
```

## Agent skill

本包内置通用 agent skill（`skills/cc-migrate/SKILL.md`，框架无关：Claude Code /
ZCode / DSH / pi / codex / opencode 都读「目录 + SKILL.md + frontmatter」约定）：

```bash
cc-migrate skill status                    # 各框架检测与安装状态
cc-migrate skill install                   # 装进所有已检测框架的用户级 skill 根
cc-migrate skill install --agent claude,zcode --dir <path>
```

只写各 skill 根下的 `cc-migrate/` 子目录，不碰其他 skill；卸载由人手动删目录。
skill 正文自带「上下文体量纪律」——教 agent 用有界输出（`--json` / `--limit` /
`preview --json` 摘要）驱动本 CLI，不把聊天记录灌进上下文。

## 常用命令

```bash
cc-migrate tools                                  # 支持的工具 id
cc-migrate list claude --limit 20 --json          # 列会话（新到旧，有界）
cc-migrate list claude --cwd "D:\proj" --json     # 只看某项目
cc-migrate preview claude <id> --json             # ≈1-2KB 决策摘要（计数+摘录）
cc-migrate migrate claude <id> dsh --json         # 迁移（新 session id）
```

详见仓库根 README 与 `skills/cc-migrate/SKILL.md`。
