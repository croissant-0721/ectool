'use strict';
const fs = require('node:fs');
const path = require('node:path');

const VIDEO = /\.(mp4|mov|m4v|mkv)$/i;
const IMAGE = /\.(jpe?g|png|webp)$/i;
const SUB = /\.(srt|ass)$/i;
const AUDIO = /\.(mp3|wav|m4a|aac|flac)$/i;

const IS_BGM = n => /bgm|音乐|配乐/i.test(n);
const IS_SFX = n => /音效|sfx|咚|stinger/i.test(n);
const IS_COVER = n => /封面|cover|poster|竖版/i.test(n);
// 派生产物：我们自己出的片、或你在别处混好的版本，不能当原片再处理一遍
const IS_DERIVED = n => /混BGM|成片|已处理|_out(put)?\b|_done|_final(?![a-z])/i.test(n);

const OUT_DIRS = new Set(['成片', 'out', 'output', '_covers']);

// 递归扫描（跳过输出目录与隐藏目录），最多两层
function scan(root, depth = 0, acc = []) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (OUT_DIRS.has(e.name) || /_subtitles$/.test(e.name)) continue;
      if (depth < 2) scan(p, depth + 1, acc);
    } else if (e.isFile()) {
      acc.push(p);
    }
  }
  return acc;
}

// 把一个素材文件夹解析成完整配置，不需要手写 JSON
function readProject(dir, { defaults = {} } = {}) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`不是文件夹: ${dir}`);
  }
  const files = scan(dir);
  const allVideos = files.filter(f => VIDEO.test(f));
  const derived = allVideos.filter(f => IS_DERIVED(path.basename(f)));
  const videos = allVideos.filter(f => !IS_DERIVED(path.basename(f)));
  const images = files.filter(f => IMAGE.test(f));
  const subs = files.filter(f => SUB.test(f));
  const audio = files.filter(f => AUDIO.test(f));

  if (!videos.length) throw new Error(`${dir} 里没有找到视频文件`);

  // 封面：优先名字带「封面/cover」的；否则取体积最大的图
  let master = images.find(f => IS_COVER(path.basename(f)));
  if (!master && images.length) {
    master = images.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  }
  if (!master) throw new Error(`${dir} 里没有找到封面图`);

  const bgmFiles = audio.filter(f => IS_BGM(path.basename(f)));
  const sfxFiles = audio.filter(f => IS_SFX(path.basename(f)));
  // 字幕目录：取字幕文件所在的公共目录
  const subDirs = [...new Set(subs.map(f => path.dirname(f)))];
  const bgmDirs = [...new Set(bgmFiles.map(f => path.dirname(f)))];

  // 文件夹内的 preset.json 覆盖默认样式（不含路径，便于跨剧复用）
  const presetPath = path.join(dir, 'preset.json');
  let preset = {};
  if (fs.existsSync(presetPath)) {
    preset = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
  }

  const cfg = {
    ...defaults, ...preset,
    title: preset.title || defaults.title || path.basename(dir),
    master,
    input: videos,
    output: path.join(dir, '成片'),
    subtitles: {
      ...(defaults.subtitles || {}), ...(preset.subtitles || {}),
      enabled: subs.length > 0,
      dir: subDirs.length === 1 ? subDirs[0] : dir,
    },
    bgm: {
      ...(defaults.bgm || {}), ...(preset.bgm || {}),
      enabled: bgmFiles.length > 0,
      dir: bgmDirs.length === 1 ? bgmDirs[0] : dir,
    },
    outro: (() => {
      const o = { ...(defaults.outro || {}), ...(preset.outro || {}), enabled: true };
      // 项目文件夹里的音效优先；都没有就别写这个键，留给 outro.js 里自带的「咚」
      const sfx = sfxFiles[0] || (defaults.outro || {}).sfxPath || (preset.outro || {}).sfxPath;
      if (sfx) o.sfxPath = sfx; else delete o.sfxPath;
      return o;
    })(),
  };

  return {
    cfg, presetPath, hasPreset: fs.existsSync(presetPath),
    found: {
      master, videos: videos.length, subs: subs.length,
      derived: derived.map(f => path.basename(f)),
      bgm: bgmFiles.length, sfx: sfxFiles[0] || null,
      subDir: cfg.subtitles.dir, bgmDir: cfg.bgm.dir,
      images: images.length, audio: audio.length,
    },
  };
}

function describeProject(f) {
  const L = [];
  L.push(`封面    ${path.basename(f.master)}${f.images > 1 ? `（${f.images} 张图中选中）` : ''}`);
  L.push(`原片    ${f.videos} 个${f.derived.length ? `（已排除 ${f.derived.length} 个派生文件：${f.derived.join('、')}）` : ''}`);
  L.push(`字幕    ${f.subs ? `${f.subs} 个  @ ${f.subDir}` : '无（将不烧字幕）'}`);
  L.push(`BGM     ${f.bgm ? `${f.bgm} 条  @ ${f.bgmDir}` : '无（将不加 BGM）'}`);
  L.push(`片尾音效 ${f.sfx ? path.basename(f.sfx) : '无（用默认或不加）'}`);
  return L;
}

module.exports = { readProject, describeProject, scan };
