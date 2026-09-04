/**
 * Local typecheck stub for `@cc-migrate/ui`（纯 tsc 用，宿主侧不用）。
 *
 * ui 是源码包（main: ./src/index.ts，.vue 由宿主 vite/vue-tsc 构建编译），
 * dsh-plugin 的构建是纯 tsc：tsc 不认 SFC，直接拉 ui 的 src/index.ts 会在
 * `.vue` 导入上炸。tsconfig 的 `paths` 把裸导入 `@cc-migrate/ui` 重定向
 * 到本桩——只为 dsh-plugin 的编译期声明形状；运行时（lib/gui.js 的动态
 * import）解析真实包，由宿主构建时带 vue 编译。真实渲染形状由 ui 包自己的
 * `vue-tsc` typecheck 保证（`pnpm --filter @cc-migrate/ui run typecheck`）。
 *
 * GUI 层实际消费面：经 `host.mount(container, component, props)` 把组件原样
 * 交给宿主，从不读组件内部结构，所以 `unknown` 是诚实且完整的类型。
 */

declare module '@cc-migrate/ui' {
  /** 组件对 GUI 层是不透明载荷：唯一操作是原样传给 host.mount。 */
  export const MigrateWizard: unknown;
  export const ToolSelect: unknown;
  export const SessionPicker: unknown;
  export const SessionPreview: unknown;
  export const TargetConfig: unknown;
}
export {};
