// Renders public/og.png (1200x630), the link preview Twitch and Discord show for pixfray.xyz.
// Uses only the site's own character art and font. Rerun after adding characters: node scripts/og-image.mjs
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromeOptions } from '../tests/chrome.mjs';

const root = new URL('../public/', import.meta.url);
const catalog = JSON.parse(readFileSync(new URL('assets/characters.json', root)));
const picks = ['adventurer', 'toon-ranger', 'alien-pink', 'soldier', 'toon-robot', 'zombie', 'alien-green'];
const sprite = (id) => {
  const c = catalog.find((x) => x.id === id), f = c.animations?.idle?.[0] || c.frames[0];
  const scale = 190 / f.h;
  return `<div class="s" style="width:${f.w * scale}px;height:190px;background:url(${new URL(c.url.slice(1), root)}) -${f.x * scale}px -${f.y * scale}px/auto ${190 * (readSize(c.url).h / f.h)}px"></div>`;
};
function readSize(url) {   // PNG width/height from the IHDR chunk
  const b = readFileSync(new URL(url.slice(1), root));
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
const html = `<!doctype html><html><head><style>
@font-face { font-family: Fraunces; src: url(${new URL('assets/fonts/fraunces-latin.woff2', root)}) format('woff2'); font-weight: 100 900; }
html, body { margin: 0; width: 1200px; height: 630px; background: #17110c; color: #f2e8d5; font-family: system-ui, sans-serif; }
.wrap { box-sizing: border-box; height: 630px; padding: 72px 80px 0; border-bottom: 12px solid #c9a45c; display: flex; flex-direction: column; }
h1 { margin: 0; font: 650 112px/1 Fraunces, serif; color: #c9a45c; letter-spacing: -1px; }
p { margin: 20px 0 0; font-size: 36px; color: #d6c6a8; }
.row { margin-top: auto; display: flex; align-items: flex-end; justify-content: space-between; padding-bottom: 36px; border-bottom: 2px solid #6b5234; }
.s { flex: none; }
</style></head><body><div class="wrap">
<h1>PixFray</h1><p>Pick your fighter and duel in the Twitch chats you watch.</p>
<div class="row">${picks.map(sprite).join('')}</div></div></body></html>`;

const browser = await chromium.launch(chromeOptions());
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
const file = join(mkdtempSync(join(tmpdir(), 'og-')), 'og.html');   // file:// so the art and font load
writeFileSync(file, html);
await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: new URL('og.png', root).pathname.replace(/^\/([A-Z]:)/, '$1') });
await browser.close();
console.log('wrote public/og.png');
