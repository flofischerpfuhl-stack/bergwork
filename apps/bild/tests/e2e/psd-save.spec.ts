import { expect, test } from '@playwright/test';
import { importThroughMenu, mountForTest, solidPng } from './helpers';

test('File > Save As writes a layered Photoshop document while Export As remains image-only', async ({ page }) => {
  await mountForTest(page, { fileTargets: true });
  await page.getByTestId('widthInput').fill('3');
  await page.getByTestId('heightInput').fill('2');
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'client.png', mimeType: 'image/png', buffer: solidPng(3, 2, [210, 40, 20, 255]) }]);
  await expect(page.getByTestId('layerCount')).toHaveText('2');
  await page.evaluate(() => { (window as any).__pickerAnswer = 'Client edit.psd'; });

  const editor = page.getByTestId('compositor-editor');
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await editor.press(`${mod}+Shift+s`);
  await expect.poll(() => page.evaluate(() => (window as any).__targetWrites.at(-1)?.name)).toBe('Client edit.psd');

  const result = await page.evaluate(async () => {
    const write = (window as any).__targetWrites.at(-1);
    const bytes = new Uint8Array(await (write.blob as Blob).arrayBuffer());
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { readPsdDocument } = await load('/src/io/psd/index.ts');
    const { cpuCompositeRegion } = await load('/src/render/cpuRender.ts');
    const reopened = readPsdDocument(bytes);
    return { signature: new TextDecoder().decode(bytes.subarray(0, 4)), version: new DataView(bytes.buffer).getUint16(4),
      names: reopened.document.layers.map((layer: any) => layer.name),
      pixels: Array.from(cpuCompositeRegion(reopened.document, { x: 0, y: 0, width: 3, height: 2 })),
      errors: (window as any).__errors };
  });
  expect(result.signature).toBe('8BPS');
  expect(result.version).toBe(1);
  expect(result.names).toContain('client');
  expect(result.pixels).toEqual(Array(6).fill([210, 40, 20, 255]).flat());
  expect(result.errors).toEqual([]);

  await page.getByTestId('menu-File').click();
  await page.getByTestId('menu-export').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await expect(page.getByTestId('export-dialog')).not.toContainText('Photoshop');
  await expect(page.getByTestId('export-dialog')).not.toContainText('PSD');
});
