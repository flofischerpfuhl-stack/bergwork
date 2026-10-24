import { describe, expect, it } from 'vitest';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import { hierarchyEntries, isValidStructure } from '../../src/core/document';
import { quarterTurned, rotateCanvasDocument, trimRect } from '../../src/core/imageCommands';
import { boundingBox, makeTransform, type LayerTransform } from '../../src/core/geometry';

const box = (t: LayerTransform) => Object.fromEntries(Object.entries(boundingBox(t)).map(([k, v]) => [k, Math.round(v * 1e6) / 1e6 + 0]));

function solid(width: number, height: number, rgba: number[]): Raster {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) pixels.set(rgba, i * 4);
  return Raster.fromPixels(width, height, 4, pixels);
}

describe('Rotate Canvas 90° (CanvasRotation.swift)', () => {
  it('turns a placement with the canvas and keeps it on whole pixels', () => {
    // A 4×2 layer at the top-left of a 10×6 canvas.
    const t = makeTransform({ x: 0, y: 0 }, { width: 4, height: 2 });
    expect(box(quarterTurned(t, true, 10, 6))).toEqual({ x: 4, y: 0, width: 2, height: 4 });
    expect(box(quarterTurned(t, false, 10, 6))).toEqual({ x: 0, y: 6, width: 2, height: 4 });
    expect(quarterTurned(t, true, 10, 6).rotation).toBe(90);
  });

  it('swaps the canvas size and turns guides, artboards and the selection', () => {
    const session = new EditorSession();
    session.createNewProject(10, 6);
    const doc = { ...session.document!,
      guides: [{ id: 'v', orientation: 'vertical' as const, position: 3 }, { id: 'h', orientation: 'horizontal' as const, position: 1 }],
      selection: { mask: Raster.fromPixels(2, 1, 1, new Uint8Array([255, 0])), x: 1, y: 0, antialiased: false } };
    const turned = rotateCanvasDocument(doc, true);
    expect([turned.width, turned.height]).toEqual([6, 10]);
    expect(turned.guides).toEqual([{ id: 'v', orientation: 'horizontal', position: 3 }, { id: 'h', orientation: 'vertical', position: 5 }]);
    // Selected pixel (1,0) moves to (5,1) on the turned canvas.
    const s = turned.selection!;
    expect([s.x, s.y, s.mask.width, s.mask.height]).toEqual([5, 1, 1, 2]);
    expect([...s.mask.toPixelsNative()]).toEqual([255, 0]);
    const back = rotateCanvasDocument(turned, false);
    expect(back.guides).toEqual(doc.guides);
    expect([back.selection!.x, back.selection!.y]).toEqual([1, 0]);
  });

  it('is one undo step, 180° included', () => {
    const session = new EditorSession();
    session.createNewProject(10, 6);
    session.rotateCanvas(true);
    expect([session.document!.width, session.document!.height]).toEqual([6, 10]);
    session.undo();
    expect([session.document!.width, session.document!.height]).toEqual([10, 6]);
    session.rotateCanvas180();
    expect([session.document!.width, session.document!.height]).toEqual([10, 6]);
    expect(Math.abs(session.document!.layers[0]!.transform.rotation)).toBe(180);
    session.undo();
    expect(session.document!.layers[0]!.transform.rotation).toBe(0);
  });
});

describe('Trim (ImageTrim.swift)', () => {
  const canvas = () => {
    // 6×5, transparent except a 2×2 block at (2,1) and a white top row.
    const pixels = new Uint8Array(6 * 5 * 4);
    for (let x = 0; x < 6; x++) pixels.set([255, 255, 255, 255], x * 4);
    for (const [x, y] of [[2, 1], [3, 1], [2, 2], [3, 2]] as const) pixels.set([200, 0, 0, 255], (y * 6 + x) * 4);
    return Raster.fromPixels(6, 5, 4, pixels);
  };
  it('trims transparent edges, only on the chosen sides', () => {
    expect(trimRect(canvas())).toEqual({ x: 0, y: 0, width: 6, height: 3 });
    expect(trimRect(canvas(), { basedOn: 'transparent', top: true, bottom: false, left: true, right: true })).toEqual({ x: 0, y: 0, width: 6, height: 5 });
  });
  it('trims edges of the top-left colour, and finds nothing left in a solid image', () => {
    const solidWhite = solid(3, 3, [255, 255, 255, 255]);
    expect(trimRect(solidWhite, { basedOn: 'topLeft', top: true, bottom: true, left: true, right: true })).toBeNull();
    expect(trimRect(canvas(), { basedOn: 'topLeft', top: true, bottom: true, left: true, right: true })).toEqual({ x: 0, y: 1, width: 6, height: 4 });
  });
});

describe('Ungroup Layers', () => {
  it('puts a folder’s children in its place, in order, and selects them', () => {
    const session = new EditorSession();
    session.createNewProject(10, 10);
    const a = session.insertRaster(solid(1, 1, [1, 1, 1, 255]), 'a');
    const b = session.insertRaster(solid(1, 1, [2, 2, 2, 255]), 'b');
    session.insertRaster(solid(1, 1, [3, 3, 3, 255]), 'c');
    session.selectLayers([a, b], b);
    session.groupSelectedLayers();
    expect(session.canUngroupLayers).toBe(true);
    session.ungroupLayers();
    const rows = hierarchyEntries(session.document!.layers, true).map((e) => `${'  '.repeat(e.depth)}${e.layer.name}`);
    expect(rows).toEqual(['c', 'b', 'a', 'Layer 1']);
    expect(isValidStructure(session.document!.layers)).toBe(true);
    expect([...session.selectedLayerIds].sort()).toEqual([a, b].sort());
    session.undo();
    expect(hierarchyEntries(session.document!.layers, true).map((e) => e.layer.name)).toEqual(['c', 'Folder 1', 'b', 'a', 'Layer 1']);
  });
});
