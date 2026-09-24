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

  async read(key: string): Promise<Uint8Array | null> {
    const handle = await this.handle(key, false);
    if (!handle) return null;
    const sync = await this.sync(key, handle);
    if (sync) {
      const bytes = new Uint8Array(sync.getSize());
      sync.read(bytes, { at: 0 });
      return bytes;
    }
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  }

  async write(key: string, bytes: Uint8Array, options: { append?: boolean } = {}): Promise<void> {
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
  }

  async remove(key: string): Promise<void> {
    requireScratchKey(key);
    this.syncHandles.get(key)?.close();
    this.syncHandles.delete(key);
    try { await this.directory.removeEntry(fileName(key)); }
    catch (error) { if ((error as DOMException).name !== 'NotFoundError') throw error; }
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
    for (const handle of this.syncHandles.values()) handle.close();
    this.syncHandles.clear();
  }
}

/** Lazily opens OPFS so the synchronous HostAdapter factory needs no startup I/O. */
export class BrowserScratchHost implements ScratchHost {
  readonly kind = 'opfs' as const;
  private readonly host = OpfsScratchHost.create();
  async read(key: string): Promise<Uint8Array | null> { return (await this.host).read(key); }
  async write(key: string, bytes: Uint8Array, options?: { append?: boolean }): Promise<void> {
    return (await this.host).write(key, bytes, options);
  }
  async remove(key: string): Promise<void> { return (await this.host).remove(key); }
  async list(prefix?: string): Promise<readonly string[]> { return (await this.host).list(prefix); }
  async flush(): Promise<void> { return (await this.host).flush(); }
  async close(): Promise<void> { return (await this.host).close(); }
}
