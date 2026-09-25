/**
 * Export requests and planning (PRODUCT-PLAN 6.1, P4): the request model, validation, file names
 * (`<name>@2x.png`), regions and pixel sizes. Synchronous and dependency-light so it stays in the
 * start chunk and the host can ask for a destination before anything is rendered; rendering and
 * encoding live in `./exportPipeline` (loaded on first export) and the export worker.
 */

import { unionRect } from '../core/align';
import { findArtboard, layerContentBounds } from '../core/artboards';
import { descendantIds, MAX_PIXELS, MAX_SIDE, type CanvasDocument } from '../core/document';
import type { Affine, Rect } from '../core/geometry';
import type { RGB } from '../core/model';
import type { EncodeSpec, ExportFormat } from './exportEncode';
import type { ExportInfo } from './exportMetadata';
import type { CmykProfile, CmykRenderingIntent } from '../core/color/cmyk';

export type { ExportFormat } from './exportEncode';
export type { ExportInfo } from './exportMetadata';

export type ExportTarget =
  | { readonly kind: 'document' }
  | { readonly kind: 'artboard'; readonly id: string }
  | { readonly kind: 'layer'; readonly id: string };

/** A scale factor (1, 2, 3 → `@2x` names) or an explicit output size (aspect kept when one side is given). */
export type ExportSize =
  | { readonly scale: number }
  | { readonly width: number; readonly height?: number }
  | { readonly height: number; readonly width?: number };

export interface ExportMetadata {
  /** Embed the document's working-space ICC profile (sRGB), or write an untagged file. */
  readonly colorProfile: 'embed' | 'strip';
  /** Write the resolution (PNG pHYs, JPEG JFIF density, TIFF X/YResolution). WebP/AVIF have no field. */
  readonly resolution: boolean;
  /** Creator/copyright fields as EXIF; null strips all EXIF-like metadata (Photoshop's "None"). */
  readonly info: ExportInfo | null;
}

export interface ExportRequest {
  readonly targets: readonly ExportTarget[];
  readonly format: ExportFormat;
  /** Defaults to `[{ scale: 1 }]`. */
  readonly sizes?: readonly ExportSize[];
  /** 0…1 for JPEG, WebP (lossy) and AVIF. Defaults: JPEG/WebP 0.85, AVIF 0.75. */
  readonly quality?: number;
  /** WebP only. */
  readonly lossless?: boolean;
  /** 16 is allowed for PNG and TIFF. Defaults to 8. */
  readonly bitDepth?: 8 | 16;
  /** PNG/TIFF deflate level. Defaults to 6. */
  readonly compressionLevel?: EncodeSpec['level'];
  /** AVIF encoder speed 0…10. Defaults to 6. */
  readonly speed?: number;
  /** TIFF compression. Defaults to deflate. */
  readonly tiffCompression?: 'lzw' | 'deflate' | 'none';
  /** Pro output conversion. The working document remains RGB. Only TIFF/JPEG accept CMYK. */
  readonly cmyk?: {
    readonly profile: CmykProfile;
    readonly intent: CmykRenderingIntent;
    readonly blackPointCompensation: boolean;
  };
  /** Keep transparency (default for PNG/WebP/AVIF/TIFF). JPEG is always flattened. */
  readonly transparent?: boolean;
  /** Colour under transparent pixels when flattening (0…1). Defaults to white. */
  readonly matte?: RGB;
  readonly metadata?: Partial<ExportMetadata>;
  /** File name stem for the whole-document target (the project name). */
  readonly baseName?: string;
  /** Pixels per inch at 1×; defaults to the document resolution. Scaled exports keep the physical size. */
  readonly resolution?: number;
}

export interface ExportPlanItem {
  readonly name: string;
  readonly target: ExportTarget;
  /** Display name of the target (document, artboard or layer name). */
  readonly label: string;
  readonly size: ExportSize;
  /** Document pixels that are exported. */
  readonly region: Rect;
  readonly width: number;
  readonly height: number;
  readonly dpi: number;
}

export interface ExportFile {
  readonly name: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly bitDepth: 8 | 16;
  readonly item: ExportPlanItem;
  readonly warnings: readonly string[];
}

export interface ExportRenderer {
  /** Straight-alpha RGBA8 of a width × height target whose pixel centres map to the document via `viewToDoc`. */
  readView(document: CanvasDocument, width: number, height: number, viewToDoc: Affine, scale: number): Uint8Array;
  /** Straight-alpha float RGBA, or null when the renderer has no float path (16-bit export falls back to 8-bit samples). */
  readViewFloat?(document: CanvasDocument, width: number, height: number, viewToDoc: Affine, scale: number): Float32Array | null;
}

export interface ExportEncoder {
  encode(pixels: Uint8Array | Uint16Array, width: number, height: number, spec: EncodeSpec, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface ExportRunOptions {
  readonly signal?: AbortSignal;
  readonly encoder?: ExportEncoder;
  readonly onProgress?: (done: number, total: number) => void;
}

export class ExportError extends Error {
  readonly code: 'no-document' | 'no-targets' | 'not-found' | 'empty' | 'too-large' | 'option';
  constructor(code: ExportError['code'], message: string) { super(message); this.name = 'ExportError'; this.code = code; }
}

export const EXPORT_FORMATS: readonly ExportFormat[] = ['png', 'jpeg', 'webp', 'avif', 'tiff'];
export const EXPORT_MIME: Record<ExportFormat, string> = {
  png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', tiff: 'image/tiff',
};
export const EXPORT_EXTENSION: Record<ExportFormat, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', avif: 'avif', tiff: 'tif' };
export const DEFAULT_EXPORT_METADATA: ExportMetadata = { colorProfile: 'embed', resolution: true, info: null };
const WHITE: RGB = { red: 1, green: 1, blue: 1 };
const DEFAULT_QUALITY: Record<ExportFormat, number> = { png: 1, jpeg: 0.85, webp: 0.85, avif: 0.75, tiff: 1 };

export function formatHasAlpha(format: ExportFormat): boolean { return format !== 'jpeg'; }
export function formatSupports16Bit(format: ExportFormat): boolean { return format === 'png' || format === 'tiff'; }

// MARK: Request resolution

export interface Resolved {
  readonly format: ExportFormat;
  readonly sizes: readonly ExportSize[];
  readonly bitDepth: 8 | 16;
  readonly alpha: boolean;
  readonly matte: RGB;
  readonly metadata: ExportMetadata;
  /** Encoder settings without the per-file resolution and the ICC profile bytes (added by the pipeline). */
  readonly spec: Omit<EncodeSpec, 'dpi' | 'icc'>;
}

function fraction(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new ExportError('option', `${name} must be between 0 and 1.`);
  return value;
}

/** Validates a request and fills in defaults. Throws `ExportError('option')`. */
export function resolveExportRequest(request: ExportRequest): Resolved {
  const format = request.format;
  if (!EXPORT_FORMATS.includes(format)) throw new ExportError('option', `Unknown export format “${String(format)}”.`);
  const bitDepth = request.bitDepth ?? 8;
  if (bitDepth !== 8 && bitDepth !== 16) throw new ExportError('option', 'Bit depth must be 8 or 16.');
  if (bitDepth === 16 && !formatSupports16Bit(format)) throw new ExportError('option', `${format.toUpperCase()} export is 8-bit only; 16-bit needs PNG or TIFF.`);
  const sizes = request.sizes?.length ? request.sizes : [{ scale: 1 }];
  const quality = fraction(request.quality ?? DEFAULT_QUALITY[format], 'Quality');
  const speed = request.speed ?? 6;
  if (!Number.isInteger(speed) || speed < 0 || speed > 10) throw new ExportError('option', 'AVIF speed must be an integer from 0 to 10.');
  const level = request.compressionLevel ?? 6;
  if (!Number.isInteger(level) || level < 0 || level > 9) throw new ExportError('option', 'Compression level must be 0…9.');
  if (request.lossless && format !== 'webp') throw new ExportError('option', 'Lossless is a WebP option (PNG and TIFF are always lossless).');
  if (request.cmyk && format !== 'tiff' && format !== 'jpeg') throw new ExportError('option', 'CMYK export is available for TIFF and JPEG only.');
  if (request.cmyk && request.transparent) throw new ExportError('option', 'CMYK export does not support transparency.');
  const matte = request.matte ?? WHITE;
  for (const channel of [matte.red, matte.green, matte.blue]) fraction(channel, 'Matte colour');
  const metadata = { ...DEFAULT_EXPORT_METADATA, ...request.metadata };
  const alpha = !request.cmyk && formatHasAlpha(format) && (request.transparent ?? true);
  return {
    format, sizes, bitDepth, alpha, matte, metadata,
    spec: { format, colorModel: request.cmyk ? 'cmyk' : 'rgb', alpha, quality, lossless: request.lossless ?? false, speed, level,
      tiffCompression: request.tiffCompression ?? (request.cmyk ? 'lzw' : 'deflate'),
      info: metadata.info },
  };
}

// MARK: Planning

/** Characters that are invalid in Windows/macOS/Linux file names, plus control characters. */
export function sanitizeFileStem(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  return cleaned || 'Untitled';
}

function formatScale(scale: number): string { return String(Math.round(scale * 1000) / 1000); }

export function sizeSuffix(size: ExportSize, width: number, height: number): string {
  if ('scale' in size) return size.scale === 1 ? '' : `@${formatScale(size.scale)}x`;
  return `-${width}x${height}`;
}

function outputSize(region: Rect, size: ExportSize): { width: number; height: number } {
  let width: number, height: number;
  if ('scale' in size) {
    if (!Number.isFinite(size.scale) || size.scale <= 0 || size.scale > 64) throw new ExportError('option', 'Export scale must be between 0 and 64.');
    width = Math.max(1, Math.round(region.width * size.scale)); height = Math.max(1, Math.round(region.height * size.scale));
  } else {
    const w = size.width, h = size.height;
    for (const value of [w, h]) if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new ExportError('option', 'Export width and height must be whole pixels.');
    width = w ?? Math.max(1, Math.round(region.width * h! / region.height));
    height = h ?? Math.max(1, Math.round(region.height * w! / region.width));
  }
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new ExportError('too-large', 'Image export supports canvases up to 100 megapixels and 30,000 pixels per side.');
  }
  return { width, height };
}

interface TargetInfo { readonly label: string; readonly region: Rect }

function targetInfo(document: CanvasDocument, target: ExportTarget, baseName: string): TargetInfo {
  if (target.kind === 'document') return { label: baseName, region: { x: 0, y: 0, width: document.width, height: document.height } };
  if (target.kind === 'artboard') {
    const artboard = findArtboard(document, target.id);
    if (!artboard) throw new ExportError('not-found', 'The artboard no longer exists.');
    return { label: artboard.name, region: artboard.rect };
  }
  const layer = document.layers.find((l) => l.id === target.id);
  if (!layer) throw new ExportError('not-found', 'The layer no longer exists.');
  const bounds = unionRect(layerExportIds(document, layer.id).flatMap((id) => {
    const rect = layerContentBounds(document.layers.find((l) => l.id === id)!);
    return rect ? [rect] : [];
  }));
  const x0 = Math.max(0, Math.floor(bounds?.x ?? 0)), y0 = Math.max(0, Math.floor(bounds?.y ?? 0));
  const x1 = Math.min(document.width, Math.ceil(bounds ? bounds.x + bounds.width : 0));
  const y1 = Math.min(document.height, Math.ceil(bounds ? bounds.y + bounds.height : 0));
  if (!bounds || x1 <= x0 || y1 <= y0) throw new ExportError('empty', `“${layer.name}” has no pixels on the canvas to export.`);
  return { label: layer.name, region: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
}

/** Names, regions and pixel sizes of the files a request produces, in target × size order. Synchronous. */
export function planExport(document: CanvasDocument | null, request: ExportRequest): ExportPlanItem[] {
  if (!document) throw new ExportError('no-document', 'There is no canvas to export.');
  if (!request.targets.length) throw new ExportError('no-targets', 'Choose what to export.');
  const resolved = resolveExportRequest(request);
  const baseResolution = request.resolution ?? document.resolution;
  if (!Number.isFinite(baseResolution) || baseResolution <= 0) throw new ExportError('option', 'Resolution must be positive.');
  const used = new Set<string>();
  const items: ExportPlanItem[] = [];
  for (const target of request.targets) {
    const info = targetInfo(document, target, request.baseName ?? 'Untitled');
    for (const size of resolved.sizes) {
      const { width, height } = outputSize(info.region, size);
      const stem = sanitizeFileStem(info.label), suffix = sizeSuffix(size, width, height), extension = EXPORT_EXTENSION[resolved.format];
      let name = `${stem}${suffix}.${extension}`;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem} ${n}${suffix}.${extension}`;
      used.add(name.toLowerCase());
      const dpi = Math.round(baseResolution * width / info.region.width * 1000) / 1000;
      items.push({ name, target, label: info.label, size, region: info.region, width, height, dpi });
    }
  }
  return items;
}

/** The target layer, its descendants and everything clipped/live-masked to them. */
export function layerExportIds(document: CanvasDocument, id: string): string[] {
  const keep = new Set([id, ...descendantIds(document.layers, id)]);
  for (let changed = true; changed;) {
    changed = false;
    for (const layer of document.layers) {
      if (!keep.has(layer.id) && layer.maskSourceId && keep.has(layer.maskSourceId)) {
        keep.add(layer.id);
        for (const d of descendantIds(document.layers, layer.id)) keep.add(d);
        changed = true;
      }
    }
  }
  return document.layers.filter((layer) => keep.has(layer.id)).map((layer) => layer.id);
}

/** Output pixel centres → document for a plan item (scale and offset only). */
export function exportViewToDocument(item: Pick<ExportPlanItem, 'region' | 'width' | 'height'>): Affine {
  return { a: item.region.width / item.width, b: 0, c: 0, d: item.region.height / item.height, tx: item.region.x, ty: item.region.y };
}
