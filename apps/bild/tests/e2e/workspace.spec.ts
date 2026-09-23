import { expect, test } from '@playwright/test';
import { importThroughMenu, manifest, mountForTest, solidPng } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });

test('dragging a layer onto another tab copies it there as one undo step', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'green.png', mimeType: 'image/png', buffer: solidPng(30, 30, [0, 200, 0, 255]) }]);
  // A second project tab.
  await page.getByTestId('new-canvas').click();
  await page.getByTestId('createCanvas').last().click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  const tabs = page.getByRole('tab');
  await tabs.nth(0).click();
  const row = page.getByTestId('layer-row').first();
  await expect(row).toContainText('green');
  const from = (await row.boundingBox())!;
  const to = (await tabs.nth(1).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + 40, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => (await manifest(page)).layers.map((l: any) => l.name)).toEqual(['Layer 1', 'green']);
  const copied = (await manifest(page)).layers[1];
  expect(copied.transform[4]).toBe(Math.floor(1920 / 2 - 15));
  await page.getByTestId('compositor-editor').press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(1);
});

test('pasting an external image centres it on a new layer', async ({ page, browserName }) => {
  // Firefox's ClipboardEvent constructor drops a synthetic clipboardData, so the event carries no image there.
  test.skip(browserName === 'firefox', 'synthetic paste events carry no data in Firefox');
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('100');
  await page.getByTestId('heightInput').fill('80');
  await page.getByTestId('createCanvas').click();
  const png = solidPng(10, 20, [255, 128, 0, 255]).toString('base64');
  await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'clip.png', { type: 'image/png' }));
    const editor = document.querySelector('[data-testid=compositor-editor]')!;
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, png);
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(2);
  const layer = (await manifest(page)).layers[1];
  expect(layer.transform).toEqual([1, 0, 0, 1, 45, 30]);
});

test('New Canvas opens an empty tab without a modal; M and L switch the selection shapes', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('createCanvas').click();
  // The editor has keyboard focus from the start.
  expect(await page.evaluate(() => document.activeElement?.closest('[data-testid=compositor-editor]') !== null)).toBe(true);
  await page.getByTestId('menu-File').click();
  await page.getByTestId('menu-new-canvas').click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[role=alertdialog], [aria-modal=true]')).toHaveCount(0);
  await page.getByTestId('createCanvas').click();
  const editor = page.getByTestId('compositor-editor');
  const tool = () => page.evaluate(() => (window as any).__editorForTests.session.tool);
  await editor.press('m');
  expect(await tool()).toBe('marquee');
  await expect(page.getByRole('radio', { name: 'Rectangle' })).toHaveAttribute('aria-checked', 'true');
  await editor.press('m');
  await expect(page.getByRole('radio', { name: 'Ellipse' })).toHaveAttribute('aria-checked', 'true');
  await editor.press('l');
  expect(await tool()).toBe('lasso');
  await editor.press('l');
  await expect(page.getByRole('radio', { name: 'Polygonal' })).toHaveAttribute('aria-checked', 'true');
  await editor.press('b');
  await editor.press('m');
  await expect(page.getByRole('radio', { name: 'Ellipse' })).toHaveAttribute('aria-checked', 'true');
});

test('Save asks where once and then overwrites; Save As asks again; a cancelled save leaves the project unsaved', async ({ page }) => {
  await mountForTest(page, { fileTargets: true });
  await page.getByTestId('widthInput').fill('40');
  await page.getByTestId('heightInput').fill('40');
  await page.getByTestId('createCanvas').click();
  const editor = page.getByTestId('compositor-editor');
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const writes = () => page.evaluate(() => (window as any).__targetWrites.map((w: any) => `${w.op}:${w.name}`));
  const modified = () => page.evaluate(() => (window as any).__editorForTests.session.isModified);
  await page.getByTestId('menu-Layer').click();
  await page.getByTestId('menu-new-layer').click();
  await page.evaluate(() => { (window as any).__pickerAnswer = 'cancel'; });
  await editor.press(`${mod}+s`);
  await expect.poll(writes).toEqual(['as:Untitled.compositor.zip']);
  expect(await modified()).toBe(true);
  await page.evaluate(() => { (window as any).__pickerAnswer = 'Poster.compositor.zip'; });
  await editor.press(`${mod}+s`);
  await expect.poll(async () => (await writes()).length).toBe(2);
  expect(await modified()).toBe(false);
  await expect(page.getByRole('tab', { selected: true })).toContainText('Poster');
  await page.getByTestId('menu-Layer').click();
  await page.getByTestId('menu-new-layer').click();
  await editor.press(`${mod}+s`);
  await expect.poll(writes).toEqual(['as:Untitled.compositor.zip', 'as:Untitled.compositor.zip', 'to:Poster.compositor.zip']);
  await editor.press(`${mod}+Shift+s`);
  await expect.poll(async () => (await writes())[3]).toBe('as:Poster.compositor.zip');
});

test('a copy saved for Compositor for Mac (.comp, v7) reopens with the same layers, masks and adjustments', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('40');
  await page.getByTestId('heightInput').fill('30');
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'green.png', mimeType: 'image/png', buffer: solidPng(20, 20, [0, 200, 0, 255]) }]);
  await page.getByTestId('layer-row').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add Black Mask' }).click();
  await page.evaluate(() => (window as any).__editorForTests.session.addAdjustment('Exposure'));
  await page.getByTestId('adjustment-ok').click();
  const before = await manifest(page);
  await page.getByTestId('menu-File').click();
  await page.getByTestId('menu-save-comp').click();
  await expect.poll(() => page.evaluate(() => (window as any).__saved.length)).toBe(1);
  const saved = await page.evaluate(() => ({ name: (window as any).__saved[0].name }));
  expect(saved.name).toBe('Untitled.comp.zip');
  await page.evaluate(() => (window as any).__handle.openProject((window as any).__saved[0].blob));
  await expect(page.getByRole('tab')).toHaveCount(2);
  const after = await manifest(page);
  expect(after.layers.map((l: any) => [l.name, l.kind, !!l.mask, l.parameters?.kind ?? null]))
    .toEqual(before.layers.map((l: any) => [l.name, l.kind, !!l.mask, l.parameters?.kind ?? null]));
  expect(after.width).toBe(40);
});
