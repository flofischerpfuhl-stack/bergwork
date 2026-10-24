import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { defaultAdjustment } from '../../src/core/adjustments';
import { newLayer, type CanvasDocument, type Layer, type LayerShape } from '../../src/core/document';
import { makeTransform, type LayerTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import {
  COMP_CURRENT_VERSION, readCompPackage, readCompZip, writeCompZip,
  type CompManifest,
} from '../../src/io/compPackage';
import { encodePng } from '../../src/io/png';
import { ProjectError } from '../../src/io/project';

const DOCUMENT = '10000000-0000-4000-8000-000000000001';
const BASE = '20000000-0000-4000-8000-000000000002';
const CLIPPED = '30000000-0000-4000-8000-000000000003';
const GROUP = '40000000-0000-4000-8000-000000000004';
const ADJUSTMENT = '50000000-0000-4000-8000-000000000005';
const SHAPE = '60000000-0000-4000-8000-000000000006';

const transform: LayerTransform = {
  origin: { x: -27.5, y: 88.25 }, size: { width: 123, height: 47 }, rotation: 38,
  flipX: true, flipY: true, sampling: 'Nearest',
};

function pixels(): Uint8Array {
  return new Uint8Array([
    255, 1, 2, 255, 3, 4, 5, 0,
    6, 7, 8, 128, 9, 10, 11, 255,
  ]);
}

type LegacyTestFields = Partial<Layer> & { isGroup?: boolean; shape?: LayerShape | null };

function testLayer(id: string, raster: Raster | null, defaults: LegacyTestFields, extra: LegacyTestFields): Layer {
  const merged = { ...defaults, ...extra };
  const { isGroup, shape, ...fields } = merged;
  const kind = isGroup ? 'group' : fields.adjustment ? 'adjustment' : shape && raster ? 'vector' : 'pixel';
  return newLayer({ id, name: fields.name ?? 'Blank', transform: fields.transform ?? transform, ...fields, raster, kind,
    ...(shape && raster ? { sourceShape: shape, paths: [], style: { fill: { kind: 'solid' as const, schemaVersion: 1 as const,
      color: { red: shape.red, green: shape.green, blue: shape.blue } }, stroke: null } } : {}) });
}

function rgbaLayer(id = BASE, extra: LegacyTestFields = {}): Layer {
  return testLayer(id, Raster.fromPixels(2, 2, 4, pixels()), {
    name: 'Paint & sky 🌤', visible: false, parentId: null,
    opacity: 0.625, blendMode: 'multiply', transform, mask: null, maskSourceId: null,
  }, extra);
}

function blankLayer(id = CLIPPED, extra: LegacyTestFields = {}): Layer {
  return testLayer(id, null, {
    name: 'Blank', visible: true, parentId: null,
    opacity: 1, blendMode: 'normal', transform: makeTransform({ x: 0, y: 0 }, { width: 64, height: 32 }),
    mask: null, maskSourceId: null,
  }, extra);
}

function document(layers: readonly Layer[]): CanvasDocument {
  return { id: DOCUMENT, width: 640, height: 480, resolution: 300, layers, selection: null };
}

function manifest(version: number, layers: Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'com.compositor.project', version, colorSpace: 'sRGB', documentID: DOCUMENT,
    width: 640, height: 480, activeLayerID: layers[0]?.id, layers, ...extra,
  };
}

function record(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: id === GROUP ? 'Folder' : 'Layer', isVisible: true,
    transform: makeTransform({ x: 0, y: 0 }, { width: 2, height: 2 }), imageFile: null, ...extra };
}

function packageMap(value: Record<string, unknown>, assets: Record<string, Uint8Array> = {}, prefix = ''): Map<string, Uint8Array> {
  return new Map([
    [`${prefix}manifest.json`, new TextEncoder().encode(JSON.stringify(value))],
    ...Object.entries(assets).map(([path, bytes]) => [`${prefix}images/${path}`, bytes] as [string, Uint8Array]),
  ]);
}

describe('upstream .comp packages (ProjectStore.swift)', () => {
  it('ProjectTests.projectRoundTripSurvivesSourceRemovalAndPackageMove: ZIP round-trips metadata and exact pixels', async () => {
    const original = document([rgbaLayer(), blankLayer()]);
    const zip = await writeCompZip(original, { name: 'Original', activeLayerId: BASE });
    const entries = unzipSync(zip);
    expect(entries['Original.comp/manifest.json']).toBeDefined();
    expect(entries['Original.comp/images/20000000-0000-4000-8000-000000000002.png']).toBeDefined();
    expect(Object.keys(entries).some((path) => path.endsWith(`${CLIPPED}.png`))).toBe(false);

    // Moving/renaming the outer ZIP cannot affect its embedded package-relative assets.
    const reopened = await readCompZip(zip.slice());
    expect(reopened.name).toBe('Original');
    expect(reopened.activeLayerId).toBe(BASE);
    expect(reopened.document.id).toBe(original.id);
    expect(reopened.document).toMatchObject({ width: 640, height: 480, resolution: 300 });
    expect(reopened.document.layers.map((layer) => ({
      id: layer.id, name: layer.name, visible: layer.visible, transform: layer.transform,
    }))).toEqual(original.layers.map((layer) => ({
      id: layer.id, name: layer.name, visible: layer.visible, transform: layer.transform,
    })));
    expect(reopened.document.layers[0]!.raster?.toPixels()).toEqual(pixels());
    expect(reopened.document.layers[1]!.raster).toBeNull();
  });

  it('ProjectTests.overwriteReplacesPackageAndDropsRemovedAssets: each write contains only current assets', async () => {
    const first = unzipSync(await writeCompZip(document([rgbaLayer()]), { name: 'Overwrite' }));
    expect(Object.keys(first).some((path) => path.endsWith(`${BASE}.png`))).toBe(true);
    const secondBytes = await writeCompZip(document([blankLayer()]), { name: 'Overwrite' });
    const second = unzipSync(secondBytes);
    expect(Object.keys(second).some((path) => path.endsWith('.png'))).toBe(false);
    expect((await readCompZip(secondBytes)).document.layers).toHaveLength(1);
  });

  it('ProjectTests.failedSavePreservesPreviouslySavedPackage: failed encoding cannot mutate prior bytes', async () => {
    const saved = await writeCompZip(document([blankLayer()]));
    const prior = saved.slice();
    const invalid = { ...document([blankLayer()]), width: 30_001 };
    await expect(writeCompZip(invalid)).rejects.toMatchObject({ code: 'too-large' });
    expect(saved).toEqual(prior);
    expect((await readCompZip(saved)).document.layers).toHaveLength(1);
  });

  it('ProjectTests.unsupportedCorruptAndUnsafeMetadataAreRejected', async () => {
    const good = manifest(6, [record(BASE)]);
    await expect(readCompPackage(packageMap({ ...good, version: 8 }))).rejects.toMatchObject({
      code: 'version',
      message: 'This project uses format version 8. This app supports versions 1–7.',
    });
    await expect(readCompPackage(new Map([['manifest.json', new TextEncoder().encode('not json')]])))
      .rejects.toMatchObject({ code: 'invalid' });
    await expect(readCompPackage(packageMap(manifest(6, [record(BASE, { imageFile: '../../outside.png' })]))))
      .rejects.toMatchObject({ code: 'invalid' });

    const unsafeZip = zipSync({ '../manifest.json': new TextEncoder().encode(JSON.stringify(good)) });
    await expect(readCompZip(unsafeZip)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('ProjectTests.missingEmbeddedImageIsRejected', async () => {
    const value = manifest(6, [record(BASE, { imageFile: `${BASE}.png` })]);
    await expect(readCompPackage(packageMap(value))).rejects.toMatchObject({ code: 'missing-image' });
  });

  it('ProjectTests.projectOperationsBlockEditsAndQueueImageImports: a rejected read leaves caller state untouched', async () => {
    // Browser package I/O has no EditorSession state to lock; its equivalent guarantee is that it
    // builds a detached document only after every file validates (ProjectStore.readPackage).
    const live = document([blankLayer()]);
    const before = live.layers;
    await expect(readCompPackage(packageMap(manifest(6, [record(BASE, { imageFile: `${BASE}.png` })]))))
      .rejects.toBeInstanceOf(ProjectError);
    expect(live.layers).toBe(before);
    expect(live.layers[0]!.id).toBe(CLIPPED);
  });

  it('reads hand-written v1–v6 manifests with documented migration defaults and features', async () => {
    const image = encodePng(pixels(), 2, 2, 4);
    const mask = encodePng(new Uint8Array([0, 64, 128, 255]), 2, 2, 1);

    const v1 = await readCompPackage(packageMap(manifest(1, [record(BASE, { imageFile: `${BASE}.png` })]), {
      [`${BASE}.png`]: image,
    }));
    expect(v1.document.resolution).toBe(72);
    expect(v1.document.layers[0]).toMatchObject({ parentId: null, kind: 'pixel', opacity: 1, blendMode: 'normal', mask: null, maskSourceId: null });

    const v2 = await readCompPackage(packageMap(manifest(2, [
      record(GROUP, { isGroup: true }), record(BASE, { parentID: GROUP }),
    ])));
    expect(v2.document.layers.map((layer) => [layer.id, layer.parentId, layer.kind])).toEqual([
      [GROUP, null, 'group'], [BASE, GROUP, 'pixel'],
    ]);

    const v3 = await readCompPackage(packageMap(manifest(3, [record(BASE, { opacity: 0.25, blendMode: 'Screen' })])));
    expect(v3.document.layers[0]).toMatchObject({ opacity: 0.25, blendMode: 'screen' });

    const v4 = await readCompPackage(packageMap(manifest(4, [record(BASE, {
      imageFile: `${BASE}.png`, maskFile: `${BASE}.mask.png`, maskEnabled: false,
    })]), { [`${BASE}.png`]: image, [`${BASE}.mask.png`]: mask }));
    expect(v4.document.layers[0]!.mask?.enabled).toBe(false);
    expect(v4.document.layers[0]!.mask?.linked).toBe(true);
    expect(v4.document.layers[0]!.mask?.raster.toPixels()).toEqual(new Uint8Array([0, 64, 128, 255]));

    const v5 = await readCompPackage(packageMap(manifest(5, [
      record(BASE), record(CLIPPED, { maskSourceID: BASE }),
    ])));
    expect(v5.document.layers[1]!.maskSourceId).toBe(BASE);

    const v6 = await readCompPackage(packageMap(manifest(6, [record(GROUP, {
      isGroup: true, maskFile: `${GROUP}.mask.png`, maskEnabled: true,
    })]), { [`${GROUP}.mask.png`]: mask }));
    expect(v6.document.layers[0]!.kind).toBe('group');
    expect(v6.document.layers[0]!.mask?.raster.toPixels()).toEqual(new Uint8Array([0, 64, 128, 255]));
  });

  it('version 7 round-trips groups, masks, placement/link state, clipping, adjustments, and shapes', async () => {
    const groupMask = Raster.fromPixels(2, 1, 1, new Uint8Array([255, 10]));
    const placed = makeTransform({ x: 17, y: 19 }, { width: 40, height: 20 }, { rotation: -12, sampling: 'Smooth' });
    const group = blankLayer(GROUP, {
      name: 'Folder', isGroup: true, transform: makeTransform({ x: 0, y: 0 }, { width: 640, height: 480 }),
      mask: { raster: groupMask, enabled: true, placement: placed, linked: false },
    });
    const base = rgbaLayer(BASE, { parentId: GROUP, visible: true, opacity: 1, blendMode: 'normal' });
    const clipped = blankLayer(CLIPPED, { parentId: GROUP, maskSourceId: BASE });
    const adjustment = blankLayer(ADJUSTMENT, {
      name: 'Exposure', adjustment: defaultAdjustment('Exposure', { red: 0, green: 0, blue: 0 }, { red: 1, green: 1, blue: 1 }),
    });
    const shape = rgbaLayer(SHAPE, {
      name: 'Rectangle', visible: true, opacity: 1, blendMode: 'normal',
      shape: { kind: 'Rectangle', red: 0.25, green: 0.5, blue: 0.75, cornerRadius: 4 },
    });
    const archive = await writeCompZip(document([group, base, clipped, adjustment, shape]), { name: 'Rich' });
    const raw = unzipSync(archive);
    const stored = JSON.parse(new TextDecoder().decode(raw['Rich.comp/manifest.json'])) as CompManifest;
    expect(stored.version).toBe(COMP_CURRENT_VERSION);
    expect(stored.layers.find((layer) => layer.id === GROUP)).toMatchObject({
      isGroup: true, maskFile: `${GROUP}.mask.png`, maskPlacement: placed, maskLinked: false,
    });

    const loaded = await readCompZip(archive);
    expect(loaded.document.layers[0]!.mask).toMatchObject({ enabled: true, linked: false, placement: placed });
    expect(loaded.document.layers[0]!.mask?.raster.toPixels()).toEqual(new Uint8Array([255, 10]));
    expect(loaded.document.layers[2]!.maskSourceId).toBe(BASE);
    expect(loaded.document.layers[3]!.adjustment?.kind).toBe('Exposure');
    expect(loaded.document.layers[4]!.kind === 'vector' ? loaded.document.layers[4]!.sourceShape : null)
      .toEqual(shape.kind === 'vector' ? shape.sourceShape : null);
    expect(loaded.document.layers[4]!.raster?.toPixels()).toEqual(pixels());
  });

  it('reads and round-trips a v7 adjustment layer, while v6 rejects it', async () => {
    const adjustment = defaultAdjustment('Exposure', { red: 0, green: 0, blue: 0 }, { red: 1, green: 1, blue: 1 });
    const adjustmentRecord = record(ADJUSTMENT, { name: 'Exposure', adjustment });
    const loaded = await readCompPackage(packageMap(manifest(7, [adjustmentRecord])));
    expect(loaded.document.layers[0]).toMatchObject({
      id: ADJUSTMENT, kind: 'adjustment', adjustment,
    });
    expect('raster' in loaded.document.layers[0]!).toBe(false);

    const archive = await writeCompZip(loaded.document, { name: 'Adjustment', activeLayerId: ADJUSTMENT });
    const stored = JSON.parse(new TextDecoder().decode(unzipSync(archive)['Adjustment.comp/manifest.json'])) as CompManifest;
    expect(stored.version).toBe(7);
    expect(stored.layers[0]!.adjustment).toEqual({ kind: 'Exposure', exposureSettings: adjustment.parameters });
    expect((await readCompZip(archive)).document.layers[0]!.adjustment).toEqual(adjustment);

    await expect(readCompPackage(packageMap(manifest(6, [adjustmentRecord])))).rejects.toMatchObject({
      code: 'invalid', message: 'This is not a valid Compositor project, or its metadata is damaged.',
    });
  });

  it('rejects version-gated fields, invalid graphs, bad masks, and noncanonical asset names', async () => {
    const gray = encodePng(new Uint8Array([255]), 1, 1, 1);
    const rgba = encodePng(new Uint8Array([255, 255, 255, 255]), 1, 1, 4);
    await expect(readCompPackage(packageMap(manifest(3, [record(BASE, { maskFile: `${BASE}.mask.png` })]), {
      [`${BASE}.mask.png`]: gray,
    }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(readCompPackage(packageMap(manifest(4, [record(GROUP, { isGroup: true, maskFile: `${GROUP}.mask.png` })]), {
      [`${GROUP}.mask.png`]: gray,
    }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(readCompPackage(packageMap(manifest(6, [record(BASE, { maskFile: `${BASE}.mask.png` })]), {
      [`${BASE}.mask.png`]: rgba,
    }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(readCompPackage(packageMap(manifest(6, [record(BASE, { parentID: GROUP })]))))
      .rejects.toMatchObject({ code: 'invalid' });
    await expect(readCompPackage(packageMap(manifest(6, [record(BASE, { imageFile: 'other.png' })]))))
      .rejects.toMatchObject({ code: 'invalid' });
  });
});
