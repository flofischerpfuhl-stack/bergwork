import { expect, test, type Page } from '@playwright/test';
import { manifest, mountForTest } from './helpers';

/**
 * UI v0.2: the canvas fills the editor and the chrome floats over it. The canvas pane is the uncovered work area
 * (Fit, rulers, the welcome card); Tab and Shift+Tab hide the chrome as in Photoshop.
 */
test.use({ viewport: { width: 1440, height: 900 } });

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const box = async (page: Page, testId: string) => (await page.getByTestId(testId).boundingBox())!;
const zoom = (page: Page) => page.evaluate(() => (window as any).__editorForTests.session.viewport.zoom as number);
/** The fitted document in page coordinates. */
const documentBox = (page: Page) => page.evaluate(() => {
  const session = (window as any).__editorForTests.session;
  const pane = document.querySelector('[data-testid="canvas-pane"]')!.getBoundingClientRect();
  const rect = session.viewport.documentRect(session.document);
  return { x: pane.left + rect.x, y: pane.top + rect.y, width: rect.width, height: rect.height };
});

async function canvas(page: Page, width = 1600, height = 1000): Promise<void> {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill(String(width));
  await page.getByTestId('heightInput').fill(String(height));
  await page.getByTestId('createCanvas').click();
}

test('the canvas fills the editor under floating chrome; Fit keeps the document in the uncovered work area', async ({ page }) => {
  await canvas(page);
  const editor = await box(page, 'compositor-editor');
  const surface = await box(page, 'editor-canvas');
  expect(surface).toEqual(editor);
  const pane = await box(page, 'canvas-pane');
  const chrome = [await box(page, 'context-bar'), await box(page, 'layers-panel'), await box(page, 'status-bar'),
    (await page.getByRole('toolbar', { name: 'Tools' }).boundingBox())!, (await page.getByRole('toolbar', { name: 'Editor' }).boundingBox())!];
  for (const part of chrome) expect(overlaps(pane, part)).toBe(false);
  // Fit: the whole document shows inside the work area, not under the panels.
  await page.getByTestId('fit').click();
  const fitted = await documentBox(page);
  expect(fitted.x).toBeGreaterThanOrEqual(pane.x);
  expect(fitted.y).toBeGreaterThanOrEqual(pane.y);
  expect(fitted.x + fitted.width).toBeLessThanOrEqual(pane.x + pane.width + 0.5);
  expect(fitted.y + fitted.height).toBeLessThanOrEqual(pane.y + pane.height + 0.5);
});

test('Tab hides tools, options, panels and status bar and Fit uses the space; Shift+Tab hides only the panels', async ({ page }) => {
  await canvas(page);
  const editor = page.getByTestId('compositor-editor');
  const before = await zoom(page);
  const paneBefore = await box(page, 'canvas-pane');
  await editor.press('Tab');
  await expect(page.getByTestId('layers-panel')).toHaveCount(0);
  await expect(page.getByTestId('context-bar')).toHaveCount(0);
  await expect(page.getByTestId('status-bar')).toHaveCount(0);
  await expect(page.getByRole('toolbar', { name: 'Tools' })).toHaveCount(0);
  // Photoshop keeps the menu bar (and document tabs) in this mode.
  await expect(page.getByTestId('menu-bar')).toBeVisible();
  const paneHidden = await box(page, 'canvas-pane');
  expect(paneHidden.width).toBeGreaterThan(paneBefore.width);
  expect(paneHidden.height).toBeGreaterThan(paneBefore.height);
  // The view followed Fit, so it grows with the work area.
  await expect.poll(() => zoom(page)).toBeGreaterThan(before);
  await editor.press('Tab');
  await expect(page.getByTestId('layers-panel')).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Tools' })).toBeVisible();
  await expect.poll(() => zoom(page)).toBeCloseTo(before, 5);

  await editor.press('Shift+Tab');
  await expect(page.getByTestId('layers-panel')).toHaveCount(0);
  await expect(page.getByRole('toolbar', { name: 'Tools' })).toBeVisible();
  await expect(page.getByTestId('toggle-panels')).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('toggle-panels').click();
  await expect(page.getByTestId('layers-panel')).toBeVisible();
  await page.getByTestId('close-panels').click();
  await expect(page.getByTestId('layers-panel')).toHaveCount(0);
  // The View menu lists both, with their shortcuts.
  await page.getByTestId('menu-View').click();
  await page.getByTestId('menu-toggle-panels').click();
  await expect(page.getByTestId('layers-panel')).toBeVisible();
});

test('Tab inside the chrome still moves the keyboard focus', async ({ page }) => {
  await canvas(page, 200, 200);
  await page.getByTestId('tab-layers').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('layers-panel')).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('tab-history');
});

test('pointer input on floating chrome never reaches the canvas, and canvas strokes reach under the chrome', async ({ page }) => {
  await canvas(page, 200, 200);
  await page.getByTestId('tool-brush').click();
  // A brush drag across the empty part of the panel stack and the status bar paints nothing.
  const panel = await box(page, 'layers-panel');
  await page.mouse.move(panel.x + panel.width / 2, panel.y + panel.height - 120);
  await page.mouse.down();
  await page.mouse.move(panel.x + 20, panel.y + panel.height - 100, { steps: 5 });
  await page.mouse.up();
  const status = await box(page, 'status-bar');
  await page.mouse.move(status.x + status.width - 30, status.y + status.height / 2);
  await page.mouse.down();
  await page.mouse.move(status.x + status.width - 80, status.y + status.height / 2, { steps: 3 });
  await page.mouse.up();
  expect((await manifest(page)).layers[0].assetId ?? null).toBeNull();
  // The same drag on the canvas paints.
  const doc = await documentBox(page);
  await page.mouse.move(doc.x + doc.width * 0.3, doc.y + doc.height / 2);
  await page.mouse.down();
  await page.mouse.move(doc.x + doc.width * 0.7, doc.y + doc.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await manifest(page)).layers[0].assetId ?? null).not.toBeNull();
});

test('rulers sit at the edge of the work area, clear of the tool palette and options bar', async ({ page }) => {
  await canvas(page, 400, 300);
  await page.getByTestId('menu-View').click();
  await page.getByRole('menuitem', { name: 'Rulers' }).click();
  const pane = await box(page, 'canvas-pane');
  // Dragging out of the top ruler (just inside the work area) makes a horizontal guide.
  await page.mouse.move(pane.x + pane.width / 2, pane.y + 8);
  await page.mouse.down();
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2, { steps: 6 });
  await page.mouse.up();
  expect(await page.evaluate(() => (window as any).__editorForTests.session.guides.length)).toBe(1);
  const top = (await page.getByTestId('context-bar').boundingBox())!;
  const tools = (await page.getByRole('toolbar', { name: 'Tools' }).boundingBox())!;
  expect(pane.y).toBeGreaterThanOrEqual(top.y + top.height);
  expect(pane.x).toBeGreaterThanOrEqual(tools.x + tools.width);
});

test.describe('phone layout', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the work area lies between the top bars and the tool strip; the welcome card fits the screen', async ({ page }) => {
    await mountForTest(page, { locale: 'de' });
    const card = (await page.getByTestId('createCanvas').locator('xpath=ancestor::*[contains(@class, "sheetCard")][1]').boundingBox())!;
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width).toBeLessThanOrEqual(390);
    await page.getByTestId('createCanvas').tap();
    const pane = await box(page, 'canvas-pane');
    const strip = (await page.getByRole('toolbar', { name: 'Werkzeuge' }).boundingBox())!;
    const options = await box(page, 'context-bar');
    expect(pane.y).toBeGreaterThanOrEqual(options.y + options.height);
    expect(pane.y + pane.height).toBeLessThanOrEqual(strip.y);
    expect(await box(page, 'editor-canvas')).toEqual(await box(page, 'compositor-editor'));
  });
});
