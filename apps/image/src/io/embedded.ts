import { Raster } from '../core/raster';
import type { PreparedEmbeddedSource } from '../core/embedded';
import { cpuCompositeRegion } from '../render/cpuRender';
import { loadTextEngine, type TextEngine } from '../text';
import { decodeImageAsset, decodeImageFile, sniffImage, type ImageDecodeOptions } from './imageImport';
import { isPdf, PdfPlacementUnavailableError, type PdfPlacementHost, validatePdfPlacement } from './pdf';
import { readArchive } from './project';
import { renderSvg, svgInfo } from './svg';

export interface PrepareEmbeddedOptions {
  readonly mode?: 'embedded' | 'linked';
  readonly uri?: string;
  readonly mime?: string;
  readonly page?: number;
  readonly modifiedAt?: number;
  readonly codecs?: ImageDecodeOptions['host'];
  readonly pdf?: PdfPlacementHost | null;
  readonly svgEngine?: TextEngine;
  /** Placement preview only; live SVG/PDF renders are generated again at target resolution. */
  readonly maximumPreviewPixels?: number;
}

let vectorEngine: Promise<TextEngine> | null = null;
function engine(): Promise<TextEngine> { return vectorEngine ??= loadTextEngine(); }

function isSvg(bytes: Uint8Array, name: string, mime?: string): boolean {
  if (mime === 'image/svg+xml' || /\.svg$/i.test(name)) return true;
  const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512))).replace(/^\s*<\?xml[^>]*>/i, '').trimStart();
  return prefix.startsWith('<svg') || prefix.startsWith('<!--') && prefix.includes('<svg');
}

function projectName(name: string, mime?: string): boolean {
  return /\.fwimg$/i.test(name) || mime === 'application/x-fernwork-image';
}

export function embeddedMediaType(bytes: Uint8Array, name: string, mime?: string): PreparedEmbeddedSource['mediaType'] {
  if (isSvg(bytes, name, mime)) return 'svg';
  if (isPdf(bytes) || mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (projectName(name, mime)) return 'project';
  if (sniffImage(bytes)) return 'image';
  throw new Error('Choose an image, SVG, PDF, or .fwimg project.');
}

function previewSize(width: number, height: number, maximumPixels: number): { width: number; height: number } {
  const scale = Math.min(1, Math.sqrt(maximumPixels / Math.max(1, width * height)));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Decodes once from authoritative source bytes. No result is ever derived from an earlier resample. */
export async function prepareEmbeddedSource(bytes: Uint8Array, sourceName: string,
  options: PrepareEmbeddedOptions = {}): Promise<PreparedEmbeddedSource> {
  const mediaType = embeddedMediaType(bytes, sourceName, options.mime);
  const common = { bytes, mediaType, sourceName, mode: options.mode ?? 'embedded', uri: options.uri,
    modifiedAt: options.modifiedAt } as const;
  if (mediaType === 'image') {
    const raster = await decodeImageFile(bytes, 100_000_000, { host: options.codecs });
    return { ...common, mime: raster.source?.mime ?? options.mime ?? 'application/octet-stream',
      width: raster.width, height: raster.height, raster };
  }
  if (mediaType === 'svg') {
    const info = svgInfo(bytes), size = previewSize(info.width, info.height, options.maximumPreviewPixels ?? 4_000_000);
    const result = renderSvg(bytes, size.width, size.height, options.svgEngine ?? await engine());
    return { ...common, mime: 'image/svg+xml', width: info.width, height: info.height, raster: result.raster };
  }
  if (mediaType === 'pdf') {
    const page = options.page ?? 0;
    validatePdfPlacement(bytes, page);
    if (!options.pdf) throw new PdfPlacementUnavailableError('PDF placement is unavailable because this host has no configured PDFium module.');
    const info = await options.pdf.inspect(bytes);
    if (page >= info.pages) throw new RangeError(`PDF page ${page + 1} does not exist.`);
    const size = previewSize(info.width, info.height, options.maximumPreviewPixels ?? 4_000_000);
    const raster = await options.pdf.renderPage(bytes, page, size.width, size.height);
    return { ...common, mime: 'application/pdf', page, width: info.width, height: info.height, raster };
  }
  const loaded = await readArchive(new Blob([bytes as BlobPart], { type: 'application/zip' }),
    (asset, mime) => decodeImageAsset(asset, 100_000_000, { host: options.codecs, nativeDecoder: undefined }).then((decoded) => ({
      width: decoded.width, height: decoded.height, channels: 4 as const, data: decoded.data, bitDepth: decoded.bitDepth,
    })));
  const document = loaded.document;
  const pixels = cpuCompositeRegion(document, { x: 0, y: 0, width: document.width, height: document.height });
  return { ...common, mime: 'application/x-fernwork-image', width: document.width, height: document.height,
    raster: Raster.fromPixels(document.width, document.height, 4, pixels) };
}
