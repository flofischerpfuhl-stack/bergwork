import { expect, test } from '@playwright/test';
import { mountForTest } from './helpers';

// Numbers follow the editor's UI language, not the browser's (the test browser runs en-US).
test('sizes in the status bar and layer rows use the editor language', async ({ page }) => {
  await mountForTest(page, { locale: 'de' });
  await page.getByTestId('widthInput').fill('2000');
  await page.getByTestId('heightInput').fill('1000');
  await page.getByTestId('createCanvas').click();
  await expect(page.getByTestId('canvasDimensions')).toHaveText('2.000 × 1.000 px');
  await expect(page.getByTestId('layer-row').first()).toContainText('2.000 × 1.000 px');
});
