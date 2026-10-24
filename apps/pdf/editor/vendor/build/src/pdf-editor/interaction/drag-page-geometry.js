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
