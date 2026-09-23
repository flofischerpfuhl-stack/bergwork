import { effectiveVisibleIds, type CanvasDocument, type Layer, type LayerMask } from '../document';
import { apply, invert, pixelToDocument, type Point } from '../geometry';
import { Raster, TILE } from '../raster';
import type { EditorSession } from '../session';
import { CloneStampState, cloneSample, type CloneSettings } from './clone';
import {
  DEFAULT_BRUSH_SETTINGS, DEFAULT_CLONE_SETTINGS, changeBrushHardness as stepHardness,
  changeBrushSize as stepSize, type BrushMode, type BrushSettings,
} from './settings';
import { beginStroke, type CloneSample, type Stroke, type StrokeResult, type StrokeUpdate } from './stroke';
import { RecordedBrushStroke, type GpuBrushPreview } from './gpuPreview';

interface LastPoint { readonly point: Point; readonly layerId: string; readonly mask: boolean }
interface ActiveStroke {
  readonly stroke: Stroke;
  readonly gpu: GpuBrushPreview | null;
  readonly layerId: string;
  readonly sourceRaster: Raster | null;
  readonly sourceMaskRaster: Raster | null;
  readonly sourceTransform: Layer['transform'];
  readonly mask: boolean;
  readonly name: string;
  changed: boolean;
}
interface SessionBrushState {
  brush: BrushSettings;
  cloneBrush: BrushSettings;
  readonly clone: CloneStampState;
  active: ActiveStroke | null;
  last: LastPoint | null;
}

const states = new WeakMap<EditorSession, SessionBrushState>();

function state(session: EditorSession): SessionBrushState {
  let result = states.get(session);
  if (!result) {
    result = { brush: DEFAULT_BRUSH_SETTINGS, cloneBrush: DEFAULT_CLONE_SETTINGS,
      clone: new CloneStampState(), active: null, last: null };
    states.set(session, result);
  }
  return result;
}

export function getBrushSettings(session: EditorSession): BrushSettings {
  const value = state(session);
  return session.tool === 'cloneStamp' ? value.cloneBrush : value.brush;
}

export function setBrushSettings(session: EditorSession, settings: BrushSettings): void {
  const value = state(session);
  if (session.tool === 'cloneStamp') value.cloneBrush = settings;
  else value.brush = settings;
  session.notify('ui');
}

export function changeBrushSize(session: EditorSession, increase: boolean): BrushSettings {
  const value = state(session);
  if (value.active) return getBrushSettings(session);
  const next = stepSize(getBrushSettings(session), increase);
  setBrushSettings(session, next);
  return next;
}

export function changeBrushHardness(session: EditorSession, increase: boolean): BrushSettings {
  const value = state(session);
  if (value.active) return getBrushSettings(session);
  const next = stepHardness(getBrushSettings(session), increase);
  setBrushSettings(session, next);
  return next;
}

export function setCloneSource(session: EditorSession, point: Point): void {
  state(session).clone.setSource(point);
  session.notify('ui');
}

export function getCloneSettings(session: EditorSession): CloneSettings { return state(session).clone.settings; }
export function setCloneSettings(session: EditorSession, settings: CloneSettings): void {
  state(session).clone.settings = settings;
  session.notify('ui');
}
export function cloneSamplePoint(session: EditorSession, point: Point): Point | null {
  const value = state(session);
  return value.clone.samplePoint(point, value.active !== null);
}

export interface BeginSessionStrokeOptions {
  readonly settings?: BrushSettings;
  readonly shift?: boolean;
  readonly mode?: BrushMode;
  /** Paint with the background swatch; on a mask this selects the opposite of `maskPaintWhite`. */
  readonly background?: boolean;
  /** Renderer-supplied exact flattened sampler for Clone Stamp's All Layers option. */
  readonly allLayersSample?: CloneSample['sample'];
}

/** EditorSession+Brush.beginBrush, kept external so the shared session does not need brush-only fields. */
export function beginBrushStroke(session: EditorSession, point: Point, options: BeginSessionStrokeOptions = {}): StrokeUpdate | null {
  const value = state(session), layer = session.activeLayer, document = session.document;
  if (value.active || !canPaint(session, layer, document)) return null;
  const mask = session.isMaskSelected;
  let settings = options.settings ?? getBrushSettings(session);
  if (!options.settings) {
    const colour = session.paletteColor(options.background ?? false);
    settings = { ...settings, red: colour.red, green: colour.green, blue: colour.blue };
  }
  if (options.mode) settings = { ...settings, mode: options.mode };
  if (mask) {
    const white = session.paletteColor(options.background ?? false).red === 1;
    settings = { ...settings, red: white ? 1 : 0, green: white ? 1 : 0, blue: white ? 1 : 0, mode: 'paint' };
  } else if (session.tool !== 'brush') settings = { ...settings, mode: 'paint' };

  let clone: CloneSample | undefined;
  if (session.tool === 'cloneStamp') {
    const offset = value.clone.strokeOffset(point);
    if (!offset) return null;
    value.clone.offset = offset;
    clone = value.clone.settings.sampleAllLayers && options.allLayersSample
      ? { offset, sample: options.allLayersSample }
      : cloneSample(document!, layer!, offset, value.clone.settings.sampleAllLayers);
  }
  const used = document!.layers.reduce((total, item) => item.id === layer!.id ? total
    : total + (mask ? item.mask?.raster.width ?? 0 : item.raster?.width ?? 0)
      * (mask ? item.mask?.raster.height ?? 0 : item.raster?.height ?? 0), 0);
  const strokeOptions = { layer: layer!, canvas: { width: document!.width, height: document!.height }, settings,
    target: mask ? 'mask' as const : 'pixels' as const, selection: document!.selection, clone,
    pixelLimit: Math.max(0, 100_000_000 - used) };
  // MetalBrushCoverage.swift keeps ordinary Brush/Eraser geometry on the GPU during the gesture.
  // Clone and selection-limited strokes need source/selection sampling and retain the CPU preview.
  const recorded = session.tool === 'brush' && !document!.selection && !clone ? new RecordedBrushStroke(strokeOptions) : null;
  const stroke = recorded ?? beginStroke(strokeOptions);
  const name = mask ? 'Paint Mask' : settings.mode === 'erase' ? 'Erase'
    : session.tool === 'cloneStamp' ? 'Clone Stamp' : 'Brush Stroke';
  value.active = { stroke, gpu: recorded?.gpuPreview ?? null, layerId: layer!.id, sourceRaster: layer!.raster,
    sourceMaskRaster: layer!.mask?.raster ?? null, sourceTransform: layer!.transform, mask, name, changed: false };
  const start = options.shift && value.last && value.last.layerId === layer!.id && value.last.mask === mask ? value.last.point : null;
  const update = stroke.addPoints(start ? [start, point] : [point]);
  value.active.changed ||= update.dirty.length > 0;
  value.last = { point: { ...point }, layerId: layer!.id, mask };
  session.notify('ui');
  return update;
}

export function extendBrushStroke(session: EditorSession, points: Point | readonly Point[],
  options?: { readonly pressure?: number | readonly number[] }): StrokeUpdate | null {
  const value = state(session), active = value.active;
  if (!active) return null;
  const list = Array.isArray(points) ? points : [points];
  const update = active.stroke.addPoints(list, options);
  active.changed ||= update.dirty.length > 0;
  const last = list.at(-1);
  if (last) value.last = { point: { ...last }, layerId: active.layerId, mask: active.mask };
  session.notify('ui');
  return update;
}

/** The stroke in progress as the canvas should show it: which layer (or its mask), pixels and placement. */
export function currentBrushPreview(session: EditorSession): { layerId: string; mask: boolean; raster: Raster; transform: Layer['transform'] } | null {
  const active = state(session).active;
  if (!active) return null;
  return { layerId: active.layerId, mask: active.mask, raster: active.stroke.currentRaster(), transform: active.stroke.currentTransform() };
}

/** Geometry-only live preview used by the WebGL compositor. */
export function currentGpuBrushPreview(session: EditorSession): GpuBrushPreview | null {
  const active = state(session).active;
  return active?.gpu ?? null;
}

/** CPU previews are registered only for brush modes that cannot use MetalBrushCoverage-equivalent rendering. */
export function currentCpuBrushPreview(session: EditorSession): ReturnType<typeof currentBrushPreview> {
  return state(session).active?.gpu ? null : currentBrushPreview(session);
}

export function isBrushStrokeActive(session: EditorSession): boolean { return state(session).active !== null; }

export function currentBrushRaster(session: EditorSession): Raster | null {
  return state(session).active?.stroke.currentRaster() ?? null;
}

export function cancelBrushStroke(session: EditorSession): boolean {
  const value = state(session), active = value.active;
  if (!active) return false;
  active.stroke.cancel();
  value.active = null;
  session.notify('ui');
  return true;
}

export function finishBrushStroke(session: EditorSession): StrokeResult | null {
  const value = state(session), active = value.active;
  if (!active) return null;
  let result: StrokeResult;
  try { result = active.stroke.finish(); } finally { value.active = null; }
  if (!active.changed) { session.notify('ui'); return result; }
  const document = session.document;
  const index = document?.layers.findIndex((layer) => layer.id === active.layerId) ?? -1;
  const current = index >= 0 ? document!.layers[index]! : null;
  if (!current || current.raster !== active.sourceRaster || (current.mask?.raster ?? null) !== active.sourceMaskRaster
    || !sameTransform(current.transform, active.sourceTransform)) return result;
  const layers = document!.layers.slice();
  if (active.mask) {
    const oldMask = current.mask;
    if (!oldMask) return result;
    layers[index] = { ...current, mask: { ...oldMask, raster: result.raster } };
  } else {
    let mask = current.mask;
    if (mask && !mask.placement && result.transform && (result.raster.width !== current.raster?.width
      || result.raster.height !== current.raster?.height)) {
      mask = expandAttachedMask(mask, result);
    }
    layers[index] = { ...current, raster: result.raster, transform: result.transform ?? current.transform, mask };
  }
  session.beginEdit(active.name);
  session.replaceDocument({ ...document!, layers });
  session.endEdit();
  return result;
}

function canPaint(session: EditorSession, layer: Layer | null, document: CanvasDocument | null): boolean {
  if (!document || !layer || !session.canEditLayers || session.selectedLayerIds.size !== 1 || layer.locked) return false;
  if (!effectiveVisibleIds(document.layers).has(layer.id)) return false;
  if (session.isMaskSelected) return !!layer.mask?.enabled;
  if (layer.isGroup || layer.adjustment) return false;
  const selection = document.selection;
  return !selection || selection.mask.tiles.some((tile) => tile?.some((value) => value !== 0));
}

/** RasterSnapshot.expandMask: old mask stays aligned; new pixels reveal. */
function expandAttachedMask(mask: LayerMask, result: StrokeResult): LayerMask {
  if (mask.raster.width === 1 && mask.raster.height === 1 && mask.raster.pixel(0, 0)[0] === 255) return mask;
  const width = result.raster.width, height = result.raster.height;
  const cols = Math.ceil(width / TILE), rows = Math.ceil(height / TILE);
  const tiles: Uint8Array[] = [];
  const oldRect = {
    x: result.sourceRect.x - result.bounds.x, y: result.sourceRect.y - result.bounds.y,
    width: result.sourceRect.width, height: result.sourceRect.height,
  };
  const uniform = mask.raster.width === 1 && mask.raster.height === 1 ? mask.raster.pixel(0, 0)[0] : null;
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const tw = Math.min(TILE, width - col * TILE), th = Math.min(TILE, height - row * TILE);
    const tile = new Uint8Array(tw * th).fill(255);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const gx = col * TILE + x, gy = row * TILE + y;
      if (gx < oldRect.x || gy < oldRect.y || gx >= oldRect.x + oldRect.width || gy >= oldRect.y + oldRect.height) continue;
      const sx = Math.floor((gx - oldRect.x) * mask.raster.width / oldRect.width);
      const sy = Math.floor((gy - oldRect.y) * mask.raster.height / oldRect.height);
      tile[y * tw + x] = uniform ?? mask.raster.pixel(sx, sy)[0] ?? 255;
    }
    tiles.push(tile);
  }
  return { ...mask, raster: new Raster(width, height, 1, tiles) };
}

function sameTransform(a: Layer['transform'], b: Layer['transform']): boolean {
  return a.origin.x === b.origin.x && a.origin.y === b.origin.y && a.size.width === b.size.width
    && a.size.height === b.size.height && a.rotation === b.rotation && a.flipX === b.flipX && a.flipY === b.flipY;
}

/** Maps a document point into the active target grid; useful to UI/workers feeding pressure samples. */
export function documentPointToLayerPixel(layer: Layer, point: Point, mask = false): Point {
  const raster = mask ? layer.mask?.raster : layer.raster;
  const width = raster?.width ?? Math.max(1, Math.round(layer.transform.size.width));
  const height = raster?.height ?? Math.max(1, Math.round(layer.transform.size.height));
  return apply(invert(pixelToDocument(mask && layer.mask?.placement ? layer.mask.placement : layer.transform, width, height)), point);
}
