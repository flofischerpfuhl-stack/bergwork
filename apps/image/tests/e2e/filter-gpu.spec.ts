import { expect, test } from '@playwright/test';
import { mountForTest } from './helpers';

test('view-space filter passes match the independent CPU bake at 1:1', async ({ page }) => {
  await mountForTest(page);
  const results = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const [{ Raster }, { newLayer }, geometry, live] = await Promise.all([
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
    const transform = geometry.makeTransform({ x: 0, y: 0 }, { width, height });
    const filters = [
      { ...live.defaultLiveFilter('gaussianBlur'), radius: 1.4, opacity: 0.6, blendMode: 'screen' },
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
    const output: { kind: string; maximum: number; mean: number;
      worst?: { index: number; actual: number; reference: number; signed: number } }[] = [];
    for (const filter of filters) {
      const layer = newLayer({ id: `filter-${filter.kind}`, name: filter.kind, raster: source, transform,
        filters: [filter] });
      const document = { id: `document-${filter.kind}`, width, height, resolution: 72, selection: null, layers: [layer] };
      const actual = gpu.readView(document, width, height, view.viewToDoc, 1);
      const reference = live.applyLiveFilters(source, [filter]).toPixels();
      let maximum = 0, total = 0, worst = { index: 0, actual: 0, reference: 0, signed: 0 };
      for (let index = 0; index < actual.length; index++) {
        const delta = Math.abs(actual[index] - reference[index]);
        if (delta > maximum) {
          maximum = delta;
          worst = { index, actual: actual[index], reference: reference[index],
            signed: actual[index] - reference[index] };
        }
        total += delta;
      }
      output.push({ kind: filter.kind, maximum, mean: total / actual.length, worst });
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
    const maskPixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) maskPixels[y * width + x] = Math.round(x * 255 / (width - 1));
    const filterMask = { raster: Raster.fromPixels(width, height, 1, maskPixels), enabled: true,
      placement: null, linked: true, defaultColor: 0 };
    const maskedLayer = newLayer({ id: 'filter-mask', name: 'Filter mask', raster: source, transform,
      filters: stack, filterMask });
    const maskedDocument = { id: 'document-filter-mask', width, height, resolution: 72, selection: null, layers: [maskedLayer] };
    const maskedActual = gpu.readView(maskedDocument, width, height, view.viewToDoc, 1);
    const maskedReference = live.applyLiveFilters(source, stack, filterMask, transform).toPixels();
    let maskedMaximum = 0, maskedTotal = 0;
    for (let index = 0; index < maskedActual.length; index++) {
      const delta = Math.abs(maskedActual[index] - maskedReference[index]);
      maskedMaximum = Math.max(maskedMaximum, delta);
      maskedTotal += delta;
    }
    output.push({ kind: 'smart-filter mask', maximum: maskedMaximum, mean: maskedTotal / maskedActual.length });
    const identity = { black0: 0, black1: 0, white0: 255, white1: 255 };
    const blendIf = { source: { gray: identity, red: { black0: 40, black1: 110, white0: 180, white1: 240 }, green: identity, blue: identity },
      destination: { gray: identity, red: identity, green: { black0: 30, black1: 90, white0: 190, white1: 250 }, blue: identity } };
    const backdrop = newLayer({ id: 'blend-if-backdrop', name: 'Backdrop', raster: source, transform });
    const blendLayer = newLayer({ id: 'blend-if', name: 'Blend If', raster: source, transform, blendIf, opacity: 0.8 });
    const blendDocument = { id: 'document-blend-if', width, height, resolution: 72, selection: null, layers: [backdrop, blendLayer] };
    const blendActual = gpu.readView(blendDocument, width, height, view.viewToDoc, 1);
    const { cpuCompositeRegion } = await load('/src/render/cpuRender.ts');
    const blendReference = cpuCompositeRegion(blendDocument, { x: 0, y: 0, width, height });
    let blendMaximum = 0, blendTotal = 0;
    for (let index = 0; index < blendActual.length; index++) {
      const delta = Math.abs(blendActual[index] - blendReference[index]);
      blendMaximum = Math.max(blendMaximum, delta); blendTotal += delta;
    }
    output.push({ kind: 'blend-if split channels', maximum: blendMaximum, mean: blendTotal / blendActual.length });
    return output;
  });
  console.log(`FILTER_GPU ${JSON.stringify(results)}`);
  for (const result of results) expect(result.maximum, result.kind).toBeLessThanOrEqual(1);
});
