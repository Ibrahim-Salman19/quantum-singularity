import { test, expect } from '@playwright/test';

// Full end-to-end camera pipeline: click "Enable camera", grant permission via
// the fake device flags, wait for the MediaPipe model to download from the CDN
// and the gesture backend to initialize. Guards the model bundle regression:
// Google serves gesture_recognizer.task as a nested ZIP bundle, and the model
// cache validation must accept it.
test.describe('Camera & Gesture Backend Pipeline', () => {
  test('camera enables and gesture backend reaches "Hand tracking active"', async ({ page }) => {
    test.setTimeout(120000);
    page.on('pageerror', (e) => { throw new Error(`pageerror: ${e.message}`); });

    await page.goto('/', { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__qsReady === true, { timeout: 45000 });

    const guideVisible = await page.locator('#guide-overlay').isVisible();
    if (guideVisible) await page.click('#modal-launch');

    const status = page.locator('#nstatus');
    await expect(status).not.toHaveText('', { timeout: 10000 });

    await expect
      .poll(async () => page.locator('#camera-toggle').textContent(), {
        timeout: 90000,
        message: 'camera toggle should reach "Disable camera"'
      })
      .toContain('Disable camera');

    await expect(page.locator('#backend-badge')).toContainText('on-device');
    // After the first no-hand inference completes, the live status settles on
    // "Waiting for a hand". Under system load a cold start can sit in "Hand
    // tracking active" briefly, so poll generously.
    await expect
      .poll(async () => page.locator('#nstatus').textContent(), {
        timeout: 60000,
        message: 'status should settle on "Waiting for a hand"'
      })
      .toContain('Waiting for a hand');
  });

  test('camera toggle round-trips back to off and resets the status', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto('/', { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__qsReady === true, { timeout: 45000 });

    const guideVisible = await page.locator('#guide-overlay').isVisible();
    if (guideVisible) {
      await page.click('#modal-launch');
    } else {
      await page.click('#camera-toggle');
    }

    await expect
      .poll(async () => page.locator('#camera-toggle').textContent(), { timeout: 150000 })
      .toContain('Disable camera');

    await page.click('#camera-toggle');
    await expect(page.locator('#camera-toggle')).toHaveText('Enable camera', { timeout: 10000 });
    await expect(page.locator('#backend-badge')).toContainText('camera off');
    await expect(page.locator('#gname')).toHaveText('No gesture');
    await expect(page.locator('#camera-toggle')).toHaveAttribute('aria-pressed', 'false');
  });
});