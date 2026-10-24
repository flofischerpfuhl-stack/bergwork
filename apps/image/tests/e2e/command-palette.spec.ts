import { expect, test } from '@playwright/test';
import { importThroughMenu, manifest, mountForTest, solidPng } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test('Search Commands finds a menu command by abbreviation and runs it', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'red.png', mimeType: 'image/png', buffer: solidPng(40, 30, [220, 0, 0, 255]) }]);
  await page.getByTestId('compositor-editor').press(`${mod}+f`);
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await expect(page.getByTestId('command-palette-input')).toBeFocused();
  await page.getByTestId('command-palette-input').fill('new blank layer');
  await expect(palette.getByRole('option').first()).toContainText('Layer › New Blank Layer');
  await page.getByTestId('command-palette-input').press('Enter');
  await expect(palette).toBeHidden();
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(3);
});

test('Search Commands lists tools, greys disabled commands and closes with Escape', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('createCanvas').click();
  await page.getByTestId('menu-View').click();
  await page.getByTestId('menu-search-commands').click();
  const input = page.getByTestId('command-palette-input');
  await input.fill('eraser');
  await expect(page.getByTestId('command-palette').getByRole('option').first()).toContainText('Tool › Eraser');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.tool)).toBe('brush');
  await page.getByTestId('compositor-editor').press(`${mod}+f`);
  await input.fill('redo');
  await expect(page.getByRole('option', { name: /Edit › Redo/ })).toHaveAttribute('aria-disabled', 'true');
  await input.press('Escape');
  await expect(page.getByTestId('command-palette')).toBeHidden();
});

test('Search Commands follows the German UI', async ({ page }) => {
  await mountForTest(page, { locale: 'de' });
  await page.getByTestId('createCanvas').click();
  await page.getByTestId('compositor-editor').press(`${mod}+f`);
  await page.getByTestId('command-palette-input').fill('gauß');
  await expect(page.getByTestId('command-palette').getByRole('option').first()).toContainText('Gauß');
});
