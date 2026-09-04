import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

/**
 * 只负责渲染进程：Vue 3 SFC 编译 + 打包。
 * @cc-migrate/ui 以源码形式被编译（packages/ui 不单独构建），
 * 与未来 DSH 插件前端的消费方式一致。
 */
export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@cc-migrate/ui': fileURLToPath(new URL('../../packages/ui/src/index.ts', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome130',
  },
  server: {
    port: 5183,
    strictPort: true,
  },
});
