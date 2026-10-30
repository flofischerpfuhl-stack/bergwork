// A drag is anchored in display-page coordinates, never in a CSS hit box.
// Reading the current surface rectangle accounts for scrolling and for the
// temporary page-stack transform used by wheel zoom before React settles it.
const positive = value => Number.isFinite(value) && value > 0;

export function captureDragPageAnchor(pointer, surfaceRect, pageSize) {
  if (!surfaceRect || !positive(surfaceRect.width) || !positive(surfaceRect.height) ||
      !positive(pageSize?.width) || !positive(pageSize?.height) ||
      !Number.isFinite(pointer?.clientX) || !Number.isFinite(pointer?.clientY)) return null;
  const scaleX = surfaceRect.width / pageSize.width;
  const scaleY = surfaceRect.height / pageSize.height;
  return {
    pageWidth: pageSize.width,
    pageHeight: pageSize.height,
    startX: (pointer.clientX - surfaceRect.left) / scaleX,
    startY: (pointer.clientY - surfaceRect.top) / scaleY,
    startScaleX: scaleX,
    startScaleY: scaleY,
  };
}

export function dragPageDelta(anchor, pointer, surfaceRect) {
  if (!anchor || !surfaceRect || !positive(surfaceRect.width) || !positive(surfaceRect.height) ||
      !Number.isFinite(pointer?.clientX) || !Number.isFinite(pointer?.clientY)) return null;
  const scaleX = surfaceRect.width / anchor.pageWidth;
  const scaleY = surfaceRect.height / anchor.pageHeight;
  return {
    dx: (pointer.clientX - surfaceRect.left) / scaleX - anchor.startX,
    dy: (pointer.clientY - surfaceRect.top) / scaleY - anchor.startY,
    scaleX,
    scaleY,
  };
}

// What stays on the page of a placed object, in page units: 24 px to grab it
// again, half of a smaller object, at least 4 px. Large objects keep 10 % of
// their shorter side, and an object under 4 px stays wholly on the page.
export function grabAreaLength(length, otherLength, pageLength, scale) {
  const grab = Math.max(4, Math.min(24, length * scale / 2)) / scale;
  return Math.min(length, pageLength, Math.max(grab, Math.min(length, otherLength) * 0.1));
}

export function positionWithinGrabArea(position, length, otherLength, pageLength, scale) {
  const overlap = grabAreaLength(length, otherLength, pageLength, scale);
  return Math.max(overlap - length, Math.min(pageLength - overlap, position));
}

// A relative move stops at the grab area. An object already past it, such as
// one from the file, may still move back but does not jump.
export function limitMoveToGrabArea(rect, dx, dy, pageSize, scale) {
  const limit = (position, delta, length, otherLength, pageLength) => {
    const overlap = grabAreaLength(length, otherLength, pageLength, scale);
    const low = Math.min(position, overlap - length), high = Math.max(position, pageLength - overlap);
    return Math.max(low, Math.min(high, position + delta)) - position;
  };
  return { dx: limit(rect.x, dx, rect.w, rect.h, pageSize.width),
    dy: limit(rect.y, dy, rect.h, rect.w, pageSize.height) };
}

export function pointerMovedBeyondSlop(start, current, slop) {
  return Number.isFinite(start?.clientX) && Number.isFinite(start?.clientY) &&
    Number.isFinite(current?.clientX) && Number.isFinite(current?.clientY) &&
    Math.hypot(current.clientX - start.clientX, current.clientY - start.clientY) >= slop;
}

// A CSS minimum hit size improves selection without changing PDF geometry.
// The logical value is written by the draft compositor after every resize so
// a rapid successor gesture can use newer visible geometry before React lands.
export function logicalDragDimension(stylePixels, modelPoints, zoom, draftPoints = NaN) {
  const scale = Number(zoom);
  const style = Number(stylePixels);
  const model = Number(modelPoints);
  const draft = Number(draftPoints);
  if (positive(draft)) return draft;
  if (!positive(scale) || !positive(style)) return model;
  if (positive(model) && style <= 8.001 && model * scale <= 8.001) return model;
  return style / scale;
}
