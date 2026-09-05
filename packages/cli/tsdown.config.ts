import { defineConfig } from 'tsdown/config';

/**
 * CLI 发布形态：bin 入口单文件自包含 bundle。
 *
 * 为什么 bundle：`@cc-migrate/core` 是本仓库的 workspace 私有包（未发布
 * registry），`npm i -g <tgz>` 装包时按 dependencies 解析会 404。参照
 * dsh-plugin 的发布形态（tsdown 单文件 + 剥依赖 tgz），把 core 整个打进
 * dist/src/index.js，tgg 自包含零依赖。
 *
 * 只覆写 bin 入口（src/index.ts → dist/src/index.js）；wizard 等其余文件
 * 由 tsc 正常出（dist/test/*.test.js 依赖 dist/src/wizard.js 的可读产物，
 * 进程内测试不需要 bundle）。
 */
/**
 * CLI 发布形态：bin 入口单文件自包含 bundle（outDir bundle/，独立于 tsc 的
 * dist/ —— tsdown 默认清空 outDir，绝不能让它碰 dist/test 的测试产物）。
 *
 * 为什么 bundle：`@cc-migrate/core` 是本仓库的 workspace 私有包（未发布
 * registry），`npm i -g <tgz>` 装包时按 dependencies 解析会 404。参照
 * dsh-plugin 的发布形态（tsdown 单文件 + 剥依赖 tgz），把 core 整个打进
 * bundle/index.js，tgz 自包含零依赖。
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'bundle',
  platform: 'node',
  format: 'esm',
  dts: false,
  deps: {
    alwaysBundle: ['@cc-migrate/core'],
  },
  outExtensions: () => ({ js: '.js' }),
});
