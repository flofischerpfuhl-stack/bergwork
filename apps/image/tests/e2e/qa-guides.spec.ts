import { expect, test, type Page } from '@playwright/test';
import { importThroughMenu, manifest, mountForTest, solidPng } from './helpers';

/** QA: rulers, guides, guide locking/clearing, the New Guide dialog, snapping, align and distribute (incl. folders). */
test.use({ viewport: { width: 1440, height: 900 } });
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

const guides = (page: Page) => page.evaluate(() =>
  ((window as any).__editorForTests.session.guides as { orientation: string; position: number }[]).map((g) => [g.orientation, g.position]));
const layers = (page: Page) => page.evaluate(() => (window as any).__handle.getManifestV2().layers as any[]);
const session = (page: Page, fn: string, ...args: unknown[]) => page.evaluate(({ fn, args }) => {
  const s = (window as any).__editorForTests.session;
  return (s[fn] as (...a: unknown[]) => unknown).apply(s, args);
}, { fn, args });
const undoNames = (page: Page) => page.evaluate(() => (window as any).__editorForTests.session.history.pastNames as string[]);

async function canvas(page: Page, locale: 'en' | 'de' = 'en', w = 400, h = 300): Promise<void> {
  await mountForTest(page, { locale });
  await page.getByTestId('widthInput').fill(String(w));
  await page.getByTestId('heightInput').fill(String(h));
  await page.getByTestId('createCanvas').click();
}
async function viewMenu(page: Page, item: string): Promise<void> {
  await page.getByTestId('menu-View').click();
  await page.getByRole('menuitem', { name: item }).click();
}
async function newGuide(page: Page, orientation: 'Horizontal' | 'Vertical', value: string): Promise<void> {
  await viewMenu(page, 'New Guide…');
  await page.getByRole('radio', { name: orientation }).click();
  await page.getByTestId('guide-position').fill(value);
  await page.getByTestId('guide-ok').click();
}
async function toPage(page: Page, x: number, y: number) {
  const pane = (await page.getByTestId('canvas-pane').boundingBox())!;
  const v = await page.evaluate(([x, y]) => { const s = (window as any).__editorForTests.session; return s.viewport.viewPoint({ x, y }, s.document); }, [x, y]);
  return { x: pane.x + v.x, y: pane.y + v.y };
}
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 6) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

test('QA bug: pressing Escape while holding a guide (without moving it) undoes the previous, unrelated step', async ({ page }) => {
  await canvas(page);
  await newGuide(page, 'Vertical', '100');
  await page.getByTestId('addBlankLayer').click();
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(2);
  await page.getByTestId('tool-move').click();
  const g = await toPage(page, 100, 150);
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  // The guide drag was abandoned: nothing else may change.
  expect(await guides(page)).toEqual([['vertical', 100]]);
  expect((await manifest(page)).layers.length).toBe(2);
});

test('QA guides: the New Guide dialog accepts a German decimal comma', async ({ page }) => {
  await canvas(page, 'de');
  await page.getByTestId('menu-Ansicht').click();
  await page.getByRole('menuitem', { name: /Neue Hilfslinie/ }).click();
  await page.getByRole('radio', { name: 'Vertikal' }).click();
  await page.getByTestId('guide-position').fill('12,5');
  await expect(page.getByTestId('guide-ok')).toBeEnabled();
  await page.getByTestId('guide-ok').click();
  const [orientation, position] = (await guides(page))[0] as [string, number];
  expect(orientation).toBe('vertical');
  console.log('QA guide typed as 12,5 lands at', position);
  expect([12, 12.5, 13]).toContain(position);
  // Garbage is rejected rather than turned into a guide at 0.
  await page.getByTestId('menu-Ansicht').click();
  await page.getByRole('menuitem', { name: /Neue Hilfslinie/ }).click();
  for (const bad of ['abc', '', '12,5,3']) {
    await page.getByTestId('guide-position').fill(bad);
    await expect(page.getByTestId('guide-ok')).toBeDisabled();
  }
});

test('QA guides: Lock Guides blocks creating, moving and clearing; unlocking and Clear Guides work; undo restores them', async ({ page }) => {
  await canvas(page);
  await viewMenu(page, 'Rulers');
  await newGuide(page, 'Horizontal', '120');
  await newGuide(page, 'Vertical', '200');
  await viewMenu(page, 'Lock Guides');
  const pane = (await page.getByTestId('canvas-pane').boundingBox())!;
  // Drag from the top ruler: no guide.
  await drag(page, { x: pane.x + pane.width / 2, y: pane.y + 8 }, { x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 + 50 });
  expect((await guides(page)).length).toBe(2);
  // Move tool on a locked guide: it does not move.
  await page.getByTestId('tool-move').click();
  const g = await toPage(page, 200, 60);
  await drag(page, g, { x: g.x + 40, y: g.y });
  expect(await guides(page)).toEqual([['horizontal', 120], ['vertical', 200]]);
  // Clear Guides and New Guide are disabled while locked.
  await page.getByTestId('menu-View').click();
  await expect(page.getByRole('menuitem', { name: 'Clear Guides' })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: 'New Guide…' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await viewMenu(page, 'Lock Guides');
  await viewMenu(page, 'Clear Guides');
  expect(await guides(page)).toEqual([]);
  await page.getByTestId('compositor-editor').press(`${mod}+z`);
  expect(await guides(page)).toEqual([['horizontal', 120], ['vertical', 200]]);
});

for (const saveHistory of [true, false]) {
  test(`QA ${saveHistory ? 'bug: a project with a guide cannot be reopened when history is saved (the default)' : 'guides: a project with guides reopens when history is not saved'}`, async ({ page }) => {
    await canvas(page);
    await newGuide(page, 'Vertical', '200');
    if (!saveHistory) {
      await page.getByTestId('tab-history').click();
      await page.getByTestId('save-history').uncheck();
    }
    const result = await page.evaluate(async () => {
      const h = (window as any).__handle;
      try { await h.openProject(await h.saveProject()); return 'ok'; } catch (error) { return String(error); }
    });
    expect(result).toBe('ok');
    await expect.poll(() => guides(page)).toEqual([['vertical', 200]]);
  });
}

test('QA guides: a layer dragged with the Move tool snaps to a nearby guide, and does not when snapping is off', async ({ page }) => {
  await canvas(page);
  await importThroughMenu(page, [{ name: 'box.png', mimeType: 'image/png', buffer: solidPng(40, 40, [255, 0, 0, 255]) }]);
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(2);
  await newGuide(page, 'Vertical', '101');
  await page.getByTestId('tool-move').click();
  const box = () => layers(page).then((ls) => ls.find((l) => l.name === 'box').transform.origin);
  const start = await box();
  // Drag so the left edge ends ~3 px right of the guide (away from the canvas centre and edges).
  const from = await toPage(page, start.x + 20, start.y + 20);
  const to = await toPage(page, 101 + 3 + 20, start.y + 20);
  await drag(page, from, to);
  expect((await box()).x).toBe(101);
  await page.getByTestId('compositor-editor').press(`${mod}+z`);
  await viewMenu(page, 'Snap to Guides');
  await drag(page, from, to);
  expect((await box()).x).toBe(104);
});

test('QA align/distribute: folders move as one unit, three layers distribute evenly, one undo step each', async ({ page }) => {
  await canvas(page, 'en', 600, 300);
  for (const [name, w] of [['a', 40], ['b', 60], ['c', 20], ['d', 30]] as const) {
    await importThroughMenu(page, [{ name: `${name}.png`, mimeType: 'image/png', buffer: solidPng(w, 30, [200, 100, 50, 255]) }]);
  }
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(5);
  const byName = async () => Object.fromEntries((await layers(page)).map((l) => [l.name, l]));
  let L = await byName();
  // Place them apart: a at x 10, b at x 150, c at x 500 (y 20), d at x 300 inside a folder with c.
  await page.evaluate((ids) => {
    const s = (window as any).__editorForTests.session;
    const pos: Record<string, [number, number]> = { [ids.a]: [10, 20], [ids.b]: [150, 100], [ids.c]: [500, 200], [ids.d]: [300, 40] };
    s.replaceDocument({ ...s.document, layers: s.document.layers.map((l: any) => pos[l.id] ? { ...l, transform: { ...l.transform, origin: { x: pos[l.id]![0], y: pos[l.id]![1] } } } : l) });
  }, { a: L.a.id, b: L.b.id, c: L.c.id, d: L.d.id });
  await session(page, 'selectLayers', [L.c.id, L.d.id], L.c.id);
  await page.getByTestId('compositor-editor').press(`${mod}+g`);
  await expect.poll(async () => (await layers(page)).some((l) => l.kind === 'group')).toBe(true);
  L = await byName();
  const folder = (await layers(page)).find((l) => l.kind === 'group');
  // Align Left Edges of layer a and the folder: the folder's box (x 300…520) moves left to x 10 as one unit.
  await session(page, 'selectLayers', [L.a.id, folder.id], L.a.id);
  const steps = (await undoNames(page)).length;
  await page.getByTestId('menu-Layer').click();
  await page.getByRole('menuitem', { name: 'Align' }).hover();
  await page.getByRole('menuitem', { name: 'Left Edges' }).click();
  L = await byName();
  expect(L.a.transform.origin.x).toBe(10);
  expect(L.d.transform.origin.x).toBe(10);
  expect(L.c.transform.origin.x).toBe(210);
  expect((await undoNames(page)).length).toBe(steps + 1);
  // Distribute horizontal centres of a, b and the folder.
  await session(page, 'selectLayers', [L.a.id, L.b.id, folder.id], L.a.id);
  await page.evaluate((ids) => {
    const s = (window as any).__editorForTests.session;
    const pos: Record<string, number> = { [ids.b]: 400 };
    s.replaceDocument({ ...s.document, layers: s.document.layers.map((l: any) => pos[l.id] !== undefined ? { ...l, transform: { ...l.transform, origin: { x: pos[l.id]!, y: l.transform.origin.y } } } : l) });
  }, { b: L.b.id });
  await page.getByTestId('menu-Layer').click();
  await page.getByRole('menuitem', { name: 'Distribute' }).hover();
  await page.getByRole('menuitem', { name: 'Horizontal Centers' }).click();
  L = await byName();
  const centres = [L.a.transform.origin.x + 20, L.b.transform.origin.x + 30,
    (Math.min(L.c.transform.origin.x, L.d.transform.origin.x) + Math.max(L.c.transform.origin.x + 20, L.d.transform.origin.x + 30)) / 2].sort((x, y) => x - y);
  console.log('QA distribute centres', centres);
  expect(Math.abs((centres[1]! - centres[0]!) - (centres[2]! - centres[1]!))).toBeLessThanOrEqual(1);
});

test('QA align: one layer aligns to the canvas, or to the selection when there is one; Distribute Horizontal Spacing evens the gaps', async ({ page }) => {
  await canvas(page, 'en', 300, 200);
  for (const [name, w] of [['p', 30], ['q', 50], ['r', 10]] as const) {
    await importThroughMenu(page, [{ name: `${name}.png`, mimeType: 'image/png', buffer: solidPng(w, 20, [10, 200, 90, 255]) }]);
  }
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(4);
  const byName = async () => Object.fromEntries((await layers(page)).map((l) => [l.name, l]));
  let L = await byName();
  await session(page, 'selectLayer', L.q.id);
  await page.getByTestId('menu-Layer').click();
  await page.getByRole('menuitem', { name: 'Align' }).hover();
  await page.getByRole('menuitem', { name: 'Right Edges' }).click();
  L = await byName();
  expect(L.q.transform.origin.x + 50).toBe(300);
  // A rectangular marquee x 40…140: Left Edges puts q at x 40.
  await page.getByTestId('tool-marquee').click();
  await drag(page, await toPage(page, 40, 30), await toPage(page, 140, 130));
  expect(await page.evaluate(() => !!(window as any).__editorForTests.session.selection)).toBe(true);
  await page.getByTestId('menu-Layer').click();
  await page.getByRole('menuitem', { name: 'Align' }).hover();
  await page.getByRole('menuitem', { name: 'Left Edges' }).click();
  L = await byName();
  expect(L.q.transform.origin.x).toBe(40);
  await page.getByTestId('compositor-editor').press(`${mod}+d`);
  // Spacing: p at 0…30, q at 100…150, r at 280…290 → gaps equal.
  await page.evaluate((ids) => {
    const s = (window as any).__editorForTests.session;
    const pos: Record<string, number> = { [ids.p]: 0, [ids.q]: 100, [ids.r]: 280 };
    s.replaceDocument({ ...s.document, layers: s.document.layers.map((l: any) => pos[l.id] !== undefined ? { ...l, transform: { ...l.transform, origin: { x: pos[l.id]!, y: l.transform.origin.y } } } : l) });
  }, { p: L.p.id, q: L.q.id, r: L.r.id });
  await session(page, 'selectLayers', [L.p.id, L.q.id, L.r.id], L.p.id);
  await page.getByTestId('menu-Layer').click();
  await page.getByRole('menuitem', { name: 'Distribute' }).hover();
  await page.getByRole('menuitem', { name: 'Horizontal Spacing' }).click();
  L = await byName();
  const gap1 = L.q.transform.origin.x - (L.p.transform.origin.x + 30), gap2 = L.r.transform.origin.x - (L.q.transform.origin.x + 50);
  console.log('QA spacing gaps', gap1, gap2);
  expect(Math.abs(gap1 - gap2)).toBeLessThanOrEqual(1);
});
