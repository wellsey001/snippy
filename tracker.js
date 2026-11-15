'use strict';

// Motion tracking: follows a box you draw on the video from frame to frame, so a sticker, text
// or overlay can move with it. FFmpeg hands over small grey frames; each frame the box's picture
// is looked for near where it was (allowing for it getting a little bigger or smaller), and
// slowly updated so it keeps up with gradual changes. Free of Electron so it can be tested alone.

const { spawn } = require('child_process');

const WORK_W = 320; // frames are tracked at this width: plenty for following things, and quick

// Picks sample points over the box (about 600 of them, whatever its size).
function samplePattern(tw, th) {
  const step = Math.max(1, Math.floor(Math.sqrt((tw * th) / 600)));
  const pts = [];
  for (let y = -th / 2; y <= th / 2; y += step) for (let x = -tw / 2; x <= tw / 2; x += step) pts.push([x, y]);
  return pts;
}

function sampleAt(frame, W, H, pts, cx, cy, s, out) {
  for (let i = 0; i < pts.length; i++) {
    let x = Math.round(cx + pts[i][0] * s);
    let y = Math.round(cy + pts[i][1] * s);
    if (x < 0) x = 0; else if (x >= W) x = W - 1;
    if (y < 0) y = 0; else if (y >= H) y = H - 1;
    out[i] = frame[y * W + x];
  }
  return out;
}

// Zero-mean normalised correlation: 1 = the same picture, ~0 = unrelated. Ignores brightness changes.
function zncc(a, b) {
  const n = a.length;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  if (da < 1e-6 || db < 1e-6) return 0;
  return num / Math.sqrt(da * db);
}

// Tracks through frames (an array or async iterable of Uint8Array grey frames, W×H).
// box: { x, y, w, h } as shares of the frame (x, y = top-left). Returns { points, lost }.
// Each point: { i (frame number), x, y (centre, shares of the frame), s (size compared with the start), score }.
async function trackFrames(frames, W, H, box, { onFrame, isCancelled } = {}) {
  const tw = Math.max(8, box.w * W);
  const th = Math.max(8, box.h * H);
  const pts = samplePattern(tw, th);
  const tmpl = new Float32Array(pts.length);
  const buf = new Float32Array(pts.length);
  let cx = (box.x + box.w / 2) * W;
  let cy = (box.y + box.h / 2) * H;
  let s = 1;
  let vx = 0;
  let vy = 0;
  const points = [];
  let lost = false;
  let i = 0;
  for await (const frame of frames) {
    if (isCancelled && isCancelled()) throw new Error('cancelled');
    if (i === 0) {
      sampleAt(frame, W, H, pts, cx, cy, s, tmpl);
      points.push({ i, x: cx / W, y: cy / H, s, score: 1 });
    } else {
      // Look around where it should be by now, coarse then fine.
      const px = cx + vx;
      const py = cy + vy;
      const R = Math.min(48, Math.max(8, Math.round(0.6 * Math.max(tw, th) * s)));
      let best = { score: -2, x: px, y: py, s };
      for (let dy = -R; dy <= R; dy += 2) {
        for (let dx = -R; dx <= R; dx += 2) {
          const sc = zncc(tmpl, sampleAt(frame, W, H, pts, px + dx, py + dy, s, buf));
          if (sc > best.score) best = { score: sc, x: px + dx, y: py + dy, s };
        }
      }
      const coarse = best;
      for (const ss of [s * 0.95, s, s * 1.05]) {
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const sc = zncc(tmpl, sampleAt(frame, W, H, pts, coarse.x + dx, coarse.y + dy, ss, buf));
            if (sc > best.score) best = { score: sc, x: coarse.x + dx, y: coarse.y + dy, s: ss };
          }
        }
      }
      if (best.score < 0.35) { lost = true; break; }
      vx = 0.6 * (best.x - cx) + 0.4 * vx;
      vy = 0.6 * (best.y - cy) + 0.4 * vy;
      cx = best.x;
      cy = best.y;
      s = Math.min(4, Math.max(0.25, best.s));
      // Keep up with slow changes (turning, light) without drifting off on to the background.
      if (best.score > 0.7) {
        sampleAt(frame, W, H, pts, cx, cy, s, buf);
        for (let k = 0; k < tmpl.length; k++) tmpl[k] = 0.9 * tmpl[k] + 0.1 * buf[k];
      }
      points.push({ i, x: cx / W, y: cy / H, s, score: best.score });
    }
    i++;
    if (onFrame) onFrame(i);
  }
  return { points, lost };
}

// Grey frames straight from FFmpeg, one at a time.
async function* ffmpegFrames(ffmpeg, src, a, b, fps, W, H, onProc) {
  const p = spawn(ffmpeg, ['-v', 'error', '-ss', a.toFixed(3), '-to', b.toFixed(3), '-i', src,
    '-vf', `fps=${fps},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'], { windowsHide: true });
  if (onProc) onProc(p);
  const size = W * H;
  let pending = Buffer.alloc(0);
  let err = '';
  p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  const done = new Promise((resolve) => p.on('close', resolve));
  try {
    for await (const chunk of p.stdout) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= size) {
        yield new Uint8Array(pending.subarray(0, size));
        pending = pending.subarray(size);
      }
    }
    const code = await done;
    if (code !== 0 && code !== null) throw new Error(err.trim().split('\n').pop() || `FFmpeg stopped (${code})`);
  } finally {
    if (p.exitCode === null) p.kill();
  }
}

// Tracks box (shares of the source picture) from source time a to b.
// Returns { points: [{ t, x, y, s }], lost, lostAt }.
async function trackRegion({ ffmpeg, src, a, b, box, srcW, srcH, fps = 15, onProgress, isCancelled }) {
  const W = WORK_W;
  const H = Math.max(2, Math.round((WORK_W * (srcH || 9)) / (srcW || 16) / 2) * 2);
  const total = Math.max(1, Math.round((b - a) * fps));
  let proc = null;
  const frames = ffmpegFrames(ffmpeg, src, a, b, fps, W, H, (p) => { proc = p; });
  try {
    const r = await trackFrames(frames, W, H, box, {
      isCancelled,
      onFrame: (n) => { if (onProgress && n % 3 === 0) onProgress(Math.min(1, n / total)); },
    });
    const points = r.points.map((p) => ({ t: Number((a + p.i / fps).toFixed(4)), x: Number(p.x.toFixed(5)), y: Number(p.y.toFixed(5)), s: Number(p.s.toFixed(4)) }));
    return { points, lost: r.lost, lostAt: r.lost && points.length ? points[points.length - 1].t : null };
  } finally {
    if (proc && proc.exitCode === null) proc.kill();
  }
}

// Fewer keyframes for the same path: drops points that lie (nearly) on the line between their
// neighbours. Ramer–Douglas–Peucker over x, y and size; tol is in shares of the frame.
function thinPath(points, tol = 0.002) {
  if (points.length < 3) return points.slice();
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const a = points[i];
    const b = points[j];
    let worst = 0;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const q = (points[k].t - a.t) / Math.max(1e-6, b.t - a.t);
      const e = Math.max(
        Math.abs(points[k].x - (a.x + (b.x - a.x) * q)),
        Math.abs(points[k].y - (a.y + (b.y - a.y) * q)),
        Math.abs(points[k].s - (a.s + (b.s - a.s) * q)) * 0.05,
      );
      if (e > worst) { worst = e; at = k; }
    }
    if (worst > tol && at > 0) { keep[at] = true; stack.push([i, at], [at, j]); }
  }
  return points.filter((_, k) => keep[k]);
}

module.exports = { trackFrames, trackRegion, thinPath, zncc, WORK_W };
