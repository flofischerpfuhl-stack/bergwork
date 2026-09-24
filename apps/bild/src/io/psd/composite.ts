/** Minimal PSD/PSB merged-image decoder used when ag-psd cannot parse the document colour mode. */

export interface RawPsdComposite {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly bitsPerChannel: 1 | 8 | 16 | 32;
  readonly colorMode: number;
  readonly isPsb: boolean;
  readonly rgba: Uint8Array;
  readonly iccProfile: Uint8Array | null;
  readonly palette: Uint8Array | null;
  /** Interleaved, host-endian samples for the Little CMS path; CMYK samples use ordinary ink polarity. */
  readonly managedSamples: Uint8Array | Uint16Array | null;
  readonly managedAlpha: Uint8Array | Uint16Array | null;
}

class Reader {
  offset = 0;
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  need(length: number): void { if (length < 0 || this.offset + length > this.bytes.length) throw new RangeError('Truncated PSD'); }
  u16(): number { this.need(2); const value = this.view.getUint16(this.offset); this.offset += 2; return value; }
  u32(): number { this.need(4); const value = this.view.getUint32(this.offset); this.offset += 4; return value; }
  u64(): number {
    const high = this.u32(), low = this.u32(), value = high * 0x1_0000_0000 + low;
    if (!Number.isSafeInteger(value)) throw new RangeError('PSD section is too large');
    return value;
  }
  take(length: number): Uint8Array { this.need(length); const value = this.bytes.subarray(this.offset, this.offset + length); this.offset += length; return value; }
  skip(length: number): void { this.need(length); this.offset += length; }
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = ''; for (let i = 0; i < length; i++) value += String.fromCharCode(bytes[offset + i]!); return value;
}

function imageResourceProfile(bytes: Uint8Array): Uint8Array | null {
  const reader = new Reader(bytes);
  while (reader.offset + 12 <= bytes.length) {
    const signature = ascii(reader.take(4), 0, 4);
    if (signature !== '8BIM' && signature !== 'MeSa') break;
    const id = reader.u16(), nameLength = reader.take(1)[0]!, nameStorage = 1 + nameLength;
    reader.skip(nameLength + (nameStorage & 1));
    const length = reader.u32(), data = reader.take(length);
    if (length & 1) reader.skip(1);
    if (id === 0x040f) return data.slice();
  }
  return null;
}

function mergedTransparency(section: Uint8Array, isPsb: boolean): boolean {
  const lengthBytes = isPsb ? 8 : 4;
  if (section.length < lengthBytes + 2) return false;
  const view = new DataView(section.buffer, section.byteOffset, section.byteLength);
  const length = isPsb ? view.getUint32(0) * 0x1_0000_0000 + view.getUint32(4) : view.getUint32(0);
  return length >= 2 && section.length >= lengthBytes + 2 && view.getInt16(lengthBytes) < 0;
}

/** Reads only the signed layer-count convention; it never touches merged image pixels. */
export function psdHasMergedTransparency(bytes: Uint8Array): boolean {
  const reader = new Reader(bytes);
  if (ascii(reader.take(4), 0, 4) !== '8BPS') throw new Error('Invalid PSD signature');
  const version = reader.u16(); if (version !== 1 && version !== 2) throw new Error(`Invalid PSD version ${version}`);
  reader.skip(20);
  reader.skip(reader.u32());
  reader.skip(reader.u32());
  const layerBytes = version === 2 ? reader.u64() : reader.u32();
  return mergedTransparency(reader.take(layerBytes), version === 2);
}

function decodePackBits(source: Uint8Array, output: Uint8Array, target: number, expected: number): void {
  let input = 0, written = 0;
  while (input < source.length && written < expected) {
    const header = source[input++]!;
    if (header <= 127) {
      const count = Math.min(header + 1, expected - written);
      if (input + count > source.length) throw new RangeError('Truncated PSD PackBits row');
      output.set(source.subarray(input, input + count), target + written); input += header + 1; written += count;
    } else if (header >= 129) {
      const count = Math.min(257 - header, expected - written), value = source[input++];
      if (value === undefined) throw new RangeError('Truncated PSD PackBits run');
      output.fill(value, target + written, target + written + count); written += count;
    }
  }
  if (written !== expected) throw new RangeError('PSD PackBits row has the wrong length');
}

function decodeChannels(reader: Reader, channels: number, width: number, height: number, bits: number,
  isPsb: boolean): Uint8Array {
  const compression = reader.u16(), rowBytes = Math.ceil(width * bits / 8), planeBytes = rowBytes * height;
  if (!Number.isSafeInteger(planeBytes * channels) || planeBytes * channels > 1_600_000_000) throw new RangeError('PSD composite is too large');
  const output = new Uint8Array(planeBytes * channels);
  if (compression === 0) { output.set(reader.take(output.length)); return output; }
  if (compression !== 1) throw new Error(`PSD composite compression ${compression} is not supported`);
  const lengths = new Uint32Array(channels * height);
  for (let i = 0; i < lengths.length; i++) lengths[i] = isPsb ? reader.u32() : reader.u16();
  for (let channel = 0, row = 0; channel < channels; channel++) for (let y = 0; y < height; y++, row++) {
    const length = lengths[row]!;
    decodePackBits(reader.take(length), output, channel * planeBytes + y * rowBytes, rowBytes);
  }
  return output;
}

function sample8(data: Uint8Array, planeBytes: number, rowBytes: number, width: number, bits: number,
  channel: number, pixel: number, view: DataView): number {
  const y = Math.floor(pixel / width), x = pixel - y * width, base = channel * planeBytes + y * rowBytes;
  if (bits === 1) return (data[base + (x >>> 3)]! & (0x80 >>> (x & 7))) ? 0 : 255;
  if (bits === 8) return data[base + x]!;
  if (bits === 16) { const at = base + x * 2; return Math.floor(((data[at]! << 8 | data[at + 1]!) * 255 + 32767) / 65535); }
  const at = base + x * 4;
  const value = view.getFloat32(at);
  return Math.round(Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)) * 255);
}

function sampleInteger(data: Uint8Array, planeBytes: number, rowBytes: number, width: number, bits: 8 | 16,
  channel: number, pixel: number): number {
  const y = Math.floor(pixel / width), x = pixel - y * width, base = channel * planeBytes + y * rowBytes;
  if (bits === 8) return data[base + x]!;
  const at = base + x * 2; return data[at]! << 8 | data[at + 1]!;
}

function writeLabRgb(output: Uint8Array, target: number, l8: number, a8: number, b8: number): void {
  const l = l8 * 100 / 255, a = a8 - 128, b = b8 - 128;
  const fy = (l + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inverse = (v: number): number => v ** 3 > 216 / 24389 ? v ** 3 : (116 * v - 16) / 903.3;
  const x = inverse(fx) * 0.96422, y = inverse(fy), z = inverse(fz) * 0.82521;
  const linear = [3.1338561 * x - 1.6168667 * y - 0.4906146 * z,
    -0.9787684 * x + 1.9161415 * y + 0.033454 * z,
    0.0719453 * x - 0.2289914 * y + 1.4052427 * z] as const;
  const encode = (value: number): number => {
    const v = Math.max(0, value), srgb = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, srgb) * 255);
  };
  output[target] = encode(linear[0]); output[target + 1] = encode(linear[1]); output[target + 2] = encode(linear[2]);
}

/** Decodes the saved merged image. PSD specification: File Header through Image Data sections. */
export function readRawPsdComposite(bytes: Uint8Array): RawPsdComposite {
  const reader = new Reader(bytes);
  if (ascii(reader.take(4), 0, 4) !== '8BPS') throw new Error('Invalid PSD signature');
  const version = reader.u16(); if (version !== 1 && version !== 2) throw new Error(`Invalid PSD version ${version}`);
  reader.skip(6);
  const channels = reader.u16(), height = reader.u32(), width = reader.u32(), bits = reader.u16(), colorMode = reader.u16();
  if (channels < 1 || channels > 16 || width < 1 || height < 1 || width > 30_000 || height > 30_000
    || width * height > 100_000_000 || ![1, 8, 16, 32].includes(bits)) throw new RangeError('Invalid PSD composite dimensions');
  const colorData = reader.take(reader.u32());
  const resources = reader.take(reader.u32()), iccProfile = imageResourceProfile(resources);
  const layerBytes = version === 2 ? reader.u64() : reader.u32();
  const hasMergedAlpha = mergedTransparency(reader.take(layerBytes), version === 2);
  const channelData = decodeChannels(reader, channels, width, height, bits, version === 2);
  const channelView = new DataView(channelData.buffer, channelData.byteOffset, channelData.byteLength);
  const rowBytes = Math.ceil(width * bits / 8), planeBytes = rowBytes * height, pixels = width * height;
  const rgba = new Uint8Array(pixels * 4), baseChannels = colorMode === 4 ? 4 : colorMode === 3 || colorMode === 9 || colorMode === 7 ? 3 : 1;
  const palette = colorMode === 2 && colorData.length >= 768 ? colorData : null;
  const managedChannelCount = colorMode === 4 ? 4 : colorMode === 1 ? 1 : 0;
  const managedSamples = managedChannelCount && (bits === 8 || bits === 16)
    ? bits === 8 ? new Uint8Array(pixels * managedChannelCount) : new Uint16Array(pixels * managedChannelCount) : null;
  const managedAlpha = managedSamples && hasMergedAlpha && channels > baseChannels
    ? bits === 8 ? new Uint8Array(pixels) : new Uint16Array(pixels) : null;
  for (let pixel = 0, target = 0; pixel < pixels; pixel++, target += 4) {
    const c0 = sample8(channelData, planeBytes, rowBytes, width, bits, 0, pixel, channelView);
    let r = c0, g = c0, b = c0;
    if (colorMode === 2 && palette) { r = palette[c0]!; g = palette[256 + c0]!; b = palette[512 + c0]!; }
    else if (colorMode === 3 || colorMode === 7) {
      g = sample8(channelData, planeBytes, rowBytes, width, bits, 1, pixel, channelView);
      b = sample8(channelData, planeBytes, rowBytes, width, bits, 2, pixel, channelView);
    } else if (colorMode === 4) {
      const m = sample8(channelData, planeBytes, rowBytes, width, bits, 1, pixel, channelView);
      const y = sample8(channelData, planeBytes, rowBytes, width, bits, 2, pixel, channelView);
      const k = sample8(channelData, planeBytes, rowBytes, width, bits, 3, pixel, channelView);
      r = Math.floor(c0 * k / 255); g = Math.floor(m * k / 255); b = Math.floor(y * k / 255);
    } else if (colorMode === 9) writeLabRgb(rgba, target, c0,
      sample8(channelData, planeBytes, rowBytes, width, bits, 1, pixel, channelView),
      sample8(channelData, planeBytes, rowBytes, width, bits, 2, pixel, channelView));
    if (colorMode !== 9) { rgba[target] = r; rgba[target + 1] = g; rgba[target + 2] = b; }
    const alpha = hasMergedAlpha && channels > baseChannels
      ? sample8(channelData, planeBytes, rowBytes, width, bits, baseChannels, pixel, channelView) : 255;
    rgba[target + 3] = colorMode === 4 && hasMergedAlpha ? 255 - alpha : alpha;
    if (managedSamples) {
      const maximum = bits === 16 ? 65535 : 255;
      for (let channel = 0; channel < managedChannelCount; channel++) {
        const value = sampleInteger(channelData, planeBytes, rowBytes, width, bits as 8 | 16, channel, pixel);
        managedSamples[pixel * managedChannelCount + channel] = colorMode === 4 ? maximum - value : value;
      }
      if (managedAlpha) {
        const value = sampleInteger(channelData, planeBytes, rowBytes, width, bits as 8 | 16, baseChannels, pixel);
        managedAlpha[pixel] = colorMode === 4 ? maximum - value : value;
      }
    }
  }
  return { width, height, channels, bitsPerChannel: bits as 1 | 8 | 16 | 32, colorMode,
    isPsb: version === 2, rgba, iccProfile, palette: colorMode === 2 && colorData.length >= 768 ? colorData.slice(0, 768) : null,
    managedSamples, managedAlpha };
}
