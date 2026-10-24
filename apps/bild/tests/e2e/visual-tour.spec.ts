import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { importThroughMenu, mountForTest } from './helpers';

/**
 * Screenshots of real editing states for the final visual review (not pixel baselines). Uses the
 * official example photographs from the reference library when present.
 */
const references = '/home/oem/Dokumente/003_Projekte/17_fernwork/research/compositor-port/references/official-site';
const out = path.resolve('artifacts/screenshots');

test('visual tour: layers, selection, transform, painting', async ({ page }) => {
  test.skip(!fs.existsSync(path.join(references, 'example1.png')), 'reference photographs not available on this machine');
  fs.mkdirSync(out, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('1600');
  await page.getByTestId('heightInput').fill('1000');
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [
    { name: 'example1.png', mimeType: 'image/png', buffer: fs.readFileSync(path.join(references, 'example1.png')) },
    { name: 'example2.png', mimeType: 'image/png', buffer: fs.readFileSync(path.join(references, 'example2.png')) },
  ]);
  await expect(page.getByTestId('layerCount')).toHaveText('3');
  await page.getByTestId('blend-mode').click();
  await page.getByRole('menuitem', { name: 'Multiply' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 'tour-desktop-layers.png') });

  // Transform handles on the top layer.
  const pane = (await page.getByTestId('canvas-pane').boundingBox())!;
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await page.mouse.down();
  await page.mouse.move(pane.x + pane.width / 2 + 60, pane.y + pane.height / 2 + 30, { steps: 5 });
  await page.mouse.up();
  await page.screenshot({ path: path.join(out, 'tour-desktop-transform.png') });

  // Elliptical marquee.
  await page.getByTestId('tool-marquee').click();
  await page.getByRole('radio', { name: 'Ellipse' }).click();
  await page.mouse.move(pane.x + 300, pane.y + 200);
  await page.mouse.down();
  await page.mouse.move(pane.x + 600, pane.y + 450, { steps: 5 });
  await page.mouse.up();
  await page.screenshot({ path: path.join(out, 'tour-desktop-selection.png') });

  // Brush cursor over the canvas.
  await page.getByTestId('tool-brush').click();
  await page.mouse.move(pane.x + 500, pane.y + 300);
  await page.screenshot({ path: path.join(out, 'tour-desktop-brush.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 'tour-phone-brush.png') });
  await page.getByTestId('open-layers').click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(out, 'tour-phone-layers-sheet.png') });
});

test('visual tour: adjustment panels, color picker, filters, German UI', async ({ page }) => {
  test.skip(!fs.existsSync(path.join(references, 'example1.png')), 'reference photographs not available on this machine');
  fs.mkdirSync(out, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('1600');
  await page.getByTestId('heightInput').fill('1000');
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'example1.png', mimeType: 'image/png', buffer: fs.readFileSync(path.join(references, 'example1.png')) }]);
  const editor = page.getByTestId('compositor-editor');
  await editor.press(process.platform === 'darwin' ? 'Meta+l' : 'Control+l');
  await expect(page.getByText('Loading histogram…')).toHaveCount(0, { timeout: 15_000 });
  await page.getByTestId('levelsInputblack').fill('30');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, 'tour-desktop-levels.png') });
  await page.getByTestId('adjustment-cancel').click();
  await page.evaluate(() => (window as any).__editorForTests.session.addAdjustment('Hue/Saturation'));
  await page.getByTestId('hueRange').selectOption('Reds');
  await page.getByTestId('hueHue').fill('60');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(out, 'tour-desktop-hue-adjustment-layer.png') });
  await page.getByTestId('adjustment-ok').click();
  await page.getByRole('button', { name: 'Foreground color' }).first().click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 'tour-desktop-color-picker.png') });
  await page.getByTestId('color-cancel').click();
  await page.getByTestId('layer-row').nth(1).click();
  await page.getByTestId('menu-Filter').click();
  await page.getByRole('menuitem', { name: 'Gaussian Blur…' }).click();
  await page.getByTestId('blurRadius').fill('12');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, 'tour-desktop-gaussian-blur.png') });
  await page.getByTestId('adjustment-cancel').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await editor.press(process.platform === 'darwin' ? 'Meta+u' : 'Control+u');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(out, 'tour-phone-hue-panel.png') });
  await page.getByTestId('adjustment-cancel').click();
  await mountForTest(page, { locale: 'de' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, 'tour-desktop-german-start.png') });
});
