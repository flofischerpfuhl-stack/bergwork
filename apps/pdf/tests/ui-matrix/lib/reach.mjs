// Reachability: everything the document draws must be reachable in the editor. The engine's view of a page
// (`session.inspect`, through the corpus harness page) is held against the UI's view (`[data-selection-key]`): each top-level
// object needs a selection node of its kind where it lies on the sheet, and the middle of its edge must hit a selection node
// (a click there selects it or something above it, never nothing). The rule knows no object kind; the report lists the
// difference by type and size.
import { promises as fs } from 'node:fs';

export async function openEnginePage(browser, baseUrl) {
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/__harness/harness.html`);
  await page.waitForFunction(() => window.BW || window.__harnessError, null, { timeout: 60_000 });
  const error = await page.evaluate(() => window.__harnessError);
  if (error) throw new Error(`harness failed to load: ${error}`);
  return page;
}

const sizeClass = box => {
  const thin = Math.min(box.right - box.left, box.top - box.bottom);
  const long = Math.max(box.right - box.left, box.top - box.bottom);
  if (thin < 0.001) return `degenerate line (${long < 1 ? '<1' : '>=1'} pt long)`;
  if (thin < 1) return 'thin < 1 pt';
  if (thin < 3) return 'thin 1-3 pt';
  if (thin < 10) return '3-10 pt';
  return '>= 10 pt';
};

/** @returns {Promise<{ profile: string, total: number, shown: number, outOfView: number, rows: Map<string, object>, hidden: object[] }>} */
export async function checkReachability(session, enginePage, file) {
  const base64 = (await fs.readFile(file.path)).toString('base64');
  const pages = await enginePage.evaluate(job => window.BW.inspectObjects(job), { base64, maxPages: 1 });
  const page = pages[0];
  const result = { profile: file.profile, total: 0, shown: 0, outOfView: 0, skipped: null, rows: new Map(), missing: [], unhittable: [] };
  if (!page || page.rotation) { result.skipped = page ? `page rotated by ${page.rotation}` : 'no page'; return result; }
  const geometry = await session.page.evaluate(() => {
    const sheet = document.querySelector('.oo-pdf-sheet')?.getBoundingClientRect();
    const view = document.querySelector('.oo-pdf-viewport')?.getBoundingClientRect();
    return sheet && view ? { sheet: { x: sheet.left, y: sheet.top, w: sheet.width, h: sheet.height }, view: { l: view.left, t: view.top, r: view.right, b: view.bottom } } : null;
  });
  if (!geometry) { result.skipped = 'no sheet'; return result; }
  const { box } = page;
  const scale = { x: geometry.sheet.w / (box.right - box.left), y: geometry.sheet.h / (box.top - box.bottom) };
  const screen = bounds => ({
    l: geometry.sheet.x + (bounds.left - box.left) * scale.x, r: geometry.sheet.x + (bounds.right - box.left) * scale.x,
    t: geometry.sheet.y + (box.top - bounds.top) * scale.y, b: geometry.sheet.y + (box.top - bounds.bottom) * scale.y,
  });
  const objects = page.objects.filter(object => !object.nested && (object.pageBounds || object.bounds) && !object.flags.hidden);
  const wanted = objects.map(object => {
    const rect = screen(object.pageBounds || object.bounds);
    return { object, rect, mid: { x: (rect.l + rect.r) / 2, y: (rect.t + rect.b) / 2 } };
  });
  const verdicts = await session.page.evaluate(({ items, view }) => {
    const nodes = [...document.querySelectorAll('[data-selection-key]')].map(node => {
      const rect = node.getBoundingClientRect();
      return { key: node.dataset.selectionKey, l: rect.left, t: rect.top, r: rect.right, b: rect.bottom, path: node.classList.contains('type-path') };
    });
    const kindOf = key => (key.startsWith('text:') ? 'text' : key.startsWith('imageRegion:') ? 'image' : key.startsWith('annotation:') ? 'annotation' : 'path');
    return items.map(item => {
      const r = item.rect;
      const inView = item.mid.x > view.l && item.mid.x < view.r - 380 && item.mid.y > view.t + 70 && item.mid.y < view.b - 70;
      const pad = 3;
      const near = nodes.filter(node => node.r >= r.l - pad && node.l <= r.r + pad && node.b >= r.t - pad && node.t <= r.b + pad && kindOf(node.key) === item.kind);
      // The middle of the longer edge of the visible object: what lies there?
      const wide = (r.r - r.l) >= (r.b - r.t);
      const point = wide ? { x: item.mid.x, y: r.t + (r.b - r.t) / 2 } : { x: r.l + (r.r - r.l) / 2, y: item.mid.y };
      const stack = document.elementsFromPoint(point.x, point.y);
      const hit = stack.some(node => node.closest?.('[data-selection-key]'));
      return { inView, shown: near.length > 0, hit, point };
    });
  }, { items: wanted.map(item => ({ rect: item.rect, mid: item.mid, kind: item.object.typeName === 'text' ? 'text' : item.object.typeName === 'image' ? 'image' : 'path' })), view: geometry.view });
  wanted.forEach((item, index) => {
    const verdict = verdicts[index];
    result.total += 1;
    if (!verdict.inView) { result.outOfView += 1; return; }
    const row = `${item.object.typeName} / ${sizeClass(item.object.pageBounds || item.object.bounds)}`;
    const entry = result.rows.get(row) || { seen: 0, noSelection: 0, unhittable: 0 };
    entry.seen += 1;
    if (!verdict.shown) { entry.noSelection += 1; result.missing.push({ row, id: item.object.stableId, bounds: item.object.pageBounds || item.object.bounds }); }
    else result.shown += 1;
    if (verdict.shown && !verdict.hit) { entry.unhittable += 1; result.unhittable.push({ row, id: item.object.stableId }); }
    result.rows.set(row, entry);
  });
  // A real click on the edge middle of a few shown objects: something has to be selected.
  const candidates = wanted.filter((item, index) => verdicts[index].inView && verdicts[index].shown).slice(0, 6);
  for (const item of candidates) {
    const wide = (item.rect.r - item.rect.l) >= (item.rect.b - item.rect.t);
    const x = wide ? item.mid.x : (item.rect.l + item.rect.r) / 2;
    const y = wide ? (item.rect.t + item.rect.b) / 2 : item.mid.y;
    await session.page.mouse.click(x, y);
    await session.settled();
    const selected = await session.page.evaluate(() => !!document.querySelector('[data-selection-key].is-selected, [data-selection-key][aria-pressed="true"]'));
    const row = `${item.object.typeName} / ${sizeClass(item.object.pageBounds || item.object.bounds)}`;
    if (!selected) { result.unhittable.push({ row, id: item.object.stableId, click: true }); const entry = result.rows.get(row); if (entry) entry.unhittable += 1; }
  }
  await session.page.keyboard.press('Escape');
  return result;
}

export function reachLines(results) {
  const lines = ['## Reachability (engine objects against the UI, first page of each file)', ''];
  const table = new Map();
  for (const result of results) {
    if (result.skipped) { lines.push(`- ${result.profile}: not compared (${result.skipped})`); continue; }
    lines.push(`- ${result.profile}: ${result.total} engine objects, ${result.outOfView} out of view, ${result.shown} with a selection in the UI, ` +
      `${result.missing.length} without, ${result.unhittable.length} whose edge middle hits nothing`);
    for (const [row, entry] of result.rows) {
      const sum = table.get(row) || { seen: 0, noSelection: 0, unhittable: 0 };
      sum.seen += entry.seen; sum.noSelection += entry.noSelection; sum.unhittable += entry.unhittable;
      table.set(row, sum);
    }
  }
  lines.push('', '| Type / size | In view | No selection in the UI | Edge middle hits nothing |', '| --- | --- | --- | --- |');
  for (const [row, sum] of [...table].sort()) lines.push(`| ${row} | ${sum.seen} | ${sum.noSelection} | ${sum.unhittable} |`);
  lines.push('', 'No object is excused here: nothing is filtered as "not editable" except engine objects flagged hidden or nested; any other reason has to be named by whoever reads this table.');
  return lines;
}
