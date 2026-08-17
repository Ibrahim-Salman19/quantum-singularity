import { test, expect } from '@playwright/test';

/**
 * Covers the microphone-driven audio reactivity pipeline: the pure band-splitting
 * and onset-detection maths (via window.__qsAudio, the same test-surface pattern
 * __qsGesture uses for the classifier), the idle UI state, and a full enable/disable
 * round trip against the fake audio device configured in playwright.config.js.
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

test.describe('Audio reactivity: idle UI state', () => {
  test.beforeEach(async ({ page }) => boot(page));

  test('microphone toggle starts off with the expected copy and ARIA state', async ({ page }) => {
    const btn = page.locator('#audio-toggle');
    await expect(btn).toHaveText('Enable microphone');
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#astatus')).toContainText(/Sound off/i);
    await expect(page.locator('#abar')).toHaveCSS('width', '0px');
  });

  test('info panel advertises on-device audio as a capability', async ({ page }) => {
    await expect(page.locator('.info-meta')).toContainText('Local audio');
  });
});

test.describe('Audio reactivity: pure band-splitting and onset detection', () => {
  test.beforeEach(async ({ page }) => boot(page));

  test('computeAudioBandBins maps sample rate/FFT size to the documented Hz ranges', async ({ page }) => {
    const bins = await page.evaluate(() => window.__qsAudio.computeAudioBandBins(48000, 1024, 512));
    // binHz = 48000/1024 = 46.875Hz; bass cuts off at ~250Hz, treble spans ~2-8kHz.
    expect(bins.bassBinEnd).toBe(5);
    expect(bins.trebleBinStart).toBe(43);
    expect(bins.trebleBinEnd).toBe(171);
  });

  test('computeAudioBandBins never produces an empty or inverted treble range', async ({ page }) => {
    // A very small FFT size could, without clamping, push trebleBinStart past
    // trebleBinEnd or past the actual bin count.
    const bins = await page.evaluate(() => window.__qsAudio.computeAudioBandBins(48000, 64, 32));
    expect(bins.trebleBinEnd).toBeGreaterThan(bins.trebleBinStart);
    expect(bins.trebleBinEnd).toBeLessThanOrEqual(32);
    expect(bins.bassBinEnd).toBeGreaterThanOrEqual(1);
  });

  test('computeAudioBands reads full-scale bass as 1.0 and silent treble as 0', async ({ page }) => {
    const out = await page.evaluate(() => {
      const bins = window.__qsAudio.computeAudioBandBins(48000, 1024, 512);
      const freq = new Uint8Array(512).fill(0);
      for (let i = 0; i < bins.bassBinEnd; i++) freq[i] = 255;
      return window.__qsAudio.computeAudioBands(freq, bins.bassBinEnd, bins.trebleBinStart, bins.trebleBinEnd, { bassRaw: 0, trebleRaw: 0 });
    });
    expect(out.bassRaw).toBe(1);
    expect(out.trebleRaw).toBe(0);
  });

  test('detectAudioOnset fires a pulse only when energy jumps well above its running average', async ({ page }) => {
    const result = await page.evaluate(() => {
      const out = { bassAvg: 0, pulse: 0, cooldownUntil: 0 };
      // A quiet, steady signal should not trigger a pulse.
      window.__qsAudio.detectAudioOnset(0.05, 0.05, 0, 0, 1000, 1 / 60, out);
      const steady = out.pulse;
      // A sudden transient well above the adaptive floor should trigger one.
      window.__qsAudio.detectAudioOnset(1.0, 0.05, 0, 0, 2000, 1 / 60, out);
      const hit = { pulse: out.pulse, cooldownUntil: out.cooldownUntil };
      return { steady, hit };
    });
    expect(result.steady).toBe(0);
    expect(result.hit.pulse).toBe(1);
    expect(result.hit.cooldownUntil).toBeGreaterThan(2000);
  });

  test('detectAudioOnset respects its cooldown window and will not re-fire immediately', async ({ page }) => {
    const result = await page.evaluate(() => {
      const out = { bassAvg: 0, pulse: 0, cooldownUntil: 0 };
      window.__qsAudio.detectAudioOnset(1.0, 0.05, 0, 0, 1000, 1 / 60, out);
      const first = out.pulse; // 1: fires
      const cooldownUntil = out.cooldownUntil;
      // Immediately after, still inside the cooldown window: should decay, not re-fire.
      window.__qsAudio.detectAudioOnset(1.0, out.bassAvg, out.pulse, out.cooldownUntil, 1010, 1 / 60, out);
      return { first, secondPulse: out.pulse, cooldownUntil };
    });
    expect(result.first).toBe(1);
    expect(result.secondPulse).toBeLessThan(1);
  });
});

test.describe('Audio reactivity: enable/disable round trip', () => {
  test.beforeEach(async ({ page }) => boot(page));

  test('microphone enables against the fake device and cleanly round-trips back off', async ({ page }) => {
    test.setTimeout(60000);
    page.on('pageerror', (e) => { throw new Error(`pageerror: ${e.message}`); });

    await page.click('#audio-toggle');
    await expect
      .poll(async () => page.evaluate(() => window.__qsAudio.state().audioState), { timeout: 20000 })
      .toBe('on');
    await expect(page.locator('#audio-toggle')).toHaveText('Disable microphone');
    await expect(page.locator('#audio-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#astatus')).toContainText(/Listening/i);

    await page.click('#audio-toggle');
    await expect
      .poll(async () => page.evaluate(() => window.__qsAudio.state().audioState), { timeout: 10000 })
      .toBe('off');
    await expect(page.locator('#audio-toggle')).toHaveText('Enable microphone');
    await expect(page.locator('#audio-toggle')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#astatus')).toContainText(/Sound off/i);
  });

  test('REGRESSION: rapid enable/disable cycles settle into a consistent live state', async ({ page }) => {
    // Guards the stale-session race: the AudioContext used to be published to module
    // state before an `await`, so a superseded enable could close the context a newer
    // enable had already begun using -- leaving the UI reading "Listening" over a
    // dead audio graph. Cycling fast and then settling on "on" must leave a context
    // that is genuinely running.
    test.setTimeout(90000);
    page.on('pageerror', (e) => { throw new Error(`pageerror: ${e.message}`); });

    const audioState = () => page.evaluate(() => window.__qsAudio.state().audioState);

    for (let i = 0; i < 3; i++) {
      await page.click('#audio-toggle');
      await page.waitForTimeout(120);
      await page.click('#audio-toggle');
      await page.waitForTimeout(120);
    }

    // A click landing mid-"starting" is intentionally ignored (the busy guard), so
    // the cycling above can legitimately settle on either "on" or "off" depending on
    // exact timing. Wait for it to settle out of "starting" at all, then drive it to
    // "on" explicitly (one more click if it landed on "off") rather than assuming
    // which parity six rapid clicks land on -- what this test actually cares about
    // is that "on" is a *real*, live audio graph, not which click count reaches it.
    await expect.poll(audioState, { timeout: 20000 }).toMatch(/^(on|off)$/);
    if (await audioState() === 'off') await page.click('#audio-toggle');
    await expect.poll(audioState, { timeout: 20000 }).toBe('on');

    // The reported state and the actual audio graph must agree.
    const live = await page.evaluate(() => window.__qsAudio.contextState());
    expect(live).toBe('running');
    await expect(page.locator('#audio-toggle')).toHaveText('Disable microphone');

    // And a final disable still tears everything down cleanly.
    await page.click('#audio-toggle');
    await expect
      .poll(async () => page.evaluate(() => window.__qsAudio.state().audioState), { timeout: 10000 })
      .toBe('off');
    expect(await page.evaluate(() => window.__qsAudio.contextState())).toBe('none');
  });
});
