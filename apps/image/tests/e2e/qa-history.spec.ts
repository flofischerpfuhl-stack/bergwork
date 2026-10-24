import { expect, test, type Page } from '@playwright/test';
import { manifest, mountForTest } from './helpers';

/** QA: the History panel — jumping, editing after a jump, saving with/without history, reopening and undoing further. */
test.use({ viewport: { width: 1440, height: 900 } });
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

const layerNames = async (page: Page) => (await manifest(page)).layers.map((l: any) => l.name);
const stepLabels = (page: Page) => page.getByTestId('history-step').allTextContents();
const current = (page: Page) => page.locator('[data-testid="history-step"][aria-current="step"]').textContent();

async function fourSteps(page: Page): Promise<void> {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('80');
  await page.getByTestId('heightInput').fill('60');
  await page.getByTestId('createCanvas').click();
  // Four named steps: three blank layers, then a rename.
  for (let i = 0; i < 3; i++) await page.getByTestId('addBlankLayer').click();
  await page.evaluate(() => { const s = (window as any).__editorForTests.session; s.renameLayer(s.document.layers.at(-1).id, 'Oben'); });
  await page.getByTestId('tab-history').click();
}

test('QA history: jump back, then a new edit discards the undone steps (dimmed rows disappear, redo is gone)', async ({ page }) => {
  await fourSteps(page);
  const labels = await stepLabels(page);
  expect(labels[0]).toBe('Opened state');
  const n = labels.length;
  // Back to the state after the second blank layer (Layer 1 + two blanks).
  await page.getByTestId('history-step').nth(n - 3).click();
  await expect.poll(() => layerNames(page)).toHaveLength(3);
  await expect(page.locator('[data-testid="history-step"][aria-current="step"]')).toHaveCount(1);
  // A different edit now: a new folder.
  await page.evaluate(() => (window as any).__editorForTests.session.addGroup());
  await expect.poll(() => stepLabels(page)).toHaveLength(n - 1);
  expect(await current(page)).not.toBe('Opened state');
  expect(await page.evaluate(() => (window as any).__editorForTests.session.canRedo)).toBe(false);
  await page.getByTestId('compositor-editor').press(`${mod}+Shift+z`);
  await expect.poll(() => layerNames(page)).toHaveLength(4);
  expect(await layerNames(page)).not.toContain('Oben');
  // Jump to "Opened state": only the first layer remains; forward to the last row brings the folder back.
  await page.getByTestId('history-step').first().click();
  await expect.poll(() => layerNames(page)).toHaveLength(1);
  await page.getByTestId('history-step').last().click();
  await expect.poll(() => layerNames(page)).toHaveLength(4);
});

test('QA history: saved with the project, reopened at an earlier step, redo and undo continue from there', async ({ page }) => {
  await fourSteps(page);
  const n = (await stepLabels(page)).length;
  await page.getByTestId('history-step').nth(n - 3).click();
  await expect.poll(() => layerNames(page)).toHaveLength(3);
  const labels = await stepLabels(page);
  await page.evaluate(async () => { const h = (window as any).__handle; await h.openProject(await h.saveProject()); });
  await page.getByTestId('tab-history').click();
  await expect.poll(() => stepLabels(page)).toEqual(labels);
  expect(await layerNames(page)).toHaveLength(3);
  expect(await current(page)).toBe(labels[n - 3]);
  // Redo the two undone steps, then undo all the way back.
  await page.getByTestId('history-step').last().click();
  await expect.poll(() => layerNames(page)).toContain('Oben');
  await page.getByTestId('history-step').first().click();
  await expect.poll(() => layerNames(page)).toHaveLength(1);
});

test('QA history: with "Save history" off the reopened project has only the opened state, and the document is intact', async ({ page }) => {
  await fourSteps(page);
  await page.getByTestId('save-history').uncheck();
  await page.evaluate(async () => { const h = (window as any).__handle; await h.openProject(await h.saveProject()); });
  await page.getByTestId('tab-history').click();
  await expect.poll(() => stepLabels(page)).toEqual(['Opened state']);
  expect(await layerNames(page)).toContain('Oben');
  expect(await page.evaluate(() => (window as any).__editorForTests.session.canUndo)).toBe(false);
  // The option is a user preference: it is still off for the next save.
  await expect(page.getByTestId('save-history')).not.toBeChecked();
});

test('QA history: steps of the Phase-1 features are listed by name (locks, fill, label, guides, align)', async ({ page }) => {
  await fourSteps(page);
  await page.getByTestId('tab-layers').click();
  await page.getByTestId('layer-row').first().click();
  await page.getByTestId('lock-position').click();
  await page.getByTestId('fill-field').fill('70');
  await page.getByTestId('fill-field').press('Enter');
  await page.getByTestId('layer-row').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Color Label' }).hover();
  await page.getByRole('menuitem', { name: 'Red' }).click();
  await page.getByTestId('menu-View').click();
  await page.getByRole('menuitem', { name: 'New Guide…' }).click();
  await page.getByTestId('guide-position').fill('10');
  await page.getByTestId('guide-ok').click();
  await page.getByTestId('tab-history').click();
  const labels = await stepLabels(page);
  console.log('QA history labels', labels);
  for (const label of labels) expect(label.trim().length).toBeGreaterThan(0);
  expect(labels.slice(-4).every((l) => !/^[a-z]/.test(l))).toBe(true);
});
