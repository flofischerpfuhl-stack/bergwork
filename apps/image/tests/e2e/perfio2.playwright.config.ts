import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 6127);

/** PIO2's same-workload Chromium GPU / Linux WebKit comparison. */
export default defineConfig({
  testDir: '.',
  testMatch: /(?:export-performance|perfio2-psd)\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 600_000,
  reporter: 'line',
  outputDir: '/tmp/pw-out-pio2',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true },
  projects: [
    { name: 'chromium-gpu', use: { ...devices['Desktop Chrome'], launchOptions: { args: [
      '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
    ] } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: '../..',
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
