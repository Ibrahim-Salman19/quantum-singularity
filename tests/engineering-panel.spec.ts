import { test, expect } from '@playwright/test';

/**
 * Covers the two "show your work" surfaces added in 5.2: the engineering notes
 * modal (B) and the GPU/performance stats HUD readout (P).
 *
 * The engineering modal reuses the guide modal's accessibility contract, so these
 * tests assert that contract explicitly (focus moves in, `inert` isolates the
 * background, Escape closes, the two modals are mutually exclusive) rather than
 * just that the element becomes visible.
 */

async function boot(page) {
  // Full-app boots are heavy under software rasterisation; give each test a
  // generous budget so a slow CI runner surfaces real failures, not timeouts.
  test.setTimeout(120000);
  await page.addInitScript(() => {
    try { localStorage.setItem('qs_guide_dismissed_v4', '1'); } catch (e) {}
  });
  await page.goto('/');
  await page.waitForFunction(() => window.__qsReady === true, null, { timeout: 45000 });
}

test.describe('Engineering notes modal', () => {
  test.beforeEach(async ({ page }) => boot(page));

  test('starts closed and inert so its controls stay out of the tab order', async ({ page }) => {
    const overlay = page.locator('#eng-overlay');
    await expect(overlay).not.toHaveClass(/visible/);
    await expect(overlay).toHaveAttribute('inert', '');
    await expect(overlay).toHaveAttribute('aria-hidden', 'true');
  });

  test('opens from the Build button and moves focus into the dialog', async ({ page }) => {
    await page.click('#eng-btn');
    const overlay = page.locator('#eng-overlay');
    await expect(overlay).toHaveClass(/visible/);
    await expect(overlay).not.toHaveAttribute('inert', '');
    // Focus must land inside the dialog, not stay on the trigger behind it.
    await expect(page.locator('#eng-close')).toBeFocused();
  });

  test('marks the background regions inert while open, and restores them on close', async ({ page }) => {
    await page.click('#eng-btn');
    await expect(page.locator('#ui')).toHaveAttribute('inert', '');
    await expect(page.locator('#nui')).toHaveAttribute('inert', '');
    await expect(page.locator('#bottom-hud')).toHaveAttribute('inert', '');

    await page.click('#eng-close');
    await expect(page.locator('#eng-overlay')).not.toHaveClass(/visible/);
    await expect(page.locator('#ui')).not.toHaveAttribute('inert', '');
    await expect(page.locator('#nui')).not.toHaveAttribute('inert', '');
    await expect(page.locator('#bottom-hud')).not.toHaveAttribute('inert', '');
  });

  test('keyboard shortcut B toggles it and Escape closes it', async ({ page }) => {
    const overlay = page.locator('#eng-overlay');
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());

    await page.keyboard.press('b');
    await expect(overlay).toHaveClass(/visible/);

    await page.keyboard.press('Escape');
    await expect(overlay).not.toHaveClass(/visible/);
  });

  test('is mutually exclusive with the guide modal', async ({ page }) => {
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.keyboard.press('b');
    await expect(page.locator('#eng-overlay')).toHaveClass(/visible/);

    // Opening the guide must close the engineering panel, so the two overlays can
    // never both be visible and fighting over the same inert background regions.
    await page.keyboard.press('h');
    await expect(page.locator('#guide-overlay')).toHaveClass(/visible/);
    await expect(page.locator('#eng-overlay')).not.toHaveClass(/visible/);
    await expect(page.locator('#eng-overlay')).toHaveAttribute('inert', '');
  });

  test('reports the live particle budget rather than a hardcoded number', async ({ page }) => {
    await page.click('#eng-btn');
    const engStat = await page.locator('#eng-stat-particles').textContent();
    // Matches the device-tiered allocation (32K/52K/56K/82K/110K), not a fixed string.
    expect(engStat).toMatch(/^\d+K$/);
    const hudStat = await page.locator('#hud-particles').textContent();
    expect(hudStat).toContain('PTS');
  });
});

test.describe('GPU / performance stats HUD', () => {
  test.beforeEach(async ({ page }) => boot(page));

  test('toggles the render readout into a GPU/draw-call readout and back', async ({ page }) => {
    const hudMode = page.locator('#hud-mode');
    await expect(hudMode).toContainText(/AUTO Q\d+/);

    await page.click('#stats-btn');
    await expect(page.locator('#stats-btn')).toHaveAttribute('aria-pressed', 'true');
    // The readout updates on the same 600ms throttle as the FPS counter.
    await expect(hudMode).toContainText(/GPU \d|draw calls/, { timeout: 15000 });

    await page.click('#stats-btn');
    await expect(page.locator('#stats-btn')).toHaveAttribute('aria-pressed', 'false');
    await expect(hudMode).toContainText(/AUTO Q\d+/);
  });

  test('counts every composer pass, not just the last one', async ({ page }) => {
    // Regression guard: EffectComposer runs one renderer.render() per pass and
    // WebGLRenderer.info auto-resets on each, so reading info.render.calls after
    // composer.render() reported 1. autoReset is now owned by the render loop.
    await page.click('#stats-btn');
    await expect
      .poll(async () => page.locator('#hud-mode').textContent(), { timeout: 15000 })
      .toMatch(/GPU \d|draw calls/);

    const calls = await page.evaluate(() => {
      const text = document.getElementById('hud-mode')?.textContent ?? '';
      const m = text.match(/(\d+)\s*(?:dc|draw calls)/);
      return m ? Number(m[1]) : -1;
    });
    // The pipeline is RenderPass + UnrealBloomPass (multi-mip) + ShaderPass +
    // OutputPass, so a correct per-frame total is comfortably above 1.
    expect(calls).toBeGreaterThan(1);
  });

  test('keyboard shortcut P toggles the stats readout', async ({ page }) => {
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.keyboard.press('p');
    await expect(page.locator('#stats-btn')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('p');
    await expect(page.locator('#stats-btn')).toHaveAttribute('aria-pressed', 'false');
  });
});
