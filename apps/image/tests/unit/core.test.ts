import { describe, expect, it } from 'vitest';
import {
  apply, dragUpdated, following, makeTransform, mirrored, pixelToDocument, placing, unitToDocument, snapOffset,
} from '../../src/core/geometry';
import { Raster, TILE, alphaBounds } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import { hierarchyEntries, isValidStructure, newLayer, releaseDetachedClipping, renderLayers } from '../../src/core/document';

function solid(width: number, height: number, rgba: [number, number, number, number]): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return Raster.fromPixels(width, height, 4, data);
}

describe('geometry (LayerTransform.swift)', () => {
  it('maps the pixel grid through centre, rotation, scale and flips', () => {
    const t = makeTransform({ x: 10, y: 20 }, { width: 200, height: 100 }, { rotation: 90, flipX: true });
    const m = pixelToDocument(t, 100, 50);
    const c = apply(m, { x: 50, y: 25 });
    expect(c.x).toBeCloseTo(110);
    expect(c.y).toBeCloseTo(70);
    // (-50,-25) scaled by (-2,2) is (100,-50); turned 90° clockwise (50,100); plus the centre.
    const corner = apply(m, { x: 0, y: 0 });
    expect(corner.x).toBeCloseTo(160);
    expect(corner.y).toBeCloseTo(170);
  });

  it('placing() recovers a transform from its own unit map', () => {
    const t = makeTransform({ x: -5, y: 7 }, { width: 30, height: 12 }, { rotation: 33, flipY: true });
    const recovered = placing(t, unitToDocument(t));
    expect(recovered.size.width).toBeCloseTo(30);
    expect(recovered.size.height).toBeCloseTo(12);
    expect(recovered.rotation).toBeCloseTo(33);
    expect(recovered.flipY).toBe(true);
    expect(recovered.origin.x).toBeCloseTo(-5);
  });

  it('following() carries a plain move exactly', () => {
    const mask = makeTransform({ x: 3, y: 4 }, { width: 10, height: 10 });
    const from = makeTransform({ x: 0, y: 0 }, { width: 50, height: 50 });
    const to = makeTransform({ x: 7, y: -2 }, { width: 50, height: 50 });
    expect(following(mask, from, to).origin).toEqual({ x: 10, y: 2 });
  });

  it('resizing from a corner with the ratio locked scales about the opposite corner', () => {
    const original = makeTransform({ x: 0, y: 0 }, { width: 100, height: 50 });
    const result = dragUpdated({ original, start: { x: 100, y: 50 }, mode: { kind: 'resize', handle: 4 } }, { x: 200, y: 100 }, true, false);
    expect(result.size.width).toBeCloseTo(200);
    expect(result.size.height).toBeCloseTo(100);
    expect(result.origin).toEqual({ x: 0, y: 0 });
  });

  it('mirroring twice restores the placement', () => {
    const t = makeTransform({ x: 5, y: 6 }, { width: 20, height: 10 }, { rotation: 12 });
    const back = mirrored(mirrored(t, true, 50), true, 50);
    expect(back.origin.x).toBeCloseTo(5);
    expect(back.rotation).toBeCloseTo(12);
    expect(back.flipX).toBe(false);
  });

  it('snaps the nearest edge within tolerance', () => {
    const snap = snapOffset({ x: 3, y: 0, width: 10, height: 10 }, [0, 50], [100], 5);
    expect(snap.dx).toBe(-3);
    expect(snap.x).toBe(0);
    expect(snap.dy).toBe(0);
  });
});

describe('Raster', () => {
  it('shares untouched tiles on region writes', () => {
    const base = solid(TILE * 2 + 5, TILE + 1, [10, 20, 30, 255]);
    const edited = base.withRegion(0, 0, 2, 2, new Uint8Array(16).fill(200));
    expect(edited.tiles[0]).not.toBe(base.tiles[0]);
    expect(edited.tiles[1]).toBe(base.tiles[1]);
    expect(edited.pixel(1, 1)).toEqual([200, 200, 200, 200]);
    expect(base.pixel(1, 1)).toEqual([10, 20, 30, 255]);
    expect(edited.readRegion(TILE * 2 + 4, TILE, 1, 1)).toEqual(new Uint8Array([10, 20, 30, 255]));
  });

  it('finds tight alpha bounds', () => {
    const blank = Raster.blank(300, 300, 4);
    const dot = blank.withRegion(270, 5, 2, 3, new Uint8Array(24).fill(255));
    expect(alphaBounds(dot)).toEqual({ x: 270, y: 5, width: 2, height: 3 });
    expect(alphaBounds(blank)).toBeNull();
  });
});

describe('EditorSession (EditorSession.swift, LayerGroups.swift)', () => {
  it('imports, undoes and redoes as one step each', () => {
    const session = new EditorSession();
    session.createNewProject(20, 10);
    const id = session.insertRaster(solid(4, 4, [255, 0, 0, 255]), 'red');
    expect(session.document!.layers.map((l) => l.name)).toEqual(['Layer 1', 'red']);
    expect(session.layer(id)!.transform.origin).toEqual({ x: 8, y: 3 });
    expect(session.undo()).toBe(true);
    expect(session.document!.layers).toHaveLength(1);
    expect(session.redo()).toBe(true);
    expect(session.document!.layers).toHaveLength(2);
    expect(session.activeLayerId).toBe(id);
  });

  it('groups the selection into a folder at the topmost branch', () => {
    const session = new EditorSession();
    session.createNewProject(10, 10);
    const a = session.insertRaster(solid(1, 1, [1, 1, 1, 255]), 'a');
    const b = session.insertRaster(solid(1, 1, [2, 2, 2, 255]), 'b');
    session.insertRaster(solid(1, 1, [3, 3, 3, 255]), 'c');
    session.selectLayers([a, b], b);
    session.groupSelectedLayers();
    const rows = hierarchyEntries(session.document!.layers, true).map((e) => `${'  '.repeat(e.depth)}${e.layer.name}`);
    expect(rows).toEqual(['c', 'Folder 1', '  b', '  a', 'Layer 1']);
    expect(isValidStructure(session.document!.layers)).toBe(true);
  });

  it('hides a folder’s contents from compositing without changing their flags', () => {
    const session = new EditorSession();
    session.createNewProject(10, 10);
    const a = session.insertRaster(solid(1, 1, [1, 1, 1, 255]), 'a');
    session.selectLayers([a], a);
    session.groupSelectedLayers();
    const folder = session.activeLayerId!;
    session.toggleLayerVisibility(folder);
    expect(renderLayers(session.document!.layers).map((l) => l.name)).toEqual(['Layer 1']);
    expect(session.layer(a)!.visible).toBe(true);
  });

  it('clips to the layer below and releases the stack above a released base', () => {
    const session = new EditorSession();
    session.createNewProject(10, 10);
    const base = session.insertRaster(solid(1, 1, [1, 1, 1, 255]), 'base');
    const one = session.insertRaster(solid(1, 1, [2, 2, 2, 255]), 'one');
    const two = session.insertRaster(solid(1, 1, [3, 3, 3, 255]), 'two');
    session.toggleClippingMask(one);
    session.toggleClippingMask(two);
    expect(session.layer(one)!.maskSourceId).toBe(base);
    expect(session.layer(two)!.maskSourceId).toBe(base);
    session.removeLiveMask(one);
    expect(session.layer(one)!.maskSourceId).toBeNull();
    expect(session.layer(two)!.maskSourceId).toBeNull();
  });

  it('releases a clipped layer moved out of its contiguous stack', () => {
    const layers = [
      newLayer({ id: 'base', name: 'base', transform: makeTransform({ x: 0, y: 0 }, { width: 1, height: 1 }) }),
      newLayer({ id: 'other', name: 'other', transform: makeTransform({ x: 0, y: 0 }, { width: 1, height: 1 }) }),
      newLayer({ id: 'clipped', name: 'clipped', maskSourceId: 'base', transform: makeTransform({ x: 0, y: 0 }, { width: 1, height: 1 }) }),
    ];
    releaseDetachedClipping(layers);
    expect(layers[2]!.maskSourceId).toBeNull();
  });

  it('commits a transform as one undo step and carries a linked placed mask', () => {
    const session = new EditorSession();
    session.createNewProject(100, 100);
    const id = session.insertRaster(solid(10, 10, [9, 9, 9, 255]), 'img');
    session.beginTransform();
    session.previewTransform({ ...session.transformEdit!.draft, origin: { x: 60, y: 50 } });
    session.commitTransform();
    expect(session.layer(id)!.transform.origin).toEqual({ x: 60, y: 50 });
    expect(session.history.undoName).toBe('Transform Layer');
    session.undo();
    expect(session.layer(id)!.transform.origin).toEqual({ x: 45, y: 45 });
  });

  it('flip canvas mirrors every layer across the middle', () => {
    const session = new EditorSession();
    session.createNewProject(100, 50);
    const id = session.insertRaster(solid(10, 10, [9, 9, 9, 255]), 'img', { x: 15, y: 25 });
    session.flipCanvas(true);
    const t = session.layer(id)!.transform;
    expect(t.origin.x).toBe(80);
    expect(t.flipX).toBe(true);
  });
});
