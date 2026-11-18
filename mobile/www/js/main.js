'use strict';
// Snippy for phones: screens, the project being edited, saving, and the toolbar.

const APP_VERSION = window.SNIPPY_VERSION || 'dev';

const App = {
  p: null,
  sel: null, // { kind: 'clip' | 'text' | 'audio' | 'fx', id }
  player: null,
};

// ---------- busy window (long jobs)
const Busy = {
  cancelled: false,
  show(title, text = '', { cancel = true } = {}) {
    this.cancelled = false;
    $('#busyTitle').textContent = title;
    $('#busyText').textContent = text;
    $('#busyBar').style.width = '0%';
    $('#busyCancel').hidden = !cancel;
    $('#busy').hidden = false;
  },
  update(p, text) {
    if (p != null) $('#busyBar').style.width = `${Math.round(clamp(p, 0, 1) * 100)}%`;
    if (text != null) $('#busyText').textContent = text;
  },
  hide() { $('#busy').hidden = true; },
};
$('#busyCancel').addEventListener('click', () => { Busy.cancelled = true; $('#busyText').textContent = 'Stopping…'; });

// ---------- projects
let saveTimer = null;
function changed({ save = true, timeline = true } = {}) {
  if (!App.p) return;
  if (App.player) App.player.changed();
  $('#edName').textContent = App.p.name;
  $('#edAspect').textContent = App.p.aspect;
  if (timeline && Timeline.ready) Timeline.render();
  Toolbar.render();
  updateTime(App.player ? App.player.t : 0);
  if (save) { clearTimeout(saveTimer); saveTimer = setTimeout(saveProject, 600); }
}
function commit() { if (App.p) History.snap(App.p); }

async function saveProject() {
  const p = App.p;
  if (!p) return;
  p.updated = Date.now();
  p.media = [...new Set([...p.clips.map((c) => c.mediaId), ...p.audio.map((a) => a.mediaId)])];
  const first = p.clips[0] && Media.get(p.clips[0].mediaId);
  try {
    await Store.putProject({ id: p.id, name: p.name, aspect: p.aspect, updated: p.updated, thumb: first ? first.thumb : null, length: videoLen(p), data: p });
  } catch (err) { toast(`Couldn’t save: ${err.message}`); }
}

async function openProject(p) {
  Busy.show('Opening', p.name, { cancel: false });
  try {
    await Media.load(p.media && p.media.length ? p.media : [...p.clips.map((c) => c.mediaId), ...p.audio.map((a) => a.mediaId)]);
  } finally { Busy.hide(); }
  // Older saves may lack newer fields.
  for (const k of ['clips', 'texts', 'audio', 'effects', 'media']) if (!p[k]) p[k] = [];
  App.p = p;
  App.sel = null;
  History.reset();
  showScreen('editor');
  if (!App.player) App.player = new Player($('#stage'), updateTime);
  App.player.t = 0;
  App.player.setProject(p);
  Timeline.init();
  changed({ save: false });
  // Timeline pictures, made in the background.
  for (const c of p.clips) {
    const m = Media.get(c.mediaId);
    if (m && m.kind === 'video' && (!m.strip || m.strip.length < 10)) Media.strip(m).then(() => Timeline.render());
  }
}

function showScreen(name) {
  $('#home').hidden = name !== 'home';
  $('#editor').hidden = name !== 'editor';
  if (name === 'home') { if (App.player) App.player.pause(); renderHome(); }
}

async function goHome() {
  closeSheet();
  if (App.p) { clearTimeout(saveTimer); await saveProject(); }
  App.p = null;
  showScreen('home');
}

function updateTime(t) {
  if (!App.p) return;
  $('#time').textContent = `${fmt(t, true)} / ${fmt(videoLen(App.p), true)}`;
  $('#play').innerHTML = icon(App.player && App.player.playing ? 'pause' : 'play', 26);
  $('#undo').disabled = !History.past.length;
  $('#redo').disabled = !History.future.length;
  if (Timeline.ready) Timeline.follow(t);
}

// ---------- adding media
function pickFiles(input) {
  return new Promise((resolve) => {
    input.value = '';
    const done = () => { input.removeEventListener('change', done); resolve([...input.files]); };
    input.addEventListener('change', done);
    input.click();
  });
}

async function importFiles(files, title = 'Adding your clips') {
  const out = [];
  if (!files.length) return out;
  Busy.show(title, '', { cancel: false });
  try {
    for (let i = 0; i < files.length; i++) {
      Busy.update(i / files.length, `${i + 1} of ${files.length}: ${files[i].name}`);
      try { out.push(await Media.add(files[i])); } catch (err) { toast(err.message, 4000); }
    }
  } finally { Busy.hide(); }
  return out;
}

function clipFor(m) {
  return { id: uid('c'), mediaId: m.id, in: 0, out: m.kind === 'image' ? 3 : m.duration, speed: 1, volume: 1, look: 'none' };
}

async function addClips() {
  const files = await pickFiles($('#pickMedia'));
  const ms = (await importFiles(files)).filter((m) => m.kind !== 'audio');
  if (!ms.length || !App.p) return;
  commit();
  // After the clip under the playhead (or at the end).
  const p = App.p;
  let at = p.clips.length;
  if (p.clips.length && App.player) {
    const on = clipsAt(p, App.player.t);
    if (on.length) at = on[on.length - 1].i + 1;
  }
  p.clips.splice(at, 0, ...ms.map(clipFor));
  changed();
  for (const m of ms) if (m.kind === 'video') Media.strip(m).then(() => Timeline.render());
  toast(ms.length === 1 ? 'Added 1 clip' : `Added ${ms.length} clips`);
}

async function newProjectFlow(aspect) {
  const p = newProject(aspect);
  const files = await pickFiles($('#pickMedia'));
  const ms = (await importFiles(files)).filter((m) => m.kind !== 'audio');
  if (!ms.length) return;
  p.clips = ms.map(clipFor);
  p.media = ms.map((m) => m.id);
  await Store.putProject({ id: p.id, name: p.name, aspect: p.aspect, updated: Date.now(), thumb: ms[0].thumb, data: p });
  await openProject(p);
}

// ---------- home
async function renderHome() {
  $('#version').textContent = `v${APP_VERSION}`;
  const row = $('#aspectRow');
  row.textContent = '';
  for (const [id, a] of Object.entries(ASPECTS)) {
    const big = 40;
    const w = a.w >= a.h ? big : Math.round((big * a.w) / a.h);
    const hh = a.h >= a.w ? big : Math.round((big * a.h) / a.w);
    row.append(h('button', { class: 'aspect-card', onClick: () => newProjectFlow(id) },
      h('span', { class: 'shape', style: { width: `${w}px`, height: `${hh}px` } }), h('b', null, id), h('small', null, a.name)));
  }
  const list = $('#projects');
  list.textContent = '';
  const ps = await Store.projects().catch(() => []);
  $('#noProjects').hidden = ps.length > 0;
  for (const pr of ps) {
    const card = h('div', { class: 'project' },
      h('button', { class: 'thumb', style: { backgroundImage: pr.thumb ? `url(${pr.thumb})` : 'none' }, 'aria-label': `Open ${pr.name}`, onClick: () => openProject(pr.data) }),
      h('div', { class: 'meta' }, h('b', null, pr.name), h('small', null, `${pr.aspect} · ${fmt(pr.length || 0)} · ${new Date(pr.updated).toLocaleDateString()}`)),
      h('button', { class: 'menu', 'aria-label': `More for ${pr.name}`, html: icon('more', 18), onClick: () => projectMenu(pr) }));
    list.append(card);
  }
}

function projectMenu(pr) {
  openSheet(pr.name, (body) => {
    const name = h('input', { class: 'input', type: 'text', value: pr.name, 'aria-label': 'Name' });
    body.append(h('label', { class: 'field' }, h('span', null, 'Name'), name),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onClick: async () => { pr.data.name = name.value.trim() || pr.name; pr.name = pr.data.name; await Store.putProject(pr); closeSheet(); renderHome(); } }, 'Rename'),
        h('button', { class: 'btn', onClick: async () => { const d = JSON.parse(JSON.stringify(pr.data)); d.id = uid('p'); d.name = `${pr.name} (copy)`; await Store.putProject({ ...pr, id: d.id, name: d.name, updated: Date.now(), data: d }); closeSheet(); renderHome(); } }, 'Duplicate')),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', style: { color: '#fca5a5' }, onClick: async () => {
        await Store.deleteProject(pr.id); await Store.tidy().catch(() => {}); closeSheet(); renderHome(); toast('Project deleted');
      } }, 'Delete project')));
  });
}

// ---------- selection and the toolbar
function select(kind, id) {
  App.sel = kind ? { kind, id } : null;
  if (Timeline.ready) Timeline.render();
  Toolbar.render();
  stageHint();
}
function selected() {
  const s = App.sel;
  const p = App.p;
  if (!s || !p) return null;
  const list = { clip: p.clips, text: p.texts, audio: p.audio, fx: p.effects }[s.kind];
  return list ? list.find((x) => x.id === s.id) || null : null;
}
function stageHint() {
  const s = App.sel;
  const hint = $('#stageHint');
  const msg = s && s.kind === 'clip' ? 'Pinch to zoom, drag to move, twist to turn' : s && s.kind === 'text' ? 'Drag to move the text, pinch to resize' : '';
  hint.hidden = !msg;
  hint.textContent = msg;
  clearTimeout(stageHint.t);
  if (msg) stageHint.t = setTimeout(() => { hint.hidden = true; }, 2600);
}

const Toolbar = {
  render() {
    const bar = $('#toolbar');
    if (!bar || !App.p) return;
    bar.textContent = '';
    const tool = (ic, label, fn, cls = '') => h('button', { class: `tool ${cls}`, onClick: () => { buzz(); fn(); } }, h('span', { html: icon(ic) }), label);
    const s = App.sel;
    const it = selected();
    if (!s || !it) {
      bar.append(
        tool('plus', 'Add clips', addClips),
        tool('music', 'Music', () => Sheets.music()),
        tool('text', 'Text', () => Sheets.addText()),
        tool('captions', 'Captions', () => Sheets.captions()),
        tool('sparkle', 'Effects', () => Sheets.effects(null)),
        tool('filter', 'Filters', () => Sheets.filters(null)),
        tool('wand', 'AutoCut', () => Sheets.autocut()),
        tool('canvas', 'Format', () => Sheets.format()),
      );
      return;
    }
    bar.append(tool('back', '', () => select(null), 'back'), h('span', { class: 'sep' }));
    if (s.kind === 'clip') {
      const m = Media.get(it.mediaId);
      bar.append(
        tool('split', 'Split', () => Edit.split()),
        m && m.kind === 'video' ? tool('speed', 'Speed', () => Sheets.speed(it)) : null,
        m && m.kind === 'video' ? tool('volume', 'Volume', () => Sheets.volume(it)) : null,
        tool('filter', 'Filters', () => Sheets.filters(it)),
        tool('sparkle', 'Effects', () => Sheets.effects(it)),
        tool('transition', 'Transition', () => Sheets.transition(App.p.clips.indexOf(it) || 1)),
        tool('reset', 'Reset fit', () => { commit(); delete it.zoom; delete it.x; delete it.y; delete it.rot; changed(); }),
        tool('left', 'Move left', () => Edit.move(it, -1)),
        tool('right', 'Move right', () => Edit.move(it, 1)),
        tool('copy', 'Duplicate', () => Edit.duplicate()),
        tool('trash', 'Delete', () => Edit.remove(), 'danger'),
      );
    } else if (s.kind === 'text') {
      bar.append(
        tool('edit', 'Edit', () => Sheets.text(it)),
        tool('sparkle', 'Animate', () => Sheets.text(it, 'anim')),
        tool('split', 'Split', () => Edit.split()),
        tool('copy', 'Duplicate', () => Edit.duplicate()),
        tool('trash', 'Delete', () => Edit.remove(), 'danger'),
      );
    } else if (s.kind === 'audio') {
      bar.append(
        tool('volume', 'Volume', () => Sheets.volume(it)),
        tool('fade', 'Fade', () => Sheets.fade(it)),
        tool('beat', 'Beats', () => Sheets.beats(it)),
        tool('split', 'Split', () => Edit.split()),
        tool('copy', 'Duplicate', () => Edit.duplicate()),
        tool('trash', 'Delete', () => Edit.remove(), 'danger'),
      );
    } else if (s.kind === 'fx') {
      bar.append(
        tool('sparkle', 'Change', () => Sheets.effects(null, it)),
        tool('split', 'Split', () => Edit.split()),
        tool('copy', 'Duplicate', () => Edit.duplicate()),
        tool('trash', 'Delete', () => Edit.remove(), 'danger'),
      );
    }
  },
};

// ---------- editing commands
const Edit = {
  split() {
    const p = App.p;
    const t = App.player.t;
    const s = App.sel;
    commit();
    if (!s || s.kind === 'clip') {
      const on = clipsAt(p, t);
      const hit = s ? on.find((x) => x.clip.id === s.id) || on[on.length - 1] : on[on.length - 1];
      if (!hit || hit.u < 0.1 || clipLen(hit.clip) - hit.u < 0.1) { History.past.pop(); toast('Move the playhead into the middle of a clip to split it'); return; }
      const a = hit.clip;
      const b = { ...JSON.parse(JSON.stringify(a)), id: uid('c'), in: hit.src };
      delete b.transition; delete b.transitionType;
      a.out = hit.src;
      p.clips.splice(hit.i + 1, 0, b);
      select('clip', b.id);
    } else {
      const it = selected();
      const local = t - it.start;
      const len = s.kind === 'audio' ? it.out - it.in : it.dur;
      if (local < 0.1 || len - local < 0.1) { History.past.pop(); toast('Move the playhead over it to split it there'); return; }
      const b = { ...JSON.parse(JSON.stringify(it)), id: uid('x'), start: t };
      if (s.kind === 'audio') { b.in = it.in + local; it.out = it.in + local; it.fadeOut = 0; b.fadeIn = 0; } else { b.dur = it.dur - local; it.dur = local; }
      const list = { text: p.texts, audio: p.audio, fx: p.effects }[s.kind];
      list.push(b);
      select(s.kind, b.id);
    }
    changed();
    buzz(15);
  },
  remove() {
    const p = App.p;
    const s = App.sel;
    if (!s) return;
    commit();
    const list = { clip: p.clips, text: p.texts, audio: p.audio, fx: p.effects }[s.kind];
    const i = list.findIndex((x) => x.id === s.id);
    if (i >= 0) list.splice(i, 1);
    if (s.kind === 'clip' && p.clips[0]) { delete p.clips[0].transition; delete p.clips[0].transitionType; }
    select(null);
    changed();
  },
  duplicate() {
    const p = App.p;
    const s = App.sel;
    const it = selected();
    if (!it) return;
    commit();
    const b = { ...JSON.parse(JSON.stringify(it)), id: uid('x') };
    if (s.kind === 'clip') { p.clips.splice(p.clips.indexOf(it) + 1, 0, b); } else {
      const len = s.kind === 'audio' ? it.out - it.in : it.dur;
      b.start = it.start + len;
      ({ text: p.texts, audio: p.audio, fx: p.effects })[s.kind].push(b);
    }
    select(s.kind, b.id);
    changed();
  },
  move(c, dir) {
    const p = App.p;
    const i = p.clips.indexOf(c);
    const j = i + dir;
    if (j < 0 || j >= p.clips.length) return;
    commit();
    p.clips.splice(i, 1);
    p.clips.splice(j, 0, c);
    if (p.clips[0]) { delete p.clips[0].transition; delete p.clips[0].transitionType; }
    changed();
    App.player.seek(clipStarts(p)[j] + 0.01);
  },
};

// ---------- touch on the preview: move, zoom and turn the selected clip or text
(function stageGestures() {
  const el = $('.stage-wrap');
  const pts = new Map();
  let start = null;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const ang = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
  el.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    el.setPointerCapture(e.pointerId);
    const it = selected();
    const canvas = $('.preview-canvas');
    start = { moved: false, it: it ? JSON.parse(JSON.stringify(it)) : null, pts: new Map([...pts].map(([k, v]) => [k, { ...v }])), rect: canvas ? canvas.getBoundingClientRect() : null, snapped: false };
  });
  el.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !start) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const it = selected();
    const s = App.sel;
    if (!it || !start.it || !start.rect || !s || (s.kind !== 'clip' && s.kind !== 'text')) return;
    const P = [...pts.values()];
    const S = [...start.pts.values()];
    if (!S.length) return;
    const moved = Math.hypot(P[0].x - S[0].x, P[0].y - S[0].y);
    if (!start.moved && moved < 6 && P.length < 2) return;
    if (!start.moved) { start.moved = true; commit(); App.player.pause(); }
    const R = start.rect;
    if (s.kind === 'clip') {
      if (P.length >= 2 && S.length >= 2) {
        const k = dist(P[0], P[1]) / Math.max(10, dist(S[0], S[1]));
        it.zoom = clamp((start.it.zoom || 1) * k, 0.2, 6);
        it.rot = Math.round(((start.it.rot || 0) + ((ang(P[0], P[1]) - ang(S[0], S[1])) * 180) / Math.PI) * 10) / 10;
        if (Math.abs(it.rot % 90) < 3) it.rot = Math.round(it.rot / 90) * 90; // settles on straight
      } else {
        it.x = (start.it.x || 0) + (P[0].x - S[0].x) / R.width;
        it.y = (start.it.y || 0) + (P[0].y - S[0].y) / R.height;
        if (Math.abs(it.x) < 0.015) it.x = 0;
        if (Math.abs(it.y) < 0.015) it.y = 0;
      }
    } else if (s.kind === 'text') {
      if (P.length >= 2 && S.length >= 2) {
        it.size = clamp((start.it.size || 6) * (dist(P[0], P[1]) / Math.max(10, dist(S[0], S[1]))), 2, 20);
      } else {
        it.offsetY = clamp((start.it.offsetY || 0) + (P[0].y - S[0].y) / R.height, -0.9, 0.9);
      }
    }
    changed({ timeline: false });
  });
  const end = (e) => {
    pts.delete(e.pointerId);
    if (!pts.size) {
      if (start && !start.moved && App.p) App.player.toggle();
      start = null;
    } else if (start) {
      start.pts = new Map([...pts].map(([k, v]) => [k, { ...v }]));
      const it = selected();
      if (it) start.it = JSON.parse(JSON.stringify(it));
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}());

// ---------- wiring
function hydrateIcons(root = document) {
  for (const i of $$('i[data-icon]', root)) { i.outerHTML = icon(i.dataset.icon, i.closest('.play-btn') ? 26 : 22); }
}

$('#play').addEventListener('click', () => { App.player.toggle(); updateTime(App.player.t); });
$('#undo').addEventListener('click', () => { const p = History.undo(App.p); if (p) { App.p = p; App.player.setProject(p); select(null); changed(); } });
$('#redo').addEventListener('click', () => { const p = History.redo(App.p); if (p) { App.p = p; App.player.setProject(p); select(null); changed(); } });
$('#edBack').addEventListener('click', goHome);
$('#edExport').addEventListener('click', () => Sheets.exportSheet());
$('#edAspect').addEventListener('click', () => Sheets.format());
$('#edName').addEventListener('click', () => Sheets.rename());
$('#homeAutoCut').addEventListener('click', () => Sheets.autocut(true));

// The phone's back button: close what's open, then go home, then leave.
(function backButton() {
  const AppPlugin = nativePlugin('App');
  if (!AppPlugin) return;
  AppPlugin.addListener('backButton', () => {
    if (!$('#busy').hidden) return;
    if (!$('#sheet').hidden) { closeSheet(); return; }
    if (App.sel) { select(null); return; }
    if (!$('#editor').hidden) { goHome(); return; }
    AppPlugin.exitApp();
  });
}());

(async function start() {
  hydrateIcons();
  const t0 = performance.now();
  await renderHome();
  $('#home').hidden = false;
  const wait = Math.max(0, 1800 - (performance.now() - t0));
  setTimeout(() => { $('#splash').classList.add('gone'); setTimeout(() => $('#splash').remove(), 400); }, wait);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}());
