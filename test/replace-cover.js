'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ff } = require('../src/ffmpeg');
const { muxCover } = require('../src/mux');
const { replaceCover, replaceFolder } = require('../src/replace-cover');
(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ectool-replace-test-'));
  try {
    const src = path.join(dir, 'src.mp4'), cover = path.join(dir, 'cover.png');
    await ff(['-f', 'lavfi', '-i', 'color=blue:s=160x240:r=25:d=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libx264', '-c:a', 'aac', '-shortest', src]);
    await ff(['-f', 'lavfi', '-i', 'color=red:s=160x240', '-frames:v', '1', cover]);
    const audioHash = async file => (await ff(['-i', file, '-map', '0:a:0', '-c:a', 'copy', '-f', 'hash', '-'])).stdout.toString();
    const old = path.join(dir, 'old.mp4');
    await muxCover({ video: src, coverPng: cover, out: old, opts: { mode: 'reencode', encoder: 'libx264' } });
    await ff(['-f', 'lavfi', '-i', 'color=green:s=160x240', '-frames:v', '1', cover]);
    for (const hasAudio of [true, false]) {
      const input = hasAudio ? old : path.join(dir, 'silent.mp4');
      if (!hasAudio) await ff(['-i', old, '-an', '-c:v', 'copy', input]);
      const out = path.join(dir, `replaced-${hasAudio}.mp4`);
      const r = await replaceCover({ video: input, cover, out });
      assert.equal(r.mode, 'reencode', 'B-frame source must use the compatible fallback');
      assert.ok(r.log.some(l => l.includes('快速拼接不可用')));
      await assert.rejects(replaceCover({ video: input, cover, out: input }), /输出已存在/);
      assert.equal(r.verify.outInfo.nbFrames, r.info.nbFrames);
      assert.ok(Math.abs(r.verify.outInfo.duration - r.info.duration) < 0.001);
      assert.equal(r.verify.outInfo.hasAudio, hasAudio);
      if (hasAudio) assert.equal(await audioHash(out), await audioHash(input));
      const { stdout } = await ff(['-i', out, '-vf', 'select=eq(n\\,1),scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
      assert.ok(stdout[2] > stdout[0] + 100 && stdout[2] > stdout[1] + 100, 'second frame must remain blue, with no old red cover');
    }
    // Real moving GOPs exercise partial re-encoding, SPS changes and exact tail preservation.
    for (const gop of [1, 12]) {
      const fast = path.join(dir, `moving's-${gop}.mp4`);
      await ff(['-f', 'lavfi', '-i', 'testsrc2=s=160x240:r=24:d=2',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
        '-c:v', 'libx264', '-g', String(gop), '-bf', '0', '-sc_threshold', '0',
        '-c:a', 'aac', '-shortest', fast]);
      const r = await replaceCover({ video: fast, cover, out: path.join(dir, `fast-${gop}.mp4`) });
      assert.equal(r.mode, 'smart', JSON.stringify(r.log));
      assert.equal(r.reencodedFrames, gop);
      assert.equal(r.reencodedSeconds, gop / 24);
      assert.equal(r.verify.outInfo.nbFrames, 48);
      assert.equal(await audioHash(fast), await audioHash(r.out));
      if (gop === 12) {
        const silent = path.join(dir, 'fast-silent.mp4');
        await ff(['-i', fast, '-an', '-c:v', 'copy', silent]);
        const s = await replaceCover({ video: silent, cover, out: path.join(dir, 'fast-silent-out.mp4') });
        assert.equal(s.mode, 'smart');
        assert.equal(s.verify.outInfo.hasAudio, false);
      }
    }
    const batchDir = path.join(dir, 'batch');
    await fs.mkdir(batchDir);
    await fs.copyFile(old, path.join(batchDir, 'EP01.mp4'));
    await fs.copyFile(path.join(dir, 'silent.mp4'), path.join(batchDir, 'EP02.mp4'));
    await fs.copyFile(cover, path.join(batchDir, '新封面.png'));
    const batch = await replaceFolder({ folder: batchDir });
    assert.equal(batch.results.length, 2);
    assert.ok(batch.results.every(r => r.status === 'ok'));
    const rerun = await replaceFolder({ folder: batchDir });
    assert.equal(rerun.results.length, 2, 'must not scan output subfolder');
    assert.ok(rerun.results.every(r => r.status === 'failed' && /输出已存在/.test(r.error)));
    await fs.copyFile(cover, path.join(batchDir, 'another.png'));
    await assert.rejects(replaceFolder({ folder: batchDir }), /恰好一张/);
    console.log('PASS: replacement preserves frames, duration, audio packets; old cover removed (audio and silent sources); smart GOP copy with audio/silent inputs and immediate IDR; B-frame fallback; batch, rerun protection and ambiguous covers');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
