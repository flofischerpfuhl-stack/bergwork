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
      || (!session.isMaskSelected && (layer.isGroup || layer.adjustment))
      || (mode !== 'blur' && session.isMaskSelected)) return [];
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
  const name = active.mode[0]!.toUpperCase() + active.mode.slice(1);
  if (active.mask) session.replaceMaskPixels(active.layerId, raster, name);
  else {
    session.beginEdit(name);
    const document = session.document;
    if (document) session.replaceDocument({ ...document, layers: document.layers.map((item) => item.id === active.layerId
      ? { ...item, raster, transform: active.transform, shape: null } : item) });
    session.endEdit();
  }
  return true;
}

export function cancelRetouch(session: EditorSession): boolean {
  const active = strokes.get(session);
  if (!active) return false;
  active.stroke.cancel();
  strokes.delete(session);
  return true;
}
