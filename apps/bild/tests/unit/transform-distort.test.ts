import { describe, expect, it } from 'vitest';
import { newLayer, type CanvasDocument, type LayerMask } from '../../src/core/document';
import { makeTransform, type LayerTransform, type Point } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';

function rgba(width: number, height: number): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([255, 0, 0, 255], i * 4);
  return Raster.fromPixels(width, height, 4, data);
}

function splitMask(width: number, height: number): Raster {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) data.fill(255, y * width, y * width + width / 2);
  return Raster.fromPixels(width, height, 1, data);
}

function layer(id: string, transform: LayerTransform, mask: LayerMask | null = null) {
  return newLayer({ id, name: id, transform, raster: rgba(4, 4), mask });
}

function install(session: EditorSession, layers: ReturnType<typeof layer>[], active: string): void {
  const document: CanvasDocument = { id: 'document', width: 100, height: 80, resolution: 72, layers, selection: null };
  session.installProject(document, active, null);
}

function distort(session: EditorSession, corners: readonly Point[]): void {
  session.beginTransform(false);
  session.beginDistort();
  session.previewCorners(corners);
  session.commitTransform();
}

describe('session distort mask parity (Distort.swift)', () => {
  it('commitTransform raster-distorts an attached linked mask and undo restores both sources', () => {
    const session = new EditorSession();
    const transform = makeTransform({ x: 10, y: 10 }, { width: 4, height: 4 });
    const sourceMask = splitMask(4, 4);
    const source = layer('source', transform,
      { raster: sourceMask, enabled: true, linked: true, placement: null });
    install(session, [source], source.id);
    const shape = [{ x: 10, y: 10 }, { x: 18, y: 10 }, { x: 18, y: 14 }, { x: 10, y: 14 }] as const;

    distort(session, shape);
    const result = session.activeLayer!;
    expect(session.history.undoName).toBe('Distort');
    expect(result.transform).toMatchObject({ origin: { x: 10, y: 10 }, size: { width: 8, height: 4 }, rotation: 0 });
    expect(result.raster).not.toBe(source.raster);
    expect(result.mask!.raster).not.toBe(sourceMask);
    expect(result.mask!.placement).toBeNull();
    expect(result.mask!.raster.width).toBe(result.raster!.width);
    expect(result.mask!.raster.height).toBe(result.raster!.height);
    expect(result.mask!.raster.pixel(1, 2)[0]).toBeGreaterThan(240);
    expect(result.mask!.raster.pixel(6, 2)[0]).toBeLessThan(15);

    expect(session.undo()).toBe(true);
    expect(session.activeLayer!.raster).toBe(source.raster);
    expect(session.activeLayer!.mask!.raster).toBe(sourceMask);
    expect(session.activeLayer!.transform).toEqual(transform);
  });

  it('commitTransform carries and warps a separately placed linked mask', () => {
    const session = new EditorSession();
    const transform = makeTransform({ x: 10, y: 10 }, { width: 4, height: 4 });
    const placement = makeTransform({ x: 20, y: 10 }, { width: 4, height: 4 });
    const sourceMask = splitMask(4, 4);
    const source = layer('source', transform,
      { raster: sourceMask, enabled: true, linked: true, placement });
    install(session, [source], source.id);

    distort(session, [{ x: 10, y: 10 }, { x: 18, y: 10 }, { x: 18, y: 14 }, { x: 10, y: 14 }]);
    const mask = session.activeLayer!.mask!;
    expect(mask.raster).not.toBe(sourceMask);
    expect(mask.placement).not.toBeNull();
    expect(mask.placement!.origin.x).toBeCloseTo(30);
    expect(mask.placement!.origin.y).toBeCloseTo(10);
    expect(mask.placement!.size).toEqual({ width: 8, height: 4 });
    expect(mask.raster.pixel(1, 2)[0]).toBeGreaterThan(240);
    expect(mask.raster.pixel(6, 2)[0]).toBeLessThan(15);
  });

  it('commitTransform leaves an independent mask raster fixed on the document', () => {
    const session = new EditorSession();
    const transform = makeTransform({ x: 10, y: 10 }, { width: 4, height: 4 });
    const sourceMask = splitMask(4, 4);
    const source = layer('source', transform,
      { raster: sourceMask, enabled: true, linked: false, placement: null });
    install(session, [source], source.id);

    distort(session, [{ x: 10, y: 10 }, { x: 18, y: 10 }, { x: 18, y: 14 }, { x: 10, y: 14 }]);
    expect(session.activeLayer!.mask!.raster).toBe(sourceMask);
    expect(session.activeLayer!.mask!.placement).toEqual(transform);
  });

  it('group distortion uses the group perspective and is named Distort Layers', () => {
    const session = new EditorSession();
    const leftTransform = makeTransform({ x: 10, y: 10 }, { width: 4, height: 4 });
    const rightTransform = makeTransform({ x: 20, y: 10 }, { width: 4, height: 4 });
    const left = layer('left', leftTransform,
      { raster: splitMask(4, 4), enabled: true, linked: true, placement: null });
    const right = layer('right', rightTransform);
    install(session, [left, right], right.id);
    session.selectLayers([left.id, right.id], right.id);
    session.beginTransform(false);
    session.beginDistort();
    session.previewCorners([{ x: 10, y: 10 }, { x: 31, y: 8 }, { x: 26, y: 18 }, { x: 10, y: 14 }]);
    session.commitTransform();

    expect(session.history.undoName).toBe('Distort Layers');
    expect(session.layer(left.id)!.raster).not.toBe(left.raster);
    expect(session.layer(left.id)!.mask!.raster).not.toBe(left.mask!.raster);
    expect(session.layer(right.id)!.raster).not.toBe(right.raster);
    expect(session.undo()).toBe(true);
    expect(session.layer(left.id)!.raster).toBe(left.raster);
    expect(session.layer(right.id)!.raster).toBe(right.raster);
  });

  it('distorting an independent mask alone uses its edge background', () => {
    const session = new EditorSession();
    const transform = makeTransform({ x: 0, y: 0 }, { width: 4, height: 4 });
    const darkEdges = new Uint8Array(16);
    darkEdges[5] = 255;
    const source = layer('source', transform, {
      raster: Raster.fromPixels(4, 4, 1, darkEdges), enabled: true, linked: false, placement: null,
    });
    install(session, [source], source.id);
    session.selectLayerTarget(source.id, true);

    distort(session, [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 6, y: 4 }, { x: 0, y: 4 }]);
    const mask = session.activeLayer!.mask!;
    expect(session.history.undoName).toBe('Distort Layer Mask');
    expect(mask.raster).not.toBe(source.mask!.raster);
    expect(mask.placement!.size).toEqual({ width: 8, height: 4 });
    expect(mask.raster.pixel(7, 3)[0]).toBe(0);
  });
});
