'use strict';

// Auto reframe: follow the person in a clip so a landscape video can fill a portrait
// (or square) canvas without cutting them off. Free of Electron so it can be tested
// with a stand-in for the person-finding model.

const { spawn } = require('child_process');
const { fillFor, planReframe } = require('./src/plans');

const SAMPLE_W = 256; // frames are looked at small; the model works at about this size anyway

// Where the person is, a couple of times a second. maskFor(rgb, w, h) gives a 0-255 person mask.
// Returns [{ t, x, y, found }] with t in source seconds and x, y as 0-1 fractions of the picture.
function trackSubject({ ffmpeg, src, a, b, srcW, srcH, fps = 2, maskFor, onProgress, isCancelled }) {
  const w = SAMPLE_W;
  const h = Math.max(2, Math.round((SAMPLE_W * srcH) / srcW / 2) * 2);
  const frameBytes = w * h * 3;
  const total = Math.max(1, Math.ceil((b - a) * fps));
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-v', 'error', '-ss', a.toFixed(3), '-t', (b - a).toFixed(3), '-i', src,
      '-vf', `fps=${fps},scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true });
    const out = [];
    let pending = Buffer.alloc(0);
    let busy = Promise.resolve();
    let failed = null;
    let err = '';
    const stop = (e) => { failed = failed || e; try { p.kill('SIGKILL'); } catch { /* gone */ } p.stdout.destroy(); };
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.stdout.on('data', (d) => {
      pending = Buffer.concat([pending, d]);
      while (pending.length >= frameBytes) {
        const frame = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);
        const i = out.length + 1; // frames are queued in order
        out.push(null);
        const slot = out.length - 1;
        p.stdout.pause();
        busy = busy.then(async () => {
          if (failed) return;
          if (isCancelled && isCancelled()) { stop(new Error('cancelled')); return; }
          const mask = await maskFor(new Uint8Array(frame), w, h);
          out[slot] = { t: a + slot / fps, ...headPosition(mask, w, h) };
          if (onProgress) onProgress(Math.min(1, i / total));
        }).catch(stop).finally(() => { if (!failed) p.stdout.resume(); });
      }
    });
    p.on('error', reject);
    p.on('close', (code) => {
      busy.then(() => {
        if (failed) return reject(failed);
        if (code !== 0 && code !== null && !out.length) return reject(new Error(err.trim() || `exit ${code}`));
        resolve(out.filter(Boolean));
      });
    });
  });
}

// The middle of the person's head and shoulders: the top third of the mask, which keeps
// the face in shot even when arms or a second person stretch the whole outline.
function headPosition(mask, w, h) {
  let top = -1;
  let bottom = -1;
  let area = 0;
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) if (mask[y * w + x] > 128) row++;
    if (row > w * 0.01) { if (top < 0) top = y; bottom = y; }
    area += row;
  }
  if (top < 0 || area < w * h * 0.01) return { x: 0.5, y: 0.5, found: false };
  const band = top + Math.max(2, Math.round((bottom - top) * 0.35));
  let sx = 0; let sy = 0; let n = 0;
  for (let y = top; y <= band; y++) {
    for (let x = 0; x < w; x++) {
      const m = mask[y * w + x];
      if (m > 128) { sx += x * m; sy += y * m; n += m; }
    }
  }
  return { x: (sx / n + 0.5) / w, y: (sy / n + 0.5) / h, found: true };
}

module.exports = { trackSubject, headPosition, fillFor, planReframe };
