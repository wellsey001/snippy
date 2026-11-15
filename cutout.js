'use strict';

// Background removal: decode frames, ask `maskFor` for a person mask per frame,
// and let FFmpeg use those masks as the alpha channel of a new file.
// Videos become WebM (VP9 with alpha), photos become PNG. Free of Electron so it
// can be tested with a stand-in mask.

const { spawn } = require('child_process');

const MASK_WIDTH = 512; // the model works at about this size, so frames are decoded small
const FPS = 30;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(err.trim().split('\n').slice(-2).join('\n') || `exit ${code}`))));
  });
}

// Size of the video as it is shown, after any rotation from a phone.
async function displayedSize(ffprobe, src) {
  const raw = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', src]);
  const info = JSON.parse(raw.toString());
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  if (!v) throw new Error('This file has no picture.');
  let rot = Number((v.tags && v.tags.rotate) || 0);
  for (const sd of v.side_data_list || []) if (sd.rotation != null) rot = Number(sd.rotation);
  const turned = Math.abs(rot) % 180 === 90;
  const duration = parseFloat((info.format && info.format.duration) || v.duration) || 0;
  return { w: turned ? v.height : v.width, h: turned ? v.width : v.height, duration };
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

async function cutoutImage({ ffmpeg, ffprobe, src, out, maskFor }) {
  const { w: sw, h: sh } = await displayedSize(ffprobe, src);
  const w = even(Math.min(sw, 2048));
  const h = even((sh * w) / sw);
  const rgb = await run(ffmpeg, ['-v', 'error', '-i', src, '-frames:v', '1', '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  const mask = Buffer.from(await maskFor(rgb, w, h));
  await new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, [
      '-y', '-v', 'error', '-i', src, '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-i', 'pipe:0',
      '-filter_complex', `[0:v]scale=${w}:${h},format=rgba[c];[1:v]format=gray[m];[c][m]alphamerge[v]`,
      '-map', '[v]', '-frames:v', '1', out,
    ], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `exit ${code}`))));
    p.stdin.end(mask);
  });
  return out;
}

async function cutoutVideo({ ffmpeg, ffprobe, src, out, maskFor, onProgress, isCancelled }) {
  const { w: sw, h: sh, duration } = await displayedSize(ffprobe, src);
  const w = even(Math.min(MASK_WIDTH, sw));
  const h = even((sh * w) / sw);
  const frameBytes = w * h * 3;
  const total = Math.max(1, Math.round(duration * FPS));

  // Small frames for the model...
  const dec = spawn(ffmpeg, ['-v', 'error', '-i', src, '-vf', `fps=${FPS},scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true });
  // ...and the full-size picture, joined with the masks as they arrive.
  const enc = spawn(ffmpeg, [
    '-y', '-v', 'error', '-i', src,
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-r', String(FPS), '-i', 'pipe:0',
    '-filter_complex', `[0:v]fps=${FPS},format=yuva420p[c];[1:v]format=gray[m];[m][c]scale2ref[m2][c2];[c2][m2]alphamerge,format=yuva420p[v]`,
    '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30', '-deadline', 'good', '-cpu-used', '5', '-auto-alt-ref', '0', '-row-mt', '1',
    '-c:a', 'libopus', '-b:a', '128k',
    out,
  ], { windowsHide: true });

  let encErr = '';
  enc.stderr.on('data', (d) => { encErr = (encErr + d).slice(-3000); });
  let decErr = '';
  dec.stderr.on('data', (d) => { decErr = (decErr + d).slice(-3000); });
  const encDone = new Promise((resolve, reject) => {
    enc.on('error', reject);
    enc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(encErr.trim().split('\n').slice(-2).join('\n') || `encoder exit ${code}`))));
  });
  enc.stdin.on('error', () => { /* reported by the encoder's own exit */ });

  // A decoder blocked on a full pipe never sees a polite stop signal, so stopping is forceful.
  const stop = () => {
    encDone.catch(() => {});
    dec.stdout.destroy();
    dec.kill('SIGKILL');
    enc.kill('SIGKILL');
  };
  let buf = Buffer.alloc(0);
  let done = 0;
  try {
    for await (const chunk of dec.stdout) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= frameBytes) {
        if (isCancelled && isCancelled()) { stop(); throw new Error('cancelled'); }
        const frame = buf.subarray(0, frameBytes);
        buf = buf.subarray(frameBytes);
        const mask = Buffer.from(await maskFor(Buffer.from(frame), w, h));
        if (!enc.stdin.write(mask)) await new Promise((r) => enc.stdin.once('drain', r));
        done += 1;
        if (onProgress) onProgress(Math.min(1, done / total), done, total);
      }
    }
  } catch (err) {
    stop();
    throw err;
  }
  enc.stdin.end();
  if (!done) { encDone.catch(() => {}); enc.kill('SIGKILL'); throw new Error(decErr.trim() || 'No frames could be read from this video.'); }
  await encDone;
  return out;
}

module.exports = { cutoutImage, cutoutVideo };
