/**
 * The editor's side of a batch run: how an item is opened (images through the import decoders, PSDs through the PSD
 * reader, `.fwimg` through the project reader — never into a tab), how it is rendered (the canvas compositor, the
 * same renderer Export As uses) and how it is exported (the controller's one export entry point).
 */

import { newLayer, type CanvasDocument } from '../../core/document';
import { makeTransform } from '../../core/geometry';
import { uuid } from '../../core/ids';
import { EditorSession } from '../../core/session';
import { fileBaseName } from '../../io/imageImport';
import { readArchive } from '../../io/project';
import { decodeImageAssetInBackground } from '../../workers/imageDecodeClient';
import { readPsdDocumentInBackground } from '../../workers/psdClient';
import { flattenTarget, type BatchDestination, type BatchServices } from '../../io/batch';
import type { EditorController } from '../../ui/controller';

/** Decodes one queued file into a document of its own (the image as one layer, like opening it). */
export async function openBatchFile(controller: EditorController, name: string, blob: Blob): Promise<CanvasDocument> {
  if (/\.ps[db]$/i.test(name)) return (await readPsdDocumentInBackground(new Uint8Array(await blob.arrayBuffer()))).document;
  if (/\.(fwimg|zip)$/i.test(name)) {
    const limits = controller.limits;
    return (await readArchive(blob, (data) => decodeImageAssetInBackground(data, limits.maxPixels,
      { host: controller.capabilities.codecs, maxSide: limits.maxSide }), limits)).document;
  }
  const raster = await controller.decodeImage(new Uint8Array(await blob.arrayBuffer()), controller.limits.maxPixels);
  const layer = newLayer({ id: uuid(), name: fileBaseName(name), raster,
    transform: makeTransform({ x: 0, y: 0 }, { width: raster.width, height: raster.height }) });
  return { id: uuid(), width: raster.width, height: raster.height, resolution: 72, layers: [layer], artboards: [], selection: null };
}

/**
 * Services for one run. `source` is the current document at the start of the run (for artboard and layer queues);
 * it is an immutable snapshot, so editing the open document meanwhile does not change what is exported.
 */
export function editorBatchServices(controller: EditorController, destination: BatchDestination, source: CanvasDocument | null): BatchServices {
  return {
    async open(item) {
      if (item.source.kind === 'file') {
        const document = await openBatchFile(controller, item.name, await item.source.read());
        return { document, target: { kind: 'document' }, name: fileBaseName(item.name) };
      }
      if (!source) throw new Error('There is no canvas to export.');
      return { document: source, target: item.source, name: item.name };
    },
    async flatten(document, target, deep) { return flattenTarget(document, target, await controller.exportRenderer(), deep); },
    async export(document, request, signal) {
      // A session of its own (no history, no tab): export runs through the controller's one pipeline entry point.
      const session = new EditorSession(controller.session.services ?? undefined, { enabled: false });
      session.installProject(document, null, request.baseName ?? null);
      for (const prepare of controller.renderPreparers) await prepare(session);
      return controller.exportFiles(request, { signal }, session);
    },
    write: (name, file, signal) => destination.write(name, file, signal),
  };
}
