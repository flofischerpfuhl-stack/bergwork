const validRect = rect => rect && [rect.x, rect.y, rect.w, rect.h,
  rect.x + rect.w, rect.y + rect.h].every(Number.isFinite) && rect.w >= 0 && rect.h >= 0;

/** Measure the actual empty gap along an alignment guide, in page points.
 * Object overlap is not a gap. For a page guide, choose the closer page edge
 * only when the whole moving rectangle remains within that perpendicular axis.
 * This is display-space measurement: page rotation is already accounted for.
 */
export function snapGuideDistance(guide, moving) {
  if (!guide || !['x', 'y'].includes(guide.axis) || !Number.isFinite(guide.position) ||
      !validRect(moving) || !validRect(guide.targetRect)) return null;
  const axis = guide.axis === 'x' ? 'y' : 'x';
  const extent = axis === 'x' ? 'w' : 'h';
  const a0 = moving[axis], a1 = a0 + moving[extent];
  const b0 = guide.targetRect[axis], b1 = b0 + guide.targetRect[extent];
  let start, end;
  if (guide.source === 'page') {
    if (a0 < b0 || a1 > b1) return null;
    if (a0 - b0 <= b1 - a1) { start = b0; end = a0; }
    else { start = a1; end = b1; }
  } else if (guide.source === 'object') {
    if (a1 < b0) { start = a1; end = b0; }
    else if (b1 < a0) { start = b1; end = a0; }
    else return null;
  } else return null;
  const length = end - start;
  if (!(length > 0) || !Number.isFinite(length)) return null;
  return { axis, position: guide.position, start, end, length };
}

export function snapDistanceLabel(points) {
  if (!(points > 0) || !Number.isFinite(points)) return '';
  // Do not round a positive, very small gap to a misleading zero.
  const value = points < 0.1 ? Number(points.toPrecision(2)) : Math.round(points * 10) / 10;
  return `${value} pt`;
}

/** Place a fixed-budget label around actual selection handles, without a
 * pointer-frame DOM measurement. All inputs/outputs here are CSS pixels. */
export function placeSnapDistanceLabel(center, page, obstacles = []) {
  if (!validRect(page) || page.w < 76 || page.h < 26 ||
      ![center?.x, center?.y].every(Number.isFinite)) return null;
  const halfW = 38, halfH = 13, gap = 4;
  const blocked = obstacles.filter(validRect);
  const clamp = point => ({
    x: Math.max(page.x + halfW, Math.min(page.x + page.w - halfW, point.x)),
    y: Math.max(page.y + halfH, Math.min(page.y + page.h - halfH, point.y)),
  });
  const preferred = clamp(center);
  const candidates = [preferred];
  for (const rect of blocked) candidates.push(
    clamp({ x: rect.x - halfW - gap, y: preferred.y }),
    clamp({ x: rect.x + rect.w + halfW + gap, y: preferred.y }),
    clamp({ x: preferred.x, y: rect.y - halfH - gap }),
    clamp({ x: preferred.x, y: rect.y + rect.h + halfH + gap }),
  );
  candidates.sort((a, b) => Math.hypot(a.x - preferred.x, a.y - preferred.y) -
    Math.hypot(b.x - preferred.x, b.y - preferred.y));
  for (const point of candidates) {
    const rect = { x: point.x - halfW, y: point.y - halfH, w: halfW * 2, h: halfH * 2 };
    if (blocked.every(other => rect.x + rect.w <= other.x - gap || rect.x >= other.x + other.w + gap ||
        rect.y + rect.h <= other.y - gap || rect.y >= other.y + other.h + gap)) return { ...point, rect };
  }
  return null;
}
