import { expect, test, type Page } from '@playwright/test';

/**
 * Recipes and File › Batch… (PRODUCT-PLAN 6.9, core task 14) through the running editor: the recipe is saved from a
 * layer with Layer › Save Recipe…, applied with Layer › Apply Recipe, and a queue is exported by the Batch dialog into
 * a directory handle. The browser's pickers are replaced by recorders: showOpenFilePicker returns the files a test
 * puts in `__openAnswer`, showDirectoryPicker a directory whose written files are kept in `__dir`, and a write can be
 * held (`__holdWrites`) so a cancel lands while an item is in progress.
 */

test.use({ viewport: { width: 1440, height: 900 } });

async function mount(page: Page, locale: 'en' | 'de' = 'en'): Promise<void> {
  await page.addInitScript(() => {
    const w = window as any;
    w.__openAnswer = [];
    w.__dir = { name: 'Hochzeit-Export', files: {} as Record<string, Blob>, order: [] as string[], active: [] as (boolean | null)[] };
    w.__holdWrites = false;
    w.__heldWrites = [] as (() => void)[];
    w.__pendingWrites = 0;
    w.showOpenFilePicker = async () => (w.__openAnswer as File[]).map((file) => ({ kind: 'file', name: file.name, getFile: async () => file }));
    w.showSaveFilePicker = async () => { throw new DOMException('No save picker in this test.', 'AbortError'); };
    w.showDirectoryPicker = async () => {
      w.__dir.active.push((navigator as any).userActivation?.isActive ?? null);
      return {
        kind: 'directory', name: w.__dir.name,
        async getFileHandle(name: string, options?: { create?: boolean }) {
          if (!options?.create && !(name in w.__dir.files)) throw new DOMException(`${name} not found`, 'NotFoundError');
          return {
            kind: 'file', name,
            async createWritable() {
              const parts: Blob[] = [];
              return {
                async write(data: Blob) { parts.push(data); },
                async close() {
                  w.__pendingWrites++;
                  if (w.__holdWrites) await new Promise<void>((resolve) => (w.__heldWrites as (() => void)[]).push(resolve));
                  w.__pendingWrites--;
                  w.__dir.files[name] = new Blob(parts, { type: 'image/png' });
                  w.__dir.order.push(name);
                },
                async abort() {},
              };
            },
          };
        },
      };
    };
  });
  await page.goto('/?harness=batch');
  await page.evaluate(async (locale) => {
    document.body.style.cssText = 'margin:0;width:100vw;height:100vh;overflow:hidden';
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { mountEditor } = await load('/src/index.ts');
    const { createBrowserHost } = await load('/src/platform/browserHost.ts');
    const w = window as any;
    w.__errors = [];
    w.__saved = [];
    localStorage.removeItem('fernwork.recipes');
    // The host object itself (not a copy): its FileSystemHost capability is bound to it.
    const host = createBrowserHost();
    host.saveFile = async (blob: Blob, name: string) => { w.__saved.push({ name, size: blob.size }); };
    host.reportError = (error: unknown) => { w.__errors.push(error); };
    w.__handle = await mountEditor(document.getElementById('root')!, { host, locale, theme: 'dark' });
  }, locale);
  await page.waitForFunction(() => !!(window as any).__editorForTests?.canvasView?.gpu, null, { timeout: 30_000 });
}

/**
 * A project with the layer "Photo" (60 × 40 gradient) carrying a recipe's worth of steps — `kind` chooses them —
 * and, for 'full', the layer "Copy" with the same pixels to the right.
 */
async function installSource(page: Page, kind: 'full' | 'invert'): Promise<void> {
  await page.evaluate(async (kind) => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { newLayer } = await load('/src/core/document.ts');
    const { makeTransform } = await load('/src/core/geometry.ts');
    const { Raster } = await load('/src/core/raster.ts');
    const { defaultLevels, defaultHueSaturation } = await load('/src/core/adjustments.ts');
    const data = new Uint8Array(60 * 40 * 4);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 60; x++) {
      data.set([Math.min(255, 30 + x * 3 + ((x * 7 + y * 13) % 11) * 2), 40 + y * 4, (x * y) & 255, 255], (y * 60 + x) * 4);
    }
    const raster = Raster.fromPixels(60, 40, 4, data);
    const levels = (white: number) => {
      const s = defaultLevels();
      return { kind: 'Levels', schemaVersion: 1, parameters: { ...s, ranges: s.ranges.map((r: any, i: number) => (i === 0 ? { ...r, white } : r)) } };
    };
    const full = kind === 'full';
    const photo = newLayer({ id: 'photo', name: 'Photo', raster, transform: makeTransform({ x: 10, y: 10 }, { width: 60, height: 40 }),
      filters: full ? [{ kind: 'gaussianBlur', schemaVersion: 1, enabled: true, radius: 1.5 }] : [],
      effects: full ? [{ kind: 'stroke', schemaVersion: 1, enabled: true, width: 2, position: 'outside', color: { red: 1, green: 0.85, blue: 0.1 } }] : [] });
    const adjustment = (id: string, value: unknown) => newLayer({ id, name: id, adjustment: value, maskSourceId: 'photo',
      transform: makeTransform({ x: 0, y: 0 }, { width: 160, height: 60 }) });
    const layers = full
      ? [photo, adjustment('Levels', levels(180)), adjustment('Hue/Saturation', { kind: 'Hue/Saturation', schemaVersion: 1,
        parameters: { hue: 40, saturation: -30, lightness: 0, colorize: false, settings: defaultHueSaturation(40, -30, 0) } }),
      newLayer({ id: 'copy', name: 'Copy', raster, transform: makeTransform({ x: 90, y: 10 }, { width: 60, height: 40 }) })]
      : [photo, adjustment('Invert', { kind: 'Invert', schemaVersion: 1, parameters: {} }), adjustment('Levels', levels(200))];
    const session = (window as any).__editorForTests.session;
    session.installProject({ id: 'source', width: 160, height: 60, resolution: 72, selection: null, artboards: [], layers }, 'photo', 'Source');
  }, kind);
}

async function saveRecipe(page: Page, name: string): Promise<void> {
  await page.getByTestId('menu-Layer').click();
  await page.getByTestId('menu-save-recipe').click();
  await expect(page.getByTestId('save-recipe-dialog')).toBeVisible();
  await page.getByTestId('recipe-name').fill(name);
  await page.getByTestId('recipe-save').click();
  await expect(page.getByTestId('save-recipe-dialog')).toHaveCount(0);
  await expect(page.getByTestId('recipe-row').filter({ hasText: name })).toBeVisible();
}

/** Twelve two-colour PNGs of different sizes, made by the browser's canvas; the colours come back for the checks. */
async function queueImages(page: Page, count: number, options: { broken?: number; width?: number; height?: number } = {}): Promise<void> {
  await page.evaluate(async ({ count, broken, width, height }) => {
    const files: File[] = [];
    for (let i = 0; i < count; i++) {
      if (i === broken) { files.push(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5, 6])], 'broken.png', { type: 'image/png' })); continue; }
      const w = width ?? 30 + i * 3, h = height ?? 20 + i * 2;
      const canvas = new OffscreenCanvas(w, h), context = canvas.getContext('2d')!;
      context.fillStyle = `rgb(${20 + i * 10}, 100, ${200 - i * 5})`; context.fillRect(0, 0, Math.floor(w / 2), h);
      context.fillStyle = `rgb(200, ${50 + i * 8}, 30)`; context.fillRect(Math.floor(w / 2), 0, w - Math.floor(w / 2), h);
      files.push(new File([await canvas.convertToBlob({ type: 'image/png' })], `IMG_${1001 + i}.png`, { type: 'image/png' }));
    }
    (window as any).__openAnswer = files;
  }, { count, broken: options.broken ?? -1, width: options.width, height: options.height });
  await page.getByTestId('batch-add-files').click();
  await expect(page.getByTestId('batch-item')).toHaveCount(count);
}

/** The files written into the directory handle, decoded with the editor's own PNG decoder. */
async function writtenFiles(page: Page): Promise<{ name: string; width: number; height: number; left: number[]; right: number[] }[]> {
  return page.evaluate(async () => {
    const { decodePng } = await import(/* @vite-ignore */ '/src/io/png.ts' as string);
    const dir = (window as any).__dir;
    const result = [];
    for (const name of dir.order as string[]) {
      const png = decodePng(new Uint8Array(await (dir.files[name] as Blob).arrayBuffer()));
      const at = (x: number, y: number) => Array.from(png.data.slice((y * png.width + x) * 4, (y * png.width + x) * 4 + 4)) as number[];
      const y = Math.floor(png.height / 2);
      result.push({ name, width: png.width, height: png.height, left: at(Math.floor(png.width / 4), y), right: at(Math.floor(png.width * 3 / 4), y) });
    }
    return result;
  });
}

async function openBatch(page: Page): Promise<void> {
  await page.getByTestId('menu-File').click();
  await page.getByTestId('menu-batch').click();
  await expect(page.getByTestId('batch-dialog')).toBeVisible();
}

/** Invert, then Levels with the white point at 200, as 8-bit numbers. */
const inverted = (value: number) => Math.min(255, Math.round((255 - value) * 255 / 200));

function expectClose(actual: number[], expected: number[], label: string): void {
  actual.slice(0, 3).forEach((value, channel) => expect(Math.abs(value - expected[channel]!), `${label} channel ${channel}: ${actual} vs ${expected}`).toBeLessThanOrEqual(1));
  expect(actual[3], label).toBe(255);
}

test('a recipe saved from a layer and applied to another renders that layer like the source', async ({ page }) => {
  await mount(page);
  await installSource(page, 'full');
  await saveRecipe(page, 'Wedding');
  // The dialog listed every captured step: filter, style, both adjustment layers.
  const recipe = await page.evaluate(() => JSON.parse(localStorage.getItem('fernwork.recipes')!).recipes[0]);
  expect(recipe.steps.map((s: any) => s.kind)).toEqual(['filter', 'effect', 'adjustment', 'adjustment']);

  // Select "Copy" in the Layers panel and apply the recipe from the Layer menu.
  await page.getByTestId('layer-row').filter({ hasText: 'Copy' }).click();
  await page.getByTestId('menu-Layer').click();
  await page.getByTestId('menu-apply-recipe').hover();
  await page.getByRole('menuitem', { name: 'Wedding' }).click();
  // Applying loads the recipe actions on first use, so wait for its undo step.
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.history.undoName)).toBe('Apply Recipe');
  const state = await page.evaluate(() => {
    const session = (window as any).__editorForTests.session;
    return { undo: session.history.undoName, layers: session.document.layers.map((l: any) => [l.name, l.kind, l.maskSourceId]),
      filters: session.layer('copy').filters.length, effects: session.layer('copy').effects.length };
  });
  expect(state.undo).toBe('Apply Recipe');
  expect(state.filters).toBe(1);
  expect(state.effects).toBe(1);
  expect(state.layers.filter((l: any) => l[2] === 'copy').map((l: any) => l[0])).toEqual(['Levels', 'Hue/Saturation']);

  // Rendered through the canvas compositor (WebGL), the copy now looks exactly like the source layer.
  const renders = await page.evaluate(async () => {
    const controller = (window as any).__editorForTests;
    const [photo, copy] = await controller.exportFiles({ targets: [{ kind: 'layer', id: 'photo' }, { kind: 'layer', id: 'copy' }], format: 'png',
      metadata: { colorProfile: 'strip', resolution: false, info: null } });
    const { decodePng } = await import(/* @vite-ignore */ '/src/io/png.ts' as string);
    const a = decodePng(photo.bytes), b = decodePng(copy.bytes);
    let differing = 0, maximum = 0;
    for (let i = 0; i < a.data.length; i++) { const d = Math.abs(a.data[i] - b.data[i]); if (d) differing++; maximum = Math.max(maximum, d); }
    return { sizes: [[a.width, a.height], [b.width, b.height]], differing, maximum, renderer: controller.canvasView.rendererKind };
  });
  expect(renders.renderer).toBe('webgl2');
  expect(renders.sizes[0]).toEqual(renders.sizes[1]);
  expect(renders.differing, `max difference ${renders.maximum}`).toBe(0);

  // One undo step takes it all back.
  await page.getByTestId('menu-Edit').click();
  await expect(page.getByTestId('menu-undo')).toContainText('Undo Apply Recipe');
  await page.getByTestId('menu-undo').click();
  expect(await page.evaluate(() => {
    const session = (window as any).__editorForTests.session;
    return [session.layer('copy').filters.length, session.document.layers.length];
  })).toEqual([0, 4]);
});

test('Batch exports 12 images with a recipe to PNG into the chosen folder', async ({ page }) => {
  test.setTimeout(180_000);
  await mount(page);
  await installSource(page, 'invert');
  await saveRecipe(page, 'Negative');
  await openBatch(page);
  await queueImages(page, 12);
  await expect(page.getByTestId('batch-recipe')).toHaveValue(/.+/);
  await expect(page.getByTestId('batch-recipe').locator('option:checked')).toHaveText('Negative');
  await page.getByTestId('batch-pattern').fill('Serie-{index}');
  await expect(page.getByTestId('batch-run')).toBeDisabled();
  await page.getByTestId('batch-choose-folder').click();
  await expect(page.getByTestId('batch-folder')).toHaveText('Hochzeit-Export');
  expect(await page.evaluate(() => (window as any).__dir.active)).toEqual([true]);
  await page.getByTestId('batch-run').click();
  await expect(page.getByTestId('batch-summary')).toHaveText('12 exported · 0 failed · 0 waiting', { timeout: 120_000 });
  await expect(page.getByTestId('batch-count')).toHaveText('12 of 12');

  const files = await writtenFiles(page);
  expect(files.map((f) => f.name)).toEqual(Array.from({ length: 12 }, (_, i) => `Serie-${String(i + 1).padStart(2, '0')}.png`));
  files.forEach((file, i) => {
    expect([file.width, file.height], file.name).toEqual([30 + i * 3, 20 + i * 2]);
    expectClose(file.left, [inverted(20 + i * 10), inverted(100), inverted(200 - i * 5)], `${file.name} left`);
    expectClose(file.right, [inverted(200), inverted(50 + i * 8), inverted(30)], `${file.name} right`);
  });
  // The open document was not touched; nothing was opened as a tab.
  expect(await page.evaluate(() => (window as any).__editorForTests.workspace.tabs.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
});

test('a corrupt file in the queue is reported and skipped', async ({ page }) => {
  await mount(page);
  await openBatch(page);
  await queueImages(page, 3, { broken: 1 });
  await page.getByTestId('batch-choose-folder').click();
  await page.getByTestId('batch-run').click();
  await expect(page.getByTestId('batch-summary')).toHaveText('2 exported · 1 failed · 0 waiting', { timeout: 60_000 });
  const rows = page.getByTestId('batch-item');
  await expect(rows.nth(0)).toHaveAttribute('data-status', 'done');
  await expect(rows.nth(1)).toHaveAttribute('data-status', 'failed');
  await expect(rows.nth(2)).toHaveAttribute('data-status', 'done');
  await expect(rows.nth(1).getByTestId('batch-item-error')).toHaveText('The image could not be read. It may be damaged or unavailable.');
  await expect(rows.nth(1)).toContainText('Failed');
  // Without a recipe the images are exported as they are.
  const files = await writtenFiles(page);
  expect(files.map((f) => f.name)).toEqual(['IMG_1001.png', 'IMG_1003.png']);
  expectClose(files[1]!.left, [40, 100, 190], 'IMG_1003 left');
  // The failed item can be retried on its own.
  await expect(page.getByTestId('batch-retry')).toBeVisible();
});

test('cancelling mid-queue keeps the rest, and Continue finishes it with the same numbering', async ({ page }) => {
  test.setTimeout(180_000);
  await mount(page);
  await openBatch(page);
  await queueImages(page, 6);
  await page.getByTestId('batch-pattern').fill('{index}-{name}');
  await page.getByTestId('batch-choose-folder').click();
  // Every write waits for the test: let the first through, cancel while the second is being written.
  await page.evaluate(() => { (window as any).__holdWrites = true; });
  await page.getByTestId('batch-run').click();
  await page.waitForFunction(() => (window as any).__heldWrites.length === 1);
  await page.evaluate(() => (window as any).__heldWrites.shift()());
  await page.waitForFunction(() => (window as any).__dir.order.length === 1 && (window as any).__heldWrites.length === 1);
  await expect(page.getByTestId('batch-item').nth(1)).toHaveAttribute('data-status', 'running');
  await page.getByTestId('batch-cancel').click();
  await expect(page.getByTestId('batch-summary')).toHaveText('Cancelling…');
  await page.evaluate(() => { const w = window as any; w.__holdWrites = false; for (const release of w.__heldWrites.splice(0)) release(); });
  // The file being written when the user cancelled is finished; everything after it waits.
  await expect(page.getByTestId('batch-summary')).toHaveText('2 exported · 0 failed · 4 waiting');
  await expect(page.getByTestId('batch-item').nth(2)).toHaveAttribute('data-status', 'pending');
  expect(await page.evaluate(() => (window as any).__dir.order)).toEqual(['1-IMG_1001.png', '2-IMG_1002.png']);
  await expect(page.getByTestId('batch-run')).toHaveText('Continue');

  // Closing keeps the job; reopening shows it and Continue finishes the queue.
  await page.getByTestId('batch-close').click();
  await openBatch(page);
  await expect(page.getByTestId('batch-summary')).toHaveText('2 exported · 0 failed · 4 waiting');
  await page.getByTestId('batch-run').click();
  await expect(page.getByTestId('batch-summary')).toHaveText('6 exported · 0 failed · 0 waiting', { timeout: 60_000 });
  expect(await page.evaluate(() => (window as any).__dir.order)).toEqual(
    ['1-IMG_1001.png', '2-IMG_1002.png', '3-IMG_1003.png', '4-IMG_1004.png', '5-IMG_1005.png', '6-IMG_1006.png']);
});

test('the layers of the open document go through the same queue, one file per layer', async ({ page }) => {
  await mount(page);
  await installSource(page, 'full');
  await openBatch(page);
  await page.getByTestId('batch-source-layers').click();
  // Top-level content layers, top of the stack first; adjustment layers are not exported on their own.
  await expect(page.getByTestId('batch-item')).toHaveCount(2);
  await expect(page.getByTestId('batch-item').nth(0)).toHaveAttribute('data-name', 'Copy');
  await expect(page.getByTestId('batch-item').nth(1)).toHaveAttribute('data-name', 'Photo');
  await expect(page.getByTestId('batch-add-files')).toHaveCount(0);
  await page.getByTestId('batch-choose-folder').click();
  await page.getByTestId('batch-run').click();
  await expect(page.getByTestId('batch-summary')).toHaveText('2 exported · 0 failed · 0 waiting', { timeout: 60_000 });
  const files = await writtenFiles(page);
  expect(files.map((f) => [f.name, f.width, f.height])).toEqual([['Copy.png', 60, 40], ['Photo.png', 60, 40]]);
  // The layer's own look: Photo with its clipped adjustments and stroke is not the plain Copy.
  expect(files[1]!.left).not.toEqual(files[0]!.left);
});

test('German labels for Batch and recipes', async ({ page }) => {
  await mount(page, 'de');
  await installSource(page, 'invert');
  await page.getByTestId('menu-Ebene').click();
  await expect(page.getByTestId('menu-save-recipe')).toHaveText(/^Rezept speichern …/);
  await expect(page.getByTestId('menu-apply-recipe')).toContainText('Rezept anwenden');
  await page.getByTestId('menu-save-recipe').click();
  await expect(page.getByTestId('save-recipe-dialog').getByRole('heading', { level: 2 })).toHaveText('Rezept speichern');
  await page.getByTestId('recipe-name').fill('Negativ');
  await page.getByTestId('recipe-save').click();
  await expect(page.getByTestId('recipes-panel').getByRole('heading')).toHaveText('Rezepte');
  await expect(page.getByTestId('recipe-apply')).toHaveText('Anwenden');

  // Layer › Rezept anwenden › Rezepte verwalten … opens the panel again after it was closed.
  await page.getByTestId('recipes-panel').getByRole('button', { name: 'Schließen' }).click();
  await expect(page.getByTestId('recipes-panel')).toHaveCount(0);
  await page.getByTestId('menu-Ebene').click();
  await page.getByTestId('menu-apply-recipe').hover();
  await page.getByTestId('menu-manage-recipes').click();
  await expect(page.getByTestId('recipe-row')).toHaveText(/Negativ/);

  await page.getByTestId('menu-Ablage').click();
  await expect(page.getByTestId('menu-batch')).toHaveText(/^Stapelverarbeitung …/);
  await page.getByTestId('menu-batch').click();
  const dialog = page.getByTestId('batch-dialog');
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Stapelverarbeitung');
  for (const heading of ['Warteschlange', 'Rezept', 'Dateinamen', 'Zielordner']) await expect(dialog.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  await expect(page.getByTestId('batch-progress')).toContainText('Fortschritt');
  await expect(page.getByTestId('batch-close')).toHaveText('Abbrechen');
  await expect(page.getByTestId('batch-recipe').locator('option').first()).toHaveText('Kein Rezept');
  await queueImages(page, 2, { broken: 0 });
  await page.getByTestId('batch-choose-folder').click();
  await page.getByTestId('batch-run').click();
  await expect(page.getByTestId('batch-summary')).toHaveText('1 exportiert · 1 fehlgeschlagen · 0 ausstehend', { timeout: 60_000 });
  await expect(page.getByTestId('batch-item').first()).toContainText('Fehlgeschlagen');
  await expect(page.getByTestId('batch-item-error')).toHaveText('Das Bild konnte nicht gelesen werden. Es ist vielleicht beschädigt oder nicht verfügbar.');
});
