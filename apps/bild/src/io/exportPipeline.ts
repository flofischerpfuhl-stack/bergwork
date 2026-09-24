/**
 * The single export pipeline (PRODUCT-PLAN 6.1 "ein Export-Dialog", P4 "pro Aufgabe genau ein Weg").
 * Every image export — File > Export As… (the one export dialog) for documents, artboards and layers,
 * `EditorHandle.exportImage` — is an `ExportRequest` that goes through `planExport` (`./exportPlan`:
 * names, regions, pixel sizes; synchronous so the host can ask for a destination first) and
 * `runExport` (render, back, matte, encode off the main thread). Loaded on first export.
 */

import { artboardUnits, findArtboard, type ArtboardBackground } from '../core/artboards';
import { cpuCompositeView, cpuCompositeViewFloat } from '../render/cpuRender';
import { ancestorIds, type CanvasDocument, type Layer } from '../core/document';
import { concat as concatAffine, type Rect } from '../core/geometry';
import type { RGB } from '../core/model';
import type { EncodeSpec } from './exportEncode';
import {
  EXPORT_MIME, exportViewToDocument, layerExportIds, planExport, resolveExportRequest,
  type ExportFile, type ExportPlanItem, type ExportRenderer, type ExportRequest, type ExportRunOptions, type ExportTarget,
} from './exportPlan';
import { srgbIccProfile } from './iccProfile';
import { defaultExportEncoder } from '../workers/exportClient';

export * from './exportPlan';

const BAND_ROWS = 1024;

/** Encoder settings of a request for one planned file. */
function encodeSpec(request: ExportRequest, item: ExportPlanItem): EncodeSpec {
  const resolved = resolveExportRequest(request);
  return { ...resolved.spec, dpi: resolved.metadata.resolution ? item.dpi : null,
    icc: resolved.metadata.colorProfile === 'embed' ? srgbIccProfile() : null };
}

// MARK: What each target renders

/** The document as the target should render: other artboards' content or other layers hidden. */
export function documentForTarget(document: CanvasDocument, target: ExportTarget): CanvasDocument {
  if (target.kind === 'document') return document;
  const hide = (visible: (layer: Layer) => boolean | null): CanvasDocument => ({
    ...document, selection: null,
    layers: document.layers.map((layer) => {
      const value = visible(layer);
      return value === null || value === layer.visible ? layer : { ...layer, visible: value };
    }),
  });
  if (target.kind === 'artboard') {
    const hidden = new Set<string>();
    for (const unit of artboardUnits(document)) {
      if (unit.artboardId !== null && unit.artboardId !== target.id) for (const id of unit.ids) hidden.add(id);
    }
    return hidden.size ? hide((layer) => (hidden.has(layer.id) ? false : null)) : document;
  }
  const keep = new Set(layerExportIds(document, target.id));
  const forced = new Set([target.id, ...ancestorIds(document.layers, target.id)]);
  return hide((layer) => (forced.has(layer.id) ? true : keep.has(layer.id) ? null : false));
}

interface Backdrop { readonly rect: Rect; readonly color: ArtboardBackground }

function backdropsFor(document: CanvasDocument, target: ExportTarget): Backdrop[] {
  if (target.kind === 'layer') return [];
  const artboards = target.kind === 'artboard' ? [findArtboard(document, target.id)!] : document.artboards ?? [];
  return artboards.filter((a) => a.background.alpha > 0).map((a) => ({ rect: a.rect, color: a.background }));
}

// MARK: Rendering

/** Straight-alpha pixels of an output window [x, x+w) × [y, y+h) of the plan item, backed and matted. */
function renderWindow(document: CanvasDocument, item: ExportPlanItem, renderer: ExportRenderer, deep: boolean,
  backdrops: readonly Backdrop[], matte: RGB | null, x: number, y: number, width: number, height: number,
  warnings: Set<string>): Uint8Array | Uint16Array {
  const toDocument = exportViewToDocument(item);
  const view = concatAffine({ a: 1, b: 0, c: 0, d: 1, tx: x, ty: y }, toDocument);
  const scale = Math.min(item.width / item.region.width, item.height / item.region.height);
  let pixels: Uint8Array | Uint16Array;
  if (deep) {
    const float = renderer.readViewFloat?.(document, width, height, view, scale) ?? null;
    if (float) {
      pixels = new Uint16Array(float.length);
      for (let i = 0; i < float.length; i++) { const v = float[i]!; pixels[i] = v <= 0 ? 0 : v >= 1 ? 65535 : Math.round(v * 65535); }
    } else {
      warnings.add('16-bit export used 8-bit rendering: this renderer has no float readback.');
      const bytes = renderer.readView(document, width, height, view, scale);
      pixels = new Uint16Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) pixels[i] = bytes[i]! * 257;
    }
  } else pixels = renderer.readView(document, width, height, view, scale);
  underlay(pixels, width, height, x, y, item, backdrops, matte);
  return pixels;
}

/** Composites artboard backgrounds (topmost first, each under the result) and the matte under the pixels. */
function underlay(pixels: Uint8Array | Uint16Array, width: number, height: number, x: number, y: number,
  item: ExportPlanItem, backdrops: readonly Backdrop[], matte: RGB | null): void {
  const max = pixels instanceof Uint16Array ? 65535 : 255;
  const sx = item.width / item.region.width, sy = item.height / item.region.height;
  const layers: { x0: number; x1: number; y0: number; y1: number; color: ArtboardBackground }[] = [];
  for (let i = backdrops.length - 1; i >= 0; i--) {
    const { rect, color } = backdrops[i]!;
    const x0 = Math.max(0, Math.ceil((rect.x - item.region.x) * sx - 0.5) - x);
    const x1 = Math.min(width, Math.ceil((rect.x + rect.width - item.region.x) * sx - 0.5) - x);
    const y0 = Math.max(0, Math.ceil((rect.y - item.region.y) * sy - 0.5) - y);
    const y1 = Math.min(height, Math.ceil((rect.y + rect.height - item.region.y) * sy - 0.5) - y);
    if (x1 > x0 && y1 > y0) layers.push({ x0, x1, y0, y1, color });
  }
  if (matte) layers.push({ x0: 0, x1: width, y0: 0, y1: height, color: { ...matte, alpha: 1 } });
  for (const { x0, x1, y0, y1, color } of layers) {
    const b = color.alpha, cr = color.red * max, cg = color.green * max, cb = color.blue * max;
    for (let row = y0; row < y1; row++) {
      for (let at = (row * width + x0) * 4, end = (row * width + x1) * 4; at < end; at += 4) {
        const a = pixels[at + 3]! / max;
        if (a >= 1) continue;
        const under = b * (1 - a), out = a + under;
        if (out <= 0) continue;
        pixels[at] = Math.round((pixels[at]! * a + cr * under) / out);
        pixels[at + 1] = Math.round((pixels[at + 1]! * a + cg * under) / out);
        pixels[at + 2] = Math.round((pixels[at + 2]! * a + cb * under) / out);
        pixels[at + 3] = Math.round(out * max);
      }
    }
  }
}

/** Renders a whole plan item in bands. */
export function renderExportItem(document: CanvasDocument, item: ExportPlanItem, request: ExportRequest,
  renderer: ExportRenderer, warnings: Set<string> = new Set()): Uint8Array | Uint16Array {
  const resolved = resolveExportRequest(request);
  const deep = resolved.bitDepth === 16;
  const source = documentForTarget(document, item.target);
  const backdrops = backdropsFor(document, item.target);
  const matte = resolved.alpha ? null : resolved.matte;
  const out = deep ? new Uint16Array(item.width * item.height * 4) : new Uint8Array(item.width * item.height * 4);
  for (let y = 0; y < item.height; y += BAND_ROWS) {
    const rows = Math.min(BAND_ROWS, item.height - y);
    const band = renderWindow(source, item, renderer, deep, backdrops, matte, 0, y, item.width, rows, warnings);
    out.set(band, y * item.width * 4);
  }
  return out;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('The export was cancelled.', 'AbortError');
}

/** Renders and encodes every planned file. Items are encoded one after another (memory stays bounded). */
export async function runExport(document: CanvasDocument | null, request: ExportRequest, renderer: ExportRenderer,
  options: ExportRunOptions = {}): Promise<ExportFile[]> {
  const items = planExport(document, request);
  const resolved = resolveExportRequest(request);
  const encoder = options.encoder ?? defaultExportEncoder();
  const files: ExportFile[] = [];
  for (const [index, item] of items.entries()) {
    throwIfAborted(options.signal);
    const warnings = new Set<string>();
    const pixels = renderExportItem(document!, item, request, renderer, warnings);
    if (resolved.format === 'avif' && resolved.metadata.info) warnings.add('AVIF export does not write EXIF creator fields.');
    const bytes = await encoder.encode(pixels, item.width, item.height, encodeSpec(request, item), options.signal);
    files.push({ name: item.name, mime: EXPORT_MIME[resolved.format], bytes, width: item.width, height: item.height,
      bitDepth: resolved.bitDepth, item, warnings: [...warnings] });
    options.onProgress?.(index + 1, items.length);
  }
  return files;
}

// MARK: File-size preview

export interface ExportSizeEstimate {
  readonly item: ExportPlanItem;
  readonly bytes: number;
  /** True when the whole file was encoded (small outputs): the number is the real size. */
  readonly exact: boolean;
  /** Output pixels that were actually encoded. */
  readonly sampledPixels: number;
}

export interface EstimateOptions extends ExportRunOptions {
  /** Outputs up to this many pixels are encoded in full. Default 1.5 MP. */
  readonly exactLimit?: number;
  /** Tile edge and grid of the full-resolution mosaic used above the limit. Default 256 px, 4 × 4. */
  readonly tile?: number;
  readonly grid?: number;
}

/**
 * Estimates each file's size by really encoding: small outputs in full, large ones as a mosaic of
 * full-resolution tiles spread evenly over the image, extrapolated by pixel count on top of the
 * format's fixed overhead (measured by encoding a 1 × 1 image with the same settings and metadata).
 * Cancel with `signal`; the worker doing the encoding is terminated.
 */
export async function estimateExportSize(document: CanvasDocument | null, request: ExportRequest, renderer: ExportRenderer,
  options: EstimateOptions = {}): Promise<ExportSizeEstimate[]> {
  const items = planExport(document, request);
  const resolved = resolveExportRequest(request);
  const encoder = options.encoder ?? defaultExportEncoder();
  const exactLimit = options.exactLimit ?? 1_500_000, tile = options.tile ?? 256, grid = options.grid ?? 4;
  const deep = resolved.bitDepth === 16;
  const results: ExportSizeEstimate[] = [];
  for (const item of items) {
    throwIfAborted(options.signal);
    const spec = encodeSpec(request, item);
    const total = item.width * item.height;
    if (total <= exactLimit) {
      const pixels = renderExportItem(document!, item, request, renderer);
      const bytes = await encoder.encode(pixels, item.width, item.height, spec, options.signal);
      results.push({ item, bytes: bytes.length, exact: true, sampledPixels: total });
      continue;
    }
    const source = documentForTarget(document!, item.target);
    const backdrops = backdropsFor(document!, item.target);
    const matte = resolved.alpha ? null : resolved.matte;
    const columns = Math.max(1, Math.min(grid, Math.floor(item.width / tile)));
    const rows = Math.max(1, Math.min(grid, Math.floor(item.height / tile)));
    const tw = Math.min(tile, item.width), th = Math.min(tile, item.height);
    const mw = columns * tw, mh = rows * th;
    const mosaic = deep ? new Uint16Array(mw * mh * 4) : new Uint8Array(mw * mh * 4);
    const warnings = new Set<string>();
    for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) {
      const x = columns > 1 ? Math.round((item.width - tw) * i / (columns - 1)) : Math.floor((item.width - tw) / 2);
      const y = rows > 1 ? Math.round((item.height - th) * j / (rows - 1)) : Math.floor((item.height - th) / 2);
      const pixels = renderWindow(source, item, renderer, deep, backdrops, matte, x, y, tw, th, warnings);
      for (let row = 0; row < th; row++) mosaic.set(pixels.subarray(row * tw * 4, (row + 1) * tw * 4), ((j * th + row) * mw + i * tw) * 4);
    }
    throwIfAborted(options.signal);
    // The encoder may take ownership of the buffer (worker transfer): copy the probe pixel first.
    const unit = deep ? new Uint16Array(4) : new Uint8Array(4);
    unit.set(mosaic.subarray(0, 4));
    const sample = (await encoder.encode(mosaic, mw, mh, spec, options.signal)).length;
    const overhead = (await encoder.encode(unit, 1, 1, spec, options.signal)).length;
    const bytes = Math.round(overhead + Math.max(0, sample - overhead) * total / (mw * mh));
    results.push({ item, bytes, exact: false, sampledPixels: mw * mh });
  }
  return results;
}

// MARK: Renderers

/** CPU renderer (the shared CPU path: live filters, layer effects, adjustments). Used headless and in unit tests. */
export function cpuExportRenderer(): ExportRenderer {
  return {
    readView: (document, width, height, viewToDoc) => cpuCompositeView(document, width, height, viewToDoc),
    readViewFloat: (document, width, height, viewToDoc) => cpuCompositeViewFloat(document, width, height, viewToDoc),
  };
}
