import type { CanvasDocument, EmbeddedLayer, Layer } from '../document';
import type { EditorSession } from '../session';
import { derivedLayerSources } from '../session';
import type { Raster } from '../raster';
import { prepareEmbeddedSource, type PrepareEmbeddedOptions } from '../../io/embedded';
import type { PdfPlacementHost } from '../../io/pdf';
import { renderSvg } from '../../io/svg';
import { loadTextEngine, type TextEngine } from '../../text';
import { sha256Hex } from '../../io/sha256';
import { updateLinkedContents } from './commands';
import type { EmbeddedLinkStatus, PreparedEmbeddedSource } from './types';

interface Entry {
  key: string;
  raster: Raster | null;
  pending: Promise<Raster | null> | null;
  error: unknown;
}

interface SessionState {
  document: CanvasDocument | null;
  readonly entries: Map<string, Entry>;
  readonly links: Map<string, EmbeddedLinkStatus>;
}

export interface EmbeddedRuntimeOptions {
  readonly files?: { readFile?(file: { readonly id: string; readonly name: string }): Promise<Blob> };
  readonly codecs?: PrepareEmbeddedOptions['codecs'];
  readonly pdf?: PdfPlacementHost | null;
  readonly changed?: (session: EditorSession) => void;
  readonly failed?: (error: unknown) => void;
}

/** Target-resolution cache used by both canvas renderers through EditorSession's ordinary hooks. */
export class EmbeddedRuntime {
  private readonly states = new WeakMap<EditorSession, SessionState>();
  private vectorEngine: Promise<TextEngine> | null = null;

  constructor(private readonly options: EmbeddedRuntimeOptions = {}) {
    derivedLayerSources.push((session, layer) => layer.kind === 'embedded' ? this.pixels(session, layer) : null);
  }

  private state(session: EditorSession): SessionState {
    let state = this.states.get(session);
    if (!state) { state = { document: null, entries: new Map(), links: new Map() }; this.states.set(session, state); }
    if (state.document !== session.document) {
      state.document = session.document;
      const live = new Set(session.document?.layers.filter((layer) => layer.kind === 'embedded').map((layer) => layer.id) ?? []);
      for (const id of state.entries.keys()) if (!live.has(id)) state.entries.delete(id);
      for (const id of state.links.keys()) if (!live.has(id)) state.links.delete(id);
    }
    return state;
  }

  private target(session: EditorSession, layer: EmbeddedLayer): { width: number; height: number } {
    if (layer.content.mediaType === 'image') return {
      width: Math.max(1, Math.round(layer.content.width ?? layer.raster?.width ?? layer.transform.size.width)),
      height: Math.max(1, Math.round(layer.content.height ?? layer.raster?.height ?? layer.transform.size.height)),
    };
    const shown = session.viewport.pointsPerPixel * (session.viewport.backingScale || 1);
    let scale = Math.min(4, Math.max(1, 2 ** Math.ceil(Math.log2(Math.max(shown, 1e-6)) - 1e-9)));
    let width = Math.max(1, Math.ceil(layer.transform.size.width * scale));
    let height = Math.max(1, Math.ceil(layer.transform.size.height * scale));
    while (width * height > 16_000_000 && scale > 0.125) {
      scale /= 2; width = Math.max(1, Math.ceil(layer.transform.size.width * scale)); height = Math.max(1, Math.ceil(layer.transform.size.height * scale));
    }
    return { width, height };
  }

  private resource(document: CanvasDocument, layer: EmbeddedLayer): { bytes: Uint8Array; mime: string } | null {
    const id = layer.content.assetId;
    const resource = id ? document.resources?.find((value) => value.id === id && value.role === 'embedded') : null;
    return resource ? { bytes: resource.bytes, mime: resource.mime } : null;
  }

  private async linked(layer: EmbeddedLayer): Promise<{ bytes: Uint8Array; mime: string } | null> {
    const files = this.options.files;
    if (!files?.readFile || !layer.content.uri) return null;
    const reference = { id: layer.content.uri, name: layer.content.sourceName };
    const blob = await files.readFile(reference);
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || 'application/octet-stream' };
  }

  private get engine(): Promise<TextEngine> { return this.vectorEngine ??= loadTextEngine(); }

  private async render(session: EditorSession, layer: EmbeddedLayer, width: number, height: number): Promise<Raster | null> {
    const document = session.document;
    if (!document) return null;
    const source = layer.content.mode === 'embedded' ? this.resource(document, layer) : await this.linked(layer);
    if (!source) return layer.raster;
    if (layer.content.mode === 'linked') {
      const hash = sha256Hex(source.bytes);
      this.state(session).links.set(layer.id, { state: hash === layer.content.sha256 ? 'current' : 'changed',
        sha256: hash, checkedAt: Date.now() });
    }
    if (layer.content.mediaType === 'svg') return renderSvg(source.bytes, width, height, await this.engine).raster;
    if (layer.content.mediaType === 'pdf') {
      if (!this.options.pdf) return layer.raster;
      return this.options.pdf.renderPage(source.bytes, layer.content.page ?? 0, width, height);
    }
    const prepared = await prepareEmbeddedSource(source.bytes, layer.content.sourceName, {
      mime: source.mime, mode: layer.content.mode, uri: layer.content.uri, page: layer.content.page,
      codecs: this.options.codecs, pdf: this.options.pdf,
    });
    return prepared.raster;
  }

  pixels(session: EditorSession, layer: EmbeddedLayer): { raster: Raster; transform: EmbeddedLayer['transform'] } | null {
    const state = this.state(session), target = this.target(session, layer);
    const sourceKey = layer.content.mode === 'embedded' ? layer.content.assetId : `${layer.content.uri}:${layer.content.sha256 ?? ''}`;
    const key = `${sourceKey}|${layer.content.mediaType}:${layer.content.page ?? 0}|${target.width}x${target.height}`;
    let entry = state.entries.get(layer.id);
    if (!entry || entry.key !== key) {
      entry = { key, raster: null, pending: null, error: null };
      state.entries.set(layer.id, entry);
    }
    if (!entry.pending && !entry.raster && !entry.error) {
      const current = entry;
      current.pending = this.render(session, layer, target.width, target.height).then((raster) => {
        if (this.state(session).entries.get(layer.id) === current) current.raster = raster;
        this.options.changed?.(session); return raster;
      }, (error: unknown) => {
        current.error = error;
        if (layer.content.mode === 'linked') this.state(session).links.set(layer.id, { state: 'missing', sha256: null,
          checkedAt: Date.now(), message: error instanceof Error ? error.message : String(error) });
        this.options.failed?.(error); return null;
      }).finally(() => { current.pending = null; });
    }
    const raster = entry.raster ?? layer.raster;
    return raster ? { raster, transform: layer.transform } : null;
  }

  async prepare(session: EditorSession): Promise<void> {
    const layers = session.document?.layers.filter((layer): layer is EmbeddedLayer => layer.kind === 'embedded') ?? [];
    for (const layer of layers) this.pixels(session, layer);
    const pending = layers.map((layer) => this.state(session).entries.get(layer.id)?.pending).filter((value): value is Promise<Raster | null> => !!value);
    await Promise.all(pending);
  }

  linkStatus(session: EditorSession, layerId: string): EmbeddedLinkStatus | null {
    return this.state(session).links.get(layerId) ?? null;
  }

  /** Focus/manual refresh. A changed source becomes one undoable parent-document edit. */
  async refreshLinked(session: EditorSession, layerId?: string): Promise<number> {
    const layers = session.document?.layers.filter((layer): layer is EmbeddedLayer => layer.kind === 'embedded'
      && layer.content.mode === 'linked' && (!layerId || layer.id === layerId)) ?? [];
    let changed = 0;
    for (const layer of layers) {
      const checkedAt = Date.now();
      try {
        const source = await this.linked(layer);
        if (!source) {
          this.state(session).links.set(layer.id, { state: 'unavailable', sha256: null, checkedAt,
            message: 'The host cannot reopen this linked file.' });
          continue;
        }
        const hash = sha256Hex(source.bytes);
        if (hash === layer.content.sha256) {
          this.state(session).links.set(layer.id, { state: 'current', sha256: hash, checkedAt }); continue;
        }
        this.state(session).links.set(layer.id, { state: 'changed', sha256: hash, checkedAt });
        const prepared: PreparedEmbeddedSource = await prepareEmbeddedSource(source.bytes, layer.content.sourceName, {
          mime: source.mime, mode: 'linked', uri: layer.content.uri, page: layer.content.page,
          codecs: this.options.codecs, pdf: this.options.pdf,
        });
        if (updateLinkedContents(session, layer.id, prepared)) changed++;
      } catch (error) {
        this.state(session).links.set(layer.id, { state: 'missing', sha256: null, checkedAt,
          message: error instanceof Error ? error.message : String(error) });
      }
    }
    return changed;
  }
}

export function documentHasEmbedded(document: CanvasDocument | null): boolean {
  return document?.layers.some((layer: Layer) => layer.kind === 'embedded') ?? false;
}
