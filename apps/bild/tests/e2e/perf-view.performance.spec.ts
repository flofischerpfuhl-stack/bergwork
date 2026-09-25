import { expect, test } from '@playwright/test';
import { mountForTest } from './helpers';

type Timing = { median: number; p95: number; max: number };

test('canvas compositor audit: uploads, unchanged frames, pan and pixels', async ({ page }) => {
  test.setTimeout(300_000);
  await mountForTest(page);
  const result = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const [{ GpuCompositor, DEFAULT_HOOKS }, { Raster, TILE }, { newLayer }, { makeTransform }, { compositeView }] = await Promise.all([
      load('/src/render/gpuCompositor.ts'), load('/src/core/raster.ts'), load('/src/core/document.ts'),
      load('/src/core/geometry.ts'), load('/src/core/composite.ts'),
    ]);
    const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)]!;
    const timing = (values: number[]): Timing => {
      const sorted = [...values].sort((a, b) => a - b);
      return { median: sorted[Math.floor(sorted.length / 2)]!, p95: p95(values), max: sorted.at(-1)! };
    };
    const finish = (gpu: any, render: () => any): { target: any; ms: number } => {
      const start = performance.now(), target = render(); gpu.gl.finish();
      return { target, ms: performance.now() - start };
    };

    // One shared tile represents a uniform 8192² source without making the benchmark's JS allocation
    // dominate the upload measurement. Every tile is logically occupied, so viewport culling is exercised.
    const size = 8192, cols = Math.ceil(size / TILE), rows = Math.ceil(size / TILE);
    const tile = new Uint8Array(TILE * TILE * 4);
    for (let i = 0; i < tile.length; i += 4) {
      tile[i] = 31; tile[i + 1] = 97; tile[i + 2] = 181; tile[i + 3] = 255;
    }
    const large = new Raster(size, size, 4, new Array(cols * rows).fill(tile));
    const largeLayer = newLayer({ id: 'large', name: 'Large', raster: large,
      transform: makeTransform({ x: 0, y: 0 }, { width: size, height: size }) });
    const largeDocument = { id: 'large-document', width: size, height: size, resolution: 72,
      layers: [largeLayer], selection: null };
    const uploadCanvas = document.createElement('canvas'); document.body.append(uploadCanvas);
    const uploadGpu = await GpuCompositor.create(uploadCanvas, 800, 600);
    uploadGpu.configureResidency({ textureByteBudget: 100 * 1024 * 1024 });
    const uploadView = { width: 800, height: 600, viewToDoc: { a: 1, b: 0, c: 0, d: 1, tx: 500, ty: 500 },
      scale: 1, snap: false, cache: true };
    const uploadBefore = uploadGpu.performanceCounters;
    let measured = finish(uploadGpu, () => uploadGpu.composite(largeDocument, uploadView));
    const uploadColdMs = measured.ms;
    uploadGpu.releaseTarget(measured.target);
    const uploadAfter = uploadGpu.performanceCounters;
    const uploadPixels = uploadGpu.textureBytes;
    const uploadReadback = uploadGpu.readView(largeDocument, uploadView.width, uploadView.height,
      uploadView.viewToDoc, uploadView.scale);
    const uploadSample = [...uploadReadback.slice((300 * uploadView.width + 400) * 4,
      (300 * uploadView.width + 400) * 4 + 4)];
    const movedView = { ...uploadView, viewToDoc: { ...uploadView.viewToDoc, tx: 5_000, ty: 5_000 } };
    measured = finish(uploadGpu, () => uploadGpu.composite(largeDocument, movedView));
    uploadGpu.releaseTarget(measured.target);
    const movedReadback = uploadGpu.readView(largeDocument, movedView.width, movedView.height,
      movedView.viewToDoc, movedView.scale);
    const movedTextureMiB = uploadGpu.textureBytes / 1048576;
    const movedSample = [...movedReadback.slice((300 * movedView.width + 400) * 4,
      (300 * movedView.width + 400) * 4 + 4)];
    uploadGpu.destroy(); uploadCanvas.remove();

    // 46,137,344 unique resident pixels: unlike the shared-tile culling fixture above, this makes
    // the LOD build perform the work and retain the bytes of a target-sized imported photograph.
    const lodWidth = 8192, lodHeight = 5632, lodCols = lodWidth / TILE, lodRows = lodHeight / TILE;
    const uniqueTiles = Array.from({ length: lodCols * lodRows }, (_, index) => {
      const unique = tile.slice();
      unique[index % (unique.length / 4) * 4] = 31;
      return unique;
    });
    const lodRaster = new Raster(lodWidth, lodHeight, 4, uniqueTiles);
    const fullLodLayer = newLayer({ id: 'lod-full', name: 'LOD full', raster: lodRaster,
      transform: makeTransform({ x: 0, y: 0 }, { width: lodWidth, height: lodHeight }, { sampling: 'Nearest' }) });
    const fullLodDocument = { id: 'lod-full-document', width: lodWidth, height: lodHeight, resolution: 72,
      layers: [fullLodLayer], selection: null };
    const lodView = { width: 640, height: 440,
      viewToDoc: { a: 12.8, b: 0, c: 0, d: 12.8, tx: 0, ty: 0 }, scale: 1 / 12.8, snap: false, cache: true };
    const fullLodCanvas = document.createElement('canvas'); document.body.append(fullLodCanvas);
    const fullLodGpu = await GpuCompositor.create(fullLodCanvas, lodView.width, lodView.height);
    let fullLodMeasured = finish(fullLodGpu, () => fullLodGpu.composite(fullLodDocument, lodView));
    const fullLodMs = fullLodMeasured.ms, fullLodTextureMiB = fullLodGpu.textureBytes / 1048576;
    fullLodGpu.releaseTarget(fullLodMeasured.target); fullLodGpu.destroy(); fullLodCanvas.remove();

    const lodLayer = newLayer({ id: 'lod', name: 'LOD', raster: lodRaster,
      transform: makeTransform({ x: 0, y: 0 }, { width: lodWidth, height: lodHeight }) });
    const lodDocument = { id: 'lod-document', width: lodWidth, height: lodHeight, resolution: 72,
      layers: [lodLayer], selection: null };
    const lodCanvas = document.createElement('canvas'); document.body.append(lodCanvas);
    const lodGpu = await GpuCompositor.create(lodCanvas, 640, 480);
    const lodBefore = lodGpu.performanceCounters;
    measured = finish(lodGpu, () => lodGpu.composite(lodDocument, lodView));
    const lodColdMs = measured.ms;
    lodGpu.releaseTarget(measured.target);
    const lodAfter = lodGpu.performanceCounters;
    const lodTextureMiB = lodGpu.textureBytes / 1048576;
    const lodReadback = lodGpu.readView(lodDocument, lodView.width, lodView.height,
      lodView.viewToDoc, lodView.scale);
    const lodSample = [...lodReadback.slice((200 * lodView.width + 300) * 4,
      (200 * lodView.width + 300) * 4 + 4)];
    lodGpu.destroy(); lodCanvas.remove();

    // Independent exact CPU oracle for resident LOD pixels (M14: not derived from GPU output).
    const oracleSize = 512, oraclePixels = new Uint8Array(oracleSize * oracleSize * 4);
    for (let y = 0; y < oracleSize; y++) for (let x = 0; x < oracleSize; x++) {
      const at = (y * oracleSize + x) * 4;
      oraclePixels[at] = (x * 13 + y * 3) & 255;
      oraclePixels[at + 1] = (x * 5 + y * 11) & 255;
      oraclePixels[at + 2] = (x ^ (y * 7)) & 255;
      oraclePixels[at + 3] = 64 + ((x * 17 + y * 19) % 192);
    }
    const oracleRaster = Raster.fromPixels(oracleSize, oracleSize, 4, oraclePixels);
    const oracleLayer = newLayer({ id: 'oracle', name: 'Oracle', raster: oracleRaster,
      transform: makeTransform({ x: 0, y: 0 }, { width: oracleSize, height: oracleSize }) });
    const oracleDocument = { id: 'oracle-document', width: oracleSize, height: oracleSize, resolution: 72,
      layers: [oracleLayer], selection: null };
    const oracleView = { a: 8, b: 0, c: 0, d: 8, tx: 0, ty: 0 };
    const oracleCanvas = document.createElement('canvas'); document.body.append(oracleCanvas);
    const oracleGpu = await GpuCompositor.create(oracleCanvas, 64, 64);
    const lodPixels = oracleGpu.readView(oracleDocument, 64, 64, oracleView, 0.125);
    const cpuPixels = compositeView(oracleDocument, 64, 64, oracleView).rgba as Uint8Array;
    let lodCpuMaxDelta = 0;
    for (let i = 0; i < lodPixels.length; i++) lodCpuMaxDelta = Math.max(lodCpuMaxDelta,
      Math.abs(lodPixels[i]! - cpuPixels[i]!));
    oracleGpu.destroy(); oracleCanvas.remove();

    const sceneSize = 1024, sceneTile = new Uint8Array(TILE * TILE * 4);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const at = (y * TILE + x) * 4;
      sceneTile[at] = x & 255; sceneTile[at + 1] = y & 255; sceneTile[at + 2] = (x ^ y) & 255;
      sceneTile[at + 3] = 176;
    }
    const sceneRaster = new Raster(sceneSize, sceneSize, 4, new Array(16).fill(sceneTile));
    const transform = makeTransform({ x: 0, y: 0 }, { width: sceneSize, height: sceneSize });
    const modes = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'softLight'];
    const layers = Array.from({ length: 16 }, (_, index) => newLayer({ id: `layer-${index}`, name: `Layer ${index}`,
      raster: sceneRaster, transform, opacity: 0.72, blendMode: modes[index % modes.length] }));
    const scene = { id: 'frame-scene', width: sceneSize, height: sceneSize, resolution: 72, layers, selection: null };
    const canvas = document.createElement('canvas'); document.body.append(canvas);
    const gpu = await GpuCompositor.create(canvas, 800, 600);
    const baseView = { width: 800, height: 600, viewToDoc: { a: 1, b: 0, c: 0, d: 1, tx: 112, ty: 212 },
      scale: 1, snap: false, cache: true };
    measured = finish(gpu, () => gpu.composite(scene, baseView)); gpu.releaseTarget(measured.target);
    const readTarget = (target: any): Uint8Array | Float32Array => gpu.floatTargets
      ? (gpu as any).readFloatPixels(target, baseView.width, baseView.height)
      : gpu.readPixels(target, baseView.width, baseView.height);
    const reference = readTarget(measured.target);
    const unchanged: number[] = [];
    for (let i = 0; i < 24; i++) {
      measured = finish(gpu, () => gpu.composite(scene, baseView)); unchanged.push(measured.ms); gpu.releaseTarget(measured.target);
    }
    const repeated = readTarget(measured.target);
    let maximumPixelDelta = 0;
    for (let i = 0; i < reference.length; i++) maximumPixelDelta = Math.max(maximumPixelDelta,
      Math.abs(reference[i]! - repeated[i]!));
    const alternateTile = sceneTile.slice();
    for (let i = 0; i < alternateTile.length; i += 4) {
      alternateTile[i] = 240; alternateTile[i + 1] = 16; alternateTile[i + 2] = 24;
    }
    const alternate = new Raster(sceneSize, sceneSize, 4, new Array(16).fill(alternateTile));
    const overrideHooks = { ...DEFAULT_HOOKS,
      raster: (layer: any) => layer.id === 'layer-15' ? alternate : layer.raster };
    const fullBeforeOverride = gpu.performanceCounters.fullComposites;
    measured = finish(gpu, () => gpu.composite(scene, baseView, overrideHooks));
    gpu.releaseTarget(measured.target);
    const changed = readTarget(measured.target);
    let changedPixelCount = 0;
    for (let i = 0; i < reference.length; i += 4) {
      if (reference[i] !== changed[i] || reference[i + 1] !== changed[i + 1] || reference[i + 2] !== changed[i + 2]) {
        changedPixelCount++;
      }
    }
    const fullAfterOverride = gpu.performanceCounters.fullComposites;
    measured = finish(gpu, () => gpu.composite(scene, baseView, overrideHooks));
    gpu.releaseTarget(measured.target);
    const hitAfterOverride = gpu.performanceCounters.unchangedFrameHits;
    let swapped = true;
    const hydratedTile = new Uint8Array(TILE * TILE * 4);
    for (let i = 0; i < hydratedTile.length; i += 4) { hydratedTile[i + 2] = 255; hydratedTile[i + 3] = 255; }
    const storage = { tiles: [null] as Array<Uint8Array | null>,
      residency: () => swapped ? 'swapped' as const : 'resident' as const };
    const hydratingRaster = new Raster(TILE, TILE, 4, storage);
    const reducedRed = new Uint8Array(32 * 32 * 4);
    for (let i = 0; i < reducedRed.length; i += 4) { reducedRed[i] = 255; reducedRed[i + 3] = 255; }
    hydratingRaster.installReducedCopy(Raster.fromPixels(32, 32, 4, reducedRed));
    const hydratingLayer = newLayer({ id: 'hydrating', name: 'Hydrating', raster: hydratingRaster,
      transform: makeTransform({ x: 0, y: 0 }, { width: TILE, height: TILE }) });
    const hydratingDocument = { id: 'hydrating-document', width: TILE, height: TILE, resolution: 72,
      layers: [hydratingLayer], selection: null };
    const hydratingView = { width: 1, height: 1, viewToDoc: { a: 1, b: 0, c: 0, d: 1, tx: 8, ty: 8 },
      scale: 1, snap: false, cache: true };
    measured = finish(gpu, () => gpu.composite(hydratingDocument, hydratingView));
    gpu.releaseTarget(measured.target);
    const beforeHydration = [...(gpu as any).readFloatPixels(measured.target, 1, 1) as Float32Array];
    storage.tiles[0] = hydratedTile; swapped = false;
    measured = finish(gpu, () => gpu.composite(hydratingDocument, hydratingView));
    gpu.releaseTarget(measured.target);
    const afterHydration = [...(gpu as any).readFloatPixels(measured.target, 1, 1) as Float32Array];
    const pan: number[] = [];
    for (let i = 0; i < 30; i++) {
      const view = { ...baseView, viewToDoc: { ...baseView.viewToDoc, tx: baseView.viewToDoc.tx + i * 3 } };
      measured = finish(gpu, () => gpu.composite(scene, view)); pan.push(measured.ms); gpu.releaseTarget(measured.target);
    }
    const finalPanView = { ...baseView, viewToDoc: { ...baseView.viewToDoc, tx: baseView.viewToDoc.tx + 29 * 3 } };
    const reprojected = readTarget(measured.target);
    const exactPan = finish(gpu, () => gpu.composite(scene, { ...finalPanView, cache: false }));
    const exactPanPixels = readTarget(exactPan.target); gpu.releaseTarget(exactPan.target);
    let panMaxDelta = 0;
    for (let i = 0; i < reprojected.length; i++) panMaxDelta = Math.max(panMaxDelta,
      Math.abs(reprojected[i]! - exactPanPixels[i]!));
    const counters = gpu.performanceCounters;
    const gl = gpu.gl as WebGL2RenderingContext, ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gpu.destroy(); canvas.remove();
    const editor = (window as any).__editorForTests, handle = (window as any).__handle;
    await handle.newProject({ name: 'View counters', width: 64, height: 64 });
    const canvasView = editor.canvasView;
    canvasView.renderNow();
    const canvasBefore = { view: canvasView.performanceCounters, gpu: canvasView.gpu.performanceCounters };
    editor.session.notify('ui');
    canvasView.renderNow();
    const canvasAfter = { view: canvasView.performanceCounters, gpu: canvasView.gpu.performanceCounters };
    const screenCanvas = canvasView.element.querySelector('canvas') as HTMLCanvasElement;
    const screenPixels = () => {
      const gl = canvasView.gpu.gl as WebGL2RenderingContext;
      const pixels = new Uint8Array(screenCanvas.width * screenCanvas.height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, screenCanvas.width, screenCanvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    const idleBefore = screenPixels();
    canvasView.element.dispatchEvent(new WheelEvent('wheel', { deltaX: 0, deltaY: 0, bubbles: true, cancelable: true }));
    canvasView.renderNow();
    const interaction = { width: screenCanvas.width, counters: canvasView.performanceCounters };
    await new Promise((resolve) => setTimeout(resolve, 150));
    canvasView.renderNow();
    const idleAfter = screenPixels();
    let idleRestoreMaxDelta = 0;
    for (let i = 0; i < idleBefore.length; i++) idleRestoreMaxDelta = Math.max(idleRestoreMaxDelta,
      Math.abs(idleBefore[i]! - idleAfter[i]!));
    const idle = { width: screenCanvas.width, counters: canvasView.performanceCounters,
      restoreMaxDelta: idleRestoreMaxDelta };
    return {
      renderer,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      upload: { coldMs: uploadColdMs, calls: uploadAfter.textureUploads - uploadBefore.textureUploads,
        textureMiB: uploadPixels / 1048576, movedTextureMiB, sample: uploadSample, movedSample },
      lod: { fullMs: fullLodMs, fullTextureMiB: fullLodTextureMiB,
        coldMs: lodColdMs, textureMiB: lodTextureMiB, sample: lodSample,
        builds: lodAfter.residentLodBuilds - lodBefore.residentLodBuilds,
        sourcePixels: lodAfter.residentLodSourcePixels - lodBefore.residentLodSourcePixels,
        cpuMaxDelta: lodCpuMaxDelta },
      unchanged: timing(unchanged), pan: timing(pan), panMaxDelta, counters, maximumPixelDelta, changedPixelCount,
      fullCompositeOnOverride: fullAfterOverride - fullBeforeOverride, hitAfterOverride,
      hydration: { before: beforeHydration, after: afterHydration },
      canvasCounters: { before: canvasBefore, after: canvasAfter, interaction, idle },
    };
  });
  console.log(`PERFVIEW ${JSON.stringify(result)}`);
  expect(result.maximumPixelDelta).toBe(0);
  expect(result.upload.sample).toEqual([31, 97, 181, 255]);
  expect(result.upload.movedSample).toEqual(result.upload.sample);
  expect(result.lod.sample).toEqual(result.upload.sample);
  expect(result.lod.textureMiB).toBeLessThan(10);
  expect(result.lod.textureMiB).toBeLessThan(result.lod.fullTextureMiB / 16);
  expect(result.lod.builds).toBe(1);
  expect(result.lod.cpuMaxDelta).toBeLessThanOrEqual(1);
  expect(result.upload.movedTextureMiB).toBeLessThanOrEqual(100);
  expect(result.changedPixelCount).toBeGreaterThan(0);
  expect(result.fullCompositeOnOverride).toBe(1);
  expect(result.panMaxDelta).toBeLessThanOrEqual(1 / 255);
  expect(result.hydration.before[0]).toBeGreaterThan(0.9);
  expect(result.hydration.after[2]).toBeGreaterThan(0.9);
  expect(result.canvasCounters.after.gpu.unchangedFrameHits
    - result.canvasCounters.before.gpu.unchangedFrameHits).toBe(1);
  expect(result.canvasCounters.after.view.frames - result.canvasCounters.before.view.frames).toBe(1);
  expect(result.upload.calls).toBeGreaterThan(0);
  expect(result.counters.panReprojections).toBeGreaterThan(0);
  expect(result.canvasCounters.idle.restoreMaxDelta).toBe(0);
  expect(result.canvasCounters.idle.counters.lastRenderScale).toBe(result.viewport.dpr);
  if (result.viewport.dpr > 1) {
    expect(result.canvasCounters.interaction.width).toBeLessThan(result.canvasCounters.idle.width);
    expect(result.canvasCounters.interaction.counters.lastRenderScale).toBe(1);
  }
  expect(result.unchanged.p95).toBeGreaterThanOrEqual(0);
});
