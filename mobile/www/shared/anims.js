'use strict';

// Clip animations: how a clip (video or photo) comes in, goes out, and moves while it's on screen.
// Shared by the desktop editor, its export and the phone app (window.SnippyAnims or require).
// Each one is a few formulas, written once and turned into both JavaScript (for the preview)
// and an FFmpeg expression (for the export), so the two always match.
//
// Formulas give z (size, multiplied), x and y (move, in shares of the frame width/height, added)
// and r (turn, degrees, added). They use:
//   q   progress through the animation, 0 to 1 (for "in": 0 at the start of the clip;
//       for "out": 0 when it starts leaving, 1 at the end)
//   p   how far from resting it is, with easing: in, 1 → 0 (fast then gentle); out, 0 → 1
//   t   seconds since the clip started, L the clip's length, k the strength (0 to 1)
// Functions: sin cos exp abs min max pow sqrt floor mod and clip(x, lo, hi). PI is pi.
// fade: true fades it in (or out) over the same time, through black.

(function () {
  const IN = [
    { id: 'fade', name: 'Fade', fade: true },
    { id: 'zoomin', name: 'Zoom in', z: '1-0.45*p', fade: true },
    { id: 'zoomout', name: 'Zoom out', z: '1+0.6*p', fade: true },
    { id: 'pop', name: 'Pop', z: '1+2.70158*pow(q-1,3)+1.70158*pow(q-1,2)' },
    { id: 'left', name: 'Slide from left', x: '-p' },
    { id: 'right', name: 'Slide from right', x: 'p' },
    { id: 'up', name: 'Rise up', y: 'p' },
    { id: 'down', name: 'Drop down', y: '-p' },
    { id: 'spin', name: 'Spin in', r: '-180*p', z: '1-0.7*p', fade: true },
    { id: 'swing', name: 'Swing in', r: '25*p*cos(q*PI*1.5)', z: '1-0.2*p', fade: true },
    { id: 'whip', name: 'Whip', x: '1.2*p*p', z: '1+0.25*p' },
    { id: 'bounce', name: 'Bounce', y: '-0.35*abs(cos(q*PI*1.75))*pow(1-q,2)' },
  ];
  const OUT = [
    { id: 'fade', name: 'Fade', fade: true },
    { id: 'zoomin', name: 'Zoom in', z: '1+0.6*p', fade: true },
    { id: 'zoomout', name: 'Zoom out', z: '1-0.45*p', fade: true },
    { id: 'left', name: 'Slide left', x: '-p' },
    { id: 'right', name: 'Slide right', x: 'p' },
    { id: 'up', name: 'Fly up', y: '-p' },
    { id: 'down', name: 'Drop away', y: 'p' },
    { id: 'spin', name: 'Spin out', r: '180*p', z: '1-0.7*p', fade: true },
    { id: 'whip', name: 'Whip', x: '-1.2*p*p', z: '1+0.25*p' },
  ];
  const LOOP = [
    { id: 'kenin', name: 'Slow zoom in', z: '1+0.18*k*clip(t/L,0,1)', still: true },
    { id: 'kenout', name: 'Slow zoom out', z: '1+0.18*k*(1-clip(t/L,0,1))', still: true },
    { id: 'panl', name: 'Pan left', z: '1+0.16*k', x: '0.07*k*(1-2*clip(t/L,0,1))', still: true },
    { id: 'panr', name: 'Pan right', z: '1+0.16*k', x: '-0.07*k*(1-2*clip(t/L,0,1))', still: true },
    { id: 'shake', name: 'Shake', z: '1+0.05*k', x: '0.012*k*sin(t*41)+0.006*k*sin(t*67)', y: '0.01*k*cos(t*37)+0.005*k*sin(t*59)' },
    { id: 'quake', name: 'Earthquake', z: '1+0.1*k', x: '0.03*k*sin(t*53)', y: '0.025*k*sin(t*47+1)', r: '1.2*k*sin(t*29)' },
    { id: 'pulse', name: 'Pulse', z: '1+0.05*k*(0.5+0.5*sin(t*2*PI/0.6))' },
    { id: 'heartbeat', name: 'Heartbeat', z: '1+0.07*k*exp(-mod(t,0.8)*9)+0.04*k*exp(-mod(t+0.6,0.8)*12)' },
    { id: 'rock', name: 'Rock', z: '1+0.08*k', r: '3*k*sin(t*2.4)' },
    { id: 'float', name: 'Float', z: '1+0.06*k', y: '0.015*k*sin(t*1.6)', x: '0.008*k*sin(t*1.1)' },
    { id: 'swirl', name: 'Swirl', z: '1+0.12*k', r: '2*k*sin(t*1.3)', x: '0.02*k*cos(t*1.3)', y: '0.02*k*sin(t*1.3)' },
    { id: 'jolt', name: 'Jolt', z: '1+0.12*k*exp(-mod(t,0.5)*14)', x: '0.02*k*exp(-mod(t,0.5)*14)*sin(t*90)' },
  ];
  const LISTS = { in: IN, out: OUT, loop: LOOP };
  const find = (kind, id) => (LISTS[kind] || []).find((a) => a.id === id) || null;
  const DEFAULT_DUR = 0.5;
  const DEFAULT_K = 0.7;

  // ----- turning a formula into JavaScript
  const cache = new Map();
  function jsFn(expr) {
    if (!cache.has(expr)) {
      const body = expr.replace(/\bclip\(/g, 'clamp_(').replace(/\bPI\b/g, 'Math.PI')
        .replace(/\b(sin|cos|exp|abs|min|max|pow|sqrt|floor)\(/g, 'Math.$1(').replace(/\bmod\(/g, 'mod_(');
      // eslint-disable-next-line no-new-func
      cache.set(expr, new Function('q', 'p', 't', 'L', 'k', 'clamp_', 'mod_', `return (${body});`));
    }
    return cache.get(expr);
  }
  const clamp_ = (v, a, b) => Math.max(a, Math.min(b, v));
  const mod_ = (a, b) => ((a % b) + b) % b;

  // The clip's animation state at clip time u (seconds), for a clip L seconds long.
  // Returns { z, x, y, r, a } (a: how visible it is, 0 to 1).
  function at(c, u, L) {
    const out = { z: 1, x: 0, y: 0, r: 0, a: 1 };
    if (!c) return out;
    const apply = (def, q, p, k) => {
      if (!def) return;
      if (def.z) out.z *= jsFn(def.z)(q, p, u, L, k, clamp_, mod_);
      if (def.x) out.x += jsFn(def.x)(q, p, u, L, k, clamp_, mod_);
      if (def.y) out.y += jsFn(def.y)(q, p, u, L, k, clamp_, mod_);
      if (def.r) out.r += jsFn(def.r)(q, p, u, L, k, clamp_, mod_);
    };
    const span = (d) => Math.max(0.05, Math.min(d || DEFAULT_DUR, L / 2));
    if (c.animIn) {
      const d = span(c.animIn.d);
      const q = clamp_(u / d, 0, 1);
      const def = find('in', c.animIn.id);
      apply(def, q, (1 - q) ** 3, 1);
      if (def && def.fade) out.a *= q;
    }
    if (c.animOut) {
      const d = span(c.animOut.d);
      const q = clamp_((u - (L - d)) / d, 0, 1);
      const def = find('out', c.animOut.id);
      apply(def, q, q ** 3, 1);
      if (def && def.fade) out.a *= 1 - q;
    }
    if (c.animLoop) apply(find('loop', c.animLoop.id), 0, 0, c.animLoop.k ?? DEFAULT_K);
    return out;
  }
  const has = (c) => Boolean(c && (c.animIn || c.animOut || c.animLoop));

  // ----- the same, as FFmpeg expressions in the time expression T (seconds since the clip started)
  const num = (v) => Number(v).toFixed(5);
  function ffSub(expr, vars) {
    let e = expr;
    for (const [k, v] of Object.entries(vars)) e = e.replace(new RegExp(`\\b${k}\\b`, 'g'), `(${v})`);
    return e;
  }
  // Returns { z, x, y, r } expressions (or null when the clip has no animation), plus the fades:
  // { fadeIn: seconds | 0, fadeOut: { st, d } | null }.
  function ffExprs(c, L, T = 't') {
    if (!has(c)) return null;
    const parts = { z: [], x: [], y: [], r: [] };
    const span = (d) => Math.max(0.05, Math.min(d || DEFAULT_DUR, L / 2));
    const add = (def, q, p, k) => {
      if (!def) return;
      for (const prop of ['z', 'x', 'y', 'r']) {
        if (def[prop]) parts[prop].push(ffSub(def[prop], { q, p, t: T, L: num(L), k: num(k), PI: 'PI' }).replace(/\(PI\)/g, 'PI'));
      }
    };
    let fadeIn = 0;
    let fadeOut = null;
    if (c.animIn) {
      const d = span(c.animIn.d);
      const q = `clip(${T}/${num(d)},0,1)`;
      const def = find('in', c.animIn.id);
      add(def, q, `pow(1-${q},3)`, 1);
      if (def && def.fade) fadeIn = d;
    }
    if (c.animOut) {
      const d = span(c.animOut.d);
      const q = `clip((${T}-${num(L - d)})/${num(d)},0,1)`;
      const def = find('out', c.animOut.id);
      add(def, q, `pow(${q},3)`, 1);
      if (def && def.fade) fadeOut = { st: L - d, d };
    }
    if (c.animLoop) add(find('loop', c.animLoop.id), '0', '0', c.animLoop.k ?? DEFAULT_K);
    const join = (list, op, base) => (list.length ? list.map((e) => `(${e})`).join(op) : base);
    return { z: join(parts.z, '*', '1'), x: join(parts.x, '+', '0'), y: join(parts.y, '+', '0'), r: join(parts.r, '+', '0'), fadeIn, fadeOut };
  }

  const api = { IN, OUT, LOOP, LISTS, find, at, has, ffExprs, DEFAULT_DUR, DEFAULT_K };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SnippyAnims = api;
}());
