import { test, expect } from '@playwright/test';

test.describe('Gesture Engine & Neural Link Tests', () => {

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('qs_guide_dismissed_v4', '1');
    });
  });

  test('Neural status badge initializes cleanly in camera off state', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const statusEl = page.locator('#nstatus');
    await expect(statusEl).toBeVisible();
    await expect(statusEl).toContainText(/Camera off/i);
  });

  test('Camera toggle button triggers status update on click', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).__qsReady === true);
    const cameraBtn = page.locator('#camera-toggle');
    await cameraBtn.click();
    const statusEl = page.locator('#nstatus');
    await expect(statusEl).toBeVisible();
  });

});
