/** Small lazy UI bridge for embedded-content engine commands; no new React surface is introduced. */
import type { EditorController } from '../ui/controller';
import { newLayer, type CanvasDocument, type EmbeddedLayer } from '../core/document';
import { makeTransform } from '../core/geometry';
import { descendantIds } from '../core/document';
import {
  convertEmbeddedToPixels, convertLayerToEmbedded, documentHasEmbedded, embeddedResource, EmbeddedRuntime,
  placeEmbeddedContent, replaceEmbeddedContents, updateSharedEmbeddedContents,
  type PreparedEmbeddedSource,
} from '../core/embedded';
import type { EditorSession } from '../core/session';
import { prepareEmbeddedSource } from '../io/embedded';
import { decodeImageAsset } from '../io/imageImport';
import { encodePng } from '../io/png';
import { readArchive, writeArchive } from '../io/project';

interface EditBinding {
  readonly parent: EditorSession;
  readonly assetId: string;
  readonly mediaType: 'image' | 'project';
  readonly sourceName: string;
}

const editBindings = new WeakMap<EditorSession, EditBinding>();

async function prepared(controller: EditorController, file: Blob & { name?: string }, mode: 'embedded' | 'linked', uri?: string) {
  const name = file.name ?? 'Content';
  return prepareEmbeddedSource(new Uint8Array(await file.arrayBuffer()), name, {
    mode, uri, mime: file.type, codecs: controller.capabilities.codecs, pdf: controller.capabilities.pdf,
  });
}

async function chooseEmbedded(controller: EditorController): Promise<PreparedEmbeddedSource | null> {
  const files = controller.capabilities.files;
  if (files?.readFile) {
    const reference = (await files.chooseFiles('content'))[0];
    if (!reference) return null;
    const blob = await files.readFile(reference);
    return prepared(controller, new File([blob], reference.name, { type: blob.type }), 'embedded');
  }
  const contentHost = controller.host as typeof controller.host & { chooseContent?(): Promise<File[]> };
  const file = (await contentHost.chooseContent?.() ?? await controller.host.chooseImages())[0];
  return file ? prepared(controller, file, 'embedded') : null;
}

async function chooseLinked(controller: EditorController): Promise<PreparedEmbeddedSource | null> {
  const files = controller.capabilities.files;
  if (!files?.readFile) {
    const fallback = await chooseEmbedded(controller);
    if (fallback) controller.alert(controller.t('Place Linked…'), controller.t('This host cannot keep a file link. The content was embedded instead.'));
    return fallback;
  }
  const reference = (await files.chooseFiles('content'))[0];
  if (!reference) return null;
  const blob = await files.readFile(reference);
  return prepared(controller, new File([blob], reference.name, { type: blob.type }), 'linked', reference.id);
}

async function place(controller: EditorController, mode: 'embedded' | 'linked'): Promise<void> {
  try {
    const source = mode === 'linked' ? await chooseLinked(controller) : await chooseEmbedded(controller);
    if (source) placeEmbeddedContent(controller.session, source);
  } catch (error) { controller.reportError('place-content-failed', error, controller.t('Place couldn’t finish')); }
}

async function replace(controller: EditorController): Promise<void> {
  const layer = controller.session.activeLayer;
  if (layer?.kind !== 'embedded') return;
  try {
    const source = layer.content.mode === 'linked' ? await chooseLinked(controller) : await chooseEmbedded(controller);
    if (source) replaceEmbeddedContents(controller.session, layer.id, source);
  } catch (error) { controller.reportError('replace-content-failed', error, controller.t('Replace Contents couldn’t finish')); }
}

function sourceDocument(document: CanvasDocument, layerId: string): CanvasDocument | null {
  const head = document.layers.find((layer) => layer.id === layerId);
  if (!head) return null;
  const ids = new Set([layerId, ...(head.kind === 'group' ? descendantIds(document.layers, layerId) : [])]);
  if (head.kind === 'pixel' && head.raster) {
    const layer = newLayer({ ...head, id: head.id, parentId: null, transform: makeTransform({ x: 0, y: 0 },
      { width: head.raster.width, height: head.raster.height }), effects: [], filters: [], mask: null, vectorMask: null, raster: head.raster });
    return { ...document, width: head.raster.width, height: head.raster.height, layers: [layer], selection: null };
  }
  return { ...document, layers: document.layers.filter((layer) => ids.has(layer.id)), selection: null };
}

async function convert(controller: EditorController): Promise<void> {
  const session = controller.session, document = session.document, layer = session.activeLayer;
  if (!document || !layer || layer.kind === 'embedded' || layer.kind === 'adjustment' || layer.kind === 'fill') return;
  const packaged = sourceDocument(document, layer.id);
  if (!packaged) return;
  try {
    const archive = writeArchive(packaged, layer.name, layer.id).blob;
    const source = await prepareEmbeddedSource(new Uint8Array(await archive.arrayBuffer()), `${layer.name}.fwimg`, {
      codecs: controller.capabilities.codecs, pdf: controller.capabilities.pdf,
    });
    convertLayerToEmbedded(session, layer.id, source);
  } catch (error) { controller.reportError('convert-embedded-failed', error); }
}

async function openEditTab(controller: EditorController): Promise<void> {
  const parent = controller.session, document = parent.document, layer = parent.activeLayer;
  if (!document || layer?.kind !== 'embedded') return;
  if (layer.content.mediaType === 'svg' || layer.content.mediaType === 'pdf') {
    controller.alert(controller.t('Edit Contents'), controller.t('SVG and PDF contents are read-only. Use Replace Contents to change the source.'));
    return;
  }
  const resource = embeddedResource(document, layer);
  if (!resource || !layer.content.assetId) {
    controller.alert(controller.t('Edit Contents'), controller.t('Linked content is edited in its source application.'));
    return;
  }
  try {
    const tab = controller.workspace.createTab(layer.content.sourceName);
    if (layer.content.mediaType === 'project') {
      const loaded = await readArchive(new Blob([resource.bytes as BlobPart]), async (bytes) => {
        const decoded = await decodeImageAsset(bytes, 100_000_000, { host: controller.capabilities.codecs });
        return { width: decoded.width, height: decoded.height, channels: 4, data: decoded.data, bitDepth: decoded.bitDepth };
      });
      tab.session.installProject(loaded.document, loaded.activeLayerId, loaded.name, loaded.history);
    } else {
      const source = await prepareEmbeddedSource(resource.bytes, layer.content.sourceName, { mime: resource.mime,
        codecs: controller.capabilities.codecs, pdf: controller.capabilities.pdf });
      const pixel = newLayer({ id: `contents-${layer.id}`, name: layer.content.sourceName, raster: source.raster,
        transform: makeTransform({ x: 0, y: 0 }, { width: source.width, height: source.height }) });
      tab.session.installProject({ id: `contents-${layer.id}`, width: source.width, height: source.height, resolution: 72,
        layers: [pixel], resources: [], selection: null }, pixel.id, layer.content.sourceName);
    }
    editBindings.set(tab.session, { parent, assetId: layer.content.assetId, mediaType: layer.content.mediaType,
      sourceName: layer.content.sourceName });
    controller.workspace.adopt(tab);
  } catch (error) { controller.reportError('edit-content-failed', error); }
}

async function saveEdited(controller: EditorController, session: EditorSession): Promise<boolean> {
  const binding = editBindings.get(session), document = session.document;
  if (!binding || !document) return false;
  try {
    let bytes: Uint8Array, source: PreparedEmbeddedSource;
    if (binding.mediaType === 'project') {
      bytes = new Uint8Array(await writeArchive(document, session.projectName ?? binding.sourceName, session.activeLayerId).blob.arrayBuffer());
      source = await prepareEmbeddedSource(bytes, binding.sourceName, { codecs: controller.capabilities.codecs, pdf: controller.capabilities.pdf });
    } else {
      const raster = await session.services!.flatten(document);
      bytes = encodePng(raster.toPixelsNative(), raster.width, raster.height, 4,
        raster.format === 'rgba16' ? { bitDepth: 16 } : {});
      source = await prepareEmbeddedSource(bytes, binding.sourceName, { mime: 'image/png', codecs: controller.capabilities.codecs, pdf: controller.capabilities.pdf });
    }
    const changed = updateSharedEmbeddedContents(binding.parent, binding.assetId, source);
    if (!changed) throw new Error('The parent document or its embedded instances are no longer open.');
    session.history.markSaved(); session.notify('ui');
  } catch (error) { controller.reportError('save-content-failed', error); }
  return true;
}

export function installEmbedded(controller: EditorController): void {
  const runtime = new EmbeddedRuntime({ files: controller.capabilities.files, codecs: controller.capabilities.codecs, pdf: controller.capabilities.pdf,
    changed: (session) => session.notify('document'), failed: (error) => controller.reportError('embedded-render-failed', error) });
  controller.features.placeEmbedded = { enabled: () => !controller.session.isProjectBusy, run: () => void place(controller, 'embedded') };
  controller.features.placeLinked = { enabled: () => !controller.session.isProjectBusy, run: () => void place(controller, 'linked') };
  controller.features.replaceEmbedded = { enabled: () => controller.session.canEditLayers && controller.session.activeLayer?.kind === 'embedded',
    run: () => void replace(controller) };
  controller.features.relinkEmbedded = { enabled: () => controller.session.canEditLayers && controller.session.activeLayer?.kind === 'embedded'
      && controller.session.activeLayer.content.mode === 'linked', run: () => void replace(controller) };
  controller.features.editEmbedded = { enabled: () => controller.session.activeLayer?.kind === 'embedded', run: () => void openEditTab(controller) };
  controller.features.convertEmbeddedPixels = { enabled: () => controller.session.canEditLayers && controller.session.activeLayer?.kind === 'embedded'
      && !!controller.session.displayedRaster(controller.session.activeLayer),
    run: () => { const layer = controller.session.activeLayer; if (layer?.kind === 'embedded') {
      convertEmbeddedToPixels(controller.session, layer.id, controller.session.displayedRaster(layer));
    } } };
  controller.features.convertToEmbedded = { enabled: () => {
    const layer = controller.session.activeLayer;
    return controller.session.canEditLayers && !!layer && ['pixel', 'group', 'vector', 'text'].includes(layer.kind);
  }, run: () => void convert(controller) };
  controller.features.refreshLinked = { enabled: () => controller.session.document?.layers.some((layer) => layer.kind === 'embedded'
      && layer.content.mode === 'linked') ?? false,
    run: () => void runtime.refreshLinked(controller.session) };
  controller.renderPreparers.push(async (session) => { if (documentHasEmbedded(session.document)) await runtime.prepare(session); });
  controller.saveInterceptors.push((session) => saveEdited(controller, session));
  controller.placeContentFiles = async (files, point) => {
    const ids: string[] = [];
    for (const file of files) {
      try {
        const source = await prepared(controller, file, 'embedded');
        const id = placeEmbeddedContent(controller.session, source, point);
        if (id) ids.push(id);
      } catch (error) { controller.reportError('place-content-failed', error, controller.t('Place couldn’t finish')); }
    }
    return ids;
  };
}
