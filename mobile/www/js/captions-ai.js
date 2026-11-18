'use strict';
// Auto captions: Whisper (the same speech model as the desktop app) running on the phone.
// The model downloads once (about 75 MB) and is kept by the phone after that.

const ASR_MODEL = 'onnx-community/whisper-base_timestamped';

const CaptionsAI = {
  asr: null,

  async load(onProgress) {
    if (this.asr) return this.asr;
    const T = await import(new URL('vendor/transformers.min.js', document.baseURI).href);
    T.env.allowLocalModels = false;
    T.env.useBrowserCache = true;
    // Phones' web views can't share memory between threads here, so the model runs on one.
    if (T.env.backends && T.env.backends.onnx && T.env.backends.onnx.wasm) T.env.backends.onnx.wasm.numThreads = 1;
    const files = new Map();
    this.asr = await T.pipeline('automatic-speech-recognition', ASR_MODEL, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (e) => {
        if (e.status === 'progress' && e.total) {
          files.set(e.file, { loaded: e.loaded, total: e.total });
          let l = 0; let t = 0;
          for (const f of files.values()) { l += f.loaded; t += f.total; }
          onProgress(t ? l / t : 0);
        }
      },
    });
    return this.asr;
  },

  async run({ lang = 'auto', style = 'boldbox' } = {}) {
    const p = App.p;
    App.player.pause();
    Busy.show('Auto captions', 'Getting the speech model ready…');
    try {
      const asr = await this.load((q) => Busy.update(q, `Downloading the speech model (one time only) ${Math.round(q * 100)}%`));
      const { cleanSegments, cleanWords, groupWords, splitSegment } = SnippyCaptionTiming;
      const starts = clipStarts(p);
      const caps = [];
      const opts = { task: 'transcribe', ...(lang === 'auto' ? {} : { language: lang === 'en' ? 'english' : lang }) };
      const withSound = p.clips.map((c, i) => ({ c, i })).filter(({ c }) => { const m = Media.get(c.mediaId); return m && m.kind === 'video' && (c.volume ?? 1) > 0; });
      for (let n = 0; n < withSound.length; n++) {
        const { c, i } = withSound[n];
        if (Busy.cancelled) throw new Error('cancelled');
        Busy.update(n / withSound.length, `Listening to clip ${n + 1} of ${withSound.length}…`);
        const buf = await Media.audioBuffer(Media.get(c.mediaId));
        if (!buf) continue;
        const audio = Media.mono(buf, 16000, c.in, c.out);
        if (audio.length < 1600) continue;
        const dur = audio.length / 16000;
        const sp = c.speed || 1;
        // Pass 1: sentences.
        const res = await asr(audio, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true, ...opts });
        const segs = cleanSegments(res.chunks && res.chunks.length ? res.chunks : [{ timestamp: [0, dur], text: res.text }], dur);
        // Pass 2: each sentence on its own, for the timing of every word.
        for (let k = 0; k < segs.length; k++) {
          if (Busy.cancelled) throw new Error('cancelled');
          Busy.update((n + k / segs.length) / withSound.length, `Timing the words (clip ${n + 1} of ${withSound.length})…`);
          const seg = segs[k];
          let words = [];
          const a0 = Math.max(0, seg.start - 0.15);
          const a1 = Math.min(dur, seg.end + 0.15);
          if (a1 - a0 < 29) {
            try {
              const r = await asr(audio.subarray(Math.floor(a0 * 16000), Math.ceil(a1 * 16000)), { return_timestamps: 'word', ...opts });
              words = cleanWords(r.chunks, a0, dur);
            } catch (err) { console.warn('word timing', err); }
          }
          const parts = words.length ? groupWords(words, 4) : splitSegment(seg, 4);
          for (const q of parts) {
            const s = starts[i] + q.start / sp;
            const e = Math.min(starts[i] + clipLen(c), starts[i] + q.end / sp);
            if (e - s < 0.1) continue;
            caps.push({ s, e, text: q.text, words: q.words ? q.words.map((w) => ({ text: w.text, s: (w.s - q.start) / sp, e: (w.e - q.start) / sp })) : undefined });
          }
        }
      }
      Busy.hide();
      if (!caps.length) { toast('No speech found in your clips'); return; }
      commit();
      p.texts = p.texts.filter((x) => x.kind !== 'caption');
      const preset = (CAPTION_PRESETS.find((x) => x.id === style) || CAPTION_PRESETS[0]).set;
      for (const q of caps) {
        p.texts.push({ id: uid('t'), kind: 'caption', text: q.text, start: q.s, dur: q.e - q.s, words: q.words, position: 'bottom', offsetY: -0.08, font: 'default', align: 'center', out: 'none', loop: 'none', ...preset, preset: style });
      }
      changed();
      toast(`Added ${caps.length} captions. Tap one to fix a word.`, 3500);
    } catch (err) {
      Busy.hide();
      if (err.message !== 'cancelled') toast(`Captions didn’t finish: ${err.message}`, 6000);
    }
  },
};
