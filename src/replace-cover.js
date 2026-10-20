'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { muxCover } = require('./mux');
const { smartReplace } = require('./smart-replace');
const { renderCover } = require('./cover');
const { detectEpisode, renderTemplate } = require('./episode');
const { startPicker, listFonts } = require('./picker');

// 独立入口，不读取项目预设或全局加工配置；校验通过后才发布产物。
async function replaceCover({ video, cover, out, lettering, onEvent = () => {} }) {
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
    let coverText;
    if (lettering) {
      const episode = lettering.episode ?? detectEpisode(video).episode;
      if (!Number.isInteger(episode) || episode < 0) throw new Error('无法从视频文件名识别集数，请用 EP01 或 第1集 等命名');
      coverText = renderTemplate(lettering.text.template, episode);
      const rendered = path.join(dir, 'numbered-cover.png');
      await renderCover({ master: cover, out: rendered, box: lettering.box,
        text: coverText, style: lettering.text, erase: { mode: 'none' } });
      cover = rendered;
    }
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
    return { ...result, out, coverText };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
async function inspectFolder(folder) {
  folder = await fs.realpath(path.resolve(folder));
  const entries = (await fs.readdir(folder, { withFileTypes: true }))
    .filter(e => e.isFile() && !e.name.startsWith('.'));
  const covers = entries.filter(e => /\.(jpe?g|png|webp)$/i.test(e.name));
  if (covers.length !== 1) throw new Error(`文件夹内需要恰好一张新封面图片，当前找到 ${covers.length} 张（支持 JPG/PNG/WebP）`);
  const videos = entries.filter(e => /\.(mp4|mov|m4v)$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }));
  if (!videos.length) throw new Error('文件夹内没有视频（支持 MP4/MOV/M4V）');
  const names = videos.map(e => `${path.parse(e.name).name}.mp4`);
  if (new Set(names.map(n => n.toLowerCase())).size !== names.length) throw new Error('视频输出文件名重复，请先调整同名视频');
  return { folder, cover: path.join(folder, covers[0].name), videos, names };
}

async function configureReplacement({ folder, port = 0, open = true, onReady = () => {} }) {
  const input = await inspectFolder(folder);
  const configPath = path.join(input.folder, '.ectool-cover.json');
  let saved = {};
  try { saved = JSON.parse(await fs.readFile(configPath, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const fonts = await listFonts();
  const font = fonts.find(f => f.name === 'Georgia Bold') || fonts[0];
  if (!font && !saved.text?.fontFile) throw new Error('未找到可用的 TTF 字体');
  const cfg = { master: input.cover,
    box: saved.box || { anchor: 'bottom-right', margin: { x: '4%', y: '2%' }, size: { w: '20%', h: '6%' } },
    text: { template: 'EP{n}', fontFile: font?.path, color: '0xF0D890', size: 'auto', fill: 0.88,
      align: 'center', valign: 'middle', strokeWidth: 2, strokeColor: '0x1a1030', ...saved.text },
    erase: { mode: 'none' } };
  const episode = input.videos.map(v => detectEpisode(v.name).episode).find(n => n != null) ?? 1;
  let resolveSelection;
  const selection = new Promise(resolve => { resolveSelection = resolve; });
  const picker = await startPicker({ cfg, configPath, port, open, episode, onSave: resolveSelection });
  onReady(picker.url);
  try { return await selection; }
  finally { await picker.close(); }
}

async function replaceFolder({ folder, out, lettering, onEvent = () => {} }) {
  const input = await inspectFolder(folder);
  const { cover, videos, names } = input;
  folder = input.folder;
  out = path.resolve(out || path.join(folder, '换封面结果'));
  onEvent({ status: 'start', cover, out, total: videos.length });
  const results = [];
  for (const [index, entry] of videos.entries()) {
    const target = path.join(out, names[index]);
    onEvent({ status: 'processing', file: entry.name, index: index + 1, total: videos.length });
    try {
      const r = await replaceCover({ video: path.join(folder, entry.name), cover, out: target, lettering,
        onEvent: e => onEvent({ ...e, file: entry.name, index: index + 1, total: videos.length }) });
      results.push({ file: entry.name, out: target, status: 'ok', mode: r.mode,
        reencodedSeconds: r.reencodedSeconds, ms: r.ms, log: r.log, coverText: r.coverText });
    } catch (e) {
      results.push({ file: entry.name, out: target, status: 'failed', error: e.message });
    }
    onEvent({ ...results.at(-1), index: index + 1, total: videos.length });
  }
  return { cover, out, results };
}
module.exports = { replaceCover, replaceFolder, configureReplacement };
