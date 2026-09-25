/**
 * The text engine inside the editor (PRODUCT-PLAN A5, P11): loads CanvasKit and the bundled fonts once, keeps one
 * TextRasterCache per tab, shapes text at the canvas resolution and hands the pixels to both renderers through
 * `derivedLayerSources`. Loaded lazily with the Text tool or the first document that contains text.
 */

import { loadSharedTextEngine, type TextEngine } from '../../text';
import {
  BUNDLED_TEXT_FONTS, listMissingFonts, TextFontRegistry, type MissingFont, type TextFontHost, type TextLayerLayout,
} from '../../core/text';
import { DEFAULT_TEXT_STYLE, newLayer } from '../../core/document';
import { TextRasterCache } from '../../render/textRasterCache';
import { derivedLayerSources, derivedPlacements, type EditorSession } from '../../core/session';
import type { CanvasDocument, Layer, TextLayer } from '../../core/document';
import { makeTransform, pixelToDocument, type Affine, type LayerTransform, type Point, type Rect, type Size } from '../../core/geometry';
import type { FontHost, SystemFont } from '../../platform/hosts';

interface SessionText {
  readonly cache: TextRasterCache;
  document: CanvasDocument | null;
  scale: number;
  /** Requested families and embedded fonts at the last font preparation. */
  requested: string;
  preparing: boolean;
  again: boolean;
  /** Missing fonts after the document's fonts were prepared; null until then. */
  missing: readonly MissingFont[] | null;
}

/**
 * Geometry of one shaped text layer (UTF-16 offsets). Caret and range rectangles are in layout pixels, where lines are
 * straight; `toRaster`/`polygon` carry them onto the drawn raster, bending them along a path or through a warp (for
 * straight text layout and raster pixels coincide).
 */
export interface TextGeometry {
  readonly layer: TextLayer;
  readonly width: number;
  readonly height: number;
  /** Raster pixels → document pixels, as the layer is drawn. */
  readonly toDocument: Affine;
  /** Text on a path or warped text: layout and raster pixels differ. */
  readonly bent: boolean;
  /** Caret index at a raster point. */
  caretIndex(local: Point): number;
  /** Caret index at a layout point. */
  layoutIndex(point: Point): number;
  caretRect(index: number): Rect;
  selectionRects(from: number, to: number): readonly Rect[];
  toRaster(point: Point): Point;
  polygon(rect: Rect): Point[];
}

export const BUNDLED_FAMILIES = [...new Set(BUNDLED_TEXT_FONTS.map((font) => font.family))];

function requestedFamilies(document: CanvasDocument): string[] {
  const families = new Set<string>();
  for (const layer of document.layers) if (layer.kind === 'text') for (const run of layer.runs) families.add(run.style.fontFamily);
  return [...families].sort();
}

const largestTexts = new WeakMap<CanvasDocument, number>();
function largestText(document: CanvasDocument): number {
  let largest = largestTexts.get(document);
  if (largest === undefined) {
    largest = 1;
    for (const layer of document.layers) {
      if (layer.kind === 'text') largest = Math.max(largest, layer.transform.size.width, layer.transform.size.height);
    }
    largestTexts.set(document, largest);
  }
  return largest;
}

/**
 * The same shaped layout seen in raster pixels: the layout keeps its paragraphs and only its placement changes, so
 * caret and range geometry can be mapped with the layer's real (rotated, flipped) placement instead of axis-aligned
 * document boxes.
 */
function rasterSpace(layout: TextLayerLayout): TextLayerLayout {
  const transform = makeTransform({ x: 0, y: 0 }, { width: layout.raster.width, height: layout.raster.height });
  return Object.create(layout, { transform: { value: transform } }) as TextLayerLayout;
}

export class TextRuntime {
  engine: TextEngine | null = null;
  registry: TextFontRegistry | null = null;
  readonly ready: Promise<void>;
  failure: unknown = null;
  /** Installed fonts offered by the host after the user asked for them (Local Font Access needs a gesture). */
  systemFonts: readonly SystemFont[] | null = null;
  private readonly states = new WeakMap<EditorSession, SessionText>();
  /** Sessions that asked for pixels before the engine was ready; they redraw once it is. */
  private readonly waiting = new Set<EditorSession>();
  /** Documents whose missing fonts were announced (once per document, P11), and those whose notice is open. */
  private readonly announced = new Set<string>();
  private readonly notices = new Set<string>();
  private listedFonts: Promise<readonly SystemFont[]> | null = null;

  constructor(private readonly host: FontHost | null, private readonly changed: (session: EditorSession) => void,
    private readonly failed: (error: unknown) => void) {
    this.ready = this.start();
    derivedLayerSources.push((session, layer) => this.pixels(session, layer));
    // Text on a path and warped text reach past their frame: a dragged transform places their pixels accordingly.
    derivedPlacements.push((session, layer, transform) => (layer.kind === 'text'
      ? this.states.get(session)?.cache.placementFor(layer, transform) ?? null : null));
  }

  private async start(): Promise<void> {
    try {
      const engine = await loadSharedTextEngine();
      const registry = new TextFontRegistry(engine, this.fontHost());
      await registry.loadBundledFallbacks();
      this.engine = engine;
      this.registry = registry;
    } catch (error) {
      this.failure = error;
      this.failed(error);
      return;
    }
    for (const session of this.waiting) this.changed(session);
    this.waiting.clear();
  }

  get isReady(): boolean { return this.registry !== null; }

  /** Lists installed fonts once per page and only from a user-initiated call; empty lists are not cached. */
  private fontHost(): TextFontHost | null {
    const host = this.host;
    if (!host) return null;
    return {
      listSystemFonts: () => this.listSystemFonts(host),
      loadSystemFont: (id) => host.loadSystemFont(id),
    };
  }
  private async listSystemFonts(host: FontHost): Promise<readonly SystemFont[]> {
    this.listedFonts ??= host.listSystemFonts().then((fonts) => {
      if (!fonts.length) this.listedFonts = null;
      return fonts;
    }, (error: unknown) => { this.listedFonts = null; throw error; });
    return this.listedFonts;
  }

  get canListSystemFonts(): boolean { return this.host !== null; }

  /** Asks the host for its installed fonts (call from a click) and resolves any that the document is missing. */
  async loadSystemFonts(session: EditorSession): Promise<void> {
    if (!this.host) return;
    const fonts = await this.listSystemFonts(this.host).catch(() => []);
    this.systemFonts = fonts;
    await this.ready;
    const document = session.document;
    if (document && this.registry) {
      await this.registry.prepareDocument(document, true).catch(() => []);
      this.refresh(session);
    }
    this.changed(session);
  }

  /** Makes a family renderable before it is applied: bundled and registered fonts at once, system fonts by loading. */
  async ensureFamily(family: string): Promise<void> {
    await this.ready;
    const registry = this.registry;
    if (!registry || this.available(family) || !this.systemFonts?.some((font) => font.family === family)) return;
    const layer = newLayer({ id: 'font-probe', name: family, kind: 'text', text: 'A',
      runs: [{ from: 0, to: 1, style: { ...DEFAULT_TEXT_STYLE, fontFamily: family } }],
      transform: makeTransform({ x: 0, y: 0 }, { width: 1, height: 1 }) });
    await registry.prepareDocument({ id: 'font-probe', width: 1, height: 1, resolution: 72, layers: [layer], selection: null }, true);
  }

  available(family: string): boolean {
    const wanted = family.toLocaleLowerCase();
    return [...this.registry?.availableFamilies ?? []].some((value) => value.toLocaleLowerCase() === wanted);
  }

  private state(session: EditorSession): SessionText | null {
    let state = this.states.get(session);
    if (state) return state;
    if (!this.engine || !this.registry) {
      this.waiting.add(session);
      return null;
    }
    state = { cache: new TextRasterCache(this.engine, this.registry), document: null, scale: 1, requested: '',
      preparing: false, again: false, missing: null };
    this.states.set(session, state);
    return state;
  }

  /**
   * Target raster scale for the canvas: whole powers of two of the displayed scale, never below 1× (exports and merges
   * read document pixels) and never above 4×.
   */
  targetScale(session: EditorSession): number {
    const viewport = session.viewport;
    const shown = viewport.pointsPerPixel * (viewport.backingScale || 1);
    let scale = Math.min(4, Math.max(1, 2 ** Math.ceil(Math.log2(Math.max(shown, 1e-6)) - 1e-9)));
    const largest = session.document ? largestText(session.document) : 1;
    while (scale > 1 && largest * scale > 8192) scale /= 2;
    return scale;
  }

  /** Reshapes changed text layers synchronously; loads fonts for new families in the background. */
  update(session: EditorSession): void {
    const document = session.document;
    const state = this.state(session);
    if (!state || !document) return;
    const scale = this.targetScale(session);
    if (state.document === document && state.scale === scale) return;
    try {
      state.cache.update(document, scale);
    } catch (error) {
      this.failed(error);
    }
    state.document = document;
    state.scale = scale;
    const requested = JSON.stringify([requestedFamilies(document), (document.fonts ?? []).map((font) => font.id)]);
    if (requested !== state.requested) {
      state.requested = requested;
      this.prepareFonts(session, state);
    }
  }

  private prepareFonts(session: EditorSession, state: SessionText): void {
    if (state.preparing) { state.again = true; return; }
    state.preparing = true;
    void (async () => {
      try {
        do {
          state.again = false;
          const document = session.document;
          if (document) await this.registry!.prepareDocument(document);
        } while (state.again);
      } catch (error) {
        this.failed(error);
      } finally {
        state.preparing = false;
      }
      this.refresh(session);
      this.changed(session);
    })();
  }

  /** Recomputes missing fonts and reshapes with whatever fonts are registered now. */
  private refresh(session: EditorSession): void {
    const state = this.state(session);
    if (!state) return;
    state.document = null;
    this.update(session);
    const document = session.document;
    state.missing = document && this.registry ? listMissingFonts(document, this.registry.availableFamilies) : [];
    if (!document) return;
    if (!state.missing.length) this.notices.delete(document.id);
    else if (!this.announced.has(document.id)) { this.announced.add(document.id); this.notices.add(document.id); }
  }

  /** Finishes font loading and shaping before pixels are read (export, merges). */
  async settle(session: EditorSession): Promise<void> {
    await this.ready;
    this.update(session);
    const state = this.state(session);
    for (let i = 0; state?.preparing && i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    this.update(session);
  }

  /** The shaped pixels of a text layer; imported previews stay on screen until the text is edited (P11). */
  private pixels(session: EditorSession, layer: Layer): { raster: import('../../core/raster').Raster; transform: LayerTransform } | null {
    if (layer.kind !== 'text' || layer.raster) return null;
    this.update(session);
    const state = this.states.get(session);
    const layout = state?.cache.layout(layer.id);
    if (!state || !layout) return null;
    return { raster: layout.raster, transform: this.displayTransform(state, layer) };
  }

  /**
   * The stored placement at the shaped size: text is never resampled. (Resizing a text layer changes its type size,
   * scaleTextWithTransform; point text keeps its stored size in step while it is edited, editor.ts.)
   */
  private displayTransform(state: SessionText, layer: TextLayer): LayerTransform {
    return state.cache.transform(layer);
  }

  /** Logical (document-pixel) size of the shaped text, or null before it is shaped. */
  shapedSize(session: EditorSession, layerId: string): Size | null {
    this.update(session);
    const state = this.states.get(session);
    const layer = session.layer(layerId);
    if (!state || layer?.kind !== 'text' || !state.cache.layout(layerId)) return null;
    return state.cache.frameSize(layerId);
  }

  geometry(session: EditorSession, layerId: string): TextGeometry | null {
    this.update(session);
    const state = this.states.get(session);
    const layer = session.layer(layerId);
    const shaped = state?.cache.layout(layerId);
    if (!state || !shaped || layer?.kind !== 'text') return null;
    const local = rasterSpace(shaped);
    const width = shaped.raster.width, bent = shaped.rasterOffset.x !== 0 || shaped.rasterOffset.y !== 0 || shaped.onPath;
    // Straight text: the raster is the line box; bent text: vertical caret moves stay within the laid-out lines.
    const height = bent ? shaped.layoutHeight : shaped.raster.height;
    const clamp = (index: number) => Math.max(0, Math.min(layer.text.length, Math.round(index)));
    return {
      layer, width, height, bent, toDocument: pixelToDocument(this.displayTransform(state, layer), width, shaped.raster.height),
      caretIndex: (point) => { try { return clamp(local.caretPosition(point)); } catch { return layer.text.length; } },
      layoutIndex: (point) => { try { return clamp(shaped.layoutIndexAt(point)); } catch { return layer.text.length; } },
      caretRect: (index) => { try { return shaped.layoutCaretRect(clamp(index)); } catch { return { x: 0, y: 0, width: 1, height } } },
      selectionRects: (from, to) => { try { return shaped.layoutSelectionRects(clamp(from), clamp(to)); } catch { return []; } },
      toRaster: (point) => shaped.toRaster(point),
      polygon: (rect) => shaped.polygon(rect),
    };
  }

  /** Frees a closed tab's shaped layouts. */
  release(session: EditorSession): void {
    this.states.get(session)?.cache.dispose();
    this.states.delete(session);
    this.waiting.delete(session);
  }

  /** Missing fonts of the session's document once its fonts were prepared. */
  missingFonts(session: EditorSession): readonly MissingFont[] {
    const state = this.states.get(session);
    return state?.missing ?? [];
  }
  noticeShown(session: EditorSession): boolean {
    const document = session.document;
    return !!document && this.notices.has(document.id) && this.missingFonts(session).length > 0;
  }
  dismissNotice(session: EditorSession): void {
    if (session.document) this.notices.delete(session.document.id);
    this.changed(session);
  }
}
