'use strict';
// AutoCut: pick clips and a song; Snippy finds the liveliest moments and cuts them to the beat.

const AC_STYLES = {
  Energetic: { pattern: [2], trans: [['none', 0], ['none', 0], ['none', 0], ['zoom', 0.3]], look: 'punch', mix: true, fx: 'beatzoom', fxK: 0.35 },
  Smooth: { pattern: [4], trans: [['fade', 0.5]], look: 'warm', mix: true },
  Cinematic: { pattern: [4, 8], trans: [['dip', 0.7], ['fade', 0.8]], look: 'faded', mix: false, endFade: 1 },
  Memories: { pattern: [4], trans: [['fade', 0.8]], look: 'vintage', mix: false, endFade: 1 },
};
const CUT_LEAD = 1 / 30; // cuts land a frame early: the eye is a touch slower than the ear

Sheets.autocut = function autocut(fromHome = false) {
  const p = fromHome ? null : App.p;
  const st = {
    picks: p ? [...new Set(p.clips.map((c) => c.mediaId))] : [],
    song: null,
    style: 'Energetic',
    len: 'song',
    prompt: '',
  };
  try { st.prompt = localStorage.getItem('snippy.acPrompt') || ''; } catch { /* none */ }
  let pool = st.picks.map(Media.get).filter(Boolean);
  if (p) { const s = p.audio[0] && Media.get(p.audio[0].mediaId); if (s) st.song = s; }
  openSheet('AutoCut', (b) => {
    const list = h('div', { class: 'pick-list' });
    const drawPicks = () => {
      list.textContent = '';
      for (const m of pool) {
        list.append(h('button', { class: 'pick', style: { backgroundImage: m.thumb ? `url(${m.thumb})` : 'none' }, 'aria-pressed': String(st.picks.includes(m.id)), 'aria-label': m.name, onClick: (e) => {
          st.picks = st.picks.includes(m.id) ? st.picks.filter((x) => x !== m.id) : [...st.picks, m.id];
          e.currentTarget.setAttribute('aria-pressed', String(st.picks.includes(m.id)));
        } }, h('small', null, m.kind === 'image' ? 'Photo' : fmt(m.duration))));
      }
      list.append(h('button', { class: 'pick', style: { display: 'grid', placeItems: 'center', background: 'var(--panel-2)' }, 'aria-label': 'Add more', html: icon('plus', 26), onClick: async () => {
        const ms = (await importFiles(await pickFiles($('#pickMedia')))).filter((m) => m.kind !== 'audio');
        pool = [...pool, ...ms];
        st.picks = [...st.picks, ...ms.map((m) => m.id)];
        drawPicks();
      } }));
    };
    drawPicks();
    const songBtn = h('button', { class: 'song' });
    const drawSong = () => {
      songBtn.innerHTML = '';
      songBtn.append(h('span', { html: icon('music', 26) }), h('span', null, h('b', null, st.song ? st.song.name : 'Choose a song'), h('small', null, st.song ? `${fmt(st.song.duration)} · tap to change` : 'Optional: without one, the clips keep their own sound')));
    };
    songBtn.addEventListener('click', async () => {
      const ms = await importFiles(await pickFiles($('#pickAudio')), 'Adding your song');
      if (ms[0]) { st.song = ms[0]; drawSong(); }
    });
    drawSong();
    const ask = h('textarea', { class: 'input', rows: '2', maxlength: '400', placeholder: 'For example: 30 seconds, smooth, in order, add the title "Summer 2026"', 'aria-label': 'What do you want? (optional)' });
    ask.value = st.prompt;
    const understood = h('div', { class: 'understood' });
    const showAsk = () => {
      understood.textContent = '';
      const a = parsePrompt(ask.value);
      for (const u of a.understood) understood.append(h('span', { class: /^Leave out/.test(u) ? 'avoid' : '' }, u));
      if (needsLooking(a)) understood.append(h('span', { class: 'avoid' }, 'Finding things in the picture is in the desktop app for now'));
      if (needsListening(a)) understood.append(h('span', { class: 'avoid' }, 'Listening for words is in the desktop app for now'));
    };
    ask.addEventListener('input', () => { st.prompt = ask.value; showAsk(); });
    showAsk();
    b.append(
      field('Clips', list),
      field('Music', songBtn),
      field('Style', chips(Object.keys(AC_STYLES).map((k) => [k, k]), st.style, (v) => { st.style = v; })),
      field('Length', chips([['song', 'Fit the song'], ['15', '15 s'], ['30', '30 s'], ['60', '1 min']], st.len, (v) => { st.len = v; })),
      field('What do you want? (optional)', ask, understood),
      h('button', { class: 'btn primary wide', style: { marginTop: '10px' }, onClick: async () => {
        if (!st.picks.length) { toast('Pick at least one clip'); return; }
        try { localStorage.setItem('snippy.acPrompt', st.prompt); } catch { /* none */ }
        closeSheet(true);
        await AutoCut.make(st, p);
      } }, h('span', { html: icon('wand') }), 'Make my video'),
      p && p.clips.length ? h('p', { class: 'hint' }, 'This replaces what’s on your timeline. You can undo it.') : null);
  }, { tall: true });
};

const AutoCut = {
  async make(st, existing) {
    const ask = parsePrompt(st.prompt || '');
    const style = AC_STYLES[ask.style] || AC_STYLES[st.style];
    const ms = st.picks.map(Media.get).filter(Boolean);
    Busy.show('AutoCut', 'Watching your clips…');
    try {
      // 1. The lively moments in each clip.
      const sources = [];
      for (let i = 0; i < ms.length; i++) {
        if (Busy.cancelled) throw new Error('cancelled');
        const m = ms[i];
        Busy.update(i / ms.length, `Watching ${m.name}`);
        const a = await Media.liveliness(m, (q) => Busy.update((i + q) / ms.length));
        sources.push({ id: m.id, step: a.step, score: a.score.map((v) => v + (Math.random() - 0.5) * 0.6), m });
      }
      // 2. The beat.
      let beats = null; let bpm = 120; let first = 0;
      if (st.song) {
        Busy.update(1, 'Listening for the beat…');
        const r = await Media.beats(st.song);
        if (r.beats && r.beats.length > 8) { beats = r.beats; bpm = r.bpm; first = r.beats[0]; }
      }
      const footage = ms.reduce((s, m) => s + (m.kind === 'image' ? 3 : m.duration), 0);
      let maxLen = ask.length || (st.len === 'song' ? (st.song ? st.song.duration - first : Math.min(30, footage)) : Number(st.len));
      maxLen = Math.max(4, Math.min(maxLen, st.song ? st.song.duration - first : maxLen, 180));
      const rel = beats ? beats.map((b) => b - first) : null;
      let pattern = style.pattern;
      if (ask.slowmo === false && style.pattern.length > 1) pattern = [style.pattern[0]];
      const slots = templateSlots({ beats: rel, bpm, pattern, maxLen });
      if (!slots.length) slots.push(Math.min(maxLen, 3));
      // 3. A moment for every shot.
      let picked = pickHighlights(sources, slots, 1);
      if (picked.length < slots.length) picked = picked.concat(pickHighlights(sources, slots.slice(picked.length), 0));
      while (picked.length < slots.length) picked.push(picked[picked.length % Math.max(1, picked.length)] || { id: ms[0].id, a: 0, b: slots[0] });
      const mix = ask.order === 'story' ? false : ask.order === 'mix' ? true : style.mix;
      if (mix) {
        // Take turns between clips, keeping each clip's moments in order.
        const by = new Map();
        for (const x of picked) { if (!by.has(x.id)) by.set(x.id, []); by.get(x.id).push(x); }
        const queues = [...by.values()];
        picked = [];
        while (queues.some((q) => q.length)) for (const q of queues) if (q.length) picked.push(q.shift());
      }
      const clips = slots.map((len, k) => {
        const x = picked[k];
        const m = Media.get(x.id);
        const a = m.kind === 'image' ? 0 : clamp(x.a, 0, Math.max(0, m.duration - len));
        return { id: uid('c'), mediaId: m.id, in: a, out: m.kind === 'image' ? len : Math.min(m.duration, a + len), speed: 1, volume: st.song ? 0 : 1, look: style.look };
      });
      // 4. Transitions, centred on the beat (the switch happens halfway through).
      clips.forEach((c, i) => {
        if (!i) return;
        const [type, tl] = style.trans[(i - 1) % style.trans.length];
        if (!type || type === 'none') return;
        const ov = Math.min(tl, slots[i - 1] * 0.4, slots[i] * 0.4);
        const half = ov / 2;
        c.transition = Number(ov.toFixed(3));
        c.transitionType = type;
        const prev = clips[i - 1];
        const pm = Media.get(prev.mediaId);
        if (pm.kind === 'image') prev.out += half;
        else { const over = Math.max(0, prev.out + half - pm.duration); prev.in = Math.max(0, prev.in - over); prev.out = Math.min(pm.duration, prev.out + half); }
        const cm = Media.get(c.mediaId);
        if (cm.kind === 'image') c.out += half;
        else if (c.in >= half) c.in -= half;
        else { const short = half - c.in; c.in = 0; c.out = Math.min(cm.duration, c.out + short); }
      });
      // 5. The project.
      const p = existing || newProject(existing ? existing.aspect : '9:16');
      if (existing) commit();
      p.clips = clips;
      p.effects = [];
      p.texts = p.texts.filter((x) => x.kind === 'caption');
      p.endFade = style.endFade || 0;
      const total = videoLen(p);
      p.audio = [];
      if (st.song) {
        const lead = beats ? Math.min(first, CUT_LEAD) : 0;
        p.audio.push({ id: uid('a'), mediaId: st.song.id, start: beats ? Number((CUT_LEAD - lead).toFixed(3)) : 0, in: first - lead, out: Math.min(st.song.duration, first - lead + total), volume: 1, fadeIn: 0, fadeOut: Math.min(2, total / 4), beats: beats || undefined, bpm });
      }
      if (style.fx) p.effects.push({ id: uid('e'), effect: style.fx, start: 0, dur: total, k: style.fxK });
      if (ask.title) p.texts.push({ id: uid('t'), kind: 'text', text: ask.title, start: 0, dur: Math.min(3, total), size: 9, position: 'center', color: '#FFFFFF', font: 'default', anim: 'zoom', out: 'fade', loop: 'none', wordFx: 'none', caps: true, box: false, hlColor: '#FFD84D', align: 'center' });
      p.media = [...new Set([...clips.map((c) => c.mediaId), ...p.audio.map((a) => a.mediaId)])];
      Busy.hide();
      if (existing) { App.player.setProject(p); App.player.seek(0); select(null); changed(); }
      else { p.name = 'AutoCut video'; await Store.putProject({ id: p.id, name: p.name, aspect: p.aspect, updated: Date.now(), thumb: Media.get(clips[0].mediaId).thumb, data: p }); await openProject(p); }
      toast(`${clips.length} shots${beats ? `, cut to ${Math.round(bpm)} beats a minute` : ''}. Tap play!`, 3500);
    } catch (err) {
      Busy.hide();
      if (err.message !== 'cancelled') toast(`AutoCut didn’t finish: ${err.message}`, 5000);
    }
  },
};
