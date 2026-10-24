import { expect, test } from '@playwright/test';
import { mountForTest } from './helpers';

test.use({ viewport: { width: 1280, height: 820 } });

test('About opens the complete offline licence inventory and full licence texts', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('menu-Help').click();
  await page.getByTestId('menu-about').click();
  const about = page.getByTestId('about-dialog');
  await expect(about).toContainText('Works offline. No account, no telemetry.');
  await expect(about).toContainText('Compositor by Wonder Assembly LLC');
  await page.getByTestId('about-licenses').click();

  const dialog = page.getByTestId('licenses-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('license-group-bundled')).toBeVisible();
  await expect(dialog.getByTestId('license-group-optional-download')).toContainText('BiRefNet_lite 1024');
  await expect(dialog.getByTestId('license-group-opt-in-host')).toContainText('system LibRaw');
  await expect(dialog.getByTestId('license-group-tauri-runtime')).toContainText('option-ext');
  await expect(dialog.locator('tbody tr')).toHaveCount(546);

  await dialog.getByTestId('license-search').fill('option-ext');
  await expect(dialog.locator('tbody tr')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'MPL-2.0' }).click();
  await expect(dialog.getByTestId('license-text')).toContainText('Mozilla Public License Version 2.0');
  await dialog.getByRole('button', { name: 'Back' }).click();
  await dialog.getByTestId('license-search').fill('');
  await dialog.getByTestId('own-license-text').click();
  await expect(dialog.getByTestId('license-text')).toContainText('Additional Use Grant');
  await expect(dialog.getByTestId('license-text')).toContainText('Licensed Work:        berg:work, including berg:work PDF, berg:work Image');
});

test('the licences view and free-tier summary are German-localized', async ({ page }) => {
  await mountForTest(page, { locale: 'de' });
  await page.getByTestId('menu-Hilfe').click();
  await page.getByTestId('menu-about').click();
  await page.getByTestId('about-licenses').click();
  const dialog = page.getByTestId('licenses-dialog');
  await expect(dialog.getByRole('heading', { name: 'Lizenzen' })).toBeVisible();
  await expect(dialog).toContainText('Organisationen mit höchstens drei Personen');
  await expect(dialog.getByTestId('license-group-opt-in-host')).toContainText('Zuschaltbare Host-Komponenten (nicht mitgeliefert)');
  await expect(dialog.getByPlaceholder('Lizenzen durchsuchen')).toBeVisible();
});
