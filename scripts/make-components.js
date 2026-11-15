'use strict';

// Used by the automatic build on GitHub. Makes the files Snippy downloads after it's installed:
//   - FFmpeg and FFprobe (from the npm packages), each squeezed with gzip
//   - the AI tools: the speech, voice and cut-out engines with everything they need, as one
//     Brotli-squeezed pack, so they only download the first time an AI feature is used
// plus components.json listing each file's size and fingerprint. It also writes
// build-exclude.json: the packages the installer can leave out because they come in the pack.
// Usage: node scripts/make-components.js <output folder>

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { packFiles } = require('../components');

const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || 'components');
fs.mkdirSync(out, { recursive: true });
const platform = process.platform;
const arch = process.arch;
const files = [];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

// ---------- FFmpeg and FFprobe
const tools = { ffmpeg: require('ffmpeg-static'), ffprobe: require('ffprobe-static').path };
for (const [tool, src] of Object.entries(tools)) {
  if (!src || !fs.existsSync(src)) throw new Error(`${tool} not found at ${src}`);
  const data = fs.readFileSync(src);
  const gz = `${tool}-${platform}-${arch}.gz`;
  fs.writeFileSync(path.join(out, gz), zlib.gzipSync(data, { level: 9 }));
  files.push({ tool, platform, arch, gz, size: data.length, gzSize: fs.statSync(path.join(out, gz)).size, sha256: sha(data) });
  console.log(`${tool}: ${mb(data.length)} -> ${mb(files[files.length - 1].gzSize)}`);
}

// ---------- the AI pack
const nm = path.join(root, 'node_modules');
const pkgJson = (name) => { try { return JSON.parse(fs.readFileSync(path.join(nm, name, 'package.json'), 'utf8')); } catch { return null; } };
// Every package a set of packages needs (npm puts them all side by side in node_modules).
function closure(roots, skip = new Set()) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const name = stack.pop();
    if (seen.has(name) || skip.has(name)) continue;
    const p = pkgJson(name);
    if (!p) continue; // optional, not installed on this computer
    seen.add(name);
    for (const d of Object.keys({ ...(p.dependencies || {}), ...(p.optionalDependencies || {}) })) stack.push(d);
  }
  return seen;
}
const AI_ROOTS = ['@huggingface/transformers', 'kokoro-js'];
const UNUSED = new Set(['onnxruntime-web']); // the browser engine: Snippy's AI runs on onnxruntime-node
const appPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const coreRoots = Object.keys(appPkg.dependencies || {}).filter((d) => !AI_ROOTS.includes(d) && !['ffmpeg-static', 'ffprobe-static'].includes(d));
const core = closure(coreRoots);
const ai = closure(AI_ROOTS, UNUSED);
const web = closure([...UNUSED]);

// Only the voices Snippy offers (tts.js), and only the files that run in Node on this computer.
const voices = new Set((fs.readFileSync(path.join(root, 'tts.js'), 'utf8').match(/'[ab][fm]_[a-z]+'/g) || []).map((v) => v.slice(1, -1)));
function keep(pkg, rel) {
  const r = rel.split(path.sep).join('/');
  if (/\.(map|d\.ts|d\.mts|d\.cts|md|markdown)$/i.test(r) && !/^licen[cs]e/i.test(path.basename(r))) return false;
  if (pkg === '@huggingface/transformers') return r === 'package.json' || /^LICENSE/i.test(r) || /^dist\/transformers\.node\.(mjs|cjs)$/.test(r);
  if (pkg === 'kokoro-js') {
    if (r.startsWith('voices/')) return voices.has(path.basename(r, '.bin'));
    return r === 'package.json' || /^LICENSE/i.test(r) || r === 'dist/kokoro.js' || r === 'dist/kokoro.cjs';
  }
  if (pkg === 'onnxruntime-node' && r.startsWith('bin/')) return r.includes(`/${platform}/${arch}/`);
  return true;
}
const packed = [];
function addDir(pkg, dir, rel = '') {
  for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, ent.name);
    if (ent.isDirectory()) addDir(pkg, dir, r);
    else if (ent.isFile() && keep(pkg, r)) packed.push({ p: path.join('node_modules', pkg, r).split(path.sep).join('/'), data: fs.readFileSync(path.join(dir, r)) });
  }
}
for (const pkg of ai) addDir(pkg, path.join(nm, pkg));
const archive = packFiles(packed);
const aiName = `ai-${platform}-${arch}.snpk.br`;
const squeezed = zlib.brotliCompressSync(archive, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: archive.length } });
fs.writeFileSync(path.join(out, aiName), squeezed);
const versions = Object.fromEntries([...ai].map((p) => [p, pkgJson(p).version]));
files.push({ tool: 'ai', platform, arch, gz: aiName, size: archive.length, gzSize: squeezed.length, sha256: sha(archive), version: sha(JSON.stringify(versions)).slice(0, 12), packages: versions });
console.log(`AI tools: ${packed.length} files, ${mb(archive.length)} -> ${mb(squeezed.length)} (${[...ai].sort().join(', ')})`);

// What the installer leaves out: the AI packages (unless the app itself needs them) and the
// browser engine nobody uses.
const exclude = [...new Set([...ai, ...web])].filter((p) => !core.has(p)).sort();
fs.writeFileSync(path.join(root, 'build-exclude.json'), JSON.stringify(exclude, null, 2));
console.log(`Left out of the installer: ${exclude.join(', ')}`);

let ffmpegVersion = null;
try { ffmpegVersion = execFileSync(tools.ffmpeg, ['-version']).toString().split('\n')[0].trim(); } catch { /* unknown */ }
fs.writeFileSync(path.join(out, 'components.json'), JSON.stringify({ made: new Date().toISOString(), ffmpegVersion, files }, null, 2));
console.log(`Wrote ${files.length} files and components.json to ${out}`);
