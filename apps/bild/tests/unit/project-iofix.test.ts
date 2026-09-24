import { describe, expect, it } from 'vitest';
import { documentsEqual, MAX_PIXELS, newLayer, type CanvasDocument } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import type { PersistedHistoryState } from '../../src/core/history';
import { Raster } from '../../src/core/raster';
import { decodeImageAsset, decodeImageFile } from '../../src/io/imageImport';
import { readArchive, writeArchive } from '../../src/io/project';

const archiveDecoder = (bytes: Uint8Array) => decodeImageAsset(bytes, MAX_PIXELS);

describe('.fwimg data preservation', () => {
  it('round-trips every CanvasDocument field in history snapshots', async () => {
    const pixels = Raster.fromPixels(1, 1, 4, new Uint8Array([12, 34, 56, 255]), { id: 'pixels' });
    const layer = newLayer({ id: 'layer', name: 'Layer', transform: makeTransform({ x: 0, y: 0 }, { width: 1, height: 1 }),
      raster: pixels });
    const before = completeDocument('before-resource', 80, 10, Raster.fromPixels(2, 1, 1, new Uint8Array([255, 0]), { id: 'before-selection' }));
    const after = completeDocument('after-resource', 125, 35, Raster.fromPixels(2, 1, 1, new Uint8Array([0, 255]), { id: 'after-selection' }));
    const withLayer = (document: CanvasDocument): CanvasDocument => ({ ...document, layers: [layer] });
    const beforeDocument = withLayer(before), afterDocument = withLayer(after);
    const history: PersistedHistoryState = { schemaVersion: 1, enabled: true, retainedByteLimit: 1024 * 1024,
      past: [{ name: 'All document fields', before: { document: beforeDocument, activeLayerId: 'layer', revision: 1 },
        after: { document: afterDocument, activeLayerId: 'layer', revision: 2 } }], future: [] };

    const archive = writeArchive(afterDocument, 'Fields', 'layer', history);
    const loaded = await readArchive(archive.blob, archiveDecoder);
    const restoredBefore = loaded.history!.past[0]!.before.document!;
    const restoredAfter = loaded.history!.past[0]!.after.document!;

    // Keep this key comparison in sync with CanvasDocument so adding a populated field cannot be
    // silently omitted by the history format again.
    expect(Object.keys(restoredBefore).sort()).toEqual(Object.keys(beforeDocument).sort());
    expect(Object.keys(restoredAfter).sort()).toEqual(Object.keys(afterDocument).sort());
    expect(restoredBefore).toMatchObject({ globalLightAngle: 80, guides: [{ id: 'guide', orientation: 'vertical', position: 10 }] });
    expect(restoredBefore.artboards?.[0]?.name).toBe('Board before-resource');
    expect(restoredBefore.fonts?.[0]?.resourceId).toBe('before-resource');
    expect(restoredBefore.resources?.map((resource) => resource.id)).toEqual(['before-resource']);
    expect(restoredBefore.selection?.mask.toPixels()).toEqual(new Uint8Array([255, 0]));
    expect(restoredAfter).toMatchObject({ globalLightAngle: 125, guides: [{ id: 'guide', orientation: 'vertical', position: 35 }] });
    expect(restoredAfter.resources?.map((resource) => resource.id)).toEqual(['after-resource']);
    expect(restoredAfter.selection?.mask.toPixels()).toEqual(new Uint8Array([0, 255]));
    expect(documentsEqual(restoredAfter, loaded.document)).toBe(true);
  });

  it('ProjectTests.projectRoundTripSurvivesSourceRemoval: reopens retained TIFF bytes through the import decoder', async () => {
    const source = tinyRgbTiff();
    const raster = await decodeImageFile(source, MAX_PIXELS);
    const layer = newLayer({ id: 'tiff-layer', name: 'TIFF', raster,
      transform: makeTransform({ x: 0, y: 0 }, { width: raster.width, height: raster.height }) });
    const document: CanvasDocument = { id: 'tiff-document', width: 2, height: 1, resolution: 72,
      layers: [layer], artboards: [], selection: null };

    const archive = writeArchive(document, 'TIFF', layer.id);
    expect(archive.manifest.assets.find((asset) => asset.role === 'image')?.mime).toBe('image/tiff');
    const loaded = await readArchive(archive.blob, archiveDecoder);
    expect(loaded.document.layers[0]!.raster!.toPixels()).toEqual(raster.toPixels());
    expect(loaded.document.layers[0]!.raster!.source?.bytes).toEqual(source);
  });
});

function completeDocument(resourceId: string, globalLightAngle: number, guidePosition: number,
  selectionMask: Raster): CanvasDocument {
  return {
    id: 'all-fields', width: 20, height: 10, resolution: 300, globalLightAngle, layers: [],
    artboards: [{ id: 'board', name: `Board ${resourceId}`, rect: { x: 1, y: 2, width: 8, height: 6 },
      background: { red: 0.1, green: 0.2, blue: 0.3, alpha: 0.4 }, colorLabel: 'blue' }],
    guides: [{ id: 'guide', orientation: 'vertical', position: guidePosition }],
    resources: [{ id: resourceId, role: 'font', mime: 'font/woff2', bytes: new Uint8Array([1, 2, guidePosition]) }],
    fonts: [{ id: `font-${resourceId}`, family: 'Fixture Sans', style: 'normal', weight: 400, source: 'embedded',
      resourceId, embeddingAllowed: true }],
    selection: { mask: selectionMask, x: guidePosition, y: -2, antialiased: true },
  };
}

/** Independent uncompressed little-endian 2×1 RGB TIFF fixture. */
function tinyRgbTiff(): Uint8Array {
  const entries = 10, ifd = 8, bitsOffset = ifd + 2 + entries * 12 + 4, pixelsOffset = bitsOffset + 6;
  const bytes = new Uint8Array(pixelsOffset + 6), view = new DataView(bytes.buffer);
  bytes.set([0x49, 0x49]); view.setUint16(2, 42, true); view.setUint32(4, ifd, true); view.setUint16(ifd, entries, true);
  const tags: readonly [number, number, number, number][] = [
    [256, 4, 1, 2], [257, 4, 1, 1], [258, 3, 3, bitsOffset], [259, 3, 1, 1], [262, 3, 1, 2],
    [273, 4, 1, pixelsOffset], [277, 3, 1, 3], [278, 4, 1, 1], [279, 4, 1, 6], [284, 3, 1, 1],
  ];
  for (let index = 0; index < tags.length; index++) {
    const [tag, type, count, value] = tags[index]!, at = ifd + 2 + index * 12;
    view.setUint16(at, tag, true); view.setUint16(at + 2, type, true); view.setUint32(at + 4, count, true);
    if (type === 3 && count === 1) view.setUint16(at + 8, value, true); else view.setUint32(at + 8, value, true);
  }
  view.setUint32(ifd + 2 + entries * 12, 0, true);
  view.setUint16(bitsOffset, 8, true); view.setUint16(bitsOffset + 2, 8, true); view.setUint16(bitsOffset + 4, 8, true);
  bytes.set([255, 0, 0, 0, 255, 0], pixelsOffset);
  return bytes;
}
