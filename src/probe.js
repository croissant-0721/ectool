'use strict';
const { probeJson } = require('./ffmpeg');

function ratio(str, fallback = 1) {
  if (!str || str === 'N/A') return fallback;
  const [a, b] = String(str).split(/[:/]/).map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !b || !a) return fallback;
  return a / b;
}

function sarString(v) {
  const s = v.sample_aspect_ratio;
  if (!s || s === 'N/A' || s.startsWith('0')) return '1/1';
  return s.replace(':', '/');
}

function parseFps(v) {
  for (const key of ['r_frame_rate', 'avg_frame_rate']) {
    const r = ratio(v[key], 0);
    if (r > 0 && Number.isFinite(r)) return r;
  }
  return 25;
}

// 旋转元数据：新版在 side_data_list.rotation，老版在 tags.rotate
function readRotation(v) {
  let deg = 0;
  const sd = (v.side_data_list || []).find(d => d.rotation !== undefined);
  if (sd) deg = Number(sd.rotation);
  else if (v.tags && v.tags.rotate !== undefined) deg = Number(v.tags.rotate);
  if (!Number.isFinite(deg)) deg = 0;
  return ((Math.round(deg) % 360) + 360) % 360;
}

async function probeVideo(file) {
  const j = await probeJson(['-show_streams', '-show_format', file]);
  const streams = j.streams || [];
  const v = streams.find(s => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  if (!v) throw new Error(`没有可用的视频流: ${file}`);
  const a = streams.find(s => s.codec_type === 'audio');

  const rotation = readRotation(v);
  // ffmpeg 默认 autorotate：滤镜链收到的帧已正立，±90° 时宽高互换
  const swap = rotation === 90 || rotation === 270;
  const frameW = swap ? v.height : v.width;
  const frameH = swap ? v.width : v.height;
  const sar = ratio(v.sample_aspect_ratio, 1);

  return {
    file,
    codedW: v.width, codedH: v.height,
    frameW, frameH,                                   // 滤镜链里的真实帧尺寸
    displayW: Math.round(frameW * sar), displayH: frameH, // 观感尺寸（方形像素）
    sar, sarStr: sarString(v),
    rotation,
    fps: parseFps(v),
    fpsStr: (v.r_frame_rate && v.r_frame_rate !== '0/0') ? v.r_frame_rate : '25/1',
    pixFmt: v.pix_fmt || 'yuv420p',
    vCodec: v.codec_name,
    profile: v.profile,
    level: v.level,
    nbFrames: Number(v.nb_frames) || null,
    duration: Number(v.duration ?? j.format?.duration) || null,
    bitrate: Number(v.bit_rate ?? j.format?.bit_rate) || null,
    timeBase: v.time_base || '1/12800',
    startTime: Number(v.start_time) || 0,
    hasAudio: !!a,
    audio: a ? {
      codec: a.codec_name,
      sampleRate: Number(a.sample_rate) || 48000,
      channels: a.channels || 2,
      channelLayout: a.channel_layout || (a.channels === 1 ? 'mono' : 'stereo'),
      bitrate: Number(a.bit_rate) || 128000,
    } : null,
  };
}

// 首个视频包的时长。封面帧被拼接边界压成 1 tick 时，只有这里能看出来
async function firstPacketDuration(file) {
  const j = await probeJson(['-select_streams', 'v:0', '-read_intervals', '%+#1',
    '-show_entries', 'packet=duration_time', file]);
  const pk = (j.packets || [])[0];
  const d = pk ? Number(pk.duration_time) : NaN;
  return Number.isFinite(d) ? d : null;
}

async function firstFrameInfo(file) {
  const j = await probeJson(['-select_streams', 'v:0', '-read_intervals', '%+#1',
    '-show_entries', 'frame=key_frame,pict_type,pts_time', file]);
  return (j.frames || [])[0] || null;
}

module.exports = { probeVideo, firstFrameInfo, firstPacketDuration, ratio };
