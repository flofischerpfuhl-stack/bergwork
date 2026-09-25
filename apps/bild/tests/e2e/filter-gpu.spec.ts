import { expect, test } from '@playwright/test';
import { mountForTest } from './helpers';

test('view-space filter passes match the independent CPU bake at 1:1', async ({ page }) => {
  await mountForTest(page);
  const results = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const [{ Raster }, { newLayer }, { makeTransform }, live] = await Promise.all([
      load('/src/core/raster.ts'), load('/src/core/document.ts'), load('/src/core/geometry.ts'),
      load('/src/core/filters/live.ts'),
    ]);
    const width = 24, height = 20, pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      pixels[at] = (x * 17 + y * 7) & 255; pixels[at + 1] = (x * 3 + y * 19) & 255;
      pixels[at + 2] = (x * 11 ^ y * 13) & 255; pixels[at + 3] = 255;
    }
    const source = Raster.fromPixels(width, height, 4, pixels);
    const transform = makeTransform({ x: 0, y: 0 }, { width, height });
    const filters = [
      { ...live.defaultLiveFilter('gaussianBlur'), radius: 1.4 },
      { ...live.defaultLiveFilter('motionBlur'), distance: 4, angle: 30 },
      { ...live.defaultLiveFilter('noise'), amount: 12, gaussian: false, monochromatic: false },
      { ...live.defaultLiveFilter('unsharpMask'), amount: 80, radius: 1.2, threshold: 3 },
      { ...live.defaultLiveFilter('smartSharpen'), amount: 65, radius: 1.1, threshold: 0, reduceNoise: 0 },
      { ...live.defaultLiveFilter('highPass'), radius: 1.4 },
      { ...live.defaultLiveFilter('denoise'), luminance: 30, colour: 35, detail: 50 },
      { ...live.defaultLiveFilter('lensCorrection'), distortion: 18 },
    ];
    const gpu = (window as any).__editorForTests.canvasView.gpu;
    const view = { width, height, viewToDoc: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, scale: 1, snap: false };
    const output: { kind: string; maximum: number; mean: number }[] = [];
    for (const filter of filters) {
      const layer = newLayer({ id: `filter-${filter.kind}`, name: filter.kind, raster: source, transform,
        filters: [filter] });
      const document = { id: `document-${filter.kind}`, width, height, resolution: 72, selection: null, layers: [layer] };
      const actual = gpu.readView(document, width, height, view.viewToDoc, 1);
      const reference = live.applyLiveFilters(source, [filter]).toPixels();
      let maximum = 0, total = 0;
      for (let index = 0; index < actual.length; index++) {
        const delta = Math.abs(actual[index] - reference[index]);
        maximum = Math.max(maximum, delta);
        total += delta;
      }
      output.push({ kind: filter.kind, maximum, mean: total / actual.length });
    }
    const stack = [
      { ...live.defaultLiveFilter('gaussianBlur'), radius: 0.8 },
      { ...live.defaultLiveFilter('noise'), amount: 5, gaussian: false, monochromatic: true },
    ];
    const stackLayer = newLayer({ id: 'filter-stack', name: 'Filter stack', raster: source, transform, filters: stack });
    const stackDocument = { id: 'document-stack', width, height, resolution: 72, selection: null, layers: [stackLayer] };
    const stackActual = gpu.readView(stackDocument, width, height, view.viewToDoc, 1);
    const stackReference = live.applyLiveFilters(source, stack).toPixels();
    let stackMaximum = 0, stackTotal = 0;
    for (let index = 0; index < stackActual.length; index++) {
      const delta = Math.abs(stackActual[index] - stackReference[index]);
      stackMaximum = Math.max(stackMaximum, delta); stackTotal += delta;
    }
    output.push({ kind: 'ordered stack', maximum: stackMaximum, mean: stackTotal / stackActual.length });
    return output;
  });
  console.log(`FILTER_GPU ${JSON.stringify(results)}`);
  for (const result of results) expect(result.maximum, result.kind).toBeLessThanOrEqual(1);
});
