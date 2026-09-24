import { expect, test } from '@playwright/test';
import type { Layer } from '../../src/core/document';

test('A6b dirty brush frames and committed bytes equal full recomposition and CPU replay', async ({ page }) => {
  await page.goto('/tests/webview/a6b-test.html');
  const result = await page.evaluate(async () => {
    const load = <T,>(path: string): Promise<T> => import(/* @vite-ignore */ path) as Promise<T>;
    const [{ GpuCompositor }, brush, { EditorSession }, { Raster }, documentModule, geometry] = await Promise.all([
      load<typeof import('../../src/render/gpuCompositor.ts')>('/src/render/gpuCompositor.ts'),
      load<typeof import('../../src/core/brush/index.ts')>('/src/core/brush/index.ts'),
      load<typeof import('../../src/core/session.ts')>('/src/core/session.ts'),
      load<typeof import('../../src/core/raster.ts')>('/src/core/raster.ts'),
      load<typeof import('../../src/core/document.ts')>('/src/core/document.ts'),
      load<typeof import('../../src/core/geometry.ts')>('/src/core/geometry.ts'),
    ]);
    const size = 512, session = new EditorSession();
    session.createNewProject(size, size);
    const layers: Layer[] = [];
    for (let layerIndex = 0; layerIndex < 5; layerIndex++) {
      const pixels = new Uint8Array(size * size * 4);
      for (let pixel = 0; pixel < size * size; pixel++) {
        const x = pixel % size, y = Math.floor(pixel / size), at = pixel * 4;
        pixels[at] = (x * (layerIndex + 1)) & 255; pixels[at + 1] = (y * (layerIndex + 2)) & 255;
        pixels[at + 2] = ((x ^ y) * (layerIndex + 3)) & 255; pixels[at + 3] = layerIndex ? 176 : 255;
      }
      layers.push(documentModule.newLayer({ id: `P${layerIndex}`, name: `P${layerIndex}`,
        raster: Raster.fromPixels(size, size, 4, pixels),
        transform: geometry.makeTransform({ x: 0, y: 0 }, { width: size, height: size }),
        blendMode: (['normal', 'multiply', 'screen', 'overlay', 'normal'] as const)[layerIndex] }));
    }
    session.replaceDocument({ ...session.document!, layers });
    session.selectLayer('P4'); session.selectTool('brush');
    const settings = { ...brush.DEFAULT_BRUSH_SETTINGS, diameter: 91, hardness: 0, opacity: 0.73,
      red: 0.8, green: 0.12, blue: 0.45 };
    const points = [{ x: 45, y: 70 }, { x: 100, y: 95 }, { x: 155, y: 82 }, { x: 220, y: 160 },
      { x: 285, y: 130 }, { x: 355, y: 250 }, { x: 430, y: 390 }];
    const exact = brush.beginStroke({ layer: layers[4]!, canvas: { width: size, height: size }, settings });
    const incremental = await GpuCompositor.create(document.createElement('canvas'), size, size);
    brush.beginBrushStroke(session, points[0]!, { settings }); exact.addPoints([points[0]!]);
    const hooks = () => ({
      transform: (layer: Layer) => layer.transform,
      maskPlacement: (layer: Layer) => layer.mask?.placement ?? null,
      blendMode: (layer: Layer) => layer.blendMode,
      raster: (layer: Layer) => layer.raster,
      maskRaster: (layer: Layer) => layer.mask?.raster ?? null,
      brush: brush.currentGpuBrushPreview(session),
    });
    let incrementalPixels: Uint8Array<ArrayBufferLike> = new Uint8Array();
    for (let index = 1; index < points.length; index++) {
      brush.extendBrushStroke(session, points[index]!); exact.addPoints([points[index]!]);
      incrementalPixels = incremental.readRegion(session.document!, 0, 0, size, size, hooks());
    }
    const full = await GpuCompositor.create(document.createElement('canvas'), size, size);
    const fullPixels = full.readRegion(session.document!, 0, 0, size, size, hooks());
    let liveDifferences = 0, liveMaximum = 0;
    for (let index = 0; index < fullPixels.length; index++) {
      const delta = Math.abs(fullPixels[index]! - incrementalPixels[index]!);
      if (delta) liveDifferences++; liveMaximum = Math.max(liveMaximum, delta);
    }
    const expected = exact.finish().raster.toPixels();
    brush.finishBrushStroke(session); await brush.waitForBrushStroke(session);
    const committed = session.activeLayer!.raster!.toPixels();
    let committedDifferences = 0;
    for (let index = 0; index < expected.length; index++) if (expected[index] !== committed[index]) committedDifferences++;
    incremental.destroy(); full.destroy();
    return { liveDifferences, liveMaximum, committedDifferences, committedBytes: committed.byteLength };
  });
  expect(result.liveMaximum).toBeLessThanOrEqual(1);
  expect(result.committedDifferences).toBe(0);
  expect(result.committedBytes).toBe(512 * 512 * 4);
});
