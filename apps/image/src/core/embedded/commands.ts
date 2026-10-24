import { descendantIds, newLayer, withLayerRaster, type CanvasDocument, type EmbeddedLayer, type Layer } from '../document';
import { makeTransform, type Point } from '../geometry';
import { uuid } from '../ids';
import type { EditorSession } from '../session';
import { sha256Hex } from '../../io/sha256';
import type { PreparedEmbeddedSource } from './types';

function resourceId(bytes: Uint8Array): string { return `embedded-${sha256Hex(bytes)}`; }

function resourcesWith(document: CanvasDocument, source: PreparedEmbeddedSource): { resources: NonNullable<CanvasDocument['resources']>; id?: string } {
  if ((source.mode ?? 'embedded') === 'linked') return { resources: [...document.resources ?? []] };
  const hash = sha256Hex(source.bytes);
  const duplicate = (document.resources ?? []).find((resource) => resource.role === 'embedded' && sha256Hex(resource.bytes) === hash);
  if (duplicate) return { resources: [...document.resources ?? []], id: duplicate.id };
  const id = resourceId(source.bytes);
  return { resources: [...document.resources ?? [], { id, role: 'embedded', mime: source.mime, bytes: source.bytes.slice() }], id };
}

function content(source: PreparedEmbeddedSource, id?: string): EmbeddedLayer['content'] {
  const hash = sha256Hex(source.bytes);
  return {
    mode: source.mode ?? 'embedded', mediaType: source.mediaType, sourceName: source.sourceName,
    width: source.width, height: source.height, ...(source.page === undefined ? {} : { page: source.page }),
    sha256: hash, ...(source.modifiedAt === undefined ? {} : { modifiedAt: source.modifiedAt }),
    ...((source.mode ?? 'embedded') === 'linked' ? { uri: source.uri } : { assetId: id }),
  };
}

function parentFor(session: EditorSession): string | null {
  const active = session.activeLayer;
  return active?.kind === 'group' ? active.id : active?.parentId ?? null;
}

function insertAtActive(document: CanvasDocument, layer: Layer, activeId: string | null): Layer[] {
  const layers = document.layers.slice();
  const active = document.layers.find((value) => value.id === activeId);
  let index = document.layers.findIndex((value) => value.id === activeId);
  index = index < 0 ? layers.length : index + 1;
  if (active?.kind === 'group') {
    const descendants = descendantIds(document.layers, active.id);
    for (let i = 0; i < layers.length; i++) if (descendants.has(layers[i]!.id)) index = Math.max(index, i + 1);
  }
  layers.splice(index, 0, layer);
  return layers;
}

/** File > Place Embedded/Linked. Source bytes, never the preview, remain authoritative. */
export function placeEmbeddedContent(session: EditorSession, source: PreparedEmbeddedSource, point: Point | null = null): string | null {
  if (session.isProjectBusy || session.isImporting || !source.width || !source.height) return null;
  let document = session.document;
  session.beginEdit(source.mode === 'linked' ? 'Place Linked' : 'Place Embedded');
  try {
    if (!document) {
      document = { id: uuid(), width: source.width, height: source.height, resolution: 72, layers: [], resources: [], selection: null };
    }
    const stored = resourcesWith(document, source);
    const centre = point ?? { x: document.width / 2, y: document.height / 2 };
    const layer = newLayer({
      id: uuid(), name: source.sourceName, kind: 'embedded', raster: source.raster,
      transform: makeTransform({ x: Math.floor(centre.x - source.width / 2), y: Math.floor(centre.y - source.height / 2) },
        { width: source.width, height: source.height }),
      parentId: parentFor(session), content: content(source, stored.id),
    });
    session.replaceDocument({ ...document, resources: stored.resources, layers: insertAtActive(document, layer, session.activeLayerId) });
    session.setActiveLayer(layer.id);
    return layer.id;
  } finally { session.endEdit(); }
}

function withoutUnusedResources(document: CanvasDocument): CanvasDocument {
  const used = new Set<string>();
  for (const layer of document.layers) if (layer.kind === 'embedded' && layer.content.assetId) used.add(layer.content.assetId);
  return { ...document, resources: (document.resources ?? []).filter((resource) => resource.role !== 'embedded' || used.has(resource.id)) };
}

/** Replace Contents affects one instance and intentionally retains every layer-level parameter. */
export function replaceEmbeddedContents(session: EditorSession, layerId: string, source: PreparedEmbeddedSource): boolean {
  const document = session.document, layer = session.layer(layerId);
  if (!document || layer?.kind !== 'embedded' || session.refuseLayerEdit(layerId, 'pixels')) return false;
  const stored = resourcesWith(document, source);
  session.edit('Replace Contents', () => {
    const layers = document.layers.map((value) => value.id === layerId
      ? { ...value, raster: source.raster, content: content(source, stored.id) } as EmbeddedLayer : value);
    session.replaceDocument(withoutUnusedResources({ ...document, resources: stored.resources, layers }));
  });
  return true;
}

/** Saving an Edit Contents tab updates every instance sharing the source, as one parent undo step. */
export function updateSharedEmbeddedContents(session: EditorSession, assetId: string, source: PreparedEmbeddedSource): number {
  const document = session.document;
  if (!document) return 0;
  const count = document.layers.filter((layer) => layer.kind === 'embedded' && layer.content.assetId === assetId).length;
  if (!count) return 0;
  const stored = resourcesWith({ ...document, resources: (document.resources ?? []).filter((resource) => resource.id !== assetId) }, source);
  session.edit('Edit Contents', () => {
    const layers = document.layers.map((layer) => layer.kind === 'embedded' && layer.content.assetId === assetId
      ? { ...layer, raster: source.raster, content: content(source, stored.id) } as EmbeddedLayer : layer);
    session.replaceDocument(withoutUnusedResources({ ...document, resources: stored.resources, layers }));
  });
  return count;
}

/** Refreshes/relinks one linked instance while preserving transform, effects, filters and masks. */
export function updateLinkedContents(session: EditorSession, layerId: string, source: PreparedEmbeddedSource, name = 'Update Linked Content'): boolean {
  const document = session.document, layer = session.layer(layerId);
  if (!document || layer?.kind !== 'embedded' || layer.content.mode !== 'linked') return false;
  session.edit(name, () => session.replaceDocument({ ...document, layers: document.layers.map((value) => value.id === layerId
    ? { ...layer, raster: source.raster, content: content({ ...source, mode: 'linked' }, undefined) } as EmbeddedLayer : value) }));
  return true;
}

export function convertEmbeddedToPixels(session: EditorSession, layerId: string, raster = session.layer(layerId)?.raster ?? null): boolean {
  const document = session.document, layer = session.layer(layerId);
  if (!document || layer?.kind !== 'embedded' || !raster || session.refuseLayerEdit(layerId, 'pixels')) return false;
  session.edit('Convert to Pixels', () => {
    const layers = document.layers.map((value) => value.id === layerId ? withLayerRaster(value, raster) : value);
    session.replaceDocument(withoutUnusedResources({ ...document, layers }));
  });
  return true;
}

/** Converts one already-packaged pixel/group branch to an embedded project without changing its appearance fields. */
export function convertLayerToEmbedded(session: EditorSession, layerId: string, source: PreparedEmbeddedSource): boolean {
  const document = session.document, layer = session.layer(layerId);
  if (!document || !layer || layer.kind === 'adjustment' || layer.kind === 'fill' || session.refuseLayerEdit(layerId, 'pixels')) return false;
  const included = new Set([layerId, ...(layer.kind === 'group' ? descendantIds(document.layers, layerId) : [])]);
  const stored = resourcesWith(document, source);
  const embedded = newLayer({ ...layer, kind: 'embedded', raster: source.raster, content: content(source, stored.id) });
  session.edit('Convert to Embedded', () => {
    const layers = document.layers.filter((value) => !included.has(value.id));
    const insertion = Math.min(document.layers.findIndex((value) => value.id === layerId), layers.length);
    layers.splice(Math.max(0, insertion), 0, embedded);
    session.replaceDocument(withoutUnusedResources({ ...document, resources: stored.resources, layers }));
    session.setActiveLayer(embedded.id);
  });
  return true;
}

/** Resource bytes for Edit Contents. Linked instances are resolved by their host instead. */
export function embeddedResource(document: CanvasDocument, layer: EmbeddedLayer) {
  return layer.content.assetId ? document.resources?.find((resource) => resource.id === layer.content.assetId && resource.role === 'embedded') ?? null : null;
}
