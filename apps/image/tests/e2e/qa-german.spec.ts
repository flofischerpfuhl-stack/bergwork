import { expect, test, type Page } from '@playwright/test';
import { translator } from '../../src/ui/i18n';
import { manifest, mountForTest, solidPng } from './helpers';

/** File (“Ablage”) › Import Images… in the German UI. */
async function importThroughMenu(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('menu-Ablage').click();
  await page.getByTestId('menu-import').click();
  await (await chooser).setFiles(files);
}

/**
 * QA: German UI. Walks the panels, menus and dialogs of the Phase-1 features with `locale: 'de'` and collects every
 * text node, title, aria-label and placeholder. A string that the English→German dictionary would translate but that
 * shows up in English is a leak; blend-mode names are checked against Photoshop's German names.
 */
test.use({ viewport: { width: 1440, height: 900 } });
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const de = translator('de');

async function visibleTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || !(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) continue;
      const t = n.textContent!.trim();
      if (t) out.add(t);
    }
    for (const el of document.querySelectorAll('[title],[aria-label],[placeholder]')) {
      for (const a of ['title', 'aria-label', 'placeholder']) { const v = el.getAttribute(a)?.trim(); if (v) out.add(v); }
    }
    return [...out];
  });
}
const leaks = (texts: string[]) => texts.filter((s) => /[A-Za-z]{3}/.test(s) && de(s) !== s);
const seen = new Set<string>();
async function collect(page: Page, where: string): Promise<void> {
  for (const s of leaks(await visibleTexts(page))) seen.add(`${where}: ${s}`);
}

test('QA German UI: no English strings in the menus, Layers/History panels, blend menu, filters, dialogs and notices', async ({ page }) => {
  test.setTimeout(180_000);
  await mountForTest(page, { locale: 'de' });
  await page.getByTestId('widthInput').fill('200');
  await page.getByTestId('heightInput').fill('150');
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'rot.png', mimeType: 'image/png', buffer: solidPng(60, 40, [255, 0, 0, 255]) }]);
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(2);
  await collect(page, 'main');
  // Every top-level menu, including the Align/Distribute/adjustment-layer submenus.
  const menus = await page.locator('[data-testid^="menu-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!).filter((id) => /^menu-[A-ZÄÖÜ]/.test(id)));
  for (const id of menus) {
    await page.getByTestId(id).click();
    await collect(page, id);
    for (const sub of ['Ausrichten', 'Verteilen', 'Neue Einstellungsebene']) {
      const item = page.getByRole('menuitem', { name: sub, exact: true });
      if (await item.count()) { await item.hover(); await collect(page, `${id} › ${sub}`); }
    }
    await page.keyboard.press('Escape');
  }
  // Blend mode popup.
  await page.getByTestId('layer-row').first().click();
  await page.getByTestId('blend-mode').click();
  const blendItems = await page.getByRole('menuitem').allTextContents();
  await collect(page, 'blend menu');
  await page.keyboard.press('Escape');
  // Layer filter menu and the row context menu with its colour-label submenu.
  await page.getByTestId('layer-filter').click();
  await collect(page, 'layer filter');
  await page.keyboard.press('Escape');
  await page.getByTestId('layer-row').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Farbmarkierung' }).hover();
  await collect(page, 'context menu');
  await page.getByRole('menuitem', { name: 'Rot', exact: true }).click();
  // Lock, fill, a guide, align: then the History panel lists them.
  await page.getByTestId('lock-pixels').click();
  await page.getByTestId('fill-field').fill('70');
  await page.getByTestId('fill-field').press('Enter');
  await page.getByTestId('menu-Ansicht').click();
  await page.getByRole('menuitem', { name: /Neue Hilfslinie/ }).click();
  await collect(page, 'new guide dialog');
  await page.getByTestId('guide-position').fill('12,5');
  await page.getByTestId('guide-ok').click();
  // A refused stroke shows the lock notice.
  await page.getByTestId('tool-brush').click();
  const pane = (await page.getByTestId('canvas-pane').boundingBox())!;
  await page.mouse.move(pane.x + pane.width / 2 - 10, pane.y + pane.height / 2);
  await page.mouse.down();
  await page.mouse.move(pane.x + pane.width / 2 + 10, pane.y + pane.height / 2, { steps: 3 });
  await page.mouse.up();
  await expect(page.getByTestId('lock-notice')).toBeVisible();
  await collect(page, 'lock notice');
  const notice = await page.getByTestId('lock-notice').textContent();
  await page.getByTestId('lock-pixels').click();
  await page.getByTestId('tool-move').click();
  await page.getByTestId('tab-history').click();
  const history = await page.getByTestId('history-step').allTextContents();
  await collect(page, 'history panel');
  await page.getByTestId('tab-layers').click();
  // Levels panel.
  await page.getByTestId('compositor-editor').press(`${mod}+l`);
  await expect(page.getByTestId('adjustment-panel')).toBeVisible();
  await collect(page, 'levels panel');
  await page.getByTestId('adjustment-cancel').click();
  // An unsupported import reports an error message.
  await importThroughMenu(page, [{ name: 'kaputt.png', mimeType: 'image/png', buffer: Buffer.from('not an image at all') }]);
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await collect(page, 'import error');
  const alertText = (await page.getByRole('alertdialog').innerText()).replace(/\s+/g, ' ');
  const errors = await page.evaluate(() => (window as any).__errors.map((e: { message: string }) => e.message));

  console.log('QA German blend menu:', blendItems.join(' | '));
  console.log('QA German history:', history.join(' | '));
  console.log('QA German lock notice:', notice);
  console.log('QA German import error (host):', errors.join(' | '));
  console.log('QA German import error (alert):', alertText);
  console.log('QA German leaks:\n  ' + [...seen].join('\n  '));
  expect([...seen], 'English strings in the German UI').toEqual([]);
});

async function germanCanvas(page: Page): Promise<void> {
  await mountForTest(page, { locale: 'de' });
  await page.getByTestId('widthInput').fill('100');
  await page.getByTestId('heightInput').fill('80');
  await page.getByTestId('createCanvas').click();
}

test('QA bug (de): 13 of 27 blend modes are listed in English in the German blend menu', async ({ page }) => {
  await germanCanvas(page);
  await page.getByTestId('layer-row').first().click();
  await page.getByTestId('blend-mode').click();
  const items = (await page.getByRole('menuitem').allTextContents()).map((b) => b.replace('✓', '').trim());
  // Photoshop's German names: Sprenkeln, Linear nachbelichten, Dunklere Farbe, Linear abwedeln (Addieren), Hellere Farbe,
  // Weiches Licht, Hartes Licht, Strahlendes Licht, Lineares Licht, Lichtpunkt, Hart mischen, Ausschluss, Dividieren.
  const english = ['Dissolve', 'Darker Color', 'Linear Burn', 'Lighter Color', 'Linear Dodge (Add)', 'Soft Light', 'Hard Light',
    'Vivid Light', 'Linear Light', 'Pin Light', 'Hard Mix', 'Exclusion', 'Divide'];
  expect(items).toHaveLength(27);
  expect(items.filter((b) => english.includes(b))).toEqual([]);
});

test('QA bug (de): the alert for an unsupported import file is in English', async ({ page }) => {
  await germanCanvas(page);
  await importThroughMenu(page, [{ name: 'kaputt.png', mimeType: 'image/png', buffer: Buffer.from('not an image at all') }]);
  const alert = page.getByRole('alertdialog');
  await expect(alert).toBeVisible();
  const text = (await alert.innerText()).replace(/\s+/g, ' ');
  console.log('QA German import alert:', text);
  expect(text).not.toMatch(/Choose a|image\./);
});

test('QA bug (de): the Image Size and Canvas Size dialogs are largely in English', async ({ page }) => {
  await germanCanvas(page);
  const found: string[] = [];
  for (const item of [/Bildgröße/, /Arbeitsfläche/]) {
    await page.getByTestId('menu-Bild').click();
    await page.getByRole('menuitem', { name: item }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const text = await dialog.innerText();
    for (const english of ['Units', 'Relative to current dimensions', 'Lock original aspect ratio', 'Canvas extension', 'Lock aspect ratio',
      'Resample', 'Resizes layer pixels', 'Only print dimensions', 'Resize', 'Resolution', 'pixels/inch']) {
      if (text.includes(english)) found.push(`${item.source}: ${english}`);
    }
    await dialog.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(dialog).toHaveCount(0);
  }
  console.log('QA German size dialogs, English strings:', found);
  expect(found).toEqual([]);
});

test('QA bug (de): the History panel lists a Content-Aware Fill step in English', async ({ page }) => {
  await germanCanvas(page);
  await importThroughMenu(page, [{ name: 'blau.png', mimeType: 'image/png', buffer: solidPng(100, 80, [20, 20, 220, 255]) }]);
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(2);
  const pane = (await page.getByTestId('canvas-pane').boundingBox())!;
  const at = async (x: number, y: number) => {
    const v = await page.evaluate(([x, y]) => { const s = (window as any).__editorForTests.session; return s.viewport.viewPoint({ x, y }, s.document); }, [x, y]);
    return { x: pane.x + v.x, y: pane.y + v.y };
  };
  await page.getByTestId('tool-marquee').click();
  const a = await at(40, 30), b = await at(55, 45);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  await page.getByTestId('compositor-editor').press('Shift+Backspace');
  await expect(page.getByTestId('content-fill-apply')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('content-fill-apply').click();
  await expect(page.getByTestId('content-fill-panel')).toHaveCount(0);
  await page.getByTestId('tab-history').click();
  const steps = await page.getByTestId('history-step').allTextContents();
  console.log('QA German history after content-aware fill:', steps);
  expect(steps.at(-1)).not.toBe('Content-Aware Fill');
});
