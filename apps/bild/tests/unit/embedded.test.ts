import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { EditorSession } from '../../src/core/session';
import { makeTransform } from '../../src/core/geometry';
import { newLayer, type CanvasDocument, type LayerEffect } from '../../src/core/document';
import { Raster } from '../../src/core/raster';
import {
  EmbeddedRuntime, placeEmbeddedContent, replaceEmbeddedContents, updateSharedEmbeddedContents,
  type PreparedEmbeddedSource,
} from '../../src/core/embedded';
import { encodePng, decodePngNativeRGBA } from '../../src/io/png';
import { sha256Hex } from '../../src/io/sha256';
import { readArchive, writeArchive } from '../../src/io/project';
import { loadTextEngine } from '../../src/text';
import { renderSvg } from '../../src/io/svg';
import { cpuCompositeRegion } from '../../src/render/cpuRender';
import type { FileSystemHost } from '../../src/platform/hosts';
import { validatePdfPlacement } from '../../src/io/pdf';
import { writePsdUint8Array, type Psd } from 'ag-psd';
import { readPsdDocument } from '../../src/io/psd';

function solid(width: number, height: number, rgba: readonly [number, number, number, number]): Raster {
  const pixels = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(rgba, offset);
  return Raster.fromPixels(width, height, 4, pixels);
}

function pngSource(name: string, rgba: readonly [number, number, number, number], mode: 'embedded' | 'linked' = 'embedded', uri?: string): PreparedEmbeddedSource {
  const raster = solid(2, 2, rgba);
  return { bytes: encodePng(raster.toPixels(), 2, 2, 4), mime: 'image/png', mediaType: 'image', sourceName: name,
    width: 2, height: 2, raster, mode, uri };
}

function session(width = 20, height = 20): EditorSession {
  const value = new EditorSession();
  value.installProject({ id: 'doc', width, height, resolution: 72, layers: [], resources: [], selection: null }, null, 'test');
  return value;
}

const shadow: LayerEffect = { kind: 'dropShadow', schemaVersion: 1, enabled: true, opacity: 0.7, angle: 120,
  distance: 3, blur: 2, color: { red: 0, green: 0, blue: 0 } };

describe('embedded content commands', () => {
  it('PRODUCT-PLAN 6.1: Place Embedded deduplicates source bytes by hash and remains undoable', () => {
    const value = session(), source = pngSource('logo.png', [10, 20, 30, 255]);
    const first = placeEmbeddedContent(value, source), second = placeEmbeddedContent(value, source);
    expect(first).toBeTruthy(); expect(second).toBeTruthy();
    expect(value.document!.resources).toHaveLength(1);
    const layers = value.document!.layers.filter((layer) => layer.kind === 'embedded');
    expect(layers.map((layer) => layer.content.assetId)).toEqual([
      `embedded-${sha256Hex(source.bytes)}`, `embedded-${sha256Hex(source.bytes)}`,
    ]);
    expect(value.undo()).toBe(true);
    expect(value.document!.layers).toHaveLength(1);
  });

  it('benchmark 4: Replace Contents keeps transform, effects, filters, mask and opacity', () => {
    const value = session(), first = pngSource('front.png', [255, 0, 0, 255]), second = pngSource('back.png', [0, 0, 255, 255]);
    const id = placeEmbeddedContent(value, first)!;
    const layer = value.layer(id)!;
    const transformed = { ...layer, opacity: 0.55, effects: [shadow], filters: [
      { kind: 'gaussianBlur' as const, schemaVersion: 1 as const, enabled: true, radius: 1 },
    ], transform: { ...layer.transform, rotation: 17, size: { width: 8, height: 6 } },
    mask: { raster: Raster.solidMask(true), enabled: true, linked: true, placement: null } };
    value.replaceDocument({ ...value.document!, layers: [transformed] });
    expect(replaceEmbeddedContents(value, id, second)).toBe(true);
    const replaced = value.layer(id)!;
    expect(replaced.transform).toEqual(transformed.transform);
    expect(replaced.effects).toEqual([shadow]); expect(replaced.filters).toEqual(transformed.filters);
    expect(replaced.mask).toBe(transformed.mask); expect(replaced.opacity).toBe(0.55);
    expect(replaced.raster!.pixel(0, 0)).toEqual([0, 0, 255, 255]);
  });

  it('PRODUCT-PLAN 6.1: saving Edit Contents updates every shared instance in one undo step', () => {
    const value = session(), first = pngSource('shared.png', [255, 0, 0, 255]);
    placeEmbeddedContent(value, first); placeEmbeddedContent(value, first);
    const assetId = (value.document!.layers[0] as EmbeddedLayerForTest).content.assetId!;
    const before = value.history.undoCount;
    expect(updateSharedEmbeddedContents(value, assetId, pngSource('shared.png', [0, 255, 0, 255]))).toBe(2);
    expect(value.history.undoCount).toBe(before + 1);
    expect(value.document!.layers.map((layer) => layer.raster!.pixel(0, 0))).toEqual([
      [0, 255, 0, 255], [0, 255, 0, 255],
    ]);
    expect(value.undo()).toBe(true);
    expect(value.document!.layers.map((layer) => layer.raster!.pixel(0, 0))).toEqual([
      [255, 0, 0, 255], [255, 0, 0, 255],
    ]);
  });
});

type EmbeddedLayerForTest = Extract<CanvasDocument['layers'][number], { kind: 'embedded' }>;

describe('embedded rendering and persistence', () => {
  it('PRODUCT-PLAN 6.8: CanvasKit SVG stays target-resolution sharp at 4× while raster pixels retain their original grid', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8"><rect x="2" y="1" width="4" height="6" fill="#000"/></svg>');
    const engine = await loadTextEngine({ wasmUrl: path.resolve('node_modules/canvaskit-wasm/bin/canvaskit.wasm') });
    try {
      const vector = renderSvg(svg, 32, 32, engine).raster;
      const partialVector = Array.from({ length: 32 }, (_, x) => vector.pixel(x, 16)[3]!).filter((alpha) => alpha > 0 && alpha < 255).length;
      expect(partialVector).toBeLessThanOrEqual(2);

      const low = new Uint8Array(8 * 8 * 4);
      for (let y = 1; y < 7; y++) for (let x = 2; x < 6; x++) low[(y * 8 + x) * 4 + 3] = 255;
      const rasterLayer = newLayer({ id: 'png', name: 'PNG', raster: Raster.fromPixels(8, 8, 4, low),
        transform: makeTransform({ x: 0, y: 0 }, { width: 32, height: 32 }) });
      const document: CanvasDocument = { id: 'scale', width: 32, height: 32, resolution: 72, layers: [rasterLayer], selection: null };
      const rasterPixels = cpuCompositeRegion(document, { x: 0, y: 0, width: 32, height: 32 });
      const partialRaster = Array.from({ length: 32 }, (_, x) => rasterPixels[(16 * 32 + x) * 4 + 3]!).filter((alpha) => alpha > 0 && alpha < 255).length;
      expect(partialRaster).toBeGreaterThan(partialVector);
      expect(rasterLayer.raster!.width).toBe(8);
    } finally { engine.dispose(); }
  }, 20_000);

  it('format v2 round trip preserves source metadata and stores one hash-deduplicated resource member', async () => {
    const value = session(), source = pngSource('mockup.png', [7, 8, 9, 255]);
    placeEmbeddedContent(value, source); placeEmbeddedContent(value, source);
    const archive = writeArchive(value.document!, 'embedded', value.activeLayerId);
    const files = unzipSync(new Uint8Array(await archive.blob.arrayBuffer()));
    expect(Object.keys(files).filter((name) => name.startsWith('assets/resource-'))).toHaveLength(1);
    const loaded = await readArchive(archive.blob, async (bytes) => {
      const decoded = decodePngNativeRGBA(bytes);
      return { width: decoded.width, height: decoded.height, channels: 4, data: decoded.data, bitDepth: decoded.bitDepth };
    });
    const layers = loaded.document.layers.filter((layer): layer is EmbeddedLayerForTest => layer.kind === 'embedded');
    expect(layers).toHaveLength(2);
    expect(layers[0]!.content).toMatchObject({ sourceName: 'mockup.png', width: 2, height: 2,
      sha256: sha256Hex(source.bytes), assetId: layers[1]!.content.assetId });
    expect(loaded.document.resources).toHaveLength(1);
  });

  it('linked refresh detects a changed hash, reloads original bytes, and is undoable', async () => {
    const first = pngSource('linked.png', [255, 0, 0, 255], 'linked', '/linked.png');
    const second = pngSource('linked.png', [0, 0, 255, 255], 'linked', '/linked.png');
    let bytes = first.bytes;
    const files: FileSystemHost = { version: 1, async chooseFiles() { return []; }, async chooseSaveTarget() { return null; },
      async writeFile() {}, async recentFiles() { return []; }, async recordRecentFile() {}, onOpenFiles() { return () => {}; },
      async readFile() { return new Blob([bytes as BlobPart], { type: 'image/png' }); } };
    const value = session(), id = placeEmbeddedContent(value, first)!;
    const runtime = new EmbeddedRuntime({ files });
    expect(await runtime.refreshLinked(value, id)).toBe(0);
    expect(runtime.linkStatus(value, id)?.state).toBe('current');
    bytes = second.bytes;
    expect(await runtime.refreshLinked(value, id)).toBe(1);
    expect(value.layer(id)!.raster!.pixel(0, 0)).toEqual([0, 0, 255, 255]);
    expect(value.undo()).toBe(true);
    expect(value.layer(id)!.raster!.pixel(0, 0)).toEqual([255, 0, 0, 255]);
  });

  it('PDF placement rejects invalid bytes before invoking an optional host', () => {
    expect(() => validatePdfPlacement(new TextEncoder().encode('not pdf'), 0)).toThrow(/not a PDF/);
    expect(() => validatePdfPlacement(new TextEncoder().encode('%PDF-1.7'), -1)).toThrow(/zero-based/);
  });

  it('PSD placed-layer import uses embedded source data and its non-destructive transform, never the PSD composite', () => {
    const source = pngSource('source.png', [12, 34, 56, 255]);
    const id = '20953ddb-9391-11ec-b4f1-c15674f50bc4';
    const preview = new Uint8ClampedArray(4 * 4 * 4);
    for (let offset = 0; offset < preview.length; offset += 4) preview.set([200, 10, 20, 255], offset);
    const psd: Psd = { width: 30, height: 30, children: [{ name: 'Mockup target', top: 10, left: 8, bottom: 14, right: 12,
      imageData: { width: 4, height: 4, data: preview }, placedLayer: { id, type: 'raster', width: 2, height: 2,
        transform: [8, 10, 16, 10, 16, 18, 8, 18] } }], linkedFiles: [{ id, name: 'source.png', data: source.bytes }],
      imageData: { width: 30, height: 30, data: new Uint8ClampedArray(30 * 30 * 4) } };
    const imported = readPsdDocument(writePsdUint8Array(psd, { generateThumbnail: false }));
    const layer = imported.document.layers[0]!;
    expect(layer.kind).toBe('embedded');
    if (layer.kind !== 'embedded') throw new Error('Expected embedded PSD layer');
    expect(layer.content).toMatchObject({ mode: 'embedded', mediaType: 'image', sourceName: 'source.png', width: 2, height: 2 });
    expect(layer.transform).toMatchObject({ origin: { x: 8, y: 10 }, size: { width: 8, height: 8 }, rotation: 0 });
    expect(imported.document.resources?.[0]?.bytes).toEqual(source.bytes);
    expect(layer.raster?.pixel(0, 0)).toEqual([12, 34, 56, 255]);
  });
});
