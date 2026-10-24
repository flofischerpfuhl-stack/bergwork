import { describe, expect, it } from 'vitest';
import { cropDocument, revealAllDocument } from '../../src/core/canvasOps';
import { cropArtboard } from '../../src/core/artboardCommands';
import { compositeRegion } from '../../src/core/composite';
import { newLayer, type CanvasDocument } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { rectangleSelection } from '../../src/core/selectionOps';
import { EditorSession } from '../../src/core/session';
import { decodePng } from '../../src/io/png';
import { readArchive, writeArchive } from '../../src/io/project';

function strip(): Raster {
  return Raster.fromPixels(4, 1, 4, Uint8Array.from([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
  ]));
}

function pixelDocument(): CanvasDocument {
  return { id: 'crop-document', width: 4, height: 1, resolution: 72, selection: null, layers: [newLayer({
    id: 'pixels', name: 'Pixels', raster: strip(),
    transform: makeTransform({ x: 0, y: 0 }, { width: 4, height: 1 }, { sampling: 'Nearest' }),
  })] };
}

function embeddedDocument(crop: { rect: { x: number; y: number; width: number; height: number }; feather: number } | null): CanvasDocument {
  const pixels = new Uint8Array(6 * 4); for (let x = 0; x < 6; x++) pixels.set([200, 40, 10, 255], x * 4);
  return { id: 'embedded-document', width: 6, height: 1, resolution: 72,
    selection: rectangleSelection({ x: 1, y: 0, width: 4, height: 1 }, { width: 6, height: 1 }), layers: [newLayer({
      id: 'embedded', name: 'Placed', kind: 'embedded', raster: Raster.fromPixels(6, 1, 4, pixels), crop,
      transform: makeTransform({ x: 0, y: 0 }, { width: 6, height: 1 }, { sampling: 'Nearest' }),
      content: { mode: 'linked', mediaType: 'image', sourceName: 'placed.png', uri: 'memory://placed.png' },
    })] };
}

describe('non-destructive document crop', () => {
  it('moves layer offsets without replacing pixels and Reveal All restores the source union', () => {
    const source = pixelDocument(), raster = source.layers[0]!.raster;
    const cropped = cropDocument(source, { x: 1, y: 0, width: 2, height: 1 });
    expect([cropped.width, cropped.height]).toEqual([2, 1]);
    expect(cropped.layers[0]!.transform.origin).toEqual({ x: -1, y: 0 });
    expect(cropped.layers[0]!.raster).toBe(raster);
    expect(Array.from(compositeRegion(cropped, { x: 0, y: 0, width: 2, height: 1 }).rgba))
      .toEqual([0, 255, 0, 255, 0, 0, 255, 255]);

    const revealed = revealAllDocument(cropped);
    expect([revealed.width, revealed.height]).toEqual([4, 1]);
    expect(revealed.layers[0]!.transform.origin).toEqual({ x: 0, y: 0 });
    expect(revealed.layers[0]!.raster).toBe(raster);
    expect(compositeRegion(revealed, { x: 0, y: 0, width: 4, height: 1 }).rgba)
      .toEqual(strip().toPixels());
  });

  it('deletes outside source samples only when explicitly requested', () => {
    const cropped = cropDocument(pixelDocument(), { x: 1, y: 0, width: 2, height: 1 }, { deletePixels: true });
    expect(cropped.layers[0]!.raster!.toPixels()).toEqual(Uint8Array.from([
      0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0,
    ]));
    const revealed = revealAllDocument(cropped);
    expect(Array.from(compositeRegion(revealed, { x: 0, y: 0, width: 4, height: 1 }).rgba))
      .toEqual([0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0]);
  });

  it('crops an artboard without resizing the document or moving its layers', () => {
    const session = new EditorSession();
    const source = pixelDocument(), raster = source.layers[0]!.raster;
    session.installProject({ ...source, artboards: [{ id: 'board', name: 'Board',
      rect: { x: 0, y: 0, width: 4, height: 1 }, background: { red: 1, green: 1, blue: 1, alpha: 0 }, colorLabel: 'none' }] },
    'pixels', 'Artboard');
    expect(cropArtboard(session, 'board', { x: 1, y: 0, width: 2, height: 1 })).toBe(true);
    expect([session.document!.width, session.document!.height]).toEqual([4, 1]);
    expect(session.document!.artboards![0]!.rect).toEqual({ x: 1, y: 0, width: 2, height: 1 });
    expect(session.activeLayer!.transform.origin).toEqual({ x: 0, y: 0 });
    expect(session.activeLayer!.raster).toBe(raster);
    expect(session.history.undoCount).toBe(1);
  });
});

describe('embedded layer crop parameter', () => {
  it('clips exact CPU pixels including feather coverage', () => {
    const document = embeddedDocument({ rect: { x: 1, y: 0, width: 4, height: 1 }, feather: 2 });
    const pixels = compositeRegion(document, { x: 0, y: 0, width: 6, height: 1 }).rgba;
    expect([0, 1, 2, 3, 4, 5].map((x) => pixels[x * 4 + 3])).toEqual([0, 64, 64, 64, 64, 0]);
    expect([1, 2, 3, 4].map((x) => Array.from(pixels.slice(x * 4, x * 4 + 3)))).toEqual([
      [200, 40, 10], [200, 40, 10], [200, 40, 10], [200, 40, 10],
    ]);
  });

  it('is one undoable, lock-aware edit and remains editable after save and reopen', async () => {
    const session = new EditorSession();
    session.installProject(embeddedDocument(null), 'embedded', 'Crop');
    expect(session.cropEmbeddedLayerToSelection()).toBe(true);
    expect(session.activeLayer!.crop).toEqual({ rect: { x: 1, y: 0, width: 4, height: 1 }, feather: 0 });
    expect(session.history.undoCount).toBe(1);

    const archive = writeArchive(session.document!, 'Crop', session.activeLayerId);
    const loaded = await readArchive(archive.blob, async (bytes) => {
      const png = decodePng(bytes); return { width: png.width, height: png.height, channels: png.channels, data: png.data };
    });
    expect(loaded.document.layers[0]!.crop).toEqual(session.activeLayer!.crop);

    const reopened = new EditorSession();
    reopened.installProject({ ...loaded.document,
      selection: rectangleSelection({ x: 2, y: 0, width: 2, height: 1 }, loaded.document) }, loaded.activeLayerId, loaded.name);
    expect(reopened.cropEmbeddedLayerToSelection()).toBe(true);
    expect(reopened.activeLayer!.crop).toEqual({ rect: { x: 2, y: 0, width: 2, height: 1 }, feather: 0 });
    expect(reopened.clearEmbeddedLayerCrop()).toBe(true);
    expect(reopened.activeLayer!.crop).toBeNull();
    expect(reopened.undo()).toBe(true);
    expect(reopened.activeLayer!.crop?.rect).toEqual({ x: 2, y: 0, width: 2, height: 1 });

    reopened.replaceDocument({ ...reopened.document!, layers: [{ ...reopened.activeLayer!, crop: null,
      locks: { ...reopened.activeLayer!.locks, all: true } }] });
    expect(reopened.cropEmbeddedLayerToSelection()).toBe(false);
    expect(reopened.activeLayer!.crop).toBeNull();
    expect(reopened.lastEditBlocker?.code).toBe('layer-lock-all');
  });
});
