import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { HAND_FIXTURE } from './global-setup.mjs';

// Runs in the "chromium-hand" project, whose fake camera shows a photo of a hand
// making a V sign (see playwright.config.js and tests/global-setup.mjs).
// camera-pipeline.spec.ts only proves the engine starts and reports no hand; this
// proves a real hand is detected and its gesture confirmed end to end.
//
// It runs under SwiftShader, as CI does. A software renderer emulates the MediaPipe
// GPU delegate on the CPU as well, at 24 s for the first inference and about twice
// the CPU delegate's time after that, so the recognizer must pick the CPU delegate.
test('a hand in front of the camera is recognised as a gesture', async ({ page }) => {
  test.setTimeout(180000);
  expect(fs.existsSync(HAND_FIXTURE), `missing ${HAND_FIXTURE}: the global setup could not download it`).toBe(true);
  page.on('pageerror', (e) => { throw new Error(`pageerror: ${e.message}`); });

  await page.goto('/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__qsReady === true, null, { timeout: 45000 });
  await page.click('#camera-toggle');

  await expect
    .poll(async () => page.locator('#camera-toggle').textContent(), { timeout: 90000 })
    .toContain('Disable camera');
  await expect(page.locator('#backend-badge')).toContainText('CPU');

  // Confirmed gestures show their bare label; candidates carry a percentage.
  await expect
    .poll(async () => page.locator('#gname').textContent(), {
      timeout: 60000,
      message: 'the V sign should be confirmed as VICTORY'
    })
    .toBe('VICTORY');
});
