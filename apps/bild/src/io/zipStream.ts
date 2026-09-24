import { Inflate, ZipPassThrough } from 'fflate';

interface Entry {
  readonly name: Uint8Array;
  readonly crc: number;
  readonly size: bigint;
  readonly offset: bigint;
}

function u16(view: DataView, offset: number, value: number): void { view.setUint16(offset, value, true); }
function u32(view: DataView, offset: number, value: number): void { view.setUint32(offset, value >>> 0, true); }
function u64(view: DataView, offset: number, value: bigint): void {
  view.setUint32(offset, Number(value & 0xffff_ffffn), true);
  view.setUint32(offset + 4, Number(value >> 32n), true);
}

function dosDate(): { time: number; date: number } {
  return { time: 0, date: ((2026 - 1980) << 9) | (1 << 5) | 1 };
}

/** ZIP64 store writer. ZipPassThrough supplies streaming CRC/size accounting without buffering entries. */
export class Zip64StreamWriter {
  private readonly chunks: BlobPart[] = [];
  private readonly entries: Entry[] = [];
  private offset = 0n;
  private pending = Promise.resolve();
  private sinkError: unknown = null;

  constructor(private readonly emitChunk?: (chunk: Uint8Array) => void | Promise<void>) {}

  private emit(chunk: Uint8Array): void {
    const copy = chunk.slice();
    if (this.emitChunk) this.pending = this.pending.then(() => this.emitChunk!(copy)).catch((error: unknown) => { this.sinkError = error; });
    else this.chunks.push(copy as BlobPart);
    this.offset += BigInt(copy.byteLength);
  }

  async add(name: string, produce: (stream: ZipPassThrough) => Promise<void> | void): Promise<void> {
    const filename = new TextEncoder().encode(name);
    if (!filename.byteLength || filename.byteLength > 0xffff) throw new RangeError('ZIP entry name is invalid');
    const start = this.offset, { time, date } = dosDate();
    const local = new Uint8Array(30 + filename.byteLength + 20), view = new DataView(local.buffer);
    u32(view, 0, 0x04034b50); u16(view, 4, 45); u16(view, 6, 0x0808); u16(view, 8, 0);
    u16(view, 10, time); u16(view, 12, date); u32(view, 14, 0); u32(view, 18, 0xffff_ffff); u32(view, 22, 0xffff_ffff);
    u16(view, 26, filename.byteLength); u16(view, 28, 20); local.set(filename, 30);
    u16(view, 30 + filename.byteLength, 1); u16(view, 32 + filename.byteLength, 16);
    u64(view, 34 + filename.byteLength, 0n); u64(view, 42 + filename.byteLength, 0n);
    this.emit(local);
    const stream = new ZipPassThrough(name);
    let final = false, streamError: Error | null = null;
    stream.ondata = (error, chunk, done) => {
      if (error) streamError = error;
      else if (chunk.byteLength) this.emit(chunk);
      final = done;
    };
    await produce(stream);
    if (!final) stream.push(new Uint8Array(), true);
    await this.drain();
    if (streamError) throw streamError;
    const size = BigInt(stream.size);
    const descriptor = new Uint8Array(24), descriptorView = new DataView(descriptor.buffer);
    u32(descriptorView, 0, 0x08074b50); u32(descriptorView, 4, stream.crc);
    u64(descriptorView, 8, size); u64(descriptorView, 16, size); this.emit(descriptor);
    this.entries.push({ name: filename, crc: stream.crc, size, offset: start });
  }

  async drain(): Promise<void> {
    await this.pending;
    if (this.sinkError) throw this.sinkError;
  }

  finish(type = 'application/zip'): Blob {
    const centralOffset = this.offset, { time, date } = dosDate();
    for (const entry of this.entries) {
      const central = new Uint8Array(46 + entry.name.byteLength + 28), view = new DataView(central.buffer);
      u32(view, 0, 0x02014b50); u16(view, 4, 45); u16(view, 6, 45); u16(view, 8, 0x0808); u16(view, 10, 0);
      u16(view, 12, time); u16(view, 14, date); u32(view, 16, entry.crc);
      u32(view, 20, 0xffff_ffff); u32(view, 24, 0xffff_ffff); u16(view, 28, entry.name.byteLength); u16(view, 30, 28);
      u16(view, 32, 0); u16(view, 34, 0); u16(view, 36, 0); u32(view, 38, 0); u32(view, 42, 0xffff_ffff);
      central.set(entry.name, 46); const extra = 46 + entry.name.byteLength;
      u16(view, extra, 1); u16(view, extra + 2, 24); u64(view, extra + 4, entry.size);
      u64(view, extra + 12, entry.size); u64(view, extra + 20, entry.offset); this.emit(central);
    }
    const centralSize = this.offset - centralOffset, zip64Offset = this.offset;
    const end = new Uint8Array(98), view = new DataView(end.buffer), count = BigInt(this.entries.length);
    u32(view, 0, 0x06064b50); u64(view, 4, 44n); u16(view, 12, 45); u16(view, 14, 45);
    u32(view, 16, 0); u32(view, 20, 0); u64(view, 24, count); u64(view, 32, count);
    u64(view, 40, centralSize); u64(view, 48, centralOffset);
    u32(view, 56, 0x07064b50); u32(view, 60, 0); u64(view, 64, zip64Offset); u32(view, 72, 1);
    u32(view, 76, 0x06054b50); u16(view, 80, 0); u16(view, 82, 0); u16(view, 84, 0xffff); u16(view, 86, 0xffff);
    u32(view, 88, 0xffff_ffff); u32(view, 92, 0xffff_ffff); u16(view, 96, 0); this.emit(end);
    return new Blob(this.chunks, { type });
  }
}

export interface StreamedZipEntry {
  readonly name: string;
  readonly size: number;
  readonly compressedSize: number;
  readonly chunks: AsyncIterable<Uint8Array>;
}

interface CentralEntry {
  readonly name: string;
  readonly size: number;
  readonly compressedSize: number;
  readonly compression: number;
  readonly localOffset: number;
}

const CENTRAL_LIMIT = 64 * 1024 * 1024;

function read64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ZIP64 value exceeds the supported file size');
  return Number(value);
}

async function sliceBytes(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

function zip64Values(extra: Uint8Array, needSize: boolean, needCompressed: boolean, needOffset: boolean): number[] {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let at = 0;
  while (at + 4 <= extra.byteLength) {
    const tag = view.getUint16(at, true), length = view.getUint16(at + 2, true);
    at += 4;
    if (at + length > extra.byteLength) throw new Error('Truncated ZIP extra field');
    if (tag === 1) {
      const values: number[] = [];
      let cursor = at;
      for (const needed of [needSize, needCompressed, needOffset]) {
        if (!needed) continue;
        if (cursor + 8 > at + length) throw new Error('Truncated ZIP64 extra field');
        values.push(read64(view, cursor)); cursor += 8;
      }
      return values;
    }
    at += length;
  }
  throw new Error('ZIP64 extra field is missing');
}

async function centralEntries(blob: Blob): Promise<CentralEntry[]> {
  if (!Number.isSafeInteger(blob.size) || blob.size < 22) throw new Error('Truncated ZIP archive');
  const tailStart = Math.max(0, blob.size - 65_557), tail = await sliceBytes(blob, tailStart, blob.size);
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let end = -1;
  for (let at = tail.byteLength - 22; at >= 0; at--) {
    if (tailView.getUint32(at, true) === 0x06054b50 && at + 22 + tailView.getUint16(at + 20, true) === tail.byteLength) {
      end = at; break;
    }
  }
  if (end < 0) throw new Error('ZIP end record is missing');
  if (tailView.getUint16(end + 4, true) || tailView.getUint16(end + 6, true)) throw new Error('Multi-disk ZIP archives are not supported');
  let count = tailView.getUint16(end + 10, true), centralSize = tailView.getUint32(end + 12, true);
  let centralOffset = tailView.getUint32(end + 16, true);
  if (count === 0xffff || centralSize === 0xffff_ffff || centralOffset === 0xffff_ffff) {
    if (end < 20 || tailView.getUint32(end - 20, true) !== 0x07064b50) throw new Error('ZIP64 locator is missing');
    const zip64Offset = read64(tailView, end - 12), record = await sliceBytes(blob, zip64Offset, zip64Offset + 56);
    if (record.byteLength < 56) throw new Error('Truncated ZIP64 end record');
    const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
    if (view.getUint32(0, true) !== 0x06064b50 || view.getUint32(16, true) || view.getUint32(20, true)) {
      throw new Error('Invalid ZIP64 end record');
    }
    count = read64(view, 32); centralSize = read64(view, 40); centralOffset = read64(view, 48);
  }
  if (centralSize > CENTRAL_LIMIT || centralOffset + centralSize > blob.size) throw new Error('ZIP central directory is too large or truncated');
  const bytes = await sliceBytes(blob, centralOffset, centralOffset + centralSize);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), decoder = new TextDecoder();
  const entries: CentralEntry[] = [];
  let at = 0;
  while (at < bytes.byteLength) {
    if (at + 46 > bytes.byteLength || view.getUint32(at, true) !== 0x02014b50) throw new Error('Invalid ZIP central directory');
    const flags = view.getUint16(at + 8, true), compression = view.getUint16(at + 10, true);
    if (flags & 1) throw new Error('Encrypted ZIP entries are not supported');
    if (compression !== 0 && compression !== 8) throw new Error(`Unsupported ZIP compression method ${compression}`);
    const nameLength = view.getUint16(at + 28, true), extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true), disk = view.getUint16(at + 34, true);
    if (disk) throw new Error('Multi-disk ZIP archives are not supported');
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > bytes.byteLength) throw new Error('Truncated ZIP central directory entry');
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    let size = view.getUint32(at + 24, true), compressedSize = view.getUint32(at + 20, true);
    let localOffset = view.getUint32(at + 42, true);
    const needSize = size === 0xffff_ffff, needCompressed = compressedSize === 0xffff_ffff;
    const needOffset = localOffset === 0xffff_ffff;
    if (needSize || needCompressed || needOffset) {
      const values = zip64Values(bytes.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength),
        needSize, needCompressed, needOffset);
      let index = 0;
      if (needSize) size = values[index++]!;
      if (needCompressed) compressedSize = values[index++]!;
      if (needOffset) localOffset = values[index++]!;
    }
    entries.push({ name, size, compressedSize, compression, localOffset });
    at = next;
  }
  if (entries.length !== count) throw new Error('ZIP entry count does not match its central directory');
  return entries;
}

async function* storedChunks(blob: Blob): AsyncGenerator<Uint8Array> {
  const reader = blob.stream().getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength) yield value;
    }
  } finally { reader.releaseLock(); }
}

async function* inflatedChunks(blob: Blob): AsyncGenerator<Uint8Array> {
  let output: Uint8Array[] = [];
  const inflater = new Inflate((chunk) => { if (chunk.byteLength) output.push(chunk); });
  const reader = blob.stream().getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      inflater.push(value);
      const ready = output; output = [];
      for (const chunk of ready) yield chunk;
    }
    inflater.push(new Uint8Array(), true);
    for (const chunk of output) yield chunk;
  } finally { reader.releaseLock(); }
}

/**
 * Reads exact entry ranges from the central directory. This avoids fflate's signature scan for
 * unknown-size stored entries, which can mistake arbitrary image bytes for a data descriptor.
 */
export async function* readZipEntries(blob: Blob): AsyncGenerator<StreamedZipEntry> {
  for (const entry of await centralEntries(blob)) {
    const header = await sliceBytes(blob, entry.localOffset, entry.localOffset + 30);
    if (header.byteLength < 30) throw new Error('Truncated ZIP local header');
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (view.getUint32(0, true) !== 0x04034b50) throw new Error('Invalid ZIP local header');
    const dataOffset = entry.localOffset + 30 + view.getUint16(26, true) + view.getUint16(28, true);
    const end = dataOffset + entry.compressedSize;
    if (end > blob.size) throw new Error('Truncated ZIP entry');
    const payload = blob.slice(dataOffset, end);
    yield { name: entry.name, size: entry.size, compressedSize: entry.compressedSize,
      chunks: entry.compression === 0 ? storedChunks(payload) : inflatedChunks(payload) };
  }
}
