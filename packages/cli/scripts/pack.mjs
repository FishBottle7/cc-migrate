/**
 * pack.mjs — CLI 自包含可安装 tgz（零 dependencies）。
 *
 * 为什么不裸 `pnpm pack`：它会把 workspace:* 依赖物化为真实版本写进 tgz 的
 * package.json dependencies（@cc-migrate/core 0.2.0）——这是本仓库的私有包，
 * 没有发布到 registry，`npm i -g <tgz>` 按 dependencies 解析会 404。tsdown
 * 已把 core 整个打进 dist/src/index.js（tsdown.config.ts 头注），tgz 必须是
 * 【零 dependencies】形态。
 *
 * 流程与 apps/dsh-plugin/scripts/pack.mjs 同款：pnpm pack → 解包 → 剥
 * dependencies/peerDependencies/optionalDependencies → 重打包 → 校验。全程
 * 临时目录，不动源 package.json。产物拷回本包目录（*.tgz 已 gitignore）。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const work = mkdtempSync(join(tmpdir(), 'cc-cli-pack-'));

// Windows 上 pnpm 是 .CMD shim，不走 shell 找不到（同 dsh-plugin pack.mjs）
const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

execFileSync(pnpmBin, ['pack', '--pack-destination', work], { cwd: appDir, stdio: 'inherit', shell: process.platform === 'win32' });
const tgzName = readdirSync(work).find((f) => f.endsWith('.tgz'));
if (!tgzName) throw new Error('pack.mjs: no tgz produced');
const tgz = join(work, tgzName);

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

const finalPath = join(appDir, tgzName);
copyFileSync(join(stage, tgzName), finalPath);
const verify = JSON.parse(execFileSync('tar', ['-xzOf', tgzName, 'package/package.json'], { cwd: appDir, encoding: 'utf8' }));
for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
  if (key in verify) throw new Error(`pack.mjs: ${key} still present in tgz package.json`);
}
console.log(`pack.mjs: ${tgzName} (${(statSync(finalPath).size / 1024).toFixed(0)}KB) — stripped: ${stripped.join(', ') || 'none'}; verified zero-dependency form`);
console.log(`install:  npm i -g ${finalPath}`);
