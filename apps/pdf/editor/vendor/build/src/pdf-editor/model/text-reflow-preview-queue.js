/**
 * Coalesce an asynchronous text-reflow preview stream without starving a
 * continuous gesture. The caller owns revision, identity and gesture guards.
 *
 * @param {{
 *   request(input: unknown): Promise<unknown> | unknown,
 *   accept(result: unknown, input: unknown): void,
 *   reject(error: unknown, input: unknown): void,
 * }} callbacks
 */
export function createTextReflowPreviewQueue({ request, accept, reject }) {
  if (typeof request !== 'function' || typeof accept !== 'function' || typeof reject !== 'function') {
    throw new TypeError('Text reflow preview queue requires request, accept and reject callbacks.');
  }
  let cancelled = false;
  let inFlight = false;
  let pending = null;

  const callSafely = (callback, ...args) => {
    try { callback(...args); } catch {}
  };

  const start = input => {
    if (cancelled) return;
    inFlight = true;
    Promise.resolve().then(() => request(input)).then(
      result => {
        if (!cancelled) callSafely(accept, result, input);
      },
      error => {
        if (!cancelled) callSafely(reject, error, input);
      },
    ).then(() => {
      inFlight = false;
      if (cancelled) { pending = null; return; }
      const next = pending;
      pending = null;
      if (next !== null) start(next);
    }, () => {
      // Callback isolation above makes this defensive branch unreachable, but
      // retaining it guarantees no internal promise rejection can escape.
      inFlight = false;
      pending = null;
    });
  };

  return Object.freeze({
    schedule(input) {
      if (cancelled) return false;
      if (inFlight) pending = input;
      else start(input);
      return true;
    },
    cancel() {
      cancelled = true;
      pending = null;
    },
  });
}
