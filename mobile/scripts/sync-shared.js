'use strict';
// Copies the code the phone app shares with the desktop app into www/shared, so there's one copy
// of each to change: effects, text drawing, montage planning, camera moves, the AutoCut prompt
// and beat finding. Run before building (the Android build does it by itself):
//   node mobile/scripts/sync-shared.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const out = path.join(__dirname, '..', 'www', 'shared');
fs.mkdirSync(out, { recursive: true });
for (const f of ['effects.js', 'anims.js', 'captions.js', 'plans.js', 'keyframes.js', 'prompt.js']) {
  fs.copyFileSync(path.join(root, 'src', f), path.join(out, f));
}
// Files written for Node are wrapped so a web page can use them (as window.<name>).
for (const [f, name] of [['beats.js', 'SnippyBeats'], ['caption-timing.js', 'SnippyCaptionTiming']]) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  fs.writeFileSync(path.join(out, f), `// Copied from ${f} by mobile/scripts/sync-shared.js. Don't edit here.\n(function () {\nconst module = { exports: {} };\n${src}\nwindow.${name} = module.exports;\n}());\n`);
}
// The version number shown in the app: the same as the desktop app's.
const version = require(path.join(root, 'package.json')).version;
fs.writeFileSync(path.join(out, 'version.js'), `window.SNIPPY_VERSION = ${JSON.stringify(version)};\n`);
console.log(`Shared code copied to mobile/www/shared (version ${version})`);
