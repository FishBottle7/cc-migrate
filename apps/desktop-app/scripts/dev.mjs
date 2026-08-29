/**
 * dev 编排：先起 vite dev server（渲染进程热更新），
 * 就绪后拉起 Electron（加载 dev server URL）。Ctrl+C / 任一子进程退出即整体回收。
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5183;
const DEV_URL = `http://localhost:${PORT}`;

const vite = spawn(
  process.execPath,
  [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'],
  { cwd: root, stdio: 'inherit' },
);

let electron = null;
let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  vite.kill();
  if (electron) electron.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
vite.on('exit', shutdown);

async function waitUntilReady(retries = 150) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(DEV_URL);
      if (res.ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`vite dev server 未在预期时间内就绪（${DEV_URL}）`);
}

try {
  await waitUntilReady();
  const electronBin = require('electron');
  electron = spawn(electronBin, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: DEV_URL },
  });
  electron.on('exit', shutdown);
} catch (e) {
  console.error(String(e));
  shutdown();
}
