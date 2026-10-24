import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { encodePng } from '../../src/io/png';
import { exportedPixels, importThroughMenu, mountForTest, solidPng } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
type Pixels = { width: number; height: number; data: number[] };

/** A 64 × 64 test card: 16 tiles of saturated colours and grays, so every adjustment has something to change. */
function testCard(): Buffer {
  const colours: [number, number, number][] = [
    [200, 40, 40], [40, 180, 60], [50, 70, 210], [128, 128, 128],
    [230, 200, 40], [40, 190, 200], [190, 50, 180], [30, 30, 30],
    [240, 240, 240], [150, 90, 60], [90, 140, 110], [180, 180, 120],
    [100, 100, 100], [160, 160, 160], [220, 120, 90], [70, 90, 160],
  ];
  const data = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const [r, g, b] = colours[Math.floor(y / 16) * 4 + Math.floor(x / 16)]!;
    data.set([r, g, b, 255], (y * 64 + x) * 4);
  }
  return Buffer.from(encodePng(data, 64, 64, 4));
}

async function canvasWith(page: Page, png: Buffer, size = 64, locale: 'de' | 'en' = 'en'): Promise<void> {
  await mountForTest(page, { locale });
  await page.getByTestId('widthInput').fill(String(size));
  await page.getByTestId('heightInput').fill(String(size));
  await page.getByTestId('createCanvas').click();
  const files = [{ name: 'card.png', mimeType: 'image/png', buffer: png }];
  if (locale === 'en') await importThroughMenu(page, files);
  else {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('menu-Ablage').click();
    await page.getByTestId('menu-import').click();
    await (await chooser).setFiles(files);
  }
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.document.layers.length)).toBe(2);
}

const undoCount = (page: Page) => page.evaluate(() => (window as any).__editorForTests.session.history.undoCount as number);
const difference = (a: Pixels, b: Pixels) => a.data.reduce((sum, v, i) => sum + (i % 4 === 3 ? 0 : Math.abs(v - b.data[i]!)), 0);
const pixelAt = (p: Pixels, x: number, y: number) => p.data.slice((y * p.width + x) * 4, (y * p.width + x) * 4 + 4);

async function newAdjustmentLayer(page: Page, label: string): Promise<void> {
  await page.getByTestId('menu-Layer').click();
  await page.getByRole('menuitem', { name: 'New Adjustment Layer' }).hover();
  await page.getByRole('menuitem', { name: `${label}…`, exact: true }).click();
  await expect(page.getByTestId('adjustment-panel')).toBeVisible();
}

async function filterMenu(page: Page, label: string): Promise<void> {
  await page.getByTestId('menu-Filter').click();
  await page.getByRole('menuitem', { name: `${label}…`, exact: true }).click();
  await expect(page.getByTestId('adjustment-panel')).toBeVisible();
}

async function setField(page: Page, testId: string, value: string): Promise<void> {
  await page.getByTestId(testId).fill(value);
  await page.getByTestId(testId).press('Enter');
}

const CASES: { label: string; kind: string; change: (page: Page) => Promise<void> }[] = [
  { label: 'Basic', kind: 'Basic', change: async (page) => {
    await setField(page, 'basic-exposure', '1.5');
    // Double-clicking a slider's name resets it (Lightroom); set it again afterwards.
    await setField(page, 'basic-vibrance', '60');
    await page.getByTestId('basic-vibrance-label').dblclick();
    await expect(page.getByTestId('basic-vibrance')).toHaveValue('0');
    await setField(page, 'basic-temperature', '40');
  } },
  { label: 'Color', kind: 'Colour', change: async (page) => {
    await page.getByTestId('colour-tab-balance').click();
    await setField(page, 'colour-balance-cyanRed', '80');
    await expect(page.getByTestId('colour-balance-enabled')).toBeChecked();
    await page.getByTestId('colour-tab-selective').click();
    await page.getByTestId('colour-selective-range').selectOption('Blues');
    await setField(page, 'colour-selective-yellow', '-60');
    await page.getByTestId('colour-tab-bw').click();
    await page.getByTestId('colour-bw-auto').click();
    await expect(page.getByTestId('colour-bw-enabled')).toBeChecked();
  } },
  { label: 'Photo Filter', kind: 'Photo Filter', change: async (page) => {
    await page.getByTestId('photo-filter-preset').selectOption('Cooling Filter (80)');
    await setField(page, 'photo-filter-density', '80');
  } },
  { label: 'Channel Mixer', kind: 'Channel Mixer', change: async (page) => {
    await setField(page, 'mixer-green', '100');
    await expect(page.getByTestId('mixer-total')).toContainText('200');
  } },
  { label: 'Invert', kind: 'Invert', change: async () => {} },
  { label: 'Threshold', kind: 'Threshold', change: async (page) => { await setField(page, 'threshold-level', '60'); } },
  { label: 'Posterize', kind: 'Posterize', change: async (page) => { await setField(page, 'posterize-levels', '2'); } },
  { label: 'Brightness/Contrast', kind: 'Brightness/Contrast', change: async (page) => {
    await setField(page, 'bc-brightness', '90');
    await page.getByTestId('bc-legacy').check();
  } },
];

for (const c of CASES) {
  test(`${c.label} adjustment layer: made through the menu, its panel changes the export in one undo step`, async ({ page }) => {
    await canvasWith(page, testCard());
    const base = await exportedPixels(page);
    const before = await undoCount(page);
    await newAdjustmentLayer(page, c.label);
    await expect(page.getByTestId('adjustment-panel')).toContainText('Adjustment Layer');
    expect(await page.evaluate(() => (window as any).__editorForTests.session.activeLayer.adjustment.kind)).toBe(c.kind);
    const created = await undoCount(page);
    expect(created).toBe(before + 1);
    const neutral = await exportedPixels(page);
    await c.change(page);
    await page.getByTestId('adjustment-ok').click();
    await expect(page.getByTestId('adjustment-panel')).toHaveCount(0);
    const after = await exportedPixels(page);
    if (c.kind === 'Invert') {
      // Invert has no settings: the layer itself is the change, and OK adds no step.
      expect(await undoCount(page)).toBe(created);
      expect(Math.abs(pixelAt(after, 8, 8)[0]! - (255 - pixelAt(base, 8, 8)[0]!))).toBeLessThanOrEqual(1);
      return;
    }
    expect(difference(after, neutral)).toBeGreaterThan(64 * 64 * 3);
    // The whole panel session is one undo step; undoing it restores the layer's neutral settings.
    expect(await undoCount(page)).toBe(created + 1);
    await page.getByTestId('compositor-editor').press(`${mod}+z`);
    expect(difference(await exportedPixels(page), neutral)).toBeLessThanOrEqual(64 * 64 * 3 / 4);
    expect(await page.evaluate(() => (window as any).__editorForTests.session.document.layers.length)).toBe(3);
  });
}

test('the Layers panel button lists the new kinds; double-click reopens the panel and Cancel keeps the stored settings', async ({ page }) => {
  await canvasWith(page, testCard());
  await page.getByRole('button', { name: 'New adjustment layer' }).click();
  for (const name of ['Basic', 'Color', 'Photo Filter', 'Channel Mixer', 'Color Lookup', 'Invert', 'Posterize', 'Threshold', 'Brightness/Contrast']) {
    await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
  }
  await page.getByRole('menuitem', { name: 'Posterize', exact: true }).click();
  await setField(page, 'posterize-levels', '3');
  await page.getByTestId('adjustment-ok').click();
  await page.locator('[data-testid="layer-row"]').first().dblclick();
  await expect(page.getByTestId('adjustment-panel')).toContainText('Posterize');
  await setField(page, 'posterize-levels', '9');
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.activeLayer.adjustment.parameters.levels)).toBe(9);
  await page.getByTestId('adjustment-cancel').click();
  expect(await page.evaluate(() => (window as any).__editorForTests.session.activeLayer.adjustment.parameters.levels)).toBe(3);
});

/** A 2-point 3D LUT: identity, or RGB inversion. */
function cube(title: string, invert: boolean): string {
  const rows: string[] = [`TITLE "${title}"`, 'LUT_3D_SIZE 2'];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) {
    rows.push([r, g, b].map((v) => (invert ? 1 - v : v).toFixed(1)).join(' '));
  }
  return `${rows.join('\n')}\n`;
}

test('Color Lookup loads a .cube file through the file picker: identity keeps, invert inverts; one undo step', async ({ page }) => {
  await canvasWith(page, testCard());
  const base = await exportedPixels(page);
  await newAdjustmentLayer(page, 'Color Lookup');
  await expect(page.getByTestId('lut-name')).toHaveText('No LUT loaded');
  let chooser = page.waitForEvent('filechooser');
  await page.getByTestId('lut-load').click();
  await (await chooser).setFiles([{ name: 'identity.cube', mimeType: 'text/plain', buffer: Buffer.from(cube('Identity', false)) }]);
  await expect(page.getByTestId('lut-name')).toHaveText('Identity');
  await page.getByRole('radio', { name: 'Trilinear' }).click();
  await page.getByTestId('adjustment-ok').click();
  let pixels = await exportedPixels(page);
  expect(difference(pixels, base)).toBeLessThanOrEqual(64 * 64 * 3);
  const stored = await page.evaluate(() => {
    const s = (window as any).__editorForTests.session;
    return { resources: s.document.resources.filter((r: any) => r.role === 'lut').length, parameters: s.activeLayer.adjustment.parameters };
  });
  expect(stored.resources).toBe(1);
  expect(stored.parameters.interpolation).toBe('trilinear');

  // Replace with an inverting LUT; a file that is not a LUT reports an error and changes nothing.
  const steps = await undoCount(page);
  await page.locator('[data-testid="layer-row"]').first().dblclick();
  chooser = page.waitForEvent('filechooser');
  await page.getByTestId('lut-load').click();
  await (await chooser).setFiles([{ name: 'broken.cube', mimeType: 'text/plain', buffer: Buffer.from('LUT_3D_SIZE 2\n0 0\n') }]);
  await expect(page.getByTestId('lut-error')).toBeVisible();
  chooser = page.waitForEvent('filechooser');
  await page.getByTestId('lut-load').click();
  await (await chooser).setFiles([{ name: 'negative.cube', mimeType: 'text/plain', buffer: Buffer.from(cube('Negative', true)) }]);
  await expect(page.getByTestId('lut-name')).toHaveText('Negative');
  await page.getByTestId('adjustment-ok').click();
  pixels = await exportedPixels(page);
  for (const [x, y] of [[8, 8], [24, 8], [40, 40], [56, 56]] as const) {
    const [r, g, b] = pixelAt(pixels, x, y), [br, bg, bb] = pixelAt(base, x, y);
    expect(Math.abs(r! - (255 - br!))).toBeLessThanOrEqual(2);
    expect(Math.abs(g! - (255 - bg!))).toBeLessThanOrEqual(2);
    expect(Math.abs(b! - (255 - bb!))).toBeLessThanOrEqual(2);
  }
  expect(await undoCount(page)).toBe(steps + 1);
  // The replaced LUT's unused resource is not kept; undo brings back the identity LUT.
  expect(await page.evaluate(() => (window as any).__editorForTests.session.document.resources.filter((r: any) => r.role === 'lut').length)).toBe(2);
  await page.getByTestId('compositor-editor').press(`${mod}+z`);
  expect(difference(await exportedPixels(page), base)).toBeLessThanOrEqual(64 * 64 * 3);
});

test('Smart filters: Unsharp Mask is live, its eye toggles it, two filters reorder by drag, Apply bakes them', async ({ page }) => {
  await canvasWith(page, testCard());
  const base = await exportedPixels(page);
  await page.evaluate(() => { const s = (window as any).__editorForTests.session; (window as any).__raster = s.activeLayer.raster; });
  const before = await undoCount(page);
  await filterMenu(page, 'Unsharp Mask');
  await expect(page.getByTestId('adjustment-panel')).toContainText('Smart Filter');
  await setField(page, 'sharpenAmount', '300');
  await setField(page, 'sharpenRadius', '2');
  await page.getByTestId('adjustment-ok').click();
  await expect(page.getByTestId('adjustment-panel')).toHaveCount(0);
  expect(await undoCount(page)).toBe(before + 1);
  const layerState = () => page.evaluate(() => {
    const layer = (window as any).__editorForTests.session.activeLayer;
    return { kinds: layer.filters.map((f: any) => f.kind), enabled: layer.filters.map((f: any) => f.enabled), same: layer.raster === (window as any).__raster };
  });
  expect(await layerState()).toEqual({ kinds: ['unsharpMask'], enabled: [true], same: true });
  const sharpened = await exportedPixels(page);
  expect(difference(sharpened, base)).toBeGreaterThan(1000);

  // The filter row's eye hides it (one undo step) and shows it again.
  await expect(page.getByTestId('filter-row')).toHaveCount(1);
  await page.getByTestId('filter-eye').click();
  expect((await layerState()).enabled).toEqual([false]);
  expect(difference(await exportedPixels(page), base)).toBeLessThanOrEqual(64 * 64 * 3 / 8);
  await page.getByTestId('filter-eye').click();
  expect((await layerState()).enabled).toEqual([true]);

  // A second live filter; rows list the stack top-down (last applied on top), as Photoshop does.
  await filterMenu(page, 'Gaussian Blur');
  await setField(page, 'blurRadius', '3');
  await page.getByTestId('adjustment-ok').click();
  expect((await layerState()).kinds).toEqual(['unsharpMask', 'gaussianBlur']);
  const rows = page.getByTestId('filter-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-filter-kind', 'gaussianBlur');
  const blurredLast = await exportedPixels(page);

  // Drag Unsharp Mask above Gaussian Blur: it now runs last.
  const from = (await rows.nth(1).boundingBox())!, to = (await rows.nth(0).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + 3, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await layerState()).kinds).toEqual(['gaussianBlur', 'unsharpMask']);
  const sharpenedLast = await exportedPixels(page);
  expect(difference(sharpenedLast, blurredLast)).toBeGreaterThan(100);

  // Double-click opens the filter's panel on the live filter; Cancel leaves it as it was.
  await rows.nth(1).dblclick();
  await expect(page.getByTestId('adjustment-panel')).toContainText('Gaussian Blur');
  await setField(page, 'blurRadius', '20');
  await page.getByTestId('adjustment-cancel').click();
  expect(await page.evaluate(() => (window as any).__editorForTests.session.activeLayer.filters[0].radius)).toBe(3);

  // Apply Smart Filters (layer context menu) bakes the stack into the pixels in one step.
  const steps = await undoCount(page);
  const id = await page.evaluate(() => (window as any).__editorForTests.session.activeLayerId);
  await page.locator(`[data-testid="layer-row"][data-layer-id="${id}"]`).click({ button: 'right' });
  await page.getByTestId('context-apply-filters').click();
  await expect.poll(async () => (await layerState()).kinds).toEqual([]);
  expect((await layerState()).same).toBe(false);
  expect(await undoCount(page)).toBe(steps + 1);
  expect(difference(await exportedPixels(page), sharpenedLast)).toBeLessThanOrEqual(64 * 64 * 3);
  await page.getByTestId('compositor-editor').press(`${mod}+z`);
  expect((await layerState()).kinds).toEqual(['gaussianBlur', 'unsharpMask']);
});

test('Dodge (a Brush mode) brightens the midtones it paints over', async ({ page }) => {
  await canvasWith(page, solidPng(100, 100, [120, 120, 120, 255]), 100);
  await page.getByTestId('tool-brush').click();
  await page.getByRole('radio', { name: 'Dodge' }).click();
  await expect(page.getByTestId('brush-range')).toHaveValue('midtones');
  await page.getByTestId('brush-exposure').fill('80');
  await page.getByTestId('brush-exposure').press('Enter');
  const pane = (await page.getByTestId('canvas-pane').boundingBox())!;
  const zoom = parseFloat((await page.getByTestId('zoomStatus').textContent())!) / 100 / (await page.evaluate(() => devicePixelRatio));
  const at = (x: number, y: number) => ({ x: pane.x + pane.width / 2 + (x - 50) * zoom, y: pane.y + pane.height / 2 + (y - 50) * zoom });
  let p = at(20, 50);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  for (const x of [35, 50, 65, 80]) { p = at(x, 50); await page.mouse.move(p.x, p.y, { steps: 3 }); }
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.history.pastNames.at(-1))).toBe('Dodge');
  const pixels = await exportedPixels(page);
  const [r, g, b, a] = pixelAt(pixels, 50, 50);
  expect(r!).toBeGreaterThan(140);
  expect(g).toBe(r);
  expect(b).toBe(r);
  expect(a).toBe(255);
  expect(pixelAt(pixels, 50, 5)).toEqual([120, 120, 120, 255]);
  // Burn and Sponge are the same tool's other modes.
  await page.getByRole('radio', { name: 'Sponge' }).click();
  await expect(page.getByTestId('brush-sponge-mode')).toBeVisible();
  await expect(page.getByTestId('brush-vibrance')).toBeVisible();
});

test('German labels: menus, Basic, Color tabs, smart filters and brush modes', async ({ page }) => {
  await canvasWith(page, testCard(), 64, 'de');
  await page.getByTestId('menu-Filter').click();
  for (const name of ['Unscharf maskieren…', 'Selektiver Scharfzeichner…', 'Hochpass…', 'Rauschen reduzieren…']) {
    await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await page.getByTestId('menu-Ebene').click();
  await page.getByRole('menuitem', { name: 'Neue Einstellungsebene' }).hover();
  for (const name of ['Basis…', 'Farbtabelle…', 'Farbe…', 'Fotofilter…', 'Kanalmixer…', 'Umkehren…', 'Schwellenwert…', 'Tontrennung…', 'Helligkeit/Kontrast…']) {
    await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
  }
  await page.getByRole('menuitem', { name: 'Basis…', exact: true }).click();
  const panel = page.getByTestId('adjustment-panel');
  for (const text of ['Basis · Einstellungsebene', 'Licht', 'Präsenz', 'Belichtung', 'Kontrast', 'Lichter', 'Tiefen', 'Weiß', 'Schwarz', 'Struktur',
    'Klarheit', 'Dunst entfernen', 'Dynamik', 'Sättigung', 'Temperatur', 'Tönung']) await expect(panel.getByText(text, { exact: true }).first()).toBeVisible();
  await page.getByTestId('adjustment-ok').click();
  expect(await page.evaluate(() => (window as any).__editorForTests.session.activeLayer.name)).toBe('Basis');
  await page.getByRole('button', { name: 'Neue Einstellungsebene' }).click();
  await page.getByRole('menuitem', { name: 'Farbe', exact: true }).click();
  for (const text of ['Schwarzweiß', 'Farbbalance', 'Selektive Farbkorrektur']) await expect(panel.getByRole('tab', { name: text })).toBeVisible();
  await page.getByTestId('colour-tab-balance').click();
  for (const text of ['Tiefen', 'Mitteltöne', 'Lichter', 'Luminanz erhalten']) await expect(panel.getByText(text, { exact: true })).toBeVisible();
  await page.getByTestId('adjustment-ok').click();

  await page.locator('[data-testid="layer-row"]', { hasText: 'card' }).click();
  await page.getByTestId('menu-Filter').click();
  await page.getByRole('menuitem', { name: 'Unscharf maskieren…', exact: true }).click();
  await expect(panel).toContainText('Unscharf maskieren · Smartfilter');
  await page.getByTestId('adjustment-ok').click();
  await expect(page.getByTestId('filter-header')).toContainText('Smartfilter');
  await expect(page.getByTestId('filter-row')).toContainText('Unscharf maskieren');

  await page.getByTestId('tool-brush').click();
  const bar = page.getByTestId('context-bar');
  for (const name of ['Malen', 'Radieren', 'Abwedler', 'Nachbelichter', 'Schwamm']) await expect(bar.getByRole('radio', { name })).toBeVisible();
  await bar.getByRole('radio', { name: 'Abwedler' }).click();
  await expect(bar.getByText('Bereich', { exact: true })).toBeVisible();
  await expect(bar.getByTestId('brush-range').locator('option:checked')).toHaveText('Mitteltöne');
  await bar.getByRole('radio', { name: 'Schwamm' }).click();
  await expect(bar.getByTestId('brush-sponge-mode').locator('option:checked')).toHaveText('Sättigung erhöhen');
  await expect(bar.getByText('Dynamik', { exact: true })).toBeVisible();
});

// Screenshots for visual review (UIADJ_SHOTS=1): German and English desktop.
for (const locale of ['de', 'en'] as const) {
  test(`screenshots (${locale}): Basic panel, Color tabs, smart filter rows, brush modes`, async ({ page }) => {
    test.skip(!process.env.UIADJ_SHOTS, 'screenshots only on request');
    const out = process.env.UIADJ_SHOTS_DIR ?? '/tmp/fw-uiadj-shots';
    fs.mkdirSync(out, { recursive: true });
    await canvasWith(page, testCard(), 64, locale);
    const shot = (name: string) => page.screenshot({ path: path.join(out, `${locale}-${name}.png`) });
    await page.evaluate(() => (window as any).__editorForTests.session.addAdjustment('Basic'));
    await setField(page, 'basic-exposure', '0.6');
    await setField(page, 'basic-clarity', '35');
    await shot('basic-panel');
    await page.getByTestId('adjustment-ok').click();
    await page.evaluate(() => (window as any).__editorForTests.session.addAdjustment('Colour'));
    for (const tab of ['bw', 'balance', 'selective']) { await page.getByTestId(`colour-tab-${tab}`).click(); await shot(`colour-${tab}`); }
    await page.getByTestId('adjustment-ok').click();
    for (const kind of ['Colour Lookup', 'Photo Filter', 'Channel Mixer', 'Threshold', 'Brightness/Contrast']) {
      await page.evaluate((k) => (window as any).__editorForTests.session.addAdjustment(k), kind);
      if (kind === 'Threshold') await expect(page.getByTestId('adjustment-panel').getByText(/Loading histogram|Histogramm wird/)).toHaveCount(0);
      await shot(`panel-${kind.replace(/\W+/g, '-').toLowerCase()}`);
      await page.getByTestId('adjustment-ok').click();
    }
    await page.locator('[data-testid="layer-row"]', { hasText: 'card' }).click();
    for (const label of locale === 'de' ? ['Unscharf maskieren', 'Gaußscher Weichzeichner', 'Hochpass'] : ['Unsharp Mask', 'Gaussian Blur', 'High Pass']) {
      await filterMenu(page, label);
      if (label === 'Unsharp Mask' || label === 'Unscharf maskieren') await shot('filter-panel');
      await page.getByTestId('adjustment-ok').click();
    }
    await page.getByTestId('filter-eye').nth(1).click();
    await shot('filter-rows');
    await page.getByTestId('tool-brush').click();
    for (const mode of locale === 'de' ? ['Abwedler', 'Schwamm'] : ['Dodge', 'Sponge']) {
      await page.getByRole('radio', { name: mode }).click();
      await shot(`brush-${mode.toLowerCase()}`);
    }
  });
}
