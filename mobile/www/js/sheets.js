'use strict';
// The bottom sheets: every tool opens one.

let sheetOnClose = null;
function openSheet(title, build, { tall = false, onClose = null } = {}) {
  closeSheet(true);
  $('#sheetTitle').textContent = title;
  const body = $('#sheetBody');
  body.textContent = '';
  body.scrollTop = 0;
  $('#sheet').classList.toggle('tall', tall);
  $('#sheet').hidden = false;
  sheetOnClose = onClose;
  // Anything left out (null or false) is simply skipped.
  body.append = (...kids) => Element.prototype.append.call(body, ...kids.filter((k) => k != null && k !== false));
  build(body);
  hydrateIcons(body);
}
function closeSheet(silent) {
  if ($('#sheet').hidden) return;
  $('#sheet').hidden = true;
  const fn = sheetOnClose;
  sheetOnClose = null;
  if (fn && !silent) fn();
  if (App.player) App.player.hideText = null;
  if (App.p) changed();
}
$('#sheetDone').addEventListener('click', () => closeSheet());
$('#sheetScrim').addEventListener('click', () => closeSheet());

// ---------- building blocks
function slider(label, { min, max, step = 0.01, value, format = (v) => v, onInput, log = false }) {
  const toPos = (v) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min));
  const fromPos = (q) => (log ? min * (max / min) ** q : min + q * (max - min));
  const out = h('output', null, format(value));
  const input = h('input', { type: 'range', min: '0', max: '1000', step: '1', value: String(Math.round(toPos(value) * 1000)), 'aria-label': label });
  input.addEventListener('input', () => {
    let v = fromPos(Number(input.value) / 1000);
    v = Math.round(v / step) * step;
    out.textContent = format(v);
    onInput(v);
  });
  input.setValue = (v) => { input.value = String(Math.round(toPos(v) * 1000)); out.textContent = format(v); };
  const f = h('div', { class: 'field' }, h('span', null, label), h('div', { class: 'slider-row' }, input, out));
  f.input = input;
  return f;
}
function chips(options, current, onPick, label) {
  const row = h('div', { class: 'chips', role: 'group', 'aria-label': label || '' });
  for (const [id, name] of options) {
    row.append(h('button', { class: 'chip', 'aria-pressed': String(id === current), onClick: () => {
      for (const b of row.children) b.setAttribute('aria-pressed', 'false');
      row.children[options.findIndex((o) => o[0] === id)].setAttribute('aria-pressed', 'true');
      onPick(id);
    } }, name));
  }
  return row;
}
const field = (label, ...kids) => h('div', { class: 'field' }, h('span', null, label), ...kids);
const pct = (v) => `${Math.round(v * 100)}%`;

// A sample picture for previews: the clip's own, or the one under the playhead.
function samplePicture(c) {
  const p = App.p;
  let m = c && c.mediaId ? Media.get(c.mediaId) : null;
  if (!m && p) { const on = clipsAt(p, App.player.t); if (on.length) m = Media.get(on[0].clip.mediaId); }
  if (!m && p && p.clips[0]) m = Media.get(p.clips[0].mediaId);
  return m && m.thumb ? m.thumb : null;
}
let tileFx = null;
function drawFxTile(cv, img, e, k) {
  const g = cv.getContext('2d');
  const W = cv.width; const H = cv.height;
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  if (img && img.naturalWidth) {
    const s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
    g.drawImage(img, (W - img.naturalWidth * s) / 2, (H - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
  } else {
    const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, '#4f46e5'); gr.addColorStop(0.6, '#f472b6'); gr.addColorStop(1, '#fb923c');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
  }
  if (e.classic) {
    const f = classicFilter(e.id, 0.05) || (e.id === 'oldfilm' ? 'grayscale(1)' : '');
    if (f) { g.filter = f; g.drawImage(cv, 0, 0); g.filter = 'none'; }
    classicFx(g, e.id, W, H, 0);
    return;
  }
  if (!tileFx) tileFx = new FxRunner();
  if (!tileFx.ok) return;
  const out = tileFx.run(cv, [{ id: e.id, k: k ?? SnippyFx.DEFAULT_K, t: 0.9, dur: 3, env: e.beat ? 1 : 0, bc: 3 }]);
  g.drawImage(out, 0, 0);
}

const Sheets = {
  rename() {
    openSheet('Name', (b) => {
      const inp = h('input', { class: 'input', type: 'text', value: App.p.name, 'aria-label': 'Project name' });
      b.append(inp, h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onClick: () => { App.p.name = inp.value.trim() || 'My video'; closeSheet(); } }, 'Save')));
      setTimeout(() => inp.focus(), 250);
    });
  },

  format() {
    const p = App.p;
    openSheet('Shape and background', (b) => {
      b.append(field('Shape', chips(Object.entries(ASPECTS).map(([id, a]) => [id, `${id}  ${a.name.split(',')[0]}`]), p.aspect, (id) => { commit(); p.aspect = id; App.player.setProject(p); changed(); })),
        field('Behind pictures that don’t fill the frame', chips([['blur', 'Blurred'], ['black', 'Black'], ['white', 'White']], p.bg || 'blur', (id) => { commit(); p.bg = id; changed(); })),
        field('Ending', chips([['0', 'Straight cut'], ['1', 'Fade to black']], String(p.endFade ? 1 : 0), (v) => { commit(); p.endFade = Number(v); changed(); })));
    });
  },

  speed(c) {
    commit();
    openSheet('Speed', (b) => {
      const s = slider('Speed', { min: 0.25, max: 4, step: 0.05, value: c.speed || 1, log: true, format: (v) => `${v.toFixed(2).replace(/\.?0+$/, '')}×`, onInput: (v) => { c.speed = v; changed({ save: false }); } });
      b.append(s, chips([['0.5', '0.5×'], ['1', '1×'], ['1.5', '1.5×'], ['2', '2×'], ['3', '3×']], String(c.speed || 1), (v) => { c.speed = Number(v); s.input.setValue(c.speed); changed(); }),
        h('p', { class: 'hint' }, 'Slower clips get longer on the timeline; faster ones get shorter.'));
    });
  },

  volume(it) {
    commit();
    const isClip = Boolean(it.in != null && App.p.clips.includes(it));
    openSheet(isClip ? 'Clip sound' : 'Volume', (b) => {
      const s = slider('Volume', { min: 0, max: 2, step: 0.05, value: it.volume ?? 1, format: pct, onInput: (v) => { it.volume = v; changed({ save: false }); } });
      b.append(s, chips([['0', 'Mute'], ['0.5', '50%'], ['1', '100%'], ['1.5', '150%']], String(it.volume ?? 1), (v) => { it.volume = Number(v); s.input.setValue(it.volume); changed(); }));
      if (isClip) b.append(h('div', { class: 'btn-row' }, h('button', { class: 'btn', onClick: () => { commit(); for (const c of App.p.clips) c.volume = 0; changed(); toast('All clips muted'); } }, 'Mute all clips')));
    });
  },

  fade(a) {
    commit();
    openSheet('Fade', (b) => {
      b.append(slider('Fade in', { min: 0, max: 5, step: 0.1, value: a.fadeIn || 0, format: (v) => `${v.toFixed(1)} s`, onInput: (v) => { a.fadeIn = v; changed({ save: false }); } }),
        slider('Fade out', { min: 0, max: 5, step: 0.1, value: a.fadeOut || 0, format: (v) => `${v.toFixed(1)} s`, onInput: (v) => { a.fadeOut = v; changed({ save: false }); } }));
    });
  },

  async beats(a) {
    const m = Media.get(a.mediaId);
    if (!a.beats) {
      Busy.show('Listening for the beat', m ? m.name : '', { cancel: false });
      try { const r = await Media.beats(m); a.beats = r.beats; a.bpm = r.bpm; } finally { Busy.hide(); }
      changed();
    }
    openSheet('Beats', (b) => {
      b.append(h('p', { class: 'hint' }, a.beats && a.beats.length ? `${Math.round(a.bpm)} beats a minute. The beats show as ticks on the music.` : 'No steady beat found in this sound.'));
      if (a.beats && a.beats.length) {
        b.append(h('button', { class: 'btn primary wide', onClick: () => { lineUpCuts(a); closeSheet(); } }, 'Line up my cuts with the beat'),
          h('p', { class: 'hint' }, 'Moves the end of each clip a little, so every cut lands on a beat.'));
      }
    });
  },

  transition(i) {
    const p = App.p;
    const c = p.clips[i];
    if (!c || i === 0) { toast('Pick the cut between two clips'); return; }
    commit();
    openSheet('Transition', (b) => {
      const grid = h('div', { class: 'chips' });
      const set = (type) => {
        c.transitionType = type;
        if (type === 'none') { delete c.transition; delete c.transitionType; } else c.transition = c.transition || 0.5;
        changed();
        App.player.seek(Math.max(0, clipStarts(p)[i] - 0.6));
        App.player.play();
        setTimeout(() => { if (App.player.playing) App.player.pause(); }, 1800);
      };
      b.append(field('Style', chips(TRANSITIONS, c.transitionType || 'none', set)),
        slider('Length', { min: 0.2, max: 1.5, step: 0.05, value: c.transition || 0.5, format: (v) => `${v.toFixed(2)} s`, onInput: (v) => { c.transition = v; changed({ save: false }); } }),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn', onClick: () => {
          commit();
          p.clips.forEach((x, j) => { if (j) { x.transitionType = c.transitionType; x.transition = c.transition; } });
          changed(); toast('Used on every cut');
        } }, 'Use on every cut')));
      grid.remove();
    });
  },

  filters(c) {
    const p = App.p;
    const target = c || (p.clips.length ? clipsAt(p, App.player.t).slice(-1)[0]?.clip : null);
    if (!target) { toast('Add a clip first'); return; }
    commit();
    const pic = samplePicture(target);
    openSheet(c ? 'Filters' : 'Filters (this clip)', (b) => {
      const grid = h('div', { class: 'grid' });
      for (const l of LOOKS) {
        const t = h('button', { class: 'tile', 'aria-pressed': String((target.look || 'none') === l.id), onClick: () => {
          target.look = l.id;
          for (const x of grid.children) x.setAttribute('aria-pressed', String(x === t));
          changed();
        } }, h('div', { class: 'pic' }, pic ? h('img', { src: pic, alt: '', style: { filter: l.css || 'none' } }) : null), l.name);
        grid.append(t);
      }
      const adj = target.adj || (target.adj = {});
      b.append(grid,
        slider('Brightness', { min: -0.5, max: 0.5, value: adj.b || 0, format: (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`, onInput: (v) => { adj.b = v; changed({ save: false }); } }),
        slider('Contrast', { min: -0.5, max: 0.5, value: adj.c || 0, format: (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`, onInput: (v) => { adj.c = v; changed({ save: false }); } }),
        slider('Saturation', { min: -1, max: 1, value: adj.s || 0, format: (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`, onInput: (v) => { adj.s = v; changed({ save: false }); } }),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn', onClick: () => {
          commit(); for (const x of p.clips) { x.look = target.look; x.adj = { ...adj }; } changed(); toast('Used on every clip');
        } }, 'Use on every clip')));
    });
  },

  // Effects: with a clip selected they go on that clip; otherwise they're added to the timeline
  // at the playhead (3 seconds, drag the ends to change). `item`: an effect already on the timeline.
  effects(c, item) {
    const p = App.p;
    if (!p.clips.length) { toast('Add a clip first'); return; }
    commit();
    const picUrl = samplePicture(c);
    const img = new Image();
    if (picUrl) img.src = picUrl;
    let cat = 'all';
    let current = c ? c.fx : item ? item.effect : null;
    let added = item || null;
    openSheet(c ? 'Effects for this clip' : 'Effects', (b) => {
      const tabs = chips([['all', 'All'], ...SnippyFx.CATS.map(([id, n]) => [id, n.split(' & ')[0]])], cat, (id) => { cat = id; draw(); });
      const grid = h('div', { class: 'grid' });
      const strength = slider('Strength', { min: 0.1, max: 1, step: 0.05, value: (c ? c.fxK : added ? added.k : null) ?? SnippyFx.DEFAULT_K, format: pct, onInput: (v) => {
        if (c) c.fxK = v; else if (added) added.k = v;
        changed({ save: false });
      } });
      const pick = (e) => {
        current = e.id;
        if (c) { c.fx = e.id; if (SnippyFx.isNew(e.id)) c.fxK = c.fxK ?? SnippyFx.DEFAULT_K; }
        else if (added) added.effect = e.id;
        else {
          const start = App.player.t;
          const dur = Math.max(0.5, Math.min(3, videoLen(p) - start));
          added = { id: uid('e'), effect: e.id, start, dur, k: SnippyFx.DEFAULT_K };
          p.effects.push(added);
          if (!SnippyFx.isNew(e.id)) { p.effects.pop(); added = null; const on = clipsAt(p, start); if (on.length) on[0].clip.fx = e.id; toast('That effect goes on the clip itself'); }
        }
        strength.hidden = !SnippyFx.isNew(e.id);
        for (const x of grid.querySelectorAll('.tile')) x.setAttribute('aria-pressed', String(x.dataset.id === e.id));
        changed();
        if (!App.player.playing) { App.player.play(); setTimeout(() => App.player.pause(), 2000); }
      };
      const draw = () => {
        grid.textContent = '';
        if (c) grid.append(h('button', { class: 'tile', 'data-id': 'none', 'aria-pressed': String(!current), onClick: () => { c.fx = null; current = null; changed(); for (const x of grid.querySelectorAll('.tile')) x.setAttribute('aria-pressed', String(x.dataset.id === 'none')); } }, h('div', { class: 'pic', style: { display: 'grid', placeItems: 'center' } }, '⦸'), 'None'));
        for (const [catId, catName] of SnippyFx.CATS) {
          if (cat !== 'all' && cat !== catId) continue;
          grid.append(h('div', { class: 'cat-head' }, catName));
          for (const e of SnippyFx.ALL.filter((x) => x.cat === catId)) {
            if (!c && e.classic) continue;
            const cv = h('canvas', { width: '120', height: '120' });
            const tile = h('button', { class: 'tile', 'data-id': e.id, 'aria-pressed': String(current === e.id), onClick: () => pick(e) },
              h('div', { class: 'pic' }, cv, e.beat ? h('span', { class: 'note' }, '♪') : null), e.name);
            grid.append(tile);
            const go = () => drawFxTile(cv, img, e);
            if (img.complete) go(); else img.addEventListener('load', go, { once: true });
          }
        }
      };
      draw();
      strength.hidden = !SnippyFx.isNew(current);
      b.append(tabs, strength, grid);
      if (!c && !item) b.prepend(h('p', { class: 'hint' }, 'Adds the effect at the playhead for 3 seconds. Drag its ends on the timeline to cover more. To put one on a single clip, select the clip first.'));
    }, { tall: true });
  },

  music() {
    const p = App.p;
    openSheet('Music and sound', (b) => {
      b.append(h('button', { class: 'btn primary wide', onClick: async () => {
        const files = await pickFiles($('#pickAudio'));
        const ms = await importFiles(files, 'Adding your music');
        const m = ms[0];
        if (!m) return;
        commit();
        const start = p.audio.length ? App.player.t : 0;
        const len = Math.min(m.duration, Math.max(1, videoLen(p) - start));
        const a = { id: uid('a'), mediaId: m.id, start, in: 0, out: len, volume: 1, fadeIn: 0, fadeOut: Math.min(1.5, len / 4) };
        p.audio.push(a);
        closeSheet();
        changed();
        select('audio', a.id);
        Media.beats(m).then((r) => { a.beats = r.beats; a.bpm = r.bpm; changed(); if (r.beats && r.beats.length > 8) toast(`Found the beat: ${Math.round(r.bpm)} a minute. Tap Beats to line your cuts up with it.`, 4000); }).catch(() => {});
      } }, h('span', { html: icon('music') }), 'Choose music from your phone'),
      h('p', { class: 'hint' }, 'Pick a song or any sound (a video’s sound works too). Its beat is found by itself.'));
      if (p.clips.length) {
        b.append(h('div', { class: 'btn-row' }, h('button', { class: 'btn', onClick: () => { commit(); for (const c of p.clips) c.volume = 0; closeSheet(); changed(); toast('Clip sound off'); } }, h('span', { html: icon('mute') }), 'Turn clip sound off')));
      }
    });
  },

  addText() {
    const p = App.p;
    if (!p.clips.length) { toast('Add a clip first'); return; }
    commit();
    const t = Math.min(App.player.t, Math.max(0, videoLen(p) - 0.5));
    const x = { id: uid('t'), kind: 'text', text: 'Your text', start: t, dur: Math.min(3, Math.max(0.5, videoLen(p) - t)), size: 7, position: 'center', offsetY: 0, color: '#FFFFFF', font: 'default', anim: 'pop', out: 'fade', loop: 'none', wordFx: 'none', hlColor: '#FFD84D', highlight: false, box: false, caps: false, align: 'center' };
    p.texts.push(x);
    select('text', x.id);
    changed();
    Sheets.text(x, 'edit', true);
  },

  text(x, focus = 'edit', fresh = false) {
    if (!fresh) commit();
    App.player.pause();
    App.player.seek(x.start + Math.min(0.6, x.dur / 2));
    openSheet(x.kind === 'caption' ? 'Caption' : 'Text', (b) => {
      const ta = h('textarea', { class: 'input', rows: '2', 'aria-label': 'Text' });
      ta.value = x.text;
      ta.addEventListener('input', () => { x.text = ta.value; delete x.words; changed({ save: false }); });
      const presetRow = chips(CAPTION_PRESETS.map((s) => [s.id, s.name]), x.preset || '', (id) => {
        const pr = CAPTION_PRESETS.find((s) => s.id === id);
        Object.assign(x, pr.set, { preset: id });
        changed();
      }, 'Styles');
      const colors = ['#FFFFFF', '#000000', '#FDE047', '#F472B6', '#C084FC', '#60A5FA', '#4ADE80', '#F87171', '#FB923C'];
      const sw = h('div', { class: 'swatches' });
      for (const col of colors) {
        sw.append(h('button', { class: 'swatch', style: { background: col }, 'aria-label': col, 'aria-pressed': String((x.color || '').toUpperCase() === col), onClick: (e) => {
          x.color = col; for (const s of sw.children) s.setAttribute('aria-pressed', String(s === e.currentTarget)); changed();
        } }));
      }
      const anim = h('div', null,
        field('Comes in', chips(TEXT_IN, x.anim || 'none', (v) => { x.anim = v; changed(); App.player.seek(x.start); App.player.play(); setTimeout(() => App.player.pause(), Math.min(2500, x.dur * 1000)); })),
        field('Goes out', chips(TEXT_OUT, x.out || 'none', (v) => { x.out = v; changed(); })),
        field('While showing', chips(TEXT_LOOP, x.loop || 'none', (v) => { x.loop = v; changed(); })));
      b.append(ta,
        field('Style', presetRow),
        field('Font', chips(TEXT_FONTS.map((f) => [f[0], f[1]]), x.font || 'default', (v) => { x.font = v; changed(); })),
        field('Colour', sw),
        slider('Size', { min: 2, max: 16, step: 0.1, value: x.size || 7, format: (v) => v.toFixed(1), onInput: (v) => { x.size = v; changed({ save: false }); } }),
        field('Place', chips([['top', 'Top'], ['center', 'Middle'], ['bottom', 'Bottom']], x.position || 'center', (v) => { x.position = v; x.offsetY = 0; changed(); })),
        field('Extras', chips([['box', 'Box behind'], ['caps', 'CAPITALS'], ['none', 'Plain']], x.box ? 'box' : x.caps ? 'caps' : 'none', (v) => { x.box = v === 'box'; x.caps = v === 'caps'; changed(); })),
        anim);
      if (focus === 'anim') setTimeout(() => anim.scrollIntoView({ block: 'start' }), 260);
      else if (fresh) setTimeout(() => { ta.focus(); ta.select(); }, 260);
    }, { tall: true });
  },

  captions() {
    const p = App.p;
    if (!p.clips.length) { toast('Add a clip first'); return; }
    let lang = 'auto';
    let style = 'boldbox';
    openSheet('Auto captions', (b) => {
      b.append(h('p', { class: 'hint' }, 'Snippy listens to your clips and writes captions for what’s said, timed to each word. It runs on your phone; the first time, it downloads the speech model (about 75 MB).'),
        field('Language', chips([['auto', 'Work it out'], ['en', 'English']], lang, (v) => { lang = v; })),
        field('Style', chips(CAPTION_PRESETS.map((s) => [s.id, s.name]), style, (v) => { style = v; })),
        h('button', { class: 'btn primary wide', onClick: () => { closeSheet(true); CaptionsAI.run({ lang, style }); } }, h('span', { html: icon('captions') }), 'Make captions'));
      if (p.texts.some((x) => x.kind === 'caption')) b.append(h('p', { class: 'hint' }, 'This replaces the captions you already have.'));
    });
  },

  exportSheet() {
    const p = App.p;
    if (!p.clips.length) { toast('Add a clip first'); return; }
    App.player.pause();
    let res = 1080; let fps = 30; let quality = 'standard';
    openSheet('Export', (b) => {
      b.append(field('Resolution', chips([['720', '720p'], ['1080', '1080p (best)']], String(res), (v) => { res = Number(v); })),
        field('Frame rate', chips([['30', '30 fps'], ['60', '60 fps']], String(fps), (v) => { fps = Number(v); })),
        field('Quality', chips([['small', 'Smaller file'], ['standard', 'Standard'], ['high', 'Best']], quality, (v) => { quality = v; })),
        h('p', { class: 'hint' }, `${fmt(videoLen(p))} long. Exporting plays the video through once, so it takes about that long. Keep Snippy open until it finishes.`),
        h('button', { class: 'btn primary wide', onClick: () => { closeSheet(true); Exporter.run(p, { short: res, fps, quality }); } }, h('span', { html: icon('download') }), 'Export to my phone'));
    });
  },
};

// Moves each cut onto the nearest beat (within half a beat), keeping every clip at least 0.3 s.
function lineUpCuts(a) {
  const p = App.p;
  commit();
  const beats = timelineBeats(p).map((t) => t - 1 / 30); // a frame early looks right on the beat
  let moved = 0;
  for (let i = 0; i < p.clips.length - 1; i++) {
    const starts = clipStarts(p);
    const c = p.clips[i];
    const ov = overlapOf(p, i + 1);
    const cut = starts[i] + clipLen(c) - ov / 2;
    const near = beats.reduce((best, b) => (Math.abs(b - cut) < Math.abs(best - cut) ? b : best), Infinity);
    const d = near - cut;
    if (!Number.isFinite(d) || Math.abs(d) > 0.4 || Math.abs(d) < 0.005) continue;
    const m = Media.get(c.mediaId);
    const newOut = c.out + d * (c.speed || 1);
    const max = m && m.kind === 'video' ? m.duration : 600;
    if (newOut - c.in < 0.3 * (c.speed || 1) || newOut > max) continue;
    c.out = newOut;
    moved++;
  }
  changed();
  toast(moved ? `Moved ${moved} cut${moved === 1 ? '' : 's'} onto the beat` : 'Your cuts were already on the beat');
}
