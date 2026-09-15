'use strict';

const ANCHORS = [
  'top-left', 'top', 'top-right',
  'left', 'center', 'right',
  'bottom-left', 'bottom', 'bottom-right',
];

// 数值或 "20%" 字符串；百分比按给定基准换算
function unit(v, basis, label) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = v.trim().match(/^(-?[\d.]+)\s*%$/);
    if (m) return (Number(m[1]) / 100) * basis;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  throw new Error(`${label} 必须是数字或百分比字符串（如 "12%"），收到 ${JSON.stringify(v)}`);
}

const H_OF = { 'top-left': 'left', left: 'left', 'bottom-left': 'left',
  top: 'center', center: 'center', bottom: 'center',
  'top-right': 'right', right: 'right', 'bottom-right': 'right' };
const V_OF = { 'top-left': 'top', top: 'top', 'top-right': 'top',
  left: 'middle', center: 'middle', right: 'middle',
  'bottom-left': 'bottom', bottom: 'bottom', 'bottom-right': 'bottom' };

// 把配置里的 box 解析成绝对像素。支持两种写法：
//   { x, y, w, h }                                     绝对坐标
//   { anchor, margin:{x,y}, size:{w,h} }               锚点 + 边距（可用百分比）
function resolveBox(box, W, H) {
  if (!box || typeof box !== 'object') throw new Error('box 必填');
  if (box.anchor === undefined) {
    const r = {
      x: unit(box.x, W, 'box.x'), y: unit(box.y, H, 'box.y'),
      w: unit(box.w, W, 'box.w'), h: unit(box.h, H, 'box.h'),
    };
    return round(r);
  }
  if (!ANCHORS.includes(box.anchor)) {
    throw new Error(`box.anchor 只能是 ${ANCHORS.join(' / ')}，收到 ${box.anchor}`);
  }
  const size = box.size || {};
  const margin = box.margin || {};
  const w = unit(size.w ?? box.w, W, 'box.size.w');
  const h = unit(size.h ?? box.h, H, 'box.size.h');
  const mx = unit(margin.x ?? 0, W, 'box.margin.x');
  const my = unit(margin.y ?? 0, H, 'box.margin.y');

  let x;
  switch (H_OF[box.anchor]) {
    case 'left': x = mx; break;
    case 'right': x = W - w - mx; break;
    default: x = (W - w) / 2 + mx;
  }
  let y;
  switch (V_OF[box.anchor]) {
    case 'top': y = my; break;
    case 'bottom': y = H - h - my; break;
    default: y = (H - h) / 2 + my;
  }
  return round({ x, y, w, h });
}

const round = r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });

// 反解：绝对像素 -> 指定锚点下的 margin，供拖框器输出锚点写法
function toAnchor(abs, anchor, W, H, { percent = false } = {}) {
  if (!ANCHORS.includes(anchor)) throw new Error(`未知锚点 ${anchor}`);
  let mx;
  switch (H_OF[anchor]) {
    case 'left': mx = abs.x; break;
    case 'right': mx = W - abs.w - abs.x; break;
    default: mx = abs.x - (W - abs.w) / 2;
  }
  let my;
  switch (V_OF[anchor]) {
    case 'top': my = abs.y; break;
    case 'bottom': my = H - abs.h - abs.y; break;
    default: my = abs.y - (H - abs.h) / 2;
  }
  const pc = (v, basis) => `${(Math.round((v / basis) * 10000) / 100)}%`;
  return percent
    ? { anchor, margin: { x: pc(mx, W), y: pc(my, H) }, size: { w: pc(abs.w, W), h: pc(abs.h, H) } }
    : { anchor, margin: { x: Math.round(mx), y: Math.round(my) }, size: { w: abs.w, h: abs.h } };
}

module.exports = { resolveBox, toAnchor, ANCHORS, H_OF, V_OF };
