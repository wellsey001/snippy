'use strict';

// Components Snippy downloads once after it's installed, so the installer stays small.
// For now that's FFmpeg and FFprobe (the video tools behind importing, previews and exports).
// They're kept on Snippy's own GitHub releases page (put there by the automatic build), each
// squeezed with gzip, with a list giving every file's size and fingerprint (SHA-256) so a broken
// or tampered download is never used. Free of Electron so it can be tested on its own.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const REPO = 'wellsey001/snippy';
const COMPONENTS_TAG = 'components-v1';
const BASE_URL = `https://github.com/${REPO}/releases/download/${COMPONENTS_TAG}/`;
const TOOLS = ['ffmpeg', 'ffprobe'];

const exeName = (tool, platform = process.platform) => (platform === 'win32' ? `${tool}.exe` : tool);

// Where the downloaded tools live, and whether they're all there.
function toolPaths(dir, platform = process.platform) {
  return Object.fromEntries(TOOLS.map((t) => [t, path.join(dir, exeName(t, platform))]));
}
function installed(dir, platform = process.platform) {
  const p = toolPaths(dir, platform);
  return TOOLS.every((t) => { try { return fs.statSync(p[t]).size > 50000; } catch { return false; } });
}

async function getManifest(fetchFn, baseUrl = BASE_URL) {
  const res = await fetchFn(`${baseUrl}components.json`);
  if (!res.ok) throw new Error(`The download list couldn't be fetched (${res.status}). Check your internet connection and try again.`);
  const m = await res.json();
  if (!m || !Array.isArray(m.files)) throw new Error('The download list was not what Snippy expected.');
  return m;
}

// Downloads every tool for this computer, checking each one before it's used.
// onProgress({ done, total (bytes, compressed), file }).
async function installTools({ dir, fetchFn, onProgress, isCancelled, baseUrl = BASE_URL, platform = process.platform, arch = process.arch }) {
  const manifest = await getManifest(fetchFn, baseUrl);
  const files = manifest.files.filter((f) => f.platform === platform && f.arch === arch && TOOLS.includes(f.tool));
  const missing = TOOLS.filter((t) => !files.some((f) => f.tool === t));
  if (missing.length) throw new Error(`There's no download of ${missing.join(' and ')} for this computer (${platform} ${arch}).`);
  fs.mkdirSync(dir, { recursive: true });
  const total = files.reduce((s, f) => s + f.gzSize, 0);
  let done = 0;
  for (const f of files) {
    const target = path.join(dir, exeName(f.tool, platform));
    const part = `${target}.part`;
    const res = await fetchFn(baseUrl + f.gz);
    if (!res.ok || !res.body) throw new Error(`${f.tool} couldn't be downloaded (${res.status}). Check your internet connection and try again.`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const count = new Transform({
      transform(chunk, _enc, cb) {
        if (isCancelled && isCancelled()) { cb(new Error('cancelled')); return; }
        done += chunk.length;
        if (onProgress) onProgress({ done, total, file: f.tool });
        cb(null, chunk);
      },
    });
    const check = new Transform({
      transform(chunk, _enc, cb) { hash.update(chunk); size += chunk.length; cb(null, chunk); },
    });
    const body = typeof res.body.getReader === 'function' ? Readable.fromWeb(res.body) : res.body;
    try {
      await pipeline(body, count, zlib.createGunzip(), check, fs.createWriteStream(part));
    } catch (err) {
      try { fs.rmSync(part, { force: true }); } catch { /* already gone */ }
      if (String(err.message).includes('cancelled')) throw err;
      throw new Error(`${f.tool} didn't download properly (${err.message}). Try again.`);
    }
    const sum = hash.digest('hex');
    if (sum !== f.sha256 || size !== f.size) {
      fs.rmSync(part, { force: true });
      throw new Error(`${f.tool} was damaged on the way (its fingerprint didn't match). Try again.`);
    }
    if (platform !== 'win32') fs.chmodSync(part, 0o755);
    fs.renameSync(part, target);
  }
  return { ...toolPaths(dir, platform), version: manifest.ffmpegVersion || null };
}

// ---------- packs: a folder of files in one download (the AI tools)
// Format: "SNPK" + 4-byte header length + JSON { files: [{ p (path), n (bytes) }] } + the files'
// bytes one after another, all squeezed with Brotli. Small to write and read with no extra packages.

function packFiles(files) {
  const header = Buffer.from(JSON.stringify({ files: files.map((f) => ({ p: f.p, n: f.data.length })) }));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(header.length);
  return Buffer.concat([Buffer.from('SNPK'), len, header, ...files.map((f) => f.data)]);
}

function unpackFiles(buf) {
  if (buf.subarray(0, 4).toString() !== 'SNPK') throw new Error('not a Snippy pack');
  const hl = buf.readUInt32LE(4);
  const { files } = JSON.parse(buf.subarray(8, 8 + hl).toString());
  let at = 8 + hl;
  return files.map((f) => {
    if (f.p.includes('..') || path.isAbsolute(f.p)) throw new Error(`bad path in pack: ${f.p}`);
    const data = buf.subarray(at, at + f.n);
    at += f.n;
    return { p: f.p, data };
  });
}

const packDir = (dir, name) => path.join(dir, name);
function packInstalled(dir, name) {
  try { return fs.existsSync(path.join(packDir(dir, name), '.complete')); } catch { return false; }
}

// Downloads and unpacks a pack (for example 'ai') into dir/<name>, checking its fingerprint.
async function installPack({ dir, name, fetchFn, onProgress, isCancelled, baseUrl = BASE_URL, platform = process.platform, arch = process.arch }) {
  const manifest = await getManifest(fetchFn, baseUrl);
  const f = manifest.files.find((x) => x.tool === name && x.platform === platform && x.arch === arch);
  if (!f) throw new Error(`There's no download of the ${name} tools for this computer (${platform} ${arch}) yet.`);
  const res = await fetchFn(baseUrl + f.gz);
  if (!res.ok || !res.body) throw new Error(`The download failed (${res.status}). Check your internet connection and try again.`);
  const chunks = [];
  let done = 0;
  const count = new Transform({
    transform(chunk, _enc, cb) {
      if (isCancelled && isCancelled()) { cb(new Error('cancelled')); return; }
      done += chunk.length;
      if (onProgress) onProgress({ done, total: f.gzSize, file: name });
      cb(null, chunk);
    },
  });
  const collect = new Transform({ transform(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
  const body = typeof res.body.getReader === 'function' ? Readable.fromWeb(res.body) : res.body;
  try {
    await pipeline(body, count, zlib.createBrotliDecompress(), collect);
  } catch (err) {
    if (String(err.message).includes('cancelled')) throw err;
    throw new Error(`The download didn't finish properly (${err.message}). Try again.`);
  }
  const buf = Buffer.concat(chunks);
  const sum = crypto.createHash('sha256').update(buf).digest('hex');
  if (sum !== f.sha256 || buf.length !== f.size) throw new Error('The download was damaged on the way (its fingerprint didn\u2019t match). Try again.');
  const target = packDir(dir, name);
  const temp = `${target}.part`;
  fs.rmSync(temp, { recursive: true, force: true });
  for (const { p, data } of unpackFiles(buf)) {
    const out = path.join(temp, p);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
  }
  fs.writeFileSync(path.join(temp, '.complete'), JSON.stringify({ sha256: f.sha256, version: f.version || null }));
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(temp, target);
  return target;
}

module.exports = { installTools, installed, toolPaths, getManifest, installPack, packInstalled, packFiles, unpackFiles, BASE_URL, COMPONENTS_TAG, TOOLS };
