'use strict';

// Voice effects, sound effects, and reversed / boomerang copies of clips.
// Free of Electron so each part can be tested on its own.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...(cwd ? { cwd } : {}) });
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) { resolve(Buffer.concat(out)); return; }
      // FFmpeg ends with generic lines ("Error while filtering", "Nothing was written"): keep the lines before them that say why.
      const lines = err.trim().split('\n').map((l) => l.trim()).filter(Boolean);
      const useful = lines.filter((l) => !/Nothing was written|Conversion failed|Error while filtering|received no packets/.test(l));
      reject(new Error((useful.length ? useful.slice(-3) : lines.slice(-2)).join('\n') || `exit ${code}`));
    });
  });
}

// ---------- voice effects (the same filter is used for the preview copy and the export)

const VOICE_FILTERS = {
  chipmunk: 'aresample=48000,asetrate=72000,aresample=48000,atempo=0.66667', // up half an octave-ish, same speed
  deep: 'aresample=48000,asetrate=36000,aresample=48000,atempo=1.33333',
  robot: "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75",
  echo: 'aecho=0.8:0.85:180|360:0.35|0.2',
  radio: 'highpass=f=400,lowpass=f=3200,acompressor=threshold=0.1:ratio=6:makeup=2',
  alien: 'aresample=48000,asetrate=57600,aresample=48000,atempo=0.83333,vibrato=f=7:d=0.5',
  // Clearer, fuller speech: rumble cut, less boxiness, more presence and air, softer "s" sounds,
  // gentle compression to even it out, and a limiter so it never clips.
  studio: 'highpass=f=80,equalizer=f=250:t=q:w=1.2:g=-3,equalizer=f=3200:t=q:w=1:g=3.5,equalizer=f=10000:t=q:w=0.8:g=2,'
    + 'deesser=i=0.35:m=0.5:f=0.5,acompressor=threshold=0.1:ratio=3:attack=8:release=160:makeup=1.8,alimiter=limit=0.9',
};

async function makeVoiceCopy(ffmpeg, src, fx, out) {
  const tmp = `${out}.part.m4a`;
  await run(ffmpeg, ['-y', '-v', 'error', '-i', src, '-vn', '-af', VOICE_FILTERS[fx], '-ac', '2', '-c:a', 'aac', '-b:a', '160k', tmp]);
  fs.renameSync(tmp, out);
  return out;
}

// ---------- sound effects, made from maths (no recordings, so no copyright to worry about)

const noise = (n = 0) => `(random(${n})-0.5)*2`;
const SOUND_EFFECTS = {
  whoosh: { name: 'Whoosh', d: 0.9, expr: `${noise()}*pow(sin(PI*t/0.9),2)`, after: 'highpass=f=350,lowpass=f=3500,volume=2.2' },
  pop: { name: 'Pop', d: 0.15, expr: 'sin(2*PI*(500*t-1500*t*t))*exp(-35*t)' },
  ding: { name: 'Ding', d: 1.6, expr: '0.55*sin(2*PI*1318.5*t)*exp(-2.2*t)+0.25*sin(2*PI*2637*t)*exp(-3.5*t)+0.12*sin(2*PI*3955.5*t)*exp(-5*t)' },
  boing: { name: 'Boing', d: 1, expr: 'sin(2*PI*180*t+6*sin(2*PI*9*t)*exp(-2.5*t))*exp(-2.8*t)' },
  scratch: {
    name: 'Record scratch', d: 0.6,
    expr: `0.5*sin(2*PI*(200*t+40*sin(2*PI*6*t)))*exp(-t)+0.6*${noise()}*abs(sin(2*PI*6*t))`, after: 'bandpass=f=1200:width_type=h:w=2200',
  },
  drumroll: {
    name: 'Drum roll', d: 2.4,
    expr: `${noise()}*(0.35+0.65*abs(sin(2*PI*14*t)))*min(1,0.3+t/1.6)*lt(t,1.8)` +
      `+gte(t,1.8)*(${noise(1)}*exp(-6*(t-1.8))+0.9*sin(2*PI*55*(t-1.8))*exp(-5*(t-1.8)))`,
    after: 'lowpass=f=6500',
  },
  airhorn: {
    name: 'Air horn', d: 1.2,
    expr: '0.3*(2*(mod(466.16*t,1)-0.5)+2*(mod(554.37*t,1)-0.5)+2*(mod(698.46*t,1)-0.5))*min(1,t/0.03)*(lt(t,1)+gte(t,1)*exp(-15*(t-1)))',
    after: 'lowpass=f=5000',
  },
  beep: { name: 'Censor beep', d: 0.6, expr: '0.5*sin(2*PI*1000*t)*min(1,t/0.01)*min(1,(0.6-t)/0.01)' },
};

async function makeSoundEffect(ffmpeg, id, out) {
  const fx = SOUND_EFFECTS[id];
  if (!fx) throw new Error('Unknown sound effect');
  const tmp = `${out}.part.wav`;
  await run(ffmpeg, [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', `aevalsrc='${fx.expr}':s=48000:d=${fx.d}`,
    '-af', `${fx.after ? `${fx.after},` : ''}alimiter=limit=0.9`, '-ac', '2', tmp,
  ]);
  fs.renameSync(tmp, out);
  return out;
}

// ---------- reversed and boomerang copies
// Reversing needs every frame in memory at once, so the clip is reversed in short pieces
// that are then joined in the opposite order. Boomerang is the clip forwards, then reversed.

// ---------- stabilising shaky footage
// Two passes with vid.stab when this FFmpeg has it (it looks at the whole clip first, then
// smooths the camera path), otherwise FFmpeg's simpler built-in deshake.

const STAB_SMOOTHING = { light: 10, medium: 20, strong: 40 }; // frames averaged on each side
let filterList = null;
async function hasFilter(ffmpeg, name) {
  if (!filterList) {
    try { filterList = (await run(ffmpeg, ['-hide_banner', '-filters'])).toString(); } catch { filterList = ''; }
  }
  return new RegExp(`\\s${name}\\s`).test(filterList);
}

async function stabilise({ ffmpeg, src, a, b, strength, height, crf, gop, hasAudio, out, onProgress }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snippy-stab-'));
  const span = ['-ss', a.toFixed(3), '-to', b.toFixed(3), '-i', src];
  const enc = [
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), ...(gop ? ['-g', String(gop)] : []),
    ...(hasAudio ? ['-ac', '2', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
  ];
  // Every pass first turns the picture into the same plain 8-bit, 30 fps, edit-sized frames, so both
  // vid.stab passes see exactly the same frames whatever the phone recorded (HDR, odd sizes, varying frame rates).
  const norm = `scale=-2:'min(${height},ih)':flags=bicubic,setsar=1,fps=30,format=yuv420p`;
  const outFile = path.join(dir, 'out.mp4');
  const attempts = [];
  try {
    if (await hasFilter(ffmpeg, 'vidstabdetect')) {
      try {
        // The motion file is written next to the job, by name, so no Windows drive colons end up in the filter.
        await run(ffmpeg, ['-y', '-v', 'error', ...span, '-vf', `${norm},vidstabdetect=shakiness=6:accuracy=12:result=motion.trf`, '-f', 'null', '-'], dir);
        if (onProgress) onProgress(0.5);
        await run(ffmpeg, ['-y', '-v', 'error', ...span,
          '-vf', `${norm},vidstabtransform=input=motion.trf:smoothing=${STAB_SMOOTHING[strength] || 20}:optzoom=1:zoomspeed=0.2:interpol=bicubic,unsharp=5:5:0.5:3:3:0.2,format=yuv420p`,
          ...enc, outFile], dir);
      } catch (err) {
        attempts.push(`vid.stab: ${err.message}`);
        console.warn('vid.stab failed, trying deshake instead:', err.message);
      }
    }
    if (!fs.existsSync(outFile) || attempts.length) {
      fs.rmSync(outFile, { force: true });
      const r = { light: 16, medium: 32, strong: 64 }[strength] || 32;
      try {
        await run(ffmpeg, ['-y', '-v', 'error', ...span, '-vf', `${norm},deshake=rx=${r}:ry=${r}:edge=mirror,format=yuv420p`, ...enc, outFile], dir);
      } catch (err) {
        attempts.push(`deshake: ${err.message}`);
        throw new Error(`Couldn't stabilise this clip.\n${attempts.join('\n')}`);
      }
    }
    fs.renameSync(path.join(dir, 'out.mp4'), out);
    if (onProgress) onProgress(1);
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A copy of the clip's range: stabilised, reversed or boomeranged (or stabilised, then reversed).
async function makeDerived(opts) {
  const { stab, mode, out, onProgress } = opts;
  if (!stab) return makeReversed(opts);
  if (!mode) return stabilise({ ...opts, strength: stab });
  const steady = `${out}.steady.mp4`;
  try {
    await stabilise({ ...opts, strength: stab, out: steady, gop: 0, crf: Math.min(opts.crf, 18), onProgress: (p) => onProgress && onProgress(p / 2) });
    const len = opts.b - opts.a;
    return await makeReversed({ ...opts, src: steady, a: 0, b: len, onProgress: (p) => onProgress && onProgress(0.5 + p / 2) });
  } finally {
    fs.rmSync(steady, { force: true });
  }
}

async function makeReversed({ ffmpeg, src, a, b, mode, height, crf, gop, hasAudio, out, onProgress }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snippy-rev-'));
  const CHUNK = 1.5;
  const common = (vf) => [
    '-vf', `scale=-2:'min(${height},ih)',fps=30${vf ? `,${vf}` : ''},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), ...(gop ? ['-g', String(gop)] : []),
    ...(hasAudio ? ['-ac', '2', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
  ];
  const pieces = [];
  try {
    const spans = [];
    if (mode === 'boomerang') spans.push({ s: a, e: b, reverse: false });
    for (let e = b; e > a + 1e-3; e -= CHUNK) spans.push({ s: Math.max(a, e - CHUNK), e, reverse: true });
    for (let i = 0; i < spans.length; i++) {
      const { s, e, reverse } = spans[i];
      const piece = path.join(dir, `p${i}.mp4`);
      await run(ffmpeg, [
        '-y', '-v', 'error', '-ss', s.toFixed(3), '-to', e.toFixed(3), '-i', src,
        ...common(reverse ? 'reverse' : ''),
        ...(hasAudio && reverse ? ['-af', 'areverse'] : []),
        piece,
      ]);
      pieces.push(piece);
      if (onProgress) onProgress((i + 1) / spans.length);
    }
    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, pieces.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    await run(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// One frame as a full-size picture, for freeze frames.
async function grabFrame(ffmpeg, src, t, out) {
  await run(ffmpeg, ['-y', '-v', 'error', '-ss', Math.max(0, t).toFixed(3), '-i', src, '-frames:v', '1', out]);
  return out;
}

module.exports = { VOICE_FILTERS, SOUND_EFFECTS, STAB_SMOOTHING, hasFilter, makeVoiceCopy, makeSoundEffect, makeDerived, stabilise, grabFrame };
