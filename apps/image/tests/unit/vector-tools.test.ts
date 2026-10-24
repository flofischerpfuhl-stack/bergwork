import { describe, expect, it } from 'vitest';
import { makeTransform, pixelToDocument, apply } from '../../src/core/geometry';
import { EditorSession } from '../../src/core/session';
import { rectanglePath } from '../../src/core/vector';
import { addPathLayer, addShapeLayer, withLayerPaths, fitDocumentPaths, translatePaths } from '../../src/app/vector/edits';
import { paddedTransform, stylePadding } from '../../src/app/vector/runtime';
import { hitPaths, linePath, shapeGeometry, deleteSelectedAnchors, nudgeSelectedAnchors } from '../../src/app/vector/tools';
import { pathTarget, selectedAnchors, shapeRecord, toolStyle, vectorState } from '../../src/app/vector/state';

const fill = { kind: 'solid' as const, schemaVersion: 1 as const, color: { red: 0, green: 0, blue: 0 } };

describe('vector tool geometry (PRODUCT-PLAN A5)', () => {
  it('pads the rendered grid by the stroke reach and keeps the layer centre', () => {
    expect(stylePadding({ fill, stroke: null })).toBe(0);
    const stroke = { color: { red: 0, green: 0, blue: 0 }, width: 10, alignment: 'inside' as const, join: 'round' as const };
    expect(stylePadding({ fill, stroke })).toBe(2);
    expect(stylePadding({ fill, stroke: { ...stroke, alignment: 'center' } })).toBe(7);
    expect(stylePadding({ fill, stroke: { ...stroke, alignment: 'outside' } })).toBe(12);
    expect(stylePadding({ fill: null, stroke: { ...stroke, alignment: 'center', endMarker: 'arrow', markerSize: 3 } })).toBe(42);
    const layer = { transform: makeTransform({ x: 10, y: 20 }, { width: 100, height: 50 }, { rotation: 30 }) } as never;
    const padded = paddedTransform(layer, makeTransform({ x: 10, y: 20 }, { width: 100, height: 50 }, { rotation: 30 }), 5);
    expect(padded.size).toEqual({ width: 110, height: 60 });
    expect(padded.origin.x + padded.size.width / 2).toBeCloseTo(60);
    expect(padded.origin.y + padded.size.height / 2).toBeCloseTo(45);
    // A pending resize scales the padding with the layer.
    const doubled = paddedTransform(layer, makeTransform({ x: 10, y: 20 }, { width: 200, height: 100 }), 5);
    expect(doubled.size).toEqual({ width: 220, height: 120 });
  });

  it('constrains shape drags: Shift squares, lines snap to 45°, Option/Alt draws from the centre', () => {
    expect(shapeGeometry('Rectangle', { x: 10, y: 10 }, { x: 50, y: 30 }, true, false).rect).toEqual({ x: 10, y: 10, width: 40, height: 40 });
    expect(shapeGeometry('Ellipse', { x: 50, y: 50 }, { x: 70, y: 60 }, false, true).rect).toEqual({ x: 30, y: 40, width: 40, height: 20 });
    const line = shapeGeometry('Line', { x: 0, y: 0 }, { x: 100, y: 10 }, true, false);
    expect(line.to.y).toBeCloseTo(0);
    expect(line.to.x).toBeCloseTo(Math.hypot(100, 10));
    const centred = shapeGeometry('Line', { x: 50, y: 50 }, { x: 60, y: 50 }, false, true);
    expect(centred.from).toEqual({ x: 40, y: 50 });
  });

  it('refits a shape layer around edited paths without moving them on the canvas', () => {
    const session = new EditorSession(); session.createNewProject(300, 200);
    const id = addPathLayer(session, [translatePaths([rectanglePath(40, 30)], 20, 10)[0]!], { fill, stroke: null }, 'Shape', 'Pen Path')!;
    const layer = session.layer(id)!;
    expect(layer.transform.origin).toEqual({ x: 20, y: 10 });
    expect(layer.transform.size).toEqual({ width: 40, height: 30 });
    // Drag the bottom-right anchor 30 px right and 20 px down (layer units): the box grows, the other anchors stay put.
    const paths = layer.kind === 'vector' ? layer.paths.map((path) => ({ ...path, points: path.points.map((point, i) => (i === 2
      ? { ...point, anchor: { x: 70, y: 50 }, in: { x: 70, y: 50 }, out: { x: 70, y: 50 } } : point)) })) : [];
    const refit = withLayerPaths(layer, paths);
    expect(refit.transform.size).toEqual({ width: 70, height: 50 });
    const map = pixelToDocument(refit.transform, 70, 50);
    const points = refit.kind === 'vector' ? refit.paths[0]!.points.map((point) => apply(map, point.anchor)) : [];
    expect(points[0]).toEqual({ x: 20, y: 10 });
    expect(points[2]).toEqual({ x: 90, y: 60 });
    expect(fitDocumentPaths([linePath({ x: 10, y: 5 }, { x: 60, y: 5 })])!.transform.size).toEqual({ width: 50, height: 1 });
  });

  it('hit-tests visible handles, then anchors, then segments', () => {
    const path = { closed: true, points: [
      { anchor: { x: 0, y: 0 }, in: { x: 0, y: 0 }, out: { x: 10, y: -10 }, kind: 'corner' as const },
      { anchor: { x: 50, y: 0 }, in: { x: 50, y: 0 }, out: { x: 50, y: 0 }, kind: 'corner' as const },
      { anchor: { x: 50, y: 50 }, in: { x: 50, y: 50 }, out: { x: 50, y: 50 }, kind: 'corner' as const },
    ] };
    expect(hitPaths([path], { x: 10, y: -9 }, 3, new Set())).toBeNull();
    expect(hitPaths([path], { x: 10, y: -9 }, 3, new Set(['0:0']))).toEqual({ kind: 'handle', path: 0, point: 0, handle: 'out' });
    expect(hitPaths([path], { x: 49, y: 1 }, 3, new Set())).toEqual({ kind: 'anchor', path: 0, point: 1 });
    expect(hitPaths([path], { x: 51, y: 25 }, 3, new Set())).toEqual({ kind: 'segment', path: 0, segment: 1 });
  });

  it('creates parametric shapes with the tool style, deletes and nudges anchors as single undo steps', () => {
    const session = new EditorSession(); session.createNewProject(300, 200);
    const state = vectorState(session);
    state.kind = 'Star'; state.points = 7; state.innerRatio = 0.4;
    const shape = shapeRecord(state, 'Star', { red: 0, green: 0, blue: 0 });
    const id = addShapeLayer(session, shape, { x: 10, y: 10, width: 100, height: 100 }, toolStyle(state, 'Star', { red: 0, green: 0, blue: 0 }), 'Star')!;
    const layer = session.layer(id)!;
    expect(layer).toMatchObject({ kind: 'vector', name: 'Star 1', sourceShape: { kind: 'Star', sides: 7, innerRatio: 0.4 } });
    expect(layer.kind === 'vector' ? layer.paths[0]!.points : []).toHaveLength(14);
    expect(pathTarget(session)?.layer.id).toBe(id);
    const undo = session.history.undoCount;
    selectedAnchors(session).add('0:0');
    expect(nudgeSelectedAnchors(session, 5, 0)).toBe(true);
    selectedAnchors(session).add('0:1');
    expect(deleteSelectedAnchors(session)).toBe(true);
    const edited = session.layer(id)!;
    expect(edited.kind === 'vector' ? edited.paths[0]!.points : []).toHaveLength(12);
    expect(edited.kind === 'vector' ? edited.sourceShape : 'x').toBeNull();
    expect(session.history.undoCount).toBe(undo + 2);
    session.undo(); session.undo();
    expect(session.layer(id)).toMatchObject({ sourceShape: { kind: 'Star' } });
  });
});
