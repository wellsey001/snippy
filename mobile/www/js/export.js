'use strict';
// Exporting: every frame is drawn by the same renderer as the preview and encoded by the phone's
// own video encoder; the sound is mixed separately (exactly, not played) and encoded alongside;
// then both are packed into an .mp4 and saved to the gallery.

const Exporter = {
  async pickVideoConfig(W, H, fps, bitrate) {
    const level = W * H > 1920 * 1088 ? '33' : fps > 30 ? '2A' : '28';
    for (const codec of [`avc1.6400${level}`, `avc1.4D00${level}`, `avc1.4200${level}`, 'avc1.640033', 'avc1.42E01F']) {
      for (const hw of ['prefer-hardware', 'no-preference']) {
        const cfg = { codec, width: W, height: H, bitrate, framerate: fps, avc: { format: 'avc' }, hardwareAcceleration: hw, bitrateMode: 'variable', latencyMode: 'quality' };
        try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) return r.config; } catch { /* next */ }
      }
    }
    return null;
  },

  async pickAudioConfig() {
    if (typeof AudioEncoder === 'undefined') return null;
    for (const [codec, kind] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
      const cfg = { codec, sampleRate: 48000, numberOfChannels: 2, bitrate: kind === 'aac' ? 192000 : 160000 };
      try { const r = await AudioEncoder.isConfigSupported(cfg); if (r.supported) return { config: r.config, kind }; } catch { /* next */ }
    }
    return null;
  },

  // The whole soundtrack, mixed exactly: clips' own sound (with crossfades), music and sounds.
  async renderAudio(p, total, rate = 48000) {
    const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(total * rate)), rate);
    const master = ctx.createGain();
    master.connect(ctx.destination);
    if (p.endFade) { master.gain.setValueAtTime(1, Math.max(0, total - p.endFade)); master.gain.linearRampToValueAtTime(0, total); }
    const starts = clipStarts(p);
    for (let i = 0; i < p.clips.length; i++) {
      const c = p.clips[i];
      const vol = c.volume ?? 1;
      const m = Media.get(c.mediaId);
      if (!m || m.kind !== 'video' || vol <= 0) continue;
      const buf = await Media.audioBuffer(m);
      if (!buf) continue;
      const s = starts[i];
      const L = clipLen(c);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = c.speed || 1;
      const g = ctx.createGain();
      const ovIn = overlapOf(p, i);
      const ovOut = i + 1 < p.clips.length ? overlapOf(p, i + 1) : 0;
      g.gain.setValueAtTime(ovIn ? 0 : vol, s);
      if (ovIn) g.gain.linearRampToValueAtTime(vol, s + ovIn);
      if (ovOut) { g.gain.setValueAtTime(vol, s + L - ovOut); g.gain.linearRampToValueAtTime(0, s + L); }
      src.connect(g).connect(master);
      src.start(s, c.in);
      src.stop(s + L);
    }
    for (const a of p.audio) {
      const m = Media.get(a.mediaId);
      if (!m) continue;
      const buf = await Media.audioBuffer(m);
      if (!buf) continue;
      const len = Math.min(a.out - a.in, total - a.start);
      if (len <= 0) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      const vol = a.volume ?? 1;
      const end = a.start + len;
      const fi = Math.min(a.fadeIn || 0, len / 2);
      const fo = Math.min(a.fadeOut || 0, len / 2);
      g.gain.setValueAtTime(fi ? 0 : vol, a.start);
      if (fi) g.gain.linearRampToValueAtTime(vol, a.start + fi);
      // The music always fades a little if the video ends in the middle of it.
      const cut = a.start + (a.out - a.in) > total + 0.05;
      const fade = cut ? Math.max(fo, Math.min(1, len / 4)) : fo;
      if (fade) { g.gain.setValueAtTime(vol, end - fade); g.gain.linearRampToValueAtTime(0, end); }
      src.connect(g).connect(master);
      src.start(a.start, a.in);
      src.stop(end);
    }
    return ctx.startRendering();
  },

  async run(p, { short = 1080, fps = 30, quality = 'standard' } = {}) {
    if (typeof VideoEncoder === 'undefined') { toast('This phone’s web view is too old to export. Update “Android System WebView” from the Play Store, then try again.', 6000); return; }
    const { W, H } = frameSize(p.aspect, short);
    const total = videoLen(p);
    const bpp = { small: 0.06, standard: 0.1, high: 0.16 }[quality] || 0.1;
    const bitrate = Math.round(W * H * fps * bpp);
    Busy.show('Exporting', 'Getting ready…');
    App.player.pause();
    const R = new Renderer(W, H, { muted: true });
    let venc = null; let aenc = null;
    const t0 = performance.now();
    try {
      const vcfg = await this.pickVideoConfig(W, H, fps, bitrate);
      if (!vcfg) throw new Error(`This phone can’t encode ${H}p video. Try 720p.`);
      const acfg = await this.pickAudioConfig();
      const mux = new Mp4Muxer({ video: { width: W, height: H }, audio: acfg ? { codec: acfg.kind, sampleRate: 48000, channels: 2 } : null });
      let failed = null;
      venc = new VideoEncoder({ output: (chunk, meta) => mux.addVideo(chunk, meta), error: (e) => { failed = e; } });
      venc.configure(vcfg);
      // Sound first (quick): mixed, then encoded.
      if (acfg) {
        Busy.update(0, 'Mixing the sound…');
        const buf = await this.renderAudio(p, total);
        aenc = new AudioEncoder({ output: (chunk, meta) => mux.addAudio(chunk, meta), error: (e) => { failed = e; } });
        aenc.configure(acfg.config);
        const n = buf.length;
        const L = buf.getChannelData(0);
        const Rr = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
        const step = 4800;
        for (let i = 0; i < n; i += step) {
          const m = Math.min(step, n - i);
          const data = new Float32Array(m * 2);
          data.set(L.subarray(i, i + m), 0);
          data.set(Rr.subarray(i, i + m), m);
          const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: m, numberOfChannels: 2, timestamp: Math.round((i / 48000) * 1e6), data });
          aenc.encode(ad);
          ad.close();
          if (aenc.encodeQueueSize > 20) await sleep(1);
        }
        await aenc.flush();
      } else toast('This phone can’t encode sound here, so the video will be silent.', 5000);
      // Pictures.
      const N = Math.max(1, Math.round(total * fps));
      for (let k = 0; k < N; k++) {
        if (Busy.cancelled) throw new Error('cancelled');
        if (failed) throw failed;
        const t = Math.min(total - 0.0005, k / fps);
        await this.ready(p, R, t, fps);
        R.frame(p, t);
        const frame = new VideoFrame(R.canvas, { timestamp: Math.round((k * 1e6) / fps), duration: Math.round(1e6 / fps) });
        venc.encode(frame, { keyFrame: k % (fps * 2) === 0 });
        frame.close();
        while (venc.encodeQueueSize > 3) await sleep(2);
        if (k % 5 === 0) {
          const done = (k + 1) / N;
          const el = (performance.now() - t0) / 1000;
          const left = done > 0.05 ? Math.max(0, el / done - el) : null;
          Busy.update(done, `${Math.round(done * 100)}%${left != null ? ` · about ${fmt(left)} left` : ''}`);
        }
      }
      await venc.flush();
      if (failed) throw failed;
      R.destroy();
      Busy.update(1, 'Saving…');
      const blob = mux.finish();
      const name = `${(p.name || 'Snippy').replace(/[^\w\- ]+/g, '').trim() || 'Snippy'} ${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.mp4`;
      const saved = await Saver.save(blob, name);
      Busy.hide();
      this.done(saved, blob, name);
    } catch (err) {
      R.destroy();
      Busy.hide();
      if (err && err.message === 'cancelled') toast('Export stopped');
      else { console.error(err); toast(`Export didn’t finish: ${err && err.message ? err.message : err}`, 6000); }
    } finally {
      try { if (venc && venc.state !== 'closed') venc.close(); } catch { /* closed */ }
      try { if (aenc && aenc.state !== 'closed') aenc.close(); } catch { /* closed */ }
    }
  },

  // Waits until every video showing at time t has the right frame up (playing along in real time
  // where it can, slowing the video down if drawing falls behind).
  async ready(p, R, t, fps) {
    const starts = clipStarts(p);
    const on = clipsAt(p, t, starts);
    const keep = on.map((x) => x.clip.id);
    const last = on[on.length - 1];
    const next = last && last.i + 1 < p.clips.length && starts[last.i + 1] - t < 1 ? { clip: p.clips[last.i + 1], src: p.clips[last.i + 1].in } : null;
    if (next) keep.push(next.clip.id);
    const used = [];
    for (const x of on) {
      const m = Media.get(x.clip.mediaId);
      if (!m || m.kind !== 'video') { if (m && m.kind === 'image') await this.imageReady(R, m); continue; }
      const el = R.elementFor(x.clip, keep);
      used.push(el);
      await this.frameAt(el, x.src, x.clip.speed || 1, fps);
    }
    // The next clip waits, ready at its first frame.
    if (next) {
      const m = Media.get(next.clip.mediaId);
      if (m && m.kind === 'video') {
        const el = R.elementFor(next.clip, keep);
        if (!used.includes(el)) {
          used.push(el);
          if (!el.paused) el.pause();
          if (el.readyState >= 1 && Math.abs(el.currentTime - next.src) > 0.02 && !el.seeking) { try { el.currentTime = next.src; } catch { /* later */ } }
        }
      }
    }
    R.pausedAll(used);
  },

  async imageReady(R, m) {
    const img = R.image(m);
    if (img.complete && img.naturalWidth) return;
    await new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); setTimeout(r, 5000); });
  },

  async frameAt(el, src, speed, fps) {
    if (!el._snippyWatch) {
      el._snippyWatch = true;
      el._mt = -1;
      if (el.requestVideoFrameCallback) {
        const cb = (_now, meta) => { el._mt = meta.mediaTime; el.requestVideoFrameCallback(cb); };
        el.requestVideoFrameCallback(cb);
      }
    }
    const shown = () => (el.requestVideoFrameCallback ? el._mt : el.currentTime);
    if (el.readyState < 1) await Media.once(el, 'loadedmetadata').catch(() => {});
    const half = (0.5 / fps) * speed;
    const deadline = performance.now() + 8000;
    let seeks = 0;
    for (;;) {
      const cur = el.currentTime;
      // Way off (a new clip, or far behind): jump there and play on.
      if ((el.paused && Math.abs(cur - src) > 0.05) || cur > src + 0.35 * speed || cur < src - 1.0 * speed) {
        if (seeks++ > 3) break;
        el.pause();
        el.currentTime = src;
        await Media.once(el, 'seeked', 6000).catch(() => {});
        el._mt = el.currentTime;
      }
      if (el._rate == null) el._rate = speed;
      if (el.paused) { el.playbackRate = el._rate; await el.play().catch(() => {}); }
      const mt = shown();
      if (mt >= src - half) {
        // Drawing slower than the video plays: the video plays slower too, so frames stay in step.
        if (mt > src + 2 * half) el._rate = Math.max(0.2 * speed, el._rate * 0.85);
        else el._rate = Math.min(speed, el._rate * 1.02);
        if (Math.abs(el.playbackRate - el._rate) > 0.01) el.playbackRate = el._rate;
        return;
      }
      // Waiting for the video: it may play a little faster again.
      el._rate = Math.min(speed, el._rate * 1.05);
      if (Math.abs(el.playbackRate - el._rate) > 0.01) el.playbackRate = el._rate;
      if (performance.now() > deadline) return;
      await new Promise((r) => (el.requestVideoFrameCallback ? el.requestVideoFrameCallback(() => r()) : setTimeout(r, 8)));
    }
  },

  done(saved, blob, name) {
    openSheet('Your video is ready', (b) => {
      const url = URL.createObjectURL(blob);
      const v = h('video', { src: url, controls: true, playsinline: true, style: { width: '100%', maxHeight: '42vh', borderRadius: '14px', background: '#000' } });
      b.append(v,
        h('p', { class: 'hint' }, saved.native ? 'Saved to your gallery, in the Snippy album (Movies/Snippy).' : `Downloaded as “${name}”.`),
        h('div', { class: 'btn-row' },
          saved.native ? h('button', { class: 'btn primary', onClick: () => Saver.share(saved) }, h('span', { html: icon('share') }), 'Share') : null,
          h('button', { class: 'btn', onClick: () => closeSheet() }, 'Done')));
    });
  },
};

// Saving to the phone's gallery (or downloading, in a browser).
const Saver = {
  async save(blob, name) {
    const FS = nativePlugin('Filesystem');
    const SV = nativePlugin('SnippySave');
    if (FS && SV) {
      const path = `exports/${name}`;
      const CH = 3 * 1024 * 1024;
      for (let i = 0; i < blob.size; i += CH) {
        const b64 = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
          fr.onerror = () => reject(fr.error);
          fr.readAsDataURL(blob.slice(i, i + CH));
        });
        if (i === 0) await FS.writeFile({ path, data: b64, directory: 'CACHE', recursive: true });
        else await FS.appendFile({ path, data: b64, directory: 'CACHE' });
        Busy.update(null, `Saving… ${Math.round((Math.min(blob.size, i + CH) / blob.size) * 100)}%`);
      }
      const { uri } = await FS.getUri({ path, directory: 'CACHE' });
      const r = await SV.saveVideo({ path: uri, name });
      return { native: true, uri: r && r.uri, file: uri, name };
    }
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    return { native: false, name };
  },
  async share(saved) {
    const Share = nativePlugin('Share');
    if (!Share) return;
    try { await Share.share({ title: 'My Snippy video', files: [saved.file], dialogTitle: 'Share your video' }); } catch { /* closed */ }
  },
};
