import { constrainMoveDelta } from './drag-constraints.js';

const MAX_SNAP_TARGETS = 5000;
const ANCHORS = Object.freeze([0, 0.5, 1]);

function validRect(value) {
  return value && [value.x, value.y, value.w, value.h, value.x + value.w, value.y + value.h].every(Number.isFinite) &&
    value.w >= 0 && value.h >= 0 && (value.w > 0 || value.h > 0);
}

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const compareAnchor = (left, right) => left.position - right.position ||
  left.priority - right.priority || compareText(left.id, right.id) || left.anchor - right.anchor;

/** Build once when a gesture starts, from current display-space page geometry. */
export function createMoveSnapIndex(pageRect, targets = [], excludedIds = [], manualGuides = []) {
  const excluded = new Set(excludedIds.map(String));
  const axes = { x: [], y: [] };
  const add = (id, rect, source) => {
    if (!validRect(rect)) return;
    const bounds = Object.freeze({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    for (const axis of ['x', 'y']) for (const anchor of ANCHORS) {
      axes[axis].push(Object.freeze({
        id, source, rect: bounds, anchor, priority: source === 'object' ? 0 : 1,
        position: bounds[axis] + bounds[axis === 'x' ? 'w' : 'h'] * anchor,
      }));
    }
  };
  add('page', pageRect, 'page');
  // A manual guide constrains only its own axis. Never manufacture targets at
  // the page corners or perpendicular center from its line-shaped bounds.
  if (validRect(pageRect) && Array.isArray(manualGuides)) for (const guide of manualGuides.slice(0, 64)) {
    if (!guide || !['x', 'y'].includes(guide.axis) || typeof guide.id !== 'string' || !guide.id ||
        !Number.isFinite(guide.position) || guide.position < pageRect[guide.axis] ||
        guide.position > pageRect[guide.axis] + pageRect[guide.axis === 'x' ? 'w' : 'h']) continue;
    const rect = guide.axis === 'x'
      ? { x: guide.position, y: pageRect.y, w: 0, h: pageRect.h }
      : { x: pageRect.x, y: guide.position, w: pageRect.w, h: 0 };
    axes[guide.axis].push(Object.freeze({ id: `guide:${guide.id}`, source: 'manual', rect: Object.freeze(rect),
      anchor: 0, priority: -1, position: guide.position }));
  }
  const boundedTargets = Array.isArray(targets) && targets.length <= MAX_SNAP_TARGETS;
  // berg:work: the object rectangles themselves, for equal-spacing snaps.
  const objects = [];
  // Huge pages retain page-edge/center snapping instead of building an
  // unbounded object index in a pointer gesture. Never choose an arbitrary
  // first subset of objects, which would make snapping depend on layer order.
  if (boundedTargets) for (const item of targets) {
    if (!item || item.hidden === true || item.id == null) continue;
    const id = String(item.id);
    if (!id || excluded.has(id)) continue;
    add(id, item.rect, 'object');
    if (validRect(item.rect) && item.rect.w > 0 && item.rect.h > 0) {
      objects.push(Object.freeze({ id, x: item.rect.x, y: item.rect.y, w: item.rect.w, h: item.rect.h }));
    }
  }
  return Object.freeze({
    x: Object.freeze(axes.x.sort(compareAnchor)),
    y: Object.freeze(axes.y.sort(compareAnchor)),
    objects: Object.freeze(objects),
    objectLimitExceeded: !boundedTargets,
  });
}

// berg:work: equal spacing (Figma's pink gap markers). Along one axis, among the objects that share the moving
// rectangle's row (or column), offer the position that makes the gap to both neighbours equal, or that repeats the
// gap between a neighbour and the next object beyond it. Returns the correction and the gaps to mark.
function closestSpacing(objects, moving, axis, threshold) {
  if (!Array.isArray(objects) || objects.length < 2) return null;
  const across = axis === 'x' ? 'y' : 'x';
  const size = axis === 'x' ? 'w' : 'h';
  const acrossSize = axis === 'x' ? 'h' : 'w';
  const overlaps = rect => Math.min(rect[across] + rect[acrossSize], moving[across] + moving[acrossSize]) -
    Math.max(rect[across], moving[across]) > 0;
  const row = objects.filter(overlaps);
  const start = moving[axis];
  const end = start + moving[size];
  const before = row.filter(rect => rect[axis] + rect[size] <= start + threshold).sort((a, b) => (b[axis] + b[size]) - (a[axis] + a[size]));
  const after = row.filter(rect => rect[axis] >= end - threshold).sort((a, b) => a[axis] - b[axis]);
  const candidates = [];
  const lead = before[0];
  const trail = after[0];
  if (lead && trail) {
    const position = (lead[axis] + lead[size] + trail[axis] - moving[size]) / 2;
    const gap = position - (lead[axis] + lead[size]);
    if (gap > 0) candidates.push({ position, gaps: [[lead[axis] + lead[size], position], [position + moving[size], trail[axis]]], anchors: [lead, trail] });
  }
  if (lead && before[1]) {
    const gap = lead[axis] - (before[1][axis] + before[1][size]);
    if (gap > 0) candidates.push({ position: lead[axis] + lead[size] + gap,
      gaps: [[before[1][axis] + before[1][size], lead[axis]], [lead[axis] + lead[size], lead[axis] + lead[size] + gap]], anchors: [before[1], lead] });
  }
  if (trail && after[1]) {
    const gap = after[1][axis] - (trail[axis] + trail[size]);
    if (gap > 0) candidates.push({ position: trail[axis] - gap - moving[size],
      gaps: [[trail[axis] - gap, trail[axis]], [trail[axis] + trail[size], after[1][axis]]], anchors: [trail, after[1]] });
  }
  let winner = null;
  for (const candidate of candidates) {
    const correction = candidate.position - start;
    const distance = Math.abs(correction);
    if (distance > threshold || (winner && distance >= winner.distance)) continue;
    winner = { ...candidate, correction, distance };
  }
  if (!winner) return null;
  // Markers sit across the middle of the shared band of the moving rectangle and its neighbours.
  const band = [moving, ...winner.anchors];
  const lo = Math.max(...band.map(rect => rect[across]));
  const hi = Math.min(...band.map(rect => rect[across] + rect[acrossSize]));
  const across0 = lo < hi ? (lo + hi) / 2 : moving[across] + moving[acrossSize] / 2;
  return { correction: winner.correction, distance: winner.distance,
    gaps: winner.gaps.map(([a, b]) => ({ start: a, end: b, length: b - a, position: across0 })) };
}

function lowerBound(entries, value) {
  let start = 0, end = entries.length;
  while (start < end) {
    const middle = (start + end) >>> 1;
    if (entries[middle].position < value) start = middle + 1;
    else end = middle;
  }
  return start;
}

function closestAlignment(entries, origin, length, threshold) {
  let winner = null;
  for (const anchor of ANCHORS) {
    const position = origin + length * anchor;
    const right = lowerBound(entries, position);
    const indices = [right];
    if (right > 0) indices.push(lowerBound(entries, entries[right - 1].position));
    for (const index of indices) {
      const target = entries[index];
      if (!target) continue;
      const correction = target.position - position;
      const distance = Math.abs(correction);
      if (distance > threshold) continue;
      const candidate = { target, anchor, correction, distance };
      if (!winner || distance < winner.distance || (distance === winner.distance &&
          (target.priority < winner.target.priority || (target.priority === winner.target.priority &&
            (compareText(target.id, winner.target.id) < 0 || (target.id === winner.target.id &&
              anchor < winner.anchor)))))) winner = candidate;
    }
  }
  return winner;
}

/** Pure move constraint: no document writes, scaling, layout, or worker calls. */
export function resolveMoveSnap(index, rect, rawDx, rawDy, options = {}) {
  const constrained = constrainMoveDelta(rawDx, rawDy, options.shiftKey === true);
  const result = { ...constrained, guides: [], spacing: [] };
  const zoom = Number(options.zoom ?? 1);
  const thresholdPx = Number(options.thresholdPx ?? 6);
  if (options.enabled === false || options.altKey === true || !validRect(rect) ||
      !(zoom > 0) || !Number.isFinite(zoom) || !(thresholdPx >= 0) || !Number.isFinite(thresholdPx) ||
      (!constrained.dx && !constrained.dy) || !Array.isArray(index?.x) || !Array.isArray(index?.y)) return result;
  const constrainedAxis = options.shiftKey === true
    ? Math.abs(Number(rawDx) || 0) >= Math.abs(Number(rawDy) || 0) ? 'y' : 'x'
    : null;
  for (const axis of ['x', 'y']) {
    if (axis === constrainedAxis) continue;
    const deltaKey = axis === 'x' ? 'dx' : 'dy';
    const sizeKey = axis === 'x' ? 'w' : 'h';
    const match = closestAlignment(index[axis], rect[axis] + constrained[deltaKey], rect[sizeKey], thresholdPx / zoom);
    // berg:work: an equal-spacing position wins when it is closer than the nearest alignment.
    const moving = { ...rect, x: rect.x + constrained.dx, y: rect.y + constrained.dy };
    const spacing = closestSpacing(index.objects, moving, axis, thresholdPx / zoom);
    if (spacing && (!match || spacing.distance <= match.distance)) {
      result[deltaKey] += spacing.correction;
      result.spacing.push({ axis, gaps: spacing.gaps });
      continue;
    }
    if (!match) continue;
    result[deltaKey] += match.correction;
    // The aligned position may also space evenly; then both are shown.
    const aligned = { ...moving, [axis]: moving[axis] + match.correction };
    const evenToo = closestSpacing(index.objects, aligned, axis, 0.5);
    if (evenToo) result.spacing.push({ axis, gaps: evenToo.gaps });
    result.guides.push({ axis, position: match.target.position, targetId: match.target.id,
      targetRect: match.target.rect, source: match.target.source,
      targetAnchor: match.target.anchor, movingAnchor: match.anchor });
  }
  return result;
}

export { MAX_SNAP_TARGETS };
