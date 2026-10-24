// @ts-check

function saveKey(documentId, kind) {
  if (typeof documentId !== 'string' || !documentId) {
    throw new TypeError('documentId is required.');
  }
  if (typeof kind !== 'string' || !kind) {
    throw new TypeError('save kind is required.');
  }
  return `${documentId}:${kind}`;
}

/**
 * Coalesces equivalent saves while retaining synchronous execution of work().
 * The latter is required by browser file pickers, which consume transient user
 * activation before the first asynchronous boundary.
 */
export class DocumentSaveCoordinator {
  #pending = new Map();
  #onChange;

  constructor({ onChange = () => {} } = {}) {
    this.#onChange = onChange;
  }

  get activeKeys() {
    return [...this.#pending.keys()];
  }

  isPending(documentId, kind = '') {
    const prefix = `${documentId}:`;
    return kind
      ? this.#pending.has(saveKey(documentId, kind))
      : [...this.#pending.keys()].some(key => key.startsWith(prefix));
  }

  run(documentId, kind, work) {
    if (typeof work !== 'function') throw new TypeError('save work must be a function.');
    const key = saveKey(documentId, kind);
    const existing = this.#pending.get(key);
    if (existing) return existing;

    let value;
    try {
      // Deliberately invoke before constructing/chaining another promise so a
      // showSaveFilePicker call still runs in the initiating event turn.
      value = work();
    } catch (error) {
      return Promise.reject(error);
    }
    const pending = Promise.resolve(value);
    this.#pending.set(key, pending);
    this.#notify();
    const settle = () => {
      if (this.#pending.get(key) !== pending) return;
      this.#pending.delete(key);
      this.#notify();
    };
    pending.then(settle, settle);
    return pending;
  }

  async waitForDocument(documentId) {
    const prefix = `${documentId}:`;
    while (true) {
      const pending = [...this.#pending.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, promise]) => promise);
      if (!pending.length) return;
      await Promise.allSettled(pending);
    }
  }

  #notify() {
    this.#onChange(this.activeKeys);
  }
}
