'use strict';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { ff, probeJson } = require('./ffmpeg');
const { renderSparkSegment } = require('./sparks');

// 仓库自带的星火序列（63 张 500x500 黑底 PNG），随代码分发，换机无需配置
const BUNDLED_SPARKS = path.join(__dirname, '..', 'assets', 'sparks');

// B「大而散」—— 用户选定的风格
const SPARK_PRESET_B = {
  count: 190, speed: 1000, gravity: 700, drag: 1.1,
  glow: 2.4, size: [1.6, 4.2], flashRadius: 0.5,
};

const DEFAULTS = {
  freezeDuration: 1.0,
  trimBlackTail: true,
  blackThreshold: 20,     // YAVG 阈值，<= 视为黑帧
  maxTrimSeconds: 2.0,    // 黑尾裁剪上限，防止异常素材被切掉一大段
  scanSeconds: 3.0,
  sfxTargetPeakDb: -1.5,  // 音效按真实浮点峰值归一化到这个电平（不用 alimiter，它拦不住瞬态）
  sparkOrigin: null,      // 默认画面中心偏上
  sparkSource: 'sequence',    // 'procedural' | 'sequence'（默认用自带序列，改 procedural 走程序化粒子）
  spark: SPARK_PRESET_B,
  // sequence 模式：逐帧 PNG 序列，默认取仓库自带的那套
  sparkSequence: {
    dir: BUNDLED_SPARKS,  // 序列所在目录，可指向任意黑底 PNG 序列
    prefix: 'a',          // 文件名前缀，形如 a0.png
    ext: 'png',
    scale: 1.6,           // 相对画面宽度的缩放倍数
    blend: 'screen',      // 黑底素材用 screen；带 alpha 的用 over
    fitToFreeze: true,    // 把整段序列压进定格时长
  },
};

// 取尾部若干秒的逐帧平均亮度
async function tailBrightness(file, seconds) {
  const { stderr } = await ff(['-sseof', `-${seconds}`, '-i', file,
    '-vf', 'scale=32:32,signalstats,metadata=print:key=lavfi.signalstats.YAVG',
    '-f', 'null', '-']);
  return [...stderr.matchAll(/YAVG=([0-9.]+)/g)].map(m => Number(m[1]));
}

// 尾部连续黑帧的时长
async function blackTailSeconds(file, fps, cfg) {
  const vals = await tailBrightness(file, cfg.scanSeconds);
  if (!vals.length) return { seconds: 0, frames: 0, freezeY: null, capped: false };
  let n = 0;
  for (let i = vals.length - 1; i >= 0; i--) {
    if (vals[i] <= cfg.blackThreshold) n++; else break;
  }
  const raw = n / fps;
  const capped = raw > cfg.maxTrimSeconds;
  const seconds = capped ? cfg.maxTrimSeconds : raw;
  const keptIdx = vals.length - 1 - Math.round(seconds * fps);
  return {
    seconds, frames: Math.round(seconds * fps), capped,
    freezeY: keptIdx >= 0 ? vals[keptIdx] : vals[0],
  };
}

// 真实浮点峰值。volumedetect 在整型格式上测，读数会偏低约 2dB，不能用来算增益
async function measurePeak(file) {
  const { stdout } = await ff(['-i', file, '-ac', '1', '-f', 'f32le', '-']);
  const n = Math.floor(stdout.length / 4);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(stdout.readFloatLE(i * 4));
    if (v > m) m = v;
  }
  return { linear: m, db: m > 0 ? 20 * Math.log10(m) : -Infinity };
}

async function audioDuration(file) {
  const j = await probeJson(['-select_streams', 'a:0', '-show_entries', 'stream=duration', file]);
  return Number(j.streams?.[0]?.duration) || null;
}

// 准备片尾：算裁剪点、抽定格帧、生成星火帧流
async function prepareOutro({ info, cfg }) {
  const c = { ...DEFAULTS, ...cfg, spark: { ...SPARK_PRESET_B, ...(cfg.spark || {}) } };
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ectool-outro-'));

  const black = c.trimBlackTail
    ? await blackTailSeconds(info.file, info.fps, c)
    : { seconds: 0, frames: 0, freezeY: null, capped: false };

  const srcDur = info.duration;
  const keepDuration = Math.max(1 / info.fps, srcDur - black.seconds);

  // 定格帧 = 保留部分的最后一帧
  const freezePng = path.join(dir, 'freeze.png');
  const at = Math.max(0, keepDuration - 1 / info.fps);
  await ff(['-ss', at.toFixed(4), '-i', info.file, '-frames:v', '1', '-update', '1',
    '-q:v', '2', freezePng]);

  const origin = c.sparkOrigin || { x: info.frameW / 2, y: info.frameH * 0.45 };
  let sparkRaw = null, sparkSeq = null, freezeFrames;

  if (c.sparkSource === 'sequence') {
    const sq = { ...DEFAULTS.sparkSequence, ...(c.sparkSequence || {}) };
    if (!sq.dir) throw new Error('sparkSource=sequence 时必须提供 sparkSequence.dir');
    if (!fs.existsSync(sq.dir)) {
      throw new Error(sq.dir === BUNDLED_SPARKS
        ? `自带星火素材缺失: ${sq.dir}（仓库没拉全？改 outro.sparkSource 为 "procedural" 可用内置粒子）`
        : `星火序列目录不存在: ${sq.dir}`);
    }
    const re = new RegExp(`^${sq.prefix}(\\d+)\\.${sq.ext}$`);
    const nums = fs.readdirSync(sq.dir).map(n => re.exec(n)).filter(Boolean).map(m => Number(m[1]));
    if (!nums.length) throw new Error(`目录里找不到 ${sq.prefix}N.${sq.ext} 序列: ${sq.dir}`);
    const start = Math.min(...nums), count = nums.length;
    const probe = await probeJson(['-show_entries', 'stream=width,height',
      path.join(sq.dir, `${sq.prefix}${start}.${sq.ext}`)]);
    const src = probe.streams?.[0] || {};
    sparkSeq = {
      pattern: path.join(sq.dir, `${sq.prefix}%d.${sq.ext}`),
      startNumber: start, count,
      srcW: src.width, srcH: src.height,
      // 让整段序列铺满定格时长
      inputFps: sq.fitToFreeze ? count / c.freezeDuration : info.fps,
      drawW: Math.round(info.frameW * sq.scale),
      blend: sq.blend, scale: sq.scale,
    };
    sparkSeq.drawH = Math.round(sparkSeq.drawW * (src.height / src.width));
    sparkSeq.x = Math.round(origin.x - sparkSeq.drawW / 2);
    sparkSeq.y = Math.round(origin.y - sparkSeq.drawH / 2);
    freezeFrames = Math.max(1, Math.round(info.fps * c.freezeDuration));
  } else {
    sparkRaw = path.join(dir, 'spark.raw');
    const spark = await renderSparkSegment({
      baseImage: freezePng, out: sparkRaw,
      W: info.frameW, H: info.frameH, fps: info.fps,
      duration: c.freezeDuration, origin, options: c.spark,
    });
    freezeFrames = spark.frames;
  }

  let sfx = null;
  if (c.sfxPath) {
    const pk = await measurePeak(c.sfxPath);
    sfx = {
      path: c.sfxPath,
      duration: await audioDuration(c.sfxPath),
      peakDb: pk.db,
      gainDb: Number((c.sfxTargetPeakDb - pk.db).toFixed(2)),
      targetPeakDb: c.sfxTargetPeakDb,
    };
  }

  return {
    dir, cfg: c, sparkRaw, sparkSeq, freezePng, origin,
    keepDuration, trim: black,
    freezeDuration: c.freezeDuration,
    freezeFrames,
    sfx,
    cleanup: () => fsp.rm(dir, { recursive: true, force: true }),
  };
}

module.exports = { prepareOutro, blackTailSeconds, tailBrightness, measurePeak, DEFAULTS, SPARK_PRESET_B };
