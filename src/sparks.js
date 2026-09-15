'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { ff } = require('./ffmpeg');

// 确定性 PRNG —— 同一 seed 出同一效果，方便调参和复现
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// 火花温度 -> 颜色（白热 -> 金 -> 橙 -> 暗红）
const RAMP = [
  [0.00, [170, 40, 8]],
  [0.35, [255, 130, 30]],
  [0.65, [255, 205, 105]],
  [1.00, [255, 250, 225]],
];
function tempColor(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < RAMP.length; i++) {
    if (t <= RAMP[i][0]) {
      const [t0, c0] = RAMP[i - 1], [t1, c1] = RAMP[i];
      const k = (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
    }
  }
  return RAMP[RAMP.length - 1][1];
}

const DEFAULTS = {
  count: 130,          // 粒子数
  speed: 620,          // 初速中值 px/s
  spread: 0.85,        // 速度随机度 0..1
  gravity: 900,        // 重力 px/s²
  drag: 1.5,           // 空气阻力系数 /s
  life: [0.35, 0.95],  // 寿命占总时长的比例区间
  size: [1.4, 3.6],    // 粒子半径 px
  glow: 2.6,           // 发光强度
  trail: 4,            // 每帧补几个拖尾采样点
  flash: 0.9,          // 初始闪光强度 0=关
  flashRadius: 0.42,   // 闪光半径（占画面短边）
  bias: 0.35,          // 向上偏置 0=各向同性 1=只向上
  seed: 20260909,
};

function buildParticles(cfg, W, H, origin, duration) {
  const rnd = mulberry32(cfg.seed);
  const ps = [];
  for (let i = 0; i < cfg.count; i++) {
    // 各向同性角度，再按 bias 把向量往上拉
    const a = rnd() * Math.PI * 2;
    let vx = Math.cos(a), vy = Math.sin(a);
    vy -= cfg.bias * (1 + vy);          // 上方向为 -y
    const n = Math.hypot(vx, vy) || 1;
    vx /= n; vy /= n;
    const sp = cfg.speed * (1 - cfg.spread + cfg.spread * Math.pow(rnd(), 0.6));
    ps.push({
      x: origin.x + (rnd() - 0.5) * 8, y: origin.y + (rnd() - 0.5) * 8,
      vx: vx * sp, vy: vy * sp,
      life: duration * (cfg.life[0] + (cfg.life[1] - cfg.life[0]) * rnd()),
      r0: cfg.size[0] + (cfg.size[1] - cfg.size[0]) * rnd(),
      seedT: 0.85 + rnd() * 0.15,
    });
  }
  return ps;
}

// 高斯光斑，加性累加到 float 缓冲
function splat(buf, W, H, px, py, r, cr, cg, cb, amp) {
  const R = Math.ceil(r * 2.2);
  const x0 = Math.max(0, Math.floor(px - R)), x1 = Math.min(W - 1, Math.ceil(px + R));
  const y0 = Math.max(0, Math.floor(py - R)), y1 = Math.min(H - 1, Math.ceil(py + R));
  const inv = 1 / (r * r);
  for (let y = y0; y <= y1; y++) {
    const dy = y - py;
    for (let x = x0; x <= x1; x++) {
      const dx = x - px;
      const w = amp * Math.exp(-(dx * dx + dy * dy) * inv * 1.8);
      if (w < 0.4) continue;
      const o = (y * W + x) * 3;
      buf[o] += cr * w / 255; buf[o + 1] += cg * w / 255; buf[o + 2] += cb * w / 255;
    }
  }
}

// 读一张图为 RGB24 原始像素
async function decodeRGB(image, W, H) {
  const { stdout } = await ff(['-i', image, '-vf', `scale=${W}:${H}`, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  if (stdout.length !== W * H * 3) throw new Error(`解码尺寸不符: ${stdout.length} != ${W * H * 3}`);
  return stdout;
}

// 生成「定格底图 + 星火」的 rawvideo rgb24 帧流文件
async function renderSparkSegment({ baseImage, out, W, H, fps, duration, origin, options = {} }) {
  const cfg = { ...DEFAULTS, ...options, life: options.life || DEFAULTS.life, size: options.size || DEFAULTS.size };
  const org = origin || { x: W / 2, y: H * 0.45 };
  const nFrames = Math.max(1, Math.round(fps * duration));
  const base = await decodeRGB(baseImage, W, H);
  const ps = buildParticles(cfg, W, H, org, duration);
  const acc = new Float32Array(W * H * 3);
  const frame = Buffer.allocUnsafe(W * H * 3);
  const ws = fs.createWriteStream(out);
  const shortSide = Math.min(W, H);

  for (let f = 0; f < nFrames; f++) {
    const t = f / fps;
    // 底图打底
    for (let i = 0; i < acc.length; i++) acc[i] = base[i];

    // 初始闪光：半径快速扩张、亮度快速衰减
    if (cfg.flash > 0 && t < 0.28) {
      const k = 1 - t / 0.28;
      splat(acc, W, H, org.x, org.y, shortSide * cfg.flashRadius * (0.25 + 0.75 * (t / 0.28) ** 0.5),
        255, 226, 170, cfg.flash * 255 * k * k);
    }

    for (const p of ps) {
      if (t > p.life) continue;
      const age = t / p.life;                       // 0..1
      const temp = p.seedT * (1 - age) ** 1.3;      // 降温
      const [cr, cg, cb] = tempColor(temp);
      const fade = (1 - age) ** 1.6;
      const rad = p.r0 * (0.35 + 0.65 * (1 - age));
      // 解析积分位置（含阻力与重力）
      const pos = (tt) => {
        const e = Math.exp(-cfg.drag * tt);
        const k = (1 - e) / cfg.drag;
        return [p.x + p.vx * k, p.y + p.vy * k + 0.5 * cfg.gravity * tt * tt];
      };
      const [cx, cy] = pos(t);
      // 拖尾：往回采样若干子步
      const back = Math.min(t, 1 / fps);
      for (let s = 0; s < cfg.trail; s++) {
        const tt = t - back * (s / cfg.trail);
        const [sx, sy] = pos(tt);
        const w = (1 - s / cfg.trail) ** 1.5;
        splat(acc, W, H, sx, sy, rad * (0.6 + 0.4 * w), cr, cg, cb, cfg.glow * 255 * fade * w / cfg.trail * 2.2);
      }
      splat(acc, W, H, cx, cy, rad, cr, cg, cb, cfg.glow * 255 * fade);
    }

    for (let i = 0; i < acc.length; i++) {
      const v = acc[i];
      frame[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    if (!ws.write(Buffer.from(frame))) await new Promise(r => ws.once('drain', r));
  }
  await new Promise((res, rej) => { ws.once('error', rej); ws.end(res); });
  const st = await fsp.stat(out);
  return { out, frames: nFrames, bytes: st.size, W, H, fps, origin: org, cfg };
}

module.exports = { renderSparkSegment, DEFAULTS, tempColor };
