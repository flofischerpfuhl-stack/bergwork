import { transformsEqual, pixelToDocument } from '../geometry';
import type { Layer, LayerMask } from '../document';
import { Raster, TILE } from '../raster';
import type { EditorSession } from '../session';
import type { DocumentSelection } from '../selection';
import { DEFAULT_BACKGROUND_SETTINGS, multiplyMasks, normalizedBackgroundSettings,
  countMaskComponents, type BackgroundSettings } from './maskProcessing';
import { SubjectInferenceError, subjectInference, type SubjectInferenceClient, type SubjectInferenceResult,
  type SubjectProgress } from '../../workers/subjectClient';
import type { SubjectStage, SubjectTiming } from '../../workers/subjectProtocol';
import type { SubjectModel, SubjectModelUrls } from './models';

export type SubjectRemovalPhase = 'idle' | SubjectStage | 'ready' | 'applying' | 'error';
export interface SubjectRemovalState {
  phase: SubjectRemovalPhase;
  progress: number;
  error: string | null;
  settings: BackgroundSettings;
  timing: SubjectTiming | null;
  layerId: string | null;
  model: SubjectModel;
  componentCount: number | null;
  downloadedBytes: number;
  totalBytes: number | null;
  downloadResumable: boolean;
}

export interface RemoveBackgroundOptions {
  readonly action?: 'begin' | 'preview' | 'apply' | 'cancel';
  readonly settings?: Partial<BackgroundSettings>;
  readonly model?: SubjectModel;
  readonly modelUrls?: Partial<SubjectModelUrls>;
  /** @deprecated Use `modelUrls.fast`; retained for the existing host integration. */
  readonly modelUrl?: string;
  readonly inference?: Pick<SubjectInferenceClient, 'infer' | 'refine'>;
  readonly onStateChange?: (state: Readonly<SubjectRemovalState>) => void;
}

interface Edit {
  readonly layerId: string;
  readonly source: Raster;
  readonly cacheKey: string;
  readonly selection: DocumentSelection | null;
  readonly transform: Layer['transform'];
  readonly existingMask: LayerMask | null;
  readonly model: SubjectModel;
  readonly modelUrls: Partial<SubjectModelUrls>;
  readonly inference: Pick<SubjectInferenceClient, 'infer' | 'refine'>;
  abort: AbortController;
  generation: number;
  preview: Raster | null;
  componentCount: number | null;
}

interface Context { readonly state: SubjectRemovalState; edit: Edit | null; notify?: RemoveBackgroundOptions['onStateChange'] }
const contexts = new WeakMap<EditorSession, Context>();

function contextFor(session: EditorSession): Context {
  let context = contexts.get(session);
  if (!context) {
    context = { state: { phase: 'idle', progress: 0, error: null, settings: DEFAULT_BACKGROUND_SETTINGS,
      timing: null, layerId: null, model: 'fast', componentCount: null, downloadedBytes: 0, totalBytes: null,
      downloadResumable: false }, edit: null };
    contexts.set(session, context);
  }
  return context;
}

export function subjectRemovalState(session: EditorSession): Readonly<SubjectRemovalState> { return contextFor(session).state; }

function publish(session: EditorSession, context: Context, values: Partial<SubjectRemovalState>, document = false): void {
  Object.assign(context.state, values);
  context.notify?.(context.state);
  session.notify(document ? 'document' : 'ui');
}

function canBegin(session: EditorSession): boolean {
  const layer = session.activeLayer;
  return session.canEditLayers && session.selectedLayerIds.size === 1 && !session.isMaskSelected
    && !!layer?.raster && !layer.adjustment && !session.editBlocker(layer.id, 'pixels');
}

/**
 * Begin, re-preview, apply or cancel Remove Background. Ported from Filters.swift
 * (`beginFilter`, `commitBackgroundMask`) and SubjectRemoval.swift (`subjectMask`).
 */
export async function removeBackground(session: EditorSession, options: RemoveBackgroundOptions = {}): Promise<Readonly<SubjectRemovalState>> {
  const context = contextFor(session);
  context.notify = options.onStateChange ?? context.notify;
  const action = options.action ?? 'begin';
  if (action === 'cancel') { cancel(session, context); return context.state; }
  if (action === 'begin') {
    cancel(session, context);
    if (!canBegin(session)) return context.state;
    const layer = session.activeLayer!;
    const source = layer.raster!;
    const model = options.model ?? 'fast';
    const modelUrls = { ...options.modelUrls };
    if (options.modelUrl && model === 'fast' && modelUrls.fast === undefined) modelUrls.fast = options.modelUrl;
    context.edit = { layerId: layer.id, source, cacheKey: `${source.id}:${source.serial}`, selection: session.selection,
      transform: layer.transform, existingMask: layer.mask, model, modelUrls,
      inference: options.inference ?? subjectInference, abort: new AbortController(), generation: 1, preview: null,
      componentCount: null };
    session.isProjectBusy = true;
    publish(session, context, { settings: normalizedBackgroundSettings(options.settings), phase: 'loading-model',
      progress: 0, error: null, timing: null, layerId: layer.id, model, componentCount: null,
      downloadedBytes: 0, totalBytes: null, downloadResumable: false });
    return runPreview(session, context, true);
  }
  const edit = context.edit;
  if (!edit) return context.state;
  if (options.settings) context.state.settings = normalizedBackgroundSettings({ ...context.state.settings, ...options.settings });
  if (action === 'preview') return runPreview(session, context, false);
  return applyResult(session, context);
}

async function runPreview(session: EditorSession, context: Context, infer: boolean): Promise<Readonly<SubjectRemovalState>> {
  const edit = context.edit;
  if (!edit) return context.state;
  edit.abort.abort(); edit.abort = new AbortController();
  const generation = ++edit.generation;
  publish(session, context, { phase: infer ? 'loading-model' : 'refining', progress: 0, error: null });
  try {
    const report = ({ stage, progress, downloadedBytes, totalBytes }: SubjectProgress): void => {
      if (context.edit === edit && edit.generation === generation) publish(session, context, {
        phase: stage, progress, downloadedBytes: downloadedBytes ?? context.state.downloadedBytes,
        totalBytes: totalBytes === undefined ? context.state.totalBytes : totalBytes,
      });
    };
    const result = infer
      ? await edit.inference.infer(edit.cacheKey, edit.source.toPixels(), edit.source.width, edit.source.height,
        context.state.settings, 1400, edit.model, edit.modelUrls, report, edit.abort.signal)
      : await edit.inference.refine(edit.cacheKey, context.state.settings, 1400, report, edit.abort.signal);
    if (context.edit !== edit || edit.generation !== generation) return context.state;
    if (!sourceStillMatches(session, edit)) throw new Error('The source layer changed; run Remove Background again.');
    const combined = combinedRaster(result, edit);
    edit.preview = combined.raster; edit.componentCount = combined.componentCount;
    session.maskOverrides.set(edit.layerId, combined.raster);
    publish(session, context, { phase: 'ready', progress: 1, timing: result.timing,
      componentCount: combined.componentCount }, true);
  } catch (error) {
    if (context.edit !== edit || edit.generation !== generation || isAbort(error)) return context.state;
    fail(session, context, error);
  }
  return context.state;
}

async function applyResult(session: EditorSession, context: Context): Promise<Readonly<SubjectRemovalState>> {
  const edit = context.edit;
  if (!edit || context.state.phase !== 'ready' || !edit.preview) return context.state;
  edit.abort.abort(); edit.abort = new AbortController();
  const generation = ++edit.generation;
  publish(session, context, { phase: 'applying', progress: 0, error: null });
  try {
    // GuidedMatte.refine uses an unlimited full-size guide for the committed mask, while previews cap at 1400px.
    let result: SubjectInferenceResult | null = null;
    if (context.state.settings.quality === 'advanced' && context.state.settings.refineEdges > 0
      && Math.max(edit.source.width, edit.source.height) > 1400) {
      result = await edit.inference.refine(edit.cacheKey, context.state.settings, Number.MAX_VALUE,
        ({ progress }) => { if (context.edit === edit && edit.generation === generation) publish(session, context, { progress }); }, edit.abort.signal);
    }
    if (context.edit !== edit || edit.generation !== generation) return context.state;
    if (!sourceStillMatches(session, edit)) throw new Error('The source layer changed; run Remove Background again.');
    const combined = result ? combinedRaster(result, edit) : { raster: edit.preview, componentCount: edit.componentCount ?? 0 };
    const raster = combined.raster;
    const document = session.document!;
    const index = document.layers.findIndex((layer) => layer.id === edit.layerId);
    const layer = document.layers[index]!;
    const mask: LayerMask = layer.mask
      ? { ...layer.mask, raster, enabled: true }
      : { raster, enabled: true, placement: null, linked: true };
    const layers = document.layers.slice(); layers[index] = { ...layer, mask };
    session.beginEdit('Remove Background');
    session.maskOverrides.delete(edit.layerId);
    session.document = { ...document, layers };
    session.isMaskSelected = true;
    session.isProjectBusy = false;
    context.edit = null;
    Object.assign(context.state, { phase: 'idle', progress: 0, error: null, layerId: null,
      timing: result?.timing ?? context.state.timing, componentCount: combined.componentCount });
    session.endEdit();
    context.notify?.(context.state);
    session.notify('document');
  } catch (error) {
    if (context.edit === edit && edit.generation === generation && !isAbort(error)) fail(session, context, error);
  }
  return context.state;
}

function combinedRaster(result: SubjectInferenceResult, edit: Edit): { raster: Raster; componentCount: number } {
  let pixels = result.mask;
  const existing = edit.existingMask;
  let base: Uint8Array = new Uint8Array(pixels.length); base.fill(255);
  if (existing?.placement === null && existing.raster.width === edit.source.width && existing.raster.height === edit.source.height) {
    base = existing.raster.toPixels();
    pixels = multiplyMasks(pixels, base);
  }
  if (edit.selection) {
    const coverage = selectionOnLayer(edit.selection, edit.transform, edit.source.width, edit.source.height);
    const blended = new Uint8Array(pixels.length);
    for (let i = 0; i < blended.length; i++) blended[i] = Math.round((pixels[i]! * coverage[i]! + base[i]! * (255 - coverage[i]!)) / 255);
    pixels = blended;
  }
  return { raster: Raster.fromPixels(edit.source.width, edit.source.height, 1, pixels),
    componentCount: countMaskComponents(pixels, edit.source.width, edit.source.height) };
}

function selectionOnLayer(selection: DocumentSelection, transform: Layer['transform'], width: number, height: number): Uint8Array {
  const result = new Uint8Array(width * height), map = pixelToDocument(transform, width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const documentX = map.a * (x + 0.5) + map.c * (y + 0.5) + map.tx;
    const documentY = map.b * (x + 0.5) + map.d * (y + 0.5) + map.ty;
    result[y * width + x] = sampleSelection(selection, documentX, documentY);
  }
  return result;
}

function sampleSelection(selection: DocumentSelection, documentX: number, documentY: number): number {
  const px = documentX - selection.x - 0.5, py = documentY - selection.y - 0.5;
  const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
  return Math.round(selectionByte(selection, x0, y0) * (1 - fx) * (1 - fy) + selectionByte(selection, x0 + 1, y0) * fx * (1 - fy)
    + selectionByte(selection, x0, y0 + 1) * (1 - fx) * fy + selectionByte(selection, x0 + 1, y0 + 1) * fx * fy);
}

function selectionByte(selection: DocumentSelection, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= selection.mask.width || y >= selection.mask.height) return 0;
  const col = Math.floor(x / TILE), row = Math.floor(y / TILE), tile = selection.mask.tiles[row * selection.mask.cols + col];
  return tile?.[(y - row * TILE) * selection.mask.tileWidth(col) + x - col * TILE] ?? 0;
}

function sourceStillMatches(session: EditorSession, edit: Edit): boolean {
  const layer = session.layer(edit.layerId);
  return !!layer && layer.raster === edit.source && transformsEqual(layer.transform, edit.transform);
}

function cancel(session: EditorSession, context: Context): void {
  const edit = context.edit;
  const changed = edit !== null || context.state.phase !== 'idle';
  if (edit) { edit.abort.abort(); session.maskOverrides.delete(edit.layerId); }
  context.edit = null; session.isProjectBusy = false;
  Object.assign(context.state, { phase: 'idle', progress: 0, error: null, timing: null, layerId: null,
    componentCount: null, downloadedBytes: 0, totalBytes: null, downloadResumable: false });
  if (changed) { context.notify?.(context.state); session.notify('document'); }
}

function fail(session: EditorSession, context: Context, error: unknown): void {
  const edit = context.edit;
  if (edit) session.maskOverrides.delete(edit.layerId);
  context.edit = null; session.isProjectBusy = false;
  const inference = error instanceof SubjectInferenceError ? error : null;
  publish(session, context, { phase: 'error', progress: 0, error: error instanceof Error ? error.message : String(error),
    downloadedBytes: inference?.downloadedBytes ?? context.state.downloadedBytes,
    totalBytes: inference?.totalBytes === undefined ? context.state.totalBytes : inference.totalBytes,
    downloadResumable: inference?.resumable ?? false }, true);
}

function isAbort(error: unknown): boolean {
  return typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError';
}

export function subjectCommands(session: EditorSession): {
  removeBackground: { enabled(): boolean; run(): void };
} {
  return { removeBackground: { enabled: () => canBegin(session), run: () => { void removeBackground(session); } } };
}
