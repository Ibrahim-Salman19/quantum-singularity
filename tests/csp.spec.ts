import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// The local test server sends no headers, so every other spec runs without the
// production Content-Security-Policy. This one serves the document with the
// exact global headers from vercel.json and boots the full app under them. A
// blocked script, font, model or worker shows up as a violation and fails here
// instead of on the live site.
const vercel = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../vercel.json', import.meta.url)), 'utf8'));
const globalHeaders = Object.fromEntries(
  vercel.headers.find((h) => h.source === '/(.*)').headers.map((h) => [h.key, h.value])
);
// Not meaningful on a plain-http loopback origin: upgrade-insecure-requests would
// rewrite the app's own module requests to https, and HSTS is ignored on http.
const csp = globalHeaders['Content-Security-Policy']
  .split(';').map((d) => d.trim()).filter((d) => d && d !== 'upgrade-insecure-requests').join('; ');

test.describe('Production security headers', () => {
  test('the app boots under the production CSP with zero violations', async ({ page }) => {
    test.setTimeout(120000);
    await page.addInitScript(() => {
      (window as any).__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        (window as any).__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    await page.route((url) => url.pathname === '/' || url.pathname === '/index.html', async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), ...globalHeaders, 'Content-Security-Policy': csp }
      });
    });

    const response = await page.goto('/', { waitUntil: 'load', timeout: 60000 });
    expect(response?.headers()['content-security-policy']).toContain("'sha256-");
    expect(response?.headers()['content-security-policy']).not.toContain("'unsafe-inline' 'wasm");

    await page.waitForFunction(() => (window as any).__qsReady === true, { timeout: 60000 });
    // Web fonts come from a cross-origin stylesheet that src/fonts.js switches on
    // after load. Confirm an Outfit face actually loaded. document.fonts.check()
    // would not prove this: it also returns true when no matching face exists.
    await expect.poll(() => page.evaluate(() =>
      [...(document.fonts as any)].some((f: FontFace) => f.family.replace(/["']/g, '') === 'Outfit' && f.status === 'loaded')
    ), { timeout: 20000 }).toBe(true);
    expect(await page.evaluate(() => (document.getElementById('webfonts') as HTMLLinkElement | null)?.media)).toBe('all');
    // Give deferred work (model prefetch, workers, fonts) time to hit the policy.
    await page.waitForTimeout(2000);
    expect(await page.evaluate(() => (window as any).__cspViolations)).toEqual([]);
  });
});
