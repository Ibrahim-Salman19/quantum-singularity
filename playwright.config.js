import { defineConfig, devices } from '@playwright/test';

// A single source of truth for the static-server port keeps the webServer
// command, its health-check URL, and the tests' baseURL from ever drifting
// apart. Override with QS_TEST_PORT to run against a port that is already free
// if a previous crashed run left the default one held.
const PORT = Number(process.env.QS_TEST_PORT || 8089);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests',
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
    launchOptions: {
      args: [
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
      ]
    }
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
      use: { ...devices['Desktop Chrome'] },
    }
  ],
});
