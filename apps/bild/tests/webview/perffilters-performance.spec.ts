import { expect, test } from '@playwright/test';

test('live and destructive filter preview stays view-sized', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?harness=perffilters');
  const result = await page.evaluate(async () => {
    const load = <T,>(path: string): Promise<T> => import(/* @vite-ignore */ path) as Promise<T>;
    const [{ mountEditor }, { createBrowserHost }, rasterModule, documentModule, geometry, liveFilters, filterEditing, filterSettings] = await Promise.all([
      load<typeof import('../../src/index.ts')>('/src/index.ts'),
      load<typeof import('../../src/platform/browserHost.ts')>('/src/platform/browserHost.ts'),
      load<typeof import('../../src/core/raster.ts')>('/src/core/raster.ts'),
      load<typeof import('../../src/core/document.ts')>('/src/core/document.ts'),
      load<typeof import('../../src/core/geometry.ts')>('/src/core/geometry.ts'),
      load<typeof import('../../src/core/filters/live.ts')>('/src/core/filters/live.ts'),
      load<typeof import('../../src/core/filters/editing.ts')>('/src/core/filters/editing.ts'),
      load<typeof import('../../src/core/filters/settings.ts')>('/src/core/filters/settings.ts'),
    ]);
    document.body.style.cssText = 'margin:0;width:100vw;height:100vh;overflow:hidden';
    const root = document.body.appendChild(document.createElement('div'));
    root.style.cssText = 'width:100vw;height:100vh';
    const handle = await mountEditor(root, { locale: 'en', profile: 'pro', host: createBrowserHost() });
    const controller = (window as unknown as { __editorForTests: import('../../src/ui/controller.ts').EditorController }).__editorForTests;
    const session = controller.session, view = controller.canvasView!;
    while (!view.gpu) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const size = 1536, tile = new Uint8Array(256 * 256 * 4);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const offset = (y * 256 + x) * 4;
      tile[offset] = (x * 13 + y * 3) & 255; tile[offset + 1] = (x * 5 + y * 11) & 255;
      tile[offset + 2] = (x ^ (y * 7)) & 255; tile[offset + 3] = x < 12 || y < 12 ? 96 : 255;
    }
    const source = new rasterModule.Raster(size, size, 4, new Array((size / 256) ** 2).fill(tile));
    const transform = geometry.makeTransform({ x: 0, y: 0 }, { width: size, height: size });
    let layer = documentModule.newLayer({ id: 'pixels', name: 'Pixels', raster: source, transform });
    session.installProject({ id: 'perffilters', width: size, height: size, resolution: 72, selection: null, layers: [layer] }, 'pixels', null);
    session.fit(); view.renderNow();

    let copiedBytes = 0, workerCreations = 0;
    const nativePixels = rasterModule.Raster.prototype.toPixelsNative, NativeWorker = window.Worker;
    rasterModule.Raster.prototype.toPixelsNative = function () {
      const pixels = nativePixels.call(this); if (this === source) copiedBytes += pixels.byteLength; return pixels;
    };
    window.Worker = function (...args: ConstructorParameters<typeof Worker>): Worker {
      workerCreations++; return new NativeWorker(...args);
    } as unknown as typeof Worker;
    const distribution = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return { median: sorted[Math.floor(sorted.length / 2)]!, p95: sorted[Math.floor(sorted.length * 0.95)]!, max: sorted.at(-1)! };
    };

    const coldFilter = { ...liveFilters.defaultLiveFilter('gaussianBlur'), radius: 1.5 };
    layer = { ...session.activeLayer!, filters: [coldFilter] };
    session.replaceDocument({ ...session.document!, layers: [layer] });
    let started = performance.now(); view.renderNow(); const coldLiveMs = performance.now() - started;
    const liveMs: number[] = [];
    for (let index = 0; index < 6; index++) {
      const filter = { ...liveFilters.defaultLiveFilter('gaussianBlur'), radius: 2 + index * 1.25 };
      layer = { ...session.activeLayer!, filters: [filter] };
      session.replaceDocument({ ...session.document!, layers: [layer] });
      started = performance.now(); view.renderNow(); liveMs.push(performance.now() - started);
    }
    const liveCopies = copiedBytes;

    layer = { ...session.activeLayer!, filters: [] };
    const selectionPixels = new Uint8Array(768 * 768); selectionPixels.fill(255);
    const selection = { mask: rasterModule.Raster.fromPixels(768, 768, 1, selectionPixels), x: 384, y: 384, antialiased: false };
    session.replaceDocument({ ...session.document!, layers: [layer], selection }); view.renderNow();
    const outsideBefore = view.gpu!.readRegion(session.document!, 96, 96, 16, 16);
    copiedBytes = 0; workerCreations = 0;
    const settings = filterSettings.defaultFilterSettings();
    if (!filterEditing.beginFilterEdit(session, 'Gaussian Blur', { ...settings, radius: 3 })) throw new Error('filter edit did not begin');
    await filterEditing.updateFilterEdit(session, { ...settings, radius: 3 }, true);
    view.renderNow();
    copiedBytes = 0; workerCreations = 0;
    const previewMs: number[] = [], previewFrameMs: number[] = [];
    for (let index = 0; index < 6; index++) {
      started = performance.now();
      await filterEditing.updateFilterEdit(session, { ...settings, radius: 2 + index * 1.25 }, true);
      previewMs.push(performance.now() - started);
      started = performance.now(); view.renderNow(); previewFrameMs.push(performance.now() - started);
    }
    const preview = { copiedBytes, workerCreations };
    const previewDocument = filterEditing.documentWithPixelFilterPreview(session, session.document!);
    const previewPixels = view.gpu!.readRegion(previewDocument, 736, 736, 64, 64);
    const applyStarted = performance.now();
    const applied = await filterEditing.applyFilterEdit(session);
    const applyMs = performance.now() - applyStarted;
    const committedPixels = view.gpu!.readRegion(session.document!, 736, 736, 64, 64);
    const outsideAfter = view.gpu!.readRegion(session.document!, 96, 96, 16, 16);
    let previewCommitMaxDelta = 0, previewMinimumSigned = 0, previewMaximumSigned = 0;
    for (let index = 0; index < previewPixels.length; index++) {
      previewCommitMaxDelta = Math.max(previewCommitMaxDelta, Math.abs(previewPixels[index]! - committedPixels[index]!));
      previewMinimumSigned = Math.min(previewMinimumSigned, previewPixels[index]! - committedPixels[index]!);
      previewMaximumSigned = Math.max(previewMaximumSigned, previewPixels[index]! - committedPixels[index]!);
    }
    let outsideMaxDelta = 0;
    for (let index = 0; index < outsideBefore.length; index++) outsideMaxDelta = Math.max(outsideMaxDelta,
      Math.abs(outsideBefore[index]! - outsideAfter[index]!));
    const committed = session.activeLayer!.raster!.pixel(768, 768);
    rasterModule.Raster.prototype.toPixelsNative = nativePixels; window.Worker = NativeWorker;
    const gl = view.gpu!.gl as WebGL2RenderingContext, extension = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const filterCounters = view.gpu!.performanceCounters;
    handle.destroy();
    return { renderer, coldLiveMs, liveMs: distribution(liveMs), liveCopies, previewMs: distribution(previewMs),
      previewFrameMs: distribution(previewFrameMs), preview,
      previewCommitMaxDelta, previewSigned: [previewMinimumSigned, previewMaximumSigned], outsideMaxDelta, filterCounters, applyMs, applied,
      committed: Array.from(committed), viewport: { width: innerWidth, height: innerHeight } };
  });
  console.log(`PERFFILTERS ${JSON.stringify(result)}`);
  expect(result.applied).toBe(true);
  expect(result.committed[3]).toBeGreaterThan(0);
  if (!process.env.PERFFILTERS_BASELINE) {
    expect(result.liveCopies).toBe(0);
    expect(result.preview.workerCreations).toBe(0);
    expect(result.preview.copiedBytes).toBe(0);
    expect(result.previewCommitMaxDelta).toBeLessThanOrEqual(1);
    expect(result.outsideMaxDelta).toBe(0);
    expect(result.filterCounters.viewFilterLayers).toBeGreaterThan(0);
  }
});
