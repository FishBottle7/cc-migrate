/**
 * dist-check.mjs — dist:win 出包后的自动冒烟 + 产物校验汇总表。
 *
 * 用法（一般不单独跑，由 `pnpm run dist:win:check` 串联）：
 *   node scripts/dist-check.mjs [--dist-dir <路径>]
 *
 * 职责：
 *   1. 定位产物目录 —— 逻辑与 set-dist-dir.mjs 一致：SM_DIST_DIR 环境变量
 *      > 仓库盘 <2GB 回退 %USERPROFILE%\Desktop\sm-dist > ./release。本脚本
 *      与 electron-builder 不在同一进程，环境变量传不过来，所以把三个候选
 *      都扫一遍，取「win-unpacked mtime 最新」的那个（一次刚跑完的构建必然
 *      是最新的）。也可 --dist-dir 显式指定。
 *   2. 三产物齐全：nsis setup.exe / portable exe / setup.exe.blockmap。
 *      （dir 产物 win-unpacked/ 不算「分发产物」，但它是冒烟对象，必须存在）
 *   3. 图标进包校验（两层）：
 *      a. 浅层：assets/icons/icon.ico 存在，且 mtime 早于产物（electron-builder
 *         读的是这份文件——不是 Electron 默认图标）；
 *      b. 深层（真实证据）：在 win-unpacked/session-migrate.exe 的 PE 资源段里
 *         找嵌入的 PNG —— 直接搜二进制里的 PNG 签名 + IHDR 尺寸（我们的 ICO
 *         是 PNG-in-ICO，exe 资源里的 RT_GROUP_ICON/RT_ICON 同样是这批 PNG）。
 *         找到 256x256 层 = 新图标真实嵌入了 exe。Electron 默认图标的 RT_ICON
 *         是 BMP 编码（PNG 只在 256px 层），且字节与我们生成的层完全不同 ——
 *         所以「能匹配到我们 icon.ico 里某层的完整 PNG 字节」是充分判据。
 *   4. 冒烟：spawn 既有 scripts/smoke-packaged.mjs（不动它的本体），
 *      stdio 直通，退出码透传。
 *   5. 汇总表：产物名 / 大小 / mtime / 冒烟结果；exit code 0=全绿。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appDir, '../..');

function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  process.exit(1);
}

/* ── 1. 定位产物目录 ─────────────────────────────────────────── */
// 与 set-dist-dir.mjs 同款 PowerShell 查驱动器剩余量（fsutil volume diskfree 要管理员）
function freeBytesOnWindows(p) {
  const drive = path.parse(path.resolve(p)).root;
  const out = execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `(Get-PSDrive ${drive.slice(0, 1)}).Free`,
  ], { encoding: 'utf8' });
  return Number(out.trim());
}

const argv = process.argv.slice(2);
const dirArgIdx = argv.indexOf('--dist-dir');
const explicitDistDir = dirArgIdx >= 0 ? argv[dirArgIdx + 1] : null;

const candidates = [];
if (explicitDistDir) {
  candidates.push(explicitDistDir);
} else {
  if (process.env.SM_DIST_DIR) candidates.push(process.env.SM_DIST_DIR);
  // set-dist-dir.mjs 的回退决策复刻：仓库盘 <2GB → 桌面
  const repoDriveFree =
    process.platform === 'win32'
      ? freeBytesOnWindows(repoRoot)
      : fs.statfsSync(repoRoot).bsize * fs.statfsSync(repoRoot).bavail;
  if (process.platform === 'win32' && repoDriveFree < 2 * 1024 ** 3) {
    candidates.push(path.join(os.homedir(), 'Desktop', 'sm-dist'));
  } else {
    candidates.push(path.join(appDir, 'release'));
  }
  // 兜底：另一个候选也扫（万一决策变了，取 mtime 最新的准没错）
  candidates.push(path.join(appDir, 'release'));
  candidates.push(path.join(os.homedir(), 'Desktop', 'sm-dist'));
}

const seen = new Set();
const unpackedCandidates = [];
for (const c of candidates) {
  const p = path.resolve(c);
  if (seen.has(p)) continue;
  seen.add(p);
  const winUnpacked = path.join(p, 'win-unpacked');
  if (fs.existsSync(path.join(winUnpacked, 'resources', 'app.asar'))) {
    unpackedCandidates.push({ distDir: p, winUnpacked, mtime: fs.statSync(winUnpacked).mtimeMs });
  }
}
if (unpackedCandidates.length === 0) {
  fail(`候选目录里都没有 win-unpacked 产物（扫过：${[...seen].join(' ; ')}）—— 先跑 dist:win`);
}
unpackedCandidates.sort((a, b) => b.mtime - a.mtime);
const { distDir, winUnpacked } = unpackedCandidates[0];
console.log(`[dist-check] 产物目录：${distDir}${unpackedCandidates.length > 1 ? '（多候选取 mtime 最新）' : ''}`);

/* ── 2. 读 package.json 版本号，拼产物文件名 ─────────────────── */
const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
const v = pkg.version;
const expected = {
  setup: `session-migrate-${v}-setup.exe`,
  portable: `session-migrate ${v}.exe`, // electron-builder portable 默认产物名（空格分隔）
  blockmap: `session-migrate-${v}-setup.exe.blockmap`,
};

/* ── 3. 图标进包校验 ────────────────────────────────────────── */
// 3a. icon.ico 存在 & mtime 早于产物（被本次构建读过）
const icoPath = path.join(appDir, 'assets', 'icons', 'icon.ico');
if (!fs.existsSync(icoPath)) {
  fail(`assets/icons/icon.ico 不存在 —— 先跑 pnpm run gen:icon`);
}
const exePath = path.join(winUnpacked, 'session-migrate.exe');
if (!fs.existsSync(exePath)) fail(`未找到 ${exePath}`);

const icoBuf = fs.readFileSync(icoPath);
const exeBuf = fs.readFileSync(exePath);

// 3b. 深层：exe 里能找到 icon.ico 某层 PNG 的完整字节（充分判据：
//     Electron 默认图标的 RT_ICON 字节与此完全不同）
//     先从 icon.ico 目录里解出各层 PNG 的 [start, size]。
const layerCount = icoBuf.readUInt16LE(4);
const layers = [];
for (let i = 0; i < layerCount; i++) {
  const o = 6 + i * 16;
  const sizeByte = icoBuf.readUInt8(o);
  const size = sizeByte === 0 ? 256 : sizeByte;
  const bytes = icoBuf.readUInt32LE(o + 8);
  const start = icoBuf.readUInt32LE(o + 12);
  layers.push({ size, start, bytes });
}
const embeddedLayers = [];
for (const l of layers) {
  if (l.size < 64) continue; // 小层字节短，误配风险高；64+ 层字节几乎唯一
  const needle = icoBuf.subarray(l.start, l.start + l.bytes);
  if (exeBuf.includes(needle)) embeddedLayers.push(l.size);
}
if (embeddedLayers.length === 0) {
  fail(
    `exe 内未找到与 icon.ico 匹配的嵌入 PNG —— 图标疑似还是 Electron 默认（重跑 dist:win 前先 gen:icon？）`,
  );
}
console.log(
  `[dist-check] 图标进包：exe PE 资源匹配到 icon.ico 的 ${embeddedLayers.join('/')}px 层（非默认图标）`,
);

// 3c. 产物时间戳晚于 icon 文件（本次构建确实在图标生成之后）
const icoMtime = fs.statSync(icoPath).mtimeMs;
const exeMtime = fs.statSync(exePath).mtimeMs;
if (exeMtime < icoMtime) {
  fail(`产物 exe mtime 早于 icon.ico —— 本次构建没有吃到新图标，重跑 dist:win`);
}
console.log(`[dist-check] 时间戳：icon.ico ${new Date(icoMtime).toISOString()} < exe ${new Date(exeMtime).toISOString()} OK`);

/* ── 4. 冒烟（spawn 既有 smoke-packaged.mjs） ───────────────── */
console.log(`\n[dist-check] 冒烟 win-unpacked ——\n`);
const smokeScript = path.join(__dirname, 'smoke-packaged.mjs');
const smoke = spawnSync(process.execPath, [smokeScript, winUnpacked], { stdio: 'inherit' });
const smokeOk = smoke.status === 0;
if (smoke.status !== 0 && smoke.error) fail(`smoke-packaged.mjs 启动失败：${smoke.error.message}`);

/* ── 5. 汇总表 ─────────────────────────────────────────────── */
function fmtBytes(n) {
  return n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)}MB` : `${(n / 1024).toFixed(0)}KB`;
}
function fmtTime(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const rows = [];
for (const [label, rel] of [
  ['nsis setup', expected.setup],
  ['blockmap', expected.blockmap],
  ['portable', expected.portable],
]) {
  const p = path.join(distDir, rel);
  if (fs.existsSync(p)) {
    const st = fs.statSync(p);
    rows.push({ name: rel, kind: label, size: st.size, mtime: st.mtimeMs, ok: 'OK' });
  } else {
    rows.push({ name: rel, kind: label, size: 0, mtime: 0, ok: 'MISSING' });
  }
}
const exeSt = fs.statSync(exePath);
rows.push({ name: 'win-unpacked/session-migrate.exe', kind: 'dir 产物', size: exeSt.size, mtime: exeSt.mtimeMs, ok: 'OK' });
rows.push({
  name: 'smoke:packaged（list-tools JSON-RPC）',
  kind: '冒烟',
  size: NaN,
  mtime: NaN,
  ok: smokeOk ? 'PASS' : 'FAIL',
});
rows.push({
  name: 'icon 嵌入（exe PE 层匹配 icon.ico）',
  kind: '图标',
  size: icoBuf.length,
  mtime: icoMtime,
  ok: 'OK',
});

// 表格列宽（中英混排按显示宽度粗略 pad：CJK 算 2）
function dispWidth(s) {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0) > 0x2e7f ? 2 : 1;
  return w;
}
function pad(s, width) {
  const diff = width - dispWidth(String(s));
  return String(s) + ' '.repeat(Math.max(diff, 0));
}

const headers = ['检查项', '结果', '大小', 'mtime'];
const colWidths = [46, 8, 9, 20];
console.log('\n' + '=' .repeat(20) + ' dist-check 汇总 ' + '=' .repeat(20));
console.log(headers.map((h, i) => pad(h, colWidths[i])).join(' '));
console.log('-'.repeat(colWidths.reduce((a, b) => a + b + 1, 0)));
for (const r of rows) {
  const cells = [
    r.name.length > 44 ? r.name.slice(0, 41) + '...' : r.name,
    r.ok,
    Number.isNaN(r.size) ? '-' : fmtBytes(r.size),
    Number.isNaN(r.mtime) ? '-' : fmtTime(r.mtime),
  ];
  console.log(cells.map((c, i) => pad(c, colWidths[i])).join(' '));
}
console.log('='.repeat(colWidths.reduce((a, b) => a + b + 1, 0)));

const missing = rows.filter((r) => r.ok === 'MISSING');
const failed = rows.filter((r) => r.ok === 'FAIL' || r.ok === 'MISSING');
if (failed.length > 0) {
  console.error(`\nFAIL：${failed.map((r) => r.name).join('、')}`);
  process.exit(1);
}
console.log('\ndist-check PASS — 产物齐全 + 图标进包 + 冒烟全绿');
