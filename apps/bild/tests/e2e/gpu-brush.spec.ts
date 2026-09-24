import { expect, test } from '@playwright/test';
import type { Layer } from '../../src/core/document';
import type { EditorSession } from '../../src/core/session';
import type { CanvasView } from '../../src/ui/canvas/CanvasView';
import { mountForTest } from './helpers';

test.use({ viewport: { width: 900, height: 700 } });

test('GPU brush coverage matches the exact CPU preview for paint, erase and masks at all tested zooms', async ({ page }) => {
  await mountForTest(page);
  // The compositor is created asynchronously after mounting (slower in WebKit).
  await page.waitForFunction(() => !!(window as any).__editorForTests?.canvasView?.gpu);
  const results = await page.evaluate(async () => {
    const load = <T,>(path: string): Promise<T> => import(/* @vite-ignore */ path) as Promise<T>;
    const brush = await load<typeof import('../../src/core/brush/index.ts')>('/src/core/brush/index.ts');
    const rasterModule = await load<typeof import('../../src/core/raster.ts')>('/src/core/raster.ts');
    const editor = (window as unknown as { __editorForTests: { session: EditorSession; canvasView: CanvasView } }).__editorForTests;
    const session = editor.session;
    const gpu = editor.canvasView.gpu;
    const size = 192;
    const output: { label: string; max: number; final: number }[] = [];
    const points = [
      { x: 21.5, y: 37.25 }, { x: 42.75, y: 60.5 }, { x: 71.125, y: 46.25 },
      { x: 98.5, y: 92.75 }, { x: 135.25, y: 75.5 }, { x: 166.75, y: 132.125 },
    ];
    for (const mask of [false, true]) for (const mode of ['paint', 'erase'] as const) {
      if (mask && mode === 'erase') continue;
      for (const hardness of [0, 1]) for (const zoom of [1, 0.37, 2.5]) {
        session.createNewProject(size, size);
        const bytes = new Uint8Array(size * size * 4);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          bytes[i] = 0; bytes[i + 1] = 0; bytes[i + 2] = 0; bytes[i + 3] = 255;
        }
        const layer = session.activeLayer!;
        if (layer.kind !== 'pixel') throw new Error('Expected pixel layer');
        session.replaceDocument({ ...session.document!, layers: [{ ...layer,
          raster: rasterModule.Raster.fromPixels(size, size, 4, bytes) }] });
        if (mask) session.addLayerMask(true);
        session.tool = 'brush';
        const settings = { ...brush.DEFAULT_BRUSH_SETTINGS, diameter: 37, hardness,
          opacity: 0.63, red: 0.8, green: 0.1, blue: 0.55, mode };
        brush.beginBrushStroke(session, points[0]!, { settings });
        for (let i = 1; i < points.length; i++) brush.extendBrushStroke(session, points[i]!);
        const cpu = brush.currentBrushPreview(session);
        const active = brush.currentGpuBrushPreview(session);
        const width = Math.max(1, Math.round(size * zoom)), height = Math.max(1, Math.round(size * zoom));
        const viewToDoc = { a: 1 / zoom, b: 0, c: 0, d: 1 / zoom, tx: 0, ty: 0 };
        const baseHooks = {
          transform: (l: Layer) => session.displayedTransform(l),
          maskPlacement: (l: Layer) => session.displayedMaskPlacement(l),
          blendMode: (l: Layer) => session.displayedBlendMode(l),
        };
        const gpuPixels = gpu!.readView(session.document!, width, height, viewToDoc, zoom, {
          ...baseHooks, raster: (l: Layer) => l.raster, maskRaster: (l: Layer) => l.mask?.raster ?? null,
          brush: active,
        });
        const cpuPixels = gpu!.readView(session.document!, width, height, viewToDoc, zoom, {
          ...baseHooks,
          transform: (l: Layer) => cpu && !cpu.mask && cpu.layerId === l.id ? cpu.transform : l.transform,
          raster: (l: Layer) => cpu && !cpu.mask && cpu.layerId === l.id ? cpu.raster : l.raster,
          maskRaster: (l: Layer) => cpu?.mask && cpu.layerId === l.id ? cpu.raster : l.mask?.raster ?? null,
        });
        brush.finishBrushStroke(session);
        const pendingPixels = gpu!.readView(session.document!, width, height, viewToDoc, zoom, {
          ...baseHooks, raster: (l: Layer) => l.raster, maskRaster: (l: Layer) => l.mask?.raster ?? null,
          brush: brush.currentGpuBrushPreview(session),
        });
        await brush.waitForBrushStroke(session);
        const finalPixels = gpu!.readView(session.document!, width, height, viewToDoc, zoom, {
          ...baseHooks, raster: (l: Layer) => l.raster, maskRaster: (l: Layer) => l.mask?.raster ?? null,
        });
        let max = 0, final = 0;
        for (let i = 0; i < gpuPixels.length; i++) {
          const pixel = Math.floor(i / 4), x = pixel % width, y = Math.floor(pixel / width);
          const documentX = (x + 0.5) / zoom, documentY = (y + 0.5) / zoom;
          if (documentX < 1 || documentX > 188 || documentY < 16 || documentY > 153) continue;
          const committedDifference = Math.abs(pendingPixels[i]! - finalPixels[i]!);
          const difference = Math.abs(gpuPixels[i]! - cpuPixels[i]!);
          if (difference > max) max = difference;
          if (committedDifference > final) final = committedDifference;
        }
        const label = `${mask ? 'mask' : mode}-${hardness ? 'hard' : 'soft'}-${zoom}`;
        output.push({ label, max, final });
      }
    }
    return output;
  });
  for (const result of results) {
    expect(result.max, `${result.label} live CPU`).toBeLessThanOrEqual(2);
    expect(result.final, `${result.label} committed`).toBeLessThanOrEqual(2);
  }
});

test('rapid worker-backed strokes commit in order as two undo steps', async ({ page }) => {
  await mountForTest(page);
  const result = await page.evaluate(async () => {
    const load = <T,>(path: string): Promise<T> => import(/* @vite-ignore */ path) as Promise<T>;
    const brush = await load<typeof import('../../src/core/brush/index.ts')>('/src/core/brush/index.ts');
    const geometry = await load<typeof import('../../src/core/geometry.ts')>('/src/core/geometry.ts');
    const editor = (window as unknown as { __editorForTests: { session: EditorSession } }).__editorForTests;
    const session = editor.session;
    session.createNewProject(128, 128);
    session.tool = 'brush';
    const settings = { ...brush.DEFAULT_BRUSH_SETTINGS, diameter: 18, hardness: 1,
      opacity: 1, red: 1, green: 0, blue: 0, mode: 'paint' as const };
    const before = session.history.undoCount;
    brush.beginBrushStroke(session, { x: 12, y: 32 }, { settings });
    brush.extendBrushStroke(session, { x: 116, y: 32 });
    brush.finishBrushStroke(session);
    brush.beginBrushStroke(session, { x: 12, y: 96 }, { settings });
    brush.extendBrushStroke(session, { x: 116, y: 96 });
    brush.finishBrushStroke(session);
    await brush.waitForBrushStroke(session);
    const sample = (x: number, y: number) => {
      const layer = session.activeLayer!;
      const p = geometry.apply(geometry.invert(geometry.pixelToDocument(layer.transform,
        layer.raster!.width, layer.raster!.height)), { x, y });
      return layer.raster!.pixel(Math.floor(p.x), Math.floor(p.y))[3] ?? 0;
    };
    const both = [sample(64, 32), sample(64, 96)];
    const steps = session.history.undoCount - before;
    session.undo();
    const afterOne = [sample(64, 32), sample(64, 96)];
    session.undo();
    return { steps, both, afterOne, empty: session.activeLayer?.raster === null };
  });
  expect(result.steps).toBe(2);
  expect(result.both[0]).toBeGreaterThan(250);
  expect(result.both[1]).toBeGreaterThan(250);
  expect(result.afterOne[0]).toBeGreaterThan(250);
  expect(result.afterOne[1]).toBe(0);
  expect(result.empty).toBe(true);
});

test('Undo requested immediately after pointer-up waits for and undoes the pending stroke', async ({ page }) => {
  await mountForTest(page);
  const result = await page.evaluate(async () => {
    const load = <T,>(path: string): Promise<T> => import(/* @vite-ignore */ path) as Promise<T>;
    const brush = await load<typeof import('../../src/core/brush/index.ts')>('/src/core/brush/index.ts');
    const editor = (window as unknown as { __editorForTests: { session: EditorSession } }).__editorForTests;
    const session = editor.session;
    session.createNewProject(128, 128);
    session.tool = 'brush';
    brush.beginBrushStroke(session, { x: 20, y: 64 }, { settings: { ...brush.DEFAULT_BRUSH_SETTINGS,
      diameter: 24, hardness: 0, red: 0, green: 0, blue: 0, mode: 'paint' } });
    brush.extendBrushStroke(session, { x: 108, y: 64 });
    brush.finishBrushStroke(session);
    const accepted = session.undo();
    await brush.waitForBrushStroke(session);
    return { accepted, raster: session.activeLayer?.raster ?? null, undoCount: session.history.undoCount };
  });
  expect(result.accepted).toBe(true);
  expect(result.raster).toBeNull();
  expect(result.undoCount).toBe(0);
});
