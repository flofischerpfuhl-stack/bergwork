import { expect, test } from '@playwright/test';

test('editing preview and history instrumentation', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?harness=perftools');
  const result = await page.evaluate(async () => {
    const load = <T,>(path: string): Promise<T> => import(/* @vite-ignore */ path) as Promise<T>;
    const [{ mountEditor }, { createBrowserHost }, rasterModule, documentModule, geometry, adjustments, editing, historyModule] = await Promise.all([
      load<typeof import('../../src/index.ts')>('/src/index.ts'),
      load<typeof import('../../src/platform/browserHost.ts')>('/src/platform/browserHost.ts'),
      load<typeof import('../../src/core/raster.ts')>('/src/core/raster.ts'),
      load<typeof import('../../src/core/document.ts')>('/src/core/document.ts'),
      load<typeof import('../../src/core/geometry.ts')>('/src/core/geometry.ts'),
      load<typeof import('../../src/core/adjustments.ts')>('/src/core/adjustments.ts'),
      load<typeof import('../../src/core/adjust/editing.ts')>('/src/core/adjust/editing.ts'),
      load<typeof import('../../src/core/history.ts')>('/src/core/history.ts'),
    ]);
    document.body.style.cssText = 'margin:0;width:100vw;height:100vh;overflow:hidden';
    const root = document.body.appendChild(document.createElement('div'));
    root.style.cssText = 'width:100vw;height:100vh';
    const handle = await mountEditor(root, { locale: 'en', profile: 'pro', host: createBrowserHost() });
    const controller = (window as unknown as { __editorForTests: import('../../src/ui/controller.ts').EditorController }).__editorForTests;
    const session = controller.session, view = controller.canvasView!;
    while (!view.gpu) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const tile = new Uint8Array(256 * 256 * 4);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const offset = (y * 256 + x) * 4;
      tile[offset] = x; tile[offset + 1] = y; tile[offset + 2] = x ^ y; tile[offset + 3] = 255;
    }
    const size = 2048;
    const source = new rasterModule.Raster(size, size, 4, new Array((size / 256) ** 2).fill(tile));
    const layer = documentModule.newLayer({ id: 'pixels', name: 'Pixels', raster: source,
      transform: geometry.makeTransform({ x: 0, y: 0 }, { width: size, height: size }) });
    session.installProject({ id: 'perftools', width: size, height: size, resolution: 72, selection: null, layers: [layer] }, 'pixels', null);
    session.fit(); view.renderNow();

    let workerCreations = 0, copiedBytes = 0, documentNotices = 0;
    const NativeWorker = window.Worker;
    window.Worker = function (...args: ConstructorParameters<typeof Worker>): Worker {
      workerCreations++; return new NativeWorker(...args);
    } as unknown as typeof Worker;
    const originalPixels = rasterModule.Raster.prototype.toPixelsNative;
    rasterModule.Raster.prototype.toPixelsNative = function () {
      const value = originalPixels.call(this); if (this === source) copiedBytes += value.byteLength; return value;
    };
    const unsubscribe = session.subscribe((kind) => { if (kind === 'document') documentNotices++; });
    if (!editing.beginHueSaturationEdit(session)) throw new Error('Could not begin the measured adjustment edit');
    await editing.updateHueSaturationEdit(session, adjustments.defaultHueSaturation(5, 0, 0), true);
    view.renderNow(); // compile the adjustment pass / warm one baseline worker outside the measured drag
    workerCreations = 0; copiedBytes = 0; documentNotices = 0;
    let longTasks = 0, longTaskMs = 0;
    const observer = typeof PerformanceObserver === 'undefined' ? null : new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) { longTasks++; longTaskMs += entry.duration; }
    });
    try { observer?.observe({ type: 'longtask', buffered: false }); } catch { /* WebKit may not expose long tasks. */ }

    const eventMs: number[] = [], frameMs: number[] = [];
    const uploadsBefore = view.gpu!.performanceCounters.textureUploads;
    for (let index = 0; index < 10; index++) {
      const settings = adjustments.defaultHueSaturation(index * 11 - 45, index * 7 - 25, index - 5);
      const started = performance.now();
      await editing.updateHueSaturationEdit(session, settings, true);
      eventMs.push(performance.now() - started);
      frameMs.push(view.renderNow());
    }
    const burst = { workerCreations, copiedBytes, documentNotices,
      textureUploads: view.gpu!.performanceCounters.textureUploads - uploadsBefore };

    let previewCommitMaxDelta: number | null = null;
    const previewDocument = editing.documentWithPixelAdjustmentPreview?.(session, session.document!);
    let live: Uint8Array | null = null;
    if (previewDocument && previewDocument !== session.document) live = view.gpu!.readRegion(previewDocument, 896, 896, 64, 64);
    const applyStarted = performance.now();
    await editing.applyHueSaturationEdit(session);
    const exactApplyMs = performance.now() - applyStarted;
    if (live) {
      const committed = session.activeLayer!.raster!.readRegion(896, 896, 64, 64);
      previewCommitMaxDelta = 0;
      for (let index = 0; index < live.length; index++) previewCommitMaxDelta = Math.max(previewCommitMaxDelta, Math.abs(live[index]! - committed[index]!));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    observer?.disconnect(); unsubscribe(); rasterModule.Raster.prototype.toPixelsNative = originalPixels; window.Worker = NativeWorker;

    const hugeSize = 16_384;
    const huge = new rasterModule.Raster(hugeSize, hugeSize, 4, new Array((hugeSize / 256) ** 2).fill(tile));
    let documentValue: import('../../src/core/document.ts').CanvasDocument = { id: 'history', width: hugeSize, height: hugeSize,
      resolution: 72, selection: null, layers: [documentModule.newLayer({ id: 'huge', name: 'Huge', raster: huge,
        transform: geometry.makeTransform({ x: 0, y: 0 }, { width: hugeSize, height: hugeSize }) })] };
    const history = new historyModule.DocumentHistory(100, Number.POSITIVE_INFINITY);
    const historyStarted = performance.now();
    for (let index = 0; index < 80; index++) {
      history.begin('Rename', documentValue, 'huge');
      documentValue = { ...documentValue, layers: [{ ...documentValue.layers[0]!, name: `Huge ${index}` }] };
      history.end(documentValue, 'huge');
    }
    const historyMs = performance.now() - historyStarted;
    const historyCounters = 'performanceCounters' in history ? history.performanceCounters : null;
    const retainedBytes = history.retainedBytes(documentValue);
    const distribution = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return { median: sorted[Math.floor(sorted.length / 2)]!, p95: sorted[Math.floor(sorted.length * 0.95)]!, max: sorted.at(-1)! };
    };
    const gl = view.gpu!.gl as WebGL2RenderingContext, extension = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    handle.destroy();
    return { renderer, eventMs: distribution(eventMs), frameMs: distribution(frameMs), burst,
      previewCommitMaxDelta, exactApplyMs, longTasks, longTaskMs, historyMs, historyCounters, retainedBytes,
      committedPixel: Array.from(session.activeLayer?.raster?.pixel(1024, 1024) ?? []) };
  });
  console.log(`PERFTOOLS ${JSON.stringify(result)}`);
  expect(result.retainedBytes).toBe(0);
  expect(result.committedPixel[3]).toBe(255);
  if (!process.env.PERFTOOLS_BASELINE) {
    expect(result.burst.workerCreations).toBe(0);
    expect(result.burst.copiedBytes).toBe(0);
    expect(result.previewCommitMaxDelta).not.toBeNull();
    expect(result.previewCommitMaxDelta!).toBeLessThanOrEqual(1);
    expect(result.historyCounters?.scannedTiles).toBeLessThanOrEqual(81 * 4096);
  }
});
