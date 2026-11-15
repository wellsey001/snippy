'use strict';

// Keyframes: an item's values at chosen moments, with smooth (ease in and out)
// movement between them. Times are seconds from the item's own start.
// Shared by the editor (a plain script) and the export (required by main.js).

const KF_PROPS = {
  overlay: ['x', 'y', 'w', 'opacity'],
  sticker: ['x', 'y', 'size', 'rotate'],
  // Main video: size (zoom, 1 = fits the canvas), centre offset as a share of the canvas, and turn in degrees.
  // plus the mask's centre (mx, my) and height (ms), as shares of the picture.
  clip: ['zoom', 'posX', 'posY', 'rotate', 'mx', 'my', 'ms'],
  // Text: offset from where its position setting puts it, size multiplier, turn and opacity.
  text: ['dx', 'dy', 'scale', 'rotate', 'opacity'],
  audio: ['volume'],
};
const KF_DEFAULTS = { zoom: 1, posX: 0, posY: 0, rotate: 0, opacity: 1, dx: 0, dy: 0, scale: 1, volume: 1, mx: 0.5, my: 0.5, ms: 0.5 };

const kfEase = (q) => { const v = Math.min(1, Math.max(0, q)); return v * v * (3 - 2 * v); };
const baseValue = (item, p) => (item[p] ?? KF_DEFAULTS[p] ?? 0);
const keyValue = (item, k, p) => (k[p] ?? baseValue(item, p));

// The item's values at time u (seconds from its start).
function kfValue(item, kind, u) {
  const out = {};
  for (const p of KF_PROPS[kind]) out[p] = baseValue(item, p);
  const keys = item.keys;
  if (!keys || !keys.length) return out;
  let i = 0;
  while (i < keys.length - 1 && u >= keys[i + 1].t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  for (const p of KF_PROPS[kind]) {
    if (!b || u <= a.t) out[p] = keyValue(item, a, p);
    else {
      // Keyframes from motion tracking move at a steady pace; the rest ease in and out.
      const q = Math.min(1, Math.max(0, (u - a.t) / (b.t - a.t)));
      out[p] = keyValue(item, a, p) + (keyValue(item, b, p) - keyValue(item, a, p)) * (a.lin ? q : kfEase(q));
    }
  }
  return out;
}

// Projects from before 0.31 stored the main video's zoom with a pan from -1 to 1 across the
// spare room. Now it's a centre offset (a share of the canvas), so the video can move anywhere.
function migrateMotion(item) {
  if (!item) return item;
  const z0 = item.zoom ?? 1;
  const conv = (o, z) => {
    if (o.panX == null && o.panY == null) return;
    if (o.panX != null) o.posX = Number((-(z - 1) * o.panX / 2).toFixed(5));
    if (o.panY != null) o.posY = Number((-(z - 1) * o.panY / 2).toFixed(5));
    delete o.panX;
    delete o.panY;
  };
  conv(item, z0);
  for (const k of item.keys || []) conv(k, k.zoom ?? z0);
  return item;
}

const hasMotion = (item) => Boolean(item.keys && item.keys.length > 1);

// The same curve as an FFmpeg expression in the time expression U.
// (No ";" allowed inside a filter graph, so the easing is written out in full.)
function kfExpr(item, prop, U) {
  const keys = item.keys || [];
  const num = (v) => Number(v).toFixed(5);
  if (keys.length < 2) return num(keys.length ? keyValue(item, keys[0], prop) : baseValue(item, prop));
  let expr = num(keyValue(item, keys[keys.length - 1], prop));
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i];
    const b = keys[i + 1];
    const va = keyValue(item, a, prop);
    const vb = keyValue(item, b, prop);
    const q = `clip((${U}-${num(a.t)})/${num(Math.max(1e-3, b.t - a.t))},0,1)`;
    const seg = a.lin ? `(${num(va)}+(${num(vb - va)})*${q})` : `(${num(va)}+(${num(vb - va)})*(${q}*${q}*(3-2*${q})))`;
    expr = `if(lt(${U},${num(b.t)}),${seg},${expr})`;
  }
  return expr;
}

// Largest value a property reaches (for sizing a box that an animated overlay fits in).
function kfMax(item, prop) {
  const vals = [baseValue(item, prop), ...(item.keys || []).map((k) => keyValue(item, k, prop))];
  return Math.max(...vals);
}

if (typeof module !== 'undefined') module.exports = { KF_PROPS, kfValue, kfExpr, kfMax, hasMotion, migrateMotion };
