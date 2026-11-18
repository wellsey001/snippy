// Copied from caption-timing.js by mobile/scripts/sync-shared.js. Don't edit here.
(function () {
const module = { exports: {} };
'use strict';

// Turning speech-model output into captions. Kept free of Electron so it can be tested on its own.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isNoise = (text) => /^[\[(♪].*[\])♪]$/.test(text) || /^[\[(♪]/.test(text); // [Music], (laughs)

// Segment-level output from Whisper: [{ text, timestamp: [s, e] }] -> [{ start, end, text }].
function cleanSegments(chunks, dur) {
  const out = [];
  chunks.forEach((ch, j) => {
    const text = (ch.text || '').trim();
    if (!text || isNoise(text)) return;
    let [s, e] = ch.timestamp || [];
    if (s == null) return;
    if (e == null) e = (chunks[j + 1] && chunks[j + 1].timestamp && chunks[j + 1].timestamp[0]) ?? dur;
    s = clamp(s, 0, dur);
    e = clamp(e, s, dur);
    if (e - s >= 0.05) out.push({ start: s, end: e, text });
  });
  return out;
}

// Word-level output for one stretch of audio that started at `offset` seconds.
// Times come back relative to that stretch; they are made absolute, kept in order,
// and kept inside the clip.
function cleanWords(chunks, offset, dur) {
  const words = [];
  for (const ch of chunks || []) {
    const text = (ch.text || '').trim();
    if (!text || isNoise(text)) continue;
    const [a, b] = ch.timestamp || [];
    if (a == null) continue;
    const prev = words[words.length - 1];
    let s = clamp(offset + a, prev ? prev.s : 0, dur);
    let e = b == null ? s + 0.3 : clamp(offset + b, s, dur);
    if (e - s < 0.04) e = Math.min(dur, s + 0.04);
    words.push({ text, s, e });
  }
  return words;
}

// Group timed words into captions of up to maxWords, starting a new caption at a
// pause or after the end of a sentence. Each caption keeps its words' timings,
// relative to the caption's own start.
function groupWords(words, maxWords) {
  const groups = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    const start = cur[0].s;
    groups.push({
      start,
      end: cur[cur.length - 1].e,
      text: cur.map((w) => w.text).join(' '),
      words: cur.map((w) => ({ text: w.text, s: w.s - start, e: w.e - start })),
    });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (cur.length >= maxWords || w.s - prev.e > 0.7 || (maxWords <= 6 && /[.!?]$/.test(prev.text)))) flush();
    cur.push(w);
  }
  flush();
  // Let each caption stay up a moment after its last word, without running into the next.
  groups.forEach((g, i) => {
    const next = groups[i + 1];
    g.end = Math.max(g.end, Math.min(g.end + 0.25, next ? next.start : g.end + 0.25));
  });
  return groups;
}

// Fallback when word timings aren't available: share a segment's time out by text length.
function splitSegment(seg, maxWords) {
  const words = seg.text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return [seg];
  const groups = [];
  for (let i = 0; i < words.length; i += maxWords) groups.push(words.slice(i, i + maxWords).join(' '));
  const chars = groups.reduce((s, g) => s + g.length, 0);
  const dur = seg.end - seg.start;
  let t = seg.start;
  return groups.map((g) => {
    const d = (dur * g.length) / chars;
    const part = { start: t, end: t + d, text: g };
    t += d;
    return part;
  });
}

module.exports = { cleanSegments, cleanWords, groupWords, splitSegment };

window.SnippyCaptionTiming = module.exports;
}());
