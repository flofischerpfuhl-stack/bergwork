import { expect, test } from '@playwright/test';

test('moving pixels and regional retouch pointer latency', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?harness=pretouch');
  const result = await page.evaluate(async () => {
    const load = <T,>(path: string): Promise<T> => import(/* @vite-ignore */ path) as Promise<T>;
    const [{ mountEditor }, { createBrowserHost }, { Raster }, documentModule, geometry, selectionOps,
      selectionCommands, retouch, brush, heal, kernelClient] = await Promise.all([
      load<typeof import('../../src/index.ts')>('/src/index.ts'),
      load<typeof import('../../src/platform/browserHost.ts')>('/src/platform/browserHost.ts'),
      load<typeof import('../../src/core/raster.ts')>('/src/core/raster.ts'),
      load<typeof import('../../src/core/document.ts')>('/src/core/document.ts'),
      load<typeof import('../../src/core/geometry.ts')>('/src/core/geometry.ts'),
      load<typeof import('../../src/core/selectionOps.ts')>('/src/core/selectionOps.ts'),
      load<typeof import('../../src/core/selectionCommands.ts')>('/src/core/selectionCommands.ts'),
      load<typeof import('../../src/core/retouch/index.ts')>('/src/core/retouch/index.ts'),
      load<typeof import('../../src/core/brush/index.ts')>('/src/core/brush/index.ts'),
      load<typeof import('../../src/core/heal.ts')>('/src/core/heal.ts'),
      load<typeof import('../../src/workers/kernelClient.ts')>('/src/workers/kernelClient.ts'),
    ]);
    document.body.style.cssText = 'margin:0;width:100vw;height:100vh;overflow:hidden';
    const root = document.body.appendChild(document.createElement('div'));
    root.style.cssText = 'width:100vw;height:100vh';
    const handle = await mountEditor(root, { locale: 'en', profile: 'pro', host: createBrowserHost() });
    const controller = (window as unknown as { __editorForTests: import('../../src/ui/controller.ts').EditorController }).__editorForTests;
    for (const tool of ['marquee', 'blur', 'cloneStamp', 'spotHealing'] as const) await controller.activateTool(tool);
    const session = controller.session, view = controller.canvasView!;
    while (!view.gpu) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const size = 1536, tile = new Uint8Array(256 * 256 * 4);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const offset = (y * 256 + x) * 4;
      tile[offset] = (x * 3 + y) & 255; tile[offset + 1] = (x + y * 5) & 255;
      tile[offset + 2] = x ^ y; tile[offset + 3] = 255;
    }
    const source = new Raster(size, size, 4, new Array((size / 256) ** 2).fill(tile));
    const sourcePixels = source.toPixels();
    const transform = geometry.makeTransform({ x: 0, y: 0 }, { width: size, height: size });
    const layer = documentModule.newLayer({ id: 'pixels', name: 'Pixels', raster: source, transform });
    const baseDocument: import('../../src/core/document.ts').CanvasDocument = {
      id: 'pretouch', width: size, height: size, resolution: 72, selection: null, layers: [layer],
    };
    const install = (selection: import('../../src/core/selection.ts').DocumentSelection | null = null) => {
      session.installProject({ ...baseDocument, selection }, layer.id, null); session.fit(); view.renderNow();
    };
    const distribution = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return { median: sorted[Math.floor(sorted.length / 2)]!, p95: sorted[Math.floor(sorted.length * 0.95)]!, max: sorted.at(-1)! };
    };
    const runMoves = (body: (index: number) => void, count = 12) => {
      const event: number[] = [], frame: number[] = [];
      for (let index = 1; index <= count; index++) {
        const started = performance.now(); body(index); event.push(performance.now() - started);
        frame.push(view.renderNow());
      }
      return { event: distribution(event), frame: distribution(frame) };
    };

    const selection = selectionOps.rectangleSelection({ x: 256, y: 256, width: 896, height: 896 }, baseDocument);
    install(selection);
    selectionCommands.beginPixelMove(session);
    selectionCommands.movePixels(session, 3, 1); view.renderNow();
    const move = runMoves((index) => selectionCommands.movePixels(session, (index + 1) * 9, (index + 1) * 3));
    const previewDocument = selectionCommands.documentWithPixelMovePreview?.(session, session.document!);
    const preview = previewDocument
      ? view.gpu!.readRegion(previewDocument, 200, 200, 1100, 1000)
      : view.readRegion(session.document!, 200, 200, 1100, 1000);
    const moveCommitStart = performance.now(); selectionCommands.finishPixelMove(session);
    const moveCommitMs = performance.now() - moveCommitStart;
    const committed = view.gpu!.readRegion(session.document!, 200, 200, 1100, 1000);
    let moveMaxDelta = 0;
    for (let index = 0; index < preview.length; index++) moveMaxDelta = Math.max(moveMaxDelta,
      Math.abs(preview[index]! - committed[index]!));

    const retouchResults: Record<string, { event: ReturnType<typeof distribution>; frame: ReturnType<typeof distribution>;
      commitEventMs: number; commitMs: number; changed: number; differences: number }> = {};
    const path = Array.from({ length: 13 }, (_, index) => ({ x: 500 + index * 22, y: 700 + Math.sin(index) * 14 }));
    for (const mode of ['smudge', 'liquify', 'blur'] as const) {
      install(); session.tool = 'blur';
      retouch.beginRetouch(session, path[0]!, mode, { diameter: 320, hardness: 0.45, strength: 0.7 });
      const measured = runMoves((index) => { retouch.updateRetouch(session, [path[index]!]); }, 12);
      const started = performance.now(); retouch.commitRetouch(session); const commitEventMs = performance.now() - started;
      await retouch.waitForRetouch?.(session);
      const commitMs = performance.now() - started;
      const output = session.activeLayer!.raster!.toPixels();
      let changed = 0; for (let index = 0; index < output.length; index++) if (output[index] !== sourcePixels[index]) changed++;
      const exact = mode === 'blur'
        ? new retouch.BlurStroke(source, transform, { diameter: 320, hardness: 0.45, strength: 0.7 })
        : new retouch.WarpStroke(source, transform, mode, { diameter: 320, hardness: 0.45, strength: 0.7 });
      exact.addPoints([path[0]!]); for (const point of path.slice(1)) exact.addPoints([point]);
      const expected = exact.finish().toPixels();
      let differences = 0; for (let index = 0; index < output.length; index++) if (output[index] !== expected[index]) differences++;
      retouchResults[mode] = { ...measured, commitEventMs, commitMs, changed, differences };
    }

    install(); session.tool = 'cloneStamp';
    brush.setBrushSettings(session, { ...brush.DEFAULT_CLONE_SETTINGS, diameter: 320, hardness: 0.5, opacity: 1 });
    brush.setCloneSource(session, { x: 300, y: 500 });
    const clonePath = Array.from({ length: 13 }, (_, index) => ({ x: 850 + index * 16, y: 650 + index * 3 }));
    brush.beginBrushStroke(session, clonePath[0]!);
    const clone = runMoves((index) => { brush.extendBrushStroke(session, clonePath[index]!); }, 12);
    const cloneCommitStart = performance.now(); brush.finishBrushStroke(session);
    const cloneCommitEventMs = performance.now() - cloneCommitStart;
    await brush.waitForBrushStroke(session);
    const cloneCommitMs = performance.now() - cloneCommitStart;
    const cloneOutput = session.activeLayer!.raster!, clonePixel = cloneOutput.pixel(900, 660);
    const cloneSettings = { ...brush.DEFAULT_CLONE_SETTINGS, diameter: 320, hardness: 0.5, opacity: 1 };
    const cloneReference = brush.beginStroke({ layer, canvas: { width: size, height: size }, settings: cloneSettings,
      clone: brush.cloneSample(baseDocument, layer, { width: -550, height: -150 }, false) });
    for (const point of clonePath) cloneReference.addPoints([point]);
    const cloneExpected = cloneReference.finish().raster.toPixels(), cloneActual = cloneOutput.toPixels();
    let cloneDifferences = 0;
    for (let index = 0; index < cloneActual.length; index++) if (cloneActual[index] !== cloneExpected[index]) cloneDifferences++;

    install(); session.tool = 'spotHealing';
    const healPath = Array.from({ length: 13 }, (_, index) => ({ x: 620 + index * 13, y: 500 + Math.sin(index) * 8 }));
    heal.beginSpotHealing(session, healPath[0]!, { diameter: 320, hardness: 0.5, opacity: 1, seed: 123 });
    const healing = runMoves((index) => { heal.addSpotHealingPoints(session, healPath[index]!); }, 12);
    const healCommitStart = performance.now(), healPromise = heal.finishSpotHealing(session);
    const healCommitEventMs = performance.now() - healCommitStart;
    await healPromise;
    const healCommitMs = performance.now() - healCommitStart;
    const healed = session.activeLayer!.raster!.toPixels();
    let healChanged = 0; for (let index = 0; index < healed.length; index++) if (healed[index] !== sourcePixels[index]) healChanged++;
    const NativeWorker = window.Worker;
    const referenceKernels = new kernelClient.KernelClient({ useWorker: true });
    window.Worker = undefined as unknown as typeof Worker;
    const healReference = new heal.SpotHealingStroke({ layer, canvas: { width: size, height: size },
      settings: { diameter: 320, hardness: 0.5, opacity: 1, mode: 'contentAware', seed: 123 }, kernels: referenceKernels });
    window.Worker = NativeWorker;
    healReference.addPoints([healPath[0]!]); for (const point of healPath.slice(1)) healReference.addPoints([point]);
    const healExpected = (await healReference.finish()).raster.toPixels();
    referenceKernels.destroy();
    let healDifferences = 0;
    for (let index = 0; index < healed.length; index++) if (healed[index] !== healExpected[index]) healDifferences++;

    const gl = view.gpu!.gl, extension = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    handle.destroy();
    return { renderer, move, moveCommitMs, moveMaxDelta, retouch: retouchResults,
      clone: { ...clone, commitEventMs: cloneCommitEventMs, commitMs: cloneCommitMs, pixel: clonePixel,
        expected: source.pixel(350, 510), differences: cloneDifferences },
      healing: { ...healing, commitEventMs: healCommitEventMs, commitMs: healCommitMs,
        changed: healChanged, differences: healDifferences } };
  });
  console.log(`PRETOUCH_RESULT ${JSON.stringify({ project: info.project.name, ...result })}`);
  expect(result.moveMaxDelta).toBeLessThanOrEqual(1);
  for (const value of Object.values(result.retouch)) { expect(value.changed).toBeGreaterThan(0); expect(value.differences).toBe(0); }
  expect(result.clone.pixel).toEqual(result.clone.expected);
  expect(result.clone.differences).toBe(0);
  expect(result.healing.changed).toBeGreaterThan(0);
  expect(result.healing.differences).toBe(0);
  if (!process.env.PRETOUCH_BASELINE) {
    expect(result.move.event.p95).toBeLessThan(8);
    for (const value of Object.values(result.retouch)) expect(value.event.p95).toBeLessThan(8);
    expect(result.clone.event.p95).toBeLessThan(8);
    expect(result.clone.commitEventMs).toBeLessThan(16);
    expect(result.healing.event.p95).toBeLessThan(8);
  }
});
