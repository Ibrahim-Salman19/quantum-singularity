import { defineConfig, devices } from '@playwright/test';
import { HAND_FIXTURE } from './tests/global-setup.mjs';

// A single source of truth for the static-server port keeps the webServer
// command, its health-check URL, and the tests' baseURL from ever drifting
// apart. Override with QS_TEST_PORT to run against a port that is already free
// if a previous crashed run left the default one held.
const PORT = Number(process.env.QS_TEST_PORT || 8089);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// A project's launchOptions replace these rather than merging, so the hand
// project spreads them explicitly.
const BROWSER_ARGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-web-security'
];

export default defineConfig({
  testDir: './tests',
  // Browser specs only; tests/unit/*.test.js run under `node --test` (npm run test:unit).
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/global-setup.mjs',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // CI hosts run WebGL under SwiftShader, which is dramatically slower than a
  // real GPU. One retry absorbs the occasional software-rasteriser timeout
  // without masking a genuine, reproducible failure (which fails twice).
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 60000,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    launchOptions: { args: BROWSER_ARGS }
  },
  webServer: {
    command: `python3 -m http.server ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 15000
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: '**/hand-gesture.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // The fake camera plays a photo of a hand instead of Chromium's test pattern.
      name: 'chromium-hand',
      testMatch: '**/hand-gesture.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: [...BROWSER_ARGS, `--use-file-for-fake-video-capture=${HAND_FIXTURE}`] }
      },
    }
  ],
});
