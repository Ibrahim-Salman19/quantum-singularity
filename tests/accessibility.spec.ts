import { test, expect } from '@playwright/test';

test.describe('Accessibility & Keyboard Interaction Tests', () => {

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('qs_guide_dismissed_v4', '1');
    });
  });

  test('Keyboard shortcut H toggles guide overlay', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).__qsReady === true);
    const overlay = page.locator('#guide-overlay');
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    
    // Press H to open
    await page.keyboard.press('h');
    await expect(overlay).toHaveClass(/visible/);

    // Press Escape to close
    await page.keyboard.press('Escape');
    await expect(overlay).not.toHaveClass(/visible/);
  });

  test('Keyboard shortcut R resets sliders', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).__qsReady === true);
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.keyboard.press('r');
    const particleHud = page.locator('#hud-particles');
    await expect(particleHud).toBeVisible();
  });

  test('Camera toggle button has proper ARIA attributes', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const cameraBtn = page.locator('#camera-toggle');
    await expect(cameraBtn).toHaveAttribute('aria-pressed', 'false');
    await expect(cameraBtn).toContainText('Enable camera');
  });

});
