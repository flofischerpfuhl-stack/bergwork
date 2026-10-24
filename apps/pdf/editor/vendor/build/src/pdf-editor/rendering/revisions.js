// @ts-check

/**
 * @typedef {object} RasterKey
 * @property {string} pageId
 * @property {number} revision
 * @property {number} scale
 * @property {{ x: number, y: number, width: number, height: number } | null} tile
 * @property {'document' | 'semantic-overlays'} [annotationMode]
 */

/**
 * @param {RasterKey} key
 * @returns {string}
 */
export function serializeRasterKey(key) {
  if (typeof key.pageId !== 'string' || !key.pageId) throw new TypeError('pageId is required.');
  if (!Number.isSafeInteger(key.revision) || key.revision < 0) {
    throw new TypeError('revision must be a non-negative safe integer.');
  }
  if (!Number.isFinite(key.scale) || key.scale <= 0) throw new TypeError('scale must be positive.');
  const tile = key.tile == null
    ? 'page'
    : [key.tile.x, key.tile.y, key.tile.width, key.tile.height].join(',');
  const annotationMode = key.annotationMode && key.annotationMode !== 'document'
    ? `:${key.annotationMode}`
    : '';
  return `${key.pageId}@${key.revision}:${key.scale}:${tile}${annotationMode}`;
}

/**
 * @param {object} input
 * @param {number} input.lastShownRevision
 * @param {number} input.requestedRevision
 * @param {number} input.resultRevision
 * @returns {boolean}
 */
export function shouldAcceptRaster({
  lastShownRevision,
  requestedRevision,
  resultRevision,
}) {
  for (const [name, value] of Object.entries({
    lastShownRevision,
    requestedRevision,
    resultRevision,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer.`);
    }
  }
  return resultRevision >= requestedRevision && resultRevision >= lastShownRevision;
}
