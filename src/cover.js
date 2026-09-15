'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ff, filter, probeJson } = require('./ffmpeg');
const { resolveBox } = require('./box');

const clampEven = (v, lo, hi) => {
  let n = Math.round(Math.max(lo, Math.min(hi, v)));
  return n % 2 ? n + 1 : n;
};

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ectool-'));
}

async function imageSize(file) {
  const j = await probeJson(['-select_streams', 'v:0', '-show_entries', 'stream=width,height', file]);
  const s = (j.streams || [])[0];
  if (!s) throw new Error(`读不出图片尺寸: ${file}`);
  return { w: s.width, h: s.height };
}

// 把一块区域缩成 1x1 取平均色
async function avgColor(image, rect) {
  const { stdout } = await ff(['-i', image,
    '-vf', `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y},scale=1:1`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  if (stdout.length < 3) throw new Error('取色失败');
  return [stdout[0], stdout[1], stdout[2]];
}

const toHex = ([r, g, b]) =>
  '0x' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

// 在 box 外侧取四条细带的平均色，用来盖掉母版上的旧数字
async function sampleEdgeColor(image, box, imgW, imgH, thickness = 8) {
  const t = thickness;
  const strips = [
    { x: box.x, y: box.y - t, w: box.w, h: t },
    { x: box.x, y: box.y + box.h, w: box.w, h: t },
    { x: box.x - t, y: box.y, w: t, h: box.h },
    { x: box.x + box.w, y: box.y, w: t, h: box.h },
  ].filter(r => r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 &&
                r.x + r.w <= imgW && r.y + r.h <= imgH);
  if (!strips.length) throw new Error('无法采样擦除色：选框贴边或超出母版范围');
  const cols = [];
  for (const s of strips) cols.push(await avgColor(image, s));
  const avg = [0, 1, 2].map(i => Math.round(cols.reduce((a, c) => a + c[i], 0) / cols.length));
  return toHex(avg);
}

// 用 cropdetect 量文字的实际墨迹盒。返回 {w,h,dx,dy}：dx/dy 是墨迹相对 drawtext 原点的偏移
async function measureText({ fontFile, text, fontSize, strokeWidth = 0 }) {
  const pad = 200;
  const W = clampEven(fontSize * (text.length + 2) * 1.6 + pad * 2, 512, 16384);
  const H = clampEven(fontSize * 3 + pad * 2, 512, 8192);
  const dir = await tmpDir();
  const tf = path.join(dir, 'text.txt');
  try {
    await fs.writeFile(tf, text, 'utf8');
    const dt = filter('drawtext', {
      fontfile: fontFile, textfile: tf, expansion: 'none',
      fontsize: fontSize, fontcolor: 'white',
      borderw: strokeWidth || undefined, bordercolor: strokeWidth ? 'white' : undefined,
      x: pad, y: pad,
    });
    const { stderr } = await ff(['-f', 'lavfi', '-i', `color=black:s=${W}x${H}`,
      '-vf', `${dt},cropdetect=limit=16:round=2:reset=1`,
      '-frames:v', '3', '-f', 'null', '-']);
    const m = [...stderr.matchAll(/crop=(\d+):(\d+):(-?\d+):(-?\d+)/g)].pop();
    if (!m) throw new Error(`量测文字尺寸失败（cropdetect 无输出）text=${JSON.stringify(text)}`);
    const [w, h, x, y] = m.slice(1).map(Number);
    return { w, h, dx: x - pad, dy: y - pad };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// 自动字号：先按 base 线性估算，再用终值复测收敛
async function fitFontSize({ fontFile, text, boxW, boxH, fill = 0.9, strokeWidth = 0, maxSize = 4000 }) {
  const BASE = 200;
  const base = await measureText({ fontFile, text, fontSize: BASE, strokeWidth });
  if (!base.w || !base.h) throw new Error('文字量测结果为空');
  const limitW = boxW * fill, limitH = boxH * fill;
  let size = Math.floor(BASE * Math.min(limitW / base.w, limitH / base.h));
  size = Math.max(8, Math.min(maxSize, size));
  let ink = null;
  for (let i = 0; i < 5; i++) {
    ink = await measureText({ fontFile, text, fontSize: size, strokeWidth });
    if (ink.w <= limitW && ink.h <= limitH) return { fontSize: size, ink };
    const next = Math.max(8, Math.floor(size * Math.min(limitW / ink.w, limitH / ink.h)));
    if (next >= size) { size -= 1; } else { size = next; }
    if (size < 8) break;
  }
  return { fontSize: Math.max(8, size), ink: ink || base };
}

const H_FACTOR = { left: 0, center: 0.5, right: 1 };
const V_FACTOR = { top: 0, middle: 0.5, bottom: 1 };

async function renderCover({ master, out, box, text, style = {}, erase = { mode: 'none' } }) {
  const {
    fontFile, size = 'auto', color = 'white', align = 'center', valign = 'middle',
    fill = 0.9, strokeWidth = 0, strokeColor = 'black',
    shadowX = 0, shadowY = 0, shadowColor = 'black@0.5',
  } = style;
  if (!fontFile) throw new Error('style.fontFile 必填（本机 ffmpeg 无 fontconfig，家族名不可用）');

  const img = await imageSize(master);
  box = resolveBox(box, img.w, img.h);
  if (box.w <= 0 || box.h <= 0) throw new Error(`选框尺寸必须为正，得到 ${box.w}x${box.h}`);
  if (box.x < 0 || box.y < 0 || box.x + box.w > img.w || box.y + box.h > img.h) {
    throw new Error(`选框超出母版范围（母版 ${img.w}x${img.h}，选框 ${box.x},${box.y} ${box.w}x${box.h}）`);
  }

  // 1) 字号与墨迹盒
  let fontSize, ink;
  if (size === 'auto') {
    ({ fontSize, ink } = await fitFontSize({ fontFile, text, boxW: box.w, boxH: box.h, fill, strokeWidth }));
  } else {
    fontSize = Number(size);
    ink = await measureText({ fontFile, text, fontSize, strokeWidth });
  }

  // 2) 按墨迹盒精确对齐（不是按 drawtext 的行高，视觉才对得准）
  const hf = H_FACTOR[align], vf = V_FACTOR[valign];
  if (hf === undefined) throw new Error(`align 只能是 left/center/right，收到 ${align}`);
  if (vf === undefined) throw new Error(`valign 只能是 top/middle/bottom，收到 ${valign}`);
  const inkX = box.x + (box.w - ink.w) * hf;
  const inkY = box.y + (box.h - ink.h) * vf;
  const drawX = Math.round(inkX - ink.dx);
  const drawY = Math.round(inkY - ink.dy);

  // 3) 擦除旧数字
  const chain = [];
  let eraseColor = null;
  if (erase.mode === 'sample' || erase.mode === 'color') {
    const pad = Number.isFinite(erase.padding) ? erase.padding : 4;
    const r = {
      x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad),
      w: Math.min(img.w, box.x + box.w + pad) - Math.max(0, box.x - pad),
      h: Math.min(img.h, box.y + box.h + pad) - Math.max(0, box.y - pad),
    };
    eraseColor = erase.mode === 'color'
      ? erase.color
      : await sampleEdgeColor(master, box, img.w, img.h, erase.thickness || 8);
    if (!eraseColor) throw new Error('erase.mode=color 时必须提供 erase.color');
    chain.push(filter('drawbox', { x: r.x, y: r.y, w: r.w, h: r.h, color: eraseColor, t: 'fill' }));
  } else if (erase.mode !== 'none') {
    throw new Error(`erase.mode 只能是 none/sample/color，收到 ${erase.mode}`);
  }

  // 4) 写字
  const dir = await tmpDir();
  try {
    const tf = path.join(dir, 'text.txt');
    await fs.writeFile(tf, text, 'utf8');
    chain.push(filter('drawtext', {
      fontfile: fontFile, textfile: tf, expansion: 'none',
      fontsize: fontSize, fontcolor: color, x: drawX, y: drawY,
      borderw: strokeWidth || undefined,
      bordercolor: strokeWidth ? strokeColor : undefined,
      shadowx: shadowX || undefined, shadowy: shadowY || undefined,
      shadowcolor: (shadowX || shadowY) ? shadowColor : undefined,
    }));
    await fs.mkdir(path.dirname(out), { recursive: true });
    await ff(['-i', master, '-vf', chain.join(','), '-frames:v', '1', '-pix_fmt', 'rgb24', out]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  return { out, fontSize, ink, drawX, drawY, eraseColor, masterSize: img };
}

module.exports = { renderCover, resolveBox, measureText, fitFontSize, sampleEdgeColor, imageSize, avgColor, toHex };
