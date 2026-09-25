/**
 * Batch export (PRODUCT-PLAN 6.9 „Stapel-Export“, core task 14): a queue of files, or of the current document's
 * artboards or layers, each opened → given a recipe (optional) → exported with Export As settings through the one
 * export pipeline (`exportPlan`/`exportPipeline`, P4) → written to the target folder → closed.
 *
 * Memory (A4): items are processed strictly one after another and nothing of an item is kept after it is written,
 * so at most one opened file is in memory. Opening, rendering and writing are host services injected as
 * `BatchServices` (the editor supplies its canvas renderer and FileSystemHost; unit tests the CPU renderer).
 *
 * Errors stay per item: a file that cannot be opened or exported is marked failed with its error and the queue
 * goes on. Cancelling stops after the current step; unfinished items stay pending, so the same queue can be
 * resumed (or its failed items retried) and every item keeps its `{index}`.
 */

import { newLayer, type CanvasDocument, type Layer } from '../core/document';
import { makeTransform } from '../core/geometry';
import { uuid } from '../core/ids';
import { Raster } from '../core/raster';
import { acceptsRecipe, applyRecipeToLayers, cropToAspect, resizedSize, type Recipe } from '../core/recipes';
import {
  EXPORT_EXTENSION, planExport, resolveExportRequest, sanitizeFileStem, sizeSuffix,
  type ExportFile, type ExportRenderer, type ExportRequest, type ExportSize, type ExportTarget,
} from './exportPlan';
import type { FileSystemHost, FolderTarget } from '../platform/hosts/types';
import { Zip64StreamWriter } from './zipStream';

export type BatchSource =
  /** A file, read only when its turn comes. */
  | { readonly kind: 'file'; read(): Promise<Blob> }
  | { readonly kind: 'artboard'; readonly id: string }
  | { readonly kind: 'layer'; readonly id: string };

export interface BatchItem {
  readonly id: string;
  /** The file name (with extension) or the artboard/layer name. */
  readonly name: string;
  readonly source: BatchSource;
}

export type BatchStatus = 'pending' | 'running' | 'done' | 'failed';

export interface BatchItemState {
  readonly item: BatchItem;
  readonly status: BatchStatus;
  readonly error: unknown;
  /** Names actually written for this item. */
  readonly outputs: readonly string[];
}

/** Export As settings without targets and base name: the same request fields the export dialog builds. */
export type BatchExportSettings = Omit<ExportRequest, 'targets' | 'baseName'>;

export interface BatchSettings {
  readonly recipe: Recipe | null;
  readonly export: BatchExportSettings;
  /** File name pattern with {name} {index} {w} {h}; the extension (and an @2x-style suffix) is added. */
  readonly pattern: string;
}

/** An item opened for processing: its document and what of it is exported. */
export interface OpenedItem {
  readonly document: CanvasDocument;
  readonly target: ExportTarget;
  /** `{name}`: the file name without extension, or the artboard/layer name. */
  readonly name: string;
}

export interface BatchServices {
  open(item: BatchItem, signal: AbortSignal): Promise<OpenedItem>;
  /** Renders one target of a document into a one-layer document of the target's size (see `flattenTarget`). */
  flatten(document: CanvasDocument, target: ExportTarget, deep: boolean): Promise<CanvasDocument>;
  /** Renders and encodes a request (the export pipeline's `runExport`). */
  export(document: CanvasDocument, request: ExportRequest, signal: AbortSignal): Promise<ExportFile[]>;
  /** Writes one file; returns the name it was written under. */
  write(name: string, file: ExportFile, signal: AbortSignal): Promise<string>;
}

export interface BatchRunOptions {
  readonly signal?: AbortSignal;
  /** Called with a new snapshot of all item states whenever one changes. */
  readonly onChange?: (states: readonly BatchItemState[]) => void;
}

export interface BatchSummary { readonly done: number; readonly failed: number; readonly pending: number }

export function pendingState(item: BatchItem): BatchItemState { return { item, status: 'pending', error: null, outputs: [] }; }

export function summarize(states: readonly BatchItemState[]): BatchSummary {
  let done = 0, failed = 0, pending = 0;
  for (const state of states) {
    if (state.status === 'done') done++;
    else if (state.status === 'failed') failed++;
    else pending++;
  }
  return { done, failed, pending };
}

/** Failed items back to pending, so the next run retries them. */
export function retryFailed(states: readonly BatchItemState[]): BatchItemState[] {
  return states.map((state) => (state.status === 'failed' ? pendingState(state.item) : state));
}

// MARK: Names

export const BATCH_TOKENS = ['{name}', '{index}', '{w}', '{h}'] as const;
export const DEFAULT_BATCH_PATTERN = '{name}';

/** The file stem of one output: tokens replaced ({index} 1-based, zero-padded to the queue length), then sanitised. */
export function batchFileStem(pattern: string, values: { name: string; index: number; total: number; width: number; height: number }): string {
  const digits = String(Math.max(1, values.total)).length;
  const stem = (pattern.trim() || DEFAULT_BATCH_PATTERN)
    .replaceAll('{name}', values.name)
    .replaceAll('{index}', String(values.index).padStart(digits, '0'))
    .replaceAll('{w}', String(values.width))
    .replaceAll('{h}', String(values.height));
  return sanitizeFileStem(stem);
}

/** Whether a pattern gives every item its own name (otherwise the files are told apart by " 2", " 3"). */
export function patternIsUnique(pattern: string): boolean {
  const value = pattern.trim() || DEFAULT_BATCH_PATTERN;
  return value.includes('{name}') || value.includes('{index}');
}

/** `name.png`, `name 2.png`, … : the first candidate `taken` does not know. */
export async function uniqueName(name: string, taken: (candidate: string) => boolean | Promise<boolean>): Promise<string> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name, extension = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  for (let n = 2; await taken(candidate); n++) candidate = `${stem} ${n}${extension}`;
  return candidate;
}

// MARK: Processing one item

/** The one content layer of a single-layer document (a decoded image), which a recipe can go on directly. */
function singleContentLayer(document: CanvasDocument): Layer | null {
  const [only] = document.layers;
  return document.layers.length === 1 && only && only.visible && acceptsRecipe(only) ? only : null;
}

/** Export sizes for an item: the settings' sizes, relative to the recipe's resized output when it has one. */
export function itemSizes(document: CanvasDocument, target: ExportTarget, settings: BatchSettings): { sizes: ExportSize[]; suffixSizes: ExportSize[] } {
  const base = settings.export.sizes?.length ? [...settings.export.sizes] : [{ scale: 1 }];
  const resize = settings.recipe?.resize;
  if (!resize) return { sizes: base, suffixSizes: base };
  const [item] = planExport(document, { targets: [target], format: settings.export.format });
  const resized = resizedSize(item!.region.width, item!.region.height, resize);
  const sizes = base.map((size): ExportSize => ('scale' in size
    ? { width: Math.max(1, Math.round(resized.width * size.scale)), height: Math.max(1, Math.round(resized.height * size.scale)) }
    : size));
  return { sizes, suffixSizes: base };
}

/** Opens, applies the recipe, exports and writes one item. Returns the written names. */
export async function processBatchItem(item: BatchItem, index: number, total: number, settings: BatchSettings,
  services: BatchServices, signal: AbortSignal): Promise<string[]> {
  const opened = await services.open(item, signal);
  throwIfAborted(signal);
  let { document, target } = opened;
  const recipe = settings.recipe;
  const deep = resolveExportRequest({ ...settings.export, targets: [target] }).bitDepth === 16;
  let flattened = false;
  const flatten = async () => {
    if (flattened) return;
    document = await services.flatten(document, target, deep);
    target = { kind: 'document' };
    flattened = true;
  };
  if (recipe?.steps.length) {
    let layerId: string | null = null;
    if (target.kind === 'layer' && !recipe.crop) layerId = target.id;
    else if (target.kind === 'document') layerId = singleContentLayer(document)?.id ?? null;
    if (!layerId) { await flatten(); layerId = document.layers[0]!.id; }
    const applied = applyRecipeToLayers(document, [layerId], recipe);
    if (!applied.applied.length) throw new Error(applied.skipped[0]?.reason ?? 'The recipe could not be applied.');
    document = applied.document;
  }
  if (recipe?.crop) {
    if (target.kind !== 'document') await flatten();
    document = cropToAspect(document, recipe.crop);
  }
  throwIfAborted(signal);
  const { sizes, suffixSizes } = itemSizes(document, target, settings);
  const request: ExportRequest = { ...settings.export, targets: [target], sizes, baseName: opened.name };
  const files = await services.export(document, request, signal);
  const extension = EXPORT_EXTENSION[request.format];
  const written: string[] = [];
  for (const [at, file] of files.entries()) {
    throwIfAborted(signal);
    const size = suffixSizes[at] ?? { scale: 1 };
    const suffix = 'scale' in size ? sizeSuffix(size, file.width, file.height) : suffixSizes.length > 1 ? `-${file.width}x${file.height}` : '';
    const stem = batchFileStem(settings.pattern, { name: opened.name, index, total, width: file.width, height: file.height });
    written.push(await services.write(`${stem}${suffix}.${extension}`, file, signal));
  }
  return written;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('The batch was cancelled.', 'AbortError');
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error as { name?: string } | null)?.name === 'AbortError';
}

/**
 * Runs every pending item in queue order. Failures are recorded per item and do not stop the queue; cancelling
 * leaves the current and all later items pending. Returns the final states.
 */
export async function runBatch(initial: readonly BatchItemState[], settings: BatchSettings, services: BatchServices,
  options: BatchRunOptions = {}): Promise<BatchItemState[]> {
  const signal = options.signal ?? new AbortController().signal;
  const states = initial.slice();
  const update = (at: number, state: BatchItemState) => { states[at] = state; options.onChange?.(states.slice()); };
  for (let at = 0; at < states.length; at++) {
    const state = states[at]!;
    if (state.status !== 'pending') continue;
    if (signal.aborted) break;
    update(at, { ...state, status: 'running', error: null });
    try {
      const outputs = await processBatchItem(state.item, at + 1, states.length, settings, services, signal);
      update(at, { item: state.item, status: 'done', error: null, outputs });
    } catch (error) {
      if (isAbort(error, signal)) { update(at, pendingState(state.item)); break; }
      update(at, { item: state.item, status: 'failed', error, outputs: [] });
    }
  }
  return states;
}

// MARK: Flattening a target

/**
 * A one-layer document holding what a target (artboard, layer, whole document) renders — artboard background
 * included — at 1×, through the same renderer as export. Used when a recipe has to go on something that is not a
 * single layer (a multi-layer file, an artboard) or when a layer is cropped.
 */
export async function flattenTarget(document: CanvasDocument, target: ExportTarget, renderer: ExportRenderer, deep: boolean): Promise<CanvasDocument> {
  const { renderExportItem } = await import('./exportPipeline');
  const request: ExportRequest = { targets: [target], format: 'png', bitDepth: deep ? 16 : 8, transparent: true };
  const [item] = planExport(document, request);
  const pixels = renderExportItem(document, item!, request, renderer);
  const raster = Raster.fromPixels(item!.width, item!.height, 4, pixels, { format: deep ? 'rgba16' : 'rgba8' });
  const layer = newLayer({ id: uuid(), name: item!.label, raster, transform: makeTransform({ x: 0, y: 0 }, { width: item!.width, height: item!.height }) });
  return { id: uuid(), width: item!.width, height: item!.height, resolution: document.resolution,
    ...(document.globalLightAngle === undefined ? {} : { globalLightAngle: document.globalLightAngle }),
    layers: [layer], artboards: [], selection: null };
}

// MARK: Destinations

export interface BatchDestination {
  /** What the user sees as the target: the folder name, or the ZIP file name. */
  readonly label: string;
  readonly kind: 'folder' | 'zip';
  write(name: string, file: ExportFile, signal: AbortSignal): Promise<string>;
  /** Called after a run (finished or cancelled): the ZIP destination saves what was written. */
  finish(): Promise<void>;
}

/** A real folder (Tauri) or a directory handle (Chromium), through `FileSystemHost`. Never overwrites a file. */
export function folderDestination(files: FileSystemHost, folder: FolderTarget): BatchDestination {
  if (!files.writeFileInFolder) throw new Error('This host cannot write into folders.');
  return {
    label: folder.name, kind: 'folder',
    write: (name, file) => files.writeFileInFolder!(folder, name, new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.mime })),
    async finish() {},
  };
}

/**
 * Hosts without a folder picker: every file of a run goes into one ZIP (stored, ZIP64 streaming writer) that is
 * handed to `save` when the run ends — also after a cancel, with the files finished so far.
 */
export function zipDestination(zipName: string, save: (blob: Blob, name: string) => Promise<void>): BatchDestination {
  let writer = new Zip64StreamWriter();
  let names = new Set<string>();
  return {
    label: zipName, kind: 'zip',
    async write(name, file) {
      const unique = await uniqueName(name, (candidate) => names.has(candidate.toLowerCase()));
      names.add(unique.toLowerCase());
      await writer.add(unique, (stream) => { stream.push(file.bytes, true); });
      return unique;
    },
    async finish() {
      if (!names.size) return;
      const blob = writer.finish();
      writer = new Zip64StreamWriter(); names = new Set();
      await save(blob, zipName);
    },
  };
}
