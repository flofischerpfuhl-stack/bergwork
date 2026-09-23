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

test('pasting an external image centres it on a new layer', async ({ page }) => {
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
