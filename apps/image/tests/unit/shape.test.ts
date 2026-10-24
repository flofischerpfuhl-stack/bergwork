import { describe, expect, it } from 'vitest';
import { makeTransform } from '../../src/core/geometry';
import { newLayer } from '../../src/core/document';
import { EditorSession } from '../../src/core/session';
import {
  beginShape, cancelShape, commitShape, currentShapeDraft, rasterizeShape, redrawShapeLayer, shapeDragRect, updateShape,
  type LayerShapeStyle,
} from '../../src/core/shape';

describe('shape tool (ShapeToolTests.swift)', () => {
  it('rectangleFillsANewLayerWithTheForegroundColorAsOneUndoStep', () => {
    const session = new EditorSession();
    session.createNewProject(100, 80);
    session.tool = 'shape';
    session.foregroundColor = { red: 1, green: 0, blue: 0 };
    const count = session.history.undoCount;
    beginShape(session, { x: 10, y: 10 }, 'Rectangle');
    updateShape(session, { x: 40, y: 30 });
    const id = commitShape(session)!;
    expect(session.document!.layers.map((layer) => layer.name)).toEqual(['Layer 1', 'Rectangle 1']);
    expect(session.history.undoCount).toBe(count + 1);
    expect(session.layer(id)!.transform).toMatchObject({ origin: { x: 10, y: 10 }, size: { width: 30, height: 20 } });
    expect(session.layer(id)!.raster!.pixel(0, 0)).toEqual([255, 0, 0, 255]);
    expect(session.layer(id)!.kind).toBe('vector');
    expect(session.layer(id)!.sourceShape).toEqual({ kind: 'Rectangle', red: 1, green: 0, blue: 0, cornerRadius: 0 });
    session.undo();
    expect(session.document!.layers.map((layer) => layer.name)).toEqual(['Layer 1']);
  });

  it('ellipseLeavesItsCornersClearWithShiftCircleAndOptionFromCenter', () => {
    expect(shapeDragRect({ x: 50, y: 40 }, { x: 60, y: 45 }, true, true))
      .toEqual({ x: 40, y: 30, width: 20, height: 20 });
    const ellipse = rasterizeShape('Ellipse', 20, 20, { red: 1, green: 0, blue: 0 });
    expect(ellipse.pixel(10, 10)).toEqual([255, 0, 0, 255]);
    expect(ellipse.pixel(0, 0)[3]).toBe(0);
    expect(ellipse.pixel(19, 19)[3]).toBe(0);
    expect(ellipse.pixel(1, 10)[3]).toBeGreaterThan(0);
  });

  it('aClickEscapeMakesNoLayer', () => {
    const session = new EditorSession();
    session.createNewProject(100, 80);
    session.tool = 'shape';
    beginShape(session, { x: 20, y: 20 });
    expect(commitShape(session)).toBeNull();
    beginShape(session, { x: 20, y: 20 });
    updateShape(session, { x: 50, y: 50 });
    expect(currentShapeDraft(session)!.rect).toEqual({ x: 20, y: 20, width: 30, height: 30 });
    expect(cancelShape(session)).toBe(true);
    expect(session.document!.layers).toHaveLength(1);
  });

  it('roundedRectanglesFollowTheRadiusAndClampToAPill', () => {
    const rounded = rasterizeShape('Rectangle', 40, 30, { red: 1, green: 0, blue: 0 }, 8);
    expect(rounded.pixel(0, 0)[3]).toBe(0);
    expect(rounded.pixel(1, 1)[3]).toBe(0);
    expect(rounded.pixel(3, 3)[3]).toBe(255);
    expect(rounded.pixel(20, 0)[3]).toBe(255);
    const pill = rasterizeShape('Rectangle', 40, 20, { red: 1, green: 0, blue: 0 }, 500);
    expect(pill.pixel(0, 0)[3]).toBe(0);
    expect(pill.pixel(20, 10)).toEqual([255, 0, 0, 255]);
  });

  it('redrawShape keeps corners crisp and its document-pixel radius fixed after scale', () => {
    const style: LayerShapeStyle = { kind: 'Rectangle', red: 1, green: 0, blue: 0, cornerRadius: 5 };
    const layer = newLayer({ id: 'shape', name: 'Rectangle 1', kind: 'vector', sourceShape: style,
      raster: rasterizeShape('Rectangle', 20, 10, { red: 1, green: 0, blue: 0 }, 5),
      transform: makeTransform({ x: 0, y: 0 }, { width: 80, height: 40 }) });
    const redrawn = redrawShapeLayer(layer);
    expect(redrawn.raster).not.toBe(layer.raster);
    expect(redrawn.raster).toMatchObject({ width: 80, height: 40 });
    expect(redrawn.raster!.pixel(0, 0)[3]).toBe(0);
    expect(redrawn.raster!.pixel(5, 0)[3]).toBe(255);
    expect(redrawn.kind === 'vector' ? redrawn.sourceShape : null).toBe(style);
  });

  it('EditorSession redrawShape runs when a live shape is scaled and pixel edits end liveness', () => {
    const session = new EditorSession();
    session.createNewProject(100, 80);
    session.tool = 'shape';
    beginShape(session, { x: 10, y: 10 }, 'Rectangle', 5);
    updateShape(session, { x: 30, y: 20 });
    const id = commitShape(session)!;
    session.beginTransform();
    session.previewTransform({ ...session.transformEdit!.draft, size: { width: 80, height: 40 } });
    session.commitTransform();
    expect(session.layer(id)!.raster).toMatchObject({ width: 80, height: 40 });
    expect(session.layer(id)!.kind).toBe('vector');
    session.replaceLayerPixels(id, rasterizeShape('Ellipse', 80, 40, { red: 0, green: 0, blue: 1 }), 'Paint');
    expect(session.layer(id)!.kind).toBe('pixel');
  });
});
