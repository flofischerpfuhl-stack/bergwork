import { describe, expect, it } from 'vitest';
import { compositeRegion } from '../../src/core/composite';
import { documentPointToLayerPixel } from '../../src/core/brush/commands';
import { newLayer, type CanvasDocument, type Layer, type LayerMask } from '../../src/core/document';
import {
  HANDLES, center, dragUpdated, makeTransform, scalePercent, scaledToPercent, unitPoint,
  type LayerTransform, type Point,
} from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import { MoveTool, overlayGeometry, type Modifiers, type ToolContext } from '../../src/ui/canvas/tools';
import { decodePng } from '../../src/io/png';
import { readArchive, writeArchive } from '../../src/io/project';

function solid(width: number, height: number, rgba: readonly [number, number, number, number]): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return Raster.fromPixels(width, height, 4, data);
}

function documentWith(layers: readonly Layer[], width = 400, height = 200): CanvasDocument {
  return { id: 'document', width, height, resolution: 72, layers, selection: null };
}

function rasterLayer(id: string, transform: LayerTransform, raster = solid(
  Math.round(transform.size.width), Math.round(transform.size.height), [255, 0, 0, 255],
), mask: LayerMask | null = null): Layer {
  return newLayer({ id, name: id, transform, raster, mask });
}

function install(session: EditorSession, layers: readonly Layer[], active = layers.at(-1)?.id ?? null,
  width = 400, height = 200): void {
  session.installProject(documentWith(layers, width, height), active, null);
}

function near(a: Point, b: Point, precision = 8): void {
  expect(a.x).toBeCloseTo(b.x, precision);
  expect(a.y).toBeCloseTo(b.y, precision);
}

const noModifiers: Modifiers = { shift: false, option: false, command: false, control: false };

function context(session: EditorSession, pixel: Point, modifiers: Modifiers = noModifiers): ToolContext {
  return {
    session, point: pixel, pixel, modifiers, pointerType: 'mouse', pressure: null, distortArmed: false,
    redraw: () => undefined, setCursor: () => undefined,
  };
}

function clickMove(session: EditorSession, pixel: Point, modifiers: Modifiers = noModifiers): void {
  const tool = new MoveTool();
  const c = context(session, pixel, modifiers);
  tool.down(c);
  tool.up(c);
}

function dragMove(session: EditorSession, from: Point, to: Point, modifiers: Modifiers = noModifiers): void {
  const tool = new MoveTool();
  tool.down(context(session, from, modifiers));
  tool.move(context(session, { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, modifiers));
  tool.move(context(session, to, modifiers));
  tool.up(context(session, to, modifiers));
}

describe('EditorSession transforms (TransformTests.swift)', () => {
  it('duplicateTransformPreservesOriginalAndSupportsUndoAndCancel', () => {
    const session = new EditorSession();
    const original = rasterLayer('original', makeTransform({ x: 0, y: 0 }, { width: 400, height: 200 }));
    install(session, [original]);
    const count = session.history.undoCount;

    session.beginDuplicateTransform();
    const moved = { ...original.transform, origin: { x: 50, y: 0 } };
    session.previewTransform(moved);
    session.commitTransform();
    expect(session.document!.layers).toHaveLength(2);
    expect(session.document!.layers[0]!.transform).toEqual(original.transform);
    expect(session.activeLayer!.transform).toEqual(moved);
    expect(session.history.undoCount).toBe(count + 1);
    expect(session.undo()).toBe(true);
    expect(session.document!.layers).toHaveLength(1);
    expect(session.activeLayerId).toBe(original.id);

    session.beginDuplicateTransform();
    session.previewTransform(moved);
    session.cancelTransform();
    expect(session.document!.layers).toHaveLength(1);
    expect(session.activeLayerId).toBe(original.id);
    expect(session.history.undoCount).toBe(count);
  });

  it('autoSelectCanBeDisabledAndCommandClickOverridesIt — session-level part', () => {
    const session = new EditorSession();
    const first = rasterLayer('first', makeTransform({ x: 0, y: 0 }, { width: 100, height: 100 }));
    const second = rasterLayer('second', makeTransform({ x: 250, y: 0 }, { width: 100, height: 100 }));
    install(session, [first, second], first.id);
    session.viewport.resize({ width: 400, height: 200 }, 1, session.document);
    session.viewport.setZoom(1, { x: 200, y: 100 }, session.document!);

    expect(session.transformAutoSelect).toBe(false);
    session.transformAutoSelect = true;
    clickMove(session, { x: 300, y: 50 });
    expect(session.activeLayerId).toBe(second.id);
    session.selectLayer(first.id);
    session.transformAutoSelect = false;
    clickMove(session, { x: 300, y: 50 });
    expect(session.activeLayerId).toBe(first.id);
    clickMove(session, { x: 300, y: 50 }, { ...noModifiers, command: true });
    expect(session.activeLayerId).toBe(second.id);
    expect(session.transformAutoSelect).toBe(false);
  });

  it('blankLayersHaveNoTransformHandlesOrEditing', () => {
    const session = new EditorSession();
    session.createNewProject(100, 100);
    expect(session.canTransform).toBe(false);
    expect(overlayGeometry(session)).toBeNull();
    session.beginTransform();
    expect(session.transformEdit).toBeNull();
    session.insertRaster(solid(100, 100, [255, 0, 0, 255]), 'Painted layer');
    expect(session.canTransform).toBe(true);
    expect(overlayGeometry(session)).not.toBeNull();
  });

  it('rotatedResizeKeepsOppositeAnchorAtEveryHandle', () => {
    const original = makeTransform({ x: 31, y: -19 }, { width: 200, height: 100 }, { rotation: 37 });
    HANDLES.forEach((handle, index) => {
      const opposite = { x: 1 - handle.x, y: 1 - handle.y };
      const start = unitPoint(original, handle);
      for (const locked of [true, false]) {
        const changed = dragUpdated({ original, start, mode: { kind: 'resize', handle: index } },
          { x: start.x + 34, y: start.y + 17 }, locked, false);
        near(unitPoint(original, opposite), unitPoint(changed, opposite), 4);
        if (locked) expect(changed.size.width / changed.size.height).toBeCloseTo(2, 4);
      }
    });
  });

  it('moveRotateAndShiftConstraints', () => {
    const original = makeTransform({ x: 0, y: 0 }, { width: 100, height: 50 });
    const moved = dragUpdated({ original, start: { x: 40, y: 20 }, mode: { kind: 'move' } },
      { x: 60, y: 25 }, true, true);
    expect(moved.origin).toEqual({ x: 20, y: 0 });
    const rotate = { original, start: { x: 100, y: 25 }, mode: { kind: 'rotate' } as const };
    const rotated = dragUpdated(rotate, { x: 50, y: 75 }, true, false);
    expect(rotated.rotation).toBeCloseTo(90, 4);
    expect(center(rotated)).toEqual(center(original));
    const snapped = dragUpdated(rotate, { x: 99, y: 45 }, true, true);
    expect(snapped.rotation % 15).toBe(0);
    const free = dragUpdated({ original, start: { x: 100, y: 50 }, mode: { kind: 'resize', handle: 4 } },
      { x: 150, y: 50 }, true, true);
    expect(free.size).toEqual({ width: 150, height: 50 });
  });

  it('previewCommitCancelAndUndoPreserveSources', () => {
    const session = new EditorSession();
    const original = rasterLayer('original', makeTransform({ x: 0, y: 0 }, { width: 200, height: 100 }));
    install(session, [original], original.id, 200, 100);
    const count = session.history.undoCount;
    const value = makeTransform({ x: -45, y: 34 }, { width: 80, height: 140 }, { rotation: 23, flipX: true });
    session.beginTransform();
    for (let i = 0; i < 30; i++) session.previewTransform(value);
    expect(session.activeLayer).toBe(original);
    expect(session.activeLayer!.raster).toBe(original.raster);
    expect(session.history.undoCount).toBe(count);
    session.cancelTransform();
    expect(session.activeLayer).toBe(original);
    session.beginTransform();
    session.previewTransform(value);
    session.commitTransform();
    expect(session.history.undoCount).toBe(count + 1);
    expect(session.activeLayer!.transform).toEqual(value);
    expect(session.activeLayer!.raster).toBe(original.raster);
    expect(session.undo()).toBe(true);
    expect(session.activeLayer).toBe(original);
    expect(session.redo()).toBe(true);
    expect(session.activeLayer!.transform).toEqual(value);
    expect(session.activeLayer!.raster).toBe(original.raster);
    expect(session.activeLayerId).toBe(original.id);
  });

  it('scalePercentSetsBothSidesAboutTheCenter', () => {
    const session = new EditorSession();
    const source = rasterLayer('source', makeTransform({ x: 0, y: 0 }, { width: 400, height: 200 }));
    install(session, [source], source.id);
    const pixels = session.transformPixelSize!;
    const stretched = makeTransform({ x: 0, y: 0 }, { width: 800, height: 600 }, { rotation: 30 });
    expect(scalePercent(stretched, pixels)).toBe(200);
    const scaled = scaledToPercent(stretched, 50, pixels);
    expect(scaled.size).toEqual({ width: 200, height: 100 });
    near(center(scaled), center(stretched), 3);
    expect(scaled.rotation).toBe(30);
    expect(scalePercent(scaled, pixels)).toBe(50);
  });

  it('noOpInvalidValuesAndSwitchingTools', () => {
    const session = new EditorSession();
    const layer = rasterLayer('painted', makeTransform({ x: 0, y: 0 }, { width: 200, height: 100 }));
    install(session, [layer], layer.id, 200, 100);
    const count = session.history.undoCount;
    session.beginTransform();
    session.commitTransform();
    expect(session.history.undoCount).toBe(count);
    session.beginTransform();
    session.previewTransform({ ...session.transformEdit!.draft, size: { width: 0, height: 100 } });
    expect(session.transformEdit!.draft.size.width).toBe(200);
    session.previewTransform({ ...session.transformEdit!.draft, size: { width: Number.POSITIVE_INFINITY, height: 100 } });
    expect(session.transformEdit!.draft.size.width).toBe(200);
    session.previewTransform({ ...session.transformEdit!.draft, origin: { x: 10, y: 0 } });
    session.selectTool('hand');
    expect(session.transformEdit).toBeNull();
    expect(session.activeLayer!.transform.origin.x).toBe(10);
    expect(session.history.undoCount).toBe(count + 1);
  });
});

describe('Move-tool presses (TransformPressTests.swift)', () => {
  function pressSession(): EditorSession {
    const session = new EditorSession();
    const layer = rasterLayer('red', makeTransform({ x: 150, y: 100 }, { width: 100, height: 100 }));
    install(session, [layer], layer.id, 400, 300);
    session.viewport.resize({ width: 400, height: 300 }, 1, session.document);
    session.viewport.setZoom(1, { x: 200, y: 150 }, session.document!);
    session.selectTool('move');
    return session;
  }

  it('draggingOutsideTheLayerMovesIt', () => {
    const session = pressSession();
    // Control isolates press targeting from snapping; browser pointer coordinates otherwise land
    // exactly on the 10 px snap boundary that AppKit's converted coordinates narrowly miss.
    dragMove(session, { x: 20, y: 20 }, { x: 40, y: 30 }, { ...noModifiers, control: true });
    expect(session.transformEdit).toBeNull();
    expect(session.activeLayer!.transform.origin).toEqual({ x: 170, y: 110 });
  });

  it('optionDraggingOutsideTheLayerDuplicatesIt', () => {
    const session = pressSession();
    dragMove(session, { x: 20, y: 20 }, { x: 40, y: 30 }, { ...noModifiers, option: true, control: true });
    expect(session.document!.layers.map((layer) => layer.transform.origin)).toEqual([
      { x: 150, y: 100 }, { x: 170, y: 110 },
    ]);
  });
});

describe('independent masks (MaskTransformTests.swift)', () => {
  const layerTransform = makeTransform({ x: 0, y: 0 }, { width: 400, height: 200 });

  function maskRaster(revealing = true): Raster {
    const data = new Uint8Array(400 * 200).fill(revealing ? 255 : 0);
    for (let y = 50; y < 150; y++) data.fill(revealing ? 0 : 255, y * 400 + 100, y * 400 + 200);
    return Raster.fromPixels(400, 200, 1, data);
  }

  function maskedSession(revealing = true): EditorSession {
    const mask = { raster: maskRaster(revealing), enabled: true, placement: null, linked: true };
    const layer = rasterLayer('layer', layerTransform, solid(400, 200, [255, 0, 0, 255]), mask);
    const session = new EditorSession();
    install(session, [layer], layer.id);
    return session;
  }

  function move(session: EditorSession, dx: number): LayerTransform {
    session.beginTransform();
    const moved = { ...session.transformEdit!.draft,
      origin: { x: session.transformEdit!.draft.origin.x + dx, y: session.transformEdit!.draft.origin.y } };
    session.previewTransform(moved);
    return moved;
  }

  function alpha(session: EditorSession, x: number, y: number): number {
    return compositeRegion(session.document!, { x, y, width: 1, height: 1 }).rgba[3]!;
  }

  it('unlinkedTheLayerMovesAloneAndItsMaskStaysOnTheCanvas', () => {
    const session = maskedSession();
    const original = session.activeLayer!;
    session.toggleMaskLink(original.id);
    session.selectLayerTarget(original.id, false);
    const moved = move(session, 100);
    expect(session.displayedMaskPlacement(session.activeLayer!)).toEqual(original.transform);
    session.commitTransform();
    const after = session.activeLayer!;
    expect(after.transform).toEqual(moved);
    expect(after.mask!.placement).toEqual(original.transform);
    expect(after.mask!.raster).toBe(original.mask!.raster);
    expect(alpha(session, 150, 100)).toBe(0);
    expect(alpha(session, 250, 100)).toBe(255);
    expect(alpha(session, 350, 100)).toBe(255);
    expect(session.undo()).toBe(true);
    expect(session.activeLayer!.transform).toEqual(original.transform);
    expect(session.activeLayer!.mask!.placement).toBeNull();
    expect(session.activeLayer!.mask!.linked).toBe(false);
  });

  it('unlinkedTheMaskMovesAloneAndRelinkedTheyMoveTogether', () => {
    const session = maskedSession();
    const original = session.activeLayer!;
    session.toggleMaskLink(original.id);
    session.selectLayerTarget(original.id, true);
    const moved = move(session, 100);
    expect(session.transformTargetsMask).toBe(true);
    expect(session.transformEdit!.mask).toBe(true);
    expect(session.displayedTransform(original)).toEqual(original.transform);
    expect(session.editedTransform(original)).toEqual(moved);
    expect(session.displayedMaskPlacement(original)).toEqual(moved);
    session.commitTransform();
    expect(session.activeLayer!.transform).toEqual(original.transform);
    expect(session.activeLayer!.mask!.placement).toEqual(moved);
    expect(session.activeLayer!.mask!.raster).toBe(original.mask!.raster);

    session.toggleMaskLink(original.id);
    session.selectLayerTarget(original.id, false);
    move(session, 50);
    session.commitTransform();
    const placement = session.activeLayer!.mask!.placement!;
    expect(placement.origin).toEqual({ x: 150, y: 0 });
    expect(placement.size).toEqual(moved.size);
  });

  it('aMovedHideAllMaskKeepsHidingPastItsPixels', () => {
    const session = maskedSession(false);
    const id = session.activeLayerId!;
    session.toggleMaskLink(id);
    session.selectLayerTarget(id, true);
    move(session, 100);
    session.commitTransform();
    expect(alpha(session, 20, 100)).toBe(0);
    expect(alpha(session, 250, 100)).toBe(255);
  });

  it('placementAndLinkAreSavedAndPaintingFollowsThePlacement', async () => {
    const session = maskedSession();
    const id = session.activeLayerId!;
    session.toggleMaskLink(id);
    session.selectLayerTarget(id, true);
    const moved = move(session, 100);
    session.commitTransform();
    const archived = writeArchive(session.document!, 'Masked', session.activeLayerId);
    const restored = await readArchive(archived.blob, async (bytes) => {
      const decoded = decodePng(bytes);
      return { width: decoded.width, height: decoded.height, channels: decoded.channels, data: decoded.data };
    });
    const restoredLayer = restored.document.layers[0]!;
    expect(restoredLayer.mask!.placement).toEqual(moved);
    expect(restoredLayer.mask!.linked).toBe(false);
    expect(documentPointToLayerPixel(restoredLayer, moved.origin, true)).toEqual({ x: 0, y: 0 });
    expect(session.undo()).toBe(true);
    expect(session.redo()).toBe(true);
    expect(session.activeLayer!.mask!.placement).toEqual(moved);
  });
});
