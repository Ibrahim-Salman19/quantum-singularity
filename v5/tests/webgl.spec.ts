import { test, expect } from '@playwright/test';

test.describe('WebGL 2 & Shader Canvas Tests', () => {

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('qs_guide_dismissed_v4', '1');
    });
  });

  test('WebGL canvas element attaches to body', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const canvas = page.locator('canvas.webgl-canvas');
    await expect(canvas).toBeVisible();
  });

  test('FPS counter updates dynamically in bottom HUD', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const fpsHud = page.locator('#hud-fps');
    await expect(fpsHud).toBeVisible();
    await page.waitForTimeout(1200);
    const fpsText = await fpsHud.textContent();
    expect(fpsText).toContain('FPS');
  });

  test('Focus Mode hides UI panels and shows exit button', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).__qsReady === true);
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.keyboard.press('f');
    await expect(page.locator('body')).toHaveClass(/focus-mode/);
    const exitBtn = page.locator('#focus-exit');
    await expect(exitBtn).toBeVisible();
    await exitBtn.click();
    await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  });

});
