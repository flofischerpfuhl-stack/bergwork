// @ts-check

import { createRichTextDocument } from './rich-text-document.js';
import { validateCustomFreeTextAppearanceReplacement } from './freetext-appearance-policy.js';

export const CommandType = Object.freeze({
  OBJECT_TRANSFORM: 'object.transform',
  OBJECT_SET_PROPERTIES: 'object.set-properties',
  OBJECT_REORDER: 'object.reorder',
  OBJECT_DUPLICATE: 'object.duplicate',
  OBJECT_PASTE: 'object.paste',
  PATH_DETACH_SUBPATH: 'path.detach-subpath',
  PATH_REATTACH_SUBPATH: 'path.reattach-subpath',
  PAGE_ROTATE: 'page.rotate',
  PAGE_MOVE: 'page.move',
  PAGE_NEW: 'page.new',
  PAGE_DELETE: 'page.delete',
  PAGE_DUPLICATE: 'page.duplicate',
  PAGE_IMPORT: 'page.import',
  OBJECT_INSERT: 'object.insert',
  OBJECT_DELETE: 'object.delete',
  IMAGE_REPLACE: 'image.replace',
  TEXT_REPLACE: 'text.replace',
  TEXT_BLOCK_REPLACE: 'text-block.replace',
  FORM_DEEP_EDIT: 'form.deep-edit',
  GROUP_SET: 'group.set',
  ANNOTATION_SET: 'annotation.set',
  OCR_INSERT: 'ocr.insert',
  DOCUMENT_RESTORE_SNAPSHOT: 'document.restore-snapshot',
});

const COMMAND_TYPES = new Set(Object.values(CommandType));

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
 * @returns {Record<string, unknown>}
 */
function requireObject(value) {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    throw new TypeError('Command payload must be an object.');
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @returns {readonly number[]}
 */
function normalizeMatrix(value) {
  if (!Array.isArray(value) || value.length !== 6 || value.some((item) => !Number.isFinite(item))) {
    throw new TypeError('Transform commands require a finite six-value matrix.');
  }
  return Object.freeze(value.map(Number));
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
// `String#localeCompare` without arguments is specified as the comparison of
// a default `Intl.Collator`; one shared collator gives the identical order
// (journal hashes and binding fingerprints depend on it) at a fraction of the
// cost. Paths are only needed for the error message, so they are built from
// the parent chain on failure instead of as a string per nested value: large
// path descriptors serialize thousands of points per fingerprint.
const serializableKeyCollator = new Intl.Collator();
const compareSerializableEntries = ([left], [right]) => serializableKeyCollator.compare(left, right);

/**
 * @param {unknown} value
 * @param {string} [path]
 * @returns {unknown}
 */
function cloneSerializable(value, path = 'payload') {
  return cloneSerializableAt(value, { parent: null, key: path });
}

/**
 * @param {{ parent: any, key: string | number }} trail
 * @returns {string}
 */
function serializablePath(trail) {
  const parts = [];
  for (let node = trail; node; node = node.parent) parts.push(node);
  let path = '';
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const { key } = parts[index];
    path = index === parts.length - 1 ? String(key) : typeof key === 'number' ? `${path}[${key}]` : `${path}.${key}`;
  }
  return path;
}

/**
 * @param {unknown} value
 * @param {{ parent: any, key: string | number }} trail
 * @returns {unknown}
 */
function cloneSerializableAt(value, trail) {
  if (Array.isArray(value)) {
    const result = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      result[index] = item !== null && typeof item === 'object'
        ? cloneSerializableAt(item, { parent: trail, key: index })
        : cloneSerializableScalar(item, trail, index);
    }
    return result;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(/** @type {Record<string, unknown>} */ (value));
    if (entries.length > 1) entries.sort(compareSerializableEntries);
    const result = {};
    for (const [key, item] of entries) {
      const cloned = item !== null && typeof item === 'object'
        ? cloneSerializableAt(item, { parent: trail, key })
        : cloneSerializableScalar(item, trail, key);
      // Same semantics as Object.fromEntries (a "__proto__" key stays data).
      Object.defineProperty(result, key, { value: cloned, enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  return cloneSerializableScalar(value, trail.parent, trail.key);
}

/**
 * @param {unknown} value
 * @param {any} parentTrail
 * @param {string | number} key
 * @returns {unknown}
 */
function cloneSerializableScalar(value, parentTrail, key) {
  if (
    value == null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  throw new TypeError(`Value is not journal-serializable at ${serializablePath({ parent: parentTrail, key })}: ${typeof value}`);
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(/** @type {Record<string, unknown>} */ (value))) {
      deepFreeze(item);
    }
  }
  return value;
}

/**
 * @typedef {object} PdfCommand
 * @property {string} commandId
 * @property {string} type
 * @property {string} targetId
 * @property {Record<string, unknown>} payload
 */

/**
 * @typedef {object} PdfTransaction
 * @property {string} transactionId
 * @property {string} sessionId
 * @property {number} baseRevision
 * @property {number} createdAt
 * @property {readonly PdfCommand[]} commands
 * @property {readonly string[]} resourceHashes
 */

/**
 * @param {object} input
 * @param {string} input.commandId
 * @param {string} input.type
 * @param {string} input.targetId
 * @param {Record<string, unknown>} input.payload
 * @returns {PdfCommand}
 */
export function createPdfCommand({ commandId, type, targetId, payload }) {
  if (!COMMAND_TYPES.has(type)) throw new TypeError(`Unknown PDF command type: ${String(type)}`);
  const normalizedPayload = requireObject(payload);
  const clonedPayload = /** @type {Record<string, unknown>} */ (cloneSerializable(normalizedPayload));

  if ((type === CommandType.TEXT_REPLACE || type === CommandType.TEXT_BLOCK_REPLACE) &&
      clonedPayload.richTextDocument != null) {
    const input = requireObject(clonedPayload.richTextDocument);
    if (input.version !== 1) throw new TypeError('Rich-text commands require document version 1.');
    const canonical = createRichTextDocument(input);
    if (typeof clonedPayload.text !== 'string' || clonedPayload.text !== canonical.text) {
      throw new TypeError('Rich-text command text must equal its canonical plain-text projection.');
    }
    clonedPayload.richTextDocument = { version: 1, ...canonical };
  }

  if (type === CommandType.OBJECT_TRANSFORM) {
    if (clonedPayload.matrix != null) {
      clonedPayload.matrix = normalizeMatrix(clonedPayload.matrix);
    } else {
      const bounds = clonedPayload.bounds;
      if (
        !bounds ||
        typeof bounds !== 'object' ||
        ['left', 'bottom', 'right', 'top'].some(
          key => !Number.isFinite(/** @type {Record<string, unknown>} */ (bounds)[key]),
        )
      ) {
        throw new TypeError('Transform commands require a matrix or finite PDF bounds.');
      }
    }
  }
  if (type === CommandType.OBJECT_REORDER) {
    if (
      !Number.isSafeInteger(clonedPayload.pageIndex) ||
      Number(clonedPayload.pageIndex) < 0 ||
      !Number.isSafeInteger(clonedPayload.destinationIndex) ||
      Number(clonedPayload.destinationIndex) < 0
    ) {
      throw new TypeError('Object reorder commands require non-negative page and destination indexes.');
    }
  }
  if (type === CommandType.OBJECT_DUPLICATE) {
    if (
      !Number.isSafeInteger(clonedPayload.pageIndex) ||
      Number(clonedPayload.pageIndex) < 0 ||
      typeof clonedPayload.newStableId !== 'string' ||
      !clonedPayload.newStableId.trim() ||
      !Number.isFinite(clonedPayload.dx) ||
      !Number.isFinite(clonedPayload.dy)
    ) {
      throw new TypeError(
        'Object duplicate commands require a non-negative page index, a new Stable ID, and finite offsets.',
      );
    }
    if (clonedPayload.destinationPageIndex != null && (
      !Number.isSafeInteger(clonedPayload.destinationPageIndex) || clonedPayload.destinationPageIndex < 0
    )) throw new TypeError('Duplicate destination page index must be non-negative.');
    if (clonedPayload.transform != null && (
      !Array.isArray(clonedPayload.transform) || clonedPayload.transform.length !== 6 ||
      !clonedPayload.transform.every(Number.isFinite)
    )) throw new TypeError('Duplicate page transform must contain six finite numbers.');
  }
  if (type === CommandType.OBJECT_PASTE) {
    if (clonedPayload.sourceText != null && (typeof clonedPayload.sourceText !== 'string' ||
        clonedPayload.sourceText.length > 100000)) {
      throw new TypeError('Native paste text identity must be a bounded string.');
    }
    if (!/^[a-f0-9]{64}$/u.test(String(clonedPayload.resourceHash || '')) ||
      typeof clonedPayload.sourceStableId !== 'string' || !clonedPayload.sourceStableId ||
      !Number.isSafeInteger(clonedPayload.pageIndex) || clonedPayload.pageIndex < 0 ||
      !Array.isArray(clonedPayload.transform) || clonedPayload.transform.length !== 6 ||
      !clonedPayload.transform.every(Number.isFinite) ||
      Math.abs(clonedPayload.transform[0] * clonedPayload.transform[3] - clonedPayload.transform[1] * clonedPayload.transform[2]) < 1e-9) {
      throw new TypeError('Native paste requires a snapshot, source identity, destination page and invertible transform.');
    }
  }
  if (type === CommandType.ANNOTATION_SET && clonedPayload.replaceCustomAppearance != null) {
    if (clonedPayload.replaceCustomAppearance !== true) {
      throw new TypeError('Custom FreeText replacement is a one-shot true flag or must be omitted.');
    }
    validateCustomFreeTextAppearanceReplacement(clonedPayload);
  }
  if (type === CommandType.PAGE_ROTATE) {
    if (
      !Number.isSafeInteger(clonedPayload.pageIndex) ||
      Number(clonedPayload.pageIndex) < 0 ||
      !Number.isSafeInteger(clonedPayload.rotation) ||
      ![0, 1, 2, 3].includes(Number(clonedPayload.rotation))
    ) {
      throw new TypeError(
        'Page rotation commands require a non-negative pageIndex and a 0..3 quarter rotation.',
      );
    }
  }
  if (type === CommandType.PAGE_MOVE) {
    if (!Number.isSafeInteger(clonedPayload.destinationIndex) || clonedPayload.destinationIndex < 0) {
      throw new TypeError('Page move commands require a non-negative destinationIndex.');
    }
  }
  if (type === CommandType.PAGE_NEW) {
    if (!Number.isSafeInteger(clonedPayload.pageIndex) || clonedPayload.pageIndex < 0 ||
        !Number.isFinite(clonedPayload.width) || clonedPayload.width <= 0 ||
        !Number.isFinite(clonedPayload.height) || clonedPayload.height <= 0) {
      throw new TypeError('Blank-page commands require an insertion index and positive finite dimensions.');
    }
  }
  if (type === CommandType.PAGE_DUPLICATE) {
    if (!Number.isSafeInteger(clonedPayload.pageIndex) || clonedPayload.pageIndex < 0 ||
        typeof clonedPayload.newPageId !== 'string' || !clonedPayload.newPageId.trim()) {
      throw new TypeError('Page duplicate commands require an insertion index and a new page ID.');
    }
  }
  if (type === CommandType.PAGE_IMPORT) {
    if (!Number.isSafeInteger(clonedPayload.pageIndex) || clonedPayload.pageIndex < 0 ||
        !/^[a-f0-9]{64}$/u.test(String(clonedPayload.resourceHash || '')) ||
        !Array.isArray(clonedPayload.sourcePageIndices) || !clonedPayload.sourcePageIndices.length ||
        clonedPayload.sourcePageIndices.some(index => !Number.isSafeInteger(index) || index < 0) ||
        !Array.isArray(clonedPayload.pageIds) || clonedPayload.pageIds.length !== clonedPayload.sourcePageIndices.length ||
        clonedPayload.pageIds.some(pageId => typeof pageId !== 'string' || !pageId.trim()) ||
        new Set(clonedPayload.pageIds).size !== clonedPayload.pageIds.length) {
      throw new TypeError('Page import commands require a snapshot, insertion index, source indexes, and unique page IDs.');
    }
  }
  if (type === CommandType.OCR_INSERT) {
    if (!Number.isSafeInteger(clonedPayload.pageIndex) || clonedPayload.pageIndex < 0 ||
        !/^[a-f0-9]{64}$/u.test(String(clonedPayload.fontResourceHash || '')) ||
        !Array.isArray(clonedPayload.words) || !clonedPayload.words.length || clonedPayload.words.length > 20_000) {
      throw new TypeError('OCR insertion requires a page, embedded font resource and bounded word list.');
    }
    for (const word of clonedPayload.words) {
      const basis = word?.basis;
      const points = basis && [basis.origin, basis.baseline, basis.ascent];
      const finitePoints = Array.isArray(points) && points.every(point =>
        Array.isArray(point) && point.length === 2 && point.every(Number.isFinite));
      const baselineX = finitePoints ? points[1][0] - points[0][0] : 0;
      const baselineY = finitePoints ? points[1][1] - points[0][1] : 0;
      const ascentX = finitePoints ? points[2][0] - points[0][0] : 0;
      const ascentY = finitePoints ? points[2][1] - points[0][1] : 0;
      if (!word || typeof word.text !== 'string' || !word.text.trim() || word.text.length > 1_000 ||
          !finitePoints || Math.hypot(baselineX, baselineY) < 0.5 || Math.hypot(ascentX, ascentY) < 0.5 ||
          Math.abs(baselineX * ascentY - baselineY * ascentX) < 0.25) {
        throw new TypeError('OCR words require bounded text and a finite non-degenerate PDF basis.');
      }
    }
  }
  if (type === CommandType.DOCUMENT_RESTORE_SNAPSHOT) {
    if (!/^[a-f0-9]{64}$/u.test(String(clonedPayload.resourceHash || ''))) {
      throw new TypeError('Document restore commands require a SHA-256 snapshot resource hash.');
    }
  }

  return /** @type {PdfCommand} */ (deepFreeze({
    commandId: requireId(commandId, 'commandId'),
    type,
    targetId: requireId(targetId, 'targetId'),
    payload: clonedPayload,
  }));
}

/**
 * @param {object} input
 * @param {string} input.transactionId
 * @param {string} input.sessionId
 * @param {number} input.baseRevision
 * @param {number} input.createdAt
 * @param {PdfCommand[]} input.commands
 * @param {string[]} [input.resourceHashes]
 * @returns {PdfTransaction}
 */
export function createPdfTransaction({
  transactionId,
  sessionId,
  baseRevision,
  createdAt,
  commands,
  resourceHashes = [],
}) {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    throw new TypeError('baseRevision must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new TypeError('createdAt must be a non-negative integer timestamp.');
  }
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new TypeError('A PDF transaction requires at least one command.');
  }
  if (new Set(commands.map((command) => command.commandId)).size !== commands.length) {
    throw new TypeError('Command IDs must be unique within a transaction.');
  }
  if (!Array.isArray(resourceHashes) || resourceHashes.some((hash) => typeof hash !== 'string' || !hash)) {
    throw new TypeError('resourceHashes must contain non-empty strings.');
  }

  return /** @type {PdfTransaction} */ (deepFreeze({
    transactionId: requireId(transactionId, 'transactionId'),
    sessionId: requireId(sessionId, 'sessionId'),
    baseRevision,
    createdAt,
    commands: [...commands],
    resourceHashes: [...new Set(resourceHashes)].sort(),
  }));
}

/**
 * Deterministic representation for journal storage and effect hashing.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalSerialize(value) {
  return serializeCanonicalAt(value, { parent: null, key: 'payload' });
}

// The direct form of JSON.stringify(cloneSerializable(value)), byte for byte:
// the same key order, the same refusals, undefined dropped from objects and null
// in arrays. Page inspection and every commit fingerprint thousands of path
// points; cloning each object with its sorted entries took half of inspection.
// An object shape recurs for every point, so its key order is computed once.
const canonicalKeyOrders = new Map();
const CANONICAL_KEY_ORDER_LIMIT = 4096;

function canonicalKeyOrder(keys) {
  let shapes = canonicalKeyOrders.get(keys[0]);
  if (shapes) {
    for (const shape of shapes) {
      if (shape.keys.length === keys.length && shape.keys.every((key, index) => key === keys[index])) return shape.order;
    }
  }
  const sorted = [...keys].sort(serializableKeyCollator.compare);
  // An object lists integer-like keys first, ascending, whatever their
  // insertion order was, so the clone serialized them that way.
  const isArrayIndex = key => {
    const number = Number(key);
    return Number.isInteger(number) && number >= 0 && number < 4294967295 && String(number) === key;
  };
  const indexes = sorted.filter(isArrayIndex).sort((left, right) => Number(left) - Number(right));
  const order = [...indexes, ...sorted.filter(key => !isArrayIndex(key))]
    .map(key => ({ key, quoted: `${JSON.stringify(key)}:` }));
  if (canonicalKeyOrders.size >= CANONICAL_KEY_ORDER_LIMIT) {
    canonicalKeyOrders.clear();
    shapes = undefined;
  }
  if (!shapes) canonicalKeyOrders.set(keys[0], shapes = []);
  shapes.push({ keys, order });
  return order;
}

function serializeCanonicalScalar(value, parentTrail, key) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) cloneSerializableScalar(value, parentTrail, key);
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  cloneSerializableScalar(value, parentTrail, key);
  return value === undefined ? undefined : String(value);
}

function serializeCanonicalAt(value, trail) {
  if (Array.isArray(value)) {
    let text = '[';
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      const serialized = item !== null && typeof item === 'object'
        ? serializeCanonicalAt(item, { parent: trail, key: index })
        : serializeCanonicalScalar(item, trail, index);
      text += `${index ? ',' : ''}${serialized === undefined ? 'null' : serialized}`;
    }
    return `${text}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(/** @type {Record<string, unknown>} */ (value));
    const order = keys.length ? canonicalKeyOrder(keys) : [];
    let text = '{';
    for (let index = 0; index < order.length; index += 1) {
      const { key, quoted } = order[index];
      const item = /** @type {Record<string, unknown>} */ (value)[key];
      const serialized = item !== null && typeof item === 'object'
        ? serializeCanonicalAt(item, { parent: trail, key })
        : serializeCanonicalScalar(item, trail, key);
      if (serialized !== undefined) text += `${text.length > 1 ? ',' : ''}${quoted}${serialized}`;
    }
    return `${text}}`;
  }
  return serializeCanonicalScalar(value, trail.parent, trail.key);
}
