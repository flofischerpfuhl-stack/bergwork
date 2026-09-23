import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { expect, test } from '@playwright/test';

const EXPECTED_SHEET_SHA256 = '1349069eba083c0c4618488b7dd7ee560ed1253e4948988cfc5818acc5e3977e';

function gzipBytes(file: string): number {
  return zlib.gzipSync(fs.readFileSync(file), { level: 9 }).byteLength;
}

test('A5 CPU sheet is identical, lazy, fast, and worker-compatible', async ({ page }, info) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1680, height: 500 });
  await page.goto('/?harness=canvaskit');
  const result = await page.evaluate(async () => {
    type TextModule = typeof import('../../src/text');
    type CheckModule = typeof import('../../src/text/checkSheet');
    type PngModule = typeof import('../../src/io/png');
    const before = performance.getEntriesByType('resource').map((entry) => entry.name);
    const loadText = (url: string): Promise<TextModule> => import(/* @vite-ignore */ url) as Promise<TextModule>;
    const loadCheck = (url: string): Promise<CheckModule> => import(/* @vite-ignore */ url) as Promise<CheckModule>;
    const loadPng = (url: string): Promise<PngModule> => import(/* @vite-ignore */ url) as Promise<PngModule>;
    const [{ loadTextEngine }, check, { encodePng }] = await Promise.all([
      loadText('/src/text/index.ts'), loadCheck('/src/text/checkSheet.ts'), loadPng('/src/io/png.ts'),
    ]);
    const engine = await loadTextEngine();
    await check.loadBundledFonts(engine);
    const sheet = check.renderIntegrationSheet(engine);
    const pixels = sheet.raster.toPixels();
    const digest = await crypto.subtle.digest('SHA-256', pixels);
    const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
    const performanceResult = check.measureParagraphPerformance(engine, 50);

    const workerSource = `
      self.onmessage = async () => {
        const text = await import(${JSON.stringify(new URL('/src/text/index.ts', location.href).href)});
        const engine = await text.loadTextEngine();
        const response = await fetch(${JSON.stringify(new URL('/fonts/NotoSans-Variable.ttf', location.href).href)});
        engine.registerFont({ id: 'worker-font', family: 'Noto Sans', bytes: await response.arrayBuffer() });
        const layout = engine.layoutParagraph({ text: 'Worker AVATAR office Übergröße', width: 360,
          fontFamilies: ['Noto Sans'], fontSize: 27 });
        const pixels = engine.rasterizeParagraph(layout, 2).raster.toPixels();
        layout.dispose(); engine.dispose();
        const digest = await crypto.subtle.digest('SHA-256', pixels);
        self.postMessage([...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join(''));
      };
    `;
    const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    const workerHash = await new Promise<string>((resolve, reject) => {
      const worker = new Worker(workerUrl, { type: 'module' });
      const timeout = setTimeout(() => { worker.terminate(); reject(new Error('CanvasKit worker timed out after 30 seconds')); }, 30_000);
      worker.onmessage = (event: MessageEvent<string>) => { clearTimeout(timeout); worker.terminate(); resolve(event.data); };
      worker.onerror = (event) => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message)); };
      worker.postMessage(null);
    });
    URL.revokeObjectURL(workerUrl);
    const workerLayout = engine.layoutParagraph({ text: 'Worker AVATAR office Übergröße', width: 360,
      fontFamilies: ['Noto Sans'], fontSize: 27 });
    const workerPixels = engine.rasterizeParagraph(workerLayout, 2).raster.toPixels();
    workerLayout.dispose();
    const mainDigest = await crypto.subtle.digest('SHA-256', workerPixels);
    const mainWorkerHash = [...new Uint8Array(mainDigest)].map((value) => value.toString(16).padStart(2, '0')).join('');

    const quality = Object.assign(document.createElement('canvas'), { id: 'canvaskit-quality', width: 1600, height: 330 });
    quality.style.cssText = 'width:1600px;height:330px;display:block';
    document.body.replaceChildren(quality);
    const context = quality.getContext('2d')!;
    context.fillStyle = '#fff'; context.fillRect(0, 0, quality.width, quality.height);
    context.fillStyle = '#111827'; context.font = '600 18px sans-serif';
    context.fillText('CanvasKit / Skia', 20, 27); context.fillText('Canvas2D / browser', 820, 27);
    const browserFont = new FontFace('Noto Sans Browser', 'url(/fonts/NotoSans-Variable.ttf)');
    await browserFont.load(); document.fonts.add(browserFont);
    const sample = 'AVATAR office · Übergröße fi';
    const sizes = [12, 16, 48];
    const tops = [50, 104, 176];
    for (let i = 0; i < sizes.length; i++) {
      const size = sizes[i]!, top = tops[i]!;
      const layout = engine.layoutParagraph({ text: sample, width: 750, fontFamilies: ['Noto Sans'], fontSize: size,
        fontFeatures: [{ name: 'kern', value: 1 }, { name: 'liga', value: 1 }] });
      const raster = engine.rasterizeParagraph(layout, 2).raster;
      layout.dispose();
      const temporary = Object.assign(document.createElement('canvas'), { width: raster.width, height: raster.height });
      temporary.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(raster.toPixels()), raster.width, raster.height), 0, 0);
      context.drawImage(temporary, 18, top - 2);
      context.fillStyle = '#111827'; context.font = `${size}px "Noto Sans Browser"`; context.textBaseline = 'top';
      context.fillText(sample, 818, top);
      context.fillStyle = '#64748b'; context.font = '11px sans-serif'; context.fillText(`${size}px`, 770, top + 2);
    }

    const resources = performance.getEntriesByType('resource')
      .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming)
      .filter((entry) => /canvaskit/i.test(entry.name))
      .map((entry) => ({ name: entry.name, transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize }));
    const memory = engine.memoryUsage();
    engine.dispose();
    return {
      lazyBeforeImport: before.some((name) => /canvaskit/i.test(name)), hash,
      png: Array.from(encodePng(pixels, sheet.raster.width, sheet.raster.height, 4)),
      width: sheet.raster.width, height: sheet.raster.height,
      unresolvedCodepoints: sheet.unresolvedCodepoints,
      paragraphMetrics: sheet.paragraphMetrics,
      performance: performanceResult, resources, memory, workerHash, mainWorkerHash,
    };
  });

  const artifactDirectory = path.resolve('artifacts/canvaskit');
  fs.mkdirSync(artifactDirectory, { recursive: true });
  fs.writeFileSync(path.join(artifactDirectory, `sheet-${info.project.name}.png`), Buffer.from(result.png));
  await page.locator('#canvaskit-quality').screenshot({ path: path.join(artifactDirectory, `quality-${info.project.name}.png`) });
  const standardJs = path.resolve('node_modules/canvaskit-wasm/bin/canvaskit.js');
  const standardWasm = path.resolve('node_modules/canvaskit-wasm/bin/canvaskit.wasm');
  const fullJs = path.resolve('node_modules/canvaskit-wasm/bin/full/canvaskit.js');
  const fullWasm = path.resolve('node_modules/canvaskit-wasm/bin/full/canvaskit.wasm');
  const payload = {
    standard: {
      rawBytes: fs.statSync(standardJs).size + fs.statSync(standardWasm).size,
      gzipBytes: gzipBytes(standardJs) + gzipBytes(standardWasm),
    },
    full: {
      rawBytes: fs.statSync(fullJs).size + fs.statSync(fullWasm).size,
      gzipBytes: gzipBytes(fullJs) + gzipBytes(fullWasm),
    },
  };
  const record = { browser: info.project.name, recordedAt: new Date().toISOString(), sheet: {
    sha256: result.hash, width: result.width, height: result.height,
    pngSha256: crypto.createHash('sha256').update(Buffer.from(result.png)).digest('hex'),
    unresolvedCodepoints: result.unresolvedCodepoints,
  }, performance: result.performance, memory: result.memory, worker: {
    sha256: result.workerHash, matchesMainThread: result.workerHash === result.mainWorkerHash,
  }, lazyLoad: { loadedBeforeImport: result.lazyBeforeImport, resources: result.resources, payload } };
  fs.writeFileSync(path.join(artifactDirectory, `metrics-${info.project.name}.json`), JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record, null, 2));

  expect(result.lazyBeforeImport).toBe(false);
  expect(result.unresolvedCodepoints).toEqual([]);
  expect(result.hash).toBe(EXPECTED_SHEET_SHA256);
  expect(result.performance.characterCount).toBe(500);
  expect(result.performance.samplesMs).toHaveLength(50);
  expect(result.performance.p95Ms).toBeGreaterThan(0);
  expect(result.workerHash).toBe(result.mainWorkerHash);
  expect(payload.standard.gzipBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
});
