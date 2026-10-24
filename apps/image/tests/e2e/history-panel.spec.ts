import { expect, test } from '@playwright/test';
import { manifest, mountForTest } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });

/** Reads the manifest of the project archive the editor produces, straight from the ZIP. */
async function savedManifest(page: import('@playwright/test').Page): Promise<any> {
  return page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { unzipSync } = await load('/node_modules/.vite/deps/fflate.js').catch(() => load('fflate'));
    const blob: Blob = await (window as any).__handle.saveProject();
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    return JSON.parse(new TextDecoder().decode(files['manifest.json']));
  });
}

test('the History panel jumps between states, dims undone steps, and its setting decides whether history is saved', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('64');
  await page.getByTestId('heightInput').fill('48');
  await page.getByTestId('createCanvas').click();
  for (let i = 0; i < 3; i++) await page.getByTestId('addBlankLayer').click();
  await expect(page.getByTestId('layerCount')).toHaveText('4');
  await page.getByTestId('tab-history').click();
  const steps = page.getByTestId('history-step');
  const count = await steps.count();
  expect(count).toBeGreaterThanOrEqual(4);
  await expect(steps.nth(count - 1)).toHaveAttribute('aria-current', 'step');
  // Back two steps: two layers fewer, the last two rows dimmed (not current).
  await steps.nth(count - 3).click();
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(2);
  await expect(steps.nth(count - 3)).toHaveAttribute('aria-current', 'step');
  await expect(steps).toHaveCount(count);
  // Forward again to the last state.
  await steps.nth(count - 1).click();
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(4);
  // History is saved with the project by default…
  expect((await savedManifest(page)).history?.commands?.length ?? 0).toBeGreaterThanOrEqual(3);
  // …and not when the setting is off.
  await page.getByTestId('save-history').uncheck();
  expect((await savedManifest(page)).history?.commands?.length ?? 0).toBe(0);
  await page.getByTestId('save-history').check();
  await page.getByTestId('tab-layers').click();
  await expect(page.getByTestId('layers-list')).toBeVisible();
});
