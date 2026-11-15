#!/usr/bin/env node
'use strict';

// Applies a new Snippy zip to this folder without disturbing your setup.
//
//   node update.js                 uses the newest snippy*.zip in your Downloads folder
//   node update.js path\to\file.zip
//
// What it does:
//  - copies every new file in, except node_modules, package.json and package-lock.json
//  - updates package.json in place: the version, scripts and build settings change, but your
//    install-script approvals and your own release settings (build.publish) are kept
//  - installs any packages the new version needs that you don't have yet

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const here = __dirname;
const SKIP = new Set(['node_modules', 'package.json', 'package-lock.json', '.git', 'dist']);
const say = (msg) => console.log(msg);

function findZip() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  const dl = path.join(os.homedir(), 'Downloads');
  const zips = fs.existsSync(dl) ? fs.readdirSync(dl).filter((f) => /^snippy.*\.zip$/i.test(f)) : [];
  if (!zips.length) throw new Error(`No snippy zip found in ${dl}. Give its path: node update.js path\\to\\snippy.zip`);
  return zips.map((f) => path.join(dl, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

// Windows 10 and 11 include tar, which can unpack zips; PowerShell and unzip are fallbacks.
function unzip(zip, dest) {
  const tries = [
    ['tar', ['-xf', zip, '-C', dest]],
    ['powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`]],
    ['unzip', ['-q', '-o', zip, '-d', dest]],
  ];
  for (const [cmd, args] of tries) {
    try {
      execFileSync(cmd, args, { stdio: 'ignore' });
      if (fs.readdirSync(dest).length) return;
    } catch { /* try the next way */ }
  }
  throw new Error('Could not unpack the zip. Unzip it yourself and run: node update.js path\\to\\unzipped\\folder');
}

function copyTree(from, to, count = { n: 0 }) {
  for (const name of fs.readdirSync(from)) {
    if (SKIP.has(name)) continue;
    const a = path.join(from, name);
    const b = path.join(to, name);
    if (fs.statSync(a).isDirectory()) {
      fs.mkdirSync(b, { recursive: true });
      copyTree(a, b, count);
    } else {
      fs.copyFileSync(a, b);
      count.n++;
    }
  }
  return count.n;
}

function main() {
  const src = findZip();
  say(`Updating from ${src}`);
  let root = src;
  let tmp = null;
  if (fs.statSync(src).isFile()) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snippy-update-'));
    unzip(src, tmp);
    root = fs.existsSync(path.join(tmp, 'snippy', 'package.json')) ? path.join(tmp, 'snippy') : tmp;
  }
  if (!fs.existsSync(path.join(root, 'package.json'))) throw new Error("That doesn't look like a Snippy update (no package.json inside).");

  const files = copyTree(root, here);
  say(`Copied ${files} files.`);

  // Merge package.json: take the new version, scripts, dependencies list and build settings,
  // keep everything of yours (approvals and anything else npm wrote) and your release settings.
  const mine = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
  const next = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const before = mine.version;
  const needed = [];
  for (const field of ['dependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(next[field] || {})) {
      const have = (mine.dependencies || {})[name] || (mine.devDependencies || {})[name];
      if (!have) needed.push({ name, range, dev: field === 'devDependencies' });
    }
  }
  mine.version = next.version;
  mine.description = next.description || mine.description;
  mine.scripts = { ...(mine.scripts || {}), ...(next.scripts || {}) };
  const publish = mine.build && mine.build.publish;
  mine.build = { ...(next.build || {}) };
  if (publish) mine.build.publish = publish;
  fs.writeFileSync(path.join(here, 'package.json'), `${JSON.stringify(mine, null, 2)}\n`);
  say(`Version ${before} → ${mine.version}. Your package approvals and release settings were kept.`);

  if (needed.length) {
    say(`New packages needed: ${needed.map((d) => d.name).join(', ')}`);
    if (process.env.SNIPPY_UPDATE_DRY_RUN) {
      say('(dry run: not installing)');
    } else {
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      for (const dev of [false, true]) {
        const list = needed.filter((d) => d.dev === dev).map((d) => `${d.name}@${d.range}`);
        if (!list.length) continue;
        const r = spawnSync(npm, ['install', ...(dev ? ['--save-dev'] : []), ...list], { stdio: 'inherit', cwd: here, shell: process.platform === 'win32' });
        if (r.status !== 0) throw new Error(`npm install failed. Try it yourself: ${npm} install ${list.join(' ')}`);
      }
      say('If npm listed packages with install scripts to approve, approve them with: npm install-scripts approve <name>');
    }
  } else {
    say('No new packages needed.');
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  say('Done. Start Snippy with: npm start');
}

try {
  main();
} catch (err) {
  console.error(`\nUpdate stopped: ${err.message}`);
  process.exit(1);
}
