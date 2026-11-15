const { app, BrowserWindow, ipcMain, dialog, shell, Menu, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { cleanSegments, cleanWords, groupWords, splitSegment } = require('./caption-timing');
const { cutoutImage, cutoutVideo } = require('./cutout');
const { detectBeats } = require('./beats');
const fun = require('./fun-audio-video');
const smartCut = require('./smart-cut');
const reframe = require('./reframe');
const plans = require('./src/plans');
const effects = require('./src/effects');
const tts = require('./tts');
const soundPack = require('./sound-pack');
const tracker = require('./tracker');
const { kfExpr, kfMax, hasMotion, migrateMotion } = require('./src/keyframes');
const crypto = require('crypto');

// Packaged builds keep the binaries outside the asar archive.
const unpacked = (p) => p.replace('app.asar', 'app.asar.unpacked');
const components = require('./components');

// FFmpeg and FFprobe: from the npm packages when running from the project folder, or downloaded
// once after installing (the installer leaves them out to stay small). See components.js.
function bundledTool(tool) {
  try {
    const p = unpacked(tool === 'ffmpeg' ? require('ffmpeg-static') : require('ffprobe-static').path);
    return p && fs.existsSync(p) ? p : null;
  } catch { return null; }
}
const componentsDir = () => path.join(app.getPath('userData'), 'components');
let FFMPEG = bundledTool('ffmpeg');
let FFPROBE = bundledTool('ffprobe');
function useDownloadedTools() {
  if (FFMPEG && FFPROBE) return true;
  if (!components.installed(componentsDir())) return false;
  const p = components.toolPaths(componentsDir());
  FFMPEG = FFMPEG || p.ffmpeg;
  FFPROBE = FFPROBE || p.ffprobe;
  return true;
}

let win;
let isDirty = false;

// ---------- loading screen
// A small window with the logo shows straight away. The editor loads hidden behind it and
// appears once both it's ready and the animation has played (1.8 s, so a quick start still
// gets the whole animation; a slow one keeps the logo up until the editor is ready).
const SPLASH_MS = 1800;
let splash = null;
let splashShownAt = 0;

function createSplash() {
  splash = new BrowserWindow({
    width: 460,
    height: 340,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    center: true,
    show: false,
    backgroundColor: '#00000000',
    title: 'Snippy',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splash.loadFile(path.join(__dirname, 'src', 'splash.html'));
  splash.once('ready-to-show', () => {
    if (!splash || splash.isDestroyed()) return;
    if (win && !win.isDestroyed() && win.isVisible()) { splash.destroy(); return; } // the editor beat it
    splash.show();
    splashShownAt = Date.now();
    if (editorWaiting) revealEditor();
  });
  // If the loading screen itself can't start, the editor doesn't wait for it.
  setTimeout(() => { if (!splashShownAt && editorWaiting) { if (splash && !splash.isDestroyed()) splash.destroy(); revealEditor(); } }, 1500);
  splash.on('closed', () => { splash = null; });
}

// Shows the editor once the animation has finished, then lets the loading screen fade away.
let editorWaiting = false;
function revealEditor() {
  if (!win || win.isDestroyed() || win.isVisible()) return;
  // The editor was quicker than the loading screen: wait for it, so the animation still plays.
  if (splash && !splash.isDestroyed() && !splashShownAt) { editorWaiting = true; return; }
  editorWaiting = false;
  const wait = splash && splashShownAt ? Math.max(0, SPLASH_MS - (Date.now() - splashShownAt)) : 0;
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    win.show();
    win.focus();
    const s = splash;
    if (!s || s.isDestroyed()) return;
    s.webContents.executeJavaScript("document.body.classList.add('leaving')").catch(() => {});
    setTimeout(() => { if (!s.isDestroyed()) s.destroy(); }, 200);
  }, wait);
}

function createWindow() {
  win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 880,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#1A1D23',
    title: 'Snippy',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', revealEditor);
  // If something holds up the first paint, don't keep the editor hidden for long.
  setTimeout(revealEditor, 8000);
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (!isDirty) { clearRecovery(); return; }
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Close without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have unsaved changes',
      detail: 'Press Ctrl+S to save your project first if you want to keep your edits.',
    });
    if (choice === 1) e.preventDefault();
    else clearRecovery(); // you chose to discard, so don't offer it back next time
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
  createSplash();
  createWindow();
  setupUpdates();
});

// ---------- updates for the installed app (GitHub Releases, via electron-updater)
// Only in the installed app, and only once release settings exist (see README). Otherwise quiet.

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { /* not installed yet: no auto-updates */ }
let updateState = { state: app.isPackaged && autoUpdater ? 'idle' : 'off' };

function sendUpdate(s) {
  updateState = s;
  if (win && !win.isDestroyed()) win.webContents.send('update:status', s);
}

function setupUpdates() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => sendUpdate({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => sendUpdate({ state: 'current' }));
  autoUpdater.on('update-available', (info) => sendUpdate({ state: 'downloading', version: info.version, progress: 0 }));
  autoUpdater.on('download-progress', (p) => sendUpdate({ ...updateState, state: 'downloading', progress: p.percent / 100 }));
  autoUpdater.on('update-downloaded', (info) => sendUpdate({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => sendUpdate({ state: 'error', message: String(err && err.message ? err.message : err).split('\n')[0] }));
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 4000);
}

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:state', () => updateState);
ipcMain.handle('update:check', async () => {
  if (!autoUpdater || !app.isPackaged) return { state: 'off' };
  try { await autoUpdater.checkForUpdates(); } catch { /* reported through the error event */ }
  return updateState;
});
ipcMain.handle('update:install', () => { if (autoUpdater) autoUpdater.quitAndInstall(); });
app.on('window-all-closed', () => app.quit());

// ---------- helpers

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    const out = [];
    let err = '';
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(lastLines(err) || `exited with code ${code}`));
    });
  });
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function writeFileSafe(p, text) {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, p);
}

// atempo only accepts 0.5–2, so bigger changes are chained.
function atempoChain(s) {
  const parts = [];
  while (s > 2) { parts.push(2); s /= 2; }
  while (s < 0.5) { parts.push(0.5); s /= 0.5; }
  parts.push(s);
  return parts.map((p) => `atempo=${p.toFixed(5)}`).join(',');
}

// Colour looks arrive as the same list of CSS filter steps the preview uses
// (e.g. [['sepia', 0.4], ['contrast', 1.1]]). Each step becomes the matrix the
// CSS Filter Effects spec defines, applied in order, so export matches preview.
function stepMatrix([fn, v]) {
  const I = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
  if (fn === 'brightness') return [[v, 0, 0, 0], [0, v, 0, 0], [0, 0, v, 0]];
  if (fn === 'contrast') { const o = 0.5 - 0.5 * v; return [[v, 0, 0, o], [0, v, 0, o], [0, 0, v, o]]; }
  if (fn === 'saturate') {
    return [
      [0.213 + 0.787 * v, 0.715 - 0.715 * v, 0.072 - 0.072 * v, 0],
      [0.213 - 0.213 * v, 0.715 + 0.285 * v, 0.072 - 0.072 * v, 0],
      [0.213 - 0.213 * v, 0.715 - 0.715 * v, 0.072 + 0.928 * v, 0],
    ];
  }
  if (fn === 'grayscale') {
    const g = 1 - v;
    return [
      [0.2126 + 0.7874 * g, 0.7152 - 0.7152 * g, 0.0722 - 0.0722 * g, 0],
      [0.2126 - 0.2126 * g, 0.7152 + 0.2848 * g, 0.0722 - 0.0722 * g, 0],
      [0.2126 - 0.2126 * g, 0.7152 - 0.7152 * g, 0.0722 + 0.9278 * g, 0],
    ];
  }
  if (fn === 'sepia') {
    const g = 1 - v;
    return [
      [0.393 + 0.607 * g, 0.769 - 0.769 * g, 0.189 - 0.189 * g, 0],
      [0.349 - 0.349 * g, 0.686 + 0.314 * g, 0.168 - 0.168 * g, 0],
      [0.272 - 0.272 * g, 0.534 - 0.534 * g, 0.131 + 0.869 * g, 0],
    ];
  }
  return I;
}

// A tone curve as FFmpeg's curves filter: 17 points sampled from the same curve the preview uses.
function curvesFilter(ys, enable = '') {
  if (!ys || plans.isFlatCurve(ys)) return '';
  const pts = plans.curveSamples(ys, 17).map((y, k) => `${(k / 16).toFixed(4)}/${y.toFixed(4)}`).join(' ');
  return `format=rgba,curves=m='${pts}'${enable},`;
}

// A colour look-up table (.cube). The file is copied into the job's folder so it can be named
// without a path; "mix" blends the graded picture with the original.
let lutCount = 0;
// Touch up (skin smoothing): a blurred copy laid over with "lighten" (in RGB, as the preview does),
// so small dark marks fill in from the skin around them while edges stay; then a touch brighter.
function touchFilter(t, i) {
  if (!t || !(t.sigma > 0)) return '';
  const b = Number(t.bright || 1).toFixed(3);
  return `format=gbrp,split[tua${i}][tub${i}];[tub${i}]gblur=sigma=${t.sigma}[tuc${i}];` +
    `[tua${i}][tuc${i}]blend=all_mode=lighten:all_opacity=${Number(t.op).toFixed(3)},colorchannelmixer=rr=${b}:gg=${b}:bb=${b},format=yuv420p,`;
}

function lutFilter(lut, tmpDir, tag) {
  if (!lut || !lut.path || !fs.existsSync(lut.path)) return '';
  const name = `lut${lutCount++}.cube`;
  fs.copyFileSync(lut.path, path.join(tmpDir, name));
  const mix = lut.mix == null ? 1 : lut.mix;
  if (mix >= 0.999) return `format=gbrp,lut3d=file=${name}:interp=tetrahedral,`;
  return `format=gbrp,split[${tag}a][${tag}b];[${tag}b]lut3d=file=${name}:interp=tetrahedral[${tag}l];[${tag}l][${tag}a]blend=all_mode=normal:all_opacity=${mix.toFixed(3)},`;
}

function colorFilters(steps) {
  const active = (steps || []).filter(([fn, v]) => (fn === 'grayscale' || fn === 'sepia') ? v > 0 : v !== 1);
  if (!active.length) return '';
  const mixers = active.map((st) => {
    const m = stepMatrix(st);
    const k = ['r', 'g', 'b'];
    // With RGBA input the alpha channel is 1, so the "a" column works as an offset.
    return 'colorchannelmixer=' + k.flatMap((row, i) =>
      ['r', 'g', 'b', 'a'].map((col, j) => `${row}${col}=${m[i][j].toFixed(5)}`)).join(':');
  });
  return `format=rgba,${mixers.join(',')},`;
}

// Video effects. Time-based ones use the clip's own time (t), with the same
// formulas the preview uses, so a shake or flicker moves the same way in both.
function fxFilters(fx, W, H) {
  const k = H / 1080;
  const R = Math.max(1, Math.round(3 * k));
  const zoom = (f) => `scale=trunc(iw*${f}/2)*2:trunc(ih*${f}/2)*2`;
  switch (fx) {
    case 'grain':
      return ',noise=alls=14:allf=t+u';
    case 'vhs': {
      const per = Math.max(3, Math.round(4 * k));
      return `,rgbashift=rh=-${R}:bh=${R},eq=saturation=1.35:contrast=1.08,gblur=sigma=${(0.8 * k).toFixed(2)},` +
        `noise=alls=7:allf=t,drawgrid=w=iw:h=${per}:t=${Math.max(1, Math.round(per / 3))}:c=black@0.22`;
    }
    case 'oldfilm':
      return ",hue=s=0,eq=brightness='0.045*sin(t*47)+0.03*sin(t*29.3)-0.02':eval=frame,noise=alls=16:allf=t+u,vignette=angle=PI/4.5";
    case 'glitch':
      // A short burst of sideways jitter every 1.7 seconds, with colour fringes throughout.
      return `,rgbashift=rh=-${2 * R}:bh=${2 * R},${zoom(1.04)},crop=${W}:${H}:` +
        `x='(iw-ow)/2+if(lt(mod(t,1.7),0.15),${(0.02 * W).toFixed(1)}*sin(t*90),0)':y='(ih-oh)/2',setsar=1`; // the zoom nudges pixel shape; clips must match to be joined
    case 'shake':
      return `,${zoom(1.06)},crop=${W}:${H}:` +
        `x='(iw-ow)/2+${H}*(0.011*sin(t*37)+0.0075*sin(t*23.3))':y='(ih-oh)/2+${H}*(0.009*sin(t*29.1)+0.0055*sin(t*41.7))',setsar=1`;
    default:
      return '';
  }
}

// Transition styles. Each overlaps the two clips with one of FFmpeg's xfade types;
// the camera moves add a short effect over the moment of the cut (on the joined video).
const XFADE = {
  cross: () => 'fade', flash: () => 'fadewhite', blur: () => 'hblur', pixelate: () => 'pixelize',
  wipe: (d) => `wipe${d}`, softwipe: (d) => `smooth${d}`, push: (d) => `slide${d}`,
  circleopen: () => 'circleopen', circleclose: () => 'circleclose', clock: () => 'radial',
  whip: (d) => `slide${d === 'right' ? 'right' : 'left'}`, zoom: () => 'zoomin', spin: () => 'fade',
  squeeze: () => 'squeezeh', glitch: () => 'fade', shake: () => 'fade', slices: () => 'hlslice',
};

// Smooth 0→1 between a and b, written out for FFmpeg expressions (no ; allowed inside a filter graph).
const ffSmooth = (a, b) => {
  const q = `clip((t-${a.toFixed(3)})/${(b - a).toFixed(3)},0,1)`;
  return `(${q}*${q}*(3-2*${q}))`;
};

// Extra effect over [a, b] seconds of the joined video, for the styles that need one.
// Returns filter graph lines that turn `src` into `dst`.
function cutMomentFx(style, src, dst, a, b, W, H, n) {
  const win = `enable='between(t,${a.toFixed(3)},${b.toFixed(3)})'`;
  const zoomed = (f) => `scale=trunc(iw*${f}/2)*2:trunc(ih*${f}/2)*2`;
  if (style === 'whip') {
    return [`[${src}]avgblur=sizeX=${Math.max(2, Math.round(W * 0.03))}:sizeY=1:${win}[${dst}]`];
  }
  if (style === 'spin') {
    return [
      `[${src}]split[${n}a][${n}b]`,
      `[${n}b]rotate=a='2*PI*${ffSmooth(a, b)}':c=black,${zoomed(1.35)},crop=${W}:${H},setsar=1[${n}c]`,
      `[${n}a][${n}c]overlay=0:0:${win}[${dst}]`,
    ];
  }
  if (style === 'glitch') {
    const R = Math.max(2, Math.round(W * 0.012));
    return [
      `[${src}]split[${n}a][${n}b]`,
      `[${n}b]rgbashift=rh=-${R}:bh=${R},noise=alls=30:allf=t,${zoomed(1.04)},crop=${W}:${H}:x='(iw-ow)/2+${(0.03 * W).toFixed(1)}*sin(t*97)':y='(ih-oh)/2',setsar=1[${n}c]`,
      `[${n}a][${n}c]overlay=0:0:${win}[${dst}]`,
    ];
  }
  if (style === 'shake') {
    const decay = `(1-clip((t-${a.toFixed(3)})/${(b - a).toFixed(3)},0,1))`;
    return [
      `[${src}]split[${n}a][${n}b]`,
      `[${n}b]${zoomed(1.08)},crop=${W}:${H}:x='(iw-ow)/2+${decay}*${(0.03 * H).toFixed(1)}*sin(t*61)':y='(ih-oh)/2+${decay}*${(0.022 * H).toFixed(1)}*sin(t*53)',setsar=1[${n}c]`,
      `[${n}a][${n}c]overlay=0:0:${win}[${dst}]`,
    ];
  }
  return null;
}

// FFmpeg's colorkey: pixels within `similarity` of the key colour become see-through,
// fading over `blend`. The preview uses the same formula.
function keyFilter(key) {
  if (!key) return '';
  return `colorkey=0x${key.color.replace('#', '')}:${key.similarity.toFixed(3)}:${key.blend.toFixed(3)},`;
}

// Size, position and turn of the main video (fixed, or keyframed over the clip's own time t).
// The canvas-sized frame is turned (with see-through corners), resized, then placed over black
// at its offset. The preview does the same with a CSS transform on the video.
function transformFilter(m, W, H, tag) {
  if (!m) return '';
  migrateMotion(m);
  const keyed = Boolean(m.keys && m.keys.length);
  const still = (p, d) => !keyed && Math.abs((m[p] ?? d) - d) < 1e-4;
  const flip = `${m.flipH ? ',hflip' : ''}${m.flipV ? ',vflip' : ''}`;
  if (still('zoom', 1) && still('posX', 0) && still('posY', 0) && still('rotate', 0)) return flip;
  const Z = kfExpr(m, 'zoom', 't');
  const X = kfExpr(m, 'posX', 't');
  const Y = kfExpr(m, 'posY', 't');
  const turns = !still('rotate', 0);
  // Quick way for the usual case (zoomed in, not turned, no black edges showing): enlarge, then crop.
  // Every keyframe inside those limits keeps the whole move inside them, as the limits form a convex shape.
  const states = [m, ...(m.keys || [])].map((k) => ({ z: k.zoom ?? m.zoom ?? 1, x: k.posX ?? m.posX ?? 0, y: k.posY ?? m.posY ?? 0 }));
  if (!turns && states.every((v) => v.z >= 1 && Math.abs(v.x) <= (v.z - 1) / 2 + 1e-6 && Math.abs(v.y) <= (v.z - 1) / 2 + 1e-6)) {
    const ZW = `(trunc(${W}*(${Z})/2)*2)`;
    const ZH = `(trunc(${H}*(${Z})/2)*2)`;
    return `${flip},scale=w='${ZW}':h='${ZH}':eval=frame,` +
      `crop=${W}:${H}:x='clip((${ZW}-${W})/2-(${X})*${W},0,${ZW}-${W})':y='clip((${ZH}-${H})/2-(${Y})*${H},0,${ZH}-${H})',setsar=1`;
  }
  const R = turns ? `,rotate=a='(${kfExpr(m, 'rotate', 't')})*PI/180':ow='hypot(iw,ih)':oh=ow:c=black@0` : '';
  return `${flip},split[${tag}a][${tag}b];[${tag}b]drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill[${tag}bg];` +
    `[${tag}a]format=rgba${R},scale=w='max(2,trunc(iw*(${Z})/2)*2)':h='max(2,trunc(ih*(${Z})/2)*2)':eval=frame[${tag}fg];` +
    `[${tag}bg][${tag}fg]overlay=x='(W-w)/2+(${X})*W':y='(H-h)/2+(${Y})*H':eval=frame,format=yuv420p,setsar=1`;
}

// ---------- graphics card encoding
// Placeholders in the export's arguments, filled in for each attempt.
const HWDEC = '\u0000hwdec';
const VENC = '\u0000venc';

const HW_CANDIDATES = [
  { id: 'nvidia', name: 'NVIDIA graphics', encoder: 'h264_nvenc' },
  { id: 'intel', name: 'Intel graphics', encoder: 'h264_qsv' },
  { id: 'amd', name: 'AMD graphics', encoder: 'h264_amf' },
  { id: 'apple', name: 'Apple graphics', encoder: 'h264_videotoolbox' },
];
let hwCache = null;
// The graphics card encoders that actually work on this computer (each is tried on a tiny clip:
// FFmpeg lists them all, whether or not the card and driver are there).
function hwEncoders() {
  if (!hwCache) {
    hwCache = (async () => {
      let list = '';
      try { list = String(await run(FFMPEG, ['-hide_banner', '-encoders'])); } catch { return []; }
      const ok = [];
      for (const c of HW_CANDIDATES) {
        if (!new RegExp(`\\s${c.encoder}\\s`).test(list)) continue;
        try {
          await run(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=0.3', '-pix_fmt', 'yuv420p', '-c:v', c.encoder, '-f', 'null', '-']);
          ok.push(c);
        } catch { /* listed, but no card or driver for it */ }
      }
      return ok;
    })();
  }
  return hwCache;
}

// Encoder settings at about the same quality as the normal encoder's crf.
function encoderArgs(card, crf, gif) {
  if (!card) return ['-c:v', 'libx264', '-preset', gif ? 'veryfast' : 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p'];
  const q = String(Math.round(crf + 1));
  switch (card.id) {
    case 'nvidia': return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', q, '-b:v', '0', '-pix_fmt', 'yuv420p'];
    case 'intel': return ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', q, '-pix_fmt', 'nv12'];
    case 'amd': return ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', q, '-qp_p', String(Math.round(crf + 3)), '-pix_fmt', 'yuv420p'];
    case 'apple': return ['-c:v', 'h264_videotoolbox', '-q:v', String(Math.max(20, Math.min(90, Math.round(110 - crf * 2.5)))), '-pix_fmt', 'yuv420p'];
    default: return ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p'];
  }
}

// Where a combined clip (several clips rendered into one) is kept: with the app's own files, so
// it's still there when the project is opened again.
ipcMain.handle('compound:path', () => {
  const dir = path.join(app.getPath('userData'), 'combined');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `combined-${Date.now()}.mp4`);
});

ipcMain.handle('encoders:hw', async () => (await hwEncoders()).map(({ id, name }) => ({ id, name })));

// Blend modes for overlays: FFmpeg's name, and the colour that leaves the picture under it unchanged.
const BLEND_MODES = {
  screen: { ff: 'screen', neutral: 'black' },
  add: { ff: 'addition', neutral: 'black' },
  lighten: { ff: 'lighten', neutral: 'black' },
  difference: { ff: 'difference', neutral: 'black' },
  multiply: { ff: 'multiply', neutral: 'white' },
  darken: { ff: 'darken', neutral: 'white' },
  overlay: { ff: 'overlay', neutral: '0x808080' },
  softlight: { ff: 'softlight', neutral: '0x808080' },
};

// Crop: covers the trimmed edges of the picture (shares of its width and height) with black.
function cropFilter(cr) {
  if (!cr) return '';
  const box = (x, y, w, h) => `drawbox=x='${x}':y='${y}':w='${w}':h='${h}':color=black:t=fill,`;
  let f = '';
  if (cr.l > 0) f += box(0, 0, `iw*${cr.l.toFixed(4)}`, 'ih');
  if (cr.r > 0) f += box(`iw*${(1 - cr.r).toFixed(4)}`, 0, `iw*${cr.r.toFixed(4)}+1`, 'ih');
  if (cr.t > 0) f += box(0, 0, 'iw', `ih*${cr.t.toFixed(4)}`);
  if (cr.b > 0) f += box(0, `ih*${(1 - cr.b).toFixed(4)}`, 'iw', `ih*${cr.b.toFixed(4)}+1`);
  return f;
}

function fadeFilters(name, len, fin, fout) {
  let f = '';
  if (fin > 0) f += `,${name}=t=in:st=0:d=${fin.toFixed(3)}`;
  if (fout > 0) f += `,${name}=t=out:st=${Math.max(0, len - fout).toFixed(3)}:d=${fout.toFixed(3)}`;
  return f;
}

function lastLines(text, n = 3) {
  return text.trim().split(/\r?\n/).slice(-n).join('\n');
}

// Escape a path for use inside a single-quoted FFmpeg filter option.
function esc(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");
}

function findFont() {
  const candidates = [
    'C:/Windows/Fonts/segoeuib.ttf',
    'C:/Windows/Fonts/arialbd.ttf',
    'C:/Windows/Fonts/arial.ttf',
  ];
  return candidates.find((f) => fs.existsSync(f)) || null;
}

async function thumbnail(file, duration) {
  // Seeking a single-image file gives no frame, so photos (duration 0) skip it.
  const seek = duration > 0 ? ['-ss', Math.min(1, duration / 2).toFixed(2)] : [];
  try {
    const buf = await run(FFMPEG, [
      '-v', 'error', ...seek, '-i', file, '-frames:v', '1',
      '-vf', 'scale=240:-2,format=yuvj420p', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '5', 'pipe:1',
    ]);
    if (!buf.length) return null;
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

async function waveform(file) {
  try {
    const buf = await run(FFMPEG, [
      '-v', 'error', '-i', file,
      '-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=1200x120:colors=0x8FD3A8',
      '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
    ]);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

// ---------- dialogs

ipcMain.handle('dialog:import', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Import media',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Video, audio and photos', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus', 'jpg', 'jpeg', 'png', 'webp', 'bmp'] },
      { name: 'Photos', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] },
      { name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'] },
      { name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'] },
    ],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('dialog:export', async (_e, format = 'mp4') => {
  const gif = format === 'gif';
  const r = await dialog.showSaveDialog(win, {
    title: gif ? 'Export GIF' : 'Export video',
    defaultPath: path.join(app.getPath('videos'), gif ? 'My clip.gif' : 'My video.mp4'),
    filters: [gif ? { name: 'Animated GIF', extensions: ['gif'] } : { name: 'MP4 video', extensions: ['mp4'] }],
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('shell:show', (_e, p) => shell.showItemInFolder(p));

// ---------- media

const IMAGE_EXT = /\.(jpe?g|png|webp|bmp)$/i;
// Photos have no length of their own. This is how far a photo clip can be stretched.
const IMAGE_MAX = 3600;

ipcMain.handle('media:probe', async (_e, filePath) => {
  if (IMAGE_EXT.test(filePath)) {
    const raw = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', filePath]);
    const v = (JSON.parse(raw.toString()).streams || []).find((s) => s.codec_type === 'video');
    if (!v) throw new Error('Not an image');
    return {
      path: filePath, url: pathToFileURL(filePath).href, name: path.basename(filePath),
      kind: 'image', duration: IMAGE_MAX, width: v.width, height: v.height,
      hasVideo: true, hasAudio: false, thumb: await thumbnail(filePath, 0),
    };
  }
  const raw = await run(FFPROBE, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath,
  ]);
  const info = JSON.parse(raw.toString());
  const streams = info.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = streams.find((s) => s.codec_type === 'audio');
  const duration = parseFloat(info.format && info.format.duration) || parseFloat(v && v.duration) || 0;
  return {
    path: filePath,
    url: pathToFileURL(filePath).href,
    name: path.basename(filePath),
    duration,
    width: v ? v.width : 0,
    height: v ? v.height : 0,
    kind: v ? 'video' : 'audio',
    vcodec: v ? v.codec_name : null,
    // A see-through video (from background removal). Its alpha needs the libvpx decoder on export.
    vpxAlpha: v && /^vp[89]$/.test(v.codec_name) && v.tags && (v.tags.alpha_mode === '1' || v.tags.ALPHA_MODE === '1')
      ? (v.codec_name === 'vp9' ? 'libvpx-vp9' : 'libvpx') : null,
    hasVideo: Boolean(v) && duration > 0,
    hasAudio: Boolean(a) && duration > 0,
    thumb: v ? await thumbnail(filePath, duration) : a ? await waveform(filePath) : null,
  };
});

// ---------- export

let exportJob = null;

ipcMain.handle('export:start', async (event, project, outPath) => {
  if (exportJob) throw new Error('An export is already running.');
  const { width: W, height: H, fps, total, clips, texts } = project;
  const audioItems = project.audio || [];
  const afmt = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snippy-'));
  // Reversed and boomerang clips are made first, at full size, then used like ordinary clips.
  for (let k = 0; k < clips.length; k++) {
    const c = clips[k];
    if (!c.mode && !c.stab) continue;
    const out = path.join(tmp, `derived${k}.mp4`);
    if (!event.sender.isDestroyed()) event.sender.send('export:progress', 0);
    await fun.makeDerived({ ffmpeg: FFMPEG, src: c.path, a: c.in, b: c.out, mode: c.mode, stab: c.stab, height: H, crf: 16, gop: 0, hasAudio: c.hasAudio, out });
    const len = (c.out - c.in) * (c.mode === 'boomerang' ? 2 : 1);
    const real = parseFloat((await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out])).toString()) || len;
    Object.assign(c, { path: out, in: 0, out: Math.min(len, real), isImage: false });
  }
  const args = ['-y', '-hide_banner'];
  const graph = [];

  // A mask on the clip: the picture shows through the mask's frames (white), and outside it is
  // black, dimmed or blurred (the same amounts as the preview).
  const maskInputs = [];
  const maskFilter = (mk, i) => {
    if (!mk || !mk.frames || !mk.frames.length) return '';
    const names = mk.images.map((url, k) => {
      const name = `cmask${i}_${k}.png`;
      fs.writeFileSync(path.join(tmp, name), Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
      return name;
    });
    const list = ['ffconcat version 1.0'];
    for (const f of mk.frames) list.push(`file '${names[f.img]}'`, `duration ${f.dur.toFixed(6)}`);
    list.push(`file '${names[mk.frames[mk.frames.length - 1].img]}'`);
    fs.writeFileSync(path.join(tmp, `cmask${i}.ffconcat`), list.join('\n'));
    // Inputs are numbered in order and the clips, music and overlays count on theirs, so the
    // mask inputs go on the end and their numbers are filled in once everything else is added.
    maskInputs.push(i);
    const idx = `@CMASK${i}@`;
    const outside = mk.outside === 'blur' ? `gblur=sigma=${mk.sigma}`
      : mk.outside === 'dim' ? `format=gbrp,colorchannelmixer=rr=${mk.dim}:gg=${mk.dim}:bb=${mk.dim},format=yuv420p`
        : 'drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill';
    return `,split[cma${i}][cmb${i}];[cmb${i}]${outside}[cmo${i}];[${idx}:v]fps=${fps},format=gray,scale=${W}:${H}[cmm${i}];` +
      `[cma${i}]format=rgba[cmr${i}];[cmr${i}][cmm${i}]alphamerge[cmk${i}];[cmo${i}][cmk${i}]overlay=0:0:eof_action=pass,format=yuv420p`;
  };
  clips.forEach((c, i) => {
    // A photo becomes a video by repeating it for as long as the clip needs.
    if (c.isImage) args.push('-loop', '1', '-framerate', String(fps), '-t', (c.out + 1).toFixed(3), '-i', c.path);
    else args.push(HWDEC, '-i', c.path);
    const a = c.in.toFixed(3);
    const b = c.out.toFixed(3);
    const sp = c.speed || 1;
    const len = (c.out - c.in) / sp;
    const d = len.toFixed(3);
    const vf = fadeFilters('fade', len, c.fadeIn || 0, c.fadeOut || 0);
    const af = fadeFilters('afade', len, c.fadeIn || 0, c.fadeOut || 0);
    // A speed curve maps source time to timeline time with an exact expression.
    const ramp = c.ramp && !c.isImage ? plans.rampSegs(c.ramp, c.out - c.in) : null;
    let timing = ramp ? `setpts=PTS-STARTPTS,setpts='(${plans.rampExpr(ramp)})/TB'` : `setpts=(PTS-STARTPTS)/${sp}`;
    // Smooth slow motion: where a clip plays at half speed or slower, the missing in-between frames
    // are made by following the motion (at half size, which is several times quicker and looks the same
    // in motion), instead of showing each frame two or three times.
    const slowest = ramp ? Math.min(...c.ramp) : sp;
    if (!c.isImage && slowest <= 0.5 && project.smoothSlow !== false) {
      timing += `,scale=${Math.round(W / 4) * 2}:${Math.round(H / 4) * 2}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=obmc:me_mode=bidir:me=epzs`;
    }
    graph.push(
      `[${i}:v:0]trim=start=${a}:end=${b},${timing},` +
      `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,${touchFilter(c.touch, i)}${cropFilter(c.crop)}${lutFilter(c.lut, tmp, `cl${i}`)}${colorFilters(c.color)}${curvesFilter(c.curve)}` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},settb=AVTB,format=yuv420p${maskFilter(c.mask, i)}${transformFilter(c.motion, W, H, `tf${i}`)}${fxFilters(c.fx, W, H)}${effects.ffChain(c.fx, W, H, { k: c.fxK ?? undefined, dur: len, beats: c.fxBeats, tag: `ce${i}`, fps })}${vf}${c.blank ? ',drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill' : ''}[v${i}]`
    );
    const vol = (c.volume == null ? 1 : c.volume).toFixed(3);
    // Sound can't change speed smoothly in FFmpeg, so a speed curve's sound is cut into short
    // pieces, each played at that piece's own average speed.
    let aIn = `[${i}:a:0]atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS,${sp !== 1 ? `${atempoChain(sp)},` : ''}`;
    if (ramp && c.hasAudio) {
      const L = c.out - c.in;
      const N = Math.max(1, Math.min(160, Math.ceil(L / 0.2)));
      const outs = [];
      graph.push(`[${i}:a:0]atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS,asplit=${N}${Array.from({ length: N }, (_, k) => `[rs${i}_${k}]`).join('')}`);
      for (let k = 0; k < N; k++) {
        const ta = (L * k) / N;
        const tb = (L * (k + 1)) / N;
        const tempo = (tb - ta) / Math.max(1e-6, plans.rampTimeAt(ramp, tb) - plans.rampTimeAt(ramp, ta));
        graph.push(`[rs${i}_${k}]atrim=start=${ta.toFixed(4)}:end=${tb.toFixed(4)},asetpts=PTS-STARTPTS,${atempoChain(tempo)}[rc${i}_${k}]`);
        outs.push(`[rc${i}_${k}]`);
      }
      graph.push(`${outs.join('')}concat=n=${N}:v=0:a=1[rr${i}]`);
      aIn = `[rr${i}]`;
    }
    graph.push(
      c.hasAudio
        ? `${aIn}${afmt},${c.voice && fun.VOICE_FILTERS[c.voice] ? `${fun.VOICE_FILTERS[c.voice]},${afmt},` : ''}${c.denoise ? 'highpass=f=80,afftdn=nf=-25,' : ''}volume=${vol}${af},apad,atrim=duration=${d}[a${i}]`
        : `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${d},${afmt}[a${i}]`
    );
  });
  // Join the clips one at a time: a crossfade overlaps a clip with the one before,
  // every other cut simply butts them together.
  let vCur = 'v0';
  let aCur = 'a0';
  let joined = (clips[0].out - clips[0].in) / (clips[0].speed || 1);
  for (let i = 1; i < clips.length; i++) {
    const c = clips[i];
    const len = (c.out - c.in) / (c.speed || 1);
    const x = c.crossIn || 0;
    if (x > 0) {
      const style = XFADE[c.xStyle] ? c.xStyle : 'cross';
      const off = joined - x;
      graph.push(`[${vCur}][v${i}]xfade=transition=${XFADE[style](c.xDir || 'left')}:duration=${x.toFixed(3)}:offset=${off.toFixed(3)}[jx${i}]`);
      // Shake cut overlaps only briefly; its shake runs for the transition's full length after the cut.
      const fx = cutMomentFx(style, `jx${i}`, `jv${i}`, off, style === 'shake' ? off + (c.xLen || 0.5) : off + x, W, H, `m${i}`);
      if (fx) graph.push(...fx);
      else graph.push(`[jx${i}]null[jv${i}]`);
      graph.push(`[${aCur}][a${i}]acrossfade=d=${x.toFixed(3)}:c1=tri:c2=tri[ja${i}]`);
      joined += len - x;
    } else {
      graph.push(`[${vCur}][v${i}]concat=n=2:v=1:a=0[jv${i}]`);
      graph.push(`[${aCur}][a${i}]concat=n=2:v=0:a=1[ja${i}]`);
      joined += len;
    }
    vCur = `jv${i}`;
    aCur = `ja${i}`;
  }
  // Effects on the timeline: the stretch they cover gets the effect, laid back over the video.
  (project.effects || []).forEach((e, j) => {
    const chain = effects.ffChain(e.id, W, H, { k: e.k, dur: e.dur, beats: e.beats, tag: `te${j}`, fps });
    if (!chain) return;
    const a = e.start.toFixed(3);
    const b = (e.start + e.dur).toFixed(3);
    graph.push(`[${vCur}]split[tea${j}][teb${j}]`,
      `[teb${j}]trim=start=${a}:end=${b},setpts=PTS-STARTPTS${chain},setpts=PTS+${a}/TB[tec${j}]`,
      `[tea${j}][tec${j}]overlay=eof_action=pass:enable='between(t,${a},${b})',format=yuv420p[teo${j}]`);
    vCur = `teo${j}`;
  });
  graph.push(`[${vCur}]null[cv]`, `[${aCur}]anull[ca]`);

  // Music and other audio-track items are mixed over the clips' own sound.
  let audioOut = 'ca';
  if (audioItems.length) {
    const mixInputs = ['[ca]'];
    audioItems.forEach((m, j) => {
      const idx = clips.length + j;
      args.push('-i', m.path);
      const len = m.out - m.in;
      const voice = m.voice && fun.VOICE_FILTERS[m.voice] ? `${fun.VOICE_FILTERS[m.voice]},${afmt},` : '';
      let chain = `[${idx}:a:0]atrim=start=${m.in.toFixed(3)}:end=${m.out.toFixed(3)},asetpts=PTS-STARTPTS,${afmt},${voice}${m.keys && m.keys.length ? `volume='${kfExpr(m, 'volume', 't')}':eval=frame` : `volume=${m.volume.toFixed(3)}`}`;
      if (m.fadeIn > 0) chain += `,afade=t=in:st=0:d=${m.fadeIn.toFixed(3)}`;
      if (m.fadeOut > 0) chain += `,afade=t=out:st=${Math.max(0, len - m.fadeOut).toFixed(3)}:d=${m.fadeOut.toFixed(3)}`;
      chain += `,adelay=delays=${Math.round(m.start * 1000)}:all=1`;
      // Auto-ducking: timed volume changes worked out by the editor (the same curve it plays).
      if (m.duck && m.duck.length) {
        const cmdFile = path.join(tmp, `duck${j}.cmd`);
        fs.writeFileSync(cmdFile, m.duck.map(([t, g]) => `${t.toFixed(3)} volume@duck${j} volume ${g.toFixed(4)};`).join('\n'));
        chain += `,asendcmd=f='${esc(cmdFile)}',volume@duck${j}=volume=${m.duck[0][1].toFixed(4)}`;
      }
      chain += `[m${j}]`;
      graph.push(chain);
      mixInputs.push(`[m${j}]`);
    });
    graph.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0:normalize=0[amix]`);
    audioOut = 'amix';
  }
  // Even out loudness to the level social sites play at (-14 LUFS).
  if (project.loudnorm) {
    graph.push(`[${audioOut}]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aloud]`);
    audioOut = 'aloud';
  }

  // Overlays (picture-in-picture videos and photos) sit above the main video and below text.
  let videoOut = 'cv';
  (project.overlays || []).forEach((o, j) => {
    const idx = clips.length + audioItems.length + j;
    if (o.isImage) args.push('-loop', '1', '-framerate', String(fps), '-t', (o.out + 1).toFixed(3), '-i', o.path);
    else if (o.vpxAlpha) args.push('-c:v', o.vpxAlpha, '-i', o.path); // keeps the see-through background
    else args.push(HWDEC, '-i', o.path);
    const end = o.start + (o.out - o.in);
    let timing = `trim=start=${o.in.toFixed(3)}:end=${o.out.toFixed(3)},setpts=PTS-STARTPTS+${o.start.toFixed(3)}/TB`;
    const enable = `enable='between(t,${o.start.toFixed(3)},${end.toFixed(3)})'`;
    // A crop to a box shape (for split screens and masks) and a mask shape. The mask is
    // drawn by the editor (the same picture the preview uses) and multiplied into any
    // see-through areas the overlay already has, before it's sized.
    let shaped = `${idx}:v:0`;
    if (o.cell || o.mask) {
      const A = o.cell || 0;
      const crop = A ? `crop=w='min(iw,ih*${A.toFixed(5)})':h='min(ih,iw/${A.toFixed(5)})':x='(iw-ow)*${(o.cropX ?? 0.5).toFixed(3)}':y='(ih-oh)*${(o.cropY ?? 0.5).toFixed(3)}',` : '';
      const MW = 512;
      const MH = Math.max(2, Math.round((MW * (o.ar || 0.5625)) / 2) * 2);
      const base = `[${idx}:v:0]trim=start=${o.in.toFixed(3)}:end=${o.out.toFixed(3)},setpts=PTS-STARTPTS,${crop}scale=${MW}:${MH},setsar=1,${keyFilter(o.key)}${colorFilters(o.color)}${curvesFilter(o.curve)}format=rgba`;
      if (o.mask) {
        const name = `mask${j}.png`;
        fs.writeFileSync(path.join(tmp, name), Buffer.from(o.mask.slice(o.mask.indexOf(',') + 1), 'base64'));
        // One still frame; blend repeats it for every frame of the overlay.
        graph.push(`${base},split[ob${j}][oc${j}]`, `[oc${j}]alphaextract[oal${j}]`,
          `movie=${name},format=gray,scale=${MW}:${MH}[omk${j}]`, `[oal${j}][omk${j}]blend=all_mode=multiply[oam${j}]`,
          `[ob${j}][oam${j}]alphamerge,setpts=PTS+${o.start.toFixed(3)}/TB[os${j}]`);
      } else {
        graph.push(`${base},setpts=PTS+${o.start.toFixed(3)}/TB[os${j}]`);
      }
      shaped = `os${j}`;
      timing = 'null';
      o.key = null; // already applied
      o.color = null;
    }
    // A blend mode (screen, multiply…) mixes the overlay with what's under it. FFmpeg's blend needs two
    // whole frames, so the overlay is placed on a plain frame of a colour that leaves the picture
    // unchanged for that mode (black for screen, white for multiply, mid grey for overlay), then blended.
    const place = (pos) => {
      const mode = BLEND_MODES[o.blend];
      if (!mode) { graph.push(`[${videoOut}][o${j}]overlay=${pos}:eof_action=pass:${enable}[ov${j}]`); return; }
      graph.push(`color=c=${mode.neutral}:s=${W}x${H}:r=${fps}:d=${(total + 1).toFixed(3)},format=rgba[nb${j}]`);
      graph.push(`[nb${j}][o${j}]overlay=${pos}:eof_action=pass:${enable},format=gbrp[nl${j}]`);
      graph.push(`[${videoOut}]format=gbrp[bv${j}]`);
      graph.push(`[bv${j}][nl${j}]blend=all_mode=${mode.ff}:shortest=0,format=yuv420p[ov${j}]`);
    };
    if (!hasMotion(o)) {
      const pw = Math.max(2, Math.round((o.w * W) / 2) * 2);
      graph.push(`[${shaped}]${timing},scale=${pw}:-2,${keyFilter(o.key)}${colorFilters(o.color)}${curvesFilter(o.curve)}format=rgba,colorchannelmixer=aa=${o.opacity.toFixed(3)}[o${j}]`);
      place(`x=${Math.round(o.x * W)}-w/2:y=${Math.round(o.y * H)}-h/2`);
    } else {
      // Keyframed: the size changes every frame, so it sits centred in a fixed box big
      // enough for its largest size, and the box moves along the keyframed path.
      const U = `(t-${o.start.toFixed(3)})`;
      const boxW = Math.ceil((kfMax(o, 'w') * W) / 2) * 2 + 4;
      const boxH = Math.ceil((kfMax(o, 'w') * W * (o.ar || 0.5625)) / 2) * 2 + 4;
      const ops = (o.keys || []).map((k) => k.opacity ?? o.opacity);
      const fade = ops.some((v) => Math.abs(v - ops[0]) > 1e-3)
        ? `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${kfExpr(o, 'opacity', `(T-${o.start.toFixed(3)})`)})'`
        : `colorchannelmixer=aa=${(ops[0] ?? o.opacity).toFixed(3)}`;
      graph.push(
        `[${shaped}]${timing},scale=w='max(2,trunc(${W}*(${kfExpr(o, 'w', U)})/2)*2)':h=-2:eval=frame,` +
        `${keyFilter(o.key)}${colorFilters(o.color)}${curvesFilter(o.curve)}format=rgba,` +
        `pad=${boxW}:${boxH}:x='(ow-iw)/2':y='(oh-ih)/2':color=black@0:eval=frame,` +
        `${fade}[o${j}]` // after the fixed-size box: geq keeps the size of the first frame it sees
      );
      place(`x='(${kfExpr(o, 'x', U)})*${W}-${boxW / 2}':y='(${kfExpr(o, 'y', U)})*${H}-${boxH / 2}'`);
    }
    videoOut = `ov${j}`;
  });

  // Adjustment layers: a look and a curve over everything underneath, for their stretch of time.
  (project.adjust || []).forEach((a, k) => {
    const en = `:enable='between(t,${a.start.toFixed(3)},${(a.start + a.dur).toFixed(3)})'`;
    const mixers = colorFilters(a.color).replace(/^format=rgba,/, '').split(',').filter(Boolean).map((f) => `${f}${en}`);
    const chain = [...mixers, curvesFilter(a.curve, en).replace(/^format=rgba,/, '').replace(/,$/, '')].filter(Boolean);
    if (!chain.length) return;
    graph.push(`[${videoOut}]format=rgba,${chain.join(',')},format=yuv420p[adj${k}]`);
    videoOut = `adj${k}`;
  });

  // Blur and pixelate boxes: the frame is blurred (or made blocky) as a whole, then let through
  // a mask the editor drew from the boxes (white where they are, soft at the edges).
  const nextInput = () => args.filter((a) => a === '-i').length;
  const playImages = (set, prefix) => {
    const names = set.images.map((url, k) => {
      const name = `${prefix}${k}.png`;
      fs.writeFileSync(path.join(tmp, name), Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
      return name;
    });
    const list = ['ffconcat version 1.0'];
    for (const f of set.frames) list.push(`file '${names[f.img]}'`, `duration ${f.dur.toFixed(6)}`);
    list.push(`file '${names[set.frames[set.frames.length - 1].img]}'`); // the concat format needs the last file twice
    const listPath = path.join(tmp, `${prefix}.ffconcat`);
    fs.writeFileSync(listPath, list.join('\n'));
    const idx = nextInput();
    args.push('-f', 'concat', '-safe', '0', '-i', listPath);
    return idx;
  };
  for (const [type, set] of Object.entries(project.fxMasks || {})) {
    if (!set || !set.frames || !set.frames.length) continue;
    const idx = playImages(set, `fx${type}`);
    const effect = type === 'pixel'
      ? `scale=${Math.max(2, Math.round(W / set.block))}:${Math.max(2, Math.round(H / set.block))}:flags=area,scale=${W}:${H}:flags=neighbor`
      : `gblur=sigma=${set.sigma}`;
    graph.push(`[${idx}:v]fps=${fps},format=gray,scale=${W}:${H}[fxm${type}]`);
    graph.push(`[${videoOut}]split[fxa${type}][fxb${type}]`);
    graph.push(`[fxb${type}]${effect},format=rgba[fxe${type}]`);
    graph.push(`[fxe${type}][fxm${type}]alphamerge[fxk${type}]`);
    graph.push(`[fxa${type}][fxk${type}]overlay=0:0:eof_action=pass,format=yuv420p[fxo${type}]`);
    videoOut = `fxo${type}`;
  }

  // Captions arrive already drawn (by the same code as the preview): a set of
  // transparent images and how long each is shown. They play as one input.
  let last = videoOut;
  const cap = project.captions;
  if (cap && cap.frames.length) {
    const names = cap.images.map((url, k) => {
      const name = `caption${k}.png`;
      fs.writeFileSync(path.join(tmp, name), Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
      return name;
    });
    const list = ['ffconcat version 1.0'];
    for (const f of cap.frames) list.push(`file '${names[f.img]}'`, `duration ${f.dur.toFixed(6)}`);
    list.push(`file '${names[cap.frames[cap.frames.length - 1].img]}'`); // the concat format needs the last file twice
    const listPath = path.join(tmp, 'captions.ffconcat');
    fs.writeFileSync(listPath, list.join('\n'));
    const idx = nextInput();
    args.push('-f', 'concat', '-safe', '0', '-i', listPath);
    graph.push(`[${idx}:v]fps=${fps},format=rgba[capv]`);
    graph.push(`[${last}][capv]overlay=0:0:eof_action=pass[capout]`);
    last = 'capout';
  }

  // A GIF is made in two steps: an MP4 of the edit first, then the GIF from that,
  // with a colour palette picked for this video (GIFs only have 256 colours).
  const gif = project.format === 'gif';
  const renderPath = gif ? path.join(tmp, 'for-gif.mp4') : outPath;
  const share = gif ? 0.8 : 1; // the MP4 step's part of the progress bar
  // The edit's filter graph goes in a file: with many clips, keyframes or tracked motion it can be far
  // longer than Windows allows on a command line (about 32,000 characters).
  let graphText = graph.join(';\n');
  for (const i of maskInputs) {
    graphText = graphText.split(`@CMASK${i}@`).join(String(nextInput()));
    args.push('-f', 'concat', '-safe', '0', '-i', path.join(tmp, `cmask${i}.ffconcat`));
  }
  fs.writeFileSync(path.join(tmp, 'graph.txt'), graphText);
  args.push(
    '-filter_complex_script', 'graph.txt',
    '-map', `[${last}]`, '-map', `[${audioOut}]`,
    VENC,
    '-c:a', 'aac', '-b:a', `${project.audioKbps || 192}k`, '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    renderPath
  );

  // Which encoders to try, in order: the graphics card (decoding and encoding, then encoding only),
  // then the normal encoder. If one fails (an old driver, a card that's busy), the next is used.
  const crf = gif ? 16 : project.crf || 20;
  const attempts = [];
  if (!gif && project.hw !== 'off') {
    const cards = await hwEncoders();
    const card = cards.find((c) => c.id === project.hw) || (project.hw === 'auto' || !project.hw ? cards[0] : null);
    if (card) {
      const videoInputs = args.filter((a) => a === HWDEC).length;
      if (videoInputs && videoInputs <= 8) attempts.push({ card, hwdec: true });
      attempts.push({ card, hwdec: false });
    }
  }
  attempts.push({ card: null, hwdec: false });
  const expand = (a) => args.flatMap((x) => {
    if (x === HWDEC) return a.hwdec ? ['-hwaccel', 'auto'] : [];
    if (x === VENC) {
      const cap = !gif && project.maxKbps ? ['-maxrate', `${project.maxKbps}k`, '-bufsize', `${project.maxKbps * 2}k`] : [];
      return [...encoderArgs(a.card, crf, gif), ...cap];
    }
    return [x];
  });

  const cmdLen = expand(attempts[attempts.length - 1]).reduce((n, x) => n + String(x).length + 3, FFMPEG.length);
  if (process.platform === 'win32' && cmdLen > 32000) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`This edit uses too many separate clips for Windows to pass to FFmpeg in one go (${args.filter((x) => x === '-i').length} inputs). Try joining some pieces, or export it in two parts.`);
  }

  // One run of FFmpeg (in the job's own folder, so masks and the graph file can be named without a path).
  const runOnce = (finalArgs) => new Promise((resolve) => {
    const proc = spawn(FFMPEG, finalArgs, { windowsHide: true, cwd: tmp });
    exportJob = { proc, cancelled: false };
    let stderr = '';
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
        if (m && total > 0 && !event.sender.isDestroyed()) event.sender.send('export:progress', share * Math.min(1, Number(m[1]) / 1e6 / total));
      }
    });
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    proc.on('error', (err) => resolve({ code: -1, stderr: err.message, cancelled: false }));
    proc.on('close', (code) => resolve({ code, stderr, cancelled: Boolean(exportJob && exportJob.cancelled) }));
  });

  const cleanup = () => {
    exportJob = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  try {
    let result = null;
    let used = null;
    for (let k = 0; k < attempts.length; k++) {
      const a = attempts[k];
      result = await runOnce(expand(a));
      if (result.cancelled) throw new Error('cancelled');
      if (result.code === 0) { used = a; break; }
      console.warn(`Export with ${a.card ? `${a.card.name}${a.hwdec ? ' (decoding too)' : ''}` : 'the normal encoder'} failed:`, lastLines(result.stderr, 3));
      fs.rmSync(renderPath, { force: true });
      if (k < attempts.length - 1 && !event.sender.isDestroyed()) event.sender.send('export:progress', 0);
    }
    if (!used) throw new Error(lastLines(result.stderr, 4) || `FFmpeg exited with code ${result.code}`);
    if (gif) {
      await makeGif(renderPath, outPath, (p) => { if (!event.sender.isDestroyed()) event.sender.send('export:progress', 0.8 + 0.2 * p); });
    }
    // A cover picture (from the thumbnail maker), stored in the MP4 so players and file
    // browsers show it. Copies the video as it is, so it only takes a moment.
    if (!gif && project.cover) {
      try {
        const img = path.join(tmp, 'cover.jpg');
        fs.writeFileSync(img, Buffer.from(project.cover.slice(project.cover.indexOf(',') + 1), 'base64'));
        const withCover = path.join(tmp, 'with-cover.mp4');
        await run(FFMPEG, ['-y', '-v', 'error', '-i', outPath, '-i', img, '-map', '0', '-map', '1', '-c', 'copy', '-c:v:1', 'mjpeg', '-disposition:v:1', 'attached_pic', '-movflags', '+faststart', withCover]);
        fs.copyFileSync(withCover, outPath);
      } catch (err) { console.warn('The cover picture could not be added:', err.message); }
    }
    const job = exportJob;
    if (job && job.cancelled) throw new Error('cancelled');
    cleanup();
    return { path: outPath, encoder: used.card ? used.card.name : null };
  } catch (err) {
    const cancelled = (exportJob && exportJob.cancelled) || err.message === 'cancelled';
    cleanup();
    fs.rmSync(outPath, { force: true });
    throw cancelled ? new Error('cancelled') : err;
  }
});

// The palette pass, then the GIF itself. Both can be cancelled through exportJob.
function makeGif(src, out, onProgress) {
  const pal = `${src}.palette.png`;
  const step = (args) => new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { windowsHide: true });
    exportJob = { proc: p, cancelled: exportJob ? exportJob.cancelled : false };
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(lastLines(err, 3) || `FFmpeg exited with code ${code}`))));
  });
  return step(['-y', '-v', 'error', '-i', src, '-vf', 'palettegen=stats_mode=diff:max_colors=256', pal])
    .then(() => { onProgress(0.4); return step(['-y', '-v', 'error', '-i', src, '-i', pal, '-lavfi', 'paletteuse=dither=sierra2_4a:diff_mode=rectangle', '-loop', '0', out]); })
    .then(() => { onProgress(1); return out; });
}

ipcMain.handle('export:cancel', () => {
  if (exportJob) {
    exportJob.cancelled = true;
    exportJob.proc.kill();
  }
});

// ---------- project files

// ---------- finding media files that have moved

ipcMain.handle('relink:pick', async (_e, name) => {
  const ext = path.extname(name).slice(1);
  const r = await dialog.showOpenDialog(win, {
    title: `Where is ${name}?`, properties: ['openFile'],
    filters: ext ? [{ name, extensions: [ext] }, { name: 'All files', extensions: ['*'] }] : [],
  });
  return r.canceled ? null : r.filePaths[0];
});

// Looks through a folder (and the folders inside it) for files with these names.
const SKIP_DIRS = new Set(['node_modules', '.git', '$recycle.bin', 'system volume information', 'windows', 'appdata', 'program files', 'program files (x86)']);
function findByName(root, names, limit = 200000) {
  const want = new Map(names.map((n) => [n.toLowerCase(), n]));
  const found = {};
  const queue = [root];
  let seen = 0;
  while (queue.length && seen < limit && Object.keys(found).length < want.size) {
    const dir = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      seen++;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.')) queue.push(path.join(dir, e.name));
      } else {
        const orig = want.get(e.name.toLowerCase());
        if (orig && !found[orig]) found[orig] = path.join(dir, e.name);
      }
    }
  }
  return found;
}

ipcMain.handle('relink:search', async (_e, names) => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder to search', properties: ['openDirectory'] });
  if (r.canceled) return null;
  return { folder: r.filePaths[0], found: findByName(r.filePaths[0], names) };
});

// Projects saved before the rename (.cutline) still open.
const PROJECT_FILTER = [{ name: 'Snippy project', extensions: ['snippy', 'cutline'] }];

ipcMain.handle('project:open', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open project', properties: ['openFile'], filters: PROJECT_FILTER });
  if (r.canceled) return null;
  const p = r.filePaths[0];
  return { path: p, text: fs.readFileSync(p, 'utf8') };
});

// A project double-clicked in Explorer arrives as a command-line argument.
ipcMain.handle('project:initial', () => {
  const p = process.argv.slice(1).find((a) => /\.(snippy|cutline)$/i.test(a) && fs.existsSync(a));
  return p ? { path: p, text: fs.readFileSync(p, 'utf8') } : null;
});

ipcMain.handle('project:save', (_e, p, text) => {
  writeFileSafe(p, text);
  return p;
});

ipcMain.handle('project:saveAs', async (_e, text) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Save project',
    defaultPath: path.join(app.getPath('documents'), 'My project.snippy'),
    filters: [{ name: 'Snippy project', extensions: ['snippy'] }],
  });
  if (r.canceled) return null;
  writeFileSafe(r.filePath, text);
  return r.filePath;
});

ipcMain.on('project:state', (_e, s) => {
  isDirty = Boolean(s.dirty);
  if (win && s.title) win.setTitle(s.title);
});

// ---------- auto captions (Whisper, running locally)

// The "timestamped" export of Whisper base can also report when each word is spoken.
const ASR_MODEL = 'onnx-community/whisper-base_timestamped';
let asrPipeline = null;
let captionsJob = null;

// ---------- the AI tools
// Bundled when running from the project folder (npm install). The installed app leaves them out to
// stay small and downloads them, once, the first time an AI feature is used (components.js).
const AI_ENTRY = {
  '@huggingface/transformers': 'node_modules/@huggingface/transformers/dist/transformers.node.mjs',
  'kokoro-js': 'node_modules/kokoro-js/dist/kokoro.js',
};
const aiDir = () => path.join(componentsDir(), 'ai');
function aiBundled() {
  try { require.resolve('@huggingface/transformers'); require.resolve('kokoro-js'); return true; } catch { return false; }
}
const aiReady = () => aiBundled() || components.packInstalled(componentsDir(), 'ai');

let aiDownload = null;
function ensureAi() {
  if (aiReady()) return Promise.resolve();
  if (!aiDownload) {
    const tell = (p) => { if (win && !win.isDestroyed()) win.webContents.send('components:progress', p); };
    const fetchFn = (url) => (net && net.fetch ? net.fetch : fetch)(url, { headers: { 'User-Agent': `Snippy/${app.getVersion()}` } });
    tell({ file: 'ai', done: 0, total: 0 });
    aiDownload = components.installPack({ dir: componentsDir(), name: 'ai', fetchFn, onProgress: tell })
      .then(() => tell({ file: 'ai', finished: true }))
      .catch((err) => { tell({ file: 'ai', failed: String(err.message || err) }); throw new Error(`Snippy's AI tools couldn't be downloaded: ${err.message || err}`); })
      .finally(() => { aiDownload = null; });
  }
  return aiDownload;
}

async function aiImport(name) {
  if (aiBundled()) return import(name);
  await ensureAi();
  return import(pathToFileURL(path.join(aiDir(), AI_ENTRY[name])).href);
}
ipcMain.handle('ai:status', () => ({ ready: aiReady(), bundled: aiBundled() }));
ipcMain.handle('ai:install', () => ensureAi().then(() => ({ ready: true })));

async function loadTransformers() {
  const T = await aiImport('@huggingface/transformers');
  // Models are cached in the user's app data folder (the install folder is read-only).
  T.env.cacheDir = path.join(app.getPath('userData'), 'models');
  T.env.allowLocalModels = false;
  return T;
}

// Reports one combined download percentage across a model's files.
function downloadProgress(send) {
  const files = {};
  return (p) => {
    if (p.status !== 'progress' || !p.total) return;
    files[p.file] = [p.loaded, p.total];
    const all = Object.values(files);
    send({ phase: 'download', progress: all.reduce((s, f) => s + f[0], 0) / all.reduce((s, f) => s + f[1], 0) });
  };
}

async function getAsr(send) {
  if (asrPipeline) return asrPipeline;
  send({ phase: 'loading' });
  const { pipeline } = await loadTransformers();
  asrPipeline = await pipeline('automatic-speech-recognition', ASR_MODEL, { dtype: 'q8', progress_callback: downloadProgress(send) });
  return asrPipeline;
}

async function extractAudio(file, start, duration) {
  const buf = await run(FFMPEG, [
    '-v', 'error', '-ss', start.toFixed(3), '-t', duration.toFixed(3), '-i', file,
    '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1',
  ]);
  const usable = buf.length - (buf.length % 4);
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + usable));
}

ipcMain.handle('captions:generate', async (event, clips, opts) => {
  if (captionsJob) throw new Error('Captions are already being generated.');
  captionsJob = { cancelled: false };
  const send = (p) => { if (!event.sender.isDestroyed()) event.sender.send('captions:progress', p); };
  try {
    const asr = await getAsr(send);
    const withAudio = clips.filter((c) => c.hasAudio);
    const out = [];
    for (let i = 0; i < withAudio.length; i++) {
      if (captionsJob.cancelled) throw new Error('cancelled');
      const c = withAudio[i];
      const dur = c.out - c.in;
      send({ phase: 'transcribe', index: i, count: withAudio.length, progress: i / withAudio.length });
      const audio = await extractAudio(c.path, c.in, dur);
      if (audio.length < 1600) continue; // under 0.1 s of sound
      const lang = opts.language ? { language: opts.language } : {};
      const sp = c.speed || 1; // timestamps are in source time
      // Pass 1: the whole clip, in 30-second chunks, gives sentences with start and end times.
      // 'translate' makes Whisper write English, whatever language is spoken.
      const task = opts.task === 'translate' ? 'translate' : 'transcribe';
      const res = await asr(audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true,
        task,
        ...lang,
      });
      const segments = cleanSegments(res.chunks && res.chunks.length ? res.chunks : [{ timestamp: [0, dur], text: res.text }], dur);
      // Pass 2: each sentence on its own, for word timings. Word timings from chunked
      // long audio are unreliable, so this pass only ever sees short stretches.
      for (let k = 0; k < segments.length; k++) {
        if (captionsJob.cancelled) throw new Error('cancelled');
        const seg = segments[k];
        send({ phase: 'align', index: i, count: withAudio.length, progress: (i + k / segments.length) / withAudio.length });
        let words = [];
        const a0 = Math.max(0, seg.start - 0.15);
        const a1 = Math.min(dur, seg.end + 0.15);
        if (a1 - a0 < 29) {
          try {
            const slice = audio.subarray(Math.floor(a0 * 16000), Math.ceil(a1 * 16000));
            const r = await asr(slice, { return_timestamps: 'word', task, ...lang });
            words = cleanWords(r.chunks, a0, dur);
          } catch (err) {
            console.warn('Word timing failed for one sentence:', err.message);
          }
        }
        const parts = words.length
          ? groupWords(words, opts.maxWords || 4)
          : splitSegment(seg, opts.maxWords || 4); // no word timings: share the time out by length
        for (const p of parts) {
          out.push({
            start: c.start + p.start / sp,
            end: c.start + p.end / sp,
            text: p.text,
            words: p.words ? p.words.map((w) => ({ text: w.text, s: w.s / sp, e: w.e / sp })) : undefined,
          });
        }
      }
    }
    send({ phase: 'transcribe', index: withAudio.length, count: withAudio.length, progress: 1 });
    return out;
  } finally {
    captionsJob = null;
  }
});

ipcMain.handle('captions:cancel', () => {
  if (captionsJob) captionsJob.cancelled = true;
});

// ---------- auto-save
// While there are unsaved changes, a copy is kept here. It survives a crash or a
// power cut, and Snippy offers it back the next time it starts.

const recoveryPath = () => path.join(app.getPath('userData'), 'recovery.snippy-autosave');

function clearRecovery() {
  try { fs.rmSync(recoveryPath(), { force: true }); } catch { /* nothing to clear */ }
}

ipcMain.handle('recovery:write', (_e, text) => writeFileSafe(recoveryPath(), text));
ipcMain.handle('recovery:clear', () => clearRecovery());
ipcMain.handle('recovery:read', () => {
  const p = recoveryPath();
  if (!fs.existsSync(p)) return null;
  return { text: fs.readFileSync(p, 'utf8'), savedAt: fs.statSync(p).mtimeMs };
});

// ---------- background removal (MODNet portrait matting, running locally)

const SEG_MODEL = 'Xenova/modnet';
let segmenter = null;
let cutoutJob = null;

async function getSegmenter(send) {
  if (segmenter) return segmenter;
  send({ phase: 'loading' });
  const T = await loadTransformers();
  const model = await T.AutoModel.from_pretrained(SEG_MODEL, { dtype: 'fp32', progress_callback: downloadProgress(send) });
  const processor = await T.AutoProcessor.from_pretrained(SEG_MODEL);
  segmenter = { T, model, processor };
  return segmenter;
}

// One frame of RGB in, a 0-255 mask of the person (same size) out.
async function personMask(rgb, w, h) {
  const { T, model, processor } = segmenter;
  const image = new T.RawImage(new Uint8ClampedArray(rgb.buffer, rgb.byteOffset, rgb.length), w, h, 3);
  const { pixel_values } = await processor(image);
  const { output } = await model({ input: pixel_values });
  const mask = await T.RawImage.fromTensor(output[0].mul(255).to('uint8')).resize(w, h);
  return mask.data;
}

ipcMain.handle('cutout:make', async (event, src, kind) => {
  if (cutoutJob) throw new Error('A background is already being removed.');
  const send = (p) => { if (!event.sender.isDestroyed()) event.sender.send('cutout:progress', p); };
  // Results are kept, named after the source file and its last change, so each clip is only done once.
  const st = fs.statSync(src);
  const key = crypto.createHash('sha1').update(`${src}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
  const dir = path.join(app.getPath('userData'), 'cutouts');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${path.parse(src).name}-${key}.${kind === 'image' ? 'png' : 'webm'}`);
  if (fs.existsSync(out)) return out;
  const tmp = `${out}.part${kind === 'image' ? '.png' : '.webm'}`;
  cutoutJob = { cancelled: false };
  try {
    await getSegmenter(send);
    send({ phase: 'cutout', progress: 0 });
    const opts = { ffmpeg: FFMPEG, ffprobe: FFPROBE, src, out: tmp, maskFor: personMask };
    if (kind === 'image') await cutoutImage(opts);
    else {
      await cutoutVideo({
        ...opts,
        onProgress: (p, i, n) => send({ phase: 'cutout', progress: p, index: i, count: n }),
        isCancelled: () => cutoutJob.cancelled,
      });
    }
    fs.renameSync(tmp, out);
    return out;
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  } finally {
    cutoutJob = null;
  }
});

ipcMain.handle('cutout:cancel', () => { if (cutoutJob) cutoutJob.cancelled = true; });

// ---------- beat finding

ipcMain.handle('beats:detect', async (_e, src, start, end) => {
  const audio = await extractAudio(src, start, end - start);
  const r = detectBeats(audio, 16000);
  return { bpm: r.bpm, beats: r.beats.map((b) => b + start), strength: r.strength || null }; // times in the source file
});

// ---------- audio levels (for auto-ducking and the level meter)
// Loudness every 50 ms through the whole file, as RMS on a 0 to 1 scale.

ipcMain.handle('audio:levels', async (_e, src) => {
  const buf = await run(FFMPEG, ['-v', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1']);
  const x = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  const hop = 400;
  const out = [];
  for (let i = 0; i + hop <= x.length; i += hop) {
    let s = 0;
    for (let j = i; j < i + hop; j++) s += x[j] * x[j];
    out.push(Math.round(Math.sqrt(s / hop) * 10000) / 10000);
  }
  return out;
});

// ---------- preview copies
// Big (over 1080p) or hard-to-play videos get a light 720p copy for the editor's
// preview. Exports always use the original file. Copies are kept between sessions.

function proxyPathFor(src) {
  const st = fs.statSync(src);
  const key = crypto.createHash('sha1').update(`${src}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
  const dir = path.join(app.getPath('userData'), 'previews');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${path.parse(src).name}-${key}.mp4`);
}

ipcMain.handle('proxy:find', (_e, src) => {
  try {
    const p = proxyPathFor(src);
    return fs.existsSync(p) ? { path: p, url: pathToFileURL(p).href } : null;
  } catch { return null; }
});

ipcMain.handle('proxy:make', (event, src, duration, id) => new Promise((resolve, reject) => {
  const out = proxyPathFor(src);
  if (fs.existsSync(out)) { resolve({ path: out, url: pathToFileURL(out).href }); return; }
  const tmp = `${out}.part.mp4`;
  const proc = spawn(FFMPEG, [
    '-y', '-v', 'error', '-i', src,
    // 720 pixels on the short side, never enlarged; a keyframe every half second so scrubbing is quick.
    '-vf', "scale='if(gt(iw,ih),-2,min(720,iw))':'if(gt(iw,ih),min(720,ih),-2)'",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-g', '15', '-keyint_min', '15',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats', tmp,
  ], { windowsHide: true });
  let err = '';
  let buf = '';
  proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  proc.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
      if (m && duration > 0 && !event.sender.isDestroyed()) event.sender.send('proxy:progress', { id, progress: Math.min(1, Number(m[1]) / 1e6 / duration) });
    }
  });
  proc.on('error', reject);
  proc.on('close', (code) => {
    if (code !== 0) { fs.rmSync(tmp, { force: true }); reject(new Error(lastLines(err) || `exit ${code}`)); return; }
    fs.renameSync(tmp, out);
    resolve({ path: out, url: pathToFileURL(out).href });
  });
}));

// ---------- voice effects, sound effects, reversed clips and freeze frames
// Results are kept in the app's folder, named after the source and its last change.

function cachePath(kind, src, extra, ext) {
  const st = fs.statSync(src);
  const key = crypto.createHash('sha1').update(`${src}|${st.size}|${st.mtimeMs}|${extra}`).digest('hex').slice(0, 16);
  const dir = path.join(app.getPath('userData'), kind);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${path.parse(src).name}-${key}.${ext}`);
}
const asFile = (p) => ({ path: p, url: pathToFileURL(p).href });

ipcMain.handle('voice:make', async (_e, src, fx) => {
  if (!fun.VOICE_FILTERS[fx]) throw new Error('Unknown voice effect');
  const out = cachePath('voices', src, fx, 'm4a');
  if (!fs.existsSync(out)) await fun.makeVoiceCopy(FFMPEG, src, fx, out);
  return asFile(out);
});

// Real recordings from the free sound pack first, then the simple sounds Snippy makes itself.
const packDir = () => path.join(app.getPath('userData'), 'sound-pack');
ipcMain.handle('sfx:list', () => [
  ...soundPack.packList(packDir()),
  ...Object.entries(fun.SOUND_EFFECTS).map(([id, s]) => ({ id, name: s.name, duration: s.d, group: 'Simple sounds', source: 'basic', ready: true })),
]);

// ---------- first-run downloads
ipcMain.handle('components:status', () => ({ ready: useDownloadedTools() }));

let componentsJob = null;
ipcMain.handle('components:install', async (event) => {
  if (useDownloadedTools()) return { ready: true };
  if (componentsJob) throw new Error('Already downloading.');
  componentsJob = { cancelled: false };
  const fetchFn = (url) => (net && net.fetch ? net.fetch : fetch)(url, { headers: { 'User-Agent': `Snippy/${app.getVersion()}` } });
  try {
    await components.installTools({
      dir: componentsDir(), fetchFn,
      onProgress: (p) => { if (!event.sender.isDestroyed()) event.sender.send('components:progress', p); },
      isCancelled: () => componentsJob.cancelled,
    });
    return { ready: useDownloadedTools() };
  } finally {
    componentsJob = null;
  }
});
ipcMain.handle('components:cancel', () => { if (componentsJob) componentsJob.cancelled = true; });

let packJob = null;
ipcMain.handle('pack:download', async (event) => {
  if (packJob) throw new Error('The sound pack is already downloading.');
  packJob = { cancelled: false };
  // Electron's own fetch uses the computer's proxy settings, like a browser would.
  const fetchFn = (url) => (net && net.fetch ? net.fetch : fetch)(url, { headers: { 'User-Agent': `Snippy/${app.getVersion ? app.getVersion() : ''}` } });
  try {
    return await soundPack.downloadPack({
      ffmpeg: FFMPEG, dir: packDir(), fetchFn,
      onProgress: (p) => { if (!event.sender.isDestroyed()) event.sender.send('pack:progress', p); },
      isCancelled: () => packJob.cancelled,
    });
  } finally {
    packJob = null;
  }
});
ipcMain.handle('pack:cancel', () => { if (packJob) packJob.cancelled = true; });

ipcMain.handle('sfx:make', async (_e, id) => {
  if (id.startsWith('p_')) {
    const spec = soundPack.PACK_SOUNDS.find((x) => x.id === id);
    const file = spec ? soundPack.packFile(packDir(), spec) : '';
    if (!fs.existsSync(file)) throw new Error('Download the sound pack first');
    return asFile(file);
  }
  const dir = path.join(app.getPath('userData'), 'sound-effects');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${fun.SOUND_EFFECTS[id] ? fun.SOUND_EFFECTS[id].name : id}.wav`);
  if (!fs.existsSync(out)) await fun.makeSoundEffect(FFMPEG, id, out);
  return asFile(out);
});

// Preview copies of reversed / boomerang clips: light 720p, quick to scrub.
ipcMain.handle('derived:make', async (event, src, a, b, mode, hasAudio, id, stab) => {
  const out = cachePath('reversed', src, `${mode}|${stab || ''}|${a.toFixed(3)}|${b.toFixed(3)}`, 'mp4');
  if (!fs.existsSync(out)) {
    const tmp = `${out}.part.mp4`;
    await fun.makeDerived({
      ffmpeg: FFMPEG, src, a, b, mode, stab, height: 720, crf: 26, gop: 15, hasAudio, out: tmp,
      onProgress: (p) => { if (!event.sender.isDestroyed()) event.sender.send('derived:progress', { id, progress: p }); },
    });
    fs.renameSync(tmp, out);
  }
  return asFile(out);
});

// ---------- translating captions (English into another language), with small local models

const TRANSLATE_TO = {
  es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', nl: 'Dutch', sv: 'Swedish',
  ru: 'Russian', uk: 'Ukrainian', ar: 'Arabic', hi: 'Hindi', zh: 'Chinese',
};
const translators = new Map();
let translateJob = null;
ipcMain.handle('translate:langs', () => TRANSLATE_TO);
ipcMain.handle('translate:run', async (event, texts, lang) => {
  if (!TRANSLATE_TO[lang]) throw new Error('That language isn\'t available');
  if (translateJob) throw new Error('Already translating');
  translateJob = { cancelled: false };
  const send = (p) => { if (!event.sender.isDestroyed()) event.sender.send('translate:progress', p); };
  try {
    let tr = translators.get(lang);
    if (!tr) {
      send({ phase: 'loading' });
      const T = await loadTransformers();
      let lastErr = null;
      // The same model is published under two names; try both.
      for (const repo of [`Xenova/opus-mt-en-${lang}`, `onnx-community/opus-mt-en-${lang}`]) {
        try { tr = await T.pipeline('translation', repo, { dtype: 'q8', progress_callback: downloadProgress(send) }); break; } catch (err) { lastErr = err; }
      }
      if (!tr) throw new Error(`The ${TRANSLATE_TO[lang]} translation model couldn't be downloaded (${lastErr ? lastErr.message : 'unknown error'})`);
      translators.set(lang, tr);
    }
    const out = [];
    for (let i = 0; i < texts.length; i++) {
      if (translateJob.cancelled) throw new Error('cancelled');
      send({ phase: 'translate', progress: i / texts.length });
      const t = texts[i].trim();
      if (!t) { out.push(''); continue; }
      const r = await tr(t, { max_new_tokens: 256 });
      out.push((Array.isArray(r) ? r[0].translation_text : r.translation_text) || t);
    }
    send({ phase: 'translate', progress: 1 });
    return out;
  } finally {
    translateJob = null;
  }
});
ipcMain.handle('translate:cancel', () => { if (translateJob) translateJob.cancelled = true; });

// ---------- loudness (EBU R128), for evening out clips

ipcMain.handle('loudness:measure', async (_e, src, a, b) => {
  const out = (await new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-nostats', '-ss', a.toFixed(3), '-t', Math.max(0.1, b - a).toFixed(3), '-i', src, '-vn', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', () => resolve(''));
    p.on('close', () => resolve(err)); // no sound to measure gives no reading, not an error
  }));
  const m = out.match(/Integrated loudness:\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/);
  return m && m[1] !== '-inf' ? Number(m[1]) : null;
});

// ---------- remove pauses

ipcMain.handle('silence:find', (_e, src, a, b, opts) => smartCut.findSilences(FFMPEG, src, a, b, opts));

// ---------- auto reframe (follows the person using the same model as background removal)

let reframeJob = null;
ipcMain.handle('reframe:track', async (event, src, a, b, srcW, srcH, id) => {
  if (reframeJob) throw new Error('Already reframing a clip.');
  reframeJob = { cancelled: false };
  const send = (p) => { if (!event.sender.isDestroyed()) event.sender.send('reframe:progress', { id, ...p }); };
  try {
    await getSegmenter(send);
    return await reframe.trackSubject({
      ffmpeg: FFMPEG, src, a, b, srcW, srcH, maskFor: personMask,
      onProgress: (p) => send({ phase: 'track', progress: p }),
      isCancelled: () => reframeJob.cancelled,
    });
  } finally {
    reframeJob = null;
  }
});
ipcMain.handle('reframe:cancel', () => { if (reframeJob) reframeJob.cancelled = true; });

// ---------- motion tracking (a box on the video, followed frame by frame)

let trackJob = null;
ipcMain.handle('track:run', async (event, src, a, b, box, srcW, srcH, id) => {
  if (trackJob) throw new Error('Already tracking');
  const job = { cancelled: false };
  trackJob = job;
  try {
    return await tracker.trackRegion({
      ffmpeg: FFMPEG, src, a, b, box, srcW, srcH,
      isCancelled: () => job.cancelled,
      onProgress: (p) => { if (!event.sender.isDestroyed()) event.sender.send('track:progress', { id, progress: p }); },
    });
  } finally {
    trackJob = null;
  }
});
ipcMain.handle('track:cancel', () => { if (trackJob) trackJob.cancelled = true; });

// ---------- text-to-speech voiceovers (Kokoro, running locally)

const TTS_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let ttsModel = null;
let ttsJob = null;

async function getTts(send) {
  if (ttsModel) return ttsModel;
  send({ phase: 'loading' });
  await loadTransformers(); // sets where models are kept
  let KokoroTTS;
  try {
    ({ KokoroTTS } = await aiImport('kokoro-js'));
  } catch (err) {
    if (/AI tools/.test(err.message)) throw err;
    throw new Error('The voice package is missing. Run "npm install" in the Snippy folder, then restart Snippy.');
  }
  ttsModel = await KokoroTTS.from_pretrained(TTS_MODEL, { dtype: 'q8', device: 'cpu', progress_callback: downloadProgress(send) });
  return ttsModel;
}

ipcMain.handle('tts:voices', () => tts.TTS_VOICES);

ipcMain.handle('tts:make', async (event, text, voice, speed, opts = {}) => {
  if (ttsJob) throw new Error('A voiceover is already being made.');
  ttsJob = { cancelled: false };
  const send = (p) => { if (!event.sender.isDestroyed()) event.sender.send('tts:progress', p); };
  try {
    const model = await getTts(send);
    send({ phase: 'speak', progress: 0 });
    const say = async (line) => {
      const out = await model.generate(line, { voice, speed });
      return { audio: out.audio || out.data, rate: out.sampling_rate || 24000 };
    };
    const res = await tts.speakScript(text, say, {
      onProgress: (p) => send({ phase: 'speak', progress: p }),
      isCancelled: () => ttsJob.cancelled,
    });
    if (opts.preview) {
      const dir = path.join(app.getPath('userData'), 'voice-samples');
      fs.mkdirSync(dir, { recursive: true });
      return asFile(tts.writeWav(path.join(dir, `${voice}-${Math.round((speed || 1) * 100)}.wav`), res.audio, res.rate));
    }
    // Voiceovers are kept with your documents, so they're easy to find and back up.
    const dir = path.join(app.getPath('documents'), 'Snippy', 'Voiceovers');
    fs.mkdirSync(dir, { recursive: true });
    const words = text.trim().split(/\s+/).slice(0, 5).join(' ').replace(/[^\w\s-]/g, '').trim() || 'Voiceover';
    let file = path.join(dir, `${words}.wav`);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${words} (${n}).wav`);
    tts.writeWav(file, res.audio, res.rate);
    // Captions to match, a few words each, timed from when each sentence is spoken.
    const captions = [];
    for (const line of res.lines) {
      for (const p of splitSegment({ start: line.start, end: line.end, text: line.text }, opts.maxWords || 5)) {
        captions.push({ start: p.start, end: p.end, text: p.text });
      }
    }
    return { ...asFile(file), duration: res.duration, captions };
  } finally {
    ttsJob = null;
  }
});
ipcMain.handle('tts:cancel', () => { if (ttsJob) ttsJob.cancelled = true; });

// ---------- music library: your own tracks, sorted into mood folders

const MOODS = ['Upbeat', 'Chill', 'Cinematic', 'Funny'];
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i;
const musicDir = () => path.join(app.getPath('documents'), 'Snippy', 'Music');
function ensureMusicDir() {
  const dir = musicDir();
  for (const m of MOODS) fs.mkdirSync(path.join(dir, m), { recursive: true });
  const readme = path.join(dir, 'About this folder.txt');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, 'Put music here and it shows up in Snippy\'s Music panel.\r\n'
      + 'Each folder is a mood. Make new folders for more moods.\r\n\r\n'
      + 'Only use music you\'re allowed to: your own, music marked CC0 (public domain),\r\n'
      + 'or tracks whose licence covers your video (some need you to credit the artist).\r\n');
  }
  return dir;
}
ipcMain.handle('music:list', () => {
  const dir = ensureMusicDir();
  const out = [];
  const walk = (d, mood, depth) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 2) walk(p, depth === 0 ? e.name : mood, depth + 1);
      else if (e.isFile() && AUDIO_EXT.test(e.name)) out.push({ path: p, url: pathToFileURL(p).href, name: e.name.replace(AUDIO_EXT, ''), mood });
    }
  };
  walk(dir, 'Other', 0);
  return { dir, moods: [...new Set([...MOODS, ...out.map((t) => t.mood)])], tracks: out.sort((x, y) => x.name.localeCompare(y.name)) };
});
ipcMain.handle('music:openFolder', () => shell.openPath(ensureMusicDir()));
ipcMain.handle('music:add', async (_e, mood) => {
  const r = await dialog.showOpenDialog(win, { title: `Add music to ${mood}`, properties: ['openFile', 'multiSelections'], filters: [{ name: 'Music', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'] }] });
  if (r.canceled) return 0;
  const dest = path.join(ensureMusicDir(), mood);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of r.filePaths) fs.copyFileSync(f, path.join(dest, path.basename(f)));
  return r.filePaths.length;
});

// ---------- auto edit: how lively each half-second of a video is (loudness + movement)

function ffmpegLog(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', () => resolve(err));
  });
}
// ---------- looking for things in the pictures (AutoCut's "what do you want" box)
// CLIP, a model that knows how well a picture fits a few words. Each clip is looked at once a
// second; what it sees is kept on disk, so asking for something else later is quick.
const CLIP_MODEL = 'Xenova/clip-vit-base-patch32';
const LOOK_SIZE = 224;
let clipKit = null;
let lookJob = null;

async function getClip(send) {
  if (clipKit) return clipKit;
  send({ phase: 'loading' });
  const T = await loadTransformers();
  const progress_callback = downloadProgress(send);
  const tokenizer = await T.AutoTokenizer.from_pretrained(CLIP_MODEL, { progress_callback });
  const processor = await T.AutoProcessor.from_pretrained(CLIP_MODEL, { progress_callback });
  const text = await T.CLIPTextModelWithProjection.from_pretrained(CLIP_MODEL, { dtype: 'q8', progress_callback });
  const vision = await T.CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL, { dtype: 'q8', progress_callback });
  clipKit = { T, tokenizer, processor, text, vision };
  return clipKit;
}

// Rows of a [n, d] tensor, each scaled to length 1 (so a dot product is the cosine similarity).
function unitRows(t) {
  const [n, d] = t.dims;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const r = Array.from(t.data.subarray(i * d, (i + 1) * d));
    const len = Math.hypot(...r) || 1;
    rows.push(r.map((v) => v / len));
  }
  return rows;
}

// Square RGB frames from a video, one every `step` seconds (or one for a photo).
async function* lookFrames(src, step, isImage, onProc) {
  const vf = `${isImage ? '' : `fps=1/${step},`}scale=${LOOK_SIZE}:${LOOK_SIZE}:force_original_aspect_ratio=increase,crop=${LOOK_SIZE}:${LOOK_SIZE},format=rgb24`;
  const p = spawn(FFMPEG, ['-v', 'error', '-i', src, '-vf', vf, ...(isImage ? ['-frames:v', '1'] : []), '-f', 'rawvideo', '-'], { windowsHide: true });
  if (onProc) onProc(p);
  const size = LOOK_SIZE * LOOK_SIZE * 3;
  let pending = Buffer.alloc(0);
  for await (const chunk of p.stdout) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= size) {
      yield new Uint8Array(pending.subarray(0, size));
      pending = pending.subarray(size);
    }
  }
}

// What each picture looks like to CLIP: one list of numbers per frame, kept on disk.
async function lookAt(item, kit, onFrame) {
  const step = item.isImage ? 1 : item.step;
  const file = cachePath('looks', item.path, `clip-v1-${step}`, 'json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not done yet */ }
  const embeds = [];
  let proc = null;
  try {
    for await (const rgb of lookFrames(item.path, step, item.isImage, (p) => { proc = p; })) {
      if (lookJob && lookJob.cancelled) throw new Error('cancelled');
      const image = new kit.T.RawImage(new Uint8ClampedArray(rgb.buffer, rgb.byteOffset, rgb.length), LOOK_SIZE, LOOK_SIZE, 3);
      const inputs = await kit.processor(image);
      const { image_embeds } = await kit.vision(inputs);
      embeds.push(unitRows(image_embeds)[0].map((v) => Math.round(v * 1e4) / 1e4));
      if (onFrame) onFrame(embeds.length);
    }
  } finally {
    if (proc && proc.exitCode === null) proc.kill();
  }
  try { fs.writeFileSync(file, JSON.stringify(embeds)); } catch { /* not kept */ }
  return embeds;
}

// items: [{ id, path, duration, isImage, step }], phrases: ['the dog', …].
// Returns { step, sims: { [id]: [ [similarity per frame] per phrase ] } }.
ipcMain.handle('match:look', async (event, items, phrases) => {
  if (lookJob) throw new Error('Already looking through clips.');
  lookJob = { cancelled: false };
  const send = (p) => { if (!event.sender.isDestroyed()) event.sender.send('match:progress', p); };
  try {
    const kit = await getClip(send);
    const ti = kit.tokenizer(phrases.map((p) => `a photo of ${p}`), { padding: true, truncation: true });
    const { text_embeds } = await kit.text(ti);
    const words = unitRows(text_embeds);
    const total = items.reduce((n, it) => n + (it.isImage ? 1 : Math.max(1, Math.ceil(it.duration / it.step))), 0);
    let done = 0;
    const sims = {};
    for (const it of items) {
      const before = done;
      const embeds = await lookAt(it, kit, (n) => send({ phase: 'look', progress: Math.min(1, (before + n) / total) }));
      done = before + (it.isImage ? 1 : Math.max(1, Math.ceil(it.duration / it.step)));
      send({ phase: 'look', progress: Math.min(1, done / total) });
      sims[it.id] = words.map((w) => embeds.map((e) => e.reduce((acc, v, k) => acc + v * w[k], 0)));
    }
    return { sims };
  } finally {
    lookJob = null;
  }
});
ipcMain.handle('match:cancel', () => { if (lookJob) lookJob.cancelled = true; });

ipcMain.handle('highlights:analyze', async (event, src, dur, hasAudio, id, opts) => {
  const step = 0.5;
  const n = Math.max(1, Math.ceil(dur / step));
  const send = (p) => { if (!event.sender.isDestroyed()) event.sender.send('highlights:progress', { id, progress: p }); };
  // Movement: how much each frame differs from the last, sampled twice a second on a tiny picture.
  send(0);
  const vlog = await ffmpegLog(['-hide_banner', '-nostats', '-i', src, '-an', '-vf', `fps=${1 / step},scale=64:36,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG`, '-f', 'null', '-']);
  const motion = [...vlog.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  send(0.6);
  // Loudness: the sound level of each half-second.
  let loud = [];
  if (hasAudio) {
    const alog = await ffmpegLog(['-hide_banner', '-nostats', '-i', src, '-vn', '-af', `aresample=16000,asetnsamples=${16000 * step},astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level`, '-f', 'null', '-']);
    loud = [...alog.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((m) => (m[1] === '-inf' ? -90 : Number(m[1])));
  }
  send(0.8);
  // Picture quality, for AutoCut to skip dark or blurry moments: brightness and blur (0 = sharp).
  let bright = [];
  let blur = [];
  if (opts && opts.quality) {
    try {
      const qlog = await ffmpegLog(['-hide_banner', '-nostats', '-i', src, '-an', '-vf', `fps=${1 / step},scale=480:-2,format=yuv420p,signalstats,blurdetect,metadata=print`, '-f', 'null', '-']);
      bright = [...qlog.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
      blur = [...qlog.matchAll(/lavfi\.blur=([\d.]+)/g)].map((m) => Number(m[1]));
    } catch { /* no quality check, just liveliness */ }
  }
  send(1);
  const fill = (a, d) => Array.from({ length: n }, (_, i) => a[i] ?? d);
  return { step, motion: fill(motion, 0), loud: fill(loud, -90), bright: bright.length ? fill(bright, 128) : null, blur: blur.length ? fill(blur, 0) : null };
});

// ---------- colour LUTs

ipcMain.handle('lut:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Load a colour LUT', properties: ['openFile'], filters: [{ name: 'Colour LUT', extensions: ['cube'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('lut:read', (_e, p) => {
  if (fs.statSync(p).size > 40 * 1024 * 1024) throw new Error('That LUT file is too big');
  return fs.readFileSync(p, 'utf8');
});

// ---------- animated stickers: your own GIFs, and Google's Noto animated emoji

ipcMain.handle('sticker:pickFile', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add a GIF or picture as a sticker', properties: ['openFile'],
    filters: [{ name: 'GIFs and pictures', extensions: ['gif', 'webp', 'png', 'apng'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

// The file's bytes, for the editor to decode frame by frame.
ipcMain.handle('sticker:bytes', (_e, p) => {
  const st = fs.statSync(p);
  if (st.size > 60 * 1024 * 1024) throw new Error('That file is too big for a sticker (over 60 MB).');
  return fs.readFileSync(p);
});

// Noto animated emoji (CC BY 4.0, by Google), downloaded the first time each one is used.
ipcMain.handle('sticker:noto', async (_e, code) => {
  if (!/^[0-9a-f]{4,6}(_[0-9a-f]{4,6})*$/.test(code)) throw new Error('Unknown emoji');
  const dir = path.join(app.getPath('userData'), 'stickers', 'noto');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${code}.webp`);
  if (!fs.existsSync(file)) {
    const res = await (net && net.fetch ? net.fetch : fetch)(`https://fonts.gstatic.com/s/e/notoemoji/latest/${code}/512.webp`);
    if (!res.ok) throw new Error(res.status === 404 ? "That emoji doesn't have an animation" : `Download failed (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(`${file}.part`, buf);
    fs.renameSync(`${file}.part`, file);
  }
  return file;
});

// ---------- check-up: what works on this computer

async function reachable(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await (net && net.fetch ? net.fetch : fetch)(url, { method: 'HEAD', signal: ctrl.signal });
    return res.status < 500;
  } catch { return false; } finally { clearTimeout(timer); }
}
function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `.snippy-check-${process.pid}`);
    fs.writeFileSync(f, 'ok'); fs.rmSync(f);
    return true;
  } catch { return false; }
}
const modelThere = (id) => fs.existsSync(path.join(app.getPath('userData'), 'models', ...id.split('/')));

ipcMain.handle('checkup:run', async () => {
  const out = [];
  const add = (group, name, state, note) => out.push({ group, name, state, note });
  // FFmpeg and what it can do
  let encoders = '';
  let filters = '';
  try {
    const v = (await run(FFMPEG, ['-hide_banner', '-version'])).toString().split('\n')[0];
    add('Video engine', 'FFmpeg', 'ok', v.replace(/Copyright.*/, '').trim());
    encoders = (await run(FFMPEG, ['-hide_banner', '-encoders'])).toString();
    filters = (await run(FFMPEG, ['-hide_banner', '-filters'])).toString();
  } catch (err) { add('Video engine', 'FFmpeg', 'bad', `Couldn't start FFmpeg: ${err.message}. Try reinstalling with npm install.`); }
  if (encoders) {
    add('Video engine', 'MP4 export (H.264 + AAC)', /\slibx264\s/.test(encoders) && /\saac\s/.test(encoders) ? 'ok' : 'bad', 'Needed for every export.');
    add('Video engine', 'See-through cut-outs (VP9)', /\slibvpx-vp9\s/.test(encoders) ? 'ok' : 'warn', 'Used by background removal for videos.');
    const has = (f) => new RegExp(`\\s${f}\\s`).test(filters);
    add('Video engine', 'Best stabiliser (vid.stab)', has('vidstabdetect') ? 'ok' : 'warn', has('vidstabdetect') ? 'Two-pass stabilising.' : 'Not in this FFmpeg, so Snippy uses the simpler deshake filter.');
    const missing = ['xfade', 'colorkey', 'alphamerge', 'loudnorm', 'silencedetect', 'palettegen', 'afftdn'].filter((f) => !has(f));
    add('Video engine', 'Effects, transitions, GIFs, pauses', missing.length ? 'bad' : 'ok', missing.length ? `Missing: ${missing.join(', ')}` : 'All the filters Snippy uses are there.');
  }
  // Folders
  add('Folders', 'Snippy\'s own data', writable(app.getPath('userData')) ? 'ok' : 'bad', app.getPath('userData'));
  add('Folders', 'Documents\\Snippy (voiceovers, music)', writable(path.join(app.getPath('documents'), 'Snippy')) ? 'ok' : 'bad', path.join(app.getPath('documents'), 'Snippy'));
  add('Folders', 'Temporary files', writable(os.tmpdir()) ? 'ok' : 'bad', os.tmpdir());
  try {
    const st = fs.statfsSync(app.getPath('userData'));
    const gb = (st.bavail * st.bsize) / 1e9;
    add('Folders', 'Free space', gb > 5 ? 'ok' : gb > 1 ? 'warn' : 'bad', `${gb.toFixed(1)} GB free. Exports and preview copies need room.`);
  } catch { /* not available on this system */ }
  // Downloads Snippy makes the first time a feature is used
  const [hf, bsb, gh] = await Promise.all([reachable('https://huggingface.co'), reachable('https://bigsoundbank.com'), reachable('https://github.com')]);
  add('Internet', 'Model downloads (huggingface.co)', hf ? 'ok' : 'warn', hf ? 'Captions, cut-outs, reframe and voices can download their models.' : 'Can\'t reach it, so first-time model downloads will fail. Check your internet, firewall or proxy.');
  add('Internet', 'Sound pack (bigsoundbank.com)', bsb ? 'ok' : 'warn', bsb ? 'The free sound pack can download.' : 'Can\'t reach it, so the sound pack can\'t download right now.');
  add('Internet', 'Updates (github.com)', gh ? 'ok' : 'warn', gh ? 'Update checks can reach GitHub.' : 'Can\'t reach GitHub, so update checks will fail.');
  // Features that download something the first time
  add('AI features', 'Auto captions model', modelThere(ASR_MODEL) ? 'ok' : 'info', modelThere(ASR_MODEL) ? 'Downloaded.' : 'Downloads (about 80 MB) the first time you use Auto captions.');
  add('AI features', 'Person finder (cut-outs, reframe)', modelThere(SEG_MODEL) ? 'ok' : 'info', modelThere(SEG_MODEL) ? 'Downloaded.' : 'Downloads (about 25 MB) the first time you remove a background or reframe.');
  add('AI features', 'AI tools', aiReady() ? 'ok' : 'info', aiBundled() ? 'Included (running from the project folder).' : aiReady() ? 'Downloaded.' : 'Download once (about 30 MB) the first time you use an AI feature.');
  const kokoro = aiReady();
  add('AI features', 'Voiceover voices', !kokoro ? 'info' : modelThere(TTS_MODEL) ? 'ok' : 'info',
    !kokoro ? 'Come with the AI tools.' : modelThere(TTS_MODEL) ? 'Downloaded.' : 'Downloads (about 90 MB) the first time you make a voiceover.');
  const pack = soundPack.packList(packDir());
  const ready = pack.filter((s) => s.ready).length;
  add('Extras', 'Real sound effects', ready === pack.length ? 'ok' : 'info', ready === pack.length ? `All ${pack.length} downloaded.` : `${ready} of ${pack.length} downloaded. Get them from the Sounds panel.`);
  add('Extras', 'Auto-updates', updateState.state === 'off' ? 'info' : 'ok', updateState.state === 'off' ? 'Off: you update with node update.js (or set up releases, see README).' : 'Set up.');
  return out;
});

// ---------- recent projects (for the home screen)

const recentPath = () => path.join(app.getPath('userData'), 'recent.json');
function readRecent() {
  try { return JSON.parse(fs.readFileSync(recentPath(), 'utf8')); } catch { return []; }
}
ipcMain.handle('recent:list', () => readRecent().map((r) => ({ ...r, exists: fs.existsSync(r.path) })));
ipcMain.handle('recent:add', (_e, entry) => {
  const list = [{ ...entry, openedAt: Date.now() }, ...readRecent().filter((r) => r.path !== entry.path)].slice(0, 12);
  writeFileSafe(recentPath(), JSON.stringify(list));
  if (process.platform === 'win32') app.addRecentDocument(entry.path);
});
ipcMain.handle('recent:remove', (_e, p) => writeFileSafe(recentPath(), JSON.stringify(readRecent().filter((r) => r.path !== p))));
ipcMain.handle('project:openPath', (_e, p) => ({ path: p, text: fs.readFileSync(p, 'utf8') }));

// The brand kit: colours, font, caption look, logo, intro and outro, kept for every project.
const brandFile = () => path.join(app.getPath('userData'), 'brand.json');
ipcMain.handle('brand:get', () => {
  try { return JSON.parse(fs.readFileSync(brandFile(), 'utf8')); } catch { return null; }
});
ipcMain.handle('brand:set', (_e, kit) => {
  fs.writeFileSync(brandFile(), JSON.stringify(kit, null, 2));
  return true;
});
ipcMain.handle('dialog:pickOne', async (_e, kind) => {
  const filters = kind === 'image'
    ? [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
    : [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'] }];
  const r = await dialog.showOpenDialog(win, { title: kind === 'image' ? 'Choose your logo' : 'Choose a video', properties: ['openFile'], filters });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

// A long video's transcript is kept, so finding Shorts in it again doesn't mean listening again.
ipcMain.handle('transcript:get', (_e, src, key) => {
  try {
    const p = cachePath('transcripts', src, key, 'json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  } catch { return null; }
});
ipcMain.handle('transcript:put', (_e, src, key, data) => {
  try { fs.writeFileSync(cachePath('transcripts', src, key, 'json'), JSON.stringify(data)); } catch { /* not kept */ }
});

// Saving a picture (a thumbnail) where the user chooses.
ipcMain.handle('image:save', async (_e, dataUrl, name) => {
  const jpg = /^data:image\/jpeg/.test(dataUrl);
  const r = await dialog.showSaveDialog(win, {
    title: 'Save thumbnail',
    defaultPath: path.join(app.getPath('pictures'), `${name || 'Thumbnail'}.${jpg ? 'jpg' : 'png'}`),
    filters: [jpg ? { name: 'JPEG picture', extensions: ['jpg', 'jpeg'] } : { name: 'PNG picture', extensions: ['png'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  return r.filePath;
});

ipcMain.handle('frame:grab', async (_e, src, t) => {
  const out = cachePath('frames', src, t.toFixed(3), 'png');
  if (!fs.existsSync(out)) await fun.grabFrame(FFMPEG, src, t, out);
  return out;
});
