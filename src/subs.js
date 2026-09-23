'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const { filter } = require('./ffmpeg');

// ASS 颜色是 &HAABBGGRR：BGR 反序，且 alpha 是反的（00=不透明，FF=全透明）
function assColor(hex, alpha = 1) {
  const h = String(hex).replace(/^#|^0x/i, '').padStart(6, '0').slice(-6);
  const r = h.slice(0, 2), g = h.slice(2, 4), b = h.slice(4, 6);
  const a = Math.round((1 - Math.max(0, Math.min(1, alpha))) * 255)
    .toString(16).padStart(2, '0');
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

const ALIGN = {
  'bottom-left': 1, 'bottom-center': 2, 'bottom-right': 3,
  'middle-left': 4, 'middle-center': 5, 'middle-right': 6,
  'top-left': 7, 'top-center': 8, 'top-right': 9,
};

const DEFAULT_STYLE = {
  fontName: 'PingFang SC',
  fontSize: 0.045,        // 相对画面高度的比例；> 1 时按像素处理
  color: '#FFFFFF', alpha: 1,
  outline: 0.006, outlineColor: '#000000', outlineAlpha: 1,   // 同样按比例
  shadow: 0, shadowColor: '#000000', shadowAlpha: 0.5,
  box: null,              // { color:'#000000', alpha:0.6 } -> 不透明底框
  bold: false, italic: false, spacing: 0,
  align: 'bottom-center',
  marginV: 0.08, marginL: 0.06, marginR: 0.06,   // 比例
  pos: null,              // { x:0.5, y:0.86 } 归一化坐标，给了就用 \pos 精确定位
};

const px = (v, basis) => (v > 1 ? v : v * basis);

function parseSrt(text) {
  const out = [];
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split('\n').filter(l => l.trim() !== '');
    if (lines.length < 2) continue;
    const ti = lines.findIndex(l => /-->/.test(l));
    if (ti < 0) continue;
    const m = lines[ti].match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) continue;
    const toS = (h, mi, s, ms) => +h * 3600 + +mi * 60 + +s + +ms / 1000;
    out.push({
      start: toS(m[1], m[2], m[3], m[4]),
      end: toS(m[5], m[6], m[7], m[8]),
      text: lines.slice(ti + 1).join('\\N'),
    });
  }
  return out;
}

const assTime = t => {
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60);
  const s = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};

// SRT -> ASS。PlayRes 直接设成视频尺寸，剪映那套归一化坐标才能一一对上
async function srtToAss({ srtPath, out, videoW, videoH, style = {} }) {
  const st = { ...DEFAULT_STYLE, ...style };
  const cues = parseSrt(await fsp.readFile(srtPath, 'utf8'));
  if (!cues.length) throw new Error(`SRT 没有可用条目: ${srtPath}`);

  if (st.maxWidth) {
    const m = Math.round((1 - st.maxWidth) / 2 * videoW);
    st.marginL = m; st.marginR = m;
  }
  const emPx = px(st.fontSize, videoH);
  // st.fontScale 由 calibrateFontScale 实测得到；缺省 1 表示不做换算
  const fs_ = Math.round(emPx / (st.fontScale || 1));
  const ol = +(px(st.outline, videoH)).toFixed(2);
  const sh = +(px(st.shadow, videoH)).toFixed(2);
  const an = ALIGN[st.align];
  if (!an) throw new Error(`align 只能是 ${Object.keys(ALIGN).join('/')}`);
  const borderStyle = st.box ? 3 : 1;
  const backColour = st.box
    ? assColor(st.box.color || '#000000', st.box.alpha ?? 0.6)
    : assColor(st.shadowColor, st.shadowAlpha);

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: None',
    `PlayResX: ${videoW}`,
    `PlayResY: ${videoH}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,'
      + ' Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle,'
      + ' Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    [
      'Style: Default', st.fontName, fs_,
      assColor(st.color, st.alpha), assColor(st.color, st.alpha),
      assColor(st.outlineColor, st.outlineAlpha), backColour,
      st.bold ? -1 : 0, st.italic ? -1 : 0, 0, 0,
      100, 100, st.spacing, 0, borderStyle, ol, sh, an,
      Math.round(px(st.marginL, videoW)), Math.round(px(st.marginR, videoW)),
      Math.round(px(st.marginV, videoH)), 1,
    ].join(','),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const posTag = st.pos
    ? `{\\pos(${Math.round(st.pos.x * videoW)},${Math.round(st.pos.y * videoH)})}`
    : '';
  const events = cues.map(c =>
    `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${posTag}${c.text}`);

  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(out, header.concat(events).join('\n') + '\n', 'utf8');
  // 取最长的一条字幕的中点作为探针时间（画面上一定有字幕）
  const longest = cues.reduce((a, c) => (c.end - c.start > a.end - a.start ? c : a), cues[0]);
  return {
    out, cues: cues.length, fontSize: fs_, outline: ol, shadow: sh, alignment: an,
    probeTime: (longest.start + longest.end) / 2,
    lastEnd: Math.max(...cues.map(c => c.end)),
  };
}


// ---------- 从剪映「组合预设」里读字幕样式 ----------
// 参数散落在两处：materials.texts[0] 存样式，tracks 里的 text segment 存位置/缩放
// styleFrom 的统一入口：.json 当作固化好的纯样式读，目录当作剪映预设解析
function loadStyleFrom(src) {
  const fs = require('node:fs');
  if (/\.json$/i.test(src)) {
    const j = JSON.parse(fs.readFileSync(src, 'utf8'));
    const style = j.style || j;
    return { style, canvas: j._画布 || j.canvas || null, raw: j.raw || null };
  }
  return capcutPresetToStyle(src);
}

function capcutPresetToStyle(presetDir) {
  const fs = require('node:fs');
  const raw = JSON.parse(fs.readFileSync(path.join(presetDir, 'preset_draft/draft_content.json'), 'utf8'));
  const draft = raw?.materials?.drafts?.[0]?.draft;
  if (!draft) throw new Error('预设里没有 draft 结构');
  const t = draft.materials?.texts?.[0];
  if (!t) throw new Error('预设里没有文本素材（在剪映里加一条字幕再存预设）');
  const canvas = draft.canvas_config || {};
  const W = canvas.width, H = canvas.height;
  if (!W || !H) throw new Error('预设里没有画布尺寸');

  const seg = (draft.tracks || []).flatMap(tr => tr.type === 'text' ? (tr.segments || []) : [])[0];
  const tf = seg?.clip?.transform || { x: 0, y: 0 };
  const sc = seg?.clip?.scale?.x ?? 1;

  // 剪映归一化坐标：x/y ∈ [-1,1]，原点在画面中心，y 向上为正
  const cx = W / 2 + tf.x * (W / 2);
  const cy = H / 2 - tf.y * (H / 2);

  const size = (t.text_size || 30) * sc;
  // 描边：border_mode/border_width 为 0 视为关
  const outline = (t.border_width || 0) * size;
  // 阴影必须看 has_shadow：剪映即使关掉阴影也会写满 shadow_* 默认值
  const sp = t.shadow_point || {};
  const shadow = t.has_shadow
    ? Math.abs((t.shadow_distance || 0) * (sp.x ?? 0.707)) * sc
    : 0;
  // 背景框同理，看 background_style（0 = 关）
  const hasBox = (t.background_style || 0) !== 0;

  return {
    style: {
      fontFile: t.font_path && fs.existsSync(t.font_path) ? t.font_path : null,
      fontName: 'CapCutSubtitle',
      fontSize: Math.round(size),
      color: t.text_color || '#ffffff',
      alpha: (t.text_alpha ?? 1) * (t.global_alpha ?? 1),
      outline: +outline.toFixed(2),
      outlineColor: t.border_color || '#000000',
      outlineAlpha: t.border_alpha ?? 1,
      shadow: +shadow.toFixed(2),
      shadowColor: t.shadow_color || '#000000',
      shadowAlpha: t.has_shadow ? (t.shadow_alpha ?? 0) : 0,
      box: hasBox ? { color: t.background_color || '#000000', alpha: t.background_alpha ?? 0.6 } : null,
      bold: (t.bold_width || 0) > 0,
      italic: (t.italic_degree || 0) > 0,
      align: 'middle-center',
      pos: { x: cx / W, y: cy / H },
      maxWidth: t.line_max_width ?? 0.82,
    },
    canvas: { w: W, h: H },
    raw: {
      text_size: t.text_size, font_size: t.font_size, scale: sc,
      transform: tf, line_spacing: t.line_spacing,
      shadow_distance: t.shadow_distance, shadow_angle: t.shadow_angle,
      shadow_smoothing: t.shadow_smoothing,
      has_shadow: !!t.has_shadow,
      background_style: t.background_style || 0,
      border_mode: t.border_mode,
      letter_spacing: t.letter_spacing,
    },
  };
}


// ---------- 从 TTF/OTF 的 name 表读家族名（libass 靠家族名匹配，不认文件路径）----------
function fontFamilyOf(file) {
  const fs = require('node:fs');
  const d = fs.readFileSync(file);
  if (d.length < 12) throw new Error(`字体文件太小: ${file}`);
  const num = d.readUInt16BE(4);
  let off = null;
  for (let i = 0; i < num; i++) {
    const e = 12 + i * 16;
    if (d.slice(e, e + 4).toString('latin1') === 'name') { off = d.readUInt32BE(e + 8); break; }
  }
  if (off == null) throw new Error(`字体没有 name 表: ${file}`);
  const count = d.readUInt16BE(off + 2), so = d.readUInt16BE(off + 4);
  let ascii = null, any = null;
  for (let i = 0; i < count; i++) {
    const p2 = off + 6 + i * 12;
    const pid = d.readUInt16BE(p2), nid = d.readUInt16BE(p2 + 6);
    const ln = d.readUInt16BE(p2 + 8), o = d.readUInt16BE(p2 + 10);
    if (nid !== 1) continue;
    const raw = d.slice(off + so + o, off + so + o + ln);
    const str = pid === 3 ? raw.toString('utf16le').split('').length && Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1');
    const clean = str.replace(/\0/g, '').trim();
    if (!clean) continue;
    any = any || clean;
    // 优先纯 ASCII 家族名，中文名在部分 libass 构建上匹配不稳
    if (!ascii && /^[\x20-\x7e]+$/.test(clean)) ascii = clean;
  }
  const fam = ascii || any;
  if (!fam) throw new Error(`读不出字体家族名: ${file}`);
  return fam;
}

// ---------- 字幕发现与配对 ----------
// 优先级 1: 兄弟目录 <视频名>_subtitles/<语言>.srt
//          2: 统一字幕目录里按集数匹配
function discoverSubtitle({ videoFile, episode, language = 'English', dir = null }) {
  const fs = require('node:fs');
  const { detectEpisode } = require('./episode');

  const sib = `${videoFile}_subtitles`;
  if (fs.existsSync(sib)) {
    const f = path.join(sib, `${language}.srt`);
    if (fs.existsSync(f)) return { srt: f, via: '兄弟目录' };
  }
  if (dir && fs.existsSync(dir)) {
    const cands = fs.readdirSync(dir)
      .filter(n => n.toLowerCase().endsWith('.srt'))
      .map(n => ({ name: n, ep: detectEpisode(n).episode }))
      .filter(c => c.ep === episode);
    if (cands.length) {
      // 不停下来问人：优先 EP<n> 形式，其次文件名短的，再按名称排序
      const rank = n => (/^ep0*\d+/i.test(n) ? 0 : 1);
      const sorted = [...cands].sort((a, b) =>
        rank(a.name) - rank(b.name) || a.name.length - b.name.length || a.name.localeCompare(b.name));
      return {
        srt: path.join(dir, sorted[0].name),
        via: cands.length > 1 ? `规则选取（${cands.length} 个候选）` : '按集数匹配',
        candidates: cands.length,
      };
    }
  }
  return null;
}


// ---------- libass 字号标定 ----------
// ASS 的 Fontsize 不等于 em 像素：libass 沿用 VSFilter 约定，按字体度量缩放，
// 且不同字体系数不同（实测思源 0.720 / Metropolis 0.782）。这里实渲一次反解系数。
const _calCache = new Map();
async function calibrateFontScale({ fontFile, fontName, fontsdir }) {
  const key = `${fontFile}|${fontName}`;
  if (_calCache.has(key)) return _calCache.get(key);
  const os = require('node:os');
  const { ff } = require('./ffmpeg');
  const { measureText } = require('./cover');

  const PROBE = 'HxwmMnop', SIZE = 100, W = 1600, H = 400;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ectool-cal-'));
  try {
    const ass = path.join(dir, 'cal.ass');
    await fsp.writeFile(ass, [
      '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,'
        + ' Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle,'
        + ' Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      `Style: D,${fontName},${SIZE},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
      '', '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      `Dialogue: 0,0:00:00.00,0:00:05.00,D,,0,0,0,,${PROBE}`,
    ].join('\n') + '\n', 'utf8');

    const { stdout } = await ff(['-f', 'lavfi', '-i', `color=black:s=${W}x${H}:d=2:r=24`,
      '-vf', `${filter('ass', { filename: ass, fontsdir: fontsdir || undefined })},format=gray`,
      '-ss', '1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
    if (stdout.length !== W * H) throw new Error('标定取帧尺寸不符');

    let x0 = W, x1 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (stdout[y * W + x] > 60) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
      }
    }
    if (x1 < 0) throw new Error(`标定失败：libass 没渲出任何像素（字体 ${fontName} 未匹配？）`);
    const got = x1 - x0 + 1;
    const want = (await measureText({ fontFile, text: PROBE, fontSize: SIZE })).w;
    const k = got / want;
    if (!(k > 0.3 && k < 1.6)) throw new Error(`标定系数异常 ${k.toFixed(3)}，字体可能未匹配`);
    _calCache.set(key, k);
    return k;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}


// 剪映按文种分字体：en.ttf=Metropolis(拉丁) / zh-hans.ttf=思源黑体 / ko.ttf 等。
// 预设里的 font_path 只记了其中一个，渲英文字幕要换成拉丁那支。
const CAPCUT_FONT_BY_LANG = {
  english: 'en.ttf', spanish: 'en.ttf', portuguese: 'en.ttf',
  turkish: 'en.ttf', indonesian: 'en.ttf', french: 'en.ttf',
  german: 'en.ttf', italian: 'en.ttf', vietnamese: 'en.ttf',
  chinese: 'zh-hans.ttf', japanese: 'zh-hans.ttf', korean: 'ko.ttf',
  thai: 'NotoSansThai-Regular.ttf', arabic: 'NotoSansArabic-Regular.ttf',
  hebrew: 'NotoSansHebrew-Regular.ttf', bengali: 'NotoSansBengali-Regular.ttf',
  khmer: 'NotoSansKhmer-Regular.ttf', myanmar: 'NotoSansMyanmar-Regular.ttf',
};

function pickCapCutFont(fontPath, language) {
  const fs = require('node:fs');
  if (!fontPath || !language) return fontPath;
  const dir = path.dirname(fontPath);
  if (!/Resources\/Font\/SystemFont$/.test(dir)) return fontPath;   // 不是剪映字体目录就别动
  const want = CAPCUT_FONT_BY_LANG[String(language).toLowerCase()];
  if (!want) return fontPath;
  const cand = path.join(dir, want);
  return fs.existsSync(cand) ? cand : fontPath;
}

module.exports = { srtToAss, calibrateFontScale, pickCapCutFont, CAPCUT_FONT_BY_LANG, parseSrt, assColor, capcutPresetToStyle, loadStyleFrom, fontFamilyOf, discoverSubtitle, ALIGN, DEFAULT_STYLE };
