# @cc-migrate/dsh-plugin

DSH cordis 插件：把任意 AI 编码工具（claude / codex / opencode / pi / zcode / dsh）的会话
迁移成 DSH 原生可 resume 的 session。本插件是 `@cc-migrate/core` 引擎的薄封装，
只暴露「任意工具 → DSH」一条线（design.md §5）。命令层（`src/commands.ts`）是与宿主
解耦的纯函数；cordis 侧（`src/index.ts`）只做注册、参数解析与 fiber 清理。

不依赖任何 cordis 包：对 DSH 宿主 ctx 做结构类型（`PluginContext`），插件独立于宿主的
cordis 版本。**DSH 宿主命令服务的实际名称/形状以宿主为准**——`PluginContext.commands`
里声明的 `register(name, handler) => unregister()` 是对宿主的最小假设；若宿主 API 不同，
只需调整 `src/index.ts` 的这一处访问点，命令层无需改动。

## 安装

构建产物入口 `lib/index.js`，patch 文件 `cordis.patch.yml`。DSH 侧挂载方式（bundle patch）：

1. 安装本包（`@cc-migrate/dsh-plugin`），让 DSH 的 node_modules 可解析到它。
2. 在 DSH 的 bundle patch 列表里加入本包导出的 patch 行（`exports['./cordis.patch.yml']`）：

```yaml
- insert:
    - id: cc-migrate
      name: '@cc-migrate/dsh-plugin'
      config: {}
```

即本包根目录 `cordis.patch.yml` 的内容（可直接引用该文件）。`config` 目前可留空；
`dstRoot` 可选，用于固定默认 DSH sessions 根目录（默认 `~/.dsh/sessions`）。

构建与自检（仓库内）：

```bash
pnpm --filter @cc-migrate/dsh-plugin run build   # tsc 零错误（GUI 层经本地 ui 类型桩过纯 tsc）
pnpm --filter @cc-migrate/dsh-plugin run test     # 冒烟 ×2：命令层（mock ctx 注册 3 命令）+ GUI 协议层（见下）
```

## 命令用法

| 命令 | 用法 | 说明 |
|---|---|---|
| list-sources | `/cc-migrate-list-sources <tool> [--root <dir>]` | 列出源工具的历史会话（标题/时间/id/cwd）。tool ∈ dsh, claude, codex, opencode, pi, zcode |
| preview | `/cc-migrate-preview <tool> <sessionId> [--root <dir>]` | 离线文本预览该会话（不调 LLM、不写任何文件） |
| import | `/cc-migrate-import <tool> <sessionId> [--src-root <dir>] [--cwd <dir>] [--root <dstRoot>] [--session-id <id>]` | 把源会话写成 DSH 原生可 resume 的新会话 |

- `--cwd`：新 DSH 会话的工作目录（默认沿用源会话的 cwd）。绝对路径 → `--<projectKey>--`
  布局；非绝对/缺失时安全降级到 `_no-cwd`（core 保证，不会写坏文件）。
- `--src-root` 指源工具的存储根（默认各工具标准路径，如 `~/.claude/projects`）；
  `--root`/`--dst-root` 指 DSH 侧 sessions 根（默认 `~/.dsh/sessions`）。两者独立。
- 全部命令失败时返回结构化错误 `{ ok: false, error }`，不会让异常炸穿宿主。

示例：

```
/cc-migrate-list-sources claude
/cc-migrate-preview claude 84c74b02-5ad2-4226-831d-98dc2a10c2ff
/cc-migrate-import claude 84c74b02-5ad2-4226-831d-98dc2a10c2ff --cwd D:\codes\myproj
```

## GUI 向导（宿主挂载，design.md Phase 3 §15）

除三个斜杠命令外，插件还带一条「选会话 → 预览 → 配置 → 写入」的向导入口
（`@cc-migrate/ui` 的现成 `MigrateWizard` 组件）。GUI 层是**独立入口
`exports['./gui']`**（`lib/gui.js`）：主入口不静态引它，命令层宿主完全不受
Vue 运行时影响；DSH 前端挂载 Vue 组件的方式没有实机参考，所以本期交付的
是「组件 + 数据桥 + 无头测试」，宿主真实挂载点以 `GuiHost` 协议对接。

### GuiHost 协议（对 DSH 宿主的最小假设，结构类型）

宿主在 `ctx.gui` 上提供以下服务（可选——没有 `ctx.gui` 时插件只剩命令，
向后兼容老宿主）：

| 成员 | 形状 | 说明 |
|---|---|---|
| `logger` | `{ info/warn/error(...args) }` | 宿主日志出口 |
| `mount(container, component, props)` | `() => void`（返回卸载函数） | 把组件挂进宿主容器。`container` 宿主自定义（DOM 元素或等价物），`component` 是 ui 的 Vue 组件，`props` 恒为 `{ backend }` |
| `listSources(tool, root?)` | `Promise<ListSourcesOutcome>` | 数据通道①：转发到命令层 `listSources`（沙箱/线程边界由宿主处理） |
| `preview(tool, sessionId, root?)` | `Promise<PreviewPayload \| CommandError>` | 数据通道②：转发到命令层 `previewPayload`（结构化预览 DTO） |
| `importSession(srcTool, sessionId, opts?)` | `Promise<ImportOutcome>` | 数据通道③：转发到命令层 `importSession`（写入 DSH） |
| `pickDirectory(defaultPath?)` | `Promise<string \| null>`（可选） | 原生目录选择对话框；缺失时向导降级为纯输入框 + warn 日志 |
| `openPath(path)` | `Promise<void>`（可选） | 在文件管理器中展示写入结果；缺失时仅 warn |

GUI 层（`src/gui.ts`）把这些桥接成 ui 组件的 `MigrationBackend` 契约并挂
`MigrateWizard`。**沙箱边界纪律**：GUI 层绝不 import `@cc-migrate/core`，
数据全走注入；core 的 zstd 解压只能跑在宿主 Node 侧，宿主自行决定通道落在
哪个线程/进程。

### DSH 宿主接入步骤（宿主侧清单）

1. **打包 ui**：`@cc-migrate/ui` 是源码包（`main: ./src/index.ts`，.vue
   由宿主构建编译），宿主前端构建链需带 vue/vite（peer `vue: ^3.5.0` 已在
   本包 dependencies 里声明）。`lib/gui.js` 运行时动态 `import('@cc-migrate/ui')`
   —— 宿主没打包它时挂载失败并给出可读错误，命令层不受影响。
2. **提供 `ctx.gui`**：按上表实现服务。数据通道直接转发到本包命令层
   （`lib/commands.js` 的 `listSources` / `previewPayload` / `importSession`）；
   前后端分离的宿主经 IPC 转发即可（通道形状就是命令层函数签名）。
3. **挂载入口（二选一）**：
   - 自动：`apply(ctx)` 检测到 `ctx.gui` 即经 `ctx.effect` 挂向导（容器传
     `undefined`，宿主 `mount` 自行决定落点；适合宿主接管默认位置的场景）；
   - 手动：宿主自行 `import('@cc-migrate/dsh-plugin/gui')` 后调
     `createSessionMigrateWizard(host, { container, dstRoot })`，拿
     `WizardHandle.dispose()` 自己管理生命周期。`opts.loadWizardComponent`
     可注入宿主自己打包的组件副本（默认动态 import 真实包）。
4. **配置**：bundle patch 的 `config.dstRoot` 同时作用于命令层默认 root 与
   向导默认写入位置。

### 当前验证状态

- 无头冒烟 `test/gui-smoke.mjs` 覆盖**协议层**：工厂失败路径（ui 未打包 →
  可读错误）、成功路径（`mount(container, component, { backend })` 契约 +
  backend 六方法）、三条数据通道真走到命令层（临时 claude 库造数据：list /
  结构化 preview / import 全新 id 写入 + 目标白名单）、`handle.dispose()`
  幂等、`apply()` 在有/无 `ctx.gui` 两种宿主下的行为。
- 组件渲染正确性由 ui 包自己的 vue-tsc 保证：
  `pnpm --filter @cc-migrate/ui run typecheck`。
- **真机渲染留宿主联调**（DSH 前端首个 Vue 挂载点）：挂载容器形状、样式
  主题（ui 的 `theme.css`）、`pickDirectory`/`openPath` 的原生对话框桥、
  worker 通道的线程边界——见上面「接入步骤」逐项。

## 安全红线

- **只读源、只写新文件**：import 每次都用全新 session id（`crypto.randomUUID()`）写入
  DSH 存储，绝不覆盖、改写或「修复」任何一侧已有的会话；源端只读。
- 代码中不存在任何 unlink / rm / DELETE / TRUNCATE 类操作。索引/缓存最多追加。
- **会话的删除只能由人手动执行**——迁移失败或写坏的产物也只是留在原地，由人决定去留
  （见仓库 AGENT.md 全库铁律）。
- 测试与冒烟脚本全部在 `os.tmpdir()` 的临时目录里进行，不触碰真实 `~/.dsh` /
  `~/.claude` 等默认路径；真实路径仅在宿主内用户显式执行命令时使用。

## 状态

Phase 3 第 15 项完成：命令层 + 插件骨架 + GUI 向导挂载层（GuiHost 协议 +
无头冒烟，宿主真机联调待 DSH 前端首个 Vue 挂载点落地）。
