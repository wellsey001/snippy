'use strict';

const $ = (sel) => document.querySelector(sel);
const ASPECTS = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] };
const FPS = 30;
const MIN_LEN = 0.2;
const COLORS = ['#FFFFFF', '#FFD84D', '#5CE1E6', '#FF7AB6'];
// Each look is a list of CSS filter steps. Export turns the same steps into
// FFmpeg colour matrices, so what you see in the preview is what you get.
const LOOKS = [
  { id: 'none', name: 'Original', steps: [] },
  { id: 'vivid', name: 'Vivid', steps: [['saturate', 1.4], ['contrast', 1.1]] },
  { id: 'warm', name: 'Warm', steps: [['sepia', 0.25], ['saturate', 1.15], ['brightness', 1.03]] },
  { id: 'vintage', name: 'Vintage', steps: [['sepia', 0.45], ['contrast', 0.9], ['brightness', 1.05], ['saturate', 0.85]] },
  { id: 'faded', name: 'Faded', steps: [['contrast', 0.82], ['brightness', 1.08], ['saturate', 0.8]] },
  { id: 'mono', name: 'Mono', steps: [['grayscale', 1]] },
  { id: 'noir', name: 'Noir', steps: [['grayscale', 1], ['contrast', 1.35], ['brightness', 0.95]] },
];
const ICON_PLAY = '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 16 16"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z"/></svg>';

const state = {
  media: [],   // { id, path, url, name, duration, width, height, hasAudio, thumb }
  clips: [],   // { id, mediaId, in, out }  — main track, played back to back
  texts: [],   // { id, text, start, dur, size, position, color }
  audio: [],   // { id, mediaId, start, in, out, volume, fadeIn, fadeOut } — music and sound, placed freely
  adjust: [], // adjustment layers: { id, start, dur, look, adj, curve }
  markers: [], // timeline markers: { id, t, label }
  stickers: [], // { id, emoji, start, dur, x, y, size, rotate, anim } — x/y = centre, size = fraction of canvas height
  overlays: [], // { id, mediaId, start, in, out, x, y, w, opacity, volume } — picture-in-picture, x/y = centre, w = width (fractions of the canvas)
  aspect: '16:9',
  zoom: 60,    // pixels per second
  playhead: 0,
  playing: false,
  selected: null, // { kind: 'clip' | 'text' | 'audio', id }
};

const video = $('#preview');
const still = $('#still'); // shows photo clips
// The incoming clip during a crossfade, drawn over the main preview with rising opacity.
const videoB = $('#previewB');
const stillB = $('#stillB');
let handoffUntil = 0; // keeps the incoming layer up while the main preview catches up
const layers = { A: $('#layerA'), B: $('#layerB'), flash: $('#transFlash') };
let stillClock = { t0: 0, w0: 0 }; // photos have no media clock, so playback uses the wall clock
const content = $('#tlContent');
let uid = 0;
const newId = (p) => `${p}${Date.now().toString(36)}${(uid++).toString(36)}`;

// ---------- helpers

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// A clip with a speed curve has no single speed; spd() gives its average, which keeps lengths exact.
const rampFor = (c) => (c && c.ramp && c.ramp.length > 1 && c.out > c.in ? rampSegs(c.ramp, c.out - c.in) : null);
const spd = (c) => { const r = rampFor(c); return r ? (c.out - c.in) / rampLength(r) : c.speed || 1; };
// Timeline offset u into a clip → source offset, and back. Exact for speed curves.
const srcOff = (c, u) => { const r = rampFor(c); return r ? rampSrcAt(r, u) : u * spd(c); };
const timeOff = (c, tau) => { const r = rampFor(c); return r ? rampTimeAt(r, tau) : tau / spd(c); };
const speedNow = (c, u) => { const r = rampFor(c); return r ? rampSpeedAt(r, u) : spd(c); };
const clampRate = (v) => Math.min(16, Math.max(0.0625, v)); // what browsers allow

function colorSteps(c) {
  const look = LOOKS.find((l) => l.id === c.look) || LOOKS[0];
  const a = c.adj || {};
  return [...look.steps, ['brightness', a.brightness ?? 1], ['contrast', a.contrast ?? 1], ['saturate', a.saturation ?? 1]];
}

function cssFilter(c) {
  const steps = colorSteps(c).filter(([fn, v]) => (fn === 'grayscale' || fn === 'sepia' ? v > 0 : v !== 1));
  const parts = steps.map(([fn, v]) => `${fn}(${v})`);
  const cv = curveUrl(c.curve);
  if (cv) parts.push(cv);
  return parts.length ? parts.join(' ') : 'none';
}

// A tone curve as an SVG filter (made once per curve shape and reused).
const curveFilters = new Map();
function curveUrl(ys) {
  if (!ys || isFlatCurve(ys)) return '';
  const key = ys.map((y) => y.toFixed(3)).join('_');
  if (!curveFilters.has(key)) {
    const id = `cv${curveFilters.size}`;
    const table = curveSamples(ys, 33).map((v) => v.toFixed(4)).join(' ');
    const NS = 'http://www.w3.org/2000/svg';
    const f = document.createElementNS(NS, 'filter');
    f.setAttribute('id', id);
    f.setAttribute('color-interpolation-filters', 'sRGB');
    const ct = document.createElementNS(NS, 'feComponentTransfer');
    for (const ch of ['R', 'G', 'B']) {
      const fn = document.createElementNS(NS, `feFunc${ch}`);
      fn.setAttribute('type', 'table');
      fn.setAttribute('tableValues', table);
      ct.append(fn);
    }
    f.append(ct);
    document.querySelector('#curveDefs defs').append(f);
    curveFilters.set(key, id);
  }
  return `url(#${curveFilters.get(key)})`;
}
// Length on the timeline. Boomerang plays the clip forwards then backwards, so twice as long.
const clipLen = (c) => ((c.out - c.in) / spd(c)) * (c.mode === 'boomerang' ? 2 : 1);
const mediaById = (id) => state.media.find((m) => m.id === id);

// A crossfade overlaps a clip with the one before it. Each overlap is capped at
// half of either clip, so a clip's two overlaps can never add up to more than it.
// Every style except dip to black overlaps the two clips.
const isCross = (c) => Boolean(c.transitionType) && c.transitionType !== 'dip';
function overlapOf(i) {
  const c = state.clips[i];
  if (i === 0 || !(c.transition > 0) || !isCross(c)) return 0;
  const want = c.transitionType === 'shake' ? 0.1 : c.transition; // a shake cut is nearly a hard cut
  return Math.min(want, clipLen(state.clips[i - 1]) / 2, clipLen(c) / 2);
}

function clipStarts() {
  let t = 0;
  return state.clips.map((c, i) => {
    t -= overlapOf(i);
    const s = t;
    t += clipLen(c);
    return s;
  });
}

function totalDuration() {
  const n = state.clips.length;
  if (!n) return 0;
  return clipStarts()[n - 1] + clipLen(state.clips[n - 1]);
}

// The clip that owns time t. During a crossfade that is the outgoing clip;
// crossAt() describes the incoming one.
function locate(t) {
  const starts = clipStarts();
  for (let i = 0; i < state.clips.length; i++) {
    const c = state.clips[i];
    const L = clipLen(c);
    if (t < starts[i] + L || i === state.clips.length - 1) {
      return { index: i, clip: c, start: starts[i], src: c.in + srcOff(c, clamp(t - starts[i], 0, L)) };
    }
  }
  return null;
}

function crossAt(t) {
  const starts = clipStarts();
  for (let i = 1; i < state.clips.length; i++) {
    const ov = overlapOf(i);
    if (ov > 0 && t >= starts[i] && t < starts[i] + ov) {
      const c = state.clips[i];
      return { index: i, clip: c, alpha: (t - starts[i]) / ov, src: c.in + srcOff(c, t - starts[i]) };
    }
  }
  return null;
}

function fmt(t) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, '0')}`;
}

function fmtShort(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const ss = Number.isInteger(s) ? String(s).padStart(2, '0') : s.toFixed(1).padStart(4, '0');
  return `${m}:${ss}`;
}

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null && k !== 'value') continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'disabled') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
}

function cleanError(err) {
  return String(err && err.message ? err.message : err)
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ---------- undo / redo

const undoStack = [];
const redoStack = [];
let lastEditKey = null;

const snapshot = () => JSON.stringify({ clips: state.clips, texts: state.texts, audio: state.audio, overlays: state.overlays, stickers: state.stickers, adjust: state.adjust || [], markers: state.markers || [] });

function pushHistory(snap) {
  editVersion++;
  undoStack.push(snap);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  lastEditKey = null;
  markDirty();
  updateToolbar();
}
const commit = () => pushHistory(snapshot());

// Groups a run of edits (like typing) into one undo step.
function commitOnce(key) {
  if (lastEditKey === key) return;
  commit();
  lastEditKey = key;
}

function restore(snap) {
  editVersion++;
  const o = JSON.parse(snap);
  state.clips = o.clips;
  state.texts = o.texts;
  state.audio = o.audio || [];
  state.overlays = o.overlays || [];
  state.stickers = o.stickers || [];
  state.adjust = o.adjust || [];
  state.markers = o.markers || [];
  selection = []; state.selected = null;
  lastEditKey = null;
  markDirty();
  renderAll();
  refreshPreview();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}

// ---------- import

async function importPaths(paths) {
  if (!paths.length) return;
  // GIFs play as stickers (with their see-through backgrounds), not as video clips.
  const gifs = paths.filter((p) => /\.gif$/i.test(p));
  if (gifs.length) {
    paths = paths.filter((p) => !/\.gif$/i.test(p));
    if (!state.clips.length && !paths.length) toast('Add a video first, then drop GIFs on to it as stickers');
    else for (const g of gifs) await addGifSticker(g);
  }
  if (!paths.length) return;
  const wasEmpty = state.clips.length === 0;
  const audioWasEmpty = state.audio.length === 0;
  const added = [];
  for (const p of paths) {
    try {
      const info = await window.api.probe(p);
      if (!info.hasVideo && !info.hasAudio) { toast(`${info.name} has no video or sound, so it was skipped`); continue; }
      const m = { id: newId('m'), ...info };
      state.media.push(m);
      added.push(m);
      loadLevels(m);
      queueProxy(m);
    } catch (err) {
      console.error(err);
      toast(`Couldn't read ${p.split(/[\\/]/).pop()}`);
    }
  }
  if (added.length) markDirty();
  const newVideo = wasEmpty ? added.filter((m) => m.kind !== 'audio') : [];
  const newAudio = audioWasEmpty ? added.filter((m) => m.kind === 'audio') : [];
  if (newVideo.length || newAudio.length) {
    commit();
    for (const m of newVideo) state.clips.push(newClip(m));
    let t = 0;
    for (const m of newAudio) { state.audio.push(newAudioItem(m, t)); t += m.duration; }
  }
  renderAll();
  if (newVideo.length || newAudio.length) seek(newVideo.length ? 0 : state.playhead);
}

const PHOTO_LEN = 3; // seconds a photo stays on screen when first added
const isImage = (m) => m.kind === 'image';

// ---------- reversed / boomerang copies and voice-effect copies for the preview
// Videos can't play backwards, so a reversed clip plays a reversed copy of its range.
// Its time τ runs from 0; at timeline time u into the clip, τ = u × speed.

const derivedCache = new Map(); // key -> { url, path } or { pending, progress }
const voiceCache = new Map();   // key -> { url } or { pending }
const derivedKey = (c, m) => `${m.path}|${c.mode}|${c.stab || ''}|${c.in.toFixed(3)}|${c.out.toFixed(3)}`;

function derivedFor(c, request = true) {
  if (!c.mode && !c.stab) return null;
  const m = mediaById(c.mediaId);
  if (!m || isImage(m)) return null;
  const key = derivedKey(c, m);
  const v = derivedCache.get(key);
  if (v && v.url) return v;
  if (!v && request) {
    derivedCache.set(key, { pending: true, progress: 0, id: c.id });
    window.api.makeDerived(m.path, c.in, c.out, c.mode || null, m.hasAudio, c.id, c.stab || null)
      .then((r) => { derivedCache.set(key, r); refreshPreview(); if (isSel('clip', c.id)) renderInspector(); })
      .catch((err) => {
        // Remembered as failed so it isn't retried on every frame; the original keeps playing.
        console.error(err); derivedCache.set(key, { failed: true });
        toast(`Couldn't make the ${c.mode || 'stabilised'} copy: ${cleanError(err)}`);
      });
  }
  return null;
}
if (window.api.onDerivedProgress) {
  window.api.onDerivedProgress(({ id, progress }) => {
    for (const v of derivedCache.values()) if (v.pending && v.id === id) v.progress = progress;
    const hint = document.getElementById('modeHint');
    if (hint) hint.textContent = `Making the copy for the preview… ${Math.round(progress * 100)}%`;
    const sh = document.getElementById('stabHint');
    if (sh) sh.textContent = `Steadying the clip… ${Math.round(progress * 100)}%`;
  });
}

// Where in the original file the clip is, at source-style time src (for loudness and freeze frames).
function trueSourceTime(c, src) {
  if (!c.mode) return src;
  const L = c.out - c.in;
  const tau = src - c.in;
  if (c.mode === 'reverse') return c.out - tau;
  return tau < L ? c.in + tau : c.out - (tau - L);
}

function voiceFor(path, fx, request = true) {
  if (!fx || fx === 'none') return null;
  const key = `${path}|${fx}`;
  const v = voiceCache.get(key);
  if (v && v.url) return v.url;
  if (!v && request) {
    voiceCache.set(key, { pending: true });
    toast('Preparing the voice effect…');
    window.api.makeVoice(path, fx)
      .then((r) => { voiceCache.set(key, r); refreshPreview(); })
      .catch((err) => { console.error(err); voiceCache.delete(key); toast(`Couldn't make the voice effect: ${cleanError(err)}`); });
  }
  return null;
}

// The changed voice of the current clip plays here, in step with the (muted) video.
const voiceEl = new Audio();
voiceEl.preload = 'auto';

function clipVoiceUrl(c) {
  if (!c || !c.voice || c.voice === 'none') return null;
  const m = mediaById(c.mediaId);
  if (!m || !m.hasAudio || isImage(m)) return null;
  if (c.mode || c.stab) {
    const d = derivedFor(c, false);
    return d ? voiceFor(d.path, c.voice) : null;
  }
  return voiceFor(m.path, c.voice);
}

// ---------- preview copies (for 4K and hard-to-play videos)
// The preview plays a light 720p copy when there is one; exports always use the original.

const srcFor = (m) => m.proxyUrl || m.url;
const PLAYABLE = new Set(['h264', 'vp8', 'vp9', 'av1']);
let proxiesOn = true;
try { proxiesOn = localStorage.getItem('snippy.proxies') !== 'off'; } catch { /* default on */ }

const needsProxy = (m) => m.kind === 'video' && !m.vpxAlpha && (Math.max(m.width, m.height) > 1920 || !PLAYABLE.has(m.vcodec));

const proxyQueue = [];
let proxyBusy = false;

async function queueProxy(m, force = false) {
  if (m.proxyUrl || m.proxyState) return;
  if (!force && (!proxiesOn || !needsProxy(m))) return;
  const found = await window.api.findProxy(m.path).catch(() => null);
  if (found) { useProxy(m, found); return; }
  m.proxyState = 'waiting';
  m.proxyProgress = 0;
  proxyQueue.push(m);
  renderMedia();
  runProxyQueue();
}

async function runProxyQueue() {
  if (proxyBusy) return;
  const m = proxyQueue.shift();
  if (!m) return;
  proxyBusy = true;
  m.proxyState = 'making';
  updateProxyBadge(m);
  try {
    useProxy(m, await window.api.makeProxy(m.path, m.duration, m.id));
  } catch (err) {
    console.error(err);
    m.proxyState = null;
    toast(`Couldn't make a preview copy of ${m.name}`);
    renderMedia();
  } finally {
    proxyBusy = false;
    runProxyQueue();
  }
}

function useProxy(m, p) {
  m.proxyUrl = p.url;
  m.proxyState = null;
  renderMedia();
  // Anything on screen showing this file switches to the copy.
  for (const [id, el] of pipEls) if (el.mediaId === m.id) { el.wrap.remove(); pipEls.delete(id); }
  refreshPreview();
}

function updateProxyBadge(m) {
  const b = document.getElementById(`badge-${m.id}`);
  if (!b) return;
  b.textContent = m.proxyState === 'making' ? `Preview copy ${Math.round((m.proxyProgress || 0) * 100)}%` : 'Preview copy waiting';
}

window.api.onProxyProgress(({ id, progress }) => {
  const m = mediaById(id);
  if (!m) return;
  m.proxyProgress = progress;
  updateProxyBadge(m);
});
const newClip = (m) => ({ id: newId('c'), mediaId: m.id, in: 0, out: isImage(m) ? PHOTO_LEN : m.duration, volume: 1 });
const newOverlay = (m, start) => ({
  id: newId('o'), mediaId: m.id, start, in: 0, out: isImage(m) ? PHOTO_LEN : m.duration,
  x: 0.78, y: 0.26, w: 0.34, opacity: 1, volume: m.hasAudio ? 1 : 0,
});
const newAudioItem = (m, start) => ({
  id: newId('a'), mediaId: m.id, start, in: 0, out: m.duration, volume: 0.8, fadeIn: 0, fadeOut: 0,
});

// ---------- overlay lanes: more video tracks. Higher lanes sit on top.

const LANE_H = 40;
const laneOf = (o) => o.lane || 0;
const laneCount = () => Math.max(1, ...state.overlays.map((o) => laneOf(o) + 1));
// Lowest lane where [a, b) doesn't overlap anything else.
function freeLane(a, b, skipId) {
  for (let lane = 0; ; lane++) {
    if (!state.overlays.some((o) => o.id !== skipId && laneOf(o) === lane && a < o.start + (o.out - o.in) && b > o.start)) return lane;
  }
}
// No two overlays share a lane at the same moment: the one just moved keeps its lane and anything
// it now sits on is lifted to the next free lane above. Empty lanes are then closed up.
function tidyLanes(keepId) {
  const end = (o) => o.start + (o.out - o.in);
  const order = [...state.overlays].sort((x, y) => (x.id === keepId ? -1 : y.id === keepId ? 1 : laneOf(x) - laneOf(y)));
  const placed = [];
  for (const o of order) {
    let lane = laneOf(o);
    while (placed.some((p) => p.lane === lane && o.start < end(p) && end(o) > p.start)) lane++;
    o.lane = lane;
    placed.push(o);
  }
  const used = [...new Set(state.overlays.map(laneOf))].sort((a, b) => a - b);
  for (const o of state.overlays) o.lane = used.indexOf(laneOf(o));
}
// Overlays in stacking order: by lane, then the order they were added.
const stacked = () => state.overlays.map((o, i) => ({ o, i })).sort((x, y) => laneOf(x.o) - laneOf(y.o) || x.i - y.i).map((x) => x.o);
function sizeOverlayRow() {
  const n = laneCount();
  const h = n * LANE_H + (n - 1) * 4 + 10;
  document.documentElement.style.setProperty('--ov-row', `${Math.max(50, h)}px`);
}

function addToTimeline(mediaId, asOverlay = false) {
  const m = mediaById(mediaId);
  if (asOverlay) {
    if (!state.clips.length) { toast('Add a main video first, then layer this on top'); return; }
    commit();
    const item = newOverlay(m, Math.min(state.playhead, Math.max(0, totalDuration() - MIN_LEN)));
    item.lane = freeLane(item.start, item.start + (item.out - item.in));
    state.overlays.push(item);
    renderAll();
    select('overlay', item.id);
    refreshPreview();
    toast(`Added ${m.name} as an overlay. Drag it on the preview to move it.`);
    return;
  }
  commit();
  if (m.kind === 'audio') {
    const item = newAudioItem(m, state.playhead);
    state.audio.push(item);
    renderAll();
    select('audio', item.id);
    toast(`Added ${m.name} at the playhead`);
    return;
  }
  state.clips.push(newClip(m));
  renderAll();
  refreshPreview();
  toast(`Added ${m.name}`);
}

// ---------- playback

let currentIndex = -1;

function setVideoTime(sec) {
  if (video.readyState >= 1) video.currentTime = sec;
  else video.addEventListener('loadedmetadata', () => { video.currentTime = sec; }, { once: true });
}

function useMedia(m, url) {
  const src = url || srcFor(m);
  if (video.dataset.src !== src) {
    video.src = src;
    video.dataset.src = src;
    video.dataset.mediaId = m.id;
  }
}

function loadClipAt(t, autoplay) {
  const loc = locate(t);
  if (!loc) {
    currentIndex = -1;
    still.hidden = true;
    video.hidden = false;
    video.removeAttribute('src');
    video.dataset.mediaId = '';
    video.load();
    return;
  }
  currentIndex = loc.index;
  const m = mediaById(loc.clip.mediaId);
  if (isImage(m)) {
    video.pause();
    video.hidden = true;
    still.hidden = false;
    if (still.dataset.mediaId !== m.id) { still.src = m.url; still.dataset.mediaId = m.id; }
    still.style.filter = cssFilter(loc.clip);
    stillClock = { t0: t, w0: performance.now() };
    return;
  }
  still.hidden = true;
  video.hidden = false;
  const d = derivedFor(loc.clip);
  useMedia(m, d ? d.url : null);
  video.style.filter = cssFilter(loc.clip);
  video.defaultPlaybackRate = clampRate(speedNow(loc.clip, t - loc.start));
  video.playbackRate = video.defaultPlaybackRate;
  video.volume = clamp(loc.clip.volume == null ? 1 : loc.clip.volume, 0, 1);
  const elemT = d ? loc.src - loc.clip.in : loc.src;
  setVideoTime(elemT);
  const vUrl = clipVoiceUrl(loc.clip);
  video.muted = Boolean(vUrl);
  if (vUrl) {
    if (voiceEl.dataset.src !== vUrl) { voiceEl.src = vUrl; voiceEl.dataset.src = vUrl; }
    voiceEl.defaultPlaybackRate = video.defaultPlaybackRate;
    voiceEl.playbackRate = video.defaultPlaybackRate;
    voiceEl.volume = video.volume;
    if (voiceEl.readyState >= 1) voiceEl.currentTime = elemT;
    else voiceEl.addEventListener('loadedmetadata', () => { voiceEl.currentTime = video.currentTime; }, { once: true });
    if (autoplay) voiceEl.play().catch(() => {});
    else voiceEl.pause();
  } else if (!voiceEl.paused) voiceEl.pause();
  if (autoplay) video.play().catch(() => {});
}

// ---------- audio levels: auto-ducking and the level meter
// Each file's loudness every 50 ms (measured by FFmpeg). The duck curve made from it
// is used both to play the preview and, as timed volume changes, in the export.

let editVersion = 0;
let levelsVersion = 0;
const LEVEL_HOP = 0.05;

function loadLevels(m) {
  if (!m.hasAudio || m.levels || m.levelsPending) return;
  m.levelsPending = true;
  window.api.audioLevels(m.path)
    .then((l) => { m.levels = l; levelsVersion++; })
    .catch(() => { /* no meter or ducking for this file */ })
    .finally(() => { m.levelsPending = false; });
}

const levelAt = (m, src) => (m && m.levels ? m.levels[Math.floor(src / LEVEL_HOP)] || 0 : 0);

// How loud the speech (clips' own sound and overlay videos) is at timeline time t.
function voiceAt(t) {
  let v = 0;
  const loc = locate(t);
  if (loc) {
    const m = mediaById(loc.clip.mediaId);
    if (m.hasAudio) v += levelAt(m, trueSourceTime(loc.clip, loc.src)) * (loc.clip.volume ?? 1);
  }
  const x = crossAt(t);
  if (x) {
    const m = mediaById(x.clip.mediaId);
    if (m.hasAudio) v += levelAt(m, trueSourceTime(x.clip, x.src)) * (x.clip.volume ?? 1);
  }
  for (const o of state.overlays) {
    const u = t - o.start;
    if (u < 0 || u >= o.out - o.in || !(o.volume > 0)) continue;
    const m = mediaById(o.mediaId);
    if (m.hasAudio) v += levelAt(m, o.in + u) * o.volume;
  }
  return v;
}

const DUCK_RATE = 20; // curve points per second
let duckCache = { key: '', env: [] };

// 0 = nobody talking, 1 = talking; eases down quickly and back up gently.
function duckEnvelope() {
  const total = totalDuration();
  const key = `${editVersion}|${levelsVersion}|${total.toFixed(3)}`;
  if (duckCache.key === key) return duckCache.env;
  const n = Math.ceil(total * DUCK_RATE) + 1;
  const env = new Float32Array(n);
  let hold = 0;
  let e = 0;
  const dt = 1 / DUCK_RATE;
  const attack = 1 - Math.exp(-dt / 0.08);
  const release = 1 - Math.exp(-dt / 0.35);
  for (let k = 0; k < n; k++) {
    const talking = voiceAt(k * dt) > 0.015; // about -36 dB
    hold = talking ? 0.25 : Math.max(0, hold - dt); // bridge the small gaps between words
    const target = talking || hold > 0 ? 1 : 0;
    e += (target - e) * (target > e ? attack : release);
    env[k] = e;
  }
  duckCache = { key, env };
  return env;
}

function duckGainAt(a, t) {
  if (!a.duck) return 1;
  const env = duckEnvelope();
  const k = t * DUCK_RATE;
  const i = Math.max(0, Math.min(env.length - 1, Math.floor(k)));
  const j = Math.min(env.length - 1, i + 1);
  const e = env[i] + (env[j] - env[i]) * Math.max(0, Math.min(1, k - i));
  return 1 - (1 - (a.duckTo ?? 0.3)) * e;
}

// For export: the duck curve as timed volume changes, only where it actually changes.
function duckCommands(a) {
  if (!a.duck) return null;
  const len = a.out - a.in;
  const out = [];
  let last = -1;
  for (let k = 0; k <= Math.ceil(len * DUCK_RATE); k++) {
    const t = a.start + k / DUCK_RATE;
    const g = duckGainAt(a, t);
    if (!out.length || Math.abs(g - last) > 0.004) { out.push([t, g]); last = g; }
  }
  return out;
}

// Mix loudness at the playhead, for the meter.
function mixLevelAt(t) {
  let v = voiceAt(t);
  for (const a of state.audio) {
    const u = t - a.start;
    if (u < 0 || u >= a.out - a.in) continue;
    v += levelAt(mediaById(a.mediaId), a.in + u) * audioGain(a, u) * duckGainAt(a, t);
  }
  return v;
}

function updateMeter() {
  const fill = $('#meterFill');
  if (!fill) return;
  const db = 20 * Math.log10(Math.max(1e-4, mixLevelAt(state.playhead) * 1.41)); // RMS to about peak
  fill.style.width = `${clamp((db + 60) / 60, 0, 1) * 100}%`;
  fill.classList.toggle('hot', db > -3);
}

// ---------- audio track playback

const audioEls = new Map(); // audio item id -> <audio>

function audioElFor(item) {
  const m = mediaById(item.mediaId);
  let el = audioEls.get(item.id);
  if (!el) {
    el = new Audio();
    el.preload = 'auto';
    audioEls.set(item.id, el);
  }
  const src = voiceFor(m.path, item.voice) || m.url;
  if (el.dataset.src !== src) {
    el.src = src;
    el.dataset.src = src;
    el.dataset.mediaId = m.id;
  }
  return el;
}

function audioGain(item, local) {
  const len = item.out - item.in;
  let g = kfValue(item, 'audio', local).volume;
  if (item.fadeIn > 0 && local < item.fadeIn) g *= local / item.fadeIn;
  if (item.fadeOut > 0 && local > len - item.fadeOut) g *= Math.max(0, (len - local) / item.fadeOut);
  return clamp(g, 0, 1);
}

function syncAudio(forceSeek) {
  const t = state.playhead;
  const live = new Set();
  for (const a of state.audio) {
    live.add(a.id);
    const el = audioElFor(a);
    const local = t - a.start;
    if (state.playing && local >= 0 && local < a.out - a.in) {
      const target = a.in + local;
      if (el.readyState >= 1 && (forceSeek || Math.abs(el.currentTime - target) > 0.25)) el.currentTime = target;
      el.volume = clamp(audioGain(a, local) * duckGainAt(a, t), 0, 1);
      if (el.paused) el.play().catch(() => {});
    } else if (!el.paused) {
      el.pause();
    }
  }
  for (const [id, el] of audioEls) {
    if (live.has(id)) continue;
    el.pause();
    el.removeAttribute('src');
    audioEls.delete(id);
  }
}

// ---------- overlays (picture-in-picture) on the preview

const pipEls = new Map(); // overlay id -> { wrap, media, mediaId, image }

function pipFor(o) {
  const m = mediaById(o.mediaId);
  let p = pipEls.get(o.id);
  if (p && p.mediaId === m.id) return p;
  if (p) p.wrap.remove();
  const media = isImage(m)
    ? h('img', { src: m.url, alt: '', draggable: 'false' })
    : h('video', { src: srcFor(m), preload: 'auto' });
  if (!isImage(m)) media.addEventListener('loadedmetadata', () => syncOverlays(true), { once: true });
  const keyCanvas = h('canvas', { class: 'pip-key' });
  const wrap = h('div', { class: 'pip', 'data-id': o.id }, media, keyCanvas,
    h('div', { class: 'pip-resize', title: 'Drag to resize' }));
  $('#pipLayer').append(wrap);
  p = { wrap, media, keyCanvas, mediaId: m.id, image: isImage(m) };
  // A paused overlay with a green screen needs redrawing once its new frame is ready.
  const redraw = () => { const cur = state.overlays.find((x) => x.id === o.id); if (cur) drawKey(cur, pipEls.get(o.id)); };
  media.addEventListener(isImage(m) ? 'load' : 'seeked', redraw);
  if (!isImage(m)) media.addEventListener('loadeddata', redraw);
  pipEls.set(o.id, p);
  return p;
}

// ---------- shapes (masks) and boxes for overlays

// How an overlay mixes with what's under it (the export uses the same modes in FFmpeg).
const BLENDS = [
  ['normal', 'Normal', 'Sits on top as it is'],
  ['screen', 'Screen', 'Only the light parts show: good for light leaks, sparks, fire and smoke on black'],
  ['add', 'Add', 'Like Screen but brighter'],
  ['lighten', 'Lighten', 'Keeps whichever is lighter'],
  ['multiply', 'Multiply', 'Only the dark parts show: good for textures, paper and shadows on white'],
  ['darken', 'Darken', 'Keeps whichever is darker'],
  ['overlay', 'Overlay', 'Adds contrast and texture: good for film grain and dust'],
  ['softlight', 'Soft light', 'A gentler Overlay'],
  ['difference', 'Difference', 'Inverts where it\'s light: a trippy effect'],
];
const CSS_BLEND = { screen: 'screen', add: 'plus-lighter', lighten: 'lighten', multiply: 'multiply', darken: 'darken', overlay: 'overlay', softlight: 'soft-light', difference: 'difference' };

const SHAPES = [['none', 'None'], ['circle', 'Circle'], ['rounded', 'Rounded'], ['heart', 'Heart'], ['star', 'Star'], ['diamond', 'Diamond']];
const SQUARE_SHAPES = new Set(['circle', 'heart', 'star', 'diamond']);

// Height ÷ width of the overlay as shown: its box if it has one, otherwise the picture's own shape.
function ovAr(o) {
  if (o.cell) return 1 / o.cell;
  const m = mediaById(o.mediaId);
  return m ? m.height / Math.max(1, m.width) : 0.5625;
}

function shapePath(ctx, shape, w, h) {
  ctx.beginPath();
  if (shape === 'circle') ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else if (shape === 'rounded') roundRect(ctx, 0, 0, w, h, Math.min(w, h) * 0.16);
  else if (shape === 'diamond') { ctx.moveTo(w / 2, 0); ctx.lineTo(w, h / 2); ctx.lineTo(w / 2, h); ctx.lineTo(0, h / 2); ctx.closePath(); }
  else if (shape === 'star') {
    for (let k = 0; k < 10; k++) {
      const r = k % 2 ? 0.4 : 1;
      const a = -Math.PI / 2 + (k * Math.PI) / 5;
      const x = w / 2 + (Math.cos(a) * r * w) / 2;
      const y = h * 0.53 + (Math.sin(a) * r * h) / 2;
      if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath();
  } else if (shape === 'heart') {
    ctx.moveTo(w / 2, h * 0.97);
    ctx.bezierCurveTo(w * 0.1, h * 0.68, -w * 0.02, h * 0.4, w * 0.12, h * 0.18);
    ctx.bezierCurveTo(w * 0.25, h * 0.0, w * 0.45, h * 0.02, w / 2, h * 0.22);
    ctx.bezierCurveTo(w * 0.55, h * 0.02, w * 0.75, h * 0.0, w * 0.88, h * 0.18);
    ctx.bezierCurveTo(w * 1.02, h * 0.4, w * 0.9, h * 0.68, w / 2, h * 0.97);
    ctx.closePath();
  } else ctx.rect(0, 0, w, h);
}

// The mask as two pictures from one drawing: see-through for the preview's CSS mask,
// black and white for the export.
const maskCache = new Map();
function shapeMask(o) {
  const W = 512;
  const H = Math.max(2, Math.round((W * ovAr(o)) / 2) * 2);
  const soft = o.soft ? 0.035 : 0;
  const key = `${o.shape}|${W}x${H}|${soft}`;
  if (maskCache.has(key)) return maskCache.get(key);
  const draw = (bg) => {
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }
    const inset = soft * Math.min(W, H) * 1.5; // room for the soft edge inside the box
    ctx.translate(inset, inset);
    if (soft) ctx.filter = `blur(${(soft * Math.min(W, H)).toFixed(1)}px)`;
    ctx.fillStyle = '#fff';
    shapePath(ctx, o.shape, W - inset * 2, H - inset * 2);
    ctx.fill();
    return cv.toDataURL('image/png');
  };
  const v = { css: draw(null), gray: draw('#000') };
  maskCache.set(key, v);
  return v;
}

// Split-screen layouts: boxes as fractions of the canvas, filled in timeline order.
const LAYOUTS = [
  ['side', 'Side by side', [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]]],
  ['stack', 'Top and bottom', [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]]],
  ['three', 'Three across', [[0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]]],
  ['threestack', 'Three stacked', [[0, 0, 1, 1 / 3], [0, 1 / 3, 1, 1 / 3], [0, 2 / 3, 1, 1 / 3]]],
  ['grid', 'Grid of four', [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]]],
  ['bigsmall', 'Big and bubble', [[0, 0, 1, 1], 'bubble']],
];

function applyLayout(id) {
  const [, name, cells] = LAYOUTS.find(([k]) => k === id);
  const t = state.playhead;
  const on = state.overlays.filter((o) => t >= o.start && t < o.start + (o.out - o.in));
  if (on.length < cells.length) {
    toast(`${name} needs ${cells.length} overlays showing at the playhead. You have ${on.length}. Add videos with their Overlay button.`);
    return;
  }
  commit();
  const [W, H] = ASPECTS[state.aspect];
  on.slice(0, cells.length).forEach((o, i) => {
    const c = cells[i];
    delete o.keys;
    o.opacity = 1;
    if (c === 'bubble') {
      Object.assign(o, { shape: 'circle', cell: 1, w: 0.3 * Math.min(1, H / W), soft: false });
      o.x = 1 - o.w / 2 - 0.04;
      o.y = 1 - (o.w * W) / H / 2 - (0.04 * W) / H;
      return;
    }
    const [x0, y0, cw, ch] = c;
    Object.assign(o, { shape: 'none', cell: (cw * W) / (ch * H), w: cw, x: x0 + cw / 2, y: y0 + ch / 2, cropX: 0.5, cropY: 0.5 });
  });
  syncOverlays(true);
  renderAll();
  toast(`${name}: drag the "Move picture" sliders to choose what shows in each box`);
}

function placePip(o, p) {
  const v = kfValue(o, 'overlay', state.playhead - o.start);
  for (const el of [p.media, p.keyCanvas]) {
    el.style.aspectRatio = o.cell ? String(o.cell) : '';
    el.style.objectFit = o.cell ? 'cover' : '';
    el.style.objectPosition = o.cell ? `${(o.cropX ?? 0.5) * 100}% ${(o.cropY ?? 0.5) * 100}%` : '';
    const mask = o.shape && o.shape !== 'none' ? `url(${shapeMask(o).css})` : '';
    el.style.maskImage = el.style.webkitMaskImage = mask;
    el.style.maskSize = el.style.webkitMaskSize = mask ? '100% 100%' : '';
  }
  p.wrap.style.left = `${v.x * 100}%`;
  p.wrap.style.top = `${v.y * 100}%`;
  p.wrap.style.width = `${v.w * 100}%`;
  p.wrap.style.opacity = String(v.opacity);
  p.wrap.style.mixBlendMode = CSS_BLEND[o.blend] || 'normal';
  p.media.style.filter = cssFilter(o);
  p.keyCanvas.style.filter = cssFilter(o);
  p.media.style.display = o.key ? 'none' : '';
  p.keyCanvas.style.display = o.key ? 'block' : 'none';
  p.wrap.classList.toggle('selected', Boolean(isSel('overlay', o.id)));
}

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// Green screen, the same way FFmpeg's colorkey does it: the further a pixel's colour is
// from the key colour, the more solid it stays.
function drawKey(o, p) {
  if (!o.key || !p) return;
  const src = p.media;
  const nw = p.image ? src.naturalWidth : src.videoWidth;
  const nh = p.image ? src.naturalHeight : src.videoHeight;
  if (!nw || !nh) return;
  const w = Math.min(nw, 640);
  const hgt = Math.max(1, Math.round((nh * w) / nw));
  const cv = p.keyCanvas;
  if (cv.width !== w || cv.height !== hgt) { cv.width = w; cv.height = hgt; }
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, hgt);
  let img;
  try {
    img = ctx.getImageData(0, 0, w, hgt);
  } catch {
    // If the system won't let the preview read this file's pixels, show it unkeyed; export still keys it.
    p.keyCanvas.style.display = 'none';
    p.media.style.display = '';
    if (!drawKey.warned) { drawKey.warned = true; toast("The preview can't show the green screen for this file, but the export will."); }
    return;
  }
  const d = img.data;
  const [kr, kg, kb] = hexRgb(o.key.color);
  const sim = o.key.similarity;
  const blend = o.key.blend;
  for (let i = 0; i < d.length; i += 4) {
    const dr = d[i] - kr, dg = d[i + 1] - kg, db = d[i + 2] - kb;
    const diff = Math.sqrt((dr * dr + dg * dg + db * db) / 195075); // 255² × 3
    const a = blend > 0.0001 ? clamp((diff - sim) / blend, 0, 1) : diff > sim ? 1 : 0;
    d[i + 3] = Math.round(d[i + 3] * a);
  }
  ctx.putImageData(img, 0, 0);
}

let pickingKeyFor = null; // overlay id while "Pick colour" is waiting for a click

function pickKeyColour(o, e, wrap) {
  const p = pipEls.get(o.id);
  const src = p.media;
  const nw = p.image ? src.naturalWidth : src.videoWidth;
  const nh = p.image ? src.naturalHeight : src.videoHeight;
  const r = wrap.getBoundingClientRect();
  const cv = document.createElement('canvas');
  cv.width = nw; cv.height = nh;
  const ctx = cv.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const x = clamp(Math.floor(((e.clientX - r.left) / r.width) * nw), 0, nw - 1);
  const y = clamp(Math.floor(((e.clientY - r.top) / r.height) * nh), 0, nh - 1);
  const [cr, cg, cb] = ctx.getImageData(x, y, 1, 1).data;
  commit();
  o.key = { ...(o.key || { similarity: 0.3, blend: 0.1 }), color: `#${[cr, cg, cb].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}` };
  pickingKeyFor = null;
  $('#stage').classList.remove('picking');
  syncOverlays(false);
  renderInspector();
}

function syncOverlays(forceSeek) {
  const t = state.playhead;
  const live = new Set();
  stacked().forEach((o, i) => {
    live.add(o.id);
    const p = pipFor(o);
    placePip(o, p);
    p.wrap.style.zIndex = String(i + 1);
    const local = t - o.start;
    const on = local >= 0 && local < o.out - o.in;
    p.wrap.hidden = !on;
    if (on && o.key) drawKey(o, p);
    if (p.image) return;
    const v = p.media;
    v.muted = !(o.volume > 0);
    v.volume = clamp(o.volume, 0, 1);
    if (!on) { if (!v.paused) v.pause(); return; }
    const target = o.in + local;
    if (v.readyState >= 1 && (forceSeek || (state.playing && Math.abs(v.currentTime - target) > 0.25))) v.currentTime = target;
    if (state.playing) { if (v.paused) v.play().catch(() => {}); } else if (!v.paused) v.pause();
  });
  for (const [id, p] of pipEls) {
    if (live.has(id)) continue;
    if (!p.image) { p.media.pause(); p.media.removeAttribute('src'); }
    p.wrap.remove();
    pipEls.delete(id);
  }
}

// Drag an overlay to move it; drag its corner dot to resize it.
$('#pipLayer').addEventListener('pointerdown', (e) => {
  const wrap = e.target.closest('.pip');
  if (!wrap || e.button !== 0) return;
  const o = state.overlays.find((x) => x.id === wrap.dataset.id);
  if (!o) return;
  e.preventDefault();
  if (pickingKeyFor === o.id) { pickKeyColour(o, e, wrap); return; }
  if (state.playing) pause();
  select('overlay', o.id);
  const rect = $('#stage').getBoundingClientRect();
  const resize = e.target.classList.contains('pip-resize');
  const start = valuesNow('overlay', o);
  const sx = e.clientX;
  const sy = e.clientY;
  const before = snapshot();
  let changed = false;
  wrap.setPointerCapture(e.pointerId);
  const move = (ev) => {
    if (!changed && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 3) return;
    changed = true;
    if (resize) {
      const cx = rect.left + start.x * rect.width;
      kset(o, 'overlay', { w: clamp((2 * Math.abs(ev.clientX - cx)) / rect.width, 0.05, 1.5) });
    } else {
      kset(o, 'overlay', {
        x: clamp(start.x + (ev.clientX - sx) / rect.width, 0, 1),
        y: clamp(start.y + (ev.clientY - sy) / rect.height, 0, 1),
      });
    }
    placePip(o, pipEls.get(o.id));
  };
  const up = () => {
    wrap.removeEventListener('pointermove', move);
    wrap.removeEventListener('pointerup', up);
    wrap.removeEventListener('pointercancel', up);
    if (changed) { pushHistory(before); renderInspector(); }
  };
  wrap.addEventListener('pointermove', move);
  wrap.addEventListener('pointerup', up);
  wrap.addEventListener('pointercancel', up);
});

// ---------- crossfade layer

function hideCross() {
  if (!videoB.paused) videoB.pause();
  videoB.hidden = true;
  stillB.hidden = true;
  resetTransitionLook(layers);
  $('#transPix').hidden = true;
}

// Pixelate: draw both clips small, blended, and let the browser scale them up blocky.
function drawPixelate(p) {
  const stage = $('#stage');
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  const cell = Math.max(1, Math.round((1 - Math.abs(2 * p - 1)) * 0.026 * W)); // block size matched to FFmpeg's pixelize
  const cv = $('#transPix');
  cv.hidden = false;
  cv.width = Math.max(1, Math.round(W / cell));
  cv.height = Math.max(1, Math.round(H / cell));
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cv.width, cv.height);
  const draw = (el, alpha) => {
    const nw = el.videoWidth || el.naturalWidth;
    const nh = el.videoHeight || el.naturalHeight;
    if (!nw || !nh) return;
    const s = Math.min(cv.width / nw, cv.height / nh);
    ctx.globalAlpha = alpha;
    ctx.filter = el.style.filter || 'none';
    try { ctx.drawImage(el, (cv.width - nw * s) / 2, (cv.height - nh * s) / 2, nw * s, nh * s); } catch { /* not ready yet */ }
  };
  draw(video.hidden ? still : video, 1);
  draw(videoB.hidden ? stillB : videoB, p);
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
}

// Shake cut: the shake runs on after the cut, for the transition's length.
function applyShakeCut() {
  const H = $('#stage').clientHeight;
  const starts = clipStarts();
  const t = state.playhead;
  state.clips.forEach((c, i) => {
    if (i === 0 || c.transitionType !== 'shake' || !(c.transition > 0)) return;
    const tf = shakeTransform(t, starts[i], c.transition, H);
    if (tf) { layers.A.style.transform = tf; layers.B.style.transform = tf; }
  });
}

function syncCross(forceSeek) {
  syncCrossLayer(forceSeek);
  applyShakeCut();
}

function styleCross(x) {
  const stage = $('#stage');
  const kind = applyTransitionLook(layers, x.clip.transitionType || 'cross', x.clip.transitionDir || 'left', x.alpha,
    stage.clientWidth, stage.clientHeight, state.playhead);
  if (kind === 'pixelate') drawPixelate(x.alpha);
  else $('#transPix').hidden = true;
}

function syncCrossLayer(forceSeek) {
  const x = crossAt(state.playhead);
  if (!x) {
    if (videoB.hidden && stillB.hidden) { resetTransitionLook(layers); return; }
    // Straight after a transition, hold the incoming layer until the main preview has its frame.
    const caughtUp = !video.hidden ? video.readyState >= 2 && !video.seeking : true;
    if (state.playing && performance.now() < handoffUntil && !caughtUp) return;
    hideCross();
    return;
  }
  const m = mediaById(x.clip.mediaId);
  const main = state.clips[currentIndex];
  const mainVol = main && main.volume != null ? main.volume : 1;
  video.volume = clamp(mainVol * (1 - x.alpha), 0, 1);
  if (isImage(m)) {
    if (!videoB.paused) videoB.pause();
    videoB.hidden = true;
    stillB.hidden = false;
    if (stillB.dataset.mediaId !== m.id) { stillB.src = m.url; stillB.dataset.mediaId = m.id; }
    stillB.style.filter = cssFilter(x.clip);
    stillB.style.transform = clipZoomTransform(x.clip, Math.max(0, (x.src - x.clip.in) / spd(x.clip)));
    stillB.style.clipPath = clipCropPath(x.clip);
    styleCross(x);
    return;
  }
  stillB.hidden = true;
  videoB.hidden = false;
  const dB = derivedFor(x.clip);
  const bSrc = dB ? dB.url : srcFor(m);
  const bTime = dB ? x.src - x.clip.in : x.src;
  if (videoB.dataset.src !== bSrc) { videoB.src = bSrc; videoB.dataset.src = bSrc; videoB.dataset.mediaId = m.id; }
  videoB.style.filter = cssFilter(x.clip);
  videoB.style.transform = clipZoomTransform(x.clip, Math.max(0, (x.src - x.clip.in) / spd(x.clip)));
  videoB.style.clipPath = clipCropPath(x.clip);
  styleCross(x);
  videoB.defaultPlaybackRate = clampRate(speedNow(x.clip, timeOff(x.clip, x.src - x.clip.in)));
  videoB.playbackRate = videoB.defaultPlaybackRate;
  videoB.volume = clamp((x.clip.volume == null ? 1 : x.clip.volume) * x.alpha, 0, 1);
  if (videoB.readyState >= 1 && (forceSeek || (state.playing && Math.abs(videoB.currentTime - bTime) > 0.25))) videoB.currentTime = bTime;
  if (state.playing) { if (videoB.paused) videoB.play().catch(() => {}); } else if (!videoB.paused) videoB.pause();
}
videoB.addEventListener('loadedmetadata', () => syncCross(true));

function seek(t) {
  state.playhead = clamp(t, 0, totalDuration());
  handoffUntil = 0;
  loadClipAt(state.playhead, state.playing);
  syncAudio(true);
  syncOverlays(true);
  syncCross(true);
  // The panel shows values at the playhead, so refresh it for an item with keyframes.
  const sel = state.selected;
  if (sel && !state.playing && ['clip', 'overlay', 'sticker'].includes(sel.kind)) {
    const list = sel.kind === 'clip' ? state.clips : sel.kind === 'overlay' ? state.overlays : state.stickers;
    const it = list.find((x) => x.id === sel.id);
    if (it && it.keys && it.keys.length && !(document.activeElement && document.activeElement.matches('#inspector input'))) renderInspector();
  }
  updatePlayheadUI();
  updateOverlay();
}

function refreshPreview() {
  overlayKey = null;
  seek(state.playhead);
}

function play() {
  const total = totalDuration();
  if (!total) return;
  if (state.playhead >= total - 0.02) state.playhead = 0;
  state.playing = true;
  loadClipAt(state.playhead, true);
  syncAudio(true);
  syncOverlays(true);
  syncCross(true);
  setPlayIcon();
}

function pause() {
  state.playing = false;
  video.pause();
  voiceEl.pause();
  syncAudio(false);
  syncOverlays(false);
  syncCross(false);
  setPlayIcon();
}

const togglePlay = () => { stopShuttle(); return state.playing ? pause() : play(); };

// ---------- J / K / L shuttle: L plays forwards (again: 2×, 4×, 8×), J backwards, K stops.
// Above 1× and backwards, the preview steps through frames silently.
let shuttle = { dir: 0, rate: 0, raf: 0, last: 0 };
function stopShuttle() {
  if (shuttle.raf) cancelAnimationFrame(shuttle.raf);
  shuttle = { dir: 0, rate: 0, raf: 0, last: 0 };
}
function shuttleStep(now) {
  const dt = Math.min(0.1, (now - shuttle.last) / 1000);
  shuttle.last = now;
  const t = clamp(state.playhead + shuttle.dir * shuttle.rate * dt, 0, totalDuration());
  seek(t);
  if (t <= 0 || t >= totalDuration()) { stopShuttle(); return; }
  shuttle.raf = requestAnimationFrame(shuttleStep);
}
function shuttleGo(dir) {
  if (!totalDuration()) return;
  const same = shuttle.dir === dir || (dir === 1 && state.playing && !shuttle.dir);
  const rate = same ? Math.min(8, (shuttle.rate || 1) * 2) : 1;
  stopShuttle();
  if (dir === 1 && rate === 1) { if (!state.playing) play(); return; }
  if (state.playing) pause();
  shuttle = { dir, rate, raf: requestAnimationFrame(shuttleStep), last: performance.now() };
  toast(`${dir < 0 ? 'Backwards' : 'Forwards'} ${rate}×`);
}

// ---------- ripple delete: remove clips and pull everything after them along, so it stays in sync

function rippleDelete() {
  const clipSel = selection.filter((s) => s.kind === 'clip');
  if (!clipSel.length) { deleteSelected(); return; }
  const starts = clipStarts();
  const removed = state.clips
    .map((c, i) => ({ c, a: starts[i], b: starts[i] + clipLen(c) }))
    .filter((x) => clipSel.some((s) => s.id === x.c.id))
    .map(({ a, b }) => ({ a, b }))
    .sort((x, y) => x.a - y.a);
  deleteSelected(); // one undo step: it commits first
  const R = (t) => rippleTime(t, removed);
  for (const x of [...state.texts, ...state.stickers]) {
    const a = R(x.start);
    const e = R(x.start + x.dur);
    if (x.words) x.words = x.words.map((w) => ({ ...w, s: R(x.start + w.s) - a, ...(w.e != null ? { e: R(x.start + w.e) - a } : {}) }));
    x.start = a;
    x.dur = e - a;
  }
  state.texts = state.texts.filter((x) => x.dur >= 0.15);
  state.stickers = state.stickers.filter((x) => x.dur >= 0.15);
  for (const x of [...state.audio, ...state.overlays]) x.start = R(x.start);
  overlayKey = null;
  renderAll();
  refreshPreview();
  toast('Deleted, and moved everything after it along to keep it in sync');
}

// ---------- shortcuts you can change

const KEY_ACTIONS = [
  ['play', 'Play or pause', 'Space', () => togglePlay()],
  ['split', 'Split at playhead', 'S', () => splitAtPlayhead()],
  ['text', 'Add text', 'T', () => addText()],
  ['sticker', 'Add a sticker', 'E', () => openPicker('add')],
  ['delete', 'Remove selected', 'Delete', () => deleteSelected()],
  ['ripple', 'Remove and close the gap', 'Shift+Delete', () => rippleDelete()],
  ['back', 'Back one frame', 'ArrowLeft', () => stepFrame(-1)],
  ['fwd', 'Forward one frame', 'ArrowRight', () => stepFrame(1)],
  ['start', 'Go to the start', 'Home', () => seek(0)],
  ['end', 'Go to the end', 'End', () => seek(totalDuration())],
  ['shuttleBack', 'Play backwards (again: faster)', 'J', () => shuttleGo(-1)],
  ['shuttleStop', 'Stop', 'K', () => { stopShuttle(); pause(); }],
  ['shuttleFwd', 'Play forwards (again: faster)', 'L', () => shuttleGo(1)],
  ['marker', 'Add a marker', 'M', () => addMarker()],
  ['prevMarker', 'Go to the previous marker', '[', () => jumpMarker(-1)],
  ['nextMarker', 'Go to the next marker', ']', () => jumpMarker(1)],
];
let keyBindings = {};
try { keyBindings = JSON.parse(localStorage.getItem('snippy.keys') || '{}'); } catch { keyBindings = {}; }
const bindingOf = (id) => keyBindings[id] || KEY_ACTIONS.find((x) => x[0] === id)[2];
function comboOf(e) {
  let k = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (k === 'Backspace') k = 'Delete'; // the same on laptops without a Delete key
  return `${e.altKey ? 'Alt+' : ''}${e.shiftKey && k.length > 1 ? 'Shift+' : ''}${k}`;
}
const prettyKey = (c) => c.replace('ArrowLeft', '←').replace('ArrowRight', '→').replace('ArrowUp', '↑').replace('ArrowDown', '↓');
let rebinding = null;
function saveBindings() { try { localStorage.setItem('snippy.keys', JSON.stringify(keyBindings)); } catch { /* not kept */ } }

function stepFrame(dir) {
  pause();
  seek(state.playhead + dir / FPS);
}

function setPlayIcon() {
  const b = $('#playBtn');
  b.innerHTML = state.playing ? ICON_PAUSE : ICON_PLAY;
  b.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  b.title = state.playing ? 'Pause (Space)' : 'Play (Space)';
}

function tick() {
  if (state.playing && currentIndex >= 0) {
    const c = state.clips[currentIndex];
    if (!c) {
      pause();
    } else {
      const starts = clipStarts();
      let ended;
      if (isImage(mediaById(c.mediaId))) {
        state.playhead = stillClock.t0 + (performance.now() - stillClock.w0) / 1000;
        ended = state.playhead >= starts[currentIndex] + clipLen(c) - 0.001;
      } else {
        const vt = video.currentTime;
        const d = derivedFor(c, false);
        if (!video.seeking) state.playhead = starts[currentIndex] + timeOff(c, Math.max(0, d ? vt : vt - c.in));
        ended = (d ? vt >= (c.out - c.in) * (c.mode === 'boomerang' ? 2 : 1) - 0.03 : vt >= c.out - 0.03) || video.ended;
        // A speed curve changes the playback rate as it goes.
        if (c.ramp && !video.seeking) {
          const rate = clampRate(speedNow(c, state.playhead - starts[currentIndex]));
          if (Math.abs(video.playbackRate - rate) > 0.01) { video.playbackRate = rate; if (video.muted) voiceEl.playbackRate = rate; }
        }
        // Keep a changed voice in step with the picture.
        if (video.muted && !voiceEl.paused && Math.abs(voiceEl.currentTime - vt) > 0.15) voiceEl.currentTime = vt;
      }
      if (ended) {
        if (currentIndex < state.clips.length - 1) {
          // With a crossfade the next clip is already part-way in, so carry on from here.
          state.playhead = starts[currentIndex] + clipLen(c);
          if (overlapOf(currentIndex + 1) > 0) handoffUntil = performance.now() + 400;
          loadClipAt(state.playhead + 0.0001, true);
        } else {
          state.playhead = totalDuration();
          pause();
        }
      }
    }
    if (state.playing) { syncAudio(false); syncOverlays(false); syncCross(false); }
    updatePlayheadUI();
    updateOverlay();
  }
  updateMaskPreview();
  drawLutLayers();
  applyAdjustLayers();
  requestAnimationFrame(tick);
}

video.addEventListener('error', () => {
  const m = mediaById(video.dataset.mediaId);
  if (!m || m.proxyUrl || m.proxyState) return;
  // The preview can't play this format, so make a copy it can (the export still uses the original).
  toast(`Making a preview copy of ${m.name} so it can play here. It will export as normal.`);
  queueProxy(m, true);
});

// ---------- preview stage and text overlay

let overlayKey = null;

function fitStage() {
  const wrap = $('#stageWrap');
  const [w, hgt] = ASPECTS[state.aspect];
  const scale = Math.min((wrap.clientWidth - 32) / w, (wrap.clientHeight - 24) / hgt);
  const stage = $('#stage');
  stage.style.width = `${Math.max(0, Math.floor(w * scale))}px`;
  stage.style.height = `${Math.max(0, Math.floor(hgt * scale))}px`;
  overlayKey = null;
  updateOverlay();
}

// Captions are drawn on a canvas the size of the stage, with the same routine
// the export uses (captions.js).
function updateOverlay() {
  const cv = $('#overlay');
  const stage = $('#stage');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(stage.clientWidth * dpr));
  const hgt = Math.max(1, Math.round(stage.clientHeight * dpr));
  if (cv.width !== w || cv.height !== hgt) { cv.width = w; cv.height = hgt; }
  const ctx = cv.getContext('2d');
  drawCaptions(ctx, w, hgt, state.texts, state.playhead, state.stickers);
  // A dashed outline round the selected text (preview only).
  const sel = state.selected && state.selected.kind === 'text' && !state.playing ? captionHits.find((b) => b.id === state.selected.id) : null;
  if (sel) {
    ctx.save();
    ctx.translate(sel.cx * w, sel.cy * hgt);
    ctx.rotate((sel.rot * Math.PI) / 180);
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = '#F0ABFC';
    ctx.strokeRect(-sel.hw * w, -sel.hh * hgt, sel.hw * 2 * w, sel.hh * 2 * hgt);
    ctx.restore();
  }
  syncStickerHits();
}

// For export: one transparent image per stretch of time in which the captions don't change.
async function renderCaptionFrames(total, W, H, fps) {
  const texts = state.texts.filter((x) => x.text.trim() && x.start < total);
  const stickers = state.stickers.filter((s) => s.start < total && !s.effect);
  if (!texts.length && !stickers.length) return null;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  const pts = captionChangePoints(texts, total, fps, stickers);
  const images = [];
  const known = new Map();
  const frames = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const dur = pts[i + 1] - a;
    if (dur <= 0) continue;
    drawCaptions(ctx, W, H, texts, a + 0.25 / fps, stickers);
    const url = cv.toDataURL('image/png');
    let k = known.get(url);
    if (k === undefined) { k = images.length; images.push(url); known.set(url, k); }
    const last = frames[frames.length - 1];
    if (last && last.img === k) last.dur += dur;
    else frames.push({ img: k, dur });
    if (i % 25 === 0) await new Promise((r) => setTimeout(r)); // keep the window responsive
  }
  return { images, frames };
}

// ---------- timeline rendering

// Everything selected; the last one is the item the side panel shows (state.selected).
let selection = [];
let soloPick = false; // the next click picks one item, not its whole group
const isSel = (kind, id) => selection.some((s) => s.kind === kind && s.id === id);
const KIND_CLASS = { clip: 'clip', text: 'text-item', audio: 'audio-item', overlay: 'overlay-item', sticker: 'sticker-item', adjust: 'adjust-item' };
const CLASS_KIND = Object.fromEntries(Object.entries(KIND_CLASS).map(([k, v]) => [v, k]));
const FREE_KINDS = new Set(['text', 'sticker', 'audio', 'overlay', 'adjust']); // items placed freely in time
const GROUP_KINDS = ['text', 'sticker', 'audio', 'overlay', 'adjust']; // what can be grouped
const listOf = (kind) => ({ clip: state.clips, text: state.texts, audio: state.audio, overlay: state.overlays, sticker: state.stickers, adjust: state.adjust })[kind];
const itemOf = (s) => (listOf(s.kind) || []).find((x) => x.id === s.id);
const kindOfEl = (el) => CLASS_KIND[[...el.classList].find((c) => CLASS_KIND[c])];
const labelFor = (x) => x.text.replace(/\n/g, ' ') || 'Empty text';

function renderTimeline() {
  const z = state.zoom;
  const total = totalDuration();
  const textEnd = state.texts.reduce((m, x) => Math.max(m, x.start + x.dur), 0);
  const audioEnd = state.audio.reduce((m, a) => Math.max(m, a.start + a.out - a.in), 0);
  const overlayEnd = state.overlays.reduce((m, o) => Math.max(m, o.start + o.out - o.in), 0);
  const stickerEnd = state.stickers.reduce((m, s) => Math.max(m, s.start + s.dur), 0);
  const width = Math.max($('#tlScroll').clientWidth, (Math.max(total, textEnd, audioEnd, overlayEnd, stickerEnd) + 10) * z);
  content.style.width = `${width}px`;
  renderRuler(width);

  const vt = $('#videoTrack');
  vt.textContent = '';
  const starts = clipStarts();
  state.clips.forEach((c, i) => {
    const m = mediaById(c.mediaId);
    const el = h('div', { class: `clip${isSel('clip', c.id) ? ' selected' : ''}`, 'data-id': c.id },
      h('div', { class: 'handle l' }), h('div', { class: 'handle r' }),
      h('span', { class: 'clip-name' }, `${m.name}  ${fmt(clipLen(c))}${c.ramp ? '  speed curve' : spd(c) !== 1 ? `  ${spd(c)}×` : ''}`));
    el.style.left = `${starts[i] * z}px`;
    el.style.width = `${Math.max(4, clipLen(c) * z)}px`;
    if (m.thumb) el.style.backgroundImage = `url("${m.thumb}")`;
    addKfMarks(el, c, z);
    vt.append(el);
  });
  // A button on every cut: click it to pick a transition (CapCut-style). Cuts with one show it.
  state.clips.forEach((c, i) => {
    if (i === 0) {
      if (!(c.transition > 0)) return;
      const mk = h('div', { class: 'transition-mark', 'data-id': c.id, title: 'Fade in from black' });
      mk.style.left = `${starts[0] * z}px`;
      vt.append(mk);
      return;
    }
    const has = c.transition > 0;
    const ov = overlapOf(i);
    const mk = h('button', {
      class: `xjoin${has ? ' on' : ''}`, 'data-id': c.id, 'data-cut': String(i), type: 'button',
      title: has ? `${c.transitionType === 'dip' || !c.transitionType ? 'Dip to black' : transitionName(c.transitionType)} (click to change)` : 'Add a transition',
      'aria-label': has ? `Transition: ${transitionName(c.transitionType)}. Change it` : `Add a transition between clip ${i} and clip ${i + 1}`,
    }, has ? xjoinIcon() : '+');
    mk.style.left = `${(starts[i] + ov / 2) * z}px`;
    vt.append(mk);
  });

  const adt = $('#adjustTrack');
  adt.textContent = '';
  for (const x of state.adjust) {
    const el = h('div', { class: `adjust-item${isSel('adjust', x.id) ? ' selected' : ''}`, 'data-id': x.id },
      h('div', { class: 'handle l' }), h('div', { class: 'handle r' }),
      h('span', { class: 'text-label' }, `Adjust  ${fmt(x.dur)}`));
    el.style.left = `${x.start * z}px`;
    el.style.width = `${Math.max(6, x.dur * z)}px`;
    adt.append(el);
  }

  const st = $('#stickerTrack');
  st.textContent = '';
  for (const s of state.stickers) {
    const el = h('div', { class: `sticker-item${isSel('sticker', s.id) ? ' selected' : ''}`, 'data-id': s.id },
      h('div', { class: 'handle l' }), h('div', { class: 'handle r' }),
      h('span', { class: 'text-label' }, `${stickerLabel(s)}  ${fmt(s.dur)}`));
    el.style.left = `${s.start * z}px`;
    el.style.width = `${Math.max(6, s.dur * z)}px`;
    addKfMarks(el, s, z);
    st.append(el);
  }

  const tt = $('#textTrack');
  tt.textContent = '';
  for (const x of state.texts) {
    const el = h('div', { class: `text-item${isSel('text', x.id) ? ' selected' : ''}`, 'data-id': x.id },
      h('div', { class: 'handle l' }), h('div', { class: 'handle r' }),
      h('span', { class: 'text-label' }, labelFor(x)));
    el.style.left = `${x.start * z}px`;
    el.style.width = `${Math.max(6, x.dur * z)}px`;
    addKfMarks(el, x, z);
    tt.append(el);
  }

  const at = $('#audioTrack');
  at.textContent = '';
  for (const a of state.audio) {
    const m = mediaById(a.mediaId);
    const len = a.out - a.in;
    const el = h('div', { class: `audio-item${isSel('audio', a.id) ? ' selected' : ''}`, 'data-id': a.id },
      h('div', { class: 'handle l' }), h('div', { class: 'handle r' }),
      h('span', { class: 'clip-name' }, `${m.name}  ${fmt(len)}`));
    el.style.left = `${a.start * z}px`;
    el.style.width = `${Math.max(6, len * z)}px`;
    if (m.thumb) {
      // Stretch the whole waveform to the source length, then offset it so the trimmed part shows.
      el.style.backgroundImage = `url("${m.thumb}")`;
      el.style.backgroundSize = `${m.duration * z}px 100%`;
      el.style.backgroundPosition = `${-a.in * z}px 0`;
    }
    for (const b of a.beats || []) {
      if (b < a.in || b > a.out) continue;
      const mk = h('div', { class: 'beat-mark' });
      mk.style.left = `${(b - a.in) * z}px`;
      el.append(mk);
    }
    if (a.keys && a.keys.length) el.append(volumeLine(a, len, z));
    addKfMarks(el, a, z);
    at.append(el);
  }

  const ot = $('#overlayTrack');
  ot.textContent = '';
  sizeOverlayRow();
  const lanes = laneCount();
  for (const o of state.overlays) {
    const m = mediaById(o.mediaId);
    const len = o.out - o.in;
    const el = h('div', { class: `overlay-item${isSel('overlay', o.id) ? ' selected' : ''}`, 'data-id': o.id },
      h('div', { class: 'handle l' }), h('div', { class: 'handle r' }),
      h('span', { class: 'clip-name' }, `${m.name}  ${fmt(len)}`));
    el.style.top = `${5 + (lanes - 1 - laneOf(o)) * (LANE_H + 4)}px`;
    el.style.height = `${LANE_H}px`;
    el.style.bottom = 'auto';
    el.style.left = `${o.start * z}px`;
    el.style.width = `${Math.max(6, len * z)}px`;
    if (m.thumb) el.style.backgroundImage = `url("${m.thumb}")`;
    addKfMarks(el, o, z);
    ot.append(el);
  }
  updatePlayheadUI();
  if (typeof markNewItems === 'function') markNewItems();
  markGroups();
}

function renderRuler(width) {
  const r = $('#ruler');
  r.textContent = '';
  const z = state.zoom;
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find((s) => s * z >= 80) || 600;
  const minor = step / 5;
  const count = Math.ceil(width / z / minor);
  const frag = document.createDocumentFragment();
  for (let i = 0; i <= count; i++) {
    const t = i * minor;
    const major = i % 5 === 0;
    const tick = h('div', { class: `tick${major ? ' major' : ''}` });
    tick.style.left = `${t * z}px`;
    if (major) tick.append(h('span', {}, fmtShort(t)));
    frag.append(tick);
  }
  for (const mk of state.markers || []) {
    const el = h('div', { class: 'marker', 'data-id': mk.id, title: `${mk.label || 'Marker'} at ${fmt(mk.t)} (drag to move, right-click for more)` },
      h('span', { class: 'marker-flag' }, mk.label || ''));
    el.style.left = `${mk.t * z}px`;
    frag.append(el);
  }
  r.append(frag);
  // A faint line down through the tracks for each marker.
  const content = $('#tlContent');
  for (const old of content.querySelectorAll(':scope > .marker-line')) old.remove();
  for (const mk of state.markers || []) {
    const ln = h('div', { class: 'marker-line' });
    ln.style.left = `${mk.t * z}px`;
    content.append(ln);
  }
}

// ---------- markers: M drops one at the playhead. Click one to jump there, drag to move it,
// right-click to rename or remove it. Items being dragged snap to them.

function addMarker(t = state.playhead, label = '') {
  const near = (state.markers || []).find((m) => Math.abs(m.t - t) < 0.05);
  if (near) { toast('There\'s already a marker here'); return; }
  commit();
  state.markers = [...(state.markers || []), { id: newId('m'), t: Number(t.toFixed(3)), label }].sort((a, b) => a.t - b.t);
  renderTimeline();
  toast(`Marker ${state.markers.findIndex((m) => Math.abs(m.t - t) < 0.001) + 1} at ${fmt(t)}`);
}

function jumpMarker(dir) {
  const list = (state.markers || []).map((m) => m.t).sort((a, b) => a - b);
  const t = state.playhead;
  const next = dir > 0 ? list.find((x) => x > t + 0.01) : [...list].reverse().find((x) => x < t - 0.01);
  if (next == null) { toast(list.length ? (dir > 0 ? 'No more markers after this' : 'No markers before this') : 'No markers yet: press M to add one'); return; }
  if (state.playing) pause();
  seek(next);
}

function renameMarker(mk) {
  const el = document.querySelector(`.marker[data-id="${mk.id}"]`);
  if (!el) return;
  const input = h('input', { class: 'marker-input', type: 'text', value: mk.label || '', maxlength: '30', placeholder: 'Name' });
  el.append(input);
  // Focused just after the click has finished, or the click itself would take the focus away again.
  setTimeout(() => { input.focus(); input.select(); }, 30);
  let finished = false;
  const done = (keep) => {
    if (finished) return;
    finished = true;
    if (keep && input.value.trim() !== (mk.label || '')) { commit(); mk.label = input.value.trim(); markDirty(); }
    input.remove();
    renderTimeline();
  };
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
  input.addEventListener('blur', () => done(true));
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
}

let lastMarkerClick = { id: null, at: 0 };
$('#ruler').addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.marker');
  if (!el || e.button !== 0 || e.target.closest('.marker-input')) return;
  e.preventDefault();
  e.stopPropagation();
  const mk = state.markers.find((m) => m.id === el.dataset.id);
  if (!mk) return;
  const sx = e.clientX;
  const t0 = mk.t;
  const before = snapshot();
  let moved = false;
  el.setPointerCapture(e.pointerId);
  const move = (ev) => {
    if (!moved && Math.abs(ev.clientX - sx) < 4) return;
    moved = true;
    const raw = Math.max(0, t0 + (ev.clientX - sx) / state.zoom);
    mk.t = Number((raw + snapDelta([raw], mk.id, ev)).toFixed(3));
    el.style.left = `${mk.t * state.zoom}px`;
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    $('#snapLine').hidden = true;
    if (moved) { state.markers.sort((a, b) => a.t - b.t); pushHistory(before); markDirty(); renderTimeline(); return; }
    // A second click on the same marker straight after: name it. Otherwise jump to it.
    const now = Date.now();
    if (lastMarkerClick.id === mk.id && now - lastMarkerClick.at < 450) { lastMarkerClick = { id: null, at: 0 }; renameMarker(mk); return; }
    lastMarkerClick = { id: mk.id, at: now };
    if (state.playing) pause();
    seek(mk.t);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}, true);
$('#ruler').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const el = e.target.closest('.marker');
  if (el) {
    const mk = state.markers.find((m) => m.id === el.dataset.id);
    if (!mk) return;
    openCtx(e.clientX, e.clientY, [
      { title: `${mk.label || 'Marker'} at ${fmt(mk.t)}` },
      { label: 'Go to marker', onClick: () => seek(mk.t) },
      { label: 'Rename…', onClick: () => renameMarker(mk) },
      '-',
      { label: 'Remove marker', danger: true, onClick: () => { commit(); state.markers = state.markers.filter((m) => m !== mk); markDirty(); renderTimeline(); } },
      state.markers.length > 1 ? { label: `Remove all ${state.markers.length} markers`, danger: true, onClick: () => { commit(); state.markers = []; markDirty(); renderTimeline(); } } : null,
    ]);
    return;
  }
  const t = Math.max(0, timeAtClientX(e.clientX));
  const music = state.audio.find((a) => a.beats && a.beats.length);
  openCtx(e.clientX, e.clientY, [
    { title: `At ${fmt(t)}` },
    { label: 'Add a marker here', key: keyHint('marker'), onClick: () => addMarker(t) },
    music ? { label: 'Add a marker on every 4th beat', onClick: () => {
      commit();
      const at = music.beats.filter((b) => b >= music.in && b <= music.out).map((b) => music.start + b - music.in).filter((_, i) => i % 4 === 0);
      const have = new Set((state.markers || []).map((m) => m.t.toFixed(2)));
      state.markers = [...(state.markers || []), ...at.filter((x) => !have.has(x.toFixed(2))).map((x) => ({ id: newId('m'), t: Number(x.toFixed(3)), label: '' }))].sort((a, b) => a.t - b.t);
      markDirty(); renderTimeline();
      toast(`Added ${at.length} markers on the beat`);
    } } : null,
  ]);
});

// ---------- video effects (preview). Export builds the same looks from FFmpeg filters
// (fxFilters in main.js); the shake, glitch jitter and flicker use the same formulas.

const FX_LIST = [['none', 'None'], ['grain', 'Grain'], ['vhs', 'VHS'], ['oldfilm', 'Old film'], ['glitch', 'Glitch'], ['shake', 'Shake']];
let grainImage = null;

function updateFx() {
  const c = state.clips[currentIndex];
  const fx = c && c.fx && c.fx !== 'none' ? c.fx : null;
  const base = c ? cssFilter(c) : 'none';
  const layer = $('#fxLayer');
  const zoomT = c ? clipZoomTransform(c, Math.max(0, state.playhead - clipStarts()[currentIndex])) : '';
  const cropP = c ? clipCropPath(c) : '';
  for (const el of [video, still]) el.style.clipPath = cropP;
  if (!fx) {
    layer.hidden = true;
    for (const el of [video, still]) { el.style.transform = zoomT; el.style.filter = base; }
    return;
  }
  const stage = $('#stage');
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  const u = Math.max(0, state.playhead - clipStarts()[currentIndex]);
  const R = Math.max(1, 0.003 * H);
  const split = (r) => ` drop-shadow(${-r}px 0 0 rgba(255,0,60,.55)) drop-shadow(${r}px 0 0 rgba(0,200,255,.55))`;
  let extra = '';
  let transform = '';
  let grain = 0;
  let scan = false;
  let vignette = false;
  if (fx === 'grain') grain = 0.35;
  if (fx === 'vhs') { extra = ` saturate(1.35) contrast(1.08) blur(0.5px)${split(R)}`; grain = 0.15; scan = true; }
  if (fx === 'oldfilm') {
    const b = 0.045 * Math.sin(u * 47) + 0.03 * Math.sin(u * 29.3) - 0.02;
    extra = ` grayscale(1) brightness(${(1 + b * 1.8).toFixed(3)})`;
    grain = 0.45;
    vignette = true;
  }
  if (fx === 'glitch') {
    extra = split(2 * R);
    const dx = u % 1.7 < 0.15 ? 0.02 * W * Math.sin(u * 90) : 0;
    transform = `translateX(${(-dx).toFixed(1)}px) scale(1.04)`;
  }
  if (fx === 'shake') {
    const dx = H * (0.011 * Math.sin(u * 37) + 0.0075 * Math.sin(u * 23.3));
    const dy = H * (0.009 * Math.sin(u * 29.1) + 0.0055 * Math.sin(u * 41.7));
    transform = `translate(${(-dx).toFixed(1)}px, ${(-dy).toFixed(1)}px) scale(1.06)`;
  }
  const filter = (base === 'none' ? '' : base) + extra;
  // The effect's own movement goes on top of the clip's zoom and pan, as in the export.
  for (const el of [video, still]) { el.style.transform = `${transform} ${zoomT}`.trim(); el.style.filter = filter.trim() || 'none'; }
  layer.hidden = !(grain || scan || vignette);
  const g = $('#fxGrain');
  g.style.opacity = String(grain);
  if (grain) {
    const ctx = g.getContext('2d');
    if (!grainImage) { g.width = 320; g.height = 180; grainImage = ctx.createImageData(320, 180); }
    const d = grainImage.data;
    for (let i = 0; i < d.length; i += 4) { const v = Math.random() * 255; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    ctx.putImageData(grainImage, 0, 0);
  }
  const per = Math.max(2, (4 * H) / 1080);
  $('#fxScan').style.background = scan ? `repeating-linear-gradient(to bottom, rgba(0,0,0,.22) 0, rgba(0,0,0,.22) ${per / 3}px, transparent ${per / 3}px, transparent ${per}px)` : 'none';
  $('#fxVignette').style.background = vignette ? 'radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,.6) 100%)' : 'none';
}

// Seconds of fade at the start and end of each clip. A transition dips through
// black: half of it ends the clip before, half starts this one.
function fadeInfo() {
  const n = state.clips.length;
  return state.clips.map((c, i) => {
    const L = clipLen(c);
    let fin = 0;
    let fout = 0;
    const tr = c.transition || 0;
    if (tr > 0 && (i === 0 || !isCross(c))) fin = i === 0 ? Math.min(tr, L / 2) : Math.min(tr / 2, L / 2, clipLen(state.clips[i - 1]) / 2);
    if (i < n - 1) {
      const next = state.clips[i + 1];
      if (next.transition > 0 && !isCross(next)) fout = Math.min(next.transition / 2, L / 2, clipLen(next) / 2);
    } else if (c.endFade > 0) {
      fout = Math.min(c.endFade, L / 2);
    }
    return { fin, fout };
  });
}

function dipOpacity(t) {
  const loc = locate(t);
  if (!loc) return 0;
  const { fin, fout } = fadeInfo()[loc.index];
  const L = clipLen(loc.clip);
  const local = t - loc.start;
  let op = 0;
  if (fin > 0 && local < fin) op = 1 - local / fin;
  if (fout > 0 && local > L - fout) op = Math.max(op, 1 - (L - local) / fout);
  return clamp(op, 0, 1);
}

// The volume over time, drawn across a sound that has volume keyframes.
function volumeLine(a, len, z) {
  const w = Math.max(6, len * z);
  const n = Math.min(400, Math.max(2, Math.ceil(w / 4)));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const u = (len * i) / n;
    pts.push(`${((u * z)).toFixed(1)},${(100 - kfValue(a, 'audio', u).volume * 100).toFixed(1)}`);
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'vol-line');
  svg.setAttribute('viewBox', `0 0 ${w.toFixed(1)} 100`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.innerHTML = `<polyline points="${pts.join(' ')}"/>`;
  return svg;
}

function addKfMarks(el, item, z) {
  for (const k of item.keys || []) {
    const mk = h('div', { class: 'kf-mark', 'data-t': String(k.t), title: `Keyframe at ${fmt(k.t)}` });
    mk.style.left = `${k.t * z}px`;
    el.append(mk);
  }
}

function updatePlayheadUI() {
  updateFx();
  updateMeter();
  $('#dip').style.opacity = String(dipOpacity(state.playhead));
  $('#playhead').style.left = `${state.playhead * state.zoom}px`;
  $('#tcNow').textContent = fmt(state.playhead);
  $('#tcTotal').textContent = fmt(totalDuration());
  if (state.playing) {
    const sc = $('#tlScroll');
    const x = state.playhead * state.zoom;
    if (x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = x - 80;
    else if (x < sc.scrollLeft) sc.scrollLeft = x - 40;
  }
}

// mode: 'replace' (just this), 'toggle' (Ctrl+click), or 'keep' (this one, keeping the rest selected).
function select(kind, id, mode = 'replace') {
  if (!kind) selection = [];
  else if (mode === 'toggle') {
    // A grouped item comes and goes with the rest of its group.
    const all = withGroup({ kind, id });
    const i = selection.findIndex((s) => s.kind === kind && s.id === id);
    if (i >= 0) selection = selection.filter((s) => !all.some((g) => g.kind === s.kind && g.id === s.id));
    else selection.push(...all.filter((g) => !isSel(g.kind, g.id)));
  } else if (mode === 'keep' && isSel(kind, id)) {
    selection = [...selection.filter((s) => !(s.kind === kind && s.id === id)), { kind, id }];
  } else selection = soloPick ? [{ kind, id }] : withGroup({ kind, id });
  soloPick = false;
  refreshSelectionUI();
  renderInspector();
}

function refreshSelectionUI() {
  selection = selection.filter((s) => itemOf(s));
  state.selected = selection.length ? selection[selection.length - 1] : null;
  content.querySelectorAll('.selected').forEach((el) => el.classList.remove('selected'));
  for (const s of selection) {
    const el = content.querySelector(`.${KIND_CLASS[s.kind]}[data-id="${s.id}"]`);
    if (el) el.classList.add('selected');
  }
  syncOverlays(false);
  syncStickerHits();
  updateToolbar();
}

// Dragging an item that's part of a bigger selection moves the other free items with it.
function groupWith(kind, id) {
  if (selection.length < 2 || !isSel(kind, id)) return [];
  return selection
    .filter((s) => !(s.kind === kind && s.id === id) && FREE_KINDS.has(s.kind))
    .map((s) => ({ item: itemOf(s), start: itemOf(s).start }))
    .filter((g) => g.item);
}
const moveGroup = (group, delta) => { for (const g of group) g.item.start = Math.max(0, g.start + delta); };

// ---------- timeline interaction

const timeAtClientX = (clientX) => (clientX - content.getBoundingClientRect().left) / state.zoom;

// ---------- snapping

let snapOn = true;
try { snapOn = localStorage.getItem('snippy.snap') !== 'off'; } catch { /* storage unavailable */ }

// Everything an edge can snap to: the playhead, the start, and every item's edges.
function snapPoints(skipId) {
  const pts = [0, state.playhead];
  const starts = clipStarts();
  state.clips.forEach((c, i) => { if (c.id !== skipId) pts.push(starts[i], starts[i] + clipLen(c)); });
  for (const x of state.texts) if (x.id !== skipId) pts.push(x.start, x.start + x.dur);
  for (const s of state.stickers) if (s.id !== skipId) pts.push(s.start, s.start + s.dur);
  for (const a of state.audio) {
    if (a.id !== skipId) pts.push(a.start, a.start + a.out - a.in);
    for (const b of a.beats || []) if (b >= a.in && b <= a.out) pts.push(a.start + b - a.in); // beats too
  }
  for (const o of state.overlays) if (o.id !== skipId) pts.push(o.start, o.start + o.out - o.in);
  for (const mk of state.markers || []) if (mk.id !== skipId) pts.push(mk.t);
  return pts;
}

// How far to nudge so one of `times` lands on a snap point within 8 px. Hold Alt to drag freely.
function snapDelta(times, skipId, ev) {
  const line = $('#snapLine');
  line.hidden = true;
  if (!snapOn || (ev && ev.altKey)) return 0;
  const limit = 8 / state.zoom;
  let best = null;
  for (const p of snapPoints(skipId)) {
    for (const t of times) {
      const d = p - t;
      if (Math.abs(d) <= limit && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, p };
    }
  }
  if (!best) return 0;
  line.hidden = false;
  line.style.left = `${best.p * state.zoom}px`;
  return best.d;
}

function setSnap(on) {
  snapOn = on;
  $('#snapBtn').setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('snippy.snap', on ? 'on' : 'off'); } catch { /* storage unavailable */ }
}

// Pointer capture lives on the timeline itself, so its children can re-render mid-drag.
function drag(e, { onMove, onEnd }) {
  const startX = e.clientX;
  content.setPointerCapture(e.pointerId);
  const move = (ev) => onMove(ev.clientX - startX, ev);
  const up = (ev) => {
    $('#snapLine').hidden = true;
    content.removeEventListener('pointermove', move);
    content.removeEventListener('pointerup', up);
    content.removeEventListener('pointercancel', up);
    onEnd(ev.clientX - startX, ev);
  };
  content.addEventListener('pointermove', move);
  content.addEventListener('pointerup', up);
  content.addEventListener('pointercancel', up);
}

content.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  soloPick = e.altKey; // Alt+click: just this one, even if it's in a group
  // A keyframe diamond: select its item and jump to that moment.
  const kfEl = e.target.closest('.kf-mark');
  if (kfEl) {
    const host = kfEl.parentElement;
    const id = host.dataset.id;
    if (state.playing) pause();
    const kind = kindOfEl(host);
    const item = itemOf({ kind, id });
    const start = kind === 'clip' ? clipStarts()[state.clips.indexOf(item)] : item.start;
    select(kind, id);
    seek(start + Number(kfEl.dataset.t));
    renderInspector();
    return;
  }
  const joinEl = e.target.closest('.xjoin');
  if (joinEl) { e.preventDefault(); e.stopPropagation(); openTransitionPop(Number(joinEl.dataset.cut), joinEl); return; }
  const markEl = e.target.closest('.transition-mark');
  if (markEl) { if (state.playing) pause(); select('clip', markEl.dataset.id); return; }
  // Ctrl+click adds or removes an item from the selection.
  const anyItem = e.target.closest('.clip, .text-item, .audio-item, .overlay-item, .sticker-item');
  if (anyItem && (e.ctrlKey || e.metaKey)) {
    if (state.playing) pause();
    select(kindOfEl(anyItem), anyItem.dataset.id, 'toggle');
    return;
  }
  const clipEl = e.target.closest('.clip');
  const textEl = e.target.closest('.text-item');
  const audioEl = e.target.closest('.audio-item');
  const overlayEl = e.target.closest('.overlay-item');
  if (overlayEl) return startAudioDrag(e, overlayEl, 'overlay');
  if (clipEl) return startClipDrag(e, clipEl);
  if (textEl) return startTextDrag(e, textEl);
  const stickerEl = e.target.closest('.sticker-item');
  if (stickerEl) return startTextDrag(e, stickerEl, 'sticker');
  const adjustEl = e.target.closest('.adjust-item');
  if (adjustEl) return startTextDrag(e, adjustEl, 'adjust');
  if (audioEl) return startAudioDrag(e, audioEl);
  if (state.playing) pause();
  // Empty track space: click to move the playhead, or drag a box to select what's inside.
  if (e.target.closest('.track') && !e.target.closest('.playhead-head')) {
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    if (!additive) select(null);
    seek(timeAtClientX(e.clientX));
    const sx = e.clientX;
    const sy = e.clientY;
    const base = selection.slice();
    let box = null;
    drag(e, {
      onMove: (_dx, ev) => {
        if (!box && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        if (!box) { box = h('div', { class: 'marquee' }); content.append(box); }
        const r = content.getBoundingClientRect();
        const x0 = Math.min(sx, ev.clientX); const x1 = Math.max(sx, ev.clientX);
        const y0 = Math.min(sy, ev.clientY); const y1 = Math.max(sy, ev.clientY);
        Object.assign(box.style, { left: `${x0 - r.left}px`, top: `${y0 - r.top}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
        const hits = [];
        content.querySelectorAll('.clip, .text-item, .audio-item, .overlay-item, .sticker-item').forEach((el) => {
          const b = el.getBoundingClientRect();
          if (b.right > x0 && b.left < x1 && b.bottom > y0 && b.top < y1) hits.push({ kind: kindOfEl(el), id: el.dataset.id });
        });
        selection = [...base, ...hits.filter((x) => !base.some((s) => s.kind === x.kind && s.id === x.id))];
        refreshSelectionUI();
      },
      onEnd: () => { if (box) { box.remove(); renderInspector(); } },
    });
    return;
  }
  if (!e.target.closest('.playhead-head')) select(null);
  seek(timeAtClientX(e.clientX));
  drag(e, { onMove: (_dx, ev) => seek(timeAtClientX(ev.clientX)), onEnd: () => {} });
});

function sideOf(target) {
  if (target.classList.contains('l')) return 'l';
  if (target.classList.contains('r')) return 'r';
  return null;
}

function startClipDrag(e, el) {
  const id = el.dataset.id;
  const clip = state.clips.find((c) => c.id === id);
  const m = mediaById(clip.mediaId);
  if (state.playing) pause();
  select('clip', id, 'keep');
  const side = sideOf(e.target);
  const before = snapshot();

  if (side) {
    const o = { in: clip.in, out: clip.out };
    const clipStartAtDrag = clipStarts()[state.clips.indexOf(clip)];
    let changed = false;
    drag(e, {
      onMove: (dx, ev) => {
        const dt = dx / state.zoom;
        const rate = spd(clip) / (clip.mode === 'boomerang' ? 2 : 1);
        if (side === 'l') {
          if (clip.mode === 'reverse') clip.out = clamp(o.out - dt * rate, clip.in + MIN_LEN, m.duration);
          else clip.in = clamp(o.in + dt * rate, 0, clip.out - MIN_LEN);
        } else {
          const end = clipStartAtDrag + (o.out - o.in) / rate + dt;
          const snapped = dt + snapDelta([end], id, ev);
          if (clip.mode === 'reverse') clip.in = clamp(o.in - snapped * rate, 0, clip.out - MIN_LEN);
          else clip.out = clamp(o.out + snapped * rate, clip.in + MIN_LEN, m.duration);
        }
        changed = true;
        renderTimeline();
        // Show the frame at the edge being trimmed.
        if (!isImage(m)) {
          currentIndex = -1;
          still.hidden = true;
          video.hidden = false;
          useMedia(m);
          video.style.filter = cssFilter(clip);
          const showStart = (side === 'l') !== (clip.mode === 'reverse'); // a reversed clip starts at the source's end
          setVideoTime(showStart ? clip.in : Math.max(clip.in, clip.out - 1 / FPS));
        }
      },
      onEnd: () => {
        if (changed) pushHistory(before);
        renderInspector();
        refreshPreview();
      },
    });
    return;
  }

  let moved = false;
  let target = null;
  drag(e, {
    onMove: (dx, ev) => {
      if (!moved && Math.abs(dx) < 4) return;
      moved = true;
      const cel = content.querySelector(`.clip[data-id="${id}"]`);
      cel.classList.add('dragging');
      cel.style.transform = `translateX(${dx}px)`;
      target = insertIndex(id, timeAtClientX(ev.clientX));
      showDropMarker(target, id);
    },
    onEnd: () => {
      $('#dropMarker').hidden = true;
      if (moved && target !== null) {
        const others = state.clips.filter((c) => c !== clip);
        others.splice(target, 0, clip);
        if (others.some((c, i) => c !== state.clips[i])) {
          pushHistory(before);
          state.clips = others;
        }
      }
      renderTimeline();
      refreshPreview();
    },
  });
}

function insertIndex(dragId, t) {
  let s = 0;
  let idx = 0;
  for (const c of state.clips) {
    if (c.id === dragId) continue;
    const L = clipLen(c);
    if (t > s + L / 2) idx++;
    s += L;
  }
  return idx;
}

function showDropMarker(target, dragId) {
  const starts = clipStarts();
  const others = state.clips.map((c, i) => ({ c, s: starts[i] })).filter((o) => o.c.id !== dragId);
  let t = 0;
  if (others.length) {
    t = target < others.length
      ? others[target].s
      : others[others.length - 1].s + clipLen(others[others.length - 1].c);
  }
  const track = $('#videoTrack');
  const mk = $('#dropMarker');
  mk.hidden = false;
  mk.style.left = `${t * state.zoom}px`;
  mk.style.top = `${track.offsetTop}px`;
  mk.style.height = `${track.offsetHeight}px`;
}

// Shared by the text and sticker tracks: items with a start and a length.
function startTextDrag(e, el, kind = 'text') {
  const id = el.dataset.id;
  const item = listOf(kind).find((x) => x.id === id);
  if (state.playing) pause();
  select(kind, id, 'keep');
  const group = groupWith(kind, id);
  const side = sideOf(e.target);
  const o = { start: item.start, dur: item.dur, words: item.words, keys: item.keys };
  const before = snapshot();
  let changed = false;
  drag(e, {
    onMove: (dx, ev) => {
      if (!changed && Math.abs(dx) < 3) return;
      const dt = dx / state.zoom;
      if (side === 'r') {
        const end = o.start + o.dur + dt;
        item.dur = Math.max(MIN_LEN, end + snapDelta([end], id, ev) - o.start);
      } else if (side === 'l') {
        const raw = o.start + dt;
        const ns = clamp(raw + snapDelta([raw], id, ev), 0, o.start + o.dur - MIN_LEN);
        item.dur = o.start + o.dur - ns;
        item.start = ns;
        // Word timings are relative to the caption's start, so they move the other way.
        if (o.words) item.words = o.words.map((w) => ({ ...w, s: w.s - (ns - o.start), e: w.e - (ns - o.start) }));
        if (o.keys) item.keys = o.keys.map((k) => ({ ...k, t: k.t - (ns - o.start) }));
      } else {
        const ns = Math.max(0, o.start + dt);
        item.start = Math.max(0, ns + snapDelta([ns, ns + o.dur], id, ev));
        moveGroup(group, item.start - o.start);
        if (group.length) syncOverlays(true);
      }
      changed = true;
      overlayKey = null;
      renderTimeline();
      updateOverlay();
    },
    onEnd: () => {
      if (changed) {
        pushHistory(before);
        renderInspector();
      }
    },
  });
}

// Shared by the audio and overlay tracks: items placed freely in time.
function startAudioDrag(e, el, kind = 'audio') {
  const id = el.dataset.id;
  const a = (kind === 'audio' ? state.audio : state.overlays).find((x) => x.id === id);
  const m = mediaById(a.mediaId);
  if (state.playing) pause();
  select(kind, id, 'keep');
  const group = groupWith(kind, id);
  const side = sideOf(e.target);
  const o = { start: a.start, in: a.in, out: a.out, keys: a.keys };
  const before = snapshot();
  let changed = false;
  drag(e, {
    onMove: (dx, ev) => {
      if (kind === 'overlay' && !side) {
        // Up or down a lane (one past the top makes a new track).
        const r = $('#overlayTrack').getBoundingClientRect();
        const n = laneCount();
        const fromTop = Math.floor((ev.clientY - r.top - 5) / (LANE_H + 4));
        const lane = clamp(n - 1 - fromTop, 0, n);
        if (lane !== laneOf(a)) { a.lane = lane; changed = true; renderTimeline(); syncOverlays(false); }
      }
      if (!changed && Math.abs(dx) < 3) return;
      const dt = dx / state.zoom;
      if (side === 'r') {
        const end = o.start + (o.out + dt - o.in);
        a.out = clamp(o.out + dt + snapDelta([end], id, ev), a.in + MIN_LEN, m.duration);
      } else if (side === 'l') {
        // Trimming the start keeps the rest of the audio where it was.
        const raw = o.start + dt;
        const d = clamp(dt + snapDelta([raw], id, ev), Math.max(-o.in, -o.start), o.out - o.in - MIN_LEN);
        a.in = o.in + d;
        a.start = o.start + d;
        if (o.keys) a.keys = o.keys.map((k) => ({ ...k, t: k.t - d }));
      } else {
        const ns = Math.max(0, o.start + dt);
        a.start = Math.max(0, ns + snapDelta([ns, ns + o.out - o.in], id, ev));
        moveGroup(group, a.start - o.start);
        if (group.length) { syncOverlays(true); updateOverlay(); }
      }
      changed = true;
      renderTimeline();
      if (kind === 'overlay') syncOverlays(true);
    },
    onEnd: () => {
      if (changed) {
        if (kind === 'overlay') { tidyLanes(id); renderTimeline(); syncOverlays(true); }
        pushHistory(before);
        renderInspector();
      }
    },
  });
}

$('#tlScroll').addEventListener('wheel', (e) => {
  const sc = $('#tlScroll');
  if (e.ctrlKey) {
    e.preventDefault();
    const anchor = timeAtClientX(e.clientX);
    const offset = e.clientX - sc.getBoundingClientRect().left;
    setZoom(state.zoom * Math.exp(-e.deltaY * 0.002));
    sc.scrollLeft = anchor * state.zoom - offset;
  } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    e.preventDefault();
    sc.scrollLeft += e.deltaY;
  }
}, { passive: false });

function setZoom(z) {
  state.zoom = clamp(z, 10, 300);
  $('#zoom').value = String(Math.round(state.zoom));
  renderTimeline();
}

// ---------- editing commands

function splitAudioAtPlayhead() {
  const s = state.selected;
  if (!s || (s.kind !== 'audio' && s.kind !== 'overlay')) return false;
  const list = s.kind === 'audio' ? state.audio : state.overlays;
  const a = list.find((x) => x.id === s.id);
  if (!a) return false;
  const local = state.playhead - a.start;
  if (local < MIN_LEN || a.out - a.in - local < MIN_LEN) return false;
  commit();
  const cut = a.in + local;
  const second = { ...a, id: newId(s.kind === 'audio' ? 'a' : 'o'), start: state.playhead, in: cut, fadeIn: 0 };
  if (a.keys) second.keys = a.keys.map((k) => ({ ...k, t: k.t - local }));
  a.out = cut;
  a.fadeOut = 0;
  list.splice(list.indexOf(a) + 1, 0, second);
  renderTimeline();
  select(s.kind, second.id);
  if (s.kind === 'overlay') syncOverlays(true);
  return true;
}

function splitAtPlayhead() {
  if (splitAudioAtPlayhead()) return;
  const loc = locate(state.playhead);
  if (!loc) { toast('Add a video first'); return; }
  if (loc.clip.mode) { toast('Set Playback back to Normal to split this clip'); return; }
  const local = state.playhead - loc.start;
  if (local < MIN_LEN || clipLen(loc.clip) - local < MIN_LEN) {
    toast('Move the playhead inside a clip to split it');
    return;
  }
  if (loc.clip.ramp) { toast('Turn off the speed curve to split this clip'); return; }
  commit();
  const c = loc.clip;
  const cut = c.in + local * spd(c);
  const second = { ...c, id: newId('c'), in: cut, transition: 0 }; // keeps speed, volume and look
  if (c.keys) second.keys = c.keys.map((k) => ({ ...k, t: k.t - local }));
  delete c.endFade;
  c.out = cut;
  state.clips.splice(loc.index + 1, 0, second);
  renderTimeline();
  select('clip', second.id);
  refreshPreview();
}

function deleteSelected() {
  if (!selection.length) return;
  commit();
  const gone = (kind) => (x) => !selection.some((s) => s.kind === kind && s.id === x.id);
  state.clips = state.clips.filter(gone('clip'));
  state.audio = state.audio.filter(gone('audio'));
  state.overlays = state.overlays.filter(gone('overlay'));
  state.stickers = state.stickers.filter(gone('sticker'));
  state.adjust = state.adjust.filter(gone('adjust'));
  state.texts = state.texts.filter(gone('text'));
  selection = [];
  state.selected = null;
  state.playhead = Math.min(state.playhead, totalDuration());
  renderAll();
  refreshPreview();
}

function addText() {
  commit();
  const x = {
    id: newId('t'), text: 'Your text', start: state.playhead, dur: 3,
    size: 7, position: 'bottom', color: '#FFFFFF', ...brandTextDefaults(),
  };
  state.texts.push(x);
  overlayKey = null;
  renderTimeline();
  select('text', x.id);
  updateOverlay();
  showInspectorTab('text'); const ta = $('#inspector textarea');
  if (ta) { ta.focus(); ta.select(); }
}

const BOX_COLOURS = [['rgba(0, 0, 0, 0.62)', 'Dark'], ['#FFFFFF', 'White'], ['#E5252A', 'Red'], ['#F2B84B', 'Amber'], ['#2E6CF6', 'Blue']];

// ---------- text templates (texts and stickers placed together at the playhead)

const T_TEXT = { size: 7, position: 'center', color: '#FFFFFF', anim: 'none', highlight: false, box: false, caps: false };
const TEMPLATES = [
  { id: 'title', name: 'Title', texts: [
    { text: 'YOUR TITLE', size: 13, anim: 'pop', caps: true, dur: 3, offsetY: -0.05 },
    { text: 'Add a subtitle here', size: 5, color: '#FFD84D', anim: 'fade', at: 0.25, dur: 2.75, offsetY: 0.09 }] },
  { id: 'lower', name: 'Lower third', texts: [
    { text: 'Your Name', size: 6.5, position: 'bottom', align: 'left', box: true, boxColor: '#F2B84B', color: '#1A1D23', anim: 'slide', dur: 4, offsetY: -0.085 },
    { text: 'Your role or channel', size: 4.2, position: 'bottom', align: 'left', box: true, color: '#FFFFFF', anim: 'slide', at: 0.15, dur: 3.85 }] },
  { id: 'subscribe', name: 'Subscribe', texts: [
    { text: 'SUBSCRIBE', size: 7, position: 'bottom', box: true, boxColor: '#E5252A', anim: 'pop', caps: true, dur: 3 }],
    stickers: [{ emoji: '🔔', x: 0.69, y: 0.865, size: 0.1, anim: 'wiggle', at: 0.3, dur: 2.7 }, { emoji: '👍', x: 0.31, y: 0.865, size: 0.1, anim: 'pulse', at: 0.3, dur: 2.7 }] },
  { id: 'countdown', name: 'Countdown', texts: [
    { text: '3', size: 26, anim: 'pop', dur: 1 }, { text: '2', size: 26, anim: 'pop', at: 1, dur: 1 },
    { text: '1', size: 26, anim: 'pop', at: 2, dur: 1 }, { text: 'GO!', size: 22, color: '#FFD84D', anim: 'pop', at: 3, dur: 1 }] },
  { id: 'chapter', name: 'Chapter', texts: [
    { text: 'CHAPTER 1', size: 4.5, color: '#F2B84B', caps: true, anim: 'fade', dur: 3.5, offsetY: -0.08 },
    { text: 'The Beginning', size: 11, anim: 'slide', at: 0.2, dur: 3.3, offsetY: 0.03 }] },
  { id: 'meme', name: 'Meme', texts: [
    { text: 'TOP TEXT', size: 10, position: 'top', caps: true, dur: 4 },
    { text: 'BOTTOM TEXT', size: 10, position: 'bottom', caps: true, dur: 4 }] },
  { id: 'news', name: 'Breaking news', texts: [
    { text: 'BREAKING NEWS', size: 5, position: 'bottom', align: 'left', box: true, boxColor: '#E5252A', caps: true, anim: 'slide', dur: 5, offsetY: -0.08 },
    { text: 'Your headline goes here', size: 5.5, position: 'bottom', align: 'left', box: true, boxColor: '#FFFFFF', color: '#1A1D23', anim: 'slide', at: 0.2, dur: 4.8 }] },
  { id: 'quote', name: 'Quote', texts: [
    { text: '“Write your quote here”', size: 8, anim: 'fade', dur: 4, offsetY: -0.04 },
    { text: '— Someone wise', size: 4.5, color: '#F2B84B', anim: 'fade', at: 0.6, dur: 3.4, offsetY: 0.09 }] },
  { id: 'typing', name: 'Typewriter', texts: [{ text: 'Type your message here…', size: 8, anim: 'typewriter', dur: 4 }] },
];

// Items for a template starting at time t0.
function templateItems(tpl, t0) {
  const texts = tpl.texts.map((d) => {
    const { at = 0, ...rest } = d;
    return { ...T_TEXT, ...rest, id: newId('t'), start: t0 + at };
  });
  const stickers = (tpl.stickers || []).map((d) => {
    const { at = 0, ...rest } = d;
    return { rotate: 0, ...rest, id: newId('s'), start: t0 + at };
  });
  return { texts, stickers };
}

function buildTemplatePicker() {
  const grid = $('#templateGrid');
  if (grid.childElementCount) return;
  const [aw, ah] = ASPECTS[state.aspect];
  for (const tpl of TEMPLATES) {
    const cv = h('canvas', { class: 'tpl-thumb' });
    cv.width = 240;
    cv.height = Math.round((240 * ah) / aw);
    const ctx = cv.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, cv.width, cv.height);
    g.addColorStop(0, '#3B5168');
    g.addColorStop(1, '#6B4F92');
    const { texts, stickers } = templateItems(tpl, 0);
    // Shown as it looks once everything has come in.
    const at = Math.max(...texts.map((x) => x.start)) + 0.9;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cv.width, cv.height);
    const layer = document.createElement('canvas');
    layer.width = cv.width;
    layer.height = cv.height;
    drawCaptions(layer.getContext('2d'), cv.width, cv.height, texts, at, stickers);
    ctx.drawImage(layer, 0, 0);
    grid.append(h('button', { class: 'tpl', title: tpl.name, onClick: () => insertTemplate(tpl) }, cv, h('span', {}, tpl.name)));
  }
}

function openTemplates() {
  const p = $('#templatePicker');
  const grid = $('#templateGrid');
  if (grid.dataset.aspect !== state.aspect) { grid.textContent = ''; grid.dataset.aspect = state.aspect; }
  buildTemplatePicker();
  const anchor = $('#templateBtn').getBoundingClientRect();
  p.hidden = false;
  const r = p.getBoundingClientRect();
  p.style.left = `${clamp(anchor.left, 8, window.innerWidth - r.width - 8)}px`;
  p.style.top = `${clamp(anchor.top - r.height - 8, 8, window.innerHeight - r.height - 8)}px`;
}
const closeTemplates = () => { $('#templatePicker').hidden = true; };

function insertTemplate(tpl) {
  closeTemplates();
  if (!state.clips.length) { toast('Add a video first, then put a template on it'); return; }
  commit();
  const t0 = Math.min(state.playhead, Math.max(0, totalDuration() - MIN_LEN));
  const { texts, stickers } = templateItems(tpl, t0);
  state.texts.push(...texts);
  state.stickers.push(...stickers);
  overlayKey = null;
  renderAll();
  select('text', texts[0].id);
  updateOverlay();
  toast(`Added ${tpl.name}. Edit the words in the panel on the right.`);
  showInspectorTab('text'); const ta = $('#inspector textarea');
  if (ta) { ta.focus(); ta.select(); }
}

const TEXT_STYLE = ['font', 'size', 'position', 'color', 'anim', 'highlight', 'hlColor', 'box', 'caps', 'align', 'boxColor', 'offsetY', 'wordFx', 'keyColor', 'kwColor', 'emoji'];
const copyStyle = (src) => Object.fromEntries(TEXT_STYLE.map((k) => [k, src[k]]));

const WORD_FX = [['none', 'None'], ['hl', 'Highlight'], ['pop', 'Pop in'], ['bounce', 'Bounce'], ['karaoke', 'Karaoke'], ['box', 'Box'], ['glow', 'Glow'], ['big', 'Big word'], ['one', 'One word']];

// Which look a text has (if it matches one exactly in its word style).
function lookOf(x) {
  const fx = x.wordFx || 'none';
  const p = CAPTION_PRESETS.find((q) => (q.set.wordFx || 'none') === fx && Boolean(q.set.highlight) === Boolean(x.highlight) && Boolean(q.set.box) === Boolean(x.box) && (q.set.hlColor || '#FFD84D') === (x.hlColor || '#FFD84D'));
  return p ? p.id : null;
}

// Picks a look for this text, or for every auto caption when it's one of them.
function applyLook(x, p) {
  commit();
  const targets = x.auto ? state.texts.filter((t) => t.auto) : [x];
  for (const t of targets) Object.assign(t, p.set);
  overlayKey = null;
  updateOverlay();
  renderTimeline();
  renderInspector();
  if (targets.length > 1) toast(`${p.name} look on all ${targets.length} captions`);
}

// A still of each look, drawn by the same code as the captions (mid-way through the second word).
const lookThumbCache = new Map();
function lookThumb(p) {
  let url = lookThumbCache.get(p.id);
  if (!url) {
    const cv = document.createElement('canvas');
    cv.width = 240;
    cv.height = 120;
    const ctx = cv.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 240, 120);
    g.addColorStop(0, '#3B2F5C');
    g.addColorStop(1, '#1C3A4A');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 240, 120);
    const sample = { id: '_look', text: 'Make it pop', start: 0, dur: 2, ...p.set, size: Math.min(17, (p.set.size || 6) * 2.6), position: 'center', words: [{ text: 'Make', s: 0, e: 0.3 }, { text: 'it', s: 0.35, e: 0.5 }, { text: 'pop', s: 0.55, e: 1 }] };
    drawCaption(ctx, 240, 120, sample, 0.62);
    captionHits.length = 0;
    url = cv.toDataURL();
    lookThumbCache.set(p.id, url);
  }
  return h('img', { src: url, alt: '' });
}

function applyStyleToAll(src) {
  commit();
  const style = copyStyle(src);
  for (const x of state.texts) Object.assign(x, style);
  overlayKey = null;
  updateOverlay();
  toast(`Updated ${state.texts.length} text items`);
}

// ---------- copy and paste (works between projects: the clipboard keeps the media paths)

const CLIP_KEY = 'snippy.clipboard';
const clone = (o) => JSON.parse(JSON.stringify(o));

function copySelection() {
  if (!selection.length) return;
  const items = selection.map((s) => ({ kind: s.kind, item: itemOf(s) })).filter((x) => x.item);
  // Clips in timeline order; free items keep their spacing relative to the earliest one.
  items.sort((a, b) => (a.kind === 'clip' && b.kind === 'clip' ? state.clips.indexOf(a.item) - state.clips.indexOf(b.item) : 0));
  const free = items.filter((x) => FREE_KINDS.has(x.kind));
  const t0 = free.length ? Math.min(...free.map((x) => x.item.start)) : 0;
  const mediaIds = new Set(items.map((x) => x.item.mediaId).filter(Boolean));
  const data = {
    v: 1, t0,
    items: items.map((x) => ({ kind: x.kind, item: clone(x.item) })),
    media: state.media.filter((m) => mediaIds.has(m.id)).map((m) => ({ id: m.id, path: m.path, name: m.name })),
  };
  try { localStorage.setItem(CLIP_KEY, JSON.stringify(data)); } catch { toast("Couldn't copy"); return; }
  toast(items.length === 1 ? 'Copied' : `Copied ${items.length} items`);
}

async function pasteClipboard() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(CLIP_KEY) || 'null'); } catch { /* nothing usable */ }
  if (!data || !data.items || !data.items.length) { toast('Nothing to paste yet. Select something and press Ctrl+C.'); return; }
  // Match each media file to one already in this project, or bring it in.
  const mediaMap = {};
  for (const ref of data.media || []) {
    let m = state.media.find((x) => x.path === ref.path);
    if (!m) {
      try {
        const info = await window.api.probe(ref.path);
        m = { id: newId('m'), ...info };
        state.media.push(m);
        loadLevels(m);
        queueProxy(m);
      } catch {
        toast(`${ref.name} can't be found any more, so items using it were skipped`);
        continue;
      }
    }
    mediaMap[ref.id] = m.id;
  }
  commit();
  const at = state.playhead;
  const loc = state.clips.length ? locate(at) : null;
  let insertAt = loc ? loc.index + 1 : state.clips.length;
  const pasted = [];
  const groupMap = {};
  for (const { kind, item } of data.items) {
    if (item.group) item.group = groupMap[item.group] || (groupMap[item.group] = newId('g'));
    if (item.mediaId) {
      if (!mediaMap[item.mediaId]) continue;
      item.mediaId = mediaMap[item.mediaId];
    }
    if (item.originalMediaId) item.originalMediaId = mediaMap[item.originalMediaId] || undefined;
    item.id = newId(kind === 'clip' ? 'c' : kind[0]);
    if (kind === 'clip') state.clips.splice(insertAt++, 0, item);
    else {
      item.start = Math.max(0, at + (item.start - data.t0));
      listOf(kind).push(item);
    }
    pasted.push({ kind, id: item.id });
  }
  markDirty();
  selection = pasted;
  state.selected = pasted[pasted.length - 1] || null;
  renderAll();
  refreshSelectionUI();
  renderInspector();
  refreshPreview();
  toast(pasted.length === 1 ? 'Pasted' : `Pasted ${pasted.length} items`);
}

function selectAll() {
  selection = [
    ...state.clips.map((x) => ({ kind: 'clip', id: x.id })),
    ...state.overlays.map((x) => ({ kind: 'overlay', id: x.id })),
    ...state.audio.map((x) => ({ kind: 'audio', id: x.id })),
    ...state.texts.map((x) => ({ kind: 'text', id: x.id })),
    ...state.stickers.map((x) => ({ kind: 'sticker', id: x.id })),
  ];
  refreshSelectionUI();
  renderInspector();
}

// ---------- stickers

let pickerMode = 'add';

// Animated emoji from Google's Noto set (CC BY 4.0), downloaded the first time each is used.
const NOTO_SET = [
  ['😀', '1f600'], ['😂', '1f602'], ['🤣', '1f923'], ['😍', '1f60d'], ['🥰', '1f970'], ['😎', '1f60e'], ['🤩', '1f929'], ['😜', '1f61c'],
  ['🤔', '1f914'], ['😮', '1f62e'], ['😱', '1f631'], ['😭', '1f62d'], ['😡', '1f621'], ['🥳', '1f973'], ['😴', '1f634'], ['🤯', '1f92f'],
  ['🙃', '1f643'], ['😇', '1f607'], ['🤡', '1f921'], ['💀', '1f480'], ['👻', '1f47b'], ['🤖', '1f916'], ['💩', '1f4a9'], ['😹', '1f639'],
  ['👍', '1f44d'], ['👏', '1f44f'], ['🙌', '1f64c'], ['🙏', '1f64f'], ['💪', '1f4aa'], ['👀', '1f440'], ['👋', '1f44b'], ['🫶', '1faf6'],
  ['🔥', '1f525'], ['💯', '1f4af'], ['✨', '2728'], ['🎉', '1f389'], ['💥', '1f4a5'], ['🚀', '1f680'], ['🌈', '1f308'], ['💔', '1f494'],
];
const NOTO_CREDIT = 'Animated emoji: Google Noto Emoji, CC BY 4.0';

// Decodes an animated image into frames (or one frame for a still picture).
async function loadGif(src) {
  const have = gifStore.get(src);
  if (have) return have.pending || have;
  const job = (async () => {
    const bytes = await window.api.stickerBytes(src);
    const ext = src.split('.').pop().toLowerCase();
    const type = ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png';
    const dec = new ImageDecoder({ data: bytes, type });
    await dec.tracks.ready;
    const n = Math.min(400, dec.tracks.selectedTrack ? dec.tracks.selectedTrack.frameCount : 1);
    const frames = [];
    let end = 0;
    let w = 0; let hgt = 0;
    for (let i = 0; i < Math.max(1, n); i++) {
      const { image } = await dec.decode({ frameIndex: i });
      w = image.displayWidth; hgt = image.displayHeight;
      const scale = Math.min(1, 360 / Math.max(w, hgt)); // plenty for a sticker, and kind to memory
      const bmp = await createImageBitmap(image, { resizeWidth: Math.max(1, Math.round(w * scale)), resizeHeight: Math.max(1, Math.round(hgt * scale)), resizeQuality: 'high' });
      end += Math.max(20, (image.duration || 100000) / 1000); // GIFs often say 0 ms; browsers treat that as 100 ms
      frames.push({ bmp, end });
      image.close();
    }
    dec.close();
    const entry = { frames, total: Math.max(20, end), w, h: hgt };
    gifStore.set(src, entry);
    return entry;
  })();
  gifStore.set(src, { pending: job });
  try { return await job; } catch (err) { gifStore.delete(src); throw err; }
}

// Makes sure every GIF sticker in the edit is decoded (before exporting, and after opening).
async function loadAllGifs() {
  const srcs = [...new Set(state.stickers.filter((s) => s.gif).map((s) => s.gif.src))];
  const failed = [];
  await Promise.all(srcs.map((src) => loadGif(src).catch(() => failed.push(src.split(/[\\/]/).pop()))));
  if (srcs.length) { overlayKey = null; updateOverlay(); syncStickerHits(); }
  return failed;
}

const stickerLabel = (s) => (s.effect ? (s.effect.type === 'pixel' ? '▦ Pixelate' : '◌ Blur') : s.fun ? (s.fun.text || { arrow: 'Arrow', circle: 'Circle', sparkles: 'Sparkles', hearts: 'Hearts', confetti: 'Confetti', subscribe: 'Subscribe', loading: 'Loading' }[s.fun.kind] || 'Sticker')
  : s.gif ? s.gif.name : s.emoji);

function funThumb(f) {
  const cv = h('canvas', { width: '144', height: '96', class: 'fun-thumb' });
  const ctx = cv.getContext('2d');
  const size = 96 / Math.max(1, (FUN_ASPECT[f.kind] || 1) * 96 / 144) * 0.8;
  ctx.translate(72, 48);
  drawFun(ctx, f, Math.min(size, 80), 0.9);
  return cv;
}

function buildPicker() {
  const sets = $('#stickerSets');
  if (sets.childElementCount) return;
  sets.append(h('h3', {}, 'Hide things'), h('div', { class: 'fx-grid' },
    ...FX_BOXES.map(([label, effect]) => h('button', {
      class: `fx-tile ${effect.type} ${effect.shape}`, title: label, onClick: () => pickSticker({ effect: { ...effect } }),
    }, h('span', { class: 'fx-swatch' }), h('span', {}, label)))));
  sets.append(h('h3', {}, 'Fun (animated)'), h('div', { class: 'fun-grid' },
    ...FUN_STICKERS.map(([kind, text]) => h('button', {
      class: 'fun-tile', title: text || kind, 'aria-label': `Sticker ${text || kind}`,
      onClick: () => pickSticker({ fun: { kind, ...(text ? { text } : {}) } }),
    }, funThumb({ kind, text })))));
  sets.append(h('h3', {}, 'Animated emoji'), h('div', { class: 'emoji-grid' },
    ...NOTO_SET.map(([em, code]) => h('button', {
      class: 'emoji noto', title: `${em} (animated)`, 'aria-label': `Animated ${em}`,
      onClick: () => pickNoto(em, code),
    }, em))),
    h('p', { class: 'picker-note' }, `Downloaded the first time you use each one. ${NOTO_CREDIT}: please credit it in your video's description.`));
  sets.append(h('h3', {}, 'Your GIFs and pictures'), h('div', { class: 'btn-row' },
    h('button', { class: 'btn', onClick: pickGifFile }, 'Add a GIF or picture…')),
    h('p', { class: 'picker-note' }, 'GIFs, animated WebPs and PNGs keep their see-through backgrounds and loop. Only use ones you\'re allowed to.'));
  for (const [name, list] of STICKER_SETS) {
    sets.append(h('h3', {}, name), h('div', { class: 'emoji-grid' },
      ...list.map((em) => h('button', { class: 'emoji', title: em, 'aria-label': `Sticker ${em}`, onClick: () => pickSticker(em) }, em))));
  }
}

async function pickNoto(em, code) {
  closePicker();
  toast(`Getting the animated ${em}…`);
  let file;
  try { file = await window.api.notoSticker(code); await loadGif(file); } catch (err) { toast(`Couldn't get that animated emoji: ${cleanError(err)}`); return; }
  pickSticker({ gif: { src: file, name: em, noto: true } }, true);
}

async function pickGifFile() {
  closePicker();
  const file = await window.api.pickStickerFile();
  if (file) addGifSticker(file);
}

async function addGifSticker(file) {
  try { await loadGif(file); } catch (err) { toast(`Snippy can't read that file as a sticker: ${cleanError(err)}`); return; }
  pickSticker({ gif: { src: file, name: file.split(/[\\/]/).pop() } }, true);
}

function openPicker(mode) {
  buildPicker();
  pickerMode = mode;
  const p = $('#stickerPicker');
  const anchor = (mode === 'replace' ? $('#inspector') : $('#stickerBtn')).getBoundingClientRect();
  p.hidden = false;
  const r = p.getBoundingClientRect();
  p.style.left = `${clamp(mode === 'replace' ? anchor.left - r.width - 8 : anchor.left, 8, window.innerWidth - r.width - 8)}px`;
  p.style.top = `${clamp(mode === 'replace' ? anchor.top + 40 : anchor.top - r.height - 8, 8, window.innerHeight - r.height - 8)}px`;
  p.querySelector('button.emoji').focus();
}

const closePicker = () => { $('#stickerPicker').hidden = true; };

// what: an emoji string, or { fun } / { gif } for the animated kinds.
function pickSticker(what, keepPickerClosed) {
  if (!keepPickerClosed) closePicker();
  const kind = typeof what === 'string' ? { emoji: what } : what;
  const sel = state.selected;
  if (pickerMode === 'replace' && sel && sel.kind === 'sticker') {
    const s = state.stickers.find((x) => x.id === sel.id);
    if (s) {
      commit();
      delete s.emoji; delete s.fun; delete s.gif; delete s.effect;
      Object.assign(s, kind);
      renderTimeline(); renderInspector(); overlayKey = null; updateOverlay(); syncStickerHits();
    }
    return;
  }
  if (!state.clips.length) { toast('Add a video first, then put stickers on it'); return; }
  commit();
  const s = {
    id: newId('s'), ...kind, start: Math.min(state.playhead, Math.max(0, totalDuration() - MIN_LEN)), dur: kind.emoji ? 2 : 3,
    x: 0.5, y: 0.42, size: kind.effect ? 0.3 : kind.fun ? 0.24 : 0.2, rotate: 0, anim: kind.effect ? 'none' : 'pop',
  };
  if (kind.effect) s.dur = Math.max(MIN_LEN, Math.min(5, totalDuration() - s.start));
  state.stickers.push(s);
  renderTimeline();
  select('sticker', s.id);
  updateOverlay();
}

$('#stickerCustom').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#stickerInput').value.trim();
  if (!v) return;
  $('#stickerInput').value = '';
  pickSticker(v);
});
document.addEventListener('pointerdown', (e) => {
  const p = $('#stickerPicker');
  if (!p.hidden && !p.contains(e.target) && !e.target.closest('#stickerBtn')) closePicker();
  const tp = $('#templatePicker');
  if (!tp.hidden && !tp.contains(e.target) && !e.target.closest('#templateBtn')) closeTemplates();
  const sp = $('#sfxPicker');
  if (!sp.hidden && !sp.contains(e.target) && !e.target.closest('#sfxBtn')) closeSfx();
});

// Invisible boxes over the preview let you grab stickers drawn on the caption canvas.
const stickerHits = new Map();

function placeHit(s, el) {
  const v = kfValue(s, 'sticker', state.playhead - s.start);
  const px = v.size * $('#stage').clientHeight;
  el.style.left = `${v.x * 100}%`;
  el.style.top = `${v.y * 100}%`;
  el.style.width = `${px * stickerAspect(s)}px`;
  el.style.height = `${px}px`;
  el.style.transform = `translate(-50%, -50%) rotate(${v.rotate || 0}deg)`;
  el.classList.toggle('selected', Boolean(isSel('sticker', s.id)));
}

function syncStickerHits() {
  const t = state.playhead;
  const live = new Set();
  for (const s of state.stickers) {
    if (t < s.start || t >= s.start + s.dur) continue;
    live.add(s.id);
    let el = stickerHits.get(s.id);
    if (!el) {
      el = h('div', { class: 'sticker-hit', 'data-id': s.id }, h('div', { class: 'pip-resize', title: 'Drag to resize' }));
      $('#stickerLayer').append(el);
      stickerHits.set(s.id, el);
    }
    placeHit(s, el);
  }
  for (const [id, el] of stickerHits) if (!live.has(id)) { el.remove(); stickerHits.delete(id); }
}

$('#stickerLayer').addEventListener('pointerdown', (e) => {
  const box = e.target.closest('.sticker-hit');
  if (!box || e.button !== 0) return;
  const s = state.stickers.find((x) => x.id === box.dataset.id);
  if (!s) return;
  e.preventDefault();
  if (state.playing) pause();
  select('sticker', s.id);
  const rect = $('#stage').getBoundingClientRect();
  const resize = e.target.classList.contains('pip-resize');
  const start = valuesNow('sticker', s);
  const sx = e.clientX;
  const sy = e.clientY;
  const before = snapshot();
  let changed = false;
  box.setPointerCapture(e.pointerId);
  const move = (ev) => {
    if (!changed && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 3) return;
    changed = true;
    if (resize) {
      const cx = rect.left + start.x * rect.width;
      const cy = rect.top + start.y * rect.height;
      const half = Math.max(Math.abs(ev.clientX - cx), Math.abs(ev.clientY - cy));
      kset(s, 'sticker', { size: clamp((2 * half) / rect.height, 0.03, 0.9) });
    } else {
      kset(s, 'sticker', {
        x: clamp(start.x + (ev.clientX - sx) / rect.width, 0, 1),
        y: clamp(start.y + (ev.clientY - sy) / rect.height, 0, 1),
      });
    }
    updateOverlay();
  };
  const up = () => {
    box.removeEventListener('pointermove', move);
    box.removeEventListener('pointerup', up);
    box.removeEventListener('pointercancel', up);
    if (changed) { pushHistory(before); renderInspector(); }
  };
  box.addEventListener('pointermove', move);
  box.addEventListener('pointerup', up);
  box.addEventListener('pointercancel', up);
});

// ---------- keyframes

// Seconds into the item at the playhead, and the item's length.
function kfLocal(kind, item) {
  if (kind === 'clip') return state.playhead - clipStarts()[state.clips.indexOf(item)];
  return state.playhead - item.start;
}
function kfLength(kind, item) {
  if (kind === 'clip') return clipLen(item);
  if (kind === 'overlay' || kind === 'audio') return item.out - item.in;
  return item.dur;
}
const kfAt = (item, u) => (item.keys || []).find((k) => Math.abs(k.t - u) < 1 / 60);
const valuesNow = (kind, item) => kfValue(item, kind, kfLocal(kind, item));

// Change values. With keyframes, the change is saved as a keyframe at the playhead.
function kset(item, kind, changes) {
  if (!item.keys || !item.keys.length) { Object.assign(item, changes); return; }
  const u = clamp(kfLocal(kind, item), 0, kfLength(kind, item));
  let k = kfAt(item, u);
  if (!k) {
    k = { t: u, ...kfValue(item, kind, u) };
    item.keys.push(k);
    item.keys.sort((a, b) => a.t - b.t);
    // A new keyframe needs its diamond on the timeline and its button in the panel.
    if (!kset.pending) {
      kset.pending = true;
      requestAnimationFrame(() => { kset.pending = false; renderTimeline(); if (!(document.activeElement && document.activeElement.matches('#inspector input'))) renderInspector(); });
    }
  }
  Object.assign(k, changes);
}

function refreshKeyed() {
  if (typeof updateClipBox === 'function') { boxKey = ''; }
  renderTimeline();
  renderInspector();
  syncOverlays(false);
  updateOverlay();
  updateFx();
}

function addKeyframe(item, kind) {
  const u = clamp(kfLocal(kind, item), 0, kfLength(kind, item));
  if (kfAt(item, u)) return;
  commit();
  item.keys = item.keys || [];
  item.keys.push({ t: u, ...kfValue(item, kind, u) });
  item.keys.sort((a, b) => a.t - b.t);
  refreshKeyed();
}

function removeKeyframe(item, kind) {
  const u = clamp(kfLocal(kind, item), 0, kfLength(kind, item));
  const k = kfAt(item, u);
  if (!k) return;
  commit();
  item.keys = item.keys.filter((x) => x !== k);
  if (!item.keys.length) { Object.assign(item, kfValue({ ...item, keys: [k] }, kind, 0)); delete item.keys; }
  refreshKeyed();
}

function jumpKeyframe(item, kind, dir) {
  const u = kfLocal(kind, item);
  const keys = item.keys || [];
  const k = dir < 0 ? [...keys].reverse().find((x) => x.t < u - 1 / 60) : keys.find((x) => x.t > u + 1 / 60);
  if (!k) return;
  seek(state.playhead + (k.t - u));
}

function keyframeSection(item, kind) {
  const u = clamp(kfLocal(kind, item), 0, kfLength(kind, item));
  const here = kfAt(item, u);
  const n = item.keys ? item.keys.length : 0;
  return section('Keyframes',
    h('div', { class: 'kf-row' },
      h('button', { class: 'btn', title: 'Previous keyframe', 'aria-label': 'Previous keyframe', onClick: () => jumpKeyframe(item, kind, -1) }, '◀'),
      here
        ? h('button', { class: 'btn kf-on', onClick: () => removeKeyframe(item, kind) }, '◆ Remove keyframe')
        : h('button', { class: 'btn', onClick: () => addKeyframe(item, kind) }, '◇ Add keyframe'),
      h('button', { class: 'btn', title: 'Next keyframe', 'aria-label': 'Next keyframe', onClick: () => jumpKeyframe(item, kind, 1) }, '▶')),
    h('p', { class: 'hint' }, n
      ? `${n} keyframe${n > 1 ? 's' : ''}. Move the playhead and change anything, and it's saved as a keyframe there. Snippy glides between them.`
      : 'Add a keyframe, move the playhead, and change the position, size or other settings. Snippy animates between them.'));
}

// Size, position, turn and flip of a clip, applied in the preview the same way the export does it:
// the canvas-sized picture is flipped, turned, resized, then moved (posX/posY are shares of the canvas).
function clipZoomTransform(c, u) {
  const v = kfValue(c, 'clip', u);
  const flip = `${c.flipH ? ' scaleX(-1)' : ''}${c.flipV ? ' scaleY(-1)' : ''}`;
  if (Math.abs(v.zoom - 1) < 1e-4 && !v.posX && !v.posY && !v.rotate) return flip.trim();
  return `translate(${(v.posX * 100).toFixed(3)}%, ${(v.posY * 100).toFixed(3)}%) rotate(${v.rotate.toFixed(3)}deg) scale(${v.zoom.toFixed(4)})${flip}`;
}

// Where the picture sits inside the canvas before any transform (it's fitted, keeping its shape),
// as shares of the canvas: { w, h }.
function pictureBox(m) {
  const [W, H] = ASPECTS[state.aspect];
  const ma = m && m.width && m.height ? m.width / m.height : W / H;
  return { w: Math.min(1, ma / (W / H)), h: Math.min(1, (W / H) / ma) };
}
// Crop as a CSS clip-path on the canvas-sized element (crop amounts are shares of the picture).
function clipCropPath(c) {
  const cr = c && c.crop;
  if (!cr || !(cr.l || cr.r || cr.t || cr.b)) return '';
  const b = pictureBox(mediaById(c.mediaId));
  const ex = (1 - b.w) / 2;
  const ey = (1 - b.h) / 2;
  const pc = (v) => `${(v * 100).toFixed(3)}%`;
  return `inset(${pc(ey + (cr.t || 0) * b.h)} ${pc(ex + (cr.r || 0) * b.w)} ${pc(ey + (cr.b || 0) * b.h)} ${pc(ex + (cr.l || 0) * b.w)})`;
}

// Size, position, turn, flip and crop of a clip. Size, position and turn can be keyframed.
function zoomSection(c) {
  const v = valuesNow('clip', c);
  const m = mediaById(c.mediaId);
  const redraw = () => { updateFx(); updateClipBox(); };
  const tiny = (label, title, onClick, pressed) => h('button', { class: 'btn', title, 'aria-pressed': pressed == null ? null : String(pressed), onClick }, label);
  const edit = (fn) => { commit(); fn(); refreshKeyed(); updateClipBox(); };
  const crop = c.crop || {};
  const cropSlider = (side, label) => sliderSection(label, {
    min: 0, max: 0.45, step: 0.005, value: crop[side] || 0, format: (x) => `${Math.round(x * 100)}%`, key: `${c.id}:crop${side}`,
    onValue: (x) => { c.crop = { ...(c.crop || {}), [side]: x }; redraw(); },
  });
  return h('div', {},
    sliderSection('Scale', {
      min: 0.1, max: 4, step: 0.01, value: v.zoom, format: (x) => `${Math.round(x * 100)}%`, key: `${c.id}:zoom`,
      onValue: (x) => { kset(c, 'clip', { zoom: x }); redraw(); },
    }),
    sliderSection('Position left / right', {
      min: -1, max: 1, step: 0.005, value: v.posX, format: (x) => `${Math.round(x * 100)}`, key: `${c.id}:px`,
      onValue: (x) => { kset(c, 'clip', { posX: x }); redraw(); },
    }),
    sliderSection('Position up / down', {
      min: -1, max: 1, step: 0.005, value: v.posY, format: (x) => `${Math.round(x * 100)}`, key: `${c.id}:py`,
      onValue: (x) => { kset(c, 'clip', { posY: x }); redraw(); },
    }),
    sliderSection('Rotation', {
      min: -180, max: 180, step: 0.5, value: v.rotate, format: (x) => `${Math.round(x)}°`, key: `${c.id}:rot`,
      onValue: (x) => { kset(c, 'clip', { rotate: x }); redraw(); },
    }),
    section('Turn and flip',
      h('div', { class: 'btn-row' },
        tiny('↺ 90°', 'Turn a quarter to the left', () => edit(() => kset(c, 'clip', { rotate: ((Math.round(v.rotate) - 90 + 540) % 360) - 180 }))),
        tiny('↻ 90°', 'Turn a quarter to the right', () => edit(() => kset(c, 'clip', { rotate: ((Math.round(v.rotate) + 90 + 540) % 360) - 180 }))),
        tiny('⇋ Flip', 'Mirror left to right', () => edit(() => { c.flipH = !c.flipH; }), Boolean(c.flipH)),
        tiny('⇵ Flip', 'Mirror top to bottom', () => edit(() => { c.flipV = !c.flipV; }), Boolean(c.flipV)))),
    h('div', { class: 'btn-row look-actions' },
      h('button', {
        class: 'btn', title: 'Make the picture cover the whole canvas, with no black bars',
        onClick: () => { const b = pictureBox(m); edit(() => kset(c, 'clip', { zoom: Number((1 / Math.min(b.w, b.h)).toFixed(4)), posX: 0, posY: 0 })); },
      }, 'Fill'),
      h('button', {
        class: 'btn', title: 'A slow zoom across the whole clip',
        onClick: () => {
          commit();
          c.keys = [{ t: 0, zoom: 1, posX: 0, posY: 0, rotate: 0 }, { t: clipLen(c), zoom: 1.25, posX: -0.044, posY: 0.031, rotate: 0 }];
          refreshKeyed(); updateClipBox();
        },
      }, 'Ken Burns'),
      h('button', {
        class: 'btn', title: 'Back to the whole picture, unturned', onClick: () => { commit(); delete c.keys; Object.assign(c, { zoom: 1, posX: 0, posY: 0, rotate: 0 }); delete c.flipH; delete c.flipV; refreshKeyed(); updateClipBox(); },
      }, 'Reset'),
      reframeCandidates(c.id).length
        ? h('button', { class: 'btn', title: 'Zoom to fill the canvas and follow the person in this clip', onClick: () => autoReframe(reframeCandidates(c.id)) }, 'Auto reframe')
        : null),
    h('p', { class: 'hint' }, 'Or do it on the preview: drag to move, scroll or drag a corner to resize, and drag the round handle to turn.'),
    cropSlider('l', 'Crop left'),
    cropSlider('r', 'Crop right'),
    cropSlider('t', 'Crop top'),
    cropSlider('b', 'Crop bottom'),
    crop.l || crop.r || crop.t || crop.b ? h('div', { class: 'btn-row' }, h('button', { class: 'btn', onClick: () => edit(() => { delete c.crop; }) }, 'Reset crop')) : null);
}

// ---------- inspector

// Adds panel parts, skipping the ones switched off (null).
const put = (el, ...kids) => el.append(...kids.flat().filter((k) => k != null));
const section = (title, ...kids) => h('div', { class: 'insp-group' }, h('h3', {}, title), ...kids);
const kv = (k, v) => h('div', { class: 'kv' }, h('span', {}, k), h('b', {}, v));
const pct = (v) => (v === 0 ? 'Muted' : `${Math.round(v * 100)}%`);
const secs = (v) => (v === 0 ? 'Off' : `${v.toFixed(1)} s`);

// A row of choices. Picking one is an undo step and refreshes the timeline.
function segSection(title, options, current, onPick) {
  return section(title, h('div', { class: 'seg', role: 'group', 'aria-label': title },
    ...options.map(([v, label]) => h('button', {
      'aria-pressed': String(current === v),
      onClick: () => {
        if (current === v) return;
        commit();
        onPick(v);
        state.playhead = Math.min(state.playhead, totalDuration());
        renderTimeline();
        renderInspector();
        refreshPreview();
      },
    }, label))));
}

// A labelled slider. Dragging it counts as one undo step.
function sliderSection(title, { min, max, step, value, format, key, onValue }) {
  const out = h('b', {}, format(value));
  const input = h('input', {
    type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': title,
    onInput: (e) => {
      commitOnce(key);
      const v = Number(e.target.value);
      onValue(v);
      out.textContent = format(v);
    },
  });
  return section(title, h('div', { class: 'row' }, input, out));
}

function renderInspector() {
  const ins = $('#inspector');
  const scroll = ins.scrollTop;
  const kindBefore = ins.dataset.kind;
  renderInspectorBody();
  const kind = state.selected && itemOf(state.selected) ? state.selected.kind : 'project';
  ins.dataset.kind = kind;
  tabify(ins, kind);
  if (selection.length > 1) ins.prepend(multiBanner());
  // Redrawing after an edit keeps your place; picking something else starts at the top.
  ins.scrollTop = kindBefore === kind ? scroll : 0;
}

// ---------- inspector tabs: each kind of item has its settings sorted into a few tabs.
// Sections are matched by title; anything not listed stays with the section before it.

const TAB_ICONS = {
  video: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M3 15h18M8 5v4M16 5v4M8 15v4M16 15v4"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M14 6l4 4"/>',
  speed: '<path d="M12 14l4-4"/><path d="M3.5 18a9 9 0 1 1 17 0"/>',
  audio: '<path d="M4 10v4h4l5 4V6L8 10H4z"/><path d="M16.5 9a4 4 0 0 1 0 6"/><path d="M19 6.5a8 8 0 0 1 0 11"/>',
  motion: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/><circle cx="5" cy="12" r="1.5"/>',
  colour: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/>',
  layout: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><rect x="11.5" y="11" width="7" height="6" rx="1"/>',
  shape: '<path d="M12 20s-7-4.3-7-9.5A4 4 0 0 1 12 8a4 4 0 0 1 7 2.5C19 15.7 12 20 12 20z"/>',
  cutout: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1.2-3.5 4-5 7-5s5.8 1.5 7 5"/><path d="M3 3l18 18" stroke-dasharray="2 2"/>',
  text: '<path d="M5 6V4.5h14V6"/><path d="M12 4.5v15"/><path d="M9 19.5h6"/>',
  style: '<path d="M14 4l6 6-9 9H5v-6z"/><path d="M5 19l4-4"/>',
  anim: '<path d="M4 17c3 0 4-10 8-10s5 10 8 10"/><circle cx="12" cy="7" r="1.6" fill="currentColor"/>',
  sticker: '<path d="M20 12a8 8 0 1 1-8-8"/><path d="M20 12h-5a3 3 0 0 1-3-3V4"/><path d="M9 14.5c1.5 1.5 4.5 1.5 6 0"/>',
  effects: '<path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/>',
  project: '<rect x="3.5" y="5" width="17" height="13" rx="2"/><path d="M3.5 9h17"/>',
  keys: '<rect x="3" y="6.5" width="18" height="11" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8"/>',
  about: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  mask: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none"/>',
};

const INSPECTOR_TABS = {
  clip: [
    ['edit', 'Basics', ['Clip', 'Combined clip', 'Playback', 'Stabilise', 'Transition from previous clip', 'Fade in from black', 'Fade out at the end']],
    ['speed', 'Speed', ['Speed', 'Speed curve']],
    ['audio', 'Audio', ['Clip volume', 'Voice', 'Background noise']],
    ['motion', 'Transform', ['Keyframes', 'Scale', 'Position left / right', 'Position up / down', 'Rotation', 'Turn and flip', 'Crop left', 'Crop right', 'Crop top', 'Crop bottom']],
    ['mask', 'Mask', ['Mask', 'Mask outside', 'Mask size', 'Mask width', 'Mask left / right', 'Mask up / down', 'Mask soft edge']],
    ['colour', 'Colour', ['Touch up', 'Effect', 'Look', 'Brightness', 'Contrast', 'Saturation', 'Curves', 'Colour LUT']],
  ],
  overlay: [
    ['layout', 'Layout', ['Overlay', 'Position', 'Size', 'Opacity', 'Blend mode', 'Split screen']],
    ['shape', 'Shape', ['Shape', 'Box']],
    ['motion', 'Motion', ['Keyframes', 'Motion tracking']],
    ['cutout', 'Cut out', ['Green screen', 'Background']],
    ['colour', 'Colour', ['Look', 'Brightness', 'Contrast', 'Saturation', 'Curves', 'Colour LUT', 'Effect']],
  ],
  text: [
    ['text', 'Text', ['Text', 'Size', 'Position', 'Align', 'Nudge up / down', 'Timing']],
    ['style', 'Style', ['Caption look', 'Font', 'Colour', 'Word animation', 'Key words', 'Emoji', 'Highlight colour', 'Background', 'Letters']],
    ['anim', 'Animation', ['Animation']],
    ['motion', 'Motion', ['Keyframes', 'Motion tracking', 'Move left / right', 'Move up / down', 'Zoom', 'Turn', 'Opacity']],
  ],
  sticker: [
    ['sticker', 'Sticker', ['Sticker', 'Blur box', 'Pixelate box', 'Hide with', 'Shape', 'Strength', 'Soft edges', 'Width', 'Size', 'Rotation']],
    ['anim', 'Animation', ['Animation']],
    ['motion', 'Motion', ['Keyframes', 'Motion tracking']],
  ],
  audio: [
    ['audio', 'Sound', ['Audio', 'Volume', 'Fade in', 'Fade out']],
    ['effects', 'Effects', ['Voice', 'Auto-duck', 'Beat sync']],
  ],
  project: [
    ['project', 'Project', ['Project', 'Sound']],
    ['keys', 'Shortcuts', ['Shortcuts']],
    ['about', 'About', ['Snippy']],
  ],
};

// Tabs that share a place in the tab bar, with small buttons underneath to pick between them,
// so the bar stays short: [group id, label, member tab ids].
const TAB_GROUPS = {
  clip: [['g-edit', 'Edit', ['edit', 'speed']], ['g-audio', 'Audio', ['audio']], ['g-video', 'Video', ['motion', 'mask']], ['g-colour', 'Colour', ['colour']]],
  overlay: [['g-layout', 'Layout', ['layout', 'shape']], ['g-motion', 'Motion', ['motion']], ['g-cutout', 'Cut out', ['cutout']], ['g-colour', 'Colour', ['colour']]],
};
const GROUP_ICON = { 'g-edit': 'edit', 'g-audio': 'audio', 'g-video': 'video', 'g-colour': 'colour', 'g-layout': 'layout', 'g-motion': 'motion', 'g-cutout': 'cutout' };

const tabChoice = (() => { try { return JSON.parse(localStorage.getItem('snippy.inspTabs') || '{}'); } catch { return {}; } })();
const tabIcon = (id) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = TAB_ICONS[id] || '';
  return svg;
};

function tabify(ins, kind) {
  const tabs = INSPECTOR_TABS[kind];
  if (!tabs) return;
  const tabOf = new Map();
  for (const [id, , titles] of tabs) for (const t of titles) tabOf.set(t, id);
  const kids = [...ins.children];
  const groups = new Map(tabs.map(([id]) => [id, []]));
  let cur = tabs[0][0];
  for (const el of kids) {
    const title = el.classList.contains('insp-group') && el.querySelector(':scope > h3') ? el.querySelector(':scope > h3').textContent : null;
    if (title && tabOf.has(title)) cur = tabOf.get(title);
    groups.get(cur).push(el);
  }
  const live = tabs.filter(([id]) => groups.get(id).length);
  if (live.length < 2) return;
  let active = tabChoice[kind];
  if (!live.some(([id]) => id === active)) active = live[0][0];
  const labelOf = new Map(live.map(([id, label]) => [id, label]));
  // The bar's buttons: groups (several tabs behind one button) or single tabs.
  const defs = TAB_GROUPS[kind] || live.map(([id, label]) => [id, label, [id]]);
  const entries = defs.map(([gid, label, ids]) => ({ gid, label, ids: ids.filter((x) => labelOf.has(x)) })).filter((g) => g.ids.length);
  const grouped = new Set(entries.flatMap((g) => g.ids));
  for (const [id, label] of live) if (!grouped.has(id)) entries.push({ gid: id, label, ids: [id] }); // anything not in a group
  const groupOf = (id) => entries.find((g) => g.ids.includes(id));
  for (const g of entries) g.tid = g.ids.length === 1 ? g.ids[0] : g.gid; // a lone tab keeps its own name
  const bar = h('div', { class: 'insp-tabs', role: 'tablist', 'aria-label': 'Settings' });
  const panels = [];
  for (const g of entries) {
    const selected = g.ids.includes(active);
    const first = selected ? active : (g.ids.includes(tabChoice[`${kind}:${g.gid}`]) ? tabChoice[`${kind}:${g.gid}`] : g.ids[0]);
    const tab = h('button', {
      class: 'insp-tab', role: 'tab', id: `itab-${g.tid}`, 'data-tabs': g.ids.join(' '), 'aria-selected': String(selected),
      'aria-controls': `ipanel-${first}`, tabindex: selected ? '0' : '-1', title: g.label,
      onClick: () => pickTab(kind, g.ids.includes(tabChoice[`${kind}:${g.gid}`]) ? tabChoice[`${kind}:${g.gid}`] : g.ids[0]),
    }, tabIcon(GROUP_ICON[g.gid] || g.gid), h('span', {}, g.label));
    bar.append(tab);
  }
  for (const [id] of live) {
    const g = groupOf(id);
    const panel = h('div', { class: 'insp-panel', role: 'tabpanel', id: `ipanel-${id}`, 'aria-labelledby': `itab-${g.tid}`, 'data-tab': id });
    // Tabs sharing a button: small buttons at the top of each to switch between them.
    if (g.ids.length > 1) {
      panel.append(h('div', { class: 'insp-sub', role: 'group', 'aria-label': g.label },
        ...g.ids.map((x) => h('button', { class: 'insp-subtab', 'aria-pressed': String(x === id), onClick: () => pickTab(kind, x) }, labelOf.get(x)))));
    }
    panel.append(...groups.get(id));
    panel.hidden = id !== active;
    panels.push(panel);
  }
  // Left / right arrows move between tabs.
  bar.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const i = Math.max(0, entries.indexOf(groupOf(tabChoice[kind]) || entries[0]));
    const next = entries[(i + (e.key === 'ArrowRight' ? 1 : -1) + entries.length) % entries.length];
    pickTab(kind, next.ids[0]);
    const b = document.getElementById(`itab-${next.tid}`);
    if (b) b.focus();
  });
  ins.textContent = '';
  ins.append(bar, ...panels);
}

function pickTab(kind, id) {
  tabChoice[kind] = id;
  const ins = $('#inspector');
  for (const t of ins.querySelectorAll('.insp-tab')) {
    const on = (t.dataset.tabs || '').split(' ').includes(id);
    if (on) tabChoice[`${kind}:${t.id.slice(5)}`] = id; // each group remembers its last tab
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    if (on) t.setAttribute('aria-controls', `ipanel-${id}`);
  }
  try { localStorage.setItem('snippy.inspTabs', JSON.stringify(tabChoice)); } catch { /* not kept */ }
  for (const p of ins.querySelectorAll('.insp-panel')) p.hidden = p.dataset.tab !== id;
  ins.scrollTop = 0;
}

// Opens a tab from elsewhere (for example the right-click menu).
function showInspectorTab(id) {
  const kind = $('#inspector').dataset.kind;
  if (document.getElementById(`ipanel-${id}`)) pickTab(kind, id);
}

function multiBanner() {
  const n = selection.length;
  const texts = selection.filter((s) => s.kind === 'text').length;
  return h('div', { class: 'multi-banner' },
    h('div', { class: 'multi-title' }, oneGroup() ? `A group of ${n} items` : `${n} items selected`),
    h('p', { class: 'hint' }, texts > 1 && state.selected && state.selected.kind === 'text'
      ? `Style changes below apply to all ${texts} text items. Drag any of them to move them together.`
      : 'Drag any of them to move them together. Ctrl+click adds or removes one.'),
    h('div', { class: 'btn-row' },
      oneGroup() ? h('button', { class: 'btn', onClick: ungroupSelected }, 'Ungroup') : canGroup() ? h('button', { class: 'btn', title: 'Ctrl+G', onClick: groupSelected }, 'Group') : null,
      canCombine() ? h('button', { class: 'btn', onClick: combineClips }, 'Combine into one clip') : null,
      h('button', { class: 'btn', onClick: copySelection }, 'Copy'),
      h('button', { class: 'btn danger', onClick: deleteSelected }, `Delete ${n}`),
      h('button', { class: 'btn', onClick: () => select(null) }, 'Clear')));
}

function renderInspectorBody() {
  const ins = $('#inspector');
  ins.textContent = '';
  const s = state.selected;
  if (s && s.kind === 'text') {
    const x = state.texts.find((t) => t.id === s.id);
    if (x) return renderTextInspector(ins, x);
  }
  if (s && s.kind === 'clip') {
    const c = state.clips.find((t) => t.id === s.id);
    if (c) return renderClipInspector(ins, c);
  }
  if (s && s.kind === 'audio') {
    const a = state.audio.find((t) => t.id === s.id);
    if (a) return renderAudioInspector(ins, a);
  }
  if (s && s.kind === 'sticker') {
    const st = state.stickers.find((t) => t.id === s.id);
    if (st) return renderStickerInspector(ins, st);
  }
  if (s && s.kind === 'adjust') {
    const ad = state.adjust.find((t) => t.id === s.id);
    if (ad) return renderAdjustInspector(ins, ad);
  }
  if (s && s.kind === 'overlay') {
    const o = state.overlays.find((t) => t.id === s.id);
    if (o) return renderOverlayInspector(ins, o);
  }
  renderProjectInspector(ins);
}

// Move, size, turn and fade for a text. Each can be keyframed; dragging the text on the preview moves it too.
function textMotionSections(x) {
  const v = valuesNow('text', x);
  const redraw = () => { overlayKey = null; updateOverlay(); updateKfBar(); };
  const slide = (title, prop, min, max, step, format) => sliderSection(title, {
    min, max, step, value: v[prop], format, key: `${x.id}:${prop}`,
    onValue: (val) => { kset(x, 'text', { [prop]: val }); redraw(); },
  });
  const moved = v.dx || v.dy || v.scale !== 1 || v.rotate || v.opacity !== 1;
  return [
    keyframeSection(x, 'text'),
    trackSection(x, 'text'),
    slide('Move left / right', 'dx', -0.6, 0.6, 0.005, (n) => `${Math.round(n * 100)}`),
    slide('Move up / down', 'dy', -0.6, 0.6, 0.005, (n) => `${Math.round(n * 100)}`),
    slide('Zoom', 'scale', 0.2, 4, 0.01, (n) => `${Math.round(n * 100)}%`),
    slide('Turn', 'rotate', -180, 180, 1, (n) => `${Math.round(n)}°`),
    slide('Opacity', 'opacity', 0, 1, 0.01, (n) => `${Math.round(n * 100)}%`),
    h('p', { class: 'hint' }, 'Drag the text on the preview to move it, or scroll over it to resize it.'),
    moved ? h('div', { class: 'btn-row' }, h('button', {
      class: 'btn', onClick: () => { commit(); delete x.keys; Object.assign(x, { dx: 0, dy: 0, scale: 1, rotate: 0, opacity: 1 }); refreshKeyed(); },
    }, 'Reset movement')) : null,
  ];
}

function renderTextInspector(ins, x) {
  // With several text items selected, style changes (not the words) apply to all of them.
  const others = () => selection.filter((s) => s.kind === 'text' && s.id !== x.id).map(itemOf).filter(Boolean);
  const share = () => { const st = copyStyle(x); for (const o of others()) Object.assign(o, st); };
  const update = (key, fn) => { commitOnce(`${x.id}:${key}`); fn(); if (key !== 'text') share(); overlayKey = null; updateOverlay(); };
  const discrete = (fn) => { commit(); fn(); share(); overlayKey = null; updateOverlay(); renderInspector(); };
  const sizeOut = h('b', {}, `${x.size}%`);
  const textSeg = (title, options, current, set) => section(title, h('div', { class: 'seg', role: 'group', 'aria-label': title },
    ...options.map(([v, label]) => h('button', {
      'aria-pressed': String(current === v),
      onClick: () => { if (current !== v) discrete(() => set(v)); },
    }, label))));
  put(ins, 
    section('Text', h('textarea', {
      rows: '3', 'aria-label': 'Text', value: x.text,
      onInput: (e) => update('text', () => {
        x.text = e.target.value;
        const lab = content.querySelector(`.text-item[data-id="${x.id}"] .text-label`);
        if (lab) lab.textContent = labelFor(x);
      }),
    })),
    section('Size', h('div', { class: 'row' },
      h('input', {
        type: 'range', min: '3', max: '16', step: '0.5', value: String(x.size), 'aria-label': 'Text size',
        onInput: (e) => update('size', () => { x.size = Number(e.target.value); sizeOut.textContent = `${x.size}%`; }),
      }),
      sizeOut)),
    section('Position', h('div', { class: 'seg', role: 'group', 'aria-label': 'Position' },
      ...[['top', 'Top'], ['center', 'Middle'], ['bottom', 'Bottom']].map(([p, label]) =>
        h('button', { 'aria-pressed': String(x.position === p), onClick: () => discrete(() => { x.position = p; }) }, label)))),
    section('Caption look', h('div', { class: 'look-grid' },
      ...CAPTION_PRESETS.map((p) => h('button', {
        class: 'look-tile', title: p.name, 'aria-pressed': String(lookOf(x) === p.id),
        onClick: () => applyLook(x, p),
      }, lookThumb(p), h('span', {}, p.name)))),
      x.auto && state.texts.filter((t) => t.auto).length > 1 ? h('p', { class: 'hint' }, 'Picking a look changes all your auto captions.') : null),
    section('Font', h('div', { class: 'font-grid', role: 'group', 'aria-label': 'Font' },
      ...TEXT_FONTS.map(([id, name, fam, weight]) => h('button', {
        class: 'font-tile', 'aria-pressed': String((x.font || 'default') === id), title: name,
        style: `font-family:${fam.replace(/"/g, "'")};font-weight:${weight}`,
        onClick: () => discrete(() => { if (id === 'default') delete x.font; else x.font = id; }),
      }, name)))),
    section('Colour', h('div', { class: 'swatches' },
      ...brandSwatches().map((c) => h('button', {
        class: 'swatch brand-swatch', style: `background:${c}`, 'aria-label': `Brand colour ${c}`, title: 'From your brand kit',
        'aria-pressed': String(x.color === c), onClick: () => discrete(() => { x.color = c; }),
      })),
      ...COLORS.filter((c) => !brandSwatches().includes(c)).map((c) => h('button', {
        class: 'swatch', style: `background:${c}`, 'aria-label': `Colour ${c}`,
        'aria-pressed': String(x.color === c), onClick: () => discrete(() => { x.color = c; }),
      })))),
    textSeg('Animation', [['none', 'None'], ['pop', 'Pop'], ['fade', 'Fade'], ['slide', 'Slide'], ['typewriter', 'Typing']], x.anim || 'none', (v) => { x.anim = v; }),
    textSeg('Align', [['left', 'Left'], [undefined, 'Centre'], ['right', 'Right']], x.align, (v) => { x.align = v; }),
    sliderSection('Nudge up / down', {
      min: -0.4, max: 0.4, step: 0.005, value: x.offsetY || 0, format: (v) => `${Math.round(v * 100)}`, key: `${x.id}:offy`,
      onValue: (v) => { x.offsetY = v; share(); overlayKey = null; updateOverlay(); },
    }),
    section('Word animation', h('div', { class: 'choices', role: 'group', 'aria-label': 'Word animation' },
      ...WORD_FX.map(([v, label]) => h('button', {
        class: 'btn', 'aria-pressed': String((x.wordFx && x.wordFx !== 'none' ? x.wordFx : (x.highlight ? 'hl' : 'none')) === v),
        onClick: () => discrete(() => { x.highlight = v === 'hl'; x.wordFx = v === 'hl' ? 'none' : v; }),
      }, label)))),
    textSeg('Key words', [[false, 'Off'], [true, 'In colour']], Boolean(x.keyColor), (v) => { x.keyColor = v; }),
    textSeg('Emoji', [[false, 'Off'], [true, 'Add emoji']], Boolean(x.emoji), (v) => { x.emoji = v; }),
    x.highlight || (x.wordFx && x.wordFx !== 'none' && x.wordFx !== 'one') ? section('Highlight colour', h('div', { class: 'swatches' },
      ...[...new Set([...brandSwatches(), '#FFD84D', '#FACC15', '#4ADE80', '#5CE1E6', '#E879F9', '#F87171', '#FFFFFF'])].map((c) => h('button', {
        class: 'swatch', style: `background:${c}`, 'aria-label': `Highlight colour ${c}`,
        'aria-pressed': String((x.hlColor || '#FFD84D') === c), onClick: () => discrete(() => { x.hlColor = c; }),
      })))) : null,
    textSeg('Background', [[false, 'Outline'], [true, 'Box']], Boolean(x.box), (v) => { x.box = v; }),
    x.box ? section('Box colour', h('div', { class: 'swatches' },
      ...[...brandSwatches().map((c) => [c, 'Brand colour']), ...BOX_COLOURS].map(([c, label]) => h('button', {
        class: 'swatch', style: `background:${c}`, 'aria-label': `Box colour ${label}`, title: label,
        'aria-pressed': String((x.boxColor || BOX_COLOURS[0][0]) === c), onClick: () => discrete(() => { x.boxColor = c; }),
      })))) : null,
    textSeg('Letters', [[false, 'Normal'], [true, 'ALL CAPS']], Boolean(x.caps), (v) => { x.caps = v; }),
    section('Timing', kv('Starts at', fmt(x.start)), kv('Length', fmt(x.dur))),
    h('div', { class: 'btn-row' },
      state.texts.length > 1
        ? h('button', { class: 'btn', onClick: () => applyStyleToAll(x) }, 'Use this style for all text')
        : null,
      h('button', { class: 'btn danger', onClick: deleteSelected }, 'Delete text')),
    ...textMotionSections(x),
  );
}

function renderClipInspector(ins, c) {
  const m = mediaById(c.mediaId);
  put(ins, 
    section('Clip',
      h('div', { class: 'clip-title' }, m.name),
      kv('Length', fmt(clipLen(c))),
      isImage(m) ? kv('Type', 'Photo') : kv('Source in', fmt(c.in)),
      isImage(m) ? null : kv('Source out', fmt(c.out)),
      kv('Resolution', `${m.width}×${m.height}`),
      kv('Audio', m.hasAudio ? 'Yes' : 'None')),
    isImage(m) ? null : playbackSection(c),
    stabSection(c),
    isImage(m) ? null : h('div', { class: 'btn-row look-actions' },
      h('button', { class: 'btn', title: 'Hold the picture at the playhead for 2 seconds', onClick: freezeFrame }, 'Freeze frame here')),
    m.hasAudio ? voiceSection(c) : null,
    m.hasAudio ? h('div', {},
      segSection('Background noise', [[false, 'Keep'], [true, 'Reduce']], Boolean(c.denoise), (v) => { c.denoise = v; }),
      c.denoise ? h('p', { class: 'hint' }, 'Hiss and hum are reduced when you export. The preview plays the original sound.') : null) : null,
    m.hasAudio ? sliderSection('Clip volume', {
      min: 0, max: 2, step: 0.01, value: c.volume == null ? 1 : c.volume, format: pct, key: `${c.id}:vol`,
      onValue: (v) => {
        c.volume = v;
        if (state.clips[currentIndex] === c) video.volume = v;
      },
    }) : null,
    isImage(m) || c.ramp ? null : segSection('Speed', [[0.25, '¼×'], [0.5, '½×'], [1, '1×'], [1.5, '1.5×'], [2, '2×'], [4, '4×']], spd(c), (v) => {
      c.speed = v;
      if (state.clips[currentIndex] === c) { video.defaultPlaybackRate = v; video.playbackRate = v; }
    }),
    isImage(m) || c.mode === 'boomerang' ? null : rampSection(c),
    state.clips[0] === c
      ? segSection('Fade in from black', [[0, 'None'], [0.5, 'Short'], [1, 'Long']], c.transition || 0, (v) => { c.transition = v; })
      : section('Transition from previous clip', h('div', { class: 'xrow' },
        h('span', { class: 'xrow-name' }, c.transition > 0 ? `${transitionName(c.transitionType || 'dip')} · ${(c.transition || 0).toFixed(1)} s` : 'None (a straight cut)'),
        h('button', { class: 'btn small', onClick: (e) => openTransitionPop(state.clips.indexOf(c), e.currentTarget) }, c.transition > 0 ? 'Change' : 'Add')),
        h('p', { class: 'hint' }, 'Tip: click the + between two clips on the timeline.')),
    state.clips[state.clips.length - 1] === c
      ? segSection('Fade out at the end', [[0, 'None'], [0.5, 'Short'], [1.5, 'Long']], c.endFade || 0, (v) => { c.endFade = v; })
      : null,
    c.compound ? section('Combined clip',
      h('p', { class: 'hint' }, `${c.compound.clips.length} clips${c.compound.items.length ? ` and ${c.compound.items.length} other items` : ''} made into one. Effects, speed and transitions on it apply to the whole thing.`),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onClick: () => uncombineClip(c) }, 'Split back into the original clips'))) : null,
    keyframeSection(c, 'clip'),
    zoomSection(c),
    isImage(mediaById(c.mediaId)) && !mediaById(c.mediaId).width ? null : maskSection(c),
    segSection('Touch up', [['none', 'Off'], ['light', 'Light'], ['medium', 'Medium'], ['strong', 'Strong']], c.touch || 'none', (v) => { if (v === 'none') delete c.touch; else c.touch = v; }),
    c.touch ? h('p', { class: 'hint' }, 'Smooths skin and evens out small marks, with a little extra light. Best on faces close to the camera.') : null,
    c.touch && state.clips.length > 1 ? h('div', { class: 'btn-row look-actions' }, h('button', {
      class: 'btn', onClick: () => { commit(); for (const x of state.clips) x.touch = c.touch; markDirty(); renderInspector(); toast(`Touch up on all ${state.clips.length} clips`); },
    }, 'Use on all clips')) : null,
    section('Effect', h('div', { class: 'choices', role: 'group', 'aria-label': 'Effect' },
      ...FX_LIST.map(([v, label]) => h('button', {
        class: 'btn', 'aria-pressed': String((c.fx || 'none') === v),
        onClick: () => { if ((c.fx || 'none') === v) return; commit(); c.fx = v; updateFx(); renderInspector(); },
      }, label)))),
    state.clips.length > 1 && c.fx && c.fx !== 'none'
      ? h('div', { class: 'btn-row look-actions' }, h('button', {
        class: 'btn', onClick: () => { commit(); for (const x of state.clips) x.fx = c.fx; updateFx(); toast(`Added the effect to ${state.clips.length} clips`); },
      }, 'Use this effect on all clips'))
      : null,
    lookSection(c, m),
    ...adjustSliders(c),
    curveSection(c),
    lutSection(c),
    h('div', { class: 'btn-row look-actions' },
      h('button', { class: 'btn', onClick: () => resetColor(c) }, 'Reset colour'),
      state.clips.length > 1 ? h('button', { class: 'btn', onClick: () => lookToAll(c) }, 'Use this look on all clips') : null),
    h('p', { class: 'hint' }, 'Drag the clip edges to trim. Drag the middle to reorder.'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onClick: splitAtPlayhead }, 'Split at playhead'),
      h('button', { class: 'btn danger', onClick: deleteSelected }, 'Delete clip'))
  );
}

// A style tile: hovering it plays the transition between two coloured cards.
function transitionTile(id, name, dirWanted, pressed, onPick) {
  const L = { A: h('div', { class: 'ta' }, 'A'), B: h('div', { class: 'tb' }, 'B'), flash: h('div', { class: 'tflash' }) };
  const stageEl = h('div', { class: 'tstage' }, L.A, L.B, L.flash);
  let raf = 0;
  const dir = TRANSITION_DIRS[id] ? (TRANSITION_DIRS[id].includes(dirWanted) ? dirWanted : 'left') : 'left';
  const frame = (start) => (now) => {
    const p = Math.min(1, ((now - start) % 1500) / 1000);
    applyTransitionLook(L, id === 'pixelate' ? 'blur' : id, dir, p, 80, 45, now / 1000);
    if (id === 'shake') { const tf = shakeTransform(now / 1000, start / 1000 + 0.1, 0.5, 45); if (tf) { L.A.style.transform = tf; L.B.style.transform = tf; } }
    raf = requestAnimationFrame(frame(start));
  };
  const play = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(frame(performance.now())); };
  const stop = () => { cancelAnimationFrame(raf); resetTransitionLook(L); };
  return h('button', {
    class: 'ttile', 'aria-pressed': String(pressed), title: name, 'data-x': id,
    onMouseenter: play, onMouseleave: stop, onFocus: play, onBlur: stop,
    onClick: onPick,
  }, stageEl, h('span', {}, name));
}

// ---------- transition picker (from the + between clips)

const X_GROUPS = [
  ['all', 'All', null],
  ['smooth', 'Smooth', ['cross', 'dip', 'blur', 'softwipe', 'circleopen', 'zoom']],
  ['fast', 'Energetic', ['flash', 'whip', 'glitch', 'shake', 'spin', 'slices', 'zoom']],
  ['shapes', 'Wipes and shapes', ['wipe', 'softwipe', 'push', 'circleopen', 'circleclose', 'clock', 'squeeze', 'pixelate']],
];
let xGroup = (() => { try { return localStorage.getItem('snippy.xGroup') || 'all'; } catch { return 'all'; } })();
let xLast = { type: 'cross', len: 0.5 }; // what's used when a + is clicked and a style is picked first
const xjoinIcon = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<rect x="1.5" y="3.5" width="8" height="9" rx="1.5"/><rect x="6.5" y="3.5" width="8" height="9" rx="1.5"/>';
  return svg;
};

function closeTransitionPop() {
  const pop = $('#xPop');
  if (pop) pop.remove();
  document.removeEventListener('pointerdown', xOutside, true);
  document.removeEventListener('keydown', xKeys, true);
}
function xOutside(e) {
  const pop = $('#xPop');
  if (pop && !pop.contains(e.target) && !e.target.closest('.xjoin') && !e.target.closest('.ctx-menu')) closeTransitionPop();
}
function xKeys(e) { if (e.key === 'Escape') { e.stopPropagation(); closeTransitionPop(); } }

// Plays the cut: from a moment before it to a moment after.
function previewCut(i) {
  if (i < 1 || i >= state.clips.length) return;
  const starts = clipStarts();
  const ov = overlapOf(i);
  const from = Math.max(0, starts[i] - 1.1);
  const to = Math.min(totalDuration(), starts[i] + ov + 1.1);
  if (state.playing) pause();
  seek(from);
  play();
  clearTimeout(previewCut.timer);
  previewCut.timer = setTimeout(() => { if (state.playing) pause(); }, Math.max(400, (to - from) * 1000));
}

function setTransition(c, patch) {
  Object.assign(c, patch);
  if (c.transitionType && TRANSITION_DIRS[c.transitionType] && !TRANSITION_DIRS[c.transitionType].includes(c.transitionDir)) c.transitionDir = 'left';
  state.playhead = Math.min(state.playhead, totalDuration());
  markDirty();
  renderTimeline();
  renderInspector();
  refreshPreview();
}

// The picker for the cut into clip i, next to the button that opened it (or the clip).
function openTransitionPop(i, anchor) {
  closeTransitionPop();
  const c = state.clips[i];
  if (!c || i < 1) return;
  if (state.playing) pause();
  const pop = h('div', { id: 'xPop', class: 'xpop', role: 'dialog', 'aria-label': 'Transition' });
  const draw = () => {
    const cur = state.clips[i];
    const on = cur.transition > 0;
    const type = on ? (cur.transitionType || 'dip') : null;
    pop.textContent = '';
    const list = (X_GROUPS.find((g) => g[0] === xGroup) || X_GROUPS[0])[2];
    const pick = (id) => () => {
      commit();
      const len = cur.transition > 0 ? cur.transition : xLast.len;
      if (id === 'none') setTransition(cur, { transition: 0 });
      else setTransition(cur, { transition: len, transitionType: id });
      if (id !== 'none') xLast = { type: id, len };
      draw();
      if (id !== 'none') previewCut(i);
    };
    pop.append(
      h('div', { class: 'xpop-head' },
        h('b', {}, `Transition into clip ${i + 1}`),
        h('span', { class: 'xpop-cur' }, on ? transitionName(type) : 'Straight cut'),
        h('button', { class: 'icon-btn xpop-close', 'aria-label': 'Close', onClick: closeTransitionPop }, '×')),
      h('div', { class: 'xpop-groups', role: 'group', 'aria-label': 'Kinds of transition' },
        ...X_GROUPS.map(([id, label]) => h('button', {
          class: 'chip', 'aria-pressed': String(xGroup === id),
          onClick: () => { xGroup = id; try { localStorage.setItem('snippy.xGroup', id); } catch { /* not kept */ } draw(); },
        }, label))),
      h('div', { class: 'tgrid xpop-grid', role: 'group', 'aria-label': 'Transition style' },
        h('button', { class: 'ttile tnone', 'aria-pressed': String(!on), title: 'No transition: a straight cut', onClick: pick('none') },
          h('div', { class: 'tstage' }, h('div', { class: 'tnone-cut' })), h('span', {}, 'None')),
        ...TRANSITIONS.filter(([id]) => !list || list.includes(id)).map(([id, name]) => transitionTile(id, name, cur.transitionDir, type === id, pick(id)))),
    );
    if (on) {
      const max = Math.max(0.2, Math.min(2, clipLen(state.clips[i - 1]) / 2, clipLen(cur) / 2));
      const val = h('span', { class: 'xpop-val' }, `${cur.transition.toFixed(1)} s`);
      const range = h('input', { type: 'range', min: '0.2', max: max.toFixed(1), step: '0.1', value: String(Math.min(max, cur.transition)), 'aria-label': 'Transition length' });
      range.addEventListener('input', () => {
        commitOnce(`xlen:${cur.id}`);
        cur.transition = Number(range.value);
        xLast.len = cur.transition;
        val.textContent = `${cur.transition.toFixed(1)} s`;
        state.playhead = Math.min(state.playhead, totalDuration());
        renderTimeline();
        refreshPreview();
        markDirty();
      });
      range.addEventListener('change', () => { renderInspector(); previewCut(i); });
      pop.append(h('div', { class: 'xpop-row' }, h('span', {}, 'Length'), range, val));
      if (TRANSITION_DIRS[type]) {
        pop.append(h('div', { class: 'xpop-row' }, h('span', {}, 'Direction'),
          h('div', { class: 'seg' }, ...TRANSITION_DIRS[type].map((d) => h('button', {
            'aria-pressed': String((cur.transitionDir || 'left') === d),
            onClick: () => { commit(); setTransition(cur, { transitionDir: d }); draw(); previewCut(i); },
          }, d[0].toUpperCase() + d.slice(1))))));
      }
    }
    const cuts = state.clips.length - 1;
    pop.append(h('div', { class: 'xpop-actions' },
      h('button', { class: 'btn small', onClick: () => previewCut(i), title: 'Play this cut' }, '▶ Preview'),
      cuts > 1 && on ? h('button', { class: 'btn small', onClick: () => { transitionToAll(cur); draw(); } }, `Use on all ${cuts} cuts`) : null,
      cuts > 1 ? h('button', { class: 'btn small', title: 'A different transition on every cut, from the kind picked above', onClick: () => { mixTransitions(list, on ? cur.transition : xLast.len); draw(); } }, '🎲 Mix it up') : null,
      cuts > 1 && state.clips.some((x, k) => k > 0 && x.transition > 0) ? h('button', { class: 'btn small', onClick: () => { clearTransitions(); draw(); } }, 'Remove all') : null));
    place();
  };
  const place = () => {
    const r = anchor && anchor.isConnected ? anchor.getBoundingClientRect() : null;
    const W = pop.offsetWidth || 440;
    const H = pop.offsetHeight || 420;
    let x = r ? r.left + r.width / 2 - W / 2 : (window.innerWidth - W) / 2;
    let y = r ? r.top - H - 10 : (window.innerHeight - H) / 2;
    if (r && y < 8) y = Math.min(window.innerHeight - H - 8, r.bottom + 10);
    x = clamp(x, 8, window.innerWidth - W - 8);
    y = clamp(y, 8, window.innerHeight - H - 8);
    pop.style.left = `${Math.round(x)}px`;
    pop.style.top = `${Math.round(y)}px`;
  };
  document.body.append(pop);
  draw();
  if (!anchor) {
    const el = document.querySelector(`.xjoin[data-cut="${i}"]`);
    if (el) { anchor = el; place(); }
  }
  setTimeout(() => {
    document.addEventListener('pointerdown', xOutside, true);
    document.addEventListener('keydown', xKeys, true);
    const sel = pop.querySelector('.ttile[aria-pressed="true"]') || pop.querySelector('.ttile');
    if (sel) sel.focus({ preventScroll: true });
  });
}

// A different transition on every cut (never the same twice in a row), from one kind.
function mixTransitions(list, len) {
  const pool = (list || TRANSITIONS.map(([id]) => id)).filter((id) => id !== 'shake' || (list && list.length < 4));
  commit();
  let prev = null;
  let n = 0;
  state.clips.forEach((c, i) => {
    if (i === 0) return;
    const choices = pool.filter((id) => id !== prev);
    const id = choices[Math.floor(Math.random() * choices.length)];
    c.transition = len || 0.5;
    c.transitionType = id;
    if (TRANSITION_DIRS[id]) c.transitionDir = TRANSITION_DIRS[id][Math.floor(Math.random() * TRANSITION_DIRS[id].length)];
    prev = id;
    n++;
  });
  state.playhead = Math.min(state.playhead, totalDuration());
  markDirty();
  renderTimeline();
  renderInspector();
  refreshPreview();
  toast(`Mixed ${n} transitions. Click Mix it up again for another mix`);
}

function clearTransitions() {
  commit();
  state.clips.forEach((c, i) => { if (i > 0) c.transition = 0; });
  markDirty();
  renderTimeline();
  renderInspector();
  refreshPreview();
  toast('Removed the transitions');
}

function transitionToAll(src) {
  commit();
  state.clips.forEach((c, i) => {
    if (i === 0) return;
    c.transition = src.transition;
    c.transitionType = src.transitionType;
    c.transitionDir = src.transitionDir;
  });
  state.playhead = Math.min(state.playhead, totalDuration());
  renderTimeline();
  renderInspector();
  refreshPreview();
  toast(`Added the transition to ${state.clips.length - 1} cuts`);
}

function applyPreviewColor(c) {
  if (state.adjust.includes(c)) { adjustKey = ''; applyAdjustLayers(); return; }
  if (state.clips[currentIndex] === c) {
    video.style.filter = cssFilter(c);
    still.style.filter = cssFilter(c);
    updateFx();
  }
  syncOverlays(false);
}

// Look buttons show this clip's own thumbnail through each look.
function lookSection(c, m) {
  const current = c.look || 'none';
  return section('Look', h('div', { class: 'looks', role: 'group', 'aria-label': 'Look' },
    ...LOOKS.map((l) => {
      const preview = { ...c, look: l.id };
      const img = m.thumb ? h('img', { src: m.thumb, alt: '' }) : h('div', { class: 'look-blank' });
      img.style.filter = cssFilter(preview);
      return h('button', {
        class: 'look', 'aria-pressed': String(current === l.id),
        onClick: () => {
          if (current === l.id) return;
          commit();
          c.look = l.id;
          applyPreviewColor(c);
          renderInspector();
        },
      }, img, h('span', {}, l.name));
    })));
}

function adjustSliders(c) {
  const adj = () => (c.adj = c.adj || {});
  const signed = (v) => (Math.abs(v - 1) < 0.005 ? '0' : `${v > 1 ? '+' : '−'}${Math.round(Math.abs(v - 1) * 100)}`);
  const make = (title, key, min, max) => sliderSection(title, {
    min, max, step: 0.01, value: (c.adj && c.adj[key]) ?? 1, format: signed, key: `${c.id}:${key}`,
    onValue: (v) => { adj()[key] = v; applyPreviewColor(c); },
  });
  return [make('Brightness', 'brightness', 0.5, 1.5), make('Contrast', 'contrast', 0.5, 1.5), make('Saturation', 'saturation', 0, 2)];
}

function resetColor(c) {
  if ((c.look || 'none') === 'none' && !c.adj && !c.curve && !c.lut) return;
  commit();
  delete c.look;
  delete c.adj;
  delete c.curve;
  delete c.lut;
  applyPreviewColor(c);
  renderInspector();
}

function lookToAll(src) {
  commit();
  for (const c of state.clips) {
    c.look = src.look;
    c.adj = src.adj ? { ...src.adj } : undefined;
    c.curve = src.curve ? src.curve.slice() : undefined;
    c.lut = src.lut ? { ...src.lut } : undefined;
  }
  refreshPreview();
  toast(`Applied the look to ${state.clips.length} clips`);
}

const STICKER_ANIMS = [['none', 'None'], ['pop', 'Pop'], ['bounce', 'Bounce'], ['wiggle', 'Wiggle'], ['spin', 'Spin'], ['pulse', 'Pulse']];

function renderStickerInspector(ins, s) {
  const redraw = () => updateOverlay();
  if (s.effect) {
    put(ins,
      section(s.effect.type === 'pixel' ? 'Pixelate box' : 'Blur box', kv('Starts at', fmt(s.start)), kv('Length', fmt(s.dur))),
      ...fxSections(s),
      keyframeSection(s, 'sticker'),
      trackSection(s, 'sticker'),
      sliderSection('Size', {
        min: 0.03, max: 1, step: 0.01, value: valuesNow('sticker', s).size, format: (v) => `${Math.round(v * 100)}%`, key: `${s.id}:size`,
        onValue: (v) => { kset(s, 'sticker', { size: v }); redraw(); },
      }),
      sliderSection('Rotation', {
        min: -180, max: 180, step: 1, value: valuesNow('sticker', s).rotate || 0, format: (v) => `${Math.round(v)}°`, key: `${s.id}:rot`,
        onValue: (v) => { kset(s, 'sticker', { rotate: v }); redraw(); },
      }),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn danger', onClick: deleteSelected }, 'Delete box')));
    return;
  }
  put(ins,
    section('Sticker',
      s.fun ? h('div', { class: 'sticker-big' }, funThumb(s.fun)) : h('div', { class: 'sticker-big', 'aria-hidden': 'true' }, s.gif ? (s.gif.noto ? s.gif.name : '🎞️') : s.emoji),
      s.gif ? kv('File', s.gif.noto ? 'Animated emoji' : s.gif.name) : null,
      kv('Starts at', fmt(s.start)),
      kv('Length', fmt(s.dur))),
    h('div', { class: 'btn-row look-actions' },
      h('button', { class: 'btn', onClick: () => openPicker('replace') }, 'Change sticker')),
    s.fun && FUN_TEXT.has(s.fun.kind) ? section('Words', h('input', {
      type: 'text', class: 'text-input', maxlength: '14', value: s.fun.text || '', 'aria-label': 'Sticker words',
      onInput: (e) => { commitOnce(`${s.id}:funtext`); s.fun.text = e.target.value.toUpperCase(); overlayKey = null; updateOverlay(); renderTimeline(); },
    })) : null,
    s.gif && s.gif.noto ? section('Credit', h('p', { class: 'hint' }, `${NOTO_CREDIT}. Add this line to your video's description.`),
      h('button', { class: 'btn small', onClick: () => navigator.clipboard.writeText(NOTO_CREDIT).then(() => toast('Credit line copied')) }, 'Copy credit line')) : null,
    section('Animation', h('div', { class: 'choices', role: 'group', 'aria-label': 'Animation' },
      ...STICKER_ANIMS.map(([v, label]) => h('button', {
        class: 'btn', 'aria-pressed': String((s.anim || 'none') === v),
        onClick: () => { if ((s.anim || 'none') === v) return; commit(); s.anim = v; redraw(); renderInspector(); },
      }, label)))),
    keyframeSection(s, 'sticker'),
    trackSection(s, 'sticker'),
    sliderSection('Size', {
      min: 0.03, max: 0.6, step: 0.01, value: valuesNow('sticker', s).size, format: (v) => `${Math.round(v * 100)}%`, key: `${s.id}:size`,
      onValue: (v) => { kset(s, 'sticker', { size: v }); redraw(); },
    }),
    sliderSection('Rotation', {
      min: -180, max: 180, step: 1, value: valuesNow('sticker', s).rotate || 0, format: (v) => `${Math.round(v)}°`, key: `${s.id}:rot`,
      onValue: (v) => { kset(s, 'sticker', { rotate: v }); redraw(); },
    }),
    h('p', { class: 'hint' }, 'Drag the sticker on the preview to move it, or drag its corner dot to resize it. Drag its edges on the timeline to change how long it shows.'),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn danger', onClick: deleteSelected }, 'Delete sticker'))
  );
}

// ---------- background removal

let cutoutRunning = false;

function setCutoutProgress(p) {
  const msg = $('#cutMsg');
  const bar = $('#cutBar');
  if (p.phase === 'loading') { msg.textContent = 'Getting the cut-out model ready.'; bar.style.width = '0%'; }
  else if (p.phase === 'download') {
    msg.textContent = `Downloading the cut-out model (one time only). ${Math.round(p.progress * 100)}%`;
    bar.style.width = `${Math.round(p.progress * 100)}%`;
  } else if (p.phase === 'cutout') {
    msg.textContent = p.count ? `Finding the person in frame ${p.index} of ${p.count}.` : 'Finding the person.';
    bar.style.width = `${Math.round(p.progress * 100)}%`;
  }
}

async function removeBackground(o) {
  const m = mediaById(o.mediaId);
  pause();
  cutoutRunning = true;
  $('#cutoutModal').hidden = false;
  $('#cutCancel').textContent = 'Cancel';
  setCutoutProgress({ phase: 'loading' });
  const off = window.api.onCutoutProgress(setCutoutProgress);
  try {
    const outPath = await window.api.removeBackground(m.path, m.kind);
    const info = await window.api.probe(outPath);
    let cut = state.media.find((x) => x.path === info.path);
    if (!cut) {
      cut = { ...info, id: newId('m'), name: `${m.name} (cut out)` };
      state.media.push(cut);
    }
    commit();
    o.originalMediaId = m.id;
    o.mediaId = cut.id;
    // The cut-out keeps the same timing, but its length can differ by a frame.
    o.out = Math.min(o.out, cut.duration);
    o.in = Math.min(o.in, Math.max(0, o.out - MIN_LEN));
    $('#cutoutModal').hidden = true;
    renderAll();
    select('overlay', o.id);
    refreshPreview();
    toast('Background removed');
  } catch (err) {
    const msg = cleanError(err);
    if (msg.includes('cancelled')) $('#cutoutModal').hidden = true;
    else {
      console.error(err);
      $('#cutMsg').textContent = `The background couldn't be removed: ${msg}`;
      $('#cutCancel').textContent = 'Close';
    }
  } finally {
    off();
    cutoutRunning = false;
  }
}

function restoreBackground(o) {
  if (!mediaById(o.originalMediaId)) { toast("The original file isn't in this project any more"); return; }
  commit();
  o.mediaId = o.originalMediaId;
  delete o.originalMediaId;
  renderAll();
  select('overlay', o.id);
  refreshPreview();
}

const KEY_COLOURS = [['#00B140', 'Green screen'], ['#0047BB', 'Blue screen']];

function keySection(o) {
  const live = () => syncOverlays(false);
  if (!o.key) {
    return section('Green screen', h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onClick: () => { commit(); o.key = { color: '#00B140', similarity: 0.3, blend: 0.1 }; live(); renderInspector(); } }, 'Make a colour see-through')));
  }
  return h('div', {},
    section('Green screen',
      h('div', { class: 'swatches' },
        ...KEY_COLOURS.map(([c, label]) => h('button', {
          class: 'swatch', style: `background:${c}`, 'aria-label': label, title: label,
          'aria-pressed': String(o.key.color.toUpperCase() === c), onClick: () => { commit(); o.key.color = c; live(); renderInspector(); },
        })),
        h('input', {
          type: 'color', class: 'key-colour', value: o.key.color, 'aria-label': 'Any colour', title: 'Any colour',
          onInput: (e) => { commitOnce(`${o.id}:keycol`); o.key.color = e.target.value.toUpperCase(); live(); },
        })),
      h('div', { class: 'btn-row' },
        h('button', {
          class: 'btn', onClick: () => {
            pickingKeyFor = o.id;
            $('#stage').classList.add('picking');
            toast('Click the colour to remove on the overlay');
          },
        }, 'Pick from the video'),
        h('button', { class: 'btn', onClick: () => { commit(); delete o.key; live(); renderInspector(); } }, 'Turn off'))),
    sliderSection('Strength', {
      min: 0.02, max: 0.6, step: 0.01, value: o.key.similarity, format: (v) => `${Math.round(v * 100)}`, key: `${o.id}:sim`,
      onValue: (v) => { o.key.similarity = v; live(); },
    }),
    sliderSection('Edge softness', {
      min: 0, max: 0.3, step: 0.01, value: o.key.blend, format: (v) => `${Math.round(v * 100)}`, key: `${o.id}:blend`,
      onValue: (v) => { o.key.blend = v; live(); },
    }));
}

function renderOverlayInspector(ins, o) {
  const m = mediaById(o.mediaId);
  const [W, H] = ASPECTS[state.aspect];
  const live = () => syncOverlays(false);
  // Corner positions leave a margin of 3% of the canvas width on every side.
  const now = valuesNow('overlay', o);
  const halfW = now.w / 2;
  const halfH = (now.w * W * ovAr(o)) / H / 2;
  const mx = clamp(0.03 + halfW, 0, 0.5);
  const my = clamp((0.03 * W) / H + halfH, 0, 0.5);
  const spots = [
    ['Top left', mx, my], ['Top right', 1 - mx, my], ['Centre', 0.5, 0.5],
    ['Bottom left', mx, 1 - my], ['Bottom right', 1 - mx, 1 - my],
  ];
  const moveTo = (x, y, w) => {
    commit();
    kset(o, 'overlay', w ? { x, y, w } : { x, y });
    live();
    renderTimeline();
  };
  put(ins, 
    section('Overlay',
      h('div', { class: 'clip-title' }, m.name),
      kv('Type', isImage(m) ? 'Photo' : 'Video'),
      kv('Starts at', fmt(o.start)),
      kv('Length', fmt(o.out - o.in))),
    section('Position', h('div', { class: 'spots' },
      ...spots.map(([label, x, y]) => h('button', { class: 'btn', onClick: () => moveTo(x, y) }, label)),
      h('button', { class: 'btn', onClick: () => moveTo(0.5, 0.5, 1) }, 'Full width'))),
    section('Shape', h('div', { class: 'shape-grid' },
      ...SHAPES.map(([id, label]) => h('button', {
        class: 'shape-tile', 'aria-pressed': String((o.shape || 'none') === id), title: label,
        onClick: () => {
          commit();
          o.shape = id;
          if (SQUARE_SHAPES.has(id) && !o.cell) o.cell = 1; // circles and hearts look best from a square crop
          syncOverlays(true);
          renderInspector();
        },
      }, h('span', { class: `shape-ico shape-${id}` }), h('small', {}, label)))),
      o.shape && o.shape !== 'none' ? h('label', { class: 'check' }, h('input', {
        type: 'checkbox', checked: Boolean(o.soft),
        onChange: (e) => { commit(); o.soft = e.target.checked; syncOverlays(true); },
      }), 'Soft edges') : null),
    section('Box', h('div', { class: 'seg', role: 'group', 'aria-label': 'Box shape' },
      ...[[0, 'Original'], [1, 'Square'], [9 / 16, '9:16'], [16 / 9, '16:9'], [4 / 5, '4:5']].map(([v, label]) => h('button', {
        'aria-pressed': String(Math.abs((o.cell || 0) - v) < 0.01),
        onClick: () => { commit(); o.cell = v || undefined; syncOverlays(true); renderInspector(); renderTimeline(); },
      }, label)))),
    o.cell ? sliderSection('Move picture left / right', {
      min: 0, max: 1, step: 0.01, value: o.cropX ?? 0.5, format: (x) => `${Math.round(x * 100)}`, key: `${o.id}:cx`,
      onValue: (x) => { o.cropX = x; syncOverlays(false); },
    }) : null,
    o.cell ? sliderSection('Move picture up / down', {
      min: 0, max: 1, step: 0.01, value: o.cropY ?? 0.5, format: (x) => `${Math.round(x * 100)}`, key: `${o.id}:cy`,
      onValue: (x) => { o.cropY = x; syncOverlays(false); },
    }) : null,
    section('Split screen', h('div', { class: 'layout-grid' },
      ...LAYOUTS.map(([id, label, cells]) => h('button', { class: 'layout-tile', title: label, onClick: () => applyLayout(id) },
        h('span', { class: 'layout-pic' }, ...cells.map((c) => h('i', {
          style: c === 'bubble' ? 'right:6%;bottom:8%;width:30%;height:42%;border-radius:50%' : `left:${c[0] * 100}%;top:${c[1] * 100}%;width:${c[2] * 100}%;height:${c[3] * 100}%`,
        }))),
        h('small', {}, label)))),
      h('p', { class: 'hint' }, 'Arranges the overlays showing at the playhead into boxes that fill the screen.')),
    sliderSection('Size', {
      min: 0.05, max: 1, step: 0.01, value: Math.min(1, now.w), format: (v) => `${Math.round(v * 100)}%`, key: `${o.id}:w`,
      onValue: (v) => { kset(o, 'overlay', { w: v }); live(); },
    }),
    sliderSection('Opacity', {
      min: 0.1, max: 1, step: 0.01, value: now.opacity, format: (v) => `${Math.round(v * 100)}%`, key: `${o.id}:op`,
      onValue: (v) => { kset(o, 'overlay', { opacity: v }); live(); },
    }),
    section('Blend mode', h('div', { class: 'choices', role: 'group', 'aria-label': 'Blend mode' },
      ...BLENDS.map(([v, label, tip]) => h('button', {
        class: 'btn', title: tip, 'aria-pressed': String((o.blend || 'normal') === v),
        onClick: () => { if ((o.blend || 'normal') === v) return; commit(); if (v === 'normal') delete o.blend; else o.blend = v; syncOverlays(true); renderInspector(); },
      }, label)))),
    m.hasAudio ? sliderSection('Volume', {
      min: 0, max: 1, step: 0.01, value: o.volume, format: pct, key: `${o.id}:vol`,
      onValue: (v) => { o.volume = v; live(); },
    }) : null,
    section('Background',
      o.originalMediaId
        ? h('div', { class: 'btn-row' },
          h('span', { class: 'muted' }, 'Background removed.'),
          h('button', { class: 'btn', onClick: () => restoreBackground(o) }, 'Restore background'))
        : h('div', { class: 'btn-row' },
          h('button', { class: 'btn primary', onClick: () => removeBackground(o) }, 'Remove background'))),
    keyframeSection(o, 'overlay'),
    trackSection(o, 'overlay'),
    keySection(o),
    lookSection(o, m),
    h('p', { class: 'hint' }, 'Drag the overlay on the preview to move it, or drag its corner dot to resize it. Drag its edges on the timeline to trim.'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onClick: splitAtPlayhead }, 'Split at playhead'),
      h('button', { class: 'btn danger', onClick: deleteSelected }, 'Delete overlay'))
  );
}

// ---------- voice changer, playback direction and freeze frame

const VOICES = [['none', 'Normal'], ['studio', 'Studio voice'], ['chipmunk', 'Chipmunk'], ['deep', 'Deep'], ['robot', 'Robot'], ['echo', 'Echo'], ['radio', 'Radio'], ['alien', 'Alien']];

function voiceSection(item) {
  const cur = item.voice || 'none';
  return section('Voice', h('div', { class: 'choices', role: 'group', 'aria-label': 'Voice' },
    ...VOICES.map(([v, label]) => h('button', {
      class: 'btn', 'aria-pressed': String(cur === v),
      onClick: () => {
        if (cur === v) return;
        commit();
        item.voice = v === 'none' ? undefined : v;
        renderInspector();
        refreshPreview();
      },
    }, label))));
}

function playbackSection(c) {
  const cur = c.mode || 'normal';
  const key = c.mode ? derivedKey(c, mediaById(c.mediaId)) : null;
  const pending = key && derivedCache.get(key) && derivedCache.get(key).pending;
  return section('Playback',
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Playback' },
      ...[['normal', 'Normal'], ['reverse', 'Reverse'], ['boomerang', 'Boomerang']].map(([v, label]) => h('button', {
        'aria-pressed': String(cur === v),
        onClick: () => {
          if (cur === v) return;
          if (v !== 'normal' && c.out - c.in > 30) { toast('Trim the clip to 30 seconds or less to play it backwards'); return; }
          commit();
          c.mode = v === 'normal' ? undefined : v;
          if (v === 'boomerang' && c.ramp) { delete c.ramp; toast('Boomerang clips play at one speed, so the speed curve was turned off'); }
          state.playhead = Math.min(state.playhead, totalDuration());
          renderTimeline();
          renderInspector();
          refreshPreview();
        },
      }, label))),
    pending ? h('p', { class: 'hint', id: 'modeHint' }, 'Making the copy for the preview…') : null);
}

// Steadies handheld footage. The preview uses a steadied copy as soon as it's ready.
function stabSection(c) {
  const m = mediaById(c.mediaId);
  if (!m || isImage(m)) return null;
  const cur = c.stab || 'off';
  const key = c.stab ? derivedKey(c, m) : null;
  const pending = key && derivedCache.get(key) && derivedCache.get(key).pending;
  return section('Stabilise',
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Stabilise' },
      ...[['off', 'Off'], ['light', 'Light'], ['medium', 'Medium'], ['strong', 'Strong']].map(([v, label]) => h('button', {
        'aria-pressed': String(cur === v),
        onClick: () => {
          if (cur === v) return;
          if (v !== 'off' && c.out - c.in > 120) { toast('Trim the clip to 2 minutes or less to stabilise it'); return; }
          commit();
          c.stab = v === 'off' ? undefined : v;
          renderInspector();
          refreshPreview();
        },
      }, label))),
    h('p', c.stab && pending ? { class: 'hint', id: 'stabHint' } : { class: 'hint' },
      c.stab && pending ? 'Steadying the clip…' : 'Smooths out shaky handheld footage. Stronger settings zoom in a little more to hide the moving edges.'));
}

// ---------- speed curves

function rampSection(c) {
  const presetOf = () => (c.ramp ? (RAMP_PRESETS.find(([, , v]) => v.join() === c.ramp.join()) || ['custom'])[0] : 'none');
  const changed = () => {
    state.playhead = Math.min(state.playhead, totalDuration());
    renderTimeline();
    refreshPreview();
    lenOut.textContent = c.ramp ? `Plays in ${fmt(clipLen(c))} (footage is ${fmt(c.out - c.in)})` : '';
  };
  const lenOut = h('p', { class: 'hint ramp-len' }, c.ramp ? `Plays in ${fmt(clipLen(c))} (footage is ${fmt(c.out - c.in)})` : '');
  const chips = h('div', { class: 'ramp-presets' },
    ...[['none', 'None', null], ...RAMP_PRESETS].map(([id, name, v]) => h('button', {
      class: 'preset-chip', 'aria-pressed': String(presetOf() === id),
      onClick: () => {
        commit();
        if (v) { c.ramp = v.slice(); delete c.speed; } else delete c.ramp;
        renderInspector();
        changed();
      },
    }, name)));
  return section('Speed curve', chips, c.ramp ? rampEditor(c, changed) : h('p', { class: 'hint' }, 'Speed up and slow down within the clip. Pick a style, then drag the points to adjust it.'), lenOut);
}

// Five points through the clip; drag one up to speed up, down to slow down (0.1× to 10×).
function rampEditor(c, onChange) {
  const W = 256;
  const H = 110;
  const cv = h('canvas', { class: 'ramp-canvas', width: String(W * 2), height: String(H * 2), 'aria-label': 'Speed curve editor' });
  const yOf = (s) => (1 - (Math.log10(s) + 1) / 2) * (H - 16) + 8;
  const sOf = (y) => 10 ** ((1 - (y - 8) / (H - 16)) * 2 - 1);
  const xOf = (i) => 12 + (i * (W - 24)) / (c.ramp.length - 1);
  const draw = () => {
    const ctx = cv.getContext('2d');
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = '10px system-ui, sans-serif';
    for (const [s, label] of [[10, '10×'], [1, '1×'], [0.1, '0.1×']]) {
      ctx.strokeStyle = s === 1 ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.08)';
      ctx.beginPath(); ctx.moveTo(0, yOf(s)); ctx.lineTo(W, yOf(s)); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.45)';
      ctx.fillText(label, W - 26, yOf(s) - 3);
    }
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, '#8B5CF6'); g.addColorStop(0.55, '#D946EF'); g.addColorStop(1, '#F472B6');
    ctx.strokeStyle = g; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
    ctx.beginPath();
    c.ramp.forEach((s, i) => (i ? ctx.lineTo(xOf(i), yOf(s)) : ctx.moveTo(xOf(i), yOf(s))));
    ctx.stroke();
    c.ramp.forEach((s, i) => {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(xOf(i), yOf(s), 5, 0, Math.PI * 2); ctx.fill();
    });
  };
  cv.addEventListener('pointerdown', (e) => {
    const r = cv.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    let idx = 0;
    c.ramp.forEach((_, i) => { if (Math.abs(xOf(i) - x) < Math.abs(xOf(idx) - x)) idx = i; });
    commitOnce(`${c.id}:ramp`);
    const move = (ev) => {
      const y = ((ev.clientY - r.top) / r.height) * H;
      const v = clamp(sOf(y), RAMP_MIN, RAMP_MAX);
      // Snap to 1× when close, so getting back to normal speed is easy.
      c.ramp[idx] = Math.abs(Math.log10(v)) < 0.04 ? 1 : Number(v.toFixed(2));
      draw();
      onChange();
    };
    move(e);
    drag(e, { onMove: (_dx, ev) => move(ev), onEnd: () => renderInspector() });
  });
  requestAnimationFrame(draw);
  return cv;
}

// ---------- colour grading: curves, LUTs and adjustment layers

function curveSection(item, onChange) {
  const changed = onChange || (() => applyPreviewColor(item));
  const cur = item.curve || CURVE_PRESETS[0][2];
  const presetId = (CURVE_PRESETS.find(([, , v]) => v.join() === cur.join()) || ['custom'])[0];
  return section('Curves',
    h('div', { class: 'ramp-presets' }, ...CURVE_PRESETS.map(([id, name, v]) => h('button', {
      class: 'preset-chip', 'aria-pressed': String(presetId === id),
      onClick: () => { commit(); if (id === 'none') delete item.curve; else item.curve = v.slice(); changed(); renderInspector(); },
    }, name))),
    curveEditor(item, changed),
    h('p', { class: 'hint' }, 'Drag the points: left ones change the shadows, right ones the highlights.'));
}

function curveEditor(item, onChange) {
  const W = 256;
  const Hh = 150;
  const cv = h('canvas', { class: 'curve-canvas', width: String(W * 2), height: String(Hh * 2), 'aria-label': 'Curve editor' });
  const pad = 10;
  const X = (x) => pad + x * (W - pad * 2);
  const Y = (y) => Hh - pad - y * (Hh - pad * 2);
  const draw = () => {
    const ys = item.curve || CURVE_PRESETS[0][2];
    const ctx = cv.getContext('2d');
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, W, Hh);
    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    for (let k = 1; k < 4; k++) { ctx.beginPath(); ctx.moveTo(X(k / 4), Y(0)); ctx.lineTo(X(k / 4), Y(1)); ctx.moveTo(X(0), Y(k / 4)); ctx.lineTo(X(1), Y(k / 4)); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(1), Y(1)); ctx.stroke(); ctx.setLineDash([]);
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, '#8B5CF6'); g.addColorStop(0.55, '#D946EF'); g.addColorStop(1, '#F472B6');
    ctx.strokeStyle = g; ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let k = 0; k <= 64; k++) { const x = k / 64; const y = curveAt(ys, x); if (k) ctx.lineTo(X(x), Y(y)); else ctx.moveTo(X(x), Y(y)); }
    ctx.stroke();
    ys.forEach((y, i) => { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(X(i / 4), Y(y), 5, 0, Math.PI * 2); ctx.fill(); });
  };
  cv.addEventListener('pointerdown', (e) => {
    const r = cv.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const idx = clamp(Math.round(((x - pad) / (W - pad * 2)) * 4), 0, 4);
    commitOnce(`${item.id}:curve`);
    if (!item.curve) item.curve = CURVE_PRESETS[0][2].slice();
    const move = (ev) => {
      const y = ((ev.clientY - r.top) / r.height) * Hh;
      item.curve[idx] = Number(clamp((Hh - pad - y) / (Hh - pad * 2), 0, 1).toFixed(3));
      if (isFlatCurve(item.curve)) delete item.curve;
      draw();
      onChange();
    };
    move(e);
    drag(e, { onMove: (_dx, ev) => move(ev), onEnd: () => renderInspector() });
  });
  requestAnimationFrame(draw);
  return cv;
}

// ----- LUTs: read once, kept as 3D colour tables for the preview

const lutStore = new Map(); // path -> { size, data } or { pending }
function parseCube(text) {
  let size = 0;
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  const vals = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'LUT_3D_SIZE') size = Number(parts[1]);
    else if (parts[0] === 'DOMAIN_MIN') min = parts.slice(1, 4).map(Number);
    else if (parts[0] === 'DOMAIN_MAX') max = parts.slice(1, 4).map(Number);
    else if (/^[-\d.]/.test(parts[0]) && parts.length >= 3) vals.push(Number(parts[0]), Number(parts[1]), Number(parts[2]));
  }
  if (!size || vals.length < size ** 3 * 3) throw new Error("That isn't a 3D .cube LUT Snippy can read");
  const data = new Uint8Array(size ** 3 * 4);
  for (let i = 0; i < size ** 3; i++) {
    for (let ch = 0; ch < 3; ch++) data[i * 4 + ch] = Math.round(clamp((vals[i * 3 + ch] - min[ch]) / ((max[ch] - min[ch]) || 1), 0, 1) * 255);
    data[i * 4 + 3] = 255;
  }
  return { size, data };
}
async function loadLut(p) {
  const have = lutStore.get(p);
  if (have) return have.pending || have;
  const job = window.api.readLut(p).then((text) => { const l = parseCube(text); lutStore.set(p, l); return l; });
  lutStore.set(p, { pending: job });
  try { return await job; } catch (err) { lutStore.delete(p); throw err; }
}

function lutSection(c) {
  return section('Colour LUT',
    c.lut ? h('div', { class: 'lut-name' }, c.lut.name) : h('p', { class: 'hint' }, 'Load a .cube LUT: the colour presets photographers and filmmakers share.'),
    c.lut ? sliderSection('Strength', {
      min: 0, max: 1, step: 0.01, value: c.lut.mix ?? 1, format: (v) => `${Math.round(v * 100)}%`, key: `${c.id}:lutmix`,
      onValue: (v) => { c.lut.mix = v; },
    }) : null,
    h('div', { class: 'btn-row' },
      h('button', {
        class: 'btn small', onClick: async () => {
          const p = await window.api.pickLut();
          if (!p) return;
          try { await loadLut(p); } catch (err) { toast(cleanError(err)); return; }
          commit();
          c.lut = { path: p, name: p.split(/[\\/]/).pop(), mix: 1 };
          renderInspector();
        },
      }, c.lut ? 'Change LUT…' : 'Load a LUT…'),
      c.lut ? h('button', { class: 'btn small', onClick: () => { commit(); delete c.lut; renderInspector(); } }, 'Remove') : null));
}

// ----- the LUT view: a WebGL canvas over a layer that shows the graded picture

// Touch up levels: blur size (share of the picture's height), how much of it, and brightness.
const TOUCH_LEVELS = { light: { k: 0.0045, op: 0.55, bright: 1.025 }, medium: { k: 0.007, op: 0.75, bright: 1.04 }, strong: { k: 0.01, op: 0.9, bright: 1.055 } };
const touchOf = (c) => (c && c.touch && TOUCH_LEVELS[c.touch]) || null;

class LutView {
  constructor(layer) {
    this.canvas = h('canvas', { class: 'lut-view' });
    this.canvas.hidden = true;
    layer.append(this.canvas);
    this.gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true });
    this.lutTex = null;
    this.lutKey = null;
    if (!this.gl) return;
    const gl = this.gl;
    const vs = `#version 300 es
in vec2 p; out vec2 uv; void main() { uv = vec2(p.x * .5 + .5, .5 - p.y * .5); gl_Position = vec4(p, 0, 1); }`;
    const fs = `#version 300 es
precision highp float; precision highp sampler3D;
in vec2 uv; out vec4 o; uniform sampler2D img; uniform sampler3D lut; uniform float n; uniform float mixv;
uniform float useLut; uniform float smoothv; uniform vec2 sig; uniform float bright;
// Touch up: a blurred copy laid over with "lighten", so small dark marks fill in from the skin
// around them while edges stay, then a touch brighter. The export does the same with FFmpeg.
vec3 blurAt(vec2 p) {
  vec3 acc = texture(img, p).rgb * .2;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * .785398;
    vec2 d = vec2(cos(a), sin(a));
    acc += texture(img, p + d * sig * .9).rgb * .065 + texture(img, p + d * sig * 1.9).rgb * .035;
  }
  return acc;
}
void main() {
  vec3 c = texture(img, uv).rgb;
  if (smoothv > 0.) { vec3 b = blurAt(uv); c = mix(c, max(c, b), smoothv); c *= bright; }
  if (useLut > .5) { vec3 q = (clamp(c, 0., 1.) * (n - 1.) + .5) / n; c = mix(c, texture(lut, q).rgb, mixv); }
  o = vec4(c, 1.);
}`;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(pr);
    gl.useProgram(pr);
    this.pr = pr;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.imgTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  }

  hide(src) {
    if (!this.canvas.hidden) { this.canvas.hidden = true; if (src) src.style.opacity = ''; }
  }

  draw(src, lutPath, mix, touch = null) {
    const gl = this.gl;
    const lut = lutPath ? lutStore.get(lutPath) : null;
    const w = src.videoWidth || src.naturalWidth;
    const hh = src.videoHeight || src.naturalHeight;
    const useLut = Boolean(lut && lut.data);
    if (!gl || (!useLut && !touch) || !w || !hh || (src.readyState != null && src.readyState < 2)) { this.hide(src); return false; }
    const scale = Math.min(1, 1920 / Math.max(w, hh));
    const cw = Math.round(w * scale);
    const ch = Math.round(hh * scale);
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    gl.viewport(0, 0, cw, ch);
    if (useLut && this.lutKey !== lutPath) {
      if (this.lutTex) gl.deleteTexture(this.lutTex);
      this.lutTex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, lut.size, lut.size, lut.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut.data);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
      this.lutKey = lutPath;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); } catch { this.hide(src); return false; }
    gl.uniform1i(gl.getUniformLocation(this.pr, 'img'), 0);
    gl.uniform1i(gl.getUniformLocation(this.pr, 'lut'), 1);
    gl.uniform1f(gl.getUniformLocation(this.pr, 'n'), useLut ? lut.size : 2);
    gl.uniform1f(gl.getUniformLocation(this.pr, 'mixv'), mix);
    gl.uniform1f(gl.getUniformLocation(this.pr, 'useLut'), useLut ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(this.pr, 'smoothv'), touch ? touch.op : 0);
    // The blur's size is a share of the picture's height, as in the export.
    gl.uniform2f(gl.getUniformLocation(this.pr, 'sig'), touch ? (touch.k * hh) / w : 0, touch ? touch.k : 0);
    gl.uniform1f(gl.getUniformLocation(this.pr, 'bright'), touch ? touch.bright : 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // The canvas takes the picture's place, with the same filters and zoom on top.
    this.canvas.style.filter = src.style.filter;
    this.canvas.style.transform = src.style.transform;
    this.canvas.style.transformOrigin = src.style.transformOrigin;
    this.canvas.style.clipPath = src.style.clipPath;
    this.canvas.style.maskImage = src.style.maskImage;
    this.canvas.style.webkitMaskImage = src.style.webkitMaskImage;
    this.canvas.style.maskSize = '100% 100%';
    this.canvas.style.webkitMaskSize = '100% 100%';
    this.canvas.hidden = false;
    src.style.opacity = '0';
    return true;
  }
}

let lutA = null;
let lutB = null;
function drawLutLayers() {
  if (!lutA) { lutA = new LutView($('#layerA')); lutB = new LutView($('#layerB')); }
  const loc = state.clips.length ? locate(state.playhead) : null;
  const a = loc && loc.clip;
  const srcA = still.hidden ? video : still;
  if (a && (a.lut || touchOf(a))) { if (a.lut && !lutStore.get(a.lut.path)) loadLut(a.lut.path).catch(() => {}); lutA.draw(srcA, a.lut ? a.lut.path : null, a.lut ? a.lut.mix ?? 1 : 0, touchOf(a)); }
  else lutA.hide(srcA);
  const x = crossAt(state.playhead);
  const srcB = stillB.hidden ? videoB : stillB;
  if (x && (x.clip.lut || touchOf(x.clip)) && !$('#layerB').hidden) { if (x.clip.lut && !lutStore.get(x.clip.lut.path)) loadLut(x.clip.lut.path).catch(() => {}); lutB.draw(srcB, x.clip.lut ? x.clip.lut.path : null, x.clip.lut ? x.clip.lut.mix ?? 1 : 0, touchOf(x.clip)); }
  else lutB.hide(srcB);
}

// ----- adjustment layers: a look, adjustments and a curve over everything underneath

function addAdjustLayer() {
  if (!state.clips.length) { toast('Add a video first'); return; }
  commit();
  const x = { id: newId('a'), start: Math.min(state.playhead, Math.max(0, totalDuration() - MIN_LEN)), dur: Math.min(5, Math.max(MIN_LEN, totalDuration() - state.playhead)), look: 'none' };
  state.adjust.push(x);
  renderTimeline();
  select('adjust', x.id);
}

let adjustKey = '';
function applyAdjustLayers() {
  const t = state.playhead;
  const on = state.adjust.filter((x) => t >= x.start && t < x.start + x.dur);
  const f = on.map((x) => cssFilter(x)).filter((v) => v !== 'none').join(' ');
  if (f !== adjustKey) { $('#gradeLayer').style.filter = f || ''; adjustKey = f; }
}

function renderAdjustInspector(ins, x) {
  const refresh = () => { adjustKey = ''; applyAdjustLayers(); };
  const m = { thumb: (state.clips[0] && mediaById(state.clips[0].mediaId) || {}).thumb };
  put(ins,
    section('Adjustment layer',
      h('p', { class: 'hint' }, 'Colours everything underneath it (clips and overlays) while it lasts. Drag its edges on the timeline to change when.'),
      kv('Starts at', fmt(x.start)), kv('Length', fmt(x.dur))),
    section('Look', h('div', { class: 'looks', role: 'group', 'aria-label': 'Look' },
      ...LOOKS.map((l) => {
        const img = m.thumb ? h('img', { src: m.thumb, alt: '' }) : h('div', { class: 'look-blank' });
        img.style.filter = cssFilter({ ...x, look: l.id });
        return h('button', {
          class: 'look', 'aria-pressed': String((x.look || 'none') === l.id),
          onClick: () => { commit(); x.look = l.id; refresh(); renderInspector(); },
        }, img, h('span', {}, l.name));
      }))),
    ...adjustSliders(x).map((el) => { el.addEventListener('input', refresh); return el; }),
    curveSection(x, refresh),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn danger', onClick: deleteSelected }, 'Delete adjustment layer')));
}

$('#adjustLbl').addEventListener('click', addAdjustLayer);

async function freezeFrame() {
  const loc = locate(state.playhead);
  if (!loc) { toast('Add a video first'); return; }
  const c = loc.clip;
  const m = mediaById(c.mediaId);
  if (isImage(m)) { toast('That clip is already a still picture'); return; }
  pause();
  const t = trueSourceTime(c, loc.src);
  let info;
  try {
    info = await window.api.probe(await window.api.grabFrame(m.path, t));
  } catch (err) {
    toast(`Couldn't grab the frame: ${cleanError(err)}`);
    return;
  }
  let img = state.media.find((x) => x.path === info.path);
  if (!img) { img = { ...info, id: newId('m'), name: `Freeze ${fmt(t)} – ${m.name}` }; state.media.push(img); }
  commit();
  const freeze = { id: newId('c'), mediaId: img.id, in: 0, out: 2, volume: 1, look: c.look, adj: c.adj ? { ...c.adj } : undefined, fx: c.fx };
  const local = state.playhead - loc.start;
  let at = loc.index + 1;
  if (!c.mode && !c.ramp && local >= MIN_LEN && clipLen(c) - local >= MIN_LEN) {
    // Split the clip at the playhead and hold the picture in between.
    const cut = c.in + local * spd(c);
    const second = { ...c, id: newId('c'), in: cut, transition: 0 };
    if (c.keys) second.keys = c.keys.map((k) => ({ ...k, t: k.t - local }));
    c.out = cut;
    delete c.endFade;
    state.clips.splice(loc.index + 1, 0, second);
  } else if (local < MIN_LEN) {
    at = loc.index;
  }
  state.clips.splice(at, 0, freeze);
  renderAll();
  select('clip', freeze.id);
  refreshPreview();
  toast('Added a 2-second freeze frame. Drag its edge to hold it longer or shorter.');
}

// ---------- sound effects

let sfxList = null;

let packBusy = false;
let packFailed = 0;

function sfxRow(x) {
  return h('div', { class: 'sfx-row' },
    h('button', { class: 'icon-btn sfx-play', title: `Listen to ${x.name}`, 'aria-label': `Listen to ${x.name}`, onClick: () => playSfx(x.id) },
      h('span', { 'aria-hidden': 'true' }, '▶')),
    h('span', { class: 'sfx-name' }, x.name),
    h('span', { class: 'muted' }, x.duration ? `${x.duration.toFixed(1)} s` : ''),
    h('button', { class: 'btn', onClick: () => addSfx(x.id) }, 'Add'));
}

function drawPackCard() {
  const card = $('#packCard');
  const pack = sfxList.filter((x) => x.source === 'pack');
  const ready = pack.filter((x) => x.ready).length;
  card.textContent = '';
  card.hidden = ready === pack.length && !packBusy;
  if (card.hidden) return;
  if (packBusy) {
    card.append(
      h('b', {}, 'Downloading real sound effects'),
      h('p', { id: 'packMsg', class: 'muted' }, 'Starting.'),
      h('div', { class: 'progress' }, h('div', { id: 'packBar', class: 'progress-bar' })),
      h('button', { class: 'btn small', onClick: () => window.api.cancelSoundPack() }, 'Stop'));
    return;
  }
  const partial = ready > 0;
  card.append(
    h('b', {}, partial ? `${pack.length - ready} sounds still to download` : `${pack.length} real sound effects, free`),
    h('p', { class: 'muted' }, partial
      ? (packFailed ? `${packFailed} couldn't be downloaded last time. Check your internet connection and try again.` : 'Pick up where the download left off.')
      : 'Studio recordings of whooshes, applause, laughs, a camera shutter, a cork pop, a boom and more. About 12 MB, downloaded once.'),
    h('button', { class: 'btn primary', onClick: downloadSoundPack }, partial ? 'Try again' : 'Download the sound pack'));
}

async function downloadSoundPack() {
  packBusy = true;
  drawPackCard();
  const off = window.api.onSoundPackProgress((p) => {
    const bar = $('#packBar');
    if (bar) bar.style.width = `${Math.round((p.done / p.total) * 100)}%`;
    const msg = $('#packMsg');
    if (msg) msg.textContent = `${p.done} of ${p.total}${p.name ? `: ${p.name}` : ''}`;
  });
  let res = null;
  try {
    res = await window.api.downloadSoundPack();
  } catch (err) {
    if (!/cancelled/.test(String(err && err.message))) toast(`The sound pack couldn't be downloaded: ${cleanError(err)}`);
  } finally {
    off();
    packBusy = false;
  }
  packFailed = res ? res.failed.length : 0;
  if (res && !res.failed.length) toast(`Added ${res.total} real sound effects`);
  else if (res) toast(`${res.installed} of ${res.total} sounds are ready. ${res.failed.length} couldn't be downloaded.`);
  sfxList = null;
  if (!$('#sfxPicker').hidden) openSfx();
}

async function openSfx() {
  const p = $('#sfxPicker');
  if (!sfxList) {
    sfxList = await window.api.listSoundEffects();
    const list = $('#sfxList');
    list.textContent = '';
    const groups = [];
    for (const x of sfxList) {
      if (x.source === 'pack' && !x.ready) continue;
      let g = groups.find((y) => y.name === x.group);
      if (!g) { g = { name: x.group, items: [] }; groups.push(g); }
      g.items.push(x);
    }
    for (const g of groups) {
      list.append(h('h4', { class: 'sfx-group' }, g.name));
      for (const x of g.items) list.append(sfxRow(x));
    }
  }
  drawPackCard();
  $('#sfxPicker .sfx-credit').hidden = !sfxList.some((x) => x.source === 'pack' && x.ready);
  const anchor = $('#sfxBtn').getBoundingClientRect();
  p.hidden = false;
  const r = p.getBoundingClientRect();
  p.style.left = `${clamp(anchor.left, 8, window.innerWidth - r.width - 8)}px`;
  p.style.top = `${clamp(anchor.top - r.height - 8, 8, window.innerHeight - r.height - 8)}px`;
}
const closeSfx = () => { $('#sfxPicker').hidden = true; };

const sfxPlayer = new Audio();
async function playSfx(id) {
  try {
    const f = await window.api.makeSoundEffect(id);
    sfxPlayer.src = f.url;
    sfxPlayer.currentTime = 0;
    sfxPlayer.play().catch(() => {});
  } catch (err) { toast(`Couldn't play the sound: ${cleanError(err)}`); }
}

async function addSfx(id) {
  if (!state.clips.length) { toast('Add a video first, then put sound effects on it'); return; }
  let f;
  let info;
  try {
    f = await window.api.makeSoundEffect(id);
    info = await window.api.probe(f.path);
  } catch (err) { toast(`Couldn't make the sound: ${cleanError(err)}`); return; }
  let m = state.media.find((x) => x.path === info.path);
  if (!m) { m = { ...info, id: newId('m') }; state.media.push(m); loadLevels(m); }
  commit();
  const item = { ...newAudioItem(m, Math.min(state.playhead, Math.max(0, totalDuration() - MIN_LEN))), volume: 1 };
  state.audio.push(item);
  closeSfx();
  renderAll();
  select('audio', item.id);
  toast(`Added ${(sfxList.find((x) => x.id === id) || { name: 'the sound' }).name} at the playhead`);
}

// ---------- music library

let musicLib = null;
let musicMood = 'All';
const musicPlayer = new Audio();

async function openMusic() {
  try { musicLib = await window.api.musicList(); } catch (err) { toast(`Couldn't read your music folder: ${cleanError(err)}`); return; }
  drawMusic();
  const p = $('#musicPicker');
  const anchor = $('#musicBtn').getBoundingClientRect();
  p.hidden = false;
  const r = p.getBoundingClientRect();
  p.style.left = `${clamp(anchor.left, 8, window.innerWidth - r.width - 8)}px`;
  p.style.top = `${clamp(anchor.top - r.height - 8, 8, window.innerHeight - r.height - 8)}px`;
}
const closeMusic = () => { $('#musicPicker').hidden = true; musicPlayer.pause(); };

function drawMusic() {
  const moods = ['All', ...musicLib.moods];
  const box = $('#musicMoods');
  box.textContent = '';
  for (const m of moods) {
    box.append(h('button', { class: 'preset-chip', 'aria-pressed': String(m === musicMood), onClick: () => { musicMood = m; drawMusic(); } }, m));
  }
  const list = $('#musicList');
  list.textContent = '';
  const tracks = musicLib.tracks.filter((t) => musicMood === 'All' || t.mood === musicMood);
  if (!tracks.length) {
    list.append(h('p', { class: 'muted music-empty' }, musicLib.tracks.length
      ? `Nothing in ${musicMood} yet.`
      : 'Your music library is empty. Add tracks you\'re allowed to use, and they\'ll be here for every project, sorted by mood.'));
  }
  for (const t of tracks) {
    list.append(h('div', { class: 'sfx-row' },
      h('button', {
        class: 'icon-btn sfx-play', title: `Listen to ${t.name}`, 'aria-label': `Listen to ${t.name}`,
        onClick: () => {
          if (musicPlayer.dataset.src === t.url && !musicPlayer.paused) { musicPlayer.pause(); return; }
          musicPlayer.src = t.url; musicPlayer.dataset.src = t.url; musicPlayer.currentTime = 0; musicPlayer.play().catch(() => {});
        },
      }, h('span', { 'aria-hidden': 'true' }, '▶')),
      h('span', { class: 'sfx-name' }, t.name),
      h('span', { class: 'muted' }, musicMood === 'All' ? t.mood : ''),
      h('button', { class: 'btn', title: 'Add under the whole video, fitted to its length', onClick: () => addMusicTrack(t) }, 'Use')));
  }
}

// Background music fitted to the video: starts at the beginning, loops with soft joins if
// it's shorter than the video, ends with a fade, and dips under speech.
async function addMusicTrack(t) {
  if (!state.clips.length) { toast('Add a video first, then add music under it'); return; }
  let info;
  try { info = await window.api.probe(t.path); } catch (err) { toast(`Couldn't read that track: ${cleanError(err)}`); return; }
  let m = state.media.find((x) => x.path === info.path);
  if (!m) { m = { ...info, id: newId('m') }; state.media.push(m); loadLevels(m); }
  commit();
  const items = fitMusic(m, totalDuration());
  state.audio.push(...items);
  musicPlayer.pause();
  closeMusic();
  renderAll();
  select('audio', items[0].id);
  toast(items.length > 1 ? `Added ${t.name}, looped ${items.length} times to fill the video` : `Added ${t.name}, fitted to your video`);
}

function fitMusic(m, total) {
  const hasSpeech = state.clips.some((c) => { const cm = mediaById(c.mediaId); return cm && cm.hasAudio && (c.volume ?? 1) > 0; });
  const join = 1; // seconds of crossfade between loops
  const items = [];
  let t = 0;
  while (t < total - 0.5 && items.length < 50) {
    const len = Math.min(m.duration, total - t);
    const a = { ...newAudioItem(m, t), in: 0, out: len, volume: 0.6, fadeIn: items.length ? join : 0.5, fadeOut: 0 };
    if (hasSpeech) { a.duck = true; a.duckTo = 0.3; }
    items.push(a);
    t += len - (t + len < total - 0.01 ? join : 0);
  }
  const last = items[items.length - 1];
  last.fadeOut = Math.min(2.5, (last.out - last.in) / 2);
  for (let i = 0; i < items.length - 1; i++) items[i].fadeOut = join;
  return items;
}

$('#musicBtn').addEventListener('click', () => ($('#musicPicker').hidden ? openMusic() : closeMusic()));
$('#musicFolder').addEventListener('click', () => window.api.openMusicFolder());
$('#musicAdd').addEventListener('click', async () => {
  const mood = musicMood === 'All' ? 'Upbeat' : musicMood;
  const n = await window.api.addMusic(mood);
  if (n) { toast(`Added ${n} track${n === 1 ? '' : 's'} to ${mood}`); openMusic(); }
});
document.addEventListener('pointerdown', (e) => {
  const p = $('#musicPicker');
  if (!p.hidden && !p.contains(e.target) && !e.target.closest('#musicBtn')) closeMusic();
});

// ---------- auto-ducking controls

function duckSection(a) {
  const on = Boolean(a.duck);
  const parts = [
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Lower under speech' },
      ...[[false, 'Off'], [true, 'Lower under speech']].map(([v, label]) => h('button', {
        'aria-pressed': String(on === v),
        onClick: () => {
          if (on === v) return;
          commit();
          a.duck = v;
          if (a.duckTo == null) a.duckTo = 0.3;
          state.media.forEach(loadLevels);
          renderInspector();
        },
      }, label))),
  ];
  if (on) {
    parts.push(sliderSection('Music level while talking', {
      min: 0.05, max: 0.8, step: 0.01, value: a.duckTo ?? 0.3, format: pct, key: `${a.id}:duck`,
      onValue: (v) => { a.duckTo = v; },
    }));
  }
  parts.push(h('p', { class: 'hint' }, 'Snippy listens to your clips and turns this music down while someone is talking.'));
  return section('Auto-duck', ...parts);
}

// ---------- beat sync

let beatEvery = 1;

function beatSection(a) {
  if (!a.beats) {
    return section('Beat sync',
      h('p', { class: 'hint' }, 'Find the beat of this music to snap clips to it, or have Snippy cut your clips on the beat.'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onClick: () => findBeats(a) }, 'Find the beat')));
  }
  if (!a.beats.length) {
    return section('Beat sync', h('p', { class: 'hint' }, "No steady beat was found in this audio."),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onClick: () => findBeats(a) }, 'Try again')));
  }
  const inRange = a.beats.filter((b) => b >= a.in && b <= a.out).length;
  return section('Beat sync',
    kv('Tempo', `${a.bpm} BPM`),
    kv('Beats marked', String(inRange)),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Cut on' },
      ...[[1, 'Every beat'], [2, 'Every 2'], [4, 'Every bar']].map(([v, label]) => h('button', {
        'aria-pressed': String(beatEvery === v), onClick: () => { beatEvery = v; renderInspector(); },
      }, label))),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onClick: () => syncClipsToBeats(a, beatEvery) }, 'Cut clips to the beat')));
}

async function findBeats(a) {
  const m = mediaById(a.mediaId);
  toast('Listening for the beat…');
  try {
    // The whole file, so the beat is still there if the music is trimmed differently later.
    const r = await window.api.detectBeats(m.path, 0, m.duration);
    commit();
    a.beats = r.beats;
    a.bpm = r.bpm;
    renderTimeline();
    renderInspector();
    toast(r.beats.length ? `Found ${r.bpm} BPM. Clips now snap to the beat.` : 'No steady beat was found');
  } catch (err) {
    toast(`Couldn't find the beat: ${cleanError(err)}`);
  }
}

// Trim each main clip so that every cut lands on a beat (or every 2nd or 4th beat).
function syncClipsToBeats(a, every) {
  const cuts = a.beats
    .filter((b) => b >= a.in && b <= a.out)
    .map((b) => a.start + b - a.in)
    .filter((t) => t >= MIN_LEN)
    .filter((_, i) => i % every === every - 1 || every === 1);
  if (!cuts.length || !state.clips.length) { toast('The music needs to overlap your clips'); return; }
  commit();
  let changed = 0;
  let crossfades = 0;
  let prevEnd = 0;
  for (const c of state.clips) {
    // Crossfades overlap clips, which would pull later cuts off the beat.
    if (c.transition > 0 && isCross(c)) { c.transition = 0; crossfades++; }
    const m = mediaById(c.mediaId);
    if (c.mode) { prevEnd += clipLen(c); continue; } // reversed and boomerang clips keep their length
    const maxLen = isImage(m) ? Infinity : (m.duration - c.in) / spd(c); // as long as the clip can go
    const want = prevEnd + clipLen(c);
    // The beat nearest to where this clip ends now, as long as the clip is long enough to reach it.
    let best = null;
    for (const t of cuts) {
      if (t - prevEnd < MIN_LEN || t - prevEnd > maxLen) continue;
      if (!best || Math.abs(t - want) < Math.abs(best - want)) best = t;
    }
    if (best == null) { prevEnd += clipLen(c); continue; } // too short to reach any beat; left as it is
    c.out = c.in + (best - prevEnd) * spd(c);
    prevEnd = best;
    changed++;
  }
  state.playhead = Math.min(state.playhead, totalDuration());
  renderAll();
  refreshPreview();
  toast(`${changed} of ${state.clips.length} clips now cut on the beat${crossfades ? `. ${crossfades} crossfade(s) removed to keep cuts on the beat` : ''}`);
}

function renderAudioInspector(ins, a) {
  const m = mediaById(a.mediaId);
  const len = a.out - a.in;
  const maxFade = Math.max(0.1, Math.min(5, len / 2));
  put(ins, 
    section('Audio',
      h('div', { class: 'clip-title' }, m.name),
      kv('Starts at', fmt(a.start)),
      kv('Length', fmt(len))),
    sliderSection('Volume', {
      min: 0, max: 1, step: 0.01, value: valuesNow('audio', a).volume, format: pct, key: `${a.id}:vol`,
      onValue: (v) => { kset(a, 'audio', { volume: v }); if (a.keys && a.keys.length) renderTimeline(); },
    }),
    keyframeSection(a, 'audio'),
    sliderSection('Fade in', {
      min: 0, max: maxFade, step: 0.1, value: Math.min(a.fadeIn, maxFade), format: secs, key: `${a.id}:fi`,
      onValue: (v) => { a.fadeIn = v; },
    }),
    sliderSection('Fade out', {
      min: 0, max: maxFade, step: 0.1, value: Math.min(a.fadeOut, maxFade), format: secs, key: `${a.id}:fo`,
      onValue: (v) => { a.fadeOut = v; },
    }),
    voiceSection(a),
    a.duckable === false ? null : duckSection(a),
    beatSection(a),
    h('p', { class: 'hint' }, 'Drag the edges to trim. Drag the middle to move it. Audio past the end of the video is cut off on export.'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onClick: splitAtPlayhead }, 'Split at playhead'),
      h('button', { class: 'btn danger', onClick: deleteSelected }, 'Delete audio'))
  );
}

// ---------- app version and updates

let appVersion = '';
let updateStatus = { state: 'off' };

function updateLine() {
  const s = updateStatus;
  if (s.state === 'checking') return 'Checking for updates…';
  if (s.state === 'current') return 'You have the latest version.';
  if (s.state === 'downloading') return `Downloading version ${s.version} (${Math.round((s.progress || 0) * 100)}%).`;
  if (s.state === 'ready') return `Version ${s.version} is ready.`;
  if (s.state === 'error') return "Couldn't check for updates.";
  if (s.state === 'off') return 'Updates arrive automatically in the installed app once releases are set up.';
  return '';
}

function showUpdateBar() {
  const bar = $('#updateBar');
  const s = updateStatus;
  bar.hidden = !(s.state === 'downloading' || s.state === 'ready');
  if (bar.hidden) return;
  $('#updateMsg').textContent = s.state === 'ready'
    ? `Snippy ${s.version} is ready to install.`
    : `Downloading Snippy ${s.version}… ${Math.round((s.progress || 0) * 100)}%`;
  $('#updateGo').hidden = s.state !== 'ready';
}

// The version, and the state of updates, at the bottom of the home screen.
function renderHomeVersion() {
  const s = updateStatus;
  $('#homeVer').textContent = appVersion ? `Snippy ${appVersion}` : 'Snippy';
  const msg = s.state === 'checking' ? 'Checking for updates…'
    : s.state === 'current' ? 'Up to date'
      : s.state === 'downloading' ? `Downloading version ${s.version}… ${Math.round((s.progress || 0) * 100)}%`
        : s.state === 'ready' ? `Version ${s.version} has downloaded`
          : s.state === 'error' ? 'Couldn’t check for updates'
            : s.state === 'off' ? 'Running from the project folder (update with node update.js)'
              : '';
  $('#homeUpd').textContent = msg;
  $('#homeVersion').classList.toggle('ready', s.state === 'ready');
  const barWrap = $('#homeUpdBar').parentElement;
  barWrap.hidden = s.state !== 'downloading';
  $('#homeUpdBar').style.width = `${Math.round((s.progress || 0) * 100)}%`;
  $('#homeRestart').hidden = s.state !== 'ready';
  $('#homeCheck').hidden = !['idle', 'current', 'error'].includes(s.state);
}
$('#homeRestart').addEventListener('click', () => window.api.installUpdate());
$('#homeCheck').addEventListener('click', async () => {
  updateStatus = { state: 'checking' };
  renderHomeVersion();
  try { updateStatus = await window.api.checkForUpdates(); } catch { updateStatus = { state: 'error' }; }
  // "checking" is followed by an event; if none comes (already up to date), say so.
  if (updateStatus.state === 'checking' || updateStatus.state === 'idle') updateStatus = { state: 'current' };
  renderHomeVersion();
});

if (window.api.appVersion) {
  window.api.appVersion().then((v) => { appVersion = v; renderHomeVersion(); if (!state.selected) renderInspector(); }).catch(() => {});
  window.api.updateState().then((s) => { updateStatus = s; showUpdateBar(); renderHomeVersion(); }).catch(() => {});
  window.api.onUpdateStatus((s) => { updateStatus = s; showUpdateBar(); renderHomeVersion(); if (!state.selected) renderInspector(); });
}

function aboutSection() {
  return section('Snippy',
    kv('Version', appVersion || '—'),
    h('p', { class: 'hint' }, updateLine()),
    updateStatus.state === 'off' ? null : h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onClick: async () => { updateStatus = await window.api.checkForUpdates(); renderInspector(); } }, 'Check for updates')),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onClick: () => startTour() }, 'Show the welcome tour'),
      h('button', { class: 'btn', title: 'Checks FFmpeg, folders, internet access and downloads', onClick: runCheckup }, 'Run a check-up')));
}

// Measures every clip's loudness and sets volumes so they all sit at the same level.
const LOUD_TARGET = -16; // LUFS, a common level for online video
async function evenOutLoudness() {
  const clips = state.clips.filter((c) => { const m = mediaById(c.mediaId); return m && !isImage(m) && m.hasAudio && (c.volume ?? 1) > 0; });
  if (!clips.length) { toast('No clips with sound to even out'); return; }
  const win = jobWindow('Even out loudness', () => {});
  $('#jobCancel').hidden = true;
  const found = [];
  try {
    for (let i = 0; i < clips.length; i++) {
      win.update(`Listening to clip ${i + 1} of ${clips.length}.`, i / clips.length);
      const c = clips[i];
      const lufs = await window.api.measureLoudness(mediaById(c.mediaId).path, c.in, c.out);
      if (lufs != null && lufs > -60) found.push({ c, lufs });
    }
  } catch (err) {
    toast(`Couldn't measure loudness: ${cleanError(err)}`);
  } finally {
    win.close();
    $('#jobCancel').hidden = false;
  }
  if (!found.length) return;
  commit();
  let boosted = 0;
  for (const { c, lufs } of found) {
    c.volume = Number(clamp(10 ** ((LOUD_TARGET - lufs) / 20), 0.05, 2).toFixed(3));
    if (c.volume > 1) boosted++;
  }
  renderInspector();
  refreshPreview();
  toast(`Evened out ${found.length} clip${found.length === 1 ? '' : 's'}${boosted ? `. ${boosted} needed a boost above 100%, which the export applies (the preview plays them at 100%)` : ''}.`);
}

function renderProjectInspector(ins) {
  const [w, hgt] = ASPECTS[state.aspect];
  const fixed = [
    ['Ctrl+Z', 'Undo'], ['Ctrl+Y', 'Redo'], ['Ctrl+S', 'Save project'], ['Ctrl+O', 'Open project'],
    ['Ctrl+click', 'Select several'], ['Ctrl+A', 'Select everything'], ['Ctrl+G', 'Group (Ctrl+Shift+G ungroups)'], ['Alt+click', 'Pick one item from a group'], ['Ctrl+C / V', 'Copy and paste'],
    ['Ctrl+scroll', 'Zoom timeline'],
  ];
  put(ins, 
    section('Project',
      kv('Canvas', `${w}×${hgt}`),
      kv('Frame rate', `${FPS} fps`),
      kv('Length', fmt(totalDuration())),
      kv('Clips', String(state.clips.length)),
      kv('Audio items', String(state.audio.length)),
      kv('Overlays', String(state.overlays.length)),
      kv('Stickers', String(state.stickers.length))),
    state.clips.length ? section('Sound', h('div', { class: 'btn-row' },
      h('button', { class: 'btn', title: 'Measures each clip and sets its volume so they all sound equally loud', onClick: evenOutLoudness }, 'Even out loudness'))) : null,
    section('Shortcuts',
      h('p', { class: 'hint' }, 'Click a key to change it, then press the new one.'),
      h('div', { class: 'keys' },
        ...KEY_ACTIONS.flatMap(([id, label]) => [
          h('button', {
            class: `kbd-btn${rebinding === id ? ' listening' : ''}`, title: 'Change this key',
            onClick: () => { rebinding = id; renderInspector(); },
          }, rebinding === id ? 'Press a key…' : prettyKey(bindingOf(id))),
          h('span', {}, label)]),
        ...fixed.flatMap(([k, d]) => [h('kbd', {}, k), h('span', {}, d)])),
      Object.keys(keyBindings).length ? h('div', { class: 'btn-row' }, h('button', {
        class: 'btn small', onClick: () => { keyBindings = {}; saveBindings(); renderInspector(); toast('Shortcuts are back to normal'); },
      }, 'Reset shortcuts')) : null),
    aboutSection()
  );
}

// ---------- media panel

function renderMedia() {
  const list = $('#mediaList');
  list.textContent = '';
  if (!state.media.length) {
    list.append(h('div', { class: 'media-empty' }, 'Import videos, photos and music to start. You can also drop files here.'));
    return;
  }
  const q = $('#mediaSearch').value.trim().toLowerCase();
  const type = $('#mediaType').value;
  const sort = $('#mediaSort').value;
  const used = usedMediaIds();
  const shown = state.media
    .filter((m) => (type === 'all' || m.kind === type) && (!q || m.name.toLowerCase().includes(q)))
    .sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })
      : sort === 'length' ? (a, b) => (isImage(a) ? 0 : a.duration) - (isImage(b) ? 0 : b.duration)
        : sort === 'type' ? (a, b) => a.kind.localeCompare(b.kind) : () => 0);
  if (!shown.length) list.append(h('div', { class: 'media-empty' }, 'Nothing matches. Clear the search to see everything.'));
  for (const m of shown) {
    list.append(h('div', { class: `media-card${m.kind === 'audio' ? ' audio' : ''}${used.has(m.id) ? '' : ' unused'}`, 'data-id': m.id, title: `${m.name} (double-click to add, right-click for more)`, onDblclick: () => addToTimeline(m.id) },
      m.thumb ? h('img', { src: m.thumb, alt: '' }) : h('div', { class: 'thumb-blank' }),
      h('button', {
        class: 'add', title: 'Add to timeline', 'aria-label': `Add ${m.name} to timeline`,
        onClick: (e) => { e.stopPropagation(); addToTimeline(m.id); },
      }, '+'),
      m.kind === 'audio' ? null : h('button', {
        class: 'add-ov', title: 'Layer on top of the main video, at the playhead', 'aria-label': `Add ${m.name} as an overlay`,
        onClick: (e) => { e.stopPropagation(); addToTimeline(m.id, true); },
      }, 'Overlay'),
      m.proxyState
        ? h('span', { class: 'badge', id: `badge-${m.id}` }, m.proxyState === 'making' ? `Preview copy ${Math.round((m.proxyProgress || 0) * 100)}%` : 'Preview copy waiting')
        : m.proxyUrl ? h('span', { class: 'badge done', title: 'The preview uses a light copy of this video. Export uses the original.' }, 'Preview copy') : null,
      h('div', { class: 'meta' }, h('div', { class: 'name' }, m.name), h('div', { class: 'dur' }, isImage(m) ? 'Photo' : fmt(m.duration)))));
  }
}

function usedMediaIds() {
  const ids = new Set();
  for (const x of [...state.clips, ...state.audio, ...state.overlays]) {
    ids.add(x.mediaId);
    if (x.originalMediaId) ids.add(x.originalMediaId);
  }
  return ids;
}

function removeUnusedMedia() {
  const used = usedMediaIds();
  const n = state.media.filter((m) => !used.has(m.id)).length;
  if (!n) { toast('Everything in the media panel is in use'); return; }
  state.media = state.media.filter((m) => used.has(m.id));
  markDirty();
  renderMedia();
  toast(`Removed ${n} unused item${n === 1 ? '' : 's'} from the panel. Your files are untouched.`);
}

$('#mediaSearch').addEventListener('input', renderMedia);
$('#mediaType').addEventListener('change', renderMedia);
$('#mediaSort').addEventListener('change', renderMedia);
$('#mediaUnused').addEventListener('click', removeUnusedMedia);

// ---------- small shared helpers for the new windows

// Fills a .seg group with choices; onPick(value) runs when one is clicked.
function fillSeg(el, options, value, onPick) {
  el.textContent = '';
  for (const [v, label] of options) {
    el.append(h('button', {
      type: 'button', 'aria-pressed': String(v === value),
      onClick: () => { el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false')); el.querySelectorAll('button')[options.findIndex((o) => o[0] === v)].setAttribute('aria-pressed', 'true'); onPick(v); },
    }, label));
  }
}

// A progress window for longer jobs (auto reframe). Returns update(msg, progress) and close().
function jobWindow(title, onCancel) {
  $('#jobTitle').textContent = title;
  $('#jobMsg').textContent = '';
  $('#jobBar').style.width = '0%';
  $('#jobCancel').onclick = onCancel;
  $('#jobCancel').disabled = false;
  $('#jobModal').hidden = false;
  return {
    update: (msg, p) => { if (msg != null) $('#jobMsg').textContent = msg; if (p != null) $('#jobBar').style.width = `${Math.round(p * 100)}%`; },
    close: () => { $('#jobModal').hidden = true; },
  };
}

let suggestTimer = null;
function suggest(msg, action, run) {
  $('#suggestMsg').textContent = msg;
  $('#suggestGo').textContent = action;
  $('#suggestGo').onclick = () => { $('#suggestBar').hidden = true; run(); };
  $('#suggestNo').onclick = () => { $('#suggestBar').hidden = true; };
  $('#suggestBar').hidden = false;
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(() => { $('#suggestBar').hidden = true; }, 20000);
}

// ---------- smart tools menu

function openSmart() {
  const menu = $('#smartMenu');
  updateSmartMenu();
  const anchor = $('#smartBtn').getBoundingClientRect();
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${clamp(anchor.left, 8, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${clamp(anchor.top - r.height - 8, 8, window.innerHeight - r.height - 8)}px`;
  menu.querySelector('button:not(:disabled)')?.focus();
}
const closeSmart = () => { $('#smartMenu').hidden = true; };
function updateSmartMenu() {
  const has = state.clips.length > 0;
  $('#captionsBtn').disabled = !has;
  $('#vtplBtn').disabled = !state.media.some((m) => m.kind !== 'audio');
  $('#autoBtn').disabled = !state.media.some((m) => m.kind === 'video');
  $('#pausesBtn').disabled = !pauseCandidates('all').length;
  $('#translateBtn').disabled = !state.texts.length;
  $('#reframeBtn').disabled = !has;
  $('#shortsBtn').disabled = !state.media.some((m) => m.kind === 'video' && m.hasAudio);
  $('#zoomInsBtn').disabled = !has;
  $('#thumbBtn').disabled = !has;
}
$('#smartBtn').addEventListener('click', () => { if ($('#smartMenu').hidden) openSmart(); else closeSmart(); });
$('#smartMenu').addEventListener('click', (e) => { if (e.target.closest('.menu-row')) closeSmart(); });
document.addEventListener('pointerdown', (e) => {
  const m = $('#smartMenu');
  if (!m.hidden && !m.contains(e.target) && !e.target.closest('#smartBtn')) closeSmart();
});

// ---------- video templates and auto edit

// Each template: how many beats each shot lasts (repeating), transitions, look, effect, camera
// moves, and the words and stickers on top.
const VIDEO_TEMPLATES = [
  { id: 'quick', name: 'Quick cuts', desc: 'Fast and punchy: a cut on almost every beat, with flashes.', swatch: 'linear-gradient(135deg,#FF3B6B,#FFE14D)',
    bpm: 128, pattern: [2, 1, 1, 2, 1, 1, 1, 1], trans: [['flash', 0.18], [null, 0]], look: 'vivid', move: 'punch', titleAnim: 'pop' },
  { id: 'travel', name: 'Smooth travel', desc: 'Gentle crossfades and slow camera drift. Lovely for trips.', swatch: 'linear-gradient(135deg,#38BDF8,#F59E0B)',
    bpm: 100, pattern: [4], trans: [['cross', 0.6]], look: 'warm', move: 'drift', titleAnim: 'slide' },
  { id: 'hype', name: 'Hype', desc: 'Whips, zooms and glitches with big shouty stickers.', swatch: 'linear-gradient(135deg,#8B5CF6,#F472B6)',
    bpm: 140, pattern: [2, 2, 1, 1, 2], trans: [['whip', 0.25], ['zoom', 0.3], ['glitch', 0.25], ['spin', 0.35]], look: 'vivid', move: 'punch', titleAnim: 'pop',
    stickers: [['shout', 'YES!'], ['burst', 'WOW!'], ['shout', 'BOOM!']] },
  { id: 'memories', name: 'Memories', desc: 'Slow, warm and nostalgic, with film grain and soft fades.', swatch: 'linear-gradient(135deg,#B45309,#FDE68A)',
    bpm: 90, pattern: [4, 4, 6], trans: [['dip', 0.5], ['cross', 0.8]], look: 'vintage', fx: 'grain', move: 'drift', titleAnim: 'fade' },
  { id: 'slideshow', name: 'Photo slideshow', desc: 'For photos: each one zooms gently, with soft crossfades.', swatch: 'linear-gradient(135deg,#10B981,#A7F3D0)',
    bpm: 100, pattern: [6], trans: [['cross', 0.7]], look: 'none', move: 'kenburns', titleAnim: 'fade' },
  { id: 'vlog', name: 'Day in my life', desc: 'Clean slides between shots, a bright look, and room for chat.', swatch: 'linear-gradient(135deg,#F97316,#FDBA74)',
    bpm: 110, pattern: [4, 2, 2], trans: [['push', 0.35]], look: 'vivid', move: 'none', titleAnim: 'slide' },
];

let vtpl = { mode: 'template', style: 'quick', picks: [] };

function openTemplatesModal(mode) {
  const visual = state.media.filter((m) => m.kind !== 'audio');
  if (!visual.length) { toast('Import some videos or photos first'); return; }
  vtpl.mode = mode;
  const longOnes = visual.filter((m) => !isImage(m));
  vtpl.picks = mode === 'auto' ? longOnes.slice(0, 3).map((m) => m.id) : visual.slice(0, 12).map((m) => m.id);
  if (mode === 'auto' && !longOnes.length) { toast('Auto edit needs at least one video'); return; }
  $('#vtplTitle').textContent = mode === 'auto' ? 'Auto edit' : 'Make from a template';
  $('#vtplMediaLabel').textContent = mode === 'auto' ? 'Videos to find the best moments in' : 'Clips and photos, in order (click to add or remove)';
  $('#vtplGo').textContent = mode === 'auto' ? 'Find the best moments' : 'Make my video';
  const styles = $('#vtplStyles');
  styles.textContent = '';
  for (const t of VIDEO_TEMPLATES) {
    styles.append(h('button', { class: 'vtpl-style', 'aria-pressed': String(vtpl.style === t.id), onClick: () => { vtpl.style = t.id; openTemplatesModalRefresh(); } },
      h('span', { class: 'vtpl-swatch', style: `background:${t.swatch}` }), h('b', {}, t.name), h('small', {}, t.desc)));
  }
  const music = $('#vtplMusic');
  music.textContent = '';
  music.append(h('option', { value: '' }, 'No music (keeps a steady beat)'));
  for (const m of state.media.filter((x) => x.kind === 'audio' || (x.hasAudio && !x.hasVideo))) music.append(h('option', { value: m.id }, m.name));
  if (music.options.length > 1) music.selectedIndex = 1;
  openTemplatesModalRefresh();
  $('#vtplModal').hidden = false;
}

function openTemplatesModalRefresh() {
  $('#vtplStyles').querySelectorAll('.vtpl-style').forEach((b, i) => b.setAttribute('aria-pressed', String(VIDEO_TEMPLATES[i].id === vtpl.style)));
  const box = $('#vtplMedia');
  box.textContent = '';
  const visual = state.media.filter((m) => m.kind !== 'audio' && (vtpl.mode !== 'auto' || !isImage(m)));
  for (const m of visual) {
    const n = vtpl.picks.indexOf(m.id);
    box.append(h('button', {
      class: 'vtpl-pick', 'aria-pressed': String(n >= 0), title: m.name,
      onClick: () => { if (n >= 0) vtpl.picks.splice(n, 1); else vtpl.picks.push(m.id); openTemplatesModalRefresh(); },
    }, m.thumb ? h('img', { src: m.thumb, alt: '' }) : h('img', { alt: '' }), n >= 0 ? h('span', { class: 'vtpl-n' }, String(n + 1)) : null, h('small', {}, m.name)));
  }
  $('#vtplNote').textContent = vtpl.mode === 'auto'
    ? 'Snippy looks for the loudest and busiest moments, then cuts them together in the chosen style. Your current edit is replaced (Ctrl+Z brings it back).'
    : 'Clips are used in the order you picked them, and reused if the video needs more shots. Your current edit is replaced (Ctrl+Z brings it back).';
}

// Builds the whole edit. shots: [{ m, in, out }] already chosen, or null to spread over the picks.
// The beat of a track only needs finding once.
const beatCache = new Map();
async function cachedBeats(m) {
  if (!beatCache.has(m.path)) beatCache.set(m.path, await window.api.detectBeats(m.path, 0, m.duration));
  return beatCache.get(m.path);
}

// opts.musicFrom: where in the music to start (for a soundtrack taken from a video); opts.beats: beats
// already found; opts.muteClips: the clips' own sound off (the music is their sound); opts.outro: the
// closing words; opts.endFade: seconds of fade to black at the end.
async function buildFromTemplate(tpl, opts) {
  const { picks, musicId, maxLen, title, shots: chosen, musicFrom = 0, muteClips = false, outro = true, endFade = 0 } = opts;
  const music = musicId ? mediaById(musicId) : null;
  let beats = null;
  let bpm = tpl.bpm;
  if (music && opts.beats) {
    if (opts.beats.beats && opts.beats.beats.length > 4) { beats = opts.beats.beats; bpm = opts.beats.bpm || bpm; }
  } else if (music) {
    const fresh = !beatCache.has(music.path);
    const win = fresh ? jobWindow('Listening for the beat', () => {}) : null;
    if (fresh) $('#jobCancel').hidden = true;
    try {
      const r = await cachedBeats(music);
      if (r.beats && r.beats.length > 4) { beats = r.beats; bpm = r.bpm || bpm; }
    } catch (err) { console.warn('No beat found, using the template beat', err); }
    finally { if (win) { win.close(); $('#jobCancel').hidden = false; } }
  }
  if (beats) {
    beats = beats.filter((b) => b >= musicFrom - 1e-3);
    if (beats.length < 5) beats = null;
  }
  const first = beats ? beats[0] : musicFrom;
  const rel = beats ? beats.map((b) => b - first) : null;
  const len = maxLen || (music ? Math.max(5, music.duration - first) : 30);
  let slots = chosen ? chosen.map((s) => s.out - s.in) : templateSlots({ beats: rel, bpm, pattern: tpl.pattern, maxLen: len });
  if (!slots.length) slots = [Math.min(len, 4)];
  // Which picture each shot shows. Reused videos move on to a later part each time.
  let shots = chosen;
  if (!shots) {
    const ms = picks.map(mediaById).filter(Boolean);
    const uses = new Map();
    const totalUses = new Map();
    slots.forEach((_, i) => { const m = ms[i % ms.length]; totalUses.set(m.id, (totalUses.get(m.id) || 0) + 1); });
    shots = slots.map((d, i) => {
      const m = ms[i % ms.length];
      const k = uses.get(m.id) || 0;
      uses.set(m.id, k + 1);
      if (isImage(m)) return { m, in: 0, out: d };
      const n = totalUses.get(m.id);
      const room = Math.max(0, m.duration - d);
      const a = n > 1 ? (room * k) / (n - 1) : Math.min(room, m.duration * 0.15);
      return { m, in: a, out: Math.min(m.duration, a + d) };
    });
  }
  commit();
  // Each clip runs on by its transition overlap, so every cut still lands on the beat.
  const clips = shots.map((s, i) => {
    const c = { ...newClip(s.m), in: s.in, out: s.out };
    if (tpl.look && tpl.look !== 'none') c.look = tpl.look;
    if (tpl.fx) c.fx = tpl.fx;
    return c;
  });
  clips.forEach((c, i) => {
    if (i === 0) return;
    const [type, tl] = tpl.trans[(i - 1) % tpl.trans.length];
    if (!type) return;
    const ov = Math.min(tl, slots[i - 1] * 0.4, slots[i] * 0.4);
    c.transition = Number(ov.toFixed(3));
    c.transitionType = type;
    if (type === 'push' || type === 'whip' || type === 'wipe') c.transitionDir = i % 2 ? 'left' : 'right';
    const prev = clips[i - 1];
    if (type !== 'dip') {
      const m = mediaById(prev.mediaId);
      if (isImage(m)) prev.out += ov;
      else {
        // Near the end of the video: start a little earlier instead, so the cut stays on the beat.
        const over = Math.max(0, prev.out + ov - m.duration);
        prev.in = Math.max(0, prev.in - over);
        prev.out = Math.min(m.duration, prev.out + ov);
      }
    }
  });
  // Camera moves.
  clips.forEach((c, i) => {
    const d = slots[i];
    const pz = tpl.punchZoom || 1.18;
    if (tpl.move === 'punch') { if (i % (tpl.punchEvery || 1) === 0) c.keys = [{ t: 0, zoom: pz, posX: 0, posY: 0 }, { t: Math.min(0.35, d / 2), zoom: 1, posX: 0, posY: 0 }]; }
    else if (tpl.move === 'drift' || tpl.move === 'kenburns') {
      const zin = i % 2 === 0;
      const dz = tpl.driftZoom || 1.14;
      const z0 = zin ? 1 : dz;
      const z1 = zin ? dz : 1;
      const px = tpl.move === 'kenburns' ? (i % 3 - 1) * 0.5 : 0;
      c.keys = [{ t: 0, zoom: z0, posX: (z0 - 1) * px / 2, posY: 0 }, { t: Number(d.toFixed(3)), zoom: z1, posX: -(z1 - 1) * px / 2, posY: 0 }];
    }
  });
  state.clips = clips;
  state.overlays = [];
  state.texts = [];
  state.stickers = [];
  state.adjust = [];
  state.audio = state.audio.filter((a) => !music || a.mediaId !== music.id);
  const total = totalDuration();
  if (music) {
    const a = { ...newAudioItem(music, 0), in: first, out: Math.min(music.duration, first + total), volume: muteClips ? 1 : 0.85, fadeIn: muteClips ? 0.3 : 0, fadeOut: Math.min(2, total / 4) };
    if (beats) { a.beats = beats; a.bpm = bpm; }
    if (!muteClips && clips.some((c) => mediaById(c.mediaId).hasAudio)) { a.duck = true; a.duckTo = 0.35; }
    state.audio.push(a);
    // With music, the clips' own sound is turned down so the music leads (or off, when it's their own sound).
    for (const c of clips) c.volume = muteClips ? 0 : 0.25;
  }
  if (title && title.trim()) {
    const t = TEMPLATES.find((x) => x.id === 'title');
    const { texts } = templateItems(t, 0);
    texts[0].text = title.trim();
    texts[0].anim = tpl.titleAnim;
    texts[0].dur = Math.min(3, slots[0] + (slots[1] || 0));
    state.texts.push(texts[0]);
  }
  // Fun stickers on a few of the beats (for the shouty templates).
  if (tpl.stickers) {
    let t = 0;
    slots.forEach((d, i) => {
      if (i > 0 && i % 4 === 2) {
        const [kind, text] = tpl.stickers[(i / 4 | 0) % tpl.stickers.length];
        state.stickers.push({ id: newId('s'), fun: { kind, text }, start: t, dur: Math.min(1.2, d), x: i % 8 === 2 ? 0.3 : 0.7, y: 0.32, size: 0.22, rotate: i % 8 === 2 ? -8 : 8, anim: 'pop' });
      }
      t += d;
    });
  }
  if (endFade > 0) clips[clips.length - 1].endFade = endFade;
  // A closing line at the end.
  const endT = Math.max(0, total - Math.min(2, total / 3));
  if (outro) state.texts.push({ ...T_TEXT, id: newId('t'), text: tpl.id === 'memories' ? 'Until next time' : 'THANKS FOR WATCHING', size: 7, caps: tpl.id !== 'memories', anim: tpl.titleAnim, start: endT, dur: total - endT });
  overlayKey = null;
  selection = [];
  state.selected = null;
  seek(0);
  renderAll();
  refreshPreview();
  return { shots: clips.length, total };
}

async function vtplGo() {
  const tpl = VIDEO_TEMPLATES.find((t) => t.id === vtpl.style);
  const picks = vtpl.picks.slice();
  if (!picks.length) { toast('Pick at least one clip or photo'); return; }
  const musicId = $('#vtplMusic').value || null;
  const maxLen = Number($('#vtplLen').value) || 0;
  const title = $('#vtplText').value;
  $('#vtplModal').hidden = true;
  if (vtpl.mode !== 'auto') {
    const r = await buildFromTemplate(tpl, { picks, musicId, maxLen, title });
    toast(`Made a ${fmt(r.total)} video from ${r.shots} shots. Swap clips or words as you like, and Ctrl+Z undoes it.`);
    return;
  }
  // Auto edit: score every half-second, then pick the best moments for the template's shots.
  const win = jobWindow('Auto edit', () => { autoCancelled = true; });
  autoCancelled = false;
  let index = 0;
  const off = window.api.onHighlightsProgress((p) => win.update(`Watching video ${index + 1} of ${picks.length}.`, (index + p.progress) / picks.length));
  const sources = [];
  try {
    for (index = 0; index < picks.length; index++) {
      if (autoCancelled) return;
      const m = mediaById(picks[index]);
      const r = await window.api.analyzeHighlights(m.path, m.duration, m.hasAudio, m.id);
      sources.push({ id: m.id, step: r.step, score: livelyScore(r.loud, r.motion) });
    }
  } catch (err) {
    toast(`Auto edit couldn't watch the video: ${cleanError(err)}`);
    return;
  } finally { off(); win.close(); }
  if (autoCancelled) return;
  const music = musicId ? mediaById(musicId) : null;
  const len = maxLen || (music ? music.duration : 30);
  const footage = picks.reduce((s, id) => s + mediaById(id).duration, 0);
  // Shot lengths on an even beat first; the real beat refines them when the edit is built.
  const lens = templateSlots({ beats: null, bpm: tpl.bpm, pattern: tpl.pattern, maxLen: Math.min(len, footage * 0.6) });
  const picked = pickHighlights(sources, lens, 1);
  if (!picked.length) { toast('Those videos are too short for that length. Try a shorter one.'); return; }
  const shots = picked.map((p) => ({ m: mediaById(p.id), in: p.a, out: p.b }));
  const r = await buildFromTemplate(tpl, { picks, musicId, maxLen: 0, title, shots });
  toast(`Picked the ${r.shots} liveliest moments: a ${fmt(r.total)} highlight reel. Ctrl+Z undoes it.`);
}
let autoCancelled = false;

$('#vtplBtn').addEventListener('click', () => openTemplatesModal('template'));
$('#autoBtn').addEventListener('click', () => openTemplatesModal('auto'));
$('#vtplGo').addEventListener('click', vtplGo);
$('#vtplCancel').addEventListener('click', () => { $('#vtplModal').hidden = true; });

// ---------- translate captions

let trMode = 'replace';
let trBusy = false;
async function openTranslate() {
  const caps = state.texts.filter((x) => x.text.trim());
  if (!caps.length) { toast('Add captions first (Smart tools, Auto captions)'); return; }
  const sel = $('#trLang');
  if (!sel.childElementCount) {
    const langs = await window.api.translateLangs();
    for (const [code, name] of Object.entries(langs)) sel.append(h('option', { value: code }, name));
    try { const last = localStorage.getItem('snippy.trLang'); if (last && langs[last]) sel.value = last; } catch { /* first one */ }
  }
  fillSeg($('#trMode'), [['replace', 'Replace the captions'], ['add', 'Add them above, as a second set']], trMode, (v) => { trMode = v; });
  $('#trWork').hidden = true;
  $('#trModal').hidden = false;
}

async function translateGo() {
  if (trBusy) return;
  const lang = $('#trLang').value;
  try { localStorage.setItem('snippy.trLang', lang); } catch { /* fine */ }
  const caps = state.texts.filter((x) => x.text.trim());
  trBusy = true;
  $('#trWork').hidden = false;
  $('#trGo').disabled = true;
  $('#trCancel').textContent = 'Stop';
  const off = window.api.onTranslateProgress((p) => {
    const name = $('#trLang').selectedOptions[0].textContent;
    if (p.phase === 'loading') $('#trMsg').textContent = `Getting the ${name} translator ready.`;
    else if (p.phase === 'download') { $('#trMsg').textContent = `Downloading the ${name} translator (first time only). ${Math.round(p.progress * 100)}%`; $('#trBar').style.width = `${Math.round(p.progress * 100)}%`; }
    else if (p.phase === 'translate') { $('#trMsg').textContent = `Translating. ${Math.round(p.progress * 100)}%`; $('#trBar').style.width = `${Math.round(p.progress * 100)}%`; }
  });
  let out = null;
  try {
    out = await window.api.translateTexts(caps.map((x) => x.text), lang);
  } catch (err) {
    if (!/cancelled/.test(String(err && err.message))) toast(cleanError(err));
  } finally {
    off();
    trBusy = false;
    $('#trGo').disabled = false;
    $('#trCancel').textContent = 'Cancel';
  }
  if (!out) return;
  commit();
  caps.forEach((x, i) => {
    if (!out[i]) return;
    if (trMode === 'replace') { x.text = out[i]; delete x.words; }
    else {
      const copy = { ...JSON.parse(JSON.stringify(x)), id: newId('t'), text: out[i], position: x.position === 'top' ? 'bottom' : 'top' };
      delete copy.words;
      state.texts.push(copy);
    }
  });
  $('#trModal').hidden = true;
  overlayKey = null;
  renderAll();
  updateOverlay();
  toast(`Translated ${caps.length} caption${caps.length === 1 ? '' : 's'} into ${$('#trLang').selectedOptions[0].textContent}`);
}
$('#translateBtn').addEventListener('click', openTranslate);
$('#trGo').addEventListener('click', translateGo);
$('#trCancel').addEventListener('click', () => { if (trBusy) window.api.cancelTranslate(); else $('#trModal').hidden = true; });

// ---------- remove pauses

const pz = { which: 'all', len: 0.5, sens: 'normal', plan: null, busy: false };

// Clips that can have their pauses cut: videos with sound, played forwards.
function pauseCandidates(which) {
  return state.clips.filter((c) => {
    const m = mediaById(c.mediaId);
    if (!m || isImage(m) || !m.hasAudio || c.mode || c.ramp) return false;
    return which === 'all' || (state.selected && state.selected.kind === 'clip' && state.selected.id === c.id);
  });
}

function openPauses() {
  if (!pauseCandidates('all').length) { toast('Add a video with sound first'); return; }
  const selClip = state.selected && state.selected.kind === 'clip' && pauseCandidates('selected').length;
  pz.which = selClip ? 'selected' : 'all';
  pz.plan = null;
  const reset = () => { pz.plan = null; $('#pzResult').hidden = true; $('#pzGo').textContent = 'Find pauses'; };
  fillSeg($('#pzWhich'), [['selected', 'Selected clip'], ['all', 'All clips']], pz.which, (v) => { pz.which = v; reset(); });
  $('#pzWhich').querySelector('button').disabled = !selClip;
  fillSeg($('#pzLen'), [[0.3, 'Short (0.3 s)'], [0.5, 'Medium (0.5 s)'], [1, 'Long (1 s)']], pz.len, (v) => { pz.len = v; reset(); });
  fillSeg($('#pzSens'), [['gentle', 'Only near silence'], ['normal', 'Normal'], ['strict', 'Also soft sounds']], pz.sens, (v) => { pz.sens = v; reset(); });
  reset();
  $('#pausesModal').hidden = false;
  $('#pzGo').focus();
}

async function findPausePlan() {
  const plan = [];
  for (const c of pauseCandidates(pz.which)) {
    const m = mediaById(c.mediaId);
    const sil = await window.api.findSilences(m.path, c.in, c.out, { minPause: pz.len, sensitivity: pz.sens });
    const keep = keptRanges(c.in, c.out, sil, { pad: 0.12, minKeep: 0.2 });
    const kept = keep.reduce((s, k) => s + k.e - k.s, 0);
    const removed = (c.out - c.in - kept) / spd(c);
    if (!keep.length || removed < 0.05) continue; // nothing to cut, or nothing but silence (left alone)
    const gaps = keep.length - 1 + (keep[0].s > c.in + 1e-3 ? 1 : 0) + (keep[keep.length - 1].e < c.out - 1e-3 ? 1 : 0);
    plan.push({ id: c.id, keep, removed, gaps });
  }
  return plan;
}

async function pausesGo() {
  if (pz.busy) return;
  if (pz.plan) { applyPausePlan(pz.plan); $('#pausesModal').hidden = true; return; }
  pz.busy = true;
  $('#pzGo').disabled = true;
  $('#pzGo').textContent = 'Listening…';
  try {
    pz.plan = await findPausePlan();
  } catch (err) {
    toast(`Couldn't check for pauses: ${cleanError(err)}`);
    $('#pzGo').textContent = 'Find pauses';
    return;
  } finally {
    pz.busy = false;
    $('#pzGo').disabled = false;
  }
  const gaps = pz.plan.reduce((s, p) => s + p.gaps, 0);
  const cut = pz.plan.reduce((s, p) => s + p.removed, 0);
  const out = $('#pzResult');
  out.hidden = false;
  if (!gaps) {
    out.textContent = 'No pauses that long were found. Try a shorter pause length.';
    $('#pzGo').textContent = 'Find pauses';
    pz.plan = null;
    return;
  }
  const before = totalDuration();
  out.textContent = `Found ${gaps} pause${gaps === 1 ? '' : 's'}, ${cut.toFixed(1)} seconds in all. Your video goes from ${fmt(before)} to about ${fmt(Math.max(0, before - cut))}.`;
  $('#pzGo').textContent = `Cut ${gaps} pause${gaps === 1 ? '' : 's'}`;
}

function applyPausePlan(plan) {
  commit();
  const starts = clipStarts();
  const removed = [];
  const out = [];
  let gaps = 0;
  let cut = 0;
  state.clips.forEach((c, i) => {
    const p = plan.find((x) => x.id === c.id);
    if (!p) { out.push(c); return; }
    gaps += p.gaps;
    cut += p.removed;
    const sp = spd(c);
    const at = (src) => starts[i] + (src - c.in) / sp; // source time → timeline time
    let t = c.in;
    for (const k of p.keep) {
      if (k.s > t + 1e-6) removed.push({ a: at(t), b: at(k.s) });
      t = k.e;
    }
    if (c.out > t + 1e-6) removed.push({ a: at(t), b: at(c.out) });
    p.keep.forEach((k, j) => {
      const piece = JSON.parse(JSON.stringify(c));
      piece.id = j === 0 ? c.id : newId('c');
      piece.in = k.s;
      piece.out = k.e;
      if (j > 0) { delete piece.transition; delete piece.transitionType; delete piece.transitionDir; }
      if (j < p.keep.length - 1) delete piece.endFade;
      // Keyframes are timed from the clip's start, so each piece shifts them by its own offset.
      if (c.keys) piece.keys = c.keys.map((kf) => ({ ...kf, t: kf.t - (k.s - c.in) / sp }));
      out.push(piece);
    });
  });
  removed.sort((x, y) => x.a - y.a);
  state.clips = out;
  // Everything else on the timeline moves up to stay in step with the picture.
  const R = (t) => rippleTime(t, removed);
  for (const x of [...state.texts, ...state.stickers]) {
    const a = R(x.start);
    const e = R(x.start + x.dur);
    if (x.words) x.words = x.words.map((w) => ({ ...w, s: R(x.start + w.s) - a, ...(w.e != null ? { e: R(x.start + w.e) - a } : {}) }));
    x.start = a;
    x.dur = e - a;
  }
  state.texts = state.texts.filter((x) => x.dur >= 0.15);
  state.stickers = state.stickers.filter((x) => x.dur >= 0.15);
  for (const x of [...state.audio, ...state.overlays]) x.start = R(x.start);
  overlayKey = null;
  renderAll();
  refreshPreview();
  seek(Math.min(R(state.playhead), totalDuration()));
  toast(`Removed ${gaps} pause${gaps === 1 ? '' : 's'} (${cut.toFixed(1)} s). Press Ctrl+Z to undo.`);
}

$('#pausesBtn').addEventListener('click', openPauses);
$('#pzGo').addEventListener('click', pausesGo);
$('#pzCancel').addEventListener('click', () => { if (!pz.busy) $('#pausesModal').hidden = true; });

// ---------- auto reframe

const canvasAspect = () => { const [w, hh] = ASPECTS[state.aspect]; return w / hh; };

// Videos whose shape differs from the canvas, so they could be reframed.
function reframeCandidates(only) {
  return state.clips.filter((c) => {
    const m = mediaById(c.mediaId);
    if (!m || isImage(m) || c.mode || !m.width || !m.height) return false;
    if (only && c.id !== only) return false;
    return fillFor(m.width / m.height, canvasAspect()).axis != null;
  });
}

let reframeCancelled = false;
async function autoReframe(clips) {
  if (!clips.length) {
    toast(state.clips.length ? 'Your clips already fit this canvas shape. Change the canvas (top right) first.' : 'Add a video first');
    return;
  }
  pause();
  reframeCancelled = false;
  const win = jobWindow('Auto reframe', () => { reframeCancelled = true; $('#jobCancel').disabled = true; window.api.cancelReframe(); });
  let index = 0;
  const off = window.api.onReframeProgress((p) => {
    if (p.phase === 'loading') win.update('Getting the person finder ready.', 0);
    else if (p.phase === 'download') win.update(`Downloading the person finder (about 25 MB, first time only). ${Math.round(p.progress * 100)}%`, p.progress);
    else if (p.phase === 'track') win.update(`Following the person in clip ${index + 1} of ${clips.length}.`, (index + p.progress) / clips.length);
  });
  let done = 0;
  try {
    for (index = 0; index < clips.length; index++) {
      const c = clips[index];
      const m = mediaById(c.mediaId);
      win.update(`Following the person in clip ${index + 1} of ${clips.length}.`, index / clips.length);
      const samples = await window.api.trackSubject(m.path, c.in, c.out, m.width, m.height, c.id);
      if (reframeCancelled) break;
      trackCache.set(trackKey(c, m), samples); // the export queue can reuse these
      const plan = planReframe(samples, { srcAspect: m.width / m.height, canvasAspect: canvasAspect(), in: c.in, speed: spd(c), length: clipLen(c) });
      if (!plan) continue;
      if (!done) commit();
      Object.assign(c, { zoom: plan.zoom, posX: 0, posY: 0, keys: plan.keys });
      migrateMotion(c);
      done++;
    }
  } catch (err) {
    if (!/cancelled/.test(String(err && err.message))) toast(`Auto reframe stopped: ${cleanError(err)}`);
  } finally {
    off();
    win.close();
  }
  if (done) {
    renderAll();
    refreshPreview();
    updateFx();
    toast(`Reframed ${done} clip${done === 1 ? '' : 's'} to follow the action. Tweak it with the zoom and pan keyframes.`);
  }
}

$('#reframeBtn').addEventListener('click', () => {
  const sel = state.selected && state.selected.kind === 'clip' ? reframeCandidates(state.selected.id) : [];
  autoReframe(sel.length ? sel : reframeCandidates());
});

// After the canvas changes shape, offer to reframe clips that no longer fit.
function offerReframe() {
  const n = reframeCandidates().length;
  if (!n) { $('#suggestBar').hidden = true; return; }
  suggest(`${n} clip${n === 1 ? ' is' : 's are'} a different shape from the canvas now. Keep people in shot?`, 'Auto reframe', () => autoReframe(reframeCandidates()));
}

// ---------- voiceovers

let voVoices = null;
const vo = { speed: 1, busy: false, player: new Audio() };

async function openVoiceover() {
  if (!state.clips.length) { toast('Add a video first, then put a voiceover on it'); return; }
  if (!voVoices) {
    try { voVoices = await window.api.ttsVoices(); } catch { voVoices = []; }
    const sel = $('#voVoice');
    for (const v of voVoices) sel.append(h('option', { value: v.id }, `${v.name}, ${v.desc}`));
    try { const last = localStorage.getItem('snippy.voice'); if (last && voVoices.some((v) => v.id === last)) sel.value = last; } catch { /* first choice */ }
  }
  fillSeg($('#voSpeed'), [[0.85, 'Slower'], [1, 'Normal'], [1.15, 'Faster']], vo.speed, (v) => { vo.speed = v; });
  voWorking(false);
  $('#voModal').hidden = false;
  $('#voText').focus();
}

function voWorking(on, msg) {
  vo.busy = on;
  $('#voWork').hidden = !on;
  if (msg) $('#voMsg').textContent = msg;
  for (const id of ['#voGo', '#voSample', '#voText', '#voVoice']) $(id).disabled = on;
  $('#voCancel').textContent = on ? 'Stop' : 'Cancel';
  if (!on) $('#voBar').style.width = '0%';
}

async function makeVoiceover(preview) {
  if (vo.busy) return;
  const voice = $('#voVoice').value;
  const script = $('#voText').value.trim();
  const first = (script.match(/[^.!?…]+[.!?…]*/) || [''])[0].trim();
  const text = preview ? (first || 'Hi! This is how I sound in Snippy.') : script;
  if (!text) { toast('Type what the voice should say first'); $('#voText').focus(); return; }
  try { localStorage.setItem('snippy.voice', voice); } catch { /* not remembered */ }
  vo.player.pause();
  voWorking(true, 'Getting the voice ready.');
  const off = window.api.onVoiceoverProgress((p) => {
    if (p.phase === 'loading') $('#voMsg').textContent = 'Getting the voice ready.';
    else if (p.phase === 'download') { $('#voMsg').textContent = `Downloading the voice (about 90 MB, first time only). ${Math.round(p.progress * 100)}%`; $('#voBar').style.width = `${Math.round(p.progress * 100)}%`; }
    else if (p.phase === 'speak') { $('#voMsg').textContent = preview ? 'Speaking a sample.' : `Speaking. ${Math.round(p.progress * 100)}%`; $('#voBar').style.width = `${Math.round(p.progress * 100)}%`; }
  });
  let res;
  try {
    res = await window.api.makeVoiceover(text, voice, vo.speed, { preview, maxWords: 5 });
  } catch (err) {
    if (!/cancelled/.test(String(err && err.message))) toast(`Couldn't make the voiceover: ${cleanError(err)}`);
    return;
  } finally {
    off();
    voWorking(false);
  }
  if (preview) {
    vo.player.src = `${res.url}?v=${Date.now()}`;
    vo.player.play().catch(() => {});
    return;
  }
  let info;
  try { info = await window.api.probe(res.path); } catch (err) { toast(`Couldn't read the voiceover: ${cleanError(err)}`); return; }
  const m = { ...info, id: newId('m') };
  state.media.push(m);
  loadLevels(m);
  commit();
  const at = Math.min(state.playhead, Math.max(0, totalDuration() - MIN_LEN));
  const item = { ...newAudioItem(m, at), volume: 1 };
  state.audio.push(item);
  if ($('#voCaps').checked && res.captions.length) {
    const earlier = state.texts.find((x) => x.auto);
    const style = earlier
      ? copyStyle(earlier)
      : { size: 6, position: 'bottom', color: '#FFFFFF', anim: 'pop', highlight: true, hlColor: '#FFD84D', box: false, caps: true };
    for (const c of res.captions) {
      state.texts.push({ id: newId('t'), text: c.text, start: at + c.start, dur: Math.max(MIN_LEN, c.end - c.start), ...style, auto: true });
    }
  }
  $('#voModal').hidden = true;
  overlayKey = null;
  renderAll();
  select('audio', item.id);
  toast(`Added a ${res.duration.toFixed(1)} second voiceover at the playhead${$('#voCaps').checked ? ', with captions' : ''}`);
}

$('#voBtn').addEventListener('click', openVoiceover);
$('#voGo').addEventListener('click', () => makeVoiceover(false));
$('#voSample').addEventListener('click', () => makeVoiceover(true));
$('#voCancel').addEventListener('click', () => {
  if (vo.busy) { window.api.cancelVoiceover(); return; }
  vo.player.pause();
  $('#voModal').hidden = true;
});

// ---------- home screen

const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} minutes ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const d = Math.round(hrs / 24);
  if (d < 14) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(ms).toLocaleDateString();
};

async function showHome() {
  closeSmart();
  pause();
  let list = [];
  try { list = await window.api.recentProjects(); } catch { /* none */ }
  const box = $('#homeRecent');
  box.textContent = '';
  if (!list.length) box.append(h('p', { class: 'muted home-empty' }, 'Projects you save or open show up here.'));
  for (const r of list) {
    const shape = r.aspect === '9:16' ? 'tall' : r.aspect === '1:1' ? 'square' : 'wide';
    box.append(h('div', { class: `recent-card${r.exists ? '' : ' missing'}` },
      h('button', {
        class: 'recent-open', title: r.exists ? r.path : `Not found: ${r.path}`,
        onClick: () => (r.exists ? openRecent(r.path) : toast("That project file has moved or been deleted. Use Open project… to find it.")),
      },
      h('div', { class: `recent-thumb ${shape}` }, r.thumb ? h('img', { src: r.thumb, alt: '' }) : null),
      h('div', { class: 'recent-name' }, r.name || 'Untitled'),
      h('div', { class: 'recent-meta' }, r.exists ? `${r.duration ? `${fmt(r.duration)} · ` : ''}${ago(r.openedAt)}` : 'File not found')),
      h('button', {
        class: 'recent-x', title: 'Remove from this list (the file is kept)', 'aria-label': `Remove ${r.name} from recent projects`,
        onClick: async () => { await window.api.removeRecent(r.path); showHome(); },
      }, '×')));
  }
  $('#homeBack').hidden = !(state.clips.length || state.media.length);
  $('#home').hidden = false;
}

function hideHome(skipTour = false) {
  $('#home').hidden = true;
  if (!skipTour) maybeShowTour();
}

// ---------- AutoCut from the home screen: a new project, your clips in, AutoCut open.

let homeAcShape = (() => { try { return localStorage.getItem('snippy.homeAcShape') || 'auto'; } catch { return 'auto'; } })();
function paintHomeAcShape() {
  document.querySelectorAll('.ac-shape').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.aspect === homeAcShape)));
}
document.querySelectorAll('.ac-shape').forEach((b) => b.addEventListener('click', () => {
  homeAcShape = b.dataset.aspect;
  try { localStorage.setItem('snippy.homeAcShape', homeAcShape); } catch { /* not kept */ }
  paintHomeAcShape();
}));
paintHomeAcShape();

// Portrait, landscape or square: whichever most of the clips are.
function shapeOfClips() {
  const votes = { '9:16': 0, '16:9': 0, '1:1': 0 };
  for (const m of state.media) {
    if (m.kind === 'audio' || !m.width || !m.height) continue;
    const r = m.width / m.height;
    const weight = isImage(m) ? 1 : Math.max(1, m.duration || 1);
    votes[r < 0.9 ? '9:16' : r > 1.1 ? '16:9' : '1:1'] += weight;
  }
  return Object.entries(votes).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0] : '9:16';
}

async function homeAutoCut(paths) {
  if (!confirmDiscard()) return;
  if (!paths) {
    try { paths = await window.api.pickFiles(); } catch { paths = null; }
  }
  if (!paths || !paths.length) return;
  dirty = false;
  newProject();
  setAspect(homeAcShape === 'auto' ? '9:16' : homeAcShape);
  hideHome(true);
  await importPaths(paths);
  if (!state.media.some((m) => m.kind !== 'audio')) { toast('Those files couldn\'t be used. Pick some videos or photos.'); return; }
  if (homeAcShape === 'auto') setAspect(shapeOfClips());
  openAutoCut();
}

$('#homeAcGo').addEventListener('click', () => homeAutoCut());
const homeAc = $('#homeAc');
homeAc.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); homeAc.classList.add('drop'); });
homeAc.addEventListener('dragleave', () => homeAc.classList.remove('drop'));
homeAc.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  homeAc.classList.remove('drop');
  document.body.classList.remove('dragging-files');
  const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
  if (paths.length) homeAutoCut(paths);
});

async function openRecent(p) {
  if (!confirmDiscard()) return;
  let file;
  try { file = await window.api.openProjectPath(p); } catch { toast("That project couldn't be opened"); return; }
  if (await openProject(file)) hideHome();
}

function startNew(aspect) {
  if (!confirmDiscard()) return;
  dirty = false;
  newProject();
  setAspect(aspect);
  hideHome();
}

function rememberRecent() {
  if (!projectPath) return;
  const first = state.clips[0] && mediaById(state.clips[0].mediaId);
  window.api.addRecent({ path: projectPath, name: projectName(), thumb: first && first.thumb && first.kind !== 'audio' ? first.thumb : null, aspect: state.aspect, duration: totalDuration() }).catch(() => {});
}

$('#homeBtn').addEventListener('click', showHome);
$('#homeBack').addEventListener('click', hideHome);
$('#homeOpen').addEventListener('click', async () => { if (await openProject()) hideHome(); });
document.querySelectorAll('.new-card').forEach((b) => b.addEventListener('click', () => startNew(b.dataset.aspect)));

// ---------- export presets

const EXPORT_PRESETS = [
  { id: 'tiktok', name: 'TikTok', aspect: '9:16', format: 'mp4', res: 1080, fps: 30, crf: 20, loud: true, safe: 'tiktok', note: 'Portrait 1080×1920, 30 fps, loudness set for phones.' },
  { id: 'reels', name: 'Instagram Reels', aspect: '9:16', format: 'mp4', res: 1080, fps: 30, crf: 20, loud: true, safe: 'reels', note: 'Portrait 1080×1920, 30 fps, loudness set for phones.' },
  { id: 'shorts', name: 'YouTube Shorts', aspect: '9:16', format: 'mp4', res: 1080, fps: 30, crf: 20, loud: true, safe: 'shorts', note: 'Portrait 1080×1920, up to 3 minutes long.' },
  { id: 'youtube', name: 'YouTube', aspect: '16:9', format: 'mp4', res: 1080, fps: 30, crf: 16, loud: true, note: 'Landscape 1920×1080 at high quality.' },
  { id: 'instagram', name: 'Instagram post', aspect: '1:1', format: 'mp4', res: 1080, fps: 30, crf: 20, loud: true, note: 'Square 1080×1080 for the feed.' },
  { id: 'whatsapp', name: 'WhatsApp', format: 'mp4', res: 720, fps: 30, crf: 26, loud: true, maxMB: 15, safe: 'whatsapp', note: 'A small 720p file (aiming for under 15 MB) that sends quickly, in any shape.' },
  { id: 'gif', name: 'GIF', format: 'gif', gif: 480 },
  { id: 'custom', name: 'Custom' },
];
let exFormat = 'mp4';
let exPreset = 'custom';

function setExFormat(f) {
  exFormat = f;
  fillSeg($('#exFormat'), [['mp4', 'MP4 video'], ['gif', 'Animated GIF']], f, (v) => { setExFormat(v); exPreset = v === 'gif' ? 'gif' : 'custom'; drawPresets(); updateExportSummary(); });
  document.querySelectorAll('#exportSettings .mp4-only').forEach((el) => { el.hidden = f === 'gif'; });
  document.querySelectorAll('#exportSettings .gif-only').forEach((el) => { el.hidden = f !== 'gif'; });
  if ($('#exExtra').childElementCount) updateGoLabel();
  $('#exsTitle').textContent = f === 'gif' ? 'Export GIF' : 'Export video';
}

function drawPresets() {
  const row = $('#exPresets');
  row.textContent = '';
  for (const p of EXPORT_PRESETS) {
    row.append(h('button', {
      type: 'button', class: 'preset-chip', 'aria-pressed': String(p.id === exPreset),
      onClick: () => applyPreset(p.id),
    }, p.name));
  }
  const p = EXPORT_PRESETS.find((x) => x.id === exPreset);
  let note = $('#exPresetNote');
  if (!note) { note = h('p', { id: 'exPresetNote', class: 'hint preset-note' }); row.after(note); }
  note.textContent = '';
  if (p && p.note) {
    note.append(p.note);
    if (p.safe) {
      note.append(' ', h('button', { type: 'button', class: 'linkish', onClick: () => { setSafeZone(p.safe); $('#exportSettings').hidden = true; } }, `See what ${SAFE_ZONES[p.safe].name} covers on screen`));
    }
  }
  note.hidden = !(p && p.note);
  const tip = $('#exShapeTip');
  if (p && p.aspect && p.aspect !== state.aspect) {
    const names = { '9:16': 'portrait 9:16', '16:9': 'landscape 16:9', '1:1': 'square 1:1' };
    tip.textContent = '';
    tip.append(
      h('span', {}, `This project is ${names[state.aspect]}. ${p.name} works best in ${names[p.aspect]}.`),
      h('button', {
        type: 'button', class: 'btn small', onClick: () => {
          setAspect(p.aspect);
          markDirty();
          drawPresets();
          updateExportSummary();
          if (reframeCandidates().length) { $('#exportSettings').hidden = true; offerReframe(); }
        },
      }, `Switch to ${p.aspect}`));
    tip.hidden = false;
  } else tip.hidden = true;
}

// The export queue: the same edit in the other canvas shapes, auto reframed, saved alongside.
function drawExtraShapes() {
  const box = $('#exExtra');
  box.textContent = '';
  const labels = { '9:16': 'Portrait 9:16 (TikTok, Reels, Shorts)', '16:9': 'Landscape 16:9 (YouTube)', '1:1': 'Square 1:1 (Instagram)' };
  for (const a of Object.keys(ASPECTS).filter((x) => x !== state.aspect)) {
    box.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', value: a, onChange: updateGoLabel }), labels[a]));
  }
  updateGoLabel();
}
function updateGoLabel() {
  const n = exFormat === 'gif' ? 0 : document.querySelectorAll('#exExtra input:checked').length;
  $('#exsGo').textContent = n ? `Choose where to save (${n + 1} videos)` : 'Choose where to save';
}

function applyPreset(id) {
  const p = EXPORT_PRESETS.find((x) => x.id === id);
  exPreset = id;
  if (p.format) setExFormat(p.format);
  if (p.res) $('#exRes').value = String(p.res);
  if (p.fps) $('#exFps').value = String(p.fps);
  if (p.crf) $('#exQuality').value = String(p.crf);
  if (p.loud != null) $('#exLoud').checked = p.loud;
  if (p.gif) $('#exGifSize').value = String(p.gif);
  drawPresets();
  updateExportSummary();
}

for (const id of ['#exRes', '#exFps', '#exQuality', '#exLoud', '#exGifSize']) {
  $(id).addEventListener('change', () => { if (exPreset !== 'gif') exPreset = 'custom'; drawPresets(); updateExportSummary(); });
}

// ---------- check-up

let checkText = '';
async function runCheckup() {
  $('#checkList').textContent = '';
  $('#checkMsg').textContent = 'Checking what works on this computer…';
  $('#checkCopy').hidden = true;
  $('#checkModal').hidden = false;
  let rows;
  try { rows = await window.api.runCheckup(); } catch (err) { $('#checkMsg').textContent = `The check-up couldn't run: ${cleanError(err)}`; return; }
  const icon = { ok: '✓', warn: '!', bad: '✕', info: 'i' };
  const bad = rows.filter((r) => r.state === 'bad').length;
  const warn = rows.filter((r) => r.state === 'warn').length;
  $('#checkMsg').textContent = bad ? `${bad} problem${bad === 1 ? '' : 's'} found. The notes say what to do.`
    : warn ? 'Snippy works here. A few extras may not, see the notes.' : 'Everything checked works on this computer.';
  let group = null;
  for (const r of rows) {
    if (r.group !== group) { group = r.group; $('#checkList').append(h('h4', { class: 'sfx-group' }, group)); }
    $('#checkList').append(h('div', { class: `check-row ${r.state}` },
      h('span', { class: 'check-ico', 'aria-label': r.state }, icon[r.state]),
      h('div', {}, h('b', {}, r.name), h('small', {}, r.note || ''))));
  }
  checkText = rows.map((r) => `[${r.state}] ${r.group} / ${r.name}: ${r.note || ''}`).join('\n');
  $('#checkCopy').hidden = false;
}
$('#checkClose').addEventListener('click', () => { $('#checkModal').hidden = true; });
$('#checkCopy').addEventListener('click', () => { navigator.clipboard.writeText(checkText).then(() => toast('Copied. Paste it to me if anything needs fixing.')).catch(() => {}); });

// ---------- welcome tour

const TOUR = [
  { el: '.media-panel', title: 'Hi, I’m Snippy! ✂️', text: 'Start here: press Import (or drop files onto the window) to bring in videos, photos and music. Press + on a file to add it to your edit.' },
  { el: '.preview-panel', title: 'Watch your edit', text: 'The preview shows exactly what you’ll export. Press Space to play, and drag captions and stickers around right on the picture.' },
  { el: '.timeline', title: 'The timeline', text: 'Clips play left to right. Drag them to reorder, drag their edges to trim, and press S to split at the playhead. Ctrl+click or drag a box to pick several things at once.' },
  { el: '.tl-toolbar', title: 'Add the fun stuff', text: 'Text, stickers, templates, sound effects and voiceovers live here. Smart tools has automatic captions, pause removal and auto reframe for portrait videos.' },
  { el: '#inspector', title: 'Fine-tune anything', text: 'Click any item and its settings appear here: speed, filters, effects, transitions, keyframes, voice changer and more.' },
  { el: '#exportBtn', title: 'Share it', text: 'When you’re happy, Export makes an MP4 up to 4K. No watermark and nothing behind a paywall. Have fun!' },
];
const TOUR_KEY = 'snippy.tourDone';
let tourStep = 0;

function startTour() {
  tourStep = 0;
  $('#tour').hidden = false;
  showTourStep();
}

function endTour() {
  $('#tour').hidden = true;
  try { localStorage.setItem(TOUR_KEY, '1'); } catch { /* fine */ }
}

function showTourStep() {
  const step = TOUR[tourStep];
  const target = document.querySelector(step.el);
  const r = target.getBoundingClientRect();
  const pad = 6;
  const hole = $('#tourHole');
  const x0 = Math.max(3, r.left - pad); const y0 = Math.max(3, r.top - pad);
  const x1 = Math.min(window.innerWidth - 3, r.right + pad); const y1 = Math.min(window.innerHeight - 3, r.bottom + pad);
  Object.assign(hole.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
  $('#tourTitle').textContent = step.title;
  $('#tourText').textContent = step.text;
  $('#tourCount').textContent = `${tourStep + 1} of ${TOUR.length}`;
  $('#tourBack').hidden = tourStep === 0;
  $('#tourNext').textContent = tourStep === TOUR.length - 1 ? 'Let’s go' : 'Next';
  // Put the card beside the highlighted area, wherever there's room.
  const card = $('#tourCard');
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const gap = 16;
  let x; let y;
  if (r.right + gap + cw < W) { x = r.right + gap; y = r.top; }
  else if (r.left - gap - cw > 0) { x = r.left - gap - cw; y = r.top; }
  else if (r.top - gap - ch > 0) { x = r.left + r.width / 2 - cw / 2; y = r.top - gap - ch; }
  else { x = r.left + r.width / 2 - cw / 2; y = r.bottom + gap; }
  card.style.left = `${clamp(x, 12, W - cw - 12)}px`;
  card.style.top = `${clamp(y, 12, H - ch - 12)}px`;
  $('#tourNext').focus();
}

$('#tourNext').addEventListener('click', () => { if (++tourStep >= TOUR.length) endTour(); else showTourStep(); });
$('#tourBack').addEventListener('click', () => { if (tourStep > 0) { tourStep--; showTourStep(); } });
$('#tourSkip').addEventListener('click', endTour);
window.addEventListener('resize', () => { if (!$('#tour').hidden) showTourStep(); });
document.addEventListener('keydown', (e) => {
  if ($('#tour').hidden) return;
  if (e.key === 'Escape') endTour();
  else if (e.key === 'ArrowRight') $('#tourNext').click();
  else if (e.key === 'ArrowLeft') $('#tourBack').click();
});

function maybeShowTour() {
  let done = false;
  try { done = Boolean(localStorage.getItem(TOUR_KEY)); } catch { done = true; }
  if (!done) setTimeout(startTour, 400);
}

// ---------- finding moved files when a project opens

const baseName = (p) => p.split(/[\\/]/).pop();

// Shows the missing files and lets the person find them. Resolves to { [ref.id]: probedInfo }.
function relinkMissing(refs) {
  return new Promise((resolve) => {
    const found = {};
    const modal = $('#relinkModal');
    const list = $('#relinkList');
    const tryPath = async (ref, p) => {
      try {
        found[ref.id] = await window.api.probe(p);
        return true;
      } catch { return false; }
    };
    const draw = () => {
      list.textContent = '';
      for (const ref of refs) {
        const ok = Boolean(found[ref.id]);
        list.append(h('li', { class: ok ? 'ok' : '' },
          h('div', { class: 'rl-name' }, baseName(ref.path), h('small', {}, ok ? found[ref.id].path : ref.path)),
          ok ? h('span', { class: 'rl-state' }, 'Found')
            : h('button', {
              class: 'btn small',
              onClick: async () => {
                const p = await window.api.relinkPick(baseName(ref.path));
                if (!p) return;
                if (!(await tryPath(ref, p))) { toast("Snippy can't open that file"); return; }
                // Others are often in the same folder: try there too.
                const dir = p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
                for (const r of refs) if (!found[r.id] && r !== ref) await tryPath(r, dir + baseName(r.path));
                draw();
              },
            }, 'Find…')));
      }
      const left = refs.filter((r) => !found[r.id]).length;
      $('#relinkDone').textContent = left ? `Open without ${left === refs.length ? 'them' : `the other ${left}`}` : 'Open project';
      $('#relinkSearch').hidden = !left;
      if (!left) $('#relinkDone').focus();
    };
    $('#relinkSearch').onclick = async () => {
      const todo = refs.filter((r) => !found[r.id]);
      const r = await window.api.relinkSearch(todo.map((x) => baseName(x.path)));
      if (!r) return;
      let n = 0;
      for (const ref of todo) {
        const p = r.found[baseName(ref.path)];
        if (p && (await tryPath(ref, p))) n++;
      }
      toast(n ? `Found ${n} of ${todo.length}` : `None of them are in ${baseName(r.folder) || r.folder}`);
      draw();
    };
    $('#relinkDone').onclick = () => { modal.hidden = true; resolve(found); };
    draw();
    modal.hidden = false;
  });
}

// ---------- export

function exportModal(mode, msg) {
  $('#exportModal').hidden = false;
  $('#exportTitle').textContent = mode === 'done' ? 'Export finished' : mode === 'error' ? 'Export failed' : 'Exporting video';
  $('#exportMsg').textContent = msg;
  $('#exportCancel').hidden = mode !== 'running';
  $('#exportClose').hidden = mode === 'running';
  $('#exportShow').hidden = mode !== 'done';
}

function setProgress(p) {
  $('#exportBar').style.width = `${Math.round(p * 100)}%`;
  if (!$('#exportCancel').hidden) $('#exportMsg').textContent = `Rendering your timeline to ${exportingWhat}. ${Math.round(p * 100)}%`;
}

let lastExportPath = null;
let exportingWhat = 'MP4';

// Output size for the chosen resolution: the short side is 720, 1080 or 2160 pixels.
function exportSize(res, aspect = state.aspect) {
  const [bw, bh] = ASPECTS[aspect];
  const k = res / Math.min(bw, bh);
  return [Math.round((bw * k) / 2) * 2, Math.round((bh * k) / 2) * 2];
}

const GIF_FPS = 15;
function readExportSettings() {
  return {
    format: exFormat, preset: exPreset, gif: Number($('#exGifSize').value),
    res: Number($('#exRes').value), fps: Number($('#exFps').value), crf: Number($('#exQuality').value), loud: $('#exLoud').checked,
    hw: $('#exHw').value,
    maxMB: (EXPORT_PRESETS.find((p) => p.id === exPreset) || {}).maxMB || 0,
  };
}

// The graphics cards this computer can encode with, as choices (checked once, in the background).
let hwListed = false;
async function listHwEncoders() {
  if (hwListed) return;
  hwListed = true;
  let cards = [];
  try { cards = (await window.api.hwEncoders()) || []; } catch { cards = []; }
  const sel = $('#exHw');
  const keep = sel.value;
  const auto = sel.querySelector('option[value="auto"]');
  auto.textContent = cards.length ? `Use the graphics card (${cards[0].name}, faster)` : 'Use the graphics card if it can (none found, so the normal encoder)';
  for (const c of cards.slice(1)) sel.insertBefore(h('option', { value: c.id }, `${c.name} (faster)`), sel.querySelector('option[value="off"]'));
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

function updateExportSummary() {
  const s = readExportSettings();
  const len = totalDuration();
  if (s.format === 'gif') {
    const [w, hgt] = exportSize(s.gif);
    $('#exSummary').textContent = `${w} × ${hgt} pixels at ${GIF_FPS} frames a second, ${fmt(len)} long. GIFs have no sound` +
      (len > 15 ? ', and they get big quickly: under 15 seconds works best.' : '.');
    return;
  }
  const [w, hgt] = exportSize(s.res);
  $('#exSummary').textContent = `${w} × ${hgt} pixels at ${s.fps} frames a second, ${fmt(len)} long.`;
}

function exportVideo() {
  if (!state.clips.length) { toast('Add a video to the timeline before exporting'); return; }
  pause();
  try {
    const saved = JSON.parse(localStorage.getItem('snippy.export') || 'null');
    if (saved) {
      $('#exRes').value = String(saved.res); $('#exFps').value = String(saved.fps); $('#exQuality').value = String(saved.crf); $('#exLoud').checked = Boolean(saved.loud);
      if (saved.hw) $('#exHw').value = saved.hw === 'off' ? 'off' : 'auto';
      if (saved.gif) $('#exGifSize').value = String(saved.gif);
      exFormat = saved.format === 'gif' ? 'gif' : 'mp4';
      exPreset = saved.preset === 'social' ? 'tiktok' : EXPORT_PRESETS.some((p) => p.id === saved.preset) ? saved.preset : 'custom';
    }
  } catch { /* use the defaults */ }
  setExFormat(exFormat);
  drawPresets();
  drawExtraShapes();
  updateExportSummary();
  listHwEncoders();
  $('#exportSettings').hidden = false;
  $('#exsGo').focus();
}

// The export project for the current state; width, height and fps come from the job.
function buildExportProject(settings, width, height) {
  const total = totalDuration();
  const fades = fadeInfo();
  return {
    width, height, fps: settings.fps, crf: settings.crf, loudnorm: settings.loud, total, format: settings.format, hw: settings.hw || 'auto',
    // A size limit (WhatsApp): a ceiling on the video's bit rate so the whole file fits.
    maxKbps: settings.maxMB ? Math.round(Math.max(400, Math.min(4000, (settings.maxMB * 8 * 1000) / Math.max(1, total) - 96))) : 0,
    audioKbps: settings.maxMB ? 96 : 192,
    cover: settings.format === 'mp4' && state.cover ? state.cover : null,
    clips: state.clips.map((c, i) => {
      const m = mediaById(c.mediaId);
      return {
        path: m.path, isImage: isImage(m), in: c.in, out: c.out, hasAudio: m.hasAudio, speed: spd(c), color: colorSteps(c), curve: c.curve || null, lut: c.lut || null, fx: c.fx || null, denoise: Boolean(c.denoise),
        touch: touchOf(c) ? { op: touchOf(c).op, bright: touchOf(c).bright, sigma: Number((touchOf(c).k * Math.min(height, (width * (m.height || 9)) / (m.width || 16))).toFixed(2)) } : null,
        mode: !isImage(m) && c.mode ? c.mode : null, ramp: !isImage(m) && rampFor(c) ? c.ramp : null, stab: !isImage(m) && c.stab ? c.stab : null, voice: c.voice && c.voice !== 'none' ? c.voice : null,
        motion: { zoom: c.zoom ?? 1, posX: c.posX || 0, posY: c.posY || 0, rotate: c.rotate || 0, flipH: Boolean(c.flipH), flipV: Boolean(c.flipV), keys: c.keys },
        crop: c.crop && (c.crop.l || c.crop.r || c.crop.t || c.crop.b) ? c.crop : null,
        volume: c.volume == null ? 1 : c.volume, fadeIn: fades[i].fin, fadeOut: fades[i].fout, crossIn: overlapOf(i),
        xStyle: c.transitionType || null, xDir: c.transitionDir || 'left', xLen: c.transition || 0,
      };
    }),
    audio: state.audio
      .filter((a) => a.start < total && (a.volume > 0 || (a.keys && a.keys.length)))
      .map((a) => {
        const m = mediaById(a.mediaId);
        return { path: m.path, in: a.in, out: a.out, start: a.start, volume: a.volume, keys: a.keys && a.keys.length ? a.keys : null, fadeIn: a.fadeIn, fadeOut: a.fadeOut, duck: duckCommands(a), voice: a.voice && a.voice !== 'none' ? a.voice : null };
      })
      // An overlay video's own sound is mixed in like any other audio.
      .concat(state.overlays
        .filter((o) => o.start < total && o.volume > 0 && mediaById(o.mediaId).hasAudio)
        .map((o) => ({ path: mediaById(o.mediaId).path, in: o.in, out: o.out, start: o.start, volume: o.volume, fadeIn: 0, fadeOut: 0 }))),
    adjust: (state.adjust || []).filter((x) => x.start < total).map((x) => ({ start: x.start, dur: Math.min(x.dur, total - x.start), color: colorSteps(x), curve: x.curve || null })),
    overlays: stacked()
      .filter((o) => o.start < total)
      .map((o) => {
        const m = mediaById(o.mediaId);
        return { path: m.path, isImage: isImage(m), vpxAlpha: m.vpxAlpha || null, in: o.in, out: o.out, start: o.start, x: o.x, y: o.y, w: o.w, opacity: o.opacity, color: colorSteps(o), curve: o.curve || null, key: o.key || null,
          keys: o.keys, ar: ovAr(o), cell: o.cell || null, blend: o.blend || null, cropX: o.cropX ?? 0.5, cropY: o.cropY ?? 0.5,
          mask: o.shape && o.shape !== 'none' ? shapeMask(o).gray : null };
      }),
    texts: [],
  };
}

// Other canvas shapes for the export queue: clips that don't fit get the auto reframe camera
// (from the person-tracking results, kept per clip), or a centred fill if tracking can't run.
const trackCache = new Map();
const trackKey = (c, m) => `${m.path}|${c.in.toFixed(3)}|${c.out.toFixed(3)}`;
async function reframeFor(aspect, onStep) {
  const [cw, ch] = ASPECTS[aspect];
  const plans = new Map();
  const need = state.clips.filter((c) => {
    const m = mediaById(c.mediaId);
    return m && !isImage(m) && !c.mode && m.width && fillFor(m.width / m.height, cw / ch).axis;
  });
  for (let i = 0; i < need.length; i++) {
    const c = need[i];
    const m = mediaById(c.mediaId);
    let samples = trackCache.get(trackKey(c, m));
    if (!samples) {
      if (onStep) onStep(i, need.length);
      try {
        samples = await window.api.trackSubject(m.path, c.in, c.out, m.width, m.height, c.id);
        trackCache.set(trackKey(c, m), samples);
      } catch (err) { console.warn('Tracking failed, using a centred fill', err); samples = null; }
    }
    const fill = fillFor(m.width / m.height, cw / ch);
    plans.set(c.id, samples && samples.length
      ? planReframe(samples, { srcAspect: m.width / m.height, canvasAspect: cw / ch, in: c.in, speed: spd(c), length: clipLen(c) })
      : { zoom: fill.zoom, keys: undefined });
  }
  return plans;
}

// Builds the project as if the canvas were another shape, without changing the edit.
function buildFor(aspect, plans, settings, width, height) {
  const saved = { aspect: state.aspect, clips: state.clips.map((c) => ({ c, zoom: c.zoom, posX: c.posX, posY: c.posY, keys: c.keys })) };
  state.aspect = aspect;
  for (const c of state.clips) {
    const p = plans.get(c.id);
    if (p) { Object.assign(c, { zoom: p.zoom, posX: 0, posY: 0, keys: p.keys }); migrateMotion(c); }
  }
  try {
    return buildExportProject(settings, width, height);
  } finally {
    state.aspect = saved.aspect;
    for (const r of saved.clips) Object.assign(r.c, { zoom: r.zoom, posX: r.posX, posY: r.posY, keys: r.keys });
  }
}

const SHAPE_NAMES = { '9:16': 'Portrait 9x16', '16:9': 'Landscape 16x9', '1:1': 'Square 1x1' };

async function startExport() {
  const settings = readExportSettings();
  try { localStorage.setItem('snippy.export', JSON.stringify(settings)); } catch { /* not remembered */ }
  const extra = settings.format === 'gif' ? [] : [...document.querySelectorAll('#exExtra input:checked')].map((x) => x.value);
  $('#exportSettings').hidden = true;
  const gif = settings.format === 'gif';
  const out = await window.api.pickExportPath(settings.format);
  if (!out) return;
  if (gif) Object.assign(settings, { fps: GIF_FPS, loud: false });
  exportingWhat = gif ? 'GIF' : 'MP4';
  // The main export, then one more for each extra shape, saved next to it.
  const stem = out.replace(/\.[^.\\/]+$/, '');
  const jobs = [{ aspect: state.aspect, out }, ...extra.map((a) => ({ aspect: a, out: `${stem} - ${SHAPE_NAMES[a]}.mp4` }))];
  const done = [];
  let madeWith = null;
  const off = window.api.onExportProgress(setProgress);
  try {
    for (let j = 0; j < jobs.length; j++) {
      const job = jobs[j];
      const label = jobs.length > 1 ? `Video ${j + 1} of ${jobs.length} (${SHAPE_NAMES[job.aspect]}): ` : '';
      setProgress(0);
      let plans = new Map();
      if (job.aspect !== state.aspect) {
        exportModal('running', `${label}getting the clips ready for this shape.`);
        plans = await reframeFor(job.aspect, (i, n) => exportModal('running', `${label}following the person in clip ${i + 1} of ${n}.`));
      }
      const [width, height] = exportSize(gif ? settings.gif : settings.res, job.aspect);
      const project = withBrandLogo(job.aspect, () => buildFor(job.aspect, plans, settings, width, height));
      exportModal('running', `${label}preparing captions.`);
      const missingGifs = await loadAllGifs();
      if (missingGifs.length) { exportModal('error', `These sticker files can't be found: ${missingGifs.join(', ')}`); return; }
      try {
        project.captions = await renderCaptionFrames(project.total, width, height, settings.fps);
        project.fxMasks = await renderFxMasks(project.total, width, height, settings.fps);
        await renderClipMasks(project, width, height, settings.fps);
      } catch (err) {
        console.error(err);
        exportModal('error', `Captions couldn't be prepared: ${cleanError(err)}`);
        return;
      }
      exportModal('running', `${label}rendering your timeline to ${exportingWhat}.`);
      const r = await window.api.exportVideo(project, job.out);
      if (r && r.encoder) madeWith = r.encoder;
      done.push(job.out);
    }
    setProgress(1);
    lastExportPath = done[0];
    const how = madeWith ? `\n(Made with the ${madeWith} card)` : '';
    exportModal('done', (done.length > 1 ? `Saved ${done.length} videos:\n${done.join('\n')}` : `Saved to ${done[0]}`) + how);
  } catch (err) {
    const msg = cleanError(err);
    if (msg.includes('cancelled')) $('#exportModal').hidden = true;
    else exportModal('error', done.length ? `${msg}\n\nAlready saved:\n${done.join('\n')}` : msg);
  } finally {
    off();
  }
}

// ---------- project files

let projectPath = null;
let dirty = false;

function projectName() {
  return projectPath ? projectPath.split(/[\\/]/).pop().replace(/\.(snippy|cutline)$/i, '') : 'Untitled project';
}

function syncTitle() {
  const name = projectName();
  $('#projectName').textContent = dirty ? `${name} (unsaved)` : name;
  window.api.setProjectState({ dirty, title: `${dirty ? '• ' : ''}${name} – Snippy` });
}

function markDirty() {
  if (dirty) return;
  dirty = true;
  syncTitle();
}

function serialize() {
  return JSON.stringify({
    app: 'snippy',
    version: 1,
    aspect: state.aspect,
    media: state.media.map((m) => ({ id: m.id, path: m.path })),
    clips: state.clips,
    texts: state.texts,
    audio: state.audio,
    overlays: state.overlays,
    stickers: state.stickers,
    adjust: state.adjust,
    markers: state.markers,
    cover: state.cover || undefined,
  }, null, 2);
}

async function saveProject(asCopy = false) {
  try {
    const text = serialize();
    const p = !asCopy && projectPath
      ? await window.api.saveProject(projectPath, text)
      : await window.api.saveProjectAs(text);
    if (!p) return;
    projectPath = p;
    dirty = false;
    syncTitle();
    window.api.clearRecovery();
    rememberRecent();
    toast(`Saved ${projectName()}`);
  } catch (err) {
    console.error(err);
    toast(`Couldn't save the project: ${cleanError(err)}`);
  }
}

const confirmDiscard = () => !dirty || window.confirm('You have unsaved changes. Discard them?');

function setAspect(a) {
  state.aspect = ASPECTS[a] ? a : '16:9';
  $('#aspect').value = state.aspect;
  fitStage();
  renderInspector();
}

function resetProject() {
  pause();
  state.media = [];
  state.clips = [];
  state.texts = [];
  state.audio = [];
  state.overlays = [];
  state.stickers = [];
  state.adjust = [];
  state.markers = [];
  state.cover = null;
  selection = []; state.selected = null;
  state.playhead = 0;
  syncAudio(false);
  syncOverlays(false);
  undoStack.length = 0;
  redoStack.length = 0;
  lastEditKey = null;
  overlayKey = null;
  currentIndex = -1;
  video.removeAttribute('src');
  video.dataset.mediaId = '';
  video.load();
  hideCross();
}

function newProject() {
  if (!confirmDiscard()) return;
  resetProject();
  projectPath = null;
  dirty = false;
  window.api.clearRecovery();
  setAspect('16:9');
  renderAll();
  refreshPreview();
  syncTitle();
}

async function openProject(file, opts = {}) {
  if (!file) {
    if (!confirmDiscard()) return;
    try {
      file = await window.api.openProject();
    } catch (err) {
      toast(`Couldn't open the project: ${cleanError(err)}`);
      return;
    }
    if (!file) return;
  }
  let data;
  try {
    data = JSON.parse(file.text);
    if (data.app !== 'snippy' && data.app !== 'cutline') throw new Error('not a project');
  } catch {
    toast("That file isn't a Snippy project");
    return;
  }

  resetProject();
  toast('Opening project');
  const missingRefs = [];
  const infos = {};
  for (const ref of data.media || []) {
    try {
      infos[ref.id] = await window.api.probe(ref.path);
    } catch {
      missingRefs.push(ref);
    }
  }
  if (missingRefs.length) Object.assign(infos, await relinkMissing(missingRefs));
  const missing = missingRefs.filter((r) => !infos[r.id]).map((r) => baseName(r.path));
  const relinked = missingRefs.length - missing.length;
  for (const ref of data.media || []) {
    if (!infos[ref.id]) continue;
    const m = { ...infos[ref.id], id: ref.id };
    state.media.push(m);
    loadLevels(m);
    queueProxy(m);
  }
  state.clips = (data.clips || []).filter((c) => mediaById(c.mediaId));
  for (const c of state.clips) {
    // The source file may have changed since the project was saved.
    const m = mediaById(c.mediaId);
    c.out = Math.min(c.out, m.duration);
    c.in = Math.min(c.in, Math.max(0, c.out - MIN_LEN));
  }
  state.texts = data.texts || [];
  state.audio = (data.audio || []).filter((a) => mediaById(a.mediaId));
  for (const a of state.audio) {
    const m = mediaById(a.mediaId);
    a.out = Math.min(a.out, m.duration);
    a.in = Math.min(a.in, Math.max(0, a.out - MIN_LEN));
  }
  state.stickers = data.stickers || [];
  state.adjust = data.adjust || [];
  state.markers = data.markers || [];
  state.cover = typeof data.cover === 'string' ? data.cover : null;
  state.overlays = (data.overlays || []).filter((o) => mediaById(o.mediaId));
  for (const o of state.overlays) {
    const m = mediaById(o.mediaId);
    o.out = Math.min(o.out, m.duration);
    o.in = Math.min(o.in, Math.max(0, o.out - MIN_LEN));
  }
  projectPath = file.path;
  dirty = relinked > 0;
  setAspect(data.aspect);
  renderAll();
  seek(0);
  syncTitle();
  if (opts.recovered) {
    dirty = true; // restored work still needs saving
    syncTitle();
  } else {
    window.api.clearRecovery();
  }
  if (missing.length) toast(`Opened without ${missing.length} file(s): ${missing.join(', ')}`);
  else if (relinked) toast(`Found ${relinked} moved file${relinked === 1 ? '' : 's'}. Press Ctrl+S to remember where they are.`);
  else toast(opts.recovered ? 'Restored your unsaved changes. Press Ctrl+S to keep them.' : `Opened ${projectName()}`);
  rememberRecent();
  loadAllGifs().then((failed) => { if (failed.length) toast(`Sticker files not found: ${failed.join(', ')}`); });
  return true;
}

const AUTOSAVE_MS = 60 * 1000;
function autosave() {
  if (stateBorrowed) return;
  if (!dirty || !(state.clips.length || state.texts.length || state.media.length)) return;
  window.api.writeRecovery(JSON.stringify({ projectPath, project: serialize() })).catch(() => {});
}
setInterval(autosave, AUTOSAVE_MS);

// After a crash, offer the last auto-saved copy back.
async function checkRecovery() {
  let rec = null;
  try { rec = await window.api.readRecovery(); } catch { return false; }
  if (!rec) return false;
  const when = new Date(rec.savedAt).toLocaleString();
  if (!window.confirm(`Snippy closed before your last changes were saved. Restore the copy auto-saved at ${when}?`)) {
    window.api.clearRecovery();
    return false;
  }
  try {
    const r = JSON.parse(rec.text);
    await openProject({ path: r.projectPath, text: r.project }, { recovered: true });
    return true;
  } catch {
    toast("The auto-saved copy couldn't be read");
    return false;
  }
}

// ---------- auto captions

let captionsRunning = false;

function openCaptions() {
  if (!state.clips.length) { toast('Add a video to the timeline first'); return; }
  if (!state.clips.some((c) => mediaById(c.mediaId).hasAudio)) { toast('None of the clips on the timeline have audio'); return; }
  pause();
  $('#capForm').hidden = false;
  $('#capRun').hidden = true;
  $('#capStart').hidden = false;
  $('#capCancel').textContent = 'Cancel';
  $('#captionsModal').hidden = false;
  $('#capStart').focus();
}

function setCapProgress(p) {
  const msg = $('#capMsg');
  const bar = $('#capBar');
  if (p.phase === 'prepare' || p.phase === 'loading') {
    msg.textContent = 'Getting the speech model ready.';
    bar.style.width = '0%';
  } else if (p.phase === 'download') {
    msg.textContent = `Downloading the speech model (one time only). ${Math.round(p.progress * 100)}%`;
    bar.style.width = `${Math.round(p.progress * 100)}%`;
  } else if (p.phase === 'align') {
    msg.textContent = `Timing each word in clip ${p.index + 1} of ${p.count}.`;
    bar.style.width = `${Math.round(p.progress * 100)}%`;
  } else if (p.phase === 'transcribe') {
    msg.textContent = p.index < p.count
      ? `Listening to clip ${p.index + 1} of ${p.count}.`
      : 'Placing captions on the timeline.';
    bar.style.width = `${Math.round(p.progress * 100)}%`;
  }
}

async function runCaptions() {
  captionsRunning = true;
  $('#capForm').hidden = true;
  $('#capRun').hidden = false;
  $('#capStart').hidden = true;
  setCapProgress({ phase: 'prepare' });

  const starts = clipStarts();
  const clips = state.clips.map((c, i) => {
    const m = mediaById(c.mediaId);
    return { path: m.path, in: c.in, out: c.out, start: starts[i], hasAudio: m.hasAudio, speed: spd(c) };
  });
  const opts = { language: $('#capLang').value || null, task: $('#capTask').value, maxWords: Number($('#capStyle').value) };
  const replace = $('#capReplace').checked;
  const off = window.api.onCaptionsProgress(setCapProgress);

  try {
    const segments = await window.api.generateCaptions(clips, opts);
    if (!segments.length) {
      toast('No speech was found in your clips');
    } else {
      commit();
      const earlier = state.texts.find((x) => x.auto);
      // New auto captions get the Pop look; later runs keep whatever style you gave the last ones.
      const style = earlier
        ? copyStyle(earlier)
        : { size: 6, position: 'bottom', color: '#FFFFFF', anim: 'pop', highlight: true, hlColor: '#FFD84D', box: false, caps: true };
      const look = CAPTION_PRESETS.find((p) => p.id === $('#capLook').value);
      if (look) Object.assign(style, look.set);
      else if (!earlier) Object.assign(style, brandCaptionStyle());
      if ($('#capKeys').checked) style.keyColor = true;
      if ($('#capEmoji').checked) style.emoji = true;
      if (replace) state.texts = state.texts.filter((x) => !x.auto);
      for (const s of segments) {
        state.texts.push({ id: newId('t'), text: s.text, start: s.start, dur: Math.max(MIN_LEN, s.end - s.start), words: s.words, ...style, auto: true });
      }
      selection = []; state.selected = null;
      overlayKey = null;
      renderAll();
      updateOverlay();
      toast(`Added ${segments.length} captions`);
    }
    $('#captionsModal').hidden = true;
  } catch (err) {
    const msg = cleanError(err);
    if (msg.includes('cancelled')) {
      $('#captionsModal').hidden = true;
    } else {
      console.error(err);
      $('#capMsg').textContent = `Captions couldn't be made: ${msg}`;
      $('#capCancel').textContent = 'Close';
    }
  } finally {
    off();
    captionsRunning = false;
  }
}

// ---------- wiring

function updateToolbar() {
  const has = state.clips.length > 0;
  $('#splitBtn').disabled = !has;
  $('#deleteBtn').disabled = !state.selected;
  $('#exportBtn').disabled = !has;
  $('#captionsBtn').disabled = !has;
  $('#voBtn').disabled = !has;
  $('#musicBtn').disabled = !has;
  $('#undoBtn').disabled = !undoStack.length;
  $('#redoBtn').disabled = !redoStack.length;
}

function renderAll() {
  for (const c of state.clips) migrateMotion(c); // older projects, templates and auto reframe use the old zoom + pan
  renderMedia();
  renderTimeline();
  renderInspector();
  updateToolbar();
  $('#stageEmpty').hidden = state.clips.length > 0;
}

$('#importBtn').addEventListener('click', async () => importPaths(await window.api.pickFiles()));
$('#exportBtn').addEventListener('click', exportVideo);

// ---------- button feel: ripples, sparks and drop-ins

const motionOK = () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const RIPPLE = '.btn, .icon-btn, .preset-chip, .shape-tile, .layout-tile, .fun-tile, .new-card, .home-ac-main, .menu-row, .seg button, .recent-open';
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !motionOK()) return;
  const b = e.target.closest(RIPPLE);
  if (!b || b.disabled) return;
  const r = b.getBoundingClientRect();
  if (getComputedStyle(b).position === 'static') b.classList.add('rippling');
  else b.style.overflow = 'hidden';
  const d = Math.hypot(Math.max(e.clientX - r.left, r.right - e.clientX), Math.max(e.clientY - r.top, r.bottom - e.clientY)) * 2;
  const dot = document.createElement('span');
  dot.className = 'ripple';
  Object.assign(dot.style, { width: `${d}px`, height: `${d}px`, left: `${e.clientX - r.left - d / 2}px`, top: `${e.clientY - r.top - d / 2}px` });
  b.append(dot);
  dot.addEventListener('animationend', () => dot.remove());
  setTimeout(() => dot.remove(), 800); // in case its button was hidden mid-ripple
}, true);

// A few sparks from a button (Export, and big moments like adding a sound pack).
function sparks(el, n = 10) {
  if (!motionOK() || !el) return;
  const r = el.getBoundingClientRect();
  const colours = ['#F0ABFC', '#C084FC', '#F472B6', '#FFE14D', '#ffffff'];
  for (let i = 0; i < n; i++) {
    const s = document.createElement('span');
    s.className = 'spark';
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
    const dist = 26 + Math.random() * 26;
    Object.assign(s.style, {
      left: `${r.left + r.width / 2 + Math.cos(a) * r.width * 0.3}px`, top: `${r.top + r.height / 2 + Math.sin(a) * r.height * 0.3}px`,
      background: colours[i % colours.length], '--dx': `${Math.cos(a) * dist}px`, '--dy': `${Math.sin(a) * dist}px`,
    });
    s.style.setProperty('--dx', `${Math.cos(a) * dist}px`);
    s.style.setProperty('--dy', `${Math.sin(a) * dist}px`);
    document.body.append(s);
    s.addEventListener('animationend', () => s.remove());
    setTimeout(() => s.remove(), 900);
  }
}
$('#exportBtn').addEventListener('pointerdown', (e) => { if (!e.currentTarget.disabled) sparks(e.currentTarget); });

// Items that weren't on the timeline a moment ago drop in when they appear.
var knownItems = null; // var: renderTimeline can run before this line during start-up
function markNewItems() {
  const now = new Set([...state.clips, ...state.texts, ...state.audio, ...state.stickers, ...state.overlays].map((x) => x.id));
  if (knownItems && motionOK()) {
    for (const id of now) {
      if (knownItems.has(id)) continue;
      const el = document.querySelector(`#tlContent [data-id="${id}"]`);
      if (el) { el.classList.add('just-added'); el.addEventListener('animationend', () => el.classList.remove('just-added'), { once: true }); }
    }
  }
  knownItems = now;
}
$('#exsGo').addEventListener('click', startExport);
$('#cutCancel').addEventListener('click', () => {
  if (cutoutRunning) { window.api.cancelCutout(); $('#cutMsg').textContent = 'Stopping.'; }
  else $('#cutoutModal').hidden = true;
});
$('#exsCancel').addEventListener('click', () => { $('#exportSettings').hidden = true; });
for (const id of ['#exRes', '#exFps', '#exQuality']) $(id).addEventListener('change', updateExportSummary);
$('#exportCancel').addEventListener('click', () => window.api.cancelExport());
$('#exportClose').addEventListener('click', () => { $('#exportModal').hidden = true; });
$('#exportShow').addEventListener('click', () => { if (lastExportPath) window.api.showInFolder(lastExportPath); });
$('#playBtn').addEventListener('click', togglePlay);
$('#backBtn').addEventListener('click', () => stepFrame(-1));
$('#fwdBtn').addEventListener('click', () => stepFrame(1));
$('#splitBtn').addEventListener('click', splitAtPlayhead);
$('#deleteBtn').addEventListener('click', deleteSelected);
$('#addTextBtn').addEventListener('click', addText);
$('#updateGo').addEventListener('click', async () => {
  // Unsaved work is offered a save first: the close prompt appears as the app restarts.
  window.api.installUpdate();
});
$('#updateLater').addEventListener('click', () => { $('#updateBar').hidden = true; });
$('#proxyToggle').checked = proxiesOn;
$('#proxyToggle').addEventListener('change', (e) => {
  proxiesOn = e.target.checked;
  try { localStorage.setItem('snippy.proxies', proxiesOn ? 'on' : 'off'); } catch { /* not remembered */ }
  if (proxiesOn) state.media.forEach((m) => queueProxy(m));
  else {
    for (const m of state.media) if (!(m.vcodec && !PLAYABLE.has(m.vcodec))) m.proxyUrl = null; // unplayable files keep theirs
    renderMedia();
    for (const [id, el] of pipEls) { el.wrap.remove(); pipEls.delete(id); }
    refreshPreview();
  }
});
$('#snapBtn').addEventListener('click', () => setSnap(!snapOn));
$('#stickerBtn').addEventListener('click', () => ($('#stickerPicker').hidden ? openPicker('add') : closePicker()));
$('#templateBtn').addEventListener('click', () => ($('#templatePicker').hidden ? openTemplates() : closeTemplates()));
$('#sfxBtn').addEventListener('click', () => ($('#sfxPicker').hidden ? openSfx() : closeSfx()));
$('#undoBtn').addEventListener('click', undo);
$('#redoBtn').addEventListener('click', redo);
$('#newBtn').addEventListener('click', newProject);
$('#openBtn').addEventListener('click', () => openProject());
$('#saveBtn').addEventListener('click', () => saveProject());
$('#captionsBtn').addEventListener('click', openCaptions);
$('#capStart').addEventListener('click', runCaptions);
$('#capCancel').addEventListener('click', () => {
  if (captionsRunning) {
    window.api.cancelCaptions();
    $('#capMsg').textContent = 'Stopping after the current clip.';
  } else {
    $('#captionsModal').hidden = true;
  }
});
$('#zoom').addEventListener('input', (e) => setZoom(Number(e.target.value)));
$('#aspect').addEventListener('change', (e) => {
  setAspect(e.target.value);
  markDirty();
  offerReframe();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#sfxPicker').hidden) { closeSfx(); return; }
  if (e.key === 'Escape' && !$('#templatePicker').hidden) { closeTemplates(); return; }
  if (e.key === 'Escape' && pickingKeyFor) { pickingKeyFor = null; $('#stage').classList.remove('picking'); return; }
  if (rebinding) {
    e.preventDefault();
    if (e.key !== 'Escape' && !['Shift', 'Alt', 'Control', 'Meta'].includes(e.key)) {
      const combo = comboOf(e);
      const clash = KEY_ACTIONS.find(([id]) => id !== rebinding && bindingOf(id) === combo);
      if (clash) keyBindings[clash[0]] = bindingOf(rebinding); // swap, so nothing is left without a key
      keyBindings[rebinding] = combo;
      saveBindings();
      if (clash) toast(`"${clash[1]}" now uses ${prettyKey(keyBindings[clash[0]])}`);
    }
    if (['Shift', 'Alt', 'Control', 'Meta'].includes(e.key)) return;
    rebinding = null;
    renderInspector();
    return;
  }
  if (e.key === 'Escape' && !$('#stickerPicker').hidden) { closePicker(); return; }
  if (e.key === 'Escape' && !$('#smartMenu').hidden) { closeSmart(); return; }
  if (e.key === 'Escape' && !$('#txPanel').hidden) { closeTranscript(); return; }
  if (e.key === 'Escape' && !$('#musicPicker').hidden) { closeMusic(); return; }
  if (e.key === 'Escape' && !$('#trModal').hidden) { $('#trCancel').click(); return; }
  if (e.key === 'Escape' && !$('#vtplModal').hidden) { $('#vtplModal').hidden = true; return; }
  if (e.key === 'Escape' && !$('#pausesModal').hidden && !pz.busy) { $('#pausesModal').hidden = true; return; }
  if (e.key === 'Escape' && !$('#voModal').hidden) { $('#voCancel').click(); return; }
  if (e.key === 'Escape' && !$('#home').hidden && !$('#homeBack').hidden) { hideHome(); return; }
  const k = e.key;
  const ctrl = e.ctrlKey || e.metaKey;
  if (!$('#exportSettings').hidden) {
    if (k === 'Escape') $('#exportSettings').hidden = true;
    return;
  }
  const dialogOpen = !$('#vtplModal').hidden || !$('#trModal').hidden || !$('#checkModal').hidden || !$('#pausesModal').hidden || !$('#voModal').hidden || !$('#jobModal').hidden || !$('#home').hidden || !$('#relinkModal').hidden || !$('#tour').hidden || !$('#exportModal').hidden || !$('#captionsModal').hidden || !$('#cutoutModal').hidden || !$('#shModal').hidden || !$('#thumbModal').hidden || !$('#setupModal').hidden || !$('#brandModal').hidden || !$('#ziModal').hidden;
  if (dialogOpen) {
    if (k === 'Escape' && !$('#captionsModal').hidden && !captionsRunning) $('#captionsModal').hidden = true;
    return;
  }
  if (ctrl && (k === 's' || k === 'S')) { e.preventDefault(); saveProject(e.shiftKey); return; }
  if (ctrl && (k === 'o' || k === 'O')) { e.preventDefault(); openProject(); return; }
  if (ctrl && (k === 'n' || k === 'N')) { e.preventDefault(); newProject(); return; }
  const tag = e.target.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
  if (ctrl && (k === 'z' || k === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if (ctrl && (k === 'y' || k === 'Y')) { e.preventDefault(); redo(); }
  else if (ctrl && (k === 'c' || k === 'C')) { e.preventDefault(); copySelection(); }
  else if (ctrl && (k === 'x' || k === 'X')) { e.preventDefault(); copySelection(); deleteSelected(); }
  else if (ctrl && (k === 'v' || k === 'V')) { e.preventDefault(); pasteClipboard(); }
  else if (ctrl && (k === 'a' || k === 'A')) { e.preventDefault(); selectAll(); }
  else if (ctrl && (k === 'g' || k === 'G')) { e.preventDefault(); if (e.shiftKey) ungroupSelected(); else groupSelected(); }
  else if (ctrl) { /* leave other Ctrl shortcuts alone */ }
  else if (k === 'Escape') { stopShuttle(); select(null); }
  else {
    const combo = comboOf(e);
    const act = KEY_ACTIONS.find(([id]) => bindingOf(id) === combo);
    if (act) { e.preventDefault(); act[3](); }
  }
});

window.addEventListener('dragover', (e) => {
  if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
    e.preventDefault();
    document.body.classList.add('dragging-files');
  }
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dragging-files');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging-files');
  const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
  importPaths(paths);
});

new ResizeObserver(fitStage).observe($('#stageWrap'));
window.addEventListener('resize', renderTimeline);

setPlayIcon();
renderAll();
fitStage();
syncTitle();
requestAnimationFrame(tick);
setSnap(snapOn);
toolsReady()
  .then(() => checkRecovery())
  .then(async (restored) => {
    if (restored) return true;
    const file = await window.api.initialProject();
    return file ? openProject(file) : false;
  })
  .catch(() => false)
  .then((opened) => { if (opened) maybeShowTour(); else showHome(); });

// ---------- right-click menus (timeline items, empty timeline, media, preview)

let ctxMenu = null;
function closeCtx() {
  if (!ctxMenu) return;
  ctxMenu.remove();
  ctxMenu = null;
}

// entries: { label, key, onClick, disabled, danger, checked } | '-' | { title } | { chips: [{ label, active, onClick }], label }
function openCtx(x, y, entries) {
  closeCtx();
  if (state.playing) pause();
  const menu = h('div', { class: 'ctx-menu', role: 'menu' });
  const run = (fn) => () => { closeCtx(); fn(); };
  for (const en of entries.filter(Boolean)) {
    if (en === '-') { if (menu.lastChild && !menu.lastChild.classList.contains('ctx-sep')) menu.append(h('div', { class: 'ctx-sep', role: 'separator' })); continue; }
    if (en.title) { menu.append(h('div', { class: 'ctx-title' }, en.title)); continue; }
    if (en.chips) {
      menu.append(h('div', { class: 'ctx-chips', role: 'group', 'aria-label': en.label },
        h('span', { class: 'ctx-chips-label' }, en.label),
        ...en.chips.map((c) => h('button', {
          class: `ctx-chip${c.active ? ' on' : ''}`, role: 'menuitemradio', 'aria-checked': String(Boolean(c.active)),
          disabled: c.disabled || null, onClick: run(c.onClick),
        }, c.label))));
      continue;
    }
    menu.append(h('button', {
      class: `ctx-item${en.danger ? ' danger' : ''}`, role: en.checked == null ? 'menuitem' : 'menuitemcheckbox',
      'aria-checked': en.checked == null ? null : String(en.checked), disabled: en.disabled || null,
      title: en.hint || null, onClick: run(en.onClick),
    }, h('span', { class: 'ctx-check' }, en.checked ? '✓' : ''), h('span', { class: 'ctx-label' }, en.label), en.key ? h('kbd', {}, en.key) : null));
  }
  while (menu.lastChild && menu.lastChild.classList.contains('ctx-sep')) menu.lastChild.remove();
  document.body.append(menu);
  // Keep it on screen: open up or to the left near the edges.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${clamp(x + r.width > window.innerWidth - 6 ? x - r.width : x, 6, window.innerWidth - r.width - 6)}px`;
  menu.style.top = `${clamp(y + r.height > window.innerHeight - 6 ? y - r.height : y, 6, window.innerHeight - r.height - 6)}px`;
  ctxMenu = menu;
  const first = menu.querySelector('button:not([disabled])');
  if (first) first.focus({ preventScroll: true });
}

// Arrow keys move through the menu, Escape closes it.
document.addEventListener('keydown', (e) => {
  if (!ctxMenu) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeCtx(); return; }
  const btns = [...ctxMenu.querySelectorAll('button:not([disabled])')];
  const i = btns.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
    e.preventDefault(); e.stopImmediatePropagation();
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1
      : (i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
    if (btns[n]) btns[n].focus();
  } else if (e.key === 'Tab') { e.preventDefault(); closeCtx(); } else if (e.key !== 'Enter' && e.key !== ' ') {
    e.stopImmediatePropagation(); // shortcuts don't fire behind an open menu
  }
}, true);
document.addEventListener('pointerdown', (e) => { if (ctxMenu && !ctxMenu.contains(e.target)) closeCtx(); }, true);
window.addEventListener('blur', closeCtx);
window.addEventListener('resize', closeCtx);
$('#tlScroll').addEventListener('scroll', closeCtx);

const keyHint = (id) => prettyKey(bindingOf(id));
const itemEnd = (kind, x) => x.start + (kind === 'audio' || kind === 'overlay' ? (x.out - x.in) / (x.speed || 1) : x.dur);

// Copies of the selected items, placed straight after each original.
function duplicateSelection() {
  const sel = selection.map((s) => ({ ...s, item: itemOf(s) })).filter((s) => s.item);
  if (!sel.length) return;
  commit();
  const made = [];
  // Clips: each copy goes right after its original (last first, so indexes stay right).
  const clips = sel.filter((s) => s.kind === 'clip').sort((a, b) => state.clips.indexOf(b.item) - state.clips.indexOf(a.item));
  for (const s of clips) {
    const copy = { ...clone(s.item), id: newId('c'), transition: 0 };
    state.clips.splice(state.clips.indexOf(s.item) + 1, 0, copy);
    made.push({ kind: 'clip', id: copy.id });
  }
  const free = sel.filter((s) => FREE_KINDS.has(s.kind));
  if (free.length) {
    const t0 = Math.min(...free.map((s) => s.item.start));
    const shift = Math.max(...free.map((s) => itemEnd(s.kind, s.item))) - t0;
    for (const s of free) {
      const copy = { ...clone(s.item), id: newId(s.kind[0]), start: s.item.start + shift };
      if (s.kind === 'overlay') copy.lane = freeLane(copy.start, copy.start + (copy.out - copy.in), copy.id);
      listOf(s.kind).push(copy);
      made.push({ kind: s.kind, id: copy.id });
    }
  }
  selection = made;
  renderAll();
  refreshSelectionUI();
  renderInspector();
  refreshPreview();
  toast(made.length === 1 ? 'Duplicated' : `Duplicated ${made.length} items`);
}

// Small edits from the menu: one undo step, then redraw.
function ctxEdit(fn) {
  commit();
  fn();
  state.playhead = Math.min(state.playhead, totalDuration());
  renderAll();
  refreshSelectionUI();
  renderInspector();
  refreshPreview();
}

// Up or down one track: overlays in the way swap places with it.
function shiftLane(x, dir) {
  const from = laneOf(x);
  const to = Math.max(0, from + dir);
  const end = (o) => o.start + (o.out - o.in);
  for (const o of state.overlays) {
    if (o !== x && laneOf(o) === to && o.start < end(x) && end(o) > x.start) o.lane = from;
  }
  x.lane = to;
  tidyLanes(x.id);
}

function moveToPlayhead(kind, x) {
  ctxEdit(() => {
    x.start = state.playhead;
    if (kind === 'overlay') x.lane = freeLane(x.start, x.start + (x.out - x.in), x.id);
  });
}

function editEntries(several) {
  return [
    '-',
    { label: 'Copy', key: 'Ctrl+C', onClick: copySelection },
    { label: 'Cut', key: 'Ctrl+X', onClick: () => { copySelection(); deleteSelected(); } },
    { label: 'Paste at playhead', key: 'Ctrl+V', onClick: pasteClipboard },
    { label: several ? 'Duplicate all' : 'Duplicate', onClick: duplicateSelection },
    '-',
    { label: several ? 'Delete all' : 'Delete', key: keyHint('delete'), danger: true, onClick: deleteSelected },
  ];
}

function splitHere(t) { seek(t); splitAtPlayhead(); }

function clipEntries(c, t) {
  const m = mediaById(c.mediaId);
  const still = !m || isImage(m);
  const vol = c.volume ?? 1;
  return [
    { title: m ? m.name : 'Clip' },
    c.compound ? { label: 'Split back into the original clips', onClick: () => uncombineClip(c) } : null,
    { label: 'Split here', key: keyHint('split'), onClick: () => splitHere(t) },
    state.clips.indexOf(c) > 0 ? { label: c.transition > 0 ? 'Change the transition into this clip…' : 'Add a transition into this clip…', onClick: () => openTransitionPop(state.clips.indexOf(c)) } : null,
    state.clips.length > 2 ? { label: 'Transitions on every cut…', onClick: () => openTransitionPop(Math.max(1, state.clips.indexOf(c))) } : null,
    still ? null : { label: 'Freeze frame here', onClick: () => { seek(t); freezeFrame(); } },
    { label: 'Add or remove a keyframe here', key: keyHint('keyframe'), onClick: () => { seek(t); toggleKeyframeHere(); } },
    still || c.ramp ? null : {
      label: 'Speed',
      chips: [[0.5, '½×'], [1, '1×'], [1.5, '1.5×'], [2, '2×'], [4, '4×']].map(([v, label]) => ({
        label, active: spd(c) === v, onClick: () => ctxEdit(() => { c.speed = v; }),
      })),
    },
    '-',
    still || !m.hasAudio ? null : { label: vol > 0 ? 'Mute' : 'Unmute', onClick: () => ctxEdit(() => { if (vol > 0) { c.unmutedVolume = vol; c.volume = 0; } else { c.volume = c.unmutedVolume || 1; delete c.unmutedVolume; } }) },
    still ? null : {
      label: 'Play backwards', checked: c.mode === 'reverse',
      onClick: () => {
        if (c.mode !== 'reverse' && c.out - c.in > 30) { toast('Trim the clip to 30 seconds or less to play it backwards'); return; }
        ctxEdit(() => { c.mode = c.mode === 'reverse' ? undefined : 'reverse'; });
      },
    },
    still ? null : {
      label: 'Stabilise', checked: Boolean(c.stab),
      onClick: () => {
        if (!c.stab && c.out - c.in > 120) { toast('Trim the clip to 2 minutes or less to stabilise it'); return; }
        ctxEdit(() => { c.stab = c.stab ? undefined : 'medium'; });
      },
    },
    { label: 'Delete and close the gap', key: keyHint('ripple'), danger: true, onClick: rippleDelete },
    ...editEntries(false),
  ];
}

function freeEntries(kind, x, t) {
  const m = x.mediaId ? mediaById(x.mediaId) : null;
  const names = { text: 'Text', sticker: 'Sticker', audio: 'Sound', overlay: 'Overlay', adjust: 'Adjustment layer' };
  const title = kind === 'text' ? `“${(x.text || '').slice(0, 28)}${(x.text || '').length > 28 ? '…' : ''}”` : m ? m.name : names[kind];
  const n = laneCount();
  return [
    { title },
    kind === 'audio' || kind === 'overlay' ? { label: 'Split here', key: keyHint('split'), onClick: () => splitHere(t) } : null,
    kind === 'overlay' || kind === 'sticker' || kind === 'text' ? { label: 'Track motion…', onClick: () => { select(kind, x.id); startTrackPick(x, kind); } } : null,
    kind === 'overlay' || kind === 'sticker' ? { label: 'Add or remove a keyframe here', key: keyHint('keyframe'), onClick: () => { seek(clamp(t, x.start, itemEnd(kind, x))); toggleKeyframeHere(); } } : null,
    kind === 'text' ? { label: 'Edit text', onClick: () => { showInspectorTab('text'); const ta = $('#inspector textarea'); if (ta) { ta.focus(); ta.select(); } } } : null,
    kind === 'sticker' ? { label: 'Change sticker…', onClick: () => openPicker('replace') } : null,
    kind === 'overlay' ? { label: 'Bring forward', disabled: laneOf(x) >= n - 1 && state.overlays.length < 2, onClick: () => ctxEdit(() => shiftLane(x, 1)) } : null,
    kind === 'overlay' ? { label: 'Send backward', disabled: laneOf(x) === 0, onClick: () => ctxEdit(() => shiftLane(x, -1)) } : null,
    kind === 'audio' || (kind === 'overlay' && m && m.hasAudio) ? {
      label: (x.volume ?? 1) > 0 ? 'Mute' : 'Unmute',
      onClick: () => ctxEdit(() => { if ((x.volume ?? 1) > 0) { x.unmutedVolume = x.volume ?? 1; x.volume = 0; } else { x.volume = x.unmutedVolume || 1; delete x.unmutedVolume; } }),
    } : null,
    { label: 'Move to playhead', disabled: Math.abs(x.start - state.playhead) < 0.01, onClick: () => moveToPlayhead(kind, x) },
    ...editEntries(false),
  ];
}

function emptyTimelineEntries(t) {
  let hasClip = false;
  try { hasClip = Boolean(localStorage.getItem(CLIP_KEY)); } catch { /* no clipboard */ }
  return [
    { title: `At ${fmt(t)}` },
    { label: 'Paste here', key: 'Ctrl+V', disabled: !hasClip, onClick: pasteClipboard },
    '-',
    { label: 'Add text here', key: keyHint('text'), onClick: addText },
    { label: 'Add a sticker here…', key: keyHint('sticker'), onClick: () => openPicker('add') },
    { label: 'Add a sound effect…', onClick: () => openSfx() },
    { label: 'Add an adjustment layer here', onClick: addAdjustLayer },
    state.clips.length ? { label: 'Split here', key: keyHint('split'), onClick: () => splitHere(t) } : null,
    '-',
    { label: 'Select everything', key: 'Ctrl+A', onClick: selectAll },
    { label: 'Fit the timeline to the window', disabled: !totalDuration(), onClick: () => setZoom(($('#tlScroll').clientWidth - 140) / Math.max(1, totalDuration())) },
  ];
}

content.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (e.target.closest('.playhead-head')) return;
  const t = clamp(timeAtClientX(e.clientX), 0, Math.max(totalDuration(), timeAtClientX(e.clientX)));
  const el = e.target.closest('.clip, .text-item, .audio-item, .overlay-item, .sticker-item, .adjust-item');
  if (!el) {
    if (!e.target.closest('.track')) return;
    select(null);
    seek(t);
    openCtx(e.clientX, e.clientY, emptyTimelineEntries(t));
    return;
  }
  const kind = kindOfEl(el);
  const id = el.dataset.id;
  // Right-clicking something already selected keeps the whole selection.
  if (!isSel(kind, id)) select(kind, id);
  if (selection.length > 1) {
    const hasClip = selection.some((s) => s.kind === 'clip');
    openCtx(e.clientX, e.clientY, [
      { title: oneGroup() ? `A group of ${selection.length} items` : `${selection.length} items selected` },
      oneGroup() ? { label: 'Ungroup', key: 'Ctrl+Shift+G', onClick: ungroupSelected } : canGroup() ? { label: 'Group (move together)', key: 'Ctrl+G', onClick: groupSelected } : null,
      canCombine() ? { label: 'Combine into one clip', onClick: combineClips } : null,
      ...editEntries(true).slice(1, -1),
      { label: 'Delete all', key: keyHint('delete'), danger: true, onClick: deleteSelected },
      hasClip ? { label: 'Delete and close the gaps', key: keyHint('ripple'), danger: true, onClick: rippleDelete } : null,
    ]);
    return;
  }
  const x = itemOf({ kind, id });
  if (!x) return;
  openCtx(e.clientX, e.clientY, kind === 'clip' ? clipEntries(x, t) : freeEntries(kind, x, t));
});

// Media panel.
$('#mediaList').addEventListener('contextmenu', (e) => {
  const card = e.target.closest('.media-card');
  if (!card) return;
  e.preventDefault();
  const m = mediaById(card.dataset.id);
  if (!m) return;
  const used = usedMediaIds().has(m.id);
  openCtx(e.clientX, e.clientY, [
    { title: m.name },
    { label: m.kind === 'audio' ? 'Add at the playhead' : 'Add to the end of the video', onClick: () => addToTimeline(m.id) },
    m.kind === 'audio' ? null : { label: 'Add as an overlay at the playhead', onClick: () => addToTimeline(m.id, true) },
    '-',
    { label: 'Show in folder', onClick: () => window.api.showInFolder(m.path) },
    {
      label: 'Remove from project', danger: true, disabled: used,
      hint: used ? 'It is used in the timeline. Delete it there first.' : null,
      onClick: () => { state.media = state.media.filter((x) => x.id !== m.id); markDirty(); renderMedia(); toast(`Removed ${m.name} from the project`); },
    },
  ]);
});

// Preview.
$('#stage').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const sel = state.selected && itemOf(state.selected);
  const loc = state.clips.length ? locate(state.playhead) : null;
  const m = loc ? mediaById(loc.clip.mediaId) : null;
  openCtx(e.clientX, e.clientY, [
    { label: state.playing ? 'Pause' : 'Play', key: keyHint('play'), onClick: () => togglePlay() },
    loc ? { label: 'Split at playhead', key: keyHint('split'), onClick: splitAtPlayhead } : null,
    loc && m && !isImage(m) ? { label: 'Freeze this frame', onClick: freezeFrame } : null,
    '-',
    { label: 'Add text', key: keyHint('text'), onClick: addText },
    { label: 'Add a sticker…', key: keyHint('sticker'), onClick: () => openPicker('add') },
    sel ? '-' : null,
    sel ? { label: 'Copy selected', key: 'Ctrl+C', onClick: copySelection } : null,
    sel ? { label: 'Duplicate selected', onClick: duplicateSelection } : null,
    sel ? { label: 'Delete selected', key: keyHint('delete'), danger: true, onClick: deleteSelected } : null,
  ]);
});

// ---------- keyframes from anywhere: the diamond next to the timecode works on the selected
// clip, overlay or sticker, whichever settings tab is open.

let trackPick = null; // set while drawing a box to track
const KEYED_KINDS = new Set(['clip', 'overlay', 'sticker', 'text', 'audio']);
function keyedTarget() {
  const s = state.selected;
  if (!s || !KEYED_KINDS.has(s.kind) || selection.length > 1) return null;
  const item = itemOf(s);
  return item ? { item, kind: s.kind } : null;
}
// Whether the playhead is inside the item, so a keyframe can go there.
function playheadInside(kind, item) {
  const u = kfLocal(kind, item);
  return u >= -1 / 60 && u <= kfLength(kind, item) + 1 / 60;
}

function toggleKeyframeHere() {
  const t = keyedTarget();
  if (!t) { toast('Select a clip, overlay, sticker, text or sound to add keyframes'); return; }
  if (!playheadInside(t.kind, t.item)) { toast('Move the playhead over the selected item first'); return; }
  const u = clamp(kfLocal(t.kind, t.item), 0, kfLength(t.kind, t.item));
  if (kfAt(t.item, u)) removeKeyframe(t.item, t.kind);
  else addKeyframe(t.item, t.kind);
  updateKfBar();
}

let kfBarKey = '';
function updateKfBar() {
  const t = keyedTarget();
  const inside = t && playheadInside(t.kind, t.item);
  const keys = t && t.item.keys ? t.item.keys : [];
  const u = t ? kfLocal(t.kind, t.item) : 0;
  const here = Boolean(inside && kfAt(t.item, clamp(u, 0, kfLength(t.kind, t.item))));
  const prev = keys.some((k) => k.t < u - 1 / 60);
  const next = keys.some((k) => k.t > u + 1 / 60);
  const key = `${t ? t.item.id : ''}|${inside}|${here}|${prev}|${next}|${keys.length}`;
  if (key === kfBarKey) return;
  kfBarKey = key;
  const btn = $('#kfToggle');
  const shortcut = prettyKey(bindingOf('keyframe'));
  btn.disabled = !inside;
  btn.classList.toggle('on', here);
  btn.setAttribute('aria-pressed', String(here));
  const label = !t ? 'Keyframes: select a clip, overlay, sticker, text or sound'
    : !inside ? 'Keyframes: move the playhead over the selected item'
      : here ? `Remove this keyframe (${shortcut})` : `Add a keyframe here (${shortcut})`;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  $('#kfPrev').disabled = !prev;
  $('#kfNext').disabled = !next;
  $('#kfBar').classList.toggle('active', Boolean(t));
}
$('#kfToggle').addEventListener('click', toggleKeyframeHere);
$('#kfPrev').addEventListener('click', () => { const t = keyedTarget(); if (t) jumpKeyframe(t.item, t.kind, -1); });
$('#kfNext').addEventListener('click', () => { const t = keyedTarget(); if (t) jumpKeyframe(t.item, t.kind, 1); });
KEY_ACTIONS.push(['keyframe', 'Add or remove a keyframe', 'Alt+K', () => toggleKeyframeHere()]);

// ---------- zoom and move the main video right on the preview.
// Scroll to zoom (towards the pointer), drag to move. With keyframes, each change is saved
// as a keyframe at the playhead, just like the sliders.

const MAX_ZOOM = 4;
function stageClip() {
  if (!state.clips.length) return null;
  const loc = locate(Math.min(state.playhead, Math.max(0, totalDuration() - 1e-3)));
  return loc ? loc.clip : null;
}
// Picks the clip under the playhead (selecting it) for an edit made on the preview.
function grabStageClip() {
  const c = stageClip();
  if (!c) return null;
  if (!isSel('clip', c.id) || selection.length > 1) select('clip', c.id);
  return c;
}

// Sets the size, keeping the stage point (sx, sy) in pixels from the stage centre where it was.
const MIN_ZOOM = 0.1;
function zoomClipAbout(c, z1, sx = 0, sy = 0) {
  const st = $('#stage');
  const W = st.clientWidth;
  const H = st.clientHeight;
  const v = valuesNow('clip', c);
  z1 = clamp(z1, MIN_ZOOM, MAX_ZOOM);
  const k = z1 / v.zoom;
  const posX = (sx - k * (sx - v.posX * W)) / W;
  const posY = (sy - k * (sy - v.posY * H)) / H;
  kset(c, 'clip', { zoom: Number(z1.toFixed(4)), posX: Number(clamp(posX, -2, 2).toFixed(4)), posY: Number(clamp(posY, -2, 2).toFixed(4)) });
  afterStageEdit();
}

let stageEditTimer = 0;
function afterStageEdit() {
  markDirty();
  updateFx();
  updateZoomHud();
  updateKfBar();
  // Keep the open panel's sliders in step, without redrawing it on every tiny move.
  clearTimeout(stageEditTimer);
  stageEditTimer = setTimeout(() => { if (!(document.activeElement && document.activeElement.matches('#inspector input'))) renderInspector(); }, 120);
}

let wheelEditTimer = 0;
$('#stage').addEventListener('wheel', (e) => {
  if ((!state.clips.length && !captionHits.length) || pickingKeyFor) return;
  e.preventDefault();
  if (state.playing) pause();
  const f = Math.exp(-clamp(e.deltaY, -120, 120) * 0.0018);
  // Over an overlay or sticker, scrolling resizes that instead.
  const pip = e.target.closest('.pip');
  const hit = e.target.closest('.sticker-hit');
  const tx = !pip && !hit ? textAt(e.clientX, e.clientY) : null;
  if (tx) {
    if (!isSel('text', tx.id)) select('text', tx.id);
    commitOnce(`${tx.id}:wheel`);
    kset(tx, 'text', { scale: Number(clamp(valuesNow('text', tx).scale * f, 0.2, 4).toFixed(4)) });
    overlayKey = null; updateOverlay(); markDirty(); updateKfBar();
  } else if (pip || hit) {
    const kind = pip ? 'overlay' : 'sticker';
    const item = (pip ? state.overlays : state.stickers).find((x) => x.id === (pip || hit).dataset.id);
    if (!item) return;
    if (!isSel(kind, item.id)) select(kind, item.id);
    commitOnce(`${item.id}:wheel`);
    const v = valuesNow(kind, item);
    if (kind === 'overlay') kset(item, 'overlay', { w: clamp(v.w * f, 0.05, 1.5) });
    else kset(item, 'sticker', { size: clamp(v.size * f, 0.03, 1.2) });
    syncOverlays(true); updateOverlay(); markDirty(); updateKfBar();
  } else {
    const c = grabStageClip();
    if (!c) return;
    commitOnce(`${c.id}:wheel`);
    const r = $('#stage').getBoundingClientRect();
    zoomClipAbout(c, valuesNow('clip', c).zoom * f, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
  }
  // A pause in scrolling ends the undo step.
  clearTimeout(wheelEditTimer);
  wheelEditTimer = setTimeout(() => { lastEditKey = null; }, 700);
}, { passive: false });

// The text under a point on the screen (topmost first), if any.
function textAt(clientX, clientY) {
  const r = $('#stage').getBoundingClientRect();
  for (let i = captionHits.length - 1; i >= 0; i--) {
    const b = captionHits[i];
    const X = (clientX - r.left) - b.cx * r.width;
    const Y = (clientY - r.top) - b.cy * r.height;
    const a = (-b.rot * Math.PI) / 180;
    const lx = X * Math.cos(a) - Y * Math.sin(a);
    const ly = X * Math.sin(a) + Y * Math.cos(a);
    if (Math.abs(lx) <= b.hw * r.width && Math.abs(ly) <= b.hh * r.height) return state.texts.find((x) => x.id === b.id) || null;
  }
  return null;
}

function dragText(e, x) {
  e.preventDefault();
  if (state.playing) pause();
  if (!isSel('text', x.id) || selection.length > 1) select('text', x.id);
  const st = $('#stage');
  const W = st.clientWidth;
  const H = st.clientHeight;
  const start = valuesNow('text', x);
  const sx = e.clientX;
  const sy = e.clientY;
  const before = snapshot();
  let changed = false;
  st.setPointerCapture(e.pointerId);
  const move = (ev) => {
    if (!changed && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 3) return;
    changed = true;
    let dx = start.dx + (ev.clientX - sx) / W;
    let dy = start.dy + (ev.clientY - sy) / H;
    if (!ev.altKey && Math.abs(dx * W) < 6) dx = 0; // back where its position setting puts it
    if (!ev.altKey && Math.abs(dy * H) < 6) dy = 0;
    kset(x, 'text', { dx: Number(dx.toFixed(4)), dy: Number(dy.toFixed(4)) });
    overlayKey = null;
    updateOverlay();
    markDirty();
    updateKfBar();
  };
  const up = () => {
    st.removeEventListener('pointermove', move);
    st.removeEventListener('pointerup', up);
    st.removeEventListener('pointercancel', up);
    if (changed) { pushHistory(before); renderTimeline(); renderInspector(); }
  };
  st.addEventListener('pointermove', move);
  st.addEventListener('pointerup', up);
  st.addEventListener('pointercancel', up);
}

$('#stage').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || pickingKeyFor) return;
  if (e.target.closest('.pip, .sticker-hit')) return; // those move themselves
  const tx = textAt(e.clientX, e.clientY);
  if (tx) { dragText(e, tx); return; }
  const c = grabStageClip();
  if (!c) return;
  e.preventDefault();
  if (state.playing) pause();
  const st = $('#stage');
  const W = st.clientWidth;
  const H = st.clientHeight;
  const start = valuesNow('clip', c);
  const sx = e.clientX;
  const sy = e.clientY;
  const before = snapshot();
  let changed = false;
  st.setPointerCapture(e.pointerId);
  st.classList.add('panning');
  const move = (ev) => {
    const dx = ev.clientX - sx;
    const dy = ev.clientY - sy;
    if (!changed && Math.abs(dx) + Math.abs(dy) < 3) return;
    changed = true;
    // Snaps to the middle (and shows a guide) unless Alt is held.
    let px = start.posX + dx / W;
    let py = start.posY + dy / H;
    const snapX = !ev.altKey && Math.abs(px * W) < 6;
    const snapY = !ev.altKey && Math.abs(py * H) < 6;
    if (snapX) px = 0;
    if (snapY) py = 0;
    showGuides(snapX, snapY);
    kset(c, 'clip', { posX: Number(clamp(px, -2, 2).toFixed(4)), posY: Number(clamp(py, -2, 2).toFixed(4)) });
    afterStageEdit();
  };
  const up = () => {
    st.removeEventListener('pointermove', move);
    st.removeEventListener('pointerup', up);
    st.removeEventListener('pointercancel', up);
    st.classList.remove('panning');
    showGuides(false, false);
    if (changed) { pushHistory(before); renderTimeline(); renderInspector(); }
  };
  st.addEventListener('pointermove', move);
  st.addEventListener('pointerup', up);
  st.addEventListener('pointercancel', up);
});

// The selected main video's outline on the preview, with corner handles to resize it
// and a round handle to turn it.
let boxKey = '';
let boxGeom = null;
function updateClipBox() {
  const svg = $('#clipBox');
  const s = state.selected;
  const c = s && s.kind === 'clip' && selection.length < 2 ? itemOf(s) : null;
  const show = Boolean(c && c === stageClip() && !state.playing && !trackPick);
  if (!show) { svg.setAttribute('hidden', ''); boxKey = ''; boxGeom = null; return; }
  const wrap = $('#stageWrap').getBoundingClientRect();
  const st = $('#stage').getBoundingClientRect();
  const W = st.width;
  const H = st.height;
  const v = valuesNow('clip', c);
  const key = [W, H, st.left - wrap.left, st.top - wrap.top, v.zoom, v.posX, v.posY, v.rotate, c.flipH, c.flipV, JSON.stringify(c.crop || {}), c.id].join('|');
  svg.removeAttribute('hidden');
  if (key === boxKey) return;
  boxKey = key;
  const b = pictureBox(mediaById(c.mediaId));
  const cr = c.crop || {};
  let x0 = -b.w * W / 2 + (cr.l || 0) * b.w * W;
  let x1 = b.w * W / 2 - (cr.r || 0) * b.w * W;
  let y0 = -b.h * H / 2 + (cr.t || 0) * b.h * H;
  let y1 = b.h * H / 2 - (cr.b || 0) * b.h * H;
  if (c.flipH) [x0, x1] = [-x1, -x0];
  if (c.flipV) [y0, y1] = [-y1, -y0];
  const r = v.rotate * Math.PI / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  // Centre of the canvas in the wrap's coordinates, then where the picture's centre has moved to.
  const cx = st.left - wrap.left + W / 2 + v.posX * W;
  const cy = st.top - wrap.top + H / 2 + v.posY * H;
  const map = (x, y) => [cx + v.zoom * (x * cos - y * sin), cy + v.zoom * (x * sin + y * cos)];
  const pts = [map(x0, y0), map(x1, y0), map(x1, y1), map(x0, y1)];
  $('#cbFrame').setAttribute('points', pts.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' '));
  svg.querySelectorAll('.cb-h').forEach((el, i) => { el.setAttribute('cx', pts[i][0].toFixed(1)); el.setAttribute('cy', pts[i][1].toFixed(1)); });
  const top = map((x0 + x1) / 2, y0);
  const rot = [top[0] + 26 * sin, top[1] - 26 * cos];
  $('#cbRot').setAttribute('cx', rot[0].toFixed(1));
  $('#cbRot').setAttribute('cy', rot[1].toFixed(1));
  const stem = $('#cbStem');
  stem.setAttribute('x1', top[0].toFixed(1)); stem.setAttribute('y1', top[1].toFixed(1));
  stem.setAttribute('x2', rot[0].toFixed(1)); stem.setAttribute('y2', rot[1].toFixed(1));
  const gx = $('#guideX');
  const gy = $('#guideY');
  const mx = st.left - wrap.left + W / 2;
  const my = st.top - wrap.top + H / 2;
  gx.setAttribute('x1', mx); gx.setAttribute('x2', mx); gx.setAttribute('y1', st.top - wrap.top); gx.setAttribute('y2', st.top - wrap.top + H);
  gy.setAttribute('y1', my); gy.setAttribute('y2', my); gy.setAttribute('x1', st.left - wrap.left); gy.setAttribute('x2', st.left - wrap.left + W);
  boxGeom = { c, wrap, cx, cy };
}
function showGuides(x, y) { $('#guideX').toggleAttribute('hidden', !x); $('#guideY').toggleAttribute('hidden', !y); }

// Corner handles resize about the picture's centre; the round handle turns it.
$('#clipBox').addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.cb-h, .cb-rot');
  if (!handle || !boxGeom || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const c = boxGeom.c;
  const wrap = $('#stageWrap').getBoundingClientRect();
  const C = [wrap.left + boxGeom.cx, wrap.top + boxGeom.cy];
  const start = valuesNow('clip', c);
  const d0 = Math.hypot(e.clientX - C[0], e.clientY - C[1]) || 1;
  const a0 = Math.atan2(e.clientY - C[1], e.clientX - C[0]);
  const turning = handle.classList.contains('cb-rot');
  const before = snapshot();
  let changed = false;
  handle.setPointerCapture(e.pointerId);
  const move = (ev) => {
    changed = true;
    if (turning) {
      let deg = start.rotate + (Math.atan2(ev.clientY - C[1], ev.clientX - C[0]) - a0) * 180 / Math.PI;
      deg = ((deg + 540) % 360) - 180;
      if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
      else { const q = Math.round(deg / 90) * 90; if (Math.abs(deg - q) < 4) deg = q; }
      kset(c, 'clip', { rotate: Number((((deg + 540) % 360) - 180).toFixed(2)) });
    } else {
      const z = clamp(start.zoom * Math.hypot(ev.clientX - C[0], ev.clientY - C[1]) / d0, MIN_ZOOM, MAX_ZOOM);
      kset(c, 'clip', { zoom: Number(z.toFixed(4)) });
    }
    afterStageEdit();
  };
  const up = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
    if (changed) { pushHistory(before); renderTimeline(); renderInspector(); }
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
});
new ResizeObserver(() => { boxKey = ''; updateClipBox(); }).observe($('#stageWrap'));

let hudKey = '';
function updateZoomHud() {
  updateClipBox();
  const s = state.selected;
  const c = s && s.kind === 'clip' && selection.length < 2 ? itemOf(s) : null;
  const show = Boolean(c && c === stageClip() && !state.playing);
  const hud = $('#zoomHud');
  const z = show ? valuesNow('clip', c).zoom : 1;
  const vv = show ? valuesNow('clip', c) : null;
  const key = `${show}|${z.toFixed(3)}|${vv ? `${vv.posX}|${vv.posY}|${vv.rotate}` : ''}`;
  if (key === hudKey) return;
  hudKey = key;
  hud.hidden = !show;
  $('#stage').classList.toggle('clip-grab', show);
  if (!show) return;
  const v = valuesNow('clip', c);
  const moved = Math.abs(v.zoom - 1) > 1e-4 || v.posX || v.posY || v.rotate;
  $('#zhVal').textContent = `${Math.round(z * 100)}%`;
  $('#zhOut').disabled = z <= MIN_ZOOM + 1e-3;
  $('#zhIn').disabled = z >= MAX_ZOOM - 1e-3;
  $('#zhReset').disabled = !moved;
}
const hudZoom = (f) => { const c = grabStageClip(); if (!c) return; commit(); zoomClipAbout(c, valuesNow('clip', c).zoom * f); };
$('#zhIn').addEventListener('click', () => hudZoom(1.25));
$('#zhOut').addEventListener('click', () => hudZoom(1 / 1.25));
$('#zhReset').addEventListener('click', () => {
  const c = grabStageClip();
  if (!c) return;
  commit();
  kset(c, 'clip', { zoom: 1, posX: 0, posY: 0, rotate: 0 });
  afterStageEdit();
});

// Both follow the playhead and the selection.
const _updatePlayheadUI = updatePlayheadUI;
updatePlayheadUI = function updatePlayheadUIWithBars() { _updatePlayheadUI(); updateKfBar(); updateZoomHud(); };
const _refreshSelectionUI = refreshSelectionUI;
refreshSelectionUI = function refreshSelectionUIWithBars() { _refreshSelectionUI(); updateKfBar(); updateZoomHud(); };
updateKfBar();

// ---------- motion tracking: draw a box round something in the video, and a sticker, text or
// overlay follows it. The tracking runs on the original file; the path is turned into keyframes.

const TRACK_PROPS = { overlay: ['x', 'y', 'w'], sticker: ['x', 'y', 'size'], text: ['dx', 'dy', 'scale'] };
let trackFollowSize = (() => { try { return localStorage.getItem('snippy.trackSize') !== '0'; } catch { return true; } })();

// A point of the source picture (shares of it) → where it shows on the canvas (shares), at clip time u.
function srcToStage(c, u, sx, sy) {
  const [W, H] = ASPECTS[state.aspect];
  const b = pictureBox(mediaById(c.mediaId));
  const v = kfValue(c, 'clip', u);
  let x = (sx - 0.5) * b.w * W;
  let y = (sy - 0.5) * b.h * H;
  if (c.flipH) x = -x;
  if (c.flipV) y = -y;
  const r = (v.rotate * Math.PI) / 180;
  const X = v.posX * W + v.zoom * (x * Math.cos(r) - y * Math.sin(r));
  const Y = v.posY * H + v.zoom * (x * Math.sin(r) + y * Math.cos(r));
  return { x: X / W + 0.5, y: Y / H + 0.5, z: v.zoom };
}
// And back: a canvas point (shares) → the source picture (shares).
function stageToSrc(c, u, px, py) {
  const [W, H] = ASPECTS[state.aspect];
  const b = pictureBox(mediaById(c.mediaId));
  const v = kfValue(c, 'clip', u);
  const X = (px - 0.5 - v.posX) * W / v.zoom;
  const Y = (py - 0.5 - v.posY) * H / v.zoom;
  const r = (-v.rotate * Math.PI) / 180;
  let x = X * Math.cos(r) - Y * Math.sin(r);
  let y = X * Math.sin(r) + Y * Math.cos(r);
  if (c.flipH) x = -x;
  if (c.flipV) y = -y;
  return { x: x / (b.w * W) + 0.5, y: y / (b.h * H) + 0.5, zoom: v.zoom, bw: b.w, bh: b.h };
}

function trackSection(item, kind) {
  return section('Motion tracking',
    h('button', { class: 'btn', onClick: () => startTrackPick(item, kind) }, '⌖ Track motion…'),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: trackFollowSize ? '' : null, onChange: (e) => { trackFollowSize = e.target.checked; try { localStorage.setItem('snippy.trackSize', trackFollowSize ? '1' : '0'); } catch { /* not kept */ } } }),
      ' Grow and shrink with it too'),
    h('p', { class: 'hint' }, 'Draw a box round something in the video (a face, a ball, a car) and this follows it from the playhead to the end. Works best on things with clear detail.'));
}

function startTrackPick(item, kind) {
  if (state.playing) pause();
  if (kind === 'clipmask') {
    // A mask follows something in its own clip: from the playhead (if it's in the clip) to the clip's end.
    const i = state.clips.indexOf(item);
    const st = clipStarts()[i];
    if (state.playhead < st || state.playhead >= st + clipLen(item) - 0.05) seek(st + 0.01);
  } else {
    const end = itemEnd(kind, item);
    if (state.playhead < item.start || state.playhead >= end - 0.05) seek(item.start);
  }
  const loc = state.clips.length ? locate(state.playhead) : null;
  const c = loc && loc.clip;
  const m = c && mediaById(c.mediaId);
  if (!c || state.playhead >= loc.start + clipLen(c)) { toast('There\'s no video under this item to follow'); return; }
  if (isImage(m)) { toast('That part of the video is a photo, so there\'s nothing moving to follow'); return; }
  if (c.mode || c.ramp || c.stab) { toast('Motion tracking works on clips playing normally. Turn off reverse, speed curves and stabilise for this clip first.'); return; }
  trackPick = { item, kind, clip: c, loc };
  boxKey = '';
  updateClipBox();
  const wrap = $('#stageWrap');
  const banner = h('div', { class: 'track-banner', id: 'trackBanner' },
    h('b', {}, 'Drag a box round what to follow'),
    h('span', {}, 'Esc to cancel'),
    h('button', { class: 'btn', onClick: endTrackPick }, 'Cancel'));
  wrap.append(banner);
  $('#stage').classList.add('picking-track');
}

function endTrackPick() {
  trackPick = null;
  $('#stage').classList.remove('picking-track');
  for (const id of ['trackBanner', 'trackRect']) { const el = document.getElementById(id); if (el) el.remove(); }
  boxKey = '';
  updateClipBox();
}

document.addEventListener('keydown', (e) => {
  if (trackPick && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); endTrackPick(); }
}, true);

// Drawing the box (this runs before the preview's other click handlers while picking).
document.addEventListener('pointerdown', (e) => {
  if (!trackPick || e.button !== 0 || !e.target.closest('#stage')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const st = $('#stage').getBoundingClientRect();
  const wrap = $('#stageWrap').getBoundingClientRect();
  const sx = clamp(e.clientX, st.left, st.right);
  const sy = clamp(e.clientY, st.top, st.bottom);
  const rect = h('div', { class: 'track-rect', id: 'trackRect' });
  $('#stageWrap').append(rect);
  let box = null;
  const move = (ev) => {
    const x = clamp(ev.clientX, st.left, st.right);
    const y = clamp(ev.clientY, st.top, st.bottom);
    box = { l: Math.min(sx, x), t: Math.min(sy, y), r: Math.max(sx, x), b: Math.max(sy, y) };
    Object.assign(rect.style, { left: `${box.l - wrap.left}px`, top: `${box.t - wrap.top}px`, width: `${box.r - box.l}px`, height: `${box.b - box.t}px` });
  };
  const up = () => {
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', up, true);
    if (!box || box.r - box.l < 8 || box.b - box.t < 8) { rect.remove(); toast('Drag a bigger box round the thing to follow'); return; }
    runTracking({ l: (box.l - st.left) / st.width, t: (box.t - st.top) / st.height, r: (box.r - st.left) / st.width, b: (box.b - st.top) / st.height });
  };
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', up, true);
}, true);

async function runTracking(sbox) {
  const { item, kind, clip: c, loc } = trackPick;
  endTrackPick();
  const m = mediaById(c.mediaId);
  const uClip0 = state.playhead - loc.start;
  // The box in the source picture.
  const centre = stageToSrc(c, uClip0, (sbox.l + sbox.r) / 2, (sbox.t + sbox.b) / 2);
  const bw = (sbox.r - sbox.l) / (centre.zoom * centre.bw);
  const bh = (sbox.b - sbox.t) / (centre.zoom * centre.bh);
  const box = { x: clamp(centre.x - bw / 2, 0, 1), y: clamp(centre.y - bh / 2, 0, 1), w: Math.min(1, bw), h: Math.min(1, bh) };
  if (centre.x < 0 || centre.x > 1 || centre.y < 0 || centre.y > 1) { toast('Draw the box on the video picture itself'); return; }
  const tEnd = kind === 'clipmask' ? loc.start + clipLen(c) : Math.min(itemEnd(kind, item), loc.start + clipLen(c));
  const a = loc.src;
  const b = c.in + srcOff(c, tEnd - loc.start);
  if (b - a < 0.2) { toast('There\'s too little time left in this clip to follow anything'); return; }
  const id = `trk${Date.now()}`;
  let cancelled = false;
  const win = jobWindow('Following it through the video', () => { cancelled = true; window.api.cancelTrack(); });
  const off = window.api.onTrackProgress((p) => { if (p.id === id) win.update(`${Math.round(p.progress * 100)}%`, p.progress); });
  let r;
  try {
    r = await window.api.trackMotion(m.path, a, b, box, m.width, m.height, id);
  } catch (err) {
    if (!cancelled) toast(`Couldn't track: ${cleanError(err)}`);
    return;
  } finally {
    off();
    win.close();
  }
  if (!r || r.points.length < 2) { toast('Couldn\'t follow that. Try a box round something with more detail.'); return; }
  applyTrack(item, kind, c, loc.start, r, uClip0);
}

// Turns a tracked path into steady-paced keyframes on the item, keeping its offset from the target.
function applyTrack(item, kind, c, clipStart, r, uClip0) {
  const sp = spd(c);
  const toTl = (srcT) => clipStart + (srcT - c.in) / sp;
  if (kind === 'clipmask') { applyMaskTrack(c, clipStart, r, toTl); return; }
  const path = r.points.map((p) => {
    const tl = toTl(p.t);
    const st = srcToStage(c, tl - clipStart, p.x, p.y);
    return { t: tl - item.start, x: st.x, y: st.y, s: p.s * st.z };
  });
  const thin = window.thinTrackPath ? window.thinTrackPath(path) : thinPathLocal(path);
  const [px, py, ps] = TRACK_PROPS[kind];
  const u0 = thin[0].t;
  const v0 = kfValue(item, kind, u0);
  const T0 = thin[0];
  const s0 = path[0].s;
  commit();
  const span = [u0 - 1 / 60, thin[thin.length - 1].t + 1 / 60];
  const kept = (item.keys || []).filter((k) => k.t < span[0] || k.t > span[1]);
  const made = thin.map((p, i) => {
    const k = { t: Number(p.t.toFixed(4)), ...kfValue(item, kind, p.t) };
    k[px] = Number((v0[px] + (kind === 'text' ? p.x - T0.x : p.x - T0.x)).toFixed(5));
    k[py] = Number((v0[py] + (p.y - T0.y)).toFixed(5));
    if (trackFollowSize) k[ps] = Number((v0[ps] * (p.s / s0)).toFixed(5));
    if (i < thin.length - 1) k.lin = true;
    return k;
  });
  item.keys = [...kept, ...made].sort((x, y) => x.t - y.t);
  refreshKeyed();
  syncOverlays(true);
  const secs = (thin[thin.length - 1].t - u0).toFixed(1);
  toast(r.lost
    ? `Lost it after ${secs} s, so it follows up to there. Try again from that point with a new box.`
    : `Following for ${secs} s (${made.length} keyframes). Play it to check.`);
}

// A mask follows the path exactly (it lives in the picture's own frame, like the tracker's answer).
function applyMaskTrack(c, clipStart, r, toTl) {
  const path = r.points.map((p) => ({ t: toTl(p.t) - clipStart, x: p.x, y: p.y, s: p.s }));
  const thin = thinPathLocal(path, 0.0015);
  const u0 = thin[0].t;
  const ms0 = kfValue(c, 'clip', u0).ms;
  commit();
  const span = [u0 - 1 / 60, thin[thin.length - 1].t + 1 / 60];
  const kept = (c.keys || []).filter((k) => k.t < span[0] || k.t > span[1]);
  const made = thin.map((p, i) => {
    const k = { t: Number(p.t.toFixed(4)), ...kfValue(c, 'clip', p.t), mx: Number(p.x.toFixed(5)), my: Number(p.y.toFixed(5)) };
    if (trackFollowSize) k.ms = Number((ms0 * p.s / path[0].s).toFixed(5));
    if (i < thin.length - 1) k.lin = true;
    return k;
  });
  c.keys = [...kept, ...made].sort((x, y) => x.t - y.t);
  maskCssKey = '';
  refreshKeyed();
  toast(r.lost ? `Lost it after ${(thin[thin.length - 1].t - u0).toFixed(1)} s, so the mask follows up to there` : `The mask follows it for ${(thin[thin.length - 1].t - u0).toFixed(1)} s`);
}

// Same thinning as the tracker uses, for the editor (shares of the canvas).
function thinPathLocal(points, tol = 0.002) {
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
      const e = Math.max(Math.abs(points[k].x - (a.x + (b.x - a.x) * q)), Math.abs(points[k].y - (a.y + (b.y - a.y) * q)), Math.abs(points[k].s - (a.s + (b.s - a.s) * q)) * 0.05);
      if (e > worst) { worst = e; at = k; }
    }
    if (worst > tol && at > 0) { keep[at] = true; stack.push([i, at], [at, j]); }
  }
  return points.filter((_, k) => keep[k]);
}

// ---------- blur and pixelate boxes (stickers with an effect instead of a picture). They follow
// keyframes and motion tracking like any sticker. The preview blurs what's under them with a
// backdrop filter; the export blurs the whole frame and lets it through a mask drawn from the boxes.

const FX_BOXES = [
  ['Blur box', { type: 'blur', shape: 'rect', amount: 0.5, feather: 0.25, ar: 1.4 }],
  ['Blur circle', { type: 'blur', shape: 'ellipse', amount: 0.5, feather: 0.35, ar: 0.8 }],
  ['Pixelate', { type: 'pixel', shape: 'rect', amount: 0.5, feather: 0, ar: 1.4 }],
];
const fxSigma = (amount, H) => Math.max(1, amount * 0.05 * H);
const fxBlock = (amount, H) => Math.max(2, Math.round((amount * 0.07 * H) / 2) * 2);

function pixFilter(block) {
  const id = `pix${block}`;
  if (!document.getElementById(id)) {
    const half = block / 2;
    const f = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
    f.id = id;
    for (const [k, v] of [['x', '0'], ['y', '0'], ['width', '1'], ['height', '1']]) f.setAttribute(k, v);
    f.innerHTML = `<feFlood x="${half - 1}" y="${half - 1}" width="2" height="2"/><feComposite width="${block}" height="${block}"/><feTile result="a"/>` +
      `<feComposite in="SourceGraphic" in2="a" operator="in"/><feMorphology operator="dilate" radius="${half}"/>`;
    $('#pixDefs').append(f);
  }
  return `url(#${id})`;
}

// Soft edges as a CSS mask (feather is a share of the box's smaller side).
function fxMaskCss(e, w, hgt) {
  const f = Math.max(0, Math.min(0.5, e.feather || 0));
  if (e.shape === 'ellipse') return `radial-gradient(closest-side, #000 ${Math.round((1 - f) * 100)}%, transparent 100%)`;
  if (!f) return 'none';
  const px = f * Math.min(w, hgt);
  return `linear-gradient(to right, transparent, #000 ${px}px, #000 calc(100% - ${px}px), transparent), linear-gradient(to bottom, transparent, #000 ${px}px, #000 calc(100% - ${px}px), transparent)`;
}

const fxBoxEls = new Map();
function updateFxBoxes() {
  const layer = $('#fxBoxLayer');
  const H = $('#stage').clientHeight;
  const t = state.playhead;
  const live = new Set();
  for (const s of state.stickers) {
    if (!s.effect || t < s.start || t >= s.start + s.dur) continue;
    live.add(s.id);
    let el = fxBoxEls.get(s.id);
    if (!el) { el = h('div', { class: 'fx-box' }); layer.append(el); fxBoxEls.set(s.id, el); }
    const v = kfValue(s, 'sticker', t - s.start);
    const e = s.effect;
    const hgt = v.size * H;
    const w = hgt * (e.ar || 1.4);
    Object.assign(el.style, {
      left: `${v.x * 100}%`, top: `${v.y * 100}%`, width: `${w}px`, height: `${hgt}px`,
      transform: `translate(-50%, -50%) rotate(${v.rotate || 0}deg)`,
      borderRadius: e.shape === 'ellipse' && !(e.feather > 0) ? '50%' : '0',
    });
    const bf = e.type === 'pixel' ? pixFilter(fxBlock(e.amount, H)) : `blur(${fxSigma(e.amount, H).toFixed(1)}px)`;
    el.style.backdropFilter = bf;
    el.style.webkitBackdropFilter = bf;
    const mask = fxMaskCss(e, w, hgt);
    el.style.webkitMaskImage = mask;
    el.style.maskImage = mask;
    el.style.webkitMaskComposite = 'source-in';
    el.style.maskComposite = 'intersect';
  }
  for (const [id, el] of fxBoxEls) if (!live.has(id)) { el.remove(); fxBoxEls.delete(id); }
}
const _syncStickerHits = syncStickerHits;
syncStickerHits = function syncStickerHitsAndBoxes() { _syncStickerHits(); updateFxBoxes(); };

// The export's masks: white where each kind of box is, soft at the edges, black elsewhere.
function drawFxMask(ctx, W, H, boxes, t) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  for (const s of boxes) {
    if (t < s.start || t >= s.start + s.dur) continue;
    const v = kfValue(s, 'sticker', t - s.start);
    const e = s.effect;
    const hgt = v.size * H;
    const w = hgt * (e.ar || 1.4);
    const f = Math.max(0, Math.min(0.5, e.feather || 0)) * Math.min(w, hgt);
    ctx.save();
    ctx.translate(v.x * W, v.y * H);
    ctx.rotate(((v.rotate || 0) * Math.PI) / 180);
    // A blurred shape, shrunk so the soft edge ends at the box's edge, like the preview's mask.
    ctx.filter = f > 0.5 ? `blur(${(f / 2.5).toFixed(2)}px)` : 'none';
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    if (e.shape === 'ellipse') ctx.ellipse(0, 0, Math.max(1, w / 2 - f / 2), Math.max(1, hgt / 2 - f / 2), 0, 0, Math.PI * 2);
    else ctx.rect(-w / 2 + f / 2, -hgt / 2 + f / 2, Math.max(1, w - f), Math.max(1, hgt - f));
    ctx.fill();
    ctx.restore();
  }
}

async function renderFxMasks(total, W, H, fps) {
  const out = {};
  for (const type of ['blur', 'pixel']) {
    const boxes = state.stickers.filter((s) => s.effect && s.effect.type === type && s.start < total);
    if (!boxes.length) continue;
    const snap = (v) => Math.round(v * fps) / fps;
    const pts = new Set([0, snap(total)]);
    for (const s of boxes) {
      pts.add(snap(s.start));
      pts.add(snap(s.start + s.dur));
      if (hasMotion(s)) for (let k = 1; k <= Math.ceil(s.dur * fps); k++) pts.add(snap(s.start + k / fps));
    }
    const times = [...pts].filter((p) => p >= 0 && p <= snap(total)).sort((a, b) => a - b);
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    const images = [];
    const known = new Map();
    const frames = [];
    for (let i = 0; i < times.length - 1; i++) {
      const a = times[i];
      const dur = times[i + 1] - a;
      if (dur <= 0) continue;
      drawFxMask(ctx, W, H, boxes, a + 0.25 / fps);
      const url = cv.toDataURL('image/png');
      let k = known.get(url);
      if (k === undefined) { k = images.length; images.push(url); known.set(url, k); }
      const last = frames[frames.length - 1];
      if (last && last.img === k) last.dur += dur;
      else frames.push({ img: k, dur });
      if (i % 25 === 0) await new Promise((r) => setTimeout(r));
    }
    // The strongest box of each kind sets the strength for that kind.
    const amount = Math.max(...boxes.map((s) => s.effect.amount || 0.5));
    out[type] = { images, frames, sigma: Number(fxSigma(amount, H).toFixed(2)), block: fxBlock(amount, H) };
  }
  return Object.keys(out).length ? out : null;
}

function fxSections(s) {
  const e = s.effect;
  const redraw = () => { updateFxBoxes(); syncStickerHits(); };
  const seg = (title, options, cur, set) => section(title, h('div', { class: 'seg', role: 'group', 'aria-label': title },
    ...options.map(([v, label]) => h('button', {
      'aria-pressed': String(cur === v),
      onClick: () => { if (cur === v) return; commit(); set(v); redraw(); renderInspector(); renderTimeline(); },
    }, label))));
  return [
    seg('Hide with', [['blur', 'Blur'], ['pixel', 'Pixelate']], e.type, (v) => { e.type = v; }),
    seg('Shape', [['rect', 'Box'], ['ellipse', 'Circle']], e.shape, (v) => { e.shape = v; }),
    sliderSection('Strength', { min: 0.1, max: 1, step: 0.01, value: e.amount, format: (v) => `${Math.round(v * 100)}%`, key: `${s.id}:fxa`, onValue: (v) => { e.amount = v; redraw(); } }),
    sliderSection('Soft edges', { min: 0, max: 0.5, step: 0.01, value: e.feather || 0, format: (v) => `${Math.round(v * 200)}%`, key: `${s.id}:fxf`, onValue: (v) => { e.feather = v; redraw(); } }),
    sliderSection('Width', { min: 0.3, max: 4, step: 0.01, value: e.ar || 1.4, format: (v) => `${v.toFixed(2)}×`, key: `${s.id}:fxw`, onValue: (v) => { e.ar = v; redraw(); } }),
    h('p', { class: 'hint' }, 'Use Track motion (Motion tab) to keep a face or number plate hidden as it moves. With several boxes, the strongest setting of each kind is used for all of that kind.'),
  ];
}

// ---------- edit by text: the captions' words as a transcript. Deleting words cuts that
// stretch out of the video, and everything after moves up to close the gap.

const tx = { words: [], anchor: -1, focus: -1, flagged: new Set(), dragging: false };
const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'ahh', 'hmm', 'hm', 'mm', 'mmm', 'eh']);
const normWord = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

// Every caption word in timeline order, with its time on the timeline.
function transcriptWords() {
  const out = [];
  const caps = state.texts.filter((x) => x.words && x.words.length && x.text.trim()).sort((a, b) => a.start - b.start);
  for (const x of caps) {
    x.words.forEach((w, i) => {
      const next = x.words[i + 1];
      const s = x.start + w.s;
      const e = x.start + (w.e != null ? w.e : next ? next.s : x.dur);
      out.push({ text: w.text.trim(), s, e: Math.max(s + 0.04, e), cap: x.id, idx: i });
    });
  }
  return out;
}

// Sits over the settings panel, so the preview and timeline stay in view.
function placeTranscript() {
  const r = $('#inspector').getBoundingClientRect();
  const p = $('#txPanel');
  const w = Math.max(r.width, 380);
  Object.assign(p.style, { top: `${r.top}px`, height: `${r.height}px`, bottom: 'auto', right: `${Math.max(8, window.innerWidth - r.right)}px`, width: `${w}px` });
}
window.addEventListener('resize', () => { if (!$('#txPanel').hidden) placeTranscript(); });

function openTranscript() {
  closeSmart();
  $('#txPanel').hidden = false;
  placeTranscript();
  tx.anchor = -1;
  tx.focus = -1;
  tx.flagged = new Set();
  renderTranscript();
  $('#txBody').focus();
}
function closeTranscript() { $('#txPanel').hidden = true; }

function renderTranscript() {
  tx.words = transcriptWords();
  const body = $('#txBody');
  body.textContent = '';
  $('#txFind').disabled = !tx.words.length;
  if (!tx.words.length) {
    body.append(h('div', { class: 'tx-empty' },
      h('p', {}, 'There\'s no transcript yet. Make auto captions first: Snippy writes down what\'s said, word by word, and the words show here.'),
      h('button', { class: 'btn primary', onClick: () => { closeTranscript(); openCaptions(); } }, 'Make auto captions')));
    updateTxButtons();
    return;
  }
  let para = null;
  let lastCap = null;
  tx.words.forEach((w, i) => {
    if (w.cap !== lastCap) {
      para = h('p', { class: 'tx-para' }, h('span', { class: 'tx-time' }, fmt(w.s)));
      body.append(para);
      lastCap = w.cap;
    }
    para.append(h('span', { class: `tx-w${tx.flagged.has(i) ? ' flag' : ''}`, 'data-i': String(i) }, w.text), ' ');
  });
  paintTxSelection();
  updateTxButtons();
}

const txRange = () => (tx.anchor < 0 ? null : [Math.min(tx.anchor, tx.focus), Math.max(tx.anchor, tx.focus)]);
function paintTxSelection() {
  const r = txRange();
  for (const el of $('#txBody').querySelectorAll('.tx-w')) {
    const i = Number(el.dataset.i);
    el.classList.toggle('sel', Boolean(r && i >= r[0] && i <= r[1]));
  }
}
function updateTxButtons() {
  const r = txRange();
  const n = r ? r[1] - r[0] + 1 : 0;
  $('#txCut').disabled = !n;
  $('#txCut').textContent = n > 1 ? `Cut ${n} words` : 'Cut selected';
  const f = tx.flagged.size;
  $('#txCutFill').hidden = !f;
  $('#txCutFill').textContent = `Cut ${f} highlighted`;
}

// Live highlight of the word being said.
function markTxNow() {
  if ($('#txPanel').hidden) return;
  const t = state.playhead;
  const i = tx.words.findIndex((w) => t >= w.s && t < w.e);
  const prev = $('#txBody').querySelector('.tx-w.now');
  if (prev && Number(prev.dataset.i) === i) return;
  if (prev) prev.classList.remove('now');
  const el = i >= 0 ? $('#txBody').querySelector(`.tx-w[data-i="${i}"]`) : null;
  if (el) { el.classList.add('now'); if (state.playing) el.scrollIntoView({ block: 'nearest' }); }
}
const _updatePlayheadUIForTx = updatePlayheadUI;
updatePlayheadUI = function updatePlayheadUIWithTranscript() { _updatePlayheadUIForTx(); markTxNow(); };

$('#txBody').addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.tx-w');
  if (!el || e.button !== 0) return;
  e.preventDefault();
  $('#txBody').focus();
  const i = Number(el.dataset.i);
  if (e.shiftKey && tx.anchor >= 0) tx.focus = i;
  else { tx.anchor = i; tx.focus = i; }
  tx.dragging = true;
  if (state.playing) pause();
  seek(tx.words[i].s);
  paintTxSelection();
  updateTxButtons();
});
$('#txBody').addEventListener('pointerover', (e) => {
  if (!tx.dragging) return;
  const el = e.target.closest('.tx-w');
  if (!el) return;
  tx.focus = Number(el.dataset.i);
  paintTxSelection();
  updateTxButtons();
});
document.addEventListener('pointerup', () => { tx.dragging = false; });
$('#txBody').addEventListener('keydown', (e) => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && txRange()) { e.preventDefault(); e.stopPropagation(); txCutSelected(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeTranscript(); }
  else if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); togglePlay(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) redo(); else undo(); renderTranscript(); }
});

// The stretch of time to cut for a run of words: the words themselves plus half the gap on each
// side (at most 0.15 s), so what's left joins up naturally.
function wordRunRange(i, j) {
  const W = tx.words;
  const before = i > 0 ? Math.max(0, W[i].s - W[i - 1].e) : 0.15;
  const after = j < W.length - 1 ? Math.max(0, W[j + 1].s - W[j].e) : 0.15;
  return { a: W[i].s - Math.min(0.15, before / 2), b: W[j].e + Math.min(0.15, after / 2) };
}

function runsOf(indices) {
  const sorted = [...indices].sort((a, b) => a - b);
  const runs = [];
  for (const i of sorted) {
    const last = runs[runs.length - 1];
    if (last && i === last[1] + 1) last[1] = i;
    else runs.push([i, i]);
  }
  return runs;
}

function txCutSelected() {
  const r = txRange();
  if (!r) return;
  const n = r[1] - r[0] + 1;
  if (cutTimeline([wordRunRange(r[0], r[1])], 'transcript')) toast(`Cut ${n} word${n === 1 ? '' : 's'}. Ctrl+Z puts ${n === 1 ? 'it' : 'them'} back.`);
  tx.anchor = -1;
  tx.focus = -1;
  tx.flagged = new Set();
  renderTranscript();
}

function txFindFillers() {
  const W = tx.words;
  const flagged = new Set();
  for (let i = 0; i < W.length; i++) {
    const w = normWord(W[i].text);
    if (FILLERS.has(w)) flagged.add(i);
    // A word said twice in a row ("I I think"): the first one goes.
    if (i + 1 < W.length && w && w === normWord(W[i + 1].text) && W[i + 1].s - W[i].e < 0.6) flagged.add(i);
    // Two words said twice ("I think I think").
    if (i + 3 < W.length && w && w === normWord(W[i + 2].text) && normWord(W[i + 1].text) === normWord(W[i + 3].text) && normWord(W[i + 1].text)) { flagged.add(i); flagged.add(i + 1); }
  }
  tx.flagged = flagged;
  renderTranscript();
  toast(flagged.size ? `Found ${flagged.size} filler or repeated word${flagged.size === 1 ? '' : 's'} (highlighted)` : 'No filler words or repeats found. (The speech model sometimes leaves out "um"s as it writes.)');
}

function txCutFlagged() {
  if (!tx.flagged.size) return;
  const ranges = runsOf(tx.flagged).map(([i, j]) => wordRunRange(i, j));
  const n = tx.flagged.size;
  if (cutTimeline(ranges, 'transcript')) toast(`Cut ${n} word${n === 1 ? '' : 's'}. Ctrl+Z puts them back.`);
  tx.flagged = new Set();
  tx.anchor = -1;
  tx.focus = -1;
  renderTranscript();
}

$('#txBtn').addEventListener('click', openTranscript);
$('#txClose').addEventListener('click', closeTranscript);
$('#txCut').addEventListener('click', txCutSelected);
$('#txFind').addEventListener('click', txFindFillers);
$('#txCutFill').addEventListener('click', txCutFlagged);

// Cuts stretches of the timeline ([{ a, b }] in timeline seconds) out of the clips, then moves
// everything after each cut up. Caption words inside a cut are removed from their captions.
// Clips played backwards or on a speed curve are left alone. Returns whether anything was cut.
function cutTimeline(ranges) {
  const merged = [];
  for (const r of [...ranges].filter((x) => x.b - x.a > 0.01).sort((x, y) => x.a - y.a)) {
    const last = merged[merged.length - 1];
    if (last && r.a <= last.b + 0.01) last.b = Math.max(last.b, r.b);
    else merged.push({ ...r });
  }
  if (!merged.length) return false;
  const starts = clipStarts();
  const out = [];
  const removed = [];
  let skipped = 0;
  const before = snapshot();
  state.clips.forEach((c, i) => {
    const st = starts[i];
    const en = st + clipLen(c);
    const mine = merged.filter((r) => r.b > st + 1e-4 && r.a < en - 1e-4).map((r) => ({ a: Math.max(r.a, st), b: Math.min(r.b, en) }));
    if (!mine.length) { out.push(c); return; }
    if (c.mode || c.ramp) { skipped++; out.push(c); return; }
    const sp = spd(c);
    const src = (t) => c.in + (t - st) * sp;
    const keep = [];
    let t = c.in;
    for (const r of mine) {
      const s = src(r.a);
      const e = src(r.b);
      if (s > t + 0.02) keep.push({ s: t, e: s });
      t = Math.max(t, e);
      removed.push(r);
    }
    if (c.out > t + 0.02) keep.push({ s: t, e: c.out });
    keep.forEach((k, j) => {
      const piece = JSON.parse(JSON.stringify(c));
      piece.id = j === 0 ? c.id : newId('c');
      piece.in = k.s;
      piece.out = k.e;
      if (j > 0) { delete piece.transition; delete piece.transitionType; delete piece.transitionDir; }
      if (j < keep.length - 1) delete piece.endFade;
      if (c.keys) piece.keys = c.keys.map((kf) => ({ ...kf, t: kf.t - (k.s - c.in) / sp }));
      out.push(piece);
    });
  });
  if (!removed.length) { if (skipped) toast('Those words are in a clip played backwards or on a speed curve, so they can\'t be cut here'); return false; }
  pushHistory(before);
  removed.sort((x, y) => x.a - y.a);
  state.clips = out;
  const inCut = (t) => removed.some((r) => t > r.a + 1e-4 && t < r.b - 1e-4);
  const R = (t) => rippleTime(t, removed);
  for (const x of state.texts) {
    if (x.words && x.words.length) {
      const textWords = captionWords({ ...x, caps: false }).flat();
      const matched = textWords.length === x.words.length;
      const kept = x.words.filter((w) => !inCut(x.start + ((w.s + (w.e ?? w.s)) / 2)));
      if (kept.length !== x.words.length) {
        const a = R(x.start);
        x.words = kept.map((w) => ({ ...w, s: Math.max(0, R(x.start + w.s) - a), ...(w.e != null ? { e: Math.max(0, R(x.start + w.e) - a) } : {}) }));
        if (matched) x.text = kept.map((w) => w.text.trim()).join(' ');
        const e = R(x.start + x.dur);
        x.start = a;
        x.dur = e - a;
        continue;
      }
    }
    const a = R(x.start);
    const e = R(x.start + x.dur);
    if (x.words) x.words = x.words.map((w) => ({ ...w, s: R(x.start + w.s) - a, ...(w.e != null ? { e: R(x.start + w.e) - a } : {}) }));
    x.start = a;
    x.dur = e - a;
  }
  for (const s of state.stickers) { const a = R(s.start); s.dur = R(s.start + s.dur) - a; s.start = a; }
  state.texts = state.texts.filter((x) => x.dur >= 0.15 && x.text.trim());
  state.stickers = state.stickers.filter((x) => x.dur >= 0.15);
  for (const x of [...state.audio, ...state.overlays, ...(state.adjust || [])]) x.start = R(x.start);
  for (const mk of state.markers || []) mk.t = R(mk.t);
  overlayKey = null;
  renderAll();
  refreshPreview();
  seek(Math.min(R(state.playhead), totalDuration()));
  if (skipped) toast('Some words are in clips played backwards or on a speed curve, so those were left in');
  return true;
}

// ---------- AutoCut: pick clips, get a few finished edits to flip between.
// Montage: the best moments (lively, not dark or blurry) cut to the music in different styles.
// Talking: the pauses taken out, captions added, and different looks (jump zooms, caption styles).

const ac = { kind: 'montage', picks: [], variants: [], active: -1, before: null, seed: 1, opts: null, busy: false };
let acInternal = false;
const acAnalysis = new Map(); // media path → analysis

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// Liveliness, less for dark, blurry and shaky-start moments.
function acScore(r) {
  const s = livelyScore(r.loud, r.motion);
  const n = s.length;
  const bm = r.blur ? median(r.blur) : 0;
  return s.map((v, i) => {
    let x = v;
    // Too dark or too blurry to show: never picked. A bit dim or soft: less likely. Blur is judged
    // against the clip's own sharpness, which also catches the camera being swung round (a pan
    // blurs everything, while people moving on a steady shot stay sharp).
    if (r.bright && r.bright[i] < 20) return -100;
    if (r.blur && bm && r.blur[i] > Math.max(bm * 1.6, 4)) return -100;
    if (r.bright && r.bright[i] < 40) x -= 2.5 * (1 - r.bright[i] / 40);
    if (r.blur && bm && r.blur[i] > bm * 1.25) x -= 2 + 4 * (r.blur[i] / bm - 1.25);
    // The wobble as the camera starts or stops (and the phone coming down at the end).
    if (i * r.step < 1) x -= 1;
    if ((n - i) * r.step < 1.25) x -= 1.5;
    return x;
  });
}

async function acMusicOptions() {
  const sel = $('#acMusic');
  sel.textContent = '';
  sel.append(h('option', { value: 'auto' }, 'Pick for me'));
  if (state.media.some((m) => m.kind === 'video' && m.hasAudio)) sel.append(h('option', { value: 'clip' }, 'The clips\' own sound (one smooth stretch)'));
  for (const m of state.media.filter((x) => x.kind === 'audio')) sel.append(h('option', { value: m.id }, m.name));
  try {
    const lib = await window.api.musicList();
    if (lib && lib.tracks && lib.tracks.length) {
      const g = h('optgroup', { label: 'Your music library' });
      for (const t of lib.tracks) g.append(h('option', { value: `lib:${t.path}` }, `${t.name} (${t.mood})`));
      sel.append(g);
    }
  } catch { /* no library */ }
  sel.append(h('option', { value: '' }, 'No music (each clip keeps its own sound)'));
}

function acRefresh() {
  fillSeg($('#acKind'), [['montage', 'Montage, cut to music'], ['talking', 'Talking, keep what\'s said']], ac.kind, (v) => { ac.kind = v; try { localStorage.setItem('snippy.acKind', v); } catch { /* not kept */ } acRefresh(); });
  $('#acMontage').hidden = ac.kind !== 'montage';
  $('#acTalking').hidden = ac.kind !== 'talking';
  const box = $('#acMedia');
  box.textContent = '';
  for (const m of state.media.filter((x) => x.kind !== 'audio')) {
    const n = ac.picks.indexOf(m.id);
    const off = ac.kind === 'talking' && (isImage(m) || !m.hasAudio);
    box.append(h('button', {
      class: `vtpl-pick${off ? ' off' : ''}`, 'aria-pressed': String(n >= 0 && !off), title: off ? `${m.name} (no speech to keep)` : m.name,
      onClick: () => { if (n >= 0) ac.picks.splice(n, 1); else ac.picks.push(m.id); acRefresh(); },
    }, m.thumb ? h('img', { src: m.thumb, alt: '' }) : h('img', { alt: '' }), n >= 0 && !off ? h('span', { class: 'vtpl-n' }, String(n + 1)) : null, h('small', {}, m.name)));
  }
  box.append(h('button', { class: 'vtpl-pick add-more', title: 'Import more clips', onClick: async () => { await importPaths(await window.api.pickFiles()); for (const m of state.media) if (m.kind !== 'audio' && !ac.picks.includes(m.id)) ac.picks.push(m.id); acRefresh(); } }, h('span', { class: 'plus' }, '+'), h('small', {}, 'Add clips')));
  $('#acNote').textContent = ac.kind === 'montage'
    ? 'You\'ll get four versions (Smooth, Energetic, Cinematic, Memories), cut on the beat with one smooth soundtrack. Flip between them, shuffle for new picks, then keep the one you like. Your current edit can be put back.'
    : 'Snippy cuts out the pauses, adds captions and makes versions with different caption looks and zooms. Photos and clips without sound are left out.';
}

async function openAutoCut() {
  closeSmart();
  const visual = state.media.filter((m) => m.kind !== 'audio');
  if (!visual.length) {
    toast('Import some clips or photos first, then AutoCut them');
    importPaths(await window.api.pickFiles()).then(() => { if (state.media.some((m) => m.kind !== 'audio')) openAutoCut(); });
    return;
  }
  // Start with the clips on the timeline (or everything, if the timeline is empty).
  const used = [...new Set(state.clips.map((c) => c.mediaId))].filter((id) => visual.some((m) => m.id === id));
  ac.picks = used.length ? used : visual.map((m) => m.id);
  try { ac.kind = localStorage.getItem('snippy.acKind') === 'talking' ? 'talking' : 'montage'; } catch { ac.kind = 'montage'; }
  await acMusicOptions();
  acRefresh();
  $('#acModal').hidden = false;
}

// The track to use: 'auto' picks music already in the project, then the first library track.
async function acResolveMusic(choice) {
  if (!choice || choice === 'clip') return null;
  let path = null;
  if (choice === 'auto') {
    const own = state.media.find((m) => m.kind === 'audio' && m.duration > 8);
    if (own) return own.id;
    try { const lib = await window.api.musicList(); if (lib.tracks && lib.tracks.length) path = lib.tracks[Math.floor(Math.random() * lib.tracks.length)].path; } catch { /* none */ }
    if (!path) return null;
  } else if (choice.startsWith('lib:')) path = choice.slice(4);
  else return mediaById(choice) ? choice : null;
  let m = state.media.find((x) => x.path === path);
  if (!m) { await importPaths([path]); m = state.media.find((x) => x.path === path); }
  return m ? m.id : null;
}

async function acAnalyse(picks, win) {
  const out = new Map();
  const vids = picks.map(mediaById).filter((m) => m && !isImage(m));
  for (let i = 0; i < vids.length; i++) {
    const m = vids[i];
    if (ac.cancel) throw new Error('cancelled');
    if (!acAnalysis.has(m.path)) {
      const off = window.api.onHighlightsProgress((p) => { if (p.id === m.id) win.update(`Watching ${m.name} (${i + 1} of ${vids.length})`, (i + p.progress) / vids.length); });
      try { acAnalysis.set(m.path, await window.api.analyzeHighlights(m.path, m.duration, m.hasAudio, m.id, { quality: true })); } finally { off(); }
    }
    out.set(m.id, acAnalysis.get(m.path));
  }
  return out;
}

// AutoCut's own montage styles: longer shots than the hand-made templates, mostly clean cuts on the
// beat, and only the odd transition or camera move, so the result is easy to watch.
const AC_STYLES = [
  { name: 'Smooth', mix: true, base: 'travel', pattern: [4, 4, 8, 4], trans: [[null, 0], [null, 0], ['cross', 0.4]], look: 'none', move: 'drift', driftZoom: 1.05,
    pulse: { share: 0.12, zoom: 1.035 }, pops: { n: 2, kind: 'colour' } },
  { name: 'Energetic', mix: true, base: 'quick', pattern: [2, 2, 4, 2, 2, 4, 8, 4], trans: [[null, 0], [null, 0], [null, 0], ['zoom', 0.25]], look: 'vivid', move: 'punch', punchEvery: 4, punchZoom: 1.08,
    ramp: [1.5, 1, 0.25, 1, 1.5], pulse: { share: 0.25, zoom: 1.07 }, pops: { n: 3, kind: 'flash' } },
  { name: 'Cinematic', base: 'travel', pattern: [8, 6, 8], trans: [['cross', 0.7]], look: 'faded', move: 'drift', driftZoom: 1.08,
    ramp: [1, 0.55, 0.35, 0.55, 1] },
  { name: 'Memories', base: 'memories', pattern: [4, 4, 6], trans: [['dip', 0.5], ['cross', 0.8]], look: 'vintage', fx: 'grain', move: 'drift', driftZoom: 1.06 },
];
const AC_PHOTO_STYLES = ['slideshow', 'memories', 'travel', 'quick'];

// A quick zoom in and back out at clip time u (on a beat), on top of whatever camera move is there.
function addZoomPulse(c, u, amount) {
  const len = clipLen(c);
  const e = Math.min(len, u + 0.34);
  const v0 = kfValue(c, 'clip', u);
  const ve = kfValue(c, 'clip', e);
  const keys = (c.keys || []).filter((k) => k.t <= u - 0.01 || k.t >= e + 0.01);
  keys.push({ t: u, ...v0 }, { t: Math.min(len, u + 0.08), ...v0, zoom: v0.zoom * amount }, { t: e, ...ve });
  c.keys = keys.sort((a, b) => a.t - b.t);
}

// The finishing touches that follow the music: a speed ramp on the shot that starts on the biggest
// beat, zoom pulses on the strong beats, and a few flashes or colour pops on the very biggest.
function acBeatPolish(st, beatInfo, musicId) {
  const music = state.audio.find((a) => a.mediaId === musicId);
  const total = totalDuration();
  const beats = beatInfo && beatInfo.strength && music
    ? beatInfo.beats.map((b, i) => ({ t: b - music.in, s: beatInfo.strength[i] || 0 })).filter((b) => b.t > 0.2 && b.t < total - 0.6)
    : [];
  const starts = clipStarts();
  const at = (t) => { for (let i = state.clips.length - 1; i >= 0; i--) if (t >= starts[i]) return i; return 0; };
  const strengthNear = (t) => beats.reduce((best, b) => (Math.abs(b.t - t) < 0.15 && b.s > best ? b.s : best), 0);
  // 1. Speed ramp: fast, slow motion on the hit, fast again, over the shot's same length on the timeline.
  let ramped = -1;
  if (st.ramp) {
    let best = -1;
    let bestV = -1;
    state.clips.forEach((c, i) => {
      const m = mediaById(c.mediaId);
      if (i === 0 || i === state.clips.length - 1 || isImage(m) || c.ramp || clipLen(c) < 1.6) return;
      const v = strengthNear(starts[i]) + clipLen(c) * 0.05;
      if (v > bestV) { bestV = v; best = i; }
    });
    if (best >= 0) {
      const c = state.clips[best];
      const m = mediaById(c.mediaId);
      const L = clipLen(c);
      const srcLen = L / rampLength(rampSegs(st.ramp, 1));
      if (srcLen < m.duration - 0.05) {
        const mid = (c.in + c.out) / 2;
        c.in = clamp(mid - srcLen / 2, 0, m.duration - srcLen);
        c.out = c.in + srcLen;
        c.ramp = st.ramp.slice();
        delete c.speed;
        ramped = best;
      }
    }
  }
  if (!beats.length) return;
  // 2. Zoom pulses on the strongest share of beats (not right at a cut, nor on the slow-motion shot).
  if (st.pulse) {
    const sorted = beats.map((b) => b.s).sort((a, b) => b - a);
    const thr = Math.max(0.3, sorted[Math.max(0, Math.floor(sorted.length * st.pulse.share) - 1)] || 1);
    let last = -9;
    for (const b of beats) {
      if (b.s < thr || b.t - last < 0.6) continue;
      const i = at(b.t);
      const u = b.t - starts[i];
      if (i === ramped || u < 0.4 || clipLen(state.clips[i]) - u < 0.4) continue;
      addZoomPulse(state.clips[i], u, st.pulse.zoom);
      last = b.t;
    }
  }
  // 3. Flashes (a burst of light) or colour pops on the few biggest hits, well apart.
  if (st.pops) {
    const chosen = [];
    for (const b of [...beats].sort((x, y) => y.s - x.s)) {
      if (chosen.length >= st.pops.n || b.s < 0.45) break;
      if (chosen.some((c) => Math.abs(c.t - b.t) < 2.5)) continue;
      chosen.push(b);
    }
    for (const b of chosen) {
      state.adjust.push(st.pops.kind === 'flash'
        ? { id: newId('a'), start: Math.max(0, b.t - 0.02), dur: 0.14, look: 'none', adj: { brightness: 1.45, contrast: 1.05 }, fx: 'beat' }
        : { id: newId('a'), start: Math.max(0, b.t - 0.02), dur: 0.4, look: 'none', adj: { saturation: 1.6, contrast: 1.12 }, fx: 'beat' });
    }
  }
}

// When there's no music: one continuous stretch of a clip's own sound (the loudest part of the
// longest clip with sound) plays under the whole edit, so the sound never jumps at the cuts.
function acClipSoundtrack(ms, analysis, want) {
  const cands = ms.filter((m) => !isImage(m) && m.hasAudio && analysis.get(m.id));
  if (!cands.length) return null;
  const m = cands.reduce((a, b) => (b.duration > a.duration ? b : a));
  const a = analysis.get(m.id);
  const len = Math.min(want, m.duration);
  const n = Math.max(1, Math.round(len / a.step));
  let best = 0;
  let bestV = -Infinity;
  for (let k = 0; k + n <= a.loud.length; k++) {
    let v = 0;
    for (let j = k; j < k + n; j++) v += Math.max(-60, a.loud[j]);
    if (v > bestV) { bestV = v; best = k; }
  }
  return { m, from: Math.min(best * a.step, Math.max(0, m.duration - len)), len };
}

const beatSpanCache = new Map();
async function acBeats(m, from, len) {
  const key = `${m.path}|${from.toFixed(2)}|${len.toFixed(2)}`;
  if (!beatSpanCache.has(key)) beatSpanCache.set(key, await window.api.detectBeats(m.path, from, Math.min(m.duration, from + len + 2)));
  return beatSpanCache.get(key);
}

async function acBuildMontage(o) {
  const picks = o.picks;
  const ms = picks.map(mediaById).filter(Boolean);
  const photosOnly = ms.every((m) => isImage(m));
  const footage = ms.reduce((s, m) => s + (isImage(m) ? PHOTO_LEN : m.duration), 0);
  // About a third of the footage: enough to keep only the good bits (8 s at least, 40 s at most).
  const auto = Math.round(Math.max(8, Math.min(40, footage * 0.35)));
  let len = o.maxLen || auto;
  // The soundtrack: chosen music, or a stretch of the clips' own sound.
  let musicId = o.musicId;
  let musicFrom = 0;
  let muteClips = false;
  let beatInfo = null;
  if (musicId) {
    const mm = mediaById(musicId);
    len = Math.min(len, mm.duration);
    try { beatInfo = await cachedBeats(mm); } catch { /* the style's own beat */ }
  } else if (o.clipSound && !photosOnly) {
    const st = acClipSoundtrack(ms, o.analysis, len);
    if (st) {
      musicId = st.m.id;
      musicFrom = st.from;
      muteClips = true;
      len = Math.min(len, st.len);
      try { beatInfo = await acBeats(st.m, st.from, st.len); } catch { /* the style's own beat */ }
    }
  }
  const beatsFrom = beatInfo && beatInfo.beats ? beatInfo.beats.filter((b) => b >= musicFrom - 1e-3) : [];
  const rel = beatsFrom.length > 4 ? beatsFrom.map((b) => b - beatsFrom[0]) : null;
  const variants = [];
  if (photosOnly) {
    for (const id of AC_PHOTO_STYLES) {
      const tpl = VIDEO_TEMPLATES.find((t) => t.id === id);
      await buildFromTemplate(tpl, { picks, musicId, maxLen: len, title: o.title, outro: false, endFade: 0.8 });
      variants.push({ name: tpl.name, snap: snapshot() });
    }
    return variants;
  }
  for (let v = 0; v < AC_STYLES.length; v++) {
    const st = AC_STYLES[v];
    const tpl = { ...VIDEO_TEMPLATES.find((t) => t.id === st.base), ...st, stickers: null };
    const r = rng(o.seed * 7919 + v * 101);
    const sources = ms.map((m) => {
      if (isImage(m)) return { id: m.id, step: 0.5, photo: true, score: Array.from({ length: PHOTO_LEN * 2 }, () => 0.1 + (r() - 0.5) * 0.6) };
      const a = o.analysis.get(m.id);
      return { id: m.id, step: a.step, score: acScore(a).map((x) => x + (r() - 0.5) * 0.9) };
    });
    // Shot lengths on the real beat, in the style's rhythm.
    const maxL = Math.min(len, footage * 0.8);
    const lens = templateSlots({ beats: rel, bpm: (beatInfo && beatInfo.bpm) || tpl.bpm, pattern: tpl.pattern, maxLen: maxL });
    // The rhythm stops when its next shot won't fit; fill what's left with shorter shots, still on the beat.
    const beatLen = 60 / ((beatInfo && beatInfo.bpm) || tpl.bpm);
    for (let left = maxL - lens.reduce((x, y) => x + y, 0); left >= 2 * beatLen - 0.05;) {
      const k = Math.min(4, Math.floor((left + 0.05) / beatLen));
      lens.push(k * beatLen);
      left -= k * beatLen;
    }
    // Moments well apart (up to 3 s, as the footage allows), so two shots from the same clip don't look like a skip.
    const want = lens.reduce((a, b) => a + b, 0);
    const usable = ms.reduce((n, m) => n + (isImage(m) ? PHOTO_LEN : m.duration), 0);
    const gap = clamp((usable - want) / Math.max(1, lens.length), 1, 3);
    // Weak moments (shaky, soft, the very start or end of a clip) are left out rather than used to fill time.
    const good = (p) => p.v > -1.5;
    let picked = pickHighlights(sources, lens, gap).filter(good);
    const got = (list) => list.reduce((a, p) => a + p.b - p.a, 0);
    if (got(picked) < want * 0.85) {
      const tighter = pickHighlights(sources, lens, 1).filter(good);
      if (got(tighter) > got(picked)) picked = tighter;
    }
    if (!picked.length) continue;
    // In story order, each shot gets the next length of the rhythm (centred on its best moment), so cuts
    // stay on the beat. If not every shot could be filled, each keeps the (on-beat) length it was picked for.
    const inRhythm = picked.length === lens.length;
    const shots = picked.map((p, i) => {
      const m = mediaById(p.id);
      const d = inRhythm ? lens[i] : (p.b - p.a);
      if (isImage(m)) return { m, in: 0, out: d };
      const c = (p.a + p.b) / 2;
      const a0 = clamp(c - d / 2, 0, Math.max(0, m.duration - d));
      return { m, in: a0, out: Math.min(m.duration, a0 + d) };
    });
    // Smooth and Energetic switch between the clips (a close shot, then a wide one…), opening on the
    // best moment of all; Cinematic and Memories keep the order things happened in.
    if (st.mix && new Set(shots.map((x) => x.m)).size > 1) {
      const bySource = new Map();
      shots.forEach((x, i) => { if (!bySource.has(x.m)) bySource.set(x.m, []); bySource.get(x.m).push({ ...x, v: picked[i].v }); });
      const lists = [...bySource.values()].sort((a, b) => Math.max(...b.map((x) => x.v)) - Math.max(...a.map((x) => x.v)));
      const mixed = [];
      for (let k = 0; mixed.length < shots.length; k = (k + 1) % lists.length) if (lists[k].length) mixed.push(lists[k].shift());
      // Each shot keeps the rhythm's length for its new place, re-centred on its moment.
      shots.splice(0, shots.length, ...mixed.map((x, i) => {
        const d = inRhythm ? lens[i] : (x.out - x.in);
        if (isImage(x.m)) return { m: x.m, in: 0, out: d };
        const c = (x.in + x.out) / 2;
        const a0 = clamp(c - d / 2, 0, Math.max(0, x.m.duration - d));
        return { m: x.m, in: a0, out: Math.min(x.m.duration, a0 + d) };
      }));
    }
    // Two shots from the same clip less than a second apart would look like a skip: the second
    // carries straight on from the first instead, so the cut can't be seen.
    for (let i = 1; i < shots.length; i++) {
      const p = shots[i - 1];
      const c = shots[i];
      if (c.m !== p.m || isImage(c.m)) continue;
      const gap = c.in - p.out;
      if (gap < 1 && gap > -(p.out - p.in)) {
        const d = c.out - c.in;
        if (p.out + d <= c.m.duration) { c.in = p.out; c.out = p.out + d; }
      }
    }
    // When the soundtrack is one of the clips' own sound, shots from that clip show the moment
    // you're hearing (singers in time with their song), like cutting between cameras at a gig.
    if (muteClips && musicId) {
      const sm = mediaById(musicId);
      const a = o.analysis.get(sm.id);
      const sc = a ? acScore(a) : null;
      const first = beatsFrom.length > 4 ? beatsFrom[0] : musicFrom;
      let t = 0;
      for (const x of shots) {
        const d = x.out - x.in;
        if (x.m === sm) {
          const at = first + t;
          const i0 = sc ? Math.floor(at / a.step) : 0;
          const i1 = sc ? Math.max(i0 + 1, Math.ceil((at + d) / a.step)) : 1;
          const ok = !sc || sc.slice(i0, i1).reduce((n, v) => n + v, 0) / Math.max(1, i1 - i0) > -1.5;
          if (ok && at + d <= sm.duration) { x.in = at; x.out = at + d; }
        }
        t += d;
      }
    }
    await buildFromTemplate(tpl, { picks, musicId, maxLen: 0, title: o.title, shots, musicFrom, muteClips, beats: beatInfo, outro: false, endFade: 0.8 });
    acBeatPolish(st, beatInfo, musicId);
    variants.push({ name: st.name, snap: snapshot() });
  }
  return variants;
}

const AC_TALK_LOOKS = [
  { name: 'Clean', look: 'clean', zoom: null },
  { name: 'Punchy', look: 'boldbox', zoom: 'jump', keys: true, emoji: true },
  { name: 'Bouncy', look: 'bounce', zoom: 'jump', emoji: true },
  { name: 'Story', look: 'karaoke', zoom: 'drift' },
];

async function acBuildTalking(o, win) {
  const vids = o.picks.map(mediaById).filter((m) => m && !isImage(m) && m.hasAudio);
  if (!vids.length) throw new Error('None of those clips have speech to keep. Try Montage instead.');
  // Cut out the pauses.
  const pieces = [];
  for (let i = 0; i < vids.length; i++) {
    const m = vids[i];
    win.update(`Finding the pauses in ${m.name}`, i / vids.length);
    const sil = await window.api.findSilences(m.path, 0, m.duration, { minPause: 0.45, sensitivity: 'normal' });
    const keep = keptRanges(0, m.duration, sil, { pad: 0.12, minKeep: 0.25 });
    // Leave out stretches that are mostly too dark to see.
    const a = o.analysis.get(m.id);
    for (const k of keep) {
      if (a && a.bright) {
        const i0 = Math.floor(k.s / a.step);
        const i1 = Math.max(i0 + 1, Math.ceil(k.e / a.step));
        const seg = a.bright.slice(i0, i1);
        if (seg.length && median(seg) < 18) continue;
      }
      pieces.push({ ...newClip(m), in: k.s, out: k.e });
    }
  }
  if (!pieces.length) throw new Error('Snippy couldn\'t find any speech to keep in those clips.');
  // Sound all the way through with no pauses (music, a concert, wind) isn't someone talking.
  const fullLen = vids.reduce((n, m) => n + m.duration, 0);
  const keptLen = pieces.reduce((n, c) => n + (c.out - c.in), 0);
  const cutShare = 1 - keptLen / Math.max(0.001, fullLen);
  const musicLike = vids.every((m) => {
    const a = o.analysis.get(m.id);
    if (!a || !a.loud || !a.loud.length) return false;
    const med = median(a.loud);
    return a.loud.filter((v) => v < med - 15).length / a.loud.length < 0.05;
  });
  if (cutShare < 0.03 && musicLike) {
    const err = new Error('no talking');
    err.code = 'NOTALK';
    throw err;
  }
  state.clips = pieces;
  state.texts = [];
  state.stickers = [];
  state.overlays = [];
  state.adjust = [];
  state.audio = [];
  // Captions, once, on the tidied-up timeline.
  let caps = [];
  if (o.captions) {
    win.update('Writing captions (getting the speech model ready)', 0);
    const off = window.api.onCaptionsProgress((p) => win.update(p.phase === 'download' ? `Downloading the speech model (one time only) ${Math.round(p.progress * 100)}%` : 'Writing captions', p.progress));
    try {
      const starts = clipStarts();
      const list = pieces.map((c, i) => { const m = mediaById(c.mediaId); return { path: m.path, in: c.in, out: c.out, start: starts[i], hasAudio: m.hasAudio, speed: 1 }; });
      const segs = await window.api.generateCaptions(list, { language: null, task: 'transcribe', maxWords: 4 });
      caps = (segs || []).map((s) => ({ id: newId('t'), text: s.text, start: s.start, dur: Math.max(MIN_LEN, s.end - s.start), words: s.words, size: 6, position: 'bottom', color: '#FFFFFF', auto: true }));
    } catch (err) {
      if (ac.cancel) throw err;
      toast(`Captions couldn't be made (${cleanError(err)}), so the versions have none`);
    } finally { off(); }
  }
  if (cutShare < 0.03 && !caps.length) {
    const err = new Error('no talking');
    err.code = 'NOTALK';
    throw err;
  }
  ac.talkNote = cutShare < 0.03 ? 'Hardly any pauses were found, so the versions differ mainly in their captions and zooms.' : `Cut ${fmt(fullLen - keptLen)} of pauses.`;
  const total = totalDuration();
  const music = o.bed ? (o.musicId ? mediaById(o.musicId) : null) : null;
  const variants = [];
  for (const L of AC_TALK_LOOKS) {
    state.clips = pieces.map((c, i) => {
      const x = { ...clone(c), id: newId('c') };
      if (L.zoom === 'jump' && i % 2 === 1) Object.assign(x, { zoom: 1.18, posX: 0, posY: 0.02 }); // a closer shot every other cut
      if (L.zoom === 'drift') { const d = (x.out - x.in); x.keys = [{ t: 0, zoom: 1, posX: 0, posY: 0, rotate: 0 }, { t: d, zoom: 1.06, posX: 0, posY: 0, rotate: 0 }]; }
      return x;
    });
    const preset = CAPTION_PRESETS.find((p) => p.id === L.look);
    state.texts = caps.map((t) => ({ ...clone(t), id: newId('t'), ...preset.set, keyColor: Boolean(L.keys), emoji: Boolean(L.emoji) }));
    state.audio = music ? [{ ...newAudioItem(music, 0), out: Math.min(music.duration, total), volume: 0.15, duck: true, duckTo: 0.5, fadeIn: 0.5, fadeOut: Math.min(2, total / 4) }] : [];
    variants.push({ name: L.name, snap: snapshot() });
  }
  return variants;
}

async function acGo(reshuffle = false) {
  if (ac.busy) return;
  const o = reshuffle ? { ...ac.opts, seed: ac.opts.seed + 1 } : {
    kind: ac.kind, picks: ac.picks.filter((id) => mediaById(id)), maxLen: Number($('#acLen').value) || 0,
    title: $('#acTitleText').value, captions: $('#acCaps').checked, bed: $('#acBed').checked, seed: Math.floor(Math.random() * 1e6), music: $('#acMusic').value,
  };
  if (!o.picks.length) { toast('Pick at least one clip or photo'); return; }
  $('#acModal').hidden = true;
  ac.busy = true;
  ac.cancel = false;
  acInternal = true;
  if (!reshuffle) ac.before = snapshot();
  const undoLen = undoStack.length;
  const win = jobWindow('AutoCut', () => { ac.cancel = true; window.api.cancelCaptions(); });
  try {
    if (!reshuffle) {
      o.musicId = await acResolveMusic(o.music);
      o.clipSound = o.music === 'clip' || (o.music === 'auto' && !o.musicId);
    }
    if (o.musicId && o.kind === 'montage') {
      win.update('Listening for the beat', 0);
      try { await cachedBeats(mediaById(o.musicId)); } catch { /* the template's own beat is used */ }
    }
    win.update('Watching your clips', 0);
    o.analysis = await acAnalyse(o.picks, win);
    if (ac.cancel) throw new Error('cancelled');
    win.update(o.kind === 'montage' ? 'Cutting it together' : 'Tidying it up', 1);
    const variants = o.kind === 'montage' ? await acBuildMontage(o) : await acBuildTalking(o, win);
    if (!variants.length) throw new Error('Those clips are too short to cut together. Try more clips or a shorter length.');
    ac.opts = o;
    ac.variants = variants;
    // One undo step for all of it: back to how things were before AutoCut.
    undoStack.length = undoLen;
    if (!reshuffle) pushHistory(ac.before);
    redoStack.length = 0;
    acShowBar();
    acShow(reshuffle ? Math.min(ac.active, variants.length - 1) : 0);
    if (o.kind === 'talking' && ac.talkNote) toast(ac.talkNote);
  } catch (err) {
    undoStack.length = undoLen;
    if (!reshuffle) restore(ac.before);
    else if (ac.variants[ac.active]) restore(ac.variants[ac.active].snap);
    const msg = cleanError(err);
    if (err && err.code === 'NOTALK') {
      suggest('These clips have sound all the way through (like music) and no speech to tidy up, so Talking can\'t change them. Make a montage cut to the music instead?', 'Make a montage', () => {
        ac.kind = 'montage';
        try { localStorage.setItem('snippy.acKind', 'montage'); } catch { /* not kept */ }
        acRefresh();
        $('#acModal').hidden = false;
      });
    } else if (!msg.includes('cancelled')) toast(msg);
  } finally {
    win.close();
    ac.busy = false;
    acInternal = false;
  }
}

function acShowBar() {
  const box = $('#acVariants');
  box.textContent = '';
  ac.variants.forEach((v, i) => box.append(h('button', { class: 'ac-chip', 'aria-pressed': 'false', onClick: () => acShow(i) }, v.name)));
  $('#acShuffle').hidden = ac.opts.kind !== 'montage';
  $('#acBar').hidden = false;
}

function acShow(i) {
  ac.active = i;
  acInternal = true;
  restore(ac.variants[i].snap);
  acInternal = false;
  overlayKey = null;
  $('#acVariants').querySelectorAll('.ac-chip').forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
  seek(0);
  updateOverlay();
  play();
}

function acClose() { $('#acBar').hidden = true; ac.variants = []; }

$('#acBtn').addEventListener('click', openAutoCut);
$('#acCancel').addEventListener('click', () => { $('#acModal').hidden = true; });
$('#acGo').addEventListener('click', () => acGo(false));
$('#acShuffle').addEventListener('click', () => { pause(); acGo(true); });
$('#acKeep').addEventListener('click', () => { pause(); const n = ac.variants[ac.active]; acClose(); toast(`Kept the ${n ? n.name : ''} version. Change anything you like; Ctrl+Z puts back what you had before.`); });
$('#acUndo').addEventListener('click', () => {
  pause();
  if (ac.before) {
    if (undoStack[undoStack.length - 1] === ac.before) undoStack.pop();
    restore(ac.before);
  }
  acClose();
  toast('Put back what you had before AutoCut');
});
// Editing anything yourself settles on the version you're looking at.
const _pushHistoryForAc = pushHistory;
pushHistory = function pushHistoryWatchingAutoCut(snap) { _pushHistoryForAc(snap); if (!acInternal && !$('#acBar').hidden) acClose(); };

// ---------- masks on the main video: a shape (or one you draw) shows the picture; outside it is
// black, dimmed or blurred. Its centre and size can be keyframed or follow motion tracking.
// The mask lives in the picture's own frame, so it moves with the picture's transform.

const MASK_SHAPES = [['circle', 'Circle'], ['rounded', 'Rounded'], ['rect', 'Box'], ['heart', 'Heart'], ['star', 'Star'], ['diamond', 'Diamond']];
const MASK_OUTSIDE = [['black', 'Black'], ['dim', 'Dimmed'], ['blur', 'Blurred']];
const MASK_DIM = 0.35;
const maskBlurShare = 0.012; // blur radius as a share of the canvas height

// Draws the mask (white = picture shows) on a canvas the size of the frame, at clip time u.
function drawClipMask(ctx, c, u, W, H) {
  const mk = c.mask;
  const v = kfValue(c, 'clip', u);
  const b = pictureBox(mediaById(c.mediaId));
  const cx = ((1 - b.w) / 2 + v.mx * b.w) * W;
  const cy = ((1 - b.h) / 2 + v.my * b.h) * H;
  const hgt = Math.max(2, v.ms * b.h * H);
  const wid = Math.max(2, hgt * (mk.ar || 1));
  const f = Math.max(0, Math.min(0.45, mk.feather || 0)) * Math.min(wid, hgt);
  ctx.save();
  ctx.fillStyle = mk.invert ? '#fff' : '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.filter = f > 0.5 ? `blur(${(f / 2.5).toFixed(2)}px)` : 'none';
  ctx.fillStyle = mk.invert ? '#000' : '#fff';
  ctx.translate(cx, cy);
  if (mk.shape === 'path' && mk.points && mk.points.length > 2) {
    const k = (v.ms / (mk.ms0 || v.ms)) * b.h * H;
    const kx = (v.ms / (mk.ms0 || v.ms)) * b.w * W;
    ctx.beginPath();
    mk.points.forEach(([dx, dy], i) => { const x = dx * kx; const y = dy * k; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.closePath();
  } else {
    const sw = Math.max(1, wid - f);
    const sh = Math.max(1, hgt - f);
    ctx.translate(-sw / 2, -sh / 2);
    shapePath(ctx, mk.shape === 'rect' ? 'none' : mk.shape, sw, sh);
  }
  ctx.fill();
  ctx.restore();
}

// The same mask as a CSS mask image for the preview (made small; it's only a mask).
const maskCanvas = document.createElement('canvas');
let maskCssKey = '';
let maskCssUrl = '';
function maskCss(c, u) {
  const [W, H] = ASPECTS[state.aspect];
  const w = 320;
  const hgt = Math.max(2, Math.round((w * H) / W));
  const v = kfValue(c, 'clip', u);
  const key = `${c.id}|${w}x${hgt}|${JSON.stringify(c.mask)}|${v.mx.toFixed(4)}|${v.my.toFixed(4)}|${v.ms.toFixed(4)}`;
  if (key !== maskCssKey) {
    maskCanvas.width = w;
    maskCanvas.height = hgt;
    const ctx = maskCanvas.getContext('2d');
    drawClipMask(ctx, c, u, w, hgt);
    // White → visible: turn the brightness into see-through for CSS masking.
    const img = ctx.getImageData(0, 0, w, hgt);
    for (let i = 0; i < img.data.length; i += 4) { img.data[i + 3] = img.data[i]; img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; }
    ctx.putImageData(img, 0, 0);
    maskCssUrl = `url(${maskCanvas.toDataURL('image/png')})`;
    maskCssKey = key;
  }
  return maskCssUrl;
}

// What's outside the mask in the preview: a copy of the frame, dimmed or blurred, underneath.
let maskUnder = null;
function updateMaskPreview() {
  const loc = state.clips.length ? locate(Math.min(state.playhead, Math.max(0, totalDuration() - 1e-3))) : null;
  const c = loc && loc.clip;
  const els = [video, still];
  if (!c || !c.mask) {
    for (const el of els) { if (el.style.maskImage) { el.style.maskImage = ''; el.style.webkitMaskImage = ''; } }
    if (maskUnder) maskUnder.hidden = true;
    return;
  }
  const u = Math.max(0, state.playhead - loc.start);
  const url = maskCss(c, u);
  for (const el of els) {
    el.style.maskImage = url; el.style.webkitMaskImage = url;
    el.style.maskSize = '100% 100%'; el.style.webkitMaskSize = '100% 100%';
    el.style.maskRepeat = 'no-repeat'; el.style.webkitMaskRepeat = 'no-repeat';
  }
  if (!maskUnder) {
    maskUnder = h('canvas', { class: 'mask-under' });
    $('#layerA').prepend(maskUnder);
  }
  const out = c.mask.outside || 'black';
  if (out === 'black') { maskUnder.hidden = true; return; }
  const src = still.hidden ? video : still;
  const r = $('#stage').getBoundingClientRect();
  const w = Math.max(2, Math.round(r.width));
  const hh = Math.max(2, Math.round(r.height));
  if (maskUnder.width !== w || maskUnder.height !== hh) { maskUnder.width = w; maskUnder.height = hh; }
  const ctx = maskUnder.getContext('2d');
  ctx.clearRect(0, 0, w, hh);
  ctx.filter = `${src.style.filter && src.style.filter !== 'none' ? `${src.style.filter} ` : ''}${out === 'dim' ? `brightness(${MASK_DIM})` : `blur(${(maskBlurShare * hh).toFixed(1)}px)`}`;
  // The picture fills the frame keeping its shape, like the video element's object-fit: contain.
  const sw = src.videoWidth || src.naturalWidth;
  const sh = src.videoHeight || src.naturalHeight;
  if (sw && sh) {
    const k = Math.min(w / sw, hh / sh);
    try { ctx.drawImage(src, (w - sw * k) / 2, (hh - sh * k) / 2, sw * k, sh * k); } catch { /* not ready */ }
  }
  ctx.filter = 'none';
  maskUnder.style.transform = src.style.transform;
  maskUnder.style.clipPath = src.style.clipPath;
  maskUnder.hidden = false;
}

function maskSection(c) {
  const mk = c.mask;
  const v = valuesNow('clip', c);
  const redraw = () => { maskCssKey = ''; updateMaskPreview(); };
  const choose = (shape) => {
    commit();
    if (!c.mask) {
      c.mask = { shape, outside: 'dim', feather: 0.1, ar: shape === 'rect' || shape === 'rounded' ? 1.4 : 1 };
      const b = pictureBox(mediaById(c.mediaId));
      const [W, H] = ASPECTS[state.aspect];
      // A shape that fits nicely: about half the picture's smaller side.
      c.ms = Number(Math.min(0.6, (0.5 * Math.min(b.w * W, b.h * H)) / (b.h * H)).toFixed(3));
      c.mx = 0.5; c.my = 0.5;
    } else c.mask.shape = shape;
    if (shape === 'circle' || shape === 'heart' || shape === 'star' || shape === 'diamond') c.mask.ar = 1;
    delete c.mask.points;
    redraw(); renderInspector();
  };
  const tiles = h('div', { class: 'choices', role: 'group', 'aria-label': 'Mask shape' },
    h('button', { class: 'btn', 'aria-pressed': String(!mk), onClick: () => { if (!mk) return; commit(); delete c.mask; redraw(); renderInspector(); } }, 'None'),
    ...MASK_SHAPES.map(([id, label]) => h('button', { class: 'btn', 'aria-pressed': String(Boolean(mk) && mk.shape === id), onClick: () => choose(id) }, label)),
    h('button', { class: 'btn', 'aria-pressed': String(Boolean(mk) && mk.shape === 'path'), title: 'Draw round what you want to keep, on the preview', onClick: () => startMaskDraw(c) }, '✎ Draw'));
  if (!mk) {
    return [section('Mask', tiles, h('p', { class: 'hint' }, 'Show the video through a shape: a spotlight on someone, a reveal, a heart-shaped frame. Outside it can be black, dimmed or blurred.'))];
  }
  const slide = (title, prop, min, max, step, fmtv) => sliderSection(title, {
    min, max, step, value: v[prop], format: fmtv, key: `${c.id}:${prop}`,
    onValue: (x) => { kset(c, 'clip', { [prop]: x }); redraw(); },
  });
  // A list, not a wrapper, so each part lands under the Mask tab.
  return [
    section('Mask', tiles),
    section('Mask outside', h('div', { class: 'seg', role: 'group', 'aria-label': 'Outside the mask' },
      ...MASK_OUTSIDE.map(([id, label]) => h('button', { 'aria-pressed': String((mk.outside || 'black') === id), onClick: () => { commit(); mk.outside = id; redraw(); renderInspector(); } }, label))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: mk.invert ? '' : null, onChange: (e) => { commit(); mk.invert = e.target.checked; redraw(); } }), ' Swap inside and outside')),
    slide('Mask size', 'ms', 0.05, 1.5, 0.005, (x) => `${Math.round(x * 100)}%`),
    mk.shape !== 'path' ? sliderSection('Mask width', { min: 0.3, max: 3, step: 0.01, value: mk.ar || 1, format: (x) => `${x.toFixed(2)}×`, key: `${c.id}:mar`, onValue: (x) => { mk.ar = x; redraw(); } }) : null,
    slide('Mask left / right', 'mx', -0.2, 1.2, 0.005, (x) => `${Math.round(x * 100)}`),
    slide('Mask up / down', 'my', -0.2, 1.2, 0.005, (x) => `${Math.round(x * 100)}`),
    sliderSection('Mask soft edge', { min: 0, max: 0.45, step: 0.01, value: mk.feather || 0, format: (x) => `${Math.round(x * 220)}%`, key: `${c.id}:mfe`, onValue: (x) => { mk.feather = x; redraw(); } }),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', onClick: () => startTrackPick(c, 'clipmask') }, '⌖ Follow something (track)')),
    h('p', { class: 'hint' }, 'With this tab open, drag on the preview to move the mask and scroll to resize it. Keyframes (Transform tab) animate its position and size too.')];
}

// With the Mask tab showing, the preview moves and resizes the mask instead of the picture.
function maskEditClip() {
  const s = state.selected;
  if (!s || s.kind !== 'clip' || selection.length > 1) return null;
  const c = itemOf(s);
  if (!c || !c.mask || c !== stageClip()) return null;
  const panel = document.getElementById('ipanel-mask');
  return panel && !panel.hidden ? c : null;
}

function dragMask(e, c) {
  e.preventDefault();
  if (state.playing) pause();
  const r = $('#stage').getBoundingClientRect();
  const loc = locate(state.playhead);
  const u = Math.max(0, state.playhead - loc.start);
  const start = valuesNow('clip', c);
  const p0 = stageToSrc(c, u, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  const before = snapshot();
  let changed = false;
  const st = $('#stage');
  st.setPointerCapture(e.pointerId);
  const move = (ev) => {
    changed = true;
    const p = stageToSrc(c, u, (ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height);
    kset(c, 'clip', { mx: Number((start.mx + p.x - p0.x).toFixed(4)), my: Number((start.my + p.y - p0.y).toFixed(4)) });
    maskCssKey = '';
    updateMaskPreview();
  };
  const up = () => {
    st.removeEventListener('pointermove', move);
    st.removeEventListener('pointerup', up);
    if (changed) { pushHistory(before); markDirty(); renderTimeline(); renderInspector(); }
  };
  st.addEventListener('pointermove', move);
  st.addEventListener('pointerup', up);
}
$('#stage').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || trackPick || maskDraw) return;
  const c = maskEditClip();
  if (!c || e.target.closest('.pip, .sticker-hit')) return;
  e.stopImmediatePropagation();
  dragMask(e, c);
}, true);
$('#stage').addEventListener('wheel', (e) => {
  const c = maskEditClip();
  if (!c) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  commitOnce(`${c.id}:maskwheel`);
  const f = Math.exp(-clamp(e.deltaY, -120, 120) * 0.0018);
  kset(c, 'clip', { ms: Number(clamp(valuesNow('clip', c).ms * f, 0.05, 1.5).toFixed(4)) });
  maskCssKey = '';
  updateMaskPreview();
  markDirty();
}, { capture: true, passive: false });

// Drawing your own mask on the preview.
let maskDraw = null;
function startMaskDraw(c) {
  if (state.playing) pause();
  if (c !== stageClip()) { const i = state.clips.indexOf(c); if (i >= 0) seek(clipStarts()[i] + 0.01); }
  maskDraw = { c };
  $('#stage').classList.add('picking-track');
  $('#stageWrap').append(h('div', { class: 'track-banner', id: 'maskBanner' },
    h('b', {}, 'Draw round what to keep'), h('span', {}, 'Esc to cancel'),
    h('button', { class: 'btn', onClick: endMaskDraw }, 'Cancel')));
}
function endMaskDraw() {
  maskDraw = null;
  $('#stage').classList.remove('picking-track');
  for (const id of ['maskBanner', 'maskTrail']) { const el = document.getElementById(id); if (el) el.remove(); }
}
document.addEventListener('keydown', (e) => { if (maskDraw && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); endMaskDraw(); } }, true);
document.addEventListener('pointerdown', (e) => {
  if (!maskDraw || e.button !== 0 || !e.target.closest('#stage')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const c = maskDraw.c;
  const r = $('#stage').getBoundingClientRect();
  const wrap = $('#stageWrap').getBoundingClientRect();
  const pts = [[e.clientX, e.clientY]];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'maskTrail';
  svg.setAttribute('class', 'mask-trail');
  svg.innerHTML = '<polyline/>';
  $('#stageWrap').append(svg);
  const line = svg.firstChild;
  const move = (ev) => {
    const last = pts[pts.length - 1];
    if (Math.hypot(ev.clientX - last[0], ev.clientY - last[1]) < 3) return;
    pts.push([ev.clientX, ev.clientY]);
    line.setAttribute('points', pts.map(([x, y]) => `${(x - wrap.left).toFixed(1)},${(y - wrap.top).toFixed(1)}`).join(' '));
  };
  const up = () => {
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', up, true);
    endMaskDraw();
    if (pts.length < 6) { toast('Draw all the way round what you want to keep'); return; }
    const loc = locate(state.playhead);
    const u = Math.max(0, state.playhead - loc.start);
    // Into the picture's own frame (so it follows the picture), around its middle.
    const src = pts.map(([x, y]) => stageToSrc(c, u, (x - r.left) / r.width, (y - r.top) / r.height));
    const xs = src.map((p) => p.x);
    const ys = src.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const msz = Math.max(0.02, Math.max(...ys) - Math.min(...ys));
    commit();
    const old = c.mask || {};
    c.mask = { shape: 'path', points: src.map((p) => [Number((p.x - cx).toFixed(4)), Number((p.y - cy).toFixed(4))]), ms0: msz, outside: old.outside || 'dim', feather: old.feather ?? 0.06, invert: Boolean(old.invert) };
    delete c.keys;
    c.mx = cx; c.my = cy; c.ms = msz;
    maskCssKey = '';
    updateMaskPreview();
    renderTimeline();
    renderInspector();
    showInspectorTab('mask');
  };
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', up, true);
}, true);

// The export's masks: for each masked clip, black-and-white frames over the clip's own time
// (one picture if the mask doesn't move), drawn by the same code as the preview.
async function renderClipMasks(project, W, H, fps) {
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  for (let i = 0; i < state.clips.length; i++) {
    const c = state.clips[i];
    if (!c.mask || !project.clips[i]) continue;
    const L = clipLen(c) + 1; // a little over, for a transition's overlap
    const moving = (c.keys || []).length > 1 && new Set(c.keys.map((k) => kfValue(c, 'clip', k.t)).map((v) => `${v.mx.toFixed(4)},${v.my.toFixed(4)},${v.ms.toFixed(4)}`)).size > 1;
    const n = moving ? Math.ceil(L * fps) : 1;
    const images = [];
    const known = new Map();
    const frames = [];
    for (let k = 0; k < n; k++) {
      drawClipMask(ctx, c, moving ? Math.min(k / fps, clipLen(c)) : 0, W, H);
      const url = cv.toDataURL('image/png');
      let idx = known.get(url);
      if (idx === undefined) { idx = images.length; images.push(url); known.set(url, idx); }
      const dur = moving ? 1 / fps : L;
      const last = frames[frames.length - 1];
      if (last && last.img === idx) last.dur += dur;
      else frames.push({ img: idx, dur });
      if (k % 20 === 19) await new Promise((r) => setTimeout(r));
    }
    project.clips[i].mask = { outside: c.mask.outside || 'black', dim: MASK_DIM, sigma: Number((maskBlurShare * H).toFixed(2)), images, frames };
  }
}


// ---------- groups and combined clips

// Groups: texts, stickers, sounds, overlays and adjustment layers that move together. Clicking one
// picks the whole group (Alt+click picks just that one); dragging any of them moves them all.

function groupMembers(gid) {
  const out = [];
  for (const k of GROUP_KINDS) for (const x of listOf(k)) if (x.group === gid) out.push({ kind: k, id: x.id });
  return out;
}

// The item and the rest of its group, with the item itself last (so it's the one the panel shows).
function withGroup(s) {
  const x = itemOf(s);
  if (!x || !x.group) return [s];
  return [...groupMembers(x.group).filter((g) => !(g.kind === s.kind && g.id === s.id)), s];
}

const freeSelected = () => selection.filter((s) => GROUP_KINDS.includes(s.kind));
function oneGroup() {
  if (selection.length < 2) return false;
  const g = itemOf(selection[0]) && itemOf(selection[0]).group;
  return Boolean(g) && selection.every((s) => (itemOf(s) || {}).group === g) && groupMembers(g).length === selection.length;
}
const canGroup = () => freeSelected().length >= 2 && !oneGroup();

function groupSelected() {
  const free = freeSelected();
  if (free.length < 2) {
    toast(selection.some((s) => s.kind === 'clip')
      ? 'Clips on the main track stay in order by themselves. To join clips, use “Combine into one clip”.'
      : 'Select two or more texts, stickers, sounds or overlays to group them (Ctrl+click adds one)');
    return;
  }
  commit();
  const gid = newId('g');
  for (const s of free) itemOf(s).group = gid;
  selection = free;
  markDirty();
  renderTimeline();
  refreshSelectionUI();
  renderInspector();
  toast(`Grouped ${free.length} items: they now move together. Alt+click picks just one.`);
}

function ungroupSelected() {
  const grouped = selection.filter((s) => (itemOf(s) || {}).group);
  if (!grouped.length) { toast('Nothing selected is in a group'); return; }
  commit();
  const gids = new Set(grouped.map((s) => itemOf(s).group));
  for (const k of GROUP_KINDS) for (const x of listOf(k)) if (gids.has(x.group)) delete x.group;
  markDirty();
  renderTimeline();
  refreshSelectionUI();
  renderInspector();
  toast('Ungrouped');
}

// A small link mark on grouped items, in a colour per group.
function markGroups() {
  const hues = new Map();
  for (const k of GROUP_KINDS) {
    for (const x of listOf(k)) {
      const el = content.querySelector(`.${KIND_CLASS[k]}[data-id="${x.id}"]`);
      if (!el) continue;
      el.classList.toggle('grouped', Boolean(x.group));
      if (!x.group) continue;
      if (!hues.has(x.group)) hues.set(x.group, (hues.size * 67 + 190) % 360);
      el.style.setProperty('--group-hue', hues.get(x.group));
      el.title = 'In a group: moves with the others (Alt+click picks just this one; Ctrl+Shift+G ungroups)';
    }
  }
  for (const c of state.clips) {
    const el = content.querySelector(`.clip[data-id="${c.id}"]`);
    if (el) el.classList.toggle('combined', Boolean(c.compound));
  }
}

// Combining: a run of clips side by side on the main track (and any texts, stickers, sounds or
// overlays selected with them) is rendered into one new clip, which can be split back apart.
function combineRun() {
  const idx = selection.filter((s) => s.kind === 'clip').map((s) => state.clips.findIndex((c) => c.id === s.id)).filter((i) => i >= 0).sort((a, b) => a - b);
  if (idx.length < 2) return null;
  for (let k = 1; k < idx.length; k++) if (idx[k] !== idx[k - 1] + 1) return null;
  return { from: idx[0], to: idx[idx.length - 1] };
}
const canCombine = () => Boolean(combineRun());

async function combineClips() {
  const run = combineRun();
  if (!run) {
    toast('Select two or more clips that sit next to each other on the main track (Ctrl+click adds one)');
    return;
  }
  if (state.playing) pause();
  const starts = clipStarts();
  const t0 = starts[run.from];
  const t1 = starts[run.to] + clipLen(state.clips[run.to]);
  const clips = state.clips.slice(run.from, run.to + 1);
  const items = freeSelected().map((s) => ({ kind: s.kind, item: itemOf(s) }));
  // The section on its own, as if it were the whole edit.
  const inner = JSON.parse(JSON.stringify(clips));
  const firstX = { transition: inner[0].transition, transitionType: inner[0].transitionType, transitionDir: inner[0].transitionDir };
  inner[0].transition = 0;
  delete inner[inner.length - 1].endFade;
  const innerItems = items.map(({ kind, item }) => {
    const copy = JSON.parse(JSON.stringify(item));
    copy.start = Math.max(0, item.start - t0);
    delete copy.group;
    return { kind, item: copy };
  });
  const saved = { clips: state.clips, texts: state.texts, audio: state.audio, overlays: state.overlays, stickers: state.stickers, adjust: state.adjust };
  const out = await window.api.compoundPath();
  const settings = { format: 'mp4', fps: 30, crf: 14, loud: false, hw: 'auto' };
  const [width, height] = exportSize(1080);
  exportingWhat = 'one clip';
  exportModal('running', 'Combining the clips into one.');
  $('#exportTitle').textContent = 'Combining clips';
  const off = window.api.onExportProgress(setProgress);
  setProgress(0);
  let project;
  try {
    state.clips = inner;
    const pick = (k) => innerItems.filter((x) => x.kind === k).map((x) => x.item);
    state.texts = pick('text'); state.audio = pick('audio'); state.overlays = pick('overlay'); state.stickers = pick('sticker'); state.adjust = pick('adjust');
    project = buildExportProject(settings, width, height);
    project.cover = null;
    await loadAllGifs();
    project.captions = await renderCaptionFrames(project.total, width, height, settings.fps);
    project.fxMasks = await renderFxMasks(project.total, width, height, settings.fps);
    await renderClipMasks(project, width, height, settings.fps);
  } catch (err) {
    Object.assign(state, saved);
    off();
    exportModal('error', `The clips couldn't be combined: ${cleanError(err)}`);
    $('#exportTitle').textContent = 'Combining failed';
    return;
  }
  Object.assign(state, saved);
  try {
    await window.api.exportVideo(project, out);
    const info = await window.api.probe(out);
    const m = { id: newId('m'), ...info, name: `Combined (${clips.length} clips)` };
    commit();
    state.media.push(m);
    loadLevels(m);
    const c = newClip(m);
    Object.assign(c, firstX, { compound: { clips: JSON.parse(JSON.stringify(clips)), items: JSON.parse(JSON.stringify(items)), length: t1 - t0, t0 } });
    const lastEndFade = clips[clips.length - 1].endFade;
    if (lastEndFade && run.to === state.clips.length - 1) c.endFade = lastEndFade;
    state.clips.splice(run.from, clips.length, c);
    for (const { kind, item } of items) {
      const list = listOf(kind);
      const i = list.indexOf(item);
      if (i >= 0) list.splice(i, 1);
    }
    selection = [{ kind: 'clip', id: c.id }];
    markDirty();
    renderAll();
    refreshSelectionUI();
    renderInspector();
    refreshPreview();
    $('#exportModal').hidden = true;
    toast(`Combined ${clips.length} clips into one. Right-click it to split it back apart.`);
  } catch (err) {
    const msg = cleanError(err);
    if (msg.includes('cancelled')) $('#exportModal').hidden = true;
    else { exportModal('error', `The clips couldn't be combined: ${msg}`); $('#exportTitle').textContent = 'Combining failed'; }
  } finally {
    off();
  }
}

function uncombineClip(c) {
  if (!c || !c.compound) return;
  const i = state.clips.indexOf(c);
  if (i < 0) return;
  commit();
  const t = clipStarts()[i];
  const back = c.compound.clips.map((x) => ({ ...JSON.parse(JSON.stringify(x)), id: newId('c') }));
  back[0].transition = c.transition || 0;
  if (c.transitionType) back[0].transitionType = c.transitionType;
  state.clips.splice(i, 1, ...back);
  // The other items go back where they were, relative to where the combined clip now starts.
  const made = [];
  for (const { kind, item } of c.compound.items) {
    const x = { ...JSON.parse(JSON.stringify(item)), id: newId(kind[0]) };
    x.start = Math.max(0, t + (item.start - (c.compound.t0 || 0)));
    listOf(kind).push(x);
    made.push({ kind, id: x.id });
  }
  selection = [...back.map((x) => ({ kind: 'clip', id: x.id })), ...made];
  markDirty();
  renderAll();
  refreshSelectionUI();
  renderInspector();
  refreshPreview();
  toast(`Split back into ${back.length} clips${(c.in > 0.01 || Math.abs(c.out - c.compound.length) > 0.05) ? ' (any trimming of the combined clip is undone)' : ''}`);
}


// ---------- safe zones
// Where each app puts its own buttons, captions and bars over a full-screen portrait video, as
// shares of the frame (from the apps' layouts at the time of writing; they change now and then).
const SAFE_ZONES = {
  tiktok: { name: 'TikTok', zones: [
    { x: 0, y: 0, w: 1, h: 0.075, label: 'Following · For You' },
    { x: 0.86, y: 0.36, w: 0.14, h: 0.44, label: 'Like, comment, share' },
    { x: 0, y: 0.8, w: 1, h: 0.2, label: 'Name, caption and sound' },
  ] },
  reels: { name: 'Instagram Reels', zones: [
    { x: 0, y: 0, w: 1, h: 0.08, label: 'Reels · camera' },
    { x: 0.86, y: 0.5, w: 0.14, h: 0.3, label: 'Like, comment, share' },
    { x: 0, y: 0.8, w: 1, h: 0.2, label: 'Name, caption and audio' },
  ] },
  shorts: { name: 'YouTube Shorts', zones: [
    { x: 0, y: 0, w: 1, h: 0.07, label: 'Search · menu' },
    { x: 0.85, y: 0.42, w: 0.15, h: 0.4, label: 'Like, dislike, comment, share' },
    { x: 0, y: 0.82, w: 1, h: 0.18, label: 'Channel, title and sound' },
  ] },
  whatsapp: { name: 'WhatsApp status', zones: [
    { x: 0, y: 0, w: 1, h: 0.1, label: 'Progress bar and name' },
    { x: 0, y: 0.89, w: 1, h: 0.11, label: 'Reply' },
  ] },
};
let safeZone = null;
try { safeZone = localStorage.getItem('snippy.safe') || null; } catch { safeZone = null; }
if (safeZone && !SAFE_ZONES[safeZone]) safeZone = null;

function setSafeZone(id) {
  safeZone = id && SAFE_ZONES[id] ? id : null;
  try { if (safeZone) localStorage.setItem('snippy.safe', safeZone); else localStorage.removeItem('snippy.safe'); } catch { /* not kept */ }
  drawSafeZones();
  if (safeZone && state.aspect !== '9:16') toast(`${SAFE_ZONES[safeZone].name} shows portrait (9:16) videos full screen; this project is ${state.aspect}, so it will have bars`);
}

function drawSafeZones() {
  const box = $('#safeZones');
  const btn = $('#safeBtn');
  box.textContent = '';
  box.hidden = !safeZone;
  btn.setAttribute('aria-pressed', String(Boolean(safeZone)));
  btn.title = safeZone ? `Showing ${SAFE_ZONES[safeZone].name}'s buttons (click to change)` : 'Safe zones: see where an app’s buttons and captions cover the video';
  if (!safeZone) return;
  const z = SAFE_ZONES[safeZone];
  for (const r of z.zones) {
    box.append(h('div', { class: `safe-zone${r.w < 0.3 ? ' side' : ''}`, style: `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%` }, h('span', {}, r.label)));
  }
  box.append(h('div', { class: 'safe-name' }, z.name));
}

$('#safeBtn').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  openCtx(r.left, r.bottom + 4, [
    { title: 'Show where an app covers the video' },
    ...Object.entries(SAFE_ZONES).map(([id, z]) => ({ label: `${safeZone === id ? '✓ ' : ''}${z.name}`, onClick: () => setSafeZone(id) })),
    '-',
    { label: `${safeZone ? '' : '✓ '}Off`, onClick: () => setSafeZone(null) },
  ]);
});
drawSafeZones();

// ---------- borrowing the edit
// Some tools render something other than the edit on screen (a combined clip, a Short) through
// the normal export. They swap the timeline for a moment; autosave waits until it's back.
let stateBorrowed = false;
const EDIT_LISTS = ['clips', 'texts', 'audio', 'overlays', 'stickers', 'adjust', 'markers'];
async function withEdit(temp, fn) {
  const saved = { aspect: state.aspect };
  for (const k of EDIT_LISTS) saved[k] = state[k];
  stateBorrowed = true;
  try {
    for (const k of EDIT_LISTS) state[k] = temp[k] || [];
    if (temp.aspect) state.aspect = temp.aspect;
    return await fn();
  } finally {
    Object.assign(state, saved);
    stateBorrowed = false;
  }
}

// ---------- Find Shorts

const sh = { media: null, words: null, picks: [], sents: [], active: -1, playing: null };
const SH_KEY = (lang) => `shorts-v1|${lang || 'auto'}`;

function openShorts() {
  const vids = state.media.filter((m) => m.kind === 'video' && m.hasAudio);
  if (!vids.length) { toast('Import a video with speech in it first (a podcast, vlog, stream or talk)'); return; }
  const sel = $('#shSrc');
  sel.textContent = '';
  const longest = vids.slice().sort((a, b) => b.duration - a.duration)[0];
  for (const m of vids) sel.append(h('option', { value: m.id }, `${m.name} (${fmtLong(m.duration)})`));
  sel.value = sh.media && vids.includes(sh.media) ? sh.media.id : longest.id;
  if (!$('#shLang').options.length) {
    for (const o of $('#capLang').options) $('#shLang').append(h('option', { value: o.value }, o.textContent));
  }
  if (!$('#shLook').options.length) {
    for (const p of CAPTION_PRESETS) $('#shLook').append(h('option', { value: p.id }, p.name));
    $('#shLook').value = CAPTION_PRESETS.some((p) => p.id === 'boldbox') ? 'boldbox' : CAPTION_PRESETS[0].id;
  }
  $('#shModal').hidden = false;
  if (sh.picks.length && sh.media && sh.media.id === sel.value) shShowResults();
  else shShowSetup();
}

const fmtLong = (s) => {
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
};

function shShowSetup() {
  shStop();
  $('#shSetup').hidden = false;
  $('#shRun').hidden = true;
  $('#shResults').hidden = true;
  $('#shBack').hidden = true;
  $('#shEdit').hidden = true;
  $('#shGo').hidden = false;
  $('#shGo').disabled = false;
  $('#shGo').textContent = 'Find the best moments';
  $('#shModal .modal-card').classList.remove('wide');
  shUpdateNote();
}

function shUpdateNote() {
  const m = mediaById($('#shSrc').value);
  if (!m) return;
  const cached = m.speech && m.speechKey === SH_KEY($('#shLang').value);
  const mins = m.duration / 60;
  $('#shNote').textContent = cached
    ? 'This video has already been listened to, so finding moments is instant.'
    : `Snippy listens to the whole video on your computer first${mins > 3 ? `: for ${Math.round(mins)} minutes of video, expect roughly ${Math.max(1, Math.round(mins / 6))} to ${Math.max(2, Math.round(mins / 3))} minutes` : ''}. It's remembered afterwards, so trying other lengths is instant.`;
}
$('#shSrc').addEventListener('change', shUpdateNote);
$('#shLang').addEventListener('change', shUpdateNote);

function shProgress(p) {
  const msg = $('#shMsg');
  const bar = $('#shBar');
  if (p.phase === 'download') { msg.textContent = `Downloading the speech model (once only). ${Math.round(p.progress * 100)}%`; bar.style.width = `${Math.round(p.progress * 100)}%`; }
  else if (p.phase === 'loading') msg.textContent = 'Loading the speech model.';
  else if (p.phase === 'transcribe') { msg.textContent = 'Listening to the whole video.'; bar.style.width = `${Math.round(p.progress * 40)}%`; }
  else if (p.phase === 'align') { msg.textContent = `Timing every word. ${Math.round(p.progress * 100)}%`; bar.style.width = `${Math.round(40 + p.progress * 60)}%`; }
}

async function shFind() {
  const m = mediaById($('#shSrc').value);
  if (!m) return;
  const lang = $('#shLang').value || null;
  const key = SH_KEY(lang);
  $('#shSetup').hidden = true;
  $('#shRun').hidden = false;
  $('#shGo').disabled = true;
  $('#shBar').style.width = '0%';
  $('#shMsg').textContent = 'Getting ready.';
  try {
    if (!(m.speech && m.speechKey === key)) {
      let words = await window.api.getTranscript(m.path, key);
      if (!words) {
        const off = window.api.onCaptionsProgress(shProgress);
        try {
          const groups = await window.api.generateCaptions([{ path: m.path, in: 0, out: m.duration, start: 0, hasAudio: true, speed: 1 }], { language: lang, task: 'transcribe', maxWords: 4 });
          words = flattenWords(groups);
        } finally { off(); }
        window.api.putTranscript(m.path, key, words);
      }
      m.speech = words;
      m.speechKey = key;
    }
    if (!m.levels) {
      $('#shMsg').textContent = 'Listening for the lively bits.';
      try { m.levels = await window.api.audioLevels(m.path); } catch { /* scored without it */ }
    }
    sh.media = m;
    sh.words = m.speech;
    if (!sh.words.length) {
      $('#shRun').hidden = true; $('#shSetup').hidden = false; $('#shGo').disabled = false;
      $('#shNote').textContent = 'No speech was found in this video, so there are no moments to suggest. (Find Shorts works on talking: podcasts, vlogs, streams and talks.)';
      return;
    }
    const [min, max] = $('#shLen').value.split('-').map(Number);
    sh.sents = sentencesOf(sh.words);
    sh.picks = findShorts([{ start: 0, end: 0, text: '', words: sh.words.map((w) => ({ ...w })) }], {
      min, max, count: Number($('#shCount').value), levels: m.levels || null, hop: LEVEL_HOP, duration: m.duration,
    }).map((p) => ({ ...p, on: true }));
    sh.active = sh.picks.length ? 0 : -1;
    if (!sh.picks.length) {
      $('#shRun').hidden = true; $('#shSetup').hidden = false; $('#shGo').disabled = false;
      $('#shNote').textContent = 'There isn’t enough speech for a Short of that length. Try a shorter length.';
      return;
    }
    shShowResults();
  } catch (err) {
    console.error(err);
    const msg = cleanError(err);
    $('#shRun').hidden = true; $('#shSetup').hidden = false; $('#shGo').disabled = false;
    $('#shNote').textContent = msg.includes('cancelled') ? '' : `The video couldn't be listened to: ${msg}`;
  }
}

function shShowResults() {
  $('#shSetup').hidden = true;
  $('#shRun').hidden = true;
  $('#shResults').hidden = false;
  $('#shBack').hidden = false;
  $('#shEdit').hidden = false;
  $('#shGo').hidden = false;
  $('#shGo').disabled = false;
  $('#shModal .modal-card').classList.add('wide');
  const v = $('#shVideo');
  const src = srcFor(sh.media);
  if (v.dataset.src !== src) { v.src = src; v.dataset.src = src; }
  shRenderList();
  shCue(sh.active, false);
}

function shRenderList() {
  const list = $('#shList');
  list.textContent = '';
  sh.picks.forEach((p, i) => {
    const thumb = h('div', { class: 'sh-thumb' });
    if (p.thumb) thumb.style.backgroundImage = `url("${p.thumb}")`;
    else shThumb(p, thumb);
    const nudge = (label, title, fn) => h('button', { class: 'sh-nudge', title, onClick: (e) => { e.stopPropagation(); fn(); } }, label);
    const card = h('div', { class: `sh-item${i === sh.active ? ' active' : ''}${p.on ? '' : ' off'}`, role: 'listitem', onClick: () => shCue(i, true) },
      h('label', { class: 'sh-check', onClick: (e) => e.stopPropagation() },
        h('input', { type: 'checkbox', checked: p.on ? '' : null, 'aria-label': `Export Short ${i + 1}`, onChange: (e) => { p.on = e.target.checked; card.classList.toggle('off', !p.on); shUpdateGo(); } })),
      thumb,
      h('div', { class: 'sh-body' },
        h('div', { class: 'sh-title' }, `“${p.title}”`),
        h('div', { class: 'sh-meta' }, h('b', { class: 'sh-score', title: 'How likely this is to work as a Short' }, String(p.score)), ` ${fmtLong(p.a)} to ${fmtLong(p.b)} · ${Math.round(p.b - p.a)} s`),
        h('div', { class: 'sh-tags' }, ...p.reasons.map((r) => h('span', { class: 'sh-tag good' }, r)), ...p.warn.map((r) => h('span', { class: 'sh-tag warn' }, r))),
        h('div', { class: 'sh-nudges' },
          h('span', {}, 'Start'), nudge('−', 'Start a sentence earlier', () => shNudge(p, 'first', -1)), nudge('+', 'Start a sentence later', () => shNudge(p, 'first', 1)),
          h('span', {}, 'End'), nudge('−', 'End a sentence earlier', () => shNudge(p, 'last', -1)), nudge('+', 'End a sentence later', () => shNudge(p, 'last', 1)))));
    list.append(card);
  });
  shUpdateGo();
}

function shUpdateGo() {
  const n = sh.picks.filter((p) => p.on).length;
  $('#shGo').textContent = n ? `Export ${n} Short${n === 1 ? '' : 's'}` : 'Tick the ones to export';
  $('#shGo').disabled = !n;
}

async function shThumb(p, el) {
  try {
    const f = await window.api.grabFrame(sh.media.path, Math.min(sh.media.duration - 0.1, p.a + 1));
    const info = await window.api.probe(f);
    p.thumb = info.url;
    el.style.backgroundImage = `url("${p.thumb}")`;
  } catch { /* no picture */ }
}

// Moves a Short's start or end by a whole sentence.
function shNudge(p, end, dir) {
  const n = sh.sents.length;
  if (end === 'first') p.first = clamp(p.first + dir, 0, p.last);
  else p.last = clamp(p.last + dir, p.first, n - 1);
  const before = p.first > 0 ? sh.sents[p.first - 1].e : 0;
  const after = p.last < n - 1 ? sh.sents[p.last + 1].s : sh.media.duration;
  p.a = Number(Math.max(before, sh.sents[p.first].s - 0.2, 0).toFixed(3));
  p.b = Number(Math.min(after, sh.sents[p.last].e + 0.4, sh.media.duration).toFixed(3));
  p.title = sh.sents[p.first].text.length > 80 ? `${sh.sents[p.first].text.slice(0, 77).replace(/\s+\S*$/, '')}…` : sh.sents[p.first].text;
  p.thumb = null;
  shRenderList();
  shCue(sh.picks.indexOf(p), true);
}

function shCue(i, play) {
  if (i < 0 || !sh.picks[i]) return;
  sh.active = i;
  $('#shList').querySelectorAll('.sh-item').forEach((el, k) => el.classList.toggle('active', k === i));
  const p = sh.picks[i];
  const v = $('#shVideo');
  const go = () => { v.currentTime = p.a; if (play) v.play().catch(() => {}); };
  if (v.readyState >= 1) go(); else v.addEventListener('loadedmetadata', go, { once: true });
  sh.playing = p;
}

function shStop() { const v = $('#shVideo'); if (!v.paused) v.pause(); }

$('#shVideo').addEventListener('timeupdate', () => {
  const v = $('#shVideo');
  const p = sh.playing;
  if (!p) return;
  if (v.currentTime >= p.b) { v.pause(); v.currentTime = p.a; }
  const w = sh.words ? sh.words.filter((x) => x.s <= v.currentTime + 0.05 && x.e >= v.currentTime - 1.2 && x.s >= v.currentTime - 1.6) : [];
  $('#shCap').textContent = w.slice(-4).map((x) => x.text).join(' ');
});
$('#shVideo').addEventListener('click', () => { const v = $('#shVideo'); if (v.paused) v.play().catch(() => {}); else v.pause(); });

// The edit for one Short: the moment's pieces (pauses cut), captions, and a title at the top.
function shortEdit(p, m) {
  const tr = tightenRange(sh.words, p.a, p.b, { tighten: $('#shTight').checked });
  const clips = tr.keep.map((r) => ({ ...newClip(m), in: r.s, out: r.e }));
  const look = CAPTION_PRESETS.find((x) => x.id === $('#shLook').value);
  const style = { size: 6, position: 'bottom', color: '#FFFFFF', anim: 'pop', highlight: true, hlColor: '#FFD84D', box: false, caps: true, ...(look ? look.set : {}) };
  // Kept above the apps' caption and button areas (the bottom fifth of the screen).
  style.position = 'bottom';
  style.offsetY = -0.17;
  const texts = captionGroups(tr.words, 4).map((g) => ({ id: newId('t'), text: g.text, start: g.start, dur: Math.max(MIN_LEN, g.end - g.start), words: g.words, ...style, auto: true }));
  if ($('#shHook').checked) {
    let t = p.title.replace(/…$/, '');
    if (t.length > 60) t = `${t.slice(0, 57).replace(/\s+\S*$/, '')}…`;
    texts.unshift({ id: newId('t'), text: t, start: 0, dur: Math.min(3.2, tr.length), size: 5.5, position: 'top', offsetY: 0.06, color: '#111111', box: true, boxColor: '#FFFFFF', anim: 'pop', caps: false });
  }
  return { clips, texts, length: tr.length };
}

// Keeping the speaker in shot: the person is followed once over the whole moment, then each
// piece gets its own camera move from that.
async function shortPlans(clips, m, p, onStep) {
  const [cw, ch] = ASPECTS['9:16'];
  const fill = fillFor(m.width / m.height, cw / ch);
  const plans = new Map();
  if (!fill.axis) return plans;
  let samples = null;
  if ($('#shFollow').checked) {
    const key = `${m.path}|short|${p.a.toFixed(2)}|${p.b.toFixed(2)}`;
    samples = trackCache.get(key);
    if (!samples) {
      if (onStep) onStep();
      try { samples = await window.api.trackSubject(m.path, p.a, p.b, m.width, m.height, 'short'); trackCache.set(key, samples); } catch (err) { console.warn('Following the speaker failed; centring', err); }
    }
  }
  for (const c of clips) {
    const part = samples ? samples.filter((s) => s.t >= c.in - 0.6 && s.t <= c.out + 0.6) : [];
    plans.set(c.id, part.length > 1
      ? planReframe(part, { srcAspect: m.width / m.height, canvasAspect: cw / ch, in: c.in, speed: 1, length: c.out - c.in }) || { zoom: fill.zoom }
      : { zoom: fill.zoom, keys: undefined });
  }
  return plans;
}

async function shExport() {
  const picks = sh.picks.filter((p) => p.on);
  if (!picks.length) return;
  shStop();
  const first = await window.api.pickExportPath('mp4');
  if (!first) return;
  const stem = first.replace(/\.[^.\\/]+$/, '');
  const m = sh.media;
  $('#shModal').hidden = true;
  exportingWhat = 'MP4';
  const settings = { format: 'mp4', fps: 30, crf: 20, loud: true, hw: $('#exHw').value || 'auto' };
  const done = [];
  const off = window.api.onExportProgress(setProgress);
  try {
    for (let i = 0; i < picks.length; i++) {
      const p = picks[i];
      const label = `Short ${i + 1} of ${picks.length}: `;
      setProgress(0);
      exportModal('running', `${label}getting it ready.`);
      $('#exportTitle').textContent = 'Exporting Shorts';
      const edit = shortEdit(p, m);
      const plans = await shortPlans(edit.clips, m, p, () => exportModal('running', `${label}following the speaker.`));
      const [width, height] = exportSize(1080, '9:16');
      const safe = p.title.replace(/[\\/:*?"<>|…]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 40).replace(/[.\s]+$/, '');
      const out = picks.length === 1 && i === 0 ? first : `${stem} - Short ${i + 1}${safe ? ` - ${safe}` : ''}.mp4`;
      const project = await withEdit({ clips: edit.clips, texts: edit.texts, aspect: '9:16' }, async () => {
        const pr = buildFor('9:16', plans, settings, width, height);
        pr.cover = null; // the project's own cover isn't this Short's
        pr.captions = await renderCaptionFrames(pr.total, width, height, settings.fps);
        pr.fxMasks = await renderFxMasks(pr.total, width, height, settings.fps);
        await renderClipMasks(pr, width, height, settings.fps);
        return pr;
      });
      exportModal('running', `${label}rendering.`);
      $('#exportTitle').textContent = 'Exporting Shorts';
      await window.api.exportVideo(project, out);
      done.push(out);
    }
    setProgress(1);
    lastExportPath = done[0];
    exportModal('done', `Saved ${done.length} Short${done.length === 1 ? '' : 's'}:\n${done.join('\n')}`);
  } catch (err) {
    const msg = cleanError(err);
    if (msg.includes('cancelled')) $('#exportModal').hidden = true;
    else exportModal('error', done.length ? `${msg}\n\nAlready saved:\n${done.join('\n')}` : msg);
  } finally {
    off();
  }
}

// Opens one Short as its own project, to keep editing it.
async function shEditOne() {
  const p = sh.picks[sh.active];
  if (!p) return;
  if (!confirmDiscard()) return;
  shStop();
  const m = sh.media;
  const edit = shortEdit(p, m);
  $('#shMsg').textContent = 'Following the speaker.';
  const plans = await shortPlans(edit.clips, m, p);
  const media = { ...m };
  delete media.levelsPending;
  resetProject();
  projectPath = null;
  state.media = [media];
  setAspect('9:16');
  state.clips = edit.clips.map((c) => {
    const pl = plans.get(c.id);
    if (pl) { Object.assign(c, { zoom: pl.zoom, posX: 0, posY: 0, keys: pl.keys }); migrateMotion(c); }
    return c;
  });
  state.texts = edit.texts;
  $('#shModal').hidden = true;
  dirty = true;
  syncTitle();
  overlayKey = null;
  renderAll();
  refreshPreview();
  seek(0);
  toast('Opened the Short as a new project. Save it with Ctrl+S.');
}

$('#shortsBtn').addEventListener('click', openShorts);
$('#shCancel').addEventListener('click', () => {
  if (!$('#shRun').hidden) window.api.cancelCaptions();
  shStop();
  $('#shModal').hidden = true;
});
$('#shBack').addEventListener('click', shShowSetup);
$('#shEdit').addEventListener('click', shEditOne);
$('#shGo').addEventListener('click', () => { if ($('#shResults').hidden) shFind(); else shExport(); });

// ---------- thumbnail maker

const TH_SIZES = { '16:9': [1280, 720, 'YouTube'], '9:16': [1080, 1920, 'Cover 9:16'], '1:1': [1080, 1080, 'Square'] };
const TH_FONTS = [['impact', 'Impact', 'Impact, "Arial Black", "Segoe UI Black", sans-serif', 400], ['heavy', 'Heavy', '"Segoe UI Black", "Arial Black", system-ui, sans-serif', 900], ['clean', 'Clean', '"Segoe UI", system-ui, sans-serif', 700]];
const TH_STYLES = [
  { id: 'yellow', name: 'Yellow', fill: '#FFE14D', stroke: '#000000' },
  { id: 'white', name: 'White', fill: '#FFFFFF', stroke: '#000000' },
  { id: 'redbox', name: 'Red box', fill: '#FFFFFF', box: '#E5252A' },
  { id: 'whitebox', name: 'White box', fill: '#111111', box: '#FFFFFF' },
  { id: 'glow', name: 'Glow', fill: '#FFFFFF', glow: '#FF3DA6' },
  { id: 'black', name: 'Black', fill: '#111111', stroke: '#FFFFFF' },
];
const TH_EMOJI = ['😱', '🔥', '➡️', '⬅️', '❌', '✅', '💯', '👀', '😂', '⭐', '❗', '❓'];

const th = { size: '16:9', img: null, src: null, zoom: 1, panX: 0, panY: 0, pop: 0.45, vig: 0.3, layers: [], sel: 0, boxes: [], frames: [] };

function thDefaultLayers() {
  return [{ type: 'text', text: 'YOUR TITLE', x: 0.5, y: th.size === '9:16' ? 0.3 : 0.76, size: th.size === '9:16' ? 0.075 : 0.17, style: 'yellow', font: 'impact', caps: true }];
}

async function openThumb() {
  if (!state.clips.some((c) => { const m = mediaById(c.mediaId); return m && m.kind !== 'audio'; })) { toast('Add a video or photo first'); return; }
  if (!th.layers.length) {
    th.size = TH_SIZES[state.aspect] ? state.aspect : '16:9';
    th.layers = thDefaultLayers();
    const first = state.texts.find((x) => !x.auto && x.text && x.text.length < 40);
    if (first) th.layers[0].text = first.text.toUpperCase();
  }
  $('#thumbModal').hidden = false;
  thControls();
  if (!th.img) await thUseTime(state.playhead);
  thDraw();
  thSuggest();
}

// A frame of the edit at timeline time t, as an image.
async function thFrameAt(t) {
  const loc = locate(clamp(t, 0, Math.max(0, totalDuration() - 0.05)));
  if (!loc) return null;
  const m = mediaById(loc.clip.mediaId);
  if (!m || m.kind === 'audio') return null;
  let url;
  if (isImage(m)) url = m.url;
  else {
    const f = await window.api.grabFrame(m.path, Math.min(loc.src, m.duration - 0.05));
    url = (await window.api.probe(f)).url;
  }
  const img = new Image();
  img.src = url;
  await img.decode();
  return { img, url, t };
}

async function thUseTime(t) {
  try {
    const f = await thFrameAt(t);
    if (f) { th.img = f.img; th.src = f.url; th.zoom = 1; th.panX = 0; th.panY = 0; $('#thZoom').value = '1'; thDraw(); thMarkFrame(); }
  } catch (err) { console.warn(err); toast('That frame couldn’t be read'); }
}

// How good a frame looks as a thumbnail: sharp, colourful and well lit.
function frameScore(img) {
  const W = 160;
  const H = Math.max(2, Math.round((W * img.height) / img.width));
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const Y = new Float32Array(W * H);
  let rg = 0, yb = 0, rg2 = 0, yb2 = 0, sumY = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    Y[p] = 0.299 * r + 0.587 * g + 0.114 * b;
    sumY += Y[p];
    const a = r - g; const c = 0.5 * (r + g) - b;
    rg += a; yb += c; rg2 += a * a; yb2 += c * c;
  }
  const n = W * H;
  const sdRg = Math.sqrt(Math.max(0, rg2 / n - (rg / n) ** 2));
  const sdYb = Math.sqrt(Math.max(0, yb2 / n - (yb / n) ** 2));
  const colour = Math.sqrt(sdRg ** 2 + sdYb ** 2) + 0.3 * Math.sqrt((rg / n) ** 2 + (yb / n) ** 2);
  let lap = 0, lap2 = 0, m = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      const v = 4 * Y[p] - Y[p - 1] - Y[p + 1] - Y[p - W] - Y[p + W];
      lap += v; lap2 += v * v; m++;
    }
  }
  const sharp = Math.sqrt(Math.max(0, lap2 / m - (lap / m) ** 2));
  const bright = sumY / n;
  const light = 1 - Math.min(1, Math.abs(bright - 125) / 100);
  return { sharp, colour, light };
}

async function thSuggest() {
  const box = $('#thFrames');
  const total = totalDuration();
  if (th.framesFor === `${total}|${state.clips.length}` && th.frames.length) { thRenderFrames(); return; }
  box.textContent = '';
  box.append(h('p', { class: 'hint' }, 'Looking for good frames…'));
  const N = 12;
  const found = [];
  for (let k = 0; k < N; k++) {
    if ($('#thumbModal').hidden) return;
    const t = ((k + 0.5) / N) * total;
    try {
      const f = await thFrameAt(t);
      if (f) found.push({ ...f, ...frameScore(f.img) });
    } catch { /* skip this one */ }
  }
  if (!found.length) { box.textContent = ''; return; }
  const top = (k) => Math.max(...found.map((f) => f[k])) || 1;
  const ms = top('sharp'); const mc = top('colour');
  for (const f of found) f.score = 0.45 * (f.sharp / ms) + 0.35 * (f.colour / mc) + 0.2 * f.light;
  found.sort((a, b) => b.score - a.score);
  th.frames = found.slice(0, 8);
  th.framesFor = `${total}|${state.clips.length}`;
  thRenderFrames();
}

function thRenderFrames() {
  const box = $('#thFrames');
  box.textContent = '';
  th.frames.forEach((f, i) => {
    box.append(h('button', {
      class: 'th-frame', 'data-url': f.url, title: `At ${fmt(f.t)}${i < 2 ? ' (a top pick)' : ''}`, style: `background-image:url("${f.url}")`,
      onClick: () => { th.img = f.img; th.src = f.url; th.zoom = 1; th.panX = 0; th.panY = 0; $('#thZoom').value = '1'; thDraw(); thMarkFrame(); },
    }, i < 2 ? h('span', { class: 'th-star' }, '★') : null));
  });
  thMarkFrame();
}
function thMarkFrame() { $('#thFrames').querySelectorAll('.th-frame').forEach((b) => b.classList.toggle('on', b.dataset.url === th.src)); }

function thLayout(ctx, L, W, H) {
  const [, , fam, weight] = TH_FONTS.find((f) => f.id === L.font) || TH_FONTS[0];
  const px = Math.max(8, L.size * H);
  ctx.font = `${weight} ${px}px ${fam}`;
  const text = L.caps ? L.text.toUpperCase() : L.text;
  // Wrap to 90% of the width, keeping the lines the user typed.
  const lines = [];
  for (const raw of text.split('\n')) {
    let cur = '';
    for (const w of raw.split(/\s+/).filter(Boolean)) {
      const tryLine = cur ? `${cur} ${w}` : w;
      if (cur && ctx.measureText(tryLine).width > W * 0.9) { lines.push(cur); cur = w; } else cur = tryLine;
    }
    lines.push(cur);
  }
  const lh = px * (L.font === 'impact' ? 1.02 : 1.1);
  const widths = lines.map((l) => ctx.measureText(l).width);
  return { px, lines, lh, widths, w: Math.max(...widths, 1), h: lh * lines.length };
}

function drawThumb(ctx, W, H, { forExport = false } = {}) {
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (th.img) {
    const s = Math.max(W / th.img.width, H / th.img.height) * th.zoom;
    const dw = th.img.width * s; const dh = th.img.height * s;
    const x = (W - dw) / 2 + th.panX * W; const y = (H - dh) / 2 + th.panY * H;
    ctx.filter = `saturate(${1 + th.pop * 0.9}) contrast(${1 + th.pop * 0.3}) brightness(${1 + th.pop * 0.06})`;
    ctx.drawImage(th.img, x, y, dw, dh);
    ctx.filter = 'none';
  }
  if (th.vig > 0) {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.hypot(W, H) * 0.55);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${(th.vig * 0.85).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  th.boxes = [];
  th.layers.forEach((L, i) => {
    let box;
    if (L.type === 'emoji') {
      const px = L.size * Math.min(W, H);
      ctx.font = `${px}px ${EMOJI_FONT}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = px * 0.08; ctx.shadowOffsetY = px * 0.03;
      ctx.fillText(L.ch, L.x * W, L.y * H);
      ctx.shadowColor = 'transparent';
      box = { x: L.x * W - px * 0.55, y: L.y * H - px * 0.55, w: px * 1.1, h: px * 1.1 };
    } else {
      const st = TH_STYLES.find((s) => s.id === L.style) || TH_STYLES[0];
      const lay = thLayout(ctx, L, W, H);
      const top = L.y * H - lay.h / 2;
      // Kept inside the picture, however far it's dragged.
      const half = lay.w / 2 + lay.px * 0.22;
      const cx = half * 2 >= W ? W / 2 : clamp(L.x * W, half, W - half);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
      lay.lines.forEach((line, k) => {
        const cy = top + lay.lh * (k + 0.5);
        if (st.box) {
          const pad = lay.px * 0.16;
          ctx.fillStyle = st.box;
          ctx.fillRect(cx - lay.widths[k] / 2 - pad, cy - lay.lh / 2 + lay.px * 0.02, lay.widths[k] + pad * 2, lay.lh);
        }
        if (st.glow) { ctx.shadowColor = st.glow; ctx.shadowBlur = lay.px * 0.35; }
        else { ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = lay.px * 0.1; ctx.shadowOffsetY = lay.px * 0.04; }
        if (st.stroke) {
          ctx.strokeStyle = st.stroke; ctx.lineWidth = lay.px * 0.16;
          ctx.strokeText(line, cx, cy + lay.px * 0.04);
          ctx.shadowColor = 'transparent';
        }
        ctx.fillStyle = st.fill;
        ctx.fillText(line, cx, cy + lay.px * 0.04);
        if (st.glow) ctx.fillText(line, cx, cy + lay.px * 0.04);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      });
      box = { x: cx - lay.w / 2 - lay.px * 0.2, y: top, w: lay.w + lay.px * 0.4, h: lay.h };
    }
    th.boxes[i] = box;
    if (!forExport && i === th.sel) {
      ctx.strokeStyle = 'rgba(192,132,252,0.95)'; ctx.lineWidth = Math.max(2, W / 400); ctx.setLineDash([W / 120, W / 160]);
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.setLineDash([]);
    }
  });
  ctx.restore();
}

function thDraw() {
  const cv = $('#thCanvas');
  const [W, H] = TH_SIZES[th.size];
  const maxW = th.size === '9:16' ? 300 : th.size === '1:1' ? 420 : 560;
  const k = maxW / W;
  const dpr = window.devicePixelRatio || 1;
  cv.style.width = `${Math.round(W * k)}px`;
  cv.style.height = `${Math.round(H * k)}px`;
  cv.width = Math.round(W * k * dpr);
  cv.height = Math.round(H * k * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(k * dpr, 0, 0, k * dpr, 0, 0);
  drawThumb(ctx, W, H);
}

function thSelected() { return th.layers[th.sel] || null; }

function thControls() {
  fillSeg($('#thSize'), Object.entries(TH_SIZES).map(([id, [, , name]]) => [id, name]), th.size, (v) => {
    const was = th.size;
    th.size = v;
    // Portrait has room for text higher up and smaller; landscape low and big.
    if (was !== v) for (const L of th.layers) if (L.type === 'text') L.size = clamp(L.size * (v === '9:16' ? 0.45 : was === '9:16' ? 2.2 : 1), 0.06, 0.4);
    thControls(); thDraw();
  });
  const L = thSelected();
  const isText = L && L.type === 'text';
  $('#thText').value = isText ? L.text : '';
  $('#thText').disabled = !isText;
  $('#thTextSize').value = String(L ? L.size : 0.15);
  $('#thTextSize').disabled = !L;
  $('#thDel').disabled = !L;
  const styles = $('#thStyles');
  styles.textContent = '';
  for (const st of TH_STYLES) {
    styles.append(h('button', {
      class: 'th-style', 'aria-pressed': String(Boolean(isText) && L.style === st.id), disabled: isText ? null : '', title: st.name,
      style: `color:${st.fill};background:${st.box || '#2a2d36'};${st.stroke ? `-webkit-text-stroke:1px ${st.stroke};` : ''}${st.glow ? `text-shadow:0 0 6px ${st.glow};` : ''}`,
      onClick: () => { if (!isText) return; L.style = st.id; thControls(); thDraw(); },
    }, 'Aa'));
  }
  fillSeg($('#thFonts'), TH_FONTS.map(([id, name]) => [id, name]), isText ? L.font : 'impact', (v) => { if (isText) { L.font = v; thDraw(); } });
  const em = $('#thEmoji');
  if (!em.childElementCount) {
    for (const ch of TH_EMOJI) {
      em.append(h('button', { class: 'th-em', title: 'Add', onClick: () => { th.layers.push({ type: 'emoji', ch, x: 0.82, y: 0.3, size: 0.24 }); th.sel = th.layers.length - 1; thControls(); thDraw(); } }, ch));
    }
  }
  $('#thPop').value = String(th.pop);
  $('#thVig').value = String(th.vig);
  $('#thZoom').value = String(th.zoom);
}

$('#thText').addEventListener('input', (e) => { const L = thSelected(); if (L && L.type === 'text') { L.text = e.target.value; thDraw(); } });
$('#thTextSize').addEventListener('input', (e) => { const L = thSelected(); if (L) { L.size = Number(e.target.value); thDraw(); } });
$('#thPop').addEventListener('input', (e) => { th.pop = Number(e.target.value); thDraw(); });
$('#thVig').addEventListener('input', (e) => { th.vig = Number(e.target.value); thDraw(); });
$('#thZoom').addEventListener('input', (e) => { th.zoom = Number(e.target.value); thDraw(); });
$('#thAddText').addEventListener('click', () => {
  th.layers.push({ type: 'text', text: 'MORE TEXT', x: 0.5, y: 0.2, size: th.size === '9:16' ? 0.05 : 0.11, style: 'white', font: 'impact', caps: true });
  th.sel = th.layers.length - 1; thControls(); thDraw();
  $('#thText').focus(); $('#thText').select();
});
$('#thDel').addEventListener('click', () => { if (!thSelected()) return; th.layers.splice(th.sel, 1); th.sel = Math.max(0, th.layers.length - 1); thControls(); thDraw(); });
$('#thHere').addEventListener('click', () => thUseTime(state.playhead));

function thHit(e) {
  const r = $('#thCanvas').getBoundingClientRect();
  const [W, H] = TH_SIZES[th.size];
  const x = ((e.clientX - r.left) / r.width) * W;
  const y = ((e.clientY - r.top) / r.height) * H;
  for (let i = th.layers.length - 1; i >= 0; i--) {
    const b = th.boxes[i];
    if (b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return i;
  }
  return -1;
}

$('#thCanvas').addEventListener('pointerdown', (e) => {
  const cv = $('#thCanvas');
  const r = cv.getBoundingClientRect();
  const i = thHit(e);
  cv.setPointerCapture(e.pointerId);
  const sx = e.clientX; const sy = e.clientY;
  if (i >= 0) {
    th.sel = i;
    const L = th.layers[i];
    const o = { x: L.x, y: L.y };
    thControls(); thDraw();
    const move = (ev) => {
      L.x = clamp(o.x + (ev.clientX - sx) / r.width, 0, 1);
      L.y = clamp(o.y + (ev.clientY - sy) / r.height, 0, 1);
      // A gentle pull to the middle line.
      if (Math.abs(L.x - 0.5) < 0.015) L.x = 0.5;
      thDraw();
    };
    const up = () => { cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); };
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
  } else {
    const o = { x: th.panX, y: th.panY };
    const move = (ev) => {
      const lim = (th.zoom - 1) / 2 + 0.25;
      th.panX = clamp(o.x + (ev.clientX - sx) / r.width, -lim, lim);
      th.panY = clamp(o.y + (ev.clientY - sy) / r.height, -lim, lim);
      thDraw();
    };
    const up = () => { cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); };
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
  }
});
$('#thCanvas').addEventListener('wheel', (e) => {
  e.preventDefault();
  const i = thHit(e);
  const f = e.deltaY < 0 ? 1.06 : 1 / 1.06;
  if (i >= 0) { th.sel = i; th.layers[i].size = clamp(th.layers[i].size * f, 0.04, 0.6); }
  else th.zoom = clamp(th.zoom * f, 1, 3);
  thControls(); thDraw();
}, { passive: false });
$('#thCanvas').addEventListener('dblclick', (e) => { const i = thHit(e); if (i >= 0 && th.layers[i].type === 'text') { $('#thText').focus(); $('#thText').select(); } });
$('#thCanvas').addEventListener('keydown', (e) => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && thSelected()) { e.preventDefault(); $('#thDel').click(); }
});

function thRender(type, quality) {
  const [W, H] = TH_SIZES[th.size];
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  drawThumb(cv.getContext('2d'), W, H, { forExport: true });
  if (type !== 'image/jpeg') return cv.toDataURL('image/png');
  // YouTube takes thumbnails up to 2 MB.
  let q = quality || 0.92;
  let url = cv.toDataURL('image/jpeg', q);
  while (url.length * 0.75 > 1.9e6 && q > 0.5) { q -= 0.08; url = cv.toDataURL('image/jpeg', q); }
  return url;
}

async function thSave(type) {
  const name = `${projectName()} thumbnail`.replace(/[\\/:*?"<>|]+/g, '');
  try {
    const p = await window.api.saveImage(thRender(type), name);
    if (p) toast(`Saved ${p.split(/[\\/]/).pop()}`);
  } catch (err) { toast(`Couldn't save the thumbnail: ${cleanError(err)}`); }
}
$('#thJpg').addEventListener('click', () => thSave('image/jpeg'));
$('#thPng').addEventListener('click', () => thSave('image/png'));
$('#thCover').addEventListener('click', () => {
  state.cover = thRender('image/jpeg', 0.9);
  markDirty();
  toast('Set as the cover: it’s saved inside the MP4 when you export');
});
$('#thCancel').addEventListener('click', () => { $('#thumbModal').hidden = true; });
$('#thumbBtn').addEventListener('click', openThumb);


// ---------- first run: the video tools
// The installer leaves out FFmpeg to stay small; the first time Snippy opens it fetches it
// (once), with a progress bar, and everything else waits until it's there.
async function toolsReady() {
  let st;
  try { st = await window.api.componentsStatus(); } catch { return; } // older main.js: tools bundled
  if (!st || st.ready) return;
  const modal = $('#setupModal');
  const bar = $('#setupBar');
  const msg = $('#setupMsg');
  const retry = $('#setupRetry');
  modal.hidden = false;
  const off = window.api.onComponentsProgress((p) => {
    if (p.file === 'ai') return;
    const f = p.total ? p.done / p.total : 0;
    bar.style.width = `${Math.round(f * 100)}%`;
    msg.textContent = `Downloading the video tools: ${(p.done / 1e6).toFixed(0)} of ${(p.total / 1e6).toFixed(0)} MB`;
  });
  try {
    for (;;) {
      retry.hidden = true;
      $('#setupQuit').hidden = true;
      bar.style.width = '0%';
      msg.textContent = 'Connecting…';
      try {
        const r = await window.api.installComponents();
        if (r && r.ready) break;
        throw new Error('The video tools still aren’t there.');
      } catch (err) {
        msg.textContent = `${cleanError(err)}`;
        retry.hidden = false;
        $('#setupQuit').hidden = false;
        await new Promise((resolve) => { retry.onclick = resolve; });
      }
    }
  } finally {
    off();
  }
  msg.textContent = 'All set!';
  bar.style.width = '100%';
  await new Promise((r) => setTimeout(r, 450));
  modal.hidden = true;
}
$('#setupQuit').addEventListener('click', () => window.close());


// The AI tools download the first time an AI feature is used: a small card shows how it's going.
if (window.api.onComponentsProgress) {
  window.api.onComponentsProgress((p) => {
    if (p.file !== 'ai') return;
    const card = $('#aiCard');
    if (p.finished) {
      $('#aiCardBar').style.width = '100%';
      $('#aiCardMsg').textContent = 'AI tools ready';
      setTimeout(() => { card.hidden = true; }, 900);
      return;
    }
    if (p.failed) { card.hidden = true; return; } // the feature itself says what went wrong
    card.hidden = false;
    const f = p.total ? p.done / p.total : 0;
    $('#aiCardBar').style.width = `${Math.round(f * 100)}%`;
    $('#aiCardMsg').textContent = p.total
      ? `Downloading Snippy's AI tools (one time only): ${(p.done / 1e6).toFixed(0)} of ${(p.total / 1e6).toFixed(0)} MB`
      : 'Getting Snippy’s AI tools (one time only)…';
  });
}

// ---------- brand kit
// Colours, a font, a caption look, a logo (with a watermark on every export if you like), and an
// intro and outro, saved once for every project.

const BRAND_DEFAULT = {
  colours: ['#C084FC', '#F472B6', '#FFD84D', '#FFFFFF', '#111111'],
  font: 'default',
  captionLook: '',
  useForNew: true,
  logo: null, // { path, url, width, height, corner, size, opacity, onExport }
  intro: null, // { path, name }
  outro: null,
};
let brand = null;
const brandSwatches = () => (brand ? brand.colours.filter(Boolean) : []);
function brandTextDefaults() {
  if (!brand || !brand.useForNew) return {};
  return brand.font && brand.font !== 'default' ? { font: brand.font } : {};
}
function brandCaptionStyle() {
  if (!brand || !brand.useForNew) return {};
  const look = CAPTION_PRESETS.find((p) => p.id === brand.captionLook);
  return { ...(look ? look.set : {}), ...brandTextDefaults(), ...(brand.colours[2] ? { hlColor: brand.colours[2] } : {}) };
}

(async () => {
  try { const k = await window.api.getBrand(); if (k) brand = { ...BRAND_DEFAULT, ...k }; } catch { /* none yet */ }
})();

let brandSaveTimer = 0;
function saveBrand() {
  clearTimeout(brandSaveTimer);
  brandSaveTimer = setTimeout(() => { window.api.setBrand(brand).catch(() => toast('The brand kit couldn’t be saved')); }, 250);
}

// Where the logo sits, as an overlay: a corner, its width as a share of the frame.
function logoPlacement(L, aspect) {
  const [cw, ch] = ASPECTS[aspect] || [16, 9];
  const w = L.size || 0.14;
  const hFrac = (w * (cw / ch)) / Math.max(0.1, (L.width || 1) / (L.height || 1));
  const m = 0.035;
  const right = (L.corner || 'br').includes('r');
  const bottom = (L.corner || 'br').startsWith('b');
  return {
    w,
    x: right ? 1 - w / 2 - m * (ch / cw) : w / 2 + m * (ch / cw),
    y: bottom ? 1 - hFrac / 2 - m : hFrac / 2 + m,
  };
}

// The logo on every export: added for the export only, unless the edit already has it.
function withBrandLogo(aspect, build) {
  const L = brand && brand.logo;
  if (!L || !L.onExport || !L.path || !state.clips.length || state.overlays.some((o) => o.brandLogo)) return build();
  const m = { id: newId('m'), kind: 'image', path: L.path, url: L.url, name: 'Logo', width: L.width, height: L.height, hasVideo: true, hasAudio: false, duration: 0 };
  const total = totalDuration();
  const o = { id: newId('o'), mediaId: m.id, start: 0, in: 0, out: total, opacity: L.opacity ?? 0.9, volume: 0, lane: laneCount(), brandLogo: true, ...logoPlacement(L, aspect) };
  state.media.push(m);
  state.overlays.push(o);
  try { return build(); } finally {
    state.overlays.splice(state.overlays.indexOf(o), 1);
    state.media.splice(state.media.indexOf(m), 1);
  }
}

async function addBrandMedia(p) {
  const existing = state.media.find((m) => m.path === p);
  if (existing) return existing;
  const info = await window.api.probe(p);
  const m = { id: newId('m'), ...info };
  state.media.push(m);
  loadLevels(m);
  queueProxy(m);
  return m;
}

// Puts the brand on this project: font and caption look on its text, the logo as an overlay you
// can see and move, and the intro and outro at the start and end.
async function applyBrand() {
  if (!brand) return;
  const done = [];
  commit();
  const look = CAPTION_PRESETS.find((p) => p.id === brand.captionLook);
  let restyled = 0;
  for (const t of state.texts) {
    if (brand.font && brand.font !== 'default') t.font = brand.font; else delete t.font;
    if (t.auto && look) { Object.assign(t, look.set); if (brand.colours[2]) t.hlColor = brand.colours[2]; }
    restyled++;
  }
  if (restyled) done.push(`${restyled} text${restyled === 1 ? '' : 's'} restyled`);
  try {
    if (brand.intro && brand.intro.path && !state.clips.some((c) => c.brand === 'intro')) {
      const m = await addBrandMedia(brand.intro.path);
      state.clips.unshift({ ...newClip(m), brand: 'intro' });
      done.push('intro added');
    }
    if (brand.outro && brand.outro.path && !state.clips.some((c) => c.brand === 'outro')) {
      const m = await addBrandMedia(brand.outro.path);
      state.clips.push({ ...newClip(m), brand: 'outro' });
      done.push('outro added');
    }
    if (brand.logo && brand.logo.path && state.clips.length && !state.overlays.some((o) => o.brandLogo)) {
      const m = await addBrandMedia(brand.logo.path);
      const o = { ...newOverlay(m, 0), out: totalDuration(), opacity: brand.logo.opacity ?? 0.9, brandLogo: true, ...logoPlacement(brand.logo, state.aspect) };
      o.lane = freeLane(0, o.out);
      state.overlays.push(o);
      done.push('logo added');
    }
  } catch (err) {
    console.error(err);
    toast(`Some of your brand files couldn't be found: ${cleanError(err)}`);
  }
  markDirty();
  overlayKey = null;
  renderAll();
  refreshPreview();
  updateOverlay();
  toast(done.length ? `Brand applied: ${done.join(', ')}` : 'Your brand is already on this project');
}

function openBrand() {
  if (!brand) brand = JSON.parse(JSON.stringify(BRAND_DEFAULT));
  $('#brandModal').hidden = false;
  renderBrand();
}

function renderBrand() {
  const body = $('#brandBody');
  body.textContent = '';
  const change = (fn) => () => { fn(); saveBrand(); renderBrand(); };
  const row = (title, ...kids) => h('div', { class: 'brand-row' }, h('h3', {}, title), ...kids);
  // Colours
  const names = ['Main', 'Second', 'Highlight', 'Text', 'Dark'];
  body.append(row('Colours',
    h('div', { class: 'brand-colours' }, ...brand.colours.map((c, i) => h('label', { class: 'brand-colour', title: names[i] },
      h('input', { type: 'color', value: c, 'aria-label': `${names[i]} colour`, onInput: (e) => { brand.colours[i] = e.target.value; saveBrand(); e.target.nextSibling.textContent = e.target.value.toUpperCase(); } }),
      h('span', {}, c.toUpperCase()), h('small', {}, names[i])))),
    h('p', { class: 'hint' }, 'They appear first in every colour choice. "Highlight" colours the spoken word in captions.')));
  // Font
  body.append(row('Font',
    h('div', { class: 'font-grid' }, ...TEXT_FONTS.map(([id, name, fam, weight]) => h('button', {
      class: 'font-tile', 'aria-pressed': String((brand.font || 'default') === id), style: `font-family:${fam.replace(/"/g, "'")};font-weight:${weight}`,
      onClick: change(() => { brand.font = id; }),
    }, name)))));
  // Caption look
  body.append(row('Caption look',
    h('div', { class: 'look-grid brand-looks' },
      h('button', { class: 'look-tile', 'aria-pressed': String(!brand.captionLook), onClick: change(() => { brand.captionLook = ''; }) }, h('span', { class: 'look-none' }, 'Aa'), h('span', {}, 'Snippy’s usual')),
      ...CAPTION_PRESETS.map((p) => h('button', {
        class: 'look-tile', 'aria-pressed': String(brand.captionLook === p.id), title: p.name,
        onClick: change(() => { brand.captionLook = p.id; }),
      }, lookThumb(p), h('span', {}, p.name)))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: brand.useForNew ? '' : null, onChange: (e) => { brand.useForNew = e.target.checked; saveBrand(); } }),
      ' Use my font and caption look for new text and auto captions')));
  // Logo
  const L = brand.logo;
  body.append(row('Logo',
    h('div', { class: 'brand-file' },
      L ? h('img', { class: 'kit-logo', src: L.url, alt: 'Your logo' }) : h('div', { class: 'kit-logo empty' }, 'No logo'),
      h('div', { class: 'brand-file-btns' },
        h('button', { class: 'btn small', onClick: async () => {
          const p = await window.api.pickOne('image');
          if (!p) return;
          try {
            const info = await window.api.probe(p);
            brand.logo = { corner: 'br', size: 0.14, opacity: 0.9, onExport: false, ...(brand.logo || {}), path: p, url: info.url, width: info.width, height: info.height };
            saveBrand(); renderBrand();
          } catch { toast('That picture couldn’t be read'); }
        } }, L ? 'Change…' : 'Choose a picture…'),
        L ? h('button', { class: 'btn small danger', onClick: change(() => { brand.logo = null; }) }, 'Remove') : null)),
    L ? h('div', { class: 'brand-logo-opts' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Corner' }, ...[['tl', 'Top left'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['br', 'Bottom right']].map(([v, label]) => h('button', {
        'aria-pressed': String((L.corner || 'br') === v), onClick: change(() => { L.corner = v; }),
      }, label))),
      h('label', { class: 'brand-slider' }, h('span', {}, 'Size'), h('input', { type: 'range', min: '0.05', max: '0.35', step: '0.01', value: String(L.size || 0.14), onInput: (e) => { L.size = Number(e.target.value); saveBrand(); } })),
      h('label', { class: 'brand-slider' }, h('span', {}, 'Opacity'), h('input', { type: 'range', min: '0.2', max: '1', step: '0.05', value: String(L.opacity ?? 0.9), onInput: (e) => { L.opacity = Number(e.target.value); saveBrand(); } })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: L.onExport ? '' : null, onChange: (e) => { L.onExport = e.target.checked; saveBrand(); } }),
        ' Add my logo to every export (as a watermark)')) : null));
  // Intro and outro
  const clipRow = (key, label) => {
    const v = brand[key];
    return h('div', { class: 'brand-clip' },
      h('b', {}, label), h('span', { class: 'brand-clip-name' }, v ? v.name : 'None'),
      h('button', { class: 'btn small', onClick: async () => {
        const p = await window.api.pickOne('video');
        if (!p) return;
        brand[key] = { path: p, name: p.split(/[\\/]/).pop() };
        saveBrand(); renderBrand();
      } }, v ? 'Change…' : 'Choose…'),
      v ? h('button', { class: 'btn small danger', onClick: change(() => { brand[key] = null; }) }, 'Remove') : null);
  };
  body.append(row('Intro and outro', clipRow('intro', 'Intro'), clipRow('outro', 'Outro'),
    h('p', { class: 'hint' }, 'Short videos you put at the start and end: a logo sting, a "thanks for watching" or a subscribe reminder.')));
  $('#brandApply').disabled = !state.clips.length;
  $('#brandApply').title = state.clips.length ? '' : 'Open or start a project first';
}

$('#brandBtn').addEventListener('click', openBrand);
$('#homeBrand').addEventListener('click', openBrand);
$('#brandClose').addEventListener('click', () => { $('#brandModal').hidden = true; renderInspector(); });
$('#brandApply').addEventListener('click', async () => { $('#brandModal').hidden = true; await applyBrand(); });

// ---------- auto zoom-ins
// Zooms in on the moments that are stressed in talking clips (said louder than the words around
// them, strong words, the end of a punchline), and back out a moment later. Uses the captions'
// word timings when there are some, otherwise just the sound.

const ZI_STRONG = /^(never|always|best|worst|biggest|crazy|insane|secret|mistake|actually|literally|love|hate|money|free|million|thousand|truth|wrong|wow|amazing|incredible|honestly|seriously|terrible|perfect|huge|everything|nothing|only|must|stop|now|really|so|very|massive|biggest|first|last|every|all|no|yes)$/i;
const ZI_SMALL = /^(the|a|an|and|or|but|of|to|in|on|at|for|it|is|was|i|you|we|he|she|they|that|this|um+|uh+|er+m?|like|just)$/i;
const ZI_GAPS = { few: 9, some: 5.5, lots: 3.2 };
const ZI_ZOOM = { subtle: 1.1, medium: 1.18, strong: 1.3 };
let ziOpts = (() => { try { return { style: 'punch', often: 'some', strength: 'medium', ...JSON.parse(localStorage.getItem('snippy.zi') || '{}') }; } catch { return { style: 'punch', often: 'some', strength: 'medium' }; } })();

// Candidate moments on the timeline: { T, score, until (when the thought ends) }.
function emphasisMoments() {
  const out = [];
  const medians = new Map();
  const loudness = (T) => {
    const loc = locate(T);
    if (!loc) return 1;
    const m = mediaById(loc.clip.mediaId);
    if (!m || !m.levels) return 1;
    if (!medians.has(loc.clip.id)) {
      const a = Math.floor(loc.clip.in / LEVEL_HOP);
      const b = Math.ceil(loc.clip.out / LEVEL_HOP);
      const v = m.levels.slice(a, b).filter((x) => x > 0.01).sort((p, q) => p - q);
      medians.set(loc.clip.id, v.length ? v[Math.floor(v.length / 2)] : 0);
    }
    const med = medians.get(loc.clip.id);
    if (!med) return 1;
    let peak = 0;
    for (let s = loc.src; s < loc.src + 0.3; s += LEVEL_HOP) peak = Math.max(peak, levelAt(m, s));
    return peak / med;
  };
  const caps = state.texts.filter((t) => t.auto && t.words && t.words.length).sort((a, b) => a.start - b.start);
  if (caps.length) {
    const words = caps.flatMap((t) => t.words.map((w) => ({ text: w.text, T: t.start + w.s, E: t.start + w.e })));
    // Where each sentence ends, so a zoom holds until the thought is finished.
    const ends = words.filter((w) => /[.!?]["')\]]?$/.test(w.text)).map((w) => w.E);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const bare = w.text.replace(/[^\p{L}\p{N}']/gu, '');
      if (!bare || ZI_SMALL.test(bare)) continue;
      const z = loudness(w.T);
      let score = Math.min(1, Math.max(0, (z - 1) / 1.1)) * 0.55;
      if (ZI_STRONG.test(bare)) score += 0.3;
      if (/!/.test(w.text)) score += 0.2;
      if (bare.length >= 6) score += 0.08;
      if (/^\d/.test(bare)) score += 0.12;
      if (bare === bare.toUpperCase() && bare.length > 1 && /\p{L}/u.test(bare)) score += 0.15;
      const until = ends.find((e) => e > w.E + 0.2) ?? w.E + 2;
      out.push({ T: w.T, score, until: Math.min(until + 0.25, w.T + 3.2) });
    }
  } else {
    // No captions: the loud moments in the sound.
    const total = totalDuration();
    let prev = 0;
    for (let T = 0.3; T < total - 0.3; T += 0.1) {
      const z = loudness(T);
      if (z > 1.35 && prev <= 1.35) out.push({ T, score: Math.min(1, (z - 1) / 1.1), until: T + 2.2 });
      prev = z;
    }
  }
  return out;
}

function removeAutoZooms(quiet = false) {
  let n = 0;
  for (const c of state.clips) {
    if (!c.keys) continue;
    const before = c.keys.length;
    c.keys = c.keys.filter((k) => !k.zi);
    n += before - c.keys.length;
    if (!c.keys.length) delete c.keys;
  }
  if (!quiet) {
    markDirty(); renderAll(); refreshPreview();
    toast(n ? 'Removed the auto zoom-ins' : 'There were no auto zoom-ins to remove');
  }
  return n;
}

function addAutoZooms(opts) {
  if (!state.clips.length) { toast('Add a talking clip first'); return; }
  commit();
  removeAutoZooms(true);
  const gap = ZI_GAPS[opts.often] || 5.5;
  const zoom = ZI_ZOOM[opts.strength] || 1.18;
  const smooth = opts.style === 'smooth';
  const starts = clipStarts();
  const moments = emphasisMoments().sort((a, b) => b.score - a.score);
  const picked = [];
  for (const mo of moments) {
    if (mo.score < 0.3) break;
    if (picked.some((p) => Math.abs(p.T - mo.T) < gap)) continue;
    const loc = locate(mo.T);
    if (!loc) continue;
    const u = mo.T - loc.start;
    if (u < 0.6 || u > clipLen(loc.clip) - 1) continue; // not right on a cut
    picked.push({ ...mo, loc });
  }
  picked.sort((a, b) => a.T - b.T);
  picked.forEach((p, i) => {
    const c = p.loc.clip;
    const L = clipLen(c);
    const u = p.T - starts[p.loc.index];
    const next = picked[i + 1];
    const until = Math.min(p.until, next ? next.T - 0.6 : Infinity, starts[p.loc.index] + L - 0.15);
    const e = Math.max(u + 0.6, until - starts[p.loc.index]);
    const ramp = smooth ? 0.35 : 0.03;
    const back = smooth ? 0.45 : 0.03;
    const a0 = Math.max(0, u - ramp);
    const e1 = Math.min(L, e + back);
    const v0 = kfValue(c, 'clip', a0);
    const vm = kfValue(c, 'clip', u);
    const ve = kfValue(c, 'clip', e);
    const v1 = kfValue(c, 'clip', e1);
    const keys = (c.keys || []).filter((k) => k.t < a0 - 0.01 || k.t > e1 + 0.01);
    keys.push(
      { t: a0, ...v0, zi: true },
      { t: u, ...vm, zoom: vm.zoom * zoom, zi: true },
      { t: e, ...ve, zoom: ve.zoom * zoom, zi: true },
      { t: e1, ...v1, zi: true },
    );
    c.keys = keys.sort((x, y) => x.t - y.t);
  });
  markDirty();
  renderAll();
  refreshPreview();
  toast(picked.length
    ? `Added ${picked.length} zoom-in${picked.length === 1 ? '' : 's'}${state.texts.some((t) => t.auto && t.words) ? ' on the stressed words' : ' on the loudest moments'}. Ctrl+Z takes them out`
    : 'No stressed moments stood out. Try "Often", or make auto captions first');
  return picked.length;
}

function openZoomIns() {
  if (!state.clips.length) { toast('Add a talking clip first'); return; }
  const body = $('#ziBody');
  body.textContent = '';
  const seg = (label, key, options) => h('div', { class: 'field' }, label, h('div', { class: 'seg', role: 'group', 'aria-label': label },
    ...options.map(([v, name]) => h('button', { 'aria-pressed': String(ziOpts[key] === v), onClick: () => { ziOpts[key] = v; try { localStorage.setItem('snippy.zi', JSON.stringify(ziOpts)); } catch { /* not kept */ } openZoomIns(); } }, name))));
  const hasCaps = state.texts.some((t) => t.auto && t.words);
  body.append(
    seg('Style', 'style', [['punch', 'Punch (a quick jump)'], ['smooth', 'Smooth (a gentle push)']]),
    seg('How often', 'often', [['few', 'Now and then'], ['some', 'Regularly'], ['lots', 'Often']]),
    seg('How much', 'strength', [['subtle', 'Subtle'], ['medium', 'Medium'], ['strong', 'Strong']]),
    h('p', { class: 'hint' }, hasCaps
      ? 'Uses your captions to find the stressed words: said louder than the rest, strong words, numbers and punchlines. Each zoom holds until the sentence finishes.'
      : 'Tip: make auto captions first (Smart tools) so the zooms land on the stressed words. Without them, Snippy zooms on the loudest moments.'),
  );
  $('#ziRemove').hidden = !state.clips.some((c) => (c.keys || []).some((k) => k.zi));
  $('#ziModal').hidden = false;
}
$('#zoomInsBtn').addEventListener('click', openZoomIns);
$('#ziCancel').addEventListener('click', () => { $('#ziModal').hidden = true; });
$('#ziRemove').addEventListener('click', () => { $('#ziModal').hidden = true; commit(); removeAutoZooms(); });
$('#ziGo').addEventListener('click', () => { $('#ziModal').hidden = true; addAutoZooms(ziOpts); });
