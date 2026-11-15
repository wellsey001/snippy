'use strict';

// Plans shared by the editor (a plain script) and the main process: which parts of a
// clip to keep when pauses are cut, and the camera move for auto reframe. Pure maths.

// The parts of [a, b] to keep once the pauses are cut. Each pause keeps `pad` seconds
// at both edges so words aren't clipped, and tiny leftover scraps are dropped.
function keptRanges(a, b, silences, { pad = 0.12, minKeep = 0.2 } = {}) {
  const cuts = silences
    .map((r) => ({ s: r.s <= a + 1e-3 ? a : r.s + pad, e: r.e >= b - 1e-3 ? b : r.e - pad }))
    .filter((r) => r.e - r.s > 0.05)
    .sort((x, y) => x.s - y.s);
  const keep = [];
  let t = a;
  for (const c of cuts) {
    if (c.s > t) keep.push({ s: t, e: c.s });
    t = Math.max(t, c.e);
  }
  if (b > t) keep.push({ s: t, e: b });
  return keep.filter((k) => k.e - k.s >= minKeep);
}


// Moves a timeline time to where it lands after the removed stretches are cut out.
// removed: [{ a, b }] in timeline seconds, sorted. A time inside a removed stretch lands at its start.
function rippleTime(t, removed) {
  let shift = 0;
  for (const r of removed) {
    if (t >= r.b) shift += r.b - r.a;
    else if (t > r.a) return r.a - shift;
    else break;
  }
  return t - shift;
}

// The zoom that makes a picture of aspect srcAspect fill a canvas of aspect canvasAspect,
// and which way the view can move.
function fillFor(srcAspect, canvasAspect) {
  if (srcAspect > canvasAspect * 1.01) return { zoom: srcAspect / canvasAspect, axis: 'x', visible: canvasAspect / srcAspect };
  if (srcAspect < canvasAspect / 1.01) return { zoom: canvasAspect / srcAspect, axis: 'y', visible: srcAspect / canvasAspect };
  return { zoom: 1, axis: null, visible: 1 };
}

// Turns the samples into a calm camera move: smoothed, held still while the person stays
// near the middle, and written as keyframes (t in timeline seconds from the clip's start).
function planReframe(samples, { srcAspect, canvasAspect, in: a, speed = 1, length }) {
  const fill = fillFor(srcAspect, canvasAspect);
  if (!fill.axis) return null;
  const v = fill.visible;
  // Fill gaps where nobody was found with the nearest sighting (or the middle).
  const seen = samples.filter((s) => s.found);
  const pos = samples.map((s) => {
    if (s.found) return s[fill.axis];
    let best = null;
    for (const f of seen) if (!best || Math.abs(f.t - s.t) < Math.abs(best.t - s.t)) best = f;
    return best ? best[fill.axis] : 0.5;
  });
  // Smooth over about 1.5 seconds so the view doesn't twitch.
  const R = Math.max(1, Math.round(samples.length > 1 ? 0.75 / Math.max(1e-3, samples[1].t - samples[0].t) : 1));
  const smooth = pos.map((_, i) => {
    let s = 0; let n = 0;
    for (let k = Math.max(0, i - R); k <= Math.min(pos.length - 1, i + R); k++) { s += pos[k]; n++; }
    return s / n;
  });
  // A virtual camera: it only moves when the person drifts away from the middle of the view.
  const lo = v / 2;
  const hi = 1 - v / 2;
  const clampC = (c) => Math.min(hi, Math.max(lo, c));
  const dead = v * 0.12;
  const keys = [];
  let cam = clampC(smooth[0] ?? 0.5);
  const toPan = (c) => (v >= 0.999 ? 0 : ((c - lo) / (1 - v)) * 2 - 1);
  const tl = (s) => Math.max(0, (s.t - a) / speed);
  keys.push({ t: 0, c: cam });
  for (let i = 1; i < samples.length; i++) {
    const want = clampC(smooth[i]);
    if (Math.abs(want - cam) > dead) {
      const last = keys[keys.length - 1];
      const t = tl(samples[i]);
      // Hold still until just before the move, then glide over about a second.
      const start = Math.max(last.t + 0.05, t - 0.6);
      if (start > last.t + 0.1) keys.push({ t: start, c: cam });
      cam = want;
      keys.push({ t: Math.max(start + 0.3, t + 0.4), c: cam });
    }
  }
  const end = length != null ? length : tl(samples[samples.length - 1] || { t: a });
  const out = keys.filter((k) => k.t <= end + 1e-3);
  if (!out.length || out[out.length - 1].t < end - 0.05) out.push({ t: end, c: cam });
  const z = Number(fill.zoom.toFixed(4));
  return {
    zoom: z,
    keys: out.map((k) => ({
      t: Number(k.t.toFixed(3)), zoom: z,
      panX: fill.axis === 'x' ? Number(toPan(k.c).toFixed(4)) : 0,
      panY: fill.axis === 'y' ? Number(toPan(k.c).toFixed(4)) : 0,
    })),
  };
}



// ---------- speed curves
// A curve is a list of speeds at evenly spaced points through the clip's source footage,
// with straight-line changes in between. Time on the timeline is the integral of 1/speed,
// which has a closed form, so the preview and the export can both map exactly between
// timeline time and source time.

const RAMP_PRESETS = [
  ['montage', 'Montage', [2.5, 0.6, 2.5, 0.6, 2.5]],
  ['hero', 'Hero', [1.5, 1, 0.25, 1, 1.5]],
  ['bullet', 'Bullet', [3, 3, 0.2, 3, 3]],
  ['flashin', 'Flash in', [5, 2, 1, 1, 1]],
  ['flashout', 'Flash out', [1, 1, 1, 2, 5]],
  ['jump', 'Jumper', [0.4, 0.4, 4, 0.4, 0.4]],
];
const RAMP_MIN = 0.1;
const RAMP_MAX = 10;

// speeds: at x = 0, 1/(n-1), …, 1 of the source span L (seconds).
function rampSegs(speeds, L) {
  const n = speeds.length;
  const segs = [];
  let u = 0;
  for (let i = 0; i < n - 1; i++) {
    const t0 = (L * i) / (n - 1);
    const t1 = (L * (i + 1)) / (n - 1);
    const s0 = speeds[i];
    const s1 = speeds[i + 1];
    const b = (s1 - s0) / Math.max(1e-9, t1 - t0);
    const du = Math.abs(b) < 1e-9 ? (t1 - t0) / s0 : Math.log(s1 / s0) / b;
    segs.push({ t0, t1, s0, s1, b, u0: u, u1: u + du });
    u += du;
  }
  return segs;
}
const rampLength = (segs) => (segs.length ? segs[segs.length - 1].u1 : 0);

// Source offset (seconds from the clip's in point) at timeline offset u.
function rampSrcAt(segs, u) {
  let g = segs[segs.length - 1];
  for (const s of segs) if (u <= s.u1) { g = s; break; }
  const du = Math.max(0, Math.min(u, g.u1) - g.u0);
  const tau = Math.abs(g.b) < 1e-9 ? g.t0 + du * g.s0 : g.t0 + (g.s0 * (Math.exp(g.b * du) - 1)) / g.b;
  return Math.min(g.t1, Math.max(g.t0, tau));
}

// Timeline offset at source offset tau.
function rampTimeAt(segs, tau) {
  let g = segs[segs.length - 1];
  for (const s of segs) if (tau <= s.t1) { g = s; break; }
  const d = Math.max(0, Math.min(tau, g.t1) - g.t0);
  return g.u0 + (Math.abs(g.b) < 1e-9 ? d / g.s0 : Math.log((g.s0 + g.b * d) / g.s0) / g.b);
}

function rampSpeedAt(segs, u) {
  const tau = rampSrcAt(segs, u);
  let g = segs[segs.length - 1];
  for (const s of segs) if (tau <= s.t1) { g = s; break; }
  return g.s0 + g.b * (tau - g.t0);
}

// The same mapping as an FFmpeg expression in T (source seconds from the clip start),
// for setpts. No ";" in a filter graph, so it's nested if()s.
function rampExpr(segs) {
  const num = (v) => Number(v).toFixed(6);
  let expr = num(rampLength(segs));
  for (let i = segs.length - 1; i >= 0; i--) {
    const g = segs[i];
    const seg = Math.abs(g.b) < 1e-9
      ? `(${num(g.u0)}+(T-${num(g.t0)})/${num(g.s0)})`
      : `(${num(g.u0)}+log((${num(g.s0)}+${num(g.b)}*(T-${num(g.t0)}))/${num(g.s0)})/${num(g.b)})`;
    expr = `if(lt(T,${num(g.t1)}),${seg},${expr})`;
  }
  return expr;
}

// ---------- tone curves
// Five points at 0, ¼, ½, ¾ and 1 of brightness, joined by a smooth curve that never overshoots
// (monotone cubic). Both the preview and the export use samples of this same curve.

const CURVE_PRESETS = [
  ['none', 'None', [0, 0.25, 0.5, 0.75, 1]],
  ['contrast', 'Punchy', [0, 0.19, 0.5, 0.81, 1]],
  ['soft', 'Soft', [0.04, 0.29, 0.5, 0.71, 0.96]],
  ['matte', 'Matte', [0.12, 0.3, 0.52, 0.76, 0.97]],
  ['bright', 'Brighter', [0, 0.33, 0.6, 0.84, 1]],
  ['moody', 'Moody', [0, 0.17, 0.43, 0.72, 0.95]],
];

function curveAt(ys, x) {
  const n = ys.length;
  const h = 1 / (n - 1);
  const d = ys.slice(1).map((y, i) => (y - ys[i]) / h);
  const m = ys.map((_, i) => (i === 0 ? d[0] : i === n - 1 ? d[n - 2] : (d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2)));
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const r = a * a + b * b;
    if (r > 9) { const t = 3 / Math.sqrt(r); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  const i = Math.min(n - 2, Math.max(0, Math.floor(x / h)));
  const t = (x - i * h) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const y = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  return Math.min(1, Math.max(0, y));
}
const curveSamples = (ys, n = 33) => Array.from({ length: n }, (_, k) => curveAt(ys, k / (n - 1)));
const isFlatCurve = (ys) => !ys || ys.every((y, i) => Math.abs(y - i / (ys.length - 1)) < 1e-3);

// ---------- templates and auto edit

// Cut points on the beat. beats: beat times in seconds from the music's first beat (or null to
// use an even beat at bpm). pattern: how many beats each shot lasts, repeated. Returns shot lengths.
function templateSlots({ beats, bpm = 120, pattern, maxLen }) {
  const interval = 60 / bpm;
  const at = (k) => (beats && k < beats.length ? beats[k] : beats && beats.length ? beats[beats.length - 1] + (k - beats.length + 1) * interval : k * interval);
  const slots = [];
  let k = 0;
  for (let i = 0; i < 400; i++) {
    const next = k + pattern[i % pattern.length];
    if (at(next) > maxLen + 1e-6) break;
    slots.push(at(next) - at(k));
    k = next;
  }
  return slots;
}

// The liveliest moments. sources: [{ id, step, score: [...] }]. Picks one window per shot length
// (longest first), never overlapping and at least minGap apart, then returns them in time order.
function pickHighlights(sources, lens, minGap = 1) {
  const taken = [];
  const free = (id, a, b) => !taken.some((t) => t.id === id && a < t.b + minGap && b > t.a - minGap);
  const order = lens.map((len, i) => ({ len, i })).sort((x, y) => y.len - x.len);
  for (const { len } of order) {
    let best = null;
    for (const src of sources) {
      const n = Math.max(1, Math.round(len / src.step));
      for (let k = 0; k + n <= src.score.length; k++) {
        const a = k * src.step;
        const b = a + len;
        if (!free(src.id, a, b)) continue;
        let sum = 0;
        for (let j = k; j < k + n; j++) sum += src.score[j];
        const v = sum / n;
        if (!best || v > best.v) best = { id: src.id, a, b, v };
      }
    }
    if (best) taken.push(best);
  }
  return taken.sort((x, y) => (x.id === y.id ? x.a - y.a : sources.findIndex((s) => s.id === x.id) - sources.findIndex((s) => s.id === y.id)));
}

// Loudness and movement → one liveliness score per step (each part scaled to its own spread).
function livelyScore(loud, motion) {
  const z = (a) => {
    const m = a.reduce((s, v) => s + v, 0) / (a.length || 1);
    const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length || 1)) || 1;
    return a.map((v) => (v - m) / sd);
  };
  const L = z(loud.map((v) => Math.max(-60, v)));
  const M = z(motion);
  const raw = L.map((v, i) => 0.6 * v + 0.4 * (M[i] || 0));
  return raw.map((_, i) => { let s = 0; let n = 0; for (let j = Math.max(0, i - 1); j <= Math.min(raw.length - 1, i + 1); j++) { s += raw[j]; n++; } return s / n; });
}

if (typeof module !== 'undefined') module.exports = { templateSlots, pickHighlights, livelyScore, CURVE_PRESETS, curveAt, curveSamples, isFlatCurve, keptRanges, rippleTime, fillFor, planReframe, RAMP_PRESETS, RAMP_MIN, RAMP_MAX, rampSegs, rampLength, rampSrcAt, rampTimeAt, rampSpeedAt, rampExpr };
