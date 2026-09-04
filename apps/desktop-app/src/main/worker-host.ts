/**
 * core 工作进程宿主：spawn 系统 Node 运行 worker/worker.mjs，
 * JSON-RPC 风格转发。worker 崩溃/退出后下次请求自动重启；
 * 挂起的请求在退出时整体失败。
 *
 * 为什么是系统 Node 而非 utilityProcess：utilityProcess 仍是 Electron
 * 内置 Node，其 node:zlib zstd 在部分帧上原生崩溃（见 worker.mjs 头注）。
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ── 打包形态的路径解析 ──────────────────────────────────────────
 *
 * dev（pnpm start / electron .，未打包）：
 *   主进程跑在 apps/desktop-app/dist/index.js，worker 在
 *   <app>/worker/worker.mjs，node_modules 就在 <app>/node_modules —— 一切
 *   天然可用，直接 __dirname 相对路径。
 *
 * packaged（electron-builder，asar: true）：
 *   主进程跑在 resources/app.asar/dist/index.js（Electron 把 asar 虚拟文件
 *   系统挂进 __dirname）。但 worker 由【系统 Node】子进程加载——系统 Node
 *   不认识 asar，没法 require 虚拟路径里的 ESM 及其依赖链。所以 electron-
 *   builder.yml 把 worker/ 与 node_modules/@cc-migrate/core asarUnpack
 *   到了 resources/app.asar.unpacked/。这里把 asar 内的路径改写成
 *   .unpacked 下的真实路径：
 *     .../app.asar/dist  →  .../app.asar.unpacked/dist   （作为 appRoot 的锚点）
 *     .../app.asar/worker/worker.mjs → .../app.asar.unpacked/worker/worker.mjs
 *
 * appRoot（spawn 的 cwd）在打包形态下取 resources/ 目录：worker.mjs 用
 * `@cc-migrate/core` 裸导入，Node 从 worker 文件位置逐级向上找
 * node_modules —— app.asar.unpacked/worker → app.asar.unpacked/node_modules
 * （asarUnpack 的 core 就在这，满足解析）。dev 形态下则必须保持
 * <app> 根，指向 apps/desktop-app/node_modules（pnpm symlink 到 packages/core）。
 */

function isPackaged(): boolean {
  // 打包后 __dirname = <resources>/app.asar/dist —— 路径里出现 app.asar 段即打包形态
  // （dev 形态 __dirname = apps/desktop-app/dist，不可能包含该段）
  return __dirname.split(path.sep).includes('app.asar');
}

function resolveWorkerPaths(): { workerPath: string; appRoot: string } {
  if (!isPackaged()) {
    // dev：dist/index.js → <app>/worker/worker.mjs；appRoot=<app>（node_modules 所在地）
    return {
      workerPath: path.resolve(__dirname, '../worker/worker.mjs'),
      appRoot: path.resolve(__dirname, '..'),
    };
  }
  // packaged：__dirname = <resources>/app.asar/dist
  // asar 内的 dist/worker/preload 中只有 worker 被 asarUnpack，改写到真实路径。
  const unpackedRoot = path.join(path.dirname(path.dirname(__dirname)), 'app.asar.unpacked');
  return {
    workerPath: path.join(unpackedRoot, 'worker', 'worker.mjs'),
    // resources/ 目录作为 cwd：worker.mjs 在 unpacked 的 node_modules 里解析 core
    appRoot: path.dirname(unpackedRoot),
  };
}

/* ── 系统 Node 的发现 ──────────────────────────────────────────
 *
 * worker 必须跑在【系统 Node】上（Electron 内置 Node 的 zstd 会原生崩溃，
 * 这是已知坑，不能退回 utilityProcess / ELECTRON_RUN_AS_NODE）。
 * process.execPath 在打包形态下指向 App 自己的 electron.exe，不可用；
 * Windows 上 spawn('node') 不带 .exe 后缀也可能踩 CreateProcess 的坑，所以
 * 依次尝试：PATH 上的 node.exe/node；找不到时给出可操作的错误（Node ≥22.15
 * 的原因：22.14 及更早的 zlib 没有稳定 zstd 绑定，Electron 内置 22.16 的
 * 实现在部分帧上崩溃，系统 Node ≥22.15 稳定）。
 */

const NODE_REQUIRED_HINT =
  '本 App 的会话解析引擎需要系统 Node（≥22.15）运行：请在 https://nodejs.org 安装 Node.js（LTS 即可）并重新打开本 App，' +
  '或改用内嵌 Node 运行时的分发版（如有）。原因：Electron 内置 Node 的 zlib zstd 在部分会话帧上原生崩溃，' +
  '解析引擎必须跑在系统 Node 上。';

let cachedNodeCommand: string | null = null;

function findSystemNode(): string {
  if (cachedNodeCommand) return cachedNodeCommand;
  // process.execPath 打包后是 electron.exe —— 不能用，只找 PATH 上的 node。
  // （dev 形态下 execPath 是 electron 的 node 入口但同样受 zstd 崩溃影响，不用。）
  // Windows 的 CreateProcess 对 PATH 查找时需要 .exe 后缀，spawn(cmd) 不带后缀
  // 也能解析（spawn 内部走 shell:false 的 PATH 搜索），但显式两个候选最稳。
  const candidates = process.platform === 'win32' ? ['node.exe', 'node'] : ['node'];
  for (const cmd of candidates) {
    let ok = false;
    try {
      const probe = spawn(cmd, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
      if (probe.pid) ok = true;
      probe.kill(); // 探测进程立即回收，只确认「能启动」
    } catch {
      // 试下一个候选
    }
    if (ok) {
      cachedNodeCommand = cmd;
      return cmd;
    }
  }
  throw new Error(NODE_REQUIRED_HINT);
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class WorkerHost {
  #proc: ChildProcess | null = null;
  #pending = new Map<number, Pending>();
  #seq = 0;
  #stderrTail = '';
  #workerPaths: { workerPath: string; appRoot: string } | null = null;

  request<T>(method: string, params?: unknown, timeoutMs = 180_000): Promise<T> {
    const proc = this.#ensure();
    const id = ++this.#seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`worker 请求超时（${method}，${timeoutMs}ms）`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      proc.send!({ id, method, params });
    });
  }

  shutdown(): void {
    this.#proc?.kill();
    this.#proc = null;
  }

  #ensure(): ChildProcess {
    if (this.#proc && this.#proc.exitCode === null && this.#proc.pid) return this.#proc;

    const { workerPath, appRoot } = this.#workerPaths ??= resolveWorkerPaths();
    // worker 不存在（打包配置漏了 worker/** 或 asarUnpack）→ 立刻可诊断
    if (!fs.existsSync(workerPath)) {
      throw new Error(`worker 缺失：${workerPath}（打包配置需包含 worker/** 并 asarUnpack）`);
    }
    const child = spawn(findSystemNode(), [workerPath], {
      cwd: appRoot,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });

    child.on('message', (raw: unknown) => {
      const m = raw as { id?: number; ok?: boolean; result?: unknown; error?: string };
      if (typeof m?.id !== 'number') return;
      const p = this.#pending.get(m.id);
      if (!p) return;
      this.#pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error || 'worker error'));
    });

    child.stderr?.on('data', (d: Buffer) => {
      // 保留末尾若干字节用于崩溃诊断
      this.#stderrTail = (this.#stderrTail + d.toString('utf8')).slice(-4000);
    });

    child.on('error', (err) => {
      // spawn 失败（典型：找不到 node）→ 带 NODE_REQUIRED_HINT 一起抛出
      console.error(`[worker] spawn 失败：${err.message}`);
      this.#proc = null;
      for (const [id, p] of this.#pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`${NODE_REQUIRED_HINT}（spawn 失败：${err.message}）`));
      }
      this.#pending.clear();
    });

    child.on('exit', (code) => {
      const tail = this.#stderrTail.trim();
      if (tail) console.error(`[worker] exited code=${code}\n${tail}`);
      else console.error(`[worker] exited code=${code}`);
      this.#stderrTail = '';
      this.#proc = null;
      for (const [id, p] of this.#pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`worker 已退出（code=${code}），请求被取消`));
      }
      this.#pending.clear();
    });

    this.#proc = child;
    return child;
  }
}
