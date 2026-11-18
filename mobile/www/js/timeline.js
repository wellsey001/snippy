'use strict';
// The timeline: scroll it to move through the video (the playhead stays in the middle), pinch to
// zoom, tap to select, drag the white handles to trim, drag a selected text, sound or effect to
// move it, and press and hold a clip to move it somewhere else.

const Timeline = {
  ready: false,
  pps: 60, // pixels per second
  ignoreScroll: false,
  imgs: new Map(),

  init() {
    this.el = $('#tl');
    this.inner = $('#tlInner');
    if (!this.bound) { this.bind(); this.bound = true; }
    this.ready = true;
    this.render();
    this.follow(App.player.t, true);
  },

  pad() { return Math.round(this.el.clientWidth / 2); },
  x(t) { return this.pad() + t * this.pps; },
  timeAtClientX(cx) {
    const r = this.el.getBoundingClientRect();
    return (this.el.scrollLeft + (cx - r.left) - this.pad()) / this.pps;
  },

  follow(t, force) {
    if (!this.ready || this.dragging || (this.touching && !force)) return;
    const want = Math.round(t * this.pps);
    if (Math.abs(this.el.scrollLeft - want) < 1) return;
    this.ignoreScroll = true;
    this.el.scrollLeft = want;
    requestAnimationFrame(() => { this.ignoreScroll = false; });
  },

  image(src) {
    if (!this.imgs.has(src)) { const im = new Image(); im.onload = () => { this.imgsLoaded = (this.imgsLoaded || 0) + 1; clearTimeout(this.imgT); this.imgT = setTimeout(() => this.render(), 50); }; im.src = src; this.imgs.set(src, im); }
    return this.imgs.get(src);
  },

  // Rows and items are kept and updated rather than rebuilt, so a finger on one keeps working
  // while the timeline zooms or changes under it.
  row(cls) {
    if (!this.rows) this.rows = {};
    if (!this.rows[cls]) { this.rows[cls] = h('div', { class: cls === 'ruler' ? 'ruler' : `row ${cls}` }); }
    if (this.rows[cls].parentNode !== this.inner) this.inner.append(this.rows[cls]);
    return this.rows[cls];
  },
  keyed(row, key, make) {
    let el = row.querySelector(`:scope > [data-key="${key}"]`);
    if (!el) { el = make(); el.dataset.key = key; row.append(el); }
    el._keep = true;
    return el;
  },
  sweep(row) { for (const el of [...row.children]) { if (!el._keep) el.remove(); else el._keep = false; } },

  render() {
    if (!this.ready || !App.p) return;
    const p = App.p;
    const pad = this.pad();
    const pps = this.pps;
    const total = Math.max(videoLen(p), ...p.audio.map((a) => a.start + a.out - a.in), ...p.texts.map((x) => x.start + x.dur), ...p.effects.map((e) => e.start + e.dur), 1);
    this.inner.style.width = `${pad * 2 + total * pps + 70}px`;
    const sel = App.sel;
    // Ruler
    const ruler = this.row('ruler');
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120].find((s) => s * pps >= 64) || 300;
    const rkey = `${pad}|${pps}|${Math.ceil(total)}`;
    if (ruler.dataset.k !== rkey) {
      ruler.dataset.k = rkey;
      ruler.textContent = '';
      for (let t = 0; t <= total + step; t += step) {
        ruler.append(h('span', { style: { left: `${pad + t * pps}px` } }, fmt(t)));
        for (let k = 1; k < 4; k++) ruler.append(h('i', { style: { left: `${pad + (t + (k * step) / 4) * pps}px` } }));
      }
    }
    // Clips
    const main = this.row('row-main');
    const starts = clipStarts(p);
    p.clips.forEach((c, i) => {
      const L = clipLen(c);
      const w = Math.max(8, L * pps - 2);
      const isSel = sel && sel.kind === 'clip' && sel.id === c.id;
      const item = this.keyed(main, c.id, () => h('div', { 'data-kind': 'clip', 'data-id': c.id },
        h('canvas', { height: '62' }), h('span', { class: 'dur' }), h('span', { class: 'badge' }),
        h('div', { class: 'handle l', 'data-handle': 'l' }), h('div', { class: 'handle r', 'data-handle': 'r' })));
      item.className = `item clip${isSel ? ' selected' : ''}`;
      item.style.left = `${pad + starts[i] * pps + 1}px`;
      item.style.width = `${w}px`;
      const cv = item.querySelector('canvas');
      const m = Media.get(c.mediaId);
      const ck = `${Math.round(w)}|${pps}|${c.in}|${c.speed}|${m && m.strip ? m.strip.length : 0}|${this.imgsLoaded || 0}`;
      if (cv.dataset.k !== ck) { cv.dataset.k = ck; cv.width = Math.min(4096, Math.round(w)); this.drawStrip(cv, c); }
      item.querySelector('.dur').textContent = fmt(L, true);
      const badges = [(c.speed || 1) !== 1 ? `${Number(c.speed.toFixed(2))}×` : '', c.fx ? '✦' : '', c.look && c.look !== 'none' ? '◐' : '', (c.volume ?? 1) === 0 && m && m.kind === 'video' ? '🔇' : ''].filter(Boolean).join(' ');
      const bd = item.querySelector('.badge');
      bd.textContent = badges;
      bd.hidden = !badges;
      if (i > 0) {
        const ov = overlapOf(p, i);
        const tb = this.keyed(main, `tr-${c.id}`, () => h('button', { 'aria-label': 'Transition', html: icon('transition', 16) }));
        tb.className = `trans-btn${ov ? ' on' : ''}`;
        tb.style.left = `${pad + (starts[i] + ov / 2) * pps}px`;
        tb.style.top = '18px';
        tb.onclick = (e) => { e.stopPropagation(); Sheets.transition(App.p.clips.indexOf(c)); };
      }
    });
    if (!p.clips.length) {
      const hint = this.keyed(main, 'hint', () => h('button', { class: 'row-hint', style: { height: '62px' }, onClick: addClips }, '+ Add videos and photos'));
      hint.style.left = `${pad}px`;
    } else {
      const add = this.keyed(main, 'add', () => h('button', { class: 'add-clips', 'aria-label': 'Add videos or photos', html: icon('plus', 24), onClick: (e) => { e.stopPropagation(); addClips(); } }));
      add.style.left = `${pad + videoLen(p) * pps + 10}px`;
    }
    this.sweep(main);
    main.classList.toggle('has-sel', Boolean(sel && sel.kind === 'clip'));
    // Texts, sounds, effects
    const rows = [
      ['text', 'row-text', p.texts, (x) => x.text.replace(/\n/g, ' ') || 'Text', (x) => x.dur, '+ Add text', () => Sheets.addText()],
      ['audio', 'row-audio', p.audio, (x) => `♪ ${(Media.get(x.mediaId) || {}).name || 'Sound'}`, (x) => x.out - x.in, '+ Add music', () => Sheets.music()],
      ['fx', 'row-fx', p.effects, (x) => `✦ ${(SnippyFx.byId[x.effect] || {}).name || 'Effect'}`, (x) => x.dur, '+ Add an effect', () => Sheets.effects(null)],
    ];
    for (const [kind, cls, list, label, len, hint, add] of rows) {
      const row = this.row(cls);
      for (const x of list) {
        const isSel = sel && sel.kind === kind && sel.id === x.id;
        const w = Math.max(10, len(x) * pps - 2);
        const item = this.keyed(row, x.id, () => h('div', { 'data-kind': kind, 'data-id': x.id },
          h('span', { class: 'label' }), h('div', { class: 'handle l', 'data-handle': 'l' }), h('div', { class: 'handle r', 'data-handle': 'r' })));
        item.className = `item ${kind}${isSel ? ' selected' : ''}`;
        item.style.left = `${pad + x.start * pps + 1}px`;
        item.style.width = `${w}px`;
        item.querySelector('.label').textContent = label(x);
        let bt = item.querySelector('.beats');
        if (kind === 'audio' && x.beats) {
          const bk = `${pps}|${x.in}|${x.out}|${x.beats.length}`;
          if (!bt) { bt = h('div', { class: 'beats' }); item.prepend(bt); }
          if (bt.dataset.k !== bk) {
            bt.dataset.k = bk;
            bt.textContent = '';
            for (const b of x.beats) if (b >= x.in && b <= x.out) bt.append(h('i', { style: { left: `${(b - x.in) * pps}px` } }));
          }
        } else if (bt) bt.remove();
      }
      if (!list.length) { const hn = this.keyed(row, 'hint', () => h('button', { class: 'row-hint', onClick: add }, hint)); hn.style.left = `${pad}px`; }
      this.sweep(row);
    }
  },

  drawStrip(cv, c) {
    const m = Media.get(c.mediaId);
    const g = cv.getContext('2d');
    g.fillStyle = '#3b2f5c';
    g.fillRect(0, 0, cv.width, cv.height);
    if (!m) return;
    const frames = m.strip && m.strip.length ? m.strip : m.thumb ? [m.thumb] : [];
    if (!frames.length) return;
    const H = cv.height;
    const ar = m.width && m.height ? m.width / m.height : 1;
    const tw = Math.max(30, Math.round(H * Math.min(1.2, Math.max(0.6, ar))));
    for (let x = 0; x < cv.width; x += tw) {
      const u = (x + tw / 2) / this.pps;
      const src = c.in + u * (c.speed || 1);
      const k = m.kind === 'video' ? clamp(Math.floor((src / Math.max(0.01, m.duration)) * frames.length), 0, frames.length - 1) : 0;
      const im = this.image(frames[k]);
      if (!im.complete || !im.naturalWidth) continue;
      const s = Math.max(tw / im.naturalWidth, H / im.naturalHeight);
      const sw = tw / s; const sh = H / s;
      g.drawImage(im, (im.naturalWidth - sw) / 2, (im.naturalHeight - sh) / 2, sw, sh, x, 0, tw, H);
    }
    g.fillStyle = 'rgba(0,0,0,.15)';
    for (let x = tw; x < cv.width; x += tw) g.fillRect(x, 0, 1, H);
  },

  find(kind, id) {
    const p = App.p;
    return ({ clip: p.clips, text: p.texts, audio: p.audio, fx: p.effects })[kind].find((x) => x.id === id);
  },

  // Snaps a time to the playhead, clip edges and beats nearby (8 pixels).
  snap(t, skipId) {
    const p = App.p;
    const pts = [App.player.t, 0, ...clipStarts(p), videoLen(p), ...timelineBeats(p)];
    for (const x of [...p.texts, ...p.effects]) if (x.id !== skipId) pts.push(x.start, x.start + x.dur);
    let best = t; let bd = 8 / this.pps;
    for (const q of pts) { const d = Math.abs(q - t); if (d < bd) { bd = d; best = q; } }
    if (best !== t && !this.snapped) { buzz(6); this.snapped = true; } else if (best === t) this.snapped = false;
    return best;
  },

  bind() {
    const el = this.el;
    el.addEventListener('scroll', () => {
      if (this.ignoreScroll || this.dragging) return;
      if (App.player.playing && this.touching) App.player.pause();
      if (!App.player.playing) App.player.seek(el.scrollLeft / this.pps);
    }, { passive: true });
    el.addEventListener('touchstart', (e) => { this.touching = true; if (e.touches.length === 2) this.pinchStart(e); }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && this.pinch) { e.preventDefault(); this.pinchMove(e); return; }
      // Moving a clip, or dragging a selected item or handle: the timeline mustn't scroll as well.
      if (this.dragging || (this.press && this.press.mode)) e.preventDefault();
    }, { passive: false });
    el.addEventListener('touchend', (e) => { if (e.touches.length < 2) this.pinch = null; if (!e.touches.length) this.touching = false; });
    // Mouse wheel / trackpad pinch (for testing on a computer).
    el.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); this.zoomTo(this.pps * (e.deltaY < 0 ? 1.1 : 0.9)); } }, { passive: false });
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', () => this.cancel());
    window.addEventListener('resize', () => { if (this.ready && App.p) { this.render(); this.follow(App.player.t, true); } });
  },

  pinchStart(e) {
    const [a, b] = e.touches;
    this.pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), pps: this.pps };
    this.cancel();
  },
  pinchMove(e) {
    const [a, b] = e.touches;
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    this.zoomTo(this.pinch.pps * (d / Math.max(20, this.pinch.d)));
  },
  zoomTo(pps) {
    const t = App.player.t;
    this.pps = clamp(pps, 6, 500);
    this.render();
    this.follow(t, true);
  },

  down(e) {
    const itemEl = e.target.closest('.item');
    cancelAnimationFrame(this.flingRaf);
    this.press = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false, itemEl, handle: e.target.dataset.handle || null, scroll0: this.el.scrollLeft, vx: 0, lastX: e.clientX, lastT: performance.now() };
    if (!itemEl) return;
    const kind = itemEl.dataset.kind;
    const id = itemEl.dataset.id;
    const it = this.find(kind, id);
    this.press.kind = kind; this.press.item = it; this.press.orig = JSON.parse(JSON.stringify(it));
    const isSel = App.sel && App.sel.id === id;
    if (this.press.handle && isSel) { this.press.mode = `trim-${this.press.handle}`; el(this).setPointerCapture(e.pointerId); }
    else if (isSel && kind !== 'clip') { this.press.mode = 'move'; el(this).setPointerCapture(e.pointerId); }
    else if (kind === 'clip') {
      this.press.timer = setTimeout(() => { if (this.press && !this.press.moved) this.startReorder(e); }, 420);
    }
    function el(self) { return self.el; }
  },

  move(e) {
    const pr = this.press;
    if (!pr || pr.id !== e.pointerId) return;
    const dx = e.clientX - pr.x;
    if (!pr.moved && Math.hypot(dx, e.clientY - pr.y) > 7) { pr.moved = true; clearTimeout(pr.timer); }
    // Swiping across a clip (or anything else on the timeline) scrolls it, as anywhere else does.
    if (!pr.mode && pr.moved && pr.itemEl) {
      const now = performance.now();
      pr.vx = 0.8 * ((e.clientX - pr.lastX) / Math.max(1, now - pr.lastT)) + 0.2 * pr.vx;
      pr.lastX = e.clientX; pr.lastT = now;
      if (!pr.scrolling) { pr.scrolling = true; this.touching = true; if (App.player.playing) App.player.pause(); }
      this.el.scrollLeft = pr.scroll0 - dx;
      return;
    }
    if (!pr.mode || !pr.moved) return;
    if (!pr.started) { pr.started = true; commit(); App.player.pause(); this.dragging = true; }
    const dt = dx / this.pps;
    const p = App.p;
    const it = pr.item;
    const o = pr.orig;
    const m = it.mediaId ? Media.get(it.mediaId) : null;
    if (pr.mode === 'reorder') { this.reorderMove(e); return; }
    if (pr.kind === 'clip') {
      const sp = it.speed || 1;
      const isImg = m && m.kind === 'image';
      if (pr.mode === 'trim-r' || (isImg && pr.mode === 'trim-l')) {
        const d = pr.mode === 'trim-l' ? -dt : dt;
        it.out = clamp(o.out + d * sp, o.in + 0.2 * sp, isImg ? 600 : m.duration);
        App.player.seek(clipStarts(p)[p.clips.indexOf(it)] + clipLen(it) - 0.02);
      } else {
        it.in = clamp(o.in + dt * sp, 0, o.out - 0.2 * sp);
        App.player.seek(clipStarts(p)[p.clips.indexOf(it)] + 0.01);
      }
    } else if (pr.kind === 'audio') {
      const dur = m ? m.duration : 1e9;
      if (pr.mode === 'trim-l') { const d = clamp(dt, -o.in, o.out - o.in - 0.3); it.in = o.in + d; it.start = Math.max(0, o.start + d); }
      else if (pr.mode === 'trim-r') it.out = clamp(o.out + dt, o.in + 0.3, dur);
      else it.start = Math.max(0, this.snap(o.start + dt, it.id));
    } else {
      if (pr.mode === 'trim-l') { const s = clamp(this.snap(o.start + dt, it.id), 0, o.start + o.dur - 0.3); it.dur = o.start + o.dur - s; it.start = s; }
      else if (pr.mode === 'trim-r') it.dur = Math.max(0.3, this.snap(o.start + o.dur + dt, it.id) - o.start);
      else it.start = Math.max(0, this.snap(o.start + dt, it.id));
    }
    changed({ save: false });
  },

  up(e) {
    const pr = this.press;
    this.press = null;
    if (!pr) return;
    clearTimeout(pr.timer);
    if (pr.mode === 'reorder') { this.reorderEnd(e, pr); return; }
    if (pr.started) { this.dragging = false; changed(); return; }
    if (pr.scrolling) { this.fling(pr.vx); return; }
    if (pr.moved) return;
    // A tap.
    if (pr.itemEl) select(pr.kind, pr.item.id);
    else if (!e.target.closest('button')) select(null);
  },
  cancel() {
    if (this.press) clearTimeout(this.press.timer);
    if (this.press && this.press.mode === 'reorder') this.reorderEnd(null, this.press);
    this.press = null;
    this.dragging = false;
  },

  // Carries on scrolling after a quick swipe, slowing down.
  fling(v) {
    let vel = -v * 16; // pixels per frame
    const step = () => {
      if (Math.abs(vel) < 0.5) { this.touching = false; return; }
      this.el.scrollLeft += vel;
      vel *= 0.94;
      this.flingRaf = requestAnimationFrame(step);
    };
    if (Math.abs(vel) > 2) this.flingRaf = requestAnimationFrame(step); else this.touching = false;
  },

  // ---------- moving a clip somewhere else
  startReorder(e) {
    const pr = this.press;
    pr.mode = 'reorder';
    pr.started = true;
    this.dragging = true;
    App.player.pause();
    buzz(20);
    try { this.el.setPointerCapture(pr.id); } catch { /* ok */ }
    const c = pr.item;
    select('clip', c.id);
    const ghost = h('div', { class: 'reorder-ghost', style: { width: '74px' } });
    const cv = h('canvas', { width: '74', height: '62' });
    this.drawStrip(cv, c);
    ghost.append(cv);
    document.body.append(ghost);
    pr.ghost = ghost;
    pr.mark = h('div', { class: 'drop-mark' });
    this.inner.append(pr.mark);
    this.reorderMove(e);
  },
  reorderMove(e) {
    const pr = this.press;
    if (!pr || !pr.ghost) return;
    pr.ghost.style.left = `${e.clientX - 37}px`;
    pr.ghost.style.top = `${e.clientY - 40}px`;
    const p = App.p;
    const t = this.timeAtClientX(e.clientX);
    const starts = clipStarts(p);
    let idx = p.clips.length;
    for (let i = 0; i < p.clips.length; i++) if (t < starts[i] + clipLen(p.clips[i]) / 2) { idx = i; break; }
    pr.drop = idx;
    const at = idx < p.clips.length ? starts[idx] : videoLen(p);
    pr.mark.style.left = `${this.x(at)}px`;
    pr.lastE = { clientX: e.clientX, clientY: e.clientY };
    // Held near an edge: keep scrolling that way.
    if (!pr.edgeRaf) {
      const edge = () => {
        if (this.press !== pr || pr.mode !== 'reorder') { pr.edgeRaf = 0; return; }
        const r = this.el.getBoundingClientRect();
        const x = pr.lastE.clientX;
        const d = x < r.left + 48 ? -1 : x > r.right - 48 ? 1 : 0;
        if (d) { this.el.scrollLeft += d * 9; this.reorderMove(pr.lastE); }
        pr.edgeRaf = requestAnimationFrame(edge);
      };
      pr.edgeRaf = requestAnimationFrame(edge);
    }
  },
  reorderEnd(e, pr) {
    if (pr.ghost) pr.ghost.remove();
    if (pr.mark) pr.mark.remove();
    this.dragging = false;
    const p = App.p;
    const from = p.clips.indexOf(pr.item);
    let to = pr.drop ?? from;
    if (e && from >= 0 && to !== from && to !== from + 1) {
      commit();
      p.clips.splice(from, 1);
      if (to > from) to -= 1;
      p.clips.splice(to, 0, pr.item);
      if (p.clips[0]) { delete p.clips[0].transition; delete p.clips[0].transitionType; }
      changed();
      App.player.seek(clipStarts(p)[to] + 0.01);
      buzz(12);
    } else this.render();
  },
};
