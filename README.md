# session-migrate

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
pnpm --filter @session-migrate/core run test           # round-trip 测试
pnpm --filter @session-migrate/cli run build
node packages/cli/dist/index.js demo                    # DSH→DSH 自环 demo
node packages/cli/dist/index.js list dsh                # 列出 ~/.dsh 真实会话
node packages/cli/dist/index.js preview dsh <会话id>     # 离线预览会话内容

# 独立 GUI（Electron）
pnpm --filter @session-migrate/desktop-app run build && pnpm --filter @session-migrate/desktop-app start
```

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
- 🔶 Phase 3：DSH 插件（`apps/dsh-plugin` 命令层 ✅ —— `/session-migrate list-sources|preview|import` 三命令 + 冒烟；GUI 向导组件挂载待做）
- 🔶 Phase 4：独立 Electron App（GUI 向导 ✅；Windows 打包 ✅ electron-builder nsis+portable 实测出包；mac/linux 构建与签名待做）
- ⬜ Phase 5：健壮性