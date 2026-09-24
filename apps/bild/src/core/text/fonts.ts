import type { CanvasDocument, DocumentFont, TextLayer } from '../document';
import type { TextEngine } from '../../text/types';

/** Structural subset of the versioned host capability, kept core-to-platform import free (A0). */
export interface TextFontHost {
  listSystemFonts(): Promise<readonly { readonly id: string; readonly family: string; readonly style: string;
    readonly postscriptName?: string }[]>;
  loadSystemFont(id: string): Promise<Uint8Array>;
}

export interface BundledFontDescriptor {
  readonly id: string;
  readonly family: string;
  readonly style: string;
  readonly weight: number;
  readonly url: string;
}

export const BUNDLED_TEXT_FONTS: readonly BundledFontDescriptor[] = [
  { id: 'noto-sans-variable', family: 'Noto Sans', style: 'Variable', weight: 400, url: '/fonts/NotoSans-Variable.ttf' },
  { id: 'noto-sans-arabic-variable', family: 'Noto Sans Arabic', style: 'Variable', weight: 400, url: '/fonts/NotoSansArabic-Variable.ttf' },
  { id: 'noto-sans-devanagari-variable', family: 'Noto Sans Devanagari', style: 'Variable', weight: 400,
    url: '/fonts/NotoSansDevanagari-Variable.ttf' },
] as const;

export interface MissingFont {
  readonly family: string;
  readonly substitute: string;
  readonly layerIds: readonly string[];
}

export interface FontResolution {
  readonly requested: string;
  readonly families: readonly string[];
  readonly substitute: string | null;
}

export type BundledFontLoader = (font: BundledFontDescriptor) => Promise<Uint8Array>;

async function defaultBundledLoader(font: BundledFontDescriptor): Promise<Uint8Array> {
  const response = await fetch(font.url);
  if (!response.ok) throw new Error(`Could not load bundled font ${font.url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function requestedFonts(document: CanvasDocument): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const layer of document.layers) {
    if (layer.kind !== 'text') continue;
    for (const run of layer.runs) {
      const list = result.get(run.style.fontFamily);
      if (list) { if (!list.includes(layer.id)) list.push(layer.id); }
      else result.set(run.style.fontFamily, [layer.id]);
    }
  }
  return result;
}

/** Lists missing requested names without mutating the document or silently changing its runs (P11). */
export function listMissingFonts(document: CanvasDocument, availableFamilies: ReadonlySet<string>): MissingFont[] {
  const available = new Map([...availableFamilies].map((family) => [family.toLocaleLowerCase(), family]));
  const result: MissingFont[] = [];
  for (const [family, layerIds] of requestedFonts(document)) {
    if (available.has(family.toLocaleLowerCase())) continue;
    result.push({ family, substitute: 'Noto Sans', layerIds });
  }
  return result.sort((a, b) => a.family.localeCompare(b.family));
}

/**
 * CanvasKit font registry. Host font bytes are requested only from an explicitly user-initiated call;
 * bundled and embedded OFL bytes stay local and may load automatically with a text document.
 */
export class TextFontRegistry {
  private readonly families = new Map<string, string>();
  private readonly registeredIds = new Set<string>();
  private systemFonts: Awaited<ReturnType<TextFontHost['listSystemFonts']>> | null = null;

  constructor(private readonly engine: TextEngine, private readonly host: TextFontHost | null = null,
    private readonly bundledLoader: BundledFontLoader = defaultBundledLoader) {}

  get availableFamilies(): ReadonlySet<string> { return new Set(this.families.values()); }

  async loadBundledFallbacks(): Promise<void> {
    for (const font of BUNDLED_TEXT_FONTS) {
      if (this.registeredIds.has(font.id)) continue;
      const bytes = await this.bundledLoader(font);
      this.engine.registerFont({ id: font.id, family: font.family, bytes, source: font.url });
      this.registeredIds.add(font.id);
      this.families.set(font.family.toLocaleLowerCase(), font.family);
    }
  }

  async prepareDocument(document: CanvasDocument, userInitiatedSystemAccess = false): Promise<readonly MissingFont[]> {
    await this.loadBundledFallbacks();
    for (const font of document.fonts ?? []) {
      if (!font.resourceId || this.registeredIds.has(font.id)) continue;
      const resource = document.resources?.find((value) => value.id === font.resourceId && value.role === 'font');
      if (resource) {
        this.engine.registerFont({ id: font.id, family: font.family, bytes: resource.bytes, source: `embedded:${resource.id}` });
        this.registeredIds.add(font.id);
        this.families.set(font.family.toLocaleLowerCase(), font.family);
      }
    }
    if (userInitiatedSystemAccess && this.host) {
      this.systemFonts ??= await this.host.listSystemFonts();
      const wanted = requestedFonts(document);
      for (const [family] of wanted) {
        if (this.families.has(family.toLocaleLowerCase())) continue;
        const matches = this.systemFonts.filter((value) => value.family.toLocaleLowerCase() === family.toLocaleLowerCase());
        for (const system of matches) {
          const id = `system:${system.id}`;
          if (this.registeredIds.has(id)) continue;
          const bytes = await this.host.loadSystemFont(system.id);
          this.engine.registerFont({ id, family: system.family, bytes, source: 'system' });
          this.registeredIds.add(id);
          this.families.set(system.family.toLocaleLowerCase(), system.family);
        }
      }
    }
    return listMissingFonts(document, this.availableFamilies);
  }

  resolution(requested: string): FontResolution {
    const actual = this.families.get(requested.toLocaleLowerCase());
    const fallbacks = ['Noto Sans', 'Noto Sans Arabic', 'Noto Sans Devanagari'];
    return { requested, families: [...new Set([actual ?? requested, ...fallbacks])], substitute: actual ? null : 'Noto Sans' };
  }
}

export interface EmbeddableFont {
  readonly id: string;
  readonly family: string;
  readonly style: string;
  readonly weight: number;
  readonly postscriptName?: string;
  readonly bytes: Uint8Array;
  readonly mime?: string;
  readonly source: DocumentFont['source'];
  readonly embeddingAllowed: boolean;
}

/** Adds font bytes only when their licence explicitly allows embedding; otherwise stores name metadata. */
export function addDocumentFont(document: CanvasDocument, font: EmbeddableFont): CanvasDocument {
  const resourceId = font.embeddingAllowed ? `font-${font.id}` : undefined;
  const previousResourceId = document.fonts?.find((value) => value.id === font.id)?.resourceId;
  const record: DocumentFont = { id: font.id, family: font.family, style: font.style, weight: font.weight,
    source: font.source, embeddingAllowed: font.embeddingAllowed, ...(font.postscriptName ? { postscriptName: font.postscriptName } : {}),
    ...(resourceId ? { resourceId } : {}) };
  const fonts = [...(document.fonts ?? []).filter((value) => value.id !== font.id), record];
  const retainedResources = (document.resources ?? []).filter((value) => value.id !== resourceId && value.id !== previousResourceId);
  const resources = resourceId ? [...retainedResources,
    { id: resourceId, role: 'font' as const, mime: font.mime ?? 'font/ttf', bytes: font.bytes }]
    : retainedResources.length || document.resources ? retainedResources : undefined;
  return { ...document, fonts, ...(resources ? { resources } : {}) };
}

export function textLayers(document: CanvasDocument): readonly TextLayer[] {
  return document.layers.filter((layer): layer is TextLayer => layer.kind === 'text');
}
