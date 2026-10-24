// @ts-check

const TRANSLATION_TOLERANCE = 1e-6;

const SELECTION_COMMANDS = new Set([
  'align-left',
  'align-center',
  'align-right',
  'align-top',
  'align-middle',
  'align-bottom',
]);

const DISTRIBUTION_COMMANDS = new Set([
  'distribute-horizontal',
  'distribute-vertical',
]);

const PAGE_COMMANDS = new Set([
  'page-left',
  'page-center',
  'page-right',
  'page-top',
  'page-middle',
  'page-bottom',
]);

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validItems(items) {
  if (!Array.isArray(items)) return false;
  const keys = new Set();
  for (const item of items) {
    const rect = item?.rect;
    if (
      item?.key == null
      || keys.has(item.key)
      || !rect
      || !finiteNumber(rect.x)
      || !finiteNumber(rect.y)
      || !finiteNumber(rect.w)
      || !finiteNumber(rect.h)
      || rect.w < 0
      || rect.h < 0
    ) return false;
    keys.add(item.key);
  }
  return true;
}

function selectionBounds(items) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const { rect } of items) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.w);
    bottom = Math.max(bottom, rect.y + rect.h);
  }
  return {
    left,
    top,
    right,
    bottom,
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2,
  };
}

function compactTranslations(items, translations) {
  return items.flatMap(item => {
    const translation = translations.get(item.key) || { dx: 0, dy: 0 };
    const dx = Math.abs(translation.dx) <= TRANSLATION_TOLERANCE ? 0 : translation.dx;
    const dy = Math.abs(translation.dy) <= TRANSLATION_TOLERANCE ? 0 : translation.dy;
    return dx === 0 && dy === 0 ? [] : [{ key: item.key, dx, dy }];
  });
}

function alignToSelection(items, command) {
  const bounds = selectionBounds(items);
  return new Map(items.map(item => {
    const { x, y, w, h } = item.rect;
    if (command === 'align-left') return [item.key, { dx: bounds.left - x, dy: 0 }];
    if (command === 'align-center') return [item.key, { dx: bounds.centerX - (x + w / 2), dy: 0 }];
    if (command === 'align-right') return [item.key, { dx: bounds.right - (x + w), dy: 0 }];
    if (command === 'align-top') return [item.key, { dx: 0, dy: bounds.top - y }];
    if (command === 'align-middle') return [item.key, { dx: 0, dy: bounds.centerY - (y + h / 2) }];
    return [item.key, { dx: 0, dy: bounds.bottom - (y + h) }];
  }));
}

function distribute(items, axis) {
  const horizontal = axis === 'horizontal';
  const position = item => horizontal ? item.rect.x : item.rect.y;
  const extent = item => horizontal ? item.rect.w : item.rect.h;
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => position(left.item) - position(right.item) || left.index - right.index);
  const start = ordered.reduce((value, { item }) => Math.min(value, position(item)), Infinity);
  const end = ordered.reduce(
    (value, { item }) => Math.max(value, position(item) + extent(item)),
    -Infinity,
  );
  const occupied = ordered.reduce((total, { item }) => total + extent(item), 0);
  const gap = (end - start - occupied) / (ordered.length - 1);
  const translations = new Map();
  let cursor = start;
  for (const { item } of ordered) {
    const delta = cursor - position(item);
    translations.set(item.key, horizontal ? { dx: delta, dy: 0 } : { dx: 0, dy: delta });
    cursor += extent(item) + gap;
  }
  return translations;
}

function alignSelectionToPage(items, command, pageSize) {
  if (
    !pageSize
    || !finiteNumber(pageSize.width)
    || !finiteNumber(pageSize.height)
    || pageSize.width <= 0
    || pageSize.height <= 0
  ) return null;
  const bounds = selectionBounds(items);
  let dx = 0;
  let dy = 0;
  if (command === 'page-left') dx = -bounds.left;
  else if (command === 'page-center') dx = pageSize.width / 2 - bounds.centerX;
  else if (command === 'page-right') dx = pageSize.width - bounds.right;
  else if (command === 'page-top') dy = -bounds.top;
  else if (command === 'page-middle') dy = pageSize.height / 2 - bounds.centerY;
  else dy = pageSize.height - bounds.bottom;
  return new Map(items.map(item => [item.key, { dx, dy }]));
}

/**
 * Calculate object translations for an arrangement command without changing
 * the input objects. Rectangles use page-view coordinates: x/y is the top-left
 * corner and w/h extends toward the right/bottom.
 *
 * @param {Array<{key: string | number, rect: {x: number, y: number, w: number, h: number}}>} items
 * @param {string} command
 * @param {{width: number, height: number}} pageSize
 * @returns {Array<{key: string | number, dx: number, dy: number}>}
 */
export function arrangeSelection(items, command, pageSize) {
  if (!validItems(items)) return [];
  if (SELECTION_COMMANDS.has(command)) {
    if (items.length < 2) return [];
    return compactTranslations(items, alignToSelection(items, command));
  }
  if (DISTRIBUTION_COMMANDS.has(command)) {
    if (items.length < 3) return [];
    const axis = command === 'distribute-horizontal' ? 'horizontal' : 'vertical';
    return compactTranslations(items, distribute(items, axis));
  }
  if (PAGE_COMMANDS.has(command)) {
    if (items.length < 1) return [];
    const translations = alignSelectionToPage(items, command, pageSize);
    return translations ? compactTranslations(items, translations) : [];
  }
  return [];
}
