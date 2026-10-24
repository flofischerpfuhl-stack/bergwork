// @ts-check

function stringKeys(value, counterpart) {
  if (value == null && Array.isArray(counterpart) && counterpart.every(item => typeof item === 'string')) {
    return [];
  }
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return null;
  return new Set(value).size === value.length ? value : null;
}

/**
 * Check only the ordered keys owned by a before/after transition. PDF layer
 * indexing may add unrelated original-object keys while a native edit is in
 * flight; those keys are intentionally outside the transaction projection.
 *
 * @returns {boolean|null} null when the values are not unique string lists.
 */
export function ownedStringListMatches(current, before, after) {
  const beforeKeys = stringKeys(before, after);
  const afterKeys = stringKeys(after, before);
  const currentKeys = stringKeys(current, beforeKeys || afterKeys);
  if (!beforeKeys || !afterKeys || !currentKeys) return null;
  const ownedKeys = new Set([...beforeKeys, ...afterKeys]);
  return JSON.stringify(currentKeys.filter(key => ownedKeys.has(key))) === JSON.stringify(beforeKeys);
}

/**
 * Apply additions, deletions, and reordering to the transition-owned keys,
 * retaining unrelated keys and their slots. A new key without an owned anchor
 * appends after existing unrelated keys.
 *
 * @returns {string[]|null} null when the values are not unique string lists.
 */
export function applyOwnedStringListDifference(current, before, after) {
  const beforeKeys = stringKeys(before, after);
  const afterKeys = stringKeys(after, before);
  const currentKeys = stringKeys(current, beforeKeys || afterKeys);
  if (!beforeKeys || !afterKeys || !currentKeys) return null;
  const beforeSet = new Set(beforeKeys);
  const afterSet = new Set(afterKeys);
  const deleted = new Set(beforeKeys.filter(key => !afterSet.has(key)));
  const added = afterKeys.filter(key => !beforeSet.has(key));
  const result = currentKeys.filter(key => !deleted.has(key));
  const retainedOrder = afterKeys.filter(key => beforeSet.has(key));
  const retainedSet = new Set(retainedOrder);
  const retainedSlots = result.flatMap((key, index) => retainedSet.has(key) ? [index] : []);
  if (retainedSlots.length !== retainedOrder.length) return null;
  retainedSlots.forEach((slot, index) => { result[slot] = retainedOrder[index]; });
  for (const key of added) {
    if (result.includes(key)) continue;
    const afterIndex = afterKeys.indexOf(key);
    const preceding = afterKeys.slice(0, afterIndex).reverse().find(candidate => result.includes(candidate));
    const following = afterKeys.slice(afterIndex + 1).find(candidate => result.includes(candidate));
    if (preceding) result.splice(result.lastIndexOf(preceding) + 1, 0, key);
    else if (following) result.splice(result.indexOf(following), 0, key);
    else result.push(key);
  }
  return result;
}
