import { expect, test } from '@playwright/test';
import { importThroughMenu, manifest, mountForTest, solidPng } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });

test('a completed save clears modified state and allows Export while recovery cleanup is still pending', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.__saveClosed = false;
    w.showSaveFilePicker = async (options: { suggestedName: string }) => ({
      name: options.suggestedName,
      async createWritable() {
        return { async write() {}, async close() { w.__saveClosed = true; }, async abort() {} };
      },
    });
  });
  await page.goto('/?harness=recovery-save-order');
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const [{ mountEditor }, { createBrowserHost }] = await Promise.all([
      load('/src/index.ts'), load('/src/platform/browserHost.ts'),
    ]);
    const w = window as any, base = createBrowserHost(), scratch = base.scratchHost;
    if (!scratch) throw new Error('Scratch storage is unavailable');
    const delayed = {
      kind: scratch.kind,
      read: scratch.read.bind(scratch), write: scratch.write.bind(scratch), list: scratch.list.bind(scratch),
      flush: scratch.flush.bind(scratch), close: scratch.close.bind(scratch),
      async remove(key: string) {
        if (key.startsWith('recovery/')) {
          w.__cleanupWaiting = true;
          await new Promise<void>((resolve) => { w.__releaseCleanup = resolve; });
        }
        await scratch.remove(key);
      },
    };
    w.__errors = [];
    const host = { ...base, scratchHost: delayed, reportError(error: unknown) { w.__errors.push(error); } };
    w.__handle = await mountEditor(document.getElementById('root')!, { host, locale: 'en' });
  });
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.recovery !== null)).toBe(true);
  await page.evaluate(async () => {
    const w = window as any;
    await w.__handle.newProject({ name: 'Saved first', width: 32, height: 32 });
    w.__editorForTests.session.addBlankLayer();
  });
  const editor = page.getByTestId('compositor-editor'), mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await editor.focus();
  await editor.press(`${mod}+s`);
  await expect.poll(() => page.evaluate(() => ({ closed: (window as any).__saveClosed,
    cleanup: (window as any).__cleanupWaiting }))).toEqual({ closed: true, cleanup: true });
  expect(await page.evaluate(() => ({ modified: (window as any).__editorForTests.session.isModified,
    busy: (window as any).__editorForTests.session.isProjectBusy }))).toEqual({ modified: false, busy: false });
  await expect(page.getByRole('tablist', { name: 'Project tabs' }).getByRole('tab', { selected: true }))
    .not.toHaveAccessibleName(/Unsaved changes/);
  await editor.press(`${mod}+Shift+e`);
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
  await page.evaluate(() => (window as any).__releaseCleanup());
});

test('an edit made while archive chunks are writing remains modified after the older revision saves', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.__saveClosed = false;
    w.showSaveFilePicker = async (options: { suggestedName: string }) => ({
      name: options.suggestedName,
      async createWritable() {
        let held = false;
        return {
          async write() {
            if (held) return;
            held = true; w.__saveWriting = true;
            await new Promise<void>((resolve) => { w.__releaseSaveWrite = resolve; });
          },
          async close() { w.__saveClosed = true; },
          async abort() {},
        };
      },
    });
  });
  await page.goto('/?harness=save-revision');
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const [{ mountEditor }, { createBrowserHost }] = await Promise.all([
      load('/src/index.ts'), load('/src/platform/browserHost.ts'),
    ]);
    const w = window as any;
    w.__errors = [];
    const host = { ...createBrowserHost(), reportError(error: unknown) { w.__errors.push(error); } };
    w.__handle = await mountEditor(document.getElementById('root')!, { host, locale: 'en' });
  });
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.recoveryWatchers.size)).toBeGreaterThan(0);
  await page.evaluate(async () => {
    const w = window as any;
    await w.__handle.newProject({ name: 'Revision', width: 32, height: 32 });
    w.__editorForTests.session.addBlankLayer();
  });
  const editor = page.getByTestId('compositor-editor'), mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await editor.focus();
  await editor.press(`${mod}+s`);
  await expect.poll(() => page.evaluate(() => (window as any).__saveWriting)).toBe(true);
  await page.evaluate(() => {
    const w = window as any;
    w.__editorForTests.session.addBlankLayer();
    w.__releaseSaveWrite();
  });
  await expect.poll(() => page.evaluate(() => (window as any).__saveClosed)).toBe(true);
  expect(await page.evaluate(() => ({ modified: (window as any).__editorForTests.session.isModified,
    layers: (window as any).__editorForTests.session.document.layers.length,
    busy: (window as any).__editorForTests.session.isProjectBusy }))).toEqual({ modified: true, layers: 2, busy: false });
  await expect.poll(() => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('fernwork-compositor');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    if (!db.objectStoreNames.contains('recovery')) { db.close(); return 0; }
    const count = await new Promise<number>((resolve) => {
      const request = db.transaction('recovery').objectStore('recovery').count();
      request.onsuccess = () => resolve(request.result);
    });
    db.close(); return count;
  }), { timeout: 15_000 }).toBe(1);
  expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
});

test('an unsaved project survives a reload through the recovery copy', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('64');
  await page.getByTestId('heightInput').fill('48');
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'teal.png', mimeType: 'image/png', buffer: solidPng(10, 10, [0, 128, 128, 200]) }]);
  const before = await manifest(page);
  // The copy is written ~2.5 s after the last change.
  await expect.poll(async () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('fernwork-compositor'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    if (!db.objectStoreNames.contains('recovery')) { db.close(); return 0; }
    const count = await new Promise<number>((resolve) => { const r = db.transaction('recovery').objectStore('recovery').count(); r.onsuccess = () => resolve(r.result); });
    db.close();
    return count;
  }), { timeout: 15_000 }).toBe(1);

  await mountForTest(page);
  await expect(page.getByRole('alertdialog')).toContainText('Recover an unsaved project?');
  await page.getByRole('button', { name: 'Recover' }).click();
  await expect(page.getByTestId('layerCount')).toHaveText('2');
  const after = await manifest(page);
  expect(after.layers).toEqual(before.layers);
  expect(after.assets).toEqual(before.assets);
});

test('a full browser storage pauses recovery copies with a readable message', async ({ page }) => {
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
      if (this.name === 'recovery') throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  await mountForTest(page);
  await page.getByTestId('createCanvas').click();
  await page.getByTestId('addBlankLayer').click();
  await expect(page.getByRole('alertdialog')).toContainText('Browser storage is full', { timeout: 15_000 });
  const errors = await page.evaluate(() => (window as any).__errors);
  expect(errors.map((e: { code: string }) => e.code)).toContain('storage-quota');
});
