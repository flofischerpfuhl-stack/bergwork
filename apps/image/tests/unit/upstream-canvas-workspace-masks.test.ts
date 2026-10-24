import { describe, expect, it } from 'vitest';
import { cropSnapTargets } from '../../src/core/canvasOps';
import { flattenDocument } from '../../src/core/composite';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { invertPixels, loadMaskSelection } from '../../src/core/selectionCommands';
import { selectionBounds } from '../../src/core/selectionOps';
import { EditorSession } from '../../src/core/session';
import { ProjectWorkspace } from '../../src/core/workspace';
import { documentFromTransfer, documentToTransfer } from '../../src/core/transfer';
import { runOp } from '../../src/workers/opsRun';
import type { OpsRequest } from '../../src/workers/opsProtocol';

function workerDocument(document: NonNullable<EditorSession['document']>, request: (value: ReturnType<typeof documentToTransfer>) => OpsRequest) {
  const response = runOp(request(documentToTransfer(document)), 1);
  if (!response.ok || !response.document) throw new Error(response.ok ? 'missing worker document' : response.error);
  return documentFromTransfer(response.document, document);
}

function solid(width: number, height: number, rgba: readonly [number, number, number, number]): Raster {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) pixels.set(rgba, i * 4);
  return Raster.fromPixels(width, height, 4, pixels);
}

describe('upstream CropTests and CanvasSizeTests', () => {
  it('sameSizeOffsetCropAndExpansionUseExactBounds', () => {
    const session = new EditorSession(); session.createDocument(100, 50); session.addBlankLayer();
    const id = session.activeLayerId!;
    const first = workerDocument(session.document!, (document) => ({ op: 'crop', document,
      rect: { x: -20, y: 10, width: 100, height: 50 }, options: {} }));
    expect(first.layers.find((layer) => layer.id === id)!.transform.origin).toEqual({ x: 20, y: -10 });
    const second = workerDocument(first, (document) => ({ op: 'crop', document,
      rect: { x: -10, y: -10, width: 140, height: 80 }, options: {} }));
    expect(second).toMatchObject({ width: 140, height: 80 });
    expect(second.layers.find((layer) => layer.id === id)!.transform.origin).toEqual({ x: 30, y: 0 });
    expect(flattenDocument(second).pixel(0, 0)[3]).toBe(0);
  });

  it('cancellationAndViewportMappingDoNotEditDocument', () => {
    const session = new EditorSession(); session.createDocument(1000, 500);
    const original = session.document;
    session.selectTool('crop');
    expect(session.cropRect).toEqual({ x: 0, y: 0, width: 1000, height: 500 });
    expect(session.document).toBe(original);
    session.cropRect = { x: 25, y: 20, width: 200, height: 100 };
    session.cancelCrop(); expect(session.document).toBe(original);
    session.cropRect = { x: 0, y: 0, width: 200, height: 100 };
    session.selectTool('move'); expect(session.cropRect).toBeNull(); expect(session.document).toBe(original);
    for (const scale of [1, 2]) {
      session.viewport.resize({ width: 800, height: 600 }, scale, original);
      session.viewport.translate(37, -19);
      const point = { x: -20, y: 135 }, view = session.viewport.viewPoint(point, original!);
      const result = session.viewport.documentPoint(view, original!);
      expect(result.x).toBeCloseTo(point.x); expect(result.y).toBeCloseTo(point.y);
    }
  });

  it('snapTargetsAreTheCanvasAndLayerBounds', () => {
    const session = new EditorSession(); session.createDocument(400, 300);
    session.insertRaster(solid(100, 60, [255, 0, 0, 255]), 'Red');
    const targets = cropSnapTargets(session.document!);
    expect(new Set(targets.xs)).toEqual(new Set([0, 400, 150, 250]));
    expect(new Set(targets.ys)).toEqual(new Set([0, 300, 120, 180]));
  });

  it('coloredExtensionPreservesOldTransparencyThroughTheWorkerPath', () => {
    const session = new EditorSession(); session.createDocument(4, 4); session.addBlankLayer();
    const resized = workerDocument(session.document!, (document) => ({ op: 'canvasSize', document,
      width: 8, height: 2, anchor: 4, options: { fill: { red: 1, green: 0, blue: 0 } } }));
    const rendered = flattenDocument(resized);
    expect(rendered.pixel(0, 0)).toEqual([255, 0, 0, 255]);
    expect(rendered.pixel(3, 0)[3]).toBe(0);
    expect(rendered.pixel(7, 1)).toEqual([255, 0, 0, 255]);
  });
});

describe('upstream ProjectWorkspaceTests engine cases', () => {
  it('newCanvasOpensAnEmptyTabWithoutAModal', () => {
    const workspace = new ProjectWorkspace(), original = workspace.current;
    original.session.createDocument(4000, 3000);
    const second = workspace.newCanvas()!;
    expect(workspace.tabs).toHaveLength(2); expect(workspace.current).toBe(second);
    expect(second.session.document).toBeNull(); expect(workspace.canSwitch).toBe(true);
    expect(original.session.document).toMatchObject({ width: 4000, height: 3000 });
    workspace.newCanvas(); expect(workspace.tabs).toHaveLength(3);
    workspace.destroy();
  });

  it('layerDropProviderCopiesIntoANewProject (workspace copy engine)', async () => {
    const workspace = new ProjectWorkspace(), source = workspace.current;
    source.session.createDocument(100, 100);
    const id = source.session.insertRaster(solid(2, 2, [255, 255, 255, 255]), 'Source');
    const copiedId = await workspace.copyLayer(id, null);
    expect(workspace.tabs).toHaveLength(2); expect(workspace.current).not.toBe(source);
    expect(workspace.current.session.document!.layers).toHaveLength(1);
    expect(copiedId).not.toBe(id); expect(source.session.layer(id)).not.toBeNull();
    workspace.destroy();
  });

  it('tabsKeepIndependentDocumentsAndUndo', () => {
    const workspace = new ProjectWorkspace(), first = workspace.current;
    first.session.createDocument(4000, 4000); first.session.addBlankLayer();
    const second = workspace.addTab(); second.session.createDocument(640, 480); second.session.addBlankLayer();
    second.session.undo();
    expect(first.session.document!.layers).toHaveLength(1); expect(second.session.document!.layers).toHaveLength(0);
    workspace.select(first.id); expect(workspace.current).toBe(first);
    workspace.removeTab(second.id); workspace.removeTab(first.id);
    expect(workspace.tabs).toHaveLength(1); expect(workspace.current.session.document).toBeNull();
    workspace.destroy();
  });

  it('crossProjectCopyRemapsIdentityAndHasIndependentUndo', async () => {
    const workspace = new ProjectWorkspace(), first = workspace.current;
    first.session.createDocument(100, 100);
    const original = first.session.insertRaster(solid(2, 2, [255, 255, 255, 255]), 'Source');
    const second = workspace.addTab(); second.session.createDocument(200, 200);
    const copiedId = await workspace.copyLayer(original, second.id);
    const copied = second.session.layer(copiedId)!;
    expect(copied.id).not.toBe(original);
    expect(copied.transform.origin).toEqual({ x: 99, y: 99 });
    expect(first.session.document!.layers).toHaveLength(1);
    second.session.undo(); expect(second.session.document!.layers).toHaveLength(0);
    expect(first.session.document!.layers).toHaveLength(1);
    second.session.redo(); expect(second.session.layer(copied.id)).not.toBeNull();
    workspace.destroy();
  });
});

describe('upstream LayerMaskTests and LiveMaskTests engine cases', () => {
  it('folderMaskCanBePaintedInvertedAndLoadedAsASelection (mask edit engine)', () => {
    const session = new EditorSession(); session.createDocument(40, 20);
    const child = session.insertRaster(solid(40, 20, [255, 0, 0, 255]), 'Red');
    session.groupSelectedLayers(); const folder = session.activeLayerId!; session.addLayerMask();
    const mask = new Uint8Array(40 * 20).fill(255);
    for (let y = 6; y < 14; y++) for (let x = 6; x < 14; x++) mask[y * 40 + x] = 0;
    session.replaceMaskPixels(folder, Raster.fromPixels(40, 20, 1, mask), 'Paint Layer Mask');
    expect(flattenDocument(session.document!).pixel(10, 10)[3]).toBe(0);
    expect(flattenDocument(session.document!).pixel(30, 10)[3]).toBe(255);
    expect(invertPixels(session)).toBe(true);
    expect(flattenDocument(session.document!).pixel(10, 10)[3]).toBe(255);
    expect(flattenDocument(session.document!).pixel(30, 10)[3]).toBe(0);
    expect(loadMaskSelection(session, folder)).toBe(true);
    expect(selectionBounds(session.selection!)!.width).toBeGreaterThan(30);
    expect(session.layer(child)!.parentId).toBe(folder);
  });

  it('optionClickCreatesSharedStackAndDragOutReleases', () => {
    const session = new EditorSession(); session.createDocument(2, 2);
    const ids = [0, 1, 2].map((i) => session.insertRaster(solid(2, 2, [i, i, i, 255]), `Layer ${i}`));
    expect(session.canToggleClippingMask(ids[0]!)).toBe(false);
    session.toggleClippingMask(ids[1]!); session.toggleClippingMask(ids[2]!);
    expect(session.layer(ids[1]!)!.maskSourceId).toBe(ids[0]);
    expect(session.layer(ids[2]!)!.maskSourceId).toBe(ids[0]);
    session.toggleClippingMask(ids[2]!); expect(session.layer(ids[2]!)!.maskSourceId).toBeNull();
    session.toggleClippingMask(ids[2]!); session.toggleClippingMask(ids[1]!);
    expect(session.layer(ids[1]!)!.maskSourceId).toBeNull(); expect(session.layer(ids[2]!)!.maskSourceId).toBeNull();
    session.undo(); expect(session.layer(ids[2]!)!.maskSourceId).toBe(ids[0]);
    expect(session.placeLayer(ids[2]!, null, null, true)).toBe(true);
    expect(session.document!.layers[0]!.id).toBe(ids[2]); expect(session.layer(ids[2]!)!.maskSourceId).toBeNull();
  });

  it('movingSourceChangesCoverageAndChainsMultiply', () => {
    const session = new EditorSession(); session.createDocument(2, 2);
    const target = session.insertRaster(solid(2, 2, [255, 255, 255, 255]), 'Target');
    const sourceRaster = Raster.fromPixels(2, 2, 4, Uint8Array.from([
      0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 128, 0, 0, 0, 255,
    ]));
    const source = session.insertRaster(sourceRaster, 'Source');
    session.toggleLayerVisibility(source); expect(session.linkMask(source, target)).toBe(true);
    const sourceLayer = session.layer(source)!;
    session.replaceDocument({ ...session.document!, layers: session.document!.layers.map((layer) => layer.id === source ? {
      ...layer, transform: makeTransform({ x: 1, y: 0 }, sourceLayer.transform.size, { sampling: 'Nearest' }),
    } : layer) });
    expect([...flattenDocument(session.document!).toPixels()].filter((_value, index) => index % 4 === 3)).toEqual([0, 255, 0, 128]);
    session.replaceDocument({ ...session.document!, layers: session.document!.layers.map((layer) => layer.id === source ? {
      ...layer, transform: sourceLayer.transform,
    } : layer) });
    const chain = session.insertRaster(Raster.fromPixels(2, 2, 4, Uint8Array.from([
      0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255,
    ])), 'Chain');
    session.toggleLayerVisibility(chain);
    expect(session.linkMask(chain, source)).toBe(true);
    expect([...flattenDocument(session.document!).toPixels()].filter((_value, index) => index % 4 === 3)).toEqual([0, 0, 128, 255]);
  });
});
