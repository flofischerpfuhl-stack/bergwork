// Finds an object of each type on the page and brings it into a state, with the same gestures a person would use.

export const OBJECT_TYPES = Object.freeze(['text', 'image', 'path', 'shape', 'annotation']);
export const STATES = Object.freeze(['normal', 'rotated', 'moved', 'wrapped', 'edited', 'rotated-page']);

// Which states exist for which type. Wrap and text edits only mean something for text.
export const applicable = (type, state) => !['wrapped', 'edited'].includes(state) || type === 'text';

const describe = (page, key) => page.evaluate(selectionKey => {
  const node = [...document.querySelectorAll('[data-selection-key]')].find(item => item.dataset.selectionKey === selectionKey);
  if (!node) return null;
  const box = node.getBoundingClientRect();
  const surface = node.querySelector(':scope > .oo-pdf-oriented-hit-surface, :scope > .oo-pdf-object-content');
  const transform = surface ? getComputedStyle(surface).transform : getComputedStyle(node).transform;
  const match = /matrix\(([^)]+)\)/.exec(transform || '');
  const values = match ? match[1].split(',').map(Number) : null;
  const polygon = node.querySelector('.oo-pdf-quad-hit-surface polygon');
  return {
    key: selectionKey,
    className: node.className,
    x: box.left, y: box.top, w: box.width, h: box.height,
    angle: values ? Math.round(Math.atan2(values[1], values[0]) * 1800 / Math.PI) / 10 : polygon ? null : 0,
    text: node.dataset.currentText ?? '',
    source: node.getAttribute('aria-label') || '',
  };
}, key);

/** Candidates in the visible part of the page, largest first, with the type the matrix calls them. */
function candidates(page) {
  return page.evaluate(() => {
    const view = document.querySelector('.oo-pdf-viewport')?.getBoundingClientRect();
    const out = [];
    for (const node of document.querySelectorAll('[data-selection-key]')) {
      const box = node.getBoundingClientRect();
      if (!view || box.width < 4 || box.height < 3) continue;
      // Its middle is clicked: that has to be free of the panel and the bars. A wide line may run on behind them.
      const middle = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      if (middle.x < view.left || middle.y < view.top + 70 || middle.x > view.right - 380 || middle.y > view.bottom - 70) continue;
      const key = node.dataset.selectionKey;
      const type = key.startsWith('text:') ? 'text' : key.startsWith('imageRegion:') ? 'image'
        : key.startsWith('annotation:') ? 'annotation' : node.classList.contains('type-path') ? 'path' : 'other';
      out.push({ key, type, area: box.width * box.height, width: box.width, x: box.left, y: box.top, w: box.width, h: box.height,
        locked: node.className.includes('is-locked') });
    }
    return out;
  });
}

async function select(session, object) {
  const { page } = session;
  await page.mouse.click(object.x + object.w / 2, object.y + object.h / 2);
  await session.settled();
  const selected = await page.evaluate(key => {
    const node = [...document.querySelectorAll('[data-selection-key]')].find(item => item.dataset.selectionKey === key);
    return !!node && (node.classList.contains('is-selected') || node.getAttribute('aria-pressed') === 'true');
  }, object.key);
  if (selected) return true;
  // Something lies above it on the page: keyboard focus selects it the way Tab does.
  await page.evaluate(key => [...document.querySelectorAll('[data-selection-key]')].find(item => item.dataset.selectionKey === key)?.focus(), object.key);
  await session.settled();
  return true;
}

async function insertByDrag(session, menu, item, box) {
  const { page } = session;
  await page.getByRole('button', { name: new RegExp(`^${menu}`) }).first().click();
  await page.getByRole('button', { name: item, exact: true }).first().click({ timeout: 4000 }).catch(() =>
    page.getByRole('menuitem', { name: item, exact: true }).first().click({ timeout: 4000 }));
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2, { steps: 4 });
  await page.mouse.move(box.x + box.w, box.y + box.h, { steps: 4 });
  await page.mouse.up();
  await session.settled();
  await page.keyboard.press('v');
  await session.settled();
}

/** A place on the sheet for a new object: a clear quarter of the visible page. */
function freeSpot(page) {
  return page.evaluate(() => {
    const sheet = document.querySelector('.oo-pdf-sheet').getBoundingClientRect();
    return { x: sheet.left + sheet.width * 0.3, y: Math.min(sheet.top + sheet.height * 0.35, 520), w: 90, h: 44 };
  });
}

/** Finds or makes an object of this type and selects it. Null when the page has none and none can be made. */
export async function findObject(session, type) {
  const { page } = session;
  const pick = async wanted => {
    const list = (await candidates(page)).filter(item => item.type === wanted && !item.locked);
    if (wanted === 'text') {
      // A heading-sized run: long enough to have words, not a whole-page OCR box.
      return list.filter(item => item.width > 60 && item.h < 60).sort((left, right) => right.width - left.width)[0] || list[0];
    }
    return list.sort((left, right) => (left.area > 400_000 ? 1 : 0) - (right.area > 400_000 ? 1 : 0) || right.area - left.area)[0];
  };
  if (type === 'shape' || type === 'annotation') {
    const before = new Set((await candidates(page)).map(item => item.key));
    if (type === 'shape') await insertByDrag(session, 'Insert', 'Rect', await freeSpot(page));
    else await insertByDrag(session, 'Markup', 'Highlight', await (async () => {
      const text = await pick('text');
      return text ? { x: text.x + 2, y: text.y + text.h / 2, w: Math.min(text.w - 4, 120), h: 1 } : freeSpot(page);
    })());
    const made = (await candidates(page)).filter(item => !before.has(item.key)).sort((left, right) => right.area - left.area)[0];
    if (!made) return null;
    await select(session, made);
    return { ...made, type };
  }
  const object = await pick(type);
  if (!object) return null;
  await select(session, object);
  return object;
}

const selectedNow = page => page.evaluate(() => {
  const node = document.querySelector('[data-selection-key].is-selected, [data-selection-key][aria-pressed="true"]');
  return node?.dataset.selectionKey || null;
});

export async function currentObject(session, fallbackKey) {
  return describe(session.page, (await selectedNow(session.page)) || fallbackKey);
}

/** Turns the selection with the drag zone just outside its corner, as a person does. */
export async function rotateSelection(session, { key }) {
  const { page } = session;
  const state = await describe(page, key);
  if (!state) return false;
  const depth = await session.historyDepth();
  // The zone just outside a corner, on the side where the page has room to drag.
  const from = { x: state.x + state.w + 8, y: state.y + state.h + 8 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(from.x - step * 7, from.y + step * 11);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
  await session.settled();
  if ((await session.historyDepth()) > depth) return true;
  // A corner over the page edge or under a toolbar: the Angle field turns it just the same.
  await session.enterSurface('inspector', key);
  const angle = page.locator('.oo-pdf-inspector:not(.is-headless) label', { hasText: /^Angle/ }).locator('input').first();
  if (await angle.count()) {
    await angle.fill('30');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await session.settled();
  }
  if ((await session.historyDepth()) > depth) return true;
  await page.locator('.oo-pdf-inspector:not(.is-headless)').getByRole('button', { name: 'Rotate right' }).first().click({ timeout: 3000 }).catch(() => {});
  await session.settled();
  return (await session.historyDepth()) > depth;
}

export async function dragSelection(session, { key }, dx = 36, dy = 24) {
  const { page } = session;
  const state = await describe(page, key);
  if (!state) return false;
  const from = { x: state.x + state.w / 2, y: state.y + state.h / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(from.x + dx * step / 8, from.y + dy * step / 8);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
  await session.settled();
  return true;
}

/** Opens the on-page editor by double click. Returns what opened, without typing. */
export async function openEditor(session, { key }) {
  const { page } = session;
  const state = await describe(page, key);
  if (!state) return null;
  const point = state.angle ? { x: state.x + state.w / 2, y: state.y + state.h / 2 } : { x: state.x + Math.min(30, state.w / 2), y: state.y + state.h / 2 };
  await page.mouse.dblclick(point.x, point.y);
  const started = Date.now();
  const opened = await page.waitForFunction(() => {
    const field = document.querySelector('.oo-pdf-viewport textarea');
    return field && document.activeElement === field;
  }, null, { timeout: 5000 }).then(() => true, () => false);
  return opened ? { ms: Date.now() - started } : null;
}

export async function typeAndCommit(session, suffix) {
  const { page } = session;
  await page.keyboard.press('End');
  await page.keyboard.type(suffix, { delay: 8 });
  await page.keyboard.press('Escape');
  const settled = await session.settled();
  // A subset font without the typed letters asks for another font; the person takes the one offered.
  const offered = page.getByRole('button', { name: /^Use / }).first();
  if (await offered.isVisible().catch(() => false)) {
    await offered.click();
    return session.settled();
  }
  return settled;
}

/** Every text line in view, top to bottom. */
export async function textLines(session) {
  return (await candidates(session.page)).filter(item => item.type === 'text').sort((left, right) => left.y - right.y);
}

export async function applyState(session, object, state) {
  const { page } = session;
  if (state === 'normal') return true;
  if (state === 'rotated') return rotateSelection(session, object);
  if (state === 'moved') return dragSelection(session, object);
  if (state === 'wrapped') {
    const wrap = page.locator('.oo-pdf-inspector label', { hasText: 'Wrap text in a box' }).first();
    if (!(await wrap.count()) || await wrap.locator('input').isDisabled()) return false;
    await wrap.click();
    await session.settled();
    return true;
  }
  if (state === 'edited') {
    if (!(await openEditor(session, object))) return false;
    await typeAndCommit(session, ' ed');
    return true;
  }
  return true;
}

/** The rotated-page state is set before an object is chosen: its frames must be found on the turned page. */
export async function rotatePage(session) {
  await session.page.getByRole('button', { name: 'Rotate page right' }).first().click();
  await session.settled();
}
