/**
 * Document selection. Upstream (Selection.swift) keeps a CoreGraphics path and combines outlines
 * with CGPath boolean operations, rasterising coverage (nonzero winding, optional antialiasing)
 * whenever an edit is clipped. The browser port stores that coverage directly: a 1-channel raster
 * placed at an integer document offset and not clipped to the canvas, so an outline moved off the
 * canvas and back stays intact, as upstream promises. Boolean modes become per-pixel max/min.
 *
 * `null` on the document means no selection; a selection with no covered pixel is an explicit
 * empty selection that edits must treat as "touch nothing".
 */

import type { Raster } from './raster';

export interface DocumentSelection {
  /** Coverage, 255 = selected. */
  readonly mask: Raster;
  /** Document position of the mask's top-left pixel. */
  readonly x: number;
  readonly y: number;
  readonly antialiased: boolean;
}

export type SelectionMode = 'New' | 'Add' | 'Subtract';
export type LassoKind = 'Freehand' | 'Polygonal' | 'Rectangle' | 'Ellipse';

/** True for the explicit-empty selection (as opposed to `null`, which means no selection). */
export function selectionIsEmpty(selection: DocumentSelection): boolean {
  for (const tile of selection.mask.tiles) {
    if (!tile) continue;
    for (let i = 0; i < tile.length; i++) if (tile[i] !== 0) return false;
  }
  return true;
}
