import type { Raster } from '../core/raster';

/** Optional host boundary for PDF placement. The 4.5 MiB PDFium runtime is never in the startup bundle. */
export interface PdfPlacementHost {
  readonly version: 1;
  inspect(bytes: Uint8Array): Promise<{ readonly pages: number; readonly width: number; readonly height: number }>;
  renderPage(bytes: Uint8Array, page: number, width: number, height: number): Promise<Raster>;
}

export class PdfPlacementUnavailableError extends Error {
  constructor(message = 'PDF placement needs the optional Fernwork PDFium host module.') {
    super(message); this.name = 'PdfPlacementUnavailableError';
  }
}

export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

/** Validates the inexpensive part before handing untrusted bytes to an isolated PDFium host. */
export function validatePdfPlacement(bytes: Uint8Array, page: number): void {
  if (!isPdf(bytes)) throw new Error('The selected file is not a PDF document.');
  if (!Number.isInteger(page) || page < 0) throw new RangeError('PDF page must be a zero-based whole number.');
}
