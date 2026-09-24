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
  jpeg46MP: {
    encodedMB: number;
    browser: Record<string, number>;
    native: NativeDecodeReport & { ipcToRasterMs: number; firstUploadMs: number };
    parity: { sampleCount: number; maximumChannelDelta: number };
  } | null;
  rendering: {
    renderer: string;
    canvasSizes: Array<{
      requested: { width: number; height: number };
      actual: { cssWidth: number; cssHeight: number; backingWidth: number; backingHeight: number; dpr: number };
      zoomUninstrumentedMs: Distribution;
      zoomSplit: FrameSplit;
    }>;
    brushUninstrumentedMs: Distribution;
    brushSplit: FrameSplit;
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

async function jpegProbe(root: HTMLElement, status: (message: string) => void): Promise<A6SpikeResult['jpeg46MP']> {
  const blob = await generatedJpeg();
  status('46 MP JPEG generated; storing native fixture…');
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
  const rasterTilingMs = performance.now() - stage;
  status('Browser raster ready; measuring first GPU upload…');
  const browserFirstUploadMs = await firstUpload(root, browserRaster, status);

  status('Browser upload complete; decoding and streaming native tiles…');
  const nativeTiles: Uint8Array[] = [];
  const channel = new (tauri().core.Channel)<unknown>();
  let tileSignal: (() => void) | null = null;
  channel.onmessage = (message) => { nativeTiles.push(toBytes(message)); tileSignal?.(); };
  const nativeStart = performance.now();
  const native = await tauri().core.invoke<NativeDecodeReport>('a6_decode_jpeg', { path, onTile: channel });
  status(`Native command complete; received ${nativeTiles.length}/${native.tileCount} tiles…`);
  while (nativeTiles.length < native.tileCount) await new Promise<void>((resolve) => { tileSignal = resolve; });
  tileSignal = null;
  const nativeRaster = new Raster(native.width, native.height, 4, nativeTiles);
  const ipcToRasterMs = performance.now() - nativeStart;
  const nativeFirstUploadMs = await firstUpload(root, nativeRaster, status);
  status('Native raster upload complete; checking pixel parity…');

  const samples = [[0, 0], [127, 511], [4096, 2048], [9000, 4000], [native.width - 1, native.height - 1]] as const;
  let maximumChannelDelta = 0;
  for (const [x, y] of samples) {
    const browserPixel = browserRaster.pixel(x, y), nativePixel = nativeRaster.pixel(x, y);
    for (let channelIndex = 0; channelIndex < 4; channelIndex++) {
      maximumChannelDelta = Math.max(maximumChannelDelta, Math.abs(browserPixel[channelIndex]! - nativePixel[channelIndex]!));
    }
  }
  return {
    encodedMB: blob.size / 1_048_576,
    browser: {
      fileReadMs, decodeMs, colorConversionAndReadbackMs, rasterTilingMs,
      firstUploadMs: browserFirstUploadMs,
      totalToRasterMs: fileReadMs + decodeMs + colorConversionAndReadbackMs + rasterTilingMs,
    },
    native: { ...native, ipcToRasterMs, firstUploadMs: nativeFirstUploadMs },
    parity: { sampleCount: samples.length, maximumChannelDelta },
  };
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

async function renderingProbe(root: HTMLElement): Promise<A6SpikeResult['rendering']> {
  const failure: A6SpikeResult['rendering'] = {
    renderer: 'unavailable', canvasSizes: [],
    brushUninstrumentedMs: measurementDistribution([]), brushSplit: {
      totalMs: measurementDistribution([]), jsCompositingMs: measurementDistribution([]),
      webglSubmissionMs: measurementDistribution([]), glFinishMs: measurementDistribution([]),
      presentationProxyMs: measurementDistribution([]), glCallsMedian: 0,
    },
    notes: [],
  };
  let mounted: Awaited<ReturnType<typeof mount>> | null = null;
  try {
    mounted = await mount(root);
    const { controller } = mounted, session = controller.session, view = controller.canvasView!;
    if (view.rendererKind !== 'webgl2' || !view.gpu) throw new Error(`renderer is ${view.rendererKind}`);
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
      const rect = view.element.getBoundingClientRect();
      const canvas = view.element.querySelector<HTMLCanvasElement>('[data-testid="editor-canvas"]');
      canvasSizes.push({ requested, actual: { cssWidth: rect.width, cssHeight: rect.height,
        backingWidth: canvas?.width ?? 0, backingHeight: canvas?.height ?? 0, dpr: devicePixelRatio },
      zoomUninstrumentedMs, zoomSplit });
    }

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
    return {
      renderer, canvasSizes, brushUninstrumentedMs, brushSplit,
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
  let jpeg46MP: A6SpikeResult['jpeg46MP'] = null;
  if (!settings.renderOnly) {
    status('Measuring 46 MP browser and native JPEG paths…');
    jpeg46MP = await jpegProbe(root, status);
  }
  status('Measuring WebKit/WebGL zoom and brush frame splits…');
  const rendering = await renderingProbe(root);
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
