/**
 * pack.mjs — 生产可安装的 tgz。
 *
 * 为什么不用裸 `pnpm pack`：它会把 workspace:* 依赖物化为真实版本写进
 * tgz 的 package.json dependencies（@cc-migrate/core 0.1.0 等）——
 * 这些是本仓库的私有包，没有发布到 registry，DSH profile 安装 tgz 时
 * pnpm 按 dependencies 解析会 404。bundle 产物已把 core 整个打进
 * lib/index.js（见 tsdown.config.ts 头注），tgz 必须是【零 dependencies】
 * 形态（与 opencode2dsh 插件同款）。
 *
 * 流程：pnpm pack → 解包 → 剥 dependencies/peerDependencies（ui/vue 是
 * GuiHost 协约的宿主侧可选物，声明成依赖或 peer 都会让宿主安装时试图解析
 * 它们）→ 重打包 → 校验产物 package.json 里 dep 类字段只剩 devDependencies
 * （该字段不影响安装解析）。全程在临时目录进行，不动源 package.json。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const work = mkdtempSync(join(tmpdir(), 'sm-plugin-pack-'));

// Windows 上 execFileSync('pnpm', …) ENOENT（pnpm 是 .CMD shim，不走 shell 时找不到）——
// pnpm 自身用 process.execPath 调度；tar 在 Git Bash 环境的 PATH 上可用。
const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

// 1) 基础 pack 到临时区
execFileSync(pnpmBin, ['pack', '--pack-destination', work], { cwd: appDir, stdio: 'inherit', shell: process.platform === 'win32' });
const tgzName = readdirSync(work).find(f => f.endsWith('.tgz'));
if (!tgzName) throw new Error('pack.mjs: no tgz produced');
const tgz = join(work, tgzName);

// 2) 解包 → 剥 dependencies/peerDependencies → 重打包
// Windows 自带的 bsdtar 对反斜杠路径参数按转义处理——统一转正斜杠。
const stage = join(work, 'rework').split('\\').join('/');
mkdirSync(stage, { recursive: true });
execFileSync('tar', ['-xzf', tgzName, '-C', stage], { cwd: work });
const pkgPath = join(stage, 'package', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const stripped = [];
for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
  if (key in pkg) { delete pkg[key]; stripped.push(key); }
}
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
execFileSync('tar', ['-czf', tgzName, 'package'], { cwd: stage });

// 3) 拷回 app 目录（覆盖 pack 产生的同名 tgz）+ 校验
const finalPath = join(appDir, tgzName);
const { copyFileSync } = await import('node:fs');
copyFileSync(join(stage, tgzName), finalPath);
const verify = JSON.parse(execFileSync('tar', ['-xzOf', tgzName, 'package/package.json'], { cwd: appDir, encoding: 'utf8' }));
for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
  if (key in verify) throw new Error(`pack.mjs: ${key} still present in tgz package.json`);
}
console.log(`pack.mjs: ${tgzName} (${(statSync(finalPath).size / 1024).toFixed(0)}KB) — stripped: ${stripped.join(', ') || 'none'}; verified zero-dependency form`);
