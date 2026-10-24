/* Baseline four-component JPEG encoder. The marker/entropy implementation is deliberately small;
 * it follows ITU-T T.81 and uses the standard luminance Huffman table for all four device channels.
 * Adobe APP14 transform 0 identifies a CMYK stream. Samples are stored inverted, as required by
 * the de-facto Adobe CMYK JPEG convention used by libjpeg, Photoshop and our decoder. */

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
] as const;

const BASE_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
] as const;

const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0] as const;
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;
const AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d] as const;
const AC_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
] as const;

interface Code { readonly value: number; readonly length: number }

function huffman(bits: readonly number[], values: readonly number[]): Map<number, Code> {
  const result = new Map<number, Code>();
  let code = 0, value = 0;
  for (let length = 1; length <= 16; length++) {
    for (let count = 0; count < bits[length - 1]!; count++) result.set(values[value++]!, { value: code++, length });
    code <<= 1;
  }
  return result;
}

class Writer {
  readonly bytes: number[] = [];
  private bits = 0;
  private bitCount = 0;
  byte(value: number): void { this.bytes.push(value & 255); }
  word(value: number): void { this.byte(value >>> 8); this.byte(value); }
  marker(value: number): void { this.byte(0xff); this.byte(value); }
  segment(marker: number, payload: readonly number[]): void { this.marker(marker); this.word(payload.length + 2); for (const value of payload) this.byte(value); }
  write(code: Code): void {
    this.bits = (this.bits << code.length) | code.value; this.bitCount += code.length;
    while (this.bitCount >= 8) {
      const value = (this.bits >>> (this.bitCount - 8)) & 255; this.byte(value); if (value === 255) this.byte(0);
      this.bitCount -= 8;
    }
  }
  flush(): void { if (this.bitCount) this.write({ value: (1 << (8 - this.bitCount)) - 1, length: 8 - this.bitCount }); }
}

const COS = Array.from({ length: 8 }, (_, u) => Array.from({ length: 8 }, (_, x) => Math.cos((2 * x + 1) * u * Math.PI / 16)));

function dct(block: Float64Array, quant: Uint8Array): Int16Array {
  const out = new Int16Array(64);
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
    let sum = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) sum += block[y * 8 + x]! * COS[u]![x]! * COS[v]![y]!;
    const scale = (u === 0 ? Math.SQRT1_2 : 1) * (v === 0 ? Math.SQRT1_2 : 1) / 4;
    out[v * 8 + u] = Math.round(sum * scale / quant[v * 8 + u]!);
  }
  return out;
}

function magnitude(value: number): { size: number; bits: number } {
  if (value === 0) return { size: 0, bits: 0 };
  const size = Math.floor(Math.log2(Math.abs(value))) + 1;
  return { size, bits: value < 0 ? value + (1 << size) - 1 : value };
}

function encodeBlock(writer: Writer, natural: Int16Array, previous: number, dc: Map<number, Code>, ac: Map<number, Code>): number {
  const coefficients = ZIGZAG.map((index) => natural[index]!);
  const difference = coefficients[0]! - previous, dcValue = magnitude(difference);
  writer.write(dc.get(dcValue.size)!); if (dcValue.size) writer.write({ value: dcValue.bits, length: dcValue.size });
  let end = 63; while (end > 0 && coefficients[end] === 0) end--;
  if (end === 0) { writer.write(ac.get(0)!); return coefficients[0]!; }
  for (let index = 1; index <= end;) {
    let zeroes = 0; while (index <= end && coefficients[index] === 0) { zeroes++; index++; }
    while (zeroes >= 16) { writer.write(ac.get(0xf0)!); zeroes -= 16; }
    const value = magnitude(coefficients[index++]!);
    writer.write(ac.get((zeroes << 4) | value.size)!); writer.write({ value: value.bits, length: value.size });
  }
  if (end < 63) writer.write(ac.get(0)!);
  return coefficients[0]!;
}

function quantTable(quality: number): Uint8Array {
  const q = Math.max(1, Math.min(100, Math.round(quality * 100)));
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  return Uint8Array.from(BASE_QUANT, (value) => Math.max(1, Math.min(255, Math.floor((value * scale + 50) / 100))));
}

/** Encodes conventional 0=no-ink CMYK8 pixels into an Adobe-compatible baseline JPEG. */
export function encodeCmykJpeg(pixels: Uint8Array, width: number, height: number, quality = 0.85): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 65_535 || height > 65_535) {
    throw new RangeError('Invalid CMYK JPEG size.');
  }
  if (pixels.length !== width * height * 4) throw new RangeError('CMYK JPEG pixels must have four channels.');
  const writer = new Writer(), quant = quantTable(quality), dc = huffman(DC_BITS, DC_VALUES), ac = huffman(AC_BITS, AC_VALUES);
  writer.marker(0xd8);
  writer.segment(0xee, [0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0, 0]);
  writer.segment(0xdb, [0, ...ZIGZAG.map((index) => quant[index]!) ]);
  writer.segment(0xc0, [8, height >>> 8, height, width >>> 8, width, 4,
    1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 4, 0x11, 0]);
  writer.segment(0xc4, [0x00, ...DC_BITS, ...DC_VALUES, 0x10, ...AC_BITS, ...AC_VALUES]);
  writer.segment(0xda, [4, 1, 0, 2, 0, 3, 0, 4, 0, 0, 63, 0]);
  const previous = [0, 0, 0, 0], block = new Float64Array(64);
  for (let by = 0; by < height; by += 8) for (let bx = 0; bx < width; bx += 8) for (let channel = 0; channel < 4; channel++) {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const sx = Math.min(width - 1, bx + x), sy = Math.min(height - 1, by + y);
      block[y * 8 + x] = (255 - pixels[(sy * width + sx) * 4 + channel]!) - 128;
    }
    previous[channel] = encodeBlock(writer, dct(block, quant), previous[channel]!, dc, ac);
  }
  writer.flush(); writer.marker(0xd9);
  return Uint8Array.from(writer.bytes);
}
