'use strict';
// Draws scripts/update-splash.html as a seamless looping GIF: src/update/update-splash.gif
// (shown by src/update/update-splash.ps1 while an update installs). Needs Playwright and FFmpeg.
//   node scripts/make-update-splash.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

const LOOP = 2.4; // seconds: the length of every animation in the page
const FPS = 20;
const SCALE = 1.5; // drawn at twice the size, so it stays sharp on high-DPI screens

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snippy-gif-'));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 420, height: 300 }, deviceScaleFactor: SCALE });
  await page.goto(`file://${path.join(__dirname, 'update-splash.html')}`);
  await page.waitForTimeout(300);
  // Step every animation by hand, one frame at a time, so the loop is exact.
  const n = Math.round(LOOP * FPS);
  for (let i = 0; i < n; i++) {
    await page.evaluate((t) => { for (const a of document.getAnimations()) { a.pause(); a.currentTime = t; } }, (i / FPS) * 1000);
    await page.screenshot({ path: path.join(dir, `f${String(i).padStart(3, '0')}.png`) });
  }
  await browser.close();
  const out = path.join(__dirname, '..', 'src', 'update', 'update-splash.gif');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(FPS), '-i', path.join(dir, 'f%03d.png'),
    '-vf', 'split[a][b];[a]palettegen=max_colors=96:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', '-loop', '0', out]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('wrote', out, `${Math.round(fs.statSync(out).size / 1024)} KB`);
})();
