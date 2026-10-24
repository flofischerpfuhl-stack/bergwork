import { describe, expect, it } from 'vitest';
import { InMemoryPixelClipboard, copyMergedSelection, layerViaCopy, paste } from '../../src/core/clipboard';
import { flattenDocument } from '../../src/core/composite';
import { newLayer, type CanvasDocument } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import {
  applySelection, beginSelectionMove, beginSelectionTransform, deleteKeyPressed, deselect, endSelectionMove,
  invertSelection, loadLayerSelection, loadMaskSelection, nudgeSelection, previewSelectionMove, selectAll,
} from '../../src/core/selectionCommands';
import {
  dragBoxRect, ellipseSelection, polygonSelection, rectangleSelection, selectionBounds, selectionCoverage,
} from '../../src/core/selectionOps';
import { EditorSession } from '../../src/core/session';
import { createMainThreadKernelClient } from '../../src/workers/kernelClient';
import { DEFAULT_WAND_SETTINGS, magicWand, WAND_MOVES_EXISTING_SELECTION } from '../../src/core/wand';

function raster(width: number, height: number, pixel: (x: number, y: number) => readonly [number, number, number, number]): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  return Raster.fromPixels(width, height, 4, data);
}

function selectionSession(): EditorSession {
  const source = raster(100, 40, (x) => x < 50 ? [255, 0, 0, 255] : [0, 0, 255, 255]);
  const layer = newLayer({ id: 'base', name: 'Base', raster: source,
    transform: makeTransform({ x: 0, y: 0 }, { width: 100, height: 40 }) });
  const document: CanvasDocument = { id: 'document', width: 100, height: 40, resolution: 72, layers: [layer], selection: null };
  const session = new EditorSession({ flatten: async (doc) => flattenDocument(doc), bakeLiveMask: async () => null });
  session.installProject(document, layer.id, null);
  return session;
}

describe('upstream SelectionTests engine cases', () => {
  it('modifiersPickModeAndSelectionIsClippedToCanvas (combination engine)', () => {
    const session = selectionSession();
    const clipped = polygonSelection([{ x: -50, y: -50 }, { x: 50, y: -50 }, { x: 50, y: 50 }, { x: -50, y: 50 }], session.document!);
    expect(applySelection(session, clipped, 'New', 'Lasso')).toBe(true);
    expect(selectionBounds(session.selection!)).toEqual({ x: 0, y: 0, width: 50, height: 40 });
    const add = rectangleSelection({ x: 45, y: 0, width: 20, height: 10 }, session.document!);
    applySelection(session, add, 'Add', 'Lasso');
    expect(selectionBounds(session.selection!)).toEqual({ x: 0, y: 0, width: 65, height: 40 });
    applySelection(session, rectangleSelection({ x: 0, y: 0, width: 10, height: 40 }, session.document!), 'Subtract', 'Lasso');
    expect(selectionBounds(session.selection!)).toEqual({ x: 10, y: 0, width: 55, height: 40 });
  });

  it('clickDeselectsAndSelectionStepsUndo', () => {
    const session = selectionSession(), count = session.history.undoCount;
    applySelection(session, rectangleSelection({ x: 10, y: 10, width: 40, height: 20 }, session.document!), 'New', 'Lasso');
    expect(session.history.undoCount).toBe(count + 1);
    expect(deselect(session)).toBe(true);
    expect(session.selection).toBeNull();
    session.undo();
    expect(selectionBounds(session.selection!)).toEqual({ x: 10, y: 10, width: 40, height: 20 });
    session.undo(); expect(session.selection).toBeNull();
    session.redo();
    expect(selectionCoverage(session.selection!, { x: 30, y: 20, width: 1, height: 1 })[0]).toBe(255);
  });

  it('selectAllInverseAndToolSwitchCancelsDraft (selection command portion)', () => {
    const session = selectionSession();
    expect(selectAll(session)).toBe(true);
    expect(selectionBounds(session.selection!)).toEqual({ x: 0, y: 0, width: 100, height: 40 });
    expect(invertSelection(session)).toBe(true);
    expect(selectionBounds(session.selection!)).toBeNull();
    session.undo();
    expect(selectionBounds(session.selection!)).toEqual({ x: 0, y: 0, width: 100, height: 40 });
  });

  it('movingOffCanvasAndBackKeepsTheWholeShape', () => {
    const session = selectionSession();
    applySelection(session, rectangleSelection({ x: 10, y: 10, width: 20, height: 20 }, session.document!), 'New', 'Lasso');
    expect(beginSelectionMove(session)).toBe(true);
    previewSelectionMove(session, -50, 0);
    expect(selectionBounds(session.selection!)).toEqual({ x: -40, y: 10, width: 20, height: 20 });
    previewSelectionMove(session, 30, 0);
    expect(selectionBounds(session.selection!)).toEqual({ x: 40, y: 10, width: 20, height: 20 });
    expect(endSelectionMove(session)).toBe(true);
    session.undo();
    expect(selectionBounds(session.selection!)).toEqual({ x: 10, y: 10, width: 20, height: 20 });
  });

  it('arrowNudgesAndMoveIsOnlyForNewModeOnARealSelection (nudge engine)', () => {
    const session = selectionSession();
    expect(nudgeSelection(session, 1, 0)).toBe(false);
    applySelection(session, rectangleSelection({ x: 10, y: 10, width: 20, height: 20 }, session.document!), 'New', 'Lasso');
    expect(nudgeSelection(session, 1, -2)).toBe(true);
    expect(selectionBounds(session.selection!)).toEqual({ x: 11, y: 8, width: 20, height: 20 });
    expect(session.history.undoName).toBe('Move Selection');
  });

  it('cmdClickingAMaskSelectsItsBlackAreas and cmdClickingALayerSelectsItsOpaquePixels', () => {
    const session = selectionSession();
    const alpha = raster(4, 1, (x) => [255, 0, 0, x < 2 ? 255 : 0]);
    const mask = Raster.fromPixels(4, 1, 1, Uint8Array.from([255, 128, 0, 255]));
    session.replaceDocument({ ...session.document!, width: 4, height: 1, layers: [newLayer({
      id: 'thumb', name: 'Thumb', raster: alpha, transform: makeTransform({ x: 0, y: 0 }, { width: 4, height: 1 }),
      mask: { raster: mask, enabled: true, linked: true, placement: null },
    })] });
    session.selectLayer('thumb');
    expect(loadLayerSelection(session, 'thumb', 'New', false)).toBe(true);
    expect([...selectionCoverage(session.selection!, { x: 0, y: 0, width: 4, height: 1 })]).toEqual([255, 255, 0, 0]);
    expect(loadMaskSelection(session, 'thumb', 'New', false)).toBe(true);
    expect([...selectionCoverage(session.selection!, { x: 0, y: 0, width: 4, height: 1 })]).toEqual([0, 0, 255, 0]);
  });

  it('marqueeDrawsWholePixelRectanglesInAnyDirection', () => {
    const canvas = { width: 100, height: 100 };
    // Selection.beginLasso rounds the marquee anchor before DragBox.rect sees it.
    for (const [a, b] of [[{ x: 60, y: 71 }, { x: 20.2, y: 30.3 }], [{ x: 20, y: 30 }, { x: 60.4, y: 70.6 }]] as const) {
      const selection = rectangleSelection(dragBoxRect(a, b), canvas, false);
      expect(selectionBounds(selection)).toEqual({ x: 20, y: 30, width: 40, height: 41 });
    }
  });

  it('marqueeShiftMakesSquaresAndCenteredDragsGrowFromTheAnchor', () => {
    expect(dragBoxRect({ x: 20, y: 20 }, { x: 40, y: 30 }, true, false)).toEqual({ x: 20, y: 20, width: 20, height: 20 });
    expect(dragBoxRect({ x: 20, y: 20 }, { x: 40, y: 30 }, false, true)).toEqual({ x: 0, y: 10, width: 40, height: 20 });
    expect(dragBoxRect({ x: 20, y: 20 }, { x: 40, y: 30 }, true, true)).toEqual({ x: 0, y: 0, width: 40, height: 40 });
  });
});

describe('upstream SelectionEditTests and SelectionClipboardTests', () => {
  it('deletingWithTheMaskTargetedRemovesOnlyTheMask', () => {
    const session = selectionSession();
    session.addLayerMask();
    const pixels = session.activeLayer!.raster;
    session.selectLayerTarget('base', true);
    expect(deleteKeyPressed(session)).toBe(true);
    expect(session.activeLayer!.mask).toBeNull();
    expect(session.activeLayer!.raster).toBe(pixels);
    expect(session.history.undoName).toBe('Delete Layer Mask');
  });

  it('layerViaCopyCopiesTheSelectionOrDuplicatesTheLayer', () => {
    const session = selectionSession();
    applySelection(session, rectangleSelection({ x: 5, y: 5, width: 10, height: 10 }, session.document!), 'New', 'Select');
    const copied = layerViaCopy(session)!;
    expect(session.layer(copied)!.transform.origin).toEqual({ x: 5, y: 5 });
    expect(session.layer(copied)!.raster).toMatchObject({ width: 10, height: 10 });
    expect(session.history.undoName).toBe('Layer via Copy');
    session.undo(); deselect(session);
    const duplicate = layerViaCopy(session)!;
    expect(session.layer(duplicate)!.raster).toBe(session.layer('base')!.raster);
    expect(session.history.undoName).toBe('Duplicate Layer');
  });

  it('applyingAnUnchangedTransformLeavesSoftEdgesUntouched', () => {
    const session = selectionSession();
    const soft = ellipseSelection({ x: 10.3, y: 5.7, width: 30, height: 25 }, session.document!, true);
    applySelection(session, soft, 'New', 'Select');
    const before = session.document, count = session.history.undoCount;
    expect(beginSelectionTransform(session)).toBe(true);
    session.commitTransform();
    expect(session.document).toBe(before);
    expect(session.history.undoCount).toBe(count);
  });

  it('lassoShapedSelectionCopiesAndPastes', async () => {
    const session = selectionSession();
    const triangle = polygonSelection([{ x: 10, y: 5 }, { x: 40, y: 5 }, { x: 10, y: 35 }], session.document!, true);
    applySelection(session, triangle, 'New', 'Lasso');
    const id = layerViaCopy(session)!;
    const pasted = session.layer(id)!;
    expect(pasted.transform.origin).toEqual({ x: 10, y: 5 });
    expect(pasted.raster!.pixel(5, 5)).toEqual([255, 0, 0, 255]);
    expect(pasted.raster!.pixel(28, 28)[3]).toBe(0);
  });

  it('copyMergedTakesEveryVisibleLayerNotJustTheActiveOne', async () => {
    const session = selectionSession();
    const green = session.insertRaster(raster(20, 20, () => [0, 255, 0, 255]), 'Green', { x: 70, y: 20 });
    applySelection(session, rectangleSelection({ x: 55, y: 5, width: 30, height: 30 }, session.document!), 'New', 'Select');
    const clipboard = new InMemoryPixelClipboard();
    expect(await copyMergedSelection(session, clipboard)).toBe(true);
    expect(clipboard.entry!.raster.pixel(3, 3)).toEqual([0, 0, 255, 255]);
    expect(clipboard.entry!.raster.pixel(10, 10)).toEqual([0, 255, 0, 255]);
    expect(await paste(session, clipboard)).not.toBeNull();
    session.undo();
    session.selectLayer(green); session.toggleLayerVisibility(green);
    expect(await copyMergedSelection(session, clipboard)).toBe(true);
    expect(clipboard.entry!.raster.pixel(10, 10)).toEqual([0, 0, 255, 255]);
  });

  it('clickingInsideASelectionMakesANewWandSelectionRatherThanDeselecting', async () => {
    const session = selectionSession();
    applySelection(session, rectangleSelection({ x: 0, y: 0, width: 100, height: 40 }, session.document!), 'New', 'Select');
    expect(WAND_MOVES_EXISTING_SELECTION).toBe(false);
    const kernels = createMainThreadKernelClient();
    await magicWand(session, { x: 10, y: 10 }, 'New', { ...DEFAULT_WAND_SETTINGS, tolerance: 0 }, kernels);
    expect(selectionBounds(session.selection!)).toEqual({ x: 0, y: 0, width: 50, height: 40 });
    kernels.destroy();
  });
});
