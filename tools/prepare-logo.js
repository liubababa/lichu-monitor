#!/usr/bin/env node
/* ============================================================
 * 企业 logo 处理：把白底 PNG 变成透明底，裁掉留白，生成页面要用的几个尺寸
 *
 *   node tools/prepare-logo.js <原始图.png>
 *
 * 产物（都在 libs/ 下）：
 *   logo.png       页头用（透明、已裁留白，高 128）
 *   logo-64.png    浏览器标签页图标（64×64，居中留边）
 *   logo-180.png   移动端/苹果书签图标（180×180）
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------- PNG 解码（8bit，支持 RGB/RGBA/调色板） ---------- */
const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function decodePNG(buf) {
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error('只支持 8bit 非隔行 PNG（实际 ' + bitDepth + 'bit, interlace=' + interlace + '）');
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 3 ? 1 : 4;
  const stride = w * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++];
    const line = raw.slice(rp, rp + stride); rp += stride;
    const cur = px.slice(y * stride, (y + 1) * stride);
    const prev = y ? px.slice((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= ch) ? prev[x - ch] : 0;
      let v = line[x];
      if (ft === 1) v = (v + a) & 255;
      else if (ft === 2) v = (v + b) & 255;
      else if (ft === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
      }
      cur[x] = v;
    }
  }
  /* → RGBA */
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    let r, g, b, a = 255;
    if (colorType === 6) { r = px[i * 4]; g = px[i * 4 + 1]; b = px[i * 4 + 2]; a = px[i * 4 + 3]; }
    else if (colorType === 2) { r = px[i * 3]; g = px[i * 3 + 1]; b = px[i * 3 + 2]; }
    else if (colorType === 3) { const p = px[i] * 3; r = palette[p]; g = palette[p + 1]; b = palette[p + 2]; }
    else { r = g = b = px[i]; }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { w: w, h: h, rgba: rgba };
}

function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  function chunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
    return Buffer.concat([head, data, crcBuf]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- 白底转透明（白键 + 边缘反解，避免锯齿发白） ---------- */
function whiteToAlpha(img) {
  const { w, h, rgba } = img;
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a0 = rgba[i * 4 + 3];
    const mn = Math.min(r, g, b);
    if (a0 === 0 || mn >= 246) continue;                       // 纯白/已透明 → 透明
    let a = 255;
    if (mn > 200) a = Math.round((246 - mn) / (246 - 200) * 255);  // 抗锯齿过渡带
    const af = a / 255;
    out[i * 4] = Math.max(0, Math.min(255, Math.round((r - (1 - af) * 255) / af)));
    out[i * 4 + 1] = Math.max(0, Math.min(255, Math.round((g - (1 - af) * 255) / af)));
    out[i * 4 + 2] = Math.max(0, Math.min(255, Math.round((b - (1 - af) * 255) / af)));
    out[i * 4 + 3] = a;
  }
  return { w: w, h: h, rgba: out };
}

/* ---------- 裁到白色区域（源图外面套了黑框时用；没有大白区就原样返回） ---------- */
function cropWhite(img) {
  const { w, h, rgba } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (Math.min(rgba[i], rgba[i + 1], rgba[i + 2]) >= 200) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return img;
  const area = (x1 - x0 + 1) * (y1 - y0 + 1) / (w * h);
  if (area < .25) return img;                     // 白区太小 → 认为图里本来就没有白底框
  const nw = x1 - x0 + 1, nh = y1 - y0 + 1;
  if (nw === w && nh === h) return img;
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    rgba.copy(out, y * nw * 4, ((y + y0) * w + x0) * 4, ((y + y0) * w + x0 + nw) * 4);
  }
  return { w: nw, h: nh, rgba: out };
}

/* ---------- 裁掉四周透明留白 ---------- */
function trim(img) {
  const { w, h, rgba } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return img;
  const nw = x1 - x0 + 1, nh = y1 - y0 + 1;
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    rgba.copy(out, y * nw * 4, ((y + y0) * w + x0) * 4, ((y + y0) * w + x0 + nw) * 4);
  }
  return { w: nw, h: nh, rgba: out };
}

/* ---------- 缩放（盒式，带 alpha 加权） ---------- */
function resize(img, nw, nh) {
  const { w, h, rgba } = img;
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy0 = Math.floor(y * h / nh), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * h / nh));
    for (let x = 0; x < nw; x++) {
      const sx0 = Math.floor(x * w / nw), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * w / nw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1 && sy < h; sy++) {
        for (let sx = sx0; sx < sx1 && sx < w; sx++) {
          const i = (sy * w + sx) * 4, pa = rgba[i + 3] / 255;
          r += rgba[i] * pa; g += rgba[i + 1] * pa; b += rgba[i + 2] * pa; a += pa; n++;
        }
      }
      const o = (y * nw + x) * 4;
      if (!a) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; continue; }
      out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a);
      out[o + 3] = Math.round(a / n * 255);
    }
  }
  return { w: nw, h: nh, rgba: out };
}

/* ---------- 放到正方形画布中心（图标用） ---------- */
function square(img, size, padRatio) {
  const inner = Math.round(size * (1 - (padRatio || 0.12) * 2));
  const scale = Math.min(inner / img.w, inner / img.h);
  const rw = Math.max(1, Math.round(img.w * scale)), rh = Math.max(1, Math.round(img.h * scale));
  const small = resize(img, rw, rh);
  const out = Buffer.alloc(size * size * 4);
  const ox = Math.round((size - rw) / 2), oy = Math.round((size - rh) / 2);
  for (let y = 0; y < rh; y++) {
    small.rgba.copy(out, ((y + oy) * size + ox) * 4, y * rw * 4, (y + 1) * rw * 4);
  }
  return { w: size, h: size, rgba: out };
}

/* ---------------- 主流程 ---------------- */
const src = process.argv[2];
if (!src) { console.error('用法：node tools/prepare-logo.js <原始图.png>'); process.exit(1); }
const outDir = path.join(__dirname, '..', 'libs');
const img = decodePNG(fs.readFileSync(src));
console.log('原始图：' + img.w + '×' + img.h);

const cut = trim(whiteToAlpha(cropWhite(img)));
console.log('去白底并裁留白后：' + cut.w + '×' + cut.h + '（宽高比 ' + (cut.w / cut.h).toFixed(2) + '）');

const head = resize(cut, Math.round(128 * cut.w / cut.h), 128);
fs.writeFileSync(path.join(outDir, 'logo.png'), encodePNG(head.w, head.h, head.rgba));
console.log('→ libs/logo.png  ' + head.w + '×' + head.h);

[['logo-64.png', 64, .14], ['logo-180.png', 180, .14]].forEach(function (p) {
  const sq = square(cut, p[1], p[2]);
  fs.writeFileSync(path.join(outDir, p[0]), encodePNG(sq.w, sq.h, sq.rgba));
  console.log('→ libs/' + p[0] + '  ' + sq.w + '×' + sq.h);
});
