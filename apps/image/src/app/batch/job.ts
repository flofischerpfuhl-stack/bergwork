/**
 * The File › Batch… job (PRODUCT-PLAN 6.9, core task 14): the queue, the chosen recipe, Export As settings, name
 * pattern and target folder, kept per editor for the session so a finished or cancelled run can be resumed after
 * the dialog was closed. The engine (`io/batch`) and the editor services load on the first run.
 */

import { createStore, type StoreApi } from 'zustand/vanilla';
import type { CanvasDocument } from '../../core/document';
import { uuid } from '../../core/ids';
import type { BatchDestination, BatchItem, BatchItemState } from '../../io/batch';
import type { FileSaveTarget, FolderTarget, HostFileReference } from '../../platform/hosts';
import type { FileTargetHost } from '../../platform/browserHost';
import type { EditorController } from '../../ui/controller';
import { currentExportSettings, exportSettingsFrom, exportSettingsRequest, type ExportSettings } from '../../ui/ExportDialog';
import { findRecipe, recipeLibrary } from './library';

export type BatchSourceKind = 'files' | 'artboards' | 'layers';

export interface BatchJobState {
  readonly source: BatchSourceKind;
  readonly files: readonly BatchItemState[];
  /** The current document's artboards or layers (for the artboard and layer sources). */
  readonly documentItems: readonly BatchItemState[];
  readonly recipeId: string | null;
  readonly settings: ExportSettings | null;
  readonly pattern: string;
  readonly folder: FolderTarget | null;
  readonly running: AbortController | null;
  readonly cancelling: boolean;
}

const jobs = new WeakMap<EditorController, StoreApi<BatchJobState>>();

export function batchJob(controller: EditorController): StoreApi<BatchJobState> {
  let store = jobs.get(controller);
  if (!store) {
    store = createStore<BatchJobState>(() => ({
      source: 'files', files: [], documentItems: [], recipeId: recipeLibrary(controller).getState().lastUsedId, settings: null,
      pattern: '{name}', folder: null, running: null, cancelling: false,
    }));
    jobs.set(controller, store);
  }
  return store;
}

const pending = (item: BatchItem): BatchItemState => ({ item, status: 'pending', error: null, outputs: [] });

export function queueOf(state: BatchJobState): readonly BatchItemState[] {
  return state.source === 'files' ? state.files : state.documentItems;
}

// MARK: Queue

/** Items for the current document's artboards or its top-level layers (top of the stack first, like the panel). */
export function documentQueue(document: CanvasDocument | null, source: 'artboards' | 'layers'): BatchItemState[] {
  if (!document) return [];
  if (source === 'artboards') {
    return (document.artboards ?? []).map((artboard) => pending({ id: `artboard:${artboard.id}`, name: artboard.name, source: { kind: 'artboard', id: artboard.id } }));
  }
  return [...document.layers].reverse().filter((layer) => layer.parentId === null && layer.kind !== 'adjustment')
    .map((layer) => pending({ id: `layer:${layer.id}`, name: layer.name, source: { kind: 'layer', id: layer.id } }));
}

export function setBatchSource(controller: EditorController, source: BatchSourceKind): void {
  const store = batchJob(controller);
  if (store.getState().running) return;
  store.setState({ source, documentItems: source === 'files' ? [] : documentQueue(controller.session.document, source) });
}

/** Refreshes a document queue that has not been started (the document may have changed since). */
export function refreshDocumentQueue(controller: EditorController): void {
  const store = batchJob(controller), state = store.getState();
  if (state.running || state.source === 'files' || state.documentItems.some((item) => item.status !== 'pending')) return;
  store.setState({ documentItems: documentQueue(controller.session.document, state.source) });
}

export function addBatchFiles(controller: EditorController, files: readonly File[]): void {
  const store = batchJob(controller);
  // A File from a picker or a drop is backed by the disk: nothing is read until the item's turn.
  const items = files.map((file) => pending({ id: uuid(), name: file.name, source: { kind: 'file', read: async () => file } }));
  store.setState({ files: [...store.getState().files, ...items] });
}

export function addBatchReferences(controller: EditorController, references: readonly HostFileReference[]): void {
  const files = controller.capabilities.files, store = batchJob(controller);
  if (!files?.readFile) return;
  const items = references.map((reference) => pending({ id: uuid(), name: reference.name,
    source: { kind: 'file', read: () => files.readFile!(reference) } }));
  store.setState({ files: [...store.getState().files, ...items] });
}

function pickBatchFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = globalThis.document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/jpeg,image/png,image/heic,image/heif,image/tiff,image/webp,image/avif,image/gif,image/vnd.adobe.photoshop,'
      + '.heic,.heif,.tif,.tiff,.webp,.avif,.gif,.psd,.psb,.fwimg';
    input.style.display = 'none';
    let settled = false;
    const finish = (files: File[]) => { if (settled) return; settled = true; input.remove(); resolve(files); };
    input.addEventListener('change', () => finish([...(input.files ?? [])]));
    input.addEventListener('cancel', () => finish([]));
    globalThis.document.body.append(input);
    input.click();
  });
}

/** Add Files… : the host's file dialog (read one at a time later), or a file input where the host has none. */
export async function chooseBatchFiles(controller: EditorController): Promise<void> {
  const files = controller.capabilities.files;
  try {
    if (files?.readFile) addBatchReferences(controller, await files.chooseFiles('batch'));
    else addBatchFiles(controller, await pickBatchFiles());
  } catch (error) { controller.reportError('batch-files-failed', error); }
}

export function removeBatchItem(controller: EditorController, id: string): void {
  const store = batchJob(controller), state = store.getState();
  if (state.running) return;
  if (state.source === 'files') store.setState({ files: state.files.filter((s) => s.item.id !== id) });
  else store.setState({ documentItems: state.documentItems.filter((s) => s.item.id !== id) });
}

export function clearBatchQueue(controller: EditorController): void {
  const store = batchJob(controller), state = store.getState();
  if (state.running) return;
  if (state.source === 'files') store.setState({ files: [] });
  else store.setState({ documentItems: documentQueue(controller.session.document, state.source) });
}

export function retryFailedItems(controller: EditorController): void {
  const store = batchJob(controller), state = store.getState();
  if (state.running) return;
  const reset = (states: readonly BatchItemState[]) => states.map((s) => (s.status === 'failed' ? pending(s.item) : s));
  store.setState(state.source === 'files' ? { files: reset(state.files) } : { documentItems: reset(state.documentItems) });
}

/** A finished queue started again from the top (Run after everything was done). */
function restartIfFinished(controller: EditorController): void {
  const store = batchJob(controller), state = store.getState();
  const queue = queueOf(state);
  if (queue.length && !queue.some((s) => s.status === 'pending')) {
    const reset = queue.map((s) => pending(s.item));
    store.setState(state.source === 'files' ? { files: reset } : { documentItems: reset });
  }
}

// MARK: Settings

export function batchSettings(controller: EditorController): ExportSettings {
  return batchJob(controller).getState().settings ?? currentExportSettings(controller.session);
}

/** Choosing a recipe with an export preset takes over its Export As settings. */
export function chooseBatchRecipe(controller: EditorController, recipeId: string | null): void {
  const store = batchJob(controller);
  const recipe = findRecipe(controller, recipeId);
  const settings = recipe?.export ? exportSettingsFrom(recipe.export, batchSettings(controller)) : store.getState().settings;
  store.setState({ recipeId, settings });
}

/** Choose Folder… (called in the click, which the browser's directory picker needs). */
export function chooseBatchFolder(controller: EditorController): void {
  const files = controller.capabilities.files;
  if (!files?.chooseFolder) return;
  void files.chooseFolder().then((folder) => { if (folder) batchJob(controller).setState({ folder }); },
    (error) => controller.reportError('batch-folder-failed', error));
}

export function hostWritesFolders(controller: EditorController): boolean {
  const files = controller.capabilities.files;
  return !!(files?.chooseFolder && files.writeFileInFolder);
}

// MARK: Running

/**
 * Run / Continue: processes the pending items. Must be called directly in the click handler: without a folder the
 * ZIP's save dialog (where the host has one) is opened before anything is awaited.
 */
export function startBatch(controller: EditorController): void {
  const store = batchJob(controller), t = controller.t;
  if (store.getState().running) return;
  restartIfFinished(controller);
  const state = store.getState();
  const queue = queueOf(state);
  const request = exportSettingsRequest(batchSettings(controller));
  if (!queue.some((s) => s.status === 'pending') || !request) return;
  const writesFolders = hostWritesFolders(controller);
  if (writesFolders && !state.folder) return;
  const zipName = `${t('Batch export')}.zip`;
  const files = controller.capabilities.files;
  const zipTarget: Promise<FileSaveTarget | null> | null = writesFolders ? null : files ? files.chooseSaveTarget(zipName, 'zip') : Promise.resolve(null);
  const abort = new AbortController();
  const sourceKind = state.source;
  const document = controller.session.document;
  const recipe = findRecipe(controller, state.recipeId);
  store.setState({ running: abort, cancelling: false });
  const publish = (states: readonly BatchItemState[]) => store.setState(sourceKind === 'files' ? { files: states } : { documentItems: states });
  void (async () => {
    let destination: BatchDestination | null = null;
    try {
      const [engine, services] = await Promise.all([import('../../io/batch'), import('./services')]);
      if (writesFolders) destination = engine.folderDestination(files!, state.folder!);
      else {
        const target = await zipTarget;
        if (files && !target) return;
        destination = engine.zipDestination(zipName, async (blob, name) => {
          if (files && target) await files.writeFile(target, blob);
          else await (controller.host as FileTargetHost).saveFile(blob, name);
        });
      }
      await engine.runBatch(queue, { recipe, export: request, pattern: state.pattern }, services.editorBatchServices(controller, destination, document),
        { signal: abort.signal, onChange: publish });
    } catch (error) { controller.reportError('batch-failed', error); }
    finally {
      try { await destination?.finish(); } catch (error) { controller.reportError('batch-failed', error); }
      store.setState({ running: null, cancelling: false });
    }
  })();
}

export function cancelBatch(controller: EditorController): void {
  const store = batchJob(controller), running = store.getState().running;
  if (!running) return;
  store.setState({ cancelling: true });
  running.abort();
}
