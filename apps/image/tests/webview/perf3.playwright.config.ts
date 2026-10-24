import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 6103);
const applicationRoot = process.env.PERF3_APPLICATION_ROOT ?? '../..';

export default defineConfig({
  testDir: '.',
  testMatch: /perf3-brush\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  reporter: 'line',
  outputDir: '/tmp/pw-out-perf3',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, trace: 'retain-on-failure' },
  projects: [
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'perf-gpu', use: { ...devices['Desktop Chrome'], launchOptions: { args: [
      '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
    ] } } },
  ],
  webServer: {
    command: `node ../../node_modules/vite/bin/vite.js ${applicationRoot} --host 127.0.0.1 --port ${port} --strictPort`,
    env: { VITE_CACHE_DIR: `/tmp/perf3-vite-cache-${port}` },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
