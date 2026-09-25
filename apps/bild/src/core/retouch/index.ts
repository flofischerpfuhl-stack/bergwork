import type { Point, Rect } from '../geometry';
import type { EditorSession } from '../session';
import { BlurStroke, type BlurSettings } from './blur';
import { editableTarget } from './common';
import { WarpStroke, type RetouchStroke, type WarpMode, type WarpSettings } from './warp';

export { BlurStroke, gaussianRegion, type BlurSettings } from './blur';
export { WarpStroke, type RetouchStroke, type WarpMode, type WarpSettings } from './warp';

export type RetouchMode = 'blur' | WarpMode;
export interface RetouchSettings extends BlurSettings, WarpSettings {}

interface SessionStroke {
  readonly layerId: string;
  readonly mask: boolean;
  readonly mode: RetouchMode;
  readonly transform: import('../geometry').LayerTransform;
  readonly stroke: RetouchStroke;
}
const strokes = new WeakMap<EditorSession, SessionStroke>();

/** Command wrapper for EditorSession+Brush.beginBrush / beginWarp. */
export function beginRetouch(session: EditorSession, point: Point, mode: RetouchMode, settings: RetouchSettings): Rect[] {
  cancelRetouch(session);
  const layer = session.activeLayer;
  if (!session.canEditLayers || session.selectedLayerIds.size !== 1 || !layer
      || (!session.isMaskSelected && (layer.kind === 'group' || layer.adjustment))
      || (mode !== 'blur' && session.isMaskSelected) || session.editBlocker(layer.id, 'pixels')) return [];
  const document = session.document;
  if (!document) return [];
  const target = editableTarget(layer, session.isMaskSelected, { width: document.width, height: document.height });
  if (!target) return [];
  const stroke = mode === 'blur'
    ? new BlurStroke(target.raster, target.transform, settings, session.selection)
    : new WarpStroke(target.raster, target.transform, mode, settings, session.selection);
  strokes.set(session, { layerId: layer.id, mask: target.mask, mode, transform: target.transform, stroke });
  return stroke.addPoints([point]);
}

export function updateRetouch(session: EditorSession, points: readonly Point[]): Rect[] {
  return strokes.get(session)?.stroke.addPoints(points) ?? [];
}

/** The retouch stroke in progress for the canvas preview. */
export function currentRetouchPreview(session: EditorSession): { layerId: string; mask: boolean; raster: ReturnType<RetouchStroke['currentRaster']>; transform: import('../geometry').LayerTransform } | null {
  const active = strokes.get(session);
  return active ? { layerId: active.layerId, mask: active.mask, raster: active.stroke.currentRaster(), transform: active.transform } : null;
}

export function currentRetouch(session: EditorSession): ReturnType<RetouchStroke['currentRaster']> | null {
  return strokes.get(session)?.stroke.currentRaster() ?? null;
}

/** Commits exactly one history item named Blur, Smudge, or Liquify. */
export function commitRetouch(session: EditorSession): boolean {
  const active = strokes.get(session);
  if (!active) return false;
  strokes.delete(session);
  const layer = session.layer(active.layerId);
  if (!layer || active.mask !== session.isMaskSelected) { active.stroke.cancel(); return false; }
  const raster = active.stroke.finish();
  const name = ['liquify', 'push', 'bloat', 'pucker', 'reconstruct'].includes(active.mode)
    ? 'Liquify' : active.mode[0]!.toUpperCase() + active.mode.slice(1);
  if (active.mask) session.replaceMaskPixels(active.layerId, raster, name);
  else session.replaceLayerPixels(active.layerId, raster, name, active.transform);
  return true;
}

export function cancelRetouch(session: EditorSession): boolean {
  const active = strokes.get(session);
  if (!active) return false;
  active.stroke.cancel();
  strokes.delete(session);
  return true;
}
