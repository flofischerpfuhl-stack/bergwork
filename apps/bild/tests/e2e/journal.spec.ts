import { expect, test } from '@playwright/test';

test('kill recovery restores the last committed state and its undo history within five seconds', async ({ context, page }) => {
  await page.goto('/?harness=1');
  const written = await page.evaluate(async () => {
    const root = '/src/';
    const [{ EditorSession }, { writeArchive }, { BrowserScratchHost }, { RecoveryStore }] = await Promise.all([
      import(root + 'core/session.ts') as Promise<typeof import('../../src/core/session')>,
      import(root + 'io/project.ts') as Promise<typeof import('../../src/io/project')>,
      import(root + 'platform/opfsScratchHost.ts') as Promise<typeof import('../../src/platform/opfsScratchHost')>,
      import(root + 'platform/recovery.ts') as Promise<typeof import('../../src/platform/recovery')>,
    ]);
    const session = new EditorSession();
    session.createNewProject(8, 8, 'Crash test');
    session.addBlankLayer();
    const archive = writeArchive(session.document!, 'Crash test', session.activeLayerId, session.history.exportState()).blob;
    const store = new RecoveryStore(new BrowserScratchHost());
    const savedAt = Date.now();
    await store.put({ id: 'kill-test', name: 'Crash test', savedAt, size: archive.size, archive });
    return { savedAt, layers: session.document!.layers.length, undo: session.history.undoCount };
  });
  expect(written).toMatchObject({ layers: 2, undo: 1 });

  await page.close({ runBeforeUnload: false });
  const restarted = await context.newPage();
  await restarted.goto('/?harness=1');
  const recovered = await restarted.evaluate(async () => {
    const root = '/src/';
    const [{ EditorSession }, { readArchive }, { BrowserScratchHost }, { RecoveryStore }] = await Promise.all([
      import(root + 'core/session.ts') as Promise<typeof import('../../src/core/session')>,
      import(root + 'io/project.ts') as Promise<typeof import('../../src/io/project')>,
      import(root + 'platform/opfsScratchHost.ts') as Promise<typeof import('../../src/platform/opfsScratchHost')>,
      import(root + 'platform/recovery.ts') as Promise<typeof import('../../src/platform/recovery')>,
    ]);
    const store = new RecoveryStore(new BrowserScratchHost());
    const record = (await store.previous()).find((candidate) => candidate.id === 'kill-test');
    if (!record) return null;
    const loaded = await readArchive(record.archive, async () => { throw new Error('Unexpected raster asset'); });
    const session = new EditorSession();
    session.installProject(loaded.document, loaded.activeLayerId, loaded.name, loaded.history);
    const beforeUndo = session.document!.layers.length;
    const undoWorked = session.undo();
    const afterUndo = session.document!.layers.length;
    await store.remove('kill-test');
    return { savedAt: record.savedAt, beforeUndo, undoWorked, afterUndo };
  });
  expect(recovered).not.toBeNull();
  expect(recovered!.savedAt).toBe(written.savedAt);
  expect(recovered).toMatchObject({ beforeUndo: 2, undoWorked: true, afterUndo: 1 });
  expect(Date.now() - recovered!.savedAt).toBeLessThan(5_000);
});
