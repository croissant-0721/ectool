'use strict';
const { spawn } = require('node:child_process');

const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';

// 本机 ffmpeg 构建缺 fontconfig 配置文件，会往 stderr 刷噪音，过滤掉
const NOISE = /^Fontconfig error/;

function exec(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => { err += d; });
    p.once('error', reject);
    p.once('close', code => {
      const stderr = err.split('\n').filter(l => !NOISE.test(l)).join('\n');
      if (code !== 0) {
        const e = new Error(`${bin} 退出码 ${code}\n${stderr.split('\n').slice(-25).join('\n')}`);
        e.stderr = stderr;
        e.exitCode = code;
        return reject(e);
      }
      resolve({ stdout: Buffer.concat(out), stderr });
    });
  });
}

const ff = args => exec(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...args]);
const ffprobe = args => exec(FFPROBE, ['-hide_banner', ...args]);

async function probeJson(args) {
  const { stdout } = await ffprobe(['-v', 'error', '-of', 'json', ...args]);
  return JSON.parse(stdout.toString('utf8') || '{}');
}

// 滤镜图里的值一律用单引号包裹，转义反斜杠与单引号
function esc(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// 组装 filter，跳过 undefined/null/'' 的选项
function filter(name, opts) {
  const body = Object.entries(opts)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}='${esc(v)}'`)
    .join(':');
  return body ? `${name}=${body}` : name;
}

async function checkTools() {
  const missing = [];
  for (const [bin, args] of [[FFMPEG, ['-version']], [FFPROBE, ['-version']]]) {
    try { await exec(bin, args); } catch { missing.push(bin); }
  }
  if (missing.length) throw new Error(`找不到可执行文件: ${missing.join(', ')}（可用 FFMPEG_BIN / FFPROBE_BIN 环境变量指定）`);
}

module.exports = { ff, ffprobe, probeJson, exec, filter, esc, checkTools, FFMPEG, FFPROBE };
