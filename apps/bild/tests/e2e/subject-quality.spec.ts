import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const references = '/home/oem/Dokumente/003_Projekte/17_fernwork/research/compositor-port/references/official-site';
const modelPath = 'public/models/birefnet-lite-1024.onnx';

test('BiRefNet_lite compares fast/best masks and records reference edge crops', async ({ page, browser }) => {
  test.skip(!existsSync(modelPath), 'HQ model is absent; run scripts/fetch-model-hq.sh for the optional real-model test');
  // Flower first makes its BiRefNet timing a cold download/load measurement, as required by the benchmark.
  const paths = [`${references}/example2.png`, `${references}/example1.png`,
    `${references}/example3.png`, `${references}/example4.png`];
  test.skip(paths.some((path) => !existsSync(path)), 'official reference photos are not available on this machine');
  test.setTimeout(15 * 60_000);
  const images = await Promise.all(paths.map(async (path) => (await readFile(path)).toString('base64')));
  await page.goto('/');
  const browserSession = await browser.newBrowserCDPSession();
  let peakBrowserRssBytes = 0, sampling = false;
  const sampleMemory = async (): Promise<void> => {
    if (sampling) return;
    sampling = true;
    try {
      const result = await browserSession.send('SystemInfo.getProcessInfo') as { processInfo: Array<{ id: number }> };
      let total = 0;
      await Promise.all(result.processInfo.map(async ({ id }) => {
        try {
          const status = await readFile(`/proc/${id}/status`, 'utf8');
          const kibibytes = Number(status.match(/^VmRSS:\s+([0-9]+)/m)?.[1] ?? 0);
          total += kibibytes * 1024;
        } catch { /* a short-lived Chromium process exited between samples */ }
      }));
      peakBrowserRssBytes = Math.max(peakBrowserRssBytes, total);
    } finally { sampling = false; }
  };
  await sampleMemory();
  const memoryTimer = setInterval(() => { void sampleMemory(); }, 500);
  const results = await page.evaluate(async ({ images }) => {
    const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path);
    const module = await load('/src/workers/subjectClient.ts') as typeof import('../../src/workers/subjectClient');
    const client = new module.SubjectInferenceClient();
    const settings = { quality: 'basic' as const, refineEdges: 12, matteContrast: 25, shiftEdge: 0 };
    const masks: Record<'fast' | 'best', Uint8Array[]> = { fast: [], best: [] };
    const timings: Record<'fast' | 'best', Array<import('../../src/workers/subjectProtocol').SubjectTiming>> = {
      fast: [], best: [],
    };
    const counts: Record<'fast' | 'best', number[]> = { fast: [], best: [] };
    let width = 0, height = 0;
    const heapBefore = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;

    for (const model of ['fast', 'best'] as const) {
      const modelPath = model === 'fast' ? '/models/u2netp.onnx' : '/models/birefnet-lite-1024.onnx';
      const modelBytes = new Uint8Array(await (await fetch(modelPath)).arrayBuffer());
      for (let index = 0; index < images.length; index++) {
        const encoded = images[index]!;
        const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        width = bitmap.width; height = bitmap.height;
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('2D canvas is unavailable');
        context.drawImage(bitmap, 0, 0); bitmap.close();
        const rgba = new Uint8Array(context.getImageData(0, 0, width, height).data);
        const output = await client.infer(`${model}:${index}`, rgba, width, height, settings, 1400, model,
          { bytes: modelBytes.slice(), cacheHit: index > 0, resolveMs: 0 });
        masks[model].push(output.mask); timings[model].push(output.timing); counts[model].push(output.componentCount);
      }
    }

    const summaries = [];
    const crops = [
      { x: 280, y: 70, width: 900, height: 650 }, // example2 fine petal edges
      { x: 630, y: 0, width: 500, height: 310 }, // example1 hair/profile boundary
      { x: 220, y: 0, width: 1050, height: 816 }, // example3 subject and shattered-glass edges
      { x: 0, y: 0, width: 580, height: 816 }, // example4 hair/eye boundary
    ];
    for (let index = 0; index < images.length; index++) {
      const fast = masks.fast[index]!, best = masks.best[index]!;
      let difference = 0, edgeDifference = 0, edgeCount = 0;
      for (let pixel = 0; pixel < fast.length; pixel++) {
        const delta = Math.abs(fast[pixel]! - best[pixel]!);
        difference += delta;
        if ((fast[pixel]! > 15 && fast[pixel]! < 240) || (best[pixel]! > 15 && best[pixel]! < 240)) {
          edgeDifference += delta; edgeCount++;
        }
      }
      const crop = crops[index]!;
      const panel = new OffscreenCanvas(crop.width * 3, crop.height);
      const context = panel.getContext('2d');
      if (!context) throw new Error('2D canvas is unavailable');
      const sourceBytes = Uint8Array.from(atob(images[index]!), (character) => character.charCodeAt(0));
      const source = await createImageBitmap(new Blob([sourceBytes], { type: 'image/png' }));
      context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
      source.close();
      for (const [column, mask] of [[1, fast], [2, best]] as const) {
        const rgba = new Uint8ClampedArray(width * height * 4);
        for (let pixel = 0, offset = 0; pixel < mask.length; pixel++, offset += 4) {
          const value = mask[pixel]!;
          rgba[offset] = value; rgba[offset + 1] = value; rgba[offset + 2] = value; rgba[offset + 3] = 255;
        }
        const full = new OffscreenCanvas(width, height), fullContext = full.getContext('2d');
        if (!fullContext) throw new Error('2D canvas is unavailable');
        fullContext.putImageData(new ImageData(rgba, width, height), 0, 0);
        context.drawImage(full, crop.x, crop.y, crop.width, crop.height,
          crop.width * column, 0, crop.width, crop.height);
      }
      const blob = await panel.convertToBlob({ type: 'image/png' });
      const cropBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error); reader.onload = () => resolve(String(reader.result).split(',')[1]!);
        reader.readAsDataURL(blob);
      });
      summaries.push({ meanAbsoluteDifference: difference / fast.length,
        edgeMeanAbsoluteDifference: edgeCount ? edgeDifference / edgeCount : 0, edgePixelCount: edgeCount,
        fastTiming: timings.fast[index]!, bestTiming: timings.best[index]!, fastComponents: counts.fast[index]!,
        bestComponents: counts.best[index]!, cropBase64 });
    }
    const heapAfter = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
    client.destroy();
    return { width, height, heapBefore, heapAfter, summaries };
  }, { images });
  clearInterval(memoryTimer);
  await sampleMemory();
  await browserSession.detach();

  const artifactDirectory = 'artifacts/subject-compare';
  await mkdir(artifactDirectory, { recursive: true });
  const report = { measuredAt: new Date().toISOString(), browser: await page.evaluate(() => navigator.userAgent),
    peakBrowserRssBytes, ...results,
    summaries: results.summaries.map(({ cropBase64: _, ...summary }) => summary) };
  await writeFile(`${artifactDirectory}/metrics.json`, `${JSON.stringify(report, null, 2)}\n`);
  await Promise.all(results.summaries.map((summary, index) => writeFile(
    `${artifactDirectory}/${['example2-flower-edge', 'example1-hair', 'example3-action-edge', 'example4-hair-eye'][index]}-original-fast-best.png`,
    Buffer.from(summary.cropBase64, 'base64'))));

  for (const summary of results.summaries) {
    expect(summary.fastComponents).toBeGreaterThan(0);
    expect(summary.bestComponents).toBeGreaterThan(0);
    expect(summary.meanAbsoluteDifference).toBeGreaterThan(0);
    expect(summary.edgeMeanAbsoluteDifference).toBeGreaterThan(0);
    expect(summary.bestTiming.modelBytes).toBe(199_681_624);
  }
  console.log('Subject quality comparison', report);
});
