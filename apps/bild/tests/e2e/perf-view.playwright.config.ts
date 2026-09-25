import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 6111);

export default defineConfig({
  testDir: '.',
  testMatch: /perf-view\.performance\.spec\.ts/,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 300_000,
  reporter: 'line',
  outputDir: '/tmp/pw-out-perfview',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true },
  projects: [
    { name: 'perf-gpu', use: { ...devices['Desktop Chrome'], launchOptions: { args: [
      '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
    ] } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: '../..',
    env: { VITE_CACHE_DIR: `.vite-cache/perf-view-${port}` },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
