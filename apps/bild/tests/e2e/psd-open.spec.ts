import path from 'node:path';
import { expect, test } from '@playwright/test';

const PSD = path.resolve('tests/fixtures/psd/corpus/1layer.psd');

test('opens a corpus PSD through Open as a layered document', async ({ page }) => {
  await page.goto('/');
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open project' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(PSD);
  await page.waitForFunction(() => (window as any).__editorForTests?.session.document?.width === 101);
  const opened = await page.evaluate(() => {
    const session = (window as any).__editorForTests.session;
    const document = session.document;
    const layer = document.layers.find((candidate: any) => candidate.raster);
    return { width: document.width, height: document.height, layers: document.layers.map((candidate: any) => candidate.name),
      pixel: layer.raster.pixel(0, 0), projectName: session.projectName };
  });
  expect(opened).toEqual({ width: 101, height: 55, layers: ['Фон'], pixel: [255, 255, 255, 255], projectName: '1layer' });
});
