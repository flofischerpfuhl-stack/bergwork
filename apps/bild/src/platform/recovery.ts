/** Crash recovery backed by append-only ScratchHost journals (PRODUCT-PLAN A4/P7). */
import { CrashJournal } from './journal';
import { BrowserScratchHost, OpfsScratchHost } from './opfsScratchHost';
import type { ScratchHost } from './scratchHost';
import type { CanvasDocument, Layer } from '../core/document';
import type { PersistedHistoryState } from '../core/history';
import { Raster } from '../core/raster';
import { loadRasterTiles, type RasterResidency, type StoredRasterTiles } from '../core/storage';
import { sha256Hex } from '../io/sha256';

export interface RecoveryRecord {
  id: string;
  name: string;
  savedAt: number;
  size: number;
  archive: Blob;
  /** The page load that wrote it; records from the current load are not offered back. */
  instance: string;
  command?: string;
  kind?: 'archive' | 'state';
}

export interface RecoveredProjectState {
  readonly document: CanvasDocument;
  readonly activeLayerId: string | null;
  readonly history: PersistedHistoryState;
  readonly name: string;
}

interface EncodedSnapshot { readonly document: string | null; readonly activeLayerId: string | null; readonly revision: number }
interface EncodedHistoryCommand { readonly name: string; readonly before: EncodedSnapshot; readonly after: EncodedSnapshot }
interface EncodedRecoveryState {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly activeLayerId: string | null;
  readonly current: string;
  readonly documents: Readonly<Record<string, unknown>>;
  readonly rasters: readonly { readonly stored: StoredRasterTiles; readonly reduced: StoredRasterTiles }[];
  readonly history: Omit<PersistedHistoryState, 'past' | 'future'> & {
    readonly past: readonly EncodedHistoryCommand[]; readonly future: readonly EncodedHistoryCommand[];
  };
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

function rastersOf(document: CanvasDocument | null): Raster[] {
  if (!document) return [];
  const result: Raster[] = [];
  for (const layer of document.layers) {
    if (layer.raster) result.push(layer.raster);
    if (layer.mask) result.push(layer.mask.raster);
  }
  if (document.selection) result.push(document.selection.mask);
  return result;
}

async function encodeRecoveryState(name: string, document: CanvasDocument, activeLayerId: string | null,
  history: PersistedHistoryState, residency: RasterResidency, host: ScratchHost): Promise<Uint8Array> {
  const documents = new Map<CanvasDocument, string>();
  const allDocuments = [document, ...history.past.flatMap((entry) => [entry.before.document, entry.after.document]),
    ...history.future.flatMap((entry) => [entry.before.document, entry.after.document])].filter((value): value is CanvasDocument => !!value);
  for (const value of allDocuments) if (!documents.has(value)) documents.set(value, `d${documents.size}`);

  const rasters = new Map<string, Raster>();
  for (const value of documents.keys()) for (const raster of rastersOf(value)) rasters.set(raster.id, raster);
  const encodedRasters: { stored: StoredRasterTiles; reduced: StoredRasterTiles }[] = [];
  for (const raster of rasters.values()) {
    const stored = await residency.manage(raster, 'history');
    const reducedRaster = raster.reducedCopy ?? raster.makeReducedCopy();
    const reduced = await residency.manage(reducedRaster, 'visible');
    await residency.persist([raster, reducedRaster]);
    encodedRasters.push({ stored, reduced });
  }

  const encodedDocuments: Record<string, unknown> = {};
  for (const [value, id] of documents) {
    const resources = [];
    for (const resource of value.resources ?? []) {
      const key = `assets/${sha256Hex(resource.bytes)}.bin`;
      if (!await host.read(key)) await host.write(key, resource.bytes);
      resources.push({ ...resource, bytes: undefined, storageKey: key, byteLength: resource.bytes.byteLength });
    }
    encodedDocuments[id] = {
      ...value,
      layers: value.layers.map((layer) => ({ ...layer, raster: layer.raster?.id ?? null,
        mask: layer.mask ? { ...layer.mask, raster: layer.mask.raster.id } : null })),
      selection: value.selection ? { ...value.selection, mask: value.selection.mask.id } : null,
      resources,
    };
  }

  const snapshot = (value: { document: CanvasDocument | null; activeLayerId: string | null; revision: number }): EncodedSnapshot => ({
    document: value.document ? documents.get(value.document)! : null,
    activeLayerId: value.activeLayerId,
    revision: value.revision,
  });
  const command = (value: PersistedHistoryState['past'][number]): EncodedHistoryCommand => ({
    name: value.name, before: snapshot(value.before), after: snapshot(value.after),
  });
  const state: EncodedRecoveryState = {
    schemaVersion: 1, name, activeLayerId, current: documents.get(document)!, documents: encodedDocuments, rasters: encodedRasters,
    history: { schemaVersion: 1, enabled: history.enabled, retainedByteLimit: history.retainedByteLimit,
      past: history.past.map(command), future: history.future.map(command) },
  };
  return new TextEncoder().encode(JSON.stringify(state));
}

async function decodeRecoveryState(bytes: Uint8Array, residency: RasterResidency, host: ScratchHost): Promise<RecoveredProjectState> {
  let parsed: EncodedRecoveryState;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)) as EncodedRecoveryState; }
  catch { throw new Error('Recovery journal structure is not valid JSON'); }
  if (parsed.schemaVersion !== 1 || typeof parsed.name !== 'string' || !parsed.documents || !Array.isArray(parsed.rasters)) {
    throw new Error('Recovery journal structure has an unsupported schema');
  }
  const rasters = new Map<string, Raster>();
  for (const record of parsed.rasters) {
    const reduced = await loadRasterTiles(record.reduced, residency.cache);
    const raster = residency.restore(record.stored, reduced);
    rasters.set(raster.id, raster);
  }
  const documents = new Map<string, CanvasDocument>();
  for (const [id, raw] of Object.entries(parsed.documents)) {
    const value = raw as Omit<CanvasDocument, 'layers' | 'selection' | 'resources'> & {
      layers: readonly (Omit<Layer, 'raster' | 'mask'> & { raster: string | null; mask: (Omit<NonNullable<Layer['mask']>, 'raster'> & { raster: string }) | null })[];
      selection: (Omit<NonNullable<CanvasDocument['selection']>, 'mask'> & { mask: string }) | null;
      resources?: readonly { id: string; role: 'pattern' | 'embedded'; mime: string; storageKey: string; byteLength: number }[];
    };
    const layers = value.layers.map((layer) => ({ ...layer, raster: layer.raster ? rasters.get(layer.raster) ?? null : null,
      mask: layer.mask ? { ...layer.mask, raster: rasters.get(layer.mask.raster)! } : null })) as Layer[];
    if (layers.some((layer) => layer.mask && !layer.mask.raster)) throw new Error('Recovery journal references a missing mask raster');
    const selection = value.selection ? { ...value.selection, mask: rasters.get(value.selection.mask)! } : null;
    if (value.selection && !selection?.mask) throw new Error('Recovery journal references a missing selection raster');
    const resources = [];
    for (const resource of value.resources ?? []) {
      const resourceBytes = await host.read(resource.storageKey);
      if (!resourceBytes || resourceBytes.byteLength !== resource.byteLength) throw new Error('Recovery journal resource is missing');
      resources.push({ id: resource.id, role: resource.role, mime: resource.mime, bytes: resourceBytes });
    }
    documents.set(id, { ...value, layers, selection, resources });
  }
  const snapshot = (value: EncodedSnapshot) => ({ document: value.document ? documents.get(value.document) ?? null : null,
    activeLayerId: value.activeLayerId, revision: value.revision });
  const command = (value: EncodedHistoryCommand) => ({ name: value.name, before: snapshot(value.before), after: snapshot(value.after) });
  const current = documents.get(parsed.current);
  if (!current) throw new Error('Recovery journal current document is missing');
  return { document: current, activeLayerId: parsed.activeLayerId, name: parsed.name,
    history: { schemaVersion: 1, enabled: parsed.history.enabled, retainedByteLimit: parsed.history.retainedByteLimit,
      past: parsed.history.past.map(command), future: parsed.history.future.map(command) } };
}

export class RecoveryStore {
  private ownedHost: ScratchHost | null = null;
  private hostPromise: Promise<ScratchHost> | null;
  readonly instance = randomInstance();

  constructor(host?: ScratchHost) { this.hostPromise = host ? Promise.resolve(host) : null; }

  private async host(): Promise<ScratchHost> {
    if (!this.hostPromise) this.hostPromise = Promise.resolve(new BrowserScratchHost()).then((host) => (this.ownedHost = host));
    return this.hostPromise;
  }

  static available(host?: ScratchHost): boolean {
    return !!host || OpfsScratchHost.available() || typeof indexedDB !== 'undefined';
  }

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
  async putState(record: { id: string; name: string; savedAt: number; document: CanvasDocument;
    activeLayerId: string | null; history: PersistedHistoryState; command?: string }, residency: RasterResidency): Promise<void> {
    const host = await this.host();
    const bytes = await encodeRecoveryState(record.name, record.document, record.activeLayerId, record.history, residency, host);
    await new CrashJournal(host, `${PREFIX}${record.id}${SUFFIX}`).appendState(bytes, {
      name: record.name, time: record.savedAt, instance: this.instance, command: record.command,
    });
    await this.legacyIndex((store) => store.put({ id: record.id, name: record.name, savedAt: record.savedAt,
      size: bytes.byteLength, instance: this.instance }));
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
        archive: new Blob([latest.bytes as BlobPart], { type: latest.commit.format === 'state' ? 'application/x-fernwork-recovery+json' : 'application/zip' }),
        instance: latest.commit.instance, kind: latest.commit.format ?? 'archive',
        ...(latest.commit.command ? { command: latest.commit.command } : {}) });
    }
    return result.sort((a, b) => a.savedAt - b.savedAt);
  }
  async recover(record: RecoveryRecord, residency: RasterResidency): Promise<RecoveredProjectState> {
    if (record.kind !== 'state') throw new Error('Legacy recovery records must be opened as project archives');
    return decodeRecoveryState(new Uint8Array(await record.archive.arrayBuffer()), residency, await this.host());
  }
  close(): void { if (this.ownedHost) void this.ownedHost.close(); }
}

export function isQuotaError(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}
