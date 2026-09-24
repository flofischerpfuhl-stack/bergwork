export type RasterFormat = 'gray8' | 'rgba8' | 'rgba16';
export type PixelArray = Uint8Array | Uint16Array;

export function formatFor(channels: 1 | 4, requested?: RasterFormat): RasterFormat {
  const format = requested ?? (channels === 1 ? 'gray8' : 'rgba8');
  if ((channels === 1) !== (format === 'gray8')) {
    throw new RangeError(`Pixel format ${format} does not match ${channels} channel(s)`);
  }
  return format;
}

export function maximumFor(format: RasterFormat): 255 | 65535 {
  return format === 'rgba16' ? 65535 : 255;
}

export function makePixelArray(format: RasterFormat, length: number): PixelArray {
  return format === 'rgba16' ? new Uint16Array(length) : new Uint8Array(length);
}

export function rgba8To16(source: Uint8Array): Uint16Array {
  const result = new Uint16Array(source.length);
  for (let i = 0; i < source.length; i++) result[i] = source[i]! * 257;
  return result;
}

export function rgba16To8(source: Uint16Array): Uint8Array {
  const result = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i++) result[i] = Math.floor((source[i]! * 255 + 32767) / 65535);
  return result;
}

export function floatToRgba16(source: Float32Array): Uint16Array {
  const result = new Uint16Array(source.length);
  for (let i = 0; i < source.length; i++) result[i] = Math.round(Math.min(1, Math.max(0, source[i]!)) * 65535);
  return result;
}
