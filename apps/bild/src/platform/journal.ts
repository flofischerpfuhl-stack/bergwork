import { sha256Hex } from '../io/sha256';
import type { ScratchHost } from './scratchHost';

const MAGIC = 0x314a5746; // "FWJ1", little endian
const HEADER = 24;
const ASSET = 1;
const COMMIT = 2;

interface JournalRecord { type: number; key: string; time: number; bytes: Uint8Array }

export interface JournalCommit {
  readonly name: string;
  readonly time: number;
  readonly instance: string;
  readonly asset: string;
  readonly size: number;
  readonly command?: string;
}

function record(type: number, key: string, time: number, bytes: Uint8Array): Uint8Array {
  const keyBytes = new TextEncoder().encode(key);
  if (keyBytes.byteLength > 0xffff) throw new RangeError('Journal key is too long');
  const out = new Uint8Array(HEADER + keyBytes.byteLength + bytes.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint8(4, type);
  view.setUint16(6, keyBytes.byteLength, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setFloat64(12, time, true);
  view.setUint32(20, checksum(bytes), true);
  out.set(keyBytes, HEADER);
  out.set(bytes, HEADER + keyBytes.byteLength);
  return out;
}

function checksum(bytes: Uint8Array): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index++) {
    value ^= bytes[index]!;
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

function parse(bytes: Uint8Array): JournalRecord[] {
  const records: JournalRecord[] = [];
  let offset = 0;
  while (offset + HEADER <= bytes.byteLength) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, HEADER);
    if (view.getUint32(0, true) !== MAGIC) break;
    const type = view.getUint8(4), keyLength = view.getUint16(6, true), length = view.getUint32(8, true);
    const end = offset + HEADER + keyLength + length;
    if (end > bytes.byteLength) break;
    const keyBytes = bytes.subarray(offset + HEADER, offset + HEADER + keyLength);
    const payload = bytes.slice(offset + HEADER + keyLength, end);
    if (checksum(payload) !== view.getUint32(20, true)) break;
    records.push({ type, key: new TextDecoder().decode(keyBytes), time: view.getFloat64(12, true), bytes: payload });
    offset = end;
  }
  return records;
}

/** Append-only, content-addressed recovery journal. Unknown or torn trailing records are ignored. */
export class CrashJournal {
  private knownAssets: Set<string> | null = null;

  constructor(readonly host: ScratchHost, readonly key: string) {}

  private async records(): Promise<JournalRecord[]> { return parse(await this.host.read(this.key) ?? new Uint8Array()); }

  private async assets(): Promise<Set<string>> {
    if (!this.knownAssets) this.knownAssets = new Set((await this.records()).filter((item) => item.type === ASSET).map((item) => item.key));
    return this.knownAssets;
  }

  /** Appends only a new content asset plus its commit marker, then fsyncs the commit. */
  async append(bytes: Uint8Array, metadata: Omit<JournalCommit, 'asset' | 'size'>): Promise<JournalCommit> {
    const asset = sha256Hex(bytes);
    const assets = await this.assets();
    if (!assets.has(asset)) {
      await this.host.write(this.key, record(ASSET, asset, metadata.time, bytes), { append: true });
      assets.add(asset);
    }
    const commit: JournalCommit = { ...metadata, asset, size: bytes.byteLength };
    const encoded = new TextEncoder().encode(JSON.stringify(commit));
    await this.host.write(this.key, record(COMMIT, asset, metadata.time, encoded), { append: true });
    await this.host.flush();
    return commit;
  }

  async commits(): Promise<readonly JournalCommit[]> {
    const result: JournalCommit[] = [];
    for (const item of await this.records()) {
      if (item.type !== COMMIT) continue;
      try {
        const value = JSON.parse(new TextDecoder().decode(item.bytes)) as JournalCommit;
        if (typeof value.name === 'string' && typeof value.instance === 'string' && typeof value.asset === 'string'
          && Number.isFinite(value.time) && Number.isSafeInteger(value.size) && value.size >= 0) result.push(value);
      } catch { /* a corrupt commit does not hide older valid commits */ }
    }
    return result;
  }

  async latest(excludingInstance?: string): Promise<{ commit: JournalCommit; bytes: Uint8Array } | null> {
    const records = await this.records();
    const assets = new Map(records.filter((item) => item.type === ASSET).map((item) => [item.key, item.bytes]));
    for (let index = records.length - 1; index >= 0; index--) {
      const item = records[index]!;
      if (item.type !== COMMIT) continue;
      try {
        const commit = JSON.parse(new TextDecoder().decode(item.bytes)) as JournalCommit;
        const value = assets.get(commit.asset);
        if (value && value.byteLength === commit.size && commit.instance !== excludingInstance) return { commit, bytes: value.slice() };
      } catch { /* keep looking for the prior valid commit */ }
    }
    return null;
  }
}
