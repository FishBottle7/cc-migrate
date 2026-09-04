/**
 * gen-icon.mjs — cc-migrate 应用图标生成（零外部依赖，可重复生成）
 *
 * 背景：本机无 ImageMagick/GraphicsMagick/Inkscape，node_modules 依赖树（.pnpm
 * store 全量排查）里也没有 sharp/canvas/pngjs/to-ico，ffmpeg 是 essentials 构建
 * （无 SVG 解码器）。因此不用「SVG→PNG 转换」路线，而是**纯 JS 手写栅格化**：
 * 在 JS 里直接定义图标的几何（签名距离函数），逐像素多子采样抗锯齿，node:zlib
 * deflateSync 编码 PNG，再手写 ICO（PNG-in-ICO，Vista+ 支持）与 ICNS（各层嵌
 * PNG 的 icns 容器）两个格式。全程无时间戳注入，gen:icon 幂等重跑字节一致。
 *
 * 设计（cc-migrate 语义：会话 / 迁移 / 流动）：
 *   深蓝→青渐变圆角方底（深浅色任务栏都可辨）+ 对角排布的两个对话气泡
 *   （左上=源工具，右下=目标工具）+ 一支穿过两气泡的对角双向箭头（迁移 ⇄）。
 *
 * 产物（assets/，electron-builder.yml 用 icon: 显式指路，绕开 build/ 约定，
 * 根 .gitignore 无需改动）：
 *   assets/icon.svg              矢量源（人可读，与栅格化同一套几何参数）
 *   assets/icons/icon.ico        Windows：16/24/32/48/64/128/256 多层 PNG-in-ICO
 *   assets/icons/icon.icns       macOS：ic07..ic14 共 8 层（16..1024）
 *   assets/icons/NNxNN.png       Linux set：16/24/32/48/64/128/256/512
 *
 * 用法：
 *   node scripts/gen-icon.mjs            生成全部
 *   node scripts/gen-icon.mjs --verify   生成后自检：解析 ICO/ICNS 容器头，
 *                                        校验每层 PNG 签名 + IHDR 尺寸
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(__dirname, '..');
const assetsDir = path.join(appDir, 'assets');
const iconsDir = path.join(assetsDir, 'icons');

const VERIFY = process.argv.includes('--verify');

/* ────────────────────────────────────────────────────────────────
 * 1. 几何：signed distance 原语（内负外正，等距于形状边界）
 *──────────────────────────────────────────────────────────────── */

/** 圆角矩形 */
function sdRoundRect(px, py, x, y, w, h, r) {
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  const dx = px - cx;
  const dy = py - cy;
  const outer = Math.hypot(dx, dy) - r;
  const bx = Math.max(x - px, px - (x + w));
  const by = Math.max(y - py, py - (y + h));
  const box = Math.hypot(Math.max(bx, 0), Math.max(by, 0)) + Math.min(Math.max(bx, by), 0);
  return Math.max(outer, box);
}

/** 三角形（三点，绕向不限） */
function sdTriangle(px, py, [x1, y1], [x2, y2], [x3, y3]) {
  const e0 = [x2 - x1, y2 - y1];
  const e1 = [x3 - x2, y3 - y2];
  const e2 = [x1 - x3, y1 - y3];
  const v0 = [px - x1, py - y1];
  const v1 = [px - x2, py - y2];
  const v2 = [px - x3, py - y3];
  const cross = (e, v) => e[0] * v[1] - e[1] * v[0];
  // 内部 = 三条有向边同侧（任意绕向：符号一致即可）
  const s0 = cross(e0, v0), s1 = cross(e1, v1), s2 = cross(e2, v2);
  const pos = s0 >= 0 && s1 >= 0 && s2 >= 0;
  const neg = s0 <= 0 && s1 <= 0 && s2 <= 0;
  const d = (e, v) => Math.abs(cross(e, v)) / Math.hypot(e[0], e[1]);
  const dist = Math.min(d(e0, v0), d(e1, v1), d(e2, v2));
  return pos || neg ? -dist : dist;
}

/** 旋转胶囊（两端圆头的粗线段）：旋转是等距变换，先逆旋转再求轴对齐圆角矩形 */
function sdCapsuleRot(px, py, cx, cy, angleRad, halfLen, halfWid) {
  const cos = Math.cos(-angleRad);
  const sin = Math.sin(-angleRad);
  const dx = px - cx;
  const dy = py - cy;
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  return sdRoundRect(rx, ry, -halfLen, -halfWid, halfLen * 2, halfWid * 2, halfWid);
}

/* ────────────────────────────────────────────────────────────────
 * 2. 形状清单（z 序：数组后面的画在上面；bbox 用于栅格化剔除）
 *    坐标系 1024x1024。同一套参数也写进 SVG 源（见 svgSource()）。
 *──────────────────────────────────────────────────────────────── */

const W = 1024;

const BG_TOP = [14, 79, 158]; // #0e4f9e 深蓝（左上）
const BG_BOT = [12, 148, 166]; // #0c94a6 青（右下）
const BUBBLE_A = [219, 231, 248]; // #dbe7f8 冷白（源工具气泡）
const BUBBLE_B = [255, 255, 255]; // #ffffff 纯白（目标工具气泡）
const ARROW = [255, 194, 71]; // #ffc247 琥珀（双向流箭头，蓝底/白底都高对比）

const A_RECT = { x: 124, y: 150, w: 384, h: 296, r: 88 };
const A_TAIL = [[180, 440], [292, 440], [150, 524]]; // 底边左侧 → 指向左下
const B_RECT = { x: 516, y: 578, w: 384, h: 296, r: 88 };
const B_TAIL = [[732, 584], [844, 584], [874, 498]]; // 顶边右侧 → 指向右上
const DIAG = Math.SQRT1_2; // 对角方向 (1,1)/√2
const SHAFT = { cx: 512, cy: 512, halfLen: 178.2, halfWid: 40 }; // (386,386)→(638,638)
const HEAD_A = [[467, 305], [305, 467], [280, 280]]; // 箭头（指向左上，源端）
const HEAD_B = [[719, 557], [557, 719], [744, 744]]; // 箭头（指向右下，目标端）

function bboxOfRect({ x, y, w, h }) { return [x, y, x + w, y + h]; }
function bboxOfTri([p1, p2, p3]) {
  const xs = [p1[0], p2[0], p3[0]];
  const ys = [p1[1], p2[1], p3[1]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function bboxOfCapsule({ cx, cy, halfLen, halfWid }) {
  const e = (halfLen + halfWid) * DIAG; // 45° 旋转后两轴投影等长
  return [cx - e, cy - e, cx + e, cy + e];
}

const shapes = [
  {
    name: 'bg',
    bbox: [0, 0, W, W],
    sd: (px, py) => sdRoundRect(px, py, 0, 0, W, W, 200),
    color: (px, py) => {
      const t = (px + py) / (2 * W); // (0,0)→(W,W) 对角渐变
      return [0, 1, 2].map((i) => BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t);
    },
  },
  { name: 'bubble-a', bbox: bboxOfRect(A_RECT), sd: (px, py) => sdRoundRect(px, py, A_RECT.x, A_RECT.y, A_RECT.w, A_RECT.h, A_RECT.r), color: () => BUBBLE_A },
  { name: 'bubble-a-tail', bbox: bboxOfTri(A_TAIL), sd: (px, py) => sdTriangle(px, py, ...A_TAIL), color: () => BUBBLE_A },
  { name: 'bubble-b', bbox: bboxOfRect(B_RECT), sd: (px, py) => sdRoundRect(px, py, B_RECT.x, B_RECT.y, B_RECT.w, B_RECT.h, B_RECT.r), color: () => BUBBLE_B },
  { name: 'bubble-b-tail', bbox: bboxOfTri(B_TAIL), sd: (px, py) => sdTriangle(px, py, ...B_TAIL), color: () => BUBBLE_B },
  { name: 'arrow-shaft', bbox: bboxOfCapsule(SHAFT), sd: (px, py) => sdCapsuleRot(px, py, SHAFT.cx, SHAFT.cy, Math.PI / 4, SHAFT.halfLen, SHAFT.halfWid), color: () => ARROW },
  { name: 'arrow-head-a', bbox: bboxOfTri(HEAD_A), sd: (px, py) => sdTriangle(px, py, ...HEAD_A), color: () => ARROW },
  { name: 'arrow-head-b', bbox: bboxOfTri(HEAD_B), sd: (px, py) => sdTriangle(px, py, ...HEAD_B), color: () => ARROW },
];

/* ────────────────────────────────────────────────────────────────
 * 3. 栅格化：每像素 SS×SS 子采样，记录各形状覆盖率后按覆盖加权混色
 *    （正确处理形状内部边界的 AA——不是取最上层色，而是混合）
 *──────────────────────────────────────────────────────────────── */

const SS = 3; // 子采样密度（3x3）：对角边缘在 16px 下也平滑

function render(size) {
  const s = size / W; // 模型→像素
  const px = new Uint8Array(size * size * 4);
  const counts = new Float64Array(shapes.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      counts.fill(0);
      // 子采样：命中「最上层」形状（z 序倒序首个 sd<=0），累计各层覆盖数
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const mx = (x + (sx + 0.5) / SS) / s;
          const my = (y + (sy + 0.5) / SS) / s;
          for (let i = shapes.length - 1; i >= 0; i--) {
            const b = shapes[i].bbox;
            if (mx < b[0] || mx > b[2] || my < b[1] || my > b[3]) continue; // bbox 剔除
            if (shapes[i].sd(mx, my) <= 0) { counts[i]++; break; }
          }
        }
      }
      const total = counts.reduce((a, b) => a + b, 0);
      const idx = (y * size + x) * 4;
      if (total === 0) { px[idx + 3] = 0; continue; } // 圆角外的透明像素
      const mcx = (x + 0.5) / s; // 模型坐标（渐变取像素中心）
      const mcy = (y + 0.5) / s;
      let r = 0, g = 0, b2 = 0;
      for (let i = 0; i < shapes.length; i++) {
        if (counts[i] === 0) continue;
        const w = counts[i] / total;
        const c = shapes[i].color(mcx, mcy);
        r += w * c[0]; g += w * c[1]; b2 += w * c[2];
      }
      px[idx] = Math.round(r);
      px[idx + 1] = Math.round(g);
      px[idx + 2] = Math.round(b2);
      px[idx + 3] = Math.round((total / (SS * SS)) * 255);
    }
  }
  return px;
}

/* ────────────────────────────────────────────────────────────────
 * 4. PNG 编码（node:zlib）：签名 + IHDR + IDAT(deflate level 9) + IEND
 *──────────────────────────────────────────────────────────────── */

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    const o = y * (stride + 1);
    raw[o] = 0; // filter: None（形状自带 AA，无需预测滤波）
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, o + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ────────────────────────────────────────────────────────────────
 * 5. ICO 容器（PNG-in-ICO）：ICONDIR + ICONDIRENTRY[] + PNG blobs
 *    Vista+ 支持目录项直接嵌 PNG；256px 层必须 PNG（BMP 位图限 128）。
 *──────────────────────────────────────────────────────────────── */

function buildICO(entries /* [size, pngBuf] 升序 */) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(([size, png], i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o); // 宽（0 = 256）
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1); // 高
    dir.writeUInt8(0, o + 2); // palette
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // color planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map(([, png]) => png)]);
}

/* ────────────────────────────────────────────────────────────────
 * 6. ICNS 容器：magic 'icns' + 总长，条目 = 类型码(4B) + len(4B 含头) + PNG
 *    ic07=128 ic08=256 ic09=512 ic10=1024 ic11=32 ic12=64
 *    ic13=512(256@2x) ic14=256(128@2x) —— hidpi 别名层，内容同源图
 *──────────────────────────────────────────────────────────────── */

const ICNS_TYPES = [
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 512],
  ['ic14', 256],
];

function buildICNS(pngBySize) {
  const entries = [];
  for (const [type, size] of ICNS_TYPES) {
    const png = pngBySize.get(size);
    if (!png) continue;
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    entries.push(Buffer.concat([head, png]));
  }
  const total = 8 + entries.reduce((n, e) => n + e.length, 0);
  const out = Buffer.alloc(8);
  out.write('icns', 0, 'ascii');
  out.writeUInt32BE(total, 4);
  return Buffer.concat([out, ...entries]);
}

/* ────────────────────────────────────────────────────────────────
 * 7. SVG 矢量源（与栅格化同一套几何参数，人可读 / 可交给美术重绘）
 *──────────────────────────────────────────────────────────────── */

function svgSource() {
  const { cx, cy, halfLen, halfWid } = SHAFT;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}" width="${W}" height="${W}">
  <title>cc-migrate</title>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0e4f9e"/>
      <stop offset="1" stop-color="#0c94a6"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${W}" rx="200" fill="url(#bg)"/>
  <rect x="${A_RECT.x}" y="${A_RECT.y}" width="${A_RECT.w}" height="${A_RECT.h}" rx="${A_RECT.r}" fill="#dbe7f8"/>
  <path d="M ${A_TAIL[0]} L ${A_TAIL[1]} L ${A_TAIL[2]} Z" fill="#dbe7f8"/>
  <rect x="${B_RECT.x}" y="${B_RECT.y}" width="${B_RECT.w}" height="${B_RECT.h}" rx="${B_RECT.r}" fill="#ffffff"/>
  <path d="M ${B_TAIL[0]} L ${B_TAIL[1]} L ${B_TAIL[2]} Z" fill="#ffffff"/>
  <g fill="#ffc247">
    <rect x="${(cx - halfLen).toFixed(1)}" y="${cy - halfWid}" width="${(halfLen * 2).toFixed(1)}" height="${halfWid * 2}" rx="${halfWid}" transform="rotate(45 ${cx} ${cy})"/>
    <path d="M ${HEAD_A[0]} L ${HEAD_A[1]} L ${HEAD_A[2]} Z"/>
    <path d="M ${HEAD_B[0]} L ${HEAD_B[1]} L ${HEAD_B[2]} Z"/>
  </g>
</svg>
`;
}

/* ────────────────────────────────────────────────────────────────
 * 8. 自检（--verify）：解析自己写的容器头
 *──────────────────────────────────────────────────────────────── */

function verifyPNG(buf, expectSize) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(sig)) return `PNG 签名错误`;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w !== expectSize || h !== expectSize) return `IHDR ${w}x${h} ≠ ${expectSize}`;
  return null;
}

function verifyICO(buf) {
  const issues = [];
  if (buf.readUInt16LE(2) !== 1) issues.push(`ICO type != icon`);
  const count = buf.readUInt16LE(4);
  const layers = [];
  let off = 6;
  for (let i = 0; i < count; i++) {
    const sizeByte = buf.readUInt8(off);
    const size = sizeByte === 0 ? 256 : sizeByte;
    const bytes = buf.readUInt32LE(off + 8);
    const start = buf.readUInt32LE(off + 12);
    const blob = buf.subarray(start, start + bytes);
    const err = verifyPNG(blob, size);
    layers.push({ size, ok: !err });
    if (err) issues.push(`层 ${size}px: ${err}`);
    off += 16;
  }
  return { issues, layers };
}

function verifyICNS(buf) {
  if (buf.readUInt32BE(0) !== 0x69636e73 /* 'icns' */) return { issues: [`magic 非 icns`], layers: [] };
  const total = buf.readUInt32BE(4);
  const layers = [];
  const issues = [];
  let off = 8;
  while (off < total) {
    const type = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32BE(off + 4);
    const size = ICNS_TYPES.find(([t]) => t === type)?.[1];
    const blob = buf.subarray(off + 8, off + len);
    const err = size ? verifyPNG(blob, size) : `未知类型码 ${type}`;
    layers.push({ type, size: size ?? '?', ok: !err });
    if (err) issues.push(`icns ${type}: ${err}`);
    off += len;
  }
  return { issues, layers };
}

/* ────────────────────────────────────────────────────────────────
 * 9. 生成主流程
 *──────────────────────────────────────────────────────────────── */

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICNS_PNG_SIZES = [32, 64, 128, 256, 512, 1024];
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

const pngCache = new Map(); // size -> Buffer（ICO/ICNS/Linux 复用同尺寸栅格）

function renderPNG(size) {
  if (!pngCache.has(size)) {
    process.stdout.write(`[render] ${size}x${size} …\n`);
    pngCache.set(size, encodePNG(size, render(size)));
  }
  return pngCache.get(size);
}

fs.mkdirSync(iconsDir, { recursive: true });

// SVG 矢量源
const svgPath = path.join(assetsDir, 'icon.svg');
fs.writeFileSync(svgPath, svgSource());
console.log(`[svg]    ${path.relative(appDir, svgPath)}（人可读矢量源）`);

// Linux PNG set
for (const size of LINUX_SIZES) {
  const png = renderPNG(size);
  const p = path.join(iconsDir, `${size}x${size}.png`);
  fs.writeFileSync(p, png);
  console.log(`[png]    ${path.relative(appDir, p)} ${png.length}B`);
}

// Windows ICO
const ico = buildICO(ICO_SIZES.map((s) => [s, renderPNG(s)]));
const icoPath = path.join(iconsDir, 'icon.ico');
fs.writeFileSync(icoPath, ico);
console.log(`[ico]    ${path.relative(appDir, icoPath)} ${ico.length}B（层：${ICO_SIZES.join('/')}）`);

// macOS ICNS
const icns = buildICNS(new Map(ICNS_PNG_SIZES.map((s) => [s, renderPNG(s)])));
const icnsPath = path.join(iconsDir, 'icon.icns');
fs.writeFileSync(icnsPath, icns);
console.log(`[icns]   ${path.relative(appDir, icnsPath)} ${icns.length}B（${ICNS_TYPES.length} 层）`);

// 自检
if (VERIFY) {
  console.log(`\n[verify] 解析容器头自检 ——`);
  let failed = false;

  const icoRes = verifyICO(fs.readFileSync(icoPath));
  console.log(`  icon.ico：${icoRes.layers.length} 层`);
  for (const l of icoRes.layers) console.log(`    ${String(l.size).padStart(3)}px  ${l.ok ? 'PNG OK' : 'BAD'}`);
  icoRes.issues.forEach((m) => { console.error(`    ! ${m}`); failed = true; });

  const icnsRes = verifyICNS(fs.readFileSync(icnsPath));
  console.log(`  icon.icns：${icnsRes.layers.length} 层`);
  for (const l of icnsRes.layers) console.log(`    ${l.type} → ${String(l.size).padStart(4)}px  ${l.ok ? 'PNG OK' : 'BAD'}`);
  icnsRes.issues.forEach((m) => { console.error(`    ! ${m}`); failed = true; });

  let pngOk = true;
  for (const size of LINUX_SIZES) {
    const err = verifyPNG(fs.readFileSync(path.join(iconsDir, `${size}x${size}.png`)), size);
    if (err) { console.error(`  ${size}x${size}.png ! ${err}`); pngOk = false; failed = true; }
  }
  console.log(`  png set：${LINUX_SIZES.join('/')} 签名+IHDR ${pngOk ? 'OK' : 'FAIL'}`);

  if (failed) { console.error('[verify] FAIL'); process.exit(1); }
  console.log('[verify] PASS');
}
