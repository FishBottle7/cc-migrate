/**
 * Headless smoke test for the GUI wizard mounting layer (design.md Phase 3 §15).
 *
 * 方案 A（无 Vue 渲染）：不 import .vue 组件——Vue SFC 无法在裸 node 下直接
 * 加载，组件渲染正确性由 ui 包自己的 vue-tsc typecheck 保证。这里只测
 * 「工厂函数 + GuiHost 协议」这条可独立验证的层：
 *
 *   1. 主入口 import 干净：lib/index.js 不因 GUI 层引入任何 Vue 副作用
 *      （动态 import 隔离验证——命令层冒烟不被拖累）。
 *   2. createSessionMigrateWizard 失败路径：ui 未打包（裸 node 下源码包
 *      必然 import 失败）→ 可读错误，mount 不被调用。
 *   3. 成功路径（宿主注入已打包组件）：host.mount 收到 (container,
 *      component, props)；props.backend 就是 MigrationBackend 契约（六个方法）。
 *   4. backend.listSessions —— props 里的数据函数真的走到命令层：用
 *      临时 root 的真实 claude 数据（core 自己的写入管线造库，复用
 *      smoke.mjs 的姿势，绝不碰真实 ~/.claude / ~/.dsh）。
 *   5. backend.preview —— 结构化 PreviewPayload（messages/blocks 投影）。
 *   6. backend.migrate —— 写入临时 DSH root，全新 session id；目标工具
 *      白名单（非 dsh 拒绝）。
 *   7. dispose：handle.dispose() 走宿主 unmount，恰好一次，重复安全。
 *   8. apply() + ctx.gui：向导挂载经 ctx.effect；老宿主（无 gui）零增量。
 *
 * Safety: everything happens inside os.tmpdir(); no unlink/rm anywhere.
 */

import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// lib 构建（test script 先跑过 build）。

// 迁移日志隔离：命令层数据通道会写 ~/.cc-migrate/migrations.jsonl —— 冒烟指到
// 临时文件，绝不碰真实日志（migrationLogPath 每次调用现读 env，晚设也生效）。
process.env.CC_MIGRATE_LOG = join(await mkdtemp(join(tmpdir(), 'cc-log-iso-')), 'migrations.jsonl');

const gui = await import('../lib/gui.js');
const { createSessionMigrateWizard, GUI_SOURCE_TOOLS } = gui;
const core = await import('@cc-migrate/core');

// ── 1. 主入口不携带 Vue 运行时 ──────────────────────────────────────
// index.js 动态引 gui.js；gui.js 只动态引 @cc-migrate/ui。
// 若隔离被破坏（顶层静态 import .vue），这里第一时间暴露。
const pluginIndex = await import('../lib/index.js');
assert.equal(typeof pluginIndex.apply, 'function', 'plugin entry still exports apply()');
assert.equal(typeof pluginIndex.listSources, 'function', 'plugin entry still re-exports commands');
console.log('[1] lib/index.js imports clean (GUI layer lazily isolated, commands intact)');

// ── 临时库：core 自己的写入管线造 claude 会话（复用 smoke.mjs 姿势） ──
const srcRoot = await mkdtemp(join(tmpdir(), 'sm-gui-src-'));   // claude side
const dstRoot = await mkdtemp(join(tmpdir(), 'sm-gui-dst-'));   // dsh side
const fakeHome = await mkdtemp(join(tmpdir(), 'sm-gui-home-'));  // ~ 展开回归用（5b）
const registry = core.builtinRegistry();
const ir = core.fallbackIr();
const claude = registry.get('claude');
const written = await core.writeTarget(claude, ir, { root: srcRoot, targetCwd: 'D:\\demo\\proj' });
const srcSessionId = written.sessionId;

// ── mock GuiHost：命令层真实数据 + mock mount ───────────────────────
const mounts = [];   // [{ container, component, props, unmounted }]
const unmountCalls = [];
const logs = [];
const commandLayer = await import('../lib/commands.js');

const makeHost = (extra = {}) => ({
  logger: {
    info: (...a) => logs.push(['info', ...a]),
    warn: (...a) => logs.push(['warn', ...a]),
    error: (...a) => logs.push(['error', ...a]),
  },
  mount(container, component, props) {
    mounts.push({ container, component, props });
    return () => unmountCalls.push('wizard');
  },
  // 数据通道直连命令层（宿主真实场景经宿主转发；函数形状即协议）
  listSources: (tool, root) => commandLayer.listSources(tool, root),
  preview: (tool, sessionId, root) => commandLayer.previewPayload(tool, sessionId, root),
  importSession: (srcTool, srcSessionId, opts) => commandLayer.importSession(srcTool, srcSessionId, opts),
  ...extra,
});

// ── 2. 工厂失败路径：ui 未打包 → 可读错误（不炸宿主） ────────────────
const host = makeHost();
const fakeContainer = { kind: 'mock-container' };
await assert.rejects(
  createSessionMigrateWizard(host, { container: fakeContainer, dstRoot }),
  (e) => {
    const msg = e instanceof Error ? e.message : String(e);
    assert.ok(msg.includes('cc-migrate gui'), `error must mention the gui layer, got: ${msg}`);
    assert.ok(
      msg.includes('@cc-migrate/ui') || msg.includes('cannot load'),
      `error must name the ui load failure, got: ${msg}`,
    );
    return true;
  },
);
assert.equal(mounts.length, 0, 'mount must not be called when component load fails');
console.log('[2] ui not bundled in bare node -> readable protocol error (mount untouched)');

// ── 3. 工厂成功路径：宿主注入已打包组件（loadWizardComponent seam） ──
// 宿主构建产物里 MigrateWizard 长什么样是宿主的事；协议面是：组件被原样
// mount 进容器，props 只有一个 backend。用注入的 mock 组件验证真实工厂路径。
const fakeWizardComponent = { name: 'MigrateWizard-mock', props: ['backend'] };
const handle = await createSessionMigrateWizard(host, {
  container: fakeContainer,
  dstRoot,
  loadWizardComponent: async () => fakeWizardComponent,
});
assert.equal(mounts.length, 1, 'host mount called exactly once');
const mounted = mounts[0];
assert.strictEqual(mounted.container, fakeContainer, 'container passed through untouched');
assert.strictEqual(mounted.component, fakeWizardComponent, 'component passed through untouched');
const backend = handle.backend;
for (const method of ['listTools', 'listSessions', 'preview', 'migrate', 'pickDirectory', 'openPath']) {
  assert.equal(typeof backend[method], 'function', `backend.${method} is a function`);
}
console.log('[3] factory happy path: mount(container, component, { backend }) — backend implements the 6 MigrationBackend methods');

// ── 4. backend.listSessions —— 真走到命令层（临时 claude 库） ────────
const sessions = await backend.listSessions('claude', srcRoot);
assert.ok(Array.isArray(sessions) && sessions.length >= 1, 'listSessions returned the seeded session');
const meta = sessions.find((s) => s.sessionId === srcSessionId);
assert.ok(meta, 'seeded session present via backend.listSessions');
console.log(`[4] backend.listSessions claude @ tmp -> ${sessions.length} session(s), seeded id found`);

// 错误通道：listSessions 对未知工具抛出可渲染错误（向导吃 throw 文案）
await assert.rejects(backend.listSessions('not-a-tool'), /unknown tool/, 'unknown tool throws for the component');

// ── 5. backend.preview —— 结构化 PreviewPayload 投影 ────────────────
const payload = await backend.preview('claude', srcSessionId, srcRoot);
assert.equal(payload.tool, 'claude');
assert.equal(payload.sessionId, srcSessionId);
assert.ok(Array.isArray(payload.messages) && payload.messages.length >= 1, 'structured messages projected');
assert.equal(payload.messageCount, payload.messages.length, 'messageCount matches messages.length');
for (const m of payload.messages) {
  assert.ok(['user', 'assistant', 'tool', 'system', 'developer'].includes(m.role), `valid role: ${m.role}`);
  assert.ok(Array.isArray(m.blocks), 'blocks is an array');
}
const blockShapes = new Set();
for (const m of payload.messages) for (const b of m.blocks) blockShapes.add(b.t);
console.log(`[5] backend.preview -> structured payload: ${payload.messages.length} message(s), block kinds: [${[...blockShapes].join(', ')}]`);

// preview 错误：坏 session id → 抛错（组件渲染 error 行）
await assert.rejects(backend.preview('claude', 'no-such-session', srcRoot), /preview claude:no-such-session failed/);

// ── 5b. backend.preview 的 ~ 展开（真机 GUI 踩过的坑，回归断言）────────
// 向导 root 框的 defaultRoot 是 `~/.claude/projects` 形态，用户不改输入框时
// 原样传到 previewPayload——漏展开会把 `~` 当字面目录（相对宿主 CWD），列表
// 能出、预览必挂。这里把 HOME/USERPROFILE 重定向到临时目录造库（node 的
// os.homedir() 每次现读 env，恢复原值在 finally 里），绝不碰真实 ~/.claude。
const prevHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
try {
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  const tildeRoot = join(fakeHome, '.claude', 'projects');
  const tildeWritten = await core.writeTarget(claude, core.fallbackIr(), { root: tildeRoot, targetCwd: 'D:\\demo\\proj' });
  // 对照：listSources 一直有展开，~ 形态应能列出
  const tildeList = await backend.listSessions('claude', '~/.claude/projects');
  assert.ok(tildeList.some((s) => s.sessionId === tildeWritten.sessionId), 'listSessions finds the seeded session via ~ root');
  // 回归主体：preview 走同一展开（修复前这里 reject「preview ... failed」）
  const tildePayload = await backend.preview('claude', tildeWritten.sessionId, '~/.claude/projects');
  assert.equal(tildePayload.sessionId, tildeWritten.sessionId, 'preview resolves the session via the ~ root');
  console.log('[5b] backend.preview with "~/.claude/projects" root -> payload (tilde expansion aligned with listSessions)');
} finally {
  for (const [k, v] of Object.entries(prevHome)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ── 6. backend.migrate —— 写入临时 DSH root，全新 id，目标白名单 ────
const outcome = await backend.migrate({
  srcTool: 'claude',
  sessionId: srcSessionId,
  srcRoot,
  dstTool: 'dsh',
  targetCwd: 'D:\\demo\\proj',
});
assert.equal(outcome.tool, 'dsh', 'migrate outcome targets dsh');
assert.ok(outcome.sessionId && outcome.sessionId !== srcSessionId, 'migrate mints a NEW dsh session id');
assert.ok(outcome.paths.length >= 1, 'migrate wrote at least one path');
const firstPath = outcome.paths[0];
const st = await stat(firstPath);
assert.ok(st.size > 0, 'written session file non-empty');

// 再迁一次：另一个全新 id，首个文件原样保留（read-old-write-new 红线）
const outcome2 = await backend.migrate({ srcTool: 'claude', sessionId: srcSessionId, srcRoot, dstTool: 'dsh' });
assert.notEqual(outcome2.sessionId, outcome.sessionId, 'second migrate mints yet another id');
const st2 = await stat(firstPath);
assert.equal(st2.size, st.size, 'first imported session untouched after second migrate');
console.log(`[6] backend.migrate -> dsh:${outcome.sessionId} (+ second run dsh:${outcome2.sessionId}, first intact)`);

// 目标白名单：插件只有 any→dsh 一条线
await assert.rejects(
  backend.migrate({ srcTool: 'claude', sessionId: srcSessionId, srcRoot, dstTool: 'codex' }),
  /not supported by the DSH plugin/,
  'non-dsh target rejected',
);

// listTools：静态元数据（顺序即卡片顺序）
const tools = await backend.listTools();
assert.deepEqual(tools, GUI_SOURCE_TOOLS, 'listTools returns the source tool metadata');
assert.ok(tools.every((t) => typeof t.id === 'string' && typeof t.label === 'string' && typeof t.defaultRoot === 'string'));
console.log(`[7] backend.listTools -> ${tools.length} tool card(s): ${tools.map((t) => t.id).join(', ')}`);

// ── 7. 可选宿主服务缺失：headless 宿主不炸 ──────────────────────────
const nullDir = await backend.pickDirectory();
assert.equal(nullDir, null, 'no host picker -> null (wizard falls back to raw input)');
await backend.openPath(firstPath); // no opener -> warn only, no throw
const warned = logs.some(([lvl]) => lvl === 'warn');
assert.ok(warned, 'missing host services logged as warnings, not crashes');
console.log('[8] pickDirectory/openPath degrade to warn when the host omits them');

// ── 8. dispose 路径：handle.dispose() 走宿主 unmount，幂等安全 ──────
unmountCalls.length = 0;
handle.dispose();
handle.dispose(); // 重复 dispose 安全
assert.equal(unmountCalls.length, 1, 'host unmount invoked exactly once across double dispose');
console.log(`[9] dispose: handle.dispose() unmounted once, repeat-safe (${unmountCalls.length} call, no throw)`);

// ── 9. 主入口 apply() + ctx.gui：向导挂载走 effect，dispose 幂等 ─────
const { apply } = pluginIndex;
const registered = [];
const disposers = [];
const wizardEffectDisposers = [];
const mockCtxGui = {
  logger: {
    info: () => {},
    warn: (...a) => logs.push(['warn', ...a]),
    error: () => {},
  },
  commands: {
    register(name, handler) {
      registered.push([name, handler]);
      return () => {};
    },
  },
  gui: {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    mount: () => () => wizardEffectDisposers.push('unmount'),
    listSources: (t, r) => commandLayer.listSources(t, r),
    preview: (t, s, r) => commandLayer.previewPayload(t, s, r),
    importSession: (t, s, o) => commandLayer.importSession(t, s, o),
  },
  effect(fn) {
    const d = fn();
    disposers.push(d);
    return () => d?.();
  },
};
apply(mockCtxGui, { dstRoot });
await new Promise((r) => setTimeout(r, 30)); // let the async mount chain settle
assert.equal(registered.length, 3, 'commands still registered with ctx.gui present');
assert.ok(disposers.length >= 4, 'wizard dispose routed through ctx.effect too');
// 老 DSH 宿主（无 gui）：命令照旧，零 gui effect —— 向后兼容
const disposersLegacy = [];
const registeredLegacy = [];
const mockCtxLegacy = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  commands: { register: (n, h) => (registeredLegacy.push([n, h]), () => {}) },
  effect(fn) {
    const d = fn();
    disposersLegacy.push(d);
    return () => d?.();
  },
};
apply(mockCtxLegacy, {});
assert.equal(registeredLegacy.length, 3, 'legacy host: still 3 commands');
assert.equal(disposersLegacy.length, 3, 'legacy host: no extra gui disposer');
for (const d of [...disposers, ...disposersLegacy]) if (typeof d === 'function') d();
console.log(`[10] apply() with ctx.gui mounts via effect (${disposers.length} disposers); legacy host unchanged (${disposersLegacy.length})`);

console.log('\nGUI SMOKE OK — wizard mount protocol + backend bridge verified headless in temp roots.');
console.log('(component rendering is guaranteed by @cc-migrate/ui typecheck — vue-tsc; real-host mounting is joint-debug scope)');
