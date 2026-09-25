import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { newLayer, type CanvasDocument, type LayerLocks } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { fillSelection } from '../../src/core/selectionCommands';
import { EditorSession } from '../../src/core/session';
import { buildManifest, readArchive, writeArchive } from '../../src/io/project';

const transform = makeTransform({ x: 0, y: 0 }, { width: 2, height: 1 });
const unlocked: LayerLocks = { transparency: false, pixels: false, position: false, all: false };

function layer(id: string, parentId: string | null = null, locks: LayerLocks = unlocked) {
  return newLayer({ id, name: id, parentId, transform, locks,
    raster: Raster.fromPixels(2, 1, 4, new Uint8Array([10, 20, 30, 0, 40, 50, 60, 128])) });
}

function sessionWith(layers = [layer('paint')]): EditorSession {
  const session = new EditorSession();
  const document: CanvasDocument = { id: 'locks', width: 20, height: 20, resolution: 72, selection: null, layers };
  session.installProject(document, layers.at(-1)?.id ?? null, null);
  return session;
}

describe('layer locks (PRODUCT-PLAN 6.1)', () => {
  it('inherits group locks, allows movement under pixel lock, and reports position refusal', () => {
    const group = newLayer({ id: 'group', name: 'Folder', kind: 'group', transform,
      locks: { ...unlocked, pixels: true } });
    const session = sessionWith([group, layer('child', 'group')]);
    expect(session.lockState('child')).toMatchObject({ pixels: true, position: false, all: false });

    const beforePixels = session.layer('child')!.raster;
    session.replaceLayerPixels('child', Raster.fromPixels(2, 1, 4, new Uint8Array(8).fill(255)), 'Paint');
    expect(session.layer('child')!.raster).toBe(beforePixels);
    expect(session.lastEditBlocker).toMatchObject({ code: 'layer-lock-pixels', layerId: 'child', sourceLayerId: 'group' });

    session.nudgeLayer(3, 2);
    expect(session.layer('child')!.transform.origin).toEqual({ x: 3, y: 2 });
    session.setLayerLocks(['group'], { position: true });
    const moved = session.layer('child')!.transform;
    session.nudgeLayer(1, 0);
    expect(session.layer('child')!.transform).toBe(moved);
    expect(session.lastEditBlocker?.code).toBe('layer-lock-position');
  });

  it('keeps destination alpha exactly during a real Fill command when transparency is locked', () => {
    const session = sessionWith([layer('paint', null, { ...unlocked, transparency: true })]);
    session.foregroundColor = { red: 210 / 255, green: 160 / 255, blue: 110 / 255 };
    expect(fillSelection(session, 'foreground')).toBe(true);
    expect(session.layer('paint')!.raster!.toPixels()).toEqual(
      new Uint8Array([0, 0, 0, 0, 210, 160, 110, 128]));
    expect(session.history.undoName).toBe('Fill');
    expect(session.undo()).toBe(true);
    expect(session.layer('paint')!.raster!.toPixels()).toEqual(
      new Uint8Array([10, 20, 30, 0, 40, 50, 60, 128]));
  });

  it('records locks, fill opacity, and colour labels as readable single undo steps', () => {
    const session = sessionWith([layer('a'), layer('b')]);
    session.selectLayers(['a', 'b'], 'b');
    session.setLayerLocks(session.selectedLayerIds, { transparency: true, pixels: true });
    expect(session.history.undoName).toBe('Set Layer Locks');
    expect(session.document!.layers.every((item) => item.locks.transparency && item.locks.pixels)).toBe(true);
    session.setFillOpacity(session.selectedLayerIds, 0.35);
    expect(session.history.undoName).toBe('Layer Fill Opacity');
    session.setColorLabel(session.selectedLayerIds, 'violet');
    expect(session.history.undoName).toBe('Set Layer Color Labels');
    expect(session.document!.layers.every((item) => item.fillOpacity === 0.35 && item.colorLabel === 'violet')).toBe(true);
    expect(session.undo()).toBe(true);
    expect(session.document!.layers.every((item) => item.colorLabel === 'none')).toBe(true);

    expect(session.beginFillOpacityEdit(session.selectedLayerIds)).toBe(true);
    session.setFillOpacity(session.selectedLayerIds, 0.6);
    session.setFillOpacity(session.selectedLayerIds, 0.8);
    session.finishFillOpacityEdit();
    expect(session.history.undoName).toBe('Layer Fill Opacity');
    expect(session.undo()).toBe(true);
    expect(session.document!.layers.every((item) => item.fillOpacity === 0.35)).toBe(true);
  });

  it('refuses a multi-layer appearance edit atomically, while full lock permits rename and delete', async () => {
    const session = sessionWith([layer('free'), layer('locked', null, { ...unlocked, all: true })]);
    session.selectLayers(['free', 'locked'], 'locked');
    session.setFillOpacity(session.selectedLayerIds, 0.25);
    expect(session.document!.layers.map((item) => item.fillOpacity)).toEqual([1, 1]);
    expect(session.lastEditBlocker?.code).toBe('layer-lock-all');
    session.renameLayer('locked', 'Renamed');
    expect(session.layer('locked')?.name).toBe('Renamed');
    await session.deleteLayer('locked');
    expect(session.layer('locked')).toBeNull();
  });

  it('maps v1 locked to locks.all and round-trips v2 lock/fill/label state losslessly', async () => {
    const original = sessionWith([newLayer({ id: 'legacy', name: 'Legacy', transform,
      locks: { ...unlocked, all: true }, raster: null })]).document!;
    const legacy = buildManifest(original, 'Legacy', 'legacy');
    expect(legacy.layers[0]!.locked).toBe(true);
    const v1 = new Blob([zipSync({ 'manifest.json': new TextEncoder().encode(JSON.stringify(legacy)) }) as BlobPart]);
    const migrated = await readArchive(v1, async () => { throw new Error('No asset expected'); });
    expect(migrated.document.layers[0]!.locks).toEqual({ ...unlocked, all: true });

    const changed = { ...migrated.document, layers: [{ ...migrated.document.layers[0]!, fillOpacity: 0.42,
      colorLabel: 'orange' as const, locks: { transparency: true, pixels: false, position: true, all: false } }] };
    const v2 = writeArchive(changed, 'Locks', 'legacy');
    const reloaded = await readArchive(v2.blob, async () => { throw new Error('No asset expected'); });
    expect(reloaded.document.layers[0]).toMatchObject({ fillOpacity: 0.42, colorLabel: 'orange',
      locks: { transparency: true, pixels: false, position: true, all: false } });
  });
});
