import { defineConfig } from 'tsdown/config';

/**
 * DSH 插件发布形态：单文件 ESM bundle。
 *
 * 为什么 bundle 而不是普通 tsc 产物：`@cc-migrate/core` 是本仓库的
 * workspace 私有包（未发布 registry），DSH 的 profile 安装走 pnpm 装包 +
 * registry 解析依赖——私有 workspace 依赖装不出去。参照 opencode2dsh 插
 * 件的发布形态（tsdown 单文件 + 零 runtime dependencies），把 core 整个
 * 打进 lib/index.js，tgz 里没有任何 dependencies，profile 装 tgz 时零
 * 解析负担。
 *
 * core 里的 node:zlib zstd / node:sqlite 属 ESM 内置模块自动保持 external；
 * `./gui.js` 入口单独一条 entry——它的 @cc-migrate/ui 与 vue 是
 * 【宿主提供】的运行时动态 import（GuiHost 协约），必须 external（在
 * DSH 前端没打包它们时 dynamic import 失败会走可读错误路径，老宿主只
 * 用命令层零影响——src/gui.ts 头注的沙箱纪律）。
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/gui.ts'],
  format: 'esm',
  dts: true,
  outDir: 'lib',
  platform: 'node',
  // tsdown 默认把 package.json dependencies 全部 external（neverBundle 语义）
  // ——core 必须强制打进 bundle（私有 workspace 包，见头注），ui/vue 留给
  // 宿主（GuiHost 协约的动态 import，外部保持）。
  deps: {
    alwaysBundle: ['@cc-migrate/core'],
    external: ['@cc-migrate/ui', 'vue'],
  },
  // 产物后缀：package.json 的 main/exports 指 lib/index.js，DSH 的 cordis
  // 加载器按 package.json 解析——产物保持 .js（不产 .mjs）。
  outExtensions: () => ({ js: '.js' }),
  unbundle: false,
});
