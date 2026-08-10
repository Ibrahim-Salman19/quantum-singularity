// Ad-hoc diagnostic harness: boots the page in a real browser and reports every
// console message, page error and failed request. Not part of the suite.
import { chromium } from '@playwright/test';

const browser = await chromium.launch({
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--ignore-gpu-blocklist',
    '--no-sandbox'
  ]
});
const page = await browser.newPage();
page.on('console', m => console.log(`[${m.type()}]`, m.text()));
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('requestfailed', r => console.log('[reqfail]', r.url(), r.failure()?.errorText));

await page.goto('http://localhost:8089/', { waitUntil: 'load', timeout: 30000 });
try {
  await page.waitForFunction(() => window.__qsReady === true, { timeout: 20000 });
  console.log('RESULT: __qsReady = true');
} catch {
  console.log('RESULT: __qsReady NEVER SET');
}
console.log('canvas count:', await page.locator('canvas.webgl-canvas').count());
console.log('fps text:', await page.locator('#hud-fps').textContent());
console.log('hud mode:', await page.locator('#hud-mode').textContent());
await browser.close();
