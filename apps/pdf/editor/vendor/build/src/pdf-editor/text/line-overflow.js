// @ts-check

// Line editing does not reflow paragraphs. When a retyped line becomes wider
// than the line it replaces, it can silently run over a neighbouring column or
// table cell. This module decides whether the widened part of an upright line
// lands on other page content, and how much horizontal condensing would pull
// it back to its original right edge.

/** Smallest horizontal scale offered by "Fit to original width". */
export const MIN_FIT_SCALE = 0.85;

/**
 * @typedef {{ x: number, y: number, w: number, h: number }} Rect
 */

const finiteRect = rect => rect && [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) &&
  rect.w >= 0 && rect.h >= 0;

const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const contains = (outer, inner, slack = 0.5) => outer.x <= inner.x + slack && outer.y <= inner.y + slack &&
  outer.x + outer.w >= inner.x + inner.w - slack && outer.y + outer.h >= inner.y + inner.h - slack;

const centerInside = (rect, box) => {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h;
};

/**
 * @param {{
 *   line: Rect,                 // the original line, page top-left coordinates
 *   width: number,              // the new line's width in the same units
 *   neighbours: Rect[],         // other page content (text, paths, images)
 *   pageWidth?: number,
 *   tolerance?: number,
 * }} input
 * @returns {null | { overflow: number, fitScale: number, canFit: boolean, collisions: number, leavesPage: boolean }}
 */
export function lineOverflowIntoNeighbours({ line, width, neighbours = [], pageWidth = Infinity, tolerance = 1 }) {
  if (!finiteRect(line) || !(line.w > 0) || !(line.h > 0) || !Number.isFinite(width)) return null;
  const overflow = width - line.w;
  if (overflow <= Math.max(tolerance, line.h * 0.1)) return null;
  // The middle of the line box: ascenders/descenders of the rows above and
  // below touch it without being in the way of the widened text.
  const extension = { x: line.x + line.w, y: line.y + line.h * 0.2, w: overflow, h: line.h * 0.6 };
  let collisions = 0;
  for (const rect of neighbours) {
    if (!finiteRect(rect)) continue;
    // Content the line already sat on (cell fills, backgrounds, its own
    // glyphs) is not a new collision.
    if (contains(rect, line) || centerInside(rect, line)) continue;
    if (intersects(rect, extension)) collisions += 1;
  }
  const leavesPage = Number.isFinite(pageWidth) && line.x + line.w <= pageWidth + 0.5 &&
    line.x + width > pageWidth + 0.5;
  if (!collisions && !leavesPage) return null;
  const fitScale = line.w / width;
  return { overflow, fitScale, canFit: fitScale >= MIN_FIT_SCALE, collisions, leavesPage };
}
