import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { installFeatures } from '../../src/app/features';
import * as brush from '../../src/core/brush';
import { newLayer, type BlendMode } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { EditorRoot } from '../../src/ui/EditorRoot';
import { EditorController } from '../../src/ui/controller';
import { GpuCompositor } from '../../src/render/gpuCompositor';

interface Distribution { p95: number; median: number; max: number }
interface FrameSplit {
  totalMs: Distribution;
  jsCompositingMs: Distribution;
  webglSubmissionMs: Distribution;
  glFinishMs: Distribution;
  presentationProxyMs: Distribution;
  glCallsMedian: number;
}

interface RuntimeSettings {
  hardwareAccelerationPolicy: string;
  accelerated2dCanvas: boolean;
  disableDmabufRenderer: boolean;
  forceDmabufShm: boolean;
  showDamage: boolean;
  renderOnly: boolean;
  runLabel: string;
}

interface NativeDecodeReport {
  width: number;
  height: number;
  tileCount: number;
  encodedBytes: number;
  rgbaBytes: number;
  fileReadMs: number;
  decodeAndYcbcrMs: number;
  rgbToRgbaMs: number;
  tileCopyMs: number;
  binaryChannelMs: number;
  nativeTotalMs: number;
}

interface PresentedFrames {
  samples: number;
  presentationTimestamps: number;
  intervalMs: Distribution;
  droppedFrames: number;
  refreshIntervalMs: number;
  source: string;
}

interface BatchDecodeReport {
  width: number;
  height: number;
  encodedBytes: number;
  fileReadMs: number;
  decodeAndYcbcrMs: number;
  rgbToRgbaMs: number;
  ipcToResponseMs: number;
  rasterTilingMs: number;
  totalToRasterMs: number;
  firstUploadMs: number;
  totalToFirstFrameMs: number;
}

interface JpegBatchResult {
  encodedMB: number;
  browser: Record<string, number>;
  native: BatchDecodeReport;
  parity: { comparedChannels: number; maximumChannelDelta: number; meanChannelDifference: number };
}

interface A6Tauri {
  core: {
    invoke<T>(command: string, args?: Record<string, unknown> | Uint8Array): Promise<T>;
    Channel: new <T>() => { onmessage: (message: T) => void };
  };
  fs: { readFile(path: string): Promise<Uint8Array> };
}

function tauri(): A6Tauri {
  return (window as unknown as { __TAURI__: A6Tauri }).__TAURI__;
}

export interface A6SpikeResult {
  timestamp: string;
  userAgent: string;
  settings: RuntimeSettings;
  viewport: { width: number; height: number; dpr: number };
  jpeg46MP: { compressible: JpegBatchResult; noisy: JpegBatchResult } | null;
  rendering: {
    renderer: string;
    canvasSizes: Array<{
      requested: { width: number; height: number };
      actual: { cssWidth: number; cssHeight: number; backingWidth: number; backingHeight: number; dpr: number };
      zoomUninstrumentedMs: Distribution;
      zoomSplit: FrameSplit;
      presented: PresentedFrames;
    }>;
    brushUninstrumentedMs: Distribution;
    brushSplit: FrameSplit;
    brushPresented: PresentedFrames;
    captures: { window: { zoom: string; brush: string }; canvas: { zoom: string; brush: string } };
    notes: string[];
    error?: string;
  };
}

const GL_SUBMISSION_METHODS = [
  'activeTexture', 'attachShader', 'bindBuffer', 'bindBufferBase', 'bindFramebuffer', 'bindRenderbuffer',
  'bindTexture', 'bindVertexArray', 'blendEquation', 'blendEquationSeparate', 'blendFunc',
  'blendFuncSeparate', 'bufferData', 'bufferSubData', 'clear', 'clearColor', 'colorMask', 'compileShader',
  'createBuffer', 'createFramebuffer', 'createProgram', 'createRenderbuffer', 'createShader', 'createTexture',
  'createVertexArray', 'deleteBuffer', 'deleteFramebuffer', 'deleteProgram', 'deleteRenderbuffer',
  'deleteShader', 'deleteTexture', 'deleteVertexArray', 'disable', 'disableVertexAttribArray', 'drawArrays',
  'drawArraysInstanced', 'drawElements', 'drawElementsInstanced', 'enable', 'enableVertexAttribArray',
  'framebufferRenderbuffer', 'framebufferTexture2D', 'generateMipmap', 'linkProgram', 'pixelStorei',
  'renderbufferStorage', 'scissor', 'shaderSource', 'texImage2D', 'texParameterf', 'texParameteri',
  'texStorage2D', 'texSubImage2D', 'uniform1f', 'uniform1fv', 'uniform1i', 'uniform1iv', 'uniform2f',
  'uniform2fv', 'uniform2i', 'uniform3f', 'uniform3fv', 'uniform4f', 'uniform4fv', 'uniformMatrix3fv',
  'uniformMatrix4fv', 'useProgram', 'vertexAttribPointer', 'viewport',
] as const;

export function measurementDistribution(values: readonly number[]): Distribution {
  if (!values.length) return { p95: 0, median: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil((sorted.length - 1) * fraction))]!;
  return { p95: at(0.95), median: at(0.5), max: sorted.at(-1)! };
}

function waitFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function host() {
  return {
    async chooseImages(): Promise<File[]> { return []; },
    async chooseProject(): Promise<null> { return null; },
    async saveFile(): Promise<void> {},
    reportError(error: { code: string; message: string }): void { console.warn(`[a6] ${error.code}: ${error.message}`); },
  };
}

async function mount(root: HTMLElement): Promise<{ controller: EditorController; reactRoot: Root; destroy(): void }> {
  root.replaceChildren();
  root.style.cssText = 'width:1440px;height:900px;position:relative;overflow:hidden';
  const controller = new EditorController(host(), 'en', 'dark');
  installFeatures(controller);
  const container = document.createElement('div');
  container.style.cssText = 'width:100%;height:100%;position:relative;overflow:hidden';
  root.append(container);
  const reactRoot = createRoot(container);
  flushSync(() => reactRoot.render(createElement(EditorRoot, { controller })));
  for (let frame = 0; frame < 180 && !controller.canvasView?.gpu; frame++) await waitFrame();
  if (!controller.canvasView?.gpu) throw new Error(controller.canvasView?.failure ?? 'WebGL compositor did not start');
  return { controller, reactRoot, destroy() { reactRoot.unmount(); controller.destroy(); root.replaceChildren(); } };
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
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob)
    : reject(new Error('46 MP JPEG encoding failed')), 'image/jpeg', 0.88));
}

async function noisyJpeg(): Promise<Blob> {
  const width = 10_109, height = 4_542;
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable');
  let seed = 0x6d2b79f5;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const stripHeight = 32;
  for (let top = 0; top < height; top += stripHeight) {
    const rows = Math.min(stripHeight, height - top);
    const image = context.createImageData(width, rows);
    const data = image.data;
    for (let y = 0; y < rows; y++) for (let x = 0; x < width; x++) {
      const value = random(), at = (y * width + x) * 4;
      const sky = Math.round(45 + 125 * (top + y) / height);
      data[at] = Math.min(255, sky + (value & 63));
      data[at + 1] = Math.min(255, 55 + ((value >>> 8) & 127) + (x % 701 < 350 ? 22 : 0));
      data[at + 2] = Math.min(255, 35 + ((value >>> 16) & 127));
      data[at + 3] = 255;
    }
    context.putImageData(image, 0, top);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob)
    : reject(new Error('noisy 46 MP JPEG encoding failed')), 'image/jpeg', 0.9));
}

async function firstUpload(root: HTMLElement, raster: Raster, status: (message: string) => void): Promise<number> {
  status('First upload: mounting WebGL compositor…');
  const mounted = await mount(root);
  try {
    status('First upload: creating document…');
    const session = mounted.controller.session;
    session.createDocument(raster.width, raster.height, false);
    session.replaceDocument({ ...session.document!, layers: [newLayer({
      id: 'JPEG', name: 'JPEG', raster,
      transform: makeTransform({ x: 0, y: 0 }, { width: raster.width, height: raster.height }),
    })] });
    session.fit(); session.notify('document');
    status('First upload: submitting raster and waiting for gl.finish…');
    const result = mounted.controller.canvasView!.renderNow();
    status('First upload: gl.finish complete.');
    return result;
  } finally { mounted.destroy(); }
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value) && value.every((item) => typeof item === 'number')) return Uint8Array.from(value);
  throw new TypeError(`Unexpected binary channel payload: ${Object.prototype.toString.call(value)}`);
}

async function jpegBatchFixture(root: HTMLElement, status: (message: string) => void, label: string,
  blob: Blob): Promise<JpegBatchResult> {
  status(`${label} 46 MP JPEG generated; storing native fixture…`);
  const fixtureBytes = new Uint8Array(await blob.arrayBuffer());
  const path = await tauri().core.invoke<string>('a6_store_jpeg', fixtureBytes);

  status('Reading 46 MP JPEG through the Tauri filesystem channel…');
  let stage = performance.now();
  const encoded = await tauri().fs.readFile(path);
  const fileReadMs = performance.now() - stage;
  stage = performance.now();
  const bitmap = await createImageBitmap(new Blob([encoded as BlobPart], { type: 'image/jpeg' }), {
    imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'none',
  });
  const decodeMs = performance.now() - stage;
  status('Browser JPEG decoded; converting to RGBA…');
  stage = performance.now();
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  if (!context) throw new Error('Offscreen 2D context unavailable');
  context.drawImage(bitmap, 0, 0);
  const rgba = new Uint8Array(context.getImageData(0, 0, bitmap.width, bitmap.height).data);
  bitmap.close();
  const colorConversionAndReadbackMs = performance.now() - stage;
  status('Browser RGBA ready; tiling raster…');
  stage = performance.now();
  const browserRaster = Raster.fromPixels(canvas.width, canvas.height, 4, rgba);
  const browserRasterTilingMs = performance.now() - stage;
  const browserTotalToRasterMs = fileReadMs + decodeMs + colorConversionAndReadbackMs + browserRasterTilingMs;
  status('Browser raster ready; measuring first GPU upload…');
  const browserFirstUploadMs = await firstUpload(root, browserRaster, status);

  status('Browser upload complete; decoding one native binary response…');
  const nativeStart = performance.now();
  const response = toBytes(await tauri().core.invoke<unknown>('a6_decode_jpeg_batch', { path }));
  const ipcToResponseMs = performance.now() - nativeStart;
  const header = new DataView(response.buffer, response.byteOffset, 40);
  if (String.fromCharCode(...response.subarray(0, 4)) !== 'FWJ1') throw new Error('invalid native JPEG batch header');
  const width = header.getUint32(4, true), height = header.getUint32(8, true), encodedBytes = header.getUint32(12, true);
  const micros = (offset: number) => Number(header.getBigUint64(offset, true)) / 1_000;
  if (response.byteLength !== 40 + width * height * 4) throw new Error('native JPEG batch has the wrong byte count');
  stage = performance.now();
  const nativeRaster = Raster.fromPixels(width, height, 4, response.subarray(40));
  const nativeRasterTilingMs = performance.now() - stage;
  const totalToRasterMs = performance.now() - nativeStart;
  const nativeFirstUploadMs = await firstUpload(root, nativeRaster, status);
  status('Native raster upload complete; checking pixel parity…');

  let maximumChannelDelta = 0, difference = 0, comparedChannels = 0;
  for (let tileIndex = 0; tileIndex < browserRaster.tiles.length; tileIndex++) {
    const browserTile = browserRaster.tiles[tileIndex], nativeTile = nativeRaster.tiles[tileIndex];
    if (!browserTile || !nativeTile) {
      if (browserTile !== nativeTile) maximumChannelDelta = 255;
      continue;
    }
    for (let channel = 0; channel < browserTile.length; channel++) {
      const delta = Math.abs(browserTile[channel]! - nativeTile[channel]!);
      maximumChannelDelta = Math.max(maximumChannelDelta, delta); difference += delta; comparedChannels++;
    }
  }
  return {
    encodedMB: blob.size / 1_048_576,
    browser: {
      fileReadMs, decodeMs, colorConversionAndReadbackMs, rasterTilingMs: browserRasterTilingMs,
      firstUploadMs: browserFirstUploadMs,
      totalToRasterMs: browserTotalToRasterMs,
      totalToFirstFrameMs: browserTotalToRasterMs + browserFirstUploadMs,
    },
    native: { width, height, encodedBytes, fileReadMs: micros(16), decodeAndYcbcrMs: micros(24),
      rgbToRgbaMs: micros(32), ipcToResponseMs, rasterTilingMs: nativeRasterTilingMs,
      totalToRasterMs, firstUploadMs: nativeFirstUploadMs,
      totalToFirstFrameMs: totalToRasterMs + nativeFirstUploadMs },
    parity: { comparedChannels, maximumChannelDelta,
      meanChannelDifference: comparedChannels ? difference / comparedChannels : maximumChannelDelta },
  };
}

async function jpegProbe(root: HTMLElement, status: (message: string) => void): Promise<NonNullable<A6SpikeResult['jpeg46MP']>> {
  const compressible = await jpegBatchFixture(root, status, 'compressible', await generatedJpeg());
  const noisy = await jpegBatchFixture(root, status, 'noisy camera-like', await noisyJpeg());
  return { compressible, noisy };
}

interface GlCounters { submissionMs: number; finishMs: number; calls: number }

function instrumentGl(gl: WebGL2RenderingContext, counters: GlCounters): () => void {
  const target = gl as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  for (const name of GL_SUBMISSION_METHODS) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    originals.set(name, original);
    target[name] = (...args: unknown[]) => {
      const start = performance.now();
      const result = Reflect.apply(original, gl, args);
      counters.submissionMs += performance.now() - start;
      counters.calls++;
      return result;
    };
  }
  const finish = target.finish;
  if (typeof finish === 'function') {
    originals.set('finish', finish);
    target.finish = (...args: unknown[]) => {
      const start = performance.now();
      const result = Reflect.apply(finish, gl, args);
      counters.finishMs += performance.now() - start;
      return result;
    };
  }
  return () => { for (const [name, original] of originals) target[name] = original; };
}

async function splitFrames(
  gl: WebGL2RenderingContext,
  renderNow: () => number,
  frames: number,
  step: (index: number) => void,
  cadence: 'raf' | 'task' = 'raf',
): Promise<FrameSplit> {
  const total: number[] = [], js: number[] = [], submission: number[] = [], finish: number[] = [];
  const presentation: number[] = [], calls: number[] = [];
  const counters: GlCounters = { submissionMs: 0, finishMs: 0, calls: 0 };
  const restore = instrumentGl(gl, counters);
  try {
    for (let index = 0; index < frames; index++) {
      if (cadence === 'raf') await waitFrame();
      counters.submissionMs = 0; counters.finishMs = 0; counters.calls = 0;
      const start = performance.now();
      step(index);
      renderNow();
      const end = performance.now();
      const elapsed = end - start;
      total.push(elapsed); submission.push(counters.submissionMs); finish.push(counters.finishMs);
      js.push(Math.max(0, elapsed - counters.submissionMs - counters.finishMs));
      if (cadence === 'raf') {
        const nextFrame = await waitFrame();
        presentation.push(Math.max(0, nextFrame - end));
      } else {
        requestAnimationFrame((nextFrame) => presentation.push(Math.max(0, nextFrame - end)));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      calls.push(counters.calls);
    }
    if (cadence === 'task') await waitFrame();
  } finally { restore(); }
  return {
    totalMs: measurementDistribution(total), jsCompositingMs: measurementDistribution(js),
    webglSubmissionMs: measurementDistribution(submission), glFinishMs: measurementDistribution(finish),
    presentationProxyMs: measurementDistribution(presentation), glCallsMedian: measurementDistribution(calls).median,
  };
}

function uninstrumented(frames: number, renderNow: () => number, step: (index: number) => void): Distribution {
  const values: number[] = [];
  for (let index = 0; index < frames; index++) { step(index); values.push(renderNow()); }
  return measurementDistribution(values);
}

async function brushFeedback(
  frames: number,
  renderNow: () => number,
  step: (index: number) => void,
): Promise<Distribution> {
  const values: number[] = [];
  for (let index = 0; index < frames; index++) {
    const start = performance.now();
    step(index);
    renderNow();
    values.push(performance.now() - start);
    // tests/e2e/performance.spec.ts: allow a task boundary between pointer samples.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return measurementDistribution(values);
}

async function nativePresented(frames: number, renderNow: () => number, step: (index: number) => void,
  cadence: 'raf' | 'task'): Promise<PresentedFrames> {
  await tauri().core.invoke<void>('a6_frame_clock_reset');
  for (let index = 0; index < frames; index++) {
    if (cadence === 'raf') await waitFrame();
    step(index); renderNow();
    if (cadence === 'task') await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  await waitFrame(); await waitFrame();
  return tauri().core.invoke<PresentedFrames>('a6_frame_clock_take');
}

function captureSuffix(settings: RuntimeSettings): string {
  const renderer = settings.forceDmabufShm ? 'shm' : settings.disableDmabufRenderer ? 'no-dmabuf' : 'default';
  return `${settings.runLabel}-${renderer}-dpr${devicePixelRatio.toFixed(2).replace('.', '_')}`;
}

async function captureCanvas(gl: WebGL2RenderingContext): Promise<string> {
  gl.finish();
  const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
  const bottomFirst = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bottomFirst);
  const topFirst = new Uint8ClampedArray(bottomFirst.length), stride = width * 4;
  for (let row = 0; row < height; row++) {
    topFirst.set(bottomFirst.subarray((height - row - 1) * stride, (height - row) * stride), row * stride);
  }
  const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas is unavailable for capture');
  context.putImageData(new ImageData(topFirst, width, height), 0, 0);
  const png = await canvas.convertToBlob({ type: 'image/png' });
  return tauri().core.invoke<string>('a6_store_capture', new Uint8Array(await png.arrayBuffer()));
}

async function renderingProbe(root: HTMLElement, settings: RuntimeSettings): Promise<A6SpikeResult['rendering']> {
  const emptyPresented = (): PresentedFrames => ({ samples: 0, presentationTimestamps: 0,
    intervalMs: measurementDistribution([]), droppedFrames: 0, refreshIntervalMs: 0, source: 'unavailable' });
  const failure: A6SpikeResult['rendering'] = {
    renderer: 'unavailable', canvasSizes: [],
    brushUninstrumentedMs: measurementDistribution([]), brushSplit: {
      totalMs: measurementDistribution([]), jsCompositingMs: measurementDistribution([]),
      webglSubmissionMs: measurementDistribution([]), glFinishMs: measurementDistribution([]),
      presentationProxyMs: measurementDistribution([]), glCallsMedian: 0,
    },
    brushPresented: emptyPresented(), captures: { window: { zoom: '', brush: '' }, canvas: { zoom: '', brush: '' } },
    notes: [],
  };
  let mounted: Awaited<ReturnType<typeof mount>> | null = null;
  try {
    mounted = await mount(root);
    const { controller } = mounted, session = controller.session, view = controller.canvasView!;
    if (view.rendererKind !== 'webgl2' || !view.gpu) {
      const probeCanvas = document.createElement('canvas');
      const basic = probeCanvas.getContext('webgl2');
      let compositorError = 'not attempted';
      if (basic) {
        basic.getExtension('WEBGL_lose_context')?.loseContext();
        try {
          const probe = await GpuCompositor.create(document.createElement('canvas'), 1, 1);
          probe.destroy(); compositorError = 'none';
        } catch (error) { compositorError = String(error); }
      }
      throw new Error(`renderer is ${view.rendererKind}; basic WebGL2=${!!basic}; compositor=${compositorError}`);
    }
    session.createDocument(4096, 4096, false);
    const modes: readonly BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'normal', 'darken', 'lighten', 'normal', 'difference', 'normal'];
    const layers = [];
    for (let layerIndex = 0; layerIndex < 10; layerIndex++) {
      const size = 4096, data = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const offset = (y * size + x) * 4;
        data[offset] = (x * (layerIndex + 1)) & 255; data[offset + 1] = (y * (layerIndex + 2)) & 255;
        data[offset + 2] = ((x ^ y) * (layerIndex + 3)) & 255; data[offset + 3] = layerIndex === 0 ? 255 : 160 + ((x + y + layerIndex * 37) & 63);
      }
      layers.push(newLayer({ id: `P${layerIndex}`, name: `Layer ${layerIndex}`, raster: Raster.fromPixels(size, size, 4, data),
        transform: makeTransform({ x: 0, y: 0 }, { width: size, height: size }), blendMode: modes[layerIndex] }));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    session.replaceDocument({ ...session.document!, layers }); session.notify('document'); session.fit();
    for (let frame = 0; frame < 5; frame++) view.renderNow();
    const gl = view.gpu.gl;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const canvasSizes: A6SpikeResult['rendering']['canvasSizes'] = [];
    for (const requested of [{ width: 960, height: 600 }, { width: 1440, height: 900 }]) {
      root.style.width = `${requested.width}px`; root.style.height = `${requested.height}px`;
      await waitFrame(); await waitFrame(); session.fit(); view.renderNow();
      const zoomStep = (index: number) => {
        const center = session.viewport.center;
        session.viewport.setZoom(session.viewport.zoom * (index % 30 < 15 ? 1.04 : 1 / 1.04), center, session.document!);
      };
      const zoomUninstrumentedMs = uninstrumented(90, () => view.renderNow(), zoomStep);
      session.fit();
      const zoomSplit = await splitFrames(gl, () => view.renderNow(), 30, zoomStep);
      session.fit();
      const presented = await nativePresented(60, () => view.renderNow(), zoomStep, 'raf');
      const rect = view.element.getBoundingClientRect();
      const canvas = view.element.querySelector<HTMLCanvasElement>('[data-testid="editor-canvas"]');
      canvasSizes.push({ requested, actual: { cssWidth: rect.width, cssHeight: rect.height,
        backingWidth: canvas?.width ?? 0, backingHeight: canvas?.height ?? 0, dpr: devicePixelRatio },
      zoomUninstrumentedMs, zoomSplit, presented });
    }
    await waitFrame(); await waitFrame();
    const zoomCanvasCapture = await captureCanvas(gl);
    const zoomCapture = await tauri().core.invoke<string>('a6_capture_window', { name: `zoom-${captureSuffix(settings)}` });

    session.fit(); session.replaceDocument({ ...session.document!, layers: layers.slice(0, 5) });
    session.notify('document'); view.renderNow(); session.selectLayer('P4'); session.selectTool('brush');
    brush.setBrushSettings(session, { ...brush.getBrushSettings(session), diameter: 300, hardness: 0 });
    brush.beginBrushStroke(session, { x: 500, y: 500 });
    const brushUninstrumentedMs = await brushFeedback(60, () => view.renderNow(), (index) => {
      brush.extendBrushStroke(session, { x: 500 + (index + 1) * 40, y: 500 + (index + 1) * 30 });
    });
    brush.cancelBrushStroke(session);
    brush.beginBrushStroke(session, { x: 500, y: 500 });
    const brushSplit = await splitFrames(gl, () => view.renderNow(), 60, (index) => {
      brush.extendBrushStroke(session, { x: 500 + (index + 1) * 40, y: 500 + (index + 1) * 30 });
    }, 'task');
    brush.cancelBrushStroke(session);
    brush.beginBrushStroke(session, { x: 500, y: 500 });
    const brushPresented = await nativePresented(60, () => view.renderNow(), (index) => {
      brush.extendBrushStroke(session, { x: 500 + (index + 1) * 40, y: 500 + (index + 1) * 30 });
    }, 'task');
    await waitFrame(); await waitFrame();
    const brushCanvasCapture = await captureCanvas(gl);
    const brushCapture = await tauri().core.invoke<string>('a6_capture_window', { name: `brush-${captureSuffix(settings)}` });
    brush.cancelBrushStroke(session);
    return {
      renderer, canvasSizes, brushUninstrumentedMs, brushSplit, brushPresented,
      captures: { window: { zoom: zoomCapture, brush: brushCapture },
        canvas: { zoom: zoomCanvasCapture, brush: brushCanvasCapture } },
      notes: [
        'Uninstrumented p95 is comparable to A1 because renderNow includes gl.finish.',
        'The split wraps WebGL calls and therefore has observer overhead; JS is residual wall time after wrapped WebGL calls and gl.finish.',
        'presentationProxyMs is finish-to-next-requestAnimationFrame delay, including vsync scheduling; brush RAF timestamps are observed without changing its zero-delay task cadence. Web APIs do not expose the GTK compositor presentation timestamp.',
      ],
    };
  } catch (error) { return { ...failure, error: String(error) }; }
  finally { mounted?.destroy(); }
}

export async function runA6Spike(root: HTMLElement, status: (message: string) => void = () => {}): Promise<A6SpikeResult> {
  const settings = await tauri().core.invoke<RuntimeSettings>('a6_runtime_settings');
  // Measure presentation before the two 46-MP upload probes. WebKitGTK may deliberately fall back
  // after the JPEG probes' temporary contexts place nearly a gigabyte of textures under pressure.
  status('Measuring WebKit/WebGL zoom and brush frame splits…');
  const rendering = await renderingProbe(root, settings);
  let jpeg46MP: A6SpikeResult['jpeg46MP'] = null;
  if (!settings.renderOnly) {
    status('Measuring 46 MP browser and native JPEG paths…');
    jpeg46MP = await jpegProbe(root, status);
  }
  return {
    timestamp: new Date().toISOString(), userAgent: navigator.userAgent, settings,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, jpeg46MP, rendering,
  };
}

export async function startA6SpikePage(root: HTMLElement): Promise<A6SpikeResult> {
  const status = document.createElement('pre'); status.id = 'a6-result'; root.replaceChildren(status);
  const result = await runA6Spike(root, (message) => {
    status.textContent = message; document.title = `A6: ${message}`; console.log(`[a6] ${message}`);
  });
  root.style.cssText = ''; root.replaceChildren(status); status.textContent = JSON.stringify(result, null, 2);
  document.title = 'Fernwork A6 Spike — complete';
  return result;
}
