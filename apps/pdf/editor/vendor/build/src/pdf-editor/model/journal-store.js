// @ts-check

const DEFAULT_DB_NAME = 'oo-pdf-engine-journal';
const STORE_NAME = 'sessions';
const RESOURCE_STORE_NAME = 'resources';
const DEFAULT_CHECKPOINT_RING_BYTES = 192 * 1024 * 1024;
const DEFAULT_RESOURCE_BYTES = 256 * 1024 * 1024;
const DEFAULT_OPFS_RESOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_CHECKPOINT_COUNT = 1;

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array();
}

function resourceBytes(resources = []) {
  return resources.reduce((total, resource) => total + (
    asBytes(resource?.bytes).byteLength || Number(resource?.byteLength || 0)
  ), 0);
}

// Snapshot resources of large documents carry thousands of binding records
// (several MB of JSON). Structured-cloning that into the IndexedDB manifest on
// every commit dominated the journal write, so bindings above this size live
// in an OPFS sidecar file and are read back when the resource is hydrated.
const RESOURCE_BINDINGS_SIDECAR_MIN_ENTRIES = 64;

function encodeBindingsSidecar(bindings) {
  return new TextEncoder().encode(JSON.stringify(bindings));
}

function decodeBindingsSidecar(bytes) {
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Binding records of a snapshot resource. A snapshot the worker retained
 * itself arrives with its records pre-encoded (`bindingsSidecar`, the exact
 * sidecar encoding) instead of as an array; decode only when the records are
 * really needed as objects.
 */
export function resourceBindingRecords(resource) {
  if (Array.isArray(resource?.bindings) && resource.bindings.length) return resource.bindings;
  const sidecar = resource?.bindingsSidecar;
  if (sidecar instanceof Uint8Array && sidecar.byteLength) return decodeBindingsSidecar(sidecar);
  return Array.isArray(resource?.bindings) ? resource.bindings : [];
}

function resourceBindingCount(resource) {
  if (resource?.bindingsSidecar instanceof Uint8Array && Number.isSafeInteger(resource.bindingsCount)) {
    return resource.bindingsCount;
  }
  return Array.isArray(resource?.bindings) ? resource.bindings.length : 0;
}

function resourceMetadata(resource, storage = {}) {
  const {
    bytes: _bytes,
    fileName: _fileName,
    indexedDbKey: _indexedDbKey,
    byteLength: _byteLength,
    bindingsSidecar: _bindingsSidecar,
    ...metadata
  } = resource || {};
  return {
    ...metadata,
    bytes: storage.bytes || null,
    fileName: storage.fileName || null,
    indexedDbKey: storage.indexedDbKey || null,
    byteLength: Number(storage.byteLength || 0),
  };
}

function resourceStorageKey(documentKey, hash) {
  return JSON.stringify([String(documentKey), String(hash)]);
}

function checkpointKey(documentKey) {
  let hash = 2166136261;
  for (const char of String(documentKey)) {
    hash ^= char.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function validCheckpointRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeCheckpointRing(record) {
  if (Array.isArray(record?.checkpointRing)) {
    return record.checkpointRing.filter(entry => (
      validCheckpointRevision(entry?.revision) && Number(entry?.byteLength || 0) > 0
    ));
  }
  const revision = record?.checkpointRevision;
  const byteLength = asBytes(record?.checkpointBytes).byteLength ||
    Number(record?.checkpointByteLength || 0);
  if (validCheckpointRevision(revision) && byteLength > 0) {
    return [{
      revision,
      bindings: record.checkpointBindings || [],
      bytes: record.checkpointBytes || null,
      fileName: record.checkpointFile || null,
      byteLength,
      createdAt: Number(record.updatedAt || Date.now()),
    }];
  }
  return [];
}

function boundedCheckpointRing(entries, { byteLimit, countLimit }) {
  const byRevision = new Map();
  for (const entry of entries) {
    if (validCheckpointRevision(entry?.revision) && Number(entry?.byteLength || 0) > 0) {
      byRevision.set(entry.revision, entry);
    }
  }
  let ring = [...byRevision.values()].sort((left, right) => left.revision - right.revision);
  if (ring.length > countLimit) {
    if (countLimit <= 1) {
      ring = ring.slice(-1);
    } else {
      const first = ring[0];
      ring = [first, ...ring.slice(-(countLimit - 1))];
    }
  }
  while (
    ring.length > 1 &&
    ring.reduce((total, entry) => total + Number(entry.byteLength || 0), 0) > byteLimit
  ) {
    ring.splice(ring.length > 2 ? 1 : 0, 1);
  }
  return ring;
}

function quotaError(message) {
  if (typeof DOMException === 'function') return new DOMException(message, 'QuotaExceededError');
  const error = new Error(message);
  error.name = 'QuotaExceededError';
  return error;
}

function retainedDocumentKeySet(value) {
  if (value == null || typeof value === 'string' || typeof value[Symbol.iterator] !== 'function') {
    return null;
  }
  try {
    const keys = new Set(value);
    return [...keys].every(key => typeof key === 'string' && key) ? keys : null;
  } catch {
    return null;
  }
}

/**
 * Durable typed-command storage. Journal rows contain typed command batches,
 * content-addressed resources, and a byte-bounded checkpoint ring. When OPFS
 * is available, checkpoint bytes are written before the IndexedDB manifest is
 * atomically advanced; IndexedDB remains the complete fallback.
 */
export class IndexedDbCommandJournalStore {
  #dbName;
  #indexedDb;
  #storageManager;
  #openPromise = null;
  #checkpointByteLimit;
  #resourceByteLimit;
  #opfsResourceByteLimit;
  #checkpointCount;
  #opfsRootPromise = null;

  constructor({
    dbName = DEFAULT_DB_NAME,
    checkpointByteLimit = DEFAULT_CHECKPOINT_RING_BYTES,
    resourceByteLimit = DEFAULT_RESOURCE_BYTES,
    opfsResourceByteLimit = DEFAULT_OPFS_RESOURCE_BYTES,
    checkpointCount = DEFAULT_CHECKPOINT_COUNT,
    indexedDb = globalThis.indexedDB,
    storageManager = globalThis.navigator?.storage,
  } = {}) {
    this.#dbName = dbName;
    this.#indexedDb = indexedDb;
    this.#storageManager = storageManager;
    this.#checkpointByteLimit = Math.max(1, Number(checkpointByteLimit));
    this.#resourceByteLimit = Math.max(1, Number(resourceByteLimit));
    this.#opfsResourceByteLimit = Math.max(this.#resourceByteLimit, Number(opfsResourceByteLimit));
    this.#checkpointCount = Math.max(1, Number(checkpointCount));
  }

  async load(documentKey) {
    const record = await this.#get(documentKey);
    if (!record) return null;
    const ring = normalizeCheckpointRing(record);
    const active = ring.at(-1) || null;
    let checkpointBytes = asBytes(active?.bytes);
    if (!checkpointBytes.byteLength && active?.fileName) {
      checkpointBytes = await this.#readOpfs(active.fileName);
    }
    return {
      ...record,
      checkpointRing: ring,
      checkpointRevision: active?.revision || 0,
      checkpointBindings: active?.bindings || [],
      checkpointBytes: checkpointBytes.byteLength ? checkpointBytes : null,
      checkpointStorage: active?.fileName ? 'opfs' : 'indexeddb',
      checkpointRingBytes: ring.reduce((total, item) => total + Number(item.byteLength || 0), 0),
    };
  }

  async loadResource(documentKey, hash) {
    const record = await this.#get(documentKey);
    const resource = (record?.resources || []).find(candidate => candidate?.hash === hash);
    if (!resource) return null;
    let bytes = asBytes(resource.bytes);
    if (!bytes.byteLength && resource.fileName) bytes = await this.#readOpfs(resource.fileName);
    if (!bytes.byteLength && resource.indexedDbKey) {
      bytes = asBytes((await this.#getResource(resource.indexedDbKey))?.bytes);
    }
    if (!bytes.byteLength || bytes.byteLength !== Number(resource.byteLength || bytes.byteLength)) {
      throw new Error(`PDF recovery resource is unavailable: ${hash}`);
    }
    let bindings = Array.isArray(resource.bindings) ? resource.bindings : [];
    if (resource.bindingsFileName && !bindings.length) {
      const sidecar = await this.#readOpfs(resource.bindingsFileName);
      if (!sidecar.byteLength) throw new Error(`PDF recovery resource bindings are unavailable: ${hash}`);
      bindings = decodeBindingsSidecar(sidecar);
    }
    return { ...resource, bytes, bindings };
  }

  async save(documentKey, state) {
    const previous = await this.#get(documentKey);
    const previousRing = normalizeCheckpointRing(previous);
    const previousResources = new Map((previous?.resources || []).map(resource => [resource.hash, resource]));
    const resources = [];
    const createdResourceFiles = [];
    const createdResourceKeys = [];
    const seenResourceHashes = new Set();
    for (const resource of state.resources || []) {
      if (typeof resource?.hash !== 'string' || !resource.hash || seenResourceHashes.has(resource.hash)) continue;
      seenResourceHashes.add(resource.hash);
      const prior = previousResources.get(resource.hash);
      const incomingBytes = asBytes(resource.bytes);
      if (prior && (prior.fileName || prior.indexedDbKey)) {
        resources.push(resourceMetadata({
          ...prior,
          ...resource,
          // Keep the already-written sidecar instead of re-cloning the bindings.
          ...(prior.bindingsFileName
            ? { bindings: [], bindingsFileName: prior.bindingsFileName, bindingsCount: prior.bindingsCount }
            : { bindingsFileName: null, bindingsCount: undefined }),
        }, {
          bytes: null,
          fileName: prior.fileName,
          indexedDbKey: prior.indexedDbKey,
          byteLength: Number(prior.byteLength || asBytes(prior.bytes).byteLength),
        }));
        continue;
      }
      const resourceBody = incomingBytes.byteLength ? incomingBytes : asBytes(prior?.bytes);
      if (!resourceBody.byteLength) {
        throw new Error(`PDF recovery resource bytes are unavailable: ${resource.hash}`);
      }
      const fileName = await this.#writeOpfsResource(documentKey, resource.hash, resourceBody);
      if (fileName) createdResourceFiles.push(fileName);
      let indexedDbKey = null;
      if (!fileName) {
        const stored = await this.#writeIndexedDbResource(
          documentKey,
          resource.hash,
          resourceBody,
        );
        indexedDbKey = stored.key;
        if (stored.created) createdResourceKeys.push(stored.key);
      }
      // A sidecar name from another machine's journal (portable import) is
      // meaningless here; only a file written by this store counts.
      let bindingsStorage = { bindingsFileName: null, bindingsCount: undefined };
      const bindingCount = resourceBindingCount(resource);
      if (bindingCount >= RESOURCE_BINDINGS_SIDECAR_MIN_ENTRIES) {
        const bindingsFileName = await this.#writeOpfsResource(
          documentKey,
          `${resource.hash}-bindings`,
          resource.bindingsSidecar instanceof Uint8Array && !resource.bindings?.length
            ? resource.bindingsSidecar
            : encodeBindingsSidecar(resource.bindings),
        );
        if (bindingsFileName) {
          createdResourceFiles.push(bindingsFileName);
          bindingsStorage = { bindings: [], bindingsFileName, bindingsCount: bindingCount };
        }
      }
      // Without a sidecar file the records stay inline in the manifest.
      if (!bindingsStorage.bindingsFileName && resource.bindingsSidecar instanceof Uint8Array) {
        bindingsStorage = { ...bindingsStorage, bindings: resourceBindingRecords(resource) };
      }
      resources.push(resourceMetadata({ ...resource, ...bindingsStorage }, {
        bytes: null,
        fileName,
        indexedDbKey,
        byteLength: resourceBody.byteLength,
      }));
    }
    const inlineResourceBytes = resources.reduce(
      (total, resource) => total + asBytes(resource.bytes).byteLength,
      0,
    );
    const totalResourceBytes = resourceBytes(resources);
    if (
      inlineResourceBytes > this.#resourceByteLimit ||
      totalResourceBytes > this.#opfsResourceByteLimit
    ) {
      for (const fileName of createdResourceFiles) await this.#removeOpfs(fileName);
      for (const key of createdResourceKeys) await this.#deleteResource(key);
      throw quotaError('PDF recovery resources exceed the configured byte budget.');
    }
    let ring = previousRing;
    let createdCheckpointFile = null;
    const revision = state.checkpointRevision;
    const bytes = asBytes(state.checkpointBytes);
    if (validCheckpointRevision(revision) && bytes.byteLength && !ring.some(entry => entry.revision === revision)) {
      if (bytes.byteLength > this.#checkpointByteLimit) {
        throw quotaError('A PDF checkpoint exceeds the configured checkpoint byte budget.');
      }
      const fileName = await this.#writeOpfs(documentKey, revision, bytes);
      createdCheckpointFile = fileName;
      ring = boundedCheckpointRing([
        ...ring,
        {
          revision,
          bindings: state.checkpointBindings || [],
          bytes: fileName ? null : bytes.slice(),
          fileName,
          byteLength: bytes.byteLength,
          createdAt: Date.now(),
        },
      ], {
        byteLimit: this.#checkpointByteLimit,
        countLimit: this.#checkpointCount,
      });
    }
    const active = ring.at(-1) || null;
    const record = {
      documentKey,
      version: 2,
      updatedAt: Date.now(),
      checkpointRevision: active?.revision || 0,
      checkpointBytes: active && !active.fileName ? active.bytes : null,
      checkpointFile: active?.fileName || null,
      checkpointByteLength: active?.byteLength || 0,
      checkpointBindings: active?.bindings || [],
      checkpointRing: ring,
      resources,
      entries: state.entries || [],
    };
    try {
      await this.#request('readwrite', store => store.put(record));
    } catch (error) {
      // OPFS is written first so a committed manifest never points at a
      // partial checkpoint. If the later IDB transaction aborts, remove the
      // unreferenced file instead of leaving recovery storage stranded.
      if (createdCheckpointFile) await this.#removeOpfs(createdCheckpointFile);
      for (const fileName of createdResourceFiles) await this.#removeOpfs(fileName);
      for (const key of createdResourceKeys) await this.#deleteResource(key);
      throw error;
    }
    const retained = new Set(ring.map(entry => entry.fileName).filter(Boolean));
    for (const entry of previousRing) {
      if (entry.fileName && !retained.has(entry.fileName)) void this.#removeOpfs(entry.fileName);
    }
    const retainedResources = new Set(resources
      .flatMap(resource => [resource.fileName, resource.bindingsFileName])
      .filter(Boolean));
    const retainedResourceKeys = new Set(resources.map(resource => resource.indexedDbKey).filter(Boolean));
    for (const resource of previousResources.values()) {
      if (resource.fileName && !retainedResources.has(resource.fileName)) {
        void this.#removeOpfs(resource.fileName);
      }
      if (resource.bindingsFileName && !retainedResources.has(resource.bindingsFileName)) {
        void this.#removeOpfs(resource.bindingsFileName);
      }
      if (resource.indexedDbKey && !retainedResourceKeys.has(resource.indexedDbKey)) {
        void this.#deleteResource(resource.indexedDbKey);
      }
    }
    return record;
  }

  async clear(documentKey) {
    const result = await this.deleteDocument(documentKey);
    const blockingError = result.errors.find(error => (
      error.scope === 'document-key' || error.scope === 'indexeddb'
    ));
    if (blockingError) throw new Error(blockingError.message);
    return result;
  }

  /**
   * Best-effort deletion for a document that has been explicitly closed. The
   * checkpoint prefix sweep also removes OPFS files stranded before a manifest
   * write. Cleanup failures are returned instead of rejecting the UI action.
   */
  async deleteDocument(documentKey) {
    const result = {
      documentKey,
      removed: false,
      checkpointFilesRemoved: [],
      resourceFilesRemoved: [],
      resourceRecordsRemoved: [],
      errors: [],
    };
    if (typeof documentKey !== 'string' || !documentKey) {
      result.errors.push({ scope: 'document-key', message: 'A non-empty document key is required.' });
      return result;
    }
    let previous;
    try {
      previous = await this.#get(documentKey);
      await this.#deleteRow(documentKey);
      result.removed = Boolean(previous);
    } catch (error) {
      result.errors.push({ scope: 'indexeddb', message: String(error?.message || error) });
      return result;
    }
    try {
      const records = await this.#allResources();
      for (const resource of records.filter(candidate => candidate?.documentKey === documentKey)) {
        await this.#deleteResource(resource.key);
        result.resourceRecordsRemoved.push(resource.key);
      }
    } catch (error) {
      result.errors.push({ scope: 'indexeddb-resource', message: String(error?.message || error) });
    }
    const manifestFiles = new Set(normalizeCheckpointRing(previous)
      .map(entry => entry.fileName)
      .filter(Boolean));
    const prefix = `${checkpointKey(documentKey)}-`;
    const listing = await this.#listOpfsFiles();
    if (listing.error) {
      result.errors.push({ scope: 'opfs-list', message: listing.error });
    }
    for (const fileName of new Set([
      ...manifestFiles,
      ...listing.files.filter(name => name.startsWith(prefix)),
    ])) {
      const removal = await this.#removeOpfs(fileName);
      if (removal.error) {
        result.errors.push({ scope: 'opfs-remove', fileName, message: removal.error });
      } else if (removal.removed) {
        (fileName.includes('-resource-')
          ? result.resourceFilesRemoved
          : result.checkpointFilesRemoved).push(fileName);
      }
    }
    return result;
  }

  /**
   * Remove journal rows and checkpoint files for documents absent from the
   * caller's active workspace. Passing the retained keys is mandatory so an
   * active writer's current and concurrently-created OPFS files stay protected.
   */
  async cleanupOrphans(retainedDocumentKeys) {
    const result = {
      retained: [],
      removed: [],
      checkpointFilesRemoved: [],
      resourceFilesRemoved: [],
      resourceRecordsRemoved: [],
      errors: [],
    };
    const retained = retainedDocumentKeySet(retainedDocumentKeys);
    if (!retained) {
      result.errors.push({
        scope: 'retained-document-keys',
        message: 'An explicit iterable of non-empty retained document keys is required.',
      });
      return result;
    }
    result.retained = [...retained];
    let records;
    try {
      records = await this.#all();
    } catch (error) {
      result.errors.push({ scope: 'indexeddb-list', message: String(error?.message || error) });
      return result;
    }

    const protectedDocumentKeys = new Set(retained);
    for (const record of records) {
      const documentKey = record?.documentKey;
      if (typeof documentKey !== 'string' || !documentKey || retained.has(documentKey)) continue;
      try {
        await this.#deleteRow(documentKey);
        result.removed.push(documentKey);
        const resources = await this.#allResources();
        for (const resource of resources.filter(candidate => candidate?.documentKey === documentKey)) {
          await this.#deleteResource(resource.key);
          result.resourceRecordsRemoved.push(resource.key);
        }
      } catch (error) {
        protectedDocumentKeys.add(documentKey);
        result.errors.push({
          scope: 'indexeddb-delete',
          documentKey,
          message: String(error?.message || error),
        });
      }
    }

    const protectedPrefixes = [...protectedDocumentKeys].map(key => `${checkpointKey(key)}-`);
    const listing = await this.#listOpfsFiles();
    if (listing.error) {
      result.errors.push({ scope: 'opfs-list', message: listing.error });
      return result;
    }
    for (const fileName of listing.files) {
      if (protectedPrefixes.some(prefix => fileName.startsWith(prefix))) continue;
      const removal = await this.#removeOpfs(fileName);
      if (removal.error) {
        result.errors.push({ scope: 'opfs-remove', fileName, message: removal.error });
      } else if (removal.removed) {
        (fileName.includes('-resource-')
          ? result.resourceFilesRemoved
          : result.checkpointFilesRemoved).push(fileName);
      }
    }
    return result;
  }

  async #get(documentKey) {
    return await this.#request('readonly', store => store.get(documentKey)) || null;
  }

  async #all() {
    return await this.#request('readonly', store => store.getAll()) || [];
  }

  async #deleteRow(documentKey) {
    await this.#request('readwrite', store => store.delete(documentKey));
  }

  async #getResource(key) {
    return await this.#request('readonly', store => store.get(key), RESOURCE_STORE_NAME) || null;
  }

  async #allResources() {
    return await this.#request('readonly', store => store.getAll(), RESOURCE_STORE_NAME) || [];
  }

  async #writeIndexedDbResource(documentKey, hash, bytes) {
    const key = resourceStorageKey(documentKey, hash);
    const existing = await this.#getResource(key);
    if (existing) return { key, created: false };
    await this.#request('readwrite', store => store.put({
      key,
      documentKey,
      hash,
      bytes: bytes.slice(),
    }), RESOURCE_STORE_NAME);
    return { key, created: true };
  }

  async #deleteResource(key) {
    await this.#request('readwrite', store => store.delete(key), RESOURCE_STORE_NAME);
  }

  async #request(mode, createRequest, storeName = STORE_NAME) {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      let settled = false;
      let requestResult;
      let request;
      let transaction;
      const finish = value => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const fail = error => {
        if (settled) return;
        settled = true;
        reject(error || new Error(`The PDF journal ${mode} transaction failed.`));
      };
      try {
        transaction = db.transaction(storeName, mode);
        const supportsCompletion = 'oncomplete' in transaction;
        if (supportsCompletion) {
          transaction.oncomplete = () => finish(requestResult);
          transaction.onerror = () => fail(transaction.error || request?.error);
          transaction.onabort = () => fail(transaction.error || request?.error || new Error(
            `The PDF journal ${mode} transaction was aborted.`,
          ));
        }
        request = createRequest(transaction.objectStore(storeName));
        request.onsuccess = () => {
          requestResult = request.result;
          // Lightweight injected stores used outside a browser may not expose
          // transaction completion events. Real IndexedDB resolves only after
          // oncomplete, which is the durability boundary.
          if (!supportsCompletion) finish(requestResult);
        };
        request.onerror = () => fail(request.error || transaction.error);
      } catch (error) {
        fail(error);
      }
    });
  }

  #open() {
    if (this.#openPromise) return this.#openPromise;
    if (!this.#indexedDb?.open) {
      return Promise.reject(new Error('IndexedDB is unavailable for the PDF command journal.'));
    }
    this.#openPromise = new Promise((resolve, reject) => {
      const request = this.#indexedDb.open(this.#dbName, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: 'documentKey' });
        }
        if (!request.result.objectStoreNames.contains(RESOURCE_STORE_NAME)) {
          request.result.createObjectStore(RESOURCE_STORE_NAME, { keyPath: 'key' });
        }
      };
      request.onblocked = () => reject(new Error(
        'PDF recovery storage upgrade is blocked. Close other Fernwork tabs and reopen this document.',
      ));
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    });
    return this.#openPromise;
  }

  async #opfsRoot() {
    if (this.#opfsRootPromise) return this.#opfsRootPromise;
    this.#opfsRootPromise = (async () => {
      try {
        const storageRoot = await this.#storageManager?.getDirectory?.();
        return await storageRoot?.getDirectoryHandle?.('fernwork-pdf-checkpoints', { create: true }) || null;
      } catch {
        return null;
      }
    })();
    return this.#opfsRootPromise;
  }

  async #writeOpfs(documentKey, revision, bytes) {
    const root = await this.#opfsRoot();
    if (!root) return null;
    const fileName = `${checkpointKey(documentKey)}-${revision}-${Date.now()}.pdf`;
    try {
      const handle = await root.getFileHandle(fileName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return fileName;
    } catch {
      await this.#removeOpfs(fileName);
      return null;
    }
  }

  async #writeOpfsResource(documentKey, hash, bytes) {
    const root = await this.#opfsRoot();
    if (!root) return null;
    const fileName = `${checkpointKey(documentKey)}-resource-${checkpointKey(hash)}-${Date.now()}.bin`;
    try {
      const handle = await root.getFileHandle(fileName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return fileName;
    } catch {
      await this.#removeOpfs(fileName);
      return null;
    }
  }

  async #readOpfs(fileName) {
    try {
      const root = await this.#opfsRoot();
      const handle = await root?.getFileHandle(fileName);
      const file = await handle?.getFile();
      return file ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array();
    } catch {
      return new Uint8Array();
    }
  }

  async #listOpfsFiles() {
    const root = await this.#opfsRoot();
    if (!root?.entries) return { files: [], error: null };
    try {
      const files = [];
      for await (const [name, handle] of root.entries()) {
        if (!handle?.kind || handle.kind === 'file') files.push(name);
      }
      return { files, error: null };
    } catch (error) {
      return { files: [], error: String(error?.message || error) };
    }
  }

  async #removeOpfs(fileName) {
    try {
      const root = await this.#opfsRoot();
      if (!root?.removeEntry) return { removed: false, error: null };
      await root.removeEntry(fileName);
      return { removed: true, error: null };
    } catch (error) {
      if (error?.name === 'NotFoundError') return { removed: false, error: null };
      return { removed: false, error: String(error?.message || error) };
    }
  }
}

export class MemoryCommandJournalStore {
  #records = new Map();
  #checkpointByteLimit;
  #resourceByteLimit;
  #checkpointCount;

  constructor({
    checkpointByteLimit = DEFAULT_CHECKPOINT_RING_BYTES,
    resourceByteLimit = DEFAULT_RESOURCE_BYTES,
    checkpointCount = DEFAULT_CHECKPOINT_COUNT,
  } = {}) {
    this.#checkpointByteLimit = checkpointByteLimit;
    this.#resourceByteLimit = resourceByteLimit;
    this.#checkpointCount = checkpointCount;
  }

  async load(documentKey) {
    const record = this.#records.get(documentKey);
    return record ? structuredClone(record) : null;
  }

  async loadResource(documentKey, hash) {
    const resource = this.#records.get(documentKey)?.resources
      ?.find(candidate => candidate?.hash === hash);
    return resource ? structuredClone(resource) : null;
  }

  async save(documentKey, state) {
    const previous = this.#records.get(documentKey);
    const previousResources = new Map((previous?.resources || []).map(resource => [resource.hash, resource]));
    const resources = [];
    const seenResourceHashes = new Set();
    for (const resource of state.resources || []) {
      if (typeof resource?.hash !== 'string' || !resource.hash || seenResourceHashes.has(resource.hash)) continue;
      seenResourceHashes.add(resource.hash);
      const bytes = asBytes(resource.bytes);
      const prior = previousResources.get(resource.hash);
      const retainedBytes = bytes.byteLength ? bytes : asBytes(prior?.bytes);
      if (!retainedBytes.byteLength) {
        throw new Error(`PDF recovery resource bytes are unavailable: ${resource.hash}`);
      }
      resources.push(resourceMetadata({
        ...prior,
        ...resource,
        ...(resource.bindingsSidecar instanceof Uint8Array ? { bindings: resourceBindingRecords(resource) } : {}),
      }, {
        bytes: retainedBytes.slice(),
        byteLength: retainedBytes.byteLength,
      }));
    }
    if (resourceBytes(resources) > this.#resourceByteLimit) {
      throw quotaError('PDF recovery resources exceed the configured byte budget.');
    }
    let ring = normalizeCheckpointRing(previous);
    const bytes = asBytes(state.checkpointBytes);
    const revision = state.checkpointRevision;
    if (validCheckpointRevision(revision) && bytes.byteLength && !ring.some(entry => entry.revision === revision)) {
      if (bytes.byteLength > this.#checkpointByteLimit) {
        throw quotaError('A PDF checkpoint exceeds the configured checkpoint byte budget.');
      }
      ring = boundedCheckpointRing([
        ...ring,
        {
          revision,
          bindings: state.checkpointBindings || [],
          bytes: bytes.slice(),
          fileName: null,
          byteLength: bytes.byteLength,
          createdAt: Date.now(),
        },
      ], {
        byteLimit: this.#checkpointByteLimit,
        countLimit: this.#checkpointCount,
      });
    }
    const active = ring.at(-1) || null;
    const record = structuredClone({
      documentKey,
      version: 2,
      updatedAt: Date.now(),
      checkpointRevision: active?.revision || 0,
      checkpointBytes: active?.bytes || null,
      checkpointBindings: active?.bindings || [],
      checkpointRing: ring,
      checkpointRingBytes: ring.reduce((total, item) => total + Number(item.byteLength || 0), 0),
      resources,
      entries: state.entries || [],
    });
    this.#records.set(documentKey, record);
    return structuredClone(record);
  }

  async clear(documentKey) {
    this.#records.delete(documentKey);
  }

  async deleteDocument(documentKey) {
    if (typeof documentKey !== 'string' || !documentKey) {
      return {
        documentKey,
        removed: false,
        checkpointFilesRemoved: [],
        errors: [{ scope: 'document-key', message: 'A non-empty document key is required.' }],
      };
    }
    const removed = this.#records.delete(documentKey);
    return { documentKey, removed, checkpointFilesRemoved: [], errors: [] };
  }

  async cleanupOrphans(retainedDocumentKeys) {
    const result = { retained: [], removed: [], checkpointFilesRemoved: [], errors: [] };
    const retained = retainedDocumentKeySet(retainedDocumentKeys);
    if (!retained) {
      result.errors.push({
        scope: 'retained-document-keys',
        message: 'An explicit iterable of non-empty retained document keys is required.',
      });
      return result;
    }
    result.retained = [...retained];
    for (const documentKey of this.#records.keys()) {
      if (!retained.has(documentKey)) {
        this.#records.delete(documentKey);
        result.removed.push(documentKey);
      }
    }
    return result;
  }
}
