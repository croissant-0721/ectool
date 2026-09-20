'use strict';
const http = require('node:http');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { renderCover, imageSize } = require('./cover');

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

// 只列单 face 的 .ttf —— ffmpeg drawtext 无法选择 .ttc 集合里的字重
async function listFonts(extra) {
  const dirs = ['/System/Library/Fonts/Supplemental', '/System/Library/Fonts',
    path.join(os.homedir(), 'Library/Fonts')];
  const seen = new Map();
  for (const d of dirs) {
    let names = [];
    try { names = await fsp.readdir(d); } catch { continue; }
    for (const n of names) {
      if (!n.toLowerCase().endsWith('.ttf')) continue;
      const p = path.join(d, n);
      if (!seen.has(p)) seen.set(p, { name: n.replace(/\.ttf$/i, ''), path: p });
    }
  }
  const out = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (extra && !seen.has(extra)) out.unshift({ name: path.basename(extra) + '（配置中）', path: extra });
  return out;
}

const readBody = req => new Promise((res, rej) => {
  const c = []; let n = 0;
  req.on('data', d => { n += d.length; if (n > 4e6) { rej(new Error('请求过大')); req.destroy(); } c.push(d); });
  req.on('end', () => res(Buffer.concat(c)));
  req.on('error', rej);
});
const json = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length });
  res.end(b);
};
const renderTpl = (tpl, n) => String(tpl)
  .replace(/\{n(\d)\}/g, (_, w) => String(n).padStart(Number(w), '0'))
  .replace(/\{n\}/g, String(n));

async function startPicker({ cfg, configPath, port = 7788, open = true }) {
  const master = await imageSize(cfg.master);
  const page = await fsp.readFile(path.join(__dirname, 'picker.html'), 'utf8');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ectool-pick-'));
  let seq = 0;

  const bootstrap = {
    configPath,
    master,
    box: cfg.box && cfg.box.anchor === undefined
      ? { x: cfg.box.x, y: cfg.box.y, w: cfg.box.w, h: cfg.box.h }
      : require('./box').resolveBox(cfg.box, master.w, master.h),
    anchor: cfg.box?.anchor || 'bottom-right',
    useAnchor: cfg.box?.anchor !== undefined,
    style: {
      fontFile: cfg.text.fontFile, color: cfg.text.color, size: cfg.text.size,
      fill: cfg.text.fill, align: cfg.text.align, valign: cfg.text.valign,
      strokeWidth: cfg.text.strokeWidth || 0, strokeColor: cfg.text.strokeColor || '0x000000',
    },
    template: cfg.text.template,
    episode: 1,
    fonts: await listFonts(cfg.text.fontFile),
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') {
        const html = page.replace('__BOOTSTRAP__', JSON.stringify(bootstrap));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      if (req.method === 'GET' && url.pathname === '/master') {
        const buf = await fsp.readFile(cfg.master);
        res.writeHead(200, {
          'content-type': MIME[path.extname(cfg.master).toLowerCase()] || 'application/octet-stream',
          'content-length': buf.length, 'cache-control': 'no-store',
        });
        return res.end(buf);
      }
      if (req.method === 'POST' && url.pathname === '/render') {
        const b = JSON.parse((await readBody(req)).toString('utf8'));
        const out = path.join(tmp, `p${++seq}.png`);
        const r = await renderCover({
          master: cfg.master, out, box: b.box,
          text: renderTpl(b.template, b.episode),
          style: b.style, erase: cfg.erase,
        });
        const buf = await fsp.readFile(out);
        await fsp.rm(out, { force: true });
        res.writeHead(200, {
          'content-type': 'image/png', 'content-length': buf.length, 'cache-control': 'no-store',
          'x-render-info': JSON.stringify({ fontSize: r.fontSize, ink: r.ink, drawX: r.drawX, drawY: r.drawY }),
        });
        return res.end(buf);
      }
      if (req.method === 'POST' && url.pathname === '/save') {
        const b = JSON.parse((await readBody(req)).toString('utf8'));
        let raw = {};
        try { raw = JSON.parse(await fsp.readFile(configPath, 'utf8')); } catch {}
        raw.box = b.box;
        // 标记「这部剧的位置由人确认过」——make 靠它区分未配置与已配置
        raw._positionedAt = new Date().toISOString();
        raw.text = { ...(raw.text || {}), ...b.text };
        await fsp.writeFile(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
        return json(res, 200, { ok: true });
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: e.message.split('\n').slice(0, 3).join(' / ') });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const addr = `http://127.0.0.1:${server.address().port}/`;
  if (open) spawn('open', [addr], { stdio: 'ignore', detached: true }).unref();

  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  process.once('exit', cleanup);
  return { server, url: addr, close: () => new Promise(r => server.close(() => (cleanup(), r()))) };
}

module.exports = { startPicker, listFonts };
