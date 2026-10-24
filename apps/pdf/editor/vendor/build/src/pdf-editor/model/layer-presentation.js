const MAX_LAYER_NAME_LENGTH = 160;

const NATIVE_FRAME_ROW_FIELDS = Object.freeze([
  'nativeLayerTarget', 'nativeTypeName', 'stableId', 'liveStableId', 'objectId',
  'objectIndex', 'nested', 'formPath', 'textFrame', 'textBlock', 'complexText',
  'base14Rich', 'richTextCapability',
  'richTextDocument', 'richTextFontResources', 'richTextAvailableFontResources', 'uniformTextAppearance',
  'fontResourceHashes', 'fontFamilies', 'usedFontResourceHashes', 'usedFontFamilies',
  'requestedFontResourceHash', 'frameResourceId', 'block', 'fontSize', 'color',
]);

/** Reconcile two rows only through their exact current stable identity. A UI
 * snapshot may update text/geometry, not downgrade verified native capability.
 * Matching text or overlapping boxes are deliberately not ownership evidence. */
export function mergeExactNativeFrameLayer(previous, next) {
  const merged = { ...previous, ...next, item: { ...(previous?.item || {}), ...(next?.item || {}) } };
  const native = previous?.item;
  const nativeId = native?.liveStableId || native?.stableId;
  const editId = next?.item?.liveStableId || next?.item?.stableId;
  if (!nativeId || nativeId !== editId || previous.key !== next.key ||
      previous.pageId !== next.pageId || previous.type !== 'text' || next.type !== 'text' ||
      native.nativeLayerTarget !== true || native.textFrame !== true || native.complexText !== true ||
      native.nested === true || native.formPath?.length) return merged;
  for (const field of NATIVE_FRAME_ROW_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(native, field)) merged.item[field] = native[field];
  }
  return merged;
}

// A group's descendants are navigation rows, not independent entries in the
// page paint stack. Expanding a tree must never change Forward/Backward targets.
export function topLevelLayerStack(layers = []) {
  return layers.filter(layer => !layer.deleted && !layer.hierarchy?.parentStableId &&
    layer.item?.nested !== true && !(Array.isArray(layer.item?.formPath) && layer.item.formPath.length));
}

// An editor-created group records the exact selected layer keys. Its source
// PDF.js observations must not survive as duplicate page-level rows. Historical
// names, text equality and overlapping geometry are never ownership evidence.
export function layersWithoutMaterializedMembers(layers = [], groups = {}, pageId = '') {
  const presentGroups = new Set(topLevelLayerStack(layers)
    .filter(layer => layer.type === 'nativeObject' && layer.pageId === pageId &&
      (layer.item?.nativeTypeName || layer.item?.typeName) === 'form')
    .map(layer => layer.item?.stableId).filter(Boolean));
  const ownedKeys = new Set(Object.values(groups || {}).flatMap(group =>
    group?.pageId === pageId && presentGroups.has(group.id) && Array.isArray(group.memberLayerKeys)
      ? group.memberLayerKeys.filter(key => typeof key === 'string' && key) : []));
  return layers.filter(layer => !ownedKeys.has(layer.key));
}

function normalizedLayerName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_LAYER_NAME_LENGTH);
}

export function normalizeLayerPresentation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const stableKey = String(key || '').trim();
    if (!stableKey || !item || typeof item !== 'object' || Array.isArray(item)) return [];
    const name = normalizedLayerName(item.name);
    const normalized = {
      ...(name ? { name } : {}),
      ...(item.hidden === true ? { hidden: true } : {}),
      ...(item.locked === true ? { locked: true } : {}),
    };
    return Object.keys(normalized).length ? [[stableKey, normalized]] : [];
  }));
}

export function layerPresentationFor(value, layerKey) {
  const key = String(layerKey || '').trim();
  const item = key && value && typeof value === 'object' && !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, key) && value[key] &&
    typeof value[key] === 'object' && !Array.isArray(value[key])
    ? value[key]
    : null;
  return {
    name: normalizedLayerName(item?.name),
    hidden: item?.hidden === true,
    locked: item?.locked === true,
  };
}

// True when at least one stored layer entry is hidden. Lets callers skip
// building the full layer list (thousands of rows on plans) when nothing
// can be hidden anyway.
export function layerPresentationHasHidden(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const entry of Object.values(value)) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && entry.hidden === true) return true;
  }
  return false;
}

export function anyLayerPresentationLocked(value, layerKeys = []) {
  return layerKeys.some(layerKey => layerPresentationFor(value, layerKey).locked);
}

export function patchLayerPresentation(value, layerKey, patch = {}) {
  const key = String(layerKey || '').trim();
  if (!key) return normalizeLayerPresentation(value);
  const current = normalizeLayerPresentation(value);
  const previous = current[key] || {};
  const next = {
    ...previous,
    ...('name' in patch ? { name: normalizedLayerName(patch.name) } : {}),
    ...('hidden' in patch ? { hidden: patch.hidden === true } : {}),
    ...('locked' in patch ? { locked: patch.locked === true } : {}),
  };
  if (!next.name) delete next.name;
  if (!next.hidden) delete next.hidden;
  if (!next.locked) delete next.locked;
  if (!Object.keys(next).length) {
    const { [key]: _removed, ...rest } = current;
    return rest;
  }
  return { ...current, [key]: next };
}

export function layerVisibilityRenderTargets(value, layers = [], annotations = [], pageId = '') {
  // Stored view preferences from older builds may refer to read-only children.
  // They cannot be passed to the page-level native visibility locator.
  const nativeStableIds = topLevelLayerStack(layers).flatMap(layer => (
    ['text', 'imageRegion', 'nativeObject'].includes(layer?.type) &&
    layer?.pageId === pageId &&
    layerPresentationFor(value, layer.key).hidden &&
    layer.item?.nativeLayerTarget !== false &&
    (layer.item?.liveStableId || layer.item?.stableId)
      ? [layer.item.liveStableId || layer.item.stableId]
      : []
  ));
  const annotationObjectNumbers = annotations.flatMap(annotation => (
    annotation?.pageId === pageId &&
    layerPresentationFor(value, `ann:${annotation.id}`).hidden &&
    Number.isSafeInteger(annotation.annotationObjectNumber) && annotation.annotationObjectNumber > 0
      ? [annotation.annotationObjectNumber]
      : []
  ));
  return {
    hiddenNativeStableIds: [...new Set(nativeStableIds)],
    hiddenAnnotationObjectNumbers: [...new Set(annotationObjectNumbers)],
  };
}

export { MAX_LAYER_NAME_LENGTH };
