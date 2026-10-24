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
  // Huge pages retain page-edge/center snapping instead of building an
  // unbounded object index in a pointer gesture. Never choose an arbitrary
  // first subset of objects, which would make snapping depend on layer order.
  if (boundedTargets) for (const item of targets) {
    if (!item || item.hidden === true || item.id == null) continue;
    const id = String(item.id);
    if (!id || excluded.has(id)) continue;
    add(id, item.rect, 'object');
  }
  return Object.freeze({
    x: Object.freeze(axes.x.sort(compareAnchor)),
    y: Object.freeze(axes.y.sort(compareAnchor)),
    objectLimitExceeded: !boundedTargets,
  });
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
  const result = { ...constrained, guides: [] };
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
    if (!match) continue;
    result[deltaKey] += match.correction;
    result.guides.push({ axis, position: match.target.position, targetId: match.target.id,
      targetRect: match.target.rect, source: match.target.source,
      targetAnchor: match.target.anchor, movingAnchor: match.anchor });
  }
  return result;
}

export { MAX_SNAP_TARGETS };
