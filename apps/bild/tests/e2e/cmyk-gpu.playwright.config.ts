import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 6157);

export default defineConfig({
  testDir: '.',
  testMatch: /cmyk-gpu\.performance\.spec\.ts/,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 90_000,
  reporter: 'line',
  outputDir: '/tmp/pw-out-cmykgpu',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true },
  projects: [
    { name: 'perf-gpu', use: { ...devices['Desktop Chrome'], launchOptions: { args: [
      '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
    ] } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: process.env.CMYKGPU_WORKTREE ?? '../..',
    env: { VITE_CACHE_DIR: `.vite-cache/cmyk-gpu-${port}` },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
