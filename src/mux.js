'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ff, filter } = require('./ffmpeg');
const { probeVideo, firstFrameInfo, firstPacketDuration } = require('./probe');

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'ectool-mux-'));

// 把封面图整形成与视频分支逐像素兼容的帧：
// 先按「显示宽高比」cover-fit 裁切，再压回编码尺寸并贴上原 SAR
function coverChain(info, fmt) {
  const { frameW: FW, frameH: FH, displayW: DW, displayH: DH, sarStr, pixFmt } = info;
  const outFmt = fmt || pixFmt;
  const parts = [
    `scale=${DW}:${DH}:force_original_aspect_ratio=increase`,
    `crop=${DW}:${DH}`,
  ];
  if (DW !== FW || DH !== FH) parts.push(`scale=${FW}:${FH}`);
  parts.push(`setsar=${sarStr}`, `format=${outFmt}`);
  return parts.join(',');
}


// 源片分支：可选烧入字幕。在 yuv444p 上渲染再降回 420，文字边缘比直接在 420 上画干净
function sourceChain(info, subs) {
  const parts = [`setsar=${info.sarStr}`];
  if (subs) {
    parts.push('format=yuv444p',
      filter('ass', { filename: subs.assPath, fontsdir: subs.fontsdir || undefined }));
  }
  parts.push(`format=${info.pixFmt}`);
  return parts.join(',');
}

const timescaleOf = info => {
  const [, den] = String(info.timeBase || '1/12800').split('/').map(Number);
  return Number.isFinite(den) && den > 0 ? den : 12800;
};

function videoEncoderArgs(info, opts) {
  const enc = opts.encoder || (info.vCodec === 'hevc' ? 'hevc_videotoolbox' : 'h264_videotoolbox');
  const args = ['-c:v', enc];
  if (/videotoolbox/.test(enc)) {
    // VideoToolbox 没有 CRF，按源码率上浮 10%，并给个下限
    const br = opts.bitrate || Math.max(2_000_000, Math.round((info.bitrate || 4_000_000) * 1.1));
    args.push('-b:v', String(br));
    if (enc.startsWith('h264')) args.push('-profile:v', 'high');
  } else if (/libx26[45]/.test(enc)) {
    args.push('-preset', opts.preset || 'veryfast', '-crf', String(opts.crf ?? 20));
  }
  return args;
}

// ---------- Path B：整体重编码（稳） ----------
async function muxReencode({ info, coverPng, out, opts }) {
  const D = opts.coverDuration;
  const audioMode = info.hasAudio ? (opts.audioMode || 'shift') : 'none';

  const args = ['-loop', '1', '-framerate', info.fpsStr, '-t', String(D), '-i', coverPng,
                '-i', info.file];
  // shift：把同一文件再开一次并整体后移 D，音频就能保持 stream copy 且不失同步
  if (audioMode === 'shift') args.push('-itsoffset', String(D), '-i', info.file);

  const fc = [
    `[0:v]${coverChain(info)}[c]`,
    `[1:v]${sourceChain(info, opts.subs)}[v]`,
    `[c][v]concat=n=2:v=1:a=0[outv]`,
  ];
  const maps = ['-map', '[outv]'];
  const acodec = [];
  if (audioMode === 'shift') {
    maps.push('-map', '2:a:0');
    acodec.push('-c:a', 'copy');
  } else if (audioMode === 'reencode') {
    fc.push(`[1:a]adelay=${Math.round(D * 1000)}:all=1[outa]`);
    maps.push('-map', '[outa]');
    acodec.push('-c:a', 'aac', '-b:a', String(info.audio?.bitrate || 128000));
  } else if (audioMode === 'nodelay') {
    maps.push('-map', '1:a:0');
    acodec.push('-c:a', 'copy');
  }

  args.push('-filter_complex', fc.join(';'), ...maps,
    ...videoEncoderArgs(info, opts), ...acodec,
    '-map_metadata', '1', '-map_chapters', '-1',
    '-video_track_timescale', String(timescaleOf(info)),
    '-movflags', '+faststart', out);
  await ff(args);
}

// ---------- Path B + 片尾：封面帧 + 原片(裁黑尾) + 定格星火段，音频混入「咚」 ----------
async function muxReencodeWithOutro({ info, coverPng, out, opts, outro }) {
  const D = opts.coverDuration;
  const KEEP = outro.keepDuration;
  const FREEZE = outro.freezeDuration;
  const TOTAL = D + KEEP + FREEZE;
  const coverMs = Math.round(D * 1000);
  const sfxMs = Math.round((D + KEEP) * 1000);

  const seq = outro.sparkSeq;
  const args = [
    '-loop', '1', '-framerate', info.fpsStr, '-t', String(D), '-i', coverPng,
    '-t', KEEP.toFixed(4), '-i', info.file,
  ];
  if (seq) {
    // 定格底图 + 外部序列帧（黑底素材用 screen 叠加）
    args.push('-loop', '1', '-framerate', info.fpsStr, '-t', String(FREEZE), '-i', outro.freezePng,
      '-framerate', seq.inputFps.toFixed(6), '-start_number', String(seq.startNumber), '-i', seq.pattern);
  } else {
    args.push('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${info.frameW}x${info.frameH}`,
      '-r', info.fpsStr, '-i', outro.sparkRaw);
  }
  const sfxIdx = seq ? 4 : 3;
  if (outro.sfx) args.push('-i', outro.sfx.path);
  // BGM 比正片短时要循环，用 -stream_loop 而不是 aloop
  const bgm = opts.bgm || null;
  const bgmIdx = sfxIdx + (outro.sfx ? 1 : 0);
  if (bgm) args.push('-stream_loop', '-1', '-i', bgm.file);

  const fc = [
    `[0:v]${coverChain(info)}[c]`,
    `[1:v]${sourceChain(info, opts.subs)}[v]`,
  ];
  if (seq) {
    fc.push(
      // 混合模式必须在 RGB 空间做：在 yuv420p 上 screen 会把色度平面也推满 -> 整片洋红
      `[2:v]${coverChain(info, 'gbrp')}[fz]`,
      `color=black:s=${info.frameW}x${info.frameH}:r=${info.fpsStr}:d=${FREEZE},format=gbrp[bg]`,
      `[3:v]fps=${info.fpsStr},scale=${seq.drawW}:${seq.drawH},format=gbrp[sp]`,
      `[bg][sp]overlay=x=${seq.x}:y=${seq.y}:eof_action=pass:shortest=1,format=gbrp[sk]`,
      `[fz][sk]blend=all_mode=${seq.blend}:shortest=1,format=${info.pixFmt},setsar=${info.sarStr}[s]`,
    );
  } else {
    fc.push(`[2:v]setsar=${info.sarStr},format=${info.pixFmt}[s]`);
  }
  fc.push(`[c][v][s]concat=n=3:v=1:a=0[outv]`);
  const maps = ['-map', '[outv]'];
  const acodec = [];

  const tail = `atrim=end=${TOTAL.toFixed(4)},afade=t=out:st=${Math.max(0, TOTAL - 0.06).toFixed(4)}:d=0.06`;
  const sfxChain = outro.sfx
    ? `[${sfxIdx}:a]volume=${outro.sfx.gainDb}dB,adelay=${sfxMs}:all=1[sx]`
    : null;

  if (info.hasAudio && bgm) {
    // 正片音频一路进混音、一路当侧链触发源
    fc.push(`[1:a]adelay=${coverMs}:all=1,asplit=2[a1][sc]`);
    const fi = bgm.fadeIn > 0 ? `,afade=t=in:st=0:d=${bgm.fadeIn}` : '';
    const foSt = Math.max(0, KEEP - (bgm.fadeOut || 0));
    const fo = bgm.fadeOut > 0 ? `,afade=t=out:st=${foSt.toFixed(3)}:d=${bgm.fadeOut}` : '';
    fc.push(`[${bgmIdx}:a]atrim=0:${KEEP.toFixed(3)},asetpts=N/SR/TB,`
      + `volume=${bgm.gainDb}dB${fi}${fo},adelay=${coverMs}:all=1[bg0]`);
    if (bgm.duck && bgm.duck.enabled) {
      const d = bgm.duck;
      fc.push(`[bg0][sc]sidechaincompress=threshold=${d.threshold}:ratio=${d.ratio}`
        + `:attack=${d.attack}:release=${d.release}:makeup=${d.makeup ?? 1}[bgd]`);
    } else {
      fc.push('[bg0]anull[bgd]', '[sc]anullsink');
    }
    const parts = ['[a1]', '[bgd]'];
    if (outro.sfx) { fc.push(sfxChain); parts.push('[sx]'); }
    fc.push(`${parts.join('')}amix=inputs=${parts.length}:duration=longest:normalize=0,${tail}[outa]`);
  } else if (info.hasAudio && outro.sfx) {
    fc.push(`[1:a]adelay=${coverMs}:all=1[a1]`, sfxChain,
      `[a1][sx]amix=inputs=2:duration=longest:normalize=0,${tail}[outa]`);
  } else if (info.hasAudio) {
    fc.push(`[1:a]adelay=${coverMs}:all=1,apad,${tail}[outa]`);
  } else if (outro.sfx) {
    fc.push(sfxChain, `[sx]${tail}[outa]`);
  }
  if (info.hasAudio || outro.sfx) {
    maps.push('-map', '[outa]');
    acodec.push('-c:a', 'aac', '-b:a', String(Math.max(128000, info.audio?.bitrate || 128000)),
      '-ar', String(info.audio?.sampleRate || 44100));
  }

  args.push('-filter_complex', fc.filter(Boolean).join(';'), ...maps,
    ...videoEncoderArgs(info, opts), ...acodec,
    '-map_metadata', '1', '-map_chapters', '-1',
    '-video_track_timescale', String(timescaleOf(info)),
    '-movflags', '+faststart', out);
  await ff(args);
}

// ---------- Path A：编 1 帧同参数片段 + 流拷贝拼接（快） ----------
const PROFILE_MAP = {
  'High': 'high', 'Main': 'main', 'Baseline': 'baseline',
  'Constrained Baseline': 'baseline', 'High 10': 'high10', 'High 4:2:2': 'high422',
};

async function muxCopy({ info, coverPng, out, opts }) {
  const D = opts.coverDuration;
  const enc = { h264: 'libx264', hevc: 'libx265' }[info.vCodec];
  if (!enc) throw new Error(`Path A 不支持源编码 ${info.vCodec}`);
  // concat 复用第一段的容器头且会丢弃旋转矩阵，导致流内分辨率突变 —— 交给 Path B
  if (info.rotation !== 0) {
    throw new Error(`Path A 不支持带旋转矩阵的源（rotation=${info.rotation}）`);
  }
  // 视频流起始偏移非零（edit list）时，concat demuxer 重整时间戳会把封面帧压成 1 tick
  if (Math.abs(info.startTime) > 0.001) {
    throw new Error(`Path A 不支持起始偏移非零的源（start_time=${info.startTime}）`);
  }
  if (info.hasAudio && info.audio.codec !== 'aac') {
    throw new Error(`Path A 仅支持 aac 音轨，源为 ${info.audio.codec}`);
  }

  const dir = await tmpDir();
  try {
    const seg = path.join(dir, 'seg.mp4');
    const build = withLevel => {
      const a = ['-loop', '1', '-framerate', info.fpsStr, '-t', String(D), '-i', coverPng];
      if (info.hasAudio) {
        a.push('-f', 'lavfi', '-t', String(D),
          '-i', `anullsrc=r=${info.audio.sampleRate}:cl=${info.audio.channelLayout}`);
      }
      a.push('-vf', coverChain(info), '-c:v', enc, '-pix_fmt', info.pixFmt);
      if (enc === 'libx264') {
        a.push('-x264-params', 'keyint=1:scenecut=0:open-gop=0');
        const p = PROFILE_MAP[info.profile];
        if (p) a.push('-profile:v', p);
        if (withLevel && info.level) a.push('-level:v', (info.level / 10).toFixed(1));
      } else {
        a.push('-x265-params', 'keyint=1:scenecut=0');
      }
      if (info.hasAudio) {
        a.push('-c:a', 'aac', '-ar', String(info.audio.sampleRate),
          '-ac', String(info.audio.channels), '-b:a', String(info.audio.bitrate));
      }
      a.push('-video_track_timescale', String(timescaleOf(info)), '-movflags', '+faststart', seg);
      return a;
    };
    try { await ff(build(true)); } catch { await ff(build(false)); }

    const list = path.join(dir, 'list.txt');
    const q = f => `file '${path.resolve(f).replace(/'/g, "'\\\\''")}'`;
    await fs.writeFile(list, [q(seg), q(info.file)].join('\n') + '\n', 'utf8');
    await ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy',
      '-movflags', '+faststart', out]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---------- 把封面同时写进容器封面原子（很多平台读这个而不是首帧） ----------
async function addAttachedPic(file, coverPng) {
  const dir = await tmpDir();
  try {
    const jpg = path.join(dir, 'cover.jpg');
    await ff(['-i', coverPng, '-frames:v', '1', '-q:v', '2', jpg]);
    const tmp = path.join(dir, 'out' + path.extname(file));
    await ff(['-i', file, '-i', jpg, '-map', '0', '-map', '1', '-c', 'copy',
      '-disposition:v:1', 'attached_pic', '-movflags', '+faststart', tmp]);
    await fs.copyFile(tmp, file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---------- 校验 ----------
// 逐帧真实解码尺寸（-noautorotate 才能看到编码帧本身）
async function frameDims(file, count = 6) {
  const { stderr } = await ff(['-noautorotate', '-i', file, '-vf', 'showinfo',
    '-frames:v', String(count), '-f', 'null', '-']);
  return [...stderr.matchAll(/n: *\d+ pts[^\n]*? s:(\d+x\d+)/g)].map(m => m[1]);
}

async function signature(file, vf, at = null) {
  const pre = at != null ? ['-ss', at.toFixed(3)] : [];
  const { stdout } = await ff([...pre, '-i', file, '-frames:v', '1', '-vf', vf,
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  return [...stdout];
}
const meanAbsDiff = (a, b) => {
  if (!a.length || a.length !== b.length) return 255;
  return a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
};

async function verify({ info, coverPng, out, coverDuration, expect = null }) {
  const problems = [];
  const notes = [];
  const o = await probeVideo(out);
  const wantFrameDelta = expect ? expect.frameDelta : 1;
  const wantDurDelta = expect ? expect.durationDelta : coverDuration;
  const wantAudio = expect ? expect.hasAudio : info.hasAudio;
  const durTol = expect ? Math.max(0.09, coverDuration * 1.5) : Math.max(0.09, coverDuration * 1.5);

  if (o.frameW !== info.frameW || o.frameH !== info.frameH) {
    problems.push(`尺寸不符：${o.frameW}x${o.frameH} ≠ ${info.frameW}x${info.frameH}`);
  }
  if (o.sarStr !== info.sarStr) problems.push(`SAR 不符：${o.sarStr} ≠ ${info.sarStr}`);
  if (info.nbFrames && o.nbFrames && o.nbFrames !== info.nbFrames + wantFrameDelta) {
    problems.push(`帧数应为 ${info.nbFrames + wantFrameDelta}，实际 ${o.nbFrames}`);
  }
  if (info.duration && o.duration) {
    const delta = o.duration - info.duration;
    if (Math.abs(delta - wantDurDelta) > durTol) {
      problems.push(`时长增量 ${delta.toFixed(3)}s 偏离预期 ${wantDurDelta.toFixed(3)}s`);
    }
  }
  if (wantAudio !== o.hasAudio) problems.push(wantAudio ? '音轨丢失' : '意外多出音轨');

  const fr = await firstFrameInfo(out);
  if (fr && Number(fr.key_frame) !== 1) problems.push('首帧不是关键帧');

  // 拼接参数不匹配的典型症状：容器头正常，但流内分辨率中途突变
  const dims = await frameDims(out, 6);
  const uniq = [...new Set(dims)];
  if (uniq.length > 1) {
    problems.push(`流内分辨率不一致：${uniq.join(' / ')}（拼接参数不匹配）`);
  } else if (uniq.length === 1 && uniq[0] !== `${o.codedW}x${o.codedH}`) {
    problems.push(`容器头尺寸 ${o.codedW}x${o.codedH} 与实际编码帧 ${uniq[0]} 不符`);
  }

  // 封面帧必须真的占满预期时长。Path A 在带 edit list / B 帧负 DTS 的源上
  // 会产出 duration=1 tick 的退化首帧，容器头和帧数都正常，只有这里能发现
  const fpd = await firstPacketDuration(out);
  if (fpd != null && fpd < coverDuration * 0.5) {
    problems.push(`封面帧时长仅 ${(fpd * 1000).toFixed(2)}ms，预期约 ${(coverDuration * 1000).toFixed(1)}ms（拼接边界时间戳被压缩）`);
  }

  // libass 字体匹配失败是静默的（退出码仍 0，画面上却没有字）——必须实测像素
  if (expect && expect.subs) {
    const { probeTime, band = 0.32 } = expect.subs;
    const bh = Math.round(info.frameH * band);
    const crop = `crop=${info.frameW}:${bh}:0:${info.frameH - bh},scale=32:16`;
    try {
      const [a, b] = await Promise.all([
        signature(out, crop, coverDuration + probeTime),
        signature(info.file, crop, probeTime),
      ]);
      const d = meanAbsDiff(a, b);
      if (d < 2) problems.push(`字幕未渲染（字幕区像素差仅 ${d.toFixed(2)}/255，疑似字体未匹配）`);
    } catch (e) {
      problems.push(`字幕校验失败: ${e.message.split('\n')[0]}`);
    }
  }

  // BGM 静默失败查不出来，但不能依赖「存在安静空档」——字幕一密就没有空档了。
  // 改成在固定窗口上比响度差，并按预期增量自适应：预期太小就如实记为「无法校验」而不是判失败。
  if (expect && expect.bgm) {
    const { expectedDeltaDb, window } = expect.bgm;
    try {
      const lufs = async (f, at, dur) => {
        const { stderr } = await ff(['-ss', at.toFixed(3), '-t', String(dur), '-i', f,
          '-af', 'ebur128', '-f', 'null', '-']);
        const m = [...stderr.matchAll(/I:\s+(-?[\d.]+)\s+LUFS/g)].pop();
        return m ? Number(m[1]) : null;
      };
      const [src, got] = await Promise.all([
        lufs(info.file, window.start, window.dur),
        lufs(out, window.start + coverDuration, window.dur),
      ]);
      if (src != null && got != null) {
        const delta = got - src;
        if (expectedDeltaDb < 0.4) {
          notes.push(`BGM 电平过低（预期仅抬升 ${expectedDeltaDb.toFixed(2)} dB），无法通过响度差校验；实测 ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} dB`);
        } else if (delta < expectedDeltaDb * 0.5) {
          problems.push(`BGM 疑似未混入（窗口响度 ${src.toFixed(1)} -> ${got.toFixed(1)} LUFS，`
            + `实测 ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} dB，预期 +${expectedDeltaDb.toFixed(2)} dB）`);
        }
      }
    } catch (e) {
      notes.push(`BGM 校验未完成: ${e.message.split('\n')[0]}`);
    }
  }

  let diff = null;
  try {
    const [sc, so] = await Promise.all([
      signature(coverPng, `${coverChain(info)},scale=16:16`),
      signature(out, 'scale=16:16'),
    ]);
    diff = meanAbsDiff(sc, so);
    if (diff > 20) problems.push(`首帧内容与封面不一致（灰度平均差 ${diff.toFixed(1)}/255）`);
  } catch (e) {
    problems.push(`首帧比对失败: ${e.message.split('\n')[0]}`);
  }

  return { ok: problems.length === 0, problems, notes, outInfo: o, firstFrameDiff: diff };
}

// ---------- 调度：auto 先试 copy，校验不过自动回退 reencode ----------
async function muxCover({ video, coverPng, out, opts = {} }) {
  const info = opts.info || await probeVideo(video);
  const coverDuration = opts.coverDuration ?? (1 / info.fps);
  const o = { ...opts, coverDuration };
  const attempts = (opts.mode || 'auto') === 'auto' ? ['copy', 'reencode'] : [opts.mode];

  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  const outro = opts.outro || null;
  // 片尾必须重编码（要拼接定格段并混音），Path A 不适用
  // 字幕要烧进画面，Path A 的流拷贝不可能做到
  const plan = outro ? ['outro'] : (opts.subs ? ['reencode'] : attempts);
  const expect = (outro || opts.subs || opts.bgm) ? {
    frameDelta: outro ? 1 - Math.round(outro.trim.seconds * info.fps) + outro.freezeFrames : 1,
    durationDelta: outro ? coverDuration - outro.trim.seconds + outro.freezeDuration : coverDuration,
    hasAudio: info.hasAudio || !!(outro && outro.sfx),
    subs: opts.subs ? { probeTime: opts.subs.probeTime } : null,
    bgm: opts.bgm && opts.bgm.verify ? opts.bgm.verify : null,
  } : null;
  const log = [];
  for (const m of plan) {
    try {
      if (m === 'copy') await muxCopy({ info, coverPng, out, opts: o });
      else if (m === 'outro') await muxReencodeWithOutro({ info, coverPng, out, opts: o, outro });
      else await muxReencode({ info, coverPng, out, opts: o });
      const v = await verify({ info, coverPng, out, coverDuration, expect });
      if (v.ok) {
        if (opts.attachedPic) await addAttachedPic(out, coverPng);
        return { mode: m, info, verify: v, log };
      }
      log.push(`[${m}] 校验未通过：${v.problems.join('；')}`);
    } catch (e) {
      log.push(`[${m}] 执行失败：${e.message.split('\n').slice(0, 3).join(' / ')}`);
    }
  }
  // 所有路径都失败时必须清掉残留产物，否则会留下一个"看起来正常"的坏文件
  await fs.rm(out, { force: true }).catch(() => {});
  const err = new Error(`封面注入失败\n${log.map(l => '  ' + l).join('\n')}`);
  err.log = log;
  throw err;
}

module.exports = { muxCover, muxReencode, muxReencodeWithOutro, muxCopy, verify, coverChain, addAttachedPic, frameDims };
