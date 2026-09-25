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

test('dab brushes (sampled, elliptic, scatter, flow): GPU preview matches the CPU and the worker commit is byte-identical', async ({ page }) => {
  await mountForTest(page);
  await page.waitForFunction(() => !!(window as any).__editorForTests?.canvasView?.gpu);
  const results = await page.evaluate(async () => {
    const load = <T,>(path: string): Promise<T> => import(/* @vite-ignore */ path) as Promise<T>;
    const brush = await load<typeof import('../../src/core/brush/index.ts')>('/src/core/brush/index.ts');
    const rasterModule = await load<typeof import('../../src/core/raster.ts')>('/src/core/raster.ts');
    const editor = (window as unknown as { __editorForTests: { session: EditorSession; canvasView: CanvasView } }).__editorForTests;
    const session = editor.session;
    const gpu = editor.canvasView.gpu!;
    const size = 300;
    // A generated grainy tip (no third-party image): a hash-thresholded disc.
    const tipSize = 120, tipData = new Uint8Array(tipSize * tipSize);
    for (let y = 0; y < tipSize; y++) for (let x = 0; x < tipSize; x++) {
      const d = Math.hypot(x + 0.5 - tipSize / 2, y + 0.5 - tipSize / 2) / (tipSize / 2);
      const grain = ((Math.imul(x * 73856093 ^ y * 19349663, 0x9e3779b1) >>> 0) % 256);
      tipData[y * tipSize + x] = d < 1 ? Math.round(grain * (1 - d)) : 0;
    }
    const tip = { id: 'e2e-grain', width: tipSize, height: tipSize, data: tipData };
    const dyn = brush.DEFAULT_BRUSH_DYNAMICS;
    const cases = [
      { label: 'sampled-scatter', settings: { diameter: 42, hardness: 1, tip: { kind: 'sampled', image: tip, angle: 25, roundness: 0.8 },
        dynamics: { ...dyn, spacing: 0.3, scatter: 0.9, count: 2, sizeJitter: 0.4, angleJitter: 0.25, flow: 0.8 } } },
      { label: 'elliptic-soft-flow', settings: { diameter: 50, hardness: 0.2, tip: { kind: 'round', angle: -30, roundness: 0.35 },
        dynamics: { ...dyn, spacing: 0.12, flow: 0.35, opacityJitter: 0.3 } } },
      { label: 'hard-spaced-erase', settings: { diameter: 24, hardness: 1, mode: 'erase', dynamics: { ...dyn, spacing: 1.4 } } },
      { label: 'mask-sampled', mask: true, settings: { diameter: 60, hardness: 1, tip: { kind: 'sampled', image: tip, angle: 0, roundness: 1 },
        dynamics: { ...dyn, spacing: 0.4 } } },
    ] as const;
    const points = [{ x: 30.5, y: 60.25 }, { x: 80.75, y: 110.5 }, { x: 140.125, y: 70.25 }, { x: 200.5, y: 180.75 }, { x: 270.25, y: 150.5 }];
    const output: { label: string; live: number; committed: number; exactDifferences: number; painted: number }[] = [];
    for (const test of cases) {
      session.createNewProject(size, size);
      const bytes = new Uint8Array(size * size * 4);
      for (let i = 0; i < size * size; i++) bytes.set([40, 120, 200, 255], i * 4);
      const layer = session.activeLayer!;
      if (layer.kind !== 'pixel') throw new Error('Expected pixel layer');
      session.replaceDocument({ ...session.document!, layers: [{ ...layer, raster: rasterModule.Raster.fromPixels(size, size, 4, bytes) }] });
      if ('mask' in test) session.addLayerMask(true);
      session.tool = 'brush';
      const settings = { ...brush.DEFAULT_BRUSH_SETTINGS, opacity: 0.85, red: 0.9, green: 0.2, blue: 0.1, mode: 'paint' as const,
        ...(test.settings as object) } as import('../../src/core/brush/settings.ts').BrushSettings;
      const before = session.activeLayer!;
      brush.beginBrushStroke(session, points[0]!, { settings });
      for (let i = 1; i < points.length; i++) brush.extendBrushStroke(session, points[i]!);
      const cpu = brush.currentBrushPreview(session);
      const active = brush.currentGpuBrushPreview(session);
      if (!active?.dabs?.length) throw new Error(`${test.label}: expected GPU dabs`);
      const viewToDoc = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
      const baseHooks = {
        transform: (l: Layer) => session.displayedTransform(l), maskPlacement: (l: Layer) => session.displayedMaskPlacement(l),
        blendMode: (l: Layer) => session.displayedBlendMode(l),
      };
      const gpuPixels = gpu.readView(session.document!, size, size, viewToDoc, 1, {
        ...baseHooks, raster: (l: Layer) => l.raster, maskRaster: (l: Layer) => l.mask?.raster ?? null, brush: active });
      const cpuPixels = gpu.readView(session.document!, size, size, viewToDoc, 1, {
        ...baseHooks,
        transform: (l: Layer) => cpu && !cpu.mask && cpu.layerId === l.id ? cpu.transform : l.transform,
        raster: (l: Layer) => cpu && !cpu.mask && cpu.layerId === l.id ? cpu.raster : l.raster,
        maskRaster: (l: Layer) => cpu?.mask && cpu.layerId === l.id ? cpu.raster : l.mask?.raster ?? null });
      brush.finishBrushStroke(session);
      const pendingPixels = gpu.readView(session.document!, size, size, viewToDoc, 1, {
        ...baseHooks, raster: (l: Layer) => l.raster, maskRaster: (l: Layer) => l.mask?.raster ?? null, brush: brush.currentGpuBrushPreview(session) });
      await brush.waitForBrushStroke(session);
      const finalPixels = gpu.readView(session.document!, size, size, viewToDoc, 1, {
        ...baseHooks, raster: (l: Layer) => l.raster, maskRaster: (l: Layer) => l.mask?.raster ?? null });
      // Compared premultiplied: an erased pixel at alpha 38 cannot hold its straight colour to one level in any RGBA8 path.
      const premultiplied = (pixels: ArrayLike<number>, i: number) => ((i & 3) === 3 ? pixels[i]! : pixels[i]! * pixels[i | 3]! / 255);
      let live = 0, committed = 0, painted = 0;
      for (let i = 0; i < gpuPixels.length; i++) {
        live = Math.max(live, Math.abs(premultiplied(gpuPixels, i) - premultiplied(cpuPixels, i)));
        committed = Math.max(committed, Math.abs(premultiplied(pendingPixels, i) - premultiplied(finalPixels, i)));
      }
      // The committed worker result against a synchronous replay of the same points on the main thread.
      const replay = brush.beginStroke({ layer: before, canvas: { width: size, height: size }, settings: {
        ...settings, ...('mask' in test ? { red: 0, green: 0, blue: 0 } : {}) }, target: 'mask' in test ? 'mask' : 'pixels' });
      for (const point of points) replay.addPoints([point]);
      const expected = replay.finish().raster;
      const actual = 'mask' in test ? session.activeLayer!.mask!.raster : session.activeLayer!.raster!;
      const a = actual.readRegion(0, 0, actual.width, actual.height), e = expected.readRegion(0, 0, expected.width, expected.height);
      const original = ('mask' in test ? before.mask!.raster : before.raster!);
      const o = original.width === actual.width ? original.readRegion(0, 0, actual.width, actual.height) : null;
      let exactDifferences = actual.width === expected.width && actual.height === expected.height ? 0 : Infinity;
      for (let i = 0; i < Math.min(a.length, e.length); i++) {
        if (a[i] !== e[i]) exactDifferences++;
        if (o ? a[i] !== o[i] : a[i] !== 255) painted++;
      }
      output.push({ label: test.label, live, committed, exactDifferences, painted });
    }
    return output;
  });
  for (const result of results) {
    expect(result.painted, `${result.label} painted`).toBeGreaterThan(500);
    expect(result.live, `${result.label} live CPU`).toBeLessThanOrEqual(2);
    expect(result.committed, `${result.label} committed`).toBeLessThanOrEqual(2);
    expect(result.exactDifferences, `${result.label} worker vs synchronous`).toBe(0);
  }
});
