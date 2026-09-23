import { describe, expect, it } from 'vitest';
import { flattenDocument } from '../../src/core/composite';
import { isValidStructure, renderLayers, type CanvasDocument } from '../../src/core/document';
import { DocumentHistory } from '../../src/core/history';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';

function solid(width: number, height: number, rgba: readonly [number, number, number, number]): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return Raster.fromPixels(width, height, 4, data);
}

function threeLayers(): EditorSession {
  const session = new EditorSession();
  session.createDocument(800, 600);
  for (let i = 0; i < 3; i++) session.addBlankLayer();
  return session;
}

describe('upstream HistoryTests', () => {
  it('everyLayerEditRoundTripsWithSelection', async () => {
    const session = new EditorSession();
    const states: { document: CanvasDocument | null; active: string | null }[] = [];
    const capture = (): void => { states.push({ document: session.document, active: session.activeLayerId }); };
    capture();
    session.createDocument(800, 600); capture();
    session.addBlankLayer(); capture();
    session.addBlankLayer(); capture();
    const id = session.activeLayerId!;
    session.renameLayer(id, 'Foreground'); capture();
    session.toggleLayerVisibility(id); capture();
    session.moveActiveLayer(-1); capture();
    session.moveActiveLayer(1); capture();
    await session.deleteLayer(id); capture();

    for (const expected of states.slice(0, -1).reverse()) {
      expect(session.undo()).toBe(true);
      expect(session.document).toBe(expected.document);
      expect(session.activeLayerId).toBe(expected.active);
    }
    expect(session.canUndo).toBe(false);
    for (const expected of states.slice(1)) {
      expect(session.redo()).toBe(true);
      expect(session.document).toBe(expected.document);
      expect(session.activeLayerId).toBe(expected.active);
    }
    expect(session.canRedo).toBe(false);
  });

  it('navigationNoOpsAndSaveRevisionPreserveHistory', () => {
    const session = new EditorSession();
    session.createDocument(800, 600);
    session.addBlankLayer();
    const id = session.activeLayerId!;
    session.history.markSaved();
    session.renameLayer(id, 'Changed');
    expect(session.isModified).toBe(true);
    session.undo();
    expect(session.isModified).toBe(false);
    const count = session.history.undoCount;
    session.zoomTo(2);
    session.renameLayer(id, 'Layer 1');
    session.renameLayer(id, '   ');
    session.moveActiveLayer(-1);
    expect(session.history.undoCount).toBe(count);
    expect(session.canRedo).toBe(true);
    session.redo();
    expect(session.viewport.zoom).toBe(2);
    expect(session.isModified).toBe(true);
    session.undo();
    session.addBlankLayer();
    expect(session.canRedo).toBe(false);
  });

  it('replacementCanvasAndNestedTransactionsUndoAsOne', () => {
    const session = new EditorSession();
    session.createDocument(100, 200);
    session.beginEdit('Layer Setup');
    session.addBlankLayer();
    session.addBlankLayer();
    expect(session.canUndo).toBe(false);
    session.endEdit();
    expect(session.history.undoName).toBe('Layer Setup');
    session.undo();
    expect(session.document?.layers).toHaveLength(0);
    session.redo();
    const previous = session.document;
    session.createDocument(300, 400);
    session.undo();
    expect(session.document).toBe(previous);
    session.redo();
    expect(session.document).toMatchObject({ width: 300, height: 400 });
  });

  it('historyBlockedDuringImportsAndDialogs (engine blockers)', () => {
    const session = new EditorSession();
    session.createDocument(40, 40);
    session.isImporting = true;
    expect(session.undo()).toBe(false);
    expect(session.document).not.toBeNull();
    session.isImporting = false;
    session.isProjectBusy = true;
    expect(session.undo()).toBe(false);
    session.isProjectBusy = false;
    expect(session.undo()).toBe(true);
    expect(session.document).toBeNull();
    expect(session.redo()).toBe(true);
    expect(session.document).not.toBeNull();
  });

  it('historyBoundsEntriesAndUniqueRetainedPixels', () => {
    const raster = solid(64, 32, [30, 40, 50, 255]);
    let document: CanvasDocument = { id: 'doc', width: 64, height: 32, resolution: 72, selection: null, layers: [] };
    const session = new EditorSession();
    session.installProject(document, null, null);
    const layerId = session.insertRaster(raster, 'Layer');
    document = session.document!;
    const history = new DocumentHistory(2, Number.POSITIVE_INFINITY);
    for (const name of ['A', 'B', 'C']) {
      history.begin('Rename', document, layerId);
      document = { ...document, layers: document.layers.map((layer) => layer.id === layerId ? { ...layer, name } : layer) };
      history.end(document, layerId);
    }
    expect(history.undoCount).toBe(2);
    expect(history.retainedBytes(document)).toBe(0);

    const zeroRetained = new DocumentHistory(100, 0);
    zeroRetained.begin('Delete', document, layerId);
    const empty = { ...document, layers: [] };
    zeroRetained.end(empty, null);
    expect(zeroRetained.undoCount).toBe(0);
    expect(zeroRetained.retainedBytes(empty)).toBe(0);
  });
});

describe('upstream LayerTests and GroupingSelectionTests', () => {
  it('reorderTranslatesVisibleOrderAndKeepsSelection', () => {
    const session = threeLayers();
    const active = session.activeLayerId;
    expect(session.placeLayer(active!, null, null, true)).toBe(true);
    expect(session.document!.layers.map((layer) => layer.name)).toEqual(['Layer 3', 'Layer 1', 'Layer 2']);
    expect(session.activeLayerId).toBe(active);
    expect(session.canMoveActiveLayer(-1)).toBe(false);
    session.moveActiveLayer(1);
    expect(session.document!.layers.map((layer) => layer.name)).toEqual(['Layer 1', 'Layer 3', 'Layer 2']);
  });

  it('unavailableActionsDoNotChangeDocument', async () => {
    const session = new EditorSession();
    session.addBlankLayer();
    expect(session.document).toBeNull();
    session.createDocument(30_000, 30_000);
    session.addBlankLayer();
    const before = session.document;
    session.isImporting = true;
    session.addBlankLayer();
    await session.deleteLayer(session.activeLayerId!);
    expect(session.document).toBe(before);
  });

  it('deletingAMultiSelectionRemovesEveryLayerInOneStep', async () => {
    const session = new EditorSession();
    session.createDocument(100, 100);
    session.addBlankLayer();
    const keep = session.activeLayerId!;
    session.selectLayer(null); session.addGroup();
    const folder = session.activeLayerId!;
    session.addBlankLayer();
    const child = session.activeLayerId!;
    session.selectLayer(null); session.addBlankLayer();
    const top = session.activeLayerId!;
    const before = session.document, count = session.history.undoCount;
    session.selectLayers([folder, top], top);
    await session.deleteLayerOrMask();
    expect(session.document!.layers.map((layer) => layer.id)).toEqual([keep]);
    expect(session.layer(child)).toBeNull();
    expect(session.history.undoCount).toBe(count + 1);
    expect(session.history.undoName).toBe('Delete Layers');
    expect(session.activeLayerId).toBe(keep);
    session.undo();
    expect(session.document).toBe(before);
  });

  it('duplicatingALayerByDraggingPlacesTheCopyAsOneStep', () => {
    const session = threeLayers();
    const rows = session.layerRows.map((entry) => entry.layer);
    const top = rows[0]!, bottom = rows.at(-1)!;
    const before = session.document, count = session.history.undoCount;
    expect(session.duplicateLayer(bottom.id, null, top.id)).toBe(true);
    const after = session.layerRows.map((entry) => entry.layer);
    expect(after[0]!.name).toBe(`${bottom.name} copy`);
    expect(after.some((layer) => layer.id === bottom.id)).toBe(true);
    expect(session.history.undoCount).toBe(count + 1);
    expect(session.history.undoName).toBe('Duplicate Layer');
    session.undo();
    expect(session.document).toBe(before);
    session.addGroup();
    expect(session.duplicateLayer(session.activeLayerId!, null, null, true)).toBe(false);
  });

  it('singleLayerAndFolderAreWrappedRatherThanCreatingAChildFolder', () => {
    const session = new EditorSession(); session.createDocument(100, 100); session.addBlankLayer();
    const layer = session.activeLayerId!;
    session.groupSelectedLayers();
    const inner = session.activeLayerId!;
    expect(session.layer(layer)!.parentId).toBe(inner);
    session.groupSelectedLayers();
    const outer = session.activeLayerId!;
    expect(session.layer(inner)!.parentId).toBe(outer);
    expect(session.layer(layer)!.parentId).toBe(inner);
    expect(session.layer(outer)!.parentId).toBeNull();
    session.undo();
    expect(session.layer(inner)!.parentId).toBeNull();
  });

  it('multipleSelectionPreservesOrderAndSelectedFolderDescendants', () => {
    const session = new EditorSession(); session.createDocument(100, 100); session.addGroup();
    const folder = session.activeLayerId!; session.addBlankLayer();
    const child = session.activeLayerId!; session.selectLayer(null); session.addBlankLayer();
    const sibling = session.activeLayerId!, before = session.document;
    session.selectLayers([folder, child, sibling], sibling);
    session.groupSelectedLayers();
    const wrapper = session.activeLayerId!;
    expect(session.layer(folder)!.parentId).toBe(wrapper);
    expect(session.layer(sibling)!.parentId).toBe(wrapper);
    expect(session.layer(child)!.parentId).toBe(folder);
    expect(renderLayers(session.document!.layers).map((layer) => layer.id)).toEqual([child, sibling]);
    expect([...session.selectedLayerIds]).toEqual([wrapper]);
    session.undo();
    expect(session.document).toBe(before);
  });

  it('itemsFromDifferentFoldersUseCommonParentAndEmptySelectionCreatesEmptyGroup', () => {
    const session = new EditorSession(); session.createDocument(100, 100);
    session.groupSelectedLayers(); const first = session.activeLayerId!;
    session.addBlankLayer(); const a = session.activeLayerId!;
    session.selectLayer(null); session.groupSelectedLayers(); const second = session.activeLayerId!;
    session.addBlankLayer(); const b = session.activeLayerId!;
    session.selectLayers([a, b], b); session.groupSelectedLayers(); const group = session.activeLayerId!;
    expect(session.layer(group)!.parentId).toBeNull();
    expect(session.layer(a)!.parentId).toBe(group);
    expect(session.layer(b)!.parentId).toBe(group);
    expect(session.layer(first)!.parentId).toBeNull();
    expect(session.layer(second)!.parentId).toBeNull();
  });
});

describe('upstream GroupTests and LayerAppearanceTests', () => {
  it('nestedGroupsMoveOutCollapseAndDeleteUndo', async () => {
    const session = new EditorSession(); session.createDocument(100, 100); session.addGroup();
    const outer = session.activeLayerId!; session.addGroup();
    const inner = session.activeLayerId!; session.addBlankLayer(); const child = session.activeLayerId!;
    expect(session.placeLayer(outer, inner)).toBe(false);
    expect(session.placeLayer(inner, inner)).toBe(false);
    session.toggleGroupExpansion(outer);
    expect(session.layerRows.map((entry) => entry.layer.id)).toEqual([outer]);
    expect(session.activeLayerId).toBe(outer);
    session.toggleGroupExpansion(outer);
    expect(session.layerRows.map((entry) => entry.depth)).toEqual([0, 1, 2]);
    session.selectLayer(child); session.moveActiveLayerOutOfGroup();
    expect(session.layer(child)!.parentId).toBe(outer);
    session.undo();
    expect(session.layer(child)!.parentId).toBe(inner);
    session.selectLayer(outer); await session.deleteLayer(outer);
    expect(session.document!.layers).toHaveLength(0);
    session.undo();
    expect(session.document!.layers).toHaveLength(3);
    expect(isValidStructure(session.document!.layers)).toBe(true);
  });

  it('hoverPreviewIsTemporaryAndNeverChangesSavedState', () => {
    const session = new EditorSession(); session.createDocument(4, 4);
    session.insertRaster(solid(4, 4, [204, 204, 204, 255]), 'Gray');
    session.history.markSaved();
    const count = session.history.undoCount;
    for (const mode of ['normal', 'multiply', 'screen', 'overlay', 'difference'] as const) {
      session.previewBlendMode(mode);
      expect(session.displayedBlendMode(session.activeLayer!)).toBe(mode);
      expect(session.activeLayer!.blendMode).toBe('normal');
      expect(session.isModified).toBe(false);
      expect(session.history.undoCount).toBe(count);
    }
    session.previewBlendMode(null);
    session.previewBlendMode('multiply');
    session.setLayerBlendMode('multiply');
    expect(session.blendPreview).toBeNull();
    expect(session.history.undoCount).toBe(count + 1);
    session.undo();
    expect(session.activeLayer!.blendMode).toBe('normal');
    expect(session.isModified).toBe(false);
  });

  it('moveToolNumberKeysSetSelectedLayersOpacityAsOneUndo', () => {
    const session = new EditorSession(); session.createDocument(4, 4);
    const first = session.insertRaster(solid(4, 4, [51, 51, 51, 255]), 'First');
    const second = session.insertRaster(solid(4, 4, [204, 204, 204, 255]), 'Second');
    session.addGroup(); const folder = session.activeLayerId!;
    session.selectTool('move'); session.selectLayers([first, second, folder], second);
    const count = session.history.undoCount;
    expect(session.typeOpacityDigit(5, 10)).toBe(.5);
    expect(session.layer(first)!.opacity).toBe(.5);
    expect(session.layer(second)!.opacity).toBe(.5);
    expect(session.layer(folder)!.opacity).toBe(1);
    expect(session.history.undoCount).toBe(count + 1);
    expect(session.typeOpacityDigit(0, 20)).toBe(1);
    session.undo();
    expect(session.layer(first)!.opacity).toBe(.5);
    session.selectTool('brush');
    expect(session.typeOpacityDigit(3, 30)).toBe(.3);
    expect(session.layer(second)!.opacity).toBe(.5);
  });

  it('appearancePersistsThroughSaveResizeAndTransparentExport (engine state)', () => {
    const session = new EditorSession(); session.createDocument(4, 4); session.addGroup();
    const group = session.activeLayerId!;
    const id = session.insertRaster(solid(4, 4, [204, 204, 204, 255]), 'Gray');
    session.setLayerOpacity(.25); session.setLayerBlendMode('multiply');
    const raster = flattenDocument(session.document!);
    expect(raster.pixel(2, 2)[3]).toBeCloseTo(64, 0);
    expect(session.layer(id)).toMatchObject({ opacity: .25, blendMode: 'multiply', parentId: group });
  });
});
