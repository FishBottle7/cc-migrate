/**
 * Smoke test for the cc-migrate DSH plugin.
 *
 * Verifies against a mock cordis ctx modeled on the REAL dsh-commands host
 * contract (normalizeDefinition / normalizeResult — see src/index.ts's
 * PluginContext 头注；真机首装时踩过「description 缺失炸插件树」的坑，
 * mock 必须与宿主同形，不能再放行宽松形状):
 *   1. apply() registers exactly the 3 flat commands with {name, description,
 *      handler} and ctx.effect collects their disposers (fiber-clean unload).
 *   2. handlers return CommandResult {kind, text} — the shape the host's
 *      normalizeResult enforces.
 *   3. list-sources returns a session array for a source tool under a
 *      temp root (data seeded with the core's own write pipeline — never
 *      the real ~/.dsh).
 *   4. preview returns text; import writes a NEW resumable session into a
 *      temp DSH root and the existing file survives untouched.
 *   5. dispose path: running every registered disposer throws nothing.
 *
 * Safety: everything happens inside os.tmpdir(); no unlink/rm anywhere.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The plugin entry (built lib) — importing it pulls in the command layer.
const plugin = await import('../lib/index.js');
const core = await import('@cc-migrate/core');
const { apply, COMMAND_NAMES } = plugin;

/** 复刻 dsh-commands 的 normalizeDefinition 校验（宽松 mock 会让真实契约
 *  违例静默漏网——见头注）。 */
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u;
function hostValidateDefinition(def) {
  if (!COMMAND_NAME.test(def.name)) throw new TypeError(`command name "${def.name}" must match ${String(COMMAND_NAME)}`);
  if (typeof def.description !== 'string') throw new TypeError(`command "${def.name}" description must be a string`);
  if (def.description.trim().length === 0) throw new TypeError(`command "${def.name}" description must not be empty`);
  if (typeof def.handler !== 'function') throw new TypeError(`command "${def.name}" handler must be a function`);
}
/** 复刻 normalizeResult 的返回值契约。 */
function hostValidateResult(name, value) {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    throw new TypeError(`command "${name}" handler must return a CommandResult`);
  }
}

// ── mock cordis ctx（宿主同形，不是宽松形状）──────────────────────────
const registered = [];            // {name, description, handler}
const disposers = [];             // disposers returned by effect(fn)
const logs = [];
const mockCtx = {
  logger: {
    info: (...a) => logs.push(['info', ...a]),
    warn: (...a) => logs.push(['warn', ...a]),
    error: (...a) => logs.push(['error', ...a]),
  },
  commands: {
    register(definition) {
      hostValidateDefinition(definition);   // ← 与真宿主同款校验，违例在此炸
      registered.push(definition);
      return () => {};                       // unregister fn — recorded via effect below
    },
  },
  effect(fn) {
    const d = fn();
    disposers.push(d);
    return () => d?.();
  },
};

// ── 1. apply() registers the 3 flat commands（宿主校验全过）──────────
apply(mockCtx, {});
const names = registered.map((d) => d.name);
assert.deepEqual(
  [...names].sort(),
  [...COMMAND_NAMES].sort(),
  `expected the 3 commands registered, got: ${names.join(', ')}`,
);
assert.equal(registered.length, 3, 'exactly 3 commands');
for (const def of registered) {
  assert.ok(def.description.trim().length > 0, `command ${def.name} carries a description (host contract)`);
}
assert.ok(disposers.length >= 3, 'every register routed through ctx.effect');
console.log(`[1] commands registered: ${names.join(', ')} (${disposers.length} disposers via ctx.effect)`);

/** 按宿主 dispatch 形态调用：rawInput = 命令名后的原始文本。 */
const invoke = (name, ...args) => {
  const def = registered.find((d) => d.name === name);
  const result = def.handler({ rawInput: ' ' + args.join(' '), agent: undefined, attachments: [], signal: undefined });
  return Promise.resolve(result).then((r) => { hostValidateResult(name, r); return r; });
};

// ── seed a source session with core's own pipeline (temp dirs only) ──
const srcRoot = await mkdtemp(join(tmpdir(), 'cc-plugin-src-'));   // claude side
const dstRoot = await mkdtemp(join(tmpdir(), 'cc-plugin-dst-'));   // dsh side
const registry = core.builtinRegistry();
const ir = core.fallbackIr();
const claude = registry.get('claude');
const written = await core.writeTarget(claude, ir, { root: srcRoot, targetCwd: 'D:\\demo\\proj' });
const srcSessionId = written.sessionId;

// ── 2. list-sources over the temp claude root ────────────────────────
const listCmd = names.find((n) => n.endsWith('list-sources'));
const listRes = await invoke(listCmd, 'claude', '--root', srcRoot);
assert.equal(listRes.kind, 'success', `list-sources failed: ${listRes.text}`);
assert.ok(listRes.text.includes('session(s)'), 'success text carries the listing');
console.log(`[2] ${listCmd} claude @ tmp -> ${listRes.text.split('\n')[0]}`);

// ── 3. preview the seeded session ───────────────────────────────────
const prevCmd = names.find((n) => n.endsWith('preview'));
const prevRes = await invoke(prevCmd, 'claude', srcSessionId, '--root', srcRoot);
assert.equal(prevRes.kind, 'success', `preview failed: ${prevRes.text}`);
assert.ok(prevRes.text.length > 0, 'preview text non-empty');
console.log(`[3] ${prevCmd} ok, ${prevRes.text.split('\n').length} line(s)`);

// ── 4. import claude session into a temp DSH root ────────────────────
const importCmd = names.find((n) => n.endsWith('import'));
const importRes = await invoke(importCmd, 'claude', srcSessionId, '--src-root', srcRoot, '--cwd', 'D:\\demo\\proj', '--root', dstRoot);
assert.equal(importRes.kind, 'success', `import failed: ${importRes.text}`);
assert.ok(importRes.text.includes('-> dsh:'), 'success text reports the migrated id');
// 找到迁移产物（summary 文本里有路径行）
const pathLine = importRes.text.split('\n').map((l) => l.trim()).find((l) => l.includes('session.jsonl.zstd'));
assert.ok(pathLine, 'success text lists the written artifact');
const importedPath = pathLine.replace(/^  /, '');
const before = await readFile(importedPath);
assert.ok(before.length > 0, 'written zstd file non-empty');
console.log(`[4] ${importCmd}: ${importRes.text.split('\n')[0]}`);
console.log(`    wrote: ${importedPath}`);

// re-import must NOT overwrite: a second import writes a different new file
const importRes2 = await invoke(importCmd, 'claude', srcSessionId, '--src-root', srcRoot, '--cwd', 'D:\\demo\\proj', '--root', dstRoot);
assert.equal(importRes2.kind, 'success', `second import failed: ${importRes2.text}`);
assert.notEqual(importRes2.text, importRes.text, 'import always mints a new session id (summary differs)');
const firstStillThere = await stat(importedPath);
assert.ok(firstStillThere.size > 0, 'first imported session untouched after second import');
console.log(`[4b] second import minted a new id; first file intact`);

// ── 5. structured errors instead of thrown exceptions ────────────────
const badTool = await invoke(listCmd, 'not-a-tool');
assert.equal(badTool.kind, 'error');
assert.ok(typeof badTool.text === 'string' && badTool.text.length > 0);
console.log(`[5] unknown tool -> CommandResult error: ${badTool.text.slice(0, 60)}...`);

// ── 6. dispose path throws nothing ───────────────────────────────────
for (const d of disposers) {
  if (typeof d === 'function') d();
}
console.log(`[6] ${disposers.length} disposers ran clean (no throw)`);

// ── 7. agent skill registration（ctx.skills 宿主契约）─────────────────
// 宿主同形 mock：register(skill) 校验 name/description/content（对齐
// @deepseek-ai/dsh-skill 的 SkillRegistry.register），返回注销函数。
// 注意上面的主 mockCtx 没有 skills 服务——apply() 已走过一次「无 skills
// 降级」路径（section 1 没炸即证明向后兼容），这里再验证有服务的正路径。
const skillRegistrations = [];
const skillEffectDisposers = [];
const skillCtx = {
  logger: mockCtx.logger,
  commands: mockCtx.commands,
  effect(fn) {
    const d = fn();
    skillEffectDisposers.push(d);
    return () => d?.();
  },
  skills: {
    register(skillDef) {
      if (!/^[a-z][a-z0-9-]*$/.test(skillDef.name)) throw new TypeError(`skill name "${skillDef.name}" not kebab-case`);
      if (typeof skillDef.description !== 'string' || !skillDef.description.trim()) throw new TypeError('skill description required');
      if (typeof skillDef.content !== 'string' || !skillDef.content.trim()) throw new TypeError('skill content required');
      skillRegistrations.push(skillDef);
      return () => skillRegistrations.pop();
    },
  },
};
apply(skillCtx, {});
assert.equal(skillRegistrations.length, 1, 'exactly one runtime skill registered');
const skillDef = skillRegistrations[0];
assert.equal(skillDef.name, 'cc-migrate', 'skill name is cc-migrate');
assert.ok(skillDef.description.length > 0, 'description routes migration intents');
assert.ok(typeof skillDef.whenToUse === 'string' && skillDef.whenToUse.length > 0, 'whenToUse carried for routing');
assert.ok(!skillDef.content.includes('{{CLI_PATH}}'), 'CLI_PATH placeholder substituted at registration');
assert.ok(skillDef.content.includes(join('lib', 'cli.js')), 'skill body embeds the absolute agent CLI path');
assert.ok(skillDef.content.includes('migrate'), 'skill body teaches the migrate command');
// effect 收的不止 skill（还有 3 条命令的注销器）——断言 skill 的注销器确实
// 在其中：全量跑完后宿主侧注册表应为空（skill mock 的注销 = 从注册表移除）。
assert.ok(skillEffectDisposers.length >= 1, 'skill registration routed through ctx.effect');
for (const d of skillEffectDisposers) d();
assert.equal(skillRegistrations.length, 0, 'running the effect disposers unregisters the skill');
console.log(`[7] skill registered: ${skillDef.name} (content ${skillDef.content.length} chars, cli path embedded)`);
console.log('[7b] skill disposer ran clean (registration removed)');

console.log('\nSMOKE OK — 3 flat commands + 1 agent skill registered under the host-shaped mock, list/preview/import verified in temp roots.');
