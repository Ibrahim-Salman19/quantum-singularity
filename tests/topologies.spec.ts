import { test, expect } from '@playwright/test';

test.describe('Topology expansion — topo4 (Hopf) and topo5 (Lorenz)', () => {
    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await page.addInitScript(() => {
            try { localStorage.setItem('qs_guide_dismissed_v4', '1'); } catch (e) {}
        });
        await page.goto('/');
        await page.waitForFunction(() => (window as any).__qsReady === true, null, { timeout: 45000 });
    });

    test('key 5 morphs to Hopf Fibration', async ({ page }) => {
        await page.keyboard.press('5');
        await expect(page.locator('#info-title')).toContainText('Hopf', { timeout: 15000 });
    });

    test('key 6 morphs to Lorenz Manifold', async ({ page }) => {
        await page.keyboard.press('6');
        await expect(page.locator('#info-title')).toContainText('Lorenz', { timeout: 15000 });
    });

    test('preset button data-shape=4 activates and is marked active', async ({ page }) => {
        const btn = page.locator('.btn-preset[data-shape="4"]');
        await expect(btn).toBeVisible();
        await btn.click();
        await expect(btn).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('#info-title')).toContainText('Hopf', { timeout: 15000 });
    });

    test('preset button data-shape=5 activates and is marked active', async ({ page }) => {
        const btn = page.locator('.btn-preset[data-shape="5"]');
        await expect(btn).toBeVisible();
        await btn.click();
        await expect(btn).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('#info-title')).toContainText('Lorenz', { timeout: 15000 });
    });

    test('morph 4->5 smooth — no crash', async ({ page }) => {
        await page.keyboard.press('5');
        await page.waitForTimeout(200);
        await page.keyboard.press('6');
        await page.waitForTimeout(200);
        const alive = await page.evaluate(() => !!(window as any).__qsReady);
        expect(alive).toBe(true);
    });

    test('keys 1 through 6 map to all 6 distinct topologies', async ({ page }) => {
        const expected = [
            { key: '1', name: 'Singularity' },
            { key: '2', name: 'Lotus' },
            { key: '3', name: 'Tesseract' },
            { key: '4', name: 'Attractor' },
            { key: '5', name: 'Hopf' },
            { key: '6', name: 'Lorenz' },
        ];
        for (const { key, name } of expected) {
            await page.keyboard.press(key);
            await expect(page.locator('#info-title')).toContainText(name, { timeout: 15000 });
        }
    });
});
