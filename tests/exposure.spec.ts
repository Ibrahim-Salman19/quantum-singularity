import { test, expect } from '@playwright/test';

// Particles blend additively, so the more of them a tier draws, the more light
// lands on the inner disk. Before 6.0.0 every tier above minimal summed it far
// past display white, and the default scene rendered as a flat white glow on
// exactly the hardware that should show it best. This renders the largest tier
// on a fixed simulated clock and fails if the frame is blown out.
//
// The clock is Playwright's fake one, so the frame is taken at the same
// simulated moment however slowly the software rasteriser runs.
test.use({ viewport: { width: 640, height: 360 } });

const FPS = 24;
const SIMULATED_SECONDS = 1.5;

test('the high tier renders a structured field, not a white-out', async ({ page }) => {
  test.setTimeout(240000);
  await page.addInitScript(() => {
    localStorage.setItem('qs_guide_dismissed_v4', '1');
    // Keep the last frame readable after compositing.
    const getContext = HTMLCanvasElement.prototype.getContext;
    (HTMLCanvasElement.prototype as any).getContext = function (this: HTMLCanvasElement, type: string, attrs?: object) {
      if (type === 'webgl2' || type === 'webgl') attrs = { ...(attrs || {}), preserveDrawingBuffer: true };
      return (getContext as any).call(this, type, attrs);
    };
  });
  await page.clock.install();
  await page.goto('/?quality=high', { waitUntil: 'load' });
  await expect
    .poll(() => page.evaluate(() => (window as any).__qsReady === true), { timeout: 60000 })
    .toBe(true);

  for (let i = 0; i < SIMULATED_SECONDS * FPS; i++) {
    await page.clock.fastForward(1000 / FPS);
    await page.evaluate(() =>
      (document.querySelector('canvas.webgl-canvas') as HTMLCanvasElement).getContext('webgl2')!.finish()
    );
  }

  const frame = await page.evaluate(() => {
    const src = document.querySelector('canvas.webgl-canvas') as HTMLCanvasElement;
    const copy = document.createElement('canvas');
    copy.width = src.width;
    copy.height = src.height;
    const ctx = copy.getContext('2d')!;
    ctx.drawImage(src, 0, 0);
    const px = ctx.getImageData(0, 0, copy.width, copy.height).data;
    let white = 0;
    let dark = 0;
    let luma = 0;
    for (let i = 0; i < px.length; i += 4) {
      const y = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      luma += y;
      if (Math.min(px[i], px[i + 1], px[i + 2]) >= 235) white++;
      if (y < 40) dark++;
    }
    const n = px.length / 4;
    return { white: white / n, dark: dark / n, meanLuma: luma / n / 255 };
  });
  console.log(`exposure: ${JSON.stringify(frame)}`);

  // A healthy frame has a bright core, a structured disk and black space around it.
  expect(frame.white, 'share of near-white pixels').toBeLessThan(0.15);
  expect(frame.dark, 'share of dark pixels').toBeGreaterThan(0.3);
});
