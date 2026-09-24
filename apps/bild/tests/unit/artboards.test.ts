import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { ProjectManifestV2 } from '../../contracts-v2';
import { ARTBOARD_PRESETS, artboardPreset } from '../../src/core/artboardPresets';
import {
  createArtboard, deleteArtboard, duplicateArtboard, lastArtboardError, moveArtboard, renameArtboard, reorderArtboard,
  resizeArtboard, setArtboardBackground,
} from '../../src/core/artboardCommands';
import { artboardAt, artboardMembership, artboardUnits, layerContentBounds, normalizeArtboards } from '../../src/core/artboards';
import { newLayer, type Artboard, type CanvasDocument, type Layer } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import { readArchive, writeArchive } from '../../src/io/project';
import { decodePng } from '../../src/io/png';

const decoder = async (bytes: Uint8Array) => {
  const png = decodePng(bytes);
  return { width: png.width, height: png.height, channels: png.channels, data: png.data };
};

function solid(width: number, height: number, rgba: [number, number, number, number]): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return Raster.fromPixels(width, height, 4, data);
}

function pixel(id: string, x: number, y: number, width: number, height: number, extra: Partial<Parameters<typeof newLayer>[0]> = {}): Layer {
  return newLayer({ id, name: id, raster: solid(width, height, [200, 10, 10, 255]), transform: makeTransform({ x, y }, { width, height }), ...extra });
}

const board = (id: string, x: number, y: number, width: number, height: number): Artboard => ({
  id, name: id, rect: { x, y, width, height }, background: { red: 1, green: 1, blue: 1, alpha: 1 }, colorLabel: 'none',
});

function sessionWith(document: CanvasDocument): EditorSession {
  const session = new EditorSession();
  session.installProject(document, null, 'Test');
  return session;
}

function twoBoards(): CanvasDocument {
  return {
    id: 'doc', width: 300, height: 100, resolution: 72, selection: null,
    artboards: [board('A', 0, 0, 100, 100), board('B', 200, 0, 100, 100)],
    layers: [
      pixel('a1', 10, 10, 20, 20),
      newLayer({ id: 'group', name: 'group', kind: 'group', transform: makeTransform({ x: 0, y: 0 }, { width: 300, height: 100 }) }),
      pixel('b-in-group', 220, 20, 30, 30, { parentId: 'group' }),
      pixel('loose', 120, 40, 20, 20),
      newLayer({ id: 'adjust', name: 'adjust', kind: 'adjustment', transform: makeTransform({ x: 0, y: 0 }, { width: 300, height: 100 }),
        adjustment: { kind: 'Exposure', schemaVersion: 1, parameters: { exposure: 1, offset: 0, gamma: 1 } } }),
      pixel('clipped-to-a1', 0, 0, 300, 100, { maskSourceId: 'a1' }),
    ],
  };
}

describe('artboard presets', () => {
  it('lists Social, Web and Print (300 ppi) sizes', () => {
    const size = (id: string) => { const p = artboardPreset(id)!; return [p.width, p.height, p.resolution]; };
    expect(size('instagram-post')).toEqual([1080, 1080, 72]);
    expect(size('instagram-story')).toEqual([1080, 1920, 72]);
    expect(size('facebook-cover')).toEqual([851, 315, 72]);
    expect(size('linkedin-banner')).toEqual([1584, 396, 72]);
    expect(size('web-1920')).toEqual([1920, 1080, 72]);
    expect(size('web-1440')).toEqual([1440, 900, 72]);
    expect(size('web-1280')).toEqual([1280, 720, 72]);
    expect(size('mobile-390')).toEqual([390, 844, 72]);
    expect(size('print-a4')).toEqual([2480, 3508, 300]);
    expect(size('print-a5')).toEqual([1748, 2480, 300]);
    expect(size('print-a3')).toEqual([3508, 4961, 300]);
    expect(size('print-us-letter')).toEqual([2550, 3300, 300]);
    expect(new Set(ARTBOARD_PRESETS.map((p) => p.id)).size).toBe(ARTBOARD_PRESETS.length);
    expect(new Set(ARTBOARD_PRESETS.map((p) => p.category))).toEqual(new Set(['social', 'web', 'print']));
  });
});

describe('artboard membership (geometric rule)', () => {
  it('assigns top-level units by the centre of their content bounds; folders and clipped layers move as one', () => {
    const membership = artboardMembership(twoBoards());
    expect(membership.get('a1')).toBe('A');
    expect(membership.get('clipped-to-a1')).toBe('A'); // joins its base, whose bounds decide
    expect(membership.get('group')).toBe('B');
    expect(membership.get('b-in-group')).toBe('B');
    expect(membership.get('loose')).toBeNull(); // centre between the artboards
    expect(membership.get('adjust')).toBeNull(); // no bounds of its own: applies everywhere
  });

  it('uses alpha-trimmed pixels, not the layer box, and the topmost artboard on overlap', () => {
    const data = new Uint8Array(100 * 100 * 4);
    for (let y = 80; y < 90; y++) for (let x = 80; x < 90; x++) data.set([0, 0, 0, 255], (y * 100 + x) * 4);
    const layer = newLayer({ id: 'corner', name: 'corner', raster: Raster.fromPixels(100, 100, 4, data), transform: makeTransform({ x: 0, y: 0 }, { width: 100, height: 100 }) });
    expect(layerContentBounds(layer)).toEqual({ x: 80, y: 80, width: 10, height: 10 });
    const document: CanvasDocument = { id: 'd', width: 200, height: 200, resolution: 72, selection: null, layers: [layer],
      artboards: [board('big', 0, 0, 200, 200), board('small', 50, 50, 100, 100)] };
    expect(artboardUnits(document)[0]!.artboardId).toBe('small');
    expect(artboardAt(document, { x: 10, y: 10 })?.id).toBe('big');
    expect(artboardAt(document, { x: 60, y: 60 })?.id).toBe('small');
  });

  it('normalises records written without background or label', () => {
    expect(normalizeArtboards([{ id: 'x', name: 'X', rect: { x: 0, y: 0, width: 5, height: 5 } } as Artboard, { id: 'x' } as Artboard])).toEqual([
      { id: 'x', name: 'X', rect: { x: 0, y: 0, width: 5, height: 5 }, background: { red: 1, green: 1, blue: 1, alpha: 1 }, colorLabel: 'none' },
    ]);
  });
});

describe('artboard commands', () => {
  it('creates from a preset next to the rightmost artboard, grows the canvas, and undoes in one step', () => {
    const session = sessionWith(twoBoards());
    const id = createArtboard(session, { preset: 'instagram-story' })!;
    const created = session.document!.artboards!.find((a) => a.id === id)!;
    expect(created).toMatchObject({ name: 'Instagram Story', rect: { x: 400, y: 0, width: 1080, height: 1920 } });
    expect([session.document!.width, session.document!.height]).toEqual([1480, 1920]);
    expect(session.undo()).toBe(true);
    expect(session.document!.artboards!.map((a) => a.id)).toEqual(['A', 'B']);
    expect([session.document!.width, session.document!.height]).toEqual([300, 100]);
    expect(session.redo()).toBe(true);
    expect(session.document!.artboards).toHaveLength(3);
  });

  it('creates from a rect, rejects invalid rects and unknown presets', () => {
    const session = sessionWith({ id: 'd', width: 50, height: 50, resolution: 72, selection: null, layers: [], artboards: [] });
    expect(createArtboard(session, { rect: { x: 0, y: 0, width: 50, height: 50 }, name: 'Canvas' })).toBeTruthy();
    expect(createArtboard(session, { rect: { x: -5, y: 0, width: 10, height: 10 } })).toBeNull();
    expect(lastArtboardError?.code).toBe('invalid-rect');
    expect(createArtboard(session, { preset: 'nope' })).toBeNull();
    expect(createArtboard(session, { rect: { x: 0, y: 0, width: 30_000, height: 30_000 } })).toBeNull();
    expect(lastArtboardError?.code).toBe('too-large');
    expect(session.document!.artboards).toHaveLength(1);
  });

  it('moves an artboard with its content only; loose layers and other artboards stay', () => {
    const session = sessionWith(twoBoards());
    expect(moveArtboard(session, 'A', 5, 7)).toBe(true);
    const layers = new Map(session.document!.layers.map((l) => [l.id, l]));
    expect(session.document!.artboards![0]!.rect).toMatchObject({ x: 5, y: 7 });
    expect(layers.get('a1')!.transform.origin).toEqual({ x: 15, y: 17 });
    expect(layers.get('clipped-to-a1')!.transform.origin).toEqual({ x: 5, y: 7 });
    expect(layers.get('b-in-group')!.transform.origin).toEqual({ x: 220, y: 20 });
    expect(layers.get('loose')!.transform.origin).toEqual({ x: 120, y: 40 });
    expect(session.document!.height).toBe(107); // canvas grew to fit
    session.undo();
    expect(session.document!.layers.find((l) => l.id === 'a1')!.transform.origin).toEqual({ x: 10, y: 10 });
  });

  it('refuses to move content that is locked in position', () => {
    const document = twoBoards();
    const session = sessionWith({ ...document, layers: document.layers.map((l) => (l.id === 'a1' ? { ...l, locks: { ...l.locks, position: true } } : l)) });
    expect(moveArtboard(session, 'A', 5, 0)).toBe(false);
    expect(lastArtboardError?.code).toBe('locked');
  });

  it('resizes without moving content, renames, recolours and reorders', () => {
    const session = sessionWith(twoBoards());
    expect(resizeArtboard(session, 'B', { x: 190, y: 0, width: 150.4, height: 120 })).toBe(true);
    expect(session.document!.artboards![1]!.rect).toEqual({ x: 190, y: 0, width: 150, height: 120 });
    expect(session.document!.layers.find((l) => l.id === 'b-in-group')!.transform.origin).toEqual({ x: 220, y: 20 });
    expect([session.document!.width, session.document!.height]).toEqual([340, 120]);
    expect(renameArtboard(session, 'B', '  Story ')).toBe(true);
    expect(session.document!.artboards![1]!.name).toBe('Story');
    expect(setArtboardBackground(session, 'B', { red: 0, green: 0, blue: 0, alpha: 0 })).toBe(true);
    expect(session.document!.artboards![1]!.background.alpha).toBe(0);
    expect(reorderArtboard(session, 'B', 0)).toBe(true);
    expect(session.document!.artboards!.map((a) => a.id)).toEqual(['B', 'A']);
    for (let i = 0; i < 4; i++) session.undo();
    expect(session.document!.artboards).toEqual(twoBoards().artboards);
  });

  it('duplicates an artboard with its content (new ids, remapped parents and clipping)', () => {
    const session = sessionWith(twoBoards());
    const copyId = duplicateArtboard(session, 'A')!;
    const document = session.document!;
    const copy = document.artboards!.find((a) => a.id === copyId)!;
    expect(copy).toMatchObject({ name: 'A copy', rect: { x: 400, y: 0, width: 100, height: 100 } });
    const membership = artboardMembership(document);
    const copied = document.layers.filter((l) => membership.get(l.id) === copyId);
    expect(copied).toHaveLength(2);
    const base = copied.find((l) => !l.maskSourceId)!, clipped = copied.find((l) => l.maskSourceId)!;
    expect(base.id).not.toBe('a1');
    expect(clipped.maskSourceId).toBe(base.id);
    expect(base.transform.origin).toEqual({ x: 410, y: 10 });
    expect(base.raster).toBe(document.layers.find((l) => l.id === 'a1')!.raster); // pixels are shared, not copied
    // Copies sit right above the source's topmost member.
    expect(document.layers.findIndex((l) => l.id === base.id)).toBe(document.layers.findIndex((l) => l.id === 'clipped-to-a1') + 1);
  });

  it('deletes an artboard with or without its content', () => {
    const session = sessionWith(twoBoards());
    expect(deleteArtboard(session, 'B', { contents: 'keep' })).toBe(true);
    expect(session.document!.layers.some((l) => l.id === 'b-in-group')).toBe(true);
    expect(artboardMembership(session.document!).get('b-in-group')).toBeNull();
    session.undo();
    expect(deleteArtboard(session, 'A')).toBe(true);
    expect(session.document!.layers.map((l) => l.id)).toEqual(['group', 'b-in-group', 'loose', 'adjust']);
    session.undo();
    expect(session.document!.layers).toHaveLength(6);
  });
});

describe('artboards in format v2', () => {
  it('round-trips artboards with backgrounds, labels and order', async () => {
    const document: CanvasDocument = { ...twoBoards(), artboards: [
      { ...board('B', 200, 0, 100, 100), background: { red: 0.2, green: 0.4, blue: 0.6, alpha: 0.5 }, colorLabel: 'violet' },
      board('A', 0, 0, 100, 100),
    ] };
    const archived = writeArchive(document, 'Boards', null);
    const manifest = JSON.parse(new TextDecoder().decode(unzipSync(new Uint8Array(await archived.blob.arrayBuffer()))['manifest.json'])) as ProjectManifestV2;
    expect(manifest.artboards.map((a) => a.id)).toEqual(['B', 'A']);
    const loaded = await readArchive(archived.blob, decoder);
    expect(loaded.document.artboards).toEqual(document.artboards);
    expect(artboardMembership(loaded.document)).toEqual(artboardMembership(document));
  });

  it('reads older v2 artboard records without background and documents without artboards', async () => {
    const archived = writeArchive({ ...twoBoards(), artboards: [] }, 'Plain', null);
    const files = unzipSync(new Uint8Array(await archived.blob.arrayBuffer()));
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as ProjectManifestV2;
    const legacy = { ...manifest, artboards: [{ id: 'old', name: 'Old', rect: { x: 0, y: 0, width: 10, height: 10 } }] };
    files['manifest.json'] = new TextEncoder().encode(JSON.stringify(legacy));
    const loaded = await readArchive(new Blob([zipSync(files) as BlobPart]), decoder);
    expect(loaded.document.artboards).toEqual([{ id: 'old', name: 'Old', rect: { x: 0, y: 0, width: 10, height: 10 },
      background: { red: 1, green: 1, blue: 1, alpha: 1 }, colorLabel: 'none' }]);
    const plain = await readArchive(archived.blob, decoder);
    expect(plain.document.artboards).toEqual([]);
  });
});
