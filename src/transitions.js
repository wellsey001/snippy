'use strict';

// How each transition looks at progress p (0 = all outgoing clip, 1 = all incoming).
// Used by the preview and by the animated tiles in the style picker. The shapes and
// timings follow FFmpeg's xfade, which the export uses (measured red-to-blue: e.g. a
// left wipe reveals the next clip from the right, the clock sweeps from 12 o'clock).

const TRANSITIONS = [
  ['cross', 'Crossfade'], ['dip', 'Dip to black'], ['flash', 'Flash'], ['blur', 'Blur'],
  ['pixelate', 'Pixelate'], ['wipe', 'Wipe'], ['softwipe', 'Soft wipe'], ['push', 'Slide'],
  ['circleopen', 'Circle open'], ['circleclose', 'Circle close'], ['clock', 'Clock'], ['whip', 'Whip pan'],
  ['zoom', 'Zoom'], ['spin', 'Spin'], ['squeeze', 'Squeeze'], ['glitch', 'Glitch'], ['shake', 'Shake cut'], ['slices', 'Slices'],
];
const TRANSITION_DIRS = {
  wipe: ['left', 'right', 'up', 'down'], softwipe: ['left', 'right', 'up', 'down'],
  push: ['left', 'right', 'up', 'down'], whip: ['left', 'right'],
};
const transitionName = (id) => (TRANSITIONS.find(([k]) => k === id) || [null, 'Crossfade'])[1];

const smooth01 = (p) => { const q = Math.min(1, Math.max(0, p)); return q * q * (3 - 2 * q); };
const smoothstepAB = (a, b, v) => smooth01((v - a) / (b - a));
const tpct = (v) => `${(v * 100).toFixed(2)}%`;

let sliceMaskUrl = null;
let sliceMaskP = -1;
// FFmpeg's hlslice: ten vertical strips, each filling from the right as the sweep passes.
function sliceMask(p) {
  if (Math.abs(p - sliceMaskP) < 0.004 && sliceMaskUrl) return sliceMaskUrl;
  const cv = document.createElement('canvas');
  cv.width = 400; cv.height = 1;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(400, 1);
  for (let i = 0; i < 400; i++) {
    const xx = (i + 0.5) / 400;
    const s = smoothstepAB(-0.5, 0, xx - 1.5 + 1.5 * p);
    const on = s > (10 * xx) % 1;
    img.data[i * 4 + 3] = on ? 255 : 0;
  }
  ctx.putImageData(img, 0, 0);
  sliceMaskP = p;
  sliceMaskUrl = `url(${cv.toDataURL()})`;
  return sliceMaskUrl;
}

function resetTransitionLook(L) {
  for (const el of [L.A, L.B]) {
    el.style.opacity = '';
    el.style.transform = '';
    el.style.filter = '';
    el.style.zIndex = '';
    el.style.maskImage = el.style.webkitMaskImage = '';
    el.style.maskSize = el.style.webkitMaskSize = '';
  }
  if (L.flash) L.flash.style.opacity = '0';
}

// L = { A, B, flash } elements. W/H = size in pixels. t = timeline time (for jitter).
// Returns 'pixelate' when the caller should also draw the pixelated picture.
function applyTransitionLook(L, style, dir, p, W, H, t) {
  resetTransitionLook(L);
  const { A, B } = L;
  const mask = (m, size) => {
    B.style.maskImage = B.style.webkitMaskImage = m;
    if (size) B.style.maskSize = B.style.webkitMaskSize = size;
  };
  const both = (prop, v) => { A.style[prop] = v; B.style[prop] = v; };
  switch (style) {
    case 'dip':
      A.style.opacity = String(Math.max(0, 1 - 2 * p));
      B.style.opacity = String(Math.max(0, 2 * p - 1));
      break;
    case 'flash': {
      // Almost white within the first quarter, then the white clears to reveal the next clip.
      const w = p < 0.25 ? (p / 0.25) ** 0.6 : (1 - p) / 0.75;
      if (L.flash) L.flash.style.opacity = String(w);
      B.style.opacity = p < 0.25 ? '0' : '1';
      break;
    }
    case 'blur':
      B.style.opacity = String(p);
      both('filter', `blur(${(Math.sin(Math.PI * p) * 0.025 * W).toFixed(1)}px)`);
      break;
    case 'pixelate':
      B.style.opacity = String(p);
      return 'pixelate';
    case 'wipe':
      if (dir === 'right') mask(`linear-gradient(to right, black ${tpct(p)}, transparent ${tpct(p)})`);
      else if (dir === 'up') mask(`linear-gradient(to bottom, transparent ${tpct(1 - p)}, black ${tpct(1 - p)})`);
      else if (dir === 'down') mask(`linear-gradient(to bottom, black ${tpct(p)}, transparent ${tpct(p)})`);
      else mask(`linear-gradient(to right, transparent ${tpct(1 - p)}, black ${tpct(1 - p)})`);
      break;
    case 'softwipe':
      if (dir === 'right') mask(`linear-gradient(to right, black ${tpct(2 * p - 1)}, transparent ${tpct(2 * p)})`);
      else if (dir === 'up') mask(`linear-gradient(to bottom, transparent ${tpct(1 - 2 * p)}, black ${tpct(2 - 2 * p)})`);
      else if (dir === 'down') mask(`linear-gradient(to bottom, black ${tpct(2 * p - 1)}, transparent ${tpct(2 * p)})`);
      else mask(`linear-gradient(to right, transparent ${tpct(1 - 2 * p)}, black ${tpct(2 - 2 * p)})`);
      break;
    case 'push':
    case 'whip': {
      const d = style === 'whip' && dir !== 'right' ? 'left' : dir;
      const sign = d === 'right' || d === 'down' ? -1 : 1;
      const axis = d === 'up' || d === 'down' ? 'Y' : 'X';
      A.style.transform = `translate${axis}(${(-sign * p * 100).toFixed(2)}%)`;
      B.style.transform = `translate${axis}(${(sign * (1 - p) * 100).toFixed(2)}%)`;
      if (style === 'whip') both('filter', `blur(${(Math.sin(Math.PI * p) * 0.012 * W).toFixed(1)}px)`);
      break;
    }
    case 'circleopen': {
      const a = 3 * p - 1.5;
      const b = 3 * p - 0.5;
      if (b <= 0) B.style.opacity = '0';
      else mask(`radial-gradient(circle farthest-corner at 50% 50%, black ${tpct(Math.max(0, a))}, transparent ${tpct(Math.max(0.001, b))})`);
      break;
    }
    case 'circleclose':
      mask(`radial-gradient(circle farthest-corner at 50% 50%, transparent ${tpct(Math.max(0, 1.5 - 3 * p))}, black ${tpct(Math.max(0.001, 2.5 - 3 * p))})`);
      break;
    case 'clock':
      mask(`conic-gradient(from 0deg at 50% 50%, black ${(p * 360).toFixed(1)}deg, transparent ${(p * 360).toFixed(1)}deg)`);
      break;
    case 'zoom':
      // The outgoing clip zooms into its centre, then the next clip fades in.
      if (p < 0.5) {
        // FFmpeg zooms all the way into the centre pixel by the midpoint.
        A.style.transform = `scale(${(1 / Math.max(0.0025, smoothstepAB(0.5, 1, 1 - p))).toFixed(3)})`;
        B.style.opacity = '0';
      } else {
        A.style.transform = 'scale(400)';
        B.style.opacity = String(1 - smoothstepAB(0, 0.5, 1 - p));
      }
      break;
    case 'spin':
      both('transform', `rotate(${(360 * smooth01(p)).toFixed(1)}deg) scale(1.35)`);
      B.style.opacity = String(p);
      break;
    case 'squeeze':
      // The outgoing clip squashes flat towards the middle, uncovering the next one behind it.
      A.style.zIndex = '2';
      B.style.zIndex = '1';
      A.style.transform = `scaleY(${Math.max(0.0001, 1 - p).toFixed(4)})`;
      break;
    case 'glitch': {
      B.style.opacity = String(p);
      const dx = 0.03 * W * Math.sin(t * 97);
      const r = Math.max(1, 0.012 * W);
      both('transform', `translateX(${(-dx).toFixed(1)}px) scale(1.04)`);
      both('filter', `drop-shadow(${-r}px 0 0 rgba(255,0,60,.7)) drop-shadow(${r}px 0 0 rgba(0,200,255,.7))`);
      break;
    }
    case 'slices':
      mask(sliceMask(p), '100% 100%');
      break;
    case 'shake': // a quick fade; the shake itself runs after the cut (shakeAfterCut)
    default:
      B.style.opacity = String(p);
  }
  return null;
}

// Shake cut: a decaying shake for the transition's length after the cut, matching the export.
function shakeTransform(t, a, d, H) {
  if (t < a || t > a + d) return '';
  const decay = 1 - (t - a) / d;
  const dx = decay * 0.03 * H * Math.sin(t * 61);
  const dy = decay * 0.022 * H * Math.sin(t * 53);
  return `translate(${(-dx).toFixed(1)}px, ${(-dy).toFixed(1)}px) scale(1.08)`;
}
