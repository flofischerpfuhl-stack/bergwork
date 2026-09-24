import { expect, test } from '@playwright/test';
import { exportedPixels, importThroughMenu, manifest, mountForTest, solidPng } from './helpers';

test.describe('desktop workflows', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('new canvas, import through the file chooser, move by dragging, undo with the keyboard', async ({ page }) => {
    await mountForTest(page);
    // Welcome sheet → Create canvas.
    await page.getByTestId('widthInput').fill('200');
    await page.getByTestId('heightInput').fill('100');
    await page.getByTestId('createCanvas').click();
    await expect(page.getByTestId('canvasDimensions')).toHaveText('200 × 100 px');
    await expect(page.getByTestId('layerCount')).toHaveText('1');

    await importThroughMenu(page, [{ name: 'red.png', mimeType: 'image/png', buffer: solidPng(40, 20, [255, 0, 0, 255]) }]);
    await expect(page.getByTestId('layerCount')).toHaveText('2');
    await expect(page.getByTestId('layer-row').first()).toContainText('red');
    let m = await manifest(page);
    expect(m.layers[1].transform).toEqual([1, 0, 0, 1, 80, 40]);

    // Drag the layer 50 document px to the right with the Move tool.
    const canvas = page.getByTestId('canvas-pane');
    const box = (await canvas.boundingBox())!;
    const zoomText = await page.getByTestId('zoomStatus').textContent();
    const pointsPerPixel = parseFloat(zoomText!) / 100 / (await page.evaluate(() => devicePixelRatio));
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + 25 * pointsPerPixel, centre.y, { steps: 4 });
    await page.mouse.move(centre.x + 50 * pointsPerPixel, centre.y, { steps: 4 });
    await page.mouse.up();
    m = await manifest(page);
    // Snapping may pull it to the canvas centre line or edges; it moved and landed on whole pixels.
    const movedX = m.layers[1].transform[4];
    expect(movedX).toBeGreaterThan(110);
    expect(Number.isInteger(movedX)).toBe(true);
    await expect(page.getByTestId('transformX')).toHaveValue(String(movedX));

    // Pixels follow the move in the export.
    const pixels = await exportedPixels(page);
    const at = (x: number, y: number) => pixels.data.slice((y * pixels.width + x) * 4, (y * pixels.width + x) * 4 + 4);
    expect(at(movedX + 5, 45)).toEqual([255, 0, 0, 255]);
    expect(at(85, 45)[3]).toBe(0);

    await page.getByTestId('compositor-editor').press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    m = await manifest(page);
    expect(m.layers[1].transform[4]).toBe(80);
  });

  test('layers panel: blank layer, rename, hide, group, clipping, opacity, delete, all undoable', async ({ page }) => {
    await mountForTest(page);
    await page.getByTestId('createCanvas').click();
    await importThroughMenu(page, [
      { name: 'base.png', mimeType: 'image/png', buffer: solidPng(8, 8, [0, 0, 255, 255]) },
      { name: 'top.png', mimeType: 'image/png', buffer: solidPng(8, 8, [0, 255, 0, 255]) },
    ]);
    await expect(page.getByTestId('layerCount')).toHaveText('3');
    const rows = page.getByTestId('layer-row');
    await expect(rows.nth(0)).toContainText('top');

    // Rename by double-click.
    await rows.nth(0).locator('span', { hasText: 'top' }).dblclick();
    const input = page.getByLabel('Layer name');
    await input.fill('Overlay');
    await input.press('Enter');
    await expect(rows.nth(0)).toContainText('Overlay');

    // Clipping mask via the Layer menu.
    await page.getByTestId('menu-Layer').click();
    await page.getByRole('menuitem', { name: /Create Clipping Mask/ }).click();
    let m = await manifest(page);
    expect(m.layers.find((l: any) => l.name === 'Overlay').clippedToBelow).toBe(true);
    await expect(rows.nth(0)).toContainText('Clipped to base');

    // Opacity through the numeric field.
    await page.getByTestId('opacity-field').fill('40');
    await page.getByTestId('opacity-field').press('Enter');
    m = await manifest(page);
    expect(m.layers.find((l: any) => l.name === 'Overlay').opacity).toBeCloseTo(0.4);

    // Hide via the eye.
    await rows.nth(1).getByTestId('layer-eye').click();
    m = await manifest(page);
    expect(m.layers.find((l: any) => l.name === 'base').visible).toBe(false);

    // Group selected layers (⌘/Ctrl-click to multi-select, then the footer folder button).
    await rows.nth(0).click();
    await rows.nth(1).click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
    await page.getByRole('button', { name: 'New folder' }).click();
    m = await manifest(page);
    const folder = m.layers.find((l: any) => l.kind === 'group');
    expect(folder).toBeTruthy();
    expect(m.layers.filter((l: any) => l.parentId === folder.id).map((l: any) => l.name).sort()).toEqual(['Overlay', 'base']);

    // Undo the grouping restores the flat stack.
    await page.getByTestId('compositor-editor').press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    m = await manifest(page);
    expect(m.layers.some((l: any) => l.kind === 'group')).toBe(false);

    // New blank layer from the footer, then delete it with the trash button.
    await page.getByTestId('addBlankLayer').click();
    await expect(page.getByTestId('layerCount')).toHaveText('4');
    await page.getByTestId('deleteLayer').click();
    await expect(page.getByTestId('layerCount')).toHaveText('3');
  });

  test('crop tool and Canvas Size change the document through real controls', async ({ page }) => {
    await mountForTest(page);
    await page.getByTestId('widthInput').fill('300');
    await page.getByTestId('heightInput').fill('200');
    await page.getByTestId('createCanvas').click();
    await importThroughMenu(page, [{ name: 'img.png', mimeType: 'image/png', buffer: solidPng(300, 200, [10, 200, 30, 255]) }]);
    await page.getByTestId('tool-crop').click();
    const canvas = page.getByTestId('canvas-pane');
    const box = (await canvas.boundingBox())!;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    // Draw a new crop frame across part of the canvas and apply it.
    await page.mouse.move(cx - 60, cy - 40);
    await page.mouse.down();
    await page.mouse.move(cx + 40, cy + 30, { steps: 5 });
    await page.mouse.up();
    await page.getByTestId('applyCrop').click();
    await expect(page.getByTestId('canvasDimensions')).not.toHaveText('300 × 200 px');
    const cropped = await manifest(page);
    expect(cropped.width).toBeLessThan(300);
    expect(cropped.height).toBeLessThan(200);

    await page.getByTestId('menu-Image').click();
    await page.getByRole('menuitem', { name: /Canvas Size/ }).click();
    await page.getByTestId('canvasSizeWidth').fill('500');
    await page.getByTestId('canvasSizeHeight').fill('400');
    await page.getByTestId('canvasSizeOK').click();
    await expect(page.getByTestId('canvasDimensions')).toHaveText('500 × 400 px');
    const resized = await manifest(page);
    expect([resized.width, resized.height]).toEqual([500, 400]);
  });

  test('saving downloads an archive that reopens identically', async ({ page }) => {
    await mountForTest(page);
    await page.getByTestId('createCanvas').click();
    await importThroughMenu(page, [{ name: 'a.png', mimeType: 'image/png', buffer: solidPng(5, 7, [200, 100, 50, 128]) }]);
    await page.getByTestId('menu-File').click();
    await page.getByTestId('menu-save').click();
    await expect.poll(() => page.evaluate(() => (window as any).__saved.length)).toBe(1);
    await expect(page.getByRole('tablist', { name: 'Project tabs' }).getByRole('tab', { selected: true }).locator('span')).toHaveCount(0);
    const result = await page.evaluate(async () => {
      const w = window as any;
      const saved = w.__saved[0];
      const before = JSON.parse(JSON.stringify(w.__handle.getManifest()));
      await w.__handle.openProject(saved.blob);
      return { name: saved.name, type: saved.type, before, after: JSON.parse(JSON.stringify(w.__handle.getManifest())) };
    });
    expect(result.name).toMatch(/\.fwimg$/);
    expect(result.after).toEqual(result.before);
  });
});

test.describe('phone layout', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('tools stay reachable, layers open as a sheet, touch targets are large', async ({ page }) => {
    await mountForTest(page, { locale: 'de' });
    await page.getByTestId('createCanvas').click();
    const tool = page.getByTestId('tool-hand');
    const size = (await tool.boundingBox())!;
    expect(size.width).toBeGreaterThanOrEqual(44);
    expect(size.height).toBeGreaterThanOrEqual(44);
    await tool.tap();
    await expect(page.getByTestId('context-bar')).toContainText('Verschieben');
    await page.getByTestId('open-layers').tap();
    await expect(page.getByTestId('layers-sheet')).toBeVisible();
    await expect(page.getByTestId('layers-sheet')).toContainText('Ebenen');
    await page.getByTestId('addBlankLayer').tap();
    await expect(page.getByTestId('layerCount')).toHaveText('2');
    const more = page.getByRole('button', { name: /Mehr: Ebene 2/ });
    expect(((await more.boundingBox())!).width).toBeGreaterThanOrEqual(44);
    await more.tap();
    await page.getByRole('menuitem', { name: 'Ebene duplizieren' }).tap();
    await expect(page.getByTestId('layerCount')).toHaveText('3');
  });
});

test('dragging a crop frame inside the canvas redraws only the overlay', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('400');
  await page.getByTestId('heightInput').fill('300');
  await page.getByTestId('createCanvas').click();
  await page.getByTestId('tool-crop').click();
  await page.evaluate(() => {
    const w = window as any;
    const gpu = w.__editorForTests.canvasView.gpu;
    const original = gpu.composite.bind(gpu);
    w.__composites = 0;
    gpu.composite = (...args: unknown[]) => { w.__composites++; return original(...args); };
  });
  const pane = (await page.getByTestId('canvas-pane').boundingBox())!;
  const zoom = await page.evaluate(() => (window as any).__editorForTests.session.viewport.pointsPerPixel);
  const origin = { x: pane.x + pane.width / 2 - 200 * zoom, y: pane.y + pane.height / 2 - 150 * zoom };
  // Drag the right edge handle inward in several steps.
  await page.mouse.move(origin.x + 400 * zoom, origin.y + 150 * zoom);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(origin.x + (400 - i * 10) * zoom, origin.y + 150 * zoom); await page.waitForTimeout(30); }
  await page.mouse.up();
  const crop = await page.evaluate(() => (window as any).__editorForTests.session.cropRect);
  expect(crop.width).toBeLessThan(330);
  expect(await page.evaluate(() => (window as any).__composites)).toBeLessThanOrEqual(2);
});
