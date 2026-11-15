'use strict';

// Text-to-speech voiceovers. The script is spoken a sentence at a time (the voice model
// handles short pieces best), joined with natural pauses, and saved as a WAV file. Because
// each sentence is made separately, Snippy also knows exactly when each one is spoken,
// which gives matching captions for free. Free of Electron so it can be tested with a
// stand-in voice.

const fs = require('fs');

const TTS_VOICES = [
  ['bf_emma', 'Emma', 'British, female'], ['bm_george', 'George', 'British, male'],
  ['bf_isabella', 'Isabella', 'British, female'], ['bm_lewis', 'Lewis', 'British, male'],
  ['af_heart', 'Heart', 'American, female'], ['am_michael', 'Michael', 'American, male'],
  ['af_bella', 'Bella', 'American, female'], ['am_fenrir', 'Fenrir', 'American, male'],
  ['af_nicole', 'Nicole', 'American, female, soft'], ['am_puck', 'Puck', 'American, male, playful'],
].map(([id, name, desc]) => ({ id, name, desc }));

// Sentences, with very long ones broken at commas (or between words) so none gets too long.
function splitScript(text, max = 220) {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
  if (!clean) return [];
  const parts = [];
  for (const para of clean.split(/\n+/)) {
    const sentences = para.match(/[^.!?…]+(?:[.!?…]+["'”’)]*|$)/g) || [para];
    for (let s of sentences) {
      s = s.trim();
      if (!s) continue;
      while (s.length > max) {
        let cut = s.lastIndexOf(', ', max);
        if (cut < max * 0.4) cut = s.lastIndexOf(' ', max);
        if (cut < max * 0.4) cut = max;
        parts.push({ text: s.slice(0, cut + 1).trim(), paragraphEnd: false });
        s = s.slice(cut + 1).trim();
      }
      if (s) parts.push({ text: s, paragraphEnd: false });
    }
    if (parts.length) parts[parts.length - 1].paragraphEnd = true;
  }
  return parts;
}

// Pauses after each piece, in seconds: a longer breath at full stops and paragraph ends.
function pauseAfter(part) {
  if (part.paragraphEnd) return 0.55;
  if (/[.!?…]["'”’)]*$/.test(part.text)) return 0.3;
  return 0.15;
}

// say(text) → { audio: Float32Array, rate }. Returns the joined sound and when each piece is spoken.
async function speakScript(text, say, { onProgress, isCancelled } = {}) {
  const parts = splitScript(text);
  if (!parts.length) throw new Error('Type something for the voice to say.');
  const chunks = [];
  const lines = [];
  let rate = 24000;
  let t = 0;
  for (let i = 0; i < parts.length; i++) {
    if (isCancelled && isCancelled()) throw new Error('cancelled');
    const { audio, rate: r } = await say(parts[i].text);
    rate = r || rate;
    const trimmed = trimSilence(audio, rate);
    const dur = trimmed.length / rate;
    lines.push({ text: parts[i].text, start: t, end: t + dur });
    chunks.push(trimmed);
    const gap = i < parts.length - 1 ? pauseAfter(parts[i]) : 0.2;
    chunks.push(new Float32Array(Math.round(gap * rate)));
    t += dur + gap;
    if (onProgress) onProgress((i + 1) / parts.length);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return { audio: out, rate, lines, duration: total / rate };
}

// Removes the quiet lead-in and tail the model leaves around each sentence (keeping a sliver).
function trimSilence(a, rate) {
  const thr = 0.01;
  let s = 0;
  let e = a.length - 1;
  while (s < a.length && Math.abs(a[s]) < thr) s++;
  while (e > s && Math.abs(a[e]) < thr) e--;
  if (s >= e) return new Float32Array(0);
  const keep = Math.round(0.03 * rate);
  return a.subarray(Math.max(0, s - keep), Math.min(a.length, e + keep));
}

// 16-bit mono WAV.
function writeWav(file, samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return file;
}

module.exports = { TTS_VOICES, splitScript, speakScript, trimSilence, writeWav };
