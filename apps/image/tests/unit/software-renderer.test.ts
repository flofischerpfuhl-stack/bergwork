import { describe, expect, it } from 'vitest';
import { beginBrushStroke, cancelBrushStroke, currentBrushPreview, extendBrushStroke, type BrushSettings } from '../../src/core/brush';
import { compositeRegion, compositeView } from '../../src/core/composite';
import { newLayer, type CanvasDocument } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import { SoftwareDownsampleCache } from '../../src/render/softwareCompositor';

function rgbaRaster(width: number, height: number, pixel: (x: number, y: number) => readonly number[]): Raster {
  const bytes = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) bytes.set(pixel(x, y), (y * width + x) * 4);
  return Raster.fromPixels(width, height, 4, bytes);
}

describe('software downsample cache (upstream DownsampleTests)', () => {
  it('halvingsAreReusedAndOnlyUsedForLargeReductions', () => {
    const cache = new SoftwareDownsampleCache();
    const raster = rgbaRaster(1024, 512, (x) => [x % 2 ? 255 : 0, 0, 0, 255]);
    expect(cache.level(.5)).toBe(0);
    expect(cache.level(.49)).toBe(1);
    expect(cache.level(1 / 1024)).toBe(SoftwareDownsampleCache.maxLevel);
    const first = cache.sampler(raster, 'High quality', 128);
    const sameLevel = cache.sampler(raster, 'High quality', 100);
    expect(first).toMatchObject({ width: 128, height: 64, level: 3 });
    expect(sameLevel).toBe(first);
    expect(cache.sampler(raster, 'Nearest', 1).level).toBe(0);
  });

  it('immutable raster replacements get independent cached levels', () => {
    const cache = new SoftwareDownsampleCache();
    const raster = rgbaRaster(512, 512, () => [10, 20, 30, 255]);
    const changed = raster.withRegion(0, 0, 1, 1, new Uint8Array([200, 20, 30, 255]));
    const originalLevel = cache.sampler(raster, 'High quality', 64);
    const changedLevel = cache.sampler(changed, 'High quality', 64);
    expect(changedLevel).not.toBe(originalLevel);
    expect(cache.sampler(raster, 'High quality', 64)).toBe(originalLevel);
  });
});

describe('software view compositor', () => {
  it('renders only the requested panned view at view resolution', () => {
    const raster = rgbaRaster(4, 2, (x) => [x * 60, 10, 20, 255]);
    const layer = newLayer({ id: 'pixels', name: 'Pixels', raster,
      transform: makeTransform({ x: 0, y: 0 }, { width: 4, height: 2 }, { sampling: 'Nearest' }) });
    const document: CanvasDocument = { id: 'doc', width: 4, height: 2, resolution: 72, selection: null, layers: [layer] };
    const result = compositeView(document, 2, 2, { a: 1, b: 0, c: 0, d: 1, tx: 2, ty: 0 });
    expect(Array.from(result.rgba.slice(0, 4))).toEqual([120, 10, 20, 255]);
    expect(Array.from(result.rgba.slice(4, 8))).toEqual([180, 10, 20, 255]);
  });

  it('softwareFallbackKeepsTheSoftStrokeContinuous (RasterSnapshotTests)', () => {
    const session = new EditorSession(); session.createDocument(180, 100, true); session.selectTool('brush');
    const settings: BrushSettings = { diameter: 30, hardness: 0, opacity: 1,
      red: 1, green: 0, blue: 0, mode: 'paint' };
    expect(beginBrushStroke(session, { x: 30, y: 50 }, { settings })).not.toBeNull();
    extendBrushStroke(session, { x: 150, y: 50 });
    const preview = currentBrushPreview(session)!;
    const document = session.document!;
    const pixels = compositeRegion(document, { x: 0, y: 0, width: 180, height: 100 }, {
      transform: (layer) => layer.id === preview.layerId ? preview.transform : layer.transform,
      raster: (layer) => layer.id === preview.layerId ? preview.raster : layer.raster,
    }).rgba;
    for (const y of [50, 57, 62]) {
      const alpha = Array.from({ length: 81 }, (_, index) => pixels[(y * 180 + 50 + index) * 4 + 3]!);
      expect(Math.max(...alpha) - Math.min(...alpha)).toBeLessThanOrEqual(2);
    }
    expect(cancelBrushStroke(session)).toBe(true);
  });
});
