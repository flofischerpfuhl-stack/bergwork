// @ts-check

const DEFAULT_TTL_MS = 12_000;
const DEFAULT_HEARTBEAT_MS = 4_000;

function randomOwnerId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `writer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function deferred() {
  /** @type {(value?: unknown) => void} */
  let resolve = () => {};
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

/**
 * A browser-local, single-writer lease for one PDF draft. Web Locks is the
 * authoritative path. The localStorage heartbeat is a cross-browser fallback
 * and also exposes diagnostics to other tabs.
 */
export class PdfDraftWriterLease {
  #documentKey;
  #ownerId;
  #ttlMs;
  #heartbeatMs;
  #locks;
  #storage;
  #timers;
  #now;
  #state = 'idle';
  #releaseGate = null;
  #lockRequest = null;
  #heartbeatTimer = 0;
  #storageKey;
  #onStorage;

  constructor({
    documentKey,
    ownerId = randomOwnerId(),
    ttlMs = DEFAULT_TTL_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    locks = globalThis.navigator?.locks,
    storage = globalThis.localStorage,
    timers = globalThis,
    now = () => Date.now(),
  }) {
    if (typeof documentKey !== 'string' || !documentKey) {
      throw new TypeError('A document key is required for writer ownership.');
    }
    this.#documentKey = documentKey;
    this.#ownerId = ownerId;
    this.#ttlMs = Math.max(1_000, Number(ttlMs) || DEFAULT_TTL_MS);
    this.#heartbeatMs = Math.max(250, Math.min(
      Number(heartbeatMs) || DEFAULT_HEARTBEAT_MS,
      this.#ttlMs / 2,
    ));
    this.#locks = locks;
    this.#storage = storage;
    this.#timers = timers;
    this.#now = now;
    this.#storageKey = `fernwork:pdf-writer:${documentKey}`;
    this.#onStorage = event => {
      if (
        this.#state === 'held' &&
        event?.key === this.#storageKey &&
        this.#readFallback()?.ownerId !== this.#ownerId
      ) {
        this.#state = 'lost';
        this.#stopHeartbeat();
      }
    };
  }

  get documentKey() {
    return this.#documentKey;
  }

  get ownerId() {
    return this.#ownerId;
  }

  get state() {
    return this.#state;
  }

  get writable() {
    return this.#state === 'held';
  }

  async acquire() {
    if (this.#state === 'held') return true;
    if (this.#state === 'acquiring') {
      throw new Error('Writer lease acquisition is already in progress.');
    }
    this.#state = 'acquiring';
    if (this.#locks?.request) {
      const decided = deferred();
      const releaseGate = deferred();
      this.#releaseGate = releaseGate;
      this.#lockRequest = this.#locks.request(
        `fernwork-pdf-writer:${this.#documentKey}`,
        { mode: 'exclusive', ifAvailable: true },
        async lock => {
          if (!lock) {
            decided.resolve(false);
            return false;
          }
          this.#state = 'held';
          this.#writeHeartbeat();
          this.#startHeartbeat();
          decided.resolve(true);
          await releaseGate.promise;
          return true;
        },
      ).catch(() => {
        decided.resolve(false);
        return false;
      });
      const acquired = Boolean(await decided.promise);
      if (!acquired) {
        this.#state = 'contended';
        this.#releaseGate = null;
      }
      return acquired;
    }
    return this.#acquireFallback();
  }

  assertWritable() {
    if (!this.writable) {
      const error = new Error(
        this.#state === 'contended'
          ? 'This PDF draft is open for writing in another tab.'
          : 'PDF writer ownership was lost; editing is read-only until ownership is reacquired.',
      );
      // @ts-ignore application error metadata
      error.code = 'writer-lease-unavailable';
      throw error;
    }
  }

  async release() {
    if (this.#state === 'released' || this.#state === 'idle') return;
    this.#stopHeartbeat();
    const current = this.#readFallback();
    if (current?.ownerId === this.#ownerId) {
      try {
        this.#storage?.removeItem(this.#storageKey);
      } catch {
        // Storage cleanup is best effort; the TTL prevents permanent locking.
      }
    }
    this.#releaseGate?.resolve();
    await this.#lockRequest?.catch(() => {});
    this.#releaseGate = null;
    this.#lockRequest = null;
    this.#state = 'released';
  }

  #acquireFallback() {
    const current = this.#readFallback();
    const now = this.#now();
    if (current && current.ownerId !== this.#ownerId && current.expiresAt > now) {
      this.#state = 'contended';
      return false;
    }
    this.#writeHeartbeat();
    const confirmed = this.#readFallback();
    if (confirmed?.ownerId !== this.#ownerId) {
      this.#state = 'contended';
      return false;
    }
    this.#state = 'held';
    this.#startHeartbeat();
    return true;
  }

  #readFallback() {
    try {
      const value = this.#storage?.getItem(this.#storageKey);
      if (!value) return null;
      const parsed = JSON.parse(value);
      if (
        typeof parsed?.ownerId !== 'string' ||
        !Number.isFinite(parsed?.expiresAt)
      ) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  #writeHeartbeat() {
    try {
      this.#storage?.setItem(this.#storageKey, JSON.stringify({
        ownerId: this.#ownerId,
        documentKey: this.#documentKey,
        expiresAt: this.#now() + this.#ttlMs,
        updatedAt: this.#now(),
      }));
    } catch {
      // Web Locks remains authoritative when localStorage is unavailable.
    }
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.#timers?.addEventListener?.('storage', this.#onStorage);
    this.#heartbeatTimer = this.#timers?.setInterval?.(() => {
      if (this.#state !== 'held') return;
      this.#writeHeartbeat();
    }, this.#heartbeatMs) || 0;
  }

  #stopHeartbeat() {
    if (this.#heartbeatTimer) this.#timers?.clearInterval?.(this.#heartbeatTimer);
    this.#heartbeatTimer = 0;
    this.#timers?.removeEventListener?.('storage', this.#onStorage);
  }
}
