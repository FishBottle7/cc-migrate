/**
 * dist:* 脚本的前置步骤：为 electron-builder 选产物目录并把决策传给 electron-builder。
 *
 * 背景：electron-builder.yml 里 directories.output 用了 ${env.SM_DIST_DIR}。
 * 本机（作者机器）D: 盘常年 100% 满，而 electron-builder 一个 win 全量
 * （nsis+portable+dir）要写 ~700MB（Electron 运行时 + 三个产物副本），
 * 写 D: 会 ENOSPC。这里在「仓库盘剩余空间不足」时把产物目录指到
 * 桌面的 sm-dist/（C: 盘），磁盘宽裕则默认 ./release（仓库内，已 gitignore）。
 *
 * 传值方式：pnpm run 链上各 script 是独立进程，环境变量没法直接带给下一个
 * script —— 所以这里把决策写进 .sm-dist-dir（一个本地小文件，已 gitignore），
 * 而 dist:* 脚本链是 `node scripts/set-dist-dir.mjs && pnpm run build && electron-builder ...`，
 * pnpm run 会把 stdin 之外的环境透传……实际上不会。因此 electron-builder 的
 * 调用改由本脚本直接 exec：见底部 —— 本脚本设置好 process.env.SM_DIST_DIR 后
 * 直接 spawn electron-builder（沿用所有命令行参数），这样环境变量必然生效。
 */

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(__dirname, '..'); // app 根（本脚本在 scripts/ 下）
const repoRoot = path.resolve(appDir, '../..');

function freeBytesOnWindows(p) {
  // fsutil volume diskfree 需要管理员；用 PowerShell 查驱动器剩余量
  const drive = path.parse(path.resolve(p)).root;
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `(Get-PSDrive ${drive.slice(0, 1)}).Free`],
    { encoding: 'utf8' },
  );
  return Number(out.trim());
}

const repoDriveFree =
  process.platform === 'win32'
    ? freeBytesOnWindows(repoRoot)
    : fs.statfsSync(repoRoot).bsize * fs.statfsSync(repoRoot).bavail;

const FALLBACK_MIN = 2 * 1024 ** 3; // 2GB：一个 win 全量产物 + tmp 的安全下限

if (process.env.SM_DIST_DIR) {
  console.log(`[dist-dir] SM_DIST_DIR 已设置，沿用：${process.env.SM_DIST_DIR}`);
} else if (process.platform === 'win32' && repoDriveFree < FALLBACK_MIN) {
  process.env.SM_DIST_DIR = path.join(os.homedir(), 'Desktop', 'sm-dist');
  fs.mkdirSync(process.env.SM_DIST_DIR, { recursive: true });
  console.log(
    `[dist-dir] 仓库盘剩余 ${(repoDriveFree / 1024 ** 3).toFixed(1)}GB < 2GB，产物目录改到 ${process.env.SM_DIST_DIR}`,
  );
} else {
  process.env.SM_DIST_DIR = path.join(appDir, 'release');
  fs.mkdirSync(process.env.SM_DIST_DIR, { recursive: true });
  console.log(`[dist-dir] 产物目录：${process.env.SM_DIST_DIR}`);
}

// 直接 exec electron-builder（不回到 shell），保证 SM_DIST_DIR 生效。
// electron-builder 二进制位于本包 node_modules/.bin（pnpm run 的 PATH 语义）。
const args = process.argv.slice(2); // 透传 --win / --win dir 等
// 不走 .bin 的 CMD shim（它对路径里的空格/引号敏感），直接用 node 跑 cli.js。
// 注意两点（都是实测踩过的坑）：
//   1. cli 会从 process.cwd() 找 electron-builder.yml 与 package.json —— 必须
//      以 app 根为 cwd 运行（本脚本在 scripts/ 下）；
//   2. require.resolve 用来定位 pnpm symlink 后的真实 cli.js。
const { createRequire } = await import('node:module');
const req = createRequire(path.join(appDir, 'package.json'));
const cliPath = req.resolve('electron-builder/cli.js');
try {
  execFileSync(process.execPath, [cliPath, ...args], {
    stdio: 'inherit',
    env: { ...process.env },
    cwd: appDir,
  });
} catch (e) {
  process.exitCode = e.status ?? 1;
}
