// @ts-check

import { serializeRasterKey } from './revisions.js';

/**
 * Byte-weighted LRU for PDFium page/tile rasters. Values may expose close()
 * (ImageBitmap) and are disposed deterministically on eviction.
 */
export class RasterCache {
  #entries = new Map();
  #bytes = 0;
  #byteLimit;

  /**
   * @param {{ byteLimit: number }} input
   */
  constructor({ byteLimit }) {
    if (!Number.isSafeInteger(byteLimit) || byteLimit <= 0) {
      throw new TypeError('Raster cache byteLimit must be a positive safe integer.');
    }
    this.#byteLimit = byteLimit;
  }

  get byteLimit() {
    return this.#byteLimit;
  }

  /**
   * Adapts the budget (viewport or devicePixelRatio changed); shrinking
   * evicts least recently used entries at once.
   *
   * @param {number} byteLimit
   */
  setByteLimit(byteLimit) {
    if (!Number.isSafeInteger(byteLimit) || byteLimit <= 0) {
      throw new TypeError('Raster cache byteLimit must be a positive safe integer.');
    }
    this.#byteLimit = byteLimit;
    this.#evict();
  }

  /**
   * Evicts least recently used entries until at most `bytes` remain, without
   * changing the budget (memory pressure, hidden tab).
   *
   * @param {number} bytes
   * @returns {number} evicted entries
   */
  trimTo(bytes) {
    const target = Math.max(0, Number(bytes) || 0);
    let evicted = 0;
    while (this.#bytes > target && this.#entries.size) {
      this.#evictOldest();
      evicted += 1;
    }
    return evicted;
  }

  get byteSize() {
    return this.#bytes;
  }

  get size() {
    return this.#entries.size;
  }

  /**
   * @param {import('./revisions.js').RasterKey} key
   */
  get(key) {
    const serialized = serializeRasterKey(key);
    const entry = this.#entries.get(serialized);
    if (!entry) return null;
    this.#entries.delete(serialized);
    this.#entries.set(serialized, entry);
    return entry.value;
  }

  /**
   * @param {import('./revisions.js').RasterKey} key
   * @param {unknown} value
   * @param {number} byteSize
   */
  set(key, value, byteSize) {
    if (!Number.isSafeInteger(byteSize) || byteSize <= 0) {
      throw new TypeError('Raster byteSize must be a positive safe integer.');
    }
    const serialized = serializeRasterKey(key);
    const previous = this.#entries.get(serialized);
    if (previous) {
      this.#entries.delete(serialized);
      this.#bytes -= previous.byteSize;
      if (previous.value !== value) this.#dispose(previous.value);
    }
    if (byteSize > this.#byteLimit) {
      this.#dispose(value);
      return false;
    }
    this.#entries.set(serialized, { key: Object.freeze({ ...key }), value, byteSize });
    this.#bytes += byteSize;
    this.#evict();
    return true;
  }

  /**
   * @param {string} pageId
   * @param {number} minimumRevision
   */
  invalidatePageBefore(pageId, minimumRevision) {
    for (const [serialized, entry] of this.#entries) {
      if ((entry.key.pageId === pageId || entry.key.pageId.startsWith(`${pageId}:rotation-`)) &&
        entry.key.revision < minimumRevision) {
        this.#entries.delete(serialized);
        this.#bytes -= entry.byteSize;
        this.#dispose(entry.value);
      }
    }
  }

  /**
   * Dirty-rectangle invalidation: rasters of `pageId` from before `revision`
   * are either carried forward under `revision` (when `remap` returns the
   * value to keep, e.g. a tile the commit provably did not touch) or disposed.
   *
   * @param {string} pageId
   * @param {number} revision
   * @param {(key: import('./revisions.js').RasterKey, value: unknown) => unknown} remap
   * @returns {number} carried entries
   */
  carryPageForward(pageId, revision, remap) {
    let carried = 0;
    for (const [serialized, entry] of [...this.#entries]) {
      if (!(entry.key.pageId === pageId || entry.key.pageId.startsWith(`${pageId}:rotation-`)) ||
        entry.key.revision >= revision) continue;
      this.#entries.delete(serialized);
      this.#bytes -= entry.byteSize;
      let next = null;
      try { next = remap(entry.key, entry.value); } catch { next = null; }
      if (!next) {
        this.#dispose(entry.value);
        continue;
      }
      const key = { ...entry.key, revision };
      const nextSerialized = serializeRasterKey(key);
      const existing = this.#entries.get(nextSerialized);
      if (existing) {
        this.#entries.delete(nextSerialized);
        this.#bytes -= existing.byteSize;
        if (existing.value !== next) this.#dispose(existing.value);
      }
      this.#entries.set(nextSerialized, { key: Object.freeze(key), value: next, byteSize: entry.byteSize });
      this.#bytes += entry.byteSize;
      carried += 1;
    }
    this.#evict();
    return carried;
  }

  clear() {
    for (const entry of this.#entries.values()) this.#dispose(entry.value);
    this.#entries.clear();
    this.#bytes = 0;
  }

  #evict() {
    while (this.#bytes > this.#byteLimit && this.#entries.size) this.#evictOldest();
  }

  #evictOldest() {
    const oldestKey = this.#entries.keys().next().value;
    const entry = this.#entries.get(oldestKey);
    this.#entries.delete(oldestKey);
    this.#bytes -= entry.byteSize;
    this.#dispose(entry.value);
  }

  /**
   * @param {unknown} value
   */
  #dispose(value) {
    try {
      if (value && typeof value === 'object' && typeof value.close === 'function') value.close();
    } catch {}
  }
}
