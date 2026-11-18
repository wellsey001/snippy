'use strict';
// Finishes the Android project after `npx cap add android`: Snippy's icons, opening screen and
// colours, the gallery-saving plugin, the permissions it needs, and the version number (taken
// from the main package.json, so the phone and desktop versions match). Run from mobile/:
//   npx cap add android && node scripts/android-setup.js && npx cap sync android
const fs = require('fs');
const path = require('path');

const here = path.join(__dirname, '..');
const app = path.join(here, 'android', 'app');
const main = path.join(app, 'src', 'main');
const res = path.join(main, 'res');
const must = (cond, what) => { if (!cond) { console.error(`android-setup: couldn't ${what}`); process.exit(1); } };
must(fs.existsSync(main), 'find the Android project (run `npx cap add android` first)');

// Icons
for (const d of fs.readdirSync(path.join(here, 'res'))) {
  const from = path.join(here, 'res', d);
  if (!fs.statSync(from).isDirectory()) continue;
  fs.mkdirSync(path.join(res, d), { recursive: true });
  for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(res, d, f));
}
const adaptive = '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n  <background android:drawable="@mipmap/ic_launcher_background"/>\n  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n</adaptive-icon>\n';
fs.mkdirSync(path.join(res, 'mipmap-anydpi-v26'), { recursive: true });
fs.writeFileSync(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml'), adaptive);
fs.writeFileSync(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), adaptive);

// Colours, and the opening screen: Snippy's dark background with the logo (instead of the
// Capacitor pictures the template comes with).
fs.mkdirSync(path.join(res, 'values'), { recursive: true });
fs.writeFileSync(path.join(res, 'values', 'snippy_colors.xml'), '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="snippy_bg">#110F17</color>\n</resources>\n');
for (const d of fs.readdirSync(res)) {
  if (!d.startsWith('drawable')) continue;
  const f = path.join(res, d, 'splash.png');
  if (fs.existsSync(f)) fs.rmSync(f);
}
fs.mkdirSync(path.join(res, 'drawable'), { recursive: true });
fs.writeFileSync(path.join(res, 'drawable', 'splash.xml'), '<?xml version="1.0" encoding="utf-8"?>\n<layer-list xmlns:android="http://schemas.android.com/apk/res/android">\n  <item android:drawable="@color/snippy_bg"/>\n  <item android:width="132dp" android:height="132dp" android:gravity="center">\n    <bitmap android:src="@mipmap/ic_launcher" android:gravity="fill"/>\n  </item>\n</layer-list>\n');
const stylesFile = path.join(res, 'values', 'styles.xml');
if (fs.existsSync(stylesFile)) {
  let st = fs.readFileSync(stylesFile, 'utf8');
  // Adds items to a style, replacing any it already has with the same name.
  const add = (styleName, items) => {
    const re = new RegExp(`(<style name="${styleName.replace(/\./g, '\\.')}"[^>]*>)([\\s\\S]*?)(</style>)`);
    st = st.replace(re, (m, open, body, close) => {
      for (const [k] of items) body = body.replace(new RegExp(`\\s*<item name="${k}">[^<]*</item>`, 'g'), '');
      return `${open}${body}${items.map(([k, v]) => `\n        <item name="${k}">${v}</item>`).join('')}\n    ${close}`;
    });
  };
  add('AppTheme.NoActionBar', [['android:statusBarColor', '@color/snippy_bg'], ['android:navigationBarColor', '@color/snippy_bg'], ['android:windowBackground', '@color/snippy_bg']]);
  add('AppTheme.NoActionBarLaunch', [['windowSplashScreenBackground', '@color/snippy_bg'], ['windowSplashScreenAnimatedIcon', '@mipmap/ic_launcher_foreground']]);
  fs.writeFileSync(stylesFile, st);
}

// The gallery-saving plugin, registered by Snippy's main activity.
const javaDir = path.join(main, 'java', 'com', 'wellsey001', 'snippy');
fs.mkdirSync(javaDir, { recursive: true });
for (const f of ['MainActivity.java', 'SnippySavePlugin.java']) fs.copyFileSync(path.join(here, 'native', f), path.join(javaDir, f));

// Permissions and settings.
const manFile = path.join(main, 'AndroidManifest.xml');
let man = fs.readFileSync(manFile, 'utf8');
if (!man.includes('WRITE_EXTERNAL_STORAGE')) man = man.replace(/(\s*)<application/, '$1<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />$1<application');
if (!man.includes('largeHeap')) man = man.replace('<application', '<application\n        android:largeHeap="true"');
// The editor is laid out for holding the phone upright.
man = man.replace(/(<activity[^>]*?)(\s*android:name="\.?MainActivity")/, (m, a, b) => (m.includes('screenOrientation') ? m : `${a}\n            android:screenOrientation="portrait"${b}`));
fs.writeFileSync(manFile, man);

// Version, from the main package.json (0.49.0 → versionCode 4900).
const version = require(path.join(here, '..', 'package.json')).version;
const [a, b, c] = version.split('.').map(Number);
const code = a * 1000000 + b * 100 + c;
const gradleFile = path.join(app, 'build.gradle');
let g = fs.readFileSync(gradleFile, 'utf8');
must(/versionCode\s+\d+/.test(g), 'find versionCode in app/build.gradle');
g = g.replace(/versionCode\s+\d+/, `versionCode ${code}`).replace(/versionName\s+"[^"]*"/, `versionName "${version}"`);
fs.writeFileSync(gradleFile, g);
console.log(`Android project set up: Snippy ${version} (version code ${code})`);
