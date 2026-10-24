import { requireScratchKey, type ScratchHost } from './scratchHost';

function fileName(key: string): string { return encodeURIComponent(key); }
function keyFromFile(name: string): string | null {
  try { const key = decodeURIComponent(name); return key.length ? key : null; } catch { return null; }
}

/**
 * Browser scratch storage. In a dedicated worker Chromium exposes sync access handles; other
 * engines use the FileSystemWritableFileStream fallback. The public capability stays async so the
 * engine never depends on a Chromium-only API.
 */
export class OpfsScratchHost implements ScratchHost {
  readonly kind = 'opfs' as const;
  private readonly syncHandles = new Map<string, FileSystemSyncAccessHandle>();
  private readonly mutations = new Map<string, Promise<void>>();

  private constructor(private readonly directory: FileSystemDirectoryHandle) {}

  static available(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
  }

  static async create(): Promise<OpfsScratchHost> {
    if (!this.available()) throw new Error('Origin-private file storage is unavailable.');
    return new OpfsScratchHost(await navigator.storage.getDirectory());
  }

  private async handle(key: string, create: boolean): Promise<FileSystemFileHandle | null> {
    requireScratchKey(key);
    try { return await this.directory.getFileHandle(fileName(key), { create }); }
    catch (error) {
      if ((error as DOMException).name === 'NotFoundError') return null;
      throw error;
    }
  }

  private async sync(key: string, handle: FileSystemFileHandle): Promise<FileSystemSyncAccessHandle | null> {
    const known = this.syncHandles.get(key);
    if (known) return known;
    if (typeof handle.createSyncAccessHandle !== 'function') return null;
    const opened = await handle.createSyncAccessHandle();
    this.syncHandles.set(key, opened);
    return opened;
  }

  /** OPFS rejects removeEntry while createWritable still owns the same file. Keep same-key changes ordered. */
  private sequence<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(action);
    const current = result.then(() => {}, () => {});
    this.mutations.set(key, current);
    void current.then(() => { if (this.mutations.get(key) === current) this.mutations.delete(key); });
    return result;
  }

  read(key: string): Promise<Uint8Array | null> {
    return this.sequence(key, async () => {
      const handle = await this.handle(key, false);
      if (!handle) return null;
      const sync = await this.sync(key, handle);
      if (sync) {
        const bytes = new Uint8Array(sync.getSize());
        sync.read(bytes, { at: 0 });
        return bytes;
      }
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    });
  }

  write(key: string, bytes: Uint8Array, options: { append?: boolean } = {}): Promise<void> {
    return this.sequence(key, async () => {
      const handle = (await this.handle(key, true))!;
      const sync = await this.sync(key, handle);
      if (sync) {
        const at = options.append ? sync.getSize() : 0;
        if (!options.append) sync.truncate(bytes.byteLength);
        sync.write(bytes, { at });
        return;
      }
      const stream = await handle.createWritable({ keepExistingData: !!options.append });
      if (options.append) await stream.seek((await handle.getFile()).size);
      await stream.write(bytes as FileSystemWriteChunkType);
      await stream.close();
    });
  }

  remove(key: string): Promise<void> {
    requireScratchKey(key);
    return this.sequence(key, async () => {
      this.syncHandles.get(key)?.close();
      this.syncHandles.delete(key);
      try { await this.directory.removeEntry(fileName(key)); }
      catch (error) { if ((error as DOMException).name !== 'NotFoundError') throw error; }
    });
  }

  async list(prefix = ''): Promise<readonly string[]> {
    const names: string[] = [];
    const directory = this.directory as FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> };
    for await (const entry of directory.values()) {
      if (entry.kind !== 'file') continue;
      const key = keyFromFile(entry.name);
      if (key?.startsWith(prefix)) names.push(key);
    }
    return names.sort();
  }

  async flush(): Promise<void> { for (const handle of this.syncHandles.values()) handle.flush(); }
  async close(): Promise<void> {
    await Promise.allSettled(this.mutations.values());
    for (const handle of this.syncHandles.values()) handle.close();
    this.syncHandles.clear();
  }
}

/** Persistent fallback for engines without OPFS (notably older Firefox/WebKit builds). */
export class IndexedDbScratchHost implements ScratchHost {
  readonly kind = 'indexeddb' as const;
  private constructor(private readonly db: IDBDatabase) {}

  static create(): Promise<IndexedDbScratchHost> {
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('Persistent browser scratch storage is unavailable.'));
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('fernwork-scratch', 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('files')) request.result.createObjectStore('files'); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(new IndexedDbScratchHost(request.result));
    });
  }

  private request<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction('files', mode);
      const request = action(transaction.objectStore('files'));
      let result: T;
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Scratch transaction was aborted'));
    });
  }

  async read(key: string): Promise<Uint8Array | null> {
    requireScratchKey(key);
    const value = await this.request<ArrayBuffer | Uint8Array | undefined>('readonly', (store) => store.get(key));
    if (!value) return null;
    return value instanceof Uint8Array ? value.slice() : new Uint8Array(value.slice(0));
  }
  async write(key: string, bytes: Uint8Array, options: { append?: boolean } = {}): Promise<void> {
    requireScratchKey(key);
    let value = bytes.slice();
    if (options.append) {
      const previous = await this.read(key);
      if (previous) { value = new Uint8Array(previous.byteLength + bytes.byteLength); value.set(previous); value.set(bytes, previous.byteLength); }
    }
    await this.request('readwrite', (store) => store.put(value, key));
  }
  async remove(key: string): Promise<void> { requireScratchKey(key); await this.request('readwrite', (store) => store.delete(key)); }
  async list(prefix = ''): Promise<readonly string[]> {
    const keys = await this.request<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
    return keys.filter((key): key is string => typeof key === 'string' && key.startsWith(prefix)).sort();
  }
  async flush(): Promise<void> { /* IndexedDB resolves writes after commit scheduling. */ }
  async close(): Promise<void> { this.db.close(); }
}

/** Lazily opens OPFS so the synchronous HostAdapter factory needs no startup I/O. */
export class BrowserScratchHost implements ScratchHost {
  readonly kind = 'opfs' as const;
  private readonly host: Promise<ScratchHost> = (OpfsScratchHost.available()
    ? OpfsScratchHost.create().catch(() => IndexedDbScratchHost.create())
    : IndexedDbScratchHost.create());
  async read(key: string): Promise<Uint8Array | null> { return (await this.host).read(key); }
  async write(key: string, bytes: Uint8Array, options?: { append?: boolean }): Promise<void> {
    return (await this.host).write(key, bytes, options);
  }
  async remove(key: string): Promise<void> { return (await this.host).remove(key); }
  async list(prefix?: string): Promise<readonly string[]> { return (await this.host).list(prefix); }
  async flush(): Promise<void> { return (await this.host).flush(); }
  async close(): Promise<void> { return (await this.host).close(); }
}
