/** Spot Healing Brush engine and session commands. Ported from BrushStroke.heal. */

import { effectiveVisibleIds, type CanvasDocument, type Layer, type LayerMask } from './document';
import { apply, invert, pixelToDocument, type Affine, type LayerTransform, type Point, type Rect, type Size } from './geometry';
import { Raster, TILE } from './raster';
import type { DocumentSelection } from './selection';
import type { EditorSession } from './session';
import { getBrushSettings } from './brush/commands';
import { beginStroke, type Stroke, type StrokeResult, type StrokeUpdate } from './brush/stroke';
import type { BrushSettings } from './brush/settings';
import { replayHealCoverageInBackground, type HealCoverageUpdate } from './healCoverageClient';
import { KernelClient } from '../workers/kernelClient';
import type { SpotHealMode } from '../wasm/kernels';
import { premultiplyRgba8InPlace, unpremultiplyRgba8InPlace } from './pixel/color';

export type SpotHealingMode = 'contentAware' | 'createTexture' | 'proximityMatch';
export const SPOT_HEALING_MODES: readonly SpotHealingMode[] = ['contentAware', 'createTexture', 'proximityMatch'];
export const DEFAULT_SPOT_HEALING_MODE: SpotHealingMode = 'contentAware';

export interface SpotHealingSettings {
  readonly diameter: number;
  readonly hardness: number;
  readonly opacity: number;
  readonly mode: SpotHealingMode;
  /** Upstream randomises this per stroke. Supplying it makes tests/replays deterministic. */
  readonly seed?: number;
}

export interface BeginSpotHealingOptions {
  readonly layer: Layer;
  readonly canvas: Size;
  readonly settings: SpotHealingSettings;
  readonly selection?: DocumentSelection | null;
  readonly pixelLimit?: number;
  readonly kernels?: KernelClient;
}

export interface SpotHealingStrokeState {
  readonly layerId: string;
  readonly settings: SpotHealingSettings;
  readonly active: boolean;
  readonly healing: boolean;
  readonly error: string | null;
}

/** Async equivalent of the brush Stroke: point input is synchronous; healing happens at finish. */
export class SpotHealingStroke {
  readonly settings: SpotHealingSettings;
  private readonly layer: Layer;
  private readonly source: Raster;
  private readonly coverageLayer: Layer;
  private readonly coverageBrush: BrushSettings;
  private readonly coverageCanvas: Size;
  private readonly coverageSelection: DocumentSelection | null;
  private readonly coveragePixelLimit: number;
  private readonly coverageUpdates: HealCoverageUpdate[] = [];
  private readonly pointsValue: Point[] = [];
  private readonly kernels: KernelClient;
  private readonly liveBase: Raster;
  private done = false;
  private healing = false;
  private errorValue: string | null = null;

  constructor(options: BeginSpotHealingOptions) {
    if (!options.layer.raster || options.layer.raster.channels !== 4) throw new RangeError('Spot Healing needs a colour raster');
    if (!SPOT_HEALING_MODES.includes(options.settings.mode)) throw new RangeError('Invalid Spot Healing mode');
    if (!Number.isFinite(options.settings.opacity) || options.settings.opacity < 0.01 || options.settings.opacity > 1) {
      throw new RangeError('Invalid Spot Healing opacity');
    }
    this.layer = options.layer;
    this.source = options.layer.raster;
    this.settings = options.settings;
    this.kernels = options.kernels ?? new KernelClient();
    this.coverageBrush = {
      diameter: options.settings.diameter, hardness: options.settings.hardness, opacity: 1,
      red: 1, green: 1, blue: 1, mode: 'paint',
    };
    // BrushStroke.heal reads the stroke's accumulated coverage, not its dark live wash.
    this.coverageLayer = { ...options.layer, raster: Raster.blank(this.source.width, this.source.height, 4), mask: null };
    this.coverageCanvas = options.canvas;
    this.coverageSelection = options.selection ?? null;
    this.coveragePixelLimit = options.pixelLimit ?? 100_000_000;
    const map = pixelToDocument(options.layer.transform, this.source.width, this.source.height);
    const canvasInPixels = transformedBounds(invert(map), { x: 0, y: 0, ...options.canvas });
    const extent = integralUnion({ x: 0, y: 0, width: this.source.width, height: this.source.height }, canvasInPixels);
    this.liveBase = expandedRaster(this.source, extent.width, extent.height, -extent.x, -extent.y);
  }

  get state(): SpotHealingStrokeState {
    return { layerId: this.layer.id, settings: this.settings, active: !this.done, healing: this.healing, error: this.errorValue };
  }

  addPoints(points: readonly Point[], options?: { readonly pressure?: number | readonly number[] }): StrokeUpdate {
    if (this.done) throw new Error('Spot Healing stroke is no longer active');
    const copied = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
      .map((point) => ({ ...point }));
    if (!copied.length) return { dirty: [] };
    this.pointsValue.push(...copied);
    const pressure = Array.isArray(options?.pressure) ? [...options.pressure] : options?.pressure;
    this.coverageUpdates.push({ points: copied, ...(pressure === undefined ? {} : { pressure }) });
    const radius = this.settings.diameter / 2 + 2;
    return { dirty: copied.map((point) => ({ x: point.x - radius, y: point.y - radius,
      width: radius * 2, height: radius * 2 })) };
  }

  /** BrushStroke's fixed 45% dark wash over the accumulated healing coverage. */
  /** Placement of `currentRaster()` (the stroke's working grid). */
  currentTransform(): LayerTransform { return this.replayCoverage().currentTransform(); }

  currentRaster(): Raster {
    const coverage = this.replayCoverage().currentRaster();
    let preview = this.liveBase;
    for (let row = 0; row < coverage.rows; row++) for (let col = 0; col < coverage.cols; col++) {
      const tile = coverage.tiles[row * coverage.cols + col];
      if (!tile) continue;
      const width = coverage.tileWidth(col), height = coverage.tileHeight(row);
      const base = preview.readRegionNative(col * TILE, row * TILE, width, height);
      const maximum = preview.maximum;
      for (let i = 0; i < width * height; i++) {
        const amount = tile[i * 4 + 3]! / coverage.maximum * 0.45;
        if (amount <= 0) continue;
        const p = i * 4, baseAlpha = base[p + 3]! / maximum, alpha = amount + baseAlpha * (1 - amount);
        const wash = 31 / 255 * maximum;
        base[p] = alpha ? Math.round((wash * amount + base[p]! * baseAlpha * (1 - amount)) / alpha) : 0;
        base[p + 1] = alpha ? Math.round((wash * amount + base[p + 1]! * baseAlpha * (1 - amount)) / alpha) : 0;
        base[p + 2] = alpha ? Math.round((wash * amount + base[p + 2]! * baseAlpha * (1 - amount)) / alpha) : 0;
        base[p + 3] = Math.round(alpha * maximum);
      }
      preview = preview.withRegion(col * TILE, row * TILE, width, height, base);
    }
    return preview;
  }

  cancel(): void {
    if (this.done) return;
    this.done = true;
  }

  async finish(): Promise<StrokeResult> {
    if (this.done) throw new Error('Spot Healing stroke is no longer active');
    this.healing = true;
    try {
      const background = replayHealCoverageInBackground(this.coverageLayer, this.coverageCanvas,
        this.coverageBrush, this.coverageSelection, this.coveragePixelLimit, this.coverageUpdates);
      const painted = background ? await background : this.replayCoverage().finish();
      const result = await this.heal(painted);
      this.done = true;
      return result;
    } catch (error) {
      this.errorValue = error instanceof Error ? error.message : String(error);
      this.done = true;
      throw error;
    } finally { this.healing = false; }
  }

  get geometry(): { readonly diameter: number; readonly points: readonly Point[] } {
    return { diameter: this.settings.diameter, points: this.pointsValue };
  }

  private replayCoverage(): Stroke {
    const stroke = beginStroke({ layer: this.coverageLayer, canvas: this.coverageCanvas,
      settings: this.coverageBrush, selection: this.coverageSelection, pixelLimit: this.coveragePixelLimit });
    for (const update of this.coverageUpdates) stroke.addPoints(update.points,
      update.pressure === undefined ? undefined : { pressure: update.pressure });
    return stroke;
  }

  private async heal(painted: StrokeResult): Promise<StrokeResult> {
    // `painted.bounds` and `sourceRect` share BrushStroke's working grid. Move both to
    // original-layer coordinates, then retain the union just as paintSnapshot does.
    const paintX = painted.bounds.x - painted.sourceRect.x;
    const paintY = painted.bounds.y - painted.sourceRect.y;
    const x0 = Math.min(0, paintX), y0 = Math.min(0, paintY);
    const right = Math.max(this.source.width, paintX + painted.raster.width);
    const bottom = Math.max(this.source.height, paintY + painted.raster.height);
    const width = right - x0, height = bottom - y0;
    if (width > 30_000 || height > 30_000 || width * height > 100_000_000) throw new RangeError('Spot Healing result is too large');
    let output = expandedRaster(this.source, width, height, -x0, -y0);
    const coverageX = paintX - x0, coverageY = paintY - y0;
    const alpha = extractAlpha(painted.raster);
    const edges = await this.kernels.healCoverageBounds(alpha, painted.raster.width, painted.raster.height,
      painted.raster.width);
    if (edges.right <= edges.left || edges.bottom <= edges.top) {
      return healingResult(output, this.layer.transform, x0, y0, this.source.width, this.source.height);
    }

    // BrushStroke.heal: the patch search reaches roughly three spot widths away.
    const paintedWidth = edges.right - edges.left, paintedHeight = edges.bottom - edges.top;
    const reach = (Math.max(paintedWidth, paintedHeight) + 32) * 3.2;
    const rx = Math.max(0, Math.floor(coverageX + edges.left - reach));
    const ry = Math.max(0, Math.floor(coverageY + edges.top - reach));
    const rr = Math.min(width, Math.ceil(coverageX + edges.right + reach));
    const rb = Math.min(height, Math.ceil(coverageY + edges.bottom + reach));
    const rw = rr - rx, rh = rb - ry;
    const region = premultiplyRgba8InPlace(output.readRegion(rx, ry, rw, rh));
    const regionCoverage = new Uint8Array(rw * rh);
    for (let y = 0; y < rh; y++) {
      const sy = ry + y - coverageY;
      if (sy < 0 || sy >= painted.raster.height) continue;
      const fromX = Math.max(0, coverageX - rx), toX = Math.min(rw, coverageX + painted.raster.width - rx);
      if (toX <= fromX) continue;
      regionCoverage.set(alpha.subarray(sy * painted.raster.width + rx + fromX - coverageX,
        sy * painted.raster.width + rx + toX - coverageX), y * rw + fromX);
    }
    const healed = await this.kernels.spotHeal(region, regionCoverage, rw, rh, rw * 4,
      Math.min(1, Math.max(0, this.settings.opacity)), modeNumber(this.settings.mode),
      this.settings.seed ?? Math.floor(Math.random() * 0x1_0000_0000));
    const straight = unpremultiplyRgba8InPlace(healed);
    if (output.format === 'rgba16') {
      const native = output.readRegionNative(rx, ry, rw, rh) as Uint16Array;
      // HealPixels.c mutates only nonzero coverage. Do the same on write-back so the RGBA8
      // compatibility kernel cannot quantize the surrounding 16-bit search rectangle.
      for (let i = 0; i < regionCoverage.length; i++) {
        if (regionCoverage[i] === 0) continue;
        const p = i * 4;
        native[p] = straight[p]! * 257; native[p + 1] = straight[p + 1]! * 257;
        native[p + 2] = straight[p + 2]! * 257; native[p + 3] = straight[p + 3]! * 257;
      }
      output = output.withRegion(rx, ry, rw, rh, native);
    } else output = output.withRegion(rx, ry, rw, rh, straight);
    return healingResult(output, this.layer.transform, x0, y0, this.source.width, this.source.height);
  }
}

export function createSpotHealingStroke(options: BeginSpotHealingOptions): SpotHealingStroke {
  return new SpotHealingStroke(options);
}

/** Same factory naming convention as brush/stroke.ts's `beginStroke`. */
export const beginSpotHealingStroke = createSpotHealingStroke;

interface ActiveSessionStroke {
  readonly stroke: SpotHealingStroke;
  readonly sourceRaster: Raster;
  readonly sourceTransform: LayerTransform;
  readonly layerId: string;
  changed: boolean;
}
interface SessionHealingState { mode: SpotHealingMode; active: ActiveSessionStroke | null }
const sessionStates = new WeakMap<EditorSession, SessionHealingState>();

function sessionState(session: EditorSession): SessionHealingState {
  let state = sessionStates.get(session);
  if (!state) { state = { mode: DEFAULT_SPOT_HEALING_MODE, active: null }; sessionStates.set(session, state); }
  return state;
}

export function getSpotHealingMode(session: EditorSession): SpotHealingMode { return sessionState(session).mode; }
export function setSpotHealingMode(session: EditorSession, mode: SpotHealingMode): void {
  if (!SPOT_HEALING_MODES.includes(mode)) throw new RangeError('Invalid Spot Healing mode');
  sessionState(session).mode = mode; session.notify('ui');
}
export function spotHealingState(session: EditorSession): SpotHealingStrokeState | null {
  return sessionState(session).active?.stroke.state ?? null;
}

/** EditorSession+Brush.beginBrush for the Spot Healing tool. */
export function beginSpotHealing(session: EditorSession, point: Point,
  options: Partial<SpotHealingSettings> & { readonly kernels?: KernelClient } = {}): StrokeUpdate | null {
  const state = sessionState(session), document = session.document, layer = session.activeLayer;
  if (state.active || !canHeal(session, document, layer)) return null;
  const brush = getBrushSettings(session);
  const settings: SpotHealingSettings = {
    diameter: options.diameter ?? brush.diameter,
    hardness: options.hardness ?? brush.hardness,
    opacity: options.opacity ?? brush.opacity,
    mode: options.mode ?? state.mode,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  };
  try {
    const stroke = createSpotHealingStroke({ layer: layer!, canvas: document!, settings,
      selection: document!.selection, pixelLimit: session.limits.maxPixels, kernels: options.kernels });
    const update = stroke.addPoints([point]);
    state.active = { stroke, sourceRaster: layer!.raster!, sourceTransform: layer!.transform,
      layerId: layer!.id, changed: update.dirty.length > 0 };
    session.notify('ui');
    return update;
  } catch (error) {
    session.errorMessage = error instanceof Error ? error.message : String(error); session.notify('ui'); return null;
  }
}

export function addSpotHealingPoints(session: EditorSession, points: Point | readonly Point[],
  options?: { readonly pressure?: number | readonly number[] }): StrokeUpdate | null {
  const active = sessionState(session).active;
  if (!active) return null;
  const update = active.stroke.addPoints(Array.isArray(points) ? points : [points], options);
  active.changed ||= update.dirty.length > 0;
  session.notify('ui');
  return update;
}

/** The stroke in progress for the canvas preview (darkened coverage over the layer). */
export function currentSpotHealingPreview(_session: EditorSession): null { return null; }

export function currentSpotHealingGeometry(session: EditorSession): { readonly diameter: number; readonly points: readonly Point[] } | null {
  return sessionState(session).active?.stroke.geometry ?? null;
}

export function currentSpotHealingRaster(session: EditorSession): Raster | null {
  return sessionState(session).active?.stroke.currentRaster() ?? null;
}

export function cancelSpotHealing(session: EditorSession): boolean {
  const state = sessionState(session), active = state.active;
  if (!active) return false;
  active.stroke.cancel(); state.active = null; session.rasterOverrides.delete(active.layerId); session.notify('document'); return true;
}

export async function finishSpotHealing(session: EditorSession): Promise<StrokeResult | null> {
  const state = sessionState(session), active = state.active;
  if (!active) return null;
  state.active = null;
  session.isProjectBusy = true; session.notify('ui');
  try {
    const result = await active.stroke.finish();
    if (!active.changed) return result;
    const document = session.document, index = document?.layers.findIndex((item) => item.id === active.layerId) ?? -1;
    const layer = index >= 0 ? document!.layers[index]! : null;
    if (!layer || layer.raster !== active.sourceRaster || !sameTransform(layer.transform, active.sourceTransform)) return result;
    const transform = result.transform ?? layer.transform;
    const constrained = session.constrainLayerPixels(layer.id, result.raster, transform);
    if (!constrained) return result;
    const layers = document!.layers.slice();
    let mask = layer.mask;
    if (mask && !mask.placement && (constrained.width !== active.sourceRaster.width
      || constrained.height !== active.sourceRaster.height)) mask = expandAttachedMask(mask, { ...result, raster: constrained });
    layers[index] = { ...layer, raster: constrained, transform, mask };
    session.beginEdit('Spot Healing'); session.replaceDocument({ ...document!, layers }); session.endEdit();
    return result;
  } catch (error) {
    session.errorMessage = error instanceof Error ? error.message : String(error); session.notify('ui'); return null;
  } finally {
    session.rasterOverrides.delete(active.layerId); session.isProjectBusy = false; session.notify('document');
  }
}

function canHeal(session: EditorSession, document: CanvasDocument | null, layer: Layer | null): boolean {
  if (!document || !layer || !layer.raster || layer.raster.channels !== 4 || session.tool !== 'spotHealing'
    || !session.canEditLayers || session.selectedLayerIds.size !== 1 || session.isMaskSelected
    || session.editBlocker(layer.id, 'pixels')
    || layer.adjustment) return false;
  if (!effectiveVisibleIds(document.layers).has(layer.id)) return false;
  return !document.selection || document.selection.mask.tiles.some((tile) => tile?.some((value) => value !== 0));
}

function modeNumber(mode: SpotHealingMode): SpotHealMode {
  return mode === 'createTexture' ? 1 : mode === 'proximityMatch' ? 2 : 0;
}

function extractAlpha(raster: Raster): Uint8Array {
  const rgba = raster.toPixels(), alpha = new Uint8Array(raster.width * raster.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3]!;
  return alpha;
}

function expandedRaster(source: Raster, width: number, height: number, offsetX: number, offsetY: number): Raster {
  if (width === source.width && height === source.height && offsetX === 0 && offsetY === 0) return source;
  let result = Raster.blank(width, height, 4, { format: source.format });
  for (let row = 0; row < source.rows; row++) for (let col = 0; col < source.cols; col++) {
    const tile = source.tiles[row * source.cols + col];
    if (!tile) continue;
    const tw = source.tileWidth(col), th = source.tileHeight(row);
    result = result.withRegion(offsetX + col * TILE, offsetY + row * TILE, tw, th, tile);
  }
  return result;
}

function transformedBounds(transform: Affine, rect: Rect): Rect {
  const points = [
    apply(transform, { x: rect.x, y: rect.y }), apply(transform, { x: rect.x + rect.width, y: rect.y }),
    apply(transform, { x: rect.x, y: rect.y + rect.height }),
    apply(transform, { x: rect.x + rect.width, y: rect.y + rect.height }),
  ];
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function integralUnion(a: Rect, b: Rect): Rect {
  const x = Math.floor(Math.min(a.x, b.x)), y = Math.floor(Math.min(a.y, b.y));
  return { x, y, width: Math.ceil(Math.max(a.x + a.width, b.x + b.width)) - x,
    height: Math.ceil(Math.max(a.y + a.height, b.y + b.height)) - y };
}

function healingResult(raster: Raster, transform: LayerTransform, x: number, y: number,
  sourceWidth: number, sourceHeight: number): StrokeResult {
  const mapping = pixelToDocument(transform, sourceWidth, sourceHeight);
  const middle = apply(mapping, { x: x + raster.width / 2, y: y + raster.height / 2 });
  const size = { width: raster.width * transform.size.width / sourceWidth,
    height: raster.height * transform.size.height / sourceHeight };
  const placed = { ...transform, size, origin: { x: middle.x - size.width / 2, y: middle.y - size.height / 2 } };
  return { raster, transform: placed, bounds: { x, y, width: raster.width, height: raster.height },
    sourceRect: { x: -x, y: -y, width: sourceWidth, height: sourceHeight } };
}

function sameTransform(a: LayerTransform, b: LayerTransform): boolean {
  return a.origin.x === b.origin.x && a.origin.y === b.origin.y && a.size.width === b.size.width
    && a.size.height === b.size.height && a.rotation === b.rotation && a.flipX === b.flipX && a.flipY === b.flipY
    && a.sampling === b.sampling;
}

/** RasterSnapshot mask carry used by BrushStroke commits: newly grown pixels reveal. */
function expandAttachedMask(mask: LayerMask, result: StrokeResult): LayerMask {
  if (mask.raster.width === 1 && mask.raster.height === 1 && mask.raster.pixel(0, 0)[0] === 255) return mask;
  const width = result.raster.width, height = result.raster.height;
  const pixels = new Uint8Array(width * height).fill(255);
  const old = result.sourceRect;
  for (let y = 0; y < old.height; y++) for (let x = 0; x < old.width; x++) {
    const sx = Math.floor(x * mask.raster.width / old.width), sy = Math.floor(y * mask.raster.height / old.height);
    const dx = old.x + x, dy = old.y + y;
    if (dx >= 0 && dy >= 0 && dx < width && dy < height) pixels[dy * width + dx] = mask.raster.pixel(sx, sy)[0] ?? 255;
  }
  return { ...mask, raster: Raster.fromPixels(width, height, 1, pixels) };
}
