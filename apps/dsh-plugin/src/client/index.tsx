/**
 * cc-migrate DSH plugin — client 半入口（浏览器 React 环境）。
 *
 * DSH 插件双半规范（对齐 dsh-better-sidebar 的 client 形态）：
 *  - package.json `dsh.client.inject` 声明本半要注入的 cordis 服务名；
 *    宿主把本包的 lib/client.js 作为 __ModuleLoader__ 模块注入 web 前端，
 *    `exports.inject` 就是那张服务名表（'betterSidebar' 是
 *    dsh-better-sidebar 在 client ctx 上 publish 的注册表服务）。
 *  - `exports.apply(ctx)` 是插件体：经 `ctx.get('betterSidebar')` 拿注册
 *    表，registerTab 把「会话迁移」tab 挂进右侧边栏。
 *  - react / UI 原语从宿主模块图 require（__ModuleLoader__ 工厂的
 *    `require` 参数）——绝不打进 bundle（peer 运行时）。
 *
 * 本文件是 tsdown 的源 entry；产出经 scripts/wrap-client.mjs 手工包装成
 * `window.__ModuleLoader__.load({id, factory})` 形态（better-sidebar 的
 * lib/client.js 同款——它也是 bundle 后手工/管线包装，rolldown 原生输出
 * 不带这层壳）。
 */

import { createElement } from 'react';
import { MigrateWizardView, type HostPrimitives } from './wizard.js';

/** Tab 图标：纯内联 SVG（14px 圆形循环箭头），不依赖宿主 icon 模块。 */
const TabIcon = (size: number): React.ReactNode =>
  createElement('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
  },
    createElement('path', {
      d: 'M8 2a6 6 0 1 1-5.66 4H4.2A4.5 4.5 0 1 0 8 3.5V6L4.5 3 8 0v2z',
      fill: 'currentColor',
    }));

/* ── 结构类型（better-sidebar 的 service.d.ts 镜像，见 README 侦察注） ──
 * 不 import 'dsh-better-sidebar'：那是宿主 profile 里的 peer 插件（我们
 * 的 tgz 零依赖），类型形状按其 lib/types/client/service.d.ts 手抄成结构
 * 镜像——字段与我们消费的子集一致即可。
 */
interface SidebarTab { id: string; type: string; title?: string }
interface SessionScope { sessionId: string }
interface SidebarStore { unknown: true }

interface TabComponentProps {
  ctx: unknown;
  store: SidebarStore;
  scope: SessionScope;
  tab: SidebarTab;
  visible: boolean;
}

interface TabDescriptor {
  id: string;
  title: string | (() => string);
  icon?: React.ReactNode | ((size: number) => React.ReactNode);
  order?: number;
  single?: boolean;
  component: (props: TabComponentProps) => React.ReactNode;
}

interface BetterSidebarService {
  registerTab(descriptor: TabDescriptor): () => void;
}

/** client cordis ctx 的消费面（结构类型——不依赖 cordis 包）。 */
interface ClientContext {
  get(name: 'betterSidebar'): BetterSidebarService | undefined;
  effect(fn: () => () => void, tag?: string): unknown;
  logger?: { warn(...args: unknown[]): void };
}

/** 宿主 UI 原语 require 的期望形状（require 失败时降级为内联兜底组件）。 */
interface PrimitivesRequire {
  (name: string): unknown;
}

/**
 * 解析宿主 UI 原语（Button/Input）。字段级降级：require 不到包、或包里
 * 没有对应导出，都走 wizard.tsx 的内联兜底——真机宿主永远有
 * dsh-client-ui-primitives（dsh-better-sidebar peer 链），兜底为降级路径。
 */
function resolveUiPrimitives(require: PrimitivesRequire): HostPrimitives {
  try {
    const mod = require('@deepseek-ai/dsh-client-ui-primitives') as Partial<HostPrimitives> | undefined;
    if (mod === null || mod === undefined || typeof mod !== 'object') return {};
    const pick = (name: keyof HostPrimitives): HostPrimitives[typeof name] | undefined => {
      const candidate = mod[name];
      return typeof candidate === 'function' ? (candidate as HostPrimitives[typeof name]) : undefined;
    };
    return { Button: pick('Button'), Input: pick('Input'), Tooltip: pick('Tooltip') };
  } catch {
    // 宿主模块图没这个包（老 runtime）——全部内联兜底
    return {};
  }
}

/**
 * client 插件体：注册「会话迁移」tab。
 *
 * inject 表见 exports.inject（下方）——cordis 按 inject 门禁 ctx 属性访问，
 * 'betterSidebar' 缺席（宿主没装 dsh-better-sidebar）时 apply 不会被调
 * （宿主 modules 加载器等所有 inject 服务就绪才激活）；防御性 get 仍留
 * undefined 分支（同 better-sidebar 的容错姿势）。
 */
export function apply(ctx: ClientContext, require?: PrimitivesRequire): void {
  const service = ctx.get('betterSidebar');
  if (service === undefined) {
    ctx.logger?.warn('cc-migrate: betterSidebar service absent — sidebar tab not registered (is dsh-better-sidebar installed?)');
    return;
  }
  const ui = require === undefined ? {} : resolveUiPrimitives(require);
  ctx.effect(
    () => service.registerTab({
      id: 'cc-migrate',
      title: () => '会话迁移',
      icon: TabIcon,
      // 90 = 排在内置 explorer(100) 之前一点点；同为外部 tab 里靠前但不压内置
      order: 90,
      // 单实例糖：+ 菜单里重复点聚焦已有 tab，不开新实例
      single: true,
      component: (props) =>
        // createElement 而非 JSX：tsdown 的 client 构建不配 jsx 转换也能走
        // （jsx-runtime require 依赖宿主提供，保持同 better-sidebar 的
        // require("react/jsx-runtime") 外置形态反而更脆——直接 createElement）
        createElement(MigrateWizardView, { ui, visible: props.visible }),
    }),
    'cc-migrate: register sidebar tab',
  );
}

/**
 * cordis client 半的服务注入表。'betterSidebar' 由 dsh-better-sidebar 的
 * client 半在激活时 `ctx.provide('betterSidebar', service)`（其
 * src/client/index.tsx）——本包声明 inject 后 cordis 保证 apply 时服务已
 * 就绪。宿主运行时服务（'runtime' 等）不需要：本半不碰宿主 boot 面。
 */
export const inject = ['betterSidebar'] as const;
