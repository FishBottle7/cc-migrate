# session-migrate

把 AI 编码工具的对话在工具之间迁移，目标像原生 `continue`/`/resume` 一样接着聊。
核心是一个「统一中间表示（IR）+ 每工具两个适配器」的引擎，避免 N² 两两转换。

> 状态：**Phase 0 已完成** — monorepo + IR + DSH 适配器 + CLI，DSH↔DSH 自环 round-trip 测试通过。
> 架构设计见 [`docs/design.md`](docs/design.md)，4 家格式审计见 [`docs/session-formats-audit.md`](docs/session-formats-audit.md)。

## 结构

```
packages/core/   引擎核心（IR、registry、migrate、DSH 适配器）— 零运行时依赖
packages/cli/    命令行（list / preview / demo）
packages/ui/     跨端复用 Vue 3 组件（计划 Phase 3）
apps/            DSH 插件 + 独立 Electron App（计划 Phase 3/4）
docs/            架构设计 + 格式审计
```

## 快速开始

```bash
pnpm install
pnpm --filter @session-migrate/core run test           # 自环 round-trip 测试
pnpm --filter @session-migrate/cli run build
node packages/cli/dist/index.js demo                    # DSH→DSH 自环 demo
node packages/cli/dist/index.js list dsh                # 列出 ~/.dsh 真实会话
node packages/cli/dist/index.js preview dsh <会话id>     # 离线预览会话内容
```

## 设计核心

统一 IR（`role + content块 + 工具调用 + cwd + model`）是扇出轴：

```
各家格式 --parse--> [IR] --write--> 各家格式
```

每个工具只需 `listSessions / preview / parse / write / resolveCwd` 五个能力，
GUI 与 CLI 共用，不重复实现格式逻辑。详见 `docs/design.md`。

## 里程碑

- ✅ Phase 0：monorepo + IR + DSH 适配器 + round-trip
- ⬜ Phase 1：Claude Code 适配器（`claude ⇄ dsh`）
- ⬜ Phase 2：Codex + OpenCode，全矩阵 `任意 ⇄ 任意`
- ⬜ Phase 3：DSH 插件 + GUI 向导
- ⬜ Phase 4：独立 Electron App
- ⬜ Phase 5：健壮性