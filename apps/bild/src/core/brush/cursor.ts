import type { Point, Rect } from '../geometry';

export const CLONE_SOURCE_MARKER_REACH = 7;
export const BRUSH_CURSOR_INVALIDATION_MARGIN = 3;

/** BrushCursorOverlay.update: the outline is never smaller than one view point. */
export function brushOutlineDiameter(diameter: number, viewPointsPerDocumentPixel: number): number {
  return Math.max(1, diameter * viewPointsPerDocumentPixel);
}

export function brushOutlineRadius(diameter: number, viewPointsPerDocumentPixel: number): number {
  return brushOutlineDiameter(diameter, viewPointsPerDocumentPixel) / 2;
}

export function brushOutlineRect(point: Point, diameter: number, viewPointsPerDocumentPixel: number): Rect {
  const size = brushOutlineDiameter(diameter, viewPointsPerDocumentPixel);
  return { x: point.x - size / 2, y: point.y - size / 2, width: size, height: size };
}

export function hardnessOutlineRect(outline: Rect, hardness: number): Rect | null {
  if (!(hardness > 0)) return null;
  const value = Math.min(1, hardness);
  const inset = outline.width * (1 - value) / 2;
  return { x: outline.x + inset, y: outline.y + inset, width: outline.width - inset * 2, height: outline.height - inset * 2 };
}
