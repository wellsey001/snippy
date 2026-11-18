'use strict';
// Draws a frame of the project. The same code draws the preview and the export, so the export
// always looks exactly like the preview.

class Renderer {
  constructor(W, H, { muted = false } = {}) {
    this.W = W; this.H = H;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.layer = document.createElement('canvas');
    this.layer.width = W; this.layer.height = H;
    this.lctx = this.layer.getContext('2d');
    this.fx = null;
    this.muted = muted;
    this.pool = []; // { el, mediaId, clipId, used }
    this.images = new Map();
    this.box = $('#mediaBox') || document.body;
  }

  resize(W, H) {
    if (this.W === W && this.H === H) return;
    this.W = W; this.H = H;
    this.canvas.width = W; this.canvas.height = H;
    this.layer.width = W; this.layer.height = H;
  }

  destroy() {
    for (const s of this.pool) { s.el.pause(); s.el.removeAttribute('src'); s.el.load(); s.el.remove(); }
    this.pool = [];
  }

  image(m) {
    if (!this.images.has(m.id)) {
      const img = new Image();
      img.onload = () => window.dispatchEvent(new Event('snippy-redraw'));
      Media.url(m.id).then((u) => { img.src = u; });
      this.images.set(m.id, img);
    }
    return this.images.get(m.id);
  }

  // The video element showing a clip (elements are shared out between clips as needed).
  elementFor(clip, keep = []) {
    let s = this.pool.find((x) => x.clipId === clip.id);
    if (s) { s.used = performance.now(); return s.el; }
    const busy = new Set(keep);
    s = this.pool.filter((x) => !busy.has(x.clipId)).sort((a, b) => (a.mediaId === clip.mediaId ? -1 : b.mediaId === clip.mediaId ? 1 : a.used - b.used))[0];
    if (!s && this.pool.length < 4) {
      const el = document.createElement('video');
      el.playsInline = true; el.preload = 'auto'; el.crossOrigin = 'anonymous';
      el.setAttribute('playsinline', '');
      el.muted = this.muted;
      this.box.append(el);
      s = { el, mediaId: null, clipId: null, used: 0 };
      this.pool.push(s);
    }
    if (!s) s = this.pool.sort((a, b) => a.used - b.used)[0];
    if (s.mediaId !== clip.mediaId) {
      s.mediaId = clip.mediaId;
      Media.url(clip.mediaId).then((u) => { if (s.mediaId === clip.mediaId) { s.el.src = u; s.el.load(); } });
    }
    s.clipId = clip.id;
    s.used = performance.now();
    return s.el;
  }
  pausedAll(except = []) {
    for (const s of this.pool) if (!except.includes(s.el) && !s.el.paused) s.el.pause();
  }

  // Where a picture of size sw×sh sits in the frame, with the clip's zoom, position and turn.
  placement(c, sw, sh) {
    const { W, H } = this;
    const fit = Math.min(W / sw, H / sh);
    const z = (c.zoom || 1) * fit;
    return { w: sw * z, h: sh * z, cx: W / 2 + (c.x || 0) * W, cy: H / 2 + (c.y || 0) * H, rot: ((c.rot || 0) * Math.PI) / 180 };
  }

  sourceOf(c) {
    const m = Media.get(c.mediaId);
    if (!m) return null;
    if (m.kind === 'image') {
      const img = this.image(m);
      return img.complete && img.naturalWidth ? { el: img, w: img.naturalWidth, h: img.naturalHeight } : null;
    }
    const s = this.pool.find((x) => x.clipId === c.id);
    if (!s || s.el.readyState < 2 || !s.el.videoWidth) return null;
    return { el: s.el, w: s.el.videoWidth, h: s.el.videoHeight };
  }

  // Draws one clip (background, picture, colour, effect) onto g. tr: { dx, dy, scale, alpha, blur }.
  drawClip(g, p, c, u, tr = {}) {
    const { W, H } = this;
    const src = this.sourceOf(c);
    if (!src) return false;
    const target = c.fx && SnippyFx.isNew(c.fx) ? this.lctx : g;
    if (target === this.lctx) { this.lctx.setTransform(1, 0, 0, 1, 0, 0); this.lctx.fillStyle = '#000'; this.lctx.fillRect(0, 0, W, H); }
    const look = (LOOKS.find((l) => l.id === c.look) || LOOKS[0]).css;
    const adj = c.adj || {};
    const adjCss = [adj.b ? `brightness(${(1 + adj.b).toFixed(3)})` : '', adj.c ? `contrast(${(1 + adj.c).toFixed(3)})` : '', adj.s ? `saturate(${(1 + adj.s).toFixed(3)})` : ''].join(' ');
    const fxCss = c.fx && !SnippyFx.isNew(c.fx) ? classicFilter(c.fx, u) : '';
    const colour = `${look} ${adjCss} ${fxCss}`.trim();
    const [ox, oy] = c.fx && !SnippyFx.isNew(c.fx) ? classicOffset(c.fx, u, H) : [0, 0];
    const scale = tr.scale || 1;
    const blur = tr.blur || 0;
    const t = target;
    t.save();
    if (target === g) t.globalAlpha = tr.alpha ?? 1;
    // Background behind a picture that doesn't fill the frame.
    const pl = this.placement(c, src.w, src.h);
    const fills = pl.w >= W - 1 && pl.h >= H - 1 && !c.rot && !c.x && !c.y;
    if (!fills) {
      if (p.bg === 'blur') {
        // A soft blurred copy behind: drawn tiny, then stretched (much quicker than a blur filter).
        if (!this.bg) { this.bg = document.createElement('canvas'); this.bgx = this.bg.getContext('2d'); }
        const bw = Math.max(8, Math.round(W / 24));
        const bh = Math.max(8, Math.round(H / 24));
        if (this.bg.width !== bw || this.bg.height !== bh) { this.bg.width = bw; this.bg.height = bh; }
        const cover = Math.max(bw / src.w, bh / src.h) * 1.08;
        this.bgx.filter = `brightness(0.62) ${colour}`.trim();
        this.bgx.drawImage(src.el, (bw - src.w * cover) / 2, (bh - src.h * cover) / 2, src.w * cover, src.h * cover);
        t.filter = 'none';
        t.imageSmoothingEnabled = true;
        t.imageSmoothingQuality = 'high';
        t.drawImage(this.bg, tr.dx || 0, tr.dy || 0, W, H);
      } else {
        t.filter = 'none';
        t.fillStyle = p.bg === 'white' ? '#fff' : '#000';
        t.fillRect(tr.dx || 0, tr.dy || 0, W, H);
      }
    }
    t.filter = `${colour} ${blur ? `blur(${blur.toFixed(1)}px)` : ''}`.trim() || 'none';
    t.translate(pl.cx + (tr.dx || 0) + ox, pl.cy + (tr.dy || 0) + oy);
    if (scale !== 1) t.scale(scale, scale);
    if (pl.rot) t.rotate(pl.rot);
    t.drawImage(src.el, -pl.w / 2, -pl.h / 2, pl.w, pl.h);
    t.restore();
    if (target === this.lctx) {
      if (c.fx === 'grain' || c.fx === 'vhs' || c.fx === 'oldfilm') classicFx(this.lctx, c.fx, W, H, u);
      if (!this.fx) this.fx = new FxRunner();
      const out = this.fx.ok ? this.fx.run(this.layer, [fxPass(p, c.fx, c.fxK, u, clipLen(c), this.clipStart(p, c))]) : this.layer;
      g.save();
      g.globalAlpha = tr.alpha ?? 1;
      g.drawImage(out, 0, 0, W, H);
      g.restore();
    } else if (c.fx === 'grain' || c.fx === 'vhs' || c.fx === 'oldfilm') {
      classicFx(g, c.fx, W, H, u);
    }
    return true;
  }

  clipStart(p, c) {
    const i = p.clips.indexOf(c);
    return clipStarts(p)[i] || 0;
  }

  // Draws the whole frame at time t onto the canvas.
  frame(p, t, { texts = true, hideText = null } = {}) {
    const { W, H, ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const starts = clipStarts(p);
    const on = clipsAt(p, t, starts);
    if (on.length === 2) this.transition(p, on[0], on[1], t);
    else if (on.length === 1) this.drawClip(ctx, p, on[0].clip, on[0].u);
    // Effects on the timeline, over everything underneath.
    const passes = p.effects.filter((e) => t >= e.start && t < e.start + e.dur && SnippyFx.isNew(e.effect))
      .map((e) => fxPass(p, e.effect, e.k, t - e.start, e.dur, e.start));
    if (passes.length) {
      if (!this.fx) this.fx = new FxRunner();
      if (this.fx.ok) ctx.drawImage(this.fx.run(this.canvas, passes), 0, 0, W, H);
    }
    // Text and captions on top.
    if (texts) {
      for (const x of p.texts) {
        if (x.id === hideText || t < x.start || t >= x.start + x.dur) continue;
        ctx.save();
        try { drawCaption(ctx, W, H, x, t - x.start); } catch (err) { console.warn(err); }
        ctx.restore();
      }
    }
    // Fade to black at the very end, if asked.
    const end = videoLen(p);
    if (p.endFade && t > end - p.endFade) {
      ctx.fillStyle = `rgba(0,0,0,${clamp((t - (end - p.endFade)) / p.endFade, 0, 1)})`;
      ctx.fillRect(0, 0, W, H);
    }
    return this.canvas;
  }

  transition(p, a, b, t) {
    const { W, H, ctx } = this;
    const ov = overlapOf(p, b.i) || 0.0001;
    const q = clamp((t - b.start) / ov, 0, 1);
    const e = q < 0.5 ? 2 * q * q : 1 - (-2 * q + 2) ** 2 / 2; // ease in and out
    const type = b.clip.transitionType;
    const A = (tr) => this.drawClip(ctx, p, a.clip, a.u, tr);
    const B = (tr) => this.drawClip(ctx, p, b.clip, b.u, tr);
    if (type === 'dip' || type === 'flash') {
      if (q < 0.5) A(); else B();
      ctx.fillStyle = type === 'dip' ? '#000' : '#fff';
      ctx.globalAlpha = 1 - Math.abs(q * 2 - 1);
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    } else if (type === 'slide') {
      A({ dx: -e * W }); B({ dx: (1 - e) * W });
    } else if (type === 'whip') {
      const bl = Math.sin(q * Math.PI) * Math.min(W, H) / 30;
      A({ dx: -e * W, blur: bl }); B({ dx: (1 - e) * W, blur: bl });
    } else if (type === 'zoom') {
      A({ scale: 1 + e * 0.6, alpha: 1 }); B({ scale: 0.7 + 0.3 * e, alpha: e });
    } else if (type === 'wipe') {
      A();
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W * e, H); ctx.clip(); B(); ctx.restore();
    } else {
      A(); B({ alpha: e });
    }
  }
}

// One effect pass for the GL runner: with the beat pulse worked out from the music on the timeline.
function fxPass(p, id, k, t, dur, start) {
  const all = timelineBeats(p);
  const beats = all.length ? SnippyFx.beatList(all.map((b) => b - start), dur) : null;
  return { id, k: k ?? SnippyFx.DEFAULT_K, t, dur, env: SnippyFx.envAt(beats, t), bc: SnippyFx.countAt(beats, t) };
}
