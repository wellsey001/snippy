'use strict';
// The project being edited and the rules of its timeline.
//
// project = {
//   id, name, aspect ('9:16' | '16:9' | '1:1' | '4:5'), bg ('blur' | 'black' | 'white'),
//   media: [ids],
//   clips:   [{ id, mediaId, in, out, speed, volume, look, adj: {b, c, s}, fx, fxK, zoom, x, y, rot, transition, transitionType }],
//   texts:   [{ id, text, start, dur, size, position, offsetY, color, font, anim, out, loop, wordFx, hlColor, highlight, box, caps, words, kind }],
//   audio:   [{ id, mediaId, start, in, out, volume, fadeIn, fadeOut }],
//   effects: [{ id, effect, start, dur, k }],
// }

const ASPECTS = {
  '9:16': { name: 'TikTok, Reels, Shorts', w: 9, h: 16 },
  '16:9': { name: 'YouTube', w: 16, h: 9 },
  '1:1': { name: 'Square', w: 1, h: 1 },
  '4:5': { name: 'Instagram post', w: 4, h: 5 },
};

// Frame size for a project at a given "short side" (540 for the preview, 1080 for a full export).
function frameSize(aspect, short) {
  const a = ASPECTS[aspect] || ASPECTS['9:16'];
  const r = a.w / a.h;
  const even = (n) => Math.round(n / 2) * 2;
  return r <= 1 ? { W: short, H: even(short / r) } : { W: even(short * r), H: short };
}

const LOOKS = [
  { id: 'none', name: 'Original', css: '' },
  { id: 'vivid', name: 'Vivid', css: 'saturate(1.4) contrast(1.1)' },
  { id: 'warm', name: 'Warm', css: 'sepia(0.25) saturate(1.15) brightness(1.03)' },
  { id: 'cool', name: 'Cool', css: 'hue-rotate(-12deg) saturate(1.1) brightness(1.02)' },
  { id: 'vintage', name: 'Vintage', css: 'sepia(0.45) contrast(0.9) brightness(1.05) saturate(0.85)' },
  { id: 'faded', name: 'Faded', css: 'contrast(0.82) brightness(1.08) saturate(0.8)' },
  { id: 'punch', name: 'Punch', css: 'contrast(1.25) saturate(1.25)' },
  { id: 'dream', name: 'Dreamy', css: 'brightness(1.1) contrast(0.9) saturate(1.2) blur(0.4px)' },
  { id: 'mono', name: 'Mono', css: 'grayscale(1)' },
  { id: 'noir', name: 'Noir', css: 'grayscale(1) contrast(1.35) brightness(0.95)' },
];

const TRANSITIONS = [
  ['none', 'None'], ['fade', 'Fade'], ['dip', 'Dip to black'], ['flash', 'Flash'], ['slide', 'Slide'],
  ['zoom', 'Zoom'], ['wipe', 'Wipe'], ['whip', 'Whip'],
];

function newProject(aspect = '9:16') {
  return { id: uid('p'), name: 'My video', aspect, bg: 'blur', media: [], clips: [], texts: [], audio: [], effects: [], created: Date.now(), updated: Date.now() };
}

const clipLen = (c) => Math.max(0.05, (c.out - c.in) / (c.speed || 1));

// How much clip i overlaps the one before it (its transition), kept to half of either clip.
function overlapOf(p, i) {
  const c = p.clips[i];
  if (!i || !c || !c.transition || !c.transitionType || c.transitionType === 'none') return 0;
  return Math.min(c.transition, clipLen(c) / 2, clipLen(p.clips[i - 1]) / 2);
}

function clipStarts(p) {
  const s = [];
  let t = 0;
  p.clips.forEach((c, i) => { t -= overlapOf(p, i); s.push(Math.max(0, t)); t += clipLen(c); });
  return s;
}

function totalLen(p) {
  const s = clipStarts(p);
  let end = p.clips.length ? s[s.length - 1] + clipLen(p.clips[p.clips.length - 1]) : 0;
  for (const x of p.texts) end = Math.max(end, x.start + x.dur);
  return end;
}
// The video's length is set by the clips (texts and music past the end are cut off).
function videoLen(p) {
  const s = clipStarts(p);
  return p.clips.length ? s[s.length - 1] + clipLen(p.clips[p.clips.length - 1]) : 0;
}

// The clips showing at time t: [{ i, clip, start, u (clip time), src (source time) }], at most two.
function clipsAt(p, t, starts = clipStarts(p)) {
  const out = [];
  for (let i = 0; i < p.clips.length; i++) {
    const c = p.clips[i];
    const s = starts[i];
    const L = clipLen(c);
    if (t >= s - 1e-6 && t < s + L) {
      const u = t - s;
      out.push({ i, clip: c, start: s, u, src: c.in + u * (c.speed || 1) });
    }
  }
  if (!out.length && p.clips.length && t >= videoLen(p) - 1e-6) {
    const i = p.clips.length - 1;
    const c = p.clips[i];
    const L = clipLen(c);
    out.push({ i, clip: c, start: starts[i], u: L - 0.001, src: c.out - 0.001 });
  }
  return out.slice(-2);
}

// Beats on the timeline, from songs whose beat was found.
function timelineBeats(p) {
  const out = [];
  for (const a of p.audio) {
    if (!a.beats) continue;
    for (const b of a.beats) if (b >= a.in && b <= a.out) out.push(a.start + (b - a.in));
  }
  return out.sort((x, y) => x - y);
}

// ---------- undo and redo
const History = {
  past: [],
  future: [],
  snap(p) { this.past.push(JSON.stringify(p)); if (this.past.length > 80) this.past.shift(); this.future = []; },
  undo(p) { if (!this.past.length) return null; this.future.push(JSON.stringify(p)); return JSON.parse(this.past.pop()); },
  redo(p) { if (!this.future.length) return null; this.past.push(JSON.stringify(p)); return JSON.parse(this.future.pop()); },
  reset() { this.past = []; this.future = []; },
};
