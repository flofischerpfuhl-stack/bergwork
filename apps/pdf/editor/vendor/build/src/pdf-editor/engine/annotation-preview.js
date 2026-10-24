export function annotationPreviewDimensions(bounds, maxEdge, maxPixels) {
  const sourceWidth = Math.abs(Number(bounds?.right) - Number(bounds?.left));
  const sourceHeight = Math.abs(Number(bounds?.top) - Number(bounds?.bottom));
  if (!(sourceWidth > 0 && sourceHeight > 0) || ![sourceWidth, sourceHeight, maxEdge, maxPixels].every(Number.isFinite)) return null;
  const scale = Math.min(4, Number(maxEdge) / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  return width <= maxEdge && height <= maxEdge && width * height <= maxPixels
    ? { sourceWidth, sourceHeight, width, height }
    : null;
}

export function copyBgraBitmapToRgba(heap, buffer, stride, width, height) {
  if (!(heap instanceof Uint8Array) || !Number.isSafeInteger(buffer) || buffer < 0 ||
      !Number.isSafeInteger(stride) || stride < width * 4 ||
      !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1 ||
      buffer + stride * height > heap.byteLength) return null;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const source = buffer + y * stride + x * 4;
    const target = (y * width + x) * 4;
    pixels[target] = heap[source + 2];
    pixels[target + 1] = heap[source + 1];
    pixels[target + 2] = heap[source];
    pixels[target + 3] = heap[source + 3];
  }
  return pixels;
}

export const normalizeAnnotationRotation = value => ((Number(value) % 360) + 360) % 360;

const COMMITTED_ANNOTATION_APPEARANCE_ACTIONS = new Set([
  'annotation.insert',
  'annotation.update',
  'annotation.delete',
]);

export function committedAnnotationAppearanceGenerations(previous, effects, committedRevision) {
  const current = previous instanceof Map ? previous : new Map();
  const revision = Number(committedRevision);
  if (!Number.isSafeInteger(revision) || revision < 1 || !Array.isArray(effects)) return current;
  let next = null;
  for (const effect of effects) {
    if (!COMMITTED_ANNOTATION_APPEARANCE_ACTIONS.has(effect?.action)) continue;
    const stableId = typeof effect?.stableId === 'string' ? effect.stableId.trim() : '';
    if (!stableId || stableId.length > 512) continue;
    if ((next || current).get(stableId) === revision) continue;
    next ||= new Map(current);
    next.set(stableId, revision);
  }
  return next || current;
}

export function committedAnnotationAppearanceGeneration(generations, stableId) {
  if (!(generations instanceof Map) || typeof stableId !== 'string' || !stableId) return 0;
  const generation = Number(generations.get(stableId));
  return Number.isSafeInteger(generation) && generation > 0 ? generation : 0;
}

export function annotationPreviewVersion({ sessionId, publishedPageEpoch, rotation }) {
  const epoch = Number(publishedPageEpoch);
  if (!Number.isSafeInteger(epoch) || epoch < 0) return null;
  return `${String(sessionId || '')}:${epoch}:${Number(rotation) || 0}`;
}

export function annotationDisplayPreviewTransform(bounds, displayMatrix, width, height) {
  const values = [bounds?.left, bounds?.bottom, bounds?.right, bounds?.top,
    displayMatrix?.a, displayMatrix?.b, displayMatrix?.c, displayMatrix?.d, displayMatrix?.e, displayMatrix?.f,
    width, height].map(Number);
  if (!values.every(Number.isFinite) || !(width > 0 && height > 0)) return null;
  const point = (x, y) => ({
    x: displayMatrix.a * x + displayMatrix.c * y + displayMatrix.e,
    y: displayMatrix.b * x + displayMatrix.d * y + displayMatrix.f,
  });
  const corners = [point(bounds.left, bounds.bottom), point(bounds.right, bounds.bottom),
    point(bounds.right, bounds.top), point(bounds.left, bounds.top)];
  const displayBounds = {
    left: Math.min(...corners.map(item => item.x)), right: Math.max(...corners.map(item => item.x)),
    bottom: Math.min(...corners.map(item => item.y)), top: Math.max(...corners.map(item => item.y)),
  };
  const displayWidth = displayBounds.right - displayBounds.left;
  const displayHeight = displayBounds.top - displayBounds.bottom;
  if (!(displayWidth > 0 && displayHeight > 0)) return null;
  const scaleX = width / displayWidth;
  const scaleY = height / displayHeight;
  return {
    displayBounds,
    matrix: {
      a: scaleX, b: 0, c: 0, d: scaleY,
      e: -displayBounds.left * scaleX,
      f: -displayBounds.bottom * scaleY,
    },
  };
}
