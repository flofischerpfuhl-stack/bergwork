// @ts-check

export const PDF_ENGINE_PROTOCOL_VERSION = 1;

export const EngineRequestType = Object.freeze({
  OPEN_SESSION: 'openSession',
  CLOSE_SESSION: 'closeSession',
  INSPECT_PAGE: 'inspectPage',
  INSPECT_BINDING: 'inspectBinding',
  BIND_SEMANTIC_TEXT: 'bindSemanticText',
  PAGE_TEXT_GLYPHS: 'pageTextGlyphs',
  EXTRACT_PAGE_TEXT: 'extractPageText',
  PROBE_FREETEXT_CAPABILITY: 'probeFreeTextCapability',
  PUT_RESOURCE: 'putResource',
  EXTRACT_FONT_RESOURCE: 'extractFontResource',
  RELEASE_RESOURCE: 'releaseResource',
  APPLY_TRANSACTION: 'applyTransaction',
  GET_TRANSACTION_STATUS: 'getTransactionStatus',
  RENDER: 'render',
  RENDER_IMAGE_PREVIEW: 'renderImagePreview',
  RENDER_ANNOTATION_PREVIEW: 'renderAnnotationPreview',
  RENDER_TEXT_FRAME_DRAG_PREVIEW: 'renderTextFrameDragPreview',
  RENDER_DRAG_COMPOSITION: 'renderDragComposition',
  RENDER_TEXT_FRAME_REFLOW_PREVIEW: 'renderTextFrameReflowPreview',
  CANCEL_RENDER: 'cancelRender',
  CHECKPOINT: 'checkpoint',
  EXPORT: 'export',
  RECOVERY_SNAPSHOT: 'recoverySnapshot',
  GET_ENGINE_LIMITS: 'getEngineLimits',
});

export const EngineErrorCode = Object.freeze({
  INVALID_REQUEST: 'invalid-request',
  SESSION_NOT_FOUND: 'session-not-found',
  SESSION_TAINTED: 'session-tainted',
  REVISION_CONFLICT: 'revision-conflict',
  TRANSACTION_REJECTED: 'transaction-rejected',
  TRANSACTION_UNKNOWN: 'transaction-unknown',
  UNSUPPORTED_OPERATION: 'unsupported-operation',
  RESOURCE_LIMIT: 'resource-limit',
  RENDER_CANCELLED: 'render-cancelled',
  PDFIUM_FAILURE: 'pdfium-failure',
  // A font program the editor ships could not be fetched (offline, blocked).
  FONT_UNAVAILABLE: 'font-unavailable',
  INTERNAL: 'internal',
});

const REQUEST_TYPES = new Set(Object.values(EngineRequestType));

/**
 * @typedef {object} EngineRequest
 * @property {number} protocolVersion
 * @property {string} requestId
 * @property {string} type
 * @property {string | null} sessionId
 * @property {number | null} revision
 * @property {string | null} transactionId
 * @property {Record<string, unknown>} payload
 */

/**
 * @typedef {object} EngineResponse
 * @property {number} protocolVersion
 * @property {string} requestId
 * @property {string} type
 * @property {boolean} ok
 * @property {string | null} sessionId
 * @property {number | null} revision
 * @property {string | null} transactionId
 * @property {Record<string, unknown> | null} result
 * @property {{ code: string, message: string, details?: unknown } | null} error
 */

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function requireId(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number | null}
 */
function optionalRevision(value, name) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  return Number(value);
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function requirePayload(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('payload must be an object.');
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {object} input
 * @param {string} input.requestId
 * @param {string} input.type
 * @param {string | null} [input.sessionId]
 * @param {number | null} [input.revision]
 * @param {string | null} [input.transactionId]
 * @param {Record<string, unknown>} [input.payload]
 * @returns {EngineRequest}
 */
export function createEngineRequest({
  requestId,
  type,
  sessionId = null,
  revision = null,
  transactionId = null,
  payload = {},
}) {
  if (!REQUEST_TYPES.has(type)) {
    throw new TypeError(`Unknown PDF engine request type: ${String(type)}`);
  }

  const normalizedSessionId = sessionId == null ? null : requireId(sessionId, 'sessionId');
  const normalizedTransactionId = transactionId == null
    ? null
    : requireId(transactionId, 'transactionId');

  if (
    (type === EngineRequestType.APPLY_TRANSACTION ||
      type === EngineRequestType.GET_TRANSACTION_STATUS) &&
    normalizedTransactionId == null
  ) {
    throw new TypeError(`${type} requires transactionId.`);
  }

  if (type !== EngineRequestType.OPEN_SESSION && normalizedSessionId == null) {
    throw new TypeError(`${type} requires sessionId.`);
  }

  return Object.freeze({
    protocolVersion: PDF_ENGINE_PROTOCOL_VERSION,
    requestId: requireId(requestId, 'requestId'),
    type,
    sessionId: normalizedSessionId,
    revision: optionalRevision(revision, 'revision'),
    transactionId: normalizedTransactionId,
    payload: requirePayload(payload),
  });
}

/**
 * @param {object} input
 * @param {EngineRequest} input.request
 * @param {boolean} input.ok
 * @param {string | null} [input.sessionId]
 * @param {number | null} [input.revision]
 * @param {string | null} [input.transactionId]
 * @param {Record<string, unknown> | null} [input.result]
 * @param {{ code: string, message: string, details?: unknown } | null} [input.error]
 * @returns {EngineResponse}
 */
export function createEngineResponse({
  request,
  ok,
  sessionId = request.sessionId,
  revision = request.revision,
  transactionId = request.transactionId,
  result = null,
  error = null,
}) {
  if (ok && error != null) throw new TypeError('Successful responses cannot carry an error.');
  if (!ok && error == null) throw new TypeError('Failed responses require an error.');
  if (error != null && !Object.values(EngineErrorCode).includes(error.code)) {
    throw new TypeError(`Unknown PDF engine error code: ${String(error.code)}`);
  }

  return Object.freeze({
    protocolVersion: PDF_ENGINE_PROTOCOL_VERSION,
    requestId: request.requestId,
    type: request.type,
    ok: Boolean(ok),
    sessionId: sessionId == null ? null : requireId(sessionId, 'sessionId'),
    revision: optionalRevision(revision, 'revision'),
    transactionId: transactionId == null ? null : requireId(transactionId, 'transactionId'),
    result: result == null ? null : requirePayload(result),
    error,
  });
}

/**
 * Validates an untrusted worker message without retaining caller-owned objects.
 *
 * @param {unknown} value
 * @returns {EngineRequest}
 */
export function parseEngineRequest(value) {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    throw new TypeError('PDF engine request must be an object.');
  }
  const request = /** @type {Record<string, unknown>} */ (value);
  if (request.protocolVersion !== PDF_ENGINE_PROTOCOL_VERSION) {
    throw new TypeError(`Unsupported PDF engine protocol version: ${String(request.protocolVersion)}`);
  }
  return createEngineRequest({
    requestId: /** @type {string} */ (request.requestId),
    type: /** @type {string} */ (request.type),
    sessionId: /** @type {string | null} */ (request.sessionId),
    revision: /** @type {number | null} */ (request.revision),
    transactionId: /** @type {string | null} */ (request.transactionId),
    payload: /** @type {Record<string, unknown>} */ (request.payload),
  });
}

/**
 * Validates an untrusted worker response without retaining caller-owned
 * payload/error objects.
 *
 * @param {unknown} value
 * @returns {EngineResponse}
 */
export function parseEngineResponse(value) {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    throw new TypeError('PDF engine response must be an object.');
  }
  const response = /** @type {Record<string, unknown>} */ (value);
  if (response.protocolVersion !== PDF_ENGINE_PROTOCOL_VERSION) {
    throw new TypeError(`Unsupported PDF engine protocol version: ${String(response.protocolVersion)}`);
  }
  if (!REQUEST_TYPES.has(response.type)) {
    throw new TypeError(`Unknown PDF engine response type: ${String(response.type)}`);
  }
  const ok = response.ok === true;
  const rawError = response.error;
  let error = null;
  if (!ok) {
    if (typeof rawError !== 'object' || rawError == null || Array.isArray(rawError)) {
      throw new TypeError('Failed PDF engine responses require a typed error.');
    }
    const typedError = /** @type {Record<string, unknown>} */ (rawError);
    if (!Object.values(EngineErrorCode).includes(typedError.code)) {
      throw new TypeError(`Unknown PDF engine error code: ${String(typedError.code)}`);
    }
    error = Object.freeze({
      code: /** @type {string} */ (typedError.code),
      message: requireId(typedError.message, 'error.message'),
      ...(typedError.details === undefined ? {} : { details: typedError.details }),
    });
  } else if (rawError != null) {
    throw new TypeError('Successful PDF engine responses cannot carry an error.');
  }

  return Object.freeze({
    protocolVersion: PDF_ENGINE_PROTOCOL_VERSION,
    requestId: requireId(response.requestId, 'requestId'),
    type: /** @type {string} */ (response.type),
    ok,
    sessionId: response.sessionId == null ? null : requireId(response.sessionId, 'sessionId'),
    revision: optionalRevision(response.revision, 'revision'),
    transactionId: response.transactionId == null
      ? null
      : requireId(response.transactionId, 'transactionId'),
    result: response.result == null ? null : requirePayload(response.result),
    error,
  });
}
