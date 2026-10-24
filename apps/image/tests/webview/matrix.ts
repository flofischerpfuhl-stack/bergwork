import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createElement } from 'react';
import { EditorController } from '../../src/ui/controller';
import { EditorRoot } from '../../src/ui/EditorRoot';
import { installFeatures } from '../../src/app/features';
import { Raster } from '../../src/core/raster';
import { newLayer, type BlendMode } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import * as brush from '../../src/core/brush';

interface Distribution { p95: number; median: number; max: number }

export interface MatrixResult {
  timestamp: string;
  userAgent: string;
  platform: string;
  capabilities: {
    webgl2: boolean;
    renderer: string | null;
    extColorBufferFloat: boolean;
    maxTextureSize: number | null;
    offscreenCanvas: boolean;
    offscreenCanvasInWorker: boolean | null;
    moduleWorker: boolean;
    webgpu: boolean;
    fileSystemAccess: boolean;
    localFontAccess: boolean;
    createImageBitmapColorConversion: {
      supported: boolean;
      identical: boolean | null;
      defaultPixel: number[] | null;
      nonePixel: number[] | null;
      error?: string;
    };
  };
  jpeg46MP: { width: number; height: number; encodedMB: number; openMs: number; error?: string };
  performance: {
    renderer: string;
    panMs: Distribution;
    zoomMs: Distribution;
    panAt200PercentMs: Distribution;
    brushFeedbackMs: Distribution;
    brushFeedbackIrregularMs: Distribution;
    brushFirstSampleMs: number;
    brushFinishMs: { even: number; irregular: number };
    brushCommitMs: { even: number; irregular: number };
    estimatedGpuTextureMB: number;
    error?: string;
  };
  heap: {
    advertisedLimitMB: number | null;
    allocatedMB: number;
    failed: boolean;
    ceilingMB: number;
    error?: string;
  };
}

const emptyDistribution = (): Distribution => ({ p95: 0, median: 0, max: 0 });

function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
}

function distribution(values: readonly number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p95: p95(sorted),
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
}

function waitFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function moduleWorkerProbe(): Promise<{ moduleWorker: boolean; offscreenCanvasInWorker: boolean | null }> {
  return new Promise((resolve) => {
    let worker: Worker;
    try { worker = new Worker(new URL('./module-worker.ts', import.meta.url), { type: 'module' }); } catch {
      resolve({ moduleWorker: false, offscreenCanvasInWorker: null }); return;
    }
    const timer = setTimeout(() => { worker.terminate(); resolve({ moduleWorker: false, offscreenCanvasInWorker: null }); }, 5_000);
    worker.onmessage = (event: MessageEvent<{ moduleWorker?: boolean; offscreenCanvasInWorker?: boolean }>) => {
      clearTimeout(timer); worker.terminate();
      resolve({ moduleWorker: event.data.moduleWorker === true, offscreenCanvasInWorker: event.data.offscreenCanvasInWorker === true });
    };
    worker.onerror = () => { clearTimeout(timer); worker.terminate(); resolve({ moduleWorker: false, offscreenCanvasInWorker: null }); };
  });
}

function readBitmapPixel(bitmap: ImageBitmap): number[] {
  const canvas = Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas 2D is unavailable');
  context.drawImage(bitmap, 0, 0, 1, 1);
  bitmap.close();
  return Array.from(context.getImageData(0, 0, 1, 1).data);
}

async function colorConversionProbe(): Promise<MatrixResult['capabilities']['createImageBitmapColorConversion']> {
  try {
    const canvas = Object.assign(document.createElement('canvas'), { width: 2, height: 1 });
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable');
    context.fillStyle = '#ef4028'; context.fillRect(0, 0, 1, 1);
    context.fillStyle = '#21a45d'; context.fillRect(1, 0, 1, 1);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('JPEG encoding failed')), 'image/jpeg', 0.95));
    const defaultBitmap = await createImageBitmap(blob, { colorSpaceConversion: 'default' });
    const noneBitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
    const defaultPixel = readBitmapPixel(defaultBitmap);
    const nonePixel = readBitmapPixel(noneBitmap);
    return { supported: true, identical: defaultPixel.every((value, i) => value === nonePixel[i]), defaultPixel, nonePixel };
  } catch (error) {
    return { supported: false, identical: null, defaultPixel: null, nonePixel: null, error: String(error) };
  }
}

async function capabilities(): Promise<MatrixResult['capabilities']> {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  let renderer: string | null = null;
  if (gl) {
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  }
  const worker = await moduleWorkerProbe();
  const nav = navigator as Navigator & { gpu?: unknown; storage?: unknown };
  const globals = globalThis as typeof globalThis & { showOpenFilePicker?: unknown; queryLocalFonts?: unknown };
  return {
    webgl2: !!gl,
    renderer,
    extColorBufferFloat: !!gl?.getExtension('EXT_color_buffer_float'),
    maxTextureSize: gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) as number : null,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    offscreenCanvasInWorker: worker.offscreenCanvasInWorker,
    moduleWorker: worker.moduleWorker,
    webgpu: !!nav.gpu,
    fileSystemAccess: typeof globals.showOpenFilePicker === 'function',
    localFontAccess: typeof globals.queryLocalFonts === 'function',
    createImageBitmapColorConversion: await colorConversionProbe(),
  };
}

function testHost() {
  return {
    async chooseImages(): Promise<File[]> { return []; },
    async chooseProject(): Promise<null> { return null; },
    async saveFile(): Promise<void> {},
    reportError(error: { code: string; message: string }): void { console.warn(`[matrix] ${error.code}: ${error.message}`); },
  };
}

async function mountMeasuredEditor(root: HTMLElement): Promise<{ controller: EditorController; reactRoot: Root; destroy(): void }> {
  root.replaceChildren();
  root.style.cssText = 'width:1440px;height:900px;position:relative;overflow:hidden';
  const controller = new EditorController(testHost(), 'en', 'dark');
  installFeatures(controller);
  const container = document.createElement('div');
  container.style.cssText = 'width:100%;height:100%;position:relative;overflow:hidden';
  root.append(container);
  const reactRoot = createRoot(container);
  flushSync(() => reactRoot.render(createElement(EditorRoot, { controller })));
  for (let i = 0; i < 120 && !controller.canvasView?.gpu; i++) await waitFrame();
  if (!controller.canvasView?.gpu) throw new Error(controller.canvasView?.failure ?? 'Editor GPU did not start');
  return {
    controller,
    reactRoot,
    destroy() { reactRoot.unmount(); controller.destroy(); root.replaceChildren(); },
  };
}

async function generatedJpeg(): Promise<Blob> {
  const width = 10_109, height = 4_542;
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable');
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#185f85'); gradient.addColorStop(0.5, '#df9648'); gradient.addColorStop(1, '#25453b');
  context.fillStyle = gradient; context.fillRect(0, 0, width, height);
  context.fillStyle = 'rgba(255,255,255,.15)';
  for (let x = 0; x < width; x += 512) context.fillRect(x, 0, 128, height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('46 MP JPEG encoding failed')), 'image/jpeg', 0.88));
}

async function jpegOpenProbe(root: HTMLElement): Promise<MatrixResult['jpeg46MP']> {
  const result: MatrixResult['jpeg46MP'] = { width: 10_109, height: 4_542, encodedMB: 0, openMs: 0 };
  let mounted: Awaited<ReturnType<typeof mountMeasuredEditor>> | null = null;
  try {
    const blob = await generatedJpeg();
    result.encodedMB = blob.size / 1_048_576;
    mounted = await mountMeasuredEditor(root);
    const start = performance.now();
    const id = await mounted.controller.handle(() => {}).importImage(new File([blob], 'generated-10109x4542.jpg', { type: 'image/jpeg' }), 'generated-10109x4542.jpg');
    result.openMs = performance.now() - start;
    const raster = mounted.controller.session.layer(id)?.raster;
    if (!raster || raster.width !== result.width || raster.height !== result.height) throw new Error('Decoded dimensions do not match 10109×4542');
  } catch (error) { result.error = String(error); }
  finally { mounted?.destroy(); }
  return result;
}

async function performanceProbe(root: HTMLElement): Promise<MatrixResult['performance']> {
  const failure: MatrixResult['performance'] = {
    renderer: 'unavailable', panMs: emptyDistribution(), zoomMs: emptyDistribution(), panAt200PercentMs: emptyDistribution(),
    brushFeedbackMs: emptyDistribution(), brushFeedbackIrregularMs: emptyDistribution(), brushFirstSampleMs: 0,
    brushFinishMs: { even: 0, irregular: 0 }, brushCommitMs: { even: 0, irregular: 0 }, estimatedGpuTextureMB: 853,
  };
  let mounted: Awaited<ReturnType<typeof mountMeasuredEditor>> | null = null;
  try {
    mounted = await mountMeasuredEditor(root);
    const { controller } = mounted;
    const session = controller.session;
    session.createDocument(4096, 4096, false);
    const size = 4096;
    const modes: readonly BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'normal', 'darken', 'lighten', 'normal', 'difference', 'normal'];
    const layers = [];
    for (let layerIndex = 0; layerIndex < 10; layerIndex++) {
      const data = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const offset = (y * size + x) * 4;
          data[offset] = (x * (layerIndex + 1)) & 255;
          data[offset + 1] = (y * (layerIndex + 2)) & 255;
          data[offset + 2] = ((x ^ y) * (layerIndex + 3)) & 255;
          data[offset + 3] = layerIndex === 0 ? 255 : 160 + ((x + y + layerIndex * 37) & 63);
        }
      }
      layers.push(newLayer({
        id: `P${layerIndex}`, name: `Layer ${layerIndex}`, raster: Raster.fromPixels(size, size, 4, data),
        transform: makeTransform({ x: 0, y: 0 }, { width: size, height: size }), blendMode: modes[layerIndex],
      }));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    session.replaceDocument({ ...session.document!, layers });
    session.notify('document');
    const view = controller.canvasView!;
    const documentSize = session.document!;
    for (let i = 0; i < 5; i++) view.renderNow();
    const measure = (frames: number, step: (index: number) => void): Distribution => {
      const values: number[] = [];
      for (let i = 0; i < frames; i++) { step(i); values.push(view.renderNow()); }
      return distribution(values);
    };
    session.fit();
    const panMs = measure(90, (i) => session.viewport.translate(i % 30 < 15 ? 7 : -7, 3 * Math.sin(i / 5)));
    const zoomMs = measure(90, (i) => {
      const center = session.viewport.center;
      session.viewport.setZoom(session.viewport.zoom * (i % 30 < 15 ? 1.04 : 1 / 1.04), center, documentSize);
    });
    session.viewport.setZoom(2, session.viewport.center, documentSize);
    const panAt200PercentMs = measure(60, (i) => session.viewport.translate(i % 20 < 10 ? 11 : -11, 0));
    session.fit();
    session.replaceDocument({ ...session.document!, layers: layers.slice(0, 5) });
    session.notify('document'); view.renderNow();
    session.selectLayer('P4'); session.selectTool('brush');
    brush.setBrushSettings(session, { ...brush.getBrushSettings(session), diameter: 300, hardness: 0 });
    const feedback: number[] = [];
    brush.beginBrushStroke(session, { x: 500, y: 500 });
    let brushFirstSampleMs = 0;
    for (let i = 1; i <= 60; i++) {
      const start = performance.now();
      brush.extendBrushStroke(session, { x: 500 + i * 40, y: 500 + i * 30 });
      view.renderNow(); feedback.push(performance.now() - start);
      if (i === 1) brushFirstSampleMs = feedback[0]!;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    let start = performance.now(); brush.finishBrushStroke(session);
    const finishEven = performance.now() - start; view.renderNow();
    await brush.waitForBrushStroke(session); view.renderNow();
    const commitEven = performance.now() - start;
    const irregular: number[] = [];
    let seed = 5, x = 500, y = 2500;
    const random = () => { seed = (seed * 1_664_525 + 1_013_904_223) >>> 0; return seed / 2 ** 32; };
    brush.beginBrushStroke(session, { x, y });
    for (let i = 1; i <= 60; i++) {
      x += 20 + random() * 40; y += (random() - 0.5) * 50;
      const sampleStart = performance.now(); brush.extendBrushStroke(session, { x, y }); view.renderNow();
      irregular.push(performance.now() - sampleStart);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    start = performance.now(); brush.finishBrushStroke(session);
    const finishIrregular = performance.now() - start; view.renderNow();
    await brush.waitForBrushStroke(session); view.renderNow();
    const commitIrregular = performance.now() - start;
    const gl = view.gpu!.gl;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
      panMs, zoomMs, panAt200PercentMs,
      brushFeedbackMs: distribution(feedback), brushFeedbackIrregularMs: distribution(irregular), brushFirstSampleMs,
      brushFinishMs: { even: finishEven, irregular: finishIrregular },
      brushCommitMs: { even: commitEven, irregular: commitIrregular }, estimatedGpuTextureMB: 853,
    };
  } catch (error) { return { ...failure, error: String(error) }; }
  finally { mounted?.destroy(); }
}

async function heapProbe(ceilingMB = 1024): Promise<MatrixResult['heap']> {
  const memory = performance as Performance & { memory?: { jsHeapSizeLimit?: number } };
  const advertisedLimitMB = memory.memory?.jsHeapSizeLimit ? memory.memory.jsHeapSizeLimit / 1_048_576 : null;
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./heap-worker.ts', import.meta.url), { type: 'module' });
    let progressMB = 0;
    const timer = setTimeout(() => {
      worker.terminate(); resolve({ advertisedLimitMB, allocatedMB: progressMB, failed: true, ceilingMB, error: 'Heap worker timed out or was terminated by the engine' });
    }, 120_000);
    worker.onmessage = (event: MessageEvent<{ progressMB?: number; allocatedMB?: number; failed?: boolean; ceilingMB?: number; error?: string }>) => {
      if (event.data.progressMB !== undefined) { progressMB = event.data.progressMB; return; }
      clearTimeout(timer); worker.terminate();
      resolve({ advertisedLimitMB, allocatedMB: event.data.allocatedMB ?? progressMB, failed: event.data.failed ?? true,
        ceilingMB: event.data.ceilingMB ?? ceilingMB, ...(event.data.error ? { error: event.data.error } : {}) });
    };
    worker.onerror = (event) => {
      clearTimeout(timer); worker.terminate();
      resolve({ advertisedLimitMB, allocatedMB: progressMB, failed: true, ceilingMB, error: event.message || 'Heap worker crashed' });
    };
    worker.postMessage({ ceilingMB });
  });
}

/** Runs the identical A1 measurement sequence in Chromium, WebKitGTK and the Tauri WebView. */
export async function runMatrix(root: HTMLElement, status: (message: string) => void = () => {}): Promise<MatrixResult> {
  status('Measuring WebView capabilities…');
  const capabilityResult = await capabilities();
  status('Generating and opening a 10109×4542 JPEG…');
  const jpeg46MP = await jpegOpenProbe(root);
  status('Running the 4096² × 10-layer editor scenario…');
  const performanceResult = await performanceProbe(root);
  status('Probing JS heap allocation behaviour…');
  const heap = await heapProbe();
  return {
    timestamp: new Date().toISOString(), userAgent: navigator.userAgent, platform: navigator.platform,
    capabilities: capabilityResult, jpeg46MP, performance: performanceResult, heap,
  };
}

export async function startMatrixPage(root: HTMLElement): Promise<MatrixResult> {
  const status = document.createElement('pre');
  status.id = 'matrix-result'; root.replaceChildren(status);
  const result = await runMatrix(root, (message) => { status.textContent = message; console.log(`[matrix] ${message}`); });
  root.style.cssText = '';
  root.replaceChildren(status);
  status.textContent = JSON.stringify(result, null, 2);
  document.title = 'Fernwork WebView Matrix — complete';
  console.log(`FERNWORK_MATRIX_RESULT=${JSON.stringify(result)}`);
  return result;
}
