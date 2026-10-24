// Preserve object/frame/font size and the arrangement within a selection.
// Translate its union back onto the destination instead of shrinking content.
export function clipboardPlacementOffset(rects, page, preferred = 16) {
  const finite = (rects || []).filter(rect => rect && [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite));
  if (!finite.length) return { x: preferred, y: preferred };
  const left = Math.min(...finite.map(rect => rect.x));
  const top = Math.min(...finite.map(rect => rect.y));
  const width = Math.max(...finite.map(rect => rect.x + rect.w)) - left;
  const height = Math.max(...finite.map(rect => rect.y + rect.h)) - top;
  const place = (start, size, extent) => {
    const available = Math.max(0, Number(extent) - size);
    return Math.max(0, Math.min(start + preferred, available)) - start;
  };
  return { x: place(left, width, page.width), y: place(top, height, page.height) };
}
