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

## Agent skill（对话式迁移）

斜杠命令是给人点用的；想让用户**直接跟 agent 对话**完成迁移（「把我在 Claude Code
里昨天调 bug 的那个会话搬过来」），插件把一个 agent skill 注册进宿主的
`ctx.skills` 注册表（`@deepseek-ai/dsh-skill`，结构面见 `src/skill.ts`）：

- **skill 本体**：`skills/cc-migrate/SKILL.md`（frontmatter name/description/
  whenToUse + 正文）。宿主把 description/whenToUse 用于触发路由；用户也可显式
  `/cc-migrate` 调用。正文教 agent 三步走：`list`（挑会话）→ `preview`（确认）→
  `migrate`（写入 DSH），并明确铁律：**读旧写新、绝不删除/覆盖、迁移可安全重复**。
- **执行通道**：插件自带一个零依赖 agent CLI `lib/cli.js`（`src/cli.ts`，复用命令层）。
  注册时 skill 正文里的 `{{CLI_PATH}}` 占位符被替换为本机绝对路径——agent 经 bash
  `node <…>/lib/cli.js <cmd>` 驱动迁移，**无需任何全局安装**。`{{CLI_PATH}}` 未被
  替换（手工安装 SKILL.md 的场景）时正文自带回退规则：PATH 上的独立 `cc-migrate`
  （命令语义一致，`migrate` 需显式补 `<dstTool>`=dsh）→ 都没有则提示重装插件。
- **向后兼容**：宿主没有 skills 服务时（老版本），注册降级为 warn 一条日志，
  三条斜杠命令与 GUI 完全不受影响（`src/skill.ts` 与 routes/gui 同款 try/catch
  探测纪律——ctx 是按 inject 门禁的 Proxy，探测必须包 try/catch）。

agent CLI 的命令面（flag 语义与独立 CLI 一致；`--json` 输出整段合法 JSON——
标题可能含换行/制表符，程序化解析一律走 `--json`；上下文体量纪律见 skill 正文）：

```
node lib/cli.js tools
node lib/cli.js list <tool> [--root <dir>] [--cwd <dir>] [--limit N] [--json]   # 新到旧；默认 50 条封顶 + 标题截 120 字
node lib/cli.js preview <tool> <sessionId> [--root <dir>] [--json] [--messages K] [--lines N] [--full]
                                         # --json = ≈1-2KB 决策摘要（计数 + ≤200 字摘录，与 session 体量无关）
node lib/cli.js migrate <tool> <sessionId> [--src-root <dir>] [--cwd <dir>]
                        [--root <dstRoot>] [--session-id <id>] [--json]
node lib/cli.js log check <tool> <sessionId> [--json]   # 「这条迁过了吗」（迁移日志查重）
node lib/cli.js log list [--limit N] [--json]           # 最近迁移记录
node lib/cli.js skill install [--agent <id,id>|--all] [--dir <path>] [--json]   # 把通用 skill 装进本机其他 agent 框架
node lib/cli.js skill status [--json]
```

- `list --cwd`：按会话 cwd 过滤（分隔符/尾斜杠归一化，win32/darwin 大小写不敏感；
  无 cwd 信息的会话被排除）——agent 帮用户找「这个项目里的会话」的主入口。
- `--flatten` / `--no-flatten` / `--keep-runtime-context`（migrate）：与命令层
  `importSession` 的 flatten/keepSynthetic 一一对应。

### 通用 skill（跨框架）与 DSH 专属 skill 的关系

- **通用 skill** 的单一事实源在独立 CLI 包（`packages/cli/skills/cc-migrate/SKILL.md`）：
  框架无关、教 agent 用 `cc-migrate` 全量命令（任意方向迁移），由
  `cc-migrate skill install` 探测 `~/.claude` `~/.zcode` `~/.agents` `~/.dsh`
  `~/.pi` `~/.codex` `~/.config/opencode` 并装进各自用户级 skill 根（只写
  `cc-migrate/` 子目录，绝不删除；卸载由人手动删目录）。
- **DSH 专属 skill**（本文件 `skills/cc-migrate/SKILL.md`）：插件 apply() 时
  经 `ctx.skills.register` 注册为运行时 skill，执行器指向插件自带的
  `lib/cli.js`（`{{CLI_PATH}}` 注册期替换为本机绝对路径），目标钉死 any→dsh。
  同名通用 skill 与运行时 skill 并存时宿主让运行时优先 —— DSH 用户的体验
  最短路径，其他框架走通用版。
- 插件包在 build 期用 `scripts/sync-universal-skill.mjs` 把通用 SKILL.md
  同步为 `skills/universal/SKILL.md` 副本（单一事实源仍在独立 CLI，副本
  gitignore），因此 **只装插件的机器** 也能 `node lib/cli.js skill install`
  把通用 skill 铺到本机其他 agent —— 不必再装独立 CLI。

## GUI 会话迁移向导（dsh-better-sidebar 侧边栏 tab）

插件带一条图形界面：DSH web 右侧边栏的「会话迁移」tab（dsh-better-sidebar
的扩展服务注册）。v0.3.0 按 **DSH 窄栏（320-420px）** 重构并对齐独立桌面
程序的体验：四步流程「选源工具 → 工作区分组浏览 → 富预览 → 导入参数 →
结果」。**前提：profile 里已安装 `dsh-better-sidebar`**（v0.12.0+，提供
`betterSidebar` 注册表服务与右侧边栏本体）——没装时 client 半不激活，
命令层不受影响。

### 侧边栏交互（v0.3.0）

- **工作区分组 + 子会话树**：会话按 `cwd` 分组（组头 = 路径短名 + 会话数
  徽章，悬停显示全路径），组可折叠/展开，折叠状态 localStorage 记忆
  （key 前缀 `cc-migrate:`）；组内 `parentSessionId` 的子会话缩进 14px/层
  挂在父会话下（语义移植自桌面版 `sessionTree.ts` 的 buildNodes）。行内
  搜索过滤标题 / 会话 id / 工作目录。
- **富预览**：消息流渲染 text / thinking（弱化斜体披露行）/ tool_use+
  tool_result（按 callId 融合成折叠卡：工具名 + 参数摘要，展开看输入输出，
  isErr 红标）/ harness 注入行；子代理旁链与独立程序同构——头部
  「子代理 · N」切换按钮 → 树形菜单（主会话节点 + 树枝旁链节点，各带消息
  数），点击节点**整区切换**该旁链的完整消息流；可定位的节点带「定位召唤
  处」准星，点击跳回主会话流中它的 tool_use 卡并闪烁高亮（召唤点 =
  parentCallId，缺失时退化到 tool_result 文本匹配）；超长块显示「已截断」
  角标（语义移植自桌面版 `flow.ts` 的 computeFlow + `SessionPreview.vue`
  的切换器，markdown 渲染与山峰定位条未移植——零依赖纪律 + 侧栏收益低）。
- **导入确认（红线）**：确认页显式展示写入目标根（`defaults` 端点回显
  插件配置的 `dstRoot`；未配置时显示 `~/.dsh/sessions（DSH 默认）`——与
  命令层 `opts.root ?? defaultRoot` 行为一致），并标注「写入的是全新会话，
  不会覆盖已有会话」；参数 = 工作目录（留空沿用源会话）+ 拍平子代理旁链
  （flatten）+ 保留 harness 注入行（keepSynthetic）。结果页给新 session
  id + 落盘路径 + 「在 DSH 会话列表选中即可 resume」提示。
- **导入成功自动跳转**（v0.3.3）：结果页出现后自动调宿主 client runtime
  的 `ctx.sessions.open(新会话 id)`（ISessions，better-sidebar 同款 inject
  声明），DSH 主界面即切到新会话可直接续聊。open 对「还没进客户端会话
  列表」的 id 会同步 throw（宿主源码锚定语义），所以带退避重试（~4.5s
  窗口）等列表刷新；始终失败回落结果页提示行（手动在会话列表选择）。
  sessions 服务探测失败（老宿主）时功能静默关闭，其余不受影响。
- **浅色/暗色自适应**：颜色全部走宿主 `--dsw-alias-*` 设计系统 token
  （`src/client/theme.ts`，与 better-sidebar 同一套），随宿主主题翻转；
  拿不到变量（老宿主/无头冒烟）时回退内联暗色兜底，观感不变。
- **窄栏密度**：源工具切换为紧凑 chip 行；会话行单行高密度（标题截断 +
  相对时间 + 归档/空/子标签）；消息块卡内边距 ≤8px。

### 双半架构

DSH 插件官方双半规范（与 dsh-better-sidebar 自身同构）：

```
宿主半（Node，lib/index.js）                 client 半（浏览器，lib/client.js）
  apply(ctx)                                   window.__ModuleLoader__.load({id, factory})
  ├─ ctx.commands.register（3 斜杠命令）        ├─ exports.inject = ['betterSidebar',
  └─ ctx.webServer.register                    │                    'sessions']
       prefix /cc-migrate/api                  └─ exports.apply(ctx)
         ├─ POST list-sources                    └─ ctx.get('betterSidebar').registerTab({
         ├─ POST preview        ←──── fetch ────      id: 'cc-migrate', title: '会话迁移',
         ├─ POST import                             order: 90, single: true,
         └─ POST defaults（目标根回显）            component: (props) => <React 向导/>
       （fence: Host 回环/trustedHosts）            })
```

- **数据通道**：client 半的 React 向导 `fetch('/cc-migrate/api/<method>')`
  （POST JSON）；宿主半路由转发到命令层纯函数（`lib/commands.js`），结果以
  `{ok:true,value}` / `{ok:false,error:{code,message}}` 信封回写——实现
  照抄 dsh-better-sidebar 的 `/sidebar/api` 模式。`defaults` 是 v0.3.0 的
  加性端点（同 fence 保护，只回显目标根路径配置）。
- **浏览器信任围栏**：所有路由过 /api 网关同款 fence（Host 头回环或宿主
  `webRuntime.trustedHosts`，带 Origin 时须同主机，`sec-fetch-site:
  cross-site` 拒绝）——防 DNS rebinding / 跨站页打到宿主路由。fence 每请求
  现读 trustedHosts 活性值，宿主换列表即时生效。
- **UI 原语**：优先宿主 `@deepseek-ai/dsh-client-ui-primitives`（Button/
  Input/Tooltip——client 半经宿主 require 拿），字段缺失自动降级为内联
  React 元素 + 内联样式（`--dsw-alias-*` token + 暗色兜底），不引第三方
  UI 库。
- **client 半文件结构**（`src/client/`，全部打进 lib/client.js）：`index.tsx`
  （tab 注册 + 原语/sessions 服务解析 + migrateViews 冒烟锚点导出）、`wizard.tsx`（四步
  状态机 + 确认/结果页 + 导入后自动跳转）、`session-list.tsx`（分组 + 折叠记忆 + 树）、
  `preview-flow.tsx`（computeFlow + 旁链切换器/整区视图 + 分页）、`theme.ts`（主题
  token）、`api.ts`（fetch 通道）。
- **构建形态**：client 半由 tsdown 出 rolldown bundle，`scripts/wrap-client.mjs`
  手工包装成 `window.__ModuleLoader__.load({id, factory})` 工厂壳（与
  better-sidebar `lib/client.js` 逐字段同形态）；react / react-dom /
  @deepseek-ai/* 全部 external（宿主模块图运行时 require 提供，绝不打进
  bundle）。package.json 的 `dsh.client.inject` 声明 client 半注入
  `["@deepseek-ai/dsh-client-runtime", "dsh-better-sidebar"]`。

### 安装与使用

```bash
dsh plugin --profile web add ./cc-migrate-dsh-plugin-0.3.3.tgz   # 宿主半 + client 半一起装
# 重装同版本前先清安装位（pnpm integrity 命中不重解压的 stale 坑）：
#   rm -rf ~/.dsh/profiles/web/node_modules/@cc-migrate/dsh-plugin
# 重启 dsh web 后：右侧边栏 + 菜单 → 「会话迁移」tab
```

1. 打开右侧边栏的 + 菜单，选「会话迁移」（单实例 tab）。
2. 第一步：点工具 chip（DSH/Claude Code/Codex/Pi/OpenCode/ZCode），下方
   按工作区分组列出该源库的会话；源库地址可手改后「刷新」，行内搜索框过滤。
3. 第二步：点任一会话 → 富预览（消息流 / 思考 / 工具卡 / 子代理旁链 /
   截断角标），「显示更多」翻页。
4. 第三步：「下一步：导入设置」→ 确认页核对目标根与参数 → 「执行导入」。
5. 结果页：新 session id + 落盘路径 + resume 提示（read-old-write-new，
   已有会话不受影响）。
   （截图占位：真机渲染验证后补——见「当前验证状态」。）

为什么不用 `@cc-migrate/ui` 的 MigrateWizard（Vue）：DSH 前端是 React，
跨框架挂载（Vue-in-React 微前端）复杂且脆，裁定轻量 React 重写；数据形状
完全复用命令层 DTO（`PreviewPayload` / `SessionMeta`），`src/client/api.ts`
是 gui.ts `createWizardBackend` 的 fetch 改写（MigrationBackend 同一契约语义）。

### GuiHost 协议（旧 Vue 通道，保留为兼容层）

> 注：这是 **design.md Phase 3 §15 的原始 Vue 通道**（`src/gui.ts` +
> `lib/gui.js`），在 better-sidebar tab 方案落地后作为兼容层保留：宿主若
> 自行实现了 `ctx.gui` 服务，向导仍可经它挂 `@cc-migrate/ui` 的
> `MigrateWizard`。两套 GUI 互不干扰——新宿主用上面的 sidebar tab，老宿主
> 用这条协议。

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

- 无头冒烟 `test/smoke.mjs` 覆盖命令层 + **agent skill 注册（新）**：
  命令注册（mock ctx 注册 3 命令 + shape 校验）、list/preview/import 全链、
  import 恒 mint 新 id、无 skills 服务的宿主降级不炸；skills 正路径断言
  （register 形状校验、name=cc-migrate、{{CLI_PATH}} 已替换为本机 lib/cli.js
  绝对路径、注销器经 ctx.effect 挂钩且执行后注销生效）。
- 无头冒烟 `test/cli-smoke.mjs` 覆盖 **插件自带 agent CLI（新）**：子进程真跑
  `node lib/cli.js`——tools 枚举、`list --json` 信封（ok/tool/count/sessions）、
  `--cwd` 归一化命中/排除、`--limit`、`preview --json` 有界摘要（<4KB、摘录
  ≤200 字）、`migrate --json` 写入临时 DSH 根并回报
  `{source,target:{sessionId,paths}}`（文件落盘非空、二次迁移 mint 新 id）、
  `skill install --dir`（通用 skill 落盘、无 {{CLI_PATH}} 占位符、status 探测
  7 框架）、失败路径（未知工具/未知命令/坏 --limit/不存在的会话 → exit 1 +
  stderr `error: …`）。
- 无头冒烟 `test/client-smoke.mjs` 覆盖 **better-sidebar GUI 全链**：
  - bundle 形态（`__ModuleLoader__` 壳逐字段断言、无裸 ESM 语句、react
    不入 bundle）；工厂执行（mock 宿主 require → `{apply, inject,
    migrateViews}`）；`apply(ctx)` → `registerTab` 收到形状合法的
    TabDescriptor（better-sidebar service.d.ts 契约）；组件树经
    `react-dom/server` 无头渲染拉通；dispose 链注销。
  - **v0.3.0 新视图结构**（经工厂导出的 migrateViews 渲染 bundle 内的真
    组件，非冒烟复刻）：工作区分组（cwd 分组/树挂接/孤儿落根/徽章计数/
    14px 缩进）、受控折叠 + `cc-migrate:` 折叠记忆回环（坏存储降级）、
    富预览（思考/工具/注入块、截断角标；旁链 = desktop 同款切换器 +
    整区切换：主视图无内联旁链、菜单树节点/召唤准星、旁链视图主流换出）；
    自动跳转重试（openSessionWithRetry：撞列表刷新竞态的重试落地 + 节拍
    耗尽回落 fail——宿主 `select()` 对未知 id 同步 throw 的语义锚定）。
  - 宿主半路由：方法表 4 method（含 `defaults` 目标根回显）、前缀路由
    注册、fence 违例矩阵（跨站 Host/Origin/sec-fetch-site 403、同主机
    200、GET 405、未知 404、坏 JSON 400、trustedHosts 活性生效）、
    list/preview/import 全链真数据（临时 claude 库）、read-old-write-new
    （两次导入两个全新 id）；**preview 的真实 wire 载荷喂回 client 预览
    视图渲染**——命令层 DTO ↔ client 视图两端一致性检查（DTO 漂移在此
    拦截）。
- 安装位冒烟 `test/installed-smoke.mjs`（v0.3.0 新增，真机联调前最后一道
  无头关）：`node test/installed-smoke.mjs [installRoot]` 对 **DSH profile
  安装位** 的 lib/client.js 做壳形态静态断言 + 工厂执行 + 全视图无头渲染
  （分组/折叠/富预览/旁链）。能抓 pack 漏文件、安装 stale（pnpm integrity
  命中不重解压）、wrap 壳炸壳。react/react-dom 按配对纪律选（安装图有同
  大版本配对就用安装位的，否则整套退回仓库 devDeps——渲染器与工厂绝不跨
  react 副本混用）。
- 无头冒烟 `test/gui-smoke.mjs` 覆盖 **旧 Vue 通道协议层**：工厂失败路径
  （ui 未打包 → 可读错误）、成功路径（`mount(container, component,
  { backend })` 契约 + backend 六方法）、三条数据通道真走到命令层、
  `handle.dispose()` 幂等、`apply()` 在有/无 `ctx.gui` 两种宿主下的行为。
- 组件渲染正确性由 ui 包自己的 vue-tsc 保证：
  `pnpm --filter @cc-migrate/ui run typecheck`。
- **真机渲染留主会话联调**：tab 在真实 DSH web 里的呈现（+ 菜单位置/图标/
  浮窗行为）、宿主原语 Button/Input 的实际视觉、fetch 跨端口 fence 行为
  （真实 `--trusted-host` 部署）、better-sidebar 版本兼容面。无头冒烟已把
  契约违例（fence 漏洞、形态漂移、TabDescriptor 字段缺失）全部拦在装进
  宿主之前。

## 安全红线

- **只读源、只写新文件**：import 每次都用全新 session id（`crypto.randomUUID()`）写入
  DSH 存储，绝不覆盖、改写或「修复」任何一侧已有的会话；源端只读。
- **迁移日志只追加**：每次成功迁移向 `~/.cc-migrate/migrations.jsonl`（`CC_MIGRATE_LOG`
  覆盖/`off` 关闭）追加一行记录（`log check`/`log list` 查询）——append-only，
  不 rewrite、不删除，日志写失败不影响迁移本身。
- 代码中不存在任何 unlink / rm / DELETE / TRUNCATE 类操作。索引/缓存最多追加。
- **会话的删除只能由人手动执行**——迁移失败或写坏的产物也只是留在原地，由人决定去留
  （见仓库 AGENT.md 全库铁律）。
- 测试与冒烟脚本全部在 `os.tmpdir()` 的临时目录里进行，不触碰真实 `~/.dsh` /
  `~/.claude` 等默认路径；真实路径仅在宿主内用户显式执行命令时使用。

## 状态

Phase 3 第 15 项完成 + 对话式迁移入口（v0.2.0）：命令层 + 插件骨架 + GUI 向导
（better-sidebar 侧边栏 tab 双半形态：fenced HTTP 数据通道 + React 向导
client 半 + 旧 GuiHost Vue 通道保留为兼容层）+ **agent skill**（`ctx.skills`
注册的运行时 skill + 插件自带零依赖 agent CLI `lib/cli.js`，SKILL.md 可单独
拷给其他宿主）。无头冒烟 ×4 全绿（命令层/skill 注册/GUI/client/cli）；真机
渲染联调见「当前验证状态」。
