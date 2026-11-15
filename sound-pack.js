'use strict';

// The free sound pack: real recordings from BigSoundBank (bigsoundbank.com, by Joseph Sardin),
// all released as CC0 (public domain), so they can be used in any video, commercial or not,
// with no credit needed. Each sound is downloaded once, then tidied up for editing: silence
// trimmed, long recordings shortened with a gentle fade, and levels evened out so they all
// sit at a similar loudness. Free of Electron so it can be tested on its own.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { findSilences } = require('./smart-cut');

const PACK_VERSION = 1;
const PACK_BASE = 'https://bigsoundbank.com/UPLOAD/mp3/';

// mode: 'first' keeps the first sound (for recordings with several takes);
//       'trim' keeps everything from the first sound to the last, up to max seconds.
const PACK_SOUNDS = [
  // Transitions
  { id: 'p_whoosh', name: 'Whoosh', group: 'Transitions', file: '1796', mode: 'first', max: 2.5 },
  { id: 'p_whoosh_fast', name: 'Fast whoosh', group: 'Transitions', file: '1801', mode: 'first', max: 1.5 },
  { id: 'p_swish', name: 'Swish', group: 'Transitions', file: '1798', mode: 'first', max: 1.5 },
  { id: 'p_sword', name: 'Sword swipe', group: 'Transitions', file: '0128', mode: 'first', max: 1.5 },
  // Reactions
  { id: 'p_applause', name: 'Applause', group: 'Reactions', file: '0815', mode: 'trim', max: 6 },
  { id: 'p_applause_big', name: 'Big applause', group: 'Reactions', file: '0019', mode: 'trim', max: 8 },
  { id: 'p_kids_laugh', name: 'Kids laughing', group: 'Reactions', file: '1660', mode: 'trim', max: 5 },
  { id: 'p_crickets', name: 'Crickets (awkward silence)', group: 'Reactions', file: '1020', mode: 'trim', max: 5 },
  { id: 'p_kiss', name: 'Kiss', group: 'Reactions', file: '2196', mode: 'first', max: 1.5 },
  { id: 'p_heartbeat', name: 'Heartbeat', group: 'Reactions', file: '0218', mode: 'trim', max: 9 },
  // Fun
  { id: 'p_boing', name: 'Cartoon boing', group: 'Fun', file: '2279', mode: 'trim', max: 3 },
  { id: 'p_drumroll', name: 'Drum roll', group: 'Fun', file: '2402', mode: 'trim', max: 5 },
  { id: 'p_drumroll_short', name: 'Short drum roll', group: 'Fun', file: '2406', mode: 'trim', max: 3 },
  { id: 'p_ding', name: 'Ding (triangle)', group: 'Fun', file: '1688', mode: 'first', max: 4 },
  { id: 'p_cork', name: 'Cork pop', group: 'Fun', file: '1719', mode: 'first', max: 1.5 },
  { id: 'p_bottle', name: 'Bottle opening', group: 'Fun', file: '1932', mode: 'first', max: 2 },
  // Everyday
  { id: 'p_camera', name: 'Camera shutter', group: 'Everyday', file: '2544', mode: 'first', max: 1.5 },
  { id: 'p_phone_camera', name: 'Phone camera', group: 'Everyday', file: '0448', mode: 'first', max: 1.5 },
  { id: 'p_click', name: 'Click', group: 'Everyday', file: '1739', mode: 'trim', max: 1 },
  { id: 'p_checkout', name: 'Checkout beep', group: 'Everyday', file: '1417', mode: 'first', max: 1 },
  { id: 'p_doorbell', name: 'Doorbell', group: 'Everyday', file: '0088', mode: 'first', max: 4 },
  { id: 'p_keyboard', name: 'Keyboard typing', group: 'Everyday', file: '0229', mode: 'trim', max: 4 },
  { id: 'p_typewriter', name: 'Typewriter', group: 'Everyday', file: '2835', mode: 'trim', max: 4 },
  { id: 'p_dog', name: 'Dog bark', group: 'Everyday', file: '2954', mode: 'first', max: 2 },
  // Impacts
  { id: 'p_punch', name: 'Punch', group: 'Impacts', file: '2459', mode: 'first', max: 1.5 },
  { id: 'p_boom', name: 'Boom', group: 'Impacts', file: '1807', mode: 'trim', max: 3 },
  { id: 'p_glass', name: 'Glass smash', group: 'Impacts', file: '0148', mode: 'trim', max: 3 },
  { id: 'p_door_slam', name: 'Door slam', group: 'Impacts', file: '1501', mode: 'first', max: 2 },
];

function ffmpegRun(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-6000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(err.trim().split('\n').slice(-2).join('\n') || `exit ${code}`))));
  });
}

async function duration(ffmpeg, src) {
  const out = await ffmpegRun(ffmpeg, ['-hide_banner', '-i', src, '-f', 'null', '-']);
  const all = [...out.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
  const m = all[all.length - 1];
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

// Which stretch of the recording to keep, as { s, e } in seconds.
async function pickSpan(ffmpeg, src, spec) {
  const len = await duration(ffmpeg, src);
  if (!len) throw new Error('The sound file is empty');
  // Quiet gaps of a quarter second or more separate one sound from the next.
  const gaps = await findSilences(ffmpeg, src, 0, len, { minPause: 0.25, sensitivity: 'gentle' });
  const sounds = [];
  let t = 0;
  for (const g of gaps) { if (g.s > t + 0.02) sounds.push({ s: t, e: g.s }); t = g.e; }
  if (len > t + 0.02) sounds.push({ s: t, e: len });
  if (!sounds.length) return { s: 0, e: Math.min(len, spec.max), len };
  const tail = 0.12; // a little of the ring-out after the sound
  if (spec.mode === 'first') {
    const a = sounds[0];
    return { s: Math.max(0, a.s - 0.02), e: Math.min(len, a.e + tail, a.s + spec.max), len };
  }
  const s = Math.max(0, sounds[0].s - 0.02);
  return { s, e: Math.min(len, sounds[sounds.length - 1].e + tail, s + spec.max), len };
}

// Trims, fades and levels one downloaded sound into a 48 kHz stereo WAV.
async function preparePackSound(ffmpeg, raw, spec, out) {
  const span = await pickSpan(ffmpeg, raw, spec);
  const d = span.e - span.s;
  const cut = span.e < span.len - 0.15 && d >= spec.max - 0.05; // shortened: fade out gently
  const fadeOut = cut ? Math.min(1.2, d * 0.3) : Math.min(0.05, d / 4);
  // Cut and fade first, then bring the peak to -1.5 dB so every sound in the pack starts at a similar level.
  const tmp = `${out}.part.wav`;
  const shaped = `${out}.shaped.wav`;
  await ffmpegRun(ffmpeg, ['-y', '-v', 'error', '-ss', span.s.toFixed(3), '-t', d.toFixed(3), '-i', raw,
    '-af', `aresample=48000,afade=t=in:d=0.005,afade=t=out:st=${Math.max(0, d - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`,
    '-ac', '2', '-c:a', 'pcm_f32le', shaped]);
  const probe = await ffmpegRun(ffmpeg, ['-hide_banner', '-i', shaped, '-af', 'volumedetect', '-f', 'null', '-']);
  const peak = Number((probe.match(/max_volume: (-?[\d.]+) dB/) || [0, -1.5])[1]);
  const gain = Math.max(-12, Math.min(24, -1.5 - peak));
  await ffmpegRun(ffmpeg, ['-y', '-v', 'error', '-i', shaped, '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.95:level=false`, '-c:a', 'pcm_s16le', tmp]);
  fs.rmSync(shaped, { force: true });
  fs.renameSync(tmp, out);
  return { duration: d };
}

// Saved under their friendly names, so they read well in the media panel.
const packFile = (dir, spec) => path.join(dir, `${spec.name}.wav`);
const packPaths = (dir) => ({ raw: path.join(dir, 'downloads'), manifest: path.join(dir, 'pack.json') });

function readPack(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(packPaths(dir).manifest, 'utf8'));
    return m.version === PACK_VERSION ? m : { version: PACK_VERSION, sounds: {} };
  } catch { return { version: PACK_VERSION, sounds: {} }; }
}

// Downloads (or resumes) the pack. fetchFn(url) → Response-like ({ ok, status, arrayBuffer() }).
// Sounds already prepared are skipped; ones that fail are reported and can be retried later.
async function downloadPack({ ffmpeg, dir, fetchFn, base = PACK_BASE, onProgress, isCancelled }) {
  const { raw, manifest } = packPaths(dir);
  fs.mkdirSync(raw, { recursive: true });
  const pack = readPack(dir);
  const failed = [];
  const todo = PACK_SOUNDS.filter((s) => !(pack.sounds[s.id] && fs.existsSync(packFile(dir, s))));
  let done = PACK_SOUNDS.length - todo.length;
  if (onProgress) onProgress({ done, total: PACK_SOUNDS.length });
  for (const spec of todo) {
    if (isCancelled && isCancelled()) throw new Error('cancelled');
    try {
      const rawPath = path.join(raw, `${spec.file}.mp3`);
      if (!fs.existsSync(rawPath)) {
        const res = await fetchFn(`${base}${spec.file}.mp3`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1000) throw new Error('The download was too small');
        fs.writeFileSync(`${rawPath}.part`, buf);
        fs.renameSync(`${rawPath}.part`, rawPath);
      }
      const info = await preparePackSound(ffmpeg, rawPath, spec, packFile(dir, spec));
      pack.sounds[spec.id] = { duration: Number(info.duration.toFixed(3)) };
      fs.writeFileSync(manifest, JSON.stringify(pack));
    } catch (err) {
      failed.push({ id: spec.id, name: spec.name, error: err.message });
    }
    done++;
    if (onProgress) onProgress({ done, total: PACK_SOUNDS.length, name: spec.name });
  }
  // The originals aren't needed once prepared.
  for (const spec of PACK_SOUNDS) {
    if (pack.sounds[spec.id]) fs.rmSync(path.join(raw, `${spec.file}.mp3`), { force: true });
  }
  return { installed: Object.keys(pack.sounds).length, total: PACK_SOUNDS.length, failed };
}

// Every pack sound, with whether it's ready to use.
function packList(dir) {
  const pack = readPack(dir);
  return PACK_SOUNDS.map((s) => ({
    id: s.id, name: s.name, group: s.group, source: 'pack',
    ready: Boolean(pack.sounds[s.id]) && fs.existsSync(packFile(dir, s)),
    duration: pack.sounds[s.id] ? pack.sounds[s.id].duration : null,
  }));
}

module.exports = { packFile, PACK_SOUNDS, PACK_VERSION, preparePackSound, pickSpan, downloadPack, packList, readPack };
