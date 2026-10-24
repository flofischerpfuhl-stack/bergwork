export async function inspectHistoryDirtyPages({
  pages,
  dirtyPageIds,
  inspectPage,
  publishRuntimeInspection,
  reportFailure,
}) {
  const dirty = new Set(dirtyPageIds || []);
  const inspections = new Map();
  for (const page of (pages || []).filter(item => !dirty.size || dirty.has(item.id))) {
    try {
      const inspection = await inspectPage(page);
      publishRuntimeInspection(page, inspection);
      inspections.set(page.id, inspection);
    } catch (error) {
      reportFailure(page, error);
    }
  }
  return inspections;
}

export function projectHistoryPageInspections(document, inspections, projectPageInspection, engine) {
  if (!document || !inspections?.size) return document;
  const currentIndex = document.scene?.pdfiumObjectIndex || {};
  const pages = { ...(currentIndex.pages || {}) };
  for (const page of document.pages || []) {
    const inspection = inspections.get(page.id);
    if (!inspection) continue;
    pages[page.id] = projectPageInspection(page, inspection, pages[page.id]);
  }
  return {
    ...document,
    scene: {
      ...(document.scene || {}),
      pdfiumObjectIndex: {
        ...currentIndex,
        status: 'available',
        engine,
        pages,
      },
    },
  };
}

export function mergeProjectedHistoryPages(latest, projected, pageIds = []) {
  if (!latest || !projected) return latest;
  const validPageIds = new Set((latest.pages || []).map(page => page.id));
  const projectedPages = projected.scene?.pdfiumObjectIndex?.pages || {};
  const currentIndex = latest.scene?.pdfiumObjectIndex || {};
  const pages = { ...(currentIndex.pages || {}) };
  let changed = false;
  for (const pageId of new Set(pageIds || [])) {
    if (!validPageIds.has(pageId) || !Object.prototype.hasOwnProperty.call(projectedPages, pageId)) continue;
    pages[pageId] = projectedPages[pageId];
    changed = true;
  }
  if (!changed) return latest;
  return {
    ...latest,
    scene: {
      ...(latest.scene || {}),
      pdfiumObjectIndex: {
        ...currentIndex,
        status: projected.scene.pdfiumObjectIndex.status,
        engine: projected.scene.pdfiumObjectIndex.engine,
        pages,
      },
    },
  };
}

/**
 * A whole-document snapshot restore reports every page as dirty. Refreshing
 * hundreds of inspections synchronously keeps "Applying change" on screen for
 * seconds, although only the pages the user can see, has selected, or that the
 * undone transition touched need authoritative metadata right now. Every other
 * inspected page is forgotten so the lazy page mount path re-inspects it on
 * demand; pages that were never inspected stay untouched.
 */
export const HISTORY_IMMEDIATE_INSPECTION_LIMIT = 12;

export function planHistoryInspections({
  dirtyPageIds,
  restoredSnapshot = false,
  inspectedPageIds = [],
  priorityPageIds = [],
}) {
  const dirty = new Set(dirtyPageIds || []);
  // A wide commit (rotate all pages of a long document) is treated like a
  // snapshot restore: inspecting every page serially would hold the history
  // step for tens of seconds.
  if (!restoredSnapshot && dirty.size <= HISTORY_IMMEDIATE_INSPECTION_LIMIT) {
    return { immediate: dirty, deferred: new Set() };
  }
  const inspected = new Set(inspectedPageIds || []);
  const immediate = new Set([...priorityPageIds].filter(pageId => dirty.has(pageId)));
  const deferred = new Set([...dirty].filter(pageId => inspected.has(pageId) && !immediate.has(pageId)));
  return { immediate, deferred };
}

export function transitionTouchedPageIds(transition, pageIdForSource, annotationPageId) {
  const pageIds = new Set();
  if (!transition?.before || !transition?.after) return pageIds;
  for (const [collection, type] of [['textEdits', 'text'], ['imageEdits', 'image'], ['objectEdits', 'object']]) {
    const before = transition.before[collection] || {};
    const after = transition.after[collection] || {};
    for (const sourceId of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[sourceId] ?? null) === JSON.stringify(after[sourceId] ?? null)) continue;
      const pageId = pageIdForSource(sourceId, type);
      if (pageId) pageIds.add(pageId);
    }
  }
  const beforeAnnotations = new Map((transition.before.annotations || []).map(item => [item?.id, item]));
  const afterAnnotations = new Map((transition.after.annotations || []).map(item => [item?.id, item]));
  for (const id of new Set([...beforeAnnotations.keys(), ...afterAnnotations.keys()])) {
    const before = beforeAnnotations.get(id);
    const after = afterAnnotations.get(id);
    if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) continue;
    const pageId = annotationPageId(after || before);
    if (pageId) pageIds.add(pageId);
  }
  return pageIds;
}
