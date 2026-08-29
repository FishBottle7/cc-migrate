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
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

    const workerPath = path.resolve(__dirname, '../worker/worker.mjs');
    const appRoot = path.resolve(__dirname, '..');
    const child = spawn('node', [workerPath], {
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
