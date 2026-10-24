function selectionIdentity(item = {}) {
  const pageId = String(item.pageId || '');
  if (!pageId) return '';
  if (item.type === 'annotation' && item.id) return `${pageId}:annotation:${item.id}`;
  if (['text', 'imageRegion', 'nativeObject'].includes(item.type) && item.sourceId) {
    return `${pageId}:${item.type}:${item.sourceId}`;
  }
  return '';
}

function stableSelectionIdentity(item = {}) {
  if (!item || !['text', 'imageRegion', 'nativeObject'].includes(item.type)) return '';
  const pageId = String(item.pageId || '');
  const stableId = String(item.item?.liveStableId || item.item?.stableId || item.edit?.liveStableId || '');
  return pageId && stableId ? `${pageId}:${item.type}:stable:${stableId}` : '';
}

export function historyLayerHasExactFreshBinding(layer, liveObjects = []) {
  if (!layer?.original || layer.type === 'annotation') return true;
  if (layer.item?.nativeLayerTarget === true) return true;
  const stableId = String(layer.item?.liveStableId || layer.item?.stableId || '');
  if (!stableId) return false;
  const matches = (liveObjects || []).filter(object =>
    object?.stableId === stableId &&
    object.nested !== true &&
    !(Array.isArray(object.formPath) && object.formPath.length));
  if (matches.length !== 1) return false;
  const object = matches[0];
  const typeName = String(object.nativeTypeName || object.typeName || '').toLowerCase();
  if (layer.type === 'text') return typeName === 'text' || object.textFrame === true;
  if (layer.type === 'imageRegion') return typeName === 'image';
  if (layer.type === 'nativeObject') {
    const expected = String(layer.item?.nativeTypeName || layer.item?.typeName || '').toLowerCase();
    return Boolean(expected && typeName === expected);
  }
  return false;
}

export function sameHistorySelectionIdentity(left, right) {
  const identities = value => {
    if (!value) return [];
    const entries = value.type === 'multi' ? value.items || [] : [value];
    return entries.map(selectionIdentity);
  };
  const leftIdentities = identities(left);
  const rightIdentities = identities(right);
  return leftIdentities.length === rightIdentities.length &&
    leftIdentities.every((identity, index) => identity && identity === rightIdentities[index]);
}

export function reconcileHistorySelection(previous, candidates = []) {
  if (!previous) return null;
  const byIdentity = new Map();
  const ambiguous = new Set();
  const byStableIdentity = new Map();
  const ambiguousStableIdentities = new Set();
  for (const candidate of candidates) {
    if (!candidate?.eligible || !candidate.payload) continue;
    const identity = selectionIdentity(candidate.payload);
    if (!identity) continue;
    if (byIdentity.has(identity)) ambiguous.add(identity);
    else byIdentity.set(identity, candidate.payload);
    const stableIdentity = stableSelectionIdentity(candidate.payload);
    if (stableIdentity) {
      if (byStableIdentity.has(stableIdentity)) ambiguousStableIdentities.add(stableIdentity);
      else byStableIdentity.set(stableIdentity, candidate.payload);
    }
  }
  const entries = previous.type === 'multi' ? previous.items || [] : [previous];
  const resolved = entries.flatMap(entry => {
    const identity = selectionIdentity(entry);
    if (identity && !ambiguous.has(identity) && byIdentity.has(identity)) {
      return [byIdentity.get(identity)];
    }
    const stableIdentity = stableSelectionIdentity(entry);
    return stableIdentity && !ambiguousStableIdentities.has(stableIdentity) && byStableIdentity.has(stableIdentity)
      ? [byStableIdentity.get(stableIdentity)]
      : [];
  });
  if (!resolved.length) return null;
  if (resolved.length === 1) return resolved[0];
  const pageId = resolved[0].pageId;
  if (!pageId || resolved.some(item => item.pageId !== pageId)) return null;
  return { type: 'multi', pageId, items: resolved };
}

export function reconcileHistorySelectionFromPages(previous, candidatesForPage) {
  if (!previous || typeof candidatesForPage !== 'function') return null;
  const entries = previous.type === 'multi' ? previous.items || [] : [previous];
  const pageIds = [...new Set(entries.map(item => String(item?.pageId || '')).filter(Boolean))];
  if (!pageIds.length) return null;
  return reconcileHistorySelection(
    previous,
    pageIds.flatMap(pageId => candidatesForPage(pageId) || []),
  );
}

export function expectedSelectionAfterHistory(previous, targetDoc = {}) {
  if (!previous) return null;
  const validPageIds = new Set((targetDoc.pages || []).map(page => String(page?.id || '')).filter(Boolean));
  const collectionFor = type => type === 'text'
    ? targetDoc.textEdits
    : type === 'imageRegion'
      ? targetDoc.imageEdits
      : type === 'nativeObject'
        ? targetDoc.objectEdits
        : null;
  const remap = entry => {
    if (!entry || entry.type === 'annotation') return entry;
    const sourceId = String(entry.sourceId || '');
    if (!sourceId) return null;
    const edit = collectionFor(entry.type)?.[sourceId];
    if (edit?.sourceId && String(edit.sourceId) !== sourceId) return null;
    const hasRelocationClaim = edit?.pageId != null;
    const pageId = String(hasRelocationClaim
      ? edit.pageId
      : entry.item?.sourcePageId || entry.edit?.sourcePageId || entry.sourcePageId || entry.pageId || '');
    if (!pageId || !validPageIds.has(pageId)) return null;
    return { ...entry, pageId };
  };
  if (previous.type !== 'multi') return remap(previous);
  const items = (previous.items || []).map(remap).filter(Boolean);
  if (!items.length || items.length !== (previous.items || []).length) return null;
  const pageId = items[0].pageId;
  if (!pageId || items.some(item => item.pageId !== pageId)) return null;
  return { ...previous, pageId, items };
}
