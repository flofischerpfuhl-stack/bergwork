import { expect, test } from '@playwright/test';
import { importThroughMenu, manifest, mountForTest, solidPng } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });

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
