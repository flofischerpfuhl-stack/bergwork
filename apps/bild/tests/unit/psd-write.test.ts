import { describe, expect, it } from 'vitest';
import { readPsd } from 'ag-psd';
import { DEFAULT_TEXT_STYLE, newLayer, type CanvasDocument, type LayerEffect } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { srgbIccProfile } from '../../src/io/iccProfile';
import { readPsdDocument, writePsdDocument } from '../../src/io/psd';
import { readRawPsdComposite } from '../../src/io/psd/composite';
import { encodePng } from '../../src/io/png';
import { cpuCompositeRegion } from '../../src/render/cpuRender';

function solid(width: number, height: number, rgba: readonly [number, number, number, number], sixteen = false): Raster {
  const data = sixteen ? new Uint16Array(width * height * 4) : new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) for (let channel = 0; channel < 4; channel++) {
    data[pixel * 4 + channel] = sixteen ? rgba[channel]! * 257 : rgba[channel]!;
  }
  return Raster.fromPixels(width, height, 4, data, sixteen ? { format: 'rgba16' } : {});
}

function document(layers: CanvasDocument['layers'], extra: Partial<CanvasDocument> = {}): CanvasDocument {
  return { id: 'write-test', width: 4, height: 2, resolution: 144, layers, selection: null, ...extra };
}

function maximumDifference(a: Uint8Array, b: Uint8Array): number {
  expect(a).toHaveLength(b.length);
  let maximum = 0;
  for (let index = 0; index < a.length; index++) maximum = Math.max(maximum, Math.abs(a[index]! - b[index]!));
  return maximum;
}

describe('PRODUCT-PLAN A7 PSD writer', () => {
  it('round-trips hierarchy, clipping, blend/opacity/fill, locks, labels, masks, guides and CPU composite pixels', () => {
    const full = makeTransform({ x: 0, y: 0 }, { width: 4, height: 2 }, { sampling: 'Nearest' });
    const base = newLayer({ id: 'base', name: 'Base', transform: full, raster: solid(4, 2, [80, 120, 180, 255]),
      locks: { transparency: true, pixels: false, position: false, all: false }, colorLabel: 'red' });
    const group = newLayer({ id: 'group', name: 'Folder', kind: 'group', transform: full, opacity: 0.75 });
    const mask = Raster.fromPixels(4, 2, 1, new Uint8Array([255, 255, 0, 0, 255, 255, 0, 0]));
    const child = newLayer({ id: 'child', name: 'Clipped', parentId: 'group', transform: full,
      raster: solid(4, 2, [200, 40, 20, 200]), blendMode: 'multiply', opacity: 0.8, fillOpacity: 0.6,
      mask: { raster: mask, enabled: true, placement: null, linked: true } });
    const input = document([base, group, child], { guides: [
      { id: 'v', orientation: 'vertical', position: 1.5 }, { id: 'h', orientation: 'horizontal', position: 1 },
    ] });
    const expected = cpuCompositeRegion(input, { x: 0, y: 0, width: 4, height: 2 });
    const output = writePsdDocument(input);
    const reopened = readPsdDocument(output.bytes);
    expect(output.format).toBe('psd');
    expect(output.notices).toEqual([]);
    expect(reopened.document.resolution).toBe(144);
    expect(reopened.document.layers.map((layer) => [layer.name, layer.kind, layer.parentId !== null]))
      .toEqual([['Base', 'pixel', false], ['Folder', 'group', false], ['Clipped', 'pixel', true]]);
    expect(reopened.document.layers[0]).toMatchObject({ colorLabel: 'red', locks: { transparency: true } });
    expect(reopened.document.layers[2]).toMatchObject({ blendMode: 'multiply', opacity: 0.8, fillOpacity: 0.6,
      mask: { enabled: true } });
    const actual = cpuCompositeRegion(reopened.document, { x: 0, y: 0, width: 4, height: 2 });
    expect(maximumDifference(actual, expected)).toBeLessThanOrEqual(1);
    expect(readRawPsdComposite(output.bytes).rgba).toEqual(expected);
    expect(readRawPsdComposite(output.bytes).iccProfile).toEqual(srgbIccProfile());
  });

  it('writes editable text, shape, adjustment, layer-style and embedded-content records with rendered caches', () => {
    const full = makeTransform({ x: 0, y: 0 }, { width: 4, height: 2 }, { sampling: 'Nearest' });
    const effects: LayerEffect[] = [
      { kind: 'dropShadow', schemaVersion: 1, enabled: true, opacity: 0.5, angle: 120, distance: 2, blur: 3,
        color: { red: 0, green: 0, blue: 0 } },
      { kind: 'stroke', schemaVersion: 1, enabled: true, width: 1, position: 'inside', color: { red: 1, green: 0, blue: 0 } },
      { kind: 'outerGlow', schemaVersion: 1, enabled: true, opacity: 0.4, color: { red: 1, green: 1, blue: 0 },
        blendMode: 'screen', spread: 0, size: 2, contour: 'linear', noise: 0 },
      { kind: 'colorOverlay', schemaVersion: 1, enabled: true, opacity: 0.2, color: { red: 0, green: 1, blue: 0 } },
      { kind: 'gradientOverlay', schemaVersion: 1, enabled: true, opacity: 0.3, blendMode: 'normal', angle: 45, scale: 100,
        gradient: { stops: [{ offset: 0, color: { red: 0, green: 0, blue: 0 }, opacity: 1 },
          { offset: 1, color: { red: 1, green: 1, blue: 1 }, opacity: 1 }] } },
    ];
    const text = newLayer({ id: 'text', name: 'Editable text', kind: 'text', transform: full, text: 'Hi',
      runs: [{ from: 0, to: 2, style: { ...DEFAULT_TEXT_STYLE, fontFamily: 'Noto Sans', fontSize: 18,
        color: { red: 0.2, green: 0.4, blue: 0.8, alpha: 1 } } }], raster: solid(4, 2, [10, 20, 30, 255]), effects });
    const path = { schemaVersion: 1 as const, closed: true, fillRule: 'nonzero' as const, points: [
      { anchor: { x: 0, y: 0 }, in: { x: 0, y: 0 }, out: { x: 0, y: 0 }, kind: 'corner' as const },
      { anchor: { x: 4, y: 0 }, in: { x: 4, y: 0 }, out: { x: 4, y: 0 }, kind: 'corner' as const },
      { anchor: { x: 4, y: 2 }, in: { x: 4, y: 2 }, out: { x: 4, y: 2 }, kind: 'corner' as const },
    ] };
    const vector = newLayer({ id: 'vector', name: 'Editable shape', kind: 'vector', transform: full, paths: [path],
      style: { fill: { kind: 'solid', schemaVersion: 1, color: { red: 1, green: 0, blue: 0 } }, stroke: null },
      raster: solid(4, 2, [255, 0, 0, 255]) });
    const invert = newLayer({ id: 'invert', name: 'Invert', transform: full,
      adjustment: { kind: 'Invert', schemaVersion: 1, parameters: {} } });
    const source = encodePng(solid(1, 1, [30, 40, 50, 255]).toPixels(), 1, 1, 4);
    const embedded = newLayer({ id: 'placed', name: 'Placed', kind: 'embedded', transform: full,
      raster: solid(4, 2, [30, 40, 50, 255]), content: { mode: 'embedded', mediaType: 'image', assetId: 'placed-source',
        sourceName: 'source.png', width: 1, height: 1 } });
    const input = document([text, vector, invert, embedded], { resources: [
      { id: 'placed-source', role: 'embedded', mime: 'image/png', bytes: source },
    ] });
    const output = writePsdDocument(input);
    const raw = readPsd(output.bytes, { useImageData: true, skipThumbnail: true, skipLinkedFilesData: false });
    const byName = new Map(raw.children!.map((layer) => [layer.name, layer]));

    expect(byName.get('Editable text')).toMatchObject({ text: { text: 'Hi' },
      effects: { dropShadow: [{ enabled: true }], stroke: [{ enabled: true }], outerGlow: { enabled: true },
        solidFill: [{ enabled: true }], gradientOverlay: [{ enabled: true }] } });
    expect(byName.get('Editable text')?.text?.style?.fontSize).toBe(18);
    expect(byName.get('Editable shape')).toMatchObject({ vectorFill: { type: 'color' }, vectorMask: { paths: [{ open: false }] } });
    expect(byName.get('Invert')).toMatchObject({ adjustment: { type: 'invert' } });
    expect(byName.get('Placed')).toMatchObject({ placedLayer: { type: 'raster', width: 1, height: 1 } });
    expect(raw.linkedFiles?.[0]?.data).toEqual(source);
    expect(output.notices).toEqual([]);
  });

  it('preserves 16-bit layer samples, writes PSB headers, and reports every rasterized unsupported feature', () => {
    const full = makeTransform({ x: 0, y: 0 }, { width: 1, height: 1 });
    const wide = Raster.fromPixels(1, 1, 4, new Uint16Array([1234, 23456, 45678, 65535]), { format: 'rgba16' });
    const pixel = newLayer({ id: 'wide', name: 'Wide', transform: full, raster: wide });
    const filtered = newLayer({ id: 'filtered', name: 'Filtered', transform: full, raster: solid(1, 1, [18, 52, 86, 255]),
      filters: [{ kind: 'gaussianBlur', schemaVersion: 1, enabled: true, radius: 2 }] });
    const grain = newLayer({ id: 'grain', name: 'Grain', transform: full,
      adjustment: { kind: 'Grain', schemaVersion: 1, parameters: { amount: 10, size: 2, roughness: 50, seed: 1 } } });
    const output = writePsdDocument({ ...document([pixel, filtered, grain]), width: 1, height: 1 }, { format: 'psb' });
    expect(output.bitsPerChannel).toBe(16);
    expect(new DataView(output.bytes.buffer, output.bytes.byteOffset).getUint16(4)).toBe(2);
    expect(output.notices.map((entry) => entry.code)).toEqual(expect.arrayContaining(
      ['live-filters', 'adjustment:Grain', '16-bit-precision']));
    const reopened = readPsdDocument(output.bytes);
    expect(reopened.source).toMatchObject({ bitsPerChannel: 16, isPsb: true });
    expect(reopened.document.layers.map((layer) => [layer.name, layer.raster?.format, layer.kind]))
      .toEqual([['Wide', 'rgba16', 'pixel'], ['Filtered', 'rgba16', 'pixel'], ['Grain', 'rgba16', 'pixel']]);
    expect(reopened.document.layers[0]?.raster?.toPixelsNative()).toEqual(wide.toPixelsNative());
  });
});
