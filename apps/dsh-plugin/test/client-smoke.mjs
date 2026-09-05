/**
 * Headless smoke test for the GUI client half + host-side HTTP routes.
 *
 * 覆盖两条新链（不渲染真 DOM——没有宿主浏览器环境，真机渲染留主会话）：
 *
 *   A. client bundle 形态与执行链（lib/client.js）：
 *      1. 文件存在，`window.__ModuleLoader__.load({id, factory})` 壳形态
 *         静态断言（头尾与 better-sidebar lib/client.js 逐字段对照）。
 *      2. 壳内无 ESM import/export 裸语句（externals 全走 require——react
 *         是宿主运行时，绝不打进 bundle）。
 *      3. 工厂执行：mock __ModuleLoader__ + mock 宿主 require（react /
 *         react/jsx-runtime 用真 node_modules 里的 React 18）→ module.exports
 *         出 {apply, inject}，inject 含 'betterSidebar'。
 *      4. apply(ctx) 执行链：mock cordis ctx（结构同形——effect 收 disposer，
 *         get('betterSidebar') 回注册表 mock）→ registerTab 收到形状合法的
 *         TabDescriptor（id/title/icon/order/single/component 全员校验——
 *         better-sidebar 的 service.d.ts 契约），disposer 路由到 ctx.effect。
 *      5. TabDescriptor.component 渲染链：用 react 的createElement + 真
 *         react-dom/server 的 renderToStaticOutput 把组件树拉出来（无头
 *         SSR 渲染——比真 DOM 弱，但足以证明组件树不炸、可见文本在）。
 *      6. v0.3.0 新视图结构（经工厂导出的 migrateViews 渲染【真组件】——
 *         bundle 内那份，非 smoke 复刻）：分组列表（cwd 分组/树挂接/孤儿
 *         落根/徽章计数/14px 缩进/受控折叠）、折叠记忆（cc-migrate: key
 *         回环 + 坏存储降级）、富预览流（思考/工具/注入块、截断角标；
 *         v0.3.1 起旁链 = desktop 同款切换器 + 整区切换：主视图无内联
 *         旁链、菜单树节点/准星、旁链整区视图主流换出）。
 *
 *   B. 宿主半 fenced 路由（src/routes.ts，宿主同形 mock 纪律）：
 *      7. buildMigrateApi 产出恰好 4 个 method（list-sources/preview/import
 *         /defaults——defaults 回显目标根，确认页红线数据源）。
 *      8. registerMigrateRoutes：mock webServer（register 返回 disposer——
 *         dsh-host-webserver 契约）→ 1 条 prefix 路由 @ /cc-migrate/api。
 *      9. 路由 handler 全链：mock req/res（结构同形——asyncIterator 请求
 *         体、writeHead/end 响应），临时 claude 库（core 写入管线造）的
 *         list 返回 JSON {ok:true,value}；preview 的真实 wire 载荷喂回
 *         client 预览视图渲染——命令层 DTO ↔ client 视图两端一致性检查。
 *     10. fence 违例：跨站 Host/Origin 组合 403；GET 405；未知 method 404；
 *         坏 JSON 400（信封字段齐全——GUI 渲染层吃这些结构）。
 *     11. import method 写临时 DSH root（read-old-write-new：两个全新 id）。
 *
 * Safety: everything happens inside os.tmpdir(); no unlink/rm anywhere.
 */

import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

/* ══════════════ A. client bundle 形态与执行链 ══════════════ */

// ── A1. 文件存在 + 壳形态静态断言 ──────────────────────────────────────
const clientSrc = await readFile('lib/client.js', 'utf8');
assert.ok(clientSrc.startsWith('window.__ModuleLoader__.load('), 'client.js opens with the ModuleLoader wrapper');
assert.ok(clientSrc.includes('id: "@cc-migrate/dsh-plugin"'), 'module id is the package name');
assert.ok(clientSrc.includes('factory: (require)'), 'factory receives the host require');
assert.ok(clientSrc.includes('exports.apply = apply;'), 'factory exports apply');
assert.ok(clientSrc.includes('exports.inject = inject;'), 'factory exports inject');
assert.ok(clientSrc.includes('exports.migrateViews = migrateViews;'), 'factory exports the smoke render anchor (migrateViews)');
assert.ok(clientSrc.includes('return module.exports;'), 'factory returns module.exports');
console.log('[A1] lib/client.js present, __ModuleLoader__ wrapper shape matches better-sidebar field-by-field');

// ── A2. 壳内无 ESM import/export 裸语句 ────────────────────────────────
// externals 必须全走 require（react 是宿主模块图运行时）。裸 import 在工厂
// 壳里是 SyntaxError——宿主加载时直接白屏，必须在静态断言拦住。
const bodyStart = clientSrc.indexOf('factory: (require) => {') + 'factory: (require) => {'.length;
const bodyEnd = clientSrc.lastIndexOf('return module.exports;');
const factoryBody = clientSrc.slice(bodyStart, bodyEnd);
assert.ok(!/^\s*import\s/m.test(factoryBody), 'no bare import statement inside the factory body');
assert.ok(!/^\s*export\s/m.test(factoryBody), 'no bare export statement inside the factory body');
// react 不在 bundle 里：不允许出现 react 的生产源码标记（打进来了会带 license 头）
assert.ok(!factoryBody.includes('react.production.min.js'), 'react itself must NOT be bundled (host provides it)');
console.log('[A2] factory body is require-only (no ESM statements, no inlined react)');

// ── A3. 工厂执行：mock __ModuleLoader__ + 宿主 require ─────────────────
// react/react-jsx-runtime 用本地 node_modules 的 React 18（与宿主运行时同代）；
// ui-primitives 用形态同形的 mock（Button/Input 有则用——验证降级路径两端都活）。
const react = nodeRequire('react');
const jsxRuntime = nodeRequire('react/jsx-runtime');
const hostRequire = (name) => {
  if (name === 'react') return react;
  if (name === 'react/jsx-runtime') return jsxRuntime;
  if (name === '@deepseek-ai/dsh-client-ui-primitives') {
    return { Button: (props) => react.createElement('button', props), Input: (props) => react.createElement('input', props) };
  }
  throw new Error(`host require: unexpected module "${name}"`);
};
const loaderLoads = [];
globalThis.window = {
  __ModuleLoader__: {
    load(mod) {
      loaderLoads.push(mod.id);
      // 直接执行工厂（与宿主加载器同语义：module 表 + require 注入）
      const module = { exports: {} };
      mod.factory(hostRequire);
      return module.exports;
    },
  },
};
eval(clientSrc);
assert.deepEqual(loaderLoads, ['@cc-migrate/dsh-plugin'], 'exactly one module load registered');
console.log('[A3] __ModuleLoader__.load executes the factory against host-shaped requires');

// 工厂导出再验一次（eval 路径已执行；再独立构一次拿返回值，验 return 契约）
const m = { exports: {} };
const factory = eval(`(require, module, exports) => {${factoryBody}\n return module.exports; }`);
const modExports = factory(hostRequire, m, m.exports);
assert.equal(typeof modExports.apply, 'function', 'module.exports.apply is a function');
assert.ok(Array.isArray(modExports.inject) && modExports.inject.includes('betterSidebar'), "module.exports.inject = ['betterSidebar']");
// 冒烟渲染锚点：子视图组件与纯函数全员在表（host-inert——宿主只读 apply/inject）
const views = modExports.migrateViews;
for (const key of ['SessionListView', 'PreviewFlowView', 'groupSessions', 'buildSessionNodes', 'computeFlow', 'loadCollapsedCwds', 'saveCollapsedCwds', 'openSessionWithRetry']) {
  assert.equal(typeof views?.[key], 'function', `migrateViews.${key} is a function`);
}
console.log(`[A3b] factory returns { apply, inject: ${JSON.stringify(modExports.inject)}, migrateViews{${Object.keys(views).length}} }`);

// ── A4. apply(ctx)：registerTab 收到形状合法的 TabDescriptor ────────────
// mock cordis ctx 宿主同形：effect(fn) 立即执行并收 disposer；get('betterSidebar')
// 回注册表 mock（betterSidebar service.d.ts 契约子集）。
const registeredTabs = [];
const effectDisposers = [];
const warns = [];
const mockClientCtx = {
  get: (name) => {
    if (name === 'betterSidebar') {
      return {
        registerTab(descriptor) {
          registeredTabs.push(descriptor);
          return () => { registeredTabs.pop(); };
        },
      };
    }
    return undefined;
  },
  effect(fn, tag) {
    const d = fn();
    effectDisposers.push({ tag, d });
    return () => d?.();
  },
  logger: { warn: (...a) => warns.push(a) },
};
modExports.apply(mockClientCtx);
assert.equal(registeredTabs.length, 1, 'registerTab called exactly once');
const tab = registeredTabs[0];
assert.equal(tab.id, 'cc-migrate', 'tab id');
assert.equal(typeof tab.title === 'function' ? tab.title() : tab.title, '会话迁移', 'tab title renders');
assert.equal(typeof tab.icon, 'function', 'tab icon is a (size) => ReactNode factory');
assert.equal(typeof tab.order, 'number', 'tab order is set (+ menu sort)');
assert.equal(tab.single, true, 'tab single-instance sugar');
assert.equal(typeof tab.component, 'function', 'tab component is a function');
assert.ok(effectDisposers.some((e) => String(e.tag).includes('cc-migrate')), 'registerTab disposer routed through ctx.effect');
console.log(`[A4] apply(): tab "${tab.id}" registered — {id, title:"${tab.title()}", order:${tab.order}, single, component} all valid`);

// 无 betterSidebar 服务（宿主没装 better-sidebar）：warn + 不炸
const noTabs = [];
modExports.apply({
  get: () => undefined,
  effect(fn) { const d = fn(); return () => d?.(); },
  logger: { warn: (...a) => warns.push(a) },
});
assert.equal(noTabs.length, 0);
assert.ok(warns.some((a) => String(a[0]).includes('betterSidebar')), 'absent service logs a warning');
console.log('[A4b] absent betterSidebar service -> warn, no throw');

// ── A5. TabDescriptor.component 渲染链（react-dom/server 无头拉树） ─────
// SSR 渲染足以证明组件树可构造（向导的 hooks/JSX 链活）；交互留真机验证。
// 注：useEffect 不在 SSR 执行，首次渲染 sessions=[]、busy=''——初始态断言
// 用「empty 提示」（fetch 会在挂载后由 useEffect 触发），不是 loading 态。
const server = nodeRequire('react-dom/server');
const element = tab.component({ visible: true });
const html = server.renderToStaticMarkup(element);
assert.ok(html.includes('会话迁移'), 'wizard header text rendered');
assert.ok(html.includes('Claude Code'), 'source tool chips rendered (compact chip row)');
assert.ok(html.includes('源库地址'), 'root input row rendered');
assert.ok(html.includes('该目录下没有找到会话'), 'initial empty state rendered (fetch starts on mount via useEffect)');
assert.ok(html.length > 500, 'rendered tree is substantial (full wizard UI)');
// visible=false 也渲染（侧栏 tab 非激活态——挂起 fetch 的门控逻辑在 hooks 里）
const htmlHidden = server.renderToStaticMarkup(tab.component({ visible: false }));
assert.ok(htmlHidden.includes('会话迁移'), 'wizard renders when not visible too');
console.log(`[A5] tab.component renders headless via react-dom/server (${html.length} chars, header/chips/input row/empty state present)`);

// dispose：ctx.effect 收到的 disposer 是 registerTab 的注销函数
for (const { d } of effectDisposers) if (typeof d === 'function') d();
assert.equal(registeredTabs.length, 0, 'disposers unregister the tab');
console.log('[A5b] dispose chain unregisters the tab cleanly');

// ── A6. 分组列表 + 折叠树（v0.3.0 新视图；语义移植 desktop sessionTree.ts） ──
// 直接渲染 migrateViews 里的【真组件】（bundle 里那份，不是 smoke 复刻）——
// 组件与断言同源，防「组件改了冒烟不知道」的漂移。
const h = (tag, props) => react.createElement(tag, props);

// fixtures：两个工作区 + 子会话挂树 + 孤儿（父不在列表 → 按根）
const now = Date.now();
const META = (over) => ({ tool: 'claude', sessionId: '', createdAt: now, ...over });
const fixtures = [
  META({ sessionId: 'p1', title: '父会话一', createdAt: now - 1_000, cwd: 'D:\\work\\alpha' }),
  META({ sessionId: 'c1', title: '子会话挂树', createdAt: now - 2_000, cwd: 'D:\\work\\alpha', parentSessionId: 'p1' }),
  META({ sessionId: 'p2', title: '另一工作区', createdAt: now - 3_000, cwd: 'C:\\Users\\demo\\beta' }),
  META({ sessionId: 'orphan', title: '孤儿子会话', createdAt: now - 4_000, cwd: 'D:\\work\\alpha', parentSessionId: 'ghost-id' }),
];
const groups = views.groupSessions(fixtures);
assert.equal(groups.length, 2, 'grouped by cwd into 2 groups');
const alpha = groups.find((g) => g.key === 'D:\\work\\alpha');
const beta = groups.find((g) => g.key === 'C:\\Users\\demo\\beta');
assert.ok(alpha && beta, 'both cwd groups present');
assert.equal(alpha.label, 'alpha', 'group label is the last path segment');
assert.equal(alpha.nodes.length, 2, 'alpha roots = parent + orphan (ghost parent falls back to root)');
const p1Node = alpha.nodes.find((n) => n.meta.sessionId === 'p1');
assert.ok(p1Node.children.some((c) => c.meta.sessionId === 'c1'), 'child attached under its parent');
assert.equal(alpha.count, 3, 'group badge counts the whole tree');
assert.equal(groups[0].key, 'D:\\work\\alpha', 'groups sorted by latest session desc');

const listProps = { groups, onToggleGroup: () => {}, onOpen: () => {}, emptyHint: '无匹配结果。' };
const listHtml = server.renderToStaticMarkup(h(views.SessionListView, { ...listProps, collapsed: new Set() }));
assert.ok(listHtml.includes('>alpha<') && listHtml.includes('>beta<'), 'group short-name headers rendered');
assert.ok(listHtml.includes('>3</span>') && listHtml.includes('>1</span>'), 'group count badges rendered');
assert.ok(listHtml.includes('父会话一') && listHtml.includes('子会话挂树'), 'session rows rendered');
assert.ok(listHtml.includes('padding-left:22px'), 'sub-session rows indented one level (8+14px)');
assert.ok(listHtml.includes('刚刚'), 'relative time rendered');
// 折叠断言（受控 collapsed）：alpha 折叠 → alpha 行消失、组头/他组不受影响
const collapsedHtml = server.renderToStaticMarkup(h(views.SessionListView, { ...listProps, collapsed: new Set(['D:\\work\\alpha']) }));
assert.ok(!collapsedHtml.includes('父会话一'), 'collapsed group hides its rows');
assert.ok(collapsedHtml.includes('>alpha<'), 'collapsed group header still rendered');
assert.ok(collapsedHtml.includes('另一工作区'), 'other group rows unaffected');
console.log('[A6] grouped list: cwd grouping + tree attach + orphan-to-root + badge counts + 14px indent + controlled collapse');

// ── A7. 折叠记忆（localStorage，key 前缀 cc-migrate:）──────────────────
// Node 默认没有 localStorage → 空集合（SSR 降级全展开，不炸）
assert.equal(views.loadCollapsedCwds().size, 0, 'no localStorage -> empty collapse set (all expanded)');
// 形状同形假 localStorage（getItem/setItem）→ 写读回环；坏 JSON 降级不炸
const kv = new Map();
try {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: (k) => (kv.has(k) ? kv.get(k) : null), setItem: (k, v) => { kv.set(k, String(v)); } },
    configurable: true,
  });
  views.saveCollapsedCwds(new Set(['D:\\work\\alpha']));
  assert.ok(kv.has('cc-migrate:collapsed-cwds'), 'storage key uses the cc-migrate: prefix');
  assert.deepEqual([...views.loadCollapsedCwds()].sort(), ['D:\\work\\alpha'], 'collapse memory roundtrips');
  kv.set('cc-migrate:collapsed-cwds', '{not json');
  assert.equal(views.loadCollapsedCwds().size, 0, 'corrupt storage degrades to empty set');
  console.log('[A7] collapse memory: cc-migrate: key roundtrip + corrupt-storage degradation');
} catch {
  console.log('[A7] (skip roundtrip — localStorage not definable in this runtime)');
} finally {
  try { delete globalThis.localStorage; } catch { /* accessor 不可删就算了 */ }
}

// ── A8. 富预览流渲染（v0.3.1 起旁链 = desktop 同款「切换器 + 整区切换」）──
// 夹具覆盖：用户行/注入行/思考披露/截断角标/tool 卡融合/未配对错误结果/
// 切换器按钮/树形菜单/召唤点准星/旁链整区视图（不在流内内联渲染）。
const richPayload = {
  tool: 'claude', sessionId: 'rich-1', title: '富预览夹具', createdAt: now, cwd: 'D:\\work\\alpha',
  messageCount: 4, sidechainCount: 2, toolCallCount: 2, hasSidechains: true,
  messages: [
    { role: 'user', blocks: [{ t: 'text', text: '用户提问正文' }] },
    { role: 'user', synthetic: true, blocks: [{ t: 'text', text: '系统注入行' }] },
    { role: 'assistant', blocks: [
      { t: 'think', text: '内部思考第一行\n第二行' },
      { t: 'text', text: '长正文块'.repeat(300), truncated: true },
      { t: 'tool_use', callId: 'call-x', name: 'Bash', text: '{"command":"pnpm build"}' },
    ] },
    { role: 'tool', blocks: [{ t: 'tool_result', callId: 'call-y', isError: true, text: 'boom failed' }] },
  ],
  sidechains: [
    { agentId: 'sc-1', agentType: 'explorer', parentCallId: 'call-x', messages: [
      { role: 'assistant', blocks: [{ t: 'text', text: '旁链内部消息' }] },
    ] },
    { agentId: 'sc-2', agentType: 'librarian', messages: [
      { role: 'assistant', blocks: [{ t: 'text', text: '没有召唤点的旁链' }] },
    ] },
  ],
};
const flowHtml = server.renderToStaticMarkup(h(views.PreviewFlowView, { payload: richPayload }));
assert.ok(flowHtml.includes('用户提问正文'), 'user row rendered');
assert.ok(flowHtml.includes('注入'), 'synthetic user row renders as an injection row');
assert.ok(flowHtml.includes('已思考') && flowHtml.includes('内部思考第一行'), 'thinking disclosure rendered');
assert.ok(flowHtml.includes('已截断'), 'truncated text block carries the truncation badge');
assert.ok(flowHtml.includes('运行命令') && flowHtml.includes('pnpm build'), 'tool_use card with mapped title + input summary');
assert.ok(flowHtml.includes('工具结果') && flowHtml.includes('错误'), 'unpaired error tool_result rendered as error card');
// 旁链 = 切换器模式（v0.3.1，对齐独立程序）：主视图只有按钮，无内联旁链
assert.ok(flowHtml.includes('子代理 · 2'), 'sidechain switcher button with count rendered');
assert.ok(!flowHtml.includes('旁链内部消息'), 'sidechain content NOT rendered inline in the main flow');
assert.ok(!flowHtml.includes('召唤点不在主消息流'), 'no orphan tail section (menu lists all sidechains)');
console.log('[A8] rich preview: think/tool/inject blocks + truncation badge + switcher (no inline sidechains)');

// 菜单展开（initialMenuOpen）：主会话节点 + 树枝旁链节点 + 消息数 + 可定位准星
const menuHtml = server.renderToStaticMarkup(h(views.PreviewFlowView, { payload: richPayload, initialMenuOpen: true }));
assert.ok(menuHtml.includes('富预览夹具') && menuHtml.includes('4 条'), 'menu main-session node with title + message count');
assert.ok(menuHtml.includes('explorer') && menuHtml.includes('librarian'), 'branch nodes labeled by agentType');
assert.ok(menuHtml.includes('定位召唤处'), 'summon crosshair on the locatable sidechain (parentCallId in main flow)');
console.log('[A8b] switcher menu: main node + agentType branch + summon crosshair');

// 旁链整区视图（initialAgentIndex）：整流切换，主会话流不渲染
const agentHtml = server.renderToStaticMarkup(h(views.PreviewFlowView, { payload: richPayload, initialAgentIndex: 0 }));
assert.ok(agentHtml.includes('旁链内部消息'), 'agent view renders the sidechain flow full-area');
assert.ok(agentHtml.includes('子代理 · explorer'), 'switcher button shows the current agent label');
assert.ok(!agentHtml.includes('pnpm build'), 'main flow content absent in agent view (whole-area switch)');
console.log('[A8c] agent whole-area view: sidechain flow only, main flow swapped out');

// ── A9. 自动跳转重试（v0.3.3：导入成功 → ctx.sessions.open 切到新会话）────
// open 的失败语义（宿主 dsh-client-runtime SessionManager.select 源码锚定）：
// id 不在客户端会话列表里就同步 throw——刚导入的会话要等列表刷新，重试
// 节拍覆盖该窗口；port 缺席时功能整体关闭（结果页不渲染跳转行）。
{
  let calls = 0;
  const flaky = { open: () => { calls += 1; if (calls < 3) throw new Error('sessions.select: unknown session x'); } };
  assert.equal(await views.openSessionWithRetry(flaky, 'x', [0, 1, 1, 1]), 'ok', 'retry lands once the session is listed');
  assert.equal(calls, 3, 'open called exactly until success');
  const dead = { open: () => { throw new Error('sessions.select: unknown session x'); } };
  assert.equal(await views.openSessionWithRetry(dead, 'x', [0, 1, 1]), 'fail', 'exhausted retries -> fail (done page shows the manual-select hint)');
}
console.log('[A9] auto-jump: open-with-retry rides the list refresh, exhausts to an honest fail');

/* ══════════════ B. 宿主半 fenced 路由（src/routes.ts） ══════════════ */

const routes = await import('../lib/routes.js');
const core = await import('@cc-migrate/core');

// ── B6. 方法表 ─────────────────────────────────────────────────────────
const api = routes.buildMigrateApi({});
for (const method of ['list-sources', 'preview', 'import', 'defaults']) {
  assert.equal(typeof api[method], 'function', `api method "${method}" exists`);
}
assert.equal(Object.keys(api).length, 4, 'exactly 4 api methods');
assert.deepEqual(await api.defaults(), { dstRoot: null, dshDefaultRoot: '~/.dsh/sessions' }, 'defaults echoes the DSH default root (confirm-page red line)');
assert.deepEqual(await routes.buildMigrateApi({ dstRoot: 'D:\\custom\\root' }).defaults(), { dstRoot: 'D:\\custom\\root', dshDefaultRoot: '~/.dsh/sessions' }, 'configured dstRoot is echoed verbatim');
console.log('[B6] buildMigrateApi -> 4 methods: list-sources, preview, import, defaults');

// ── 临时库：core 写入管线造 claude 会话（复用 smoke.mjs 姿势） ──────────
const srcRoot = await mkdtemp(join(tmpdir(), 'cc-client-src-'));   // claude side
const dstRoot = await mkdtemp(join(tmpdir(), 'cc-client-dst-'));   // dsh side
const registry = core.builtinRegistry();
const ir = core.fallbackIr();
const claude = registry.get('claude');
const written = await core.writeTarget(claude, ir, { root: srcRoot, targetCwd: 'D:\\demo\\proj' });
const srcSessionId = written.sessionId;

// ── B7. registerMigrateRoutes：宿主同形 mock webServer ─────────────────
// dsh-host-webserver 契约：register({kind, path, handler}) => disposer。
const routeRegistrations = [];
let unregisterCalls = 0;
const mockWebServer = {
  register(route) {
    // 宿主同形校验：kind/path/handler 缺一即炸（宽松 mock 拦不住契约违例）
    if (!['exact', 'prefix'].includes(route.kind)) throw new TypeError(`route.kind "${route.kind}" invalid`);
    if (typeof route.path !== 'string' || !route.path.startsWith('/')) throw new TypeError('route.path must be an absolute path string');
    if (typeof route.handler !== 'function') throw new TypeError('route.handler must be a function');
    routeRegistrations.push(route);
    return () => { unregisterCalls++; };
  },
};
const mockCtx = {
  webServer: mockWebServer,
  webRuntime: { trustedHosts: [] },
  logger: { warn: () => {}, info: () => {}, error: () => {} },
};
const disposer = routes.registerMigrateRoutes(mockCtx, { dstRoot });
assert.equal(routeRegistrations.length, 1, 'exactly one route registered');
const route = routeRegistrations[0];
assert.equal(route.kind, 'prefix', 'route kind is prefix');
assert.equal(route.path, '/cc-migrate/api', 'route path is the plugin namespace');
assert.equal(typeof disposer, 'function', 'route registration returns a disposer');
console.log(`[B7] registerMigrateRoutes -> prefix route @ ${route.path} (disposer returned)`);

// 缺 webServer 的老宿主：undefined + 不炸
const legacy = routes.registerMigrateRoutes({ logger: { warn: () => {} } }, {});
assert.equal(legacy, undefined, 'no webServer -> no routes, no throw');
console.log('[B7b] host without webServer/webRuntime -> routes skipped (legacy-compatible)');

// ── mock req/res（结构同形：asyncIterator 请求体 + writeHead/end） ───────
const makeReq = (method, url, body, headers = {}) => ({
  method,
  url,
  headers: { host: 'localhost:3000', ...headers },
  async *[Symbol.asyncIterator]() {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body));
  },
});
const makeRes = () => {
  const res = { statusCode: 0, headers: {}, body: '' };
  res.writeHead = (status, headers) => { res.statusCode = status; Object.assign(res.headers, headers ?? {}); };
  res.end = (b) => { res.body = String(b ?? ''); };
  return res;
};

// ── B8. list-sources 全链（临时 claude 库） ────────────────────────────
const listRes = makeRes();
await route.handler(makeReq('POST', '/cc-migrate/api/list-sources', { tool: 'claude', root: srcRoot }), listRes);
assert.equal(listRes.statusCode, 200, 'list route returns 200');
assert.equal(listRes.headers['content-type'], 'application/json; charset=utf-8', 'JSON content type');
const listBody = JSON.parse(listRes.body);
assert.equal(listBody.ok, true, 'success envelope');
const sessions = listBody.value.sessions;
assert.ok(Array.isArray(sessions) && sessions.length >= 1, 'seeded session listed');
assert.ok(sessions.some((s) => s.sessionId === srcSessionId), 'seeded id present in the wire payload');
console.log(`[B8] POST list-sources (fenced ok) -> 200 {ok:true, value.sessions[${sessions.length}]}, content-type JSON`);

// preview 全链：结构化 PreviewPayload
const prevRes = makeRes();
await route.handler(makeReq('POST', '/cc-migrate/api/preview', { tool: 'claude', sessionId: srcSessionId, root: srcRoot }), prevRes);
assert.equal(prevRes.statusCode, 200);
const prevBody = JSON.parse(prevRes.body);
assert.equal(prevBody.ok, true);
assert.equal(prevBody.value.sessionId, srcSessionId);
assert.ok(Array.isArray(prevBody.value.messages) && prevBody.value.messages.length >= 1, 'structured messages over the wire');
console.log(`[B8b] POST preview -> 200 PreviewPayload (${prevBody.value.messages.length} message(s) over the wire)`);

// wire DTO 字段形状（client 渲染依赖的字段全员在——DTO 漂移在此拦截）
const prevValue = prevBody.value;
for (const field of ['messageCount', 'toolCallCount', 'hasSidechains', 'messages']) {
  assert.ok(field in prevValue, `PreviewPayload.${field} present over the wire`);
}
const firstMsg = prevValue.messages[0];
assert.ok(Array.isArray(firstMsg.blocks) && firstMsg.blocks.length >= 1, 'message blocks array over the wire');
assert.equal(firstMsg.blocks[0].t, 'text', 'block discriminator `t` over the wire');
assert.equal(typeof firstMsg.blocks[0].text, 'string', 'text block {t, text} shape');
// 真实 wire 载荷喂进 client 渲染：命令层 DTO ↔ client 视图两端一致性
// （渲染缺口 = 漂移；client-smoke 唯一同时摸到两半的检查点）
const realFlowHtml = server.renderToStaticMarkup(h(views.PreviewFlowView, { payload: prevValue }));
assert.ok(realFlowHtml.includes('帮我看看这个迁移工具'), 'real wire payload renders user text');
assert.ok(realFlowHtml.includes('docs/design.md'), 'real wire payload renders tool input summary (file_path key picked)');
assert.ok(realFlowHtml.includes('条消息'), 'real wire payload renders summary chips');
console.log('[B8c] real PreviewPayload rendered through the client preview view — no DTO/render drift');

// ── B10. import 全链：写临时 DSH root，全新 id；命令层错误变 4xx 信封 ──
const impRes = makeRes();
await route.handler(makeReq('POST', '/cc-migrate/api/import', { tool: 'claude', sessionId: srcSessionId, srcRoot, targetCwd: 'D:\\demo\\proj' }), impRes);
assert.equal(impRes.statusCode, 200);
const impBody = JSON.parse(impRes.body);
assert.equal(impBody.ok, true);
const newId = impBody.value.target.sessionId;
assert.ok(newId && newId !== srcSessionId, 'import mints a NEW dsh session id');
const firstFile = impBody.value.target.paths[0];
const st = await stat(firstFile);
assert.ok(st.size > 0, 'written session file non-empty');
// 再导入一次：又一个全新 id，首文件原样（read-old-write-new 红线）
const impRes2 = makeRes();
await route.handler(makeReq('POST', '/cc-migrate/api/import', { tool: 'claude', sessionId: srcSessionId, srcRoot }), impRes2);
const impBody2 = JSON.parse(impRes2.body);
assert.equal(impBody2.value.target.sessionId !== newId, true, 'second import mints another id');
assert.equal((await stat(firstFile)).size, st.size, 'first imported session untouched');
console.log(`[B10] POST import -> 200 dsh:${newId} (+ second run dsh:${impBody2.value.target.sessionId}, first intact)`);

// 命令层结构化错误 → 4xx 信封（不是 500）
const badToolRes = makeRes();
await route.handler(makeReq('POST', '/cc-migrate/api/list-sources', { tool: 'not-a-tool' }), badToolRes);
assert.equal(badToolRes.statusCode, 400);
const badBody = JSON.parse(badToolRes.body);
assert.equal(badBody.ok, false, 'failure envelope');
assert.ok(badBody.error.code === 'bad-request' && typeof badBody.error.message === 'string', 'error {code, message} envelope');
assert.ok(badBody.error.message.includes('unknown tool'), 'command-layer error text carried through');
console.log(`[B10b] command error -> ${badToolRes.statusCode} {ok:false, error:{code, message}} — message: ${badBody.error.message.slice(0, 40)}...`);

// ── B9. fence 违例与分发守卫 ───────────────────────────────────────────
// 跨站 Host（非回环、非 trusted）→ 403 forbidden 信封
const f1 = makeRes();
await route.handler(makeReq('POST', '/cc-migrate/api/list-sources', { tool: 'claude' }, { host: 'evil.example.com' }), f1);
assert.equal(f1.statusCode, 403);
assert.equal(JSON.parse(f1.body).error.code, 'forbidden');
// Origin 不同主机 → 403（浏览器跨站标记）
const f2 = makeRes();
await route.handler(makeReq('POST', '/cc-migrate/api/list-sources', { tool: 'claude' }, { origin: 'http://evil.example.com' }), f2);
assert.equal(f2.statusCode, 403);
// sec-fetch-site: cross-site → 403
const f3 = makeRes();
await route.handler(makeReq('POST', '/cc-migrate/api/list-sources', { tool: 'claude' }, { 'sec-fetch-site': 'cross-site' }), f3);
assert.equal(f3.statusCode, 403);
// 同主机 Origin（loopback 页面）→ 放行
const f4 = makeRes();
await route.handler(makeReq('POST', '/cc-migrate/api/list-sources', { tool: 'claude', root: srcRoot }, { origin: 'http://localhost:3000' }), f4);
assert.equal(f4.statusCode, 200, 'same-host origin passes the fence');
// GET → 405
const f5 = makeRes();
await route.handler(makeReq('GET', '/cc-migrate/api/list-sources', undefined), f5);
assert.equal(f5.statusCode, 405);
assert.equal(JSON.parse(f5.body).error.code, 'method-error');
// 未知 method → 404
const f6 = makeRes();
await route.handler(makeReq('POST', '/cc-migrate/api/no-such', {}), f6);
assert.equal(f6.statusCode, 404);
// method 段里带 / → 404
const f7 = makeRes();
await route.handler(makeReq('POST', '/cc-migrate/api/a/b', {}), f7);
assert.equal(f7.statusCode, 404);
// 坏 JSON → 400
const badJsonReq = {
  method: 'POST', url: '/cc-migrate/api/list-sources',
  headers: { host: 'localhost:3000' },
  async *[Symbol.asyncIterator]() { yield Buffer.from('{not json'); },
};
const f8 = makeRes();
await route.handler(badJsonReq, f8);
assert.equal(f8.statusCode, 400);
assert.equal(JSON.parse(f8.body).error.code, 'bad-request');
// trustedHosts 活性：注册后宿主换列表，下一请求即生效（fence 每请求现读）
const trustedCtx = {
  webServer: { register(r) { routeRegistrations.push(r); return () => {}; } },
  webRuntime: { trustedHosts: ['192.168.1.50'] },
  logger: { warn: () => {}, info: () => {}, error: () => {} },
};
routes.registerMigrateRoutes(trustedCtx, {});
const trustedRoute = routeRegistrations[routeRegistrations.length - 1];
const f9 = makeRes();
await trustedRoute.handler(makeReq('POST', '/cc-migrate/api/list-sources', { tool: 'claude' }, { host: '192.168.1.50:3000' }), f9);
assert.equal(f9.statusCode, 200, 'host in live trustedHosts passes');
console.log('[B9] fence: cross-host 403 / cross-origin 403 / sec-fetch-site 403 / same-host 200 / GET 405 / unknown 404 / bad JSON 400 / live trustedHosts 200');

// ── dispose ────────────────────────────────────────────────────────────
disposer();
assert.equal(unregisterCalls, 1, 'route disposer unregisters exactly once');
console.log('[B11] route disposer unregisters the prefix route (fiber-clean)');

console.log('\nCLIENT SMOKE OK — bundle shape + factory execution + tab registration + headless render of all views (grouped list / collapse tree / rich preview); fenced host routes verified in temp roots.');
console.log('(real-browser rendering inside the DSH sidebar is joint-debug scope — see README GUI section)');
