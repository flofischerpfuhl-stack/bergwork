import { newLayer, type Layer } from '../core/document';
import { makeTransform } from '../core/geometry';
import { Raster, TILE, type Channels } from '../core/raster';
import { setBrushSettings, getBrushSettings } from '../core/brush';
import type { ToolContext } from '../ui/canvas/tools';
import type { EditorController } from '../ui/controller';

export interface LargeDocumentIo {
  save(): Promise<{ readonly archive: Blob; readonly bytes: number }>;
  closeAndReopen(archive: Blob): Promise<void>;
}

export interface LargeDocumentMetrics {
  readonly dimensions: [number, number];
  readonly rasterLayers: number;
  readonly logicalLayerPixels: number;
  readonly createImportMs: number;
  readonly scratchBytes: number;
  readonly residentBytes: number;
  readonly fitPanZoomP95Ms: number;
  readonly pan100P95Ms: number;
  readonly firstStrokeHydrationMs: number;
  readonly strokeCommitMs: number;
  readonly adjustmentUndoRedoMs: number;
  readonly saveMs: number;
  readonly reopenMs: number;
  readonly archiveBytes: number;
  readonly verifiedSamples: number;
}

const WIDTH = 20_000, HEIGHT = 10_000;

function percentile95(values: readonly number[]): number {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
}

async function aesKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new Uint8Array([
    0x46, 0x65, 0x72, 0x6e, 0x77, 0x6f, 0x72, 0x6b, 0x2d, 0x41, 0x34, 0x63, 0x2d, 0x32, 0x30, 0x30,
  ]), 'AES-CTR', false, ['encrypt']);
}

async function generatedRaster(layerIndex: number, width: number, height: number, key: CryptoKey): Promise<Raster> {
  const cols = Math.ceil(width / TILE), rows = Math.ceil(height / TILE);
  const tiles: Uint8Array[] = new Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tileWidth = Math.min(TILE, width - col * TILE), tileHeight = Math.min(TILE, height - row * TILE);
      const tileNumber = BigInt(layerIndex * 100_000 + row * cols + col);
      const counter = new Uint8Array(16);
      new DataView(counter.buffer).setBigUint64(8, tileNumber * 16_384n, false);
      const encrypted = await crypto.subtle.encrypt({ name: 'AES-CTR', counter, length: 64 }, key,
        new Uint8Array(tileWidth * tileHeight * 4));
      tiles[row * cols + col] = new Uint8Array(encrypted);
    }
  }
  return new Raster(width, height, 4 as Channels, tiles, { id: `a4c-raster-${layerIndex}` });
}

function context(controller: EditorController, x: number, y: number): ToolContext {
  return {
    session: controller.session, point: { x, y }, pixel: { x, y }, pointerType: 'mouse', pressure: null,
    modifiers: { shift: false, option: false, command: false, control: false }, distortArmed: false,
    redraw: () => controller.canvasView?.renderNow(), setCursor: () => {},
  };
}

/** Deterministic, tile-at-a-time A4 acceptance exercise shared by Chromium and packaged Tauri. */
export async function runLargeDocumentAcceptance(controller: EditorController, io: LargeDocumentIo): Promise<LargeDocumentMetrics> {
  if (!controller.residency || !controller.canvasView) throw new Error('Large-document acceptance needs scratch storage and a canvas');
  const key = await aesKey(), layers: Layer[] = [], samples = new Map<string, readonly number[]>();
  let logicalLayerPixels = 0;
  const createStart = performance.now();
  for (let index = 0; index < 20; index++) {
    const width = index < 5 ? WIDTH : [2_000, 4_000, 6_000][(index - 5) % 3]!;
    const height = HEIGHT, raster = await generatedRaster(index, width, height, key);
    const sampleX = Math.min(width - 1, 997 + index * 31), sampleY = 733 + index * 17;
    samples.set(`a4c-layer-${index}`, raster.pixel(sampleX, sampleY));
    const x = index < 5 ? 0 : Math.floor((WIDTH - width) * ((index % 5) / 4));
    layers.push(newLayer({ id: `a4c-layer-${index}`, name: `Photo ${index + 1}`, raster,
      transform: makeTransform({ x, y: 0 }, { width, height }) }));
    logicalLayerPixels += width * height;
    await controller.residency.manage(raster, index === 19 ? 'visible' : 'offscreen');
    console.info(`[A4c] generated and swapped layer ${index + 1}/20`);
  }
  controller.session.installProject({ id: 'a4c-200mp', width: WIDTH, height: HEIGHT, resolution: 72,
    layers, artboards: [], selection: null }, layers[0]!.id, 'A4c 200 MP');
  controller.session.notify('document');
  const createImportMs = performance.now() - createStart;
  const view = controller.canvasView;
  controller.session.fit();
  for (let i = 0; i < 4; i++) view.renderNow();
  const fit: number[] = [];
  for (let i = 0; i < 8; i++) {
    controller.session.viewport.translate(i % 20 < 10 ? 9 : -9, Math.sin(i / 4) * 3);
    fit.push(view.renderNow());
    if (i % 4 === 3) controller.session.viewport.setZoom(controller.session.viewport.zoom * 1.01,
      controller.session.viewport.center, controller.session.document!);
  }
  console.info('[A4c] completed fit pan/zoom');
  controller.session.viewport.setZoom(1, controller.session.viewport.center, controller.session.document!);
  const at100: number[] = [];
  for (let i = 0; i < 8; i++) {
    controller.session.viewport.translate(i % 12 < 6 ? 128 : -128, i % 2 ? 16 : -16);
    at100.push(view.renderNow());
    await controller.whenFullyResolved();
  }
  controller.session.selectLayer(layers[0]!.id);
  controller.session.selectTool('brush');
  setBrushSettings(controller.session, { ...getBrushSettings(controller.session), diameter: 180, hardness: 0.65 });
  const brush = view.tools.brush!;
  const hydrateStart = performance.now();
  brush.down(context(controller, 9_000, 4_500));
  await controller.whenFullyResolved();
  const firstStrokeHydrationMs = performance.now() - hydrateStart;
  const strokeStart = performance.now();
  brush.move(context(controller, 9_250, 4_650));
  brush.move(context(controller, 9_500, 4_800));
  brush.up(context(controller, 9_700, 4_900));
  await controller.whenFullyResolved();
  const strokeCommitMs = performance.now() - strokeStart;
  const adjustmentStart = performance.now();
  controller.session.addAdjustment('Levels');
  controller.session.adjustmentEditingId = null;
  if (!controller.session.undo() || !controller.session.redo()) throw new Error('Adjustment undo/redo failed');
  const adjustmentUndoRedoMs = performance.now() - adjustmentStart;
  console.info('[A4c] completed stroke and adjustment undo/redo');
  const saveStart = performance.now(), saved = await io.save(), saveMs = performance.now() - saveStart;
  console.info(`[A4c] saved ${saved.bytes} bytes`);
  const reopenStart = performance.now();
  await io.closeAndReopen(saved.archive);
  console.info('[A4c] reopened archive');
  const reopenMs = performance.now() - reopenStart;
  const restored = controller.session.document;
  if (!restored || restored.width !== WIDTH || restored.height !== HEIGHT) throw new Error('Reopened document dimensions differ');
  let verifiedSamples = 0;
  for (let index = 0; index < 20; index++) {
    const layer = restored.layers.find((value) => value.id === `a4c-layer-${index}`), raster = layer?.raster;
    if (!raster) throw new Error(`Reopened layer ${index} is missing`);
    const sampleX = Math.min(raster.width - 1, 997 + index * 31), sampleY = 733 + index * 17;
    const lease = await controller.residency.ensureResident([raster], { x: sampleX, y: sampleY, width: 1, height: 1 });
    try {
      const actual = raster.pixel(sampleX, sampleY), expected = samples.get(`a4c-layer-${index}`);
      if (!expected || actual.some((value, channel) => value !== expected[channel])) throw new Error(`Pixel verification failed for layer ${index}`);
      verifiedSamples++;
    } finally { lease.release(); }
  }
  return { dimensions: [WIDTH, HEIGHT], rasterLayers: 20, logicalLayerPixels, createImportMs,
    scratchBytes: controller.residency.cache.persistedBytes, residentBytes: controller.residency.cache.residentBytes,
    fitPanZoomP95Ms: percentile95(fit), pan100P95Ms: percentile95(at100), firstStrokeHydrationMs,
    strokeCommitMs, adjustmentUndoRedoMs, saveMs, reopenMs, archiveBytes: saved.bytes, verifiedSamples };
}
