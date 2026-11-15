'use strict';

// Finding the pauses in a talking clip, and which parts to keep.
// Free of Electron so it can be tested on its own.

const { spawn } = require('child_process');
const { keptRanges } = require('./src/plans');

function ffmpegText(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.on('data', () => {});
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(err.trim().split('\n').slice(-2).join('\n') || `exit ${code}`))));
  });
}

// How much quieter than the clip's speech counts as a pause, by sensitivity.
// The threshold follows each clip's own loudness, so quiet and loud recordings both work.
const BELOW_SPEECH = { gentle: 26, normal: 20, strict: 15 };

// Pauses in src between a and b (source seconds), each { s, e } in source seconds.
async function findSilences(ffmpeg, src, a, b, { minPause = 0.5, sensitivity = 'normal' } = {}) {
  const span = ['-ss', a.toFixed(3), '-t', (b - a).toFixed(3), '-i', src, '-vn', '-ac', '1'];
  // The level speech reaches: the loud end of the clip (95th percentile of 50 ms blocks).
  const stats = await ffmpegText(ffmpeg, ['-hide_banner', '-nostats', ...span,
    '-af', 'aresample=16000,asetnsamples=800,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level', '-f', 'null', '-']);
  const levels = [...stats.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((m) => (m[1] === '-inf' ? -120 : Number(m[1]))).sort((x, y) => x - y);
  if (!levels.length) return [];
  const speech = levels[Math.floor(levels.length * 0.95)];
  const threshold = Math.max(-60, Math.min(-18, speech - (BELOW_SPEECH[sensitivity] || 20)));
  const out = await ffmpegText(ffmpeg, ['-hide_banner', '-nostats', ...span,
    '-af', `silencedetect=noise=${threshold.toFixed(1)}dB:d=${minPause}`, '-f', 'null', '-']);
  const res = [];
  let start = null;
  for (const line of out.split('\n')) {
    let m = line.match(/silence_start: (-?[\d.]+)/);
    if (m) { start = Math.max(0, Number(m[1])); continue; }
    m = line.match(/silence_end: (-?[\d.]+)/);
    if (m && start != null) { res.push({ s: a + start, e: a + Number(m[1]) }); start = null; }
  }
  if (start != null) res.push({ s: a + start, e: b }); // silent to the end
  return res.map((r) => ({ s: Math.max(a, r.s), e: Math.min(b, r.e) })).filter((r) => r.e > r.s);
}

module.exports = { findSilences, keptRanges };
