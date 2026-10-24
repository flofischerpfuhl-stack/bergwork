// @ts-check

export function createTileCoverage(key = '', tileKeys = []) {
  return Object.freeze({
    key: String(key),
    required: Object.freeze([...new Set(tileKeys.map(String))]),
    ready: Object.freeze([]),
  });
}

export function updateTileCoverage(state, key, tileKey, ready) {
  if (!state || state.key !== String(key) || !state.required.includes(String(tileKey))) return state;
  const next = new Set(state.ready);
  if (ready) next.add(String(tileKey));
  else next.delete(String(tileKey));
  if (next.size === state.ready.length && state.ready.every(item => next.has(item))) return state;
  return Object.freeze({ ...state, ready: Object.freeze([...next]) });
}

export function tileCoverageComplete(state) {
  return Boolean(state?.key && state.required.length &&
    state.ready.length === state.required.length && state.required.every(key => state.ready.includes(key)));
}

export function tileCoveragePublished(state, key, suspended = false) {
  return !suspended && state?.key === String(key) && tileCoverageComplete(state);
}
