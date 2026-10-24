import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 6123);
const applicationRoot = process.env.PRETOUCH_APPLICATION_ROOT ?? '../..';

export default defineConfig({
  testDir: '.',
  testMatch: /pretouch-performance\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 300_000,
  reporter: 'line',
  outputDir: '/tmp/pw-out-pretouch',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, trace: 'retain-on-failure' },
  projects: [
    { name: 'perf-gpu', use: { ...devices['Desktop Chrome'], launchOptions: { args: [
      '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
    ] } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `node ../../node_modules/vite/bin/vite.js ${applicationRoot} --host 127.0.0.1 --port ${port} --strictPort`,
    env: { VITE_CACHE_DIR: `/tmp/pretouch-vite-cache-${port}` },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
