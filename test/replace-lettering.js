'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ff } = require('../src/ffmpeg');
const { replaceCover } = require('../src/replace-cover');

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ectool-lettering-'));
  let child;
  try {
    const source = path.join(dir, 'EP01.mp4');
    await ff(['-f', 'lavfi', '-i', 'testsrc2=s=160x240:r=24:d=2',
      '-c:v', 'libx264', '-g', '12', '-bf', '0', '-sc_threshold', '0', source]);
    await fs.copyFile(source, path.join(dir, 'EP02.mp4'));
    await ff(['-f', 'lavfi', '-i', 'color=green:s=160x240', '-frames:v', '1', path.join(dir, '新封面.png')]);
    child = spawn(process.execPath, [path.resolve(__dirname, '../bin/ectool.js'), 'replace-cover', dir, '--no-open']);
    let output = '', errors = '', resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    child.stdout.on('data', b => {
      output += b;
      const m = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (m) resolveReady(m[0]);
    });
    child.stderr.on('data', b => { errors += b; });
    const done = new Promise(resolve => child.once('close', code => resolve(code)));
    const timer = setTimeout(() => child.kill(), 30000);
    try {
      const url = await Promise.race([ready, done.then(() => { throw new Error(`CLI exited before picker: ${errors}`); })]);
      assert.ok(!output.includes('正在换封面'), 'must wait for position confirmation');
      const html = await (await fetch(url)).text();
      const boot = JSON.parse(html.match(/const BOOT = (.*);/)[1]);
      assert.equal(boot.saveLabel, '确认位置并批量换封面');
      const text = { ...boot.style, template: 'EP{n2}', size: 30, color: '0xFFFFFF', strokeWidth: 0 };
      const box = { x: 20, y: 160, w: 120, h: 50 };
      const post = (route, body) => fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const preview = await post('render', { box, style: text, template: text.template, episode: 2 });
      assert.equal(preview.status, 200);
      assert.equal(Buffer.from(await preview.arrayBuffer()).subarray(1, 4).toString(), 'PNG');
      const invalid = await post('save', { box: { ...box, y: 240 }, text });
      assert.equal(invalid.status, 500, 'invalid position must not trigger processing');
      await assert.rejects(fs.stat(path.join(dir, '.ectool-cover.json')), { code: 'ENOENT' });
      const save = await post('save', { box, text });
      assert.equal(save.status, 200);
      await save.json();
      assert.equal(await done, 0, errors + output);
      assert.ok(output.includes('2 成功，0 失败'), output);
      assert.equal((output.match(/仅重编码开头/g) || []).length, 2, 'lettering must retain fast GOP copy');
      const saved = JSON.parse(await fs.readFile(path.join(dir, '.ectool-cover.json'), 'utf8'));
      assert.deepEqual(saved.box, box);
      assert.deepEqual(saved.text, text);
      const signatures = [];
      for (const name of ['EP01.mp4', 'EP02.mp4']) {
        const { stdout } = await ff(['-i', path.join(dir, '换封面结果', name), '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
        const countWhite = (y0, y1) => {
          let count = 0;
          for (let y = y0; y < y1; y++) for (let x = 0; x < 160; x++) {
            const i = (y * 160 + x) * 3;
            if (stdout[i] > 180 && stdout[i + 1] > 180 && stdout[i + 2] > 180) count++;
          }
          return count;
        };
        assert.equal(countWhite(0, 150), 0, 'text must not stay at old position');
        assert.ok(countWhite(160, 210) > 50, 'text must be rendered at saved position');
        signatures.push(stdout);
      }
      assert.notDeepEqual(signatures[0], signatures[1], 'each episode must get its own number');
      const unknown = path.join(dir, 'trailer.mp4');
      const unknownOut = path.join(dir, 'unknown-out.mp4');
      await fs.copyFile(source, unknown);
      await assert.rejects(replaceCover({ video: unknown, cover: path.join(dir, '新封面.png'),
        out: unknownOut, lettering: { box, text } }), /无法从视频文件名识别集数/);
      await assert.rejects(fs.stat(unknownOut), { code: 'ENOENT' });
      console.log('PASS: CLI waits for picker; preview, invalid save, saved position/style, distinct episode numbers and fast batch output');
    } finally { clearTimeout(timer); }
  } finally {
    if (child && child.exitCode == null) child.kill();
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
