'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { ff, probeJson } = require('./ffmpeg');
const { probeVideo } = require('./probe');
const { coverChain, verify } = require('./mux');

const PROFILE = { High: 'high', Main: 'main', Baseline: 'baseline', 'Constrained Baseline': 'baseline' };
const packets = async file => (await probeJson(['-select_streams', 'v:0', '-show_packets',
  '-show_entries', 'packet=pts_time,dts_time,duration_time', file])).packets || [];
const hash = async (file, args) => (await ff(['-v', 'error', ...args.pre || [], '-i', file,
  ...args.post, '-f', 'hash', '-hash', 'sha256', '-'])).stdout.toString().trim();

function nalTypes(buffer) {
  const types = [];
  for (let i = 0; i + 3 < buffer.length; i++) {
    if (buffer[i] === 0 && buffer[i + 1] === 0 && buffer[i + 2] === 1) types.push(buffer[i + 3] & 31);
  }
  return types;
}

// Conservative first version: closed H.264 GOPs without frame reordering only.
// Never silently truncate a GOP, move audio, or accept a changed copied tail.
async function smartReplace({ video, cover, out, dir }) {
  const info = await probeVideo(video);
  const j = await probeJson(['-select_streams', 'v:0', '-show_streams', video]);
  const stream = j.streams[0];
  if (info.vCodec !== 'h264' || stream.has_b_frames !== 0 || info.rotation !== 0
      || Math.abs(info.startTime) > 0.000001 || info.pixFmt !== 'yuv420p' || !PROFILE[info.profile]) {
    throw new Error('快速拼接暂不支持此片源的编码、B 帧、旋转或起始偏移');
  }
  const timebase = Number(info.timeBase.split('/')[1]);
  if (info.timeBase.split('/')[0] !== '1' || !Number.isInteger(timebase) || timebase <= 0 || !info.nbFrames) throw new Error('片源缺少可靠的时间基准或帧数');
  const scan = await probeJson(['-select_streams', 'v:0', '-read_intervals', '%+10',
    '-show_packets', '-show_entries', 'packet=pts,pts_time,dts_time,flags', video]);
  const ps = scan.packets || [];
  const index = ps.findIndex((p, i) => i > 0 && p.flags?.includes('K'));
  if (index < 1) throw new Error('前 10 秒没有可用的后续关键帧');
  const cut = Number(ps[index].pts) / timebase;
  const tolerance = Math.max(0.000002, 1 / timebase);
  if (cut <= 0 || Math.abs(cut - index / info.fps) > tolerance
      || ps.some((p, i) => Math.abs(Number(p.pts_time) - i / info.fps) > tolerance
        || Math.abs(Number(p.pts_time) - Number(p.dts_time)) > tolerance)) {
    throw new Error('片源不是无重排序的固定帧率时间线');
  }
  const head = path.join(dir, 'head.mp4'), tail = path.join(dir, 'tail.mp4');
  await ff(['-ss', cut.toFixed(9), '-i', video, '-map', '0:v:0', '-an', '-c:v', 'copy',
    '-avoid_negative_ts', 'make_zero', '-video_track_timescale', String(timebase), tail]);
  const first = await ff(['-i', tail, '-map', '0:v:0', '-frames:v', '1', '-c:v', 'copy',
    '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', '-']);
  if (!nalTypes(first.stdout).includes(5)) throw new Error('拼接点不是可独立解码的 IDR 帧');

  const graph = [`[0:v]${coverChain(info)}[c]`];
  if (index > 1) {
    graph.push(`[1:v]trim=start_frame=1:end_frame=${index},setpts=PTS-STARTPTS,setsar=${info.sarStr},format=${info.pixFmt}[v]`,
      '[c][v]concat=n=2:v=1:a=0[h]');
  } else graph.push('[c]null[h]');
  const colors = [];
  for (const [key, option] of [['color_range', '-color_range'], ['color_space', '-colorspace'],
    ['color_transfer', '-color_trc'], ['color_primaries', '-color_primaries']]) {
    if (stream[key] && stream[key] !== 'unknown') colors.push(option, stream[key]);
  }
  await ff(['-loop', '1', '-framerate', info.fpsStr, '-t', String(1 / info.fps), '-i', cover,
    '-i', video, '-filter_complex', graph.join(';'), '-map', '[h]', '-an',
    '-frames:v', String(index), '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-bf', '0',
    '-profile:v', PROFILE[info.profile], ...(info.level ? ['-level:v', String(info.level / 10)] : []),
    '-pix_fmt', info.pixFmt, ...colors, '-video_track_timescale', String(timebase), head]);
  // Relative, fixed names avoid path escaping issues in the concat script.
  const list = path.join(dir, 'join.txt');
  await fs.writeFile(list, `ffconcat version 1.0\nfile head.mp4\nduration ${cut.toFixed(9)}\nfile tail.mp4\n`);
  const joined = await ff(['-f', 'concat', '-safe', '0', '-i', list, '-i', video,
    '-map', '0:v:0', '-map', '1:a?', '-c', 'copy', '-map_metadata', '1', '-map_chapters', '-1',
    '-video_track_timescale', String(timebase), '-movflags', '+faststart', out]);
  if (/non.monoton|invalid|corrupt|error/i.test(joined.stderr)) throw new Error('拼接出现解码或时间戳警告');
  const v = await verify({ info, coverPng: cover, out, coverDuration: 1 / info.fps,
    expect: { frameDelta: 0, durationDelta: 0, hasAudio: info.hasAudio } });
  if (!v.ok) throw new Error(v.problems.join('；'));

  // Check the complete packet timeline, not just container duration or the seam.
  const [before, after] = await Promise.all([packets(video), packets(out)]);
  if (before.length !== after.length || before.length !== info.nbFrames
      || before.some((p, i) => ['pts_time', 'dts_time', 'duration_time']
        .some(k => !Number.isFinite(Number(p[k])) || !Number.isFinite(Number(after[i][k]))
          || Math.abs(Number(p[k]) - Number(after[i][k])) > tolerance))) {
    throw new Error('拼接改变了视频包数量或时间戳');
  }
  // Ignore only transport parameter-set/AUD NALs; every copied picture must match.
  const tailArgs = { pre: ['-ss', cut.toFixed(9)], post: ['-map', '0:v:0', '-c:v', 'copy',
    '-bsf:v', 'h264_mp4toannexb,filter_units=remove_types=7|8|9'] };
  const [a, b] = await Promise.all([hash(video, tailArgs), hash(out, tailArgs)]);
  if (a !== b) throw new Error('后段视频压缩数据未保持一致');
  if (info.hasAudio) {
    const audio = { post: ['-map', '0:a', '-c:a', 'copy'] };
    const [a, b] = await Promise.all([hash(video, audio), hash(out, audio)]);
    if (a !== b) throw new Error('原音频数据未保持一致');
    const audioPackets = async file => (await probeJson(['-select_streams', 'a', '-show_packets',
      '-show_entries', 'packet=stream_index,pts_time,dts_time,duration_time', file])).packets || [];
    const [aPackets, bPackets] = await Promise.all([audioPackets(video), audioPackets(out)]);
    if (aPackets.length !== bPackets.length || aPackets.some((p, i) => ['pts_time', 'dts_time', 'duration_time']
      .some(k => !Number.isFinite(Number(p[k])) || Math.abs(Number(p[k]) - Number(bPackets[i][k])) > 0.000002))) {
      throw new Error('原音频时间戳发生变化');
    }
  }
  // Sequential decoding across the SPS switch catches seams that a fresh seek hides.
  const seamArgs = ['-v', 'error', '-xerror', '-i', out, '-an', '-vf',
    `select=gte(n\\,${index})`, '-frames:v', '6', '-f', 'framemd5', '-'];
  const seam = (await ff(seamArgs)).stdout.toString().split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(',').at(-1).trim());
  const reference = (await ff(['-v', 'error', '-xerror', '-ss', cut.toFixed(9), '-i', video,
    '-an', '-frames:v', '6', '-f', 'framemd5', '-'])).stdout.toString().split('\n')
    .filter(l => l && !l.startsWith('#')).map(l => l.split(',').at(-1).trim());
  if (!seam.length || JSON.stringify(seam) !== JSON.stringify(reference)) throw new Error('接缝后解码画面与原片不一致');
  return { mode: 'smart', info, verify: v, reencodedSeconds: cut, reencodedFrames: index, log: [] };
}
module.exports = { smartReplace };
