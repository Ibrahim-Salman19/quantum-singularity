import { test, expect } from '@playwright/test';
import { POSES, makeHand } from './fixtures/hand-poses.mjs';

test.describe('Gesture Engine & Neural Link Tests', () => {

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('qs_guide_dismissed_v4', '1');
    });
  });

  test('Neural status badge initializes cleanly in camera off state', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const statusEl = page.locator('#nstatus');
    await expect(statusEl).toBeVisible();
    await expect(statusEl).toContainText(/Camera off/i);
  });

  test('Camera toggle button triggers status update on click', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).__qsReady === true);
    const cameraBtn = page.locator('#camera-toggle');
    await cameraBtn.click();
    const statusEl = page.locator('#nstatus');
    await expect(statusEl).toBeVisible();
  });

  test('Pointing_Up gesture increases hand influence and sets attractor world position', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).__qsReady === true);

    const pose = POSES.point();
    const state = await page.evaluate(({ lm }) => {
      const g = (window as any).__qsGesture;
      for (let i = 0; i < 15; i++) {
        g.applyGesture('Pointing_Up', lm, performance.now() + i * 40, 0.4, 0.04);
      }
      return g.animationState();
    }, { lm: pose.normalized });

    expect(state.handInfl).toBeGreaterThan(0.5);
    expect(Number.isFinite(state.handWorldPos.x)).toBe(true);
    expect(Number.isFinite(state.handWorldPos.y)).toBe(true);
    expect(Number.isFinite(state.handWorldPos.z)).toBe(true);
  });

  test('Open_Palm gesture modulates targetCameraRadius between near and far hand scale', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).__qsReady === true);

    const nearPose = makeHand({ spread: 0.55, scale: 1.5 });
    const farPose = makeHand({ spread: 0.55, scale: 0.5 });

    const zoomState = await page.evaluate(({ nearLm, farLm }) => {
      const g = (window as any).__qsGesture;
      const nearGeom = g.geometryGestureScores(nearLm, null);
      for (let i = 0; i < 15; i++) {
        g.applyGesture('Open_Palm', nearLm, performance.now() + i * 40, nearGeom.handScale, 0.04);
      }
      const nearRadius = g.animationState().targetCameraRadius;

      const farGeom = g.geometryGestureScores(farLm, null);
      for (let i = 0; i < 15; i++) {
        g.applyGesture('Open_Palm', farLm, performance.now() + 1000 + i * 40, farGeom.handScale, 0.04);
      }
      const farRadius = g.animationState().targetCameraRadius;

      return { nearRadius, farRadius };
    }, { nearLm: nearPose.normalized, farLm: farPose.normalized });

    // Hand close to camera should zoom in (smaller radius); hand far should zoom out (larger radius).
    expect(zoomState.nearRadius).toBeLessThan(zoomState.farRadius);
    expect(zoomState.nearRadius).toBeLessThan(120);
    expect(zoomState.farRadius).toBeGreaterThan(180);
  });

  test('Victory gesture modulates chaos parameter according to hand horizontal travel', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).__qsReady === true);

    // Camera image x=0.2 maps to mirrored screen-right (higher chaos); x=0.8 maps to mirrored screen-left (lower chaos).
    const camLeftPose = makeHand({ thumb: 0.8, index: 0, middle: 0, ring: 1, pinky: 1, spread: 1.0, centerX: 0.8 });
    const camRightPose = makeHand({ thumb: 0.8, index: 0, middle: 0, ring: 1, pinky: 1, spread: 1.0, centerX: 0.2 });

    const chaosState = await page.evaluate(({ lowLm, highLm }) => {
      const g = (window as any).__qsGesture;
      for (let i = 0; i < 20; i++) {
        g.applyGesture('Victory', lowLm, performance.now() + i * 40, 0.4, 0.04);
      }
      const chaosLow = g.animationState().chaos;

      for (let i = 0; i < 20; i++) {
        g.applyGesture('Victory', highLm, performance.now() + 1000 + i * 40, 0.4, 0.04);
      }
      const chaosHigh = g.animationState().chaos;

      return { chaosLow, chaosHigh };
    }, { lowLm: camLeftPose.normalized, highLm: camRightPose.normalized });

    expect(chaosState.chaosLow).toBeLessThan(chaosState.chaosHigh);
    expect(chaosState.chaosLow).toBeLessThan(0.8);
    expect(chaosState.chaosHigh).toBeGreaterThan(1.2);
  });

  test('Non-pointing gestures smoothly decay hand influence', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).__qsReady === true);

    const pointPose = POSES.point();
    const palmPose = POSES.openPalm();

    const decayState = await page.evaluate(({ pointLm, palmLm }) => {
      const g = (window as any).__qsGesture;
      for (let i = 0; i < 15; i++) {
        g.applyGesture('Pointing_Up', pointLm, performance.now() + i * 40, 0.4, 0.04);
      }
      const activeInfl = g.animationState().handInfl;

      for (let i = 0; i < 25; i++) {
        g.applyGesture('Open_Palm', palmLm, performance.now() + 1000 + i * 40, 0.4, 0.04);
      }
      const decayedInfl = g.animationState().handInfl;

      return { activeInfl, decayedInfl };
    }, { pointLm: pointPose.normalized, palmLm: palmPose.normalized });

    expect(decayState.activeInfl).toBeGreaterThan(0.5);
    expect(decayState.decayedInfl).toBeLessThan(0.05);
  });

});
