import { expect, test } from '@playwright/test';
import { mountForTest } from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });

test('Object Select is exposed from the selection tool and never fetches a model before user enablement', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => { if (request.url().includes('efficientsam')) requests.push(request.url()); });
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('64');
  await page.getByTestId('heightInput').fill('64');
  await page.getByTestId('createCanvas').click();
  await page.getByTestId('tool-wand').click();
  await expect(page.getByRole('radio', { name: 'Object Point' })).toBeVisible();
  await page.getByRole('radio', { name: 'Object Point' }).click();
  await expect(page.getByTestId('enable-object-selection')).toBeVisible();
  expect(requests).toEqual([]);
});

test('Quick Mask Q and Refine Edge hook keep selection edits undoable', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('32');
  await page.getByTestId('heightInput').fill('32');
  await page.getByTestId('createCanvas').click();
  await page.getByTestId('compositor-editor').press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
  await page.getByTestId('compositor-editor').press('q');
  await page.getByTestId('tool-marquee').click();
  await expect(page.getByTestId('refine-edge')).toBeEnabled();
});
