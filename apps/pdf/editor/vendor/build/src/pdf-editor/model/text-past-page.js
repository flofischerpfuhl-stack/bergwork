// PDF.js leaves out every glyph whose origin lies past the page, so a line that
// hangs over the edge reaches the scene cut, or not at all when its baseline is
// outside. PDFium still sees the whole line. Matching the visual line against
// the native objects has to use that whole text, or the line can neither be
// moved back nor retyped without losing its other part.
const compact = text => String(text ?? '').replace(/\s+/g, '').toLowerCase();
const right = box => box.x + box.w;
const bottom = box => box.y + box.h;
const sameLine = (a, b) => Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y) >= Math.min(a.h, b.h) * 0.5;
const overlapsAcross = (a, b) => a.x < right(b) && b.x < right(a);
const validBox = box => box && [box.x, box.y, box.w, box.h].every(Number.isFinite) && box.w > 0 && box.h > 0;

function wholeLineOfItem(item, box, textObjects, pageWidth) {
  const line = textObjects.filter(object => sameLine(object.bbox, box)).sort((a, b) => a.bbox.x - b.bbox.x);
  const touching = line.map((object, index) => overlapsAcross(object.bbox, box) ? index : -1).filter(index => index >= 0);
  if (!touching.length) return null;
  let first = touching[0], last = touching.at(-1);
  const reach = box.h * 1.5;
  const cutRight = right(box) >= pageWidth - reach;
  const cutLeft = box.x <= reach;
  if (cutRight) while (last + 1 < line.length && line[last + 1].bbox.x - right(line[last].bbox) <= reach) last += 1;
  if (cutLeft) while (first > 0 && line[first].bbox.x - right(line[first - 1].bbox) <= reach) first -= 1;
  const members = line.slice(first, last + 1);
  const start = members[0].bbox.x;
  const end = Math.max(...members.map(object => right(object.bbox)));
  const pastRight = cutRight && end > pageWidth + 0.5, pastLeft = cutLeft && start < -0.5;
  if (!pastRight && !pastLeft) return null;
  // The side still on the page keeps PDF.js's text origin, not the ink box.
  const x = pastLeft ? start : box.x;
  const text = members.reduce((joined, object, index) => {
    const gap = index ? object.bbox.x - right(members[index - 1].bbox) : 0;
    return joined + (gap > box.h * 0.15 && !/\s$/.test(joined) ? ' ' : '') + object.text;
  }, '');
  const whole = compact(text), seen = compact(item.str);
  return whole !== seen && whole.includes(seen)
    ? { text, x, w: (pastRight ? end : right(box)) - x, members } : null;
}

/** Returns `items` itself unless a text object reaches past the page. */
export function textItemsWithPastPageText(items, objects, page, { displayRect, itemFromObject, ownedElsewhere }) {
  const pageWidth = Number(page?.width), pageHeight = Number(page?.height);
  if (!(pageWidth > 0 && pageHeight > 0)) return items;
  const textObjects = (objects || []).filter(object => object?.typeName === 'text' && !object.nested &&
    validBox(object.bbox) && compact(object.text) && object.renderMode !== 3);
  const pastPage = textObjects.filter(({ bbox }) => bbox.x < -0.5 || bbox.y < -0.5 ||
    right(bbox) > pageWidth + 0.5 || bottom(bbox) > pageHeight + 0.5);
  if (!pastPage.length) return items;
  const claimed = new Set();
  let changed = false;
  const next = (items || []).map(item => {
    const box = { x: item.sourceX, y: item.sourceY, w: item.sourceW, h: item.sourceH };
    if (!validBox(box) || Math.abs(Number(item.sourceAngle) || 0) > 0.01) return item;
    for (const object of textObjects) if (sameLine(object.bbox, box) && overlapsAcross(object.bbox, box)) claimed.add(object);
    const whole = wholeLineOfItem(item, box, textObjects, pageWidth);
    if (!whole) return item;
    whole.members.forEach(object => claimed.add(object));
    changed = true;
    const shiftX = whole.x - box.x;
    const widen = whole.w - box.w;
    const source = { ...box, x: whole.x, w: whole.w };
    const { x, y, w, h } = displayRect(source);
    return { ...item, str: whole.text, x, y, w, h, sourceX: source.x, sourceW: source.w,
      ...(Number.isFinite(item.sourceBaselineX) ? { sourceBaselineX: item.sourceBaselineX + shiftX } : {}),
      ...(Number.isFinite(item.inlineSize) ? { inlineSize: item.inlineSize + widen } : {}),
      ...(Number.isFinite(item.sourceInlineSize) ? { sourceInlineSize: item.sourceInlineSize + widen } : {}) };
  });
  // Lines PDF.js dropped altogether. Objects wholly off the page stay out, such
  // as printer marks or text a file parked there on purpose, and so do lines an
  // edit or frame already shows: PDF.js reads the file as it was opened.
  for (const object of pastPage) {
    const { bbox } = object;
    if (claimed.has(object) || ownedElsewhere(object) ||
        right(bbox) <= 0 || bottom(bbox) <= 0 || bbox.x >= pageWidth || bbox.y >= pageHeight) continue;
    const item = itemFromObject(object);
    if (!item) continue;
    next.push(item);
    changed = true;
  }
  return changed ? next : items;
}
