'use strict';
const path = require('node:path');

// 易被误判成集数的 token，先等长掩成 # —— 等长是为了不破坏分隔符结构
const NOISE = new RegExp([
  '\\b(?:4k|8k|2k|uhd|fhd)\\b',
  '\\b\\d{2,3}fps\\b',
  '\\b(?:480|720|1080|1440|2160|4320)[pi]?\\b',
  '\\b(?:h\\.?26[45]|x26[45]|hevc|avc1?|vp9|av1)\\b',
  '\\b(?:aac|ac3|eac3|dts|flac|mp3)\\b',
  '\\b(?:8|10|12)bit\\b',
  '\\b(?:hdr10\\+?|hdr|sdr|dv)\\b',
  '\\b(?:19|20)\\d{2}\\b',            // 年份
  '\\bv\\d\\b',                        // v2 / v3 版本号
].join('|'), 'gi');

const RULES = [
  { name: '第N集',     re: /第\s*(\d{1,4})\s*[集话話期幕]/ },
  { name: 'SxxExx',    re: /(?<![A-Za-z0-9])S\d{1,2}\s*[Ee][Pp]?\s*(\d{1,4})(?!\d)/ },
  { name: 'EP/E 前缀', re: /(?<![A-Za-z0-9])[Ee][Pp]?\s*[.\-_]?\s*(\d{1,4})(?!\d)/ },
  { name: '括号内数字', re: /[\[【(（]\s*(\d{1,4})\s*[\]】)）]/ },
  { name: '分隔符包围', re: /(?:^|[-_\s.·])(\d{1,4})(?:[-_\s.·]|$)/ },
  { name: '末尾数字',   re: /(\d{1,4})\s*$/ },
];

function detectEpisode(filename) {
  const stem = path.basename(filename, path.extname(filename));
  const masked = stem.replace(NOISE, m => '#'.repeat(m.length));
  for (const r of RULES) {
    const m = masked.match(r.re);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isInteger(n) && n >= 0 && n <= 9999) {
      return { episode: n, rule: r.name, ok: true, stem };
    }
  }
  return { episode: null, rule: null, ok: false, stem };
}

// 整批识别 + 冲突标记。overrides 形如 { "文件名.mp4": 12 }
function detectBatch(files, overrides = {}) {
  const rows = files.map(f => {
    const base = path.basename(f);
    const d = detectEpisode(base);
    if (Object.prototype.hasOwnProperty.call(overrides, base)) {
      return { file: f, base, episode: Number(overrides[base]), rule: '手动指定', ok: true, stem: d.stem };
    }
    return { file: f, base, ...d };
  });
  const seen = new Map();
  for (const r of rows) {
    if (r.episode == null) continue;
    seen.set(r.episode, (seen.get(r.episode) || 0) + 1);
  }
  for (const r of rows) r.duplicate = r.episode != null && seen.get(r.episode) > 1;
  return rows;
}

function renderTemplate(tpl, n) {
  return String(tpl)
    .replace(/\{n(\d)\}/g, (_, w) => String(n).padStart(Number(w), '0'))
    .replace(/\{n\}/g, String(n));
}

module.exports = { detectEpisode, detectBatch, renderTemplate, RULES };
