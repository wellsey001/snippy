'use strict';
// Packs encoded video (H.264) and sound (AAC or Opus) into an .mp4 file that plays everywhere,
// with the index at the front so it starts playing straight away.

class Mp4Muxer {
  // video: { width, height, description (avcC) }  audio: { codec: 'aac'|'opus', sampleRate, channels, description }
  constructor({ video, audio }) {
    this.video = video ? { ...video, samples: [] } : null;
    this.audio = audio ? { ...audio, samples: [] } : null;
  }

  addVideo(chunk, meta) {
    if (meta && meta.decoderConfig && meta.decoderConfig.description && !this.video.description) this.video.description = new Uint8Array(meta.decoderConfig.description.buffer ? meta.decoderConfig.description.buffer : meta.decoderConfig.description);
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.video.samples.push({ data, pts: chunk.timestamp, dur: chunk.duration || 0, key: chunk.type === 'key' });
  }

  addAudio(chunk, meta) {
    if (meta && meta.decoderConfig && meta.decoderConfig.description && !this.audio.description) {
      const d = meta.decoderConfig.description;
      this.audio.description = new Uint8Array(d.buffer ? d.buffer.slice(d.byteOffset || 0, (d.byteOffset || 0) + d.byteLength) : d);
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.audio.samples.push({ data, pts: chunk.timestamp, dur: chunk.duration || 0, key: true });
  }

  // The finished file, as a Blob.
  finish() {
    const tracks = [];
    if (this.video && this.video.samples.length) tracks.push(this.videoTrack());
    if (this.audio && this.audio.samples.length) tracks.push(this.audioTrack());
    const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
    const dataLen = tracks.reduce((s, t) => s + t.bytes, 0);
    const big = dataLen + 16 > 0xffffffff;
    // The index goes before the data, so its size decides where the data starts.
    let moov = this.moov(tracks, 0, big);
    const mdatHead = big ? 16 : 8;
    const base = ftyp.length + moov.length + mdatHead;
    moov = this.moov(tracks, base, big);
    const head = big ? cat(u32(1), str('mdat'), u64(dataLen + 16)) : cat(u32(dataLen + 8), str('mdat'));
    const parts = [ftyp, moov, head];
    for (const t of tracks) for (const s of t.samples) parts.push(s.data);
    return new Blob(parts, { type: 'video/mp4' });
  }

  videoTrack() {
    const v = this.video;
    const TS = 90000;
    const S = v.samples;
    // Presentation times may be out of order (frames that look ahead); decode times are the
    // same times sorted, shifted so no frame shows before it's decoded.
    const pts = S.map((s) => Math.round((s.pts * TS) / 1e6));
    const sorted = [...pts].sort((a, b) => a - b);
    let shift = 0;
    for (let i = 0; i < S.length; i++) shift = Math.max(shift, sorted[i] - pts[i]);
    const dts = sorted.map((t) => t - shift);
    const frameDur = S.length > 1 ? Math.round((sorted[sorted.length - 1] - sorted[0]) / (S.length - 1)) : Math.round(TS / 30);
    const deltas = dts.map((t, i) => (i < dts.length - 1 ? dts[i + 1] - t : frameDur));
    const ctts = pts.map((t, i) => t - dts[i]);
    const duration = sorted[sorted.length - 1] - sorted[0] + frameDur;
    const entry = box('avc1', zeros(6), u16(1), zeros(16), u16(v.width), u16(v.height), u32(0x00480000), u32(0x00480000), zeros(4), u16(1), zeros(32), u16(0x18), s16(-1),
      box('avcC', v.description || new Uint8Array(0)));
    return {
      id: 1, kind: 'vide', TS, duration, samples: S, deltas, ctts: ctts.some((c) => c !== 0) ? ctts : null, shift, entry,
      sync: S.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean), width: v.width, height: v.height,
      bytes: S.reduce((a, s) => a + s.data.length, 0),
    };
  }

  audioTrack() {
    const a = this.audio;
    const TS = a.sampleRate;
    const S = a.samples;
    const deltas = S.map((s, i) => {
      if (s.dur) return Math.round((s.dur * TS) / 1e6);
      return i < S.length - 1 ? Math.round(((S[i + 1].pts - s.pts) * TS) / 1e6) : (a.codec === 'opus' ? 960 : 1024);
    });
    const duration = deltas.reduce((x, y) => x + y, 0);
    let entry;
    if (a.codec === 'opus') {
      const preSkip = 312;
      const dOps = box('dOps', u8(0), u8(a.channels), u16(preSkip), u32(a.sampleRate), s16(0), u8(0));
      entry = box('Opus', zeros(6), u16(1), zeros(8), u16(a.channels), u16(16), zeros(4), u32(a.sampleRate << 16 >>> 0), dOps);
    } else {
      const asc = a.description || aacConfig(a.sampleRate, a.channels);
      const desc = (tag, body) => cat(u8(tag), u8(0x80), u8(0x80), u8(0x80), u8(body.length), body);
      const dsi = desc(0x05, asc);
      const dcd = desc(0x04, cat(u8(0x40), u8(0x15), zeros(3), u32(192000), u32(128000), dsi));
      const es = desc(0x03, cat(u16(1), u8(0), dcd, desc(0x06, u8(0x02))));
      entry = box('mp4a', zeros(6), u16(1), zeros(8), u16(a.channels), u16(16), zeros(4), u32(a.sampleRate << 16 >>> 0), fullbox('esds', 0, 0, es));
    }
    return { id: 2, kind: 'soun', TS, duration, samples: S, deltas, ctts: null, shift: 0, entry, sync: null, bytes: S.reduce((x, s) => x + s.data.length, 0) };
  }

  moov(tracks, base, big) {
    const movieTS = 1000;
    let off = base;
    const traks = tracks.map((t) => {
      const offsets = t.samples.map((s) => { const o = off; off += s.data.length; return o; });
      const durMovie = Math.round((t.duration * movieTS) / t.TS);
      const stbl = box('stbl',
        fullbox('stsd', 0, 0, u32(1), t.entry),
        fullbox('stts', 0, 0, ...runs(t.deltas)),
        t.sync && t.sync.length < t.samples.length ? fullbox('stss', 0, 0, u32(t.sync.length), ...t.sync.map(u32)) : null,
        t.ctts ? fullbox('ctts', 0, 0, ...runs(t.ctts)) : null,
        fullbox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)),
        fullbox('stsz', 0, 0, u32(0), u32(t.samples.length), ...t.samples.map((s) => u32(s.data.length))),
        big ? fullbox('co64', 0, 0, u32(offsets.length), ...offsets.map(u64)) : fullbox('stco', 0, 0, u32(offsets.length), ...offsets.map(u32)));
      const isV = t.kind === 'vide';
      const minf = box('minf',
        isV ? fullbox('vmhd', 0, 1, zeros(8)) : fullbox('smhd', 0, 0, zeros(4)),
        box('dinf', fullbox('dref', 0, 0, u32(1), fullbox('url ', 0, 1))),
        stbl);
      const mdia = box('mdia',
        fullbox('mdhd', 0, 0, u32(0), u32(0), u32(t.TS), u32(t.duration), u16(0x55c4), u16(0)),
        fullbox('hdlr', 0, 0, u32(0), str(t.kind), zeros(12), str(isV ? 'Snippy video\0' : 'Snippy sound\0')),
        minf);
      const tkhd = fullbox('tkhd', 0, 3, u32(0), u32(0), u32(t.id), u32(0), u32(durMovie), zeros(8), u16(0), u16(0), u16(isV ? 0 : 0x0100), u16(0), matrix(),
        u32(isV ? t.width << 16 >>> 0 : 0), u32(isV ? t.height << 16 >>> 0 : 0));
      // Frames that look ahead start the track a little late: the edit list hides that.
      const edts = t.shift ? box('edts', fullbox('elst', 0, 0, u32(1), u32(durMovie), u32(t.shift), u16(1), u16(0))) : null;
      return box('trak', tkhd, edts, mdia);
    });
    const dur = Math.max(...tracks.map((t) => Math.round((t.duration * movieTS) / t.TS)));
    const mvhd = fullbox('mvhd', 0, 0, u32(0), u32(0), u32(movieTS), u32(dur), u32(0x00010000), u16(0x0100), zeros(10), matrix(), zeros(24), u32(tracks.length + 1));
    return box('moov', mvhd, ...traks);
  }
}

// ---------- byte helpers
function u8(v) { return new Uint8Array([v & 255]); }
function u16(v) { return new Uint8Array([(v >> 8) & 255, v & 255]); }
function s16(v) { return u16(v < 0 ? 0x10000 + v : v); }
function u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return b; }
function u64(v) { const b = new Uint8Array(8); const dv = new DataView(b.buffer); dv.setUint32(0, Math.floor(v / 2 ** 32)); dv.setUint32(4, v >>> 0); return b; }
function str(s) { return new Uint8Array([...s].map((c) => c.charCodeAt(0))); }
function zeros(n) { return new Uint8Array(n); }
function cat(...parts) {
  const ps = parts.filter(Boolean);
  const out = new Uint8Array(ps.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of ps) { out.set(p, o); o += p.length; }
  return out;
}
function box(type, ...payload) { const body = cat(...payload); return cat(u32(body.length + 8), str(type), body); }
function fullbox(type, version, flags, ...payload) { return box(type, u8(version), u8(flags >> 16), u8(flags >> 8), u8(flags), ...payload); }
function matrix() { return cat(u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)); }
// Repeated values packed as (count, value) pairs, after a count of pairs.
function runs(values) {
  const out = [];
  for (const v of values) { if (out.length && out[out.length - 1][1] === v) out[out.length - 1][0]++; else out.push([1, v]); }
  return [u32(out.length), ...out.flatMap(([n, v]) => [u32(n), u32(v)])];
}
// The AAC setup bytes for plain AAC-LC, if the encoder didn't give them.
function aacConfig(rate, channels) {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const i = Math.max(0, rates.indexOf(rate));
  return new Uint8Array([(2 << 3) | (i >> 1), ((i & 1) << 7) | (channels << 3)]);
}
