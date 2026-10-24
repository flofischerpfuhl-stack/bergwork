// @ts-check

import { log, summarizePayload } from '../../../../../assets/debug-log.js';

const EXPECTED_RENDER_ERRORS = new Set(['revision-conflict', 'render-cancelled', 'cancelled']);

/**
 * Dedicated transport for the revisioned PDF engine protocol. Unlike the
 * legacy helper it deliberately has no idle timeout: a live PDFium document
 * must remain owned by the same worker until its session is closed.
 */
export class PdfEngineWorkerTransport {
  #worker;
  #pending = new Map();
  #closed = false;
  #timeoutMs;

  /**
   * @param {object} [options]
   * @param {string | URL} [options.workerUrl]
   * @param {number} [options.timeoutMs]
   * @param {Worker} [options.worker]
   */
  constructor({
    workerUrl = '/tools/vendor/pdf-tools/pdfium-worker.js?v=20260927a',
    timeoutMs = 45_000,
    worker = undefined,
  } = {}) {
    if (!worker && typeof Worker === 'undefined') {
      throw new Error('PDFium Worker is unavailable in this environment.');
    }
    this.#worker = worker || new Worker(workerUrl, { type: 'module' });
    this.#timeoutMs = timeoutMs;
    this.#worker.addEventListener('message', this.#onMessage);
    this.#worker.addEventListener('error', this.#onError);
    this.#worker.addEventListener('messageerror', this.#onMessageError);
  }

  get closed() {
    return this.#closed;
  }

  /**
   * @param {import('./protocol.js').EngineRequest} request
   * @param {Transferable[]} [transfer]
   */
  request(request, transfer = []) {
    if (this.#closed) return Promise.reject(new Error('PDFium Worker transport is closed.'));
    if (this.#pending.has(request.requestId)) {
      return Promise.reject(new Error(`Duplicate PDF engine request ID: ${request.requestId}`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(request.requestId);
        log.error('engine.timeout', { type: request.type, requestId: request.requestId, timeoutMs: this.#timeoutMs });
        reject(new Error(`PDFium Worker timed out during ${request.type}.`));
      }, this.#timeoutMs);
      this.#pending.set(request.requestId, {
        resolve,
        reject,
        timer,
        type: request.type,
        revision: request.revision,
        commands: Array.isArray(request.payload?.commands)
          ? request.payload.commands.slice(0, 10).map(command => ({
            type: command?.type,
            targetId: command?.targetId,
            payload: summarizePayload(command?.payload),
          }))
          : undefined,
        startedAt: Date.now(),
      });
      try {
        this.#worker.postMessage(request, transfer);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(request.requestId);
        reject(error);
      }
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#worker.removeEventListener('message', this.#onMessage);
    this.#worker.removeEventListener('error', this.#onError);
    this.#worker.removeEventListener('messageerror', this.#onMessageError);
    try {
      this.#worker.terminate();
    } catch {
      // Browser implementations may already have terminated a failed worker.
    }
    this.#rejectAll(new Error('PDFium Worker transport closed.'));
  }

  #onMessage = (event) => {
    const requestId = event.data?.requestId;
    if (typeof requestId !== 'string') return;
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    const data = event.data;
    const ok = data?.ok !== false;
    const entry = {
      type: pending.type,
      ok,
      ...(ok ? {} : { error: data?.error }),
      requestId,
      revision: pending.revision,
      resultRevision: data?.revision,
      ms: Date.now() - pending.startedAt,
      commands: pending.commands,
    };
    // Stale or superseded renders are retried by the viewer; not a failure.
    const expected = !ok && EXPECTED_RENDER_ERRORS.has(data?.error?.code) && /render/i.test(pending.type || '');
    (ok || expected ? log.debug : log.warn)('engine.response', entry);
    pending.resolve(data);
  };

  #onError = (event) => {
    log.error('engine.worker-error', { message: event?.message || '' });
    this.#rejectAll(new Error(event?.message || 'PDFium Worker failed.'));
  };

  #onMessageError = () => {
    log.error('engine.worker-messageerror');
    this.#rejectAll(new Error('PDFium Worker returned an unreadable message.'));
  };

  #rejectAll(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
