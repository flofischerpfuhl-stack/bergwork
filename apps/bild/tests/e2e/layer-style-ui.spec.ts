import { expect, test, type Page } from '@playwright/test';
import { exportedPixels, mountForTest, solidPng } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });
// Long workflows; several imports and exports each.
test.describe.configure({ timeout: 240_000 });

const undoKey = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';
const redoKey = process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z';

/** A 160 × 120 canvas with opaque squares imported on top of the empty first layer. */
async function setup(page: Page, locale: 'de' | 'en' = 'en', squares = 1): Promise<void> {
  await mountForTest(page, { locale });
  await page.getByTestId('widthInput').fill('160');
  await page.getByTestId('heightInput').fill('120');
  await page.getByTestId('createCanvas').click();
  for (let i = 0; i < squares; i++) {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId(locale === 'de' ? 'menu-Ablage' : 'menu-File').click();
    await page.getByTestId('menu-import').click();
    await (await chooser).setFiles([{ name: `square${i + 1}.png`, mimeType: 'image/png', buffer: solidPng(40, 40, [220, 40, 40, 255]) }]);
    await expect(page.getByTestId('layer-row')).toHaveCount(i + 2);
  }
  await expect(page.getByTestId('layer-row')).toHaveCount(squares + 1);
}

const layerNamed = (page: Page, name: string) => page.evaluate((n) => {
  const layer = (window as any).__editorForTests.session.document.layers.find((l: any) => l.name === n);
  return { id: layer.id as string, effects: layer.effects as any[], origin: layer.transform.origin as { x: number; y: number } };
}, name);
const history = (page: Page) => page.evaluate(() => {
  const h = (window as any).__editorForTests.session.history;
  return { count: h.undoCount as number, name: h.undoName as string };
});
const alphaAt = (pixels: { width: number; data: number[] }, x: number, y: number) => pixels.data[(y * pixels.width + x) * 4 + 3]!;

async function openFromLayerMenu(page: Page, item: string, menu = 'Layer', submenu = 'Layer Style'): Promise<void> {
  await page.getByTestId(`menu-${menu}`).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${submenu}`) }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

test('Layer Style dialog: drop shadow from the menu, distance typed and dragged, pixels, one undo step, Cancel, Enter and Escape', async ({ page }) => {
  await setup(page);
  const square = await layerNamed(page, 'square1');
  const before = await exportedPixels(page);
  // Below and right of the square, where a shadow lit from 120° falls.
  const probe = { x: Math.round(square.origin.x) + 44, y: Math.round(square.origin.y) + 52 };
  expect(alphaAt(before, probe.x, probe.y)).toBe(0);
  const start = await history(page);

  await openFromLayerMenu(page, 'Drop Shadow…');
  const dialog = page.getByTestId('layer-style-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('style-body')).toHaveAttribute('data-kind', 'dropShadow');
  await expect(page.getByTestId('style-enable-dropShadow')).toBeChecked();
  expect((await layerNamed(page, 'square1')).effects).toMatchObject([{ kind: 'dropShadow', enabled: true, distance: 5, useGlobalLight: true }]);

  // Distance by typing: applies live.
  await page.getByTestId('style-distance').fill('12');
  await expect.poll(async () => (await layerNamed(page, 'square1')).effects[0].distance).toBe(12);
  // …and by dragging the slider (0–250 px).
  const slider = (await page.getByTestId('style-distance-slider').boundingBox())!;
  // Grab the thumb (about 16 px wide, at 12 of 250) and drag it to the right.
  const thumb = slider.x + 8 + (slider.width - 16) * (12 / 250);
  await page.mouse.move(thumb, slider.y + slider.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumb + slider.width * 0.05, slider.y + slider.height / 2, { steps: 5 });
  await page.mouse.up();
  const dragged = (await layerNamed(page, 'square1')).effects[0].distance as number;
  expect(dragged).toBeGreaterThan(12);
  expect(dragged).toBeLessThan(40);
  await expect(page.getByTestId('style-distance')).toHaveValue(String(dragged));
  await page.getByTestId('style-distance').fill('20');
  // Keys typed into fields never reach the tools.
  await page.getByTestId('style-distance').press('b');
  expect(await page.evaluate(() => (window as any).__editorForTests.session.tool)).not.toBe('brush');
  await page.getByTestId('style-distance').fill('20');
  await page.getByTestId('style-size').fill('4');

  // The canvas previews live, and the export shows the shadow where it falls.
  const live = await exportedPixels(page);
  expect(alphaAt(live, probe.x, probe.y)).toBeGreaterThan(40);
  expect(await page.evaluate(() => (window as any).__editorForTests.session.canUndo)).toBe(false);

  await page.getByTestId('style-ok').click();
  await expect(dialog).toBeHidden();
  const after = await history(page);
  expect(after).toEqual({ count: start.count + 1, name: 'Layer Style' });
  const exported = await exportedPixels(page);
  expect(alphaAt(exported, probe.x, probe.y)).toBeGreaterThan(40);
  // Inside the square nothing changed; well away from it nothing either.
  const inside = (Math.round(square.origin.y) + 20) * before.width + Math.round(square.origin.x) + 20;
  expect(exported.data.slice(inside * 4, inside * 4 + 4)).toEqual(before.data.slice(inside * 4, inside * 4 + 4));
  expect(alphaAt(exported, 2, 2)).toBe(0);

  // One undo step removes everything the dialog did; redo brings it back.
  await page.getByTestId('compositor-editor').press(undoKey);
  expect((await layerNamed(page, 'square1')).effects).toEqual([]);
  await page.getByTestId('compositor-editor').press(redoKey);
  expect((await layerNamed(page, 'square1')).effects).toMatchObject([{ kind: 'dropShadow', distance: 20, size: 4 }]);

  // Cancel restores the state from before opening, including an effect added meanwhile and the global light.
  const kept = (await layerNamed(page, 'square1')).effects;
  const row = page.getByTestId('layer-row').first();
  await row.locator('[class*="layerMeta"]').dblclick();
  await expect(dialog).toBeVisible();
  await page.getByTestId('style-opacity').fill('90');
  await page.getByTestId('style-angle').fill('45');
  await page.getByTestId('style-effect-stroke').click();
  await expect(page.getByTestId('style-body')).toHaveAttribute('data-kind', 'stroke');
  await page.getByRole('radio', { name: 'Inside' }).click();
  expect((await layerNamed(page, 'square1')).effects.map((e: any) => e.kind)).toEqual(['dropShadow', 'stroke']);
  await page.getByTestId('style-cancel').click();
  await expect(dialog).toBeHidden();
  expect((await layerNamed(page, 'square1')).effects).toEqual(kept);
  expect(await page.evaluate(() => (window as any).__editorForTests.session.document.globalLightAngle ?? 120)).toBe(120);
  expect(await history(page)).toEqual(after);

  // Escape cancels, Enter confirms from a field.
  await row.locator('[class*="layerMeta"]').dblclick();
  await page.getByTestId('style-size').fill('9');
  await page.getByTestId('style-size').press('Escape');
  await expect(dialog).toBeHidden();
  expect((await layerNamed(page, 'square1')).effects[0].size).toBe(4);
  await row.locator('[class*="layerMeta"]').dblclick();
  await page.getByTestId('style-size').fill('9');
  await page.getByTestId('style-size').press('Enter');
  await expect(dialog).toBeHidden();
  expect((await layerNamed(page, 'square1')).effects[0].size).toBe(9);
  expect(await history(page)).toEqual({ count: after.count + 1, name: 'Layer Style' });

  // A double-click on the name still renames.
  await row.locator('[data-layer-name]').dblclick();
  await expect(page.getByRole('textbox', { name: 'Layer name' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Layer name' }).press('Escape');
  await expect(dialog).toBeHidden();
});

test('copy, paste and clear layer styles; fx badge, effect rows with eyes, the fx button and locks', async ({ page }) => {
  await setup(page, 'en', 2);
  const rows = page.getByTestId('layer-row');
  // Top row: square2. A stroke through the row's context menu.
  await rows.nth(0).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Layer Style/ }).click();
  await page.getByRole('menuitem', { name: 'Stroke…' }).click();
  await expect(page.getByTestId('style-body')).toHaveAttribute('data-kind', 'stroke');
  await page.getByTestId('style-width').fill('6');
  // Gradient fill with a third stop, reversed.
  await page.getByRole('radio', { name: 'Gradient' }).click();
  await expect(page.getByTestId('style-gradient-stop')).toHaveCount(2);
  await page.getByTestId('style-stop-add').click();
  await expect(page.getByTestId('style-gradient-stop')).toHaveCount(3);
  await page.getByTestId('style-reverse').check();
  // A second effect, switched on from its checkbox.
  await page.getByTestId('style-enable-colorOverlay').check();
  await page.getByTestId('style-ok').click();
  const styled = await layerNamed(page, 'square2');
  expect(styled.effects.map((e: any) => e.kind)).toEqual(['colorOverlay', 'stroke']);
  expect(styled.effects[1]).toMatchObject({ width: 6, fill: { kind: 'gradient', gradient: { reverse: true } } });
  expect(styled.effects[1].fill.gradient.stops).toHaveLength(3);

  // Copy from square2, paste onto square1 through the context menus.
  await rows.nth(0).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Layer Style/ }).click();
  await page.getByRole('menuitem', { name: 'Copy Layer Style' }).click();
  await rows.nth(1).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Layer Style/ }).click();
  await page.getByRole('menuitem', { name: 'Paste Layer Style' }).click();
  expect((await layerNamed(page, 'square1')).effects).toEqual(styled.effects);
  expect((await history(page)).name).toBe('Paste Layer Style');

  // fx badge on both rows; expanding lists the effects in Photoshop's order with an eye each.
  await expect(rows.nth(0).getByTestId('fx-badge')).toBeVisible();
  await expect(rows.nth(1).getByTestId('fx-badge')).toBeVisible();
  await expect(rows.nth(2).getByTestId('fx-badge')).toHaveCount(0);
  await rows.nth(0).getByTestId('fx-badge').click();
  const effectRows = page.getByTestId('effect-row');
  await expect(effectRows).toHaveCount(2);
  await expect(effectRows.nth(0)).toContainText('Stroke');
  await expect(effectRows.nth(1)).toContainText('Color Overlay');
  await effectRows.nth(0).getByTestId('effect-eye').click();
  expect((await layerNamed(page, 'square2')).effects[1].enabled).toBe(false);
  await expect(effectRows.nth(0).getByTestId('effect-eye')).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('compositor-editor').press(undoKey);
  expect((await layerNamed(page, 'square2')).effects[1].enabled).toBe(true);
  // Double-click on an effect row opens the dialog on that effect.
  await effectRows.nth(1).dblclick();
  await expect(page.getByTestId('style-body')).toHaveAttribute('data-kind', 'colorOverlay');
  await page.getByTestId('style-cancel').click();
  await rows.nth(0).getByTestId('fx-badge').click();
  await expect(effectRows).toHaveCount(0);

  // Clear Layer Style from the Layer menu on square1.
  await rows.nth(1).click();
  await page.getByTestId('menu-Layer').click();
  await page.getByRole('menuitem', { name: /^Layer Style/ }).click();
  await page.getByRole('menuitem', { name: 'Clear Layer Style' }).click();
  expect((await layerNamed(page, 'square1')).effects).toEqual([]);
  await expect(rows.nth(1).getByTestId('fx-badge')).toHaveCount(0);

  // The fx button in the footer offers the effects.
  await page.getByTestId('fx-button').click();
  await page.getByRole('menuitem', { name: 'Outer Glow…' }).click();
  await expect(page.getByTestId('style-body')).toHaveAttribute('data-kind', 'outerGlow');
  // Effects only looked at and left off are not kept.
  await page.getByTestId('style-effect-dropShadow').click();
  await page.getByTestId('style-enable-dropShadow').uncheck();
  await page.getByTestId('style-ok').click();
  expect((await layerNamed(page, 'square1')).effects.map((e: any) => e.kind)).toEqual(['outerGlow']);

  // Lock All: the dialog does not open and the lock notice says why.
  await page.getByTestId('lock-all').click();
  await openFromLayerMenu(page, 'Drop Shadow…');
  await expect(page.getByTestId('lock-notice')).toHaveAttribute('data-code', 'layer-lock-all');
  await expect(page.getByTestId('layer-style-dialog')).toHaveCount(0);
  await rows.nth(1).getByTestId('fx-badge').click();
  await page.getByTestId('effect-eye').click();
  expect((await layerNamed(page, 'square1')).effects[0].enabled).toBe(true);
});

test('German labels in the menus, the dialog and the Layers panel', async ({ page }) => {
  await setup(page, 'de');
  await openFromLayerMenu(page, 'Schlagschatten …', 'Ebene', 'Ebenenstil');
  const dialog = page.getByTestId('layer-style-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Ebenenstil · square1' })).toBeVisible();
  for (const text of ['Effekte', 'Kontur', 'Farbüberlagerung', 'Verlaufsüberlagerung', 'Schein nach außen', 'Schlagschatten',
    'Füllmethode', 'Deckkraft', 'Winkel', 'Globales Licht verwenden', 'Distanz', 'Überfüllen', 'Größe', 'Ebene spart Schlagschatten aus',
    'Effekt löschen', 'Abbrechen']) {
    await expect(dialog.getByText(text, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByTestId('style-blend')).toHaveValue('multiply');
  await expect(page.getByTestId('style-blend').locator('option:checked')).toHaveText('Multiplizieren');
  await page.getByTestId('style-effect-stroke').click();
  for (const text of ['Position', 'Füllart']) await expect(dialog.getByText(text, { exact: true }).first()).toBeVisible();
  for (const text of ['Außen', 'Innen', 'Mitte', 'Farbe', 'Verlauf']) await expect(dialog.getByRole('radio', { name: text })).toBeVisible();
  await page.getByTestId('style-ok').click();
  const row = page.getByTestId('layer-row').first();
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Ebenenstil/ }).click();
  for (const text of ['Ebenenstil kopieren', 'Ebenenstil einfügen', 'Ebenenstil löschen', 'Verlaufsüberlagerung …']) {
    await expect(page.getByRole('menuitem', { name: text })).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await row.getByTestId('fx-badge').click();
  await expect(page.getByTestId('effect-row').first()).toContainText('Kontur');
  await page.getByTestId('menu-Bearbeiten').click();
  await expect(page.getByTestId('menu-undo')).toHaveText(/Widerrufen Ebenenstil/);
});
