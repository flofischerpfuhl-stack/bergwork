const MAX_NATIVE_GROUP_DEPTH = 32;

function identity(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function pathOf(descriptor) {
  return Array.isArray(descriptor?.formPath) &&
    descriptor.formPath.every(entry => Number.isSafeInteger(entry) && entry >= 0)
    ? descriptor.formPath
    : null;
}

function physicalTypeOf(descriptor) {
  // Ordinary worker descriptors report their physical type as typeName.
  // nativeTypeName is an override only when a verified logical text frame
  // changes typeName from its physical Form to text.
  return identity(descriptor?.nativeTypeName) || identity(descriptor?.typeName);
}

function objectIndexOf(descriptor) {
  const index = descriptor?.objectIndex;
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

function parentObjectIndexOf(descriptor) {
  const index = descriptor?.parentObjectIndex;
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

function hierarchyIssue(code, descriptor, detail = '') {
  return Object.freeze({
    code,
    stableId: identity(descriptor?.stableId),
    objectId: identity(descriptor?.objectId),
    detail,
  });
}

/**
 * Builds a display/navigation hierarchy from one current page inspection.
 * Parentage is accepted only from an exact unique parentObjectId identity and
 * a matching formPath prefix. Invalid objects are quarantined, never promoted
 * to top-level selectable content.
 */
export function buildNativeObjectHierarchy(descriptors = [], options = {}) {
  const maxDepth = Number.isSafeInteger(options.maxDepth) && options.maxDepth >= 0
    ? Math.min(options.maxDepth, MAX_NATIVE_GROUP_DEPTH)
    : MAX_NATIVE_GROUP_DEPTH;
  const records = (Array.isArray(descriptors) ? descriptors : []).map((descriptor, order) => ({
    descriptor,
    order,
    stableId: identity(descriptor?.stableId),
    objectId: identity(descriptor?.objectId),
    parentObjectId: identity(descriptor?.parentObjectId),
    formPath: pathOf(descriptor),
    objectIndex: objectIndexOf(descriptor),
    parentObjectIndex: parentObjectIndexOf(descriptor),
    parent: null,
    children: [],
    invalid: null,
  }));
  const issues = [];
  const mark = (record, code, detail = '') => {
    if (record.invalid) return;
    record.invalid = code;
    issues.push(hierarchyIssue(code, record.descriptor, detail));
  };

  const stableIds = new Map();
  const objectIds = new Map();
  for (const record of records) {
    if (!record.stableId || !record.objectId || !record.formPath || record.objectIndex === null) {
      mark(record, 'malformed-identity');
      continue;
    }
    const stableMatches = stableIds.get(record.stableId) || [];
    stableMatches.push(record);
    stableIds.set(record.stableId, stableMatches);
    const objectMatches = objectIds.get(record.objectId) || [];
    objectMatches.push(record);
    objectIds.set(record.objectId, objectMatches);
  }
  for (const matches of [...stableIds.values(), ...objectIds.values()]) {
    if (matches.length < 2) continue;
    for (const record of matches) mark(record, 'ambiguous-identity');
  }

  for (const record of records) {
    if (record.invalid) continue;
    const nested = record.descriptor?.nested === true || record.formPath.length > 0 || !!record.parentObjectId;
    if (!nested) continue;
    if (!record.parentObjectId) {
      mark(record, 'missing-parent-identity');
      continue;
    }
    const matches = objectIds.get(record.parentObjectId) || [];
    if (matches.length !== 1 || matches[0].invalid) {
      mark(record, matches.length > 1 ? 'ambiguous-parent' : 'missing-parent', record.parentObjectId);
      continue;
    }
    const parent = matches[0];
    if (physicalTypeOf(parent.descriptor) !== 'form') {
      mark(record, 'parent-not-physical-form', record.parentObjectId);
      continue;
    }
    if (parent.descriptor?.textFrame === true) {
      mark(record, 'opaque-text-frame-child', record.parentObjectId);
      continue;
    }
    const prefixMatches = record.formPath.length === parent.formPath.length + 1 &&
      parent.formPath.every((entry, index) => record.formPath[index] === entry);
    if (!prefixMatches) {
      mark(record, 'form-path-parent-mismatch', record.parentObjectId);
      continue;
    }
    if (record.formPath.at(-1) !== record.objectIndex) {
      mark(record, 'form-path-index-mismatch', String(record.objectIndex));
      continue;
    }
    const expectedTopLevelIndex = parent.formPath.length === 0
      ? parent.objectIndex
      : parent.parentObjectIndex;
    if (record.parentObjectIndex === null || record.parentObjectIndex !== expectedTopLevelIndex) {
      mark(record, 'parent-object-index-mismatch', String(expectedTopLevelIndex));
      continue;
    }
    record.parent = parent;
  }

  for (const record of records) {
    if (record.invalid) continue;
    const seen = new Set();
    let cursor = record;
    let depth = 0;
    while (cursor?.parent) {
      if (seen.has(cursor)) {
        for (const member of seen) mark(member, 'parent-cycle');
        break;
      }
      seen.add(cursor);
      cursor = cursor.parent;
      depth += 1;
      if (depth > maxDepth) {
        mark(record, 'maximum-depth-exceeded', String(maxDepth));
        break;
      }
    }
  }

  // A child of quarantined state is not independently safe to expose.
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (record.invalid || !record.parent?.invalid) continue;
      mark(record, 'invalid-parent', record.parent.objectId);
      changed = true;
    }
  }
  for (const record of records) {
    if (!record.invalid && record.parent) record.parent.children.push(record);
  }

  const project = record => Object.freeze({
    stableId: record.stableId,
    objectId: record.objectId,
    descriptor: record.descriptor,
    children: Object.freeze(record.children.sort((a, b) => a.order - b.order).map(project)),
  });
  return Object.freeze({
    roots: Object.freeze(records.filter(record => !record.invalid && !record.parent)
      .sort((a, b) => a.order - b.order).map(project)),
    quarantined: Object.freeze(records.filter(record => record.invalid)
      .sort((a, b) => a.order - b.order).map(record => Object.freeze({
        descriptor: record.descriptor,
        reason: record.invalid,
      }))),
    issues: Object.freeze(issues),
  });
}

export function flattenNativeObjectHierarchy(hierarchy, expandedStableIds = []) {
  const expanded = new Set(Array.isArray(expandedStableIds) ? expandedStableIds : []);
  const rows = [];
  const visit = (node, depth, ancestors) => {
    if (!node?.stableId || depth > MAX_NATIVE_GROUP_DEPTH) return;
    const children = Array.isArray(node.children) ? node.children : [];
    rows.push(Object.freeze({
      node,
      depth,
      ancestorStableIds: Object.freeze([...ancestors]),
      expandable: children.length > 0,
      expanded: children.length > 0 && expanded.has(node.stableId),
    }));
    if (!children.length || !expanded.has(node.stableId)) return;
    for (const child of children) visit(child, depth + 1, [...ancestors, node.stableId]);
  };
  for (const root of Array.isArray(hierarchy?.roots) ? hierarchy.roots : []) visit(root, 1, []);
  return Object.freeze(rows);
}

/**
 * Projects the authoritative inspection hierarchy into one flat, virtual-list
 * sequence. Known hidden/quarantined descendants never fall back as roots.
 * A search temporarily reveals matching descendants and their ancestor path.
 */
export function projectNativeObjectHierarchyLayers({
  descriptors = [],
  layers = [],
  expandedStableIds = [],
  query = '',
  pinnedLayerKeys = [],
  identitiesForLayer = layer => [layer?.item?.stableId, layer?.item?.objectId],
  makeLayer = descriptor => descriptor,
  labelForLayer = layer => layer?.label || '',
} = {}) {
  const hierarchy = buildNativeObjectHierarchy(descriptors);
  const authoritativeIds = new Set();
  for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
    for (const value of [identity(descriptor?.stableId), identity(descriptor?.objectId)]) {
      if (value) authoritativeIds.add(value);
    }
  }
  const allExpandable = [];
  const collectExpandable = nodes => {
    for (const node of nodes || []) {
      if (node.children?.length) allExpandable.push(node.stableId);
      collectExpandable(node.children);
    }
  };
  collectExpandable(hierarchy.roots);
  const allRows = flattenNativeObjectHierarchy(hierarchy, allExpandable);
  const existingByIdentity = new Map();
  for (const layer of layers) {
    for (const value of identitiesForLayer(layer) || []) {
      const key = identity(value);
      if (!key) continue;
      const previous = existingByIdentity.get(key);
      const exactOwnedAnnotation = candidate => candidate?.type === 'annotation' &&
        candidate.item?.liveCommitted === true && identity(candidate.item?.liveStableId) === key;
      // A committed annotation and its progressive native image observation
      // are two UI views of one exact Stable Binding. The annotation is the
      // owner of its editable properties; prefer it without using geometry,
      // labels or inferred image similarity. Other identity collisions retain
      // their existing fail-closed projection behavior.
      if (!previous || exactOwnedAnnotation(layer) && !exactOwnedAnnotation(previous)) {
        existingByIdentity.set(key, layer);
      }
    }
  }
  const layerForRow = row => existingByIdentity.get(row.node.stableId) ||
    existingByIdentity.get(row.node.objectId) || makeLayer(row.node.descriptor, row);
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const pinnedKeys = new Set((Array.isArray(pinnedLayerKeys) ? pinnedLayerKeys : [])
    .map(identity).filter(Boolean));
  const searchVisible = new Set();
  const searchExpanded = new Set();
  if (normalizedQuery) {
    for (const row of allRows) {
      const layer = layerForRow(row);
      const searchable = `${labelForLayer(layer)} ${row.node.descriptor?.typeName || ''}`.toLowerCase();
      if (!searchable.includes(normalizedQuery) && !pinnedKeys.has(layer?.key)) continue;
      searchVisible.add(row.node.stableId);
      for (const ancestor of row.ancestorStableIds) {
        searchVisible.add(ancestor);
        searchExpanded.add(ancestor);
      }
    }
  }
  const effectiveExpanded = new Set([...expandedStableIds, ...searchExpanded]);
  const rows = flattenNativeObjectHierarchy(hierarchy, [...effectiveExpanded])
    .filter(row => !normalizedQuery || searchVisible.has(row.node.stableId));
  const projectedByStableId = new Map(rows.map(row => {
    const layer = layerForRow(row);
    return [row.node.stableId, layer ? {
      ...layer,
      hierarchy: {
        stableId: row.node.stableId,
        parentStableId: row.ancestorStableIds.at(-1) || '',
        ancestorStableIds: row.ancestorStableIds,
        depth: row.depth,
        expandable: row.expandable,
        expanded: row.expanded,
        searchContext: normalizedQuery ? searchVisible.has(row.node.stableId) : false,
      },
    } : null];
  }));
  const childrenByParent = new Map();
  for (const row of rows) {
    const parent = row.ancestorStableIds.at(-1) || '';
    const children = childrenByParent.get(parent) || [];
    children.push(row.node.stableId);
    childrenByParent.set(parent, children);
  }
  const emitted = new Set();
  const result = [];
  const emit = stableId => {
    const layer = projectedByStableId.get(stableId);
    if (!layer || emitted.has(layer.key)) return;
    emitted.add(layer.key);
    result.push(layer);
    if (!layer.hierarchy.expanded) return;
    for (const childStableId of childrenByParent.get(stableId) || []) emit(childStableId);
  };
  const rootByIdentity = new Map();
  for (const root of hierarchy.roots) {
    rootByIdentity.set(root.stableId, root.stableId);
    rootByIdentity.set(root.objectId, root.stableId);
  }
  for (const layer of layers) {
    const identities = (identitiesForLayer(layer) || []).map(identity).filter(Boolean);
    const rootStableId = identities.map(value => rootByIdentity.get(value)).find(Boolean);
    if (rootStableId) emit(rootStableId);
    else if (identities.some(value => authoritativeIds.has(value))) continue;
    else if (!emitted.has(layer.key) && (
      !normalizedQuery || pinnedKeys.has(layer.key) ||
      `${labelForLayer(layer)} ${layer?.type || ''}`.toLowerCase().includes(normalizedQuery)
    )) {
      emitted.add(layer.key);
      result.push(layer);
    }
  }
  return Object.freeze({
    layers: Object.freeze(result),
    quarantinedCount: hierarchy.quarantined.filter(item =>
      item.reason !== 'opaque-text-frame-child' && item.reason !== 'invalid-parent').length,
  });
}
