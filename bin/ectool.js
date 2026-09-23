#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('node:util');
const fsSync = require('node:fs');
const { checkTools } = require('../src/ffmpeg');
const { normalizeConfig, plan, runBatch } = require('../src/batch');
const { renderCover } = require('../src/cover');
const { renderTemplate } = require('../src/episode');
const { startPicker } = require('../src/picker');
const { readProject, describeProject } = require('../src/project');

const C = { dim: s => `\x1b[2m${s}\x1b[0m`, red: s => `\x1b[31m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`, yellow: s => `\x1b[33m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m` };

// 中文按两个终端列宽计
const dispW = s => [...String(s)].reduce((n, c) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(c) ? 2 : 1), 0);
const padEndW = (s, w) => String(s) + ' '.repeat(Math.max(0, w - dispW(s)));

// 没有 preset.json 时的内置默认（pick 之后会被写进项目文件夹）
const BUILTIN = {
  box: { anchor: 'bottom-right', margin: { x: '4%', y: '2%' }, size: { w: '20%', h: '6%' } },
  text: {
    template: 'EP{n}',
    fontFile: '/System/Library/Fonts/Supplemental/Georgia Bold.ttf',
    color: '0xF0D890', size: 'auto', fill: 0.88,
    align: 'center', valign: 'middle', strokeWidth: 2, strokeColor: '0x1a1030',
  },
  erase: { mode: 'none' },
  cover: { duration: null, attachedPic: false },
  subtitles: { language: 'English' },
  outro: {
    freezeDuration: 1.0, trimBlackTail: true, blackThreshold: 20,
    sfxTargetPeakDb: -1.5, sparkSource: 'sequence',
  },
  bgm: { levelRatio: 0.2, moodPriority: ['悬疑', '紧张', '反击'], fadeIn: 1.5, fadeOut: 2.0 },
  mux: { mode: 'auto', audioMode: 'shift' },
  concurrency: 2,
};

// 全局默认：跨剧通用的片尾音效、字幕样式、星火素材等
function loadGlobalDefaults() {
  const f = path.join(require('node:os').homedir(), '.ectool', 'defaults.json');
  if (!fsSync.existsSync(f)) return {};
  try { return JSON.parse(fsSync.readFileSync(f, 'utf8')); }
  catch (e) { console.error(C.yellow(`  ~/.ectool/defaults.json 解析失败，已忽略: ${e.message}`)); return {}; }
}
const deepMerge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]))
      ? deepMerge(a[k], v) : v;
  }
  return out;
};

const USAGE = `用法:
  ectool plan    -c <config.json>            仅显示识别结果与警告，不写任何文件
  ectool preview -c <config.json> [-e N] [-o out.png]   渲染单张封面预览
  ectool make    <素材文件夹>                  一键出片：自动识别封面/原片/字幕/BGM，无需配置文件
                 [--use-default-position]     跳过「集数位置未确认」的阻断
  ectool pick    <素材文件夹> | -c <config.json>  拖框器：调集数位置并写回 preset.json
  ectool run     -c <config.json> [--force] [--limit N] 执行批量处理

选项:
  -c, --config   配置文件路径（必填）
  -e, --episode  preview 用的集数（默认 1）
  -o, --out      preview 输出路径（默认 <output>/_preview.png）
      --force    run 时覆盖已存在的输出
      --limit N  run 时只处理前 N 个（试跑用）
`;

async function loadConfig(p) {
  if (!p) throw new Error('缺少 -c <config.json>');
  const abs = path.resolve(p);
  const raw = JSON.parse(await fs.readFile(abs, 'utf8'));
  return normalizeConfig(raw, path.dirname(abs));
}

function printPlan(planned, cfg) {
  const { rows, master, mAspect } = planned;
  // box 可能是锚点写法，先解析成绝对坐标再显示
  let bx;
  try { bx = require('../src/box').resolveBox(cfg.box, master.w, master.h); }
  catch { bx = { x: '?', y: '?', w: '?', h: '?' }; }
  console.log(C.bold(`\n母版 ${cfg.master}`));
  if (cfg.outro?.enabled) {
    console.log(C.dim(`  片尾: 定格 ${cfg.outro.freezeDuration ?? 1}s · 星火 ${(cfg.outro.spark?.count) ?? 190} 粒 · 音效 ${cfg.outro.sfxPath ? path.basename(cfg.outro.sfxPath) : '无'}${cfg.outro.trimBlackTail === false ? '' : ' · 自动裁黑尾'}`));
  }
  console.log(`  ${master.w}x${master.h}  比例 ${mAspect.toFixed(4)}   选框 ${bx.x},${bx.y} ${bx.w}x${bx.h}${cfg.box.anchor ? `（锚点 ${cfg.box.anchor}）` : ''}   模板 "${cfg.text.template}"  擦除 ${cfg.erase.mode}\n`);

  const cols = [
    ['集数', 5], ['规则', 10], ['封面', 8], ['字幕', 20], ['BGM', 26], ['源参数', 30], ['文件名', 30],
  ];
  console.log(C.dim('  ' + cols.map(([n, w]) => padEndW(n, w)).join(' ')));
  for (const r of rows) {
    const src = r.info
      ? `${r.info.frameW}x${r.info.frameH}${r.info.rotation ? '/rot' + r.info.rotation : ''}${r.info.sarStr !== '1/1' ? '/sar' + r.info.sarStr : ''} ${r.info.vCodec} ${r.info.fps.toFixed(0)}fps ${r.info.hasAudio ? r.info.audio.codec : '无音轨'}`
      : C.red('探测失败');
    const mark = r.blocked ? C.red('✗') : r.duplicate ? C.yellow('!') : C.green('·');
    const sub = r.srtError ? C.red('冲突')
      : r.srt ? `${path.basename(r.srt)} (${r.srtVia})`
      : (cfg.subtitles?.enabled ? C.dim('无字幕') : '—');
    const bg = r.bgmError ? C.red('冲突')
      : r.bgm ? `${path.basename(r.bgm)}${r.bgmCandidates > 1 ? C.dim('/' + r.bgmCandidates + '选1') : ''}`
      : (cfg.bgm?.enabled ? C.dim('无BGM') : '—');
    console.log(`${mark} ` + [
      padEndW(r.episode ?? '—', 5), padEndW(r.rule || '未识别', 10),
      padEndW(r.text ?? '—', 8), padEndW(sub, 20), padEndW(bg, 26),
      padEndW(src, 30), r.base,
    ].join(' '));
    if (r.blocked) console.log(C.red(`      ↳ ${r.blocked}`));
    if (r.duplicate) console.log(C.yellow(`      ↳ 集数重复，用 overrides 手动指定`));
    if (r.aspectMismatch) console.log(C.yellow(`      ↳ 母版比例 ${r.aspectMismatch.master.toFixed(4)} 与视频显示比例 ${r.aspectMismatch.video.toFixed(4)} 不同，封面会被裁切`));
  }
  const bad = rows.filter(r => r.blocked).length;
  const dup = rows.filter(r => r.duplicate).length;
  console.log(`\n共 ${rows.length} 个：可处理 ${rows.length - bad}，受阻 ${bad}${dup ? `，集数重复 ${dup}` : ''}`);
  return bad;
}

async function executeRun(cfg, p, v) {
    let done = 0;
  const total = p.rows.filter(r => !r.blocked).length;
  const cap = v.limit ? Math.min(Number(v.limit), total) : total;
  const { results } = await runBatch(cfg, {
    force: v.force, limit: v.limit ? Number(v.limit) : 0,
    onEvent: res => {
      done++;
      const tag = res.status === 'ok' ? C.green('OK  ') : res.status === 'skipped' ? C.dim('SKIP') : C.red('FAIL');
      const si = res.subs
        ? C.dim(`  字幕${res.subs.cues}条 ${res.subs.font} em${res.subs.emPx}px(ASS ${res.subs.fontSize})`)
        : '';
      if (res.status === 'note') { console.log(C.dim(`      ↳ ${res.reason}`)); return; }
      const bi = res.bgm
        ? C.dim(`  BGM ${res.bgm.gainDb}dB→${res.bgm.targetLufs}LUFS`)
        : '';
      const oi = res.outro
        ? C.dim(`  裁黑${res.outro.trimFrames}帧 定格${res.outro.freezeFrames}帧 咚${res.outro.sfxGainDb >= 0 ? '+' : ''}${res.outro.sfxGainDb}dB`)
        : '';
      const extra = res.status === 'ok'
        ? `${res.mode.padEnd(8)} ${String(res.ms).padStart(6)}ms${res.fallback?.length ? C.dim('  (已回退)') : ''}${si}${bi}${oi}`
        : res.status === 'skipped' ? C.dim(res.reason) : '';
      console.log(`[${String(done).padStart(3)}/${cap}] ${tag} ${padEndW(res.row.base, 40)} ${extra}`);
      if (res.status === 'failed') console.log(C.red(`        ${res.error.replace(/\n/g, '\n        ')}`));
    },
  });
  const ok = results.filter(r => r?.status === 'ok').length;
  const noBgm = p.rows.filter(r => !r.blocked && cfg.bgm?.enabled && !r.bgm).length;
  const noSub = p.rows.filter(r => !r.blocked && cfg.subtitles?.enabled && !r.srt).length;
  const skip = results.filter(r => r?.status === 'skipped').length;
  const fail = results.filter(r => r?.status === 'failed').length;
  const byMode = results.filter(r => r?.status === 'ok')
    .reduce((m, r) => (m[r.mode] = (m[r.mode] || 0) + 1, m), {});
  console.log(`\n完成: ${C.green(ok + ' 成功')}${skip ? `  ${skip} 跳过` : ''}${fail ? `  ${C.red(fail + ' 失败')}` : ''}` +
    `${Object.keys(byMode).length ? `   路径分布: ${Object.entries(byMode).map(([k, n]) => `${k}×${n}`).join(' ')}` : ''}`);
  if (noSub || noBgm) {
    console.log(C.yellow(`  缺素材: ${noSub ? noSub + ' 集无字幕' : ''}${noSub && noBgm ? '，' : ''}${noBgm ? noBgm + ' 集无BGM' : ''}（已按无该素材出片）`));
  }
  console.log(`输出目录: ${cfg.output}`);
  console.log(C.dim(`决策报告: ${path.join(cfg.output, 'report.json')}`));
  return fail ? 1 : 0;
}

async function main() {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      episode: { type: 'string', short: 'e' },
      out: { type: 'string', short: 'o' },
      force: { type: 'boolean', default: false },
      limit: { type: 'string' },
      port: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      'use-default-position': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const cmd = positionals[0];
  if (v.help || !cmd) { console.log(USAGE); return 0; }
  await checkTools();

  if (cmd === 'plan') {
    const cfg = await loadConfig(v.config);
    const p = await plan(cfg);
    printPlan(p, cfg);
    return 0;
  }

  if (cmd === 'preview') {
    const cfg = await loadConfig(v.config);
    const ep = Number(v.episode ?? 1);
    const out = v.out ? path.resolve(v.out) : path.join(cfg.output, '_preview.png');
    const text = renderTemplate(cfg.text.template, ep);
    const r = await renderCover({ master: cfg.master, out, box: cfg.box, text, style: cfg.text, erase: cfg.erase });
    console.log(`预览已生成: ${out}`);
    console.log(`  文字 "${text}"  字号 ${r.fontSize}  墨迹 ${r.ink.w}x${r.ink.h}  原点 ${r.drawX},${r.drawY}${r.eraseColor ? `  擦除色 ${r.eraseColor}` : ''}`);
    return 0;
  }

  if (cmd === 'make') {
    const dir = path.resolve(positionals[1] || '.');
    const base = deepMerge(BUILTIN, loadGlobalDefaults());
    const { cfg: raw, found, hasPreset, presetPath } = readProject(dir, { defaults: base });
    console.log(C.bold(`\n素材文件夹: ${dir}`));
    describeProject(found).forEach(l => console.log('  ' + l));
    const positioned = hasPreset && fsSync.existsSync(presetPath)
      && !!(JSON.parse(fsSync.readFileSync(presetPath, 'utf8'))._positionedAt);
    if (!positioned && !v['use-default-position']) {
      console.log(C.red(`\n  集数位置尚未为这部剧确认过。`));
      console.log(`  封面是 ${path.basename(found.master)}，内置默认会把集数放在右下角，多半会压到标题上。\n`);
      console.log(`  先定位置：  ${C.bold(`ectool pick "${dir}"`)}`);
      console.log(C.dim(`  或坚持用默认位置： ectool make "${dir}" --use-default-position\n`));
      return 2;
    }
    if (!positioned) {
      console.log(C.yellow(`  ⚠ 使用内置默认集数位置（未经确认）`));
    }
    console.log('');
    const cfg = normalizeConfig(raw, dir);
    const p = await plan(cfg);
    printPlan(p, cfg);
    console.log('');
    return await executeRun(cfg, p, v);
  }

  if (cmd === 'pick') {
    const target = positionals[1];
    if (target && !v.config) {
      const dir = path.resolve(target);
      const { cfg: raw, presetPath } = readProject(dir, { defaults: deepMerge(BUILTIN, loadGlobalDefaults()) });
      const cfg = normalizeConfig(raw, dir);
      // 不在启动时写 preset：一旦写了，「没配过」就和「配成默认值」无法区分，
      // make 会以为你确认过位置而直接合成。只有你点保存才落盘。
      const { url } = await startPicker({ cfg, configPath: presetPath,
        port: v.port ? Number(v.port) : 7788, open: !v['no-open'] });
      console.log(`拖框器: ${C.bold(url)}`);
      console.log(C.dim(`  保存后写回 ${presetPath}，然后跑 ectool make "${dir}"`));
      await new Promise(() => {});
      return 0;
    }
    const cfg = await loadConfig(v.config);
    const { url } = await startPicker({
      cfg, configPath: path.resolve(v.config),
      port: v.port ? Number(v.port) : 7788, open: !v['no-open'],
    });
    console.log(`拖框器已启动: ${C.bold(url)}`);
    console.log(C.dim('  拖动/缩放选框 → 自动用 ffmpeg 真实渲染 → 「保存到 config」写回'));
    console.log(C.dim('  Ctrl-C 结束'));
    await new Promise(() => {});   // 常驻
    return 0;
  }

  if (cmd === 'run') {
    const cfg = await loadConfig(v.config);
    const p = await plan(cfg);
    printPlan(p, cfg);
    console.log('');
    return await executeRun(cfg, p, v);
  }

  console.error(`未知命令: ${cmd}\n`);
  console.log(USAGE);
  return 2;
}

main().then(c => process.exit(c)).catch(e => {
  console.error(C.red('错误: ') + e.message);
  process.exit(1);
});
