const MAX_OBSTACLES = 128;
const MAX_ABS_COORDINATE = 1e9;
const MAX_AA_PADDING = 64;

function aabb(value) {
  if (!value || typeof value !== 'object') return null;
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 ||
      [x, y, width, height].some(number => Math.abs(number) > MAX_ABS_COORDINATE)) return null;
  return Object.freeze({ x, y, width, height });
}

function unionPair(first, second) {
  const left = Math.min(first.x, second.x);
  const top = Math.min(first.y, second.y);
  const right = Math.max(first.x + first.width, second.x + second.width);
  const bottom = Math.max(first.y + first.height, second.y + second.height);
  return Object.freeze({ x: left, y: top, width: right - left, height: bottom - top });
}

function overlap(left, right, padding) {
  return left.x - padding <= right.x + right.width + padding &&
    left.x + left.width + padding >= right.x - padding &&
    left.y - padding <= right.y + right.height + padding &&
    left.y + left.height + padding >= right.y - padding;
}

export function normalizeTextPreviewUpperPaint(input = {}) {
  const targetObjectIndex = input.targetObjectIndex;
  const pageBounds = aabb(input.pageBounds);
  const aaPadding = input.aaPadding == null ? 1 : input.aaPadding;
  const entries = input.obstacles;
  if (!Array.isArray(entries) || entries.length > 100_000 ||
      !Number.isSafeInteger(targetObjectIndex) || targetObjectIndex < 0 || !pageBounds ||
      !Number.isFinite(aaPadding) || aaPadding < 0 || aaPadding > MAX_AA_PADDING) {
    return Object.freeze({ valid: false, reason: 'invalid-paint-order', aaPadding: 0, obstacles: Object.freeze([]) });
  }
  const normalized = [];
  let overflowUnion = null;
  let previousIndex = targetObjectIndex;
  for (const entry of entries) {
    const objectIndex = entry?.objectIndex;
    if (!Number.isSafeInteger(objectIndex) || objectIndex <= previousIndex) {
      return Object.freeze({ valid: false, reason: 'invalid-paint-order', aaPadding, obstacles: Object.freeze([]) });
    }
    previousIndex = objectIndex;
    const bounds = aabb(entry?.bounds) || pageBounds;
    if (overflowUnion) {
      overflowUnion = unionPair(overflowUnion, bounds);
    } else if (normalized.length < MAX_OBSTACLES) {
      normalized.push(bounds);
    } else {
      overflowUnion = normalized.reduce(unionPair, bounds);
      normalized.length = 0;
    }
  }
  const bounded = overflowUnion ? [overflowUnion] : normalized;
  return Object.freeze({
    valid: true,
    reason: overflowUnion ? 'obstacle-union' : '',
    aaPadding,
    pageBounds,
    obstacles: Object.freeze(bounded),
  });
}

export function textPreviewRasterSafety(paintOrder, input = {}) {
  const padding = paintOrder?.aaPadding;
  const provenPage = aabb(paintOrder?.pageBounds);
  if (!paintOrder?.valid || !Array.isArray(paintOrder.obstacles) ||
      paintOrder.obstacles.length > MAX_OBSTACLES || !Number.isFinite(padding) ||
      padding < 0 || padding > MAX_AA_PADDING || !provenPage) {
    return Object.freeze({ safe: false, reason: paintOrder?.reason || 'invalid-paint-order' });
  }
  const source = aabb(input.sourceBounds);
  const dx = input.dx;
  const dy = input.dy;
  if (!source || !Number.isFinite(dx) || !Number.isFinite(dy)) {
    return Object.freeze({ safe: false, reason: 'invalid-preview-translation' });
  }
  const destination = aabb({ ...source, x: source.x + dx, y: source.y + dy });
  if (!destination) return Object.freeze({ safe: false, reason: 'invalid-preview-translation' });
  if (destination.x < provenPage.x || destination.y < provenPage.y ||
      destination.x + destination.width > provenPage.x + provenPage.width ||
      destination.y + destination.height > provenPage.y + provenPage.height) {
    return Object.freeze({ safe: false, reason: 'destination-outside-proven-page' });
  }
  for (const obstacle of paintOrder.obstacles) {
    if (!aabb(obstacle)) return Object.freeze({ safe: false, reason: 'invalid-paint-order' });
    if (overlap(source, obstacle, padding) || overlap(destination, obstacle, padding)) {
      return Object.freeze({ safe: false, reason: 'upper-paint-overlap' });
    }
  }
  return Object.freeze({ safe: true, reason: '', destination });
}

export const TEXT_PREVIEW_MAX_UPPER_PAINT_OBSTACLES = MAX_OBSTACLES;
