'use strict';

// Captions are drawn by this one routine for both the preview and the export,
// so an exported video shows exactly what the editor showed.

const CAPTION_FONT = '"Segoe UI", "Segoe UI Variable Display", system-ui, sans-serif';
const ANIMS = { pop: 0.22, fade: 0.25, slide: 0.28 }; // intro length in seconds
// Caption looks: a whole style in one click. Each sets every word-style field, so switching
// between them never leaves part of the old look behind.
const LOOK_BASE = { wordFx: 'none', highlight: false, box: false, caps: false, anim: 'none', color: '#FFFFFF', hlColor: '#FFD84D' };
const CAPTION_PRESETS = [
  { id: 'boldbox', name: 'Bold box', set: { ...LOOK_BASE, wordFx: 'box', hlColor: '#FACC15', caps: true, size: 7 } },
  { id: 'bounce', name: 'Bounce', set: { ...LOOK_BASE, wordFx: 'bounce', hlColor: '#4ADE80', caps: true, anim: 'pop', size: 7 } },
  { id: 'karaoke', name: 'Karaoke', set: { ...LOOK_BASE, wordFx: 'karaoke', hlColor: '#FDE047', anim: 'fade', size: 6.5 } },
  { id: 'popin', name: 'Pop in', set: { ...LOOK_BASE, wordFx: 'pop', hlColor: '#FFFFFF', size: 6.5 } },
  { id: 'neon', name: 'Neon', set: { ...LOOK_BASE, wordFx: 'glow', hlColor: '#E879F9', color: '#F5D0FE', caps: true, anim: 'fade', size: 6.5 } },
  { id: 'big', name: 'Big word', set: { ...LOOK_BASE, wordFx: 'big', hlColor: '#F87171', caps: true, anim: 'pop', size: 7 } },
  { id: 'one', name: 'One word', set: { ...LOOK_BASE, wordFx: 'one', caps: true, size: 8 } },
  { id: 'highlight', name: 'Highlight', set: { ...LOOK_BASE, highlight: true, caps: true, anim: 'pop', size: 6 } },
  { id: 'clean', name: 'Clean', set: { ...LOOK_BASE, box: true, boxColor: 'rgba(0, 0, 0, 0.62)', anim: 'fade', size: 5.5 } },
];

// Stickers: emoji drawn with the system's colour emoji font.
const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
const STICKER_INTRO = 0.25;
const LOOPING = new Set(['bounce', 'wiggle', 'spin', 'pulse']); // these change every frame
// Where each text was drawn last time (shares of the canvas), so the preview can pick texts by clicking.
const captionHits = [];
const STICKER_SETS = [
  ['Faces', '😀 😂 🤣 😍 🥰 😎 🤩 😜 🤔 😮 😱 😭 😡 🥳 😴 🤯 🙃 😇'],
  ['Hands', '👍 👎 👏 🙌 🙏 💪 👀 👉 👈 ✌️ 🤞 👋'],
  ['Hearts and symbols', '❤️ 🧡 💛 💚 💙 💜 💯 ✨ 🔥 ⭐ 💥 ⚡ ✅ ❌ ❓ ❗ 💬 🎵'],
  ['Party and things', '🎉 🎂 🎁 🏆 🚀 🌈 ☀️ 🍕 🍦 ☕ 🐶 🐱 🦄 👻 💩 🤖'],
].map(([name, list]) => [name, list.split(' ')]);

const easeOutCubic = (p) => 1 - (1 - p) ** 3;
const easeOutBack = (p) => 1 + 2.70158 * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2;

function captionWords(x) {
  const text = x.caps ? x.text.toUpperCase() : x.text;
  return text.split('\n').map((line) => line.split(/\s+/).filter(Boolean));
}

// Without word timings, each word gets a share of the caption's time in
// proportion to its length (longer words take longer to say).
function wordStarts(x) {
  const words = captionWords(x).flat();
  // Real timings from the speech model, as long as the text still has the same words.
  if (x.words && x.words.length === words.length) return x.words.map((w) => w.s);
  const weights = words.map((w) => w.length + 1);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let t = 0;
  return words.map((_, i) => { const s = t; t += (x.dur * weights[i]) / sum; return s; });
}

// Seconds per letter for the Typing animation: brisk, and done within 60% of the caption.
function typeRate(x) {
  const n = Math.max(1, captionWords(x).flat().join('').length);
  return Math.min(0.06, (x.dur * 0.6) / n);
}

function activeWordAt(x, u) {
  const starts = wordStarts(x);
  let k = 0;
  for (let i = 0; i < starts.length; i++) if (u >= starts[i]) k = i;
  return k;
}

function layoutCaption(ctx, x, W, H) {
  const size = (x.size / 100) * H;
  ctx.font = `700 ${size}px ${CAPTION_FONT}`;
  // A little extra room between words so a highlighted (slightly larger) word never touches its neighbours.
  const space = ctx.measureText(' ').width + size * 0.1;
  const maxW = W * 0.9;
  const lines = [];
  let idx = 0;
  for (const hard of captionWords(x)) {
    let line = [];
    let lw = 0;
    for (const text of hard) {
      const w = ctx.measureText(text).width;
      if (line.length && lw + space + w > maxW) { lines.push({ words: line, w: lw }); line = []; lw = 0; }
      line.push({ text, w, idx: idx++ });
      lw += (line.length > 1 ? space : 0) + w;
    }
    if (line.length) lines.push({ words: line, w: lw });
  }
  const lineH = size * 1.22;
  const blockH = lines.length * lineH;
  const y0 = (x.position === 'top' ? H * 0.08 : x.position === 'center' ? (H - blockH) / 2 : H - H * 0.08 - blockH)
    + (x.offsetY || 0) * H; // "nudge up / down"
  const margin = W * 0.06;
  const blockW = Math.max(0, ...lines.map((ln) => ln.w));
  lines.forEach((ln, i) => {
    ln.cy = y0 + lineH * (i + 0.5);
    let wx = x.align === 'left' ? margin : x.align === 'right' ? W - margin - ln.w : (W - ln.w) / 2;
    for (const wd of ln.words) { wd.x = wx; wx += wd.w + space; }
  });
  const cx = x.align === 'left' ? margin + blockW / 2 : x.align === 'right' ? W - margin - blockW / 2 : W / 2;
  return { size, lines, cx, cy: y0 + blockH / 2 };
}

function drawCaption(ctx, W, H, x, u) {
  const L = layoutCaption(ctx, x, W, H);
  if (!L.lines.length) return;
  const { size } = L;
  let alpha = 1;
  let scale = 1;
  let dy = 0;
  if (x.anim === 'pop') {
    scale = 0.55 + 0.45 * easeOutBack(Math.min(1, u / ANIMS.pop));
    alpha = Math.min(1, u / 0.08);
  } else if (x.anim === 'fade') {
    alpha = easeOutCubic(Math.min(1, u / ANIMS.fade));
  } else if (x.anim === 'slide') {
    const p = easeOutCubic(Math.min(1, u / ANIMS.slide));
    dy = (1 - p) * 0.06 * H;
    alpha = p;
  }
  const active = x.highlight || (x.wordFx && x.wordFx !== 'none') ? activeWordAt(x, u) : -1;
  const hl = x.hlColor || '#FFD84D';
  // Keyframed (or fixed) move, size, turn and opacity on top of the intro animation.
  const k = kfValue(x, 'text', u);
  const mx = L.cx + k.dx * W;
  const my = L.cy + k.dy * H;
  const blockW = Math.max(...L.lines.map((ln) => ln.w)) + size * 0.7;
  const blockH = L.lines.length * size * 1.22 + size * 0.2;
  captionHits.push({ id: x.id, cx: mx / W, cy: my / H, hw: (blockW / 2) * k.scale / W, hh: (blockH / 2) * k.scale / H, rot: k.rotate, ar: W / H });

  ctx.save();
  ctx.globalAlpha = alpha * Math.max(0, Math.min(1, k.opacity));
  ctx.translate(mx, my + dy);
  ctx.rotate((k.rotate * Math.PI) / 180);
  ctx.scale(scale * k.scale, scale * k.scale);
  ctx.translate(-L.cx, -L.cy);
  ctx.font = `700 ${size}px ${CAPTION_FONT}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';

  if (x.box) {
    ctx.fillStyle = x.boxColor || 'rgba(0, 0, 0, 0.62)';
    for (const ln of L.lines) {
      const pad = size * 0.32;
      roundRect(ctx, ln.words[0].x - pad, ln.cy - size * 0.66, ln.w + pad * 2, size * 1.32, size * 0.24);
      ctx.fill();
    }
  }
  // Typing: letters appear one by one (the layout is for the whole text, so lines never jump).
  let typed = x.anim === 'typewriter' ? Math.floor(u / typeRate(x)) : Infinity;
  const fx = x.wordFx && x.wordFx !== 'none' ? x.wordFx : (x.highlight ? 'hl' : 'none');
  const starts = fx !== 'none' || x.emoji || x.keyColor ? wordStarts(x) : null;
  const endOf = (i) => (x.words && x.words[i] && x.words[i].e != null && starts.length === x.words.length ? x.words[i].e : (starts[i + 1] ?? x.dur));
  const kwColor = x.kwColor || '#4ADE80';
  const allWords = L.lines.flatMap((ln) => ln.words.map((wd) => ({ ln, wd })));
  const drawWord = (ln, wd, text, opts) => {
    const { scale: ws = 1, dy: wdy = 0, colour, boxBehind = null, glow = null, partial = null, alphaW = 1, at = null } = opts;
    const wx = at ? at.x : wd.x;
    const wy = at ? at.y : ln.cy;
    const wc = wx + wd.w / 2;
    ctx.save();
    ctx.globalAlpha *= alphaW;
    ctx.translate(wc, wy + wdy);
    ctx.scale(ws, ws);
    ctx.translate(-wc, -wy);
    if (boxBehind) {
      const pad = size * 0.1;
      ctx.fillStyle = boxBehind;
      roundRect(ctx, wx - pad, wy - size * 0.62, wd.w + pad * 2, size * 1.24, size * 0.2);
      ctx.fill();
    }
    if (!x.box && !boxBehind) {
      ctx.lineWidth = size * 0.16;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      ctx.strokeText(text, wx, wy);
    }
    if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = size * 0.6; }
    ctx.fillStyle = boxBehind ? '#111111' : colour;
    ctx.fillText(text, wx, wy);
    if (glow) { ctx.fillText(text, wx, wy); ctx.shadowBlur = 0; }
    if (partial) {
      // Karaoke: the sung part of the word in the highlight colour.
      ctx.save();
      ctx.beginPath();
      ctx.rect(wx - 2, wy - size, (wd.w + 4) * partial.share, size * 2);
      ctx.clip();
      ctx.fillStyle = partial.colour;
      ctx.fillText(text, wx, wy);
      ctx.restore();
    }
    ctx.restore();
  };
  if (fx === 'one') {
    // One word at a time, big, in the middle of where the caption sits.
    const item = allWords.find((o) => o.wd.idx === active);
    if (item && u >= starts[active]) {
      const p = Math.min(1, (u - starts[active]) / 0.16);
      const text = item.wd.text;
      const big = 1.45;
      drawWord(item.ln, item.wd, text, {
        scale: big * (0.6 + 0.4 * easeOutBack(p)), colour: x.keyColor && isKeyword(text) ? kwColor : x.color,
        at: { x: L.cx - item.wd.w / 2, y: L.cy },
      });
    }
  } else {
    for (const { ln, wd } of allWords) {
      if (typed <= 0) break;
      const text = typed < wd.text.length ? wd.text.slice(0, typed) : wd.text;
      typed -= wd.text.length;
      const i = wd.idx;
      const on = i === active;
      const ws = starts ? starts[i] : 0;
      const spoken = !starts || u >= ws;
      const p = starts ? Math.min(1, Math.max(0, (u - ws) / 0.18)) : 1;
      let colour = x.keyColor && isKeyword(text) ? kwColor : x.color;
      const o = {};
      if (fx === 'hl' && on) { o.scale = 1.06; colour = hl; }
      else if (fx === 'pop') {
        if (!spoken) continue;
        o.scale = 0.45 + 0.55 * easeOutBack(p);
        o.alphaW = Math.min(1, p * 2.5);
        if (on) colour = hl;
      } else if (fx === 'bounce' && on) {
        o.dy = -Math.sin(Math.PI * Math.min(1, (u - ws) / 0.3)) * 0.24 * size;
        colour = hl;
      } else if (fx === 'karaoke') {
        const we = endOf(i);
        if (u >= we) colour = hl;
        else if (on && spoken) o.partial = { share: Math.min(1, (u - ws) / Math.max(0.05, we - ws)), colour: hl };
      } else if (fx === 'box' && on && spoken) {
        o.boxBehind = hl;
        o.scale = 0.88 + 0.12 * easeOutBack(Math.min(1, (u - ws) / 0.12)) + 0.06;
      } else if (fx === 'glow' && on && spoken) { o.glow = hl; colour = '#FFFFFF'; o.scale = 1.04; }
      else if (fx === 'big' && on && spoken) { o.scale = 1 + 0.18 * easeOutBack(Math.min(1, (u - ws) / 0.14)); colour = hl; }
      o.colour = colour;
      drawWord(ln, wd, text, o);
    }
  }
  // Auto emoji: the latest word said that has one shows its emoji just above the caption.
  if (x.emoji && starts) {
    let pick = -1;
    for (const { wd } of allWords) if (u >= starts[wd.idx] && emojiFor(wd.text)) pick = wd.idx;
    if (pick >= 0) {
      const word = allWords.find((o) => o.wd.idx === pick).wd.text;
      const p = Math.min(1, (u - starts[pick]) / 0.2);
      const top = L.lines[0].cy - size * 0.66;
      ctx.save();
      ctx.translate(L.cx, top - size * 0.75);
      ctx.scale(0.3 + 0.7 * easeOutBack(p), 0.3 + 0.7 * easeOutBack(p));
      ctx.font = `${size * 1.25}px ${EMOJI_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(emojiFor(word), 0, 0);
      ctx.restore();
    }
  }
  ctx.restore();
}

// Words worth a colour of their own: numbers, long words and words people stress.
const KEY_WORDS = new Set(['never', 'always', 'best', 'worst', 'free', 'money', 'secret', 'new', 'love', 'huge', 'amazing', 'crazy', 'insane', 'now', 'today', 'important', 'must', 'stop', 'first', 'only', 'every', 'everything', 'nothing', 'biggest', 'easy', 'fast', 'why', 'how', 'wow', 'win', 'lose', 'real', 'truth', 'mistake', 'hack', 'tip', 'tips']);
const bare = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
function isKeyword(w) {
  const b = bare(w);
  return /\d/.test(b) || b.replace(/'/g, '').length >= 8 || KEY_WORDS.has(b);
}
const EMOJI_WORDS = [
  [['money', 'cash', 'dollars', 'pounds', 'rich', 'paid', 'pay', 'price', 'cost', 'expensive', 'cheap'], '💰'],
  [['love', 'loved', 'heart', 'cute', 'adore'], '❤️'], [['fire', 'hot', 'lit', 'spicy', 'burn'], '🔥'],
  [['laugh', 'funny', 'lol', 'joke', 'hilarious'], '😂'], [['wow', 'amazing', 'crazy', 'insane', 'unbelievable', 'mind'], '🤯'],
  [['time', 'minutes', 'hours', 'late', 'clock', 'seconds'], '⏰'], [['food', 'eat', 'eating', 'hungry', 'dinner', 'lunch', 'breakfast', 'pizza', 'burger'], '🍔'],
  [['happy', 'smile', 'glad'], '😊'], [['sad', 'cry', 'crying', 'upset'], '😢'], [['music', 'song', 'songs', 'sing'], '🎵'],
  [['idea', 'ideas', 'tip', 'tips', 'hack', 'trick'], '💡'], [['win', 'won', 'winner', 'winning', 'best', 'champion'], '🏆'],
  [['phone', 'app', 'apps'], '📱'], [['car', 'drive', 'driving'], '🚗'], [['home', 'house'], '🏠'], [['cat', 'cats', 'kitten'], '🐱'],
  [['dog', 'dogs', 'puppy'], '🐶'], [['party', 'celebrate', 'birthday'], '🎉'], [['fast', 'rocket', 'quick', 'launch', 'grow', 'growth'], '🚀'],
  [['star', 'stars'], '⭐'], [['sun', 'sunny', 'summer', 'beach'], '☀️'], [['coffee', 'tea'], '☕'], [['book', 'books', 'read', 'reading', 'learn', 'study'], '📚'],
  [['work', 'job', 'business', 'office'], '💼'], [['travel', 'trip', 'flight', 'holiday'], '✈️'], [['game', 'games', 'gaming', 'play'], '🎮'],
  [['video', 'film', 'movie'], '🎬'], [['photo', 'camera', 'picture'], '📸'], [['yes', 'done', 'right', 'correct', 'perfect'], '✅'],
  [['no', 'wrong', 'mistake', 'never'], '❌'], [['think', 'thinking', 'wonder', 'why'], '🤔'], [['look', 'see', 'watch', 'eyes'], '👀'],
  [['strong', 'gym', 'workout', 'muscle'], '💪'], [['secret', 'quiet', 'shh'], '🤫'], [['hello', 'hi', 'hey', 'bye'], '👋'],
];
const EMOJI_MAP = new Map(EMOJI_WORDS.flatMap(([ws, e]) => ws.map((w) => [w, e])));
const emojiFor = (w) => EMOJI_MAP.get(bare(w)) || null;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------- animated images (GIFs, animated WebP, Noto animated emoji)
// Decoded once into frames, so any moment can be drawn exactly: the preview and the export
// pick the same frame for the same time.
const gifStore = new Map(); // src -> { frames: [{ bmp, end }], total, w, h } or { pending }

function gifFrameAt(entry, u) {
  if (!entry.frames.length) return null;
  const t = ((u * 1000) % entry.total + entry.total) % entry.total;
  for (const f of entry.frames) if (t < f.end) return f.bmp;
  return entry.frames[entry.frames.length - 1].bmp;
}

// The shape of a sticker's box (width ÷ height), for drawing and for its handle on the preview.
function stickerAspect(s) {
  if (s.effect) return s.effect.ar || 1.4;
  if (s.gif) { const e = gifStore.get(s.gif.src); return e && e.w ? e.w / e.h : 1; }
  if (s.fun) return FUN_ASPECT[s.fun.kind] || 1;
  return 1;
}

// ---------- Snippy's own animated stickers, drawn from code

const FUN_STICKERS = [
  ['bubble', 'WOW!'], ['bubble', 'LOL'], ['bubble', 'OMG'], ['bubble', 'NO WAY'], ['bubble', 'BRUH'],
  ['shout', 'YES!'], ['shout', 'BOOM!'], ['burst', 'NEW!'], ['burst', 'SALE'],
  ['arrow'], ['circle'], ['sparkles'], ['hearts'], ['confetti'], ['subscribe'], ['loading'],
];
const FUN_ASPECT = { bubble: 1.5, shout: 1.5, burst: 1.15, arrow: 1.6, circle: 1.5, subscribe: 1.9, loading: 2.2 };
const FUN_TEXT = new Set(['bubble', 'shout', 'burst']);
const funFont = (px) => `900 ${px}px "Segoe UI Black", "Segoe UI", system-ui, sans-serif`;

function funGradient(ctx, w) {
  const g = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
  g.addColorStop(0, '#8B5CF6'); g.addColorStop(0.55, '#D946EF'); g.addColorStop(1, '#F472B6');
  return g;
}
// The same "random" numbers every time, so the preview and the export agree.
const rnd = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

function fitText(ctx, text, maxW, px) {
  ctx.font = funFont(px);
  const w = ctx.measureText(text).width;
  if (w > maxW) { px *= maxW / w; ctx.font = funFont(px); }
  return px;
}

function star(ctx, n, rOut, rIn) {
  ctx.beginPath();
  for (let k = 0; k < n * 2; k++) {
    const r = k % 2 ? rIn : rOut;
    const a = -Math.PI / 2 + (k * Math.PI) / n;
    if (k) ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); else ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
}

// Drawn centred on (0, 0) in a box size tall and size × aspect wide; u = seconds since it appeared.
function drawFun(ctx, f, size, u) {
  const kind = f.kind;
  const w = size * (FUN_ASPECT[kind] || 1);
  const h = size;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (kind === 'bubble') {
    const wob = 1 + 0.035 * Math.sin(u * Math.PI * 3);
    ctx.scale(wob, 2 - wob);
    // Tail, then bubble, then the tail's inside again so the join has no line across it.
    const tail = (k) => { ctx.beginPath(); ctx.moveTo(-w * 0.2 * k, h * 0.16); ctx.lineTo(-w * 0.3, h * 0.46 - (1 - k) * h * 0.05); ctx.lineTo(-w * 0.03 * k, h * 0.2); ctx.closePath(); };
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#1B0F33'; ctx.lineWidth = h * 0.05;
    tail(1); ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, -h * 0.06, w * 0.46, h * 0.36, 0, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    tail(0.82); ctx.fill();
    const px = fitText(ctx, f.text || 'WOW!', w * 0.72, h * 0.3);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = funGradient(ctx, w);
    ctx.fillText(f.text || 'WOW!', 0, -h * 0.05 + px * 0.04);
  } else if (kind === 'shout') {
    const jitter = (k) => Math.sin(u * 40 + k) * h * 0.012;
    ctx.beginPath();
    for (let k = 0; k < 22; k++) {
      const a = (k / 22) * Math.PI * 2;
      const r = k % 2 ? 0.36 : 0.5;
      const x = Math.cos(a) * w * r + jitter(k);
      const y = Math.sin(a) * h * r * 0.95 + jitter(k + 9);
      if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = '#FFE14D'; ctx.fill();
    ctx.lineWidth = h * 0.045; ctx.strokeStyle = '#E5242B'; ctx.stroke();
    const px = fitText(ctx, f.text || 'YES!', w * 0.6, h * 0.3);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = px * 0.16; ctx.strokeStyle = '#fff'; ctx.strokeText(f.text || 'YES!', 0, px * 0.04);
    ctx.fillStyle = '#E5242B'; ctx.fillText(f.text || 'YES!', 0, px * 0.04);
  } else if (kind === 'burst') {
    ctx.save();
    ctx.rotate(u * 0.6);
    ctx.scale(w / h, 1);
    star(ctx, 14, h * 0.5, h * 0.4);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, h * 0.5);
    g.addColorStop(0, '#FFE873'); g.addColorStop(1, '#FF8A1F');
    ctx.fillStyle = g; ctx.fill();
    ctx.lineWidth = h * 0.03; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.restore();
    const px = fitText(ctx, f.text || 'NEW!', w * 0.6, h * 0.26);
    ctx.save(); ctx.rotate(-0.12);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#B4161B'; ctx.fillText(f.text || 'NEW!', 0, px * 0.04);
    ctx.restore();
  } else if (kind === 'arrow') {
    ctx.translate(Math.sin(u * Math.PI * 3.2) * w * 0.07, 0);
    ctx.beginPath();
    ctx.moveTo(-w * 0.45, -h * 0.13); ctx.lineTo(w * 0.08, -h * 0.13); ctx.lineTo(w * 0.08, -h * 0.34);
    ctx.lineTo(w * 0.46, 0); ctx.lineTo(w * 0.08, h * 0.34); ctx.lineTo(w * 0.08, h * 0.13); ctx.lineTo(-w * 0.45, h * 0.13);
    ctx.closePath();
    ctx.lineWidth = h * 0.07; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.fillStyle = funGradient(ctx, w); ctx.fill();
  } else if (kind === 'circle') {
    // A hand-drawn ring that draws itself on, then stays.
    const p = Math.min(1, u / 0.6);
    const ease = 1 - (1 - p) ** 3;
    ctx.beginPath();
    const turns = 1.08 * ease;
    for (let k = 0; k <= 60; k++) {
      const a = -2.2 + (k / 60) * turns * Math.PI * 2;
      const wob = 1 + 0.03 * Math.sin(a * 3) + 0.04 * (k / 60);
      const x = Math.cos(a) * w * 0.45 * wob;
      const y = Math.sin(a) * h * 0.4 * wob;
      if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.lineWidth = h * 0.06; ctx.strokeStyle = '#FF2D55'; ctx.stroke();
  } else if (kind === 'sparkles') {
    const spots = [[-0.22, -0.12, 0.5, 0], [0.24, -0.26, 0.32, 1.3], [0.18, 0.24, 0.38, 2.4], [-0.3, 0.3, 0.22, 3.6]];
    for (const [x, y, r, ph] of spots) {
      const s = 0.55 + 0.45 * Math.abs(Math.sin(u * 2.6 + ph));
      ctx.save(); ctx.translate(x * h, y * h); ctx.rotate(u * 0.8 + ph); ctx.scale(s, s);
      star(ctx, 4, h * r * 0.5, h * r * 0.13);
      ctx.fillStyle = ph > 2 ? '#FFFFFF' : '#FFE14D'; ctx.fill();
      ctx.restore();
    }
  } else if (kind === 'hearts') {
    for (let k = 0; k < 6; k++) {
      const period = 2.2;
      const t = ((u + rnd(k) * period) % period) / period;
      const x = (rnd(k + 10) - 0.5) * h * 0.7 + Math.sin(t * 6 + k) * h * 0.06;
      const y = h * 0.42 - t * h * 0.9;
      const s = (0.12 + rnd(k + 20) * 0.1) * h * (0.6 + 0.4 * Math.sin(Math.min(1, t * 4) * Math.PI / 2));
      ctx.save(); ctx.globalAlpha *= t < 0.75 ? 1 : (1 - t) / 0.25; ctx.translate(x, y);
      ctx.beginPath();
      ctx.moveTo(0, s * 0.35);
      ctx.bezierCurveTo(-s, -s * 0.25, -s * 0.45, -s * 0.95, 0, -s * 0.45);
      ctx.bezierCurveTo(s * 0.45, -s * 0.95, s, -s * 0.25, 0, s * 0.35);
      ctx.fillStyle = k % 3 ? '#FF3B6B' : '#FF7AB6'; ctx.fill();
      ctx.restore();
    }
  } else if (kind === 'confetti') {
    const colours = ['#FFE14D', '#FF3B6B', '#5CE1E6', '#8B5CF6', '#7CFF6B', '#FF8A1F'];
    const t = u % 2.6;
    for (let k = 0; k < 34; k++) {
      const a = rnd(k) * Math.PI * 2;
      const v = (0.35 + rnd(k + 50) * 0.5) * h;
      const x = Math.cos(a) * v * Math.min(1, t * 2.4) + Math.sin(t * 3 + k) * h * 0.03;
      const y = Math.sin(a) * v * Math.min(1, t * 2.4) * 0.6 + t * t * h * 0.22;
      ctx.save(); ctx.globalAlpha *= Math.max(0, 1 - Math.max(0, t - 1.8) / 0.8);
      ctx.translate(x, y); ctx.rotate(t * 6 + k);
      ctx.fillStyle = colours[k % colours.length];
      ctx.fillRect(-h * 0.025, -h * 0.012, h * 0.05, h * 0.024);
      ctx.restore();
    }
  } else if (kind === 'subscribe') {
    const clicked = (u % 3.2) > 1.2;
    const bw = w * 0.86;
    const bh = h * 0.42;
    roundRect(ctx, -bw / 2, -bh / 2, bw, bh, bh / 2);
    ctx.fillStyle = clicked ? '#5A5A62' : '#E5242B'; ctx.fill();
    const label = clicked ? 'SUBSCRIBED' : 'SUBSCRIBE';
    const px = fitText(ctx, label, bw * 0.62, bh * 0.42);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
    ctx.fillText(label, bw * 0.08, px * 0.05);
    // play / bell icon on the left
    ctx.save(); ctx.translate(-bw * 0.36, 0);
    if (clicked) {
      ctx.rotate(Math.sin(u * 18) * 0.25 * Math.max(0, 1 - ((u % 3.2) - 1.2)));
      ctx.beginPath(); ctx.arc(0, -bh * 0.04, bh * 0.2, Math.PI, 0); ctx.lineTo(bh * 0.24, bh * 0.16); ctx.lineTo(-bh * 0.24, bh * 0.16); ctx.closePath();
      ctx.fillStyle = '#fff'; ctx.fill();
    } else {
      ctx.beginPath(); ctx.moveTo(-bh * 0.12, -bh * 0.16); ctx.lineTo(bh * 0.18, 0); ctx.lineTo(-bh * 0.12, bh * 0.16); ctx.closePath();
      ctx.fillStyle = '#fff'; ctx.fill();
    }
    ctx.restore();
    // a pointer comes in and clicks
    const pt = Math.min(1, (u % 3.2) / 1.1);
    const press = (u % 3.2) > 1.1 && (u % 3.2) < 1.35 ? 0.85 : 1;
    ctx.save();
    ctx.translate(w * 0.5 - pt * w * 0.32, h * 0.5 - pt * h * 0.42); ctx.scale(press, press);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, h * 0.3); ctx.lineTo(h * 0.08, h * 0.22); ctx.lineTo(h * 0.14, h * 0.34);
    ctx.lineTo(h * 0.19, h * 0.31); ctx.lineTo(h * 0.13, h * 0.2); ctx.lineTo(h * 0.23, h * 0.2); ctx.closePath();
    ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = h * 0.02; ctx.strokeStyle = '#111'; ctx.stroke();
    ctx.restore();
  } else if (kind === 'loading') {
    const bw = w * 0.9;
    const bh = h * 0.26;
    const p = (u % 2.4) / 2;
    roundRect(ctx, -bw / 2, -bh / 2, bw, bh, bh / 2);
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fill();
    ctx.lineWidth = h * 0.03; ctx.strokeStyle = '#fff'; ctx.stroke();
    const fill = Math.min(1, p) * (bw - bh * 0.3);
    if (fill > 1) { roundRect(ctx, -bw / 2 + bh * 0.15, -bh / 2 + bh * 0.15, Math.max(bh * 0.7, fill), bh * 0.7, bh * 0.35); ctx.fillStyle = funGradient(ctx, bw); ctx.fill(); }
    const dots = '.'.repeat(1 + Math.floor((u * 3) % 3));
    ctx.font = funFont(h * 0.2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = h * 0.05; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.strokeText(`Loading${dots}`, 0, -h * 0.3);
    ctx.fillStyle = '#fff'; ctx.fillText(`Loading${dots}`, 0, -h * 0.3);
  }
}

function drawSticker(ctx, W, H, s, u) {
  if (s.effect) return; // blur and pixelate boxes change the video itself, not this layer
  let scale = s.anim && s.anim !== 'none' ? 0.3 + 0.7 * easeOutBack(Math.min(1, u / STICKER_INTRO)) : 1;
  let rot = s.rotate || 0;
  let dy = 0;
  if (s.anim === 'bounce') dy = -Math.abs(Math.sin(u * Math.PI * 2.2)) * 0.06 * H;
  if (s.anim === 'wiggle') rot += Math.sin(u * Math.PI * 4) * 12;
  if (s.anim === 'spin') rot += u * 180;
  if (s.anim === 'pulse') scale *= 1 + 0.08 * Math.sin(u * Math.PI * 3.2);
  const size = s.size * H;
  ctx.save();
  ctx.translate(s.x * W, s.y * H + dy);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.scale(scale, scale);
  if (s.fun) {
    drawFun(ctx, s.fun, size, u);
  } else if (s.gif) {
    const e = gifStore.get(s.gif.src);
    const bmp = e && e.frames ? gifFrameAt(e, u) : null;
    const w = size * stickerAspect(s);
    if (bmp) ctx.drawImage(bmp, -w / 2, -size / 2, w, size);
  } else {
    ctx.font = `${size}px ${EMOJI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.emoji, 0, size * 0.04);
  }
  ctx.restore();
}

function drawCaptions(ctx, W, H, texts, t, stickers = []) {
  ctx.clearRect(0, 0, W, H);
  captionHits.length = 0;
  // Stickers sit under the captions, so a sticker never hides the words.
  for (const s of stickers) {
    if (t >= s.start && t < s.start + s.dur) drawSticker(ctx, W, H, { ...s, ...kfValue(s, 'sticker', t - s.start) }, t - s.start);
  }
  for (const x of texts) {
    if (t < x.start || t >= x.start + x.dur || !x.text.trim()) continue;
    drawCaption(ctx, W, H, x, t - x.start);
  }
}

// The times at which the caption picture changes: starts and ends, each frame
// of an intro animation, and each word switch. Between two of these the
// picture is still, so export only needs one image per stretch.
function captionChangePoints(texts, total, fps, stickers = []) {
  const snap = (v) => Math.round(v * fps) / fps;
  const pts = new Set([0, snap(total)]);
  for (const s of stickers) {
    if (s.effect) continue;
    pts.add(snap(s.start));
    pts.add(snap(s.start + s.dur));
    // A looping animation changes every frame; the others only during the pop-in.
    const moving = LOOPING.has(s.anim) || hasMotion(s) || s.fun || (s.gif && (gifStore.get(s.gif.src) || {}).frames?.length > 1);
    const frames = moving ? Math.ceil(s.dur * fps) : s.anim && s.anim !== 'none' ? Math.ceil(STICKER_INTRO * fps) : 0;
    for (let k = 1; k <= frames; k++) pts.add(snap(s.start + k / fps));
  }
  for (const x of texts) {
    const s = x.start;
    pts.add(snap(s));
    pts.add(snap(s + x.dur));
    if (hasMotion(x)) for (let k = 1; k <= Math.ceil(x.dur * fps); k++) pts.add(snap(s + k / fps));
    const a = ANIMS[x.anim];
    if (a) for (let k = 1; k <= Math.ceil(a * fps); k++) pts.add(snap(s + k / fps));
    const wfx = x.wordFx && x.wordFx !== 'none' ? x.wordFx : null;
    if (x.highlight || wfx || x.emoji) for (const w of wordStarts(x)) pts.add(snap(s + w));
    // Word animations change for a few frames after each word starts; karaoke changes all the time.
    if (wfx === 'karaoke') for (let k = 1; k <= Math.ceil(x.dur * fps); k++) pts.add(snap(s + k / fps));
    else if (wfx || x.emoji) {
      const win = wfx === 'bounce' ? 0.3 : 0.22;
      for (const w of wordStarts(x)) for (let k = 1; k <= Math.ceil(win * fps); k++) pts.add(snap(s + w + k / fps));
    }
    if (x.anim === 'typewriter') {
      const n = captionWords(x).flat().join('').length;
      for (let k = 1; k <= n; k++) pts.add(snap(s + k * typeRate(x)));
    }
  }
  return [...pts].filter((p) => p >= 0 && p <= snap(total)).sort((a, b) => a - b);
}
