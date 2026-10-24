import { expect, test, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';

/**
 * File > Export As… — the one export dialog (P4). The save picker is replaced by a recorder (as in large-save.spec.ts)
 * that notes whether the click's user activation still counted when the editor asked for the destination, and keeps
 * the written bytes so the files can be checked here.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

interface Pick { name: string; active: boolean | null; bytes: number; data: number[] }

async function mount(page: Page, locale: 'en' | 'de' = 'en'): Promise<void> {
  await page.addInitScript(() => {
    const w = window as any;
    w.__picks = [];
    w.showSaveFilePicker = async (options: { suggestedName: string }) => {
      const active = (navigator as any).userActivation?.isActive ?? null;
      const record = { name: options.suggestedName, active, bytes: 0, data: [] as number[] };
      w.__picks.push(record);
      if (active === false) throw new DOMException('Must be handling a user gesture to show a file picker.', 'SecurityError');
      return {
        name: options.suggestedName,
        async createWritable() {
          const parts: Blob[] = [];
          return {
            async write(blob: Blob) { parts.push(blob); },
            async close() { const all = new Uint8Array(await new Blob(parts).arrayBuffer()); record.bytes = all.length; record.data = Array.from(all); },
            async abort() {},
          };
        },
      };
    };
  });
  await page.goto('/?harness=export-dialog');
  await page.evaluate(async (locale) => {
    document.body.style.cssText = 'margin:0;width:100vw;height:100vh;overflow:hidden';
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { mountEditor } = await load('/src/index.ts');
    const { createBrowserHost } = await load('/src/platform/browserHost.ts');
    const { Raster } = await load('/src/core/raster.ts');
    const w = window as any;
    w.__errors = [];
    const host = { ...createBrowserHost(), reportError(error: unknown) { w.__errors.push(error); } };
    w.__handle = await mountEditor(document.getElementById('root')!, { host, locale, theme: 'dark' });
    await w.__handle.newProject({ name: 'Poster', width: 400, height: 300 });
    // A gradient with noise, so JPEG quality changes the file size.
    const data = new Uint8Array(400 * 300 * 4);
    for (let y = 0; y < 300; y++) for (let x = 0; x < 400; x++) {
      const o = (y * 400 + x) * 4, n = (x * 7919 + y * 104729) % 61;
      data.set([(x * 255 / 400 + n) & 255, (y * 255 / 300 + n) & 255, (x ^ y) & 255, 255], o);
    }
    w.__editorForTests.session.insertRaster(Raster.fromPixels(400, 300, 4, data), 'Photo');
  }, locale);
  await page.waitForFunction(() => !!(window as any).__editorForTests?.canvasView?.gpu, null, { timeout: 30_000 });
}

const picks = (page: Page): Promise<Pick[]> => page.evaluate(() => (window as any).__picks);

function pngSize(bytes: Uint8Array): [number, number] {
  expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return [view.getUint32(16), view.getUint32(20)];
}

async function openFromMenu(page: Page): Promise<void> {
  await page.getByTestId('menu-File').click();
  await page.getByTestId('menu-export').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
}

const estimates = (page: Page) => page.getByTestId('export-estimate').allTextContents();

test('Export As replaces the old export items and shows only the options each format has', async ({ page }) => {
  await mount(page);
  await page.getByTestId('menu-File').click();
  // One way to export: no separate PNG/JPEG items, no JPEG dialog.
  await expect(page.getByRole('menuitem', { name: /Export (PNG|JPEG)/ })).toHaveCount(0);
  await expect(page.getByTestId('menu-export')).toHaveText(/Export As…/);
  await page.getByTestId('menu-export').click();
  const dialog = page.getByTestId('export-dialog');
  await expect(dialog.getByRole('heading', { name: 'Export As' })).toBeVisible();
  // PNG: bit depth and transparency, no quality.
  await expect(page.getByTestId('export-format-png')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('export-depth-16')).toBeVisible();
  await expect(page.getByTestId('export-transparency')).toBeChecked();
  await expect(page.getByTestId('export-quality')).toHaveCount(0);
  await expect(page.getByTestId('export-matte')).toHaveCount(0);
  // JPEG: quality and a matte colour, never transparency or 16-bit.
  await page.getByTestId('export-format-jpeg').click();
  await expect(page.getByTestId('export-quality')).toBeVisible();
  await expect(page.getByTestId('export-matte')).toBeVisible();
  await expect(page.getByTestId('export-transparency')).toHaveCount(0);
  await expect(page.getByTestId('export-depth-16')).toHaveCount(0);
  await expect(page.getByTestId('export-file')).toHaveText([/Poster\.jpg/]);
  // WebP: lossless hides quality.
  await page.getByTestId('export-format-webp').click();
  await expect(page.getByTestId('export-quality')).toBeVisible();
  await page.getByTestId('export-lossless').check();
  await expect(page.getByTestId('export-quality')).toHaveCount(0);
  // AVIF: quality, 8-bit only. TIFF: 16-bit, no quality.
  await page.getByTestId('export-format-avif').click();
  await expect(page.getByTestId('export-quality')).toBeVisible();
  await expect(page.getByTestId('export-depth-16')).toHaveCount(0);
  await page.getByTestId('export-format-tiff').click();
  await expect(page.getByTestId('export-depth-16')).toBeVisible();
  await expect(page.getByTestId('export-quality')).toHaveCount(0);
  await expect(page.getByTestId('export-file')).toHaveText([/Poster\.tif/]);
  // Turning transparency off asks for the matte colour.
  await page.getByTestId('export-transparency').uncheck();
  await expect(page.getByTestId('export-matte')).toBeVisible();
  // Escape closes without exporting.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('export-dialog')).toHaveCount(0);
  expect(await picks(page)).toEqual([]);
});

test('sizes, preview and a cancellable size estimate that follows the settings', async ({ page }) => {
  test.setTimeout(120_000);
  await mount(page);
  // Record every estimate's AbortSignal: a change must cancel the running estimate.
  await page.evaluate(() => {
    const w = window as any, controller = w.__editorForTests;
    const original = controller.estimateExport.bind(controller);
    w.__signals = [];
    controller.estimateExport = (request: unknown, options: { signal?: AbortSignal } = {}, session?: unknown) => {
      w.__signals.push(options.signal);
      return original(request, options, session);
    };
  });
  await openFromMenu(page);
  await expect(page.getByTestId('export-preview-image')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => estimates(page), { timeout: 30_000 }).toEqual([expect.stringMatching(/^\d[\d.,]* (B|KB|MB)$/)]);
  await expect(page.getByTestId('export-size-result')).toHaveText(['400 × 300 px']);
  // Add @2x: a second row with its pixel size, a second file, and a ZIP.
  await page.getByTestId('export-add-size').click();
  await expect(page.getByTestId('export-size-result')).toHaveText(['400 × 300 px', '800 × 600 px']);
  await expect(page.getByTestId('export-file')).toHaveText([/Poster\.png/, /Poster@2x\.png/]);
  await expect(page.getByTestId('export-summary')).toContainText('2 files · saved as one ZIP archive');
  await expect.poll(async () => (await estimates(page)).filter((text) => /\d/.test(text)).length, { timeout: 30_000 }).toBe(2);
  // An explicit width: height follows the aspect ratio.
  await page.getByTestId('export-size-mode').nth(1).selectOption('width');
  await page.getByTestId('export-size-value').fill('1000');
  await expect(page.getByTestId('export-size-result')).toHaveText(['400 × 300 px', '1,000 × 750 px']);
  await expect(page.getByTestId('export-file')).toHaveText([/Poster\.png/, /Poster-1000x750\.png/]);
  await page.getByTestId('export-size-value').fill('0');
  await expect(page.getByTestId('export-confirm')).toBeDisabled();
  await page.getByTestId('export-remove-size').nth(1).click();
  await expect(page.getByTestId('export-remove-size')).toBeDisabled();
  // JPEG at 90 % and at 10 %: the estimate updates and shrinks.
  await page.getByTestId('export-format-jpeg').click();
  await page.getByTestId('export-quality').fill('90');
  const size = async () => {
    const [text] = await estimates(page);
    const match = /([\d.,]+) (B|KB|MB)/.exec(text ?? '');
    return match ? Number(match[1]!.replace(/,/g, '')) * (match[2] === 'MB' ? 1024 * 1024 : match[2] === 'KB' ? 1024 : 1) : null;
  };
  await expect.poll(size, { timeout: 30_000 }).not.toBeNull();
  const high = (await size())!;
  // Start an estimate, then change the settings while it runs: its signal is aborted.
  const started = await page.evaluate(() => (window as any).__signals.length);
  await page.getByTestId('export-quality').fill('10');
  await expect.poll(() => page.evaluate(() => (window as any).__signals.length), { timeout: 30_000 }).toBeGreaterThan(started);
  await page.getByTestId('export-quality').fill('11');
  await expect.poll(() => page.evaluate((index) => (window as any).__signals[index].aborted, started), { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => { const now = await size(); return now !== null && now < high * 0.7; }, { timeout: 30_000 }).toBe(true);
  expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
});

test('Export writes one file, or one ZIP for several, choosing the destination while the click counts', async ({ page }) => {
  test.setTimeout(120_000);
  await mount(page);
  await openFromMenu(page);
  await expect.poll(() => estimates(page), { timeout: 30_000 }).toEqual([expect.stringMatching(/\d/)]);
  await page.getByTestId('export-confirm').click();
  await expect.poll(async () => (await picks(page))[0]?.bytes ?? 0, { timeout: 60_000 }).toBeGreaterThan(1000);
  await expect(page.getByTestId('export-dialog')).toHaveCount(0);
  let recorded = await picks(page);
  expect(recorded[0]!.name).toBe('Poster.png');
  expect(recorded[0]!.active).not.toBe(false);
  expect(pngSize(new Uint8Array(recorded[0]!.data))).toEqual([400, 300]);
  // The shortcut opens the same dialog with the settings of this document; @2x makes it a ZIP.
  const editor = page.getByTestId('compositor-editor');
  await editor.focus();
  await editor.press(`${mod}+Alt+Shift+w`);
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await page.getByTestId('export-add-size').click();
  await expect(page.getByTestId('export-file')).toHaveCount(2);
  await page.getByTestId('export-confirm').click();
  await expect.poll(async () => (await picks(page))[1]?.bytes ?? 0, { timeout: 60_000 }).toBeGreaterThan(1000);
  recorded = await picks(page);
  expect(recorded[1]!.name).toBe('Poster export.zip');
  expect(recorded[1]!.active).not.toBe(false);
  const entries = unzipSync(new Uint8Array(recorded[1]!.data));
  expect(Object.keys(entries).sort()).toEqual(['Poster.png', 'Poster@2x.png']);
  expect(pngSize(entries['Poster.png']!)).toEqual([400, 300]);
  expect(pngSize(entries['Poster@2x.png']!)).toEqual([800, 600]);
  // The earlier export shortcut opens the dialog too, still with the two sizes of this document.
  await editor.focus();
  await editor.press(`${mod}+Shift+e`);
  await expect(page.getByTestId('export-size-row')).toHaveCount(2);
  await page.getByTestId('export-dialog').getByRole('button', { name: 'Cancel' }).click();
  // Another document starts from the defaults: settings are remembered per document, not globally.
  await page.evaluate(async () => { await (window as any).__handle.newProject({ name: 'Second', width: 50, height: 40 }); });
  await openFromMenu(page);
  await expect(page.getByTestId('export-size-row')).toHaveCount(1);
  await expect(page.getByTestId('export-file')).toHaveText([/Second\.png/]);
  expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
});

test('German labels', async ({ page }) => {
  await mount(page, 'de');
  const editor = page.getByTestId('compositor-editor');
  await editor.focus();
  await editor.press(`${mod}+Alt+Shift+w`);
  const dialog = page.getByTestId('export-dialog');
  await expect(dialog.getByRole('heading', { name: 'Exportieren als' })).toBeVisible();
  for (const label of ['Gesamtes Dokument', 'Format', 'Größe', 'Metadaten', 'Farbprofil einbetten (sRGB)', 'Transparenz', 'Bittiefe']) {
    await expect(dialog.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await page.getByTestId('export-format-jpeg').click();
  await expect(dialog.getByText('Qualität', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Hintergrund für Transparenz', { exact: true })).toBeVisible();
  await page.getByTestId('export-add-size').click();
  await expect(page.getByTestId('export-summary')).toContainText('2 Dateien · als ein ZIP-Archiv gesichert');
  await expect(page.getByTestId('export-summary')).toContainText('Dateigröße', { timeout: 30_000 });
  await expect(page.getByTestId('export-dialog').getByRole('button', { name: 'Exportieren', exact: true })).toBeVisible();
  await page.getByTestId('export-dialog').getByRole('button', { name: 'Abbrechen' }).click();
  await page.getByTestId('menu-Ablage').click();
  await expect(page.getByTestId('menu-export')).toHaveText(/Exportieren als …/);
});
