import { describe, expect, it } from 'vitest';
import { newLayer, type CanvasDocument } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { packPsdValue, psdWireMetrics, unpackPsdValue } from '../../src/workers/psdProtocol';
import { cpuCompositeRegion } from '../../src/render/cpuRender';
import { installPsdColorTransfer, type PsdColorTransferResult } from '../../src/io/psd/reader';

describe('PSD worker transferable tile protocol', () => {
  it('rehydrates Raster prototypes, exact pixels, masks and shared identity', () => {
    const pixels = new Uint8Array(300 * 2 * 4);
    for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 17) & 255;
    const raster = Raster.fromPixels(300, 2, 4, pixels);
    const mask = Raster.fromPixels(300, 2, 1, new Uint8Array(600).fill(255));
    const transform = makeTransform({ x: 0, y: 0 }, { width: 300, height: 2 });
    const identity = { black0: 0, black1: 0, white0: 255, white1: 255 };
    const blendIf = { source: { gray: identity, red: identity, green: identity, blue: identity },
      destination: { gray: identity, red: identity, green: identity, blue: identity } };
    const filters = [{ kind: 'gaussianBlur' as const, schemaVersion: 1 as const, enabled: false, radius: 2,
      opacity: 0.65, blendMode: 'screen' as const }];
    const document: CanvasDocument = { id: 'wire', width: 300, height: 2, resolution: 72, selection: null,
      layers: [newLayer({ id: 'one', name: 'One', transform, raster, blendIf,
        mask: { raster: mask, enabled: true, linked: true, placement: null } }),
      newLayer({ id: 'two', name: 'Two', transform, raster }),
      newLayer({ id: 'smart', name: 'Smart', kind: 'embedded', transform, raster, filters,
        filterMask: { raster: mask, enabled: true, linked: false, placement: null, defaultColor: 255 } })] };
    const packed = packPsdValue(document, true), metrics = psdWireMetrics(packed);
    expect(metrics).toEqual({ tileBytes: raster.byteSize + mask.byteSize, tileCount: 4 });
    expect(packed.rasters[0]!.tiles[0]).not.toBe(raster.tiles[0]);
    const restored = unpackPsdValue<CanvasDocument>(packed);
    expect(restored.layers[0]!.raster).toBeInstanceOf(Raster);
    expect(restored.layers[0]!.raster).toBe(restored.layers[1]!.raster);
    expect(restored.layers[0]!.mask!.raster).toBeInstanceOf(Raster);
    expect(restored.layers[0]!.raster!.toPixels()).toEqual(pixels);
    expect(restored.layers[0]!.blendIf).toEqual(blendIf);
    expect(restored.layers[2]!.filters).toEqual(filters);
    expect(restored.layers[2]!.filterMask).toMatchObject({ enabled: true, linked: false, defaultColor: 255 });
    expect(restored.layers[2]!.filterMask!.raster).toBe(restored.layers[0]!.mask!.raster);
    expect(cpuCompositeRegion(restored, { x: 0, y: 0, width: 300, height: 2 }))
      .toEqual(cpuCompositeRegion(document, { x: 0, y: 0, width: 300, height: 2 }));
  });

  it('installs a deferred CMYK table into document and adjustment state before exact pixels render', () => {
    const transform = makeTransform({ x: 0, y: 0 }, { width: 1, height: 1 });
    const base = newLayer({ id: 'base', name: 'Base', transform,
      raster: Raster.fromPixels(1, 1, 4, new Uint8Array([255, 0, 0, 255])) });
    const threshold = Object.assign({ kind: 'Threshold' as const, schemaVersion: 1 as const,
      parameters: { level: 100 } }, { psdColorMode: 4, psdBitsPerChannel: 8 });
    const adjustment = newLayer({ id: 'threshold', name: 'Threshold', transform, adjustment: threshold });
    const document = { id: 'deferred', width: 1, height: 1, resolution: 72, selection: null,
      layers: [base, adjustment], psdColorMode: 4, psdColorTransferKey: 'profile' } as CanvasDocument;
    const inverse = new Uint8Array(2 ** 3 * 4);
    for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) {
      inverse.set([r * 255, g * 255, b * 255, 0], ((b * 2 + g) * 2 + r) * 4);
    }
    const forward = new Uint8Array(2 ** 4 * 4);
    for (let k = 0; k < 2; k++) for (let y = 0; y < 2; y++) for (let m = 0; m < 2; m++) for (let c = 0; c < 2; c++) {
      const at = (((k * 2 + y) * 2 + m) * 2 + c) * 4;
      forward.set([255 - k * 255, 255 - k * 255, 255 - k * 255, 255], at);
    }
    const result: PsdColorTransferResult = { key: 'profile', cached: false, buildMs: 1,
      transfer: { kind: 'cmyk', table: { inverseSize: 2, inverse, forwardSize: 2, forward } } };
    const progressive = cpuCompositeRegion(document, { x: 0, y: 0, width: 1, height: 1 });
    const installed = installPsdColorTransfer(document, result);
    const exact = cpuCompositeRegion(installed, { x: 0, y: 0, width: 1, height: 1 });
    expect(Array.from(progressive)).toEqual([0, 0, 0, 255]);
    expect(Array.from(exact)).toEqual([255, 255, 255, 255]);
    expect((installed as CanvasDocument & { psdCmykTransfer?: unknown }).psdCmykTransfer).toBe(result.transfer.table);
    expect((installed.layers[1]!.adjustment as typeof threshold & { psdCmykTransfer?: unknown }).psdCmykTransfer)
      .toBe(result.transfer.table);
  });
});
