import { expect, test, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';

/**
 * The Artboard tool: draw, preset, rename, move by the name label (content moves along), resize by a handle
 * (content stays), background, delete keeping or deleting the content, one undo step per gesture, the Layers panel
 * grouping, and File > Export As… producing one file per artboard at the right pixel sizes.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

async function mount(page: Page): Promise<void> {
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
  await page.goto('/?harness=artboard-tool');
  await page.evaluate(async () => {
    document.body.style.cssText = 'margin:0;width:100vw;height:100vh;overflow:hidden';
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { mountEditor } = await load('/src/index.ts');
    const { createBrowserHost } = await load('/src/platform/browserHost.ts');
    const w = window as any;
    w.__errors = [];
    const host = { ...createBrowserHost(), reportError(error: unknown) { w.__errors.push(error); } };
    w.__handle = await mountEditor(document.getElementById('root')!, { host, locale: 'en', theme: 'dark' });
    await w.__handle.newProject({ name: 'Campaign', width: 600, height: 400 });
  });
  await page.waitForFunction(() => !!(window as any).__editorForTests?.canvasView?.gpu, null, { timeout: 30_000 });
}

/** View position (page coordinates) of a document point. */
async function viewOf(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const pane = (await page.getByTestId('canvas-pane').boundingBox())!;
  const point = await page.evaluate(([px, py]) => {
    const s = (window as any).__editorForTests.session;
    return s.viewport.viewPoint({ x: px, y: py }, s.document);
  }, [x, y]);
  return { x: pane.x + point.x, y: pane.y + point.y };
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

const artboards = (page: Page) => page.evaluate(() =>
  ((window as any).__editorForTests.session.document.artboards as { name: string; rect: { x: number; y: number; width: number; height: number }; background: { alpha: number; red: number } }[])
    .map((a) => ({ name: a.name, ...a.rect, alpha: a.background.alpha })));
const undoNames = (page: Page) => page.evaluate(() => ((window as any).__editorForTests.session.history.exportState().past as { name: string }[]).map((e) => e.name));
const layerOrigin = (page: Page, name: string) => page.evaluate((n) => {
  const layer = (window as any).__editorForTests.session.document.layers.find((l: { name: string }) => l.name === n);
  return layer ? { x: layer.transform.origin.x, y: layer.transform.origin.y } : null;
}, name);

async function addSquare(page: Page, name: string, x: number, y: number, size: number, rgba: number[]): Promise<void> {
  await page.evaluate(async ({ name, x, y, size, rgba }) => {
    const { Raster } = await import(/* @vite-ignore */ '/src/core/raster.ts' as string);
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) data.set(rgba, i * 4);
    const session = (window as any).__editorForTests.session;
    session.setActiveLayer(null);
    session.insertRaster(Raster.fromPixels(size, size, 4, data), name, { x: x + size / 2, y: y + size / 2 });
  }, { name, x, y, size, rgba });
}

test('draw, preset, rename, move by the name, resize by a handle — one undo step each', async ({ page }) => {
  test.setTimeout(120_000);
  await mount(page);
  const editor = page.getByTestId('compositor-editor');
  // Shift-V cycles Move and Artboard (Photoshop's tool group); V stays Move.
  await editor.focus();
  await editor.press('Shift+V');
  await expect(page.getByTestId('tool-artboard')).toHaveAttribute('aria-pressed', 'true');
  await editor.press('Shift+V');
  await expect(page.getByTestId('tool-move')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('tool-artboard').click();
  await expect(page.getByTestId('context-bar')).toContainText('Drag on the canvas to draw an artboard');
  const before = (await undoNames(page)).length;
  // Draw from (40, 30) to (240, 180).
  await drag(page, await viewOf(page, 40, 30), await viewOf(page, 240, 180));
  let boards = await artboards(page);
  expect(boards).toHaveLength(1);
  expect(Math.abs(boards[0]!.x - 40)).toBeLessThanOrEqual(1);
  expect(Math.abs(boards[0]!.width - 200)).toBeLessThanOrEqual(2);
  expect(Math.abs(boards[0]!.height - 150)).toBeLessThanOrEqual(2);
  expect(boards[0]!.name).toBe('Artboard');
  await expect(page.getByTestId('artboard-size')).toBeVisible();
  // Preset: the selected artboard takes the size (the canvas grows to fit, right and bottom only).
  await page.getByTestId('artboard-preset').selectOption('instagram-post');
  boards = await artboards(page);
  expect(boards[0]).toMatchObject({ width: 1080, height: 1080 });
  const x0 = boards[0]!.x, y0 = boards[0]!.y;
  expect(await page.evaluate(() => { const d = (window as any).__editorForTests.session.document; return [d.width, d.height]; })).toEqual([x0 + 1080, y0 + 1080]);
  // Rename in the context bar.
  await page.getByTestId('artboard-name').fill('Hero');
  await page.getByTestId('artboard-name').press('Enter');
  await expect.poll(async () => (await artboards(page))[0]!.name).toBe('Hero');
  // Content on the artboard moves with it; dragging the name label moves the artboard.
  await addSquare(page, 'Red', x0 + 100, y0 + 100, 80, [255, 0, 0, 255]);
  await page.evaluate(() => (window as any).__editorForTests.session.fit());
  const label = await viewOf(page, x0, y0);
  const ppp = await page.evaluate(() => (window as any).__editorForTests.session.viewport.pointsPerPixel);
  await drag(page, { x: label.x + 20, y: label.y - 10 }, { x: label.x + 20 + 200 * ppp, y: label.y - 10 });
  boards = await artboards(page);
  const moved = boards[0]!.x - x0;
  expect(moved).toBeGreaterThan(150);
  expect(boards[0]!.y).toBe(y0);
  expect(await layerOrigin(page, 'Red')).toEqual({ x: x0 + 100 + moved, y: y0 + 100 });
  // Resize from the bottom-right handle: the artboard changes, the content stays.
  const corner = await viewOf(page, boards[0]!.x + 1080, boards[0]!.y + 1080);
  await drag(page, corner, { x: corner.x - 300 * ppp, y: corner.y - 100 * ppp });
  boards = await artboards(page);
  expect(boards[0]!.width).toBeLessThan(1080 - 250);
  expect(boards[0]!.height).toBeLessThan(1080 - 50);
  expect(boards[0]!.x).toBe(x0 + moved);
  expect(await layerOrigin(page, 'Red')).toEqual({ x: x0 + 100 + moved, y: y0 + 100 });
  // Background: transparent and white.
  await page.getByTestId('artboard-bg-transparent').click();
  expect((await artboards(page))[0]!.alpha).toBe(0);
  await page.getByTestId('artboard-bg-white').click();
  expect((await artboards(page))[0]!.alpha).toBe(1);
  // One history step per gesture (the square came in as an import step).
  const names = (await undoNames(page)).slice(before);
  expect(names).toEqual(['New Artboard', 'Resize Artboard', 'Rename Artboard', expect.any(String), 'Move Artboard', 'Resize Artboard', 'Artboard Background', 'Artboard Background']);
  // Undo the resize gesture in one step.
  await editor.focus();
  for (let i = 0; i < 3; i++) await editor.press(`${mod}+z`);
  boards = await artboards(page);
  expect(boards[0]).toMatchObject({ width: 1080, height: 1080, x: x0 + moved });
  await editor.press(`${mod}+z`);
  expect((await artboards(page))[0]!.x).toBe(x0);
  expect(await layerOrigin(page, 'Red')).toEqual({ x: x0 + 100, y: y0 + 100 });
  expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
});

test('Layers panel groups layers under artboards; delete keeps or deletes the content', async ({ page }) => {
  test.setTimeout(120_000);
  await mount(page);
  await page.evaluate(async () => {
    const { createArtboard } = await import(/* @vite-ignore */ '/src/core/artboardCommands.ts' as string);
    const session = (window as any).__editorForTests.session;
    createArtboard(session, { rect: { x: 0, y: 0, width: 200, height: 200 }, name: 'Left' });
    createArtboard(session, { rect: { x: 300, y: 0, width: 200, height: 200 }, name: 'Right' });
  });
  await addSquare(page, 'On Left', 50, 50, 40, [255, 0, 0, 255]);
  await addSquare(page, 'On Right', 350, 50, 40, [0, 0, 255, 255]);
  await addSquare(page, 'Loose', 520, 300, 40, [0, 255, 0, 255]);
  const rows = page.getByTestId('layers-list').locator('[data-testid=artboard-row], [data-testid=layer-row]');
  const names = async () => (await rows.all()).length ? rows.evaluateAll((elements) => elements.map((element) =>
    (element.getAttribute('data-testid') === 'artboard-row' ? '▣ ' : '  ') + (element.querySelector('[class*=layerName]')?.textContent ?? ''))) : [];
  await expect.poll(names).toEqual(['  Loose', '▣ Right', '  On Right', '▣ Left', '  On Left']);
  // Collapsing hides the members, not the order.
  await page.locator('[data-testid=artboard-row]', { hasText: 'Right' }).getByTestId('artboard-disclosure').click();
  await expect.poll(names).toEqual(['  Loose', '▣ Right', '▣ Left', '  On Left']);
  await page.locator('[data-testid=artboard-row]', { hasText: 'Right' }).getByTestId('artboard-disclosure').click();
  // Delete "Left" but keep its layers.
  await page.getByTestId('tool-artboard').click();
  const leftLabel = await viewOf(page, 0, 0);
  await page.mouse.click(leftLabel.x + 18, leftLabel.y - 10);
  await expect(page.getByTestId('artboard-name')).toHaveValue('Left');
  await page.getByTestId('artboard-delete').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Artboard Only' }).click();
  expect((await artboards(page)).map((a) => a.name)).toEqual(['Right']);
  await expect.poll(names).toEqual(['  Loose', '▣ Right', '  On Right', '  On Left']);
  // Undo brings it back in one step; then delete it with its content.
  const editor = page.getByTestId('compositor-editor');
  await editor.focus();
  await editor.press(`${mod}+z`);
  expect((await artboards(page)).map((a) => a.name)).toEqual(['Left', 'Right']);
  await page.getByTestId('layers-list').locator('[data-testid=artboard-row]', { hasText: 'Left' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete Artboard…' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Artboard and Contents' }).click();
  expect((await artboards(page)).map((a) => a.name)).toEqual(['Right']);
  await expect.poll(names).toEqual(['  Loose', '▣ Right', '  On Right']);
  await editor.focus();
  await editor.press(`${mod}+z`);
  await expect.poll(names).toEqual(['  Loose', '▣ Right', '  On Right', '▣ Left', '  On Left']);
  // Rename from the panel (double-click) is one undo step too.
  await page.getByTestId('layers-list').locator('[data-testid=artboard-row]', { hasText: 'Right' }).dblclick();
  const panelName = page.getByTestId('layers-list').getByRole('textbox', { name: 'Artboard name' });
  await panelName.fill('Story');
  await panelName.press('Enter');
  expect((await artboards(page)).map((a) => a.name)).toEqual(['Left', 'Story']);
  expect((await undoNames(page)).slice(-1)).toEqual(['Rename Artboard']);
  expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
});

test('Export As exports each artboard at @1x and @2x with the right pixel sizes', async ({ page }) => {
  test.setTimeout(150_000);
  await mount(page);
  await page.getByTestId('tool-artboard').click();
  // One artboard from a preset with nothing selected, one drawn.
  await page.getByTestId('artboard-preset').selectOption('facebook-cover');
  await page.getByTestId('artboard-name').fill('Cover');
  await page.getByTestId('artboard-name').press('Enter');
  await page.evaluate(() => (window as any).__editorForTests.session.fit());
  await drag(page, await viewOf(page, 20, 360), await viewOf(page, 140, 440));
  const boards = await artboards(page);
  expect(boards.map((a) => a.name)).toEqual(['Cover', 'Artboard']);
  const drawn = boards[1]!;
  await addSquare(page, 'Red', 10, 10, 30, [255, 0, 0, 255]);
  await page.getByTestId('menu-File').click();
  await page.getByTestId('menu-export').click();
  // Artboards are the default targets when a document has them.
  await expect(page.getByTestId('export-target-artboard')).toHaveCount(2);
  await expect(page.getByTestId('export-target-document')).not.toBeChecked();
  await page.getByTestId('export-add-size').click();
  await expect(page.getByTestId('export-file')).toHaveText([/^Cover\.png/, /^Cover@2x\.png/, /^Artboard\.png/, /^Artboard@2x\.png/]);
  await page.getByTestId('export-confirm').click();
  await expect.poll(() => page.evaluate(() => (window as any).__picks[0]?.bytes ?? 0), { timeout: 90_000 }).toBeGreaterThan(1000);
  const pick = await page.evaluate(() => (window as any).__picks[0]);
  expect(pick.name).toBe('Campaign export.zip');
  expect(pick.active).not.toBe(false);
  const entries = unzipSync(new Uint8Array(pick.data));
  const size = (bytes: Uint8Array) => { const view = new DataView(bytes.buffer, bytes.byteOffset); return [view.getUint32(16), view.getUint32(20)]; };
  expect(Object.fromEntries(Object.entries(entries).map(([name, bytes]) => [name, size(bytes)]))).toEqual({
    'Cover.png': [851, 315], 'Cover@2x.png': [1702, 630],
    'Artboard.png': [drawn.width, drawn.height], 'Artboard@2x.png': [drawn.width * 2, drawn.height * 2],
  });
  expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
});
