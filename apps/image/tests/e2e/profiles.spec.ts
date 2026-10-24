import { expect, test } from '@playwright/test';
import { solidPng } from './helpers';

async function mount(page: import('@playwright/test').Page, profile: 'pro' | 'lite'): Promise<void> {
  await page.goto('/?harness=ui');
  await page.evaluate(async (selected) => {
    document.body.style.cssText = 'margin:0;width:100vw;height:100vh;overflow:hidden';
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { mountEditor } = await load('/src/index.ts');
    const { createBrowserHost } = await load('/src/platform/browserHost.ts');
    const host = createBrowserHost();
    (window as any).__profileHandle = await mountEditor(document.getElementById('root')!, { host, profile: selected, locale: 'en' });
  }, profile);
}

test('the same mount selects Lite or Pro and exposes only their configured UI', async ({ page }) => {
  const png = solidPng(2, 2, [220, 20, 20, 255]).toString('base64');
  for (const profile of ['lite', 'pro'] as const) {
    await mount(page, profile);
    await expect(page.locator(`[data-editor-profile="${profile}"]`)).toBeVisible();
    await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
      await (window as any).__profileHandle.importImage(new Blob([bytes], { type: 'image/png' }), 'sample.png');
      (window as any).__editorForTests.showDialog(null);
    }, png);
    await page.getByTestId('menu-Filter').click();
    await page.getByRole('menuitem', { name: /Remove Background/ }).click();
    await expect(page.getByTestId('remove-background-panel')).toBeVisible();
    // PRODUCT-PLAN 6.2 marks background removal PLQ, so both local models remain visible.
    await expect(page.getByRole('radio', { name: 'Best quality' })).toHaveCount(1);
    await expect(page.getByTestId('tool-cloneStamp')).toBeVisible();
    await page.evaluate(() => (window as any).__profileHandle.destroy());
  }
});
