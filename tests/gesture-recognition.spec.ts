import { test, expect } from '@playwright/test';
import { POSES, makeHand } from './fixtures/hand-poses.mjs';

/**
 * Exercises the gesture recognition pipeline directly through `window.__qsGesture`.
 *
 * These are the tests that matter most for this project: the classifier is pure,
 * deterministic maths, but it is the only subsystem that cannot be driven through
 * the UI without a physical hand in front of a physical camera.
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

/** Score a pose through geometry only (no neural classifier available offline). */
async function geom(page, pose) {
  return page.evaluate(
    ({ normalized, world }) => window.__qsGesture.geometryGestureScores(normalized, world),
    pose
  );
}

test.describe('Gesture geometry classifier', () => {
  test.beforeEach(async ({ page }) => boot(page));

  test('open palm scores highest for Open_Palm', async ({ page }) => {
    const s = await geom(page, POSES.openPalm());
    expect(s.Open_Palm).toBeGreaterThan(0.80);
    expect(s.Open_Palm).toBeGreaterThan(s.Pointing_Up);
    expect(s.Open_Palm).toBeGreaterThan(s.Victory);
  });

  test('pointing index scores highest for Pointing_Up', async ({ page }) => {
    const s = await geom(page, POSES.point());
    expect(s.Pointing_Up).toBeGreaterThan(0.70);
    expect(s.Pointing_Up).toBeGreaterThan(s.Open_Palm);
    expect(s.Pointing_Up).toBeGreaterThan(s.Victory);
  });

  test('victory sign scores highest for Victory', async ({ page }) => {
    const s = await geom(page, POSES.victory());
    expect(s.Victory).toBeGreaterThan(0.70);
    expect(s.Victory).toBeGreaterThan(s.Open_Palm);
    expect(s.Victory).toBeGreaterThan(s.Pointing_Up);
  });

  test('closed fist matches no gesture', async ({ page }) => {
    const s = await geom(page, POSES.fist());
    expect(s.Open_Palm).toBeLessThan(0.45);
    expect(s.Victory).toBeLessThan(0.60);
  });

  test('two fingers held together scores lower than a spread V', async ({ page }) => {
    // Fingertip separation carries real weight now; previously a closed pair scored
    // essentially the same as a proper Victory.
    const spread = await geom(page, POSES.victory());
    const together = await geom(page, POSES.twoTogether());
    expect(together.Victory).toBeLessThan(spread.Victory);
  });

  test('open palm and victory are clearly separated, not near-ties', async ({ page }) => {
    const palm = await geom(page, POSES.openPalm());
    const vic = await geom(page, POSES.victory());
    // Each pose must beat the other gesture by a comfortable margin, otherwise the
    // hysteresis thresholds sit inside the noise band.
    expect(palm.Open_Palm - palm.Victory).toBeGreaterThan(0.15);
    expect(vic.Victory - vic.Open_Palm).toBeGreaterThan(0.15);
  });

  test('a horizontal point scores lower than a raised point', async ({ page }) => {
    // Pointing_Up now considers direction; it used to ignore orientation entirely.
    const up = await geom(page, makeHand({ thumb: 0.75, index: 0, middle: 1, ring: 1, pinky: 1 }));
    const sideways = await geom(page, makeHand({
      thumb: 0.75, index: 0, middle: 1, ring: 1, pinky: 1, tilt: Math.PI / 2
    }));
    expect(sideways.Pointing_Up).toBeLessThan(up.Pointing_Up);
  });

  test('scores are scale invariant (near vs far hand)', async ({ page }) => {
    const near = await geom(page, makeHand({ index: 0, middle: 1, ring: 1, pinky: 1, thumb: 0.75, scale: 1.5 }));
    const far  = await geom(page, makeHand({ index: 0, middle: 1, ring: 1, pinky: 1, thumb: 0.75, scale: 0.6 }));
    expect(Math.abs(near.Pointing_Up - far.Pointing_Up)).toBeLessThan(0.08);
  });

  test('handScale tracks distance monotonically for palm zoom', async ({ page }) => {
    const values = [];
    for (const scale of [0.6, 0.9, 1.2, 1.6]) {
      const s = await geom(page, makeHand({ spread: 0.55, scale }));
      values.push(s.handScale);
    }
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });

  test('palm-normal quality drops for an edge-on hand', async ({ page }) => {
    const faceOn = await geom(page, makeHand({ spread: 0.55 }));
    const edgeOn = await geom(page, makeHand({ spread: 0.55, roll: Math.PI / 2 }));
    expect(edgeOn.quality).toBeLessThan(faceOn.quality);
  });

  test('malformed landmark input never throws or returns NaN', async ({ page }) => {
    const results = await page.evaluate(() => {
      const g = window.__qsGesture.geometryGestureScores;
      const cases = [
        [null, null],
        [[], []],
        [new Array(21).fill(null), null],
        [new Array(5).fill({ x: 0, y: 0, z: 0 }), null]
      ];
      return cases.map(([n, w]) => {
        try {
          const s = g(n, w);
          return Object.values(s).every(v => Number.isFinite(v)) ? 'finite' : 'NaN';
        } catch (e) { return 'threw: ' + e.message; }
      });
    });
    expect(results).toEqual(['finite', 'finite', 'finite', 'finite']);
  });
});

test.describe('Gesture temporal hysteresis', () => {
  test.beforeEach(async ({ page }) => boot(page));

  /** Feed a constant score vector for `ms` milliseconds of simulated time. */
  async function feed(page, scores, ms, stepMs = 40) {
    return page.evaluate(({ scores, ms, stepMs }) => {
      const g = window.__qsGesture;
      let t = performance.now();
      const end = t + ms;
      let last = null;
      while (t <= end) {
        last = g.updateGestureTemporal(scores, t);
        t += stepMs;
      }
      return last;
    }, { scores, ms, stepMs });
  }

  test('a sustained confident score activates', async ({ page }) => {
    await page.evaluate(() => window.__qsGesture.resetGestureTemporal());
    const r = await feed(page, { Pointing_Up: 0.95, Open_Palm: 0.1, Victory: 0.1 }, 400);
    expect(r.gesture).toBe('Pointing_Up');
  });

  test('a single-frame spike does not activate', async ({ page }) => {
    const r = await page.evaluate(() => {
      const g = window.__qsGesture;
      g.resetGestureTemporal();
      const t = performance.now();
      g.updateGestureTemporal({ Pointing_Up: 0, Open_Palm: 0, Victory: 0 }, t);
      // One noisy frame at full confidence, then back to nothing.
      g.updateGestureTemporal({ Pointing_Up: 1, Open_Palm: 0, Victory: 0 }, t + 40);
      return g.updateGestureTemporal({ Pointing_Up: 0, Open_Palm: 0, Victory: 0 }, t + 80);
    });
    expect(r.gesture).toBeNull();
  });

  test('an active gesture releases when its score collapses', async ({ page }) => {
    await page.evaluate(() => window.__qsGesture.resetGestureTemporal());
    const on = await feed(page, { Pointing_Up: 0.95, Open_Palm: 0.1, Victory: 0.1 }, 400);
    expect(on.gesture).toBe('Pointing_Up');
    const off = await feed(page, { Pointing_Up: 0, Open_Palm: 0, Victory: 0 }, 600);
    expect(off.gesture).toBeNull();
  });

  test('REGRESSION: a flickering challenger cannot block release', async ({ page }) => {
    // The old state machine evaluated release only in the `else` branch of the
    // switch test, so an oscillating challenger suppressed the release timer and a
    // dead gesture stayed active forever.
    const result = await page.evaluate(() => {
      const g = window.__qsGesture;
      g.resetGestureTemporal();
      let t = performance.now();
      for (let i = 0; i < 12; i++) {
        g.updateGestureTemporal({ Pointing_Up: 0.95, Open_Palm: 0, Victory: 0 }, t);
        t += 40;
      }
      if (g.state().active !== 'Pointing_Up') return { setup: false };
      // Incumbent collapses; a challenger flickers in and out of the switch band.
      for (let i = 0; i < 40; i++) {
        g.updateGestureTemporal(
          { Pointing_Up: 0, Open_Palm: i % 2 ? 0.98 : 0.2, Victory: 0 },
          t
        );
        t += 40;
      }
      return { setup: true, active: g.state().active };
    });
    expect(result.setup).toBe(true);
    // Must have moved on -- either released or switched. It must NOT still be the
    // collapsed original gesture.
    expect(result.active).not.toBe('Pointing_Up');
  });

  test('holds through a brief tracking dropout', async ({ page }) => {
    const active = await page.evaluate(() => {
      const g = window.__qsGesture;
      g.resetGestureTemporal();
      let t = performance.now();
      for (let i = 0; i < 12; i++) {
        g.updateGestureTemporal({ Pointing_Up: 0.95, Open_Palm: 0, Victory: 0 }, t);
        t += 40;
      }
      // Two dropped frames, as happens when the hand briefly leaves frame.
      g.updateGestureTemporal({ Pointing_Up: 0, Open_Palm: 0, Victory: 0 }, t); t += 40;
      g.updateGestureTemporal({ Pointing_Up: 0, Open_Palm: 0, Victory: 0 }, t); t += 40;
      g.updateGestureTemporal({ Pointing_Up: 0.95, Open_Palm: 0, Victory: 0 }, t);
      return g.state().active;
    });
    expect(active).toBe('Pointing_Up');
  });

  test('switching requires a clear margin over the incumbent', async ({ page }) => {
    const out = await page.evaluate(() => {
      const g = window.__qsGesture;
      g.resetGestureTemporal();
      let t = performance.now();
      for (let i = 0; i < 12; i++) {
        g.updateGestureTemporal({ Pointing_Up: 0.95, Open_Palm: 0, Victory: 0 }, t);
        t += 40;
      }
      // A marginally-better rival must not steal control.
      for (let i = 0; i < 12; i++) {
        g.updateGestureTemporal({ Pointing_Up: 0.90, Open_Palm: 0.93, Victory: 0 }, t);
        t += 40;
      }
      const afterWeak = g.state().active;
      // A decisively better rival must.
      for (let i = 0; i < 12; i++) {
        g.updateGestureTemporal({ Pointing_Up: 0.05, Open_Palm: 0.99, Victory: 0 }, t);
        t += 40;
      }
      return { afterWeak, afterStrong: g.state().active };
    });
    expect(out.afterWeak).toBe('Pointing_Up');
    expect(out.afterStrong).toBe('Open_Palm');
  });

  test('debounce timing is frame-rate independent', async ({ page }) => {
    // The same wall-clock duration must produce the same decision whether inference
    // runs at 12Hz or 30Hz. The old frame-counted logic varied by more than 2x.
    const out = await page.evaluate(() => {
      const g = window.__qsGesture;
      const run = (stepMs) => {
        g.resetGestureTemporal();
        let t = performance.now();
        const end = t + 300;
        while (t <= end) {
          g.updateGestureTemporal({ Pointing_Up: 0.95, Open_Palm: 0, Victory: 0 }, t);
          t += stepMs;
        }
        return g.state().active;
      };
      return { slow: run(83), fast: run(33) };
    });
    expect(out.slow).toBe('Pointing_Up');
    expect(out.fast).toBe('Pointing_Up');
  });
});

test.describe('Gesture fusion', () => {
  test.beforeEach(async ({ page }) => boot(page));

  test('a confident classifier prediction survives mediocre geometry', async ({ page }) => {
    const { fused, activate } = await page.evaluate(() => ({
      fused: window.__qsGesture.fuseGestureScores(
        { Pointing_Up: 0.45, Open_Palm: 0.2, Victory: 0.2 },
        { Pointing_Up: 0.96, Open_Palm: 0.01, Victory: 0.01, None: 0.02 },
        0.5
      ),
      activate: window.__qsGesture.thresholds.GESTURE_ACTIVATE
    }));
    expect(fused.Pointing_Up).toBeGreaterThan(activate);
  });

  test('an explicit None from the classifier suppresses weak geometry', async ({ page }) => {
    const fused = await page.evaluate(() => window.__qsGesture.fuseGestureScores(
      { Pointing_Up: 0.60, Open_Palm: 0.2, Victory: 0.2 },
      { Pointing_Up: 0.05, Open_Palm: 0.02, Victory: 0.02, None: 0.95 },
      1
    ));
    expect(fused.Pointing_Up).toBeLessThan(0.5);
  });

  test('agreement between geometry and classifier is boosted', async ({ page }) => {
    const fused = await page.evaluate(() => window.__qsGesture.fuseGestureScores(
      { Pointing_Up: 0.90, Open_Palm: 0.1, Victory: 0.1 },
      { Pointing_Up: 0.92, Open_Palm: 0.02, Victory: 0.02, None: 0.04 },
      1
    ));
    expect(fused.Pointing_Up).toBeGreaterThan(0.90);
  });

  test('non-actionable canned labels feed the None veto', async ({ page }) => {
    const ml = await page.evaluate(() => window.__qsGesture.mediaPipeGestureScores([
      { categoryName: 'Closed_Fist', score: 0.93 }
    ]));
    expect(ml.None).toBeGreaterThan(0.9);
  });

  test('prototype keys cannot pollute the classifier score map', async ({ page }) => {
    const ml = await page.evaluate(() => window.__qsGesture.mediaPipeGestureScores([
      { categoryName: 'constructor', score: 0.99 },
      { categoryName: 'Victory', score: 0.7 }
    ]));
    expect(ml.Victory).toBeCloseTo(0.7, 5);
    expect(Object.keys(ml).sort()).toEqual(['None', 'Open_Palm', 'Pointing_Up', 'Victory']);
  });
});

test.describe('Hand to NDC mapping', () => {
  test.beforeEach(async ({ page }) => boot(page));

  test('is physical and window-independent: ground travel ratio matches the camera frame', async ({ page }) => {
    const out = await page.evaluate(() => {
      const g = window.__qsGesture;
      const THREE = g.THREE;
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
      const ground = new THREE.Vector3();
      const measure = (viewAspect) => {
        g.setFrameAspect(4 / 3);
        const camera = new THREE.PerspectiveCamera(60, viewAspect, 0.5, 2000);
        camera.position.set(0, 0, 140);
        camera.lookAt(0, 0, 0);
        camera.updateMatrixWorld(true);
        camera.updateProjectionMatrix();
        const r = new THREE.Raycaster();
        const project = (nx, ny) => {
          const v = new THREE.Vector2();
          g.handToNDC(nx, ny, v, viewAspect);
          r.setFromCamera(v, camera);
          r.ray.intersectPlane(plane, ground);
          return { x: ground.x, y: ground.y };
        };
        const c = project(0.5, 0.5);
        const dx = project(0.6, 0.5);
        const dy = project(0.5, 0.6);
        return { wx: Math.abs(dx.x - c.x), wy: Math.abs(dy.y - c.y) };
      };
      // Equal fractional hand travel must move the ground point by the same
      // physical-world ratio as the camera frame itself (4:3), and that ratio must
      // NOT change when the viewport aspect changes.
      const wide = measure(16 / 9);
      const square = measure(4 / 3);
      return { rWide: wide.wx / wide.wy, rSquare: square.wx / square.wy };
    });
    expect(Math.abs(out.rWide - 4 / 3)).toBeLessThan(0.02);
    expect(Math.abs(out.rSquare - 4 / 3)).toBeLessThan(0.02);
    expect(Math.abs(out.rWide - out.rSquare)).toBeLessThan(0.02);
  });

  test('centres correctly and stays clamped inside NDC', async ({ page }) => {
    const out = await page.evaluate(() => {
      const g = window.__qsGesture;
      const v = { x: 0, y: 0, set(a, b) { this.x = a; this.y = b; } };
      g.handToNDC(0.5, 0.5, v); const centre = { x: v.x, y: v.y };
      const extremes = [];
      for (const [a, b] of [[0, 0], [1, 1], [0, 1], [1, 0], [-1, 2]]) {
        g.handToNDC(a, b, v);
        extremes.push({ x: v.x, y: v.y });
      }
      return { centre, extremes };
    });
    expect(Math.abs(out.centre.x)).toBeLessThan(1e-6);
    expect(Math.abs(out.centre.y)).toBeLessThan(1e-6);
    for (const e of out.extremes) {
      expect(e.x).toBeGreaterThanOrEqual(-1);
      expect(e.x).toBeLessThanOrEqual(1);
      expect(e.y).toBeGreaterThanOrEqual(-1);
      expect(e.y).toBeLessThanOrEqual(1);
    }
  });

  test('mirroring: moving the hand right moves the attractor right', async ({ page }) => {
    // The preview is mirrored (scaleX(-1)); applyGesture pre-mirrors x, so a larger
    // mirrored x must map to a larger NDC x.
    const out = await page.evaluate(() => {
      const g = window.__qsGesture;
      const v = { x: 0, y: 0, set(a, b) { this.x = a; this.y = b; } };
      g.handToNDC(1 - 0.7, 0.5, v); const handRight = v.x;
      g.handToNDC(1 - 0.3, 0.5, v); const handLeft = v.x;
      return { handRight, handLeft };
    });
    expect(out.handRight).toBeLessThan(out.handLeft);
  });
});
