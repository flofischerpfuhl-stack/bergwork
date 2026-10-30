// @ts-check

import {
  EngineErrorCode,
  EngineRequestType,
  createEngineRequest,
  parseEngineResponse,
} from './protocol.js';

/**
 * Parallel tile rendering. PDFium is not thread-safe, so one document cannot be
 * rendered from two threads; a helper is a second PDFium in its own worker with
 * a read-only session on the committed bytes of the current revision. Tiles of
 * that revision may be rendered by any instance because all of them hold the
 * same document. The primary session stays the only one that edits, inspects
 * and answers for hidden objects; a helper is opened after slow tiles, dropped
 * with every new revision and closed when it has been idle.
 *
 * Measured on a dense page: 3 instances render 16 tiles 2.3 times as fast, each
 * instance costs its own WASM heap (63 MB on that page).
 */
export class RenderHelperPool {
  #createTransport;
  #size;
  #idleCloseMs;
  /** @type {{ transport: any, sessionId: string, revision: number, inflight: number }[]} */
  #helpers = [];
  #revision = -1;
  #opening = null;
  #jobs = new Map();
  #sequence = 0;
  #idleTimer = 0;
  #capacityListeners = new Set();
  rendered = 0;

  /**
   * @param {object} options
   * @param {() => any} options.createTransport
   * @param {number} options.size helpers besides the primary session
   * @param {number} [options.idleCloseMs]
   */
  constructor({ createTransport, size, idleCloseMs = 20_000 }) {
    this.#createTransport = createTransport;
    this.#size = size;
    this.#idleCloseMs = idleCloseMs;
  }

  get size() {
    return this.#size;
  }

  /** Render jobs the engine can run at once for this revision. */
  capacity(revision) {
    return this.readyFor(revision) ? 1 + this.#helpers.length : 1;
  }

  /** @param {(capacity: number) => void} listener */
  onCapacityChanged(listener) {
    this.#capacityListeners.add(listener);
    return () => this.#capacityListeners.delete(listener);
  }

  #publishCapacity(capacity) {
    for (const listener of this.#capacityListeners) listener(capacity);
  }

  readyFor(revision) {
    return this.#helpers.length > 0 && this.#revision === revision;
  }

  get opening() {
    return this.#opening !== null;
  }

  /**
   * @param {() => Promise<{ bytes: Uint8Array | null, revision: number }>} snapshot
   * @param {() => number} currentRevision
   */
  open(snapshot, currentRevision) {
    if (this.#opening) return this.#opening;
    this.#opening = (async () => {
      const { bytes, revision } = await snapshot();
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength || revision !== currentRevision()) return false;
      await this.#closeSessions();
      const helpers = [];
      for (let index = 0; index < this.#size; index += 1) {
        const transport = this.#createTransport();
        const sessionBytes = bytes.slice();
        const request = createEngineRequest({
          requestId: `render-helper-open-${this.#sequence += 1}`,
          type: EngineRequestType.OPEN_SESSION,
          payload: { bytes: sessionBytes, warmFidelityBaseline: false },
        });
        const response = parseEngineResponse(await transport.request(request, [sessionBytes.buffer]));
        const sessionId = response.sessionId || response.result?.sessionId;
        if (!response.ok || !sessionId) {
          await transport.close?.();
          throw new Error('A render helper could not open the document.');
        }
        helpers.push({ transport, sessionId, revision: response.revision ?? 0, inflight: 0 });
      }
      if (revision !== currentRevision()) {
        await Promise.all(helpers.map(helper => helper.transport.close?.()));
        return false;
      }
      this.#helpers = helpers;
      this.#revision = revision;
      this.#armIdleClose();
      this.#publishCapacity(1 + helpers.length);
      return true;
    })().catch(() => false).finally(() => { this.#opening = null; });
    return this.#opening;
  }

  /**
   * @param {object} input
   * @param {Record<string, unknown>} input.payload the primary's render payload
   * @param {string} input.jobId
   * @param {number} input.revision
   * @returns {Promise<any> | null} null when no helper is free
   */
  render({ payload, jobId, revision }) {
    if (!this.readyFor(revision)) return null;
    const helper = this.#helpers.reduce((best, candidate) =>
      candidate.inflight < best.inflight ? candidate : best);
    if (helper.inflight >= 1) return null;
    helper.inflight += 1;
    const request = createEngineRequest({
      requestId: `render-helper-${this.#sequence += 1}`,
      type: EngineRequestType.RENDER,
      sessionId: helper.sessionId,
      revision: helper.revision,
      // The helper's page epochs are its own; it renders by index at its revision.
      payload: { ...payload, pageEpoch: undefined, pageId: undefined },
    });
    this.#jobs.set(jobId, helper);
    return helper.transport.request(request).then(parseEngineResponse).then(response => {
      if (!response.ok) {
        throw Object.assign(new Error(response.error?.message || 'Render helper failed.'), {
          code: response.error?.code || EngineErrorCode.INTERNAL,
        });
      }
      this.rendered += 1;
      return response.result;
    }).finally(() => {
      helper.inflight -= 1;
      this.#jobs.delete(jobId);
      this.#armIdleClose();
    });
  }

  /** @param {string} jobId */
  hasJob(jobId) {
    return this.#jobs.has(jobId);
  }

  /** @param {string} jobId */
  async cancel(jobId) {
    const helper = this.#jobs.get(jobId);
    if (!helper) return false;
    const response = parseEngineResponse(await helper.transport.request(createEngineRequest({
      requestId: `render-helper-cancel-${this.#sequence += 1}`,
      type: EngineRequestType.CANCEL_RENDER,
      sessionId: helper.sessionId,
      revision: helper.revision,
      payload: { jobId },
    })));
    return response.result?.cancelled === true;
  }

  #armIdleClose() {
    clearTimeout(this.#idleTimer);
    if (!this.#helpers.length) return;
    this.#idleTimer = setTimeout(() => {
      if (this.#helpers.every(helper => helper.inflight === 0)) void this.#closeSessions();
    }, this.#idleCloseMs);
    /** @type {any} */ (this.#idleTimer)?.unref?.();
  }

  async #closeSessions() {
    clearTimeout(this.#idleTimer);
    const helpers = this.#helpers;
    if (!helpers.length) return;
    this.#helpers = [];
    this.#revision = -1;
    this.#publishCapacity(1);
    // Closing the transport ends the worker and with it the helper's whole heap.
    await Promise.all(helpers.map(helper => helper.transport.close?.()));
  }

  /** A new revision: helpers hold the previous document until reopened. */
  invalidate() {
    if (this.#helpers.length) void this.#closeSessions();
  }

  async close() {
    await this.#opening;
    await this.#closeSessions();
  }
}

/**
 * Helpers only where a machine can spare the cores and memory.
 * @param {{ hardwareConcurrency?: number, deviceMemory?: number } | undefined} environment
 */
export function renderHelperCount(environment) {
  const cores = Number(environment?.hardwareConcurrency || 0);
  const memory = environment?.deviceMemory;
  if (cores < 4 || (memory !== undefined && Number(memory) < 4)) return 0;
  return Math.min(2, cores - 2);
}
