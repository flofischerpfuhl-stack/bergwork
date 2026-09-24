import { expect, test } from '@playwright/test';
import { mountForTest, solidPng } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.setTimeout(180_000);

async function place(page: import('@playwright/test').Page, item: 'Place Embedded…' | 'Replace Contents…', file: {
  name: string; mimeType: string; buffer: Buffer;
}): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId(item === 'Place Embedded…' ? 'menu-File' : 'menu-Layer').click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
  await (await chooser).setFiles(file);
}

test('embedded workflow: menu placement, target-resolution SVG, Replace Contents, shared Edit Contents, and round trip', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('96');
  await page.getByTestId('heightInput').fill('72');
  await page.getByTestId('createCanvas').click();

  const png = { name: 'pixel-logo.png', mimeType: 'image/png', buffer: solidPng(8, 8, [255, 0, 0, 255]) };
  const svg = { name: 'vector-logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8"><rect x="2" y="1" width="4" height="6" fill="#00ff00"/></svg>') };
  await place(page, 'Place Embedded…', png);
  await expect(page.getByTestId('layer-row').first()).toContainText('pixel-logo.png');
  await place(page, 'Place Embedded…', svg);
  await expect(page.getByTestId('layer-row').first()).toContainText('vector-logo.svg');

  const before = await page.evaluate(() => {
    const session = (window as any).__editorForTests.session;
    const layers = session.document.layers.map((layer: any) => layer.kind === 'embedded'
      ? { ...layer, transform: { ...layer.transform, size: { width: 32, height: 32 } } } : layer);
    const svgLayer = layers.find((layer: any) => layer.name === 'vector-logo.svg');
    svgLayer.effects = [{ kind: 'dropShadow', schemaVersion: 1, enabled: true, opacity: 0.5, angle: 120,
      distance: 3, blur: 2, color: { red: 0, green: 0, blue: 0 } }];
    session.replaceDocument({ ...session.document, layers });
    session.notify('document');
    return { transform: svgLayer.transform, effects: svgLayer.effects };
  });
  // Export is the production render-preparation path and waits for the lazy SVG engine.
  await page.evaluate(() => (window as any).__handle.exportImage({ format: 'png' }));
  const grids = await page.evaluate(() => {
    const session = (window as any).__editorForTests.session;
    const pngLayer = session.document.layers.find((layer: any) => layer.name === 'pixel-logo.png');
    const svgLayer = session.document.layers.find((layer: any) => layer.name === 'vector-logo.svg');
    const vector = session.displayedRaster(svgLayer), raster = session.displayedRaster(pngLayer);
    const partial = Array.from({ length: vector.width }, (_, x) => vector.pixel(x, Math.floor(vector.height / 2))[3])
      .filter((alpha: number) => alpha > 0 && alpha < 255).length;
    return { png: [raster.width, raster.height], svg: [vector.width, vector.height], partial };
  });
  expect(grids.png).toEqual([8, 8]);
  expect(grids.svg[0]).toBeGreaterThanOrEqual(32);
  expect(grids.svg[1]).toBe(grids.svg[0]);
  expect(grids.partial).toBeLessThanOrEqual(2);

  const replacement = { name: 'replacement.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><circle cx="4" cy="4" r="3" fill="#0000ff"/></svg>') };
  await place(page, 'Replace Contents…', replacement);
  const replaced = await page.evaluate(() => {
    const layer = (window as any).__editorForTests.session.activeLayer;
    return { transform: layer.transform, effects: layer.effects, sourceName: layer.content.sourceName };
  });
  expect(replaced).toEqual({ ...before, sourceName: 'replacement.svg' });

  // Select the image instance, duplicate it (same resource), then Edit Contents through the menu.
  await page.getByTestId('layer-row').filter({ hasText: 'pixel-logo.png' }).click();
  await page.evaluate(() => (window as any).__editorForTests.session.duplicateActiveLayer());
  await page.getByTestId('menu-Layer').click();
  await page.getByRole('menuitem', { name: 'Edit Contents', exact: true }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).__editorForTests.workspace.tabs.length)).toBe(2);
  await page.evaluate(async () => {
    const load = (url: string): Promise<any> => import(/* @vite-ignore */ url);
    const { Raster } = await load('/src/core/raster.ts');
    const session = (window as any).__editorForTests.session;
    const pixels = new Uint8Array(session.document.width * session.document.height * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) pixels.set([0, 0, 255, 255], offset);
    session.replaceLayerPixels(session.activeLayerId, Raster.fromPixels(session.document.width, session.document.height, 4, pixels), 'Paint Contents');
  });
  await page.getByTestId('menu-File').click();
  await page.getByTestId('menu-save').click();
  await expect.poll(async () => page.evaluate(() => {
    const controller = (window as any).__editorForTests;
    const parent = controller.workspace.tabs.find((tab: any) => tab.session.document?.layers.filter((layer: any) => layer.kind === 'embedded').length === 3);
    return parent?.session.document.layers.filter((layer: any) => layer.name.startsWith('pixel-logo')).map((layer: any) => layer.raster.pixel(0, 0));
  })).toEqual([[0, 0, 255, 255], [0, 0, 255, 255]]);

  // The parent archive reopens with all three embedded layers and source resources intact.
  const roundTrip = await page.evaluate(async () => {
    const controller = (window as any).__editorForTests;
    const parent = controller.workspace.tabs.find((tab: any) => tab.session.document?.layers.filter((layer: any) => layer.kind === 'embedded').length === 3);
    controller.workspace.select(parent.id);
    const blob = await (window as any).__handle.saveProject();
    await (window as any).__handle.openProject(blob);
    const document = controller.session.document;
    return { layers: document.layers.filter((layer: any) => layer.kind === 'embedded').length,
      resources: document.resources.filter((resource: any) => resource.role === 'embedded').length };
  });
  expect(roundTrip).toEqual({ layers: 3, resources: 2 });
});
