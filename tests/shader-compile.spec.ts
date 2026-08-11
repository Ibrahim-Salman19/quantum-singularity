import { test, expect } from '@playwright/test';

// Guards the GLSL3 CinematicShader upgrade: ShaderPass does not forward
// `glslVersion`, so the pass material must be built as an explicit
// ShaderMaterial with GLSL3 set, or the GLSL ES 3.0 syntax (out vec4, texture(),
// uvec2, floatBitsToUint) fails to compile. A failed compile surfaces as a
// console error containing the GLSL diagnostic; this test fails on any such error.
test.describe('Post-processing shader compilation', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('qs_guide_dismissed_v4', '1');
    });
  });

  test('CinematicShader (GLSL3) compiles without WebGL program errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(String(err)));

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).__qsReady === true, null, { timeout: 25000 });
    // Let a few frames run so composer.render() actually exercises every pass.
    await page.waitForTimeout(500);

    const shaderErrors = errors.filter((e) =>
      /shader|glsl|program|compile|link|fragColor|floatBitsToUint|texture2D|gl_FragColor/i.test(e)
    );
    expect(shaderErrors, `WebGL shader errors:\n${shaderErrors.join('\n')}`).toEqual([]);
  });
});
