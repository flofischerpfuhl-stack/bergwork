import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 6117);
const dev = process.env.PERFIO_DEV === '1';

/** Production-build startup measurements for the PERFIO audit. */
export default defineConfig({
  testDir: '.',
  testMatch: dev ? /perfio\.spec\.ts/ : /perfio-startup\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  reporter: 'line',
  outputDir: '/tmp/pw-out-perfio',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true },
  projects: [
    { name: 'chromium-gpu', use: { ...devices['Desktop Chrome'], launchOptions: { args: [
      '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
    ] } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `node node_modules/vite/bin/vite.js ${dev ? '' : 'preview '}--host 127.0.0.1 --port ${port} --strictPort`,
    cwd: '../..',
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
