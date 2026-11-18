'use strict';

// Reading an AutoCut request typed in plain words, such as
//   "30 seconds, fast, start with the sunset, lots of the dog, no shots of the car,
//    end where he says 'see you next time'"
// into settings (length, pace, style, order, slow motion, sound, a title) and things to look for:
// what to show more of, what to leave out, what to open and end on, and words someone says.
// Pure text handling, so it runs in the editor and in tests alike.

(function (root) {
  const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90, half: 0.5 };
  const num = (w) => (w in NUM_WORDS ? NUM_WORDS[w] : Number(w));

  const STYLE_WORDS = [
    ['Energetic', /\b(fast|quick|energetic|hype|hyped|punchy|upbeat|exciting|intense|action|dynamic|lively|high energy|tiktok)\b/],
    ['Cinematic', /\b(cinematic|film|movie|epic|dramatic|moody|trailer)\b/],
    ['Memories', /\b(memories|memory|nostalgic|nostalgia|vintage|old|retro|throwback|sentimental|emotional)\b/],
    ['Smooth', /\b(smooth|calm|chill|relaxed|relaxing|slow|gentle|soft|peaceful|easy)\b/],
  ];

  // Little words that carry no meaning of their own when looking for things in the picture.
  const FILLER = /^(and|also|then|plus|please|i want|i'd like|i would like|make it|make|use|with|include|including|some|a few|lots of|plenty of|loads of|more of|more|mostly|mainly|focus on|focusing on|show|showing|the|a|an|of|my|our|video|clip|clips|shots?|footage|bits?|parts?|scenes?|moments?)\s+/i;

  const clean = (s) => {
    let t = s.trim().replace(/^[\s,;.:-]+|[\s,;.:!-]+$/g, '');
    let prev;
    do { prev = t; t = t.replace(FILLER, '').replace(/\s+(shots?|footage|bits?|parts?|scenes?|moments?|clips?|please)$/i, ''); } while (t !== prev);
    return t.trim();
  };

  function parsePrompt(text) {
    const out = { length: null, style: null, order: null, slowmo: null, sound: null, title: null, want: [], avoid: [], start: [], end: [], only: false, says: [], understood: [] };
    if (!text || !text.trim()) return out;
    let t = ` ${text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")} `;

    // A title: title "Summer 2026" (or title: Summer 2026, up to the next comma).
    t = t.replace(/(?:\b(?:add|put|use|show|include|with|and)\s+(?:a\s+|an\s+|the\s+)?)?\b(?:title|called|named)\s*(?:is|of|:)?\s*"([^"]{1,60})"/i, (_, x) => { out.title = x.trim(); return ' '; });
    t = t.replace(/(?:\b(?:add|put|use|show|include|with)\s+)?"([^"]{1,60})"\s+as\s+(?:a\s+|the\s+)?title\b/i, (_, x) => { out.title = x.trim(); return ' '; });
    t = t.replace(/\btitle\s*:\s*([^,.;\n]{1,60})/i, (_, x) => { out.title = x.trim(); return ' '; });
    if (out.title) out.understood.push(`Title "${out.title}"`);

    // Words someone says, in quotes: "where he says 'thank you'", "end on 'see you next time'".
    // (Single quotes only count around a phrase, so "don't" and "it's" are left alone.)
    const quoteRe = /"([^"]{2,80})"|(^|[\s(])'([^']{2,80})'(?=[\s,.;!?)]|$)/g;
    const quoted = [];
    let m;
    let rest = '';
    let last = 0;
    while ((m = quoteRe.exec(t))) {
      const phrase = (m[1] || m[3]).trim();
      const before = t.slice(last, m.index);
      const lead = before.split(/[,;.\n]/).pop();
      const w = lead.toLowerCase();
      quoted.push({ p: phrase, where: /\b(start|open|begin)/.test(w) ? 'start' : /\b(end|finish|close)/.test(w) ? 'end' : null });
      rest += before.slice(0, before.length - lead.length) + ' ';
      last = m.index + m[0].length;
    }
    t = rest + t.slice(last);
    for (const q of quoted) {
      out.says.push(q);
      out.understood.push(`${q.where === 'start' ? 'Open on' : q.where === 'end' ? 'End on' : 'Include'} the moment someone says "${q.p}"`);
    }

    const low = t.toLowerCase();
    // Length: "30 seconds", "a minute", "1:30", "half a minute", "under 20s".
    const mmss = low.match(/\b(\d{1,2}):(\d{2})\b/);
    const lenM = low.match(/\b(\d+(?:\.\d+)?|a|an|one|two|three|four|five|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety|half)\s*(?:a\s+)?(seconds?|secs?|s|minutes?|mins?|m)\b/);
    if (mmss) out.length = Number(mmss[1]) * 60 + Number(mmss[2]);
    else if (lenM) {
      const v = num(lenM[1]);
      out.length = /^m/.test(lenM[2]) ? v * 60 : v;
    }
    if (out.length != null) {
      out.length = Math.max(5, Math.min(300, Math.round(out.length)));
      out.understood.push(`About ${out.length >= 60 && out.length % 60 === 0 ? `${out.length / 60} minute${out.length === 60 ? '' : 's'}` : `${out.length} seconds`} long`);
    }
    for (const [name, re] of STYLE_WORDS) {
      if (re.test(low.replace(/slow[ -]?mo(?:tion)?/g, ''))) { out.style = name; out.understood.push(`${name} style first`); break; }
    }
    if (/\b(in order|chronological|chronologically|as it happened|in sequence|story order|start to finish)\b/.test(low)) { out.order = 'story'; out.understood.push('Shots in the order they happened'); }
    else if (/\b(mix(ed)? (it )?up|shuffle|random order|jump around)\b/.test(low)) { out.order = 'mix'; out.understood.push('Shots mixed up'); }
    if (/\b(no|without|not|skip|avoid) (any )?slow[ -]?mo(tion)?\b/.test(low)) { out.slowmo = false; out.understood.push('No slow motion'); }
    else if (/\bslow[ -]?mo(tion)?\b/.test(low)) { out.slowmo = true; out.understood.push('Slow motion'); }
    if (/\b(original|real|their own|own|clips?'?) (sound|audio)\b|\bkeep the (sound|audio)\b|\bno music\b/.test(low)) { out.sound = 'clip'; out.understood.push('The clips’ own sound, no music'); }
    else if (/\b(no sound|mute|silent)\b/.test(low)) { out.sound = 'none'; out.understood.push('No sound from the clips'); }

    // What to look for: split into phrases, then sort by the words in front of them.
    const settingsWords = /\bkeep( the)? (original |real |clips?'? )?(sound|audio)\b|\b(about|around|roughly|approximately|under|over|at most|max(imum)?|no more than|less than)\b|\b\d+(\.\d+)?\s*(s|m)\b|\b(\d+(\.\d+)?|a|an|one|two|three|four|five|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety|half)\s*(a\s+)?(seconds?|secs?|minutes?|mins?)\s*(long)?\b|\b\d{1,2}:\d{2}\b|\b(fast|quick|energetic|hype|hyped|punchy|upbeat|exciting|intense|dynamic|lively|high energy|cinematic|film|movie|epic|dramatic|moody|trailer|memories|nostalgic|vintage|retro|throwback|sentimental|emotional|smooth|calm|chill|relaxed|relaxing|gentle|peaceful|style|vibe|feel|pace|paced|edit|cut|montage|tiktok|reel|short)\b|\b(in order|chronological(ly)?|as it happened|in sequence|story order|start to finish|mix(ed)? (it )?up|shuffle|random order|jump around)\b|\b(no |without |not |skip |avoid )?(any )?slow[ -]?mo(tion)?\b|\b(original|real|their own|own|clips?'?) (sound|audio)\b|\bkeep the (sound|audio)\b|\bno music\b|\bno sound\b|\bmute\b|\bsilent\b/gi;
    const parts = t.replace(settingsWords, ' ')
      .split(/[,;.\n]|\s+(?:and then|then|but|and also|also|plus|and|or|&)\s+/i)
      .map((x) => x.trim()).filter(Boolean);
    for (let p of parts) {
      let kind = 'want';
      const lowP = p.toLowerCase();
      if (/^(no|not|without|skip|avoid|leave out|cut out|don'?t (show|include|use)|exclude|nothing with|none of)\b/.test(lowP)) {
        kind = 'avoid';
        p = p.replace(/^(no|not|without|skip|avoid|leave out|cut out|don'?t (show|include|use)|exclude|nothing with|none of)\s+(any\s+|the\s+)?/i, '');
      } else if (/^(start|open|begin)\s+(with|on)\b/.test(lowP)) {
        kind = 'start';
        p = p.replace(/^(start|open|begin)\s+(with|on)\s+/i, '');
      } else if (/^(end|finish|close)\s+(with|on)\b/.test(lowP)) {
        kind = 'end';
        p = p.replace(/^(end|finish|close)\s+(with|on)\s+/i, '');
      } else if (/^(only|just)\b/.test(lowP)) {
        out.only = true;
        p = p.replace(/^(only|just)\s+(show\s+|use\s+)?/i, '');
      }
      p = clean(clean(p).replace(/^(where|when|while|as)\s+(he|she|they|i|we|you|it|someone|people)?\s*('s|is|are|was|were)?\s*(talks?|talking|says?|saying|speaks?|speaking|mentions?|discuss(es)?|goes on)?\s*(about|on)?\s*/i, '')).replace(/\s{2,}/g, ' ');
      if (/^(it'?s|it is|that'?s|they'?re|i think|because|so it|which)\b/i.test(p)) continue; // a remark, not something to find
      if (p.length < 2 || /^(it|this|that|them|those|these|one|ones|stuff|things?|long|good|best|nice)$/i.test(p)) continue;
      out[kind].push(p);
    }
    for (const p of out.want) out.understood.push(`${out.only ? 'Only' : 'More of'}: ${p}`);
    for (const p of out.avoid) out.understood.push(`Leave out: ${p}`);
    for (const p of out.start) out.understood.push(`Open on: ${p}`);
    for (const p of out.end) out.understood.push(`End on: ${p}`);
    return out;
  }

  // Does the prompt need Snippy to look at the pictures, or listen to what's said?
  const needsLooking = (p) => p.want.length + p.avoid.length + p.start.length + p.end.length > 0;
  const needsListening = (p) => p.says.length > 0;

  // Words → a loose match: lower case, no punctuation, simple endings dropped.
  const stem = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, '').replace(/'s$/, '').replace(/(ing|ed|es|s)$/, '');
  // Where a phrase is said in a list of timed words ([{ text, s, e }]): [{ s, e }] for each time.
  function findSaid(words, phrase) {
    const want = phrase.split(/\s+/).map(stem).filter(Boolean);
    if (!want.length) return [];
    const hits = [];
    const ws = words.map((w) => ({ ...w, k: stem(w.text) }));
    for (let i = 0; i < ws.length; i++) {
      if (ws[i].k !== want[0]) continue;
      // All the words, in order, allowing one extra word between each (speech models add the odd "the").
      let j = i;
      let ok = true;
      for (let n = 1; n < want.length; n++) {
        let found = -1;
        for (let k = j + 1; k <= Math.min(ws.length - 1, j + 2); k++) if (ws[k].k === want[n]) { found = k; break; }
        if (found < 0) { ok = false; break; }
        j = found;
      }
      if (ok) hits.push({ s: ws[i].s, e: ws[j].e });
    }
    return hits;
  }

  // How much a sentence is about the topics asked for (shared words), 0 when it's unrelated.
  const STOP = new Set(['he', 'she', 'they', 'i', 'we', 'you', 'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'is', 'it', 'that', 'this', 'with', 'about', 'my', 'your', 'our', 'their', 'when', 'where', 'part', 'bit', 'talk', 'talking', 'say', 'says']);
  function topicScore(sentence, topics) {
    const words = new Set(sentence.split(/\s+/).map(stem).filter((w) => w && !STOP.has(w)));
    let score = 0;
    for (const tp of topics) {
      const tw = tp.split(/\s+/).map(stem).filter((w) => w && !STOP.has(w));
      if (!tw.length) continue;
      const hit = tw.filter((w) => words.has(w)).length / tw.length;
      score = Math.max(score, hit);
    }
    return score;
  }

  const api = { parsePrompt, needsLooking, needsListening, findSaid, topicScore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
}(typeof window !== 'undefined' ? window : globalThis));
