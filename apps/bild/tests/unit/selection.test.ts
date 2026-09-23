import { describe, expect, it } from 'vitest';
import { newLayer, type CanvasDocument } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import {
  combineSelection, contractSelection, ellipseSelection, expandSelection, moveSelection, polygonSelection,
  rectangleSelection, selectionBounds, selectionContains, selectionCoverage, selectionOutline,
} from '../../src/core/selectionOps';
import {
  addMaskFromSelection, applySelection, beginSelectionTransform, clearSelectedPixels, displayedSelection, fillSelection,
  invertPixels, loadLayerSelection,
} from '../../src/core/selectionCommands';
import { InMemoryPixelClipboard, copySelection, cutSelection, paste } from '../../src/core/clipboard';

function solid(width: number, height: number, rgba: readonly [number, number, number, number]): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return Raster.fromPixels(width, height, 4, data);
}

function sessionWith(raster: Raster, width = raster.width, height = raster.height): EditorSession {
  const session = new EditorSession();
  const layer = newLayer({ id: 'pixels', name: 'Pixels', raster,
    transform: makeTransform({ x: 0, y: 0 }, { width: raster.width, height: raster.height }) });
  const document: CanvasDocument = { id: 'document', width, height, resolution: 72, layers: [layer], selection: null };
  session.installProject(document, layer.id, null);
  return session;
}

describe('selection geometry (SelectionTests.swift)', () => {
  it('replaceAddAndSubtractCombineOutlines and keeps explicit empty distinct', () => {
    const canvas = { width: 100, height: 100 };
    let selection = rectangleSelection({ x: 10, y: 10, width: 40, height: 40 }, canvas);
    selection = combineSelection(selection, rectangleSelection({ x: 50, y: 50, width: 40, height: 40 }, canvas), 'Add', canvas)!;
    expect(selectionCoverage(selection, { x: 30, y: 30, width: 1, height: 1 })[0]).toBe(255);
    expect(selectionCoverage(selection, { x: 70, y: 70, width: 1, height: 1 })[0]).toBe(255);
    selection = combineSelection(selection, rectangleSelection({ x: 0, y: 0, width: 100, height: 100 }, canvas), 'Subtract', canvas)!;
    expect(selectionBounds(selection)).toBeNull();
    expect(combineSelection(null, rectangleSelection({ x: 0, y: 0, width: 10, height: 10 }, canvas), 'Subtract', canvas)).toBeNull();
  });

  it('antialiasingControlsEdgeCoverage and outline is closed', () => {
    const canvas = { width: 100, height: 100 };
    const triangle = polygonSelection([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }], canvas, true);
    const edge = selectionCoverage(triangle, { x: 0, y: 99, width: 100, height: 1 });
    expect([...edge].some((v) => v > 0 && v < 255)).toBe(true);
    const hard = polygonSelection([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }], canvas, false);
    expect([...selectionCoverage(hard, { x: 0, y: 99, width: 100, height: 1 })].every((v) => v === 0 || v === 255)).toBe(true);
    const outlines = selectionOutline(hard);
    expect(outlines.length).toBe(1);
    expect(outlines[0]![0]).toEqual(outlines[0]!.at(-1));
  });

  it('elliptical marquee, move, expand and contract follow document pixels', () => {
    const canvas = { width: 100, height: 100 };
    const ellipse = ellipseSelection({ x: 10, y: 20, width: 60, height: 40 }, canvas, true);
    expect(selectionCoverage(ellipse, { x: 40, y: 40, width: 1, height: 1 })[0]).toBe(255);
    expect(selectionCoverage(ellipse, { x: 10, y: 20, width: 1, height: 1 })[0]).toBeLessThan(128);
    const box = rectangleSelection({ x: 40, y: 40, width: 20, height: 20 }, canvas);
    expect(selectionBounds(expandSelection(box, 5, canvas))).toEqual({ x: 35, y: 35, width: 30, height: 30 });
    expect(selectionBounds(contractSelection(box, 3, canvas))).toEqual({ x: 43, y: 43, width: 14, height: 14 });
    const moved = moveSelection(box, -60, 0);
    expect(selectionBounds(moved)).toEqual({ x: -20, y: 40, width: 20, height: 20 });
    expect(selectionContains(moved, { x: -15, y: 45 })).toBe(true);
  });
});

describe('selection pixel edits (SelectionEditTests.swift)', () => {
  it('fill, clear and invert stay inside a selection', () => {
    const session = sessionWith(solid(10, 4, [255, 0, 0, 255]));
    applySelection(session, rectangleSelection({ x: 0, y: 0, width: 5, height: 4 }, session.document!), 'New', 'Select');
    session.foregroundColor = { red: 0, green: 0, blue: 1 };
    expect(fillSelection(session, 'foreground')).toBe(true);
    expect(session.activeLayer!.raster!.pixel(2, 2)).toEqual([0, 0, 255, 255]);
    expect(session.activeLayer!.raster!.pixel(8, 2)).toEqual([255, 0, 0, 255]);
    expect(invertPixels(session)).toBe(true);
    expect(session.activeLayer!.raster!.pixel(2, 2)).toEqual([255, 255, 0, 255]);
    expect(clearSelectedPixels(session)).toBe(true);
    expect(session.activeLayer!.raster!.pixel(2, 2)[3]).toBe(0);
    expect(session.activeLayer!.raster!.pixel(8, 2)[3]).toBe(255);
  });

  it('maps selection through a scaled layer transform and creates masks with upstream polarity', () => {
    const session = sessionWith(solid(4, 4, [255, 0, 0, 255]), 8, 8);
    session.replaceDocument({ ...session.document!, layers: session.document!.layers.map((l) => ({ ...l,
      transform: makeTransform({ x: 0, y: 0 }, { width: 8, height: 8 }) })) });
    applySelection(session, rectangleSelection({ x: 0, y: 0, width: 4, height: 8 }, session.document!), 'New', 'Select');
    session.foregroundColor = { red: 0, green: 1, blue: 0 };
    fillSelection(session, 'foreground');
    expect(session.activeLayer!.raster!.pixel(0, 2)).toEqual([0, 255, 0, 255]);
    expect(session.activeLayer!.raster!.pixel(3, 2)).toEqual([255, 0, 0, 255]);
    expect(addMaskFromSelection(session, true)).toBe(true);
    expect(session.selection).toBeNull();
    expect(session.activeLayer!.mask!.raster.pixel(0, 2)[0]).toBe(0);
    expect(session.activeLayer!.mask!.raster.pixel(3, 2)[0]).toBe(255);
    expect(session.history.undoName).toBe('Add Mask from Selection');
  });

  it('loadLayerSelection traces alpha at the 50 percent threshold', () => {
    const data = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) { data[i * 4] = 10; data[i * 4 + 3] = i < 8 ? 127 : 128; }
    const session = sessionWith(Raster.fromPixels(4, 4, 4, data));
    expect(loadLayerSelection(session, 'pixels', 'New', false)).toBe(true);
    expect(selectionBounds(session.selection!)).toEqual({ x: 0, y: 2, width: 4, height: 2 });
    expect(session.history.undoName).toBe('Load Layer Selection');
  });
});

describe('clipboard and floating selection (SelectionClipboardTests.swift)', () => {
  it('copy/paste returns pixels in place and cut leaves a hole', async () => {
    const session = sessionWith(solid(10, 4, [255, 0, 0, 255]));
    applySelection(session, rectangleSelection({ x: 2, y: 1, width: 4, height: 2 }, session.document!), 'New', 'Select');
    const clipboard = new InMemoryPixelClipboard();
    expect(copySelection(session, clipboard)).toBe(true);
    expect(await paste(session, clipboard)).not.toBeNull();
    expect(session.activeLayer!.transform.origin).toEqual({ x: 2, y: 1 });
    session.undo();
    expect(cutSelection(session, clipboard)).toBe(true);
    expect(session.layer('pixels')!.raster!.pixel(3, 2)[3]).toBe(0);
  });

  it('floating transform moves pixels and selection in one undo step; cancel restores identity', () => {
    const session = sessionWith(solid(10, 4, [255, 0, 0, 255]), 20, 10);
    applySelection(session, rectangleSelection({ x: 1, y: 1, width: 2, height: 2 }, session.document!), 'New', 'Select');
    const before = session.document, count = session.history.undoCount;
    expect(beginSelectionTransform(session)).toBe(true);
    session.previewTransform({ ...session.transformEdit!.draft, origin: { x: 12, y: 5 } });
    expect(selectionBounds(displayedSelection(session)!)).toEqual({ x: 12, y: 5, width: 2, height: 2 });
    session.commitTransform();
    expect(session.history.undoName).toBe('Transform Selection');
    expect(session.history.undoCount).toBe(count + 1);
    expect(session.layer('pixels')!.raster!.pixel(1, 1)[3]).toBe(0);
    expect(selectionBounds(session.selection!)).toEqual({ x: 12, y: 5, width: 2, height: 2 });
    session.undo();
    expect(session.document).toBe(before);

    expect(beginSelectionTransform(session)).toBe(true);
    session.cancelTransform();
    expect(session.document).toBe(before);
    expect(session.history.undoCount).toBe(count);
  });
});
