/**
 * wrap-client.mjs — 把 tsdown 的 client 产物包装成 DSH 宿主要求的
 * `window.__ModuleLoader__.load({id, factory})` 形态。
 *
 * 为什么手工包装：better-sidebar 的 lib/client.js 是
 * `window.__ModuleLoader__.load({id, factory: (require) => {...; exports.apply
 * = apply; exports.inject = inject; return module.exports;}})` 的工厂壳包着
 * rolldown bundle——rolldown/任何打包器原生都不产这层壳（它需要把整个
 * bundle 变成工厂闭包体，并用注入的 `require` 解析 externals）。宿主加载
 * 器按这个形态注入模块（id = 包名，require = 宿主模块图的 require），
 * `exports.apply` / `exports.inject` 是激活入口与服务注入表。
 *
 * 形态对照（better-sidebar lib/client.js 头尾）：
 *   window.__ModuleLoader__.load({
 *     id: "dsh-better-sidebar",
 *     factory: (require) => {
 *       var module = { exports: {} };
 *       var exports = module.exports;
 *       let react = require("react");          ← externals 前置
 *       <bundle body>
 *       exports.apply = apply;
 *       exports.inject = inject;
 *       return module.exports;
 *     }
 *   });
 *
 * 两类改写：
 *  1. external 裸导入（import x from "react" / import {a,b} from "..."）→
 *     删行，改写成工厂顶的 `require()` + 绑定重建（宿主 require 是唯一
 *     的 externals 来源——better-sidebar 的 bundle 就是这样拿 react 的）。
 *  2. body 尾的 `export { apply, inject };` → 删行（值声明在 body 内可见，
 *     壳尾的 exports.apply/exports.inject 负责导出）。
 *
 * 越界 external（不在宿主运行时白名单里）让构建直接失败——宁炸不错，
 * 错包装的 client.js 在宿主里是运行时白屏。
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const libDir = join(here, '..', 'lib');
const rawPath = join(libDir, 'client.raw.js');
const outPath = join(libDir, 'client.js');

if (!existsSync(rawPath)) {
  console.error('wrap-client: lib/client.raw.js not found — run `tsdown` (bundle) first');
  process.exit(1);
}
const raw = readFileSync(rawPath, 'utf8');

// ── 1. 抽走 external 裸导入，改写为 require + 绑定重建 ─────────────────
// 形态集：默认导入 / 命名空间导入 / 命名导入 / 纯副作用导入（当期源码只产
// 前两种 + 命名导入——react 的 hook 列表与 jsx-runtime 的 {Fragment,jsx,jsxs}）。
const importRe = /^import\s+(?:(\w+)\s+from\s+|(\*\s+as\s+(\w+))\s+from\s+|(\{[^}]*\})\s+from\s+)?["']([^"']+)["'];?\s*$/gm;
const externals = [];
const bindingLines = [];
let body = raw.replace(importRe, (_m, def, _nsFull, nsName, named, spec) => {
  externals.push(spec);
  const varName = `__mod_${spec.replace(/[^a-zA-Z0-9]/g, '_')}`;
  // require 每包一次（多导入行共享同一模块句柄）
  if (!externals.slice(0, -1).includes(spec)) {
    bindingLines.push(`let ${varName} = require(${JSON.stringify(spec)});`);
  }
  if (def !== undefined && def !== varName) bindingLines.push(`const ${def} = ${varName};`);
  if (nsName !== undefined) bindingLines.push(`const ${nsName} = ${varName};`);
  if (named !== undefined) {
    // 命名导入（{ a, b as c }）→ 从模块对象重建绑定
    for (const n of named.replace(/^\{|\}$/g, '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const [orig, alias] = n.split(/\s+as\s+/);
      bindingLines.push(`const ${alias ?? orig} = ${varName}[${JSON.stringify(orig)}];`);
    }
  }
  return '';
});

// ── 1.5 body 内遗留的 ESM export 语句 → 删（壳尾的 exports.* 负责导出） ─
body = body.replace(/^\s*export\s*\{[^}]*\};?\s*$/m, '');
// 同步 sourcemap 引用行（壳包装后行号全变，留着误导调试器）
body = body.replace(/^\s*\/\/# sourceMappingURL=.*$\n?/m, '');
body = body.replace(/^\n+/, '');

// ── 2. external 白名单（宿主运行时集）──越界即炸（宁炸不错） ───────────
const ALLOWED = new Set(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']);
const unknown = externals.filter((s) => !ALLOWED.has(s));
if (unknown.length > 0) {
  console.error(`wrap-client: unexpected external imports: ${unknown.join(', ')} (allowed: ${[...ALLOWED].join(', ')})`);
  process.exit(1);
}
const unique = [...new Set(externals)];

// ── 3. 壳包装（形态 = better-sidebar lib/client.js 头尾逐字段对照） ─────
const wrapped = `window.__ModuleLoader__.load({
\tid: "@cc-migrate/dsh-plugin",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${bindingLines.map((l) => `\t\t${l}`).join('\n')}
${body
  .split('\n')
  .map((l) => `\t\t${l}`)
  .join('\n')}
\t\texports.apply = apply;
\t\texports.inject = inject;
\t\treturn module.exports;
\t}
});
`;

writeFileSync(outPath, wrapped);
// raw 中间产物不发布（pack.mjs 的 files 覆盖 lib 整目录）
unlinkSync(rawPath);

// ── 4. 静态自检：形态断言（与 test/client-smoke.mjs 共享语义） ─────────
if (!wrapped.includes('window.__ModuleLoader__.load(')) throw new Error('wrap-client: missing ModuleLoader wrapper');
if (!wrapped.includes('exports.apply = apply;')) throw new Error('wrap-client: missing exports.apply');
if (!wrapped.includes('exports.inject = inject;')) throw new Error('wrap-client: missing exports.inject');
if (/^\s*(import|export)\s/m.test(body)) throw new Error('wrap-client: ESM import/export statement survived rewrite');

console.log(`wrap-client: lib/client.js written (${(wrapped.length / 1024).toFixed(0)}KB, externals: [${unique.join(', ') || 'none'}])`);
