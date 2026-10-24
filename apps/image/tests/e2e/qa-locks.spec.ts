import { expect, test, type Page } from '@playwright/test';
import { exportedPixels, importThroughMenu, manifest, mountForTest, solidPng } from './helpers';

/** QA: layer locks (incl. folder inheritance), the lock notice, fill vs opacity, colour labels, search/filter. */
test.use({ viewport: { width: 1440, height: 900 } });
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

const session = (page: Page, fn: string, ...args: unknown[]) => page.evaluate(({ fn, args }) => {
  const s = (window as any).__editorForTests.session;
  return (s[fn] as (...a: unknown[]) => unknown).apply(s, args);
}, { fn, args });
const layers = (page: Page) => page.evaluate(() => (window as any).__handle.getManifestV2().layers as any[]);
const layerNamed = async (page: Page, name: string) => (await layers(page)).find((l) => l.name === name);
const idOf = async (page: Page, name: string) => (await layerNamed(page, name)).id as string;

/** 200×150 canvas, "red" 80×60 opaque and "blue" 60×40 opaque imported on top (centred). */
async function setup(page: Page, locale: 'en' | 'de' = 'en'): Promise<void> {
  await mountForTest(page, { locale });
  await page.getByTestId('widthInput').fill('200');
  await page.getByTestId('heightInput').fill('150');
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'red.png', mimeType: 'image/png', buffer: solidPng(80, 60, [255, 0, 0, 255]) }]);
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(2);
  await importThroughMenu(page, [{ name: 'blue.png', mimeType: 'image/png', buffer: solidPng(60, 40, [0, 0, 255, 255]) }]);
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(3);
}

/** Maps document pixels to page coordinates. */
async function mapper(page: Page) {
  const pane = (await page.getByTestId('canvas-pane').boundingBox())!;
  return async (x: number, y: number) => {
    const v = await page.evaluate(([x, y]) => { const s = (window as any).__editorForTests.session; return s.viewport.viewPoint({ x, y }, s.document); }, [x, y]);
    return { x: pane.x + v.x, y: pane.y + v.y };
  };
}
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 6) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

test('QA locks: a locked folder protects its children; the notice names the folder; child lock buttons show as implied', async ({ page }) => {
  await setup(page);
  const blue = await idOf(page, 'blue');
  await session(page, 'selectLayer', blue);
  await page.getByTestId('compositor-editor').press(`${mod}+g`);
  await expect.poll(async () => (await layers(page)).some((l) => l.kind === 'group')).toBe(true);
  const group = (await layers(page)).find((l) => l.kind === 'group');
  await session(page, 'renameLayer', group.id, 'Mappe');
  await session(page, 'selectLayer', group.id);
  await page.getByTestId('lock-all').click();
  await expect.poll(async () => (await layerNamed(page, 'Mappe')).locks.all).toBe(true);
  // The child: lock buttons for flags implied by the folder are disabled, the row shows a lock badge.
  await session(page, 'selectLayer', blue);
  await expect(page.getByTestId('lock-pixels')).toBeDisabled();
  await expect(page.getByTestId('lock-position')).toBeDisabled();
  // Painting on the child is refused and says the folder is locked.
  await page.getByTestId('tool-brush').click();
  const at = await mapper(page);
  await drag(page, await at(90, 75), await at(110, 75));
  await expect(page.getByTestId('lock-notice')).toContainText('Folder “Mappe” is locked.');
  expect((await exportedPixels(page)).data.slice((75 * 200 + 100) * 4, (75 * 200 + 100) * 4 + 4)).toEqual([0, 0, 255, 255]);
  // Moving the child with the arrow keys is refused too.
  await page.getByTestId('tool-move').click();
  const before = (await layerNamed(page, 'blue')).transform.origin;
  await page.getByTestId('compositor-editor').press('ArrowRight');
  expect((await layerNamed(page, 'blue')).transform.origin).toEqual(before);
  // Blend mode and opacity are not editable on a fully locked (inherited) layer.
  await expect(page.getByTestId('blend-mode')).toBeDisabled();
});

test('QA locks: the lock notice is non-modal and fades; the canvas stays usable while it shows', async ({ page }) => {
  await setup(page);
  await session(page, 'selectLayer', await idOf(page, 'blue'));
  await page.getByTestId('lock-pixels').click();
  await page.getByTestId('tool-brush').click();
  const at = await mapper(page);
  await drag(page, await at(90, 75), await at(110, 75));
  const notice = page.getByTestId('lock-notice');
  await expect(notice).toBeVisible();
  // No backdrop: a layer row can be clicked while the notice is shown, and painting the red layer works.
  await page.getByTestId('layer-row').filter({ hasText: 'red' }).click();
  await drag(page, await at(62, 50), await at(75, 50));
  await expect.poll(async () => (await exportedPixels(page)).data.slice((50 * 200 + 68) * 4, (50 * 200 + 68) * 4 + 3)).toEqual([0, 0, 0]);
  await expect(notice).toHaveCount(0, { timeout: 8000 });
});

test('QA locks: Lock Transparency keeps alpha under the brush', async ({ page }) => {
  await setup(page);
  const red = await idOf(page, 'red');
  await session(page, 'selectLayer', red);
  await page.getByTestId('lock-transparency').click();
  // Hide blue so the export shows red's pixels alone.
  await session(page, 'toggleLayerVisibility', await idOf(page, 'blue'));
  const at = await mapper(page);
  // Red spans x 60…140, y 45…105. Paint across its left edge: inside turns black, outside stays transparent.
  await page.getByTestId('tool-brush').click();
  await drag(page, await at(40, 55), await at(75, 55));
  const px = await exportedPixels(page);
  const get = (x: number, y: number) => px.data.slice((y * 200 + x) * 4, (y * 200 + x) * 4 + 4);
  expect(get(70, 55)).toEqual([0, 0, 0, 255]);
  expect(get(50, 55)[3]).toBe(0);
});

test('QA bug: the eraser on a transparency-locked layer paints black instead of the background colour', async ({ page }) => {
  await setup(page);
  await session(page, 'selectLayer', await idOf(page, 'red'));
  await page.getByTestId('lock-transparency').click();
  await session(page, 'toggleLayerVisibility', await idOf(page, 'blue'));
  const at = await mapper(page);
  await page.getByTestId('tool-brush').click();
  // Adobe: "in a layer with transparency locked, the pixels change to the background color" (white by default here).
  await page.getByTestId('context-bar').getByText('Erase', { exact: true }).click();
  await drag(page, await at(70, 90), await at(130, 90));
  const px = await exportedPixels(page);
  const got = px.data.slice((90 * 200 + 100) * 4, (90 * 200 + 100) * 4 + 4);
  console.log('QA eraser on transparency-locked layer leaves', got);
  expect(got[3]).toBe(255);
  expect(got.slice(0, 3)).toEqual([255, 255, 255]);
});

test('QA fill opacity: the Fill field fades the pixels like Opacity for Normal, is independent of Opacity, and is off for folders', async ({ page }) => {
  await setup(page);
  const blue = await idOf(page, 'blue');
  await session(page, 'selectLayer', blue);
  await page.getByTestId('fill-field').fill('50');
  await page.getByTestId('fill-field').press('Enter');
  await expect.poll(async () => (await layerNamed(page, 'blue')).fillOpacity).toBeCloseTo(0.5, 3);
  await expect(page.getByTestId('opacity-field')).toHaveValue('100');
  let px = await exportedPixels(page);
  const at = (x: number, y: number) => px.data.slice((y * 200 + x) * 4, (y * 200 + x) * 4 + 4);
  // Blue over red at 50 %: (128, 0, 128); blue over transparent at 50 %: alpha 128.
  expect(at(100, 75).map((v, i) => Math.abs(v - [128, 0, 127, 255][i]!) <= 1)).toEqual([true, true, true, true]);
  await page.getByTestId('opacity-field').fill('50');
  await page.getByTestId('opacity-field').press('Enter');
  px = await exportedPixels(page);
  // Opacity and Fill multiply for Normal: 25 % blue over red.
  expect(at(100, 75).map((v, i) => Math.abs(v - [191, 0, 64, 255][i]!) <= 1)).toEqual([true, true, true, true]);
  // Folders have no Fill in Photoshop: the field is disabled.
  await page.getByTestId('compositor-editor').press(`${mod}+g`);
  await expect.poll(async () => (await layers(page)).some((l) => l.kind === 'group')).toBe(true);
  await session(page, 'selectLayer', (await layers(page)).find((l) => l.kind === 'group').id);
  await expect(page.getByTestId('fill-field')).toBeDisabled();
});

test('QA search: case- and accent-insensitive search finds Ü/ß/Ä names, and children keep their folder visible', async ({ page }) => {
  await setup(page);
  for (let i = 0; i < 3; i++) await page.getByTestId('addBlankLayer').click();
  const ls = await layers(page);
  const blanks = ls.filter((l) => l.kind === 'pixel' && !['red', 'blue'].includes(l.name));
  const names = ['Übersicht', 'Straße', 'ÄRGER Ebene'];
  for (let i = 0; i < 3; i++) await session(page, 'renameLayer', blanks[i + 1]?.id ?? blanks[i].id, names[i]);
  await session(page, 'renameLayer', (await layers(page)).find((l) => l.name.startsWith('Layer'))!.id, 'Hintergrund');
  // Put "Straße" into a folder.
  await session(page, 'selectLayer', await idOf(page, 'Straße'));
  await page.getByTestId('compositor-editor').press(`${mod}+g`);
  await expect.poll(async () => (await layers(page)).some((l) => l.kind === 'group')).toBe(true);
  const rows = page.getByTestId('layer-row');
  const search = page.getByTestId('layer-search');
  const visibleNames = async () => rows.evaluateAll((els) => els.map((el) => el.querySelector('[class*="layerName"]')!.textContent!));
  for (const [query, expected] of [['uber', ['Übersicht']], ['ÜBER', ['Übersicht']], ['strasse', ['Straße']], ['STRAẞE', ['Straße']],
    ['ärger', ['ÄRGER Ebene']], ['arger', ['ÄRGER Ebene']], ['ebene', ['ÄRGER Ebene']]] as const) {
    await search.fill(query);
    await expect.poll(async () => (await visibleNames()).filter((n) => !n.startsWith('Group') && !n.startsWith('Folder'))).toEqual([...expected]);
  }
  // The folder of a matching child stays visible so the child can be reached.
  await search.fill('straße');
  await expect(rows).toHaveCount(2);
  await search.press('Escape');
  await expect(rows).toHaveCount((await layers(page)).length);
});

test('QA colour labels: label from the context menu, filter by colour, label survives save/reopen', async ({ page }) => {
  await setup(page);
  await page.getByTestId('layer-row').filter({ hasText: 'red' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Color Label' }).hover();
  await page.getByRole('menuitem', { name: 'Violet' }).click();
  await expect.poll(async () => (await layerNamed(page, 'red')).colorLabel).toBe('violet');
  await page.getByTestId('layer-filter').click();
  await page.getByRole('menuitem', { name: 'Violet' }).click();
  await expect(page.getByTestId('layer-row')).toHaveCount(1);
  await page.evaluate(async () => { const h = (window as any).__handle; await h.openProject(await h.saveProject()); });
  await expect.poll(async () => (await layerNamed(page, 'red'))?.colorLabel).toBe('violet');
});

test('QA locks: align with a position-locked layer in the selection is refused as a whole, with a notice', async ({ page }) => {
  await setup(page);
  const red = await idOf(page, 'red'), blue = await idOf(page, 'blue');
  await session(page, 'selectLayer', blue);
  await page.getByTestId('lock-position').click();
  const before = await layers(page);
  await session(page, 'selectLayers', [red, blue], red);
  await page.getByTestId('menu-Layer').click();
  await page.getByRole('menuitem', { name: 'Align' }).hover();
  await page.getByRole('menuitem', { name: 'Top Edges' }).click();
  await expect(page.getByTestId('lock-notice')).toHaveAttribute('data-code', 'layer-lock-position');
  const after = await layers(page);
  expect(after.map((l) => l.transform.origin)).toEqual(before.map((l) => l.transform.origin));
});

test('QA bug: distorting two layers where one has locked pixels distorts the other one anyway', async ({ page }) => {
  await setup(page);
  const red = await idOf(page, 'red'), blue = await idOf(page, 'blue');
  await session(page, 'selectLayer', blue);
  await page.getByTestId('lock-pixels').click();
  await session(page, 'selectLayers', [red, blue], blue);
  const before = await layers(page);
  // ⌘T, then ⌘-drag the top-left corner handle of the group box (Photoshop's distort gesture), then Enter.
  await page.getByTestId('compositor-editor').press(`${mod}+t`);
  await expect.poll(() => page.evaluate(() => !!(window as any).__editorForTests.session.transformEdit)).toBe(true);
  const at = await mapper(page);
  const box = await page.evaluate(() => { const s = (window as any).__editorForTests.session; const o = s.transformEdit.draft.origin; return { x: o.x, y: o.y }; });
  const corner = await at(box.x, box.y);
  await page.keyboard.down(mod);
  await drag(page, corner, { x: corner.x + 25, y: corner.y + 15 }, 5);
  await page.keyboard.up(mod);
  await expect.poll(() => page.evaluate(() => !!(window as any).__editorForTests.session.transformEdit?.corners)).toBe(true);
  await page.getByTestId('compositor-editor').press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.transformEdit)).toBe(null);
  const after = await layers(page);
  const changed = after.filter((l, i) => JSON.stringify(l.transform) !== JSON.stringify(before[i].transform) || l.assetId !== before[i].assetId);
  console.log('QA distort changed layers:', changed.map((l) => l.name));
  // Photoshop refuses the whole transform; a partial result (red distorted, blue not) is the bug.
  expect(changed.map((l) => l.name)).toEqual([]);
});

test('QA locks: Fill with Foreground (Alt+Backspace) on a transparency-locked layer fills only its opaque pixels', async ({ page }) => {
  await setup(page);
  await session(page, 'selectLayer', await idOf(page, 'red'));
  await session(page, 'toggleLayerVisibility', await idOf(page, 'blue'));
  await page.getByTestId('lock-transparency').click();
  await page.getByTestId('compositor-editor').press(`${mod}+a`);
  await page.getByTestId('compositor-editor').press('Alt+Backspace');
  await expect.poll(async () => (await page.evaluate(() => (window as any).__editorForTests.session.history.pastNames as string[])).length).toBeGreaterThan(3);
  const px = await exportedPixels(page);
  const get = (x: number, y: number) => px.data.slice((y * 200 + x) * 4, (y * 200 + x) * 4 + 4);
  expect(get(100, 75)).toEqual([0, 0, 0, 255]);
  expect(get(20, 20)[3]).toBe(0);
});

for (const [what, key] of [['Fill with Foreground (Alt+Backspace)', 'Alt+Backspace'], ['Levels (⌘L)', `${mod}+l`], ['Invert (⌘I)', `${mod}+i`]] as const) {
  test(`QA bug: ${what} on a pixel-locked layer silently does nothing — no lock notice`, async ({ page }) => {
    await setup(page);
    await session(page, 'selectLayer', await idOf(page, 'red'));
    await page.getByTestId('lock-pixels').click();
    const steps = await page.evaluate(() => (window as any).__editorForTests.session.history.undoCount);
    await page.getByTestId('compositor-editor').press(`${mod}+a`);
    await page.getByTestId('compositor-editor').press(key);
    // Refused, as it should be …
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as any).__editorForTests.session.history.undoCount)).toBeLessThanOrEqual(steps + 1);
    // … but the user should be told why, like for a refused brush stroke.
    await expect(page.getByTestId('lock-notice')).toHaveAttribute('data-code', 'layer-lock-pixels', { timeout: 3000 });
  });
}

test('QA bug: a Move-tool drag on a position-locked layer is refused without the lock notice', async ({ page }) => {
  await setup(page);
  await session(page, 'selectLayer', await idOf(page, 'blue'));
  await page.getByTestId('lock-position').click();
  await page.getByTestId('tool-move').click();
  const before = (await layerNamed(page, 'blue')).transform.origin;
  const at = await mapper(page);
  await drag(page, await at(100, 75), await at(130, 95));
  console.log('QA move of position-locked layer:', JSON.stringify(before), '→', JSON.stringify((await layerNamed(page, 'blue')).transform.origin),
    await page.evaluate(() => (window as any).__editorForTests.session.history.pastNames));
  expect((await layerNamed(page, 'blue')).transform.origin).toEqual(before);
  expect((await layerNamed(page, 'red')).transform.origin).toEqual({ x: 60, y: 45 });
  await expect(page.getByTestId('lock-notice')).toHaveAttribute('data-code', 'layer-lock-position');
});
