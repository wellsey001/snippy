'use strict';
// Media: bringing videos, photos and songs in from the phone, and everything Snippy learns
// about them (length, size, thumbnails, sound, beats, lively moments).

const Media = (() => {
  const items = new Map(); // id → media record
  const urls = new Map(); // id → object URL
  const audioBufs = new Map(); // id → Promise<AudioBuffer|null>

  const kindOf = (f) => (f.type.startsWith('video/') ? 'video' : f.type.startsWith('image/') ? 'image' : f.type.startsWith('audio/') ? 'audio'
    : /\.(mp4|mov|m4v|webm|3gp|mkv)$/i.test(f.name) ? 'video' : /\.(jpe?g|png|webp|gif|heic)$/i.test(f.name) ? 'image' : /\.(mp3|m4a|aac|wav|ogg|flac|opus)$/i.test(f.name) ? 'audio' : null);

  async function url(id) {
    if (urls.has(id)) return urls.get(id);
    const blob = await Store.getBlob(id);
    if (!blob) return null;
    const u = URL.createObjectURL(blob);
    urls.set(id, u);
    return u;
  }
  const get = (id) => items.get(id);

  async function load(ids) {
    for (const id of ids) {
      if (items.has(id)) continue;
      const m = await Store.getMedia(id);
      if (m) { items.set(id, m); await url(id); }
    }
  }

  function once(el, ev, ms = 15000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${ev}`)), ms);
      el.addEventListener(ev, () => { clearTimeout(t); resolve(); }, { once: true });
      el.addEventListener('error', () => { clearTimeout(t); reject(new Error('This file can’t be played on this phone')); }, { once: true });
    });
  }

  // A small JPEG of a video frame (or a photo).
  function snap(el, w, h, maxW = 160) {
    const sw = el.videoWidth || el.naturalWidth || w;
    const sh = el.videoHeight || el.naturalHeight || h;
    const s = Math.min(1, maxW / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(sw * s));
    c.height = Math.max(2, Math.round(sh * s));
    c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.72);
  }

  async function seekTo(v, t) {
    if (Math.abs(v.currentTime - t) < 0.01 && v.readyState >= 2) return;
    v.currentTime = t;
    await once(v, 'seeked', 8000);
  }

  // Reads one file in. Returns its media record.
  async function add(file) {
    const kind = kindOf(file);
    if (!kind) throw new Error(`${file.name}: Snippy can’t use this kind of file`);
    const id = uid('m');
    await Store.putBlob(id, file);
    const u = URL.createObjectURL(file);
    urls.set(id, u);
    const m = { id, name: file.name, kind, duration: 0, width: 0, height: 0, hasAudio: kind !== 'image', thumb: null, strip: [], size: file.size };
    if (kind === 'image') {
      const img = new Image();
      img.src = u;
      await img.decode();
      m.width = img.naturalWidth; m.height = img.naturalHeight; m.duration = 3;
      m.thumb = snap(img, m.width, m.height);
      m.strip = [m.thumb];
    } else if (kind === 'audio') {
      const a = new Audio();
      a.preload = 'metadata';
      a.src = u;
      await once(a, 'loadedmetadata');
      m.duration = a.duration;
    } else {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.src = u;
      await once(v, 'loadedmetadata');
      m.duration = v.duration; m.width = v.videoWidth; m.height = v.videoHeight;
      if (v.readyState < 2) await once(v, 'loadeddata').catch(() => {});
      await seekTo(v, Math.min(0.15, m.duration / 2)).catch(() => {});
      m.thumb = snap(v);
      v.removeAttribute('src'); v.load();
    }
    await Store.putMedia(m);
    items.set(id, m);
    return m;
  }

  // A row of frames across the video, for the timeline (made in the background).
  async function strip(m, n = 10) {
    if (m.kind !== 'video' || (m.strip && m.strip.length >= n)) return m.strip;
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.src = await url(m.id);
    try {
      await once(v, 'loadeddata');
      const out = [];
      for (let i = 0; i < n; i++) {
        await seekTo(v, Math.min(m.duration - 0.05, ((i + 0.5) / n) * m.duration));
        out.push(snap(v, 0, 0, 120));
      }
      m.strip = out;
      await Store.putMedia(m);
    } catch { /* keep the thumbnail only */ }
    v.removeAttribute('src'); v.load();
    return m.strip;
  }

  // The sound of a video or song, decoded (null when it has none).
  function audioBuffer(m) {
    if (!audioBufs.has(m.id)) {
      audioBufs.set(m.id, (async () => {
        if (m.kind === 'image') return null;
        try {
          const blob = await Store.getBlob(m.id);
          const ab = await blob.arrayBuffer();
          const ctx = new OfflineAudioContext(2, 2, 48000);
          const buf = await ctx.decodeAudioData(ab);
          let peak = 0;
          const ch = buf.getChannelData(0);
          for (let i = 0; i < ch.length; i += 97) peak = Math.max(peak, Math.abs(ch[i]));
          if (peak < 1e-4) { m.hasAudio = false; return null; }
          return buf;
        } catch {
          m.hasAudio = false;
          return null;
        }
      })());
    }
    return audioBufs.get(m.id);
  }

  // Mono samples at a lower rate (for beat finding and speech).
  function mono(buf, rate, from = 0, to = Infinity) {
    const a = Math.max(0, Math.floor(from * buf.sampleRate));
    const b = Math.min(buf.length, Math.floor(Math.min(to, buf.duration) * buf.sampleRate));
    const ratio = buf.sampleRate / rate;
    const n = Math.max(0, Math.floor((b - a) / ratio));
    const out = new Float32Array(n);
    const chans = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    for (let i = 0; i < n; i++) {
      const s0 = a + Math.floor(i * ratio);
      const s1 = Math.min(b, a + Math.floor((i + 1) * ratio));
      let sum = 0; let cnt = 0;
      for (let s = s0; s < s1; s++) for (const ch of chans) { sum += ch[s]; cnt++; }
      out[i] = cnt ? sum / cnt : 0;
    }
    return out;
  }

  async function beats(m) {
    const key = `beats2:${m.id}`;
    const hit = await Store.getCache(key);
    if (hit) return hit;
    const buf = await audioBuffer(m);
    if (!buf) return { bpm: 0, beats: [] };
    const r = SnippyBeats.detectBeats(mono(buf, 16000), 16000);
    await Store.putCache(key, r);
    return r;
  }

  // How lively each moment of a video is (every `step` seconds): movement and loudness, with
  // dark and blurry moments marked down. For AutoCut.
  async function liveliness(m, onProgress, step = 0.5) {
    const key = `lively1:${m.id}`;
    const hit = await Store.getCache(key);
    if (hit) return hit;
    if (m.kind === 'image') return { step: m.duration, score: [0.5] };
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.src = await url(m.id);
    await once(v, 'loadeddata');
    const W = 64; const H = 36;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    const n = Math.max(1, Math.floor(m.duration / step));
    const motion = []; const bright = []; const sharp = [];
    let prev = null;
    for (let k = 0; k < n; k++) {
      await seekTo(v, Math.min(m.duration - 0.05, k * step + step / 2));
      g.drawImage(v, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data;
      const lum = new Float32Array(W * H);
      let sum = 0;
      for (let i = 0; i < W * H; i++) { lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; sum += lum[i]; }
      let lap = 0;
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; lap += Math.abs(4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - W] - lum[i + W]); }
      let mo = 0;
      if (prev) for (let i = 0; i < lum.length; i++) mo += Math.abs(lum[i] - prev[i]);
      prev = lum;
      bright.push(sum / lum.length);
      sharp.push(lap / ((W - 2) * (H - 2)));
      motion.push(k ? mo / lum.length : 0);
      if (onProgress) onProgress((k + 1) / n);
    }
    if (motion.length > 1) motion[0] = motion[1];
    v.removeAttribute('src'); v.load();
    // Loudness per step.
    const loud = new Array(n).fill(-40);
    const buf = await audioBuffer(m);
    if (buf) {
      const ch = buf.getChannelData(0);
      for (let k = 0; k < n; k++) {
        const a = Math.floor(k * step * buf.sampleRate);
        const b = Math.min(ch.length, Math.floor((k + 1) * step * buf.sampleRate));
        let s = 0;
        for (let i = a; i < b; i += 4) s += ch[i] * ch[i];
        loud[k] = 10 * Math.log10(s / Math.max(1, (b - a) / 4) + 1e-9);
      }
    }
    const base = livelyScore(loud, motion);
    const score = base.map((v, k) => v - (bright[k] < 35 ? 1.5 : 0) - (sharp[k] < 4 ? 1 : 0));
    const r = { step, score };
    await Store.putCache(key, r);
    return r;
  }

  return { add, load, get, url, strip, audioBuffer, mono, beats, liveliness, items, kindOf, seekTo, once };
})();
