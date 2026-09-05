/**
 * installed-smoke.mjs — 安装位 headless 渲染冒烟（真机联调前的最后一道无头关）。
 *
 * 与 client-smoke.mjs 的差别：client-smoke 渲染的是【仓库构建产物】
 * （apps/dsh-plugin/lib/client.js + 本仓库 node_modules 的 react）；本脚本
 * 渲染的是【DSH profile 安装位】的那份 client.js，react/react-dom 也从
 * profile 的 node_modules 解析——即「宿主模块图运行时」的真实形状。它能抓
 * 到：pack 漏文件、安装 stale（pnpm integrity 命中不重解压）、profile 的
 * react 版本与渲染器不兼容、wrap 壳在真实 require 语义下炸壳。
 *
 * 用法：node test/installed-smoke.mjs [installRoot]
 *   installRoot 默认 ~/.dsh/profiles/web/node_modules/@cc-migrate/dsh-plugin
 *
 * Safety: read-only against the install root; rendering happens in-memory.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const installRoot = process.argv[2]
  ?? join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@cc-migrate', 'dsh-plugin');

// ── 1. 安装位文件 + 版本 ────────────────────────────────────────────────
const installRequire = createRequire(join(installRoot, 'package.json'));
const pkg = JSON.parse(await readFile(join(installRoot, 'package.json'), 'utf8'));
console.log(`[1] install root: ${installRoot}`);
console.log(`[1] installed version: ${pkg.version}`);

const clientSrc = await readFile(join(installRoot, 'lib', 'client.js'), 'utf8');
assert.ok(clientSrc.startsWith('window.__ModuleLoader__.load('), 'installed client.js keeps the ModuleLoader wrapper');
assert.ok(clientSrc.includes('exports.migrateViews = migrateViews;'), 'installed client.js exports the smoke render anchor');
console.log('[1] lib/client.js present with __ModuleLoader__ wrapper + migrateViews anchor');

// ── 2. 静态检查：react 绝不打进 bundle（externals 全走宿主 require）──────
const bodyStart = clientSrc.indexOf('factory: (require) => {') + 'factory: (require) => {'.length;
const bodyEnd = clientSrc.lastIndexOf('return module.exports;');
const factoryBody = clientSrc.slice(bodyStart, bodyEnd);
assert.ok(!/^\s*import\s/m.test(factoryBody), 'no bare import statement in the installed factory body');
assert.ok(!factoryBody.includes('react.production.min.js'), 'react itself must NOT be bundled');
console.log('[2] installed bundle is require-only (no ESM statements, no inlined react)');

// ── 3. react/react-dom 配对（渲染器与工厂必须同一 react 副本）────────────
// 安装可达的磁盘树常常没有配对副本（本机 profile：react 18.3.1 提升，
// react-dom 19.2.8 嵌套在 dsh-client-ui-trajectory 下——跨大版本，渲染必炸
// 「Objects are not valid as a React child」）。真宿主的浏览器模块图自有
// 配对（不落磁盘），这里按纪律选对：profile 图有同大版本 react-dom 就全用
// profile 的；否则【整套】退回仓库 devDeps 的配对——绝不跨版本/跨副本混用。
const repoRequire = createRequire(import.meta.url);
const tryInstall = (name) => {
  try { return installRequire(name); } catch { return undefined; }
};
const profileReact = tryInstall('react');
const profileReactDom = tryInstall('react-dom/package.json');
const majorOf = (v) => String(v).split('.')[0];
let react = profileReact;
let jsxRuntime = tryInstall('react/jsx-runtime');
let reactDomServer;
if (profileReact && profileReactDom && jsxRuntime && majorOf(profileReactDom.version) === majorOf(profileReact.version)) {
  reactDomServer = installRequire('react-dom/server');
  console.log(`[3] renderer pair: PROFILE's react ${profileReact.version} + react-dom ${profileReactDom.version}`);
} else {
  // 整套退回仓库 devDeps 的配对（react + jsx-runtime + react-dom 同副本）
  react = repoRequire('react');
  jsxRuntime = repoRequire('react/jsx-runtime');
  reactDomServer = repoRequire('react-dom/server');
  console.log(`[3] profile graph has no matched react pair (react ${profileReact?.version ?? 'absent'}, react-dom ${profileReactDom?.version ?? 'absent'})`);
  console.log(`[3] renderer pair falls back to repo devDeps: react ${react.version} + react-dom ${repoRequire('react-dom/package.json').version} (factory + renderer same copy)`);
}

const hostRequire = (name) => {
  if (name === 'react') return react;
  if (name === 'react/jsx-runtime') return jsxRuntime;
  if (name === '@deepseek-ai/dsh-client-ui-primitives') {
    return installRequire('@deepseek-ai/dsh-client-ui-primitives');
  }
  throw new Error(`installed-smoke: unexpected host require "${name}"`);
};

// ── 4. 工厂执行（mock __ModuleLoader__ 与宿主加载器同语义）───────────────
let loaded = false;
let pluginExports = null;
globalThis.window = {
  __ModuleLoader__: {
    load(mod) {
      loaded = true;
      // 工厂内部自建 module/exports 并 return——收【返回值】，mock 自建的
      // 空对象不是导出面（client-smoke 的 mock 同款陷阱，这里别踩）。
      pluginExports = mod.factory(hostRequire) ?? null;
    },
  },
};
// eslint-disable-next-line no-eval
eval(clientSrc);
assert.ok(loaded, '__ModuleLoader__.load ran exactly once');
console.log('[4] installed factory executes against the profile module graph');

// ── 5. tab.component 无头渲染（主视图初始态 + 侧栏窄栏结构）──────────────
assert.equal(typeof pluginExports.apply, 'function', 'installed exports.apply');
assert.ok(Array.isArray(pluginExports.inject) && pluginExports.inject.includes('betterSidebar'), 'installed exports.inject declares betterSidebar');
const views = pluginExports.migrateViews;
assert.ok(views && typeof views.SessionListView === 'function', 'installed migrateViews anchor');

const registered = [];
const ctx = {
  get: (name) => name === 'betterSidebar'
    ? { registerTab: (d) => { registered.push(d); return () => { registered.pop(); }; } }
    : undefined,
  effect(fn) { const d = fn(); return () => d?.(); },
  logger: { warn: () => {} },
};
pluginExports.apply(ctx);
assert.equal(registered.length, 1, 'registerTab called once against the profile runtime');
const html = reactDomServer.renderToStaticMarkup(registered[0].component({ visible: true }));
assert.ok(html.includes('会话迁移'), 'wizard header rendered');
assert.ok(html.includes('Claude Code'), 'compact source-tool chip row rendered');
assert.ok(html.includes('源库地址'), 'root input row rendered');
assert.ok(html.includes('该目录下没有找到会话'), 'initial empty state rendered (fetch on mount)');
console.log(`[5] tab.component renders headless via the matched renderer pair (${html.length} chars)`);

// ── 6. 新视图结构（分组出现 + 折叠 + 富预览，与 client-smoke A6/A8 同断言集）──
const h = (tag, props) => react.createElement(tag, props);
const now = Date.now();
const groups = views.groupSessions([
  { tool: 'claude', sessionId: 'p1', title: '父会话一', createdAt: now - 1_000, cwd: 'D:\\work\\alpha' },
  { tool: 'claude', sessionId: 'c1', title: '子会话挂树', createdAt: now - 2_000, cwd: 'D:\\work\\alpha', parentSessionId: 'p1' },
  { tool: 'claude', sessionId: 'p2', title: '另一工作区', createdAt: now - 3_000, cwd: 'C:\\Users\\demo\\beta' },
]);
assert.equal(groups.length, 2, 'grouped by cwd (installed renderer)');
const listHtml = reactDomServer.renderToStaticMarkup(h(views.SessionListView, {
  groups, collapsed: new Set(), onToggleGroup: () => {}, onOpen: () => {}, emptyHint: '无匹配结果。',
}));
assert.ok(listHtml.includes('>alpha<') && listHtml.includes('>beta<'), 'group headers rendered');
assert.ok(listHtml.includes('父会话一') && listHtml.includes('子会话挂树'), 'session rows + tree attach rendered');
assert.ok(listHtml.includes('padding-left:22px'), '14px/level sub-session indent rendered');
const collapsedHtml = reactDomServer.renderToStaticMarkup(h(views.SessionListView, {
  groups, collapsed: new Set(['D:\\work\\alpha']), onToggleGroup: () => {}, onOpen: () => {}, emptyHint: '无匹配结果。',
}));
assert.ok(!collapsedHtml.includes('父会话一') && collapsedHtml.includes('>alpha<'), 'controlled collapse hides rows, keeps header');
const flowHtml = reactDomServer.renderToStaticMarkup(h(views.PreviewFlowView, {
  payload: {
    tool: 'claude', sessionId: 'r', messageCount: 2, toolCallCount: 1, hasSidechains: true, sidechainCount: 1,
    messages: [
      { role: 'user', blocks: [{ t: 'text', text: '安装位渲染断言' }] },
      { role: 'assistant', blocks: [{ t: 'tool_use', callId: 'k1', name: 'Bash', text: '{"command":"dsh --version"}' }] },
    ],
    sidechains: [{ agentId: 's1', agentType: 'explorer', parentCallId: 'k1', messages: [{ role: 'assistant', blocks: [{ t: 'text', text: '旁链' }] }] }],
  },
}));
assert.ok(flowHtml.includes('安装位渲染断言') && flowHtml.includes('dsh --version'), 'preview flow renders from the install root');
assert.ok(flowHtml.includes('子代理 · 1'), 'sidechain switcher button rendered (desktop-style whole-area switch)');
assert.ok(!flowHtml.includes('>旁链<'), 'sidechain content NOT inline in the main flow');
const agentHtml = reactDomServer.renderToStaticMarkup(h(views.PreviewFlowView, {
  payload: {
    tool: 'claude', sessionId: 'r', messageCount: 2, toolCallCount: 1, hasSidechains: true, sidechainCount: 1,
    messages: [
      { role: 'user', blocks: [{ t: 'text', text: '安装位渲染断言' }] },
      { role: 'assistant', blocks: [{ t: 'tool_use', callId: 'k1', name: 'Bash', text: '{"command":"dsh --version"}' }] },
    ],
    sidechains: [{ agentId: 's1', agentType: 'explorer', parentCallId: 'k1', messages: [{ role: 'assistant', blocks: [{ t: 'text', text: '旁链' }] }] }],
  },
  initialAgentIndex: 0,
}));
assert.ok(agentHtml.includes('旁链') && agentHtml.includes('子代理 · explorer'), 'agent whole-area view renders the sidechain flow');
assert.ok(!agentHtml.includes('dsh --version'), 'main flow swapped out in agent view');
console.log('[6] installed renderer: cwd grouping + controlled collapse + rich preview + sidechain switcher');

console.log(`\nINSTALLED SMOKE OK — ${pkg.version} @ ${installRoot}`);
console.log('(next: real-browser rendering inside the DSH sidebar — main-session joint-debug scope)');
