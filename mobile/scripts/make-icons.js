// Draws the Android app icons (mobile/res) from the Snippy logo in src/splash.html.
//   node mobile/scripts/make-icons.js src/splash.html mobile/res
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const fs = require('fs');
const path = require('path');
const [,, splashHtml, outDir] = process.argv;
const html = fs.readFileSync(splashHtml, 'utf8');
const svg = html.slice(html.indexOf('<svg viewBox="0 0 1024 1024"'), html.indexOf('</svg>') + 6);
const defs = svg.slice(svg.indexOf('<defs>'), svg.indexOf('</defs>') + 7);
const art = svg.slice(svg.indexOf('<!-- Blade with the lower point'), svg.lastIndexOf('</svg>'));
const fg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-200 -188 1400 1400">${defs}${art}</svg>`;
const bg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${defs}<rect width="1024" height="1024" fill="url(#tile)"/><rect width="1024" height="1024" fill="url(#shine)"/></svg>`;
const full = svg.replace('<svg viewBox', '<svg xmlns="http://www.w3.org/2000/svg" viewBox');
const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
  const page = await b.newPage();
  async function shot(markup, size, file, round = false) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px;${round ? 'border-radius:50%;overflow:hidden;' : ''}">${markup.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div></body></html>`);
    await page.screenshot({ path: file, omitBackground: true });
  }
  for (const [d, k] of Object.entries(dens)) {
    const dir = path.join(outDir, `mipmap-${d}`);
    fs.mkdirSync(dir, { recursive: true });
    await shot(fg, Math.round(108 * k), path.join(dir, 'ic_launcher_foreground.png'));
    await shot(bg, Math.round(108 * k), path.join(dir, 'ic_launcher_background.png'));
    await shot(full, Math.round(48 * k), path.join(dir, 'ic_launcher.png'));
    await shot(bg.replace('</svg>', `${art.replace(/<g class/g, '<g transform="translate(0 0)" class')}</svg>`), Math.round(48 * k), path.join(dir, 'ic_launcher_round.png'), true);
  }
  await shot(full, 512, path.join(outDir, 'icon-512.png'));
  await b.close();
})();
