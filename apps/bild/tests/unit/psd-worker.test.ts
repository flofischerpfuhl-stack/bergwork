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
});
