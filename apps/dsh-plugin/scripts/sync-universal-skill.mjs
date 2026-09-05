/**
 * sync-universal-skill.mjs — 把独立 CLI 的通用 SKILL.md 同步进插件包。
 *
 * 通用 skill 的单一事实源在 packages/cli/skills/cc-migrate/SKILL.md（独立
 * CLI 随包分发并负责 `cc-migrate skill install`）。插件包也带一份副本：
 * DSH 用户的机器上往往只装了本插件 tgz（拿不到独立 CLI），插件自带的
 * agent CLI（lib/cli.js 的 `skill install`）用这份副本把通用 skill 装进
 * 本机其他 agent 框架的 skill 目录 —— 不然每个框架都要单独装一遍独立 CLI。
 *
 * build 期同步（build = tsc + 本脚本，先于冒烟与 bundle），副本不进版本库
 * 由 gitignore？—— 不：副本进版本库会让两份文件悄悄漂移；这里选「每次
 * build 强制覆盖 + 内容哈希校验」的机器同步，git 里忽略
 * skills/universal/（.gitignore 已加）。
 */

import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, '..');
const src = join(pluginDir, '..', '..', 'packages', 'cli', 'skills', 'cc-migrate', 'SKILL.md');
const destDir = join(pluginDir, 'skills', 'universal');
const dest = join(destDir, 'SKILL.md');

let srcStat;
try {
  srcStat = statSync(src);
} catch {
  console.error(`sync-universal-skill: source missing: ${src}`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });

// 内容相同则跳过（避免触碰 mtime 触发不必要的重装/重打包链）
let same = false;
try {
  same = statSync(dest).size === srcStat.size && readFileSync(dest, 'utf8') === readFileSync(src, 'utf8');
} catch {
  same = false;
}
if (same) {
  console.log('sync-universal-skill: universal SKILL.md already up to date');
} else {
  copyFileSync(src, dest);
  console.log(`sync-universal-skill: ${src} -> ${dest}`);
}
