'use strict';
// Small helpers used everywhere in the phone app.

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = (p = 'x') => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

// h('div', { class: 'x', onClick() {} }, child, 'text', [more]) → element
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
}

// 0:07, 1:05, or 0:07.4 with tenths
function fmt(t, tenths = false) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const ss = tenths ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  return `${m}:${ss}`;
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); setTimeout(() => { el.hidden = true; }, 250); }, ms);
}

const buzz = (ms = 8) => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch { /* none */ } };

// A Capacitor plugin when running as the Android app, or null in a browser.
function nativePlugin(name) {
  const C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return null;
  try { return C.registerPlugin ? C.registerPlugin(name) : (C.Plugins && C.Plugins[name]) || null; } catch { return null; }
}

// Icons (simple line drawings, 24×24).
const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" stroke="none"/>',
  undo: '<path d="M9 7H5V3"/><path d="M5 7a8 8 0 1 1-1 7"/>',
  redo: '<path d="M15 7h4V3"/><path d="M19 7a8 8 0 1 0 1 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  split: '<path d="M12 3v18"/><path d="M5 8l-3 4 3 4M19 8l3 4-3 4"/>',
  speed: '<path d="M12 21a9 9 0 1 1 9-9"/><path d="M12 12l5-4"/>',
  volume: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  filter: '<circle cx="9" cy="10" r="5"/><circle cx="15" cy="10" r="5"/><circle cx="12" cy="15" r="5"/>',
  wand: '<path d="M4 20L16 8M14 4v3M18 6h3M19 10v3M11 3h2"/><path d="M15 7l2 2"/>',
  captions: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 12h4M13 12h4M7 15h7"/>',
  canvas: '<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M3 8h3M18 16h3"/>',
  transition: '<path d="M4 6h7v12H4zM13 6h7v12h-7z"/><path d="M11 12h2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  fade: '<path d="M3 18h18"/><path d="M3 18L9 6l6 12"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  share: '<path d="M12 3v13M7 8l5-5 5 5"/><path d="M5 13v7h14v-7"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 8"/>',
  left: '<path d="M14 6l-6 6 6 6"/>',
  right: '<path d="M10 6l6 6-6 6"/>',
  reset: '<path d="M4 12a8 8 0 1 0 3-6.3"/><path d="M4 4v5h5"/>',
  beat: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/>',
};
function icon(name, size = 22) {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}
