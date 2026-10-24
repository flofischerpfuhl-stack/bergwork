import { expect, test } from '@playwright/test';
import { importThroughMenu, manifest, mountForTest, solidPng } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });

const guides = (page: import('@playwright/test').Page) => page.evaluate(() =>
  ((window as any).__editorForTests.session.guides as { orientation: string; position: number }[]).map((g) => [g.orientation, g.position]));

test('rulers, guides dragged from the ruler, moved and dropped back, the New Guide dialog, and Align from the menu', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('400');
  await page.getByTestId('heightInput').fill('300');
  await page.getByTestId('createCanvas').click();
  await page.getByTestId('menu-View').click();
  await page.getByRole('menuitem', { name: 'Rulers' }).click();
  const pane = (await page.getByTestId('canvas-pane').boundingBox())!;
  const docPoint = (x: number, y: number) => page.evaluate(([vx, vy]) => {
    const s = (window as any).__editorForTests.session;
    return s.viewport.documentPoint({ x: vx, y: vy }, s.document);
  }, [x - pane.x, y - pane.y]);
  // Drag a horizontal guide out of the top ruler.
  await page.mouse.move(pane.x + pane.width / 2, pane.y + 8);
  await page.mouse.down();
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2, { steps: 6 });
  await page.mouse.up();
  const expectedY = Math.round((await docPoint(pane.x + pane.width / 2, pane.y + pane.height / 2)).y);
  expect(await guides(page)).toEqual([['horizontal', expectedY]]);
  // New Guide dialog: a vertical guide at 100 px.
  await page.getByTestId('menu-View').click();
  await page.getByRole('menuitem', { name: 'New Guide…' }).click();
  await page.getByRole('radio', { name: 'Vertical' }).click();
  await page.getByTestId('guide-position').fill('100');
  await page.getByTestId('guide-ok').click();
  expect(await guides(page)).toEqual([['horizontal', expectedY], ['vertical', 100]]);
  // The Move tool drags the vertical guide, then drops it back on the left ruler to delete it.
  await page.getByTestId('tool-move').click();
  const x100 = await page.evaluate(() => { const s = (window as any).__editorForTests.session; return s.viewport.viewPoint({ x: 100, y: 0 }, s.document).x; });
  await page.mouse.move(pane.x + x100, pane.y + pane.height / 2 + 40);
  await page.mouse.down();
  await page.mouse.move(pane.x + x100 + 60, pane.y + pane.height / 2 + 40, { steps: 5 });
  await page.mouse.up();
  const moved = (await guides(page))[1]![1] as number;
  expect(moved).toBeGreaterThan(100);
  const xMoved = await page.evaluate((p) => { const s = (window as any).__editorForTests.session; return s.viewport.viewPoint({ x: p, y: 0 }, s.document).x; }, moved);
  // Away from the crossing with the horizontal guide (there the nearer guide wins).
  await page.mouse.move(pane.x + xMoved, pane.y + pane.height / 2 + 40);
  await page.mouse.down();
  await page.mouse.move(pane.x + 6, pane.y + pane.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  expect(await guides(page)).toEqual([['horizontal', expectedY]]);
  // Undo brings the deleted guide back.
  await page.getByTestId('compositor-editor').press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  expect((await guides(page)).length).toBe(2);
  // Align two layers to their left edges through Layer › Align.
  await importThroughMenu(page, [{ name: 'a.png', mimeType: 'image/png', buffer: solidPng(40, 20, [255, 0, 0, 255]) }]);
  await importThroughMenu(page, [{ name: 'b.png', mimeType: 'image/png', buffer: solidPng(60, 30, [0, 0, 255, 255]) }]);
  await page.evaluate(() => {
    const s = (window as any).__editorForTests.session;
    const layers = s.document.layers.filter((l: any) => l.raster && l.name !== 'Layer 1');
    s.replaceDocument({ ...s.document, layers: s.document.layers.map((l: any) => l.id === layers[0].id ? { ...l, transform: { ...l.transform, origin: { x: 30, y: 40 } } } : l) });
    s.selectLayers(layers.map((l: any) => l.id), layers[0].id);
  });
  await page.getByTestId('menu-Layer').click();
  await page.getByRole('menuitem', { name: 'Align' }).hover();
  await page.getByRole('menuitem', { name: 'Left Edges' }).click();
  const xs = (await manifest(page)).layers.filter((l: any) => l.name === 'a' || l.name === 'b').map((l: any) => l.transform[4]);
  expect(new Set(xs).size).toBe(1);
});
