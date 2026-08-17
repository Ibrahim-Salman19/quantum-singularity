import { test, expect } from '@playwright/test';

test.describe('Four-band audio DSP', () => {
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            try { localStorage.setItem('qs_guide_dismissed_v4', '1'); } catch (e) {}
        });
        await page.goto('/');
        await page.waitForFunction(() => (window as any).__qsReady === true);
    });

    test('computeAudioBandBins returns 4 strictly ordered non-overlapping boundaries', async ({ page }) => {
        const bins = await page.evaluate(() =>
            (window as any).__qsAudio.computeAudioBandBins(44100, 1024, 512)
        );
        expect(bins.subBassBinEnd).toBeGreaterThan(0);
        expect(bins.subBassBinEnd).toBeLessThan(bins.midBassBinEnd);
        expect(bins.midBassBinEnd).toBeLessThan(bins.midBinEnd);
        expect(bins.midBinEnd).toBeLessThan(bins.trebleBinEnd);
        expect(bins.trebleBinEnd).toBeLessThanOrEqual(512);
    });

    test('computeAudioBandBins at 48 kHz gives sensible sub-bass boundary', async ({ page }) => {
        const bins = await page.evaluate(() =>
            (window as any).__qsAudio.computeAudioBandBins(48000, 2048, 1024)
        );
        // 80 Hz at 48kHz, fftSize=2048 → binHz = 48000/2048 ≈ 23.4 Hz → ≈ 3-4 bins
        expect(bins.subBassBinEnd).toBeGreaterThanOrEqual(1);
        expect(bins.subBassBinEnd).toBeLessThan(10);
    });

    test('computeAudioBands bassRaw is weighted blend of sub-bass and mid-bass', async ({ page }) => {
        const result = await page.evaluate(() => {
            const freq = new Uint8Array(512);
            // Fill only the first 2 bins (sub-bass) with max energy
            freq[0] = 255; freq[1] = 255;
            const bins = (window as any).__qsAudio.computeAudioBandBins(44100, 1024, 512);
            const out = { bassRaw: 0, subBassRaw: 0, midBassRaw: 0, midRaw: 0, trebleRaw: 0 };
            (window as any).__qsAudio.computeAudioBands(
                freq, bins.subBassBinEnd, bins.midBassBinEnd, bins.midBinEnd, bins.trebleBinEnd, out
            );
            return out;
        });
        expect(result.subBassRaw).toBeGreaterThan(0);
        // bassRaw is a 0.55/0.45 blend — must be positive when sub-bass is active
        expect(result.bassRaw).toBeGreaterThan(0);
        // Treble bins are all zero
        expect(result.trebleRaw).toBe(0);
        // Mid bins are all zero
        expect(result.midRaw).toBe(0);
    });

    test('computeAudioBands trebleRaw responds to treble-only input', async ({ page }) => {
        const result = await page.evaluate(() => {
            const freq = new Uint8Array(512);
            const bins = (window as any).__qsAudio.computeAudioBandBins(44100, 1024, 512);
            // Fill treble bins only
            for (let i = bins.midBinEnd; i < bins.trebleBinEnd; i++) freq[i] = 200;
            const out = { bassRaw: 0, subBassRaw: 0, midBassRaw: 0, midRaw: 0, trebleRaw: 0 };
            (window as any).__qsAudio.computeAudioBands(
                freq, bins.subBassBinEnd, bins.midBassBinEnd, bins.midBinEnd, bins.trebleBinEnd, out
            );
            return out;
        });
        expect(result.trebleRaw).toBeGreaterThan(0.5);
        expect(result.subBassRaw).toBe(0);
        expect(result.bassRaw).toBe(0);
    });

    test('__qsAudio.state() exposes midSmooth and midBassSmooth keys', async ({ page }) => {
        const state = await page.evaluate(() => (window as any).__qsAudio.state());
        expect('midSmooth' in state).toBe(true);
        expect('midBassSmooth' in state).toBe(true);
        expect(typeof state.midSmooth).toBe('number');
        expect(typeof state.midBassSmooth).toBe('number');
    });
});
