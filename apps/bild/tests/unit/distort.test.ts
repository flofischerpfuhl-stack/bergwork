import { describe, expect, it } from 'vitest';
import { applyDistort } from '../../src/core/canvasOps';
import { compositeRegion } from '../../src/core/composite';
import { distortLayer, homography, isUsableDistort, maskBackground, warpMask, warpRaster, warpRasterTrimmed,
  type DistortCorners } from '../../src/core/distort';
import { makeTransform } from '../../src/core/geometry';
import { newLayer, type CanvasDocument } from '../../src/core/document';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import { trimmed } from '../../src/core/trim';

function solid(width: number, height: number, color: [number, number, number, number]): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(color, i * 4);
  return Raster.fromPixels(width, height, 4, data);
}

const shape: DistortCorners = [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }];

describe('DistortWarp (Distort.swift)', () => {
  it('perspectiveMappingHitsTheCornersAndTwistedShapesAreRefused', () => {
    const map = homography(shape);
    const units = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    units.forEach((unit, i) => {
      expect(map(unit).x).toBeCloseTo(shape[i]!.x, 6);
      expect(map(unit).y).toBeCloseTo(shape[i]!.y, 6);
    });
    expect(isUsableDistort(shape)).toBe(true);
    expect(isUsableDistort([shape[0], shape[2], shape[1], shape[3]])).toBe(false);
    expect(isUsableDistort([shape[0], shape[0], shape[2], shape[3]])).toBe(false);
  });

  it('distortingWarpsTheLayerIntoTheShape with transparent outside pixels', () => {
    const warped = warpRaster(solid(20, 20, [255, 0, 0, 255]),
      makeTransform({ x: 10, y: 10 }, { width: 20, height: 20 }), shape);
    expect(warped.transform.origin).toEqual({ x: 10, y: 10 });
    expect(warped.transform.size).toEqual({ width: 50, height: 20 });
    expect(warped.raster.pixel(40, 2)[3]).toBeGreaterThan(200);
    expect(warped.raster.pixel(5, 15)[3]).toBeGreaterThan(200);
    expect(warped.raster.pixel(40, 18)[3]).toBe(0);
  });

  it('distortedLayerIsTrimmedToItsVisiblePixels', () => {
    const source = Raster.blank(40, 20, 4).withRegion(15, 5, 10, 10, new Uint8Array(10 * 10 * 4).fill(255));
    const warped = warpRasterTrimmed(source, makeTransform({ x: 10, y: 10 }, { width: 40, height: 20 }), shape);
    expect(warped.transform.size.width).toBeLessThan(20);
    expect(warped.transform.size.height).toBeLessThanOrEqual(12);
    expect(warped.transform.origin.x).toBeGreaterThanOrEqual(19); // Bilinear edge antialiasing can retain one fringe pixel.
    expect(warped.transform.origin.y).toBeGreaterThanOrEqual(14);
  });

  it('PixelFilter.trimmed keeps placement, rotation, and empty upstream behaviour', () => {
    const raster = Raster.blank(10, 10, 4).withRegion(2, 3, 4, 2, new Uint8Array(4 * 2 * 4).fill(255));
    const placed = makeTransform({ x: 10, y: 20 }, { width: 20, height: 10 }, { rotation: 90 });
    const result = trimmed(raster, placed)!;
    expect([result.raster.width, result.raster.height]).toEqual([4, 2]);
    expect(result.transform.size).toEqual({ width: 8, height: 2 });
    expect(result.transform.rotation).toBe(90);
    const empty = Raster.blank(5, 6, 4);
    expect(trimmed(empty, placed)).toEqual({ raster: empty, transform: placed });
  });

  it('warpMask uses edge background and uniform masks stay allocation-free', () => {
    const white = Raster.solidMask(true);
    const uniform = warpMask(white, makeTransform({ x: 0, y: 0 }, { width: 10, height: 10 }), shape, 1);
    expect(uniform.raster).toBe(white);
    const data = new Uint8Array(16).fill(255);
    data[5] = 0;
    const mask = Raster.fromPixels(4, 4, 1, data);
    expect(maskBackground(mask)).toBe(1);
    const moved = warpMask(mask, makeTransform({ x: 0, y: 0 }, { width: 4, height: 4 }), shape, 1);
    expect(moved.raster.pixel(45, 18)[0]).toBeGreaterThan(200);
  });

  it('commit helper carries mask rules and applyDistort is one undo step', () => {
    const raster = solid(20, 20, [255, 0, 0, 255]);
    const maskRaster = Raster.fromPixels(20, 20, 1, new Uint8Array(400).fill(255));
    const layer = newLayer({ id: 'red', name: 'Red', raster,
      transform: makeTransform({ x: 10, y: 10 }, { width: 20, height: 20 }),
      mask: { raster: maskRaster, enabled: true, linked: false, placement: null } });
    const distorted = distortLayer(layer, layer.transform, shape);
    expect(distorted.mask!.placement).toEqual(layer.transform);
    expect(distorted.mask!.raster).toBe(maskRaster);

    const doc: CanvasDocument = { id: 'doc', width: 100, height: 60, resolution: 72, layers: [layer], selection: null };
    const session = new EditorSession();
    session.installProject(doc, 'red', null);
    expect(applyDistort(session, 'red', layer.transform, shape)).toBe(true);
    expect(session.history.undoName).toBe('Distort');
    expect(session.activeLayer!.transform.size).toEqual({ width: 50, height: 20 });
    expect(session.undo()).toBe(true);
    expect(session.activeLayer!.raster).toBe(raster);
  });

  it('CPU compositing reads a live WarpQuad instead of the affine layer rectangle', () => {
    const layer = newLayer({ id: 'smart', name: 'Smart Object', kind: 'embedded',
      content: { mode: 'embedded', mediaType: 'image', sourceName: 'smart.png', width: 4, height: 4 },
      raster: solid(4, 4, [20, 90, 220, 255]),
      transform: makeTransform({ x: 0, y: 0 }, { width: 8, height: 8 }, { sampling: 'Nearest' }),
      warp: { kind: 'quad', schemaVersion: 1,
        corners: [{ x: 1, y: 1 }, { x: 7, y: 0 }, { x: 5, y: 7 }, { x: 1, y: 6 }] } });
    const document: CanvasDocument = { id: 'warp', width: 8, height: 8, resolution: 72,
      layers: [layer], selection: null };
    const pixels = compositeRegion(document, { x: 0, y: 0, width: 8, height: 8 }).rgba;
    const alpha = (x: number, y: number) => pixels[(y * 8 + x) * 4 + 3];
    expect(alpha(3, 3)).toBe(255);
    expect(alpha(7, 7)).toBe(0);
    expect(alpha(0, 0)).toBe(0);
  });
});
