'use strict';
// The preview: plays the project, keeping the videos and music in step.
// While music plays, the music keeps time and the pictures follow it (so the music never jumps).

class Player {
  constructor(host, onTime) {
    this.host = host;
    this.onTime = onTime;
    this.p = null;
    this.t = 0;
    this.playing = false;
    this.renderer = null;
    this.audioEls = new Map();
    this.pending = new Map(); // element → source time wanted once it finishes seeking
    this.last = performance.now();
    this.dirty = true;
    this.hideText = null;
    window.addEventListener('snippy-redraw', () => { this.dirty = true; });
    const loop = () => { this.tick(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  setProject(p) {
    this.p = p;
    const short = Math.min(720, Math.round(Math.min(screen.width, screen.height) * (window.devicePixelRatio || 1)));
    const { W, H } = frameSize(p.aspect, clamp(short, 360, 540));
    if (!this.renderer) {
      this.renderer = new Renderer(W, H);
      this.renderer.canvas.className = 'preview-canvas';
      this.host.append(this.renderer.canvas);
    } else this.renderer.resize(W, H);
    this.t = clamp(this.t, 0, Math.max(0, videoLen(p) - 0.001));
    this.dirty = true;
  }

  changed() { this.dirty = true; this.syncElements(false, true); }

  play() {
    if (!this.p || !this.p.clips.length) return;
    if (this.t >= videoLen(this.p) - 0.05) this.t = 0;
    this.playing = true;
    this.last = performance.now();
    this.syncElements(true, true);
    document.body.classList.add('is-playing');
  }
  pause() {
    this.playing = false;
    if (this.renderer) this.renderer.pausedAll();
    for (const el of this.audioEls.values()) el.pause();
    document.body.classList.remove('is-playing');
    this.dirty = true;
  }
  toggle() { if (this.playing) this.pause(); else this.play(); }

  seek(t) {
    if (!this.p) return;
    this.t = clamp(t, 0, Math.max(0, videoLen(this.p) - 0.001));
    this.syncElements(this.playing, true);
    this.dirty = true;
  }

  // The clips playing (or about to) and where each of their videos should be.
  wanted(t) {
    const p = this.p;
    const starts = clipStarts(p);
    const on = clipsAt(p, t, starts);
    const out = on.map((x) => ({ ...x }));
    // The next clip gets its video ready a moment before it starts.
    const lastOn = on[on.length - 1];
    if (lastOn && lastOn.i + 1 < p.clips.length) {
      const ni = lastOn.i + 1;
      if (starts[ni] - t < 1.2) { const c = p.clips[ni]; out.push({ i: ni, clip: c, start: starts[ni], u: 0, src: c.in, upcoming: true }); }
    }
    return out;
  }

  setTime(el, src) {
    if (el.seeking) { this.pending.set(el, src); return; }
    if (el.readyState < 1) {
      // Not loaded yet: go there as soon as it is.
      if (!el._snippyWait) { el._snippyWait = true; el.addEventListener('loadedmetadata', () => { el._snippyWait = false; this.dirty = true; this.syncElements(this.playing, true); }, { once: true }); }
      return;
    }
    try { el.currentTime = src; } catch { /* not ready yet */ }
    const done = () => {
      const next = this.pending.get(el);
      this.pending.delete(el);
      this.dirty = true;
      if (next != null && Math.abs(next - el.currentTime) > 0.02) this.setTime(el, next);
    };
    el.addEventListener('seeked', done, { once: true });
  }

  syncElements(playing, force) {
    const p = this.p;
    const R = this.renderer;
    if (!p || !R) return;
    const want = this.wanted(this.t);
    const keep = want.map((w) => w.clip.id);
    const used = [];
    const ovNow = want.filter((w) => !w.upcoming);
    for (const w of want) {
      const m = Media.get(w.clip.mediaId);
      if (!m || m.kind !== 'video') continue;
      const el = R.elementFor(w.clip, keep);
      used.push(el);
      // Crossfading sound during a transition.
      let vol = w.clip.volume ?? 1;
      if (ovNow.length === 2) {
        const b = ovNow[1];
        const q = clamp((this.t - b.start) / (overlapOf(p, b.i) || 1), 0, 1);
        vol *= w.i === b.i ? q : 1 - q;
      }
      el.volume = clamp(vol, 0, 1);
      el.muted = vol <= 0.001;
      el.playbackRate = w.clip.speed || 1;
      const drift = Math.abs(el.currentTime - w.src);
      if (w.upcoming) {
        if (!el.paused) el.pause();
        if (drift > 0.04 && !el.seeking) this.setTime(el, w.src);
        continue;
      }
      if (playing) {
        if (drift > (force ? 0.06 : 0.3) && !this.isMaster(el)) this.setTime(el, w.src);
        if (el.paused && el.readyState >= 2) el.play().catch(() => {});
      } else {
        if (!el.paused) el.pause();
        if (drift > 0.02) this.setTime(el, w.src);
      }
    }
    R.pausedAll(used);
    // Music and sounds.
    const live = new Set();
    for (const a of p.audio) {
      live.add(a.id);
      let el = this.audioEls.get(a.id);
      if (!el) {
        el = new Audio();
        el.preload = 'auto';
        Media.url(a.mediaId).then((u) => { el.src = u; });
        this.audioEls.set(a.id, el);
      }
      const local = this.t - a.start;
      const len = a.out - a.in;
      const active = local >= 0 && local < len;
      if (!active || !playing) { if (!el.paused) el.pause(); if (!playing && active && Math.abs(el.currentTime - (a.in + local)) > 0.05 && el.readyState >= 1) el.currentTime = a.in + local; continue; }
      let g = a.volume ?? 1;
      if (a.fadeIn && local < a.fadeIn) g *= local / a.fadeIn;
      if (a.fadeOut && local > len - a.fadeOut) g *= (len - local) / a.fadeOut;
      el.volume = clamp(g, 0, 1);
      const want = a.in + local;
      if (Math.abs(el.currentTime - want) > (force ? 0.06 : 0.3) && this.master !== el) el.currentTime = want;
      if (el.paused) el.play().catch(() => {});
    }
    for (const [id, el] of this.audioEls) if (!live.has(id)) { el.pause(); this.audioEls.delete(id); }
  }

  isMaster(el) { return this.master === el; }

  // What keeps time while playing: the music if a song is playing, otherwise the video on screen.
  clock() {
    const p = this.p;
    for (const a of p.audio) {
      const el = this.audioEls.get(a.id);
      const local = this.t - a.start;
      if (!el || el.paused || el.seeking || el.readyState < 3 || local < 0 || local >= a.out - a.in - 0.05) continue;
      const t = a.start + (el.currentTime - a.in);
      if (Math.abs(t - this.t) < 0.5) return { t, el };
    }
    const on = clipsAt(p, this.t);
    const cur = on[on.length - 1];
    if (cur) {
      const s = this.renderer.pool.find((x) => x.clipId === cur.clip.id);
      if (s && !s.el.paused && !s.el.seeking && s.el.readyState >= 3) {
        const t = cur.start + (s.el.currentTime - cur.clip.in) / (cur.clip.speed || 1);
        if (Math.abs(t - this.t) < 0.5 && t >= cur.start) return { t, el: s.el };
      }
    }
    return null;
  }

  tick() {
    const now = performance.now();
    const dt = (now - this.last) / 1000;
    this.last = now;
    if (!this.p || !this.renderer) return;
    if (this.playing) {
      const c = this.clock();
      this.master = c ? c.el : null;
      let t = c ? c.t : this.t + dt;
      if (t < this.t && this.t - t < 0.08) t = this.t; // never step back by a hair
      // Images and stalls: no clock, so time moves on with the wall clock.
      this.t = t;
      const end = videoLen(this.p);
      if (this.t >= end) { this.t = Math.max(0, end - 0.001); this.pause(); }
      this.syncElements(this.playing, false);
      this.dirty = true;
    }
    // Videos still loading: keep putting them where they should be until they're ready.
    else if (this.renderer.pool.some((s) => s.el.src && s.el.readyState < 2)) this.syncElements(false, false);
    if (this.dirty) {
      this.dirty = false;
      this.renderer.frame(this.p, this.t, { hideText: this.hideText });
      if (this.onTime) this.onTime(this.t);
      // Keep redrawing while videos are still loading their first frames.
      if (this.renderer.pool.some((s) => s.el.readyState < 2 && s.el.src) || this.pending.size) this.dirty = true;
    }
  }
}
