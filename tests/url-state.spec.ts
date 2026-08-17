import { test, expect } from '@playwright/test';

test.describe('URL hash state serialization', () => {
    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await page.addInitScript(() => {
            try { localStorage.setItem('qs_guide_dismissed_v4', '1'); } catch (e) {}
        });
    });

    test('reads chaos from hash on load', async ({ page }) => {
        await page.goto('/#ch=1.50&sc=30');
        await page.waitForFunction(() => (window as any).__qsReady === true);
        const chaos = await page.inputValue('#chaos');
        expect(parseFloat(chaos)).toBeCloseTo(1.5, 1);
        const scale = await page.inputValue('#scale');
        expect(parseFloat(scale)).toBeCloseTo(30, 1);
    });

    test('reads topology from hash and morphs to it', async ({ page }) => {
        await page.goto('/#t=2');
        await page.waitForFunction(() => (window as any).__qsReady === true);
        await expect(page.locator('#info-title')).toContainText('Tesseract', { timeout: 5000 });
    });

    test('invalid hash values are silently ignored (no crash)', async ({ page }) => {
        await page.goto('/#ch=NOTANUMBER&t=999&p=-1');
        await page.waitForFunction(() => (window as any).__qsReady === true);
        // Chaos should still be at its default (0.18)
        const chaos = await page.inputValue('#chaos');
        expect(parseFloat(chaos)).toBeCloseTo(0.18, 1);
    });

    test('__qsState.serialize() returns a parseable hash string', async ({ page }) => {
        await page.goto('/');
        await page.waitForFunction(() => (window as any).__qsReady === true);
        const hash = await page.evaluate(() => (window as any).__qsState.serialize());
        expect(hash).toContain('t=');
        expect(hash).toContain('ch=');
        expect(hash).toContain('bl=');
        // All values should be numeric
        const params = new URLSearchParams(hash);
        for (const [, v] of params) {
            expect(isNaN(Number(v))).toBe(false);
        }
    });

    test('C key copies a parseable URL hash to clipboard', async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.goto('/');
        await page.waitForFunction(() => (window as any).__qsReady === true);
        await page.keyboard.press('c');
        await page.waitForTimeout(250);
        const text = await page.evaluate(() => navigator.clipboard.readText());
        expect(text).toContain('#t=');
        expect(text).toContain('ch=');
        const url = new URL(text);
        const params = new URLSearchParams(url.hash.replace(/^#/, ''));
        expect(params.get('t')).not.toBeNull();
    });

    test('HUD shows "Link copied!" after C key and reverts', async ({ page }) => {
        await page.goto('/');
        await page.waitForFunction(() => (window as any).__qsReady === true);
        await page.keyboard.press('c');
        await expect(page.locator('#hud-mode')).toContainText('Link copied', { timeout: 5000 });
        // After 1.8s it should revert
        await expect(page.locator('#hud-mode')).not.toContainText('Link copied', { timeout: 8000 });
    });
});
