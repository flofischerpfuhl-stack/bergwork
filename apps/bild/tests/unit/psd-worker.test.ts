import { describe, expect, it } from 'vitest';
import { newLayer, type CanvasDocument } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { packPsdValue, psdWireMetrics, unpackPsdValue } from '../../src/workers/psdProtocol';
import { cpuCompositeRegion } from '../../src/render/cpuRender';

describe('PSD worker transferable tile protocol', () => {
  it('rehydrates Raster prototypes, exact pixels, masks and shared identity', () => {
    const pixels = new Uint8Array(300 * 2 * 4);
    for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 17) & 255;
    const raster = Raster.fromPixels(300, 2, 4, pixels);
    const mask = Raster.fromPixels(300, 2, 1, new Uint8Array(600).fill(255));
    const transform = makeTransform({ x: 0, y: 0 }, { width: 300, height: 2 });
    const document: CanvasDocument = { id: 'wire', width: 300, height: 2, resolution: 72, selection: null,
      layers: [newLayer({ id: 'one', name: 'One', transform, raster,
        mask: { raster: mask, enabled: true, linked: true, placement: null } }),
      newLayer({ id: 'two', name: 'Two', transform, raster })] };
    const packed = packPsdValue(document, true), metrics = psdWireMetrics(packed);
    expect(metrics).toEqual({ tileBytes: raster.byteSize + mask.byteSize, tileCount: 4 });
    expect(packed.rasters[0]!.tiles[0]).not.toBe(raster.tiles[0]);
    const restored = unpackPsdValue<CanvasDocument>(packed);
    expect(restored.layers[0]!.raster).toBeInstanceOf(Raster);
    expect(restored.layers[0]!.raster).toBe(restored.layers[1]!.raster);
    expect(restored.layers[0]!.mask!.raster).toBeInstanceOf(Raster);
    expect(restored.layers[0]!.raster!.toPixels()).toEqual(pixels);
    expect(cpuCompositeRegion(restored, { x: 0, y: 0, width: 300, height: 2 }))
      .toEqual(cpuCompositeRegion(document, { x: 0, y: 0, width: 300, height: 2 }));
  });
});
