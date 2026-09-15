'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ff, probeJson } = require('./ffmpeg');
const { parseSrt } = require('./subs');
const { detectEpisode } = require('./episode');

const DEFAULTS = {
  enabled: false,
  dir: null,
  levelRatio: 0.2,        // BGM 相对人声的线性振幅比 -> 0.2 = -13.98 dB
  moodPriority: ['悬疑', '紧张', '反击'],   // 命中越靠前越优先；按你的素材分布排的
  duck: { enabled: true, threshold: 0.03, ratio: 6, attack: 20, release: 400, makeup: 1 },
  fadeIn: 1.5,
  fadeOut: 2.0,
  overrides: {},          // { 12: '第12集bgm(紧张).mp3' }
};

// 用字幕时间轴把「有人说话」的片段拼起来测响度，比整轨测准得多
async function speechLoudness(videoFile, srtPath, { maxCues = 40 } = {}) {
  const cues = parseSrt(fs.readFileSync(srtPath, 'utf8'))
    .filter(c => c.end - c.start > 0.25);
  if (!cues.length) return null;
  const step = Math.max(1, Math.ceil(cues.length / maxCues));
  const use = cues.filter((_, i) => i % step === 0);

  const parts = use.map((c, i) =>
    `[0:a]atrim=start=${c.start.toFixed(3)}:end=${c.end.toFixed(3)},asetpts=N/SR/TB[s${i}]`);
  const chain = use.map((_, i) => `[s${i}]`).join('');
  const fc = `${parts.join(';')};${chain}concat=n=${use.length}:v=0:a=1[sp];[sp]ebur128=peak=true[out]`;

  const { stderr } = await ff(['-i', videoFile, '-filter_complex', fc,
    '-map', '[out]', '-f', 'null', '-']);
  const m = [...stderr.matchAll(/I:\s+(-?[\d.]+)\s+LUFS/g)].pop();
  const p = [...stderr.matchAll(/Peak:\s+(-?[\d.]+)\s+dBFS/g)].pop();
  return m ? {
    lufs: Number(m[1]),
    peakDb: p ? Number(p[1]) : null,
    cuesUsed: use.length,
    totalCues: cues.length,
    speechSeconds: use.reduce((s, c) => s + (c.end - c.start), 0),
  } : null;
}

async function trackLoudness(file) {
  const { stderr } = await ff(['-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const m = [...stderr.matchAll(/I:\s+(-?[\d.]+)\s+LUFS/g)].pop();
  const p = [...stderr.matchAll(/Peak:\s+(-?[\d.]+)\s+dBFS/g)].pop();
  return m ? { lufs: Number(m[1]), peakDb: p ? Number(p[1]) : null } : null;
}

async function audioDuration(file) {
  const j = await probeJson(['-show_entries', 'format=duration', file]);
  return Number(j.format?.duration) || null;
}

// 按集数发现 BGM；一集多条时用情绪优先级挑，挑不出就报冲突让人决定
function discoverBgm({ episode, dir, moodPriority = [], override = null }) {
  if (!dir || !fs.existsSync(dir)) return null;
  if (override) {
    const p = path.isAbsolute(override) ? override : path.join(dir, override);
    if (!fs.existsSync(p)) throw new Error(`bgm.overrides 指定的文件不存在: ${p}`);
    return { file: p, via: '手动指定', candidates: 1 };
  }
  const cands = fs.readdirSync(dir)
    .filter(n => /\.(mp3|m4a|aac|wav|flac)$/i.test(n))
    .filter(n => /bgm/i.test(n))
    .filter(n => detectEpisode(n).episode === episode);
  if (!cands.length) return null;
  if (cands.length === 1) return { file: path.join(dir, cands[0]), via: '唯一匹配', candidates: 1 };

  // 全自动流水线里不能停下来问人：按确定性规则排序取第一个，并把候选数记进报告
  //   1) 情绪优先级靠前者胜
  //   2) 同情绪下优先无 (n) 后缀的原始文件
  //   3) 仍并列则按文件名排序
  const moodRank = n => {
    const i = moodPriority.findIndex(m => n.includes(m));
    return i < 0 ? moodPriority.length : i;
  };
  const dupRank = n => (/\(\d+\)/.test(n) ? 1 : 0);
  const sorted = [...cands].sort((a, b) =>
    moodRank(a) - moodRank(b) || dupRank(a) - dupRank(b) || a.localeCompare(b));
  const pickName = sorted[0];
  const mood = moodPriority.find(m => pickName.includes(m)) || null;
  return {
    file: path.join(dir, pickName),
    via: mood ? `规则选取（情绪「${mood}」）` : '规则选取（按文件名）',
    candidates: cands.length, mood, allCandidates: sorted,
  };
}

// 目标增益：让 BGM 落到人声的 levelRatio（线性振幅比）
function computeGainDb({ speechLufs, bgmLufs, levelRatio }) {
  const ratioDb = 20 * Math.log10(levelRatio);
  const target = speechLufs + ratioDb;
  return { gainDb: Number((target - bgmLufs).toFixed(2)), targetLufs: Number(target.toFixed(2)), ratioDb: Number(ratioDb.toFixed(2)) };
}


// 找「最安静的对白空档」——BGM 在这里最容易被测出来，用于校验
async function findQuietGap(videoFile, srtPath, { minLen = 1.2 } = {}) {
  const cues = parseSrt(fs.readFileSync(srtPath, 'utf8'));
  const gaps = [];
  for (let i = 0; i < cues.length - 1; i++) {
    const len = cues[i + 1].start - cues[i].end;
    if (len >= minLen) gaps.push({ t: cues[i].end + len / 2, len });
  }
  if (!gaps.length) return null;
  let best = null;
  for (const g of gaps.slice(0, 12)) {
    const { stderr } = await ff(['-ss', g.t.toFixed(3), '-t', '1.2', '-i', videoFile,
      '-af', 'volumedetect', '-f', 'null', '-']);
    const m = stderr.match(/mean_volume:\s*(-?[\d.]+)/);
    const lv = m ? Number(m[1]) : 0;
    if (!best || lv < best.level) best = { t: g.t, len: g.len, level: lv };
  }
  return best;
}

module.exports = { DEFAULTS, speechLoudness, findQuietGap, trackLoudness, discoverBgm, computeGainDb, audioDuration };
