/**
 * ag-psd 31 reads 16-bit data but only emits 8-bit channels. This structural post-pass restores native
 * RGBA16 layer samples where available and expands rasterized/mask/composite samples to valid 16-bit channels.
 */

import { unzlibSync } from 'fflate';

class Reader {
  offset = 0;
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  u16(): number { const value = this.view.getUint16(this.offset); this.offset += 2; return value; }
  i16(): number { const value = this.view.getInt16(this.offset); this.offset += 2; return value; }
  u32(): number { const value = this.view.getUint32(this.offset); this.offset += 4; return value; }
  i32(): number { const value = this.view.getInt32(this.offset); this.offset += 4; return value; }
  u64(): number { const high = this.u32(), low = this.u32(); return high * 0x1_0000_0000 + low; }
  skip(length: number): void { this.offset += length; if (this.offset > this.bytes.length) throw new RangeError('Truncated PSD'); }
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0; for (const part of parts) { output.set(part, at); at += part.length; } return output;
}

function lengthBytes(value: number, large: boolean): Uint8Array {
  const bytes = new Uint8Array(large ? 8 : 4), view = new DataView(bytes.buffer);
  if (large) { view.setUint32(0, Math.floor(value / 0x1_0000_0000)); view.setUint32(4, value); }
  else view.setUint32(0, value);
  return bytes;
}

function decodePackBits(source: Uint8Array, expected: number): Uint8Array {
  const output = new Uint8Array(expected); let input = 0, written = 0;
  while (input < source.length && written < expected) {
    const header = source[input++]!;
    if (header <= 127) { const count = header + 1; output.set(source.subarray(input, input + count), written); input += count; written += count; }
    else if (header >= 129) { const count = 257 - header, value = source[input++]!; output.fill(value, written, written + count); written += count; }
  }
  if (written !== expected) throw new RangeError('Invalid PSD PackBits channel');
  return output;
}

function channel8(bytes: Uint8Array, width: number, height: number, large: boolean): Uint8Array {
  if (!width || !height) return new Uint8Array();
  const reader = new Reader(bytes), compression = reader.u16();
  if (compression === 0) return bytes.subarray(2, 2 + width * height);
  if (compression === 2) {
    const output = unzlibSync(bytes.subarray(2));
    if (output.length !== width * height) throw new RangeError('Invalid PSD ZIP channel');
    return output;
  }
  if (compression !== 1) throw new Error(`Cannot promote PSD compression ${compression} to 16 bit`);
  const lengths = new Uint32Array(height);
  for (let row = 0; row < height; row++) lengths[row] = large ? reader.u32() : reader.u16();
  const output = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    const length = lengths[row]!, decoded = decodePackBits(bytes.subarray(reader.offset, reader.offset + length), width);
    output.set(decoded, row * width); reader.skip(length);
  }
  return output;
}

function raw16(samples: Uint8Array | Uint16Array): Uint8Array {
  const output = new Uint8Array(2 + samples.length * 2);
  // Compression 0, followed by big-endian channel samples.
  for (let index = 0; index < samples.length; index++) {
    const value = samples instanceof Uint16Array ? samples[index]! : samples[index]! * 257;
    output[2 + index * 2] = value >>> 8; output[3 + index * 2] = value & 0xff;
  }
  return output;
}

export interface Native16Layer {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint16Array;
}

function matchingNativeLayer(channels: ReadonlyMap<number, Uint8Array>, width: number, height: number,
  candidates: readonly Native16Layer[]): Native16Layer | undefined {
  const candidateChannels = [...channels].filter(([id]) => id === -1 || id >= 0 && id <= 2);
  return candidates.find((candidate) => {
    if (candidate.width !== width || candidate.height !== height || candidate.rgba.length !== width * height * 4) return false;
    for (const [id, samples] of candidateChannels) {
      const component = id === -1 ? 3 : id;
      for (let pixel = 0; pixel < samples.length; pixel++) {
        if (Math.round(candidate.rgba[pixel * 4 + component]! * 255 / 65535) !== samples[pixel]) return false;
      }
    }
    return true;
  });
}

function nativeChannel(layer: Native16Layer | undefined, id: number): Uint16Array | undefined {
  if (!layer) return undefined;
  const component = id === -1 ? 3 : id;
  if (component < 0 || component > 3) return undefined;
  const output = new Uint16Array(layer.width * layer.height);
  for (let pixel = 0; pixel < output.length; pixel++) output[pixel] = layer.rgba[pixel * 4 + component]!;
  return output;
}

interface ChannelRecord { readonly id: number; readonly lengthAt: number; readonly length: number }
interface LayerRecord { readonly width: number; readonly height: number; readonly maskWidth: number; readonly maskHeight: number;
  readonly channels: readonly ChannelRecord[] }

/** Promotes an ag-psd-generated RGB PSD/PSB from 8 to 16 bits per channel. */
function compositeRaw(rgba: Uint8Array, width: number, height: number, channels: number, bits: 8 | 16): Uint8Array {
  if (rgba.length !== width * height * 4) throw new RangeError('PSD composite pixel count does not match');
  const sampleBytes = bits / 8, output = new Uint8Array(2 + width * height * channels * sampleBytes);
  let at = 2;
  for (let channel = 0; channel < channels; channel++) for (let pixel = 0; pixel < width * height; pixel++) {
    const value = rgba[pixel * 4 + channel]!;
    output[at++] = value;
    if (bits === 16) output[at++] = value;
  }
  return output;
}

function compositeOffset(bytes: Uint8Array): { offset: number; width: number; height: number; channels: number } {
  const source = new Reader(bytes); source.skip(12);
  const channels = source.u16(), height = source.u32(), width = source.u32(); source.skip(4);
  source.skip(source.u32()); source.skip(source.u32());
  const large = bytes[5] === 2, length = large ? source.u64() : source.u32();
  return { offset: source.offset + length + (length & 1), width, height, channels };
}

/** Replaces ag-psd's merged image (its PSB RLE scratch buffer is undersized for narrow images). */
export function replacePsdComposite(bytes: Uint8Array, rgba: Uint8Array, bits: 8 | 16 = 8): Uint8Array {
  const info = compositeOffset(bytes);
  return join([bytes.subarray(0, info.offset), compositeRaw(rgba, info.width, info.height, info.channels, bits)]);
}

export function promotePsdTo16(bytes: Uint8Array, compositeRgba: Uint8Array,
  nativeLayers: readonly Native16Layer[] = []): Uint8Array {
  const source = new Reader(bytes);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== '8BPS') throw new Error('Invalid PSD output');
  source.skip(4); const version = source.u16(), large = version === 2;
  if (version !== 1 && version !== 2) throw new Error('Invalid PSD version');
  source.skip(6); const compositeChannels = source.u16(), height = source.u32(), width = source.u32();
  if (source.u16() !== 8) throw new Error('PSD promotion expects 8-bit input');
  source.skip(2);
  const colorLength = source.u32(); source.skip(colorLength);
  const resourceLength = source.u32(); source.skip(resourceLength);
  const outerLengthAt = source.offset, outerLength = large ? source.u64() : source.u32(), outerStart = source.offset;
  const layerLengthAt = source.offset, layerLength = large ? source.u64() : source.u32(), layerStart = source.offset;
  const count = Math.abs(source.i16()), recordsStart = source.offset;
  const records: LayerRecord[] = [];
  for (let index = 0; index < count; index++) {
    const top = source.i32(), left = source.i32(), bottom = source.i32(), right = source.i32();
    const channelCount = source.u16(), channels: ChannelRecord[] = [];
    for (let channel = 0; channel < channelCount; channel++) {
      const id = source.i16(), lengthAt = source.offset, length = large ? source.u64() : source.u32();
      channels.push({ id, lengthAt, length });
    }
    source.skip(12); // signature, blend key, opacity/clipping/flags/filler
    const extraLength = source.u32(), extraStart = source.offset;
    let maskWidth = 0, maskHeight = 0;
    if (extraLength >= 4) {
      const maskLength = source.u32();
      if (maskLength >= 18) { const mt = source.i32(), ml = source.i32(), mb = source.i32(), mr = source.i32();
        maskWidth = Math.max(0, mr - ml); maskHeight = Math.max(0, mb - mt); }
    }
    source.offset = extraStart + extraLength;
    records.push({ width: Math.max(0, right - left), height: Math.max(0, bottom - top), maskWidth, maskHeight, channels });
  }
  const channelStart = source.offset, mutableRecords = bytes.slice(recordsStart, channelStart), promotedChannels: Uint8Array[] = [];
  let channelAt = channelStart;
  for (const record of records) {
    const decoded = new Map<number, Uint8Array>(), encoded: { record: ChannelRecord; samples: Uint8Array }[] = [];
    for (const channel of record.channels) {
      const channelEnd = channelAt + channel.length;
      if (channelEnd > layerStart + layerLength) throw new RangeError('Truncated PSD layer channel');
      const channelWidth = channel.id === -2 ? record.maskWidth : record.width;
      const channelHeight = channel.id === -2 ? record.maskHeight : record.height;
      const samples = channel8(bytes.subarray(channelAt, channelEnd), channelWidth, channelHeight, large);
      decoded.set(channel.id, samples); encoded.push({ record: channel, samples }); channelAt = channelEnd;
    }
    const native = matchingNativeLayer(decoded, record.width, record.height, nativeLayers);
    for (const channel of encoded) {
      const promoted = raw16(nativeChannel(native, channel.record.id) ?? channel.samples);
      promotedChannels.push(promoted);
      const relative = channel.record.lengthAt - recordsStart, view = new DataView(mutableRecords.buffer);
      if (large) { view.setUint32(relative, 0); view.setUint32(relative + 4, promoted.length); }
      else view.setUint32(relative, promoted.length);
    }
  }
  const newLayerBody = join([bytes.subarray(layerStart, recordsStart), mutableRecords, ...promotedChannels]);
  const layerPadding = new Uint8Array((4 - (newLayerBody.length & 3)) & 3);
  const newLayer = join([newLayerBody, layerPadding]);
  const oldLayerEnd = layerStart + layerLength;
  const outerTail = bytes.subarray(oldLayerEnd, outerStart + outerLength);
  const newOuterBody = join([lengthBytes(newLayer.length, large), newLayer, outerTail]);
  const outerPadding = new Uint8Array(newOuterBody.length & 1);
  const newOuter = join([newOuterBody, outerPadding]);

  const composite16 = compositeRaw(compositeRgba, width, height, compositeChannels, 16);
  const prefix = bytes.slice(0, outerLengthAt);
  new DataView(prefix.buffer).setUint16(22, 16);
  return join([prefix, lengthBytes(newOuterBody.length, large), newOuter, composite16]);
}
