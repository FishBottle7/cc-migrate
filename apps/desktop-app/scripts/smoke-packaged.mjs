/**
 * 打包产物冒烟：验证「dir target 产物里的 worker + core 依赖链」在打包形态下
 * 可被系统 Node 加载并按 JSON-RPC 协议响应。
 *
 * 用法：node scripts/smoke-packaged.mjs <dir产物路径>
 *   例：node scripts/smoke-packaged.mjs "C:\Users\me\Desktop\sm-dist\win-unpacked"
 *   或：node scripts/smoke-packaged.mjs release/win-unpacked
 *
 * 不启动 GUI：无头环境起不了窗口，也不需要 —— 本冒烟只关心「Electron 之外」
 * 的核心架构约束：worker.mjs 及其 @session-migrate/core 依赖链在 asar.unpacked
 * 真实目录里可被系统 Node require/spawn。这正是主进程 worker-host.ts 在打包
 * 形态下做的事（spawn 系统 Node 跑 app.asar.unpacked/worker/worker.mjs）。
 *
 * 检查项：
 *   1. 产物目录布局：resources/app.asar 存在，asar 内有 dist/preload/worker；
 *      resources/app.asar.unpacked/worker/worker.mjs 与
 *      node_modules/@session-migrate/core 存在（asarUnpack 生效）
 *   2. 系统 Node 以【主进程同样的方式】spawn unpacked 的 worker.mjs，
 *      发送一条 list-tools JSON-RPC，断言收到 ok:true 且工具列表非空
 *      —— 证明 core 从 asar.unpacked/node_modules 正常解析（zstd 等重活可用）
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const productDir = process.argv[2];
if (!productDir || !fs.existsSync(productDir)) {
  fail(`用法：node scripts/smoke-packaged.mjs <dir产物路径>（收到：${productDir ?? '无'}）`);
}

const resourcesDir = path.join(productDir, 'resources');
const asarFile = path.join(resourcesDir, 'app.asar');
const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked');

/* ── 1. 布局检查 ─────────────────────────────────────────────── */
if (!fs.existsSync(asarFile)) fail(`未找到 ${asarFile}（这不是 electron-builder dir 产物？）`);
const unpackedWorker = path.join(unpackedDir, 'worker', 'worker.mjs');
if (!fs.existsSync(unpackedWorker)) {
  fail(`${unpackedWorker} 不存在 —— asarUnpack 没把 worker/ 解出来，系统 Node 将无法加载 worker`);
}
const unpackedCore = path.join(unpackedDir, 'node_modules', '@session-migrate', 'core');
for (const rel of ['package.json', path.join('dist', 'src', 'index.js')]) {
  if (!fs.existsSync(path.join(unpackedCore, rel))) {
    fail(`${path.join(unpackedCore, rel)} 不存在 —— asarUnpack 没把 @session-migrate/core 解出来，worker 将无法解析依赖链`);
  }
}
console.log('[layout] app.asar / app.asar.unpacked(worker+core) 布局 OK');

/* ── 2. asar 内主进程产物：解析 asar 头部 JSON（结构：8B 长度前缀 + files 树，
 *      每级目录/文件名是 JSON key），按路径段逐一存在性检查 ───────────── */
const asarHeaderJson = (() => {
  const fd = fs.openSync(asarFile, 'r');
  try {
    // asar 头（pickle 格式）：[0:4]=pickle 头长(恒4) [4:8]=JSON 长+padding
    // [8:12]=JSON 长(同上+padding 修正) [12:16]=净 JSON 长 [16:]=JSON 文本。
    // 两个字段都有 pickle 的 4 字节对齐 padding，取 [12:16] 的净长度最可靠。
    const sizeBuf = Buffer.alloc(16);
    fs.readSync(fd, sizeBuf, 0, 16, 0);
    const jsonSize = sizeBuf.readUInt32LE(12);
    const buf = Buffer.alloc(jsonSize);
    fs.readSync(fd, buf, 0, jsonSize, 16);
    return JSON.parse(buf.toString('utf8')).files;
  } finally {
    fs.closeSync(fd);
  }
})();

function asarHas(segments) {
  let node = asarHeaderJson;
  for (const seg of segments) {
    if (!node || typeof node !== 'object' || !node[seg]) return false;
    node = node[seg].files;
  }
  return true;
}

const asarEntries = [
  ['dist', 'index.js'], // 主进程入口
  ['dist', 'renderer', 'index.html'], // 渲染层
  ['preload', 'index.cjs'], // contextBridge
  ['worker', 'worker.mjs'], // worker（asar 内占位副本，实际运行用 unpacked）
  ['package.json'], // electron main 字段
];
for (const segs of asarEntries) {
  if (!asarHas(segs)) fail(`app.asar 内缺少 ${segs.join('/')} —— files 配置漏了关键产物`);
}
console.log('[layout] app.asar 内含 dist/preload/worker/renderer/package.json OK');

/* ── 3. worker 协议冒烟（与主进程 worker-host.ts 同款 spawn） ──── */
const child = spawn('node', [unpackedWorker], {
  cwd: resourcesDir, // 与 worker-host.ts 打包分支的 appRoot 一致：resources/
  stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
});
let stderr = '';
child.stderr.on('data', (d) => (stderr += d.toString('utf8')));

const reply = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ timeout: true }), 30_000);
  child.on('message', (m) => {
    clearTimeout(timer);
    resolve(m);
  });
  child.on('exit', (code) => {
    clearTimeout(timer);
    resolve({ exited: code, stderrTail: stderr.slice(-2000) });
  });
  child.send({ id: 1, method: 'list-tools', params: {} });
});

child.kill();

if (reply.timeout) fail('worker 30s 未响应 list-tools');
if (reply.exited !== undefined) fail(`worker 提前退出 code=${reply.exited} stderr：${reply.stderrTail ?? ''}`);
if (reply.id !== 1 || reply.ok !== true) fail(`worker 响应异常：${JSON.stringify(reply).slice(0, 300)}`);
if (!Array.isArray(reply.result) || reply.result.length === 0) {
  fail(`list-tools 返回空：${JSON.stringify(reply.result)}`);
}

console.log(`[worker] list-tools OK：${reply.result.map((t) => t.id).join(', ')}`);
console.log(`PASS — 打包产物 worker + core 依赖链完整可用（${path.basename(productDir)}）`);
