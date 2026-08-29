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
src/main/worker-host.ts worker 子进程宿主（spawn/超时/重启/stderr 捕获）
src/main/ipc-types.ts   App 自有 IPC 契约（渲染进程做结构对接）
src/renderer/   Vue 3 应用（index.html + App.vue）
preload/        contextBridge 桥（.cjs 直接加载，无需构建）
worker/worker.mjs  system-Node worker：core 全能力 + PreviewMessageDTO 组装
scripts/dev.mjs dev 编排：先起 vite(5183) 就绪后拉起 Electron
```

注意：主进程产物是**平铺**的（`tsconfig.main.json` rootDir=src/main → `dist/index.js`），
启动入口是 `npx electron .`（读 package.json main），不要传 `dist/main/index.js`。

## 安全与数据边界

- 渲染进程 `contextIsolation: true` / `nodeIntegration: false`，一切能力走显式 IPC。
- `list` / `preview` 只读；`migrate` 只写**新会话**，绝不覆盖目标工具已有会话。
- 预览为离线投影（不启动 LLM）；大会话预览文本截断展示（迁移本身无损）。
- 写入默认工具真实存储前，确认页会显式提示默认路径。

## 已知边界

- 打包分发（electron-builder / 跨平台安装包）尚未配置（Phase 4 第 18 项）；
  打包时需把 worker/（system-Node 启动器）与 preload 一并打入 asar，
  且打包产物里 worker 仍依赖用户机器上的系统 Node（PATH 可见）。
- preload 以源文件 `preload/index.cjs` 加载；worker 以源文件加载（依赖 workspace
  根的 node_modules 解析 `@session-migrate/core`）。
