/**
 * Vector layers and vector masks on the canvas (PRODUCT-PLAN A5): loads the CanvasKit engine lazily (with a vector
 * tool or the first document that needs it), renders each vector layer at the canvas resolution and hands the pixels to
 * both compositors through the session's derived sources. Strokes and line-end markers may reach past the layer box,
 * so the rendered grid is padded; the layer's model placement stays the shape's box.
 */

import { loadTextEngine, type TextEngine } from '../../text';
import { derivedLayerSources, derivedMaskSources, derivedPlacements, type EditorSession } from '../../core/session';
import type { Layer, VectorMask, VectorPath, VectorStyle } from '../../core/model';
import { renderVector, renderVectorMask } from '../../core/vector';
import { Raster } from '../../core/raster';
import { apply, concat, invert, pixelToDocument, type LayerTransform } from '../../core/geometry';
import { maskBackground } from '../../core/distort';

/** How far a style's paint reaches past its path (layer units), including antialiasing. */
export function stylePadding(style: VectorStyle): number {
  const stroke = style.stroke;
  if (!stroke || !(stroke.width > 0)) return 0;
  const half = stroke.alignment === 'outside' ? stroke.width : stroke.alignment === 'center' ? stroke.width / 2 : 0;
  const join = (stroke.join ?? 'miter') === 'miter' ? Math.min(stroke.miterLimit ?? 4, 10) : 1;
  const cap = stroke.cap === 'square' ? Math.SQRT2 : 1;
  const markers = (stroke.startMarker ?? 'none') !== 'none' || (stroke.endMarker ?? 'none') !== 'none'
    ? (stroke.markerSize ?? 3) * stroke.width + stroke.width : 0;
  return Math.min(4000, Math.ceil(Math.max(half * join * cap, markers)) + 2);
}

/** The placement of a padded grid around `transform`, which shows `layer` (scaled by a pending resize). */
export function paddedTransform(layer: Layer, transform: LayerTransform, pad: number): LayerTransform {
  if (!pad) return transform;
  const base = layer.transform.size;
  const sx = base.width > 0 ? transform.size.width / base.width : 1, sy = base.height > 0 ? transform.size.height / base.height : 1;
  const width = transform.size.width + 2 * pad * sx, height = transform.size.height + 2 * pad * sy;
  const cx = transform.origin.x + transform.size.width / 2, cy = transform.origin.y + transform.size.height / 2;
  return { ...transform, origin: { x: cx - width / 2, y: cy - height / 2 }, size: { width, height } };
}

const offsets = new WeakMap<readonly VectorPath[], Map<number, readonly VectorPath[]>>();
/** Paths moved by `pad` (stable identity, so repeated renders hit the raster cache). */
export function offsetPaths(paths: readonly VectorPath[], pad: number): readonly VectorPath[] {
  if (!pad) return paths;
  let variants = offsets.get(paths);
  if (!variants) { variants = new Map(); offsets.set(paths, variants); }
  let moved = variants.get(pad);
  if (!moved) {
    const shift = (p: { x: number; y: number }) => ({ x: p.x + pad, y: p.y + pad });
    moved = paths.map((path) => ({ ...path, points: path.points.map((point) => ({ ...point, anchor: shift(point.anchor), in: shift(point.in), out: shift(point.out) })) }));
    variants.clear();
    variants.set(pad, moved);
  }
  return moved;
}

const ids = new WeakMap<object, number>();
let nextId = 1;
function identity(value: object | null | undefined): number {
  if (!value) return 0;
  let id = ids.get(value);
  if (!id) { id = nextId++; ids.set(value, id); }
  return id;
}

/** Imported shapes whose paint the engine cannot draw keep their saved preview (vector-engine report). */
function previewOnly(layer: Layer): boolean {
  if (layer.kind !== 'vector' || !layer.raster) return false;
  return layer.style.fill?.kind === 'pattern' || layer.style.stroke?.paint?.kind === 'pattern' || (!layer.style.fill && !layer.style.stroke);
}

interface Rendered { readonly key: string; readonly raster: Raster }
interface SessionVectors { readonly layers: Map<string, Rendered>; readonly masks: Map<string, Rendered>; document: unknown }

export class VectorRuntime {
  engine: TextEngine | null = null;
  failure: unknown = null;
  private loading: Promise<TextEngine | null> | null = null;
  private readonly states = new WeakMap<EditorSession, SessionVectors>();

  constructor(private readonly changed: () => void, private readonly failed: (error: unknown) => void) {
    derivedLayerSources.push((session, layer) => {
      const raster = this.pixels(session, layer);
      return raster ? { raster, transform: this.placement(session, layer, layer.transform) ?? layer.transform } : null;
    });
    derivedPlacements.push((session, layer, transform) => this.placement(session, layer, transform));
    derivedMaskSources.push((session, layer) => this.mask(session, layer));
  }

  /** Loads CanvasKit once; resolves null when it cannot load (the failure is reported). */
  load(): Promise<TextEngine | null> {
    this.loading ??= loadTextEngine().then((engine) => {
      this.engine = engine;
      this.changed();
      return engine;
    }, (error: unknown) => {
      this.failure = error;
      this.failed(error);
      return null;
    });
    return this.loading;
  }

  get isReady(): boolean { return this.engine !== null; }

  private state(session: EditorSession): SessionVectors {
    let state = this.states.get(session);
    if (!state) { state = { layers: new Map(), masks: new Map(), document: null }; this.states.set(session, state); }
    // Drop layers that left the document.
    if (state.document !== session.document) {
      state.document = session.document;
      const live = new Set(session.document?.layers.map((layer) => layer.id) ?? []);
      for (const id of state.layers.keys()) if (!live.has(id)) state.layers.delete(id);
      for (const id of state.masks.keys()) if (!live.has(id)) state.masks.delete(id);
    }
    return state;
  }

  /** Whole powers of two of the displayed scale, never below 1 (exports read document pixels), at most 4. */
  private scale(session: EditorSession, width: number, height: number): number {
    const viewport = session.viewport;
    const shown = viewport.pointsPerPixel * (viewport.backingScale || 1);
    let scale = Math.min(4, Math.max(1, 2 ** Math.ceil(Math.log2(Math.max(shown, 1e-6)) - 1e-9)));
    while (scale > 1 && width * height * scale * scale > 16_000_000) scale /= 2;
    return scale;
  }

  /** Grid padding for a vector layer's rendered pixels, or null while the engine cannot draw it. */
  padding(layer: Layer): number | null {
    if (layer.kind !== 'vector' || !this.engine || previewOnly(layer)) return null;
    return stylePadding(layer.style);
  }

  private placement(session: EditorSession, layer: Layer, transform: LayerTransform): LayerTransform | null {
    const pad = this.padding(layer);
    if (pad === null) { if (layer.kind === 'vector' && !this.engine) void this.load(); return null; }
    return pad ? paddedTransform(layer, transform, pad) : null;
  }

  pixels(session: EditorSession, layer: Layer): Raster | null {
    if (layer.kind !== 'vector') return null;
    const pad = this.padding(layer);
    if (pad === null) { if (!this.engine) void this.load(); return null; }
    const width = layer.transform.size.width + 2 * pad, height = layer.transform.size.height + 2 * pad;
    if (!(width > 0 && height > 0)) return null;
    const scale = this.scale(session, width, height);
    const key = `${identity(layer.paths)}|${JSON.stringify(layer.style)}|${width}x${height}|${scale}`;
    const state = this.state(session), cached = state.layers.get(layer.id);
    if (cached?.key === key) return cached.raster;
    try {
      const raster = renderVector(this.engine!, offsetPaths(layer.paths, pad), layer.style, width, height, scale);
      state.layers.set(layer.id, { key, raster });
      return raster;
    } catch (error) {
      if (!(error instanceof RangeError)) this.failed(error);
      return cached?.raster ?? null;
    }
  }

  /** A layer's vector mask (combined with an enabled raster mask) over its displayed grid. */
  private mask(session: EditorSession, layer: Layer): Raster | null {
    if (!this.engine) { void this.load(); return null; }
    const pad = layer.kind === 'vector' ? this.padding(layer) : 0;
    if (pad === null || (!layer.vectorMask?.enabled && !pad)) return null;
    const width = layer.transform.size.width + 2 * pad, height = layer.transform.size.height + 2 * pad;
    if (!(width > 0 && height > 0)) return null;
    const raster = layer.mask?.enabled ? layer.mask : null;
    const scale = this.scale(session, width, height);
    const key = JSON.stringify([identity(layer.vectorMask?.enabled ? layer.vectorMask : null), identity(raster?.raster), raster?.placement ?? null,
      width, height, scale, layer.transform]);
    const state = this.state(session), cached = state.masks.get(layer.id);
    if (cached?.key === key) return cached.raster;
    try {
      const vector = layer.vectorMask?.enabled ? layer.vectorMask : null;
      let result = vector
        ? renderVectorMask(this.engine, { ...vector, paths: offsetPaths(vector.paths, pad) }, width, height, scale)
        : Raster.fromPixels(Math.max(1, Math.ceil(width * scale)), Math.max(1, Math.ceil(height * scale)), 1,
          new Uint8Array(Math.max(1, Math.ceil(width * scale)) * Math.max(1, Math.ceil(height * scale))).fill(255));
      if (raster) result = combineRasterMask(layer, paddedTransform(layer, layer.transform, pad), result);
      state.masks.set(layer.id, { key, raster: result });
      return result;
    } catch (error) {
      if (!(error instanceof RangeError)) this.failed(error);
      return cached?.raster ?? null;
    }
  }

  /** The vector mask alone at thumbnail size, for the Layers panel. */
  maskThumbnail(layer: Layer): Raster | null {
    const mask: VectorMask | null = layer.vectorMask;
    if (!mask || !this.engine) return null;
    const { width, height } = layer.transform.size;
    if (!(width > 0 && height > 0)) return null;
    const scale = Math.min(1, 96 / Math.max(width, height));
    try { return renderVectorMask(this.engine, { ...mask, enabled: true, density: 1, feather: 0 }, width, height, scale); } catch { return null; }
  }

  /** Whether the document has content this runtime must draw before its pixels are read. */
  needs(session: EditorSession): boolean {
    return !!session.document?.layers.some((layer) => layer.kind === 'vector' || layer.vectorMask);
  }
}

/** The stored raster mask resampled onto the displayed grid and multiplied in (vector-engine `combineRasterMask`). */
function combineRasterMask(layer: Layer, grid: LayerTransform, vectorMask: Raster): Raster {
  const storedMask = layer.mask!;
  const stored = storedMask.raster, pixels = vectorMask.toPixels(), storedPixels = stored.toPixels();
  const map = concat(pixelToDocument(grid, vectorMask.width, vectorMask.height),
    invert(pixelToDocument(storedMask.placement ?? layer.transform, stored.width, stored.height)));
  const outside = maskBackground(stored);
  const sample = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= stored.width || y >= stored.height) return outside;
    return storedPixels[Math.floor(y) * stored.width + Math.floor(x)]! / 255;
  };
  for (let y = 0; y < vectorMask.height; y++) for (let x = 0; x < vectorMask.width; x++) {
    const point = apply(map, { x: x + 0.5, y: y + 0.5 }), sx = point.x - 0.5, sy = point.y - 0.5;
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    const coverage = sample(x0, y0) * (1 - fx) * (1 - fy) + sample(x0 + 1, y0) * fx * (1 - fy)
      + sample(x0, y0 + 1) * (1 - fx) * fy + sample(x0 + 1, y0 + 1) * fx * fy;
    const index = y * vectorMask.width + x;
    pixels[index] = Math.round(pixels[index]! * coverage);
  }
  return Raster.fromPixels(vectorMask.width, vectorMask.height, 1, pixels);
}
