/**
 * Joins independently compressed raw DEFLATE streams into one (for band-parallel PNG with the
 * browser's native zlib via CompressionStream, which always ends its output with a BFINAL block).
 *
 * `openDeflateEnd` walks the stream's block structure (RFC 1951; Huffman codes are decoded but no
 * output is produced), clears the BFINAL bit of the last block and appends an empty non-final
 * stored block so the result ends byte-aligned, exactly like zlib's Z_SYNC_FLUSH. Another raw stream
 * can then follow directly.
 */

export class DeflateJoinError extends Error {
  constructor(message: string) { super(message); this.name = 'DeflateJoinError'; }
}

const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huffman {
  readonly count: Uint16Array;
  readonly symbol: Uint16Array;
  /** 9-bit lookup of (symbol << 4 | length) for codes up to 9 bits; 0 = longer code. */
  readonly fast: Uint32Array;
}

const FAST_BITS = 9;

function huffman(lengths: Uint8Array, n: number): Huffman {
  const count = new Uint16Array(16), symbol = new Uint16Array(n), offsets = new Uint16Array(16);
  for (let i = 0; i < n; i++) count[lengths[i]!]!++;
  count[0] = 0;
  for (let len = 1; len < 15; len++) offsets[len + 1] = offsets[len]! + count[len]!;
  for (let i = 0; i < n; i++) if (lengths[i]) symbol[offsets[lengths[i]!]!++] = i;
  const fast = new Uint32Array(1 << FAST_BITS);
  for (let len = 1, code = 0, index = 0; len <= FAST_BITS; len++, code <<= 1) {
    for (let k = 0; k < count[len]!; k++, code++, index++) {
      let reversed = 0;
      for (let b = 0; b < len; b++) reversed |= ((code >> b) & 1) << (len - 1 - b);
      for (let j = reversed; j < fast.length; j += 1 << len) fast[j] = (symbol[index]! << 4) | len;
    }
  }
  return { count, symbol, fast };
}

const FIXED = (() => {
  const lengths = new Uint8Array(288);
  lengths.fill(8, 0, 144); lengths.fill(9, 144, 256); lengths.fill(7, 256, 280); lengths.fill(8, 280, 288);
  const distances = new Uint8Array(30).fill(5);
  return { literal: huffman(lengths, 288), distance: huffman(distances, 30) };
})();

/** LSB-first bit reader with a 32-bit window; reads past the end as zero bits and checks the position at the end. */
class Bits {
  private buffer = 0;
  private count = 0;
  private at = 0;
  constructor(private readonly data: Uint8Array) {}
  get position(): number { return this.at * 8 - this.count; }
  private need(n: number): void {
    while (this.count < n) { this.buffer |= (this.data[this.at++] ?? 0) << this.count; this.count += 8; }
    if (this.at > this.data.length + 4) throw new DeflateJoinError('Truncated DEFLATE stream');
  }
  bits(n: number): number {
    if (n === 0) return 0;
    this.need(n);
    const value = this.buffer & ((1 << n) - 1);
    this.buffer >>>= n; this.count -= n;
    return value;
  }
  skip(n: number): void { if (n) this.bits(n); }
  alignToByte(): void { this.skip(this.count & 7); }
  /** Skips whole bytes after alignment (stored blocks). */
  skipBytes(n: number): void {
    this.alignToByte();
    const buffered = this.count >>> 3;
    const fromBuffer = Math.min(buffered, n);
    this.skip(fromBuffer * 8);
    this.at += n - fromBuffer;
    if (this.at > this.data.length) throw new DeflateJoinError('Truncated stored block');
  }
  byteAt(offset: number): number { return this.data[offset] ?? 0; }
  get bytePosition(): number { return this.at - (this.count >>> 3); }
  decode(table: Huffman): number {
    this.need(FAST_BITS);
    const entry = table.fast[this.buffer & ((1 << FAST_BITS) - 1)]!;
    if (entry) { const len = entry & 15; this.buffer >>>= len; this.count -= len; return entry >>> 4; }
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= this.bits(1);
      const count = table.count[len]!;
      if (code - count < first) return table.symbol[index + (code - first)]!;
      index += count; first += count; first <<= 1; code <<= 1;
    }
    throw new DeflateJoinError('Invalid Huffman code');
  }
}

function skipCodes(bits: Bits, literal: Huffman, distance: Huffman): void {
  for (;;) {
    const symbol = bits.decode(literal);
    if (symbol < 256) continue;
    if (symbol === 256) return;
    const index = symbol - 257;
    if (index >= 29) throw new DeflateJoinError('Invalid length symbol');
    bits.skip(LENGTH_EXTRA[index]!);
    const code = bits.decode(distance);
    if (code >= 30) throw new DeflateJoinError('Invalid distance symbol');
    bits.skip(DISTANCE_EXTRA[code]!);
  }
}

function dynamicTables(bits: Bits): { literal: Huffman; distance: Huffman } {
  const nlen = bits.bits(5) + 257, ndist = bits.bits(5) + 1, ncode = bits.bits(4) + 4;
  if (nlen > 286 || ndist > 30) throw new DeflateJoinError('Invalid dynamic block counts');
  const lengths = new Uint8Array(19);
  for (let i = 0; i < ncode; i++) lengths[CODE_LENGTH_ORDER[i]!] = bits.bits(3);
  const lengthCode = huffman(lengths, 19);
  const all = new Uint8Array(nlen + ndist);
  for (let index = 0; index < nlen + ndist;) {
    const symbol = bits.decode(lengthCode);
    if (symbol < 16) { all[index++] = symbol; continue; }
    let value = 0, repeat: number;
    if (symbol === 16) {
      if (index === 0) throw new DeflateJoinError('Repeat without a previous length');
      value = all[index - 1]!; repeat = 3 + bits.bits(2);
    } else if (symbol === 17) repeat = 3 + bits.bits(3);
    else repeat = 11 + bits.bits(7);
    if (index + repeat > nlen + ndist) throw new DeflateJoinError('Too many code lengths');
    while (repeat--) all[index++] = value;
  }
  return { literal: huffman(all.subarray(0, nlen), nlen), distance: huffman(all.subarray(nlen), ndist) };
}

/** Bit position of the last block's BFINAL bit and the bit position right after that block. */
export function lastDeflateBlock(data: Uint8Array): { header: number; end: number } {
  const bits = new Bits(data);
  for (;;) {
    const header = bits.position;
    const final = bits.bits(1), type = bits.bits(2);
    if (type === 0) {
      bits.alignToByte();
      const at = bits.bytePosition;
      if (at + 4 > data.length) throw new DeflateJoinError('Truncated stored block');
      const length = bits.byteAt(at) | (bits.byteAt(at + 1) << 8);
      if ((length ^ 0xffff) !== (bits.byteAt(at + 2) | (bits.byteAt(at + 3) << 8))) throw new DeflateJoinError('Invalid stored block length');
      bits.skipBytes(4 + length);
    } else if (type === 1) skipCodes(bits, FIXED.literal, FIXED.distance);
    else if (type === 2) { const tables = dynamicTables(bits); skipCodes(bits, tables.literal, tables.distance); }
    else throw new DeflateJoinError('Invalid block type');
    if (bits.position > data.length * 8) throw new DeflateJoinError('Truncated DEFLATE stream');
    if (final) return { header, end: bits.position };
  }
}

/** The stream with its last block made non-final and a sync-flush marker appended (byte-aligned end). */
export function openDeflateEnd(data: Uint8Array): Uint8Array {
  const { header, end } = lastDeflateBlock(data);
  const bytes = end >>> 3, bit = end & 7;
  // Keep everything up to the last partial byte; the stored block's 3 zero header bits go right after `end`.
  const headerBytes = bit === 0 ? 1 : bit + 3 > 8 ? 2 : 1;
  const out = new Uint8Array(bytes + headerBytes + 4);
  out.set(data.subarray(0, bytes + (bit ? 1 : 0)));
  if (bit) out[bytes] = out[bytes]! & ((1 << bit) - 1);
  out[header >>> 3] = out[header >>> 3]! & ~(1 << (header & 7));
  out.set([0, 0, 0xff, 0xff], bytes + headerBytes);
  return out;
}
