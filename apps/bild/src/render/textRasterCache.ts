import type { CanvasDocument, Layer } from '../core/document';
import type { LayerTransform } from '../core/geometry';
import type { Raster } from '../core/raster';
import { layoutTextLayer, type MissingFont, type TextFontRegistry, type TextLayerLayout } from '../core/text';
import type { TextEngine } from '../text';

interface CacheEntry { readonly key: string; readonly layout: TextLayerLayout }

/**
 * Async preparation hook for both renderers. A changed transform/zoom gets a newly shaped target-resolution
 * raster; `raster()` itself stays synchronous for the compositor hot path.
 */
export class TextRasterCache {
  private readonly entries = new Map<string, CacheEntry>();
  private missing: readonly MissingFont[] = [];
  /** Registered families when the entries were shaped; newly loaded fonts reshape every layer. */
  private fontsKey = '';

  constructor(private readonly engine: TextEngine, private readonly fonts: TextFontRegistry) {}

  async prepare(document: CanvasDocument, targetPixelsPerDocumentPixel: number): Promise<readonly MissingFont[]> {
    this.missing = await this.fonts.prepareDocument(document);
    this.update(document, targetPixelsPerDocumentPixel);
    return this.missing;
  }

  /**
   * Synchronous reshaping with the fonts registered so far (typing, zoom). Families that are not registered yet
   * render with the fallback chain; `prepare()` loads embedded/system fonts and reports what is still missing.
   */
  update(document: CanvasDocument, targetPixelsPerDocumentPixel: number): void {
    const fontsKey = [...this.fonts.availableFamilies].sort().join('\u0000');
    if (fontsKey !== this.fontsKey) {
      for (const entry of this.entries.values()) entry.layout.dispose();
      this.entries.clear();
      this.fontsKey = fontsKey;
    }
    const live = new Set<string>();
    for (const layer of document.layers) {
      if (layer.kind !== 'text') continue;
      live.add(layer.id);
      // The placement is not part of the key: moving or rotating a layer never reshapes it (see transform()).
      const key = JSON.stringify([document.resolution, targetPixelsPerDocumentPixel, layer.text, layer.runs,
        layer.paragraphs, layer.box]);
      if (this.entries.get(layer.id)?.key === key) continue;
      const next = layoutTextLayer(this.engine, this.fonts, document, layer, targetPixelsPerDocumentPixel, this.missing);
      this.entries.get(layer.id)?.layout.dispose();
      this.entries.set(layer.id, { key, layout: next });
    }
    for (const [id, entry] of this.entries) if (!live.has(id)) { entry.layout.dispose(); this.entries.delete(id); }
  }

  raster(layer: Layer): Raster | null { return layer.kind === 'text' ? this.entries.get(layer.id)?.layout.raster ?? layer.raster : layer.raster ?? null; }
  /** The layer's live placement with the shaped logical size. */
  transform(layer: Layer): LayerTransform {
    if (layer.kind !== 'text') return layer.transform;
    const shaped = this.entries.get(layer.id)?.layout.transform;
    return shaped ? { ...layer.transform, size: shaped.size } : layer.renderedTransform ?? layer.transform;
  }
  /** Shaped layout; its document-space geometry uses the placement at shaping time. */
  layout(layerId: string): TextLayerLayout | null { return this.entries.get(layerId)?.layout ?? null; }
  missingFonts(): readonly MissingFont[] { return this.missing; }

  dispose(): void {
    for (const entry of this.entries.values()) entry.layout.dispose();
    this.entries.clear();
  }
}
