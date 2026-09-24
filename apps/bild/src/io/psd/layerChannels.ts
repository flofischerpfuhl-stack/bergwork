import { unzlibSync } from 'fflate';
import type { Layer as AgLayer, PixelData } from 'ag-psd';
import type { LittleCms } from '../../wasm/lcms';

export interface PsdLayerColourContext {
  readonly colorMode: number;
  readonly bitsPerChannel: 1 | 8 | 16 | 32;
  readonly isPsb: boolean;
  readonly palette: Uint8Array | null;
  readonly iccProfile: Uint8Array | null;
  readonly lcms: LittleCms | null;
}

interface RawChannel { readonly id: number; readonly compression: number; readonly data?: Uint8Array }
interface RawLayerData { readonly channels: readonly RawChannel[] }

function decodePackBits(source: Uint8Array, output: Uint8Array, target: number, expected: number): void {
  let input = 0, written = 0;
  while (input < source.length && written < expected) {
    const header = source[input++]!;
    if (header <= 127) {
      const count = header + 1;
      if (input + count > source.length || written + count > expected) throw new RangeError('Invalid PSD layer PackBits row');
      output.set(source.subarray(input, input + count), target + written); input += count; written += count;
    } else if (header >= 129) {
      const count = 257 - header, value = source[input++];
      if (value === undefined || written + count > expected) throw new RangeError('Invalid PSD layer PackBits run');
      output.fill(value, target + written, target + written + count); written += count;
    }
  }
  if (written !== expected) throw new RangeError('PSD layer PackBits row has the wrong length');
}

function predicted(bytes: Uint8Array, width: number, height: number, bits: number): void {
  if (bits === 8) {
    for (let y = 0; y < height; y++) for (let x = 1, at = y * width + 1; x < width; x++, at++) {
      bytes[at] = (bytes[at]! + bytes[at - 1]!) & 0xff;
    }
  } else if (bits === 16) {
    for (let y = 0; y < height; y++) for (let x = 1; x < width; x++) {
      const at = (y * width + x) * 2, before = at - 2;
      const value = ((bytes[at]! << 8 | bytes[at + 1]!) + (bytes[before]! << 8 | bytes[before + 1]!)) & 0xffff;
      bytes[at] = value >>> 8; bytes[at + 1] = value;
    }
  } else if (bits === 32) {
    const stride = width * 4;
    for (let y = 0; y < height; y++) for (let byte = 0; byte < 4; byte++) {
      const start = y * stride + byte * width;
      for (let x = 1; x < width; x++) bytes[start + x] = (bytes[start + x]! + bytes[start + x - 1]!) & 0xff;
    }
    const row = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
      const start = y * stride; row.set(bytes.subarray(start, start + stride));
      for (let x = 0; x < width; x++) for (let byte = 0; byte < 4; byte++) bytes[start + x * 4 + byte] = row[byte * width + x]!;
    }
  }
}

function decodeChannel(channel: RawChannel | undefined, width: number, height: number,
  bits: number, isPsb: boolean): Uint8Array | null {
  if (!channel?.data) return null;
  const rowBytes = Math.ceil(width * bits / 8), expected = rowBytes * height, data = channel.data;
  if (channel.compression === 0) {
    if (data.length < expected) throw new RangeError('Truncated raw PSD layer channel');
    return data.slice(0, expected);
  }
  if (channel.compression === 1) {
    const countBytes = isPsb ? 4 : 2, tableBytes = countBytes * height;
    if (data.length < tableBytes) throw new RangeError('Truncated PSD layer row table');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength), output = new Uint8Array(expected);
    let source = tableBytes;
    for (let y = 0; y < height; y++) {
      const length = countBytes === 4 ? view.getUint32(y * 4) : view.getUint16(y * 2);
      if (source + length > data.length) throw new RangeError('Truncated PSD layer PackBits data');
      decodePackBits(data.subarray(source, source + length), output, y * rowBytes, rowBytes); source += length;
    }
    return output;
  }
  if (channel.compression === 2 || channel.compression === 3) {
    const output = unzlibSync(data);
    if (output.length !== expected) throw new RangeError('PSD ZIP layer channel has the wrong length');
    if (channel.compression === 3) predicted(output, width, height, bits);
    return output;
  }
  throw new Error(`Unsupported PSD layer compression ${channel.compression}`);
}

function sample(bytes: Uint8Array | null, pixel: number, bits: number, width: number): number {
  if (!bytes) return bits === 16 ? 65535 : bits === 32 ? 1 : 255;
  if (bits === 1) {
    const rowBytes = Math.ceil(width / 8), y = Math.floor(pixel / width), x = pixel - y * width;
    return (bytes[y * rowBytes + (x >>> 3)]! & (0x80 >>> (x & 7))) ? 0 : 255;
  }
  if (bits === 8) return bytes[pixel]!;
  if (bits === 16) return bytes[pixel * 2]! << 8 | bytes[pixel * 2 + 1]!;
  return new DataView(bytes.buffer, bytes.byteOffset + pixel * 4, 4).getFloat32(0);
}

function labInverse(value: number): number {
  return value ** 3 > 216 / 24389 ? value ** 3 : (116 * value - 16) / 903.3;
}

function labEncode(value: number): number {
  const v = Math.max(0, value);
  return Math.min(1, v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
}

function writeLabRgb(output: Uint8ClampedArray | Uint16Array, target: number,
  l: number, a: number, b: number, maximum: number): void {
  const fy = (l * 100 + 16) / 116, fx = fy + (a * 255 - 128) / 500, fz = fy - (b * 255 - 128) / 200;
  const x = labInverse(fx) * 0.96422, y = labInverse(fy), z = labInverse(fz) * 0.82521;
  output[target] = Math.round(labEncode(3.1338561 * x - 1.6168667 * y - 0.4906146 * z) * maximum);
  output[target + 1] = Math.round(labEncode(-0.9787684 * x + 1.9161415 * y + 0.033454 * z) * maximum);
  output[target + 2] = Math.round(labEncode(0.0719453 * x - 0.2289914 * y + 1.4052427 * z) * maximum);
}

function normalizedSample(planes: readonly (Uint8Array | null)[], channel: number, pixel: number,
  bits: number, width: number, maximum: number): number {
  return Number(sample(planes[channel] ?? null, pixel, bits, width)) / maximum;
}

function rgbaFromChannels(channels: readonly RawChannel[], width: number, height: number,
  context: PsdLayerColourContext): PixelData | undefined {
  if (!width || !height) return undefined;
  const bits = context.bitsPerChannel, maximum = bits === 16 ? 65535 : bits === 32 ? 1 : 255;
  const base = context.colorMode === 4 ? 4 : context.colorMode === 3 || context.colorMode === 7 || context.colorMode === 9 ? 3 : 1;
  const planes = new Array<Uint8Array | null>(base);
  for (let index = 0; index < base; index++) planes[index] = decodeChannel(channels.find((channel) => channel.id === index), width, height, bits, context.isPsb);
  if (!planes[0]) return undefined;
  const alphaPlane = decodeChannel(channels.find((channel) => channel.id === -1), width, height, bits, context.isPsb);
  const pixels = width * height;
  if ((context.colorMode === 1 || context.colorMode === 4) && context.lcms && (bits === 8 || bits === 16)) {
    const count = context.colorMode === 4 ? 4 : 1;
    const input = bits === 16 ? new Uint16Array(pixels * count) : new Uint8Array(pixels * count);
    const alpha = alphaPlane ? bits === 16 ? new Uint16Array(pixels) : new Uint8Array(pixels) : null;
    for (let pixel = 0; pixel < pixels; pixel++) {
      for (let channel = 0; channel < count; channel++) {
        const value = sample(planes[channel] ?? null, pixel, bits, width);
        input[pixel * count + channel] = context.colorMode === 4 ? maximum - value : value;
      }
      if (alpha) alpha[pixel] = sample(alphaPlane, pixel, bits, width);
    }
    const profile = context.iccProfile ?? (context.colorMode === 4 ? context.lcms.createCmykProfile()
      : context.lcms.createGrayProfile([0.3127, 0.329], 2.2));
    const converted = context.lcms.transform(profile, input, context.colorMode === 4 ? 'cmyk' : 'gray', bits, alpha);
    if (bits !== 16) return { width, height, data: converted };
    const sixteen = new Uint16Array(converted.length);
    for (let index = 0; index < converted.length; index++) sixteen[index] = converted[index]! * 257;
    return { width, height, data: sixteen };
  }
  const output = bits === 16 ? new Uint16Array(pixels * 4) : new Uint8ClampedArray(pixels * 4);
  for (let pixel = 0, target = 0; pixel < pixels; pixel++, target += 4) {
    let r = normalizedSample(planes, 0, pixel, bits, width, maximum), g = r, b = r;
    if (context.colorMode === 2 && context.palette) {
      const index = Math.round(r * 255); r = context.palette[index]! / 255;
      g = context.palette[256 + index]! / 255; b = context.palette[512 + index]! / 255;
    } else if (context.colorMode === 3 || context.colorMode === 7) {
      g = normalizedSample(planes, 1, pixel, bits, width, maximum);
      b = normalizedSample(planes, 2, pixel, bits, width, maximum);
    } else if (context.colorMode === 4) {
      g = normalizedSample(planes, 1, pixel, bits, width, maximum);
      b = normalizedSample(planes, 2, pixel, bits, width, maximum);
      const k = normalizedSample(planes, 3, pixel, bits, width, maximum); r *= k; g *= k; b *= k;
    } else if (context.colorMode === 9) {
      writeLabRgb(output, target, r, normalizedSample(planes, 1, pixel, bits, width, maximum),
        normalizedSample(planes, 2, pixel, bits, width, maximum), bits === 16 ? 65535 : 255);
    }
    if (context.colorMode !== 9) {
      output[target] = Math.round(Math.min(1, Math.max(0, r)) * (bits === 16 ? 65535 : 255));
      output[target + 1] = Math.round(Math.min(1, Math.max(0, g)) * (bits === 16 ? 65535 : 255));
      output[target + 2] = Math.round(Math.min(1, Math.max(0, b)) * (bits === 16 ? 65535 : 255));
    }
    const alpha = alphaPlane ? sample(alphaPlane, pixel, bits, width) : maximum;
    output[target + 3] = Math.round(Math.min(maximum, Math.max(0, Number(alpha))) * (bits === 32 ? 255 : 1));
  }
  return { width, height, data: output };
}

function maskFromChannels(channels: readonly RawChannel[], layer: AgLayer, id: -2 | -3,
  context: PsdLayerColourContext): PixelData | undefined {
  const mask = id === -2 ? layer.mask : layer.realMask;
  if (!mask) return undefined;
  const width = Math.max(0, (mask.right ?? 0) - (mask.left ?? 0));
  const height = Math.max(0, (mask.bottom ?? 0) - (mask.top ?? 0));
  if (!width || !height) return undefined;
  const plane = decodeChannel(channels.find((channel) => channel.id === id), width, height,
    context.bitsPerChannel, context.isPsb);
  if (!plane) return undefined;
  const data = new Uint8ClampedArray(width * height * 4), maximum = context.bitsPerChannel === 16 ? 65535 : context.bitsPerChannel === 32 ? 1 : 255;
  for (let pixel = 0, target = 0; pixel < width * height; pixel++, target += 4) {
    const value = Math.round(Number(sample(plane, pixel, context.bitsPerChannel, width)) * 255 / maximum);
    data[target] = value; data[target + 1] = value; data[target + 2] = value; data[target + 3] = 255;
  }
  return { width, height, data };
}

/** Decodes layer-owned channel blocks; the saved composite is never consulted. */
export function decodePsdLayerChannels(layer: AgLayer, context: PsdLayerColourContext): void {
  const raw = layer.rawData as RawLayerData | undefined;
  if (raw) {
    const width = Math.max(0, (layer.right ?? 0) - (layer.left ?? 0));
    const height = Math.max(0, (layer.bottom ?? 0) - (layer.top ?? 0));
    layer.imageData = rgbaFromChannels(raw.channels, width, height, context);
    if (layer.mask) layer.mask.imageData = maskFromChannels(raw.channels, layer, -2, context);
    if (layer.realMask) layer.realMask.imageData = maskFromChannels(raw.channels, layer, -3, context);
    delete layer.rawData;
  }
  for (const child of layer.children ?? []) decodePsdLayerChannels(child, context);
}
