'use strict';

// Used by the automatic build on GitHub: packs FFmpeg and FFprobe for Windows (from the npm
// packages) into the files Snippy downloads after it's installed, plus the list with each file's
// size and fingerprint. Usage: node scripts/make-components.js <output folder>

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const out = path.resolve(process.argv[2] || 'components');
fs.mkdirSync(out, { recursive: true });

const platform = process.platform;
const arch = process.arch;
const sources = {
  ffmpeg: require('ffmpeg-static'),
  ffprobe: require('ffprobe-static').path,
};

const files = [];
for (const [tool, src] of Object.entries(sources)) {
  if (!src || !fs.existsSync(src)) throw new Error(`${tool} not found at ${src}`);
  const data = fs.readFileSync(src);
  const gz = `${tool}-${platform}-${arch}.gz`;
  fs.writeFileSync(path.join(out, gz), zlib.gzipSync(data, { level: 9 }));
  files.push({
    tool, platform, arch, gz,
    size: data.length,
    gzSize: fs.statSync(path.join(out, gz)).size,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
  });
  console.log(`${tool}: ${(data.length / 1e6).toFixed(1)} MB -> ${(files[files.length - 1].gzSize / 1e6).toFixed(1)} MB`);
}

let ffmpegVersion = null;
try { ffmpegVersion = execFileSync(sources.ffmpeg, ['-version']).toString().split('\n')[0]; } catch { /* unknown */ }

fs.writeFileSync(path.join(out, 'components.json'), JSON.stringify({ made: new Date().toISOString(), ffmpegVersion, files }, null, 2));
console.log(`Wrote ${files.length} files and components.json to ${out}`);
