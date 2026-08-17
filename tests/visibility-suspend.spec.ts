import { test, expect } from '@playwright/test';

// Guards the tab-hide teardown contract (README/ARCHITECTURE: "full teardown on
// tab hide"): when the tab goes hidden the camera and microphone must be fully
// stopped, and on return they must be re-acquired ONLY if they were on at hide
// time. MediaStreamTracks cannot be restarted once stopped, so a hidden-tab
// suspend has to run the whole guarded enable path again on restore.
test.describe('Tab hide teardown & restore', () => {
  test('hiding the tab stops the camera; returning re-acquires it', async ({ page }) => {
    // The camera pipeline (model download + WASM init) is slow on software
    // rasterisers, and this test drives it twice (enable, suspend, re-enable).
    test.setTimeout(300000);
    page.on('pageerror', (e) => { throw new Error(`pageerror: ${e.message}`); });

    await page.goto('/', { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__qsReady === true, { timeout: 45000 });

    const guideVisible = await page.locator('#guide-overlay').isVisible();
    if (guideVisible) await page.click('#modal-launch');

    // Camera on. (#modal-launch is the guide's CTA, which enables the camera.)
    await expect
      .poll(async () => page.locator('#camera-toggle').textContent(), { timeout: 150000 })
      .toContain('Disable camera');
    await expect(page.locator('#backend-badge')).toContainText('on-device');

    // Simulate the tab going hidden (document.hidden is not directly settable).
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Full teardown: toggle back to "Enable camera", backend badge to "camera off".
    await expect(page.locator('#camera-toggle')).toHaveText('Enable camera', { timeout: 15000 });
    await expect(page.locator('#backend-badge')).toContainText('camera off');
    await expect(page.locator('#camera-toggle')).toHaveAttribute('aria-pressed', 'false');

    // Tab becomes visible again: camera is re-acquired automatically.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await expect
      .poll(async () => page.locator('#camera-toggle').textContent(), { timeout: 150000 })
      .toContain('Disable camera');
    await expect(page.locator('#backend-badge')).toContainText('on-device');
  });

  test('a camera that was off before hiding stays off on return', async ({ page }) => {
    test.setTimeout(120000);

    await page.goto('/', { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__qsReady === true, { timeout: 45000 });

    // Do NOT click #modal-launch: it is the guide's CTA and enables the camera.
    // The guide overlay staying open does not block the visibility cycle below.
    await expect(page.locator('#camera-toggle')).toHaveText('Enable camera');

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Never re-enabled: the visitor did not have it on.
    await expect(page.locator('#camera-toggle')).toHaveText('Enable camera', { timeout: 15000 });
    await expect(page.locator('#backend-badge')).toContainText('camera off');
  });
});