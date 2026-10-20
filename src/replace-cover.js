'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { muxCover } = require('./mux');
const { smartReplace } = require('./smart-replace');

// 独立入口，不读取项目预设或全局加工配置；校验通过后才发布产物。
async function replaceCover({ video, cover, out, onEvent = () => {} }) {
  video = await fs.realpath(path.resolve(video));
  cover = await fs.realpath(path.resolve(cover));
  out = path.resolve(out || path.join(path.dirname(video), `${path.parse(video).name}_换封面.mp4`));
  if (path.extname(out).toLowerCase() !== '.mp4') throw new Error('输出文件请使用 .mp4 扩展名');
  try {
    await fs.lstat(out);
    throw new Error(`输出已存在，请另选文件名: ${out}`);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await fs.mkdir(path.dirname(out), { recursive: true });
  // 硬链接发布可原子地拒绝覆盖已有文件（包括片源及其软/硬链接）。
  const dir = await fs.mkdtemp(path.join(path.dirname(out), '.ectool-replace-'));
  try {
    const temp = path.join(dir, 'result.mp4');
    const started = performance.now();
    let result;
    try {
      result = await smartReplace({ video, cover, out: temp, dir });
    } catch (e) {
      const reason = e.message.split('\n')[0];
      onEvent({ status: 'fallback', reason });
      result = await muxCover({ video, coverPng: cover, out: temp,
        opts: { replaceFirstFrame: true } });
      result.log.unshift(`快速拼接不可用，已整体重编码：${reason}`);
    }
    result.ms = Math.round(performance.now() - started);
    try { await fs.link(temp, out); }
    catch (e) {
      if (e.code === 'EEXIST') throw new Error(`输出已存在，请另选文件名: ${out}`);
      throw e;
    }
    return { ...result, out };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
async function replaceFolder({ folder, out, onEvent = () => {} }) {
  folder = await fs.realpath(path.resolve(folder));
  const entries = (await fs.readdir(folder, { withFileTypes: true }))
    .filter(e => e.isFile() && !e.name.startsWith('.'));
  const covers = entries.filter(e => /\.(jpe?g|png|webp)$/i.test(e.name));
  if (covers.length !== 1) throw new Error(`文件夹内需要恰好一张新封面图片，当前找到 ${covers.length} 张（支持 JPG/PNG/WebP）`);
  const videos = entries.filter(e => /\.(mp4|mov|m4v)$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }));
  if (!videos.length) throw new Error('文件夹内没有视频（支持 MP4/MOV/M4V）');
  out = path.resolve(out || path.join(folder, '换封面结果'));
  const names = videos.map(e => `${path.parse(e.name).name}.mp4`);
  if (new Set(names.map(n => n.toLowerCase())).size !== names.length) throw new Error('视频输出文件名重复，请先调整同名视频');
  const cover = path.join(folder, covers[0].name);
  onEvent({ status: 'start', cover, out, total: videos.length });
  const results = [];
  for (const [index, entry] of videos.entries()) {
    const target = path.join(out, names[index]);
    onEvent({ status: 'processing', file: entry.name, index: index + 1, total: videos.length });
    try {
      const r = await replaceCover({ video: path.join(folder, entry.name), cover, out: target,
        onEvent: e => onEvent({ ...e, file: entry.name, index: index + 1, total: videos.length }) });
      results.push({ file: entry.name, out: target, status: 'ok', mode: r.mode,
        reencodedSeconds: r.reencodedSeconds, ms: r.ms, log: r.log });
    } catch (e) {
      results.push({ file: entry.name, out: target, status: 'failed', error: e.message });
    }
    onEvent({ ...results.at(-1), index: index + 1, total: videos.length });
  }
  return { cover, out, results };
}
module.exports = { replaceCover, replaceFolder };
