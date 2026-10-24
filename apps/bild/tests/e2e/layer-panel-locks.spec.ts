import { expect, test } from '@playwright/test';
import { mountForTest } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });

const layerById = async (page: import('@playwright/test').Page, name: string) =>
  (await page.evaluate(() => (window as any).__handle.getManifestV2())).layers.find((l: any) => l.name === name);

test('locks, fill opacity, colour labels, search and filter in the Layers panel', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('64');
  await page.getByTestId('heightInput').fill('48');
  await page.getByTestId('createCanvas').click();
  for (let i = 0; i < 3; i++) await page.getByTestId('addBlankLayer').click();
  const rows = page.getByTestId('layer-row');
  await expect(rows).toHaveCount(4);
  const names: string[] = await rows.evaluateAll((els) => els.map((el) => el.querySelector('[class*="layerName"]')!.textContent!));
  const [top, second] = names as [string, string];

  // Locks: one undo step each, badge on the row, partial vs. full.
  await rows.first().click();
  await page.getByTestId('lock-transparency').click();
  await expect(page.getByTestId('lock-transparency')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await layerById(page, top)).locks?.transparency).toBe(true);
  await expect(rows.first().getByTestId('layer-lock')).toBeVisible();
  await page.getByTestId('lock-all').click();
  await expect.poll(async () => (await layerById(page, top)).locks?.all).toBe(true);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect.poll(async () => (await layerById(page, top)).locks?.all).toBe(false);
  await expect(page.getByTestId('lock-all')).toHaveAttribute('aria-pressed', 'false');

  // A stroke on a layer with locked pixels does nothing and says why.
  await page.getByTestId('lock-pixels').click();
  await page.getByTestId('tool-brush').click();
  const pane = (await page.getByTestId('canvas-pane').boundingBox())!;
  await page.mouse.move(pane.x + pane.width / 2 - 20, pane.y + pane.height / 2);
  await page.mouse.down();
  await page.mouse.move(pane.x + pane.width / 2 + 20, pane.y + pane.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('lock-notice')).toHaveAttribute('data-code', 'layer-lock-pixels');
  expect((await layerById(page, top)).locks?.pixels).toBe(true);
  await page.getByTestId('lock-pixels').click();

  // Fill opacity through the field, independent of opacity.
  await rows.nth(1).click();
  await page.getByTestId('fill-field').fill('40');
  await page.getByTestId('fill-field').press('Enter');
  await expect.poll(async () => (await layerById(page, second)).fillOpacity).toBeCloseTo(0.4, 3);
  expect((await layerById(page, second)).opacity).toBe(1);
  await expect(page.getByTestId('opacity-field')).toHaveValue('100');

  // Colour label from the context menu: stored and shown on the eye column.
  await rows.nth(1).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Color Label' }).hover();
  await page.getByRole('menuitem', { name: 'Green' }).click();
  await expect.poll(async () => (await layerById(page, second)).colorLabel).toBe('green');
  await expect(rows.nth(1).getByTestId('layer-eye')).toHaveAttribute('data-label', 'green');

  // Search narrows the list; Escape clears it.
  const search = page.getByTestId('layer-search');
  await search.fill(second.toUpperCase());
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(second);
  await search.fill('no such layer');
  await expect(rows).toHaveCount(0);
  await expect(page.getByTestId('layer-search-empty')).toBeVisible();
  await search.press('Escape');
  await expect(rows).toHaveCount(4);

  // Filter by colour, then by locked layers; clearing restores the list.
  await page.getByTestId('layer-filter').click();
  await page.getByRole('menuitem', { name: 'Green' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(second);
  await page.getByTestId('layer-filter').click();
  await page.getByRole('menuitem', { name: 'Clear Filter' }).click();
  await page.getByTestId('layer-filter').click();
  await page.getByRole('menuitem', { name: 'Locked Layers' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(top);
  await page.getByTestId('layer-filter').click();
  await page.getByRole('menuitem', { name: 'Clear Filter' }).click();
  await expect(rows).toHaveCount(4);

  // Everything survives a save/reopen round trip of the archive (format v2).
  const reopened = await page.evaluate(async () => {
    const handle = (window as any).__handle;
    const blob: Blob = await handle.saveProject();
    await handle.openProject(blob);
    return true;
  });
  expect(reopened).toBe(true);
  await expect.poll(async () => (await layerById(page, second))?.colorLabel).toBe('green');
  expect((await layerById(page, second)).fillOpacity).toBeCloseTo(0.4, 3);
  expect((await layerById(page, top)).locks?.transparency).toBe(true);
});
