/** Crash recovery backed by append-only ScratchHost journals (PRODUCT-PLAN A4/P7). */
import { CrashJournal } from './journal';
import { OpfsScratchHost } from './opfsScratchHost';
import type { ScratchHost } from './scratchHost';

export interface RecoveryRecord {
  id: string;
  name: string;
  savedAt: number;
  size: number;
  archive: Blob;
  /** The page load that wrote it; records from the current load are not offered back. */
  instance: string;
  command?: string;
}

const PREFIX = 'recovery/';
const SUFFIX = '.fwj';
const LEGACY_DB = 'fernwork-compositor';
const LEGACY_STORE = 'recovery';

function randomInstance(): string {
  const values = new Uint32Array(2);
  if (typeof crypto !== 'undefined') crypto.getRandomValues(values);
  else { values[0] = Math.random() * 0xffff_ffff; values[1] = Date.now(); }
  return values.join('-');
}

export class RecoveryStore {
  private ownedHost: ScratchHost | null = null;
  private hostPromise: Promise<ScratchHost> | null;
  readonly instance = randomInstance();

  constructor(host?: ScratchHost) { this.hostPromise = host ? Promise.resolve(host) : null; }

  private async host(): Promise<ScratchHost> {
    if (!this.hostPromise) this.hostPromise = OpfsScratchHost.create().then((host) => (this.ownedHost = host));
    return this.hostPromise;
  }

  static available(host?: ScratchHost): boolean { return !!host || OpfsScratchHost.available(); }

  /** Metadata-only compatibility index; recovery archive bytes live exclusively in ScratchHost. */
  private legacyIndex(action: (store: IDBObjectStore) => IDBRequest): Promise<void> {
    if (typeof indexedDB === 'undefined') return Promise.resolve();
    return new Promise((resolve, reject) => {
      // Version 2 reserves this store as metadata-only. Opening at v2 also repairs a v1 database
      // that another tab created before the recovery controller initialized.
      const request = indexedDB.open(LEGACY_DB, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(LEGACY_STORE)) request.result.createObjectStore(LEGACY_STORE, { keyPath: 'id' });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        let operation: IDBRequest;
        try { operation = action(db.transaction(LEGACY_STORE, 'readwrite').objectStore(LEGACY_STORE)); }
        catch (error) { db.close(); reject(error); return; }
        operation.onerror = () => { db.close(); reject(operation.error); };
        operation.onsuccess = () => { db.close(); resolve(); };
      };
    });
  }

  async put(record: Omit<RecoveryRecord, 'instance'>): Promise<void> {
    const bytes = new Uint8Array(await record.archive.arrayBuffer());
    await new CrashJournal(await this.host(), `${PREFIX}${record.id}${SUFFIX}`).append(bytes, {
      name: record.name, time: record.savedAt, instance: this.instance, command: record.command,
    });
    await this.legacyIndex((store) => store.put({ id: record.id, name: record.name, savedAt: record.savedAt,
      size: record.size, instance: this.instance }));
  }
  async remove(id: string): Promise<void> {
    await (await this.host()).remove(`${PREFIX}${id}${SUFFIX}`);
    await this.legacyIndex((store) => store.delete(id));
  }

  /** Latest committed state from each journal left by an earlier page/app instance. */
  async previous(): Promise<RecoveryRecord[]> {
    const host = await this.host();
    const result: RecoveryRecord[] = [];
    for (const key of await host.list(PREFIX)) {
      if (!key.endsWith(SUFFIX)) continue;
      const latest = await new CrashJournal(host, key).latest(this.instance);
      if (!latest) continue;
      result.push({ id: key.slice(PREFIX.length, -SUFFIX.length), name: latest.commit.name,
        savedAt: latest.commit.time, size: latest.commit.size,
        archive: new Blob([latest.bytes as BlobPart], { type: 'application/zip' }), instance: latest.commit.instance,
        ...(latest.commit.command ? { command: latest.commit.command } : {}) });
    }
    return result.sort((a, b) => a.savedAt - b.savedAt);
  }
  close(): void { if (this.ownedHost) void this.ownedHost.close(); }
}

export function isQuotaError(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}
