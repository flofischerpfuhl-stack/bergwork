import { describe, expect, it } from 'vitest';
import { makeTransform, type Point } from '../../src/core/geometry';
import { newLayer } from '../../src/core/document';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import {
  DEFAULT_BRUSH_SETTINGS, beginBrushStroke, beginStroke, cancelBrushStroke, currentBrushPreview,
  currentCpuBrushPreview, currentGpuBrushPreview, extendBrushStroke, finishBrushStroke,
} from '../../src/core/brush';

function sessionWithLayer(mask = false): EditorSession {
  const session = new EditorSession();
  session.createDocument(512, 512);
  const raster = Raster.blank(512, 512, 4);
  const layer = newLayer({ id: 'paint', name: 'Paint', raster,
    transform: makeTransform({ x: 0, y: 0 }, { width: 512, height: 512 }),
    mask: mask ? { raster: Raster.solidMask(true), enabled: true, linked: true, placement: null } : null });
  session.replaceDocument({ ...session.document!, layers: [layer] });
  session.selectLayerTarget(layer.id, mask);
  session.tool = 'brush';
  return session;
}

describe('geometry-only GPU brush preview (MetalBrushCoverage.swift)', () => {
  it('records settled segments and a replaceable tail without changing document pixels', () => {
    const session = sessionWithLayer();
    const source = session.activeLayer!.raster;
    const points: Point[] = [{ x: 40, y: 50 }, { x: 100, y: 75 }, { x: 180, y: 40 }];
    beginBrushStroke(session, points[0]!, { settings: { ...DEFAULT_BRUSH_SETTINGS, diameter: 80, hardness: 0 } });
    extendBrushStroke(session, points[1]!);
    extendBrushStroke(session, points[2]!);
    const preview = currentGpuBrushPreview(session)!;
    expect(preview.settled.length).toBeGreaterThan(1);
    expect(preview.tail).toHaveLength(1);
    expect(preview.tail[0]).toMatchObject({ x0: 100, y0: 75, x1: 180, y1: 40 });
    expect(session.activeLayer!.raster).toBe(source);
    cancelBrushStroke(session);
  });

  it('materializes an exact immutable CPU snapshot on demand and commits one undo step', () => {
    const session = sessionWithLayer();
    const settings = { ...DEFAULT_BRUSH_SETTINGS, diameter: 54, hardness: 0.35, opacity: 0.7,
      red: 0.8, green: 0.2, blue: 0.4 };
    const points = [{ x: 30, y: 80 }, { x: 100, y: 110 }, { x: 220, y: 60 }, { x: 310, y: 130 }];
    beginBrushStroke(session, points[0]!, { settings });
    for (let i = 1; i < points.length; i++) extendBrushStroke(session, points[i]!);
    const snapshot = currentBrushPreview(session)!;
    const expected = beginStroke({ layer: currentGpuBrushPreview(session)!.layer, canvas: { width: 512, height: 512 }, settings });
    for (const point of points) expected.addPoints([point]);
    const expectedSnapshot = expected.currentRaster();
    expect(snapshot.raster.readRegion(0, 0, 512, 512)).toEqual(expectedSnapshot.readRegion(0, 0, 512, 512));
    const oldTile = snapshot.raster.tiles.find((tile) => tile !== null)?.slice();
    const undo = session.history.undoCount;
    finishBrushStroke(session);
    expect(session.history.undoCount).toBe(undo + 1);
    expect(oldTile).toEqual(snapshot.raster.tiles.find((tile) => tile !== null));
  });

  it('uses GPU geometry for attached masks and caches immutable selections in the preview', () => {
    const maskSession = sessionWithLayer(true);
    beginBrushStroke(maskSession, { x: 100, y: 100 });
    expect(currentGpuBrushPreview(maskSession)?.target).toBe('mask');
    cancelBrushStroke(maskSession);

    const selected = sessionWithLayer();
    const selection = {
      mask: Raster.fromPixels(2, 2, 1, new Uint8Array(4).fill(255)), x: 0, y: 0, antialiased: false,
    } as const;
    selected.replaceDocument({ ...selected.document!, selection });
    beginBrushStroke(selected, { x: 1, y: 1 });
    expect(currentGpuBrushPreview(selected)?.selection).toBe(selection);
    expect(currentCpuBrushPreview(selected)).toBeNull();
    cancelBrushStroke(selected);
  });
});
