// Text markup (Highlight / Underline / StrikeOut) as a property of its text.
//
// The marks stay real PDF annotations, but the editor treats every marked
// line as belonging to the text run it lies on: moving, resizing, rotating,
// retyping or deleting that run carries its marks along, and a reading
// selection over marked text can remove or complete the marking exactly over
// the selected range.
//
// Everything here is pure geometry in display page units (unzoomed, top-left
// origin, y down), the space the shell keeps annotations and text runs in.
// An annotation stores its quads relative to its own box: `{ x, y, w, h }`
// for an upright line and, once rotated with its text, four corner `points`
// (top-left, top-right, bottom-left, bottom-right in text direction; the
// QuadPoints order of the PDF specification) with `x/y/w/h` as their bounds.
//
// Binding is derived from geometry every time it is needed, never stored: a
// quad belongs to a run when it lies on the run's line (vertical overlap of at
// least half the smaller height) and over its width. That is the same rule for
// marks made here and for marks found in an imported PDF, and it survives
// export and reopening because nothing but the geometry has to survive.
// A quad that reaches past the run is split at the run's edge; each piece
// follows its own run while the annotation stays one annotation (one /Popup,
// one reply thread).

export const TEXT_MARKUP_ANNOTATION_TYPES = Object.freeze(['highlight', 'underline', 'strikeout']);
const MARKUP_TYPES = new Set(TEXT_MARKUP_ANNOTATION_TYPES);

export function isTextMarkupAnnotation(annotation) {
  return MARKUP_TYPES.has(annotation?.type);
}

/**
 * A mark made over text lines (it has quads). A highlight drawn freely as a
 * box (over a scan, say) has none; it is a region, not a property of text,
 * and keeps behaving as a shape.
 */
export function isTextLineMarkup(annotation) {
  return isTextMarkupAnnotation(annotation) && Array.isArray(annotation.quads) && annotation.quads.length > 0;
}

const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

function boundsOfPoints(points) {
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function quadHasArea(quad) {
  return quad && quad.w > 0 && quad.h > 0;
}

/** The annotation's marked lines in page units. A mark without quads marks its box. */
export function absoluteMarkupQuads(annotation = {}) {
  const ox = finite(annotation.x);
  const oy = finite(annotation.y);
  const quads = Array.isArray(annotation.quads) ? annotation.quads : [];
  const result = [];
  for (const quad of quads) {
    if (!quad) continue;
    if (Array.isArray(quad.points) && quad.points.length === 4) {
      const points = quad.points.map(point => [ox + finite(point[0]), oy + finite(point[1])]);
      const bounds = boundsOfPoints(points);
      if (!(bounds.w > 0 || bounds.h > 0)) continue;
      result.push({ ...bounds, points });
      continue;
    }
    const absolute = { x: ox + finite(quad.x), y: oy + finite(quad.y), w: finite(quad.w), h: finite(quad.h) };
    if (quadHasArea(absolute)) result.push(absolute);
  }
  if (result.length || quads.length) return result;
  const box = { x: ox, y: oy, w: finite(annotation.w), h: finite(annotation.h) };
  return quadHasArea(box) ? [box] : [];
}

/** The annotation with these page-unit quads, its box their union; null when none is left. */
export function markupWithAbsoluteQuads(annotation, quads) {
  const usable = (quads || []).filter(quad => quad && (quad.points ? true : quadHasArea(quad)));
  if (!usable.length) return null;
  const x = Math.min(...usable.map(quad => quad.x));
  const y = Math.min(...usable.map(quad => quad.y));
  const right = Math.max(...usable.map(quad => quad.x + quad.w));
  const bottom = Math.max(...usable.map(quad => quad.y + quad.h));
  return {
    ...annotation,
    x, y, w: right - x, h: bottom - y,
    quads: usable.map(quad => (quad.points
      ? {
          x: quad.x - x, y: quad.y - y, w: quad.w, h: quad.h,
          points: quad.points.map(point => [point[0] - x, point[1] - y]),
        }
      : { x: quad.x - x, y: quad.y - y, w: quad.w, h: quad.h })),
  };
}

// The part of a line mark that lies on one text run; a sliver at either end
// shorter than this fraction of the line height belongs to the run as well.
const OVERHANG_FRACTION = 0.3;

function verticalOverlap(a, b) {
  return Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
}

/** True when the quad lies on the line of `box` (or on the line `box` is). */
export function quadOnLine(quad, box) {
  const overlap = verticalOverlap(quad, box);
  return overlap > 0 && overlap >= 0.5 * Math.min(quad.h, box.h);
}

/**
 * Split one page-unit quad at the edges of a text run box: `inside` is the
 * piece on the run (or null), `outside` the pieces beyond it. A rotated quad is
 * not split; it belongs to the run its centre lies on.
 */
export function splitQuadByTextBox(quad, box) {
  if (!quad || !box || !(box.w > 0) || !(box.h > 0)) return { inside: null, outside: quad ? [quad] : [] };
  if (quad.points) {
    const cx = quad.x + quad.w / 2;
    const cy = quad.y + quad.h / 2;
    const inside = cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h;
    return inside ? { inside: quad, outside: [] } : { inside: null, outside: [quad] };
  }
  if (!quadOnLine(quad, box)) return { inside: null, outside: [quad] };
  const tolerance = Math.max(0.5, OVERHANG_FRACTION * Math.min(quad.h, box.h));
  const quadRight = quad.x + quad.w;
  const boxRight = box.x + box.w;
  const left = Math.max(quad.x, box.x);
  const right = Math.min(quadRight, boxRight);
  if (right - left <= tolerance) return { inside: null, outside: [quad] };
  const outside = [];
  let insideLeft = left;
  let insideRight = right;
  if (left - quad.x > tolerance) outside.push({ ...quad, w: left - quad.x });
  else insideLeft = quad.x;
  if (quadRight - right > tolerance) outside.push({ ...quad, x: right, w: quadRight - right });
  else insideRight = quadRight;
  return { inside: { ...quad, x: insideLeft, w: insideRight - insideLeft }, outside };
}

/** The pieces of a mark on a text run (`inside`) and elsewhere (`outside`). */
export function splitMarkupByTextBox(annotation, box) {
  const inside = [];
  const outside = [];
  for (const quad of absoluteMarkupQuads(annotation)) {
    const split = splitQuadByTextBox(quad, box);
    if (split.inside) inside.push(split.inside);
    outside.push(...split.outside);
  }
  return { inside, outside };
}

/** Markup annotations of `pageId` with at least one marked piece on the run `box`. */
export function textMarkupBoundToBox(annotations, pageId, box) {
  if (!box || !(box.w > 0) || !(box.h > 0)) return [];
  const bound = [];
  for (const annotation of annotations || []) {
    if (!isTextLineMarkup(annotation) || annotation.pageId !== pageId) continue;
    const split = splitMarkupByTextBox(annotation, box);
    if (split.inside.length) bound.push({ annotation, ...split });
  }
  return bound;
}

// ---------------------------------------------------------------------------
// Following a text run.

function mapPoint(point, transform) {
  const [x, y] = point;
  if (transform.kind === 'rotate') {
    const cos = Math.cos(transform.radians);
    const sin = Math.sin(transform.radians);
    const dx = x - transform.cx;
    const dy = y - transform.cy;
    return [transform.cx + dx * cos - dy * sin + finite(transform.dx), transform.cy + dx * sin + dy * cos + finite(transform.dy)];
  }
  if (transform.kind === 'map') {
    const { from, to } = transform;
    const sx = from.w > 0 ? to.w / from.w : 1;
    const sy = from.h > 0 ? to.h / from.h : 1;
    return [to.x + (x - from.x) * sx, to.y + (y - from.y) * sy];
  }
  return [x + finite(transform.dx), y + finite(transform.dy)];
}

function cornersOf(quad) {
  return quad.points || [
    [quad.x, quad.y], [quad.x + quad.w, quad.y],
    [quad.x, quad.y + quad.h], [quad.x + quad.w, quad.y + quad.h],
  ];
}

const AXIS_EPSILON = 1e-6;

/** One page-unit quad under a run transform (translate, box map or rotation). */
export function transformMarkupQuad(quad, transform) {
  if (!transform || transform.kind === 'translate') {
    const dx = finite(transform?.dx);
    const dy = finite(transform?.dy);
    return quad.points
      ? { x: quad.x + dx, y: quad.y + dy, w: quad.w, h: quad.h, points: quad.points.map(point => [point[0] + dx, point[1] + dy]) }
      : { ...quad, x: quad.x + dx, y: quad.y + dy };
  }
  const points = cornersOf(quad).map(point => mapPoint(point, transform));
  const bounds = boundsOfPoints(points);
  // An upright line stays a plain box when the transform keeps it upright
  // (box maps, quarter turns); only a slanted line needs its four corners.
  const upright = Math.abs(points[0][1] - points[1][1]) < AXIS_EPSILON &&
    Math.abs(points[0][0] - points[2][0]) < AXIS_EPSILON &&
    points[1][0] > points[0][0] && points[2][1] > points[0][1];
  return upright ? bounds : { ...bounds, points };
}

function clipQuadToBox(quad, box) {
  if (quad.points) {
    const cx = quad.x + quad.w / 2;
    const cy = quad.y + quad.h / 2;
    return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h ? quad : null;
  }
  const x = Math.max(quad.x, box.x);
  const right = Math.min(quad.x + quad.w, box.x + box.w);
  const y = Math.max(quad.y, box.y - quad.h * 0.25);
  const bottom = Math.min(quad.y + quad.h, box.y + box.h + quad.h * 0.25);
  if (right - x <= Math.max(0.5, OVERHANG_FRACTION * quad.h) || bottom - y <= quad.h * 0.5) return null;
  return { ...quad, x, w: right - x };
}

function proportionalMeasure(text) {
  return Array.from(String(text || '')).length;
}

function commonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function commonSuffixLength(left, right, prefix) {
  const limit = Math.min(left.length, right.length) - prefix;
  let index = 0;
  while (index < limit && left[left.length - 1 - index] === right[right.length - 1 - index]) index += 1;
  return index;
}

/**
 * Where the characters of a single-line run sit horizontally: boundary `i`
 * (before character i) at `box.x + box.w * measure(text[0:i]) / measure(text)`.
 * The reading layer places its selectable text the same way, so marks made
 * from a reading selection map back to the characters they were made over.
 */
function characterBoundaries(text, box, measure) {
  const characters = Array.from(text);
  const total = Math.max(1e-9, measure(text));
  const boundaries = [box.x];
  let prefix = '';
  for (const character of characters) {
    prefix += character;
    boundaries.push(box.x + box.w * Math.min(1, measure(prefix) / total));
  }
  return boundaries;
}

function nearestBoundary(boundaries, x) {
  let best = 0;
  for (let index = 1; index < boundaries.length; index += 1) {
    if (Math.abs(boundaries[index] - x) < Math.abs(boundaries[best] - x)) best = index;
  }
  return best;
}

/**
 * Keep line marks over the same characters when a single-line run is
 * retyped. Marks over unchanged text keep their characters (shifted by what
 * was inserted before them); a mark that spans the whole change (also exactly
 * a typed-over word) grows or shrinks with it; a mark partly over replaced
 * characters keeps only its unchanged part; a mark only over some of the
 * replaced characters is dropped.
 */
export function remapQuadsForTextChange(quads, { from, to, oldText, newText, measure = proportionalMeasure }) {
  const oldChars = Array.from(String(oldText ?? ''));
  const newChars = Array.from(String(newText ?? ''));
  if (!oldChars.length || !newChars.length || !(from?.w > 0) || !(to?.w > 0)) return [];
  const oldBoundaries = characterBoundaries(oldChars.join(''), from, measure);
  const newBoundaries = characterBoundaries(newChars.join(''), to, measure);
  const prefix = commonPrefixLength(oldChars, newChars);
  const suffix = commonSuffixLength(oldChars, newChars, prefix);
  const changeStart = prefix;
  const oldChangeEnd = oldChars.length - suffix;
  const delta = newChars.length - oldChars.length;
  const dy = finite(to.y) - finite(from.y);
  const result = [];
  for (const quad of quads) {
    if (quad.points) continue;
    const i0 = nearestBoundary(oldBoundaries, quad.x);
    const i1 = nearestBoundary(oldBoundaries, quad.x + quad.w);
    if (i1 <= i0) continue;
    let j0;
    let j1;
    if (i1 <= changeStart) {
      j0 = i0; j1 = i1;
    } else if (i0 >= oldChangeEnd) {
      j0 = i0 + delta; j1 = i1 + delta;
    } else if (i0 <= changeStart && i1 >= oldChangeEnd) {
      j0 = i0; j1 = i1 + delta;
    } else if (i0 < changeStart) {
      j0 = i0; j1 = changeStart;
    } else if (i1 > oldChangeEnd) {
      j0 = oldChangeEnd + delta; j1 = i1 + delta;
    } else {
      continue;
    }
    j0 = Math.max(0, Math.min(newChars.length, j0));
    j1 = Math.max(0, Math.min(newChars.length, j1));
    if (j1 <= j0 || !newChars.slice(j0, j1).join('').trim()) continue;
    const x = newBoundaries[j0];
    const right = newBoundaries[j1];
    if (!(right > x)) continue;
    result.push({ ...quad, x, w: right - x, y: quad.y + dy });
  }
  return result;
}

function singleLine(quads, box) {
  if (!quads.length) return true;
  const top = Math.min(...quads.map(quad => quad.y));
  const bottom = Math.max(...quads.map(quad => quad.y + quad.h));
  const lineHeight = Math.max(...quads.map(quad => quad.h));
  return bottom - top <= lineHeight * 1.5 && box.h <= lineHeight * 2.2;
}

/**
 * New page-unit quads for the marked pieces of a run (`inside`) after the
 * run changes from `from` to `to`.
 *
 * - `move`: translated with the run (also onto another page).
 * - `scale`: the run's glyphs are scaled; the marks are mapped box to box.
 * - `reflow`: the run is a text frame whose width/height changed and whose
 *   lines may wrap differently; marks keep their place relative to the frame's
 *   top-left and are clipped to the new frame (lines rewrapped elsewhere are
 *   not followed: there is no exact character mapping without the new glyphs).
 * - `rotate`: rotated by `degrees` (clockwise on the page) about the run's centre.
 * - `text`: the run was retyped (`oldText` -> `newText`); see remapQuadsForTextChange.
 *   Multi-line runs keep only the marks above the first changed line.
 * - `delete`: the run is gone and so are its marks.
 */
export function followedMarkupQuads(inside, { mode, from, to, degrees = 0, oldText = '', newText = '', measure }) {
  if (mode === 'delete') return [];
  if (mode === 'rotate') {
    const radians = finite(degrees) * Math.PI / 180;
    const cx = from.x + from.w / 2;
    const cy = from.y + from.h / 2;
    const dx = finite(to?.x, from.x) + finite(to?.w, from.w) / 2 - cx;
    const dy = finite(to?.y, from.y) + finite(to?.h, from.h) / 2 - cy;
    return inside.map(quad => transformMarkupQuad(quad, { kind: 'rotate', cx, cy, radians, dx, dy }));
  }
  if (mode === 'scale') {
    return inside.map(quad => transformMarkupQuad(quad, { kind: 'map', from, to }));
  }
  const translated = inside.map(quad => transformMarkupQuad(quad, { kind: 'translate', dx: to.x - from.x, dy: to.y - from.y }));
  if (mode === 'reflow') {
    return translated.map(quad => clipQuadToBox(quad, to)).filter(Boolean);
  }
  if (mode === 'text') {
    const sameWidth = Math.abs(finite(to.w, from.w) - from.w) <= 0.01;
    if (oldText === newText && sameWidth) return translated;
    // Same characters in a wider or narrower run (a font change): each mark
    // stays over its characters.
    if (singleLine(inside, from)) return remapQuadsForTextChange(inside, { from, to, oldText, newText, measure });
    if (oldText === newText) return translated;
    // A multi-line run: lines above the one holding the first change keep
    // their characters; everything from there on may have moved.
    const oldLines = String(oldText).split('\n');
    const prefix = commonPrefixLength(Array.from(String(oldText)), Array.from(String(newText)));
    const changedLine = Array.from(String(oldText)).slice(0, prefix).join('').split('\n').length - 1;
    const lineHeight = from.h / Math.max(1, oldLines.length);
    const cutoff = from.y + changedLine * lineHeight;
    return translated.filter((quad, index) => inside[index].y + inside[index].h <= cutoff + lineHeight * 0.25);
  }
  return translated;
}

/**
 * The marks that change when text runs change. Each run is `{ pageId, from,
 * to, mode, degrees, oldText, newText, measure }` (`to.pageId` when it moves
 * to another page). Every marked piece belongs to the first run it lies on.
 * Returns `{ updates, inserts }`: `updates` maps annotation id -> next
 * annotation, or null when nothing of it is left; `inserts` are new
 * annotations (pieces carried to another page become a mark of the same kind
 * there, named by `createId(annotation, pageId)`). `onlyIds` restricts the
 * marks to those bound when a gesture started.
 */
export function planTextMarkupFollowRuns(annotations, runs, { createId, onlyIds = null } = {}) {
  const updates = new Map();
  const inserts = [];
  const usable = (runs || []).filter(run => run?.pageId && run.from?.w > 0 && run.from?.h > 0);
  if (!usable.length) return { updates, inserts };
  for (const annotation of annotations || []) {
    if (!isTextLineMarkup(annotation)) continue;
    if (onlyIds && !onlyIds.has(annotation.id)) continue;
    let remaining = absoluteMarkupQuads(annotation);
    const stay = [];
    const carried = new Map();
    let touched = false;
    for (const run of usable) {
      if (run.pageId !== annotation.pageId) continue;
      const inside = [];
      const rest = [];
      for (const quad of remaining) {
        const split = splitQuadByTextBox(quad, run.from);
        if (split.inside) inside.push(split.inside);
        rest.push(...split.outside);
      }
      remaining = rest;
      if (!inside.length) continue;
      touched = true;
      const followed = run.mode === 'delete' ? [] : followedMarkupQuads(inside, { ...run, to: run.to || run.from });
      const targetPageId = run.to?.pageId || run.pageId;
      if (targetPageId === annotation.pageId) stay.push(...followed);
      else carried.set(targetPageId, [...(carried.get(targetPageId) || []), ...followed]);
    }
    if (!touched) continue;
    const next = markupWithAbsoluteQuads(annotation, [...remaining, ...stay]);
    if (!sameMarkupGeometry(annotation, next)) updates.set(annotation.id, next);
    for (const [pageId, quads] of carried) {
      const moved = markupWithAbsoluteQuads(annotation, quads);
      if (!moved || typeof createId !== 'function') continue;
      const id = createId(annotation, pageId);
      const {
        annotationIndex, annotationObjectNumber, sourceAnnotationId, liveCommitted, replies, replyCount, modified, ...rest
      } = moved;
      inserts.push({ ...rest, id, pageId, liveStableId: `pdf-annotation-${id}`, imported: false });
    }
  }
  return { updates, inserts };
}

/** planTextMarkupFollowRuns for one run (`{ pageId, from, to, mode, ... , createId, onlyIds }`). */
export function planTextMarkupFollow(annotations, { createId, onlyIds = null, ...run } = {}) {
  return planTextMarkupFollowRuns(annotations, [run], { createId, onlyIds });
}

/** Ids a plan touches: updated, removed and inserted marks. */
export function textMarkupPlanIds(plan) {
  return [...(plan?.updates?.keys() || []), ...(plan?.inserts || []).map(item => item.id)];
}

const GEOMETRY_EPSILON = 1e-4;

/** True when two marks cover the same lines of the same page (in any quad order). */
export function sameMarkupGeometry(left, right) {
  if (!left || !right) return left === right;
  if (left.pageId !== right.pageId) return false;
  const order = (x, y) => x.y - y.y || x.x - y.x || x.w - y.w;
  const a = absoluteMarkupQuads(left).sort(order);
  const b = absoluteMarkupQuads(right).sort(order);
  if (a.length !== b.length) return false;
  const close = (x, y) => Math.abs(Number(x) - Number(y)) <= GEOMETRY_EPSILON;
  return a.every((quad, index) => {
    const other = b[index];
    if (Boolean(quad.points) !== Boolean(other.points)) return false;
    if (quad.points) return quad.points.every((point, corner) => close(point[0], other.points[corner][0]) && close(point[1], other.points[corner][1]));
    return close(quad.x, other.x) && close(quad.y, other.y) && close(quad.w, other.w) && close(quad.h, other.h);
  });
}

/** `annotations` with a follow plan applied (order kept, inserts appended). */
export function applyTextMarkupPlan(annotations, plan) {
  if (!plan || (!plan.updates?.size && !plan.inserts?.length)) return annotations;
  const inserted = new Set((plan.inserts || []).map(item => item.id));
  const next = [];
  for (const annotation of annotations || []) {
    // Applying the same plan twice (a gesture re-publishing its prediction)
    // replaces its inserts instead of adding them again.
    if (inserted.has(annotation.id)) continue;
    if (!plan.updates.has(annotation.id)) { next.push(annotation); continue; }
    const value = plan.updates.get(annotation.id);
    if (value) next.push(value);
  }
  return [...next, ...(plan.inserts || [])];
}

// ---------------------------------------------------------------------------
// Reading selection: pressed / mixed state, removal and completion.

function lineInterval(quad, line) {
  if (quad.points || !quadOnLine(quad, line)) return null;
  const left = Math.max(quad.x, line.x);
  const right = Math.min(quad.x + quad.w, line.x + line.w);
  return right > left ? [left, right] : null;
}

function unionLength(intervals) {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let current = null;
  for (const interval of sorted) {
    if (!current || interval[0] > current[1]) {
      if (current) total += current[1] - current[0];
      current = [...interval];
    } else {
      current[1] = Math.max(current[1], interval[1]);
    }
  }
  if (current) total += current[1] - current[0];
  return total;
}

function lineTolerance(line) {
  return Math.max(1, line.h * 0.35);
}

/**
 * How much of the selected lines carries marks of `type` on `pageId`:
 * 'full' (every selected line is marked over its whole selected width),
 * 'mixed' (part of it) or 'none'.
 */
export function textMarkupSelectionState(annotations, pageId, type, lines) {
  const usable = (lines || []).filter(line => line.w > 0 && line.h > 0);
  if (!usable.length) return 'none';
  const quads = (annotations || [])
    .filter(annotation => annotation.type === type && annotation.pageId === pageId && isTextLineMarkup(annotation))
    .flatMap(annotation => absoluteMarkupQuads(annotation));
  let anyCovered = false;
  let allCovered = true;
  for (const line of usable) {
    const covered = unionLength(quads.map(quad => lineInterval(quad, line)).filter(Boolean));
    if (covered > lineTolerance(line) * 0.5) anyCovered = true;
    if (line.w - covered > lineTolerance(line)) allCovered = false;
  }
  if (!anyCovered) return 'none';
  return allCovered ? 'full' : 'mixed';
}

/** One quad minus the selected part of its line (0, 1 or 2 pieces). */
function subtractLineFromQuad(quad, line) {
  if (quad.points) {
    const cx = quad.x + quad.w / 2;
    const cy = quad.y + quad.h / 2;
    return cx >= line.x && cx <= line.x + line.w && cy >= line.y && cy <= line.y + line.h ? [] : [quad];
  }
  if (!quadOnLine(quad, line)) return [quad];
  const tolerance = lineTolerance(line);
  const left = Math.max(quad.x, line.x);
  const right = Math.min(quad.x + quad.w, line.x + line.w);
  if (right - left <= 0) return [quad];
  const pieces = [];
  if (left - quad.x > tolerance) pieces.push({ ...quad, w: left - quad.x });
  if (quad.x + quad.w - right > tolerance) pieces.push({ ...quad, x: right, w: quad.x + quad.w - right });
  return pieces;
}

/**
 * The annotation without its marks over the selected lines: the same object
 * when nothing of it is selected, null when nothing of it is left.
 */
export function removeLinesFromMarkup(annotation, lines) {
  if (!isTextLineMarkup(annotation)) return annotation;
  let quads = absoluteMarkupQuads(annotation);
  let changed = false;
  for (const line of lines || []) {
    const next = [];
    for (const quad of quads) {
      const pieces = subtractLineFromQuad(quad, line);
      if (pieces.length !== 1 || pieces[0] !== quad) changed = true;
      next.push(...pieces);
    }
    quads = next;
  }
  if (!changed) return annotation;
  return markupWithAbsoluteQuads(annotation, quads);
}

/** The selected pieces not yet carrying a mark of `type` (one box per gap). */
export function unmarkedLinePieces(annotations, pageId, type, lines) {
  const quads = (annotations || [])
    .filter(annotation => annotation.type === type && annotation.pageId === pageId && isTextLineMarkup(annotation))
    .flatMap(annotation => absoluteMarkupQuads(annotation));
  const pieces = [];
  for (const line of lines || []) {
    if (!(line.w > 0) || !(line.h > 0)) continue;
    const covered = quads.map(quad => lineInterval(quad, line)).filter(Boolean).sort((a, b) => a[0] - b[0]);
    let cursor = line.x;
    const tolerance = lineTolerance(line);
    for (const [left, right] of covered) {
      if (left - cursor > tolerance) pieces.push({ x: cursor, y: line.y, w: left - cursor, h: line.h });
      cursor = Math.max(cursor, right);
    }
    if (line.x + line.w - cursor > tolerance) pieces.push({ x: cursor, y: line.y, w: line.x + line.w - cursor, h: line.h });
  }
  return pieces;
}

/** True when the mark has a line touching one of the selected lines. */
export function markupTouchesLines(annotation, lines) {
  if (!isTextLineMarkup(annotation)) return false;
  const quads = absoluteMarkupQuads(annotation);
  return (lines || []).some(line => quads.some(quad => {
    if (quad.points || !quadOnLine(quad, line)) return false;
    const gap = Math.max(quad.x, line.x) - Math.min(quad.x + quad.w, line.x + line.w);
    return gap <= lineTolerance(line);
  }));
}

/**
 * The annotation with `pieces` added, each merged into a quad of the same
 * line it touches so a line keeps one quad.
 */
export function addPiecesToMarkup(annotation, pieces) {
  const quads = absoluteMarkupQuads(annotation);
  for (const piece of pieces || []) {
    const tolerance = lineTolerance(piece);
    const touching = quads.filter(quad => !quad.points && quadOnLine(quad, piece) &&
      Math.max(quad.x, piece.x) - Math.min(quad.x + quad.w, piece.x + piece.w) <= tolerance);
    if (!touching.length) { quads.push({ ...piece }); continue; }
    const merged = [piece, ...touching];
    const x = Math.min(...merged.map(quad => quad.x));
    const right = Math.max(...merged.map(quad => quad.x + quad.w));
    // Keep the line height the existing mark already has.
    const keep = touching[0];
    const replacement = { x, y: keep.y, w: right - x, h: keep.h };
    for (const quad of touching) quads.splice(quads.indexOf(quad), 1);
    quads.push(replacement);
  }
  quads.sort((a, b) => a.y - b.y || a.x - b.x);
  return markupWithAbsoluteQuads(annotation, quads);
}
