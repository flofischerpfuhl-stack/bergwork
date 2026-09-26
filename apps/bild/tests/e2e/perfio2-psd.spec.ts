import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const FIXTURE = path.resolve('tests/fixtures/psd/corpus/blend-modes/rgb-blend-modes.psd');

test('PSD product worker read preserves pixels while the event loop keeps advancing', async ({ page }) => {
  test.skip(!fs.existsSync(FIXTURE), 'PSD corpus not fetched');
  await page.route('**/pio2-rgb.psd', (route) => route.fulfill({ body: fs.readFileSync(FIXTURE), contentType: 'image/vnd.adobe.photoshop' }));
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const load = (module: string): Promise<any> => import(/* @vite-ignore */ module);
    const [{ readPsdDocumentManaged }, { readPsdDocumentInBackground, backgroundPsdTimings }, { cpuCompositeRegion }] = await Promise.all([
      load('/src/io/psd/index.ts'), load('/src/workers/psdClient.ts'), load('/src/render/cpuRender.ts'),
    ]);
    const source = new Uint8Array(await (await fetch('/pio2-rgb.psd')).arrayBuffer());
    const measure = async (operation: () => Promise<any>) => {
      let previous = performance.now(), maximumGap = 0, ticks = 0;
      const timer = setInterval(() => { const now = performance.now(); maximumGap = Math.max(maximumGap, now - previous); previous = now; ticks++; }, 5);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const started = performance.now(), value = await operation(), total = performance.now() - started;
      await new Promise((resolve) => setTimeout(resolve, 20));
      clearInterval(timer);
      return { value, total, maximumGap, ticks };
    };
    const direct = await measure(() => readPsdDocumentManaged(source.slice()));
    const background = await measure(() => readPsdDocumentInBackground(source));
    const region = { x: 0, y: 0, width: direct.value.document.width, height: direct.value.document.height };
    const a = cpuCompositeRegion(direct.value.document, region), b = cpuCompositeRegion(background.value.document, region);
    let maximumDifference = 0;
    for (let index = 0; index < a.length; index++) maximumDifference = Math.max(maximumDifference, Math.abs(a[index] - b[index]));
    return { direct: { total: direct.total, maximumGap: direct.maximumGap, ticks: direct.ticks },
      background: { total: background.total, maximumGap: background.maximumGap, ticks: background.ticks },
      maximumDifference, layers: [direct.value.document.layers.length, background.value.document.layers.length],
      timing: backgroundPsdTimings().at(-1) };
  });
  console.info('PIO2 PSD read (ms):', JSON.stringify(result));
  expect(result.layers[1]).toBe(result.layers[0]);
  expect(result.maximumDifference).toBe(0);
  expect(result.background.ticks).toBeGreaterThan(2);
  expect(result.timing.tileBytes).toBeGreaterThan(0);
});

test('PSD product worker write preserves exact bytes while the event loop keeps advancing', async ({ page }) => {
  test.skip(!fs.existsSync(FIXTURE), 'PSD corpus not fetched');
  await page.route('**/pio2-rgb.psd', (route) => route.fulfill({ body: fs.readFileSync(FIXTURE), contentType: 'image/vnd.adobe.photoshop' }));
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const load = (module: string): Promise<any> => import(/* @vite-ignore */ module);
    const [{ writePsdDocument },
      { readPsdDocumentInBackground, writePsdDocumentInBackground, backgroundPsdTimings }] = await Promise.all([
      load('/src/io/psd/index.ts'), load('/src/workers/psdClient.ts'),
    ]);
    const source = new Uint8Array(await (await fetch('/pio2-rgb.psd')).arrayBuffer());
    const imported = await readPsdDocumentInBackground(source);
    const measure = async (operation: () => Promise<any>) => {
      let previous = performance.now(), maximumGap = 0, ticks = 0;
      const timer = setInterval(() => { const now = performance.now(); maximumGap = Math.max(maximumGap, now - previous); previous = now; ticks++; }, 5);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const started = performance.now(), value = await operation(), total = performance.now() - started;
      await new Promise((resolve) => setTimeout(resolve, 20));
      clearInterval(timer);
      return { value, total, maximumGap, ticks };
    };
    const direct = await measure(async () => writePsdDocument(imported.document));
    const background = await measure(() => writePsdDocumentInBackground(imported.document));
    let exact = direct.value.bytes.length === background.value.bytes.length;
    for (let index = 0; exact && index < direct.value.bytes.length; index++) {
      if (direct.value.bytes[index] !== background.value.bytes[index]) exact = false;
    }
    return { direct: { total: direct.total, maximumGap: direct.maximumGap, ticks: direct.ticks },
      background: { total: background.total, maximumGap: background.maximumGap, ticks: background.ticks },
      exact, bytes: background.value.bytes.length, timing: backgroundPsdTimings().at(-1) };
  });
  console.info('PIO2 PSD write (ms):', JSON.stringify(result));
  expect(result.exact).toBe(true);
  expect(result.bytes).toBeGreaterThan(0);
  expect(result.background.ticks).toBeGreaterThan(2);
  expect(result.timing.tileBytes).toBeGreaterThan(0);
});
