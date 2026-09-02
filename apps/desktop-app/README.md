# desktop-app — session-migrate 独立跨平台 App

「任意 AI 编码工具 ⇄ 任意」的图形向导：选源 → 浏览/预览会话 → 配置目标 → 一键写入。
渲染进程为 Vue 3（复用 `packages/ui` 组件），`contextIsolation` 隔离，渲染层零 Node 能力。

## 运行

```bash
pnpm install                      # workspace 根目录（electron 需放行构建脚本：pnpm approve-builds electron）
pnpm --filter @session-migrate/desktop-app run build   # 主进程 tsc + 渲染层 vite
pnpm --filter @session-migrate/desktop-app start       # 构建并启动（生产模式，加载 dist/renderer）
```

开发模式（vite 热更新 + Electron 自动拉起）：

```bash
pnpm --filter @session-migrate/desktop-app run dev
```

## 架构：为什么有 system-Node worker

**Electron 37 内置的 Node 22.16 在实验性 `node:zlib` zstd 上有原生崩溃 bug**：
对多帧 DSH 会话文件（大文件 2 万+ zstd 帧）调用 `zstdDecompressSync` 会在第 2+ 帧
原生崩溃（crashpad "not connected"，exit 127），无 JS 异常可捕获；系统 Node 24 正常。
主进程也不能简单换 Node —— Electron 的 Node 是绑定的。

因此所有 core 调用（列出工具/会话、解析预览、执行迁移）都在一个
**系统 Node 的子进程**（`worker/worker.mjs`，纯 JS、零构建）里跑：

```
renderer ──contextBridge──> main（薄壳：窗口 + IPC 转发）
                                └─ child_process.spawn('node', worker.mjs)
                                     └─ @session-migrate/core（zstd 解析等重活）
```

- `worker-host.ts`：spawn + JSON-RPC（`process.send`），每请求 180s 超时，
  worker 崩溃自动重启，stderr 尾部 4000 字符记入日志。
- 附带收益：解析/迁移这类秒级重活不阻塞主进程与渲染层。
- 诊断：`SM_SMOKE=1 npx electron .` 不开窗口，走完整 worker 链路解析默认
  大会话后退出，逐步打印 `[smoke] ...`。

## 结构

```
src/main/       Electron 主进程（Node）：窗口 + IPC；backend.ts 纯转发到 worker
src/main/worker-host.ts worker 子进程宿主（spawn/超时/重启/stderr 捕获/打包路径解析）
src/main/ipc-types.ts   App 自有 IPC 契约（渲染进程做结构对接）
src/renderer/   Vue 3 应用（index.html + App.vue）
preload/        contextBridge 桥（.cjs 直接加载，无需构建）
worker/worker.mjs  system-Node worker：core 全能力 + PreviewMessageDTO 组装
scripts/dev.mjs dev 编排：先起 vite(5183) 就绪后拉起 Electron
scripts/set-dist-dir.mjs dist:* 前置：选产物目录（盘满回退桌面）并转调 electron-builder
scripts/smoke-packaged.mjs 打包产物冒烟：asar 布局 + worker JSON-RPC 一条链路
electron-builder.yml 打包配置（win 本机构建；mac/linux 就绪未构建）
```

注意：主进程产物是**平铺**的（`tsconfig.main.json` rootDir=src/main → `dist/index.js`），
启动入口是 `npx electron .`（读 package.json main），不要传 `dist/main/index.js`。

## 安全与数据边界

- 渲染进程 `contextIsolation: true` / `nodeIntegration: false`，一切能力走显式 IPC。
- `list` / `preview` 只读；`migrate` 只写**新会话**，绝不覆盖目标工具已有会话。
- 预览为离线投影（不启动 LLM）；大会话预览文本截断展示（迁移本身无损）。
- 写入默认工具真实存储前，确认页会显式提示默认路径。

## 打包分发（electron-builder）

```bash
pnpm --filter @session-migrate/desktop-app run dist:win      # nsis 安装包 + portable + dir（本机 Windows）
pnpm --filter @session-migrate/desktop-app run dist:win:dir  # 只出未打包目录树（冒烟用，快）
pnpm --filter @session-migrate/desktop-app run smoke:packaged # 打包产物冒烟（见下）
# node scripts/smoke-packaged.mjs <dir产物路径>  等效
```

- 产物目录：仓库盘空间够时是 `apps/desktop-app/release/`；**仓库盘剩余 <2GB 时自动改到
  `%USERPROFILE%\Desktop\sm-dist\`**（`scripts/set-dist-dir.mjs` 检测 —— 本机 D: 盘
  常年满盘，electron-builder 一次 win 全量约需 700MB）。也可用 `SM_DIST_DIR=... pnpm run dist:win`
  显式指定。
- 产物：`session-migrate-<版本>-setup.exe`（nsis 安装包，非一键、可改安装目录）、
  `session-migrate <版本>.exe`（portable 免安装版）、`win-unpacked/`（dir 目录树）。
- macOS（dmg）/ Linux（AppImage）：`electron-builder.yml` 已配置就绪，本机未构建
  （mac 需真机 + 签名身份；linux 可在 WSL/CI 出）。
- 无代码签名：Windows 会弹 SmartScreen 警告，个人工具可接受；有证书后配
  `win.certificateFile` 即可。

### 打包形态下的 system-Node worker（关键架构约束）

所有 core 调用仍跑在**系统 Node 子进程**里——Electron 内置 Node 的 `node:zlib`
zstd 在部分会话帧上原生崩溃（见上节），打包不能改变这一点。落法：

- `worker/**` 与 `node_modules/@session-migrate/core`（含 `dist/src` + `package.json`）
  经 `asarUnpack` 解到 `resources/app.asar.unpacked/` —— 系统 Node 不认识 asar 虚拟
  文件系统，worker 及其依赖链必须在真实文件系统上。
- 主进程 `dist/**`、渲染层 `dist/renderer/**`、`preload/**` 留在 `app.asar` 内
  （Electron 自己认识 asar）；渲染层依赖（vue/@session-migrate/ui）已被 vite 打进
  bundle，asar 内显式排除全部运行时 `node_modules`，asar 仅 ~280KB。
- `worker-host.ts` 的 `resolveWorkerPaths()` 按 `__dirname` 是否位于 `app.asar`
  区分 dev/打包形态：打包后 worker 路径改写到 `app.asar.unpacked/worker/worker.mjs`，
  spawn 的 cwd 取 `resources/`（worker.mjs 的裸导入 `@session-migrate/core` 从
  `app.asar.unpacked/node_modules` 解析）。
- **用户机器需要系统 Node ≥22.15**（PATH 可见）。缺 Node 时 App 给出可操作提示
  （安装 Node.js LTS 或使用便携运行时版）；未来可用 electron-builder `externalBin`
  内嵌 node.exe 消除此依赖（体积 +~80MB，暂不做）。

### 打包冒烟（不启动 GUI）

`scripts/smoke-packaged.mjs <dir产物路径>`：校验 asar 布局（dist/preload/worker/renderer
齐全 + unpacked 的 worker/core 存在），再以主进程同款方式 spawn unpacked 的
worker.mjs 发一条 `list-tools` JSON-RPC，PASS/FAIL 一行结论。更完整的链路自检可用
`SM_SMOKE=1 <产物>/session-migrate.exe`（不开窗口，走主进程→worker→zstd 解析默认
大会话后退出）。
