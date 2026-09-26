import { expect, test, type Locator, type Page } from '@playwright/test';
import { mountForTest } from './helpers';

type Box = { x: number; y: number; width: number; height: number };

async function newCanvas(page: Page): Promise<void> {
  await page.getByTestId('widthInput').fill('640');
  await page.getByTestId('heightInput').fill('480');
  await page.getByTestId('createCanvas').click();
}

async function expectStableInsideEditor(page: Page, popover: Locator): Promise<void> {
  await expect(popover).toBeVisible();
  const editor = (await page.getByTestId('compositor-editor').boundingBox())!;
  const samples = await popover.evaluate(async (element) => {
    const boxes: Box[] = [];
    for (let i = 0; i < 4; i++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const rect = element.getBoundingClientRect();
      boxes.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { boxes, receivesPointer: !!hit && element.contains(hit) };
  });
  for (const box of samples.boxes) {
    expect(box.x).toBeGreaterThanOrEqual(editor.x + 7);
    expect(box.y).toBeGreaterThanOrEqual(editor.y + 7);
    expect(box.x + box.width).toBeLessThanOrEqual(editor.x + editor.width - 7);
    expect(box.y + box.height).toBeLessThanOrEqual(editor.y + editor.height - 7);
  }
  expect(samples.boxes.slice(1)).toEqual([samples.boxes[0], samples.boxes[0], samples.boxes[0]]);
  expect(samples.receivesPointer).toBe(true);
}

test.describe('editor-local overlays', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('menus and brush, type and shape popovers stay stable inside an offset editor mount', async ({ page }) => {
    await mountForTest(page);
    await page.evaluate(() => {
      const host = document.getElementById('root')!;
      host.style.cssText = 'position:absolute;left:24px;right:20px;top:38px;bottom:18px';
    });
    await newCanvas(page);

    await page.getByTestId('menu-File').click();
    await expectStableInsideEditor(page, page.locator('[data-menu-popup]').first());
    await page.keyboard.press('Escape');

    await page.getByTestId('tool-brush').click();
    await page.getByTestId('brush-preset-button').click();
    const brushes = page.getByTestId('brush-presets');
    await expectStableInsideEditor(page, brushes);
    await brushes.getByTestId('brush-presets-search').fill('round');
    await expect(brushes.getByTestId('brush-preset').first()).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByTestId('tool-text').click();
    await expect(page.locator('[data-testid="text-bar"][data-engine="ready"]')).toBeVisible({ timeout: 90_000 });
    await page.getByTestId('font-family').click();
    const fonts = page.getByTestId('font-list');
    await expectStableInsideEditor(page, fonts);
    await fonts.getByTestId('font-search').fill('Noto');
    await page.keyboard.press('Escape');
    await page.getByTestId('text-panel-toggle').click();
    await expectStableInsideEditor(page, page.getByTestId('text-panel'));
    await page.keyboard.press('Escape');

    await page.getByTestId('tool-shape').click();
    await page.getByTestId('vector-fill').click();
    await expectStableInsideEditor(page, page.getByTestId('vector-fill-popover'));
    await page.keyboard.press('Escape');
    await page.getByTestId('vector-stroke').click();
    await expectStableInsideEditor(page, page.getByTestId('vector-stroke-popover'));
    await page.keyboard.press('Escape');
    await page.getByTestId('vector-stroke-options').click();
    await expectStableInsideEditor(page, page.getByTestId('vector-stroke-popover'));
    await page.keyboard.press('Escape');
  });

  for (const width of [1201, 1280, 1440]) {
    test(`the wide colour picker stays clear of the tool palette at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mountForTest(page);
      await newCanvas(page);
      await page.getByTestId('tool-brush').click();
      await page.getByRole('button', { name: 'Foreground color' }).first().click();
      const picker = (await page.getByTestId('color-picker').boundingBox())!;
      const tools = (await page.getByRole('toolbar', { name: 'Tools' }).boundingBox())!;
      expect(picker.x).toBeGreaterThanOrEqual(tools.x + tools.width);
      expect(picker.x + picker.width).toBeLessThanOrEqual(width);
    });
  }
});

test.describe('tablet status bar', () => {
  test.use({ viewport: { width: 768, height: 1024 }, hasTouch: true });

  test('keeps both document facts visible while dropping the optional tool hint', async ({ page }) => {
    await mountForTest(page);
    await newCanvas(page);
    const status = (await page.getByTestId('status-bar').boundingBox())!;
    const facts = page.getByTestId('status-facts');
    const factsBox = (await facts.boundingBox())!;
    expect(factsBox.x).toBeGreaterThanOrEqual(status.x);
    expect(factsBox.x + factsBox.width).toBeLessThanOrEqual(status.x + status.width);
    await expect(facts).toContainText('640 × 480 px');
    await expect(facts).toContainText('sRGB · Transparent');
    expect(await page.getByTestId('status-bar').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
});
