const IDENTITY_FIELDS = Object.freeze([
  'sessionId', 'revision', 'pageEpoch', 'pageId', 'sourceId', 'targetKind',
]);

function copyIdentity(identity) {
  if (!identity || typeof identity !== 'object' ||
      IDENTITY_FIELDS.some(field => identity[field] == null)) return null;
  return Object.fromEntries(IDENTITY_FIELDS.map(field => [field, identity[field]]));
}

function sameIdentity(left, right) {
  return !!left && !!right &&
    IDENTITY_FIELDS.every(field => left[field] === right[field]);
}

/** One retry for one refused selection on each actual reservation-settlement event. */
export function createPrewarmCapacityRetry() {
  let capacityVersion = 0;
  let refusal = null;
  return Object.freeze({
    get version() { return capacityVersion; },
    recordRefusal(identity, observedVersion = capacityVersion) {
      const current = copyIdentity(identity);
      if (!current) return false;
      const observed = Number.isSafeInteger(observedVersion) && observedVersion >= 0
        ? observedVersion : capacityVersion;
      capacityVersion = Math.max(capacityVersion, observed);
      refusal = { identity: current, refusedAt: observed };
      return true;
    },
    capacityReleased() {
      capacityVersion += 1;
      return !!refusal && capacityVersion > refusal.refusedAt;
    },
    claim(identity, { gestureActive = false } = {}) {
      if (!refusal) return false;
      if (!sameIdentity(refusal.identity, identity)) {
        refusal = null;
        return false;
      }
      if (gestureActive || capacityVersion <= refusal.refusedAt) return false;
      // A failed retry must explicitly record a new refusal. A successful one
      // cannot be retriggered by unrelated future capacity releases.
      refusal = null;
      return true;
    },
    clear(identity) {
      if (arguments.length === 0 || sameIdentity(refusal?.identity, identity)) refusal = null;
    },
  });
}

/** Release a render's reservation only after its original Promise settles. */
export function releaseDragCompositionReservation(runtime, entry, notify) {
  if (!runtime || !entry) return 0;
  const reserved = Number(entry.reservedBytes);
  const released = Number.isFinite(reserved) && reserved > 0 ? reserved : 0;
  const current = Number(runtime.compositionReservedBytes);
  runtime.compositionReservedBytes = Math.max(0,
    (Number.isFinite(current) && current > 0 ? current : 0) - released);
  entry.reservedBytes = 0;
  if (released > 0) notify?.(runtime);
  return released;
}
