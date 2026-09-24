const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export interface StreamingSha256 {
  update(bytes: Uint8Array): this;
  digestHex(): string;
}

/** Synchronous, allocation-bounded SHA-256 for stable AssetRecord.sha256 values. */
export function sha256Hex(bytes: Uint8Array): string {
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const words = new Uint32Array(64);
  const block = new Uint8Array(64);
  const fullLength = bytes.length - (bytes.length % 64);

  const compress = (data: Uint8Array, offset: number): void => {
    for (let i = 0; i < 16; i++) {
      const at = offset + i * 4;
      words[i] = ((data[at]! << 24) | (data[at + 1]! << 16) | (data[at + 2]! << 8) | data[at + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15]!, y = words[i - 2]!;
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      words[i] = (words[i - 16]! + s0 + words[i - 7]! + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const sum1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const choice = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + sum1 + choice + K[i]! + words[i]!) >>> 0;
      const sum0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  };

  for (let offset = 0; offset < fullLength; offset += 64) compress(bytes, offset);
  const remainder = bytes.length - fullLength;
  block.fill(0);
  block.set(bytes.subarray(fullLength), 0);
  block[remainder] = 0x80;
  if (remainder >= 56) {
    compress(block, 0);
    block.fill(0);
  }
  // Uint8Array lengths are safely representable here; write the 64-bit bit count
  // as two 32-bit words without allocating a padded copy of the input.
  const high = Math.floor(bytes.length / 0x20000000);
  const low = (bytes.length << 3) >>> 0;
  block[56] = high >>> 24; block[57] = high >>> 16; block[58] = high >>> 8; block[59] = high;
  block[60] = low >>> 24; block[61] = low >>> 16; block[62] = low >>> 8; block[63] = low;
  compress(block, 0);

  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(h5) + hex(h6) + hex(h7);
}

function rotr(value: number, shift: number): number { return (value >>> shift) | (value << (32 - shift)); }
function hex(value: number): string { return value.toString(16).padStart(8, '0'); }

/** Stateful SHA-256; `update` never retains caller chunks. */
export class IncrementalSha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly words = new Uint32Array(64);
  private readonly pending = new Uint8Array(64);
  private pendingLength = 0;
  private length = 0;
  private finished = false;

  update(bytes: Uint8Array): this {
    if (this.finished) throw new Error('SHA-256 digest is already finished');
    this.length += bytes.byteLength;
    let offset = 0;
    if (this.pendingLength) {
      const take = Math.min(64 - this.pendingLength, bytes.byteLength);
      this.pending.set(bytes.subarray(0, take), this.pendingLength);
      this.pendingLength += take; offset += take;
      if (this.pendingLength === 64) { this.compress(this.pending, 0); this.pendingLength = 0; }
    }
    while (offset + 64 <= bytes.byteLength) { this.compress(bytes, offset); offset += 64; }
    if (offset < bytes.byteLength) {
      this.pending.set(bytes.subarray(offset), 0);
      this.pendingLength = bytes.byteLength - offset;
    }
    return this;
  }

  digestHex(): string {
    if (this.finished) throw new Error('SHA-256 digest is already finished');
    this.finished = true;
    const block = this.pending;
    block.fill(0, this.pendingLength);
    block[this.pendingLength] = 0x80;
    if (this.pendingLength >= 56) { this.compress(block, 0); block.fill(0); }
    const high = Math.floor(this.length / 0x20000000), low = (this.length << 3) >>> 0;
    block[56] = high >>> 24; block[57] = high >>> 16; block[58] = high >>> 8; block[59] = high;
    block[60] = low >>> 24; block[61] = low >>> 16; block[62] = low >>> 8; block[63] = low;
    this.compress(block, 0);
    return [...this.state].map(hex).join('');
  }

  private compress(data: Uint8Array, offset: number): void {
    const w = this.words, s = this.state;
    for (let i = 0; i < 16; i++) {
      const at = offset + i * 4;
      w[i] = ((data[at]! << 24) | (data[at + 1]! << 16) | (data[at + 2]! << 8) | data[at + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!, y = w[i - 2]!;
      w[i] = (w[i - 16]! + (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + w[i - 7]!
        + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10))) >>> 0;
    }
    let a = s[0]!, b = s[1]!, c = s[2]!, d = s[3]!, e = s[4]!, f = s[5]!, g = s[6]!, h = s[7]!;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    s[0] = (s[0]! + a) >>> 0; s[1] = (s[1]! + b) >>> 0; s[2] = (s[2]! + c) >>> 0; s[3] = (s[3]! + d) >>> 0;
    s[4] = (s[4]! + e) >>> 0; s[5] = (s[5]! + f) >>> 0; s[6] = (s[6]! + g) >>> 0; s[7] = (s[7]! + h) >>> 0;
  }
}

interface ShaWasmExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  sha_buffer(): number;
  sha_init(): void;
  sha_update(length: number): void;
  sha_finish(): number;
}

class WasmSha256 implements StreamingSha256 {
  private readonly exports: ShaWasmExports;
  private readonly pointer: number;
  private finished = false;

  constructor(module: WebAssembly.Module) {
    this.exports = new WebAssembly.Instance(module).exports as ShaWasmExports;
    this.pointer = this.exports.sha_buffer();
    this.exports.sha_init();
  }

  update(bytes: Uint8Array): this {
    if (this.finished) throw new Error('SHA-256 digest is already finished');
    for (let offset = 0; offset < bytes.byteLength; offset += 1_048_576) {
      const length = Math.min(1_048_576, bytes.byteLength - offset);
      new Uint8Array(this.exports.memory.buffer, this.pointer, length).set(bytes.subarray(offset, offset + length));
      this.exports.sha_update(length);
    }
    return this;
  }

  digestHex(): string {
    if (this.finished) throw new Error('SHA-256 digest is already finished');
    this.finished = true;
    const pointer = this.exports.sha_finish();
    return [...new Uint8Array(this.exports.memory.buffer, pointer, 32)]
      .map((value) => value.toString(16).padStart(2, '0')).join('');
  }
}

let wasmModule: Promise<WebAssembly.Module | null> | null = null;

async function loadWasmSha256(): Promise<WebAssembly.Module | null> {
  if (typeof WebAssembly === 'undefined' || typeof fetch === 'undefined') return null;
  if ((globalThis as typeof globalThis & { process?: { versions?: { node?: string } } }).process?.versions?.node) return null;
  try {
    const response = await fetch(new URL('./sha256.wasm', import.meta.url));
    if (!response.ok) return null;
    return await WebAssembly.compile(await response.arrayBuffer());
  } catch { return null; }
}

/** Prepared once per archive operation; every returned hasher has independent WASM state. */
export async function prepareStreamingSha256(): Promise<() => StreamingSha256> {
  wasmModule ??= loadWasmSha256();
  const module = await wasmModule;
  return module ? () => new WasmSha256(module) : () => new IncrementalSha256();
}
