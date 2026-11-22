import { test, expect } from '@playwright/test';

// First-run contract: the field is the first impression. No modal on arrival; a
// compact, non-modal welcome card appears after the scene settles, offers the two
// ways in, never steals focus, and is dismissed for good by any engagement.
const KEY = 'qs_guide_dismissed_v4';

async function firstVisit(page) {
  await page.goto('/');
  await page.evaluate((key) => localStorage.removeItem(key), KEY);
  await page.reload();
  await page.waitForFunction(() => window.__qsReady === true, { timeout: 45000 });
}

test.describe('First-run onboarding', () => {
  test('arrival shows the field, not a modal, then a welcome card', async ({ page }) => {
    await firstVisit(page);
    const card = page.locator('#intro-card');
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#guide-overlay')).not.toHaveClass(/visible/);
    await expect(card.getByRole('heading')).toHaveText(/hands/i);
    // Non-modal: it must not take focus from wherever the visitor is.
    const focusInCard = await page.evaluate(() => document.getElementById('intro-card').contains(document.activeElement));
    expect(focusInCard).toBe(false);
    // And the rest of the UI stays operable.
    await expect(page.locator('#ui')).not.toHaveAttribute('inert', '');
  });

  test('"Explore with mouse" dismisses it permanently', async ({ page }) => {
    await firstVisit(page);
    await page.locator('#intro-dismiss').click();
    await expect(page.locator('#intro-card')).toBeHidden();
    await page.reload();
    await page.waitForFunction(() => window.__qsReady === true, { timeout: 45000 });
    await page.waitForTimeout(2200);
    await expect(page.locator('#intro-card')).toBeHidden();
  });

  test('"How it works" opens the full guide', async ({ page }) => {
    await firstVisit(page);
    await page.locator('#intro-guide').click();
    await expect(page.locator('#guide-overlay')).toHaveClass(/visible/);
    await expect(page.locator('#intro-card')).toBeHidden();
    await expect(page.locator('#modal-close')).toBeFocused();
  });

  test('Escape dismisses it', async ({ page }) => {
    await firstVisit(page);
    await expect(page.locator('#intro-card')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('#intro-card')).toBeHidden();
  });

  test('returning visitors are not greeted again', async ({ page }) => {
    await page.addInitScript((key) => { try { localStorage.setItem(key, '1'); } catch (e) {} }, KEY);
    await page.goto('/');
    await page.waitForFunction(() => window.__qsReady === true, { timeout: 45000 });
    await page.waitForTimeout(2200);
    await expect(page.locator('#intro-card')).toBeHidden();
    await expect(page.locator('#guide-overlay')).not.toHaveClass(/visible/);
  });

  test('the guide lists every topology shortcut', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#guide-overlay .shortcut-row')).toContainText('1-6');
  });
});
