// @ts-check

import {
  EngineErrorCode,
  EngineRequestType,
  createEngineRequest,
  parseEngineResponse,
} from './protocol.js';
import { canonicalSerialize } from '../model/commands.js';
import { RenderPriority } from '../rendering/render-scheduler.js';

export const EngineSessionState = Object.freeze({
  CLOSED: 'closed',
  OPENING: 'opening',
  OPEN: 'open',
  TAINTED: 'tainted',
  CLOSING: 'closing',
});

export class PdfEngineError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'PdfEngineError';
    this.code = code;
    this.details = details;
  }
}

/**
 * @typedef {object} EngineTransport
 * @property {(request: import('./protocol.js').EngineRequest, transfer?: Transferable[]) => Promise<unknown>} request
 * @property {(() => void | Promise<void>)=} close
 */

/**
 * Main-thread owner for one worker-side PDFium session. Structural operations
 * are serialized here even though the worker independently enforces its own
 * single-writer queue.
 */
export class PdfEngineSessionOrchestrator {
  #transport;
  #requestSequence = 0;
  #writeTail = Promise.resolve();
  #transactions = new Map();
  #renderJobs = new Map();
  #dragCompositionJobs = new Set();
  #state = EngineSessionState.CLOSED;
  #sessionId = null;
  #revision = 0;
  #pageEpochs = new Map();
  #limits = null;
  #revisionListeners = new Set();
  #workCompletedListeners = new Set();
  #completedWorkSequence = 0;
  #lastFailedTransaction = null;

  /**
   * @param {object} input
   * @param {EngineTransport} input.transport
   */
  constructor({ transport }) {
    if (!transport || typeof transport.request !== 'function') {
      throw new TypeError('A PDF engine transport is required.');
    }
    this.#transport = transport;
  }

  get state() {
    return this.#state;
  }

  /** Content-free summary of the most recent transaction the engine refused. */
  get lastFailedTransaction() {
    return this.#lastFailedTransaction;
  }

  get sessionId() {
    return this.#sessionId;
  }

  get revision() {
    return this.#revision;
  }

  get completedWorkSequence() {
    return this.#completedWorkSequence;
  }

  /** A queue-full refusal does not notify; an admitted worker response does. */
  onWorkCompleted(listener) {
    if (typeof listener !== 'function') throw new TypeError('Work completion listener required.');
    this.#workCompletedListeners.add(listener);
    return () => this.#workCompletedListeners.delete(listener);
  }

  get limits() {
    return this.#limits;
  }

  /**
   * @param {string} pageId
   */
  pageEpoch(pageId) {
    return this.#pageEpochs.get(pageId) || 0;
  }

  /**
   * @param {(revision: number, details: Record<string, unknown>) => void} listener
   */
  subscribeRevision(listener) {
    if (typeof listener !== 'function') throw new TypeError('Revision listener must be a function.');
    this.#revisionListeners.add(listener);
    return () => this.#revisionListeners.delete(listener);
  }

  /**
   * @param {Uint8Array} bytes
   * @param {Record<string, unknown>} [options]
   */
  async open(bytes, options = {}) {
    if (this.#state !== EngineSessionState.CLOSED) {
      throw new Error(`Cannot open PDF engine session from ${this.#state}.`);
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new TypeError('open requires non-empty Uint8Array PDF bytes.');
    }
    this.#state = EngineSessionState.OPENING;
    try {
      const sessionBytes = bytes.slice();
      const request = createEngineRequest({
        requestId: this.#nextRequestId(),
        type: EngineRequestType.OPEN_SESSION,
        payload: { ...options, bytes: sessionBytes },
      });
      const response = await this.#send(request, [sessionBytes.buffer]);
      const result = response.result || {};
      const sessionId = response.sessionId || result.sessionId;
      if (typeof sessionId !== 'string' || !sessionId) {
        throw new PdfEngineError(EngineErrorCode.INTERNAL, 'Worker did not return a session ID.');
      }
      this.#sessionId = sessionId;
      this.#revision = response.revision ?? Number(result.revision || 0);
      this.#limits = result.limits || null;
      this.#replacePageEpochs(result.pageEpochs);
      this.#state = EngineSessionState.OPEN;
      this.#notifyRevision({ reason: 'open', pageEpochs: result.pageEpochs || {} });
      return Object.freeze({ ...result, sessionId, revision: this.#revision });
    } catch (error) {
      this.#state = EngineSessionState.CLOSED;
      throw error;
    }
  }

  /**
   * @param {{ pageId?: string, pageIndex?: number, objectCursor?: number, objectBatchSize?: number }} input
   */
  async inspectPage({ pageId, pageIndex, objectCursor, objectBatchSize }) {
    this.#requireOpen();
    const request = createEngineRequest({
      requestId: this.#nextRequestId(),
      type: EngineRequestType.INSPECT_PAGE,
      sessionId: this.#sessionId,
      revision: this.#revision,
      payload: {
        pageId,
        pageIndex,
        ...(objectCursor == null ? {} : { objectCursor }),
        ...(objectBatchSize == null ? {} : { objectBatchSize }),
      },
    });
    return (await this.#send(request)).result;
  }

  /**
   * @param {string} stableId
   */
  async inspectBinding(stableId) {
    this.#requireOpen();
    const request = createEngineRequest({
      requestId: this.#nextRequestId(),
      type: EngineRequestType.INSPECT_BINDING,
      sessionId: this.#sessionId,
      revision: this.#revision,
      payload: { stableId },
    });
    return (await this.#send(request)).result;
  }

  /**
   * Resolves one PDF.js visual text item to its exact native object group and
   * registers that Stable Binding without changing page content or revision.
   * @param {Record<string, unknown>} input
   */
  async bindSemanticText(input) {
    await this.#writeTail;
    this.#requireOpen();
    const expectedRevision = this.#revision;
    const request = createEngineRequest({
      requestId: this.#nextRequestId(),
      type: EngineRequestType.BIND_SEMANTIC_TEXT,
      sessionId: this.#sessionId,
      revision: expectedRevision,
      payload: { ...input },
    });
    const response = await this.#send(request);
    if (response.revision !== expectedRevision || response.result?.revision !== expectedRevision) {
      throw new PdfEngineError(
        EngineErrorCode.REVISION_CONFLICT,
        'Semantic text binding does not match the requested document revision.',
      );
    }
    return response.result;
  }

  /**
   * Glyph boxes of one page (PDF user space) for redaction snapping, preview
   * and search. Waits for issued writes so the geometry matches this revision.
   *
   * @param {object} input
   * @param {number} input.pageIndex
   */
  async pageTextGlyphs({ pageIndex }) {
    await this.#writeTail;
    this.#requireOpen();
    const expectedRevision = this.#revision;
    const request = createEngineRequest({
      requestId: this.#nextRequestId(),
      type: EngineRequestType.PAGE_TEXT_GLYPHS,
      sessionId: this.#sessionId,
      revision: expectedRevision,
      payload: { pageIndex },
    });
    const response = await this.#send(request);
    if (response.revision !== expectedRevision || response.result?.revision !== expectedRevision) {
      throw new PdfEngineError(
        EngineErrorCode.REVISION_CONFLICT,
        'Text glyph response does not match the requested document revision.',
      );
    }
    return response.result;
  }

  /**
   * Reads a page's text in PDFium reading order with one display-space box
   * per character (Find in PDF). Read-only; the revision is reported back.
   * @param {{ pageId?: string, pageIndex?: number }} input
   */
  async extractPageText({ pageId, pageIndex }) {
    this.#requireOpen();
    const request = createEngineRequest({
      requestId: this.#nextRequestId(),
      type: EngineRequestType.EXTRACT_PAGE_TEXT,
      sessionId: this.#sessionId,
      revision: this.#revision,
      payload: { pageId, pageIndex },
    });
    const response = await this.#send(request);
    return { ...response.result, revision: response.revision };
  }

  /**
   * Uploads a content-addressed binary resource without changing the document
   * revision. The worker independently verifies the SHA-256 identifier.
   *
   * @param {object} resource
   * @param {string} resource.hash
   * @param {string} resource.kind
   * @param {number} [resource.width]
   * @param {number} [resource.height]
   * @param {string} [resource.format]
   * @param {string} [resource.family]
   * @param {Uint8Array} resource.bytes
   */
  async putResource({ hash, kind, width, height, format, family, bindings, bytes }) {
    this.#requireWritable();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new TypeError('Resource bytes must be a non-empty Uint8Array.');
    }
    const ownedBytes = bytes.slice();
    const request = createEngineRequest({
      requestId: this.#nextRequestId(),
      type: EngineRequestType.PUT_RESOURCE,
      sessionId: this.#sessionId,
      revision: this.#revision,
      payload: { hash, kind, width, height, format, family, bindings, bytes: ownedBytes },
    });
    return (await this.#send(request, [ownedBytes.buffer])).result;
  }

  async probeFreeTextCapability(payload) {
    await this.#writeTail;
    this.#requireOpen();
    const expectedRevision = this.#revision;
    if (payload?.revision !== expectedRevision) {
      throw new PdfEngineError(EngineErrorCode.REVISION_CONFLICT, 'FreeText capability probe revision is stale.');
    }
    const request = createEngineRequest({
      requestId: this.#nextRequestId(),
      type: EngineRequestType.PROBE_FREETEXT_CAPABILITY,
      sessionId: this.#sessionId,
      revision: expectedRevision,
      payload,
    });
    const response = await this.#send(request);
    const result = response.result || {};
    if (this.#revision !== expectedRevision || response.revision !== expectedRevision ||
        result.revision !== expectedRevision || result.stableId !== payload.stableId) {
      throw new PdfEngineError(EngineErrorCode.REVISION_CONFLICT, 'FreeText capability probe response is stale.');
    }
    return result;
  }

  async extractFontResource(targetId) {
    this.#requireWritable();
    const request = createEngineRequest({
      requestId: this.#nextRequestId(),
      type: EngineRequestType.EXTRACT_FONT_RESOURCE,
      sessionId: this.#sessionId,
      revision: this.#revision,
      payload: { targetId },
    });
    return (await this.#send(request)).result;
  }

  /** Release a content-addressed resource after its transaction is complete. */
  async releaseResource(hash) {
    this.#requireWritable();
    if (typeof hash !== 'string' || !hash) {
      throw new TypeError('A non-empty resource hash is required.');
    }
    const request = createEngineRequest({
      requestId: this.#nextRequestId(),
      type: EngineRequestType.RELEASE_RESOURCE,
      sessionId: this.#sessionId,
      revision: this.#revision,
      payload: { hash },
    });
    return (await this.#send(request)).result;
  }

  /**
   * @param {import('../model/commands.js').PdfTransaction} transaction
   */
  applyTransaction(transaction) {
    this.#requireWritable();
    if (transaction.sessionId !== this.#sessionId) {
      return Promise.reject(new Error('Transaction session does not match the open engine session.'));
    }
    const transactionId = transaction.transactionId;
    const serialized = canonicalSerialize(transaction);
    const existing = this.#transactions.get(transactionId);
    if (existing) {
      if (existing.serialized !== serialized) {
        return Promise.reject(new Error(`Transaction ID collision: ${transactionId}`));
      }
      return existing.promise;
    }

    // A speculative drag raster must not keep a real edit behind the worker's
    // proof/render queue. CANCEL_RENDER is handled between native bands.
    this.#cancelDragCompositionPreparation();

    const promise = this.#enqueueWrite(async () => {
      if (transaction.baseRevision !== this.#revision) {
        throw new PdfEngineError(
          EngineErrorCode.REVISION_CONFLICT,
          `Transaction ${transactionId} targets revision ${transaction.baseRevision}; current revision is ${this.#revision}.`,
        );
      }
      const request = createEngineRequest({
        requestId: this.#nextRequestId(),
        type: EngineRequestType.APPLY_TRANSACTION,
        sessionId: this.#sessionId,
        revision: transaction.baseRevision,
        transactionId,
        payload: { commands: transaction.commands, resourceHashes: transaction.resourceHashes },
      });
      try {
        // A deterministic test gate pauses dispatch while the preview remains
        // held. Production has no hook and incurs no extra scheduling step.
        if (typeof globalThis.__fernworkPdfDragCommitGate === 'function') {
          await globalThis.__fernworkPdfDragCommitGate({ transactionId,
            baseRevision: transaction.baseRevision,
            commandTypes: transaction.commands.map(command => command.type) });
        }
        const response = await this.#send(request);
        const result = response.result || {};
        const committedRevision = response.revision ?? Number(result.committedRevision);
        if (!Number.isSafeInteger(committedRevision) || committedRevision !== this.#revision + 1) {
          this.#state = EngineSessionState.TAINTED;
          throw new PdfEngineError(
            EngineErrorCode.SESSION_TAINTED,
            `Invalid committed revision for ${transactionId}.`,
            { previousRevision: this.#revision, committedRevision },
          );
        }
        this.#revision = committedRevision;
        this.#replacePageEpochs(result.pageEpochs);
        this.#notifyRevision({
          reason: 'transaction',
          transactionId,
          dirtyPages: result.dirtyPages || [],
          pageEpochs: result.pageEpochs || {},
        });
        return Object.freeze({ ...result, committedRevision });
      } catch (error) {
        this.#lastFailedTransaction = Object.freeze({
          transactionId,
          baseRevision: transaction.baseRevision,
          commandTypes: Object.freeze(transaction.commands.map(command => String(command?.type || ''))),
          code: typeof error?.code === 'string' ? error.code : 'internal',
          at: Date.now(),
        });
        if (
          error instanceof PdfEngineError &&
          (error.code === EngineErrorCode.SESSION_TAINTED ||
            error.code === EngineErrorCode.TRANSACTION_UNKNOWN ||
            error.code === EngineErrorCode.PDFIUM_FAILURE)
        ) {
          this.#state = EngineSessionState.TAINTED;
        }
        throw error;
      }
    });
    this.#transactions.set(transactionId, { serialized, promise });
    // Transaction identity is only needed for retry coalescing around the
    // active request window. Keeping every resolved Promise for a long editing
    // session leaks the complete transaction graph.
    while (this.#transactions.size > 512) {
      this.#transactions.delete(this.#transactions.keys().next().value);
    }
    return promise;
  }

  /**
   * @param {string} transactionId
   */
  async getTransactionStatus(transactionId) {
    this.#requireOpen();
    const request = createEngineRequest({
      requestId: this.#nextRequestId(),
      type: EngineRequestType.GET_TRANSACTION_STATUS,
      sessionId: this.#sessionId,
      revision: this.#revision,
      transactionId,
    });
    const response = await this.#send(request);
    return response.result;
  }

  /**
   * @param {object} input
   * @param {string} input.pageId
   * @param {number} input.pageIndex
   * @param {number} input.scale
   * @param {{ x: number, y: number, width: number, height: number } | null} [input.tile]
   * @param {number} [input.rotation]
   * @param {'document' | 'semantic-overlays'} [input.annotationMode]
   * @param {string} input.jobId
   * @param {number} [input.priority]
   * @param {AbortSignal} [input.signal]
   */
  async render({
    pageId,
    pageIndex,
    scale,
    tile = null,
    rotation = 0,
    annotationMode = 'document',
    hiddenNativeStableIds = [],
    hiddenAnnotationObjectNumbers = [],
    byteOrder = 'BGRA',
    priority = RenderPriority.VISIBLE,
    jobId,
    signal,
  }) {
    this.#requireOpen();
    if (signal?.aborted) throw new DOMException('Render cancelled.', 'AbortError');
    // Only visible work can displace speculative drag preparation. Overscan
    // and background prefetch must not repeatedly cancel an active preview.
    if (priority === RenderPriority.VISIBLE) this.#cancelDragCompositionPreparation();
    const request = createEngineRequest({
      requestId: this.#nextRequestId(),
      type: EngineRequestType.RENDER,
      sessionId: this.#sessionId,
      revision: this.#revision,
      payload: {
        pageId,
        pageIndex,
        pageEpoch: this.pageEpoch(pageId),
        scale,
        tile,
        rotation,
        byteOrder,
        annotationMode,
        hiddenNativeStableIds,
        hiddenAnnotationObjectNumbers,
        jobId,
      },
    });
    const cancellation = () => {
      void this.cancelRender(jobId);
    };
    signal?.addEventListener('abort', cancellation, { once: true });
    const promise = this.#send(request);
    this.#renderJobs.set(jobId, promise);
    try {
      const response = await promise;
      return response.result;
    } finally {
      this.#renderJobs.delete(jobId);
      signal?.removeEventListener('abort', cancellation);
    }
  }

  /**
   * Render one bound top-level native image into image-local coordinates.
   * Reads wait for already-issued writes; the worker then serializes the
   * request with every other operation and verifies this revision again.
   *
   * @param {object} input
   * @param {string} input.stableId
   * @param {number} [input.maxEdge]
   */
  async renderImagePreview({ stableId, maxEdge = 512 }) {
    await this.#writeTail;
    this.#requireOpen();
    if (typeof stableId !== 'string' || !stableId) {
      throw new TypeError('Image preview requires a non-empty Stable ID.');
    }
    if (!Number.isSafeInteger(maxEdge) || maxEdge < 1 || maxEdge > 512) {
      throw new PdfEngineError(
        EngineErrorCode.RESOURCE_LIMIT,
        'Image preview maxEdge must be an integer from 1 through 512.',
      );
    }
    const expectedRevision = this.#revision;
    const request = createEngineRequest({
      requestId: this.#nextRequestId(),
      type: EngineRequestType.RENDER_IMAGE_PREVIEW,
      sessionId: this.#sessionId,
      revision: expectedRevision,
      payload: { stableId, maxEdge },
    });
    const response = await this.#send(request);
    const result = response.result || {};
    if (response.revision !== expectedRevision || result.revision !== expectedRevision) {
      throw new PdfEngineError(
        EngineErrorCode.REVISION_CONFLICT,
        'Image preview response does not match the requested document revision.',
      );
    }
    if (result.stableId !== stableId) {
      throw new PdfEngineError(EngineErrorCode.INTERNAL, 'Image preview returned the wrong Stable ID.');
    }
    return result;
  }

  async renderAnnotationPreview({ stableId, pageIndex, pageEpoch, annotationIndex, annotationObjectNumber, maxEdge = 512 }) {
    await this.#writeTail;
    this.#requireOpen();
    if (typeof stableId !== 'string' || !stableId) throw new TypeError('Annotation preview requires a non-empty Stable ID.');
    if (!Number.isSafeInteger(maxEdge) || maxEdge < 1 || maxEdge > 512) {
      throw new PdfEngineError(EngineErrorCode.RESOURCE_LIMIT, 'Annotation preview maxEdge must be an integer from 1 through 512.');
    }
    const expectedRevision = this.#revision;
    const request = createEngineRequest({
      requestId: this.#nextRequestId(),
      type: EngineRequestType.RENDER_ANNOTATION_PREVIEW,
      sessionId: this.#sessionId,
      revision: expectedRevision,
      payload: { stableId, pageIndex, pageEpoch, annotationIndex, annotationObjectNumber, maxEdge },
    });
    const response = await this.#send(request);
    const result = response.result || {};
    if (response.revision !== expectedRevision || result.revision !== expectedRevision || result.stableId !== stableId) {
      throw new PdfEngineError(EngineErrorCode.REVISION_CONFLICT, 'Annotation preview response is stale or belongs to another annotation.');
    }
    return result;
  }

  async renderTextFrameDragPreview({
    stableId,
    pageIndex,
    pageEpoch,
    rotation = 0,
    scale = 1,
    maxEdge = 2048,
    hiddenNativeStableIds = [],
    hiddenAnnotationObjectNumbers = [],
  }) {
    await this.#writeTail;
    this.#requireOpen();
    if (typeof stableId !== 'string' || !stableId) {
      throw new TypeError('Text-frame drag preview requires a non-empty Stable ID.');
    }
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 ||
      !Number.isSafeInteger(pageEpoch) || pageEpoch < 0 ||
      !Number.isInteger(rotation) || rotation < 0 || rotation > 3 ||
      !Number.isFinite(scale) || scale <= 0 ||
      !Number.isSafeInteger(maxEdge) || maxEdge < 1 || maxEdge > 2048) {
      throw new PdfEngineError(EngineErrorCode.INVALID_REQUEST, 'Text-frame drag preview parameters are invalid.');
    }
    if (!Array.isArray(hiddenNativeStableIds) || !Array.isArray(hiddenAnnotationObjectNumbers) ||
      hiddenNativeStableIds.length > 512 || hiddenAnnotationObjectNumbers.length > 512 ||
      hiddenNativeStableIds.some(value => typeof value !== 'string' || !value || value === stableId) ||
      hiddenAnnotationObjectNumbers.some(value => !Number.isSafeInteger(value) || value <= 0)) {
      throw new PdfEngineError(EngineErrorCode.INVALID_REQUEST, 'Text-frame drag preview visibility identities are invalid.');
    }
    const canonicalHiddenNativeStableIds = [...new Set(hiddenNativeStableIds)].sort();
    const canonicalHiddenAnnotationObjectNumbers = [...new Set(hiddenAnnotationObjectNumbers)].sort((left, right) => left - right);
    const expectedRevision = this.#revision;
    const expectedSessionId = this.#sessionId;
    const request = createEngineRequest({
      requestId: this.#nextRequestId(),
      type: EngineRequestType.RENDER_TEXT_FRAME_DRAG_PREVIEW,
      sessionId: this.#sessionId,
      revision: expectedRevision,
      payload: {
        stableId, pageIndex, pageEpoch, rotation, scale, maxEdge,
        hiddenNativeStableIds: canonicalHiddenNativeStableIds,
        hiddenAnnotationObjectNumbers: canonicalHiddenAnnotationObjectNumbers,
      },
    });
    const response = await this.#send(request);
    const result = response.result || {};
    const sameList = (actual, expected) => Array.isArray(actual) && actual.length === expected.length &&
      actual.every((value, index) => value === expected[index]);
    const expectedBytes = Number(result.stride) * Number(result.height);
    const validPixels = pixels => (pixels instanceof ArrayBuffer || ArrayBuffer.isView(pixels)) &&
      pixels.byteLength === expectedBytes;
    const rasterScale = Number(result.rasterScale);
    const boundsScaleConsistent = result.bounds && Number.isFinite(rasterScale) && rasterScale > 0 && rasterScale <= scale &&
      Math.abs(result.bounds.width * rasterScale - result.width) <= 1.01 &&
      Math.abs(result.bounds.height * rasterScale - result.height) <= 1.01;
    const outline = result.previewKind === 'outline';
    const raster = result.previewKind === 'raster';
    const validPayload = (outline && result.reason === 'backdrop-dependent-native-paint' &&
      result.format == null && result.foregroundPixels == null && result.backgroundPixels == null) ||
      (raster && result.format === 'RGBA' && validPixels(result.foregroundPixels) && validPixels(result.backgroundPixels));
    if (this.#sessionId !== expectedSessionId || this.#revision !== expectedRevision ||
      response.sessionId !== expectedSessionId || response.revision !== expectedRevision || result.revision !== expectedRevision ||
      result.stableId !== stableId || result.pageIndex !== pageIndex ||
      result.pageEpoch !== pageEpoch || result.rotation !== rotation || result.scale !== scale ||
      result.coordinateSpace !== 'page-display-aabb' || !validPayload ||
      !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) ||
      result.width < 1 || result.height < 1 || result.width > maxEdge || result.height > maxEdge ||
      result.stride !== result.width * 4 ||
      !sameList(result.hiddenNativeStableIds, canonicalHiddenNativeStableIds) ||
      !sameList(result.hiddenAnnotationObjectNumbers, canonicalHiddenAnnotationObjectNumbers) ||
      !result.bounds || ![result.bounds.x, result.bounds.y, result.bounds.width, result.bounds.height].every(Number.isFinite) ||
      result.bounds.x < 0 || result.bounds.y < 0 || result.bounds.width <= 0 || result.bounds.height <= 0 ||
      !boundsScaleConsistent) {
      throw new PdfEngineError(EngineErrorCode.REVISION_CONFLICT, 'Text-frame drag preview response is stale or belongs to another object.');
    }
    return result;
  }

  async renderDragComposition(payload) {
    this.#requireOpen();
    const job = { jobId: String(payload?.jobId || ''), cancelled: false, dispatched: false };
    this.#dragCompositionJobs.add(job);
    try {
      await this.#writeTail;
      if (job.cancelled) throw new DOMException('Drag preparation cancelled.', 'AbortError');
      this.#requireOpen();
      const expectedRevision = this.#revision;
      const expectedSessionId = this.#sessionId;
      job.dispatched = true;
      const response = await this.#send(createEngineRequest({
        requestId: this.#nextRequestId(),
        type: EngineRequestType.RENDER_DRAG_COMPOSITION,
        sessionId: expectedSessionId,
        revision: expectedRevision,
        payload,
      })).catch(error => {
        if (error?.code === EngineErrorCode.SESSION_TAINTED) this.#state = EngineSessionState.TAINTED;
        throw error;
      });
      if (job.cancelled) throw new DOMException('Drag preparation cancelled.', 'AbortError');
      const result = response.result || {};
      if (this.#sessionId !== expectedSessionId || this.#revision !== expectedRevision ||
          response.sessionId !== expectedSessionId || result.revision !== expectedRevision ||
          result.pageIndex !== payload.pageIndex || result.pageEpoch !== payload.pageEpoch) {
        throw new PdfEngineError(EngineErrorCode.REVISION_CONFLICT, 'Drag composition response became stale.');
      }
      if (result.previewKind === 'outline') return result;
      const size = Number(result.width) * Number(result.height) * 4;
      if (result.previewKind !== 'raster' || !Number.isSafeInteger(size) || size < 4 || size > 48 * 1024 * 1024 ||
          ![result.belowPixels, result.spritePixels, result.upperPixels].every(value =>
            (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) && value.byteLength === size)) {
        throw new PdfEngineError(EngineErrorCode.INVALID_REQUEST, 'Drag composition buffers are invalid.');
      }
      return result;
    } finally {
      this.#dragCompositionJobs.delete(job);
    }
  }

  #cancelDragCompositionPreparation() {
    for (const job of this.#dragCompositionJobs) {
      if (job.cancelled) continue;
      job.cancelled = true;
      if (job.dispatched && job.jobId) void this.cancelRender(job.jobId).catch(() => {});
    }
  }

  async renderTextFrameReflowPreview({
    stableId, pageIndex, pageEpoch, width, height, placement,
    rotation = 0, scale = 1, maxEdge = 2048,
    hiddenNativeStableIds = [], hiddenAnnotationObjectNumbers = [],
    signal,
  }) {
    if (signal?.aborted) throw new DOMException('Text-frame reflow preview cancelled.', 'AbortError');
    await this.#writeTail;
    this.#requireOpen();
    if (signal?.aborted) throw new DOMException('Text-frame reflow preview cancelled.', 'AbortError');
    if (typeof stableId !== 'string' || !stableId ||
      !Number.isSafeInteger(pageIndex) || pageIndex < 0 ||
      !Number.isSafeInteger(pageEpoch) || pageEpoch < 0 ||
      !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0 ||
      !placement || ![placement.x,placement.y,placement.width,placement.height].every(Number.isFinite) ||
      placement.width<=0 || placement.height<=0 ||
      (placement.baselineX!=null&&!Number.isFinite(placement.baselineX)) ||
      (placement.baselineY!=null&&!Number.isFinite(placement.baselineY)) ||
      !Number.isInteger(rotation) || rotation < 0 || rotation > 3 ||
      !Number.isFinite(scale) || scale <= 0 ||
      !Number.isSafeInteger(maxEdge) || maxEdge < 1 || maxEdge > 2048 ||
      !Array.isArray(hiddenNativeStableIds) || !Array.isArray(hiddenAnnotationObjectNumbers) ||
      hiddenNativeStableIds.length > 512 || hiddenAnnotationObjectNumbers.length > 512 ||
      hiddenNativeStableIds.some(value => typeof value !== 'string' || !value || value === stableId) ||
      hiddenAnnotationObjectNumbers.some(value => !Number.isSafeInteger(value) || value <= 0)) {
      throw new PdfEngineError(EngineErrorCode.INVALID_REQUEST, 'Text-frame reflow preview parameters are invalid.');
    }
    const expectedRevision = this.#revision;
    const expectedSessionId = this.#sessionId;
    const requestId = this.#nextRequestId();
    const jobId = `text-reflow:${requestId}`;
    const request = createEngineRequest({
      requestId, type: EngineRequestType.RENDER_TEXT_FRAME_REFLOW_PREVIEW,
      sessionId: expectedSessionId, revision: expectedRevision,
      payload: { stableId, pageIndex, pageEpoch, width, height, placement:{...placement}, rotation, scale, maxEdge,
        jobId, deadlineAt: Date.now() + 5_000,
        hiddenNativeStableIds: [...new Set(hiddenNativeStableIds)].sort(),
        hiddenAnnotationObjectNumbers: [...new Set(hiddenAnnotationObjectNumbers)].sort((a, b) => a - b) },
    });
    const cancellation = () => { void this.cancelRender(jobId).catch(() => {}); };
    signal?.addEventListener('abort', cancellation, { once: true });
    const pending = this.#send(request);
    this.#renderJobs.set(jobId, pending);
    let response;
    try {
      response = await pending;
    } finally {
      this.#renderJobs.delete(jobId);
      signal?.removeEventListener('abort', cancellation);
    }
    if (signal?.aborted) throw new DOMException('Text-frame reflow preview cancelled.', 'AbortError');
    const result = response.result || {};
    const expectedBytes=Number(result.stride)*Number(result.height);
    const validPixels=value=>(value instanceof ArrayBuffer||ArrayBuffer.isView(value))&&value.byteLength===expectedBytes;
    const validRaster=result.previewKind==='raster'&&result.format==='RGBA'&&
      validPixels(result.foregroundPixels)&&validPixels(result.backgroundPixels);
    const validOutline=result.previewKind==='outline'&&result.reason==='backdrop-dependent-native-paint'&&
      result.foregroundPixels==null&&result.backgroundPixels==null;
    const rasterScale=Number(result.rasterScale);
    const expectedFrame={frameWidth:width,frameHeight:height,placement:{...placement}};
    const sameFrame=JSON.stringify(result.proposedFrame)===JSON.stringify(expectedFrame);
    const scaleMatches=Number.isFinite(rasterScale)&&rasterScale>0&&rasterScale<=scale&&result.bounds&&
      Math.abs(result.bounds.width*rasterScale-result.width)<=1.01&&
      Math.abs(result.bounds.height*rasterScale-result.height)<=1.01;
    if (this.#sessionId !== expectedSessionId || this.#revision !== expectedRevision ||
      response.sessionId !== expectedSessionId || response.revision !== expectedRevision ||
      result.stableId !== stableId || result.pageIndex !== pageIndex || result.pageEpoch !== pageEpoch ||
      result.revision !== expectedRevision || result.rotation!==rotation || result.scale!==scale || !sameFrame || !scaleMatches ||
      result.coordinateSpace !== 'page-display-aabb' ||
      !(validRaster||validOutline) || !Number.isSafeInteger(result.width)||!Number.isSafeInteger(result.height)||
      result.width<1||result.height<1||result.width>maxEdge||result.height>maxEdge||result.stride!==result.width*4||
      !result.bounds||![result.bounds.x,result.bounds.y,result.bounds.width,result.bounds.height].every(Number.isFinite)||
      result.bounds.x<0||result.bounds.y<0||result.bounds.width<=0||result.bounds.height<=0||
      !Array.isArray(result.hiddenNativeStableIds)||!Array.isArray(result.hiddenAnnotationObjectNumbers)||
      result.hiddenNativeStableIds.join('\0')!==request.payload.hiddenNativeStableIds.join('\0')||
      result.hiddenAnnotationObjectNumbers.join(',')!==request.payload.hiddenAnnotationObjectNumbers.join(',')) {
      throw new PdfEngineError(EngineErrorCode.REVISION_CONFLICT, 'Text-frame reflow preview response is stale or invalid.');
    }
    return result;
  }


  /**
   * @param {string} jobId
   */
  async cancelRender(jobId) {
    if (!this.#sessionId || this.#state === EngineSessionState.CLOSED) return false;
    const request = createEngineRequest({
      requestId: this.#nextRequestId(),
      type: EngineRequestType.CANCEL_RENDER,
      sessionId: this.#sessionId,
      revision: this.#revision,
      payload: { jobId },
    });
    const response = await this.#send(request);
    return response.result?.cancelled === true;
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.retainAsResource] also keep the snapshot as a
   *   worker-resident pdf-snapshot resource (`result.retainedAsResource`), so
   *   registering it does not have to send the bytes back.
   */
  async checkpoint({ retainAsResource = false } = {}) {
    return this.#enqueueWrite(async () => {
      this.#requireOpen();
      const request = createEngineRequest({
        requestId: this.#nextRequestId(),
        type: EngineRequestType.CHECKPOINT,
        sessionId: this.#sessionId,
        revision: this.#revision,
        ...(retainAsResource ? { payload: { retainAsResource: true } } : {}),
      });
      return (await this.#send(request)).result;
    });
  }

  /**
   * Bytes of the last successfully committed revision, also after a failed
   * mutation tainted the session. `bytes` is null when no verified snapshot
   * of that revision is retained (for example above the snapshot size limit).
   */
  async recoverySnapshot() {
    return this.#enqueueWrite(async () => {
      this.#requireOpen();
      const request = createEngineRequest({
        requestId: this.#nextRequestId(),
        type: EngineRequestType.RECOVERY_SNAPSHOT,
        sessionId: this.#sessionId,
        revision: this.#revision,
      });
      const result = (await this.#send(request)).result || {};
      const bytes = result.bytes instanceof Uint8Array && result.bytes.byteLength > 0 &&
        result.revision === this.#revision ? result.bytes : null;
      return Object.freeze({ revision: this.#revision, bytes });
    });
  }

  /**
   * @param {Record<string, unknown>} [options]
   */
  async export(options = {}) {
    return this.#enqueueWrite(async () => {
      this.#requireOpen();
      const request = createEngineRequest({
        requestId: this.#nextRequestId(),
        type: EngineRequestType.EXPORT,
        sessionId: this.#sessionId,
        revision: this.#revision,
        payload: options,
      });
      return (await this.#send(request)).result;
    });
  }

  async close() {
    if (this.#state === EngineSessionState.CLOSED) return;
    const sessionId = this.#sessionId;
    this.#state = EngineSessionState.CLOSING;
    await this.#writeTail.catch(() => {});
    try {
      if (sessionId) {
        const request = createEngineRequest({
          requestId: this.#nextRequestId(),
          type: EngineRequestType.CLOSE_SESSION,
          sessionId,
          revision: this.#revision,
        });
        await this.#send(request);
      }
    } finally {
      await this.#transport.close?.();
      this.#state = EngineSessionState.CLOSED;
      this.#sessionId = null;
      this.#revision = 0;
      this.#pageEpochs.clear();
      this.#transactions.clear();
      this.#renderJobs.clear();
    }
  }

  #nextRequestId() {
    this.#requestSequence += 1;
    return `engine-${this.#requestSequence}`;
  }

  #requireOpen() {
    if (this.#state !== EngineSessionState.OPEN && this.#state !== EngineSessionState.TAINTED) {
      throw new Error(`PDF engine session is not open (${this.#state}).`);
    }
  }

  #requireWritable() {
    if (this.#state === EngineSessionState.TAINTED) {
      throw new PdfEngineError(EngineErrorCode.SESSION_TAINTED, 'PDF engine session is tainted.');
    }
    if (this.#state !== EngineSessionState.OPEN) {
      throw new Error(`PDF engine session is not writable (${this.#state}).`);
    }
  }

  /**
   * @param {() => Promise<unknown>} operation
   */
  #enqueueWrite(operation) {
    const next = this.#writeTail.then(operation, operation);
    this.#writeTail = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * @param {unknown} value
   */
  #replacePageEpochs(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [pageId, epoch] of Object.entries(value)) {
      if (Number.isSafeInteger(epoch) && Number(epoch) >= 0) {
        this.#pageEpochs.set(pageId, Number(epoch));
      }
    }
  }

  /**
   * @param {import('./protocol.js').EngineRequest} request
   * @param {Transferable[]} [transfer]
   */
  async #send(request, transfer = []) {
    let completedWorkerWork = false;
    try {
      const response = parseEngineResponse(await this.#transport.request(request, transfer));
      // A queue-full refusal never entered the worker's bounded job queue.
      // Counting that refusal would immediately wake its own tile retry.
      completedWorkerWork = ![
        EngineRequestType.CANCEL_RENDER,
        EngineRequestType.GET_TRANSACTION_STATUS,
        EngineRequestType.GET_ENGINE_LIMITS,
        EngineRequestType.CLOSE_SESSION,
      ].includes(request.type) && !(response.ok === false &&
        response.error?.code === EngineErrorCode.RESOURCE_LIMIT &&
        /queue is full/iu.test(String(response.error?.message || '')));
      if (response.requestId !== request.requestId || response.type !== request.type) {
        throw new PdfEngineError(EngineErrorCode.INVALID_REQUEST, 'Mismatched PDF engine response.');
      }
      if (!response.ok) {
        throw new PdfEngineError(
          response.error?.code || EngineErrorCode.INTERNAL,
          response.error?.message || 'PDF engine request failed.',
          response.error?.details,
        );
      }
      return response;
    } finally {
      if (completedWorkerWork) {
        this.#completedWorkSequence += 1;
        for (const listener of this.#workCompletedListeners) {
          try { listener(this.#completedWorkSequence); }
          catch { /* A UI retry observer cannot compromise the session. */ }
        }
      }
    }
  }

  #notifyRevision(details) {
    for (const listener of this.#revisionListeners) {
      try {
        listener(this.#revision, Object.freeze({ ...details }));
      } catch {
        // A UI observer cannot compromise engine state.
      }
    }
  }
}
