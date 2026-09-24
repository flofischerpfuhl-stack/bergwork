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

  constructor(private readonly engine: TextEngine, private readonly fonts: TextFontRegistry) {}

  async prepare(document: CanvasDocument, targetPixelsPerDocumentPixel: number): Promise<readonly MissingFont[]> {
    this.missing = await this.fonts.prepareDocument(document);
    const live = new Set<string>();
    for (const layer of document.layers) {
      if (layer.kind !== 'text') continue;
      live.add(layer.id);
      const key = JSON.stringify([document.resolution, targetPixelsPerDocumentPixel, layer.text, layer.runs,
        layer.paragraphs, layer.box, layer.transform]);
      if (this.entries.get(layer.id)?.key === key) continue;
      const next = layoutTextLayer(this.engine, this.fonts, document, layer, targetPixelsPerDocumentPixel, this.missing);
      this.entries.get(layer.id)?.layout.dispose();
      this.entries.set(layer.id, { key, layout: next });
    }
    for (const [id, entry] of this.entries) if (!live.has(id)) { entry.layout.dispose(); this.entries.delete(id); }
    return this.missing;
  }

  raster(layer: Layer): Raster | null { return layer.kind === 'text' ? this.entries.get(layer.id)?.layout.raster ?? layer.raster : layer.raster ?? null; }
  transform(layer: Layer): LayerTransform { return layer.kind === 'text'
    ? this.entries.get(layer.id)?.layout.transform ?? layer.renderedTransform ?? layer.transform : layer.transform; }
  layout(layerId: string): TextLayerLayout | null { return this.entries.get(layerId)?.layout ?? null; }
  missingFonts(): readonly MissingFont[] { return this.missing; }

  dispose(): void {
    for (const entry of this.entries.values()) entry.layout.dispose();
    this.entries.clear();
  }
}
