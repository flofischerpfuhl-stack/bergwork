import { defineConfig } from '@playwright/test';

const port = Number(process.env.WEBVIEW_PORT ?? 5207);

export default defineConfig({
  testDir: '.',
  testMatch: /matrix\.spec\.ts/,
  workers: 1,
  timeout: 900_000,
  reporter: 'line',
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 }, headless: true },
  projects: [{
    name: 'chromium-gpu',
    use: { launchOptions: { args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] } },
  }],
  webServer: {
    command: `cd ../.. && node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/tests/webview/index.html`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
