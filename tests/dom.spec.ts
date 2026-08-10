import { test, expect } from '@playwright/test';

test.describe('DOM Structure and Interface Tests', () => {

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('qs_guide_dismissed_v4', '1');
    });
  });

  test('Page loads with correct title and header elements', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveTitle(/Quantum Singularity/);
    const titleHeader = page.locator('#info h1');
    await expect(titleHeader).toHaveText(/QUANTUM SINGULARITY/i);
  });

  test('HUD particles indicator is visible', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const particleHud = page.locator('#hud-particles');
    await expect(particleHud).toBeVisible();
    await expect(particleHud).toContainText(/PTS/);
  });

  test('Preset buttons toggle active state correctly', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).__qsReady === true);
    const torusBtn = page.locator('.btn-preset[data-shape="1"]');
    await torusBtn.click();
    await expect(torusBtn).toHaveClass(/active/);
    await expect(torusBtn).toHaveAttribute('aria-pressed', 'true');
  });

  test('Color swatches select palette cleanly', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).__qsReady === true);
    const swatch2 = page.locator('.swatch[data-pal="2"]');
    await swatch2.click();
    await expect(swatch2).toHaveClass(/active/);
    await expect(swatch2).toHaveAttribute('aria-pressed', 'true');
  });

  test('HUD Guide button opens and closes guide modal', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).__qsReady === true);
    const guideBtn = page.locator('#hud-help-btn');
    await guideBtn.click();
    const overlay = page.locator('#guide-overlay');
    await expect(overlay).toHaveClass(/visible/);

    const closeBtn = page.locator('#modal-close');
    await closeBtn.click();
    await expect(overlay).not.toHaveClass(/visible/);
  });

});
