// Copied from beats.js by mobile/scripts/sync-shared.js. Don't edit here.
(function () {
const module = { exports: {} };
'use strict';

// Beat finding for music: an onset envelope (how suddenly the sound gets louder,
// weighted towards the kick drum), a tempo from its autocorrelation, then beats
// tracked through the song. Pure JavaScript, no Electron, so it can be tested alone.

const HOP = 256; // samples between envelope points

// Two-pole low-pass filter, used to pull out the kick and bass.
function lowpass(x, sr, fc) {
  const w = (2 * Math.PI * fc) / sr;
  const q = Math.SQRT1_2;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  const b0 = (1 - cos) / 2, b1 = 1 - cos, b2 = (1 - cos) / 2;
  const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

function logEnergy(x, hop) {
  const n = Math.floor(x.length / hop);
  const e = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) s += x[i] * x[i];
    e[f] = Math.log(1e-9 + s / hop);
  }
  return e;
}

function onsetEnvelope(samples, sr) {
  const low = logEnergy(lowpass(samples, sr, 160), HOP);
  const full = logEnergy(samples, HOP);
  const n = low.length;
  const env = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    env[i] = Math.max(0, low[i] - low[i - 1]) + 0.5 * Math.max(0, full[i] - full[i - 1]);
  }
  // Subtract a local average so steady loud parts don't count as onsets.
  const out = new Float32Array(n);
  const w = 8;
  let max = 0;
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) { s += env[j]; c++; }
    out[i] = Math.max(0, env[i] - s / c);
    if (out[i] > max) max = out[i];
  }
  if (max > 0) for (let i = 0; i < n; i++) out[i] /= max;
  return out;
}

// Tempo between 70 and 180 BPM, gently preferring values near 115 (where most pop music sits).
function findPeriod(env, fps) {
  let best = null;
  const minLag = Math.floor((60 / 180) * fps);
  const maxLag = Math.ceil((60 / 70) * fps);
  const score = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 115) / 0.9) ** 2);
    score[lag] = s * prior;
    if (!best || score[lag] > best.s) best = { lag, s: score[lag] };
  }
  if (!best || best.s <= 0) return null;
  // Refine between neighbouring lags for a non-whole-number period.
  const l = best.lag;
  const a = score[l - 1] ?? score[l];
  const c = score[l + 1] ?? score[l];
  const denom = a - 2 * score[l] + c;
  const shift = denom ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
  return l + shift;
}

function trackBeats(env, period) {
  // Where the beat grid lines up best with the onsets.
  let bestPhase = 0, bestSum = -1;
  for (let ph = 0; ph < period; ph += 0.25) {
    let s = 0;
    for (let t = ph; t < env.length; t += period) s += env[Math.round(t)] || 0;
    if (s > bestSum) { bestSum = s; bestPhase = ph; }
  }
  // Follow the beat through the song, letting each one move slightly onto the nearest onset.
  const beats = [];
  const strong = [];
  const power = [];
  let t = bestPhase;
  while (t < env.length) {
    const win = Math.max(1, Math.round(period * (beats.length ? 0.12 : 0.25))); // wider for the first beat
    const c = Math.round(t);
    let bi = c, bv = -1;
    for (let j = Math.max(0, c - win); j <= Math.min(env.length - 1, c + win); j++) {
      const v = env[j] * (1 - (0.5 * Math.abs(j - c)) / (win + 1));
      if (v > bv) { bv = v; bi = j; }
    }
    const hit = bv > 0.15;
    const at = hit ? bi : c;
    beats.push(at);
    strong.push(hit);
    power.push(Math.max(0, env[at] || 0));
    t = at + period;
  }
  return { beats, strong, power };
}

// Steadies the beats. Busy music (vocals, fills, guitar between the drums) pulls single beats a
// few hundredths of a second early or late, and cuts placed on them feel off. Each beat is moved
// onto a straight line through the beats around it (eight either side, the ones that landed on
// a real hit, ignoring any far off the line), so the grid stays even but still follows a song
// that speeds up or slows down.
function steady(times, strong, period) {
  const W = 8;
  return times.map((t, i) => {
    let pts = [];
    for (let j = Math.max(0, i - W); j <= Math.min(times.length - 1, i + W); j++) if (strong[j]) pts.push([j, times[j]]);
    for (let pass = 0; pass < 2; pass++) {
      if (pts.length < 5) return Number(t.toFixed(4));
      const n = pts.length;
      const mx = pts.reduce((a, p) => a + p[0], 0) / n;
      const my = pts.reduce((a, p) => a + p[1], 0) / n;
      let sxy = 0; let sxx = 0;
      for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
      const slope = sxx ? sxy / sxx : period;
      const at = (x) => my + slope * (x - mx);
      if (pass === 0) { pts = pts.filter(([x, y]) => Math.abs(y - at(x)) < period * 0.08); continue; }
      // Keep a beat where it is if the line is far from it (a real change in the music).
      const fit = at(i);
      return Number((Math.abs(fit - t) < period * 0.2 ? fit : t).toFixed(4));
    }
    return Number(t.toFixed(4));
  });
}

function detectBeats(samples, sr) {
  const fps = sr / HOP;
  const env = onsetEnvelope(samples, sr);
  if (env.length < fps * 3) return { bpm: 0, beats: [] }; // under 3 seconds: too short to tell
  let period = findPeriod(env, fps);
  if (!period) return { bpm: 0, beats: [] };
  let tr = trackBeats(env, period);
  // Refine the tempo from the gaps between beats that landed on real onsets, then track again.
  const gaps = [];
  for (let i = 1; i < tr.beats.length; i++) if (tr.strong[i] && tr.strong[i - 1]) gaps.push(tr.beats[i] - tr.beats[i - 1]);
  if (gaps.length >= 4) {
    const first = tr.beats.findIndex((b, i) => tr.strong[i]);
    const last = tr.beats.length - 1 - [...tr.strong].reverse().indexOf(true);
    const span = last > first ? (tr.beats[last] - tr.beats[first]) / (last - first) : period;
    if (Math.abs(span - period) / period < 0.05) { period = span; tr = trackBeats(env, period); }
  }
  // How hard each beat hits (0 to 1, the strongest being 1), for effects on the big ones.
  const top = Math.max(1e-9, ...tr.power);
  // Each beat is reported at the middle of its envelope step (the hit lands somewhere inside it).
  const times = steady(tr.beats.map((b) => (b + 0.5) / fps), tr.strong, period / fps);
  return { bpm: Math.round((600 * fps) / period) / 10, beats: times, strength: tr.power.map((v) => Number((v / top).toFixed(3))) };
}

module.exports = { detectBeats };

window.SnippyBeats = module.exports;
}());
