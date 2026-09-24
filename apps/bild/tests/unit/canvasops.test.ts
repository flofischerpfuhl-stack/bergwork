import { describe, expect, it } from 'vitest';
import {
  applyCanvasSize, applyCrop, applyCropRatio, applyCropSnap, canvasOffset, canvasSizeDraftValid,
  createCropRect, cropDocument, displayedCanvasDimension, displayedImageDimension, imageSizeDraftValid,
  makeCanvasSizeDraft, resizeCanvas, resizeImage, setCanvasDimension, setImageDimension, setImageResample,
  setImageResolution, snapCropRect, tryResizeCanvas, updateCropDrag,
  type ImageSizeDraft,
} from '../../src/core/canvasOps';
import { makeTransform, type Rect } from '../../src/core/geometry';
import { newLayer, type CanvasDocument } from '../../src/core/document';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';

function rgba(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  return Raster.fromPixels(width, height, 4, data);
}

function document(width = 64, height = 32): CanvasDocument {
  const raster = rgba(width, height, (x, y) => [x, y, 50, 255]);
  const mask = Raster.fromPixels(width, height, 1, new Uint8Array(width * height).fill(255));
  return {
    id: 'doc', width, height, resolution: 72, selection: { mask: Raster.solidMask(true), x: 2, y: 3, antialiased: false },
    layers: [newLayer({ id: 'layer', name: 'Layer', raster, transform: makeTransform({ x: 0, y: 0 }, { width, height }),
      mask: { raster: mask, enabled: true, linked: false,
        placement: makeTransform({ x: 5, y: 6 }, { width, height }) } })],
  };
}

describe('Crop.swift geometry', () => {
  it('ports dragGeometrySupportsReverseRatioMoveAndEveryHandle', () => {
    const rect = createCropRect({ x: 100, y: 100 }, { x: 20, y: 60 }, 2);
    expect(rect).toEqual({ x: 20, y: 60, width: 80, height: 40 });
    const move = { start: { x: 40, y: 70 }, original: rect, mode: { kind: 'move' as const } };
    expect(updateCropDrag(move, { x: 30, y: 40 }, null)).toEqual({ x: 10, y: 30, width: 80, height: 40 });
    for (let handle = 0; handle < 8; handle++) {
      const units = [[0, 0], [.5, 0], [1, 0], [1, .5], [1, 1], [.5, 1], [0, 1], [0, .5]] as const;
      const unit = units[handle]!;
      const start = { x: rect.x + unit[0] * rect.width, y: rect.y + unit[1] * rect.height };
      const next = updateCropDrag({ start, original: rect, mode: { kind: 'resize', handle } },
        { x: start.x + (unit[0] * 2 - 1) * 20, y: start.y + (unit[1] * 2 - 1) * 10 }, 2);
      expect(next.width / next.height).toBeCloseTo(2, 1);
      expect(next).not.toEqual(rect);
    }
    expect(snapCropRect({ x: 10.6, y: 9.5, width: -5, height: -3 })).toEqual({ x: 6, y: 7, width: 5, height: 3 });
  });

  it('ports cropEdgesSnapToNearbyEdges and ratio choices', () => {
    const snap = { xs: [0, 200, 50, 150], ys: [0, 100, 20, 80], tolerance: 6 };
    const original: Rect = { x: 10, y: 10, width: 60, height: 40 };
    const move = { start: { x: 30, y: 30 }, original, mode: { kind: 'move' as const } };
    const movedTo = { x: 26, y: 34 };
    expect(applyCropSnap(updateCropDrag(move, movedTo, null), move, movedTo, null, snap))
      .toEqual({ x: 0, y: 20, width: 60, height: 40 });
    const resize = { start: { x: 70, y: 50 }, original, mode: { kind: 'resize' as const, handle: 4 } };
    const near = { x: 146, y: 83 };
    expect(applyCropSnap(updateCropDrag(resize, near, null), resize, near, null, snap))
      .toEqual({ x: 10, y: 10, width: 140, height: 70 });
    expect(applyCropRatio({ x: 0, y: 0, width: 160, height: 100 }, 16 / 9))
      .toEqual({ x: 0, y: 5, width: 160, height: 90 });
  });
});

describe('CanvasResizer.swift', () => {
  it('ports everyAnchorPreservesSourceAndTransformForExpansionAndShrink', () => {
    const doc = document();
    const source = doc.layers[0]!.raster;
    for (const delta of [5, -5]) for (let anchor = 0; anchor <= 8; anchor++) {
      const output = resizeCanvas(doc, 64 + delta, 32 + delta, anchor as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8);
      const expected = [0, delta === 5 ? 2 : -3, delta];
      expect(output.layers[0]!.transform.origin).toEqual({ x: expected[anchor % 3]!, y: expected[Math.floor(anchor / 3)]! });
      expect(output.layers[0]!.raster).toBe(source);
      expect(output.layers[0]!.mask!.placement!.origin).toEqual({ x: 5 + expected[anchor % 3]!, y: 6 + expected[Math.floor(anchor / 3)]! });
      expect(output.selection).toBeNull();
    }
    expect(canvasOffset(59, 27, 64, 32, 4)).toEqual({ x: -3, y: -3 });
  });

  it('ports relativeRatioAndUnitsUseFinalDimensions', () => {
    let draft = { ...makeCanvasSizeDraft(1000, 500, 100), relative: true, locked: true };
    draft = setCanvasDimension(draft, 200, true);
    expect([draft.width, draft.height, displayedCanvasDimension(draft, false)]).toEqual([1200, 600, 100]);
    draft = setCanvasDimension(draft, -250, false);
    expect([draft.width, draft.height]).toEqual([500, 250]);
    draft = { ...draft, relative: false, unit: 'Inches' };
    draft = setCanvasDimension(draft, 10, true);
    expect([draft.width, draft.height]).toEqual([1000, 500]);
    draft = { ...draft, unit: 'Percent' };
    draft = setCanvasDimension(draft, 50, true);
    expect([draft.width, draft.height]).toEqual([500, 250]);
    draft = { ...draft, unit: 'Centimeters' };
    expect(displayedCanvasDimension(draft, true)).toBeCloseTo(12.7);
    expect(canvasSizeDraftValid({ ...draft, width: 0 })).toBe(false);
  });

  it('creates only the colored extension and reports typed limit errors', () => {
    const doc = { ...document(4, 4), layers: [] };
    const output = resizeCanvas(doc, 8, 2, 4, { fill: { red: 1, green: 0, blue: 0 } });
    const extension = output.layers[0]!.raster!;
    expect(extension.pixel(0, 0)).toEqual([255, 0, 0, 255]);
    expect(extension.pixel(3, 0)).toEqual([0, 0, 0, 0]);
    expect(extension.pixel(7, 1)).toEqual([255, 0, 0, 255]);
    expect(tryResizeCanvas(doc, 0, 2).ok).toBe(false);
  });

  it('cropTranslatesWithoutResamplingAndUndoRestoresBounds', () => {
    const doc = document();
    const source = doc.layers[0]!.raster;
    const cropped = cropDocument(doc, { x: 8, y: 4, width: 32, height: 16 });
    expect([cropped.width, cropped.height]).toEqual([32, 16]);
    expect(cropped.layers[0]!.transform.origin).toEqual({ x: -8, y: -4 });
    expect(cropped.layers[0]!.raster).toBe(source);

    const session = new EditorSession();
    session.installProject(doc, 'layer', null);
    expect(applyCrop(session, { x: 8, y: 4, width: 32, height: 16 })).toBe(true);
    expect(session.history.undoName).toBe('Crop');
    expect(session.undo()).toBe(true);
    expect(session.document).toBe(doc);
    expect(applyCanvasSize(session, 70, 40, 0)).toBe(true);
    expect(session.history.undoName).toBe('Canvas Size');
  });
});

describe('ImageResizer.swift', () => {
  it('resizePreservesLayerIdentityAndUndoRestoresSource with nearest pixels', () => {
    const doc = document(4, 2);
    const output = resizeImage(doc, 8, 6, 300, 'Nearest');
    expect([output.width, output.height, output.resolution]).toEqual([8, 6, 300]);
    expect(output.layers[0]!.id).toBe('layer');
    expect(output.layers[0]!.raster!.width).toBe(8);
    expect(output.layers[0]!.raster!.height).toBe(6);
    expect(output.layers[0]!.raster!.pixel(0, 0)).toEqual([0, 0, 50, 255]);
    expect(output.layers[0]!.raster!.pixel(7, 5)).toEqual([3, 1, 50, 255]);
    expect(output.layers[0]!.mask!.raster.width).toBe(4); // Placed masks keep their pixels.
    expect(output.layers[0]!.mask!.placement!.origin).toEqual({ x: 10, y: 18 });
  });

  it('resolutionOnlyRetainsPixels and high filtering avoids transparent colour bleed', () => {
    const doc = document(2, 1);
    const resolution = resizeImage(doc, 2, 1, 300, false);
    expect(resolution.layers).toBe(doc.layers);
    expect(resolution.resolution).toBe(300);
    const edge = rgba(2, 1, (x) => x === 0 ? [255, 0, 0, 255] : [0, 255, 0, 0]);
    const alphaDoc: CanvasDocument = { id: 'a', width: 2, height: 1, resolution: 72, selection: null,
      layers: [newLayer({ id: 'a', name: 'a', raster: edge, transform: makeTransform({ x: 0, y: 0 }, { width: 2, height: 1 }) })] };
    const enlarged = resizeImage(alphaDoc, 8, 4, 72, 'High quality').layers[0]!.raster!;
    const transition = enlarged.pixel(3, 2);
    expect(transition[0]).toBeGreaterThan(200);
    expect(transition[1]).toBeLessThan(10);
  });

  it('ports ImageSizeSheet unit, proportion, resolution, and resample-toggle semantics', () => {
    let draft: ImageSizeDraft = { width: 1000, height: 500, resolution: 100, locked: true, resample: true, unit: 'Percent' };
    expect(displayedImageDimension(draft, 1000, true)).toBe(100);
    draft = setImageDimension(draft, 50, 1000, true);
    expect([draft.width, draft.height]).toEqual([500, 250]);
    let physical: ImageSizeDraft = { ...draft, unit: 'Inches' };
    physical = setImageResolution(physical, 200);
    expect([physical.width, physical.height]).toEqual([1000, 500]);
    physical = setImageResample(physical, false, 1000, 500);
    physical = setImageDimension(physical, 5, 1000, true);
    expect(physical.resolution).toBe(200);
    expect(imageSizeDraftValid(physical)).toBe(true);
  });

  it('resamples an owned mask with its layer but preserves group metadata', () => {
    const base = document(4, 2);
    const mask = Raster.fromPixels(4, 2, 1, Uint8Array.from([255, 0, 0, 0, 0, 0, 0, 255]));
    const pixel = { ...base.layers[0]!, parentId: 'group', mask: { raster: mask, enabled: false, linked: true, placement: null } };
    const group = newLayer({ id: 'group', name: 'Folder', kind: 'group', visible: false, opacity: .4,
      transform: makeTransform({ x: 0, y: 0 }, { width: 4, height: 2 }) });
    const output = resizeImage({ ...base, layers: [group, pixel] }, 8, 4, 72, 'Nearest');
    expect(output.layers[0]!.kind).toBe('group');
    expect(output.layers[0]!.visible).toBe(false);
    expect(output.layers[0]!.opacity).toBe(.4);
    expect(output.layers[1]!.mask!.raster.pixel(0, 0)).toEqual([255]);
    expect(output.layers[1]!.mask!.raster.pixel(7, 3)).toEqual([255]);
    expect(output.layers[1]!.mask!.enabled).toBe(false);
  });

  it('rotatedHiddenLayerScalesInDocumentAxesAndInvalidSizeIsRejected', () => {
    const base = document();
    const layer = { ...base.layers[0]!, visible: false,
      transform: makeTransform({ x: -16, y: 4 }, { width: 64, height: 32 }, { rotation: 90 }) };
    const output = resizeImage({ ...base, layers: [layer] }, 128, 96, 72, 'Nearest').layers[0]!;
    expect(output.visible).toBe(false);
    expect(output.transform.rotation).toBe(0);
    expect(Math.abs(output.transform.size.width - 64)).toBeLessThanOrEqual(1);
    expect(Math.abs(output.transform.size.height - 192)).toBeLessThanOrEqual(1);
    expect(() => resizeImage(base, 30_000, 30_000, 72)).toThrow(/100-megapixel/);
  });
});
