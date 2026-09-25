/**
 * Photoshop brush files (`.abr`), written from the published format descriptions (Adobe's descriptor structure in
 * the Photoshop File Format specification, and the community descriptions of ABR v1/v2 and v6 sample records).
 *
 * Supported:
 * - v1 and v2 (Photoshop ≤ 6): computed (round) brushes with diameter, hardness, angle, roundness and spacing;
 *   sampled brushes with spacing, v2 names, 8/16-bit raw or PackBits samples.
 * - v6 and later (Photoshop 7 … CC, versions 6–10, subversions 1 and 2): the `samp` section's sampled tips
 *   (8/16-bit, raw or PackBits) and, from the `desc` action descriptor, preset names, diameter, spacing, angle,
 *   roundness and hardness, and computed tips. Samples are linked to presets by their UUID.
 * Not imported: brush dynamics (shape/transfer/scattering), textures and dual brushes, the `patt` section, and
 * 32-bit samples. Unknown sections are skipped. Tips larger than 2500 px are reduced (box filter) to fit.
 */

import { MAX_TIP_SIZE } from '../core/brush/tip';

export interface AbrBrush {
  readonly name: string;
  readonly kind: 'sampled' | 'computed';
  /** 8-bit coverage, 255 paints (sampled brushes only). */
  readonly image?: { readonly width: number; readonly height: number; readonly data: Uint8Array };
  /** Pixels. */
  readonly diameter: number;
  /** Fraction of the diameter; null when spacing is off. */
  readonly spacing: number | null;
  /** 0…1 (computed brushes). */
  readonly hardness: number;
  /** Degrees. */
  readonly angle: number;
  /** 0.01…1. */
  readonly roundness: number;
}

export interface AbrParseResult {
  readonly version: number;
  readonly subversion: number;
  readonly brushes: readonly AbrBrush[];
  /** Brushes that were present but could not be read (unknown type, 32-bit samples, damaged records). */
  readonly skipped: number;
}

export class AbrError extends Error {}

class Reader {
  position = 0;
  private readonly view: DataView;
  constructor(readonly bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  get remaining(): number { return this.bytes.length - this.position; }
  need(count: number): void { if (count < 0 || this.position + count > this.bytes.length) throw new AbrError('Unexpected end of brush file'); }
  u8(): number { this.need(1); return this.bytes[this.position++]!; }
  i16(): number { this.need(2); const v = this.view.getInt16(this.position); this.position += 2; return v; }
  u16(): number { this.need(2); const v = this.view.getUint16(this.position); this.position += 2; return v; }
  i32(): number { this.need(4); const v = this.view.getInt32(this.position); this.position += 4; return v; }
  u32(): number { this.need(4); const v = this.view.getUint32(this.position); this.position += 4; return v; }
  f64(): number { this.need(8); const v = this.view.getFloat64(this.position); this.position += 8; return v; }
  take(count: number): Uint8Array { this.need(count); const v = this.bytes.subarray(this.position, this.position + count); this.position += count; return v; }
  skip(count: number): void { this.need(count); this.position += count; }
  ascii(count: number): string { return String.fromCharCode(...this.take(count)); }
  /** Photoshop Unicode string: 4-byte length in UTF-16 code units, then big-endian code units (often NUL-terminated). */
  unicode(): string {
    const length = this.u32();
    if (length > 1_000_000) throw new AbrError('Implausible string length');
    let text = '';
    for (let i = 0; i < length; i++) text += String.fromCharCode(this.u16());
    return text.replace(/\0+$/, '');
  }
  pascal(): string { return this.ascii(this.u8()); }
}

export function parseAbr(bytes: Uint8Array): AbrParseResult {
  if (bytes.length < 4) throw new AbrError('Not a brush file');
  const reader = new Reader(bytes);
  const version = reader.i16();
  const second = reader.i16();
  if (version === 1 || version === 2) return parseV12(reader, version, second);
  if (version >= 6 && version <= 10) return parseV6(reader, version, second);
  throw new AbrError(`Unsupported brush file version ${version}`);
}

// MARK: v1 / v2

function parseV12(reader: Reader, version: number, count: number): AbrParseResult {
  const brushes: AbrBrush[] = [];
  let skipped = 0;
  for (let index = 0; index < count && reader.remaining >= 6; index++) {
    const type = reader.i16();
    const size = reader.u32();
    const start = reader.position, end = start + size;
    if (end > reader.bytes.length) throw new AbrError('Truncated brush record');
    try {
      if (type === 1) {
        reader.skip(4);
        const spacing = reader.i16();
        let name = '';
        // Some v2 writers store a name here as well; accept it only when the record length says so.
        if (version === 2 && end - reader.position > 10) {
          const save = reader.position;
          try { name = reader.unicode(); if (end - reader.position !== 8) { reader.position = save; name = ''; } } catch { reader.position = save; name = ''; }
        }
        const diameter = reader.i16(), roundness = reader.i16(), angle = reader.i16(), hardness = reader.i16();
        brushes.push({ name, kind: 'computed', diameter: Math.max(1, diameter), spacing: spacingValue(spacing),
          hardness: clamp(hardness / 100, 0, 1), angle: clamp(angle, -180, 180), roundness: clamp(roundness / 100, 0.01, 1) });
      } else if (type === 2) {
        reader.skip(4);
        const spacing = reader.i16();
        const name = version === 2 ? reader.unicode() : '';
        reader.skip(1 + 8);
        const top = reader.i32(), left = reader.i32(), bottom = reader.i32(), right = reader.i32();
        const image = readSample(reader, right - left, bottom - top);
        brushes.push({ name, kind: 'sampled', image, diameter: Math.max(image.width, image.height),
          spacing: spacingValue(spacing), hardness: 1, angle: 0, roundness: 1 });
      } else skipped++;
    } catch (error) {
      if (!(error instanceof AbrError)) throw error;
      skipped++;
    }
    reader.position = end;
  }
  return { version, subversion: 0, brushes, skipped };
}

// MARK: v6+

interface SampleRecord { readonly uuid: string; readonly image: { width: number; height: number; data: Uint8Array } }

function parseV6(reader: Reader, version: number, subversion: number): AbrParseResult {
  if (subversion !== 1 && subversion !== 2) throw new AbrError(`Unsupported brush file subversion ${subversion}`);
  const samples: SampleRecord[] = [];
  let presets: DescriptorPreset[] | null = null;
  let skipped = 0;
  while (reader.remaining >= 12) {
    const signature = reader.ascii(4);
    if (signature !== '8BIM' && signature !== '8B64') {
      // Sections are aligned inconsistently by different writers: look for the next signature a few bytes on.
      reader.position -= 3;
      continue;
    }
    const key = reader.ascii(4);
    const size = reader.u32();
    const start = reader.position, end = Math.min(reader.bytes.length, start + size);
    if (key === 'samp') {
      while (reader.position + 4 <= end) {
        const length = reader.u32();
        const recordEnd = reader.position + Math.ceil(length / 4) * 4;
        if (length === 0 || recordEnd > end + 3) break;
        try {
          const uuid = reader.pascal();
          reader.skip(subversion === 1 ? 10 : 264);
          const top = reader.i32(), left = reader.i32(), bottom = reader.i32(), right = reader.i32();
          samples.push({ uuid, image: readSample(reader, right - left, bottom - top) });
        } catch (error) {
          if (!(error instanceof AbrError)) throw error;
          skipped++;
        }
        reader.position = Math.min(recordEnd, end);
      }
    } else if (key === 'desc') {
      try {
        const descriptorReader = new Reader(reader.bytes.subarray(start, end));
        descriptorReader.u32(); // descriptor version (16)
        presets = descriptorPresets(readDescriptor(descriptorReader));
      } catch (error) {
        if (!(error instanceof AbrError)) throw error;
        presets = null;
      }
    }
    reader.position = end;
  }
  const byUuid = new Map(samples.map((sample) => [sample.uuid, sample]));
  const used = new Set<string>();
  const brushes: AbrBrush[] = [];
  for (const preset of presets ?? []) {
    if (preset.sampled !== null) {
      const sample = byUuid.get(preset.sampled);
      if (!sample) { skipped++; continue; }
      used.add(sample.uuid);
      brushes.push({ name: preset.name, kind: 'sampled', image: sample.image,
        diameter: preset.diameter ?? Math.max(sample.image.width, sample.image.height), spacing: preset.spacing,
        hardness: 1, angle: preset.angle, roundness: preset.roundness });
    } else {
      brushes.push({ name: preset.name, kind: 'computed', diameter: preset.diameter ?? 30, spacing: preset.spacing,
        hardness: preset.hardness, angle: preset.angle, roundness: preset.roundness });
    }
  }
  // Samples no descriptor refers to (or files without a readable descriptor) still become brushes.
  for (const sample of samples) {
    if (used.has(sample.uuid)) continue;
    brushes.push({ name: '', kind: 'sampled', image: sample.image, diameter: Math.max(sample.image.width, sample.image.height),
      spacing: 0.25, hardness: 1, angle: 0, roundness: 1 });
  }
  return { version, subversion, brushes, skipped };
}

// MARK: Sample pixels

function readSample(reader: Reader, width: number, height: number): { width: number; height: number; data: Uint8Array } {
  if (!(width >= 1 && height >= 1 && width <= 30_000 && height <= 30_000)) throw new AbrError('Invalid brush bounds');
  const depth = reader.i16();
  const compression = reader.u8();
  if (depth !== 8 && depth !== 16) throw new AbrError(`Unsupported sample depth ${depth}`);
  const bytesPerPixel = depth / 8, rowBytes = width * bytesPerPixel;
  const raw = new Uint8Array(rowBytes * height);
  if (compression === 0) raw.set(reader.take(raw.length));
  else if (compression === 1) {
    const counts: number[] = [];
    for (let row = 0; row < height; row++) counts.push(reader.u16());
    for (let row = 0; row < height; row++) {
      const packed = reader.take(counts[row]!);
      unpackBits(packed, raw.subarray(row * rowBytes, (row + 1) * rowBytes));
    }
  } else throw new AbrError(`Unsupported sample compression ${compression}`);
  let data: Uint8Array;
  if (depth === 8) data = raw;
  else {
    data = new Uint8Array(width * height);
    for (let i = 0; i < data.length; i++) data[i] = Math.round(((raw[i * 2]! << 8) | raw[i * 2 + 1]!) / 257);
  }
  return fitTip(width, height, data);
}

/** PackBits: n ≥ 0 copies n + 1 literal bytes, n in −127…−1 repeats the next byte 1 − n times, −128 is a no-op. */
export function unpackBits(input: Uint8Array, output: Uint8Array): void {
  let i = 0, o = 0;
  while (i < input.length && o < output.length) {
    const n = (input[i++]! << 24) >> 24;
    if (n >= 0) {
      const count = Math.min(n + 1, output.length - o, input.length - i);
      output.set(input.subarray(i, i + count), o);
      i += n + 1; o += count;
    } else if (n !== -128) {
      const value = input[i++] ?? 0, count = Math.min(1 - n, output.length - o);
      output.fill(value, o, o + count);
      o += count;
    }
  }
}

/** Box-reduces tips above the engine's 2500 px limit. */
function fitTip(width: number, height: number, data: Uint8Array): { width: number; height: number; data: Uint8Array } {
  const factor = Math.ceil(Math.max(width, height) / MAX_TIP_SIZE);
  if (factor <= 1) return { width, height, data };
  const w = Math.ceil(width / factor), h = Math.ceil(height / factor), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0, count = 0;
    for (let sy = y * factor; sy < Math.min(height, (y + 1) * factor); sy++) {
      for (let sx = x * factor; sx < Math.min(width, (x + 1) * factor); sx++) { sum += data[sy * width + sx]!; count++; }
    }
    out[y * w + x] = Math.round(sum / count);
  }
  return { width: w, height: h, data: out };
}

// MARK: Action descriptors (Photoshop File Format specification, "Descriptor structure")

type DescriptorValue =
  | { readonly type: 'descriptor'; readonly classId: string; readonly items: ReadonlyMap<string, DescriptorValue> }
  | { readonly type: 'list'; readonly values: readonly DescriptorValue[] }
  | { readonly type: 'number'; readonly value: number; readonly unit?: string }
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'bool'; readonly value: boolean }
  | { readonly type: 'other' };

function readKey(reader: Reader): string {
  const length = reader.u32();
  if (length > 10_000) throw new AbrError('Implausible descriptor key');
  return reader.ascii(length === 0 ? 4 : length);
}

function readDescriptor(reader: Reader, depth = 0): DescriptorValue & { type: 'descriptor' } {
  if (depth > 32) throw new AbrError('Descriptor nesting too deep');
  reader.unicode();
  const classId = readKey(reader);
  const count = reader.u32();
  if (count > 100_000) throw new AbrError('Implausible descriptor size');
  const items = new Map<string, DescriptorValue>();
  for (let i = 0; i < count; i++) {
    const key = readKey(reader);
    items.set(key, readValue(reader, reader.ascii(4), depth));
  }
  return { type: 'descriptor', classId, items };
}

function readValue(reader: Reader, type: string, depth: number): DescriptorValue {
  switch (type) {
    case 'Objc': case 'GlbO': return readDescriptor(reader, depth + 1);
    case 'VlLs': {
      const count = reader.u32();
      if (count > 1_000_000) throw new AbrError('Implausible list size');
      const values: DescriptorValue[] = [];
      for (let i = 0; i < count; i++) values.push(readValue(reader, reader.ascii(4), depth + 1));
      return { type: 'list', values };
    }
    case 'doub': return { type: 'number', value: reader.f64() };
    case 'UntF': { const unit = reader.ascii(4); return { type: 'number', unit, value: reader.f64() }; }
    case 'UnFl': { reader.ascii(4); const count = reader.u32(); reader.skip(count * 8); return { type: 'other' }; }
    case 'TEXT': return { type: 'text', value: reader.unicode() };
    case 'enum': readKey(reader); readKey(reader); return { type: 'other' };
    case 'long': return { type: 'number', value: reader.i32() };
    case 'comp': reader.skip(8); return { type: 'other' };
    case 'bool': return { type: 'bool', value: reader.u8() !== 0 };
    case 'type': case 'GlbC': reader.unicode(); readKey(reader); return { type: 'other' };
    case 'alis': case 'tdta': case 'Pth ': reader.skip(reader.u32()); return { type: 'other' };
    case 'obj ': {
      const count = reader.u32();
      for (let i = 0; i < count; i++) {
        const form = reader.ascii(4);
        if (form === 'prop') { reader.unicode(); readKey(reader); readKey(reader); }
        else if (form === 'Clss') { reader.unicode(); readKey(reader); }
        else if (form === 'Enmr') { reader.unicode(); readKey(reader); readKey(reader); readKey(reader); }
        else if (form === 'rele') { reader.unicode(); readKey(reader); reader.skip(4); }
        else if (form === 'Idnt' || form === 'indx') reader.skip(4);
        else if (form === 'name') { reader.unicode(); readKey(reader); reader.unicode(); }
        else throw new AbrError(`Unknown reference form ${form}`);
      }
      return { type: 'other' };
    }
    default: throw new AbrError(`Unknown descriptor type ${type}`);
  }
}

interface DescriptorPreset {
  readonly name: string;
  readonly sampled: string | null;
  readonly diameter: number | null;
  readonly spacing: number | null;
  readonly hardness: number;
  readonly angle: number;
  readonly roundness: number;
}

function descriptorPresets(root: DescriptorValue & { type: 'descriptor' }): DescriptorPreset[] {
  const list = root.items.get('Brsh');
  if (list?.type !== 'list') return [];
  const presets: DescriptorPreset[] = [];
  for (const value of list.values) {
    if (value.type !== 'descriptor') continue;
    const tip = value.items.get('Brsh');
    if (tip?.type !== 'descriptor') continue;
    const number = (key: string) => { const item = tip.items.get(key); return item?.type === 'number' ? item.value : null; };
    const text = (from: DescriptorValue & { type: 'descriptor' }, key: string) => { const item = from.items.get(key); return item?.type === 'text' ? item.value : null; };
    const spacing = number('Spcn');
    presets.push({
      name: text(value, 'Nm  ') ?? '',
      sampled: text(tip, 'sampledData'),
      diameter: number('Dmtr'),
      spacing: spacingValue(spacing ?? 25),
      hardness: clamp((number('Hrdn') ?? 100) / 100, 0, 1),
      angle: clamp(number('Angl') ?? 0, -180, 180),
      roundness: clamp((number('Rndn') ?? 100) / 100, 0.01, 1),
    });
  }
  return presets;
}

function spacingValue(percent: number): number | null {
  return percent > 0 ? clamp(percent / 100, 0.01, 10) : null;
}

function clamp(value: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, Number.isFinite(value) ? value : lo)); }
