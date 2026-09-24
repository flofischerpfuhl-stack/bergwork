import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { ProjectManifestV1 } from '../../contracts';
import type { ProjectManifestV2 } from '../../contracts-v2';
import { newLayer, type CanvasDocument } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { EditorSession } from '../../src/core/session';
import { Raster } from '../../src/core/raster';
import { buildManifest, readArchive, writeArchive } from '../../src/io/project';
import { decodePng } from '../../src/io/png';

const decoder = async (bytes: Uint8Array) => {
  const png = decodePng(bytes);
  return { width: png.width, height: png.height, channels: png.channels, data: png.data };
};
const transform = makeTransform({ x: 0, y: 0 }, { width: 4, height: 3 });

function fixture(): CanvasDocument {
  const common = (id: string, name: string) => ({ id, name, transform, fillOpacity: 0.8,
    locks: { transparency: false, pixels: false, position: false, all: false }, colorLabel: 'none' as const });
  return { id: 'document-v2', width: 40, height: 30, resolution: 144, selection: null,
    resources: [{ id: 'embedded-svg', role: 'embedded', mime: 'image/svg+xml', bytes: new TextEncoder().encode('<svg/>') }],
    artboards: [{ id: 'artboard-1', name: 'Banner', rect: { x: 1, y: 2, width: 20, height: 10 },
      background: { red: 1, green: 1, blue: 1, alpha: 0 }, colorLabel: 'green' }],
    layers: [
      newLayer({ ...common('pixel', 'Pixel'), kind: 'pixel', raster: Raster.fromPixels(1, 1, 4, new Uint8Array([7, 8, 9, 255])),
        effects: [{ kind: 'stroke', schemaVersion: 1, enabled: true, width: 2, position: 'inside', color: { red: 1, green: 0, blue: 0 } }],
        filters: [{ kind: 'gaussianBlur', schemaVersion: 1, enabled: true, radius: 3 }] }),
      newLayer({ ...common('group', 'Group'), kind: 'group' }),
      newLayer({ ...common('adjustment', 'Levels'), kind: 'adjustment', adjustment: { kind: 'Levels', schemaVersion: 1,
        levels: { channel: 'RGB', ranges: Array.from({ length: 4 }, () => ({ black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 })) } } }),
      newLayer({ ...common('fill', 'Fill'), kind: 'fill', fill: { kind: 'gradient', schemaVersion: 1, angle: 45,
        stops: [{ offset: 0, color: { red: 0, green: 0, blue: 0 }, opacity: 1 }, { offset: 1, color: { red: 1, green: 1, blue: 1 }, opacity: 1 }] } }),
      newLayer({ ...common('vector', 'Vector'), kind: 'vector', paths: [{ closed: true, points: [{ anchor: { x: 0, y: 0 }, in: { x: 0, y: 0 }, out: { x: 1, y: 0 } }] }],
        style: { fill: { kind: 'solid', schemaVersion: 1, color: { red: 0, green: 0.5, blue: 1 } }, stroke: null } }),
      newLayer({ ...common('text', 'Text'), kind: 'text', text: 'Hello', runs: [{ from: 0, to: 5, fontFamily: 'Inter', fontSize: 18,
        color: { red: 0, green: 0, blue: 0 } }], box: { width: 100, height: 30 }, alignment: 'center' }),
      newLayer({ ...common('embedded', 'SVG'), kind: 'embedded', content: { mode: 'embedded', mediaType: 'svg', assetId: 'embedded-svg', sourceName: 'logo.svg' } }),
    ] };
}

describe('format v2 (PRODUCT-PLAN A2/P7/P8)', () => {
  it('round-trips every layer kind and document-level artboards', async () => {
    const archived = writeArchive(fixture(), 'Kinds', 'text');
    const files = unzipSync(new Uint8Array(await archived.blob.arrayBuffer()));
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as ProjectManifestV2;
    expect(manifest.format).toBe('fernwork-image');
    expect(manifest.version).toBe(2);
    expect(manifest.layers.map((layer) => layer.kind)).toEqual(['pixel', 'group', 'adjustment', 'fill', 'vector', 'text', 'embedded']);

    const loaded = await readArchive(archived.blob, decoder);
    expect(loaded.document.layers.map((layer) => layer.kind)).toEqual(manifest.layers.map((layer) => layer.kind));
    expect(loaded.document.layers[0]!.raster!.pixel(0, 0)).toEqual([7, 8, 9, 255]);
    expect(loaded.document.layers[0]!.effects?.[0]?.kind).toBe('stroke');
    expect((loaded.document.layers[3] as import('../../src/core/model').FillLayer).fill.kind).toBe('gradient');
    expect((loaded.document.layers[5] as import('../../src/core/model').TextLayer).text).toBe('Hello');
    expect((loaded.document.layers[6] as import('../../src/core/model').EmbeddedLayer).content.assetId).toBe('embedded-svg');
    expect(new TextDecoder().decode(loaded.document.resources?.[0]?.bytes)).toBe('<svg/>');
    expect(loaded.document.artboards?.[0]?.name).toBe('Banner');
  });

  it('migrates a v1 fernwork-compositor manifest losslessly', async () => {
    const source: CanvasDocument = { id: 'legacy', width: 12, height: 9, resolution: 300, selection: null, layers: [], artboards: [] };
    const manifest: ProjectManifestV1 = buildManifest(source, 'Legacy', null);
    const archive = new Blob([zipSync({ 'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)) }) as BlobPart]);
    const loaded = await readArchive(archive, decoder);
    expect(loaded.document).toMatchObject({ id: 'legacy', width: 12, height: 9, resolution: 300, artboards: [] });
    expect(writeArchive(loaded.document, loaded.name, null).manifest.format).toBe('fernwork-image');
  });

  it('restores command history so undo continues after reload', async () => {
    const session = new EditorSession(undefined, { retainedByteLimit: 8 * 1024 * 1024 });
    session.createNewProject(10, 10, 'History');
    const red = session.insertRaster(Raster.fromPixels(1, 1, 4, new Uint8Array([255, 0, 0, 255])), 'Red');
    session.replaceLayerPixels(red, Raster.fromPixels(1, 1, 4, new Uint8Array([0, 0, 255, 255])), 'Paint');
    const archive = writeArchive(session.document!, 'History', session.activeLayerId, session.history.exportState());
    expect(archive.manifest.history?.commands).toHaveLength(2);
    expect(archive.manifest.assets.some((asset) => asset.role === 'history-tile')).toBe(true);
    const loaded = await readArchive(archive.blob, decoder);
    const restored = new EditorSession();
    restored.installProject(loaded.document, loaded.activeLayerId, loaded.name, loaded.history);
    expect(restored.document!.layers).toHaveLength(2);
    expect(restored.undo()).toBe(true);
    expect(restored.document!.layers[1]!.raster!.pixel(0, 0)).toEqual([255, 0, 0, 255]);
    expect(restored.undo()).toBe(true);
    expect(restored.document!.layers).toHaveLength(1);
    expect(restored.redo()).toBe(true);
    expect(restored.redo()).toBe(true);
    expect(restored.document!.layers[1]!.raster!.pixel(0, 0)).toEqual([0, 0, 255, 255]);
  });

  it('persists the explicit history-off setting without commands', async () => {
    const session = new EditorSession(undefined, { enabled: false });
    session.createNewProject(4, 4);
    session.addBlankLayer();
    expect(session.isModified).toBe(true);
    expect(session.history.canUndo).toBe(false);
    const archive = writeArchive(session.document!, 'No history', null, session.history.exportState());
    expect(archive.manifest.history).toMatchObject({ enabled: false, commands: [] });
    const loaded = await readArchive(archive.blob, decoder);
    expect(loaded.history?.enabled).toBe(false);
  });
});
