import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 5199);

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: 'line',
  outputDir: 'artifacts/e2e-results',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /performance\.spec/ },
    ...(process.env.E2E_BENCHMARKS ? [{
      name: 'benchmarks',
      testDir: 'tests/benchmarks',
      use: { ...devices['Desktop Chrome'] },
    }] : []),
    // Real-GPU measurements (ANGLE on the host OpenGL driver); run with --project perf-gpu.
    {
      name: 'perf-gpu', testMatch: /performance\.spec/,
      use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] } },
    },
    // Cross-browser runs of the workflow specs (opt-in: E2E_ALL_BROWSERS=1; needs `playwright install firefox webkit`).
    ...(process.env.E2E_ALL_BROWSERS ? [
      { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testIgnore: /performance\.spec|gpu-vs-cpu|adjust-gpu|subject/ },
      { name: 'webkit', use: { ...devices['Desktop Safari'] }, testIgnore: /performance\.spec|gpu-vs-cpu|adjust-gpu|subject/ },
    ] : []),
  ],
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    env: { VITE_CACHE_DIR: `.vite-cache/e2e-${port}` },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
