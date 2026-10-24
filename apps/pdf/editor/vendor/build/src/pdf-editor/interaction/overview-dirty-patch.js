// Use the same integer raster origin as PDFium's tiled renderer. The input
// rectangles already include the native object's stroke and six page units of
// dirty-tile padding; two further raster pixels cover edge antialiasing.
export function overviewDirtyPixelCrop(rects, pageWidth, pageHeight, scale, maxFraction = 0.35) {
  if (!Array.isArray(rects) || !rects.length ||
      ![pageWidth, pageHeight, scale].every(Number.isFinite) ||
      pageWidth <= 0 || pageHeight <= 0 || scale <= 0) return null;
  const fullWidth = Math.ceil(pageWidth * scale);
  const fullHeight = Math.ceil(pageHeight * scale);
  if (!fullWidth || !fullHeight) return null;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const rect of rects) {
    if (!rect || ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) ||
        rect.w <= 0 || rect.h <= 0) return null;
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.w);
    bottom = Math.max(bottom, rect.y + rect.h);
  }
  const leftPx = Math.max(0, Math.floor(left * scale) - 2);
  const topPx = Math.max(0, Math.floor(top * scale) - 2);
  const rightPx = Math.min(fullWidth, Math.ceil(right * scale) + 2);
  const bottomPx = Math.min(fullHeight, Math.ceil(bottom * scale) + 2);
  const widthPx = rightPx - leftPx;
  const heightPx = bottomPx - topPx;
  if (widthPx <= 0 || heightPx <= 0 ||
      widthPx * heightPx >= fullWidth * fullHeight * maxFraction) return null;
  // PDFium's clipping at a bitmap boundary can change antialiasing in the
  // outermost pixels even with the same full-page transform. Render beyond
  // the write rectangle, then copy only the interior onto the prior canvas.
  const guardPx = 8;
  const renderLeftPx = Math.max(0, leftPx - guardPx);
  const renderTopPx = Math.max(0, topPx - guardPx);
  const renderRightPx = Math.min(fullWidth, rightPx + guardPx);
  const renderBottomPx = Math.min(fullHeight, bottomPx + guardPx);
  const renderWidthPx = renderRightPx - renderLeftPx;
  const renderHeightPx = renderBottomPx - renderTopPx;
  return {
    leftPx, topPx, widthPx, heightPx, fullWidth, fullHeight,
    renderLeftPx, renderTopPx, renderWidthPx, renderHeightPx,
    writeOffsetX: leftPx - renderLeftPx, writeOffsetY: topPx - renderTopPx,
    tile: { x: renderLeftPx / scale, y: renderTopPx / scale,
      width: renderWidthPx / scale, height: renderHeightPx / scale },
  };
}
