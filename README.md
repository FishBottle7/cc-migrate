# cc-migrate

把 AI 编码工具的对话在工具之间迁移，目标像原生 `continue`/`/resume` 一样接着聊。
核心是一个「统一中间表示（IR）+ 每工具两个适配器」的引擎，避免 N² 两两转换。

> 状态：**Phase 0-2 已完成** — monorepo + IR + 6 家适配器（dsh/claude/codex/pi/opencode/zcode）+ CLI 全矩阵；
> **Phase 4 独立 App GUI 已可用**（`apps/desktop-app`，Electron + Vue 3，选源 → 预览 → 配置 → 写入向导）。
> 架构设计见 [`docs/design.md`](docs/design.md)，6 家格式审计见 [`docs/session-formats-audit.md`](docs/session-formats-audit.md)。

## 结构

```
packages/core/   引擎核心（IR、registry、migrate、各工具适配器）— 零运行时依赖
packages/cli/    命令行（list / preview / migrate / wizard / verify / reconcile）
packages/ui/     跨端复用 Vue 3 组件（SessionPicker / SessionPreview / MigrateWizard）
apps/desktop-app/ 独立 Electron App（主进程直连 core + Vue 3 渲染层）
docs/            架构设计 + 格式审计 + 一 agent 一档
```

## 快速开始

```bash
pnpm install
pnpm --filter @cc-migrate/core run test           # round-trip 测试
pnpm --filter @cc-migrate/cli run build
node packages/cli/dist/src/index.js demo                    # DSH→DSH 自环 demo
node packages/cli/dist/src/index.js tools                   # 列出支持的源工具 id
node packages/cli/dist/src/index.js list dsh                # 列出 ~/.dsh 真实会话
node packages/cli/dist/src/index.js list claude --cwd "D:\codes\myproj" --limit 20 --json  # agent 友好：按项目过滤 + JSON
node packages/cli/dist/src/index.js preview dsh <会话id>     # 离线预览会话内容

# 独立 GUI（Electron）
pnpm --filter @cc-migrate/desktop-app run build && pnpm --filter @cc-migrate/desktop-app start

# Agent skill（跨框架通用：Claude Code / ZCode / DSH / pi / codex / opencode）
pnpm --filter @cc-migrate/cli run pack                     # 产出自包含 tgz（零依赖）
npm i -g packages/cli/cc-migrate-cli-0.2.0.tgz             # 全局安装 CLI
cc-migrate skill install                                   # 把 skill 装进本机所有已检测的 agent 框架
```

Agent 通过 skill 里的「上下文体量纪律」驱动 CLI：`list --limit N --json`、
`preview --json`（≈1-2KB 决策摘要，绝不把聊天记录灌进上下文）、`migrate --json`。
每次成功迁移向 `~/.cc-migrate/migrations.jsonl` 追加一行（append-only，`CC_MIGRATE_LOG`
可改道/`off` 关闭）；`migrate` 前自动查重提示、`log check`/`log list` 主动查询
（「这条迁过了吗」；桌面 App 迁移暂不进日志）。

## 设计核心

统一 IR（`role + content块 + 工具调用 + cwd + model`）是扇出轴：

```
各家格式 --parse--> [IR] --write--> 各家格式
```

每个工具只需 `listSessions / preview / parse / write / resolveCwd` 五个能力，
GUI 与 CLI 共用，不重复实现格式逻辑。详见 `docs/design.md`。

> **安全红线**：引擎只读源会话、只写**新**文件——不含任何删除/覆盖源会话的代码路径；会话删除永远只能由人在源工具里执行（如 pi `/resume` 的 `Ctrl+D`，走 trash 回收站通道），防止误操作打到有价值的会话。

## 里程碑

- ✅ Phase 0：monorepo + IR + DSH 适配器 + round-trip
- ✅ Phase 1：Claude Code 适配器（`claude ⇄ dsh`）
- ✅ Phase 2：Codex + OpenCode + Pi + ZCode，全矩阵 `任意 ⇄ 任意`
- ✅ Phase 3：DSH 插件（`apps/dsh-plugin`：三命令 ✅ + GUI 向导挂载层 ✅ `GuiHost` 协议 + 无头冒烟；真机宿主联调待做）
- ✅ Phase 3.5：对话式迁移（通用 agent skill：`@cc-migrate/cli` 内置 SKILL.md + `skill install` 一键装进各 agent 框架 skill 目录；CLI 输出全面有界化 —— `preview --json` 决策摘要 / `list` 默认 50 条封顶 + 标题截 120 字；DSH 插件额注册运行时 skill + 自带零依赖 agent CLI）
- ✅ Phase 4：独立 Electron App（GUI 向导 ✅；Windows 打包 ✅ nsis+portable+图标 ✅+dist:win:check 一键校验；mac/linux 构建与签名待做）
- 🔶 Phase 5：健壮性（写端碰撞防护 + callId 去重 ✅；残余：损坏文件容错矩阵补全）