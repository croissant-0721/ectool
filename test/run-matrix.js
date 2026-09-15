'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { probeVideo } = require('../src/probe');
const { detectEpisode, renderTemplate } = require('../src/episode');
const { renderCover } = require('../src/cover');
const { muxCover } = require('../src/mux');

const FONT = '/System/Library/Fonts/Supplemental/Arial Unicode.ttf';
const FIX = path.join(__dirname, 'fixtures');
const OUT = path.join(__dirname, 'out');
const BOX = { x: 290, y: 1410, w: 500, h: 320 };

(async () => {
  const files = fs.readdirSync(FIX).filter(f => f.endsWith('.mp4')).sort();
  const modes = process.argv[2] ? [process.argv[2]] : ['copy', 'reencode'];
  for (const f of files) {
    const src = path.join(FIX, f);
    const info = await probeVideo(src);
    const ep = detectEpisode(f).episode ?? 0;
    const cover = path.join(OUT, `cover_ep${ep}.png`);
    await renderCover({
      master: path.join(FIX, 'master.png'), out: cover, box: BOX,
      text: renderTemplate('{n2}', ep),
      style: { fontFile: FONT, color: '0xffd166', size: 'auto', fill: 0.9 },
      erase: { mode: 'sample', padding: 6 },
    });
    console.log(`\n${f}`);
    console.log(`  源: ${info.codedW}x${info.codedH} rot=${info.rotation} sar=${info.sarStr} -> 帧 ${info.frameW}x${info.frameH} 显示 ${info.displayW}x${info.displayH} | ${info.vCodec}/${info.profile} ${info.fps}fps | audio=${info.hasAudio ? info.audio.codec : 'none'} | ep=${ep}`);
    for (const mode of modes) {
      const out = path.join(OUT, `${mode}__${f}`);
      const t0 = process.hrtime.bigint();
      try {
        const r = await muxCover({ video: src, coverPng: cover, out, opts: { mode, info } });
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        console.log(`  ${mode.padEnd(8)} OK   ${ms.toFixed(0)}ms  帧 ${info.nbFrames}->${r.verify.outInfo.nbFrames}  时长 +${(r.verify.outInfo.duration - info.duration).toFixed(3)}s  首帧差 ${r.verify.firstFrameDiff?.toFixed(1)}`);
      } catch (e) {
        console.log(`  ${mode.padEnd(8)} FAIL ${e.message.replace(/\n/g, '\n           ')}`);
      }
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
