import { expect, test } from '@playwright/test';

test('decodes and tiles a large lossless image off the main thread', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?harness=perfio');
  const result = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { encodePng } = await load('/src/io/png.ts');
    const { decodeImageFile } = await load('/src/io/imageImport.ts');
    const background = await load('/src/workers/imageDecodeClient.ts');
    const { sha256Hex } = await load('/src/io/sha256.ts');
    const width = 2_048, height = 2_048;
    const original = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      original[at] = x & 255;
      original[at + 1] = y & 255;
      original[at + 2] = (x ^ y) & 255;
      original[at + 3] = 255;
    }
    const encoded = encodePng(original, width, height, 4, { level: 1 });
    const expectedHash = sha256Hex(original);
    type Run = { totalMs: number; maxTimerGapMs: number; tileBytes: number; sample: number[]; pixelHash: string };
    const measure = async (decode: () => Promise<any>): Promise<Run> => {
      const gaps: number[] = [];
      let previous = performance.now();
      const timer = setInterval(() => { const now = performance.now(); gaps.push(now - previous); previous = now; }, 5);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      const start = performance.now();
      const raster = await decode();
      const totalMs = performance.now() - start;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      clearInterval(timer);
      return { totalMs, maxTimerGapMs: Math.max(0, ...gaps),
        tileBytes: raster.tiles.reduce((sum: number, tile: Uint8Array | null) => sum + (tile?.byteLength ?? 0), 0),
        sample: raster.pixel(1_337, 733), pixelHash: sha256Hex(raster.toPixels()) };
    };
    const directRuns: Run[] = [];
    for (let run = 0; run < 3; run++) directRuns.push(await measure(() => decodeImageFile(encoded, width * height)));
    background.clearBackgroundImageDecodeTimings();
    const workerRuns: Run[] = [];
    for (let run = 0; run < 3; run++) workerRuns.push(await measure(() => background.decodeImageFileInBackground(encoded, width * height)));
    const gl = document.createElement('canvas').getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return { width, height, encodedBytes: encoded.byteLength, decodedBytes: original.byteLength, expectedHash, directRuns, workerRuns,
      timings: background.backgroundImageDecodeTimings(),
      renderer: gl ? gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : 'none' };
  });
  console.info('PERFIO import worker', JSON.stringify(result));
  for (const run of [...result.directRuns, ...result.workerRuns]) {
    expect(run.tileBytes).toBe(result.decodedBytes);
    expect(run.sample).toEqual([57, 221, 228, 255]);
    expect(run.pixelHash).toBe(result.expectedHash);
  }
  expect(result.timings).toHaveLength(3);
  expect(result.timings.every((timing: { copiedInputBytes: number }) => timing.copiedInputBytes === result.encodedBytes)).toBe(true);
});
