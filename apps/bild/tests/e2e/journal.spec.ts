import { expect, test } from '@playwright/test';

test('kill recovery restores the last committed state and its undo history within five seconds', async ({ context, page }) => {
  await page.goto('/?harness=1');
  const written = await page.evaluate(async () => {
    const root = '/src/';
    const [{ EditorSession }, { Raster }, { RasterResidency, TileCache }, { BrowserScratchHost }, { RecoveryStore }] = await Promise.all([
      import(root + 'core/session.ts') as Promise<typeof import('../../src/core/session')>,
      import(root + 'core/raster.ts') as Promise<typeof import('../../src/core/raster')>,
      import(root + 'core/storage/index.ts') as Promise<typeof import('../../src/core/storage')>,
      import(root + 'platform/opfsScratchHost.ts') as Promise<typeof import('../../src/platform/opfsScratchHost')>,
      import(root + 'platform/recovery.ts') as Promise<typeof import('../../src/platform/recovery')>,
    ]);
    const session = new EditorSession();
    session.createNewProject(8, 8, 'Crash test');
    session.insertRaster(Raster.fromPixels(1, 1, 4, new Uint8Array([11, 22, 33, 255])), 'pixels');
    const host = new BrowserScratchHost();
    const store = new RecoveryStore(host);
    const residency = new RasterResidency(new TileCache(host, 1024));
    const savedAt = Date.now();
    await store.putState({ id: 'kill-test', name: 'Crash test', savedAt, document: session.document!,
      activeLayerId: session.activeLayerId, history: session.history.exportState(), command: session.history.undoName }, residency);
    return { savedAt, layers: session.document!.layers.length, undo: session.history.undoCount };
  });
  expect(written).toMatchObject({ layers: 2, undo: 1 });

  await page.close({ runBeforeUnload: false });
  const restarted = await context.newPage();
  await restarted.goto('/?harness=1');
  const recovered = await restarted.evaluate(async () => {
    const root = '/src/';
    const [{ EditorSession }, { RasterResidency, TileCache }, { BrowserScratchHost }, { RecoveryStore }] = await Promise.all([
      import(root + 'core/session.ts') as Promise<typeof import('../../src/core/session')>,
      import(root + 'core/storage/index.ts') as Promise<typeof import('../../src/core/storage')>,
      import(root + 'platform/opfsScratchHost.ts') as Promise<typeof import('../../src/platform/opfsScratchHost')>,
      import(root + 'platform/recovery.ts') as Promise<typeof import('../../src/platform/recovery')>,
    ]);
    const host = new BrowserScratchHost();
    const store = new RecoveryStore(host);
    const record = (await store.previous()).find((candidate) => candidate.id === 'kill-test');
    if (!record) return null;
    const residency = new RasterResidency(new TileCache(host, 1024));
    const loaded = await store.recover(record, residency);
    const session = new EditorSession();
    session.installProject(loaded.document, loaded.activeLayerId, loaded.name, loaded.history);
    const raster = session.activeLayer?.raster;
    if (!raster) throw new Error('Recovered raster is missing');
    const lease = await residency.ensureResident([raster]);
    const pixel = raster.pixel(0, 0);
    lease.release();
    const beforeUndo = session.document!.layers.length;
    const undoWorked = session.undo();
    const afterUndo = session.document!.layers.length;
    await store.remove('kill-test');
    return { savedAt: record.savedAt, beforeUndo, undoWorked, afterUndo, pixel };
  });
  expect(recovered).not.toBeNull();
  expect(recovered!.savedAt).toBe(written.savedAt);
  expect(recovered).toMatchObject({ beforeUndo: 2, undoWorked: true, afterUndo: 1, pixel: [11, 22, 33, 255] });
  expect(Date.now() - recovered!.savedAt).toBeLessThan(5_000);
});
