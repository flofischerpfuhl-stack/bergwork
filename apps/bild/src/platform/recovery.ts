/**
 * Crash and reload recovery in IndexedDB (idb). Each open, modified project tab keeps its latest
 * archive; on the next start the editor offers to reopen them. Quota errors pause copies for that
 * project and are reported once instead of failing silently.
 */

import { openDB, type IDBPDatabase } from 'idb';

export interface RecoveryRecord {
  id: string;
  name: string;
  savedAt: number;
  size: number;
  archive: Blob;
  /** The page load that wrote it; records from the current load are not offered back. */
  instance: string;
}

const DB_NAME = 'fernwork-compositor';
const STORE = 'recovery';

export class RecoveryStore {
  private db: Promise<IDBPDatabase> | null = null;
  readonly instance = crypto.getRandomValues(new Uint32Array(2)).join('-');

  private open(): Promise<IDBPDatabase> {
    this.db ??= openDB(DB_NAME, 1, {
      upgrade(db) { if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }); },
    });
    return this.db;
  }

  static available(): boolean { return typeof indexedDB !== 'undefined'; }

  async put(record: Omit<RecoveryRecord, 'instance'>): Promise<void> {
    const db = await this.open();
    await db.put(STORE, { ...record, instance: this.instance });
  }
  async remove(id: string): Promise<void> {
    const db = await this.open();
    await db.delete(STORE, id);
  }
  /** Records left behind by earlier page loads. */
  async previous(): Promise<RecoveryRecord[]> {
    const db = await this.open();
    const all = (await db.getAll(STORE)) as RecoveryRecord[];
    return all.filter((record) => record.instance !== this.instance).sort((a, b) => a.savedAt - b.savedAt);
  }
  close(): void { void this.db?.then((db) => db.close()); this.db = null; }
}

export function isQuotaError(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}
