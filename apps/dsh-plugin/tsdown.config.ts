import { defineConfig } from 'tsdown/config';

/**
 * DSH 插件发布形态：单文件 ESM bundle（宿主半）+ client 半独立构建。
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
 *
 * client 半（src/client/index.tsx → lib/client.raw.js）：React 向导，react
 * /react-dom/@deepseek-ai/* 全部 external（宿主模块图运行时提供，绝不
 * 打进 bundle——better-sidebar client 同款纪律）。产物【不是】直接可用的
 * 形态：rolldown 输出裸 ESM，而 DSH 宿主要求 `window.__ModuleLoader__
 * .load({id, factory})` 包装（better-sidebar lib/client.js 的形态）——
 * scripts/wrap-client.mjs 在 build 后做手工包装成 lib/client.js。
 */
export default defineConfig({
  // cli.ts 是插件自带的 agent CLI 入口（lib/cli.js，skill 正文 {{CLI_PATH}}
  // 指向它）——与 index/gui/client 并列的独立 entry。
  entry: ['src/index.ts', 'src/gui.ts', 'src/cli.ts', 'src/client/index.tsx'],
  format: 'esm',
  dts: true,
  outDir: 'lib',
  platform: 'node',
  // tsdown 默认把 package.json dependencies 全部 external（neverBundle 语义）
  // ——core 必须强制打进 bundle（私有 workspace 包，见头注），ui/vue 留给
  // 宿主（GuiHost 协约的动态 import，外部保持）。client 半（src/client/*）
  // 的 react 与宿主 UI 原语同理：宿主模块图运行时提供。
  deps: {
    alwaysBundle: ['@cc-migrate/core'],
    // ui/vue 是 GuiHost 协约的宿主侧动态 import；react / react-dom /
    // @deepseek-ai/* 是 client 半的宿主模块图运行时（better-sidebar client
    // 同款：绝不打进 bundle，宿主 __ModuleLoader__ 的 require 提供）。
    neverBundle: ['@cc-migrate/ui', 'vue', 'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  },
  // 产物后缀：package.json 的 main/exports 指 lib/index.js，DSH 的 cordis
  // 加载器按 package.json 解析——产物保持 .js（不产 .mjs）。client 半的
  // entry（src/client/index.tsx → 名为 client/index 的 chunk）产成
  // client.raw.js：它还不是宿主可加载形态（差 __ModuleLoader__ 工厂壳），
  // scripts/wrap-client.mjs 包装后写 lib/client.js——raw 后缀防半成品被
  // 直接引用。
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  // tsdown 按 chunk name 出产物：给 client 半改名需要 hook——最简做法是
  // 先用固定 .js 出全部，wrap 脚本读 chunk 名判断。见 scripts/wrap-client.mjs。
  // （实际 rename 在 wrap 脚本内做：tsdown 产 lib/client/index.js，脚本
  // 包装成 lib/client.js 并删中间目录。）
  hooks: {
    'build:done': async (ctx) => {
      const { renameSync, rmSync } = await import('node:fs');
      const { join } = await import('node:path');
      const outDir = ctx.options.outDir ?? 'lib';
      // tsdown 对 src/client/index.tsx 的产物路径是 outDir/client/index.js
      // —— 展平成 outDir/client.raw.js 给 wrap 脚本消费
      const nested = join(outDir, 'client', 'index.js');
      const flat = join(outDir, 'client.raw.js');
      try {
        renameSync(nested, flat);
        rmSync(join(outDir, 'client'), { recursive: true, force: true });
        console.log('tsdown: flattened client chunk -> lib/client.raw.js (wrap-client.mjs takes over)');
      } catch {
        // 单 entry 直出（未来 tsdown 行为变化）——wrap 脚本自带兼容
      }
    },
  },
  unbundle: false,
});
