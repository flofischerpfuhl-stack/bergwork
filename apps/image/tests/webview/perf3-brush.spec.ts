import { expect, test, type Browser, type Page } from '@playwright/test';

interface ScenarioResult {
  readonly mode: 'paint' | 'erase';
  readonly selection: boolean;
  readonly eventMs: { readonly median: number; readonly p95: number; readonly max: number };
  readonly frameMs: { readonly median: number; readonly p95: number; readonly max: number };
  readonly compositeCalls: number;
  readonly overlayClears: number;
  readonly antsPaints: number;
  readonly textureUploads: number;
  readonly workerResponses: number;
  readonly changedBytes: number;
  readonly outsideSelectionChanges: number;
  readonly committedDifferences: number;
}

interface RunResult {
  readonly isolated: boolean;
  readonly hardwareConcurrency: number;
  readonly renderer: string;
  readonly scenarios: readonly ScenarioResult[];
}

async function measure(page: Page): Promise<RunResult> {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/tests/e2e/a6b-test.html');
  return page.evaluate(async () => {
    const load = <T,>(path: string): Promise<T> => import(/* @vite-ignore */ path) as Promise<T>;
    const [{ mountEditor }, { createBrowserHost }, { Raster }, documentModule, geometry, selectionOps, brush] = await Promise.all([
      load<typeof import('../../src/index.ts')>('/src/index.ts'),
      load<typeof import('../../src/platform/browserHost.ts')>('/src/platform/browserHost.ts'),
      load<typeof import('../../src/core/raster.ts')>('/src/core/raster.ts'),
      load<typeof import('../../src/core/document.ts')>('/src/core/document.ts'),
      load<typeof import('../../src/core/geometry.ts')>('/src/core/geometry.ts'),
      load<typeof import('../../src/core/selectionOps.ts')>('/src/core/selectionOps.ts'),
      load<typeof import('../../src/core/brush/index.ts')>('/src/core/brush/index.ts'),
    ]);
    document.body.style.cssText = 'margin:0;width:100vw;height:100vh;overflow:hidden';
    const root = document.body.appendChild(document.createElement('div'));
    root.style.cssText = 'width:100vw;height:100vh';
    const host = createBrowserHost();
    const handle = await mountEditor(root, { locale: 'en', profile: 'pro', host });
    const controller = (window as unknown as { __editorForTests: import('../../src/ui/controller.ts').EditorController }).__editorForTests;
    await controller.activateTool('lasso');
    await controller.activateTool('brush');
    await handle.newProject({ name: 'PERF3', width: 1600, height: 900 });
    const session = controller.session, view = controller.canvasView!;
    const width = 350, height = 300;
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      pixels[offset] = (x * 3 + y) & 255; pixels[offset + 1] = (x + y * 2) & 255;
      pixels[offset + 2] = (x ^ y) & 255; pixels[offset + 3] = 255;
    }
    const source = Raster.fromPixels(width, height, 4, pixels);
    const transform = geometry.makeTransform({ x: 625, y: 300 }, { width, height });
    const layer = documentModule.newLayer({ id: 'paint', name: 'Paint', raster: source, transform });
    const selection = selectionOps.polygonSelection([
      { x: 650, y: 325 }, { x: 930, y: 340 }, { x: 945, y: 555 }, { x: 700, y: 575 }, { x: 640, y: 460 }, ],
    { width: 1600, height: 900 }, true);
    const points = Array.from({ length: 49 }, (_, i) => ({
      x: 650 + i * 5.7,
      y: 360 + Math.sin(i / 5) * 58 + i * 2.6,
    }));
    const distribution = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return { median: sorted[Math.floor(sorted.length / 2)]!, p95: sorted[Math.floor(sorted.length * 0.95)]!, max: Math.max(...values) };
    };
    const scenarios: ScenarioResult[] = [];
    const contextProto = CanvasRenderingContext2D.prototype;
    const originalClear = contextProto.clearRect;
    const originalDash = contextProto.setLineDash;
    let overlayClears = 0;
    let antsPaints = 0;
    contextProto.clearRect = function (...args: Parameters<CanvasRenderingContext2D['clearRect']>) {
      overlayClears++;
      return originalClear.apply(this, args);
    };
    contextProto.setLineDash = function (segments: number[]) {
      if (segments.length === 2 && segments[0] === 4 && segments[1] === 4) antsPaints++;
      return originalDash.call(this, segments);
    };
    try {
      for (const mode of ['paint', 'erase'] as const) for (const selected of [false, true]) {
        session.replaceDocument({ ...session.document!, layers: [layer], selection: selected ? selection : null });
        session.selectLayer(layer.id);
        const settings = { ...brush.DEFAULT_BRUSH_SETTINGS, mode, diameter: 40, hardness: 1, opacity: 1,
          red: 0.9, green: 0.1, blue: 0.3 };
        brush.setBrushSettings(session, settings);
        view.renderNow();
        const gpu = view.gpu!;
        const originalComposite = gpu.composite.bind(gpu);
        let compositeCalls = 0;
        gpu.composite = ((...args: Parameters<typeof gpu.composite>) => { compositeCalls++; return originalComposite(...args); }) as typeof gpu.composite;
        const uploadsBefore = gpu.performanceCounters.textureUploads;
        const overlaysBefore = overlayClears;
        const antsBefore = antsPaints;
        const eventMs: number[] = [], frameMs: number[] = [];
        brush.beginBrushStroke(session, points[0]!, { settings });
        view.renderNow();
        for (const point of points.slice(1)) {
          const before = performance.now();
          brush.extendBrushStroke(session, point);
          eventMs.push(performance.now() - before);
          frameMs.push(view.renderNow());
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        const reference = brush.beginStroke({ layer, canvas: { width: 1600, height: 900 }, settings,
          selection: selected ? selection : null });
        for (const point of points) reference.addPoints([point]);
        const expected = reference.finish().raster.toPixels();
        brush.finishBrushStroke(session);
        await brush.waitForBrushStroke(session);
        view.renderNow();
        const output = session.activeLayer!.raster!.toPixels();
        let changedBytes = 0, outsideSelectionChanges = 0, committedDifferences = 0;
        for (let index = 0; index < output.length; index++) if (output[index] !== expected[index]) committedDifferences++;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 4;
          let changed = false;
          for (let channel = 0; channel < 4; channel++) if (output[offset + channel] !== pixels[offset + channel]) {
            changedBytes++; changed = true;
          }
          if (changed) {
            const doc = geometry.apply(geometry.pixelToDocument(transform, width, height), { x: x + 0.5, y: y + 0.5 });
            const coverage = selection.mask.pixel(Math.floor(doc.x - selection.x), Math.floor(doc.y - selection.y))[0] ?? 0;
            if (selected && coverage === 0) outsideSelectionChanges++;
          }
        }
        gpu.composite = originalComposite;
        scenarios.push({ mode, selection: selected, eventMs: distribution(eventMs), frameMs: distribution(frameMs),
          compositeCalls, overlayClears: overlayClears - overlaysBefore, antsPaints: antsPaints - antsBefore,
          textureUploads: gpu.performanceCounters.textureUploads - uploadsBefore,
          workerResponses: brush.lastBrushWorkerTiming.length, changedBytes, outsideSelectionChanges,
          committedDifferences });
      }
    } finally {
      contextProto.clearRect = originalClear;
      contextProto.setLineDash = originalDash;
      handle.destroy();
    }
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return { isolated: crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency,
      renderer: gl ? String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : 'none', scenarios };
  });
}

async function contextRun(browser: Browser, isolated: boolean, workers: number): Promise<RunResult> {
  const context = await browser.newContext();
  await context.addInitScript(({ workers }) => {
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { configurable: true, get: () => workers });
  }, { workers });
  if (!isolated) await context.route('**/*', async (route) => {
    const response = await route.fetch();
    const headers = response.headers();
    delete headers['cross-origin-opener-policy']; delete headers['cross-origin-embedder-policy'];
    await route.fulfill({ response, headers });
  });
  const page = await context.newPage();
  try { return await measure(page); } finally { await context.close(); }
}

test('PERF3 eraser and selection product-path profile', async ({ browser }, info) => {
  const matrix: RunResult[] = [];
  for (const isolated of [true, false]) for (const workers of [1, 4]) matrix.push(await contextRun(browser, isolated, workers));
  console.log(`PERF3_RESULT ${JSON.stringify({ project: info.project.name, matrix })}`);
  for (const run of matrix) for (const scenario of run.scenarios) {
    expect(scenario.changedBytes).toBeGreaterThan(0);
    expect(scenario.outsideSelectionChanges).toBe(0);
    expect(scenario.committedDifferences).toBe(0);
    expect(scenario.compositeCalls).toBeGreaterThanOrEqual(50);
    expect(scenario.compositeCalls).toBeLessThanOrEqual(58);
  }
});
