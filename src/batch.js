'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const fsSync = require('node:fs');
const { probeVideo } = require('./probe');
const { detectBatch, renderTemplate } = require('./episode');
const { renderCover, imageSize } = require('./cover');
const { muxCover } = require('./mux');
const { prepareOutro } = require('./outro');
const bgmMod = require('./bgm');
const crypto = require('node:crypto');
const { srtToAss, capcutPresetToStyle, fontFamilyOf, discoverSubtitle,
        calibrateFontScale, pickCapCutFont } = require('./subs');
const os = require('node:os');

const DEFAULTS = {
  extensions: ['.mp4', '.mov', '.m4v'],
  concurrency: 2,
  text: { template: '{n2}', color: 'white', size: 'auto', fill: 0.9, align: 'center', valign: 'middle', strokeWidth: 0, strokeColor: 'black' },
  erase: { mode: 'none', padding: 4 },
  cover: { duration: null, attachedPic: false },
  mux: { mode: 'auto', audioMode: 'shift' },
  outro: { enabled: false },
  // 产物命名模板：{title} 剧名（默认取素材文件夹名）、{n}/{n2}/{n3} 集数
  // 留空则沿用源文件名。此项不参与指纹计算——改名不影响画面，不该触发重渲。
  outputName: null,
  title: null,
  subtitles: { enabled: false, language: 'English', dir: null, styleFrom: null, style: {} },
  bgm: { ...bgmMod.DEFAULTS },
  overrides: {},
};

function normalizeConfig(raw, baseDir) {
  const cfg = {
    ...DEFAULTS, ...raw,
    text: { ...DEFAULTS.text, ...(raw.text || {}) },
    erase: { ...DEFAULTS.erase, ...(raw.erase || {}) },
    cover: { ...DEFAULTS.cover, ...(raw.cover || {}) },
    mux: { ...DEFAULTS.mux, ...(raw.mux || {}) },
    outro: { ...DEFAULTS.outro, ...(raw.outro || {}) },
    subtitles: { ...DEFAULTS.subtitles, ...(raw.subtitles || {}) },
    bgm: { ...DEFAULTS.bgm, ...(raw.bgm || {}),
           duck: { ...DEFAULTS.bgm.duck, ...((raw.bgm || {}).duck || {}) } },
    baseDir,
  };
  const abs = p => (p && !path.isAbsolute(p) ? path.resolve(baseDir, p) : p);
  cfg.master = abs(cfg.master);
  cfg.output = abs(cfg.output);
  cfg.input = Array.isArray(cfg.input) ? cfg.input.map(abs) : abs(cfg.input);
  cfg.extensions = cfg.extensions.map(e => e.toLowerCase());
  if (cfg.outro.sfxPath) cfg.outro.sfxPath = abs(cfg.outro.sfxPath);
  if (cfg.subtitles.dir) cfg.subtitles.dir = abs(cfg.subtitles.dir);
  if (cfg.subtitles.styleFrom) cfg.subtitles.styleFrom = abs(cfg.subtitles.styleFrom);
  if (cfg.bgm.dir) cfg.bgm.dir = abs(cfg.bgm.dir);
  if (cfg.outro.enabled && cfg.outro.sfxPath === undefined) cfg.outro.sfxPath = null;
  if (!cfg.master) throw new Error('config.master 必填');
  if (!cfg.input) throw new Error('config.input 必填');
  if (!cfg.output) throw new Error('config.output 必填');
  if (!cfg.text.fontFile) throw new Error('config.text.fontFile 必填（绝对路径，本机 ffmpeg 无 fontconfig）');
  if (!cfg.box) throw new Error('config.box 必填');
  return cfg;
}

async function listInputs(cfg) {
  if (Array.isArray(cfg.input)) return cfg.input;
  const st = await fs.stat(cfg.input);
  if (st.isFile()) return [cfg.input];
  const names = await fs.readdir(cfg.input);
  return names
    .filter(n => !n.startsWith('.') && cfg.extensions.includes(path.extname(n).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'zh'))
    .map(n => path.join(cfg.input, n));
}


// 产物文件名：按 outputName 模板生成，留空则沿用源文件名
function outputBasename(cfg, row) {
  const src = path.basename(row.file);
  if (!cfg.outputName || row.episode == null) return src;
  const ext = path.extname(src) || '.mp4';
  const title = cfg.title || path.basename(cfg.baseDir || '');
  const name = String(cfg.outputName)
    .replace(/\{title\}/g, title)
    .replace(/\{n(\d)\}/g, (_, w) => String(row.episode).padStart(Number(w), '0'))
    .replace(/\{n\}/g, String(row.episode))
    .replace(/[\/\\]/g, '_');          // 防止模板里带出路径分隔符
  return name.endsWith(ext) ? name : name + ext;
}

async function plan(cfg) {
  const files = await listInputs(cfg);
  const rows = detectBatch(files, cfg.overrides);
  const master = await imageSize(cfg.master);
  const mAspect = master.w / master.h;

  for (const r of rows) {
    r.outPath = path.join(cfg.output, outputBasename(cfg, r));
    r.sameAsInput = path.resolve(r.outPath) === path.resolve(r.file);
    r.text = r.episode == null ? null : renderTemplate(cfg.text.template, r.episode);
    try {
      r.info = await probeVideo(r.file);
      const vAspect = r.info.displayW / r.info.displayH;
      // 母版与视频显示比例不同 -> cover-fit 会裁掉母版边缘，可能切到文案
      r.aspectMismatch = Math.abs(vAspect - mAspect) / mAspect > 0.01
        ? { master: mAspect, video: vAspect } : null;
    } catch (e) {
      r.probeError = e.message.split('\n')[0];
    }
    if (cfg.subtitles.enabled && r.episode != null) {
      try {
        const found = discoverSubtitle({
          videoFile: r.file, episode: r.episode,
          language: cfg.subtitles.language, dir: cfg.subtitles.dir,
        });
        if (found) { r.srt = found.srt; r.srtVia = found.via; }
      } catch (e) {
        r.srtError = e.message;
      }
    }
    if (cfg.bgm.enabled && r.episode != null) {
      try {
        const b = bgmMod.discoverBgm({
          episode: r.episode, dir: cfg.bgm.dir,
          moodPriority: cfg.bgm.moodPriority,
          override: cfg.bgm.overrides?.[r.episode] ?? cfg.bgm.overrides?.[String(r.episode)] ?? null,
        });
        if (b) { r.bgm = b.file; r.bgmVia = b.via; r.bgmCandidates = b.candidates; }
      } catch (e) {
        r.bgmError = e.message.split('\n')[0];
      }
    }
    r.blocked = !r.ok ? '未识别到集数'
      : r.probeError ? `探测失败: ${r.probeError}`
      : r.sameAsInput ? '输出会覆盖源文件'
      : r.srtError ? r.srtError
      : null;
  }
  // 输出名冲突：模板可能让两集算出同一个文件名，绝不能互相覆盖
  const byName = new Map();
  for (const r of rows) {
    if (r.blocked) continue;
    const k = path.basename(r.outPath);
    (byName.get(k) || byName.set(k, []).get(k)).push(r);
  }
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    list.forEach(r => { r.blocked = `输出名冲突「${name}」（${list.length} 个源指向同一文件名）`; });
  }

  // 同一集出现多个视频（如 (1)/(2) 重复下载）→ 取 mtime 最新的，其余标记跳过。
  // 全自动流水线不能让两个源写到同一个输出名。
  const byEp = new Map();
  for (const r of rows) {
    if (r.blocked || r.episode == null) continue;
    const list = byEp.get(r.episode) || [];
    list.push(r); byEp.set(r.episode, list);
  }
  for (const [ep, list] of byEp) {
    if (list.length < 2) continue;
    const withTime = list.map(r => ({ r, mtime: fsSync.statSync(r.file).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    withTime.slice(1).forEach(({ r }) => {
      r.blocked = `第 ${ep} 集重复（保留了更新的 ${path.basename(withTime[0].r.file)}）`;
      r.duplicateLoser = true;
    });
  }
  return { rows, master, mAspect };
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }));
  return out;
}

async function runBatch(cfg, { onEvent = () => {}, force = false, limit = 0 } = {}) {
  const planned = await plan(cfg);
  let todo = planned.rows.filter(r => !r.blocked);
  if (limit > 0) todo = todo.slice(0, limit);

  await fs.mkdir(cfg.output, { recursive: true });
  const coverDir = path.join(cfg.output, '_covers');
  await fs.mkdir(coverDir, { recursive: true });

  // 指纹：任何影响画面/声音的配置变了，产物就必须重渲，不能因"已存在"静默跳过
  const styleFingerprint = crypto.createHash('sha256').update(JSON.stringify({
    master: cfg.master, box: cfg.box, text: cfg.text, erase: cfg.erase, cover: cfg.cover,
    subtitles: cfg.subtitles, outro: cfg.outro, bgm: cfg.bgm, mux: cfg.mux,
  })).digest('hex').slice(0, 16);
  const manifestPath = path.join(cfg.output, '.ectool-manifest.json');
  let manifest = {};
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch {}

  // 字幕样式：优先从剪映预设读，再叠加 config 里的覆盖项
  let subStyle = null, fontsdir = null;
  if (cfg.subtitles.enabled) {
    let base = {};
    if (cfg.subtitles.styleFrom) base = capcutPresetToStyle(cfg.subtitles.styleFrom).style;
    subStyle = { ...base, ...(cfg.subtitles.style || {}) };
    // 剪映按文种分字体，预设里的 font_path 未必是目标语言那支
    if (subStyle.fontFile && !(cfg.subtitles.style || {}).fontFile) {
      subStyle.fontFile = pickCapCutFont(subStyle.fontFile, cfg.subtitles.language);
    }
    if (subStyle.fontFile) {
      subStyle.fontName = fontFamilyOf(subStyle.fontFile);
      fontsdir = path.dirname(subStyle.fontFile);
      // ASS 的 Fontsize 不是 em 像素，实测标定后换算
      subStyle.fontScale = await calibrateFontScale({
        fontFile: subStyle.fontFile, fontName: subStyle.fontName, fontsdir,
      });
    }
  }
  const assDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ectool-ass-'));

  // 封面只取决于文字内容，按文字缓存（含并发去重）
  const cache = new Map();
  const getCover = text => {
    if (!cache.has(text)) {
      const out = path.join(coverDir, `cover_${text.replace(/[^\w一-龥-]/g, '_')}.png`);
      cache.set(text, renderCover({
        master: cfg.master, out, box: cfg.box, text,
        style: cfg.text, erase: cfg.erase,
      }).then(r => r.out));
    }
    return cache.get(text);
  };

  const results = await pool(todo, cfg.concurrency, async (r) => {
    const started = Date.now();
    try {
      if (!force) {
        const exists = await fs.stat(r.outPath).then(() => true).catch(() => false);
        const rec = manifest[path.basename(r.outPath)];
        const srcMtime = fsSync.statSync(r.file).mtimeMs;
        const fresh = exists && rec
          && rec.fingerprint === styleFingerprint
          && rec.srcMtime === srcMtime
          && rec.srt === (r.srt || null)
          && rec.bgm === (r.bgm || null);
        if (fresh) {
          const res = { row: r, status: 'skipped', reason: '产物已是最新（配置与源均未变）' };
          onEvent(res); return res;
        }
        if (exists && !rec) {
          // 没有清单记录，无从判断是否陈旧 -> 重渲，宁可多做不可留旧
          onEvent({ row: r, status: 'note', reason: '无清单记录，重新渲染' });
        }
      }
      const coverPng = await getCover(r.text);
      let outro = null, subs = null, bgm = null;
      try {
        if (subStyle && r.srt) {
          const assPath = path.join(assDir, `ep${r.episode}.ass`);
          const a = await srtToAss({
            srtPath: r.srt, out: assPath,
            videoW: r.info.frameW, videoH: r.info.frameH, style: subStyle,
          });
          subs = { assPath, fontsdir, probeTime: a.probeTime, cues: a.cues,
                   fontSize: a.fontSize, emPx: Math.round(subStyle.fontSize),
                   font: subStyle.fontName };
        }
        if (cfg.bgm.enabled && r.bgm) {
          const sp = r.srt
            ? await bgmMod.speechLoudness(r.file, r.srt)
            : await bgmMod.trackLoudness(r.file);
          const bl = await bgmMod.trackLoudness(r.bgm);
          if (sp && bl) {
            const g = bgmMod.computeGainDb({
              speechLufs: sp.lufs, bgmLufs: bl.lufs, levelRatio: cfg.bgm.levelRatio,
            });
            // 校验窗口：取片子中段 20 秒，不依赖字幕空档
            const dur = r.info.duration || 60;
            const win = { start: Math.max(0, dur * 0.35), dur: Math.min(20, dur * 0.3) };
            const prog = await bgmMod.trackLoudness(r.file);
            // 混入后整体响度的预期抬升量
            const ratio = Math.pow(10, (g.targetLufs - (prog ? prog.lufs : sp.lufs)) / 10);
            const expectedDeltaDb = 10 * Math.log10(1 + ratio);
            bgm = {
              file: r.bgm, gainDb: g.gainDb,
              fadeIn: cfg.bgm.fadeIn, fadeOut: cfg.bgm.fadeOut,
              duck: cfg.bgm.duck,
              verify: { expectedDeltaDb, window: win },
              _meta: { speechLufs: sp.lufs, bgmLufs: bl.lufs, targetLufs: g.targetLufs,
                       ratioDb: g.ratioDb, via: r.bgmVia, candidates: r.bgmCandidates,
                       speechFrom: r.srt ? '字幕区间' : '整轨',
                       expectedDeltaDb: Number(expectedDeltaDb.toFixed(2)) },
            };
          }
        }
        if (cfg.outro.enabled) outro = await prepareOutro({ info: r.info, cfg: cfg.outro });
        const m = await muxCover({
          video: r.file, coverPng, out: r.outPath,
          opts: {
            info: r.info,
            mode: cfg.mux.mode,
            audioMode: cfg.mux.audioMode,
            encoder: cfg.mux.encoder || undefined,
            crf: cfg.mux.crf, preset: cfg.mux.preset, bitrate: cfg.mux.bitrate,
            coverDuration: cfg.cover.duration ?? undefined,
            attachedPic: cfg.cover.attachedPic,
            outro, subs, bgm,
          },
        });
        const res = {
          row: r, status: 'ok', mode: m.mode, verify: m.verify, fallback: m.log,
          ms: Date.now() - started,
          outro: outro && { trimFrames: outro.trim.frames, freezeFrames: outro.freezeFrames, freezeY: outro.trim.freezeY, sfxGainDb: outro.sfx?.gainDb },
          subs: subs && { cues: subs.cues, fontSize: subs.fontSize, emPx: subs.emPx,
                          font: subs.font, via: r.srtVia },
          bgm: bgm && { file: path.basename(bgm.file), gainDb: bgm.gainDb, ...bgm._meta },
        };
        onEvent(res); return res;
      } finally {
        if (outro) await outro.cleanup();
      }
    } catch (e) {
      const res = { row: r, status: 'failed', error: e.message, ms: Date.now() - started };
      onEvent(res); return res;
    }
  });

  await fs.rm(assDir, { recursive: true, force: true });

  for (const res of results) {
    if (res?.status !== 'ok') continue;
    manifest[path.basename(res.row.outPath)] = {
      fingerprint: styleFingerprint,
      srcMtime: fsSync.statSync(res.row.file).mtimeMs,
      srt: res.row.srt || null,
      bgm: res.row.bgm || null,
      episode: res.row.episode,
      mode: res.mode,
      renderedAt: new Date().toISOString(),
    };
  }
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  // 全自动流水线没有人工闸门，所有决策必须落到报告里供事后追查
  const report = {
    generatedAt: new Date().toISOString(),
    fingerprint: styleFingerprint,
    master: cfg.master, output: cfg.output,
    levelRatio: cfg.bgm.enabled ? cfg.bgm.levelRatio : null,
    episodes: planned.rows.map(r => {
      const res = results.find(x => x?.row === r);
      return {
        episode: r.episode, file: path.basename(r.file), rule: r.rule,
        blocked: r.blocked || null,
        status: res ? res.status : (r.blocked ? 'blocked' : 'not-run'),
        coverText: r.text || null,
        subtitle: r.srt ? { file: path.basename(r.srt), via: r.srtVia } : null,
        subtitleError: r.srtError || null,
        bgm: res?.bgm || (r.bgm ? { file: path.basename(r.bgm), via: r.bgmVia } : null),
        bgmError: r.bgmError || null,
        outro: res?.outro || null,
        mode: res?.mode || null,
        ms: res?.ms ?? null,
        error: res?.error || null,
      };
    }),
  };
  await fs.writeFile(path.join(cfg.output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n', 'utf8');

  return { planned, results, report,
           skippedBlocked: planned.rows.filter(r => r.blocked) };
}

module.exports = { normalizeConfig, plan, runBatch, listInputs, outputBasename, DEFAULTS };
