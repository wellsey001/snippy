'use strict';

(function (root) {

// Finding Shorts in a long video: the transcript is split into sentences, and every run of
// whole sentences that's the right length is scored on what makes a short clip work on its
// own: an opening line that grabs you, a finished thought, a lively pace and voice, and few
// pauses or fillers. The best runs that don't overlap are suggested. Pure maths and text, so it
// runs in the editor and in tests alike.

const HOOK_START = /^(why|how|what|when|who|stop|never|nobody|no one|everyone|everybody|the (secret|truth|problem|reason|best|worst|biggest|one thing|only)|here'?s|this is (why|how|what|the)|you (need|should|won'?t|have to|can'?t|don'?t|will)|i (can'?t believe|never|almost|wish|used to|quit|lost|made|tried)|if you|did you know|imagine|don'?t|do not|there'?s (a|no|one)|most people|the (first|last|real)|let me (tell|show)|watch|look)\b/i;
const WEAK_START = /^(and|but|so|because|cause|which|that'?s why|then|also|or|um+|uh+|er+m?|like|yeah|yes|no|okay|ok|right|well|anyway|exactly|mm+)\b/i;
const NEEDS_CONTEXT = /^(it|this|that|they|he|she|those|these|there|him|her|them)\b/i;
const STRONG = /\b(never|always|best|worst|biggest|crazy|insane|secret|mistake|actually|literally|love|hate|money|free|million|thousand|shock\w*|truth|wrong|wow|amazing|incredible|honestly|seriously|terrible|perfect|huge|everything|nothing|dead|died|scared|funny|hilarious|ridiculous|massive|unbelievable)\b/gi;
const FILLER = /\b(um+|uh+|erm+|er|you know|i mean|kind of|sort of)\b/gi;
const LAUGH = /\b(ha(ha)+|lol|laugh\w*)\b/gi;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const countOf = (re, s) => (s.match(re) || []).length;
const smooth = (x, lo, hi) => clamp((x - lo) / (hi - lo), 0, 1);

// Caption groups from the speech model ([{ start, end, text, words: [{ text, s, e }] }] with word
// times relative to the group) -> one flat list of words with times in seconds.
function flattenWords(groups) {
  const out = [];
  for (const g of groups) {
    if (g.words && g.words.length) {
      for (const w of g.words) out.push({ text: w.text, s: g.start + w.s, e: g.start + w.e });
    } else {
      const parts = g.text.split(/\s+/).filter(Boolean);
      const d = (g.end - g.start) / Math.max(1, parts.length);
      parts.forEach((p, i) => out.push({ text: p, s: g.start + i * d, e: g.start + (i + 1) * d }));
    }
  }
  out.sort((a, b) => a.s - b.s);
  return out;
}

// Words -> sentences, at full stops and question marks, or a long pause.
function sentencesOf(words, { pause = 0.9 } = {}) {
  const out = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ s: cur[0].s, e: cur[cur.length - 1].e, words: cur, text: cur.map((w) => w.text).join(' ').replace(/\s+([,.!?])/g, '$1') });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && w.s - prev.e > pause) flush();
    cur.push(w);
    if (/[.!?]["')\]]?$/.test(w.text) && !/^(mr|mrs|ms|dr|st|vs|etc)\.$/i.test(w.text)) flush();
  }
  flush();
  return out;
}

// How loud and lively the voice is over [a, b], compared with the whole video.
// levels: loudness every `hop` seconds (any scale); returns 0..1.
function energyScore(levels, hop, a, b, ref) {
  if (!levels || !levels.length || !ref) return 0.5;
  const i0 = Math.max(0, Math.floor(a / hop));
  const i1 = Math.min(levels.length, Math.ceil(b / hop));
  if (i1 - i0 < 4) return 0.5;
  let sum = 0;
  let sq = 0;
  for (let i = i0; i < i1; i++) { sum += levels[i]; sq += levels[i] * levels[i]; }
  const n = i1 - i0;
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
  // Louder than usual, and more up-and-down (laughing, raised voices), scores higher.
  return clamp(0.5 * smooth(mean / ref.mean, 0.7, 1.4) + 0.5 * smooth(sd / Math.max(1e-6, ref.sd), 0.7, 1.5), 0, 1);
}

function levelStats(levels) {
  if (!levels || !levels.length) return null;
  const loud = levels.filter((v) => v > 0.002);
  if (!loud.length) return null;
  const mean = loud.reduce((s, v) => s + v, 0) / loud.length;
  const sd = Math.sqrt(loud.reduce((s, v) => s + (v - mean) * (v - mean), 0) / loud.length);
  return { mean, sd };
}

function hookOf(text) {
  const t = text.trim().replace(/^["'“]/, '');
  const words = t.split(/\s+/).length;
  let h = 0.25;
  const why = [];
  if (HOOK_START.test(t)) { h += 0.45; why.push('Strong opening line'); }
  if (/\?$/.test(t)) { h += 0.3; if (!why.length) why.push('Opens with a question'); }
  if (/\b\d+\b|\b(one|two|three|five|ten|hundred)\b/i.test(t)) h += 0.1;
  if (countOf(STRONG, t)) h += 0.1;
  if (words <= 14) h += 0.1;
  else if (words > 28) h -= 0.15;
  if (WEAK_START.test(t)) { h -= 0.55; why.push('starts mid-thought'); }
  else if (NEEDS_CONTEXT.test(t)) h -= 0.25;
  return { score: clamp(h, 0, 1), why };
}

// Scores sentences[i..j] as a Short.
function scoreRun(sents, i, j, ctx) {
  const first = sents[i];
  const last = sents[j];
  const a = first.s;
  const b = last.e;
  const dur = b - a;
  const words = [];
  for (let k = i; k <= j; k++) words.push(...sents[k].words);
  const text = sents.slice(i, j + 1).map((x) => x.text).join(' ');
  const reasons = [];
  const warn = [];

  const hook = hookOf(first.text);
  if (hook.why.length && hook.score >= 0.6) reasons.push(hook.why[0]);
  if (hook.score < 0.25) warn.push('Starts mid-thought');

  const ends = /[.!?]["')\]]?$/.test(last.words[last.words.length - 1].text);
  // "Right, okay." or "Um, what else." isn't an ending, it's the talk moving on.
  const trailing = last.words.length <= 4 && WEAK_START.test(last.text);
  const ending = trailing ? 0.05 : (ends ? 0.75 : 0.25) + (last.words.length <= 9 ? 0.25 : 0);
  if (ends && !trailing && last.words.length <= 9) reasons.push('Ends on a punchline');
  else if (!ends) warn.push('Ends mid-sentence');

  const wps = words.length / Math.max(1, dur);
  const pace = wps < 1.4 ? smooth(wps, 0.6, 1.4) * 0.6 : wps <= 4 ? 1 : 1 - smooth(wps, 4, 5.5) * 0.4;
  if (wps >= 2.4 && wps <= 4) reasons.push('Quick, steady talking');

  let gaps = 0;
  for (let k = 1; k < words.length; k++) gaps += Math.max(0, words[k].s - words[k - 1].e - 0.35);
  const flow = 1 - smooth(gaps / dur, 0.05, 0.35);
  if (gaps / dur > 0.25) warn.push('Lots of pauses');

  const perMin = (countOf(STRONG, text) + 2 * countOf(LAUGH, text) + countOf(/!/g, text)) / (dur / 60);
  const punch = smooth(perMin, 1, 10);
  if (perMin >= 6) reasons.push('Strong, emotional words');

  const fillers = countOf(FILLER, text) / Math.max(1, words.length);
  const clean = 1 - smooth(fillers, 0.01, 0.08);
  if (fillers > 0.05) warn.push('Quite a few “um”s');

  const energy = energyScore(ctx.levels, ctx.hop, a, b, ctx.ref);
  if (energy >= 0.7) reasons.push('Lively voice');

  // Closer to the middle of the chosen length is a little better.
  const fit = 1 - Math.abs(dur - (ctx.min + ctx.max) / 2) / ((ctx.max - ctx.min) / 2 + 1e-6) * 0.3;

  const score = 0.3 * hook.score + 0.14 * ending + 0.12 * pace + 0.1 * flow + 0.12 * punch + 0.06 * clean + 0.12 * energy + 0.04 * fit;
  return { a, b, dur, score, reasons: [...new Set(reasons)], warn, title: titleOf(first.text), text, i, j };
}

function titleOf(text) {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > 80 ? `${t.slice(0, 77).replace(/\s+\S*$/, '')}…` : t;
}

// The best Shorts in a transcript.
// opts: { min, max (seconds), count, levels, hop, gap (seconds kept between picks) }.
// Returns picks in time order: { a, b, dur, score (0..100), reasons, warn, title, text }, where
// a and b leave a little room before the first word and after the last.
function findShorts(groups, opts = {}) {
  const { min = 20, max = 45, count = 5, levels = null, hop = 0.05, gap = 1, duration = Infinity } = opts;
  const words = flattenWords(groups);
  const sents = sentencesOf(words);
  const ctx = { levels, hop, ref: levelStats(levels), min, max };
  const runs = [];
  for (let i = 0; i < sents.length; i++) {
    for (let j = i; j < sents.length; j++) {
      const dur = sents[j].e - sents[i].s;
      if (dur > max || sents[j].e > duration + 0.5) break;
      if (dur >= min) runs.push(scoreRun(sents, i, j, ctx));
    }
  }
  // If nothing is long enough (a short video, or one long sentence), take what there is.
  if (!runs.length && sents.length) runs.push(scoreRun(sents, 0, sents.length - 1, ctx));
  runs.sort((x, y) => y.score - x.score);
  const picked = [];
  for (const r of runs) {
    if (picked.length >= count) break;
    if (r.dur < min * 0.6 && picked.length) continue; // a scrap at the very end isn't worth it
    if (picked.some((p) => r.a < p.b + gap && r.b > p.a - gap)) continue;
    picked.push(r);
  }
  picked.sort((x, y) => x.a - y.a);
  return picked.map((p) => {
    const before = p.i > 0 ? sents[p.i - 1].e : 0;
    const after = p.j < sents.length - 1 ? sents[p.j + 1].s : duration;
    return {
      a: Number(Math.max(before, p.a - 0.2, 0).toFixed(3)),
      b: Number(Math.min(after, p.b + 0.4, duration).toFixed(3)),
      dur: p.dur,
      score: Math.round(p.score * 100),
      reasons: p.reasons,
      warn: p.warn,
      title: p.title,
      text: p.text,
      first: p.i,
      last: p.j,
    };
  });
}

// The parts of [a, b] to keep when the pauses between words are cut (gaps over `pause` seconds,
// keeping `pad` either side), and the words inside it on the new, shorter timeline.
function tightenRange(words, a, b, { pause = 0.6, pad = 0.15, tighten = true } = {}) {
  const inside = words.filter((w) => w.e > a && w.s < b);
  let keep = [{ s: a, e: b }];
  if (tighten && inside.length > 1) {
    keep = [];
    let s = a;
    for (let k = 1; k < inside.length; k++) {
      const g0 = inside[k - 1].e;
      const g1 = inside[k].s;
      if (g1 - g0 > pause) {
        keep.push({ s, e: g0 + pad });
        s = g1 - pad;
      }
    }
    keep.push({ s, e: b });
    keep = keep.filter((r) => r.e - r.s > 0.1);
  }
  // Source time -> new timeline time.
  const offsets = [];
  let t = 0;
  for (const r of keep) { offsets.push(t); t += r.e - r.s; }
  const map = (x) => {
    for (let k = 0; k < keep.length; k++) {
      if (x <= keep[k].e) return offsets[k] + clamp(x - keep[k].s, 0, keep[k].e - keep[k].s);
    }
    return t;
  };
  return { keep, length: t, words: inside.map((w) => ({ text: w.text, s: map(Math.max(a, w.s)), e: map(Math.min(b, w.e)) })) };
}

// Words (already on the Short's timeline) -> captions of up to maxWords, like the caption maker.
function captionGroups(words, maxWords = 4) {
  const groups = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    const start = cur[0].s;
    groups.push({ start, end: cur[cur.length - 1].e, text: cur.map((w) => w.text).join(' '), words: cur.map((w) => ({ text: w.text, s: w.s - start, e: w.e - start })) });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (cur.length >= maxWords || w.s - prev.e > 0.7 || /[.!?]$/.test(prev.text))) flush();
    cur.push(w);
  }
  flush();
  groups.forEach((g, i) => {
    const next = groups[i + 1];
    g.end = Math.max(g.end, Math.min(g.end + 0.25, next ? next.start : g.end + 0.25));
  });
  return groups;
}

const api = { findShorts, flattenWords, sentencesOf, tightenRange, captionGroups, hookOf };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else Object.assign(root, api);
}(typeof window !== 'undefined' ? window : globalThis));
