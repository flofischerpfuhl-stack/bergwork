import { expect, test } from '@playwright/test';

/**
 * B1: saving and exporting a large document from a key press. The browser only allows showSaveFilePicker while the
 * user's activation is still valid, so the editor must ask for the destination before the slow encoding. The picker is
 * replaced by a recorder that notes whether activation was still active when it was called and captures the bytes.
 */
test('saving and exporting a 40-megapixel document asks for the file while the key press still counts', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const w = window as any;
    w.__picks = [];
    w.showSaveFilePicker = async (options: { suggestedName: string }) => {
      const active = navigator.userActivation?.isActive ?? null;
      const record: { name: string; active: boolean | null; bytes: number; head: number[] } = { name: options.suggestedName, active, bytes: 0, head: [] };
      w.__picks.push(record);
      if (!active) throw new DOMException("Failed to execute 'showSaveFilePicker' on 'Window': Must be handling a user gesture to show a file picker.", 'SecurityError');
      return {
        name: options.suggestedName,
        async createWritable() {
          const parts: Blob[] = [];
          return {
            async write(blob: Blob) { parts.push(blob); },
            async close() { const all = new Blob(parts); record.head = [...new Uint8Array(await all.slice(0, 24).arrayBuffer())]; record.bytes = all.size; },
            async abort() {},
          };
        },
      };
    };
  });
  await page.goto('/?harness=large-save');
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { mountEditor } = await load('/src/index.ts');
    const { createBrowserHost } = await load('/src/platform/browserHost.ts');
    const w = window as any;
    w.__errors = [];
    const host = { ...createBrowserHost(), reportError(e: unknown) { w.__errors.push(e); } };
    w.__handle = await mountEditor(document.getElementById('root')!, { host, locale: 'en' });
    await w.__handle.newProject({ name: 'Poster', width: 8000, height: 5000 });
  });
  // A real pixel layer across the whole 40 MP canvas, so encoding does real work.
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { Raster } = await load('/src/core/raster.ts');
    const w = 8000, h = 5000, data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; data[o] = x & 255; data[o + 1] = y & 255; data[o + 2] = (x ^ y) & 255; data[o + 3] = 255; }
    const session = (window as any).__editorForTests.session;
    session.insertRaster(Raster.fromPixels(w, h, 4, data), 'Pattern');
  });
  const editor = page.getByTestId('compositor-editor');
  await editor.focus();
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await editor.press(`${mod}+s`);
  await expect.poll(() => page.evaluate(() => (window as any).__picks[0]?.bytes ?? 0), { timeout: 180_000 }).toBeGreaterThan(10_000);
  await editor.press(`${mod}+Shift+e`);
  await expect.poll(() => page.evaluate(() => (window as any).__picks[1]?.bytes ?? 0), { timeout: 180_000 }).toBeGreaterThan(10_000);
  const picks = await page.evaluate(() => (window as any).__picks);
  expect(picks.map((p: { name: string; active: boolean }) => [p.name, p.active])).toEqual([['Poster.fwimg', true], ['Poster.png', true]]);
  // ZIP and PNG signatures.
  expect(picks[0].head.slice(0, 2)).toEqual([0x50, 0x4b]);
  expect(picks[1].head.slice(0, 8)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  // IHDR width/height of the exported PNG.
  const ihdr = picks[1].head.slice(16, 24);
  expect((ihdr[0] << 24 | ihdr[1] << 16 | ihdr[2] << 8 | ihdr[3]) >>> 0).toBe(8000);
  expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
});
