import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { zipSync } from 'fflate';
import { expect, test, type Page } from '@playwright/test';
import { encodePng } from '../../src/io/png';
import { mountForTest } from './helpers';
import { mountBare, QA_DIR, qaCorpus } from './qa-helpers';

/**
 * QA: .fwimg round trips of every generated import file, an old-style v1 `.zip` project written by hand from
 * contracts.ts, opening through File › Open and by dropping files on the canvas and on the new-tab button.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const layerDigests = (page: Page) => page.evaluate(() => {
  const s = (window as any).__editorForTests.session;
  return s.document.layers.filter((l: any) => l.raster).map((l: any) => {
    const px = l.raster.toPixelsNative() as Uint8Array | Uint16Array;
    let h = 0x811c9dc5;
    for (let i = 0; i < px.length; i++) h = Math.imul(h ^ px[i]!, 0x01000193);
    return { name: l.name, format: l.raster.format, w: l.raster.width, h: l.raster.height, hash: h >>> 0,
      origin: l.transform.origin, blend: l.blendMode, opacity: l.opacity };
  });
});

const corpus = qaCorpus();
for (const item of corpus) {
  test(`QA .fwimg round trip: ${item.file} reopens with the same pixels and bit depth`, async ({ page }) => {
    await mountBare(page, { width: 128, height: 96 });
    const b64 = fs.readFileSync(path.join(QA_DIR, item.file)).toString('base64');
    await page.evaluate(async ({ b64, name }) => {
      await (window as any).__handle.importImage(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]), name);
    }, { b64, name: item.file });
    const before = await layerDigests(page);
    const pixels = () => page.evaluate(() => Array.from((window as any).__editorForTests.session.document.layers.at(-1).raster.toPixels() as Uint8Array));
    const beforePixels = await pixels();
    const reopened = await page.evaluate(async () => {
      const h = (window as any).__handle;
      try { await h.openProject(await h.saveProject()); return 'ok'; } catch (error) { return String(error); }
    });
    expect(reopened, 'the saved project must open again').toBe('ok');
    const after = await layerDigests(page);
    const afterPixels = await pixels();
    let sum = 0, max = 0;
    for (let i = 0; i < beforePixels.length; i++) { const d = Math.abs(beforePixels[i]! - afterPixels[i]!); sum += d; max = Math.max(max, d); }
    if (max) console.log(`QA round trip ${item.file}: pixels changed after reopening, mean |Δ| ${(sum / beforePixels.length).toFixed(2)}, max ${max}`);
    // Layer records identical; pixels identical up to one 8-bit step (a re-decode may round differently).
    const withoutHash = (list: any[]) => list.map((d) => { const { hash: _hash, ...rest } = d; return rest; });
    expect(withoutHash(after)).toEqual(withoutHash(before));
    expect(max).toBeLessThanOrEqual(1);
    expect(sum / beforePixels.length).toBeLessThan(0.1);
  });
}

/** An archive as earlier builds wrote it: format "fernwork-compositor", version 1 (contracts.ts), no extensions. */
function legacyZip(): Buffer {
  const png = (w: number, h: number, rgba: number[]) => {
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
    return encodePng(data, w, h, 4);
  };
  const red = png(40, 30, [255, 0, 0, 255]), blue = png(20, 20, [0, 0, 255, 255]);
  const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
  const manifest = {
    format: 'fernwork-compositor', version: 1, id: 'legacy-1', name: 'Altprojekt', width: 100, height: 80, colorSpace: 'srgb',
    layers: [
      { id: 'L1', parentId: null, name: 'Rot', kind: 'raster', visible: true, locked: false, opacity: 1, blendMode: 'normal',
        transform: [1, 0, 0, 1, 10, 20], assetId: 'A1', clippedToBelow: false, parameters: {} },
      { id: 'G1', parentId: null, name: 'Gruppe', kind: 'group', visible: true, locked: true, opacity: 1, blendMode: 'normal',
        transform: [1, 0, 0, 1, 0, 0], clippedToBelow: false, parameters: {} },
      { id: 'L2', parentId: 'G1', name: 'Blau', kind: 'raster', visible: true, locked: false, opacity: 0.5, blendMode: 'multiply',
        transform: [1, 0, 0, 1, 40, 30], assetId: 'A2', clippedToBelow: false, parameters: {} },
    ],
    assets: [
      { id: 'A1', path: 'assets/A1.png', mime: 'image/png', width: 40, height: 30, sha256: sha(red) },
      { id: 'A2', path: 'assets/A2.png', mime: 'image/png', width: 20, height: 20, sha256: sha(blue) },
    ],
  };
  return Buffer.from(zipSync({ 'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)), 'assets/A1.png': red, 'assets/A2.png': blue }));
}

async function checkLegacyOpened(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests?.session?.document?.layers?.length ?? 0)).toBe(3);
  const info = await page.evaluate(() => {
    const s = (window as any).__editorForTests.session;
    return s.document.layers.map((l: any) => ({ name: l.name, kind: l.kind, origin: l.transform.origin, blend: l.blendMode, opacity: l.opacity, all: l.locks.all }));
  });
  expect(info).toEqual([
    { name: 'Rot', kind: 'pixel', origin: { x: 10, y: 20 }, blend: 'normal', opacity: 1, all: false },
    { name: 'Gruppe', kind: 'group', origin: expect.anything(), blend: 'normal', opacity: 1, all: true },
    { name: 'Blau', kind: 'pixel', origin: { x: 40, y: 30 }, blend: 'multiply', opacity: 0.5, all: false },
  ].map((e) => ({ ...e, kind: expect.any(String) })));
  // Blue multiplied onto red is black; at 50 % opacity: (127.5, 0, 0).
  const px = await page.evaluate(async () => {
    const blob: Blob = await (window as any).__handle.exportImage({ format: 'png' });
    const bmp = await createImageBitmap(blob);
    const c = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    const g = c.getContext('2d')!; g.drawImage(bmp, 0, 0);
    return Array.from(g.getImageData(45, 35, 1, 1).data);
  });
  expect(px.map((v, i) => Math.abs(v - [128, 0, 0, 255][i]!) <= 1)).toEqual([true, true, true, true]);
}

test('QA old .zip project: opens through File › Open Project with layers, folder lock, blend mode and opacity', async ({ page }) => {
  await mountForTest(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('menu-File').click();
  await page.getByRole('menuitem', { name: 'Open Project…' }).click();
  await (await chooser).setFiles({ name: 'altprojekt.zip', mimeType: 'application/zip', buffer: legacyZip() });
  await checkLegacyOpened(page);
  expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
});

/** Dispatches a real drop of `files` on `selector` (dragover first, as a browser does). */
async function dropFiles(page: Page, selector: string, files: { name: string; type: string; buffer: Buffer }[]): Promise<void> {
  const transfer = await page.evaluateHandle((files) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    return dt;
  }, files.map((f) => ({ name: f.name, type: f.type, b64: f.buffer.toString('base64') })));
  await page.dispatchEvent(selector, 'dragenter', { dataTransfer: transfer });
  await page.dispatchEvent(selector, 'dragover', { dataTransfer: transfer });
  await page.dispatchEvent(selector, 'drop', { dataTransfer: transfer });
}

async function savedFwimg(page: Page): Promise<Buffer> {
  await page.getByTestId('widthInput').fill('100');
  await page.getByTestId('heightInput').fill('80');
  await page.getByTestId('createCanvas').click();
  for (let i = 0; i < 2; i++) await page.getByTestId('addBlankLayer').click();
  await page.evaluate(() => { const s = (window as any).__editorForTests.session; s.renameLayer(s.document.layers.at(-1).id, 'Gezogen'); });
  const b64 = await page.evaluate(async () => {
    const bytes = new Uint8Array(await ((await (window as any).__handle.saveProject()) as Blob).arrayBuffer());
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  return Buffer.from(b64, 'base64');
}

test('QA drag and drop: a .fwimg and an old .zip dropped on the canvas open as projects', async ({ page }) => {
  await mountForTest(page);
  const fwimg = await savedFwimg(page);
  await dropFiles(page, '[data-testid="canvas-pane"]', [{ name: 'gezogen.fwimg', type: '', buffer: fwimg }]);
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.document?.layers.map((l: any) => l.name))).toContain('Gezogen');
  await dropFiles(page, '[data-testid="canvas-pane"]', [{ name: 'alt.zip', type: 'application/zip', buffer: legacyZip() }]);
  await checkLegacyOpened(page);
  expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
});

test('QA bug: a .fwimg dropped on the new-tab (+) button is treated as an image and fails instead of opening', async ({ page }) => {
  await mountForTest(page);
  const fwimg = await savedFwimg(page);
  const tabs = await page.evaluate(() => (window as any).__editorForTests.workspace.tabs.length);
  await dropFiles(page, '[data-testid="new-canvas"]', [{ name: 'gezogen.fwimg', type: '', buffer: fwimg }]);
  // The .zip twin of this drop opens the project in a new tab; the .fwimg must do the same.
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.workspace.tabs.length)).toBe(tabs + 1);
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.document?.layers.map((l: any) => l.name) ?? [])).toContain('Gezogen');
  expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
});

test('QA bug: a project with a guide, saved and opened again through File › Open Project, is rejected as damaged', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('100');
  await page.getByTestId('heightInput').fill('80');
  await page.getByTestId('createCanvas').click();
  await page.getByTestId('menu-View').click();
  await page.getByRole('menuitem', { name: 'New Guide…' }).click();
  await page.getByTestId('guide-position').fill('40');
  await page.getByTestId('guide-ok').click();
  const b64 = await page.evaluate(async () => {
    const bytes = new Uint8Array(await ((await (window as any).__handle.saveProject()) as Blob).arrayBuffer());
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('menu-File').click();
  await page.getByRole('menuitem', { name: 'Open Project…' }).click();
  await (await chooser).setFiles({ name: 'mit-hilfslinie.fwimg', mimeType: 'application/zip', buffer: Buffer.from(b64, 'base64') });
  // Opening succeeds (a second project tab with the guide) or reports the damage; today it reports it.
  await expect.poll(() => page.evaluate(() => (window as any).__errors.length + ((window as any).__editorForTests.workspace.tabs.length > 1 ? 1 : 0))).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).__errors.map((e: { message: string }) => e.message))).toEqual([]);
  expect(await page.evaluate(() => (window as any).__editorForTests.session.guides.map((g: any) => g.position))).toEqual([40]);
});

test('QA bug: the recovery copy of an unsaved document with a guide cannot be recovered after a reload', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('64');
  await page.getByTestId('heightInput').fill('48');
  await page.getByTestId('createCanvas').click();
  await page.getByTestId('addBlankLayer').click();
  await page.getByTestId('menu-View').click();
  await page.getByRole('menuitem', { name: 'New Guide…' }).click();
  await page.getByTestId('guide-position').fill('20');
  await page.getByTestId('guide-ok').click();
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
  expect(await page.evaluate(() => (window as any).__editorForTests.session.guides.map((g: any) => g.position))).toEqual([20]);
});
