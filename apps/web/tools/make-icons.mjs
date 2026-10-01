/**
 * Writes every image of the mark from the one drawing in
 * src/components/shieldMark.js:
 *
 *   public/shield.svg              the favicon and the offline page's mark
 *   public/icon-192.png, -512.png  installed web app (transparent)
 *   public/icon-maskable-512.png   Android's masked icon (shield inside the safe zone)
 *   public/apple-touch-icon.png    iOS home screen (iOS fills transparency with black)
 *   ../mobile/assets/shield.png    the mark inside the mobile app
 *   ../mobile/assets/icon.png      the mobile app icon
 *   ../mobile/assets/adaptive-icon.png  Android adaptive icon foreground
 *
 *   node tools/make-icons.mjs        (USC_CHROMIUM_PATH if Chromium is not where Playwright looks)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { shieldDocument, shieldInner, SHIELD_VIEWBOX, SHIELD_RATIO } from '../src/components/shieldMark.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, '..');
const mobileAssets = path.resolve(web, '../mobile/assets');
fs.mkdirSync(mobileAssets, { recursive: true });

fs.writeFileSync(path.join(web, 'public/shield.svg'), shieldDocument({ shadow: false }));

const NAVY = 'radial-gradient(120% 100% at 50% 18%, #0c3f72 0%, #001f3f 55%, #00152b 100%)';

/**
 * One PNG: a canvas `size` high (and `width` wide, square by default), the shield `fill` of its height,
 * centred, on a navy ground or transparent.
 */
async function render(page, file, { size, width = size, fill, ground = null, shadow = true }) {
  const h = Math.round(size * fill);
  const w = Math.round(h * SHIELD_RATIO);
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">
    <div id="c" style="width:${width}px;height:${size}px;display:grid;place-items:center;${ground ? `background:${ground}` : ''}">
      <svg viewBox="${SHIELD_VIEWBOX}" width="${w}" height="${h}" style="overflow:visible">${shieldInner('i', { gleam: false, shadow })}</svg>
    </div></body></html>`);
  await page.locator('#c').screenshot({ path: file, omitBackground: !ground });
  console.log('wrote', path.relative(path.resolve(web, '..'), file), `${width}x${size}`);
}

const browser = await chromium.launch(process.env.USC_CHROMIUM_PATH ? { executablePath: process.env.USC_CHROMIUM_PATH } : {});
const page = await browser.newPage({ deviceScaleFactor: 1 });

await render(page, path.join(web, 'public/icon-192.png'), { size: 192, fill: 0.92 });
await render(page, path.join(web, 'public/icon-512.png'), { size: 512, fill: 0.92 });
// Android crops a maskable icon to as little as the middle 80% circle.
await render(page, path.join(web, 'public/icon-maskable-512.png'), { size: 512, fill: 0.6, ground: NAVY, shadow: false });
await render(page, path.join(web, 'public/apple-touch-icon.png'), { size: 180, fill: 0.78, ground: NAVY });
// Shield-shaped rather than square, so the app can size it by height.
await render(page, path.join(mobileAssets, 'shield.png'), { size: 480, width: 420, fill: 0.94 });
await render(page, path.join(mobileAssets, 'icon.png'), { size: 1024, fill: 0.78, ground: NAVY });
await render(page, path.join(mobileAssets, 'adaptive-icon.png'), { size: 1024, fill: 0.58, shadow: false });

await browser.close();
console.log('wrote', 'web/public/shield.svg');
