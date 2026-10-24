import type { LayerTransform, Point, Rect } from '../geometry';
import type { Raster } from '../raster';
import type { DocumentSelection } from '../selection';
import type { EditorSession } from '../session';
import { BlurStroke, type BlurSettings } from './blur';
import { editableTarget } from './common';
import { WarpStroke, type RetouchStroke, type WarpMode, type WarpSettings } from './warp';
import { replayRetouchInBackground } from './workerClient';

export { BlurStroke, gaussianRegion, type BlurSettings } from './blur';
export { WarpStroke, type RetouchStroke, type WarpMode, type WarpSettings } from './warp';
export { lastRetouchWorkerTiming } from './workerClient';

export type RetouchMode = 'blur' | WarpMode;
export interface RetouchSettings extends BlurSettings, WarpSettings {}

interface SessionStroke {
  readonly layerId: string;
  readonly mask: boolean;
  readonly mode: RetouchMode;
  readonly transform: import('../geometry').LayerTransform;
  readonly stroke: RecordedRetouchStroke;
}
const strokes = new WeakMap<EditorSession, SessionStroke>();
const pending = new WeakMap<EditorSession, Promise<Raster | null>>();

interface RecordedBatch { readonly points: readonly Point[] }

/**
 * Pointer-time geometry recorder. SmudgeLiquify.swift/BlurTool.swift remain the exact CPU oracle
 * and are replayed once at commit, rather than mutating regional tiles for every DOM sample.
 */
class RecordedRetouchStroke implements RetouchStroke {
  private readonly batches: RecordedBatch[] = [];
  private readonly pointsValue: Point[] = [];
  private ended = false;

  constructor(readonly original: Raster, private readonly transform: LayerTransform,
    readonly mode: RetouchMode, readonly settings: RetouchSettings,
    private readonly selection: DocumentSelection | null) {}

  addPoints(points: readonly Point[]): Rect[] {
    if (this.ended) return [];
    const valid = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)
      && Math.abs(point.x) <= 10_000_000 && Math.abs(point.y) <= 10_000_000).map((point) => ({ ...point }));
    if (!valid.length) return [];
    this.batches.push({ points: valid }); this.pointsValue.push(...valid);
    const radius = this.settings.diameter / 2 + (this.mode === 'blur' ? Math.min(90, Math.max(5, this.settings.diameter * 0.3)) : 2);
    return valid.map((point) => ({ x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 }));
  }

  currentRaster(): Raster { return this.original; }
  finish(): Raster {
    this.ended = true;
    return this.exactReplay();
  }
  finishInBackground(): Promise<Raster> | null {
    this.ended = true;
    return replayRetouchInBackground(this.original, this.transform, this.mode, this.settings,
      this.selection, this.batches.map((batch) => batch.points));
  }
  exactReplay(): Raster {
    const exact: RetouchStroke = this.mode === 'blur'
      ? new BlurStroke(this.original, this.transform, this.settings, this.selection)
      : new WarpStroke(this.original, this.transform, this.mode, this.settings, this.selection);
    for (const batch of this.batches) exact.addPoints(batch.points);
    return exact.finish();
  }
  cancel(): Raster { this.ended = true; return this.original; }
  get points(): readonly Point[] { return this.pointsValue; }
}

export interface RetouchGeometryPreview {
  readonly mode: RetouchMode;
  readonly diameter: number;
  readonly points: readonly Point[];
}

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
  const stroke = new RecordedRetouchStroke(target.raster, target.transform, mode, settings, session.selection);
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

export function currentRetouchGeometry(session: EditorSession): RetouchGeometryPreview | null {
  const active = strokes.get(session);
  return active ? { mode: active.mode, diameter: active.stroke.settings.diameter, points: active.stroke.points } : null;
}

/** Commits exactly one history item named Blur, Smudge, or Liquify. */
export function commitRetouch(session: EditorSession): boolean {
  const active = strokes.get(session);
  if (!active || pending.has(session)) return false;
  strokes.delete(session);
  const layer = session.layer(active.layerId);
  if (!layer || active.mask !== session.isMaskSelected) { active.stroke.cancel(); return false; }
  const background = active.stroke.finishInBackground();
  if (!background) { installResult(session, active, active.stroke.finish()); return true; }
  session.isProjectBusy = true;
  const job = background.catch(() => active.stroke.exactReplay()).then((raster) => {
    if (pending.get(session) !== job) return null;
    pending.delete(session); session.isProjectBusy = false;
    installResult(session, active, raster); session.notify('document'); return raster;
  }, (cause: unknown) => {
    if (pending.get(session) === job) pending.delete(session);
    session.isProjectBusy = false; session.errorMessage = cause instanceof Error ? cause.message : String(cause);
    session.notify('ui'); return null;
  });
  pending.set(session, job); session.notify('ui');
  return true;
}

function installResult(session: EditorSession, active: SessionStroke, raster: Raster): void {
  const layer = session.layer(active.layerId);
  if (!layer || active.mask !== session.isMaskSelected) return;
  const name = ['liquify', 'push', 'bloat', 'pucker', 'reconstruct'].includes(active.mode)
    ? 'Liquify' : active.mode[0]!.toUpperCase() + active.mode.slice(1);
  if (active.mask) session.replaceMaskPixels(active.layerId, raster, name);
  else session.replaceLayerPixels(active.layerId, raster, name, active.transform);
}

export async function waitForRetouch(session: EditorSession): Promise<Raster | null> {
  return pending.get(session) ?? null;
}

export function cancelRetouch(session: EditorSession): boolean {
  const active = strokes.get(session);
  if (!active) return false;
  active.stroke.cancel();
  strokes.delete(session);
  return true;
}
