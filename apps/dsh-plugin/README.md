# @session-migrate/dsh-plugin

DSH cordis 插件：把任意 AI 编码工具（claude / codex / opencode / pi / zcode / dsh）的会话
迁移成 DSH 原生可 resume 的 session。本插件是 `@session-migrate/core` 引擎的薄封装，
只暴露「任意工具 → DSH」一条线（design.md §5）。命令层（`src/commands.ts`）是与宿主
解耦的纯函数；cordis 侧（`src/index.ts`）只做注册、参数解析与 fiber 清理。

不依赖任何 cordis 包：对 DSH 宿主 ctx 做结构类型（`PluginContext`），插件独立于宿主的
cordis 版本。**DSH 宿主命令服务的实际名称/形状以宿主为准**——`PluginContext.commands`
里声明的 `register(name, handler) => unregister()` 是对宿主的最小假设；若宿主 API 不同，
只需调整 `src/index.ts` 的这一处访问点，命令层无需改动。

## 安装

构建产物入口 `lib/index.js`，patch 文件 `cordis.patch.yml`。DSH 侧挂载方式（bundle patch）：

1. 安装本包（`@session-migrate/dsh-plugin`），让 DSH 的 node_modules 可解析到它。
2. 在 DSH 的 bundle patch 列表里加入本包导出的 patch 行（`exports['./cordis.patch.yml']`）：

```yaml
- insert:
    - id: session-migrate
      name: '@session-migrate/dsh-plugin'
      config: {}
```

即本包根目录 `cordis.patch.yml` 的内容（可直接引用该文件）。`config` 目前可留空；
`dstRoot` 可选，用于固定默认 DSH sessions 根目录（默认 `~/.dsh/sessions`）。

构建与自检（仓库内）：

```bash
pnpm --filter @session-migrate/dsh-plugin run build   # tsc 零错误
pnpm --filter @session-migrate/dsh-plugin run test     # 冒烟：mock ctx 注册 3 命令 + 临时目录里跑 list/preview/import
```

## 命令用法

| 命令 | 用法 | 说明 |
|---|---|---|
| list-sources | `/session-migrate list-sources <tool> [--root <dir>]` | 列出源工具的历史会话（标题/时间/id/cwd）。tool ∈ dsh, claude, codex, opencode, pi, zcode |
| preview | `/session-migrate preview <tool> <sessionId> [--root <dir>]` | 离线文本预览该会话（不调 LLM、不写任何文件） |
| import | `/session-migrate import <tool> <sessionId> [--src-root <dir>] [--cwd <dir>] [--root <dstRoot>] [--session-id <id>]` | 把源会话写成 DSH 原生可 resume 的新会话 |

- `--cwd`：新 DSH 会话的工作目录（默认沿用源会话的 cwd）。绝对路径 → `--<projectKey>--`
  布局；非绝对/缺失时安全降级到 `_no-cwd`（core 保证，不会写坏文件）。
- `--src-root` 指源工具的存储根（默认各工具标准路径，如 `~/.claude/projects`）；
  `--root`/`--dst-root` 指 DSH 侧 sessions 根（默认 `~/.dsh/sessions`）。两者独立。
- 全部命令失败时返回结构化错误 `{ ok: false, error }`，不会让异常炸穿宿主。

示例：

```
/session-migrate list-sources claude
/session-migrate preview claude 84c74b02-5ad2-4226-831d-98dc2a10c2ff
/session-migrate import claude 84c74b02-5ad2-4226-831d-98dc2a10c2ff --cwd D:\codes\myproj
```

## 安全红线

- **只读源、只写新文件**：import 每次都用全新 session id（`crypto.randomUUID()`）写入
  DSH 存储，绝不覆盖、改写或「修复」任何一侧已有的会话；源端只读。
- 代码中不存在任何 unlink / rm / DELETE / TRUNCATE 类操作。索引/缓存最多追加。
- **会话的删除只能由人手动执行**——迁移失败或写坏的产物也只是留在原地，由人决定去留
  （见仓库 AGENT.md 全库铁律）。
- 测试与冒烟脚本全部在 `os.tmpdir()` 的临时目录里进行，不触碰真实 `~/.dsh` /
  `~/.claude` 等默认路径；真实路径仅在宿主内用户显式执行命令时使用。

## 状态

Phase 3 第一步：命令层 + 插件骨架。GUI 向导（复用 `packages/ui` 的
SessionPicker / SessionPreview / MigrateWizard）是下一步。
