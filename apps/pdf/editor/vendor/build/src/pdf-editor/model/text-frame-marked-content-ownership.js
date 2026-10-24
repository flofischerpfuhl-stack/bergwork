export const TEXT_FRAME_OWNER_MARK_PREFIX = 'FWTextFrameOwner_';

const ownerIdFromTag = tag => {
  const value = String(tag || '');
  if (!value.startsWith(TEXT_FRAME_OWNER_MARK_PREFIX)) return null;
  const id = value.slice(TEXT_FRAME_OWNER_MARK_PREFIX.length);
  return /^[a-f0-9]{32}$/u.test(id) ? id : '';
};

export const hasExactTextFrameOwnerMark = descriptor => {
  const id = String(descriptor?.frameResourceId || '');
  const markNames = Array.isArray(descriptor?.markNames)
    ? descriptor.markNames : descriptor?.textFrameValidation?.markNames;
  return /^[a-f0-9]{32}$/u.test(id) && Array.isArray(markNames) &&
    markNames.includes(`${TEXT_FRAME_OWNER_MARK_PREFIX}${id}`);
};

/** Resolve only randomly identified marked-content scopes to independently
 * verified native frame descriptors. Unknown, malformed and duplicate owners
 * remain visible and are excluded from all legacy text/bounds matching. */
export function exactTextFrameMarkedContentOwnership(items = [], descriptors = []) {
  const descriptorCounts = new Map();
  for (const descriptor of descriptors) {
    const id = String(descriptor?.frameResourceId || '');
    if (descriptor?.textFrame !== true || descriptor?.nested || !hasExactTextFrameOwnerMark(descriptor)) continue;
    descriptorCounts.set(id, (descriptorCounts.get(id) || 0) + 1);
  }

  const groups = [];
  const stack = [];
  let active = null;
  let structurallyInvalid = false;
  for (const [index, item] of items.entries()) {
    if (item?.type === 'beginMarkedContent' || item?.type === 'beginMarkedContentProps') {
      stack.push(item.tag || '');
      const ownerId = ownerIdFromTag(item.tag);
      if (ownerId !== null) {
        if (active) active.invalid = true;
        else active = { id: ownerId, depth: stack.length, indexes: [], invalid: false };
      }
      continue;
    }
    if (item?.type === 'endMarkedContent') {
      if (!stack.length) {
        structurallyInvalid = true;
        if (active) active.invalid = true;
        continue;
      }
      if (active && stack.length === active.depth) {
        groups.push(active);
        active = null;
      }
      stack.pop();
      continue;
    }
    if (active && !item?.type) active.indexes.push(index);
  }
  if (active) groups.push({ ...active, invalid: true });
  if (stack.length) structurallyInvalid = true;

  const groupCounts = new Map();
  for (const group of groups) groupCounts.set(group.id, (groupCounts.get(group.id) || 0) + 1);
  const ownerScopedIndexes = new Set(groups.flatMap(group => group.indexes));
  const ownedIndexes = new Set(groups.flatMap(group =>
    !structurallyInvalid && !group.invalid && group.id &&
      descriptorCounts.get(group.id) === 1 && groupCounts.get(group.id) === 1
      ? group.indexes : []));
  return { ownedIndexes, ownerScopedIndexes };
}
