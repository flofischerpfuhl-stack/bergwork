// @ts-check

export const RenderPriority = Object.freeze({
  VISIBLE: 0,
  OVERSCAN: 10,
  BACKGROUND: 100,
});

/**
 * Bounded priority scheduler. It never lets a stale revision become visible;
 * queued work can be cancelled before it reaches PDFium.
 */
export class RenderScheduler {
  #queue = [];
  #running = 0;
  #sequence = 0;
  #latestRevision = new Map();
  #maxConcurrent;
  #maxQueued;
  #idleListeners = new Set();

  /**
   * @param {{ maxConcurrent?: number, maxQueued?: number }} [options]
   */
  /**
   * Helper engines raise and drop the parallelism while the document is open.
   * @param {number} maxConcurrent
   */
  setMaxConcurrent(maxConcurrent) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new TypeError('maxConcurrent must be a positive safe integer.');
    }
    this.#maxConcurrent = maxConcurrent;
    this.#drain();
  }

  constructor({ maxConcurrent = 1, maxQueued = 64 } = {}) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new TypeError('maxConcurrent must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 1) {
      throw new TypeError('maxQueued must be a positive safe integer.');
    }
    this.#maxConcurrent = maxConcurrent;
    this.#maxQueued = maxQueued;
  }

  get queued() {
    return this.#queue.length;
  }

  get running() {
    return this.#running;
  }

  /**
   * Run a callback after admitted and queued raster work drains. A tile that
   * lost one transient attempt can retry without polling or a release timer.
   * @param {() => void} callback
   */
  onIdle(callback) {
    if (typeof callback !== 'function') throw new TypeError('Idle callback required.');
    this.#idleListeners.add(callback);
    if (this.#running === 0 && this.#queue.length === 0) {
      queueMicrotask(() => this.#notifyIdle());
    }
    return () => this.#idleListeners.delete(callback);
  }

  #notifyIdle() {
    if (this.#running || this.#queue.length) return;
    for (const callback of [...this.#idleListeners]) {
      try { callback(); }
      catch (error) { console.error('[pdf] render idle callback failed', error); }
    }
  }

  /**
   * @param {object} input
   * @param {string} input.jobId
   * @param {string} input.pageId
   * @param {number} input.revision
   * @param {number} [input.priority]
   * @param {number} [input.order]
   * @param {AbortSignal} [input.signal]
   * @param {() => Promise<unknown>} input.run
   */
  schedule({
    jobId,
    pageId,
    revision,
    priority = RenderPriority.BACKGROUND,
    order = 0,
    signal,
    run,
  }) {
    if (!jobId || !pageId || typeof run !== 'function') {
      return Promise.reject(new TypeError('Render jobId, pageId, and run are required.'));
    }
    if (!Number.isSafeInteger(revision) || revision < 0) {
      return Promise.reject(new TypeError('Render revision must be a non-negative safe integer.'));
    }
    if (signal?.aborted) return Promise.reject(new DOMException('Render cancelled.', 'AbortError'));
    const latest = Math.max(this.#latestRevision.get(pageId) || 0, revision);
    this.#latestRevision.set(pageId, latest);

    return new Promise((resolve, reject) => {
      const job = {
        jobId,
        pageId,
        revision,
        priority,
        order: Number.isFinite(order) ? order : 0,
        sequence: this.#sequence++,
        signal,
        run,
        resolve,
        reject,
      };
      job.abortQueued = () => {
        const index = this.#queue.indexOf(job);
        if (index < 0) return;
        this.#queue.splice(index, 1);
        job.signal?.removeEventListener('abort', job.abortQueued);
        job.reject(new DOMException('Render cancelled.', 'AbortError'));
      };
      signal?.addEventListener('abort', job.abortQueued, { once: true });
      if (this.#queue.length >= this.#maxQueued) {
        const worst = [...this.#queue]
          .sort((left, right) => right.priority - left.priority || right.order - left.order ||
            right.sequence - left.sequence)[0];
        if (worst && worst.priority >= priority) {
          this.#queue.splice(this.#queue.indexOf(worst), 1);
          worst.signal?.removeEventListener('abort', worst.abortQueued);
          worst.reject(new Error(`Render queue backpressure dropped ${worst.jobId}.`));
        } else {
          signal?.removeEventListener('abort', job.abortQueued);
          reject(new Error(`Render queue backpressure rejected ${jobId}.`));
          return;
        }
      }
      this.#queue.push(job);
      this.#queue.sort((left, right) => left.priority - right.priority || left.order - right.order ||
        left.sequence - right.sequence);
      this.#drain();
    });
  }

  /**
   * @param {string} pageId
   * @param {number} revision
   */
  invalidate(pageId, revision) {
    this.#latestRevision.set(pageId, Math.max(this.#latestRevision.get(pageId) || 0, revision));
    const retained = [];
    for (const job of this.#queue) {
      if (job.pageId === pageId && job.revision < revision) {
        job.signal?.removeEventListener('abort', job.abortQueued);
        job.reject(new Error(`Render ${job.jobId} became stale.`));
      } else {
        retained.push(job);
      }
    }
    this.#queue = retained;
  }

  /**
   * Invalidate every rotation/visibility raster identity for one document
   * page. Cache keys carry those suffixes, while commit dirtiness does not.
   *
   * @param {string} pageId
   * @param {number} revision
   */
  invalidatePage(pageId, revision) {
    const matchesPage = candidate => candidate === pageId || candidate.startsWith(`${pageId}:rotation-`);
    for (const candidate of this.#latestRevision.keys()) {
      if (matchesPage(candidate)) {
        this.#latestRevision.set(candidate, Math.max(this.#latestRevision.get(candidate) || 0, revision));
      }
    }
    const retained = [];
    for (const job of this.#queue) {
      if (matchesPage(job.pageId) && job.revision < revision) {
        job.signal?.removeEventListener('abort', job.abortQueued);
        job.reject(new Error(`Render ${job.jobId} became stale.`));
      } else {
        retained.push(job);
      }
    }
    this.#queue = retained;
  }

  #drain() {
    while (this.#running < this.#maxConcurrent && this.#queue.length) {
      const job = this.#queue.shift();
      job.signal?.removeEventListener('abort', job.abortQueued);
      if (job.signal?.aborted) {
        job.reject(new DOMException('Render cancelled.', 'AbortError'));
        continue;
      }
      if (job.revision < (this.#latestRevision.get(job.pageId) || 0)) {
        job.reject(new Error(`Render ${job.jobId} became stale.`));
        continue;
      }
      this.#running += 1;
      Promise.resolve()
        .then(job.run)
        .then((value) => {
          if (job.signal?.aborted) throw new DOMException('Render cancelled.', 'AbortError');
          if (job.revision < (this.#latestRevision.get(job.pageId) || 0)) {
            throw new Error(`Render ${job.jobId} became stale.`);
          }
          job.resolve(value);
        })
        .catch(job.reject)
        .finally(() => {
          this.#running -= 1;
          this.#drain();
          this.#notifyIdle();
        });
    }
  }
}
