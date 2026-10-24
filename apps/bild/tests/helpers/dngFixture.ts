/** Synthetic DNG writer. Every byte is generated in-repo; no camera files or codec output are used as an oracle. */
export type DngFixtureKind = 'bayer' | 'linear';

interface Field { tag: number; type: number; values: number[] }
const sizeOf: Record<number, number> = { 1: 1, 3: 2, 4: 4, 5: 8, 10: 8 };

function matrixMultiply(a: readonly number[], b: readonly number[]): number[] {
  const out = Array<number>(9).fill(0);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) for (let k = 0; k < 3; k++) out[y * 3 + x]! += a[y * 3 + k]! * b[k * 3 + x]!;
  return out;
}

// XYZ(D50) -> Bradford D65 -> linear sRGB. A DNG ColorMatrix maps XYZ to camera channels.
const COLOR_MATRIX = matrixMultiply(
  [3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252],
  [0.9555766, -0.0230393, 0.0631636, -0.0282895, 1.0099416, 0.0210077, 0.0122982, -0.020483, 1.3299098],
);

function losslessJpeg(samples: Uint16Array, width: number, height: number, channels: number): Uint8Array {
  const bytes: number[] = [0xff, 0xd8];
  const segment = (marker: number, body: number[]) => bytes.push(0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255, ...body);
  const components = Array.from({ length: channels }, (_, c) => [c + 1, 0x11, 0]).flat();
  segment(0xc3, [16, height >> 8, height & 255, width >> 8, width & 255, channels, ...components]);
  segment(0xc4, [0, ...Array(7).fill(0), 17, ...Array(8).fill(0), ...Array.from({ length: 17 }, (_, i) => i)]);
  const scan = Array.from({ length: channels }, (_, c) => [c + 1, 0]).flat();
  segment(0xda, [channels, ...scan, 1, 0, 0]);
  const entropy: number[] = []; let bitBuffer = 0, bitCount = 0;
  const write = (value: number, count: number) => {
    bitBuffer = bitBuffer * 2 ** count + value; bitCount += count;
    while (bitCount >= 8) {
      const divisor = 2 ** (bitCount - 8), byte = Math.floor(bitBuffer / divisor) & 255;
      entropy.push(byte); if (byte === 0xff) entropy.push(0); bitBuffer %= divisor; bitCount -= 8;
    }
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < channels; c++) {
    const index = (y * width + x) * channels + c;
    const predictor = x ? samples[index - channels]! : y ? samples[index - width * channels]! : 32768;
    const difference = samples[index]! - predictor;
    const category = difference === 0 ? 0 : Math.floor(Math.log2(Math.abs(difference))) + 1;
    write(category, 8);
    if (category) write(difference < 0 ? difference + (2 ** category - 1) : difference, category);
  }
  if (bitCount) write(2 ** (8 - bitCount) - 1, 8 - bitCount);
  bytes.push(...entropy, 0xff, 0xd9);
  return Uint8Array.from(bytes);
}

function encodedSamples(kind: DngFixtureKind, width: number, height: number): { channels: number; samples: Uint16Array } {
  const channels = kind === 'linear' ? 3 : 1, output = new Uint16Array(width * height * channels);
  const patches = [[0.72, 0.015, 0.012], [0.015, 0.68, 0.018], [0.012, 0.018, 0.74]];
  const pattern = [0, 1, 1, 2];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const patch = patches[Math.min(2, Math.floor(x * 3 / width))]!;
    if (kind === 'linear') for (let c = 0; c < 3; c++) output[(y * width + x) * 3 + c] = Math.round(patch[c]! * 65535);
    else output[y * width + x] = Math.round(patch[pattern[(y & 1) * 2 + (x & 1)]!]! * 65535);
  }
  return { channels, samples: output };
}

function dataBytes(samples: Uint16Array): Uint8Array {
  const output = new Uint8Array(samples.length * 2), view = new DataView(output.buffer);
  for (let i = 0; i < samples.length; i++) view.setUint16(i * 2, samples[i]!, true);
  return output;
}

export function makeDng(kind: DngFixtureKind, compression: 'none' | 'lossless-jpeg' = 'none', width = 18, height = 10, orientation = 1): Uint8Array {
  const { channels, samples } = encodedSamples(kind, width, height);
  const image = compression === 'lossless-jpeg' ? losslessJpeg(samples, width, height, channels) : dataBytes(samples);
  const fields: Field[] = [
    { tag: 256, type: 4, values: [width] }, { tag: 257, type: 4, values: [height] }, { tag: 258, type: 3, values: [16] },
    { tag: 259, type: 3, values: [compression === 'none' ? 1 : 7] }, { tag: 262, type: 3, values: [kind === 'linear' ? 34892 : 32803] },
    { tag: 274, type: 3, values: [orientation] },
    { tag: 273, type: 4, values: [0] }, { tag: 277, type: 3, values: [channels] }, { tag: 278, type: 4, values: [height] },
    { tag: 279, type: 4, values: [image.length] }, { tag: 284, type: 3, values: [1] }, { tag: 50706, type: 1, values: [1, 4, 0, 0] },
    { tag: 50714, type: 5, values: [0] }, { tag: 50717, type: 4, values: [65535] },
    { tag: 50721, type: 10, values: COLOR_MATRIX }, { tag: 50728, type: 5, values: [1, 1, 1] },
  ];
  if (kind === 'bayer') fields.push({ tag: 33421, type: 3, values: [2, 2] }, { tag: 33422, type: 1, values: [0, 1, 1, 2] });
  fields.sort((a, b) => a.tag - b.tag);
  const ifdBytes = 2 + fields.length * 12 + 4;
  let extraBytes = 0;
  for (const field of fields) if (field.values.length * sizeOf[field.type]! > 4) extraBytes += field.values.length * sizeOf[field.type]!;
  const imageOffset = 8 + ifdBytes + extraBytes;
  fields.find((field) => field.tag === 273)!.values[0] = imageOffset;
  const output = new Uint8Array(imageOffset + image.length), view = new DataView(output.buffer);
  output.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]); view.setUint16(8, fields.length, true);
  let extraAt = 8 + ifdBytes;
  const writeValues = (at: number, field: Field) => {
    for (let i = 0; i < field.values.length; i++) {
      const value = field.values[i]!, offset = at + i * sizeOf[field.type]!;
      if (field.type === 1) view.setUint8(offset, value);
      else if (field.type === 3) view.setUint16(offset, value, true);
      else if (field.type === 4) view.setUint32(offset, value, true);
      else if (field.type === 5) { view.setUint32(offset, Math.round(value * 1_000_000), true); view.setUint32(offset + 4, 1_000_000, true); }
      else if (field.type === 10) { view.setInt32(offset, Math.round(value * 1_000_000), true); view.setInt32(offset + 4, 1_000_000, true); }
    }
  };
  fields.forEach((field, index) => {
    const at = 10 + index * 12, byteLength = field.values.length * sizeOf[field.type]!;
    view.setUint16(at, field.tag, true); view.setUint16(at + 2, field.type, true); view.setUint32(at + 4, field.values.length, true);
    if (byteLength <= 4) writeValues(at + 8, field);
    else { view.setUint32(at + 8, extraAt, true); writeValues(extraAt, field); extraAt += byteLength; }
  });
  view.setUint32(10 + fields.length * 12, 0, true); output.set(image, imageOffset); return output;
}
