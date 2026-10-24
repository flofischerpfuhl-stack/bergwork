import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importThroughMenu, manifest, mountForTest, solidPng } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const size = (page: Page) => page.evaluate(() => {
  const d = (window as any).__editorForTests.session.document;
  return [d.width, d.height];
});
const menu = async (page: Page, title: string, ...path: string[]) => {
  await page.getByTestId(`menu-${title}`).click();
  for (const [index, label] of path.entries()) {
    const item = page.locator('[data-menu-popup]').last().getByRole('menuitem', { name: new RegExp(`^${label}`) });
    if (index < path.length - 1) await item.hover(); else await item.click();
  }
};

test('Image Rotation turns the canvas a quarter turn as one undo step', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('300');
  await page.getByTestId('heightInput').fill('200');
  await page.getByTestId('createCanvas').click();
  await menu(page, 'Image', 'Image Rotation', '90° Clockwise');
  await expect.poll(() => size(page)).toEqual([200, 300]);
  await menu(page, 'Image', 'Image Rotation', '180°');
  await expect.poll(() => size(page)).toEqual([200, 300]);
  await page.getByTestId('compositor-editor').press(`${mod}+z`);
  await page.getByTestId('compositor-editor').press(`${mod}+z`);
  await expect.poll(() => size(page)).toEqual([300, 200]);
});

test('Trim crops away transparent edges', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'red.png', mimeType: 'image/png', buffer: solidPng(120, 80, [220, 0, 0, 255]) }]);
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(2);
  await menu(page, 'Image', 'Trim…');
  await expect(page.getByTestId('trim-dialog')).toBeVisible();
  await page.getByTestId('trim-apply').click();
  await expect.poll(() => size(page)).toEqual([120, 80]);
});

test('Ungroup Layers (Shift+Ctrl+G) releases a folder in place', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('createCanvas').click();
  await page.getByTestId('compositor-editor').press(`${mod}+g`);
  await expect.poll(async () => (await manifest(page)).layers.map((l: any) => l.name)).toEqual(['Folder 1', 'Layer 1']);
  await page.getByTestId('compositor-editor').press(`${mod}+Shift+g`);
  await expect.poll(async () => (await manifest(page)).layers.map((l: any) => l.name)).toEqual(['Layer 1']);
});

test('Import Folder as Layers brings in the folder’s images in name order', async ({ page }) => {
  const folder = mkdtempSync(join(tmpdir(), 'fwimg-folder-'));
  writeFileSync(join(folder, 'b-10.png'), solidPng(20, 20, [0, 0, 255, 255]));
  writeFileSync(join(folder, 'b-2.png'), solidPng(20, 20, [0, 255, 0, 255]));
  writeFileSync(join(folder, 'notes.txt'), 'not an image');
  await mountForTest(page);
  await page.getByTestId('createCanvas').click();
  const chooser = page.waitForEvent('filechooser');
  await menu(page, 'File', 'Import Folder as Layers…');
  await (await chooser).setFiles(folder);
  await expect.poll(async () => (await manifest(page)).layers.map((l: any) => l.name)).toEqual(['Layer 1', 'b-2', 'b-10']);
});

test('the crop tool offers 3:4 and 9:16; tabs reorder by dragging; Ctrl + middle drag zooms', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('createCanvas').click();
  await page.getByTestId('tool-crop').click();
  const ratios = page.locator('select', { has: page.locator('option[value="16:9"]') });
  await expect(ratios.locator('option[value="3:4"]')).toHaveCount(1);
  await ratios.selectOption('9:16');
  await page.keyboard.press('Escape');

  await page.getByTestId('new-canvas').click();
  await page.getByTestId('createCanvas').last().click();
  const tabs = page.getByRole('tablist', { name: 'Project tabs' }).getByRole('tab');
  await expect(tabs).toHaveCount(2);
  const names = async () => (await tabs.allTextContents()).map((text) => text.trim());
  const before = await names();
  const first = (await tabs.nth(0).boundingBox())!, second = (await tabs.nth(1).boundingBox())!;
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + second.width / 2 + 20, second.y + second.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(names).toEqual([before[1], before[0]]);

  const zoom = () => page.evaluate(() => (window as any).__editorForTests.session.viewport.zoom as number);
  const start = await zoom();
  const pane = (await page.getByTestId('canvas-pane').boundingBox())!;
  const x = pane.x + pane.width / 2, y = pane.y + pane.height / 2;
  await page.mouse.move(x, y);
  await page.keyboard.down('Control');
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(x + 150, y, { steps: 6 });
  await page.mouse.up({ button: 'middle' });
  await page.keyboard.up('Control');
  await expect.poll(zoom).toBeGreaterThan(start * 1.8);
});
