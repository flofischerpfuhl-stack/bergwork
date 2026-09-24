/**
 * Swatch files (PRODUCT-PLAN 6.1): Photoshop Color Swatches `.aco` (versions 1 and 2) and Adobe Swatch Exchange
 * `.ase` are read; `.ase` is written. Both are big-endian.
 *
 * `.aco` (Adobe Photoshop File Formats Specification, "Color Swatches"): one or two sections, each `u16 version`,
 * `u16 count`, then `count` entries of `u16 colorSpace` + four `u16` components. Version 2 follows version 1 in the
 * same file and adds `u32 length` + UTF-16BE name (length counts code units including the terminating null) after
 * each entry. Colour spaces read here: 0 RGB (0…65535), 1 HSB (hue 0…65535 ≙ 0…360°), 2 CMYK (0 = 100 % ink),
 * 7 Lab (L 0…10000, a/b signed −12800…12700 in hundredths), 8 Grayscale (0…10000 of black). Book colours (Pantone,
 * Focoltone, Trumatch, Toyo, HKS, DIC) carry no colour values and are skipped.
 *
 * `.ase`: `"ASEF"`, `u16 1`, `u16 0`, `u32 blockCount`, then blocks `u16 type` + `u32 length` + data. 0xC001 opens a
 * group (`u16 nameLength` + UTF-16BE name with null), 0xC002 closes it, 0x0001 is a colour: name, a 4-byte model
 * (`RGB `, `CMYK`, `LAB `, `Gray`), float32 components (RGB/CMYK/Gray 0…1; Lab L 0…1 ≙ 0…100 %, a/b −128…127) and
 * `u16` colour type (0 global, 1 spot, 2 normal). Gray is read as luminance (0 black, 1 white).
 *
 * Conversion into the sRGB working space (A3): RGB and HSB are exact; Lab is converted exactly from D50 Lab
 * (`labToRgb`); CMYK uses the app's generic CMYK profile through Little CMS when it loads (`refineCmyk`), otherwise
 * the same subtractive formula directly. Neither is a calibrated press profile — imported CMYK swatches are an
 * approximation and the import reports it.
 */

import type { RGB } from '../core/model/types';
import type { SwatchGroup } from '../core/color/swatches';
import { cmykToRgbNaive, hsbToRgb, labToRgb } from '../core/color/convert';

export type SwatchFileModel = 'rgb' | 'hsb' | 'cmyk' | 'lab' | 'gray';
export interface ImportedSwatch { readonly name: string; readonly model: SwatchFileModel; readonly values: readonly number[]; readonly color: RGB }
export interface ImportedSwatchGroup { readonly name: string; readonly swatches: readonly ImportedSwatch[] }
export interface SwatchFileResult {
  readonly format: 'aco' | 'ase';
  readonly groups: readonly ImportedSwatchGroup[];
  /** Entries without convertible colour values (book colours, unknown models). */
  readonly skipped: number;
  /** CMYK entries were converted with an uncalibrated model. */
  readonly approximated: boolean;
}

export class SwatchFileError extends Error {
  constructor(message: string) { super(message); this.name = 'SwatchFileError'; }
}

const MAX_ENTRIES = 20_000;

class Reader {
  private offset = 0;
  private readonly view: DataView;
  constructor(private readonly bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  get position(): number { return this.offset; }
  get remaining(): number { return this.bytes.byteLength - this.offset; }
  private need(count: number): void { if (count < 0 || this.remaining < count) throw new SwatchFileError('The swatch file is truncated.'); }
  u16(): number { this.need(2); const v = this.view.getUint16(this.offset); this.offset += 2; return v; }
  i16(): number { this.need(2); const v = this.view.getInt16(this.offset); this.offset += 2; return v; }
  u32(): number { this.need(4); const v = this.view.getUint32(this.offset); this.offset += 4; return v; }
  f32(): number { this.need(4); const v = this.view.getFloat32(this.offset); this.offset += 4; return v; }
  ascii(count: number): string { this.need(count); const s = String.fromCharCode(...this.bytes.subarray(this.offset, this.offset + count)); this.offset += count; return s; }
  utf16(units: number): string {
    this.need(units * 2);
    let text = '';
    for (let i = 0; i < units; i++) text += String.fromCharCode(this.view.getUint16(this.offset + i * 2));
    this.offset += units * 2;
    return text.replace(/\0+$/, '');
  }
  skip(count: number): void { this.need(count); this.offset += count; }
}

const unit = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

// MARK: .aco

function acoColor(space: number, w: number, x: number, y: number, z: number): { model: SwatchFileModel; values: number[]; color: RGB } | null {
  switch (space) {
    case 0: return { model: 'rgb', values: [w, x, y].map((v) => v / 65535), color: { red: w / 65535, green: x / 65535, blue: y / 65535 } };
    case 1: {
      const values = [w / 65535 * 360, x / 65535, y / 65535];
      return { model: 'hsb', values, color: hsbToRgb({ hue: values[0]!, saturation: values[1]!, brightness: values[2]! }) };
    }
    case 2: {
      // 0 is 100 % ink.
      const values = [w, x, y, z].map((v) => 1 - v / 65535);
      return { model: 'cmyk', values, color: cmykToRgbNaive({ c: values[0]!, m: values[1]!, y: values[2]!, k: values[3]! }) };
    }
    case 7: {
      const a = x > 32767 ? x - 65536 : x, b = y > 32767 ? y - 65536 : y;
      const values = [w / 100, a / 100, b / 100];
      return { model: 'lab', values, color: labToRgb({ l: values[0]!, a: values[1]!, b: values[2]! }) };
    }
    case 8: {
      const black = unit(w / 10000), level = 1 - black;
      return { model: 'gray', values: [black], color: { red: level, green: level, blue: level } };
    }
    default: return null;
  }
}

export function parseAco(bytes: Uint8Array, fallbackName = 'Swatches'): SwatchFileResult {
  const reader = new Reader(bytes);
  let version = reader.u16();
  if (version !== 1 && version !== 2) throw new SwatchFileError('This is not a Photoshop swatch file (.aco).');
  let swatches: ImportedSwatch[] = [];
  let skipped = 0;
  const readSection = (named: boolean) => {
    const count = reader.u16();
    if (count > MAX_ENTRIES) throw new SwatchFileError('The swatch file has too many colours.');
    const result: ImportedSwatch[] = [];
    let missing = 0;
    for (let i = 0; i < count; i++) {
      const space = reader.u16(), w = reader.u16(), x = reader.u16(), y = reader.u16(), z = reader.u16();
      let name = '';
      if (named) {
        const units = reader.u32();
        if (units > 4096) throw new SwatchFileError('A swatch name is too long.');
        name = reader.utf16(units);
      }
      const converted = acoColor(space, w, x, y, z);
      if (!converted) { missing++; continue; }
      result.push({ name, ...converted });
    }
    return { result, missing };
  };
  if (version === 1) {
    const first = readSection(false);
    swatches = first.result; skipped = first.missing;
    // Version 2 (with names) repeats the same colours after version 1.
    if (reader.remaining >= 4) {
      version = reader.u16();
      if (version === 2) { const second = readSection(true); swatches = second.result; skipped = second.missing; }
    }
  } else {
    const only = readSection(true);
    swatches = only.result; skipped = only.missing;
  }
  const named = swatches.map((swatch, index) => (swatch.name ? swatch : { ...swatch, name: `${fallbackName} ${index + 1}` }));
  return { format: 'aco', groups: named.length ? [{ name: fallbackName, swatches: named }] : [], skipped,
    approximated: named.some((swatch) => swatch.model === 'cmyk') };
}

// MARK: .ase

function aseColor(model: string, values: number[]): { model: SwatchFileModel; values: number[]; color: RGB } | null {
  switch (model) {
    case 'RGB ': return { model: 'rgb', values, color: { red: unit(values[0]!), green: unit(values[1]!), blue: unit(values[2]!) } };
    case 'CMYK': return { model: 'cmyk', values, color: cmykToRgbNaive({ c: values[0]!, m: values[1]!, y: values[2]!, k: values[3]! }) };
    case 'LAB ': {
      // Adobe writes L as a fraction (0.5 = 50 %); some tools write 0…100. a/b are plain.
      const l = values[0]! <= 1 ? values[0]! * 100 : values[0]!;
      return { model: 'lab', values: [l, values[1]!, values[2]!], color: labToRgb({ l, a: values[1]!, b: values[2]! }) };
    }
    case 'Gray': { const level = unit(values[0]!); return { model: 'gray', values, color: { red: level, green: level, blue: level } }; }
    default: return null;
  }
}

const ASE_COMPONENTS: Record<string, number> = { 'RGB ': 3, 'CMYK': 4, 'LAB ': 3, 'Gray': 1 };

export function parseAse(bytes: Uint8Array, fallbackName = 'Swatches'): SwatchFileResult {
  const reader = new Reader(bytes);
  if (reader.remaining < 12 || reader.ascii(4) !== 'ASEF') throw new SwatchFileError('This is not an Adobe Swatch Exchange file (.ase).');
  const major = reader.u16();
  reader.u16();
  if (major !== 1) throw new SwatchFileError('This .ase version is not supported.');
  const blocks = reader.u32();
  if (blocks > MAX_ENTRIES * 2) throw new SwatchFileError('The swatch file has too many colours.');
  const groups: { name: string; swatches: ImportedSwatch[] }[] = [];
  const loose: ImportedSwatch[] = [];
  let current: { name: string; swatches: ImportedSwatch[] } | null = null;
  let skipped = 0;
  for (let i = 0; i < blocks && reader.remaining >= 6; i++) {
    const type = reader.u16(), length = reader.u32();
    const end = reader.position + length;
    if (length > reader.remaining) throw new SwatchFileError('The swatch file is truncated.');
    if (type === 0xc001) {
      const units = length >= 2 ? reader.u16() : 0;
      current = { name: reader.utf16(units) || fallbackName, swatches: [] };
      groups.push(current);
    } else if (type === 0xc002) {
      current = null;
    } else if (type === 0x0001) {
      const units = reader.u16();
      const name = reader.utf16(units);
      const model = reader.ascii(4);
      const count = ASE_COMPONENTS[model];
      if (count === undefined) skipped++;
      else {
        const values = Array.from({ length: count }, () => reader.f32());
        const converted = aseColor(model, values);
        if (converted) (current ? current.swatches : loose).push({ name, ...converted });
        else skipped++;
      }
    }
    reader.skip(end - reader.position);
  }
  const all = [...(loose.length ? [{ name: fallbackName, swatches: loose }] : []), ...groups];
  const named = all.map((group) => ({ ...group, swatches: group.swatches.map((swatch, index) => (swatch.name ? swatch : { ...swatch, name: `${group.name} ${index + 1}` })) }));
  return { format: 'ase', groups: named, skipped, approximated: named.some((group) => group.swatches.some((swatch) => swatch.model === 'cmyk')) };
}

/** Detects the format by content (the `ASEF` signature, else an `.aco` version word). */
export function parseSwatchFile(bytes: Uint8Array, fallbackName = 'Swatches'): SwatchFileResult {
  if (bytes.byteLength >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === 'ASEF') return parseAse(bytes, fallbackName);
  return parseAco(bytes, fallbackName);
}

/**
 * Converts CMYK entries with Little CMS and the app's generic CMYK profile (the path untagged CMYK images take).
 * Falls back to the already-computed subtractive formula when the WASM module cannot load.
 */
export async function refineCmyk(result: SwatchFileResult, load?: () => Promise<{ transform16(profile: Uint8Array, input: Uint16Array, model: 'cmyk'): Uint16Array; createCmykProfile(): Uint8Array }>): Promise<SwatchFileResult & { cmykMethod: 'lcms' | 'formula' | 'none' }> {
  const cmyk = result.groups.flatMap((group) => group.swatches.filter((swatch) => swatch.model === 'cmyk'));
  if (!cmyk.length) return { ...result, cmykMethod: 'none' };
  try {
    const lcms = await (load ?? (async () => (await import('../wasm/lcms')).loadLittleCms()))();
    const input = new Uint16Array(cmyk.length * 4);
    cmyk.forEach((swatch, i) => swatch.values.forEach((v, c) => { input[i * 4 + c] = Math.round(unit(v) * 65535); }));
    const rgba = lcms.transform16(lcms.createCmykProfile(), input, 'cmyk');
    const converted = new Map<ImportedSwatch, RGB>();
    cmyk.forEach((swatch, i) => converted.set(swatch, { red: rgba[i * 4]! / 65535, green: rgba[i * 4 + 1]! / 65535, blue: rgba[i * 4 + 2]! / 65535 }));
    return { ...result, cmykMethod: 'lcms', groups: result.groups.map((group) => ({ ...group,
      swatches: group.swatches.map((swatch) => { const color = converted.get(swatch); return color ? { ...swatch, color } : swatch; }) })) };
  } catch {
    return { ...result, cmykMethod: 'formula' };
  }
}

// MARK: .ase export

/** Writes groups as `.ase` with RGB float entries (colour type normal). */
export function writeAse(groups: readonly Pick<SwatchGroup, 'name' | 'swatches'>[]): Uint8Array {
  const parts: number[] = [];
  const u16 = (v: number) => parts.push((v >> 8) & 0xff, v & 0xff);
  const u32 = (v: number) => parts.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  const f32 = (v: number) => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v); parts.push(...new Uint8Array(b.buffer)); };
  const nameBytes = (name: string) => {
    const units = [...name.slice(0, 4095)].join('');
    const out: number[] = [];
    out.push(((units.length + 1) >> 8) & 0xff, (units.length + 1) & 0xff);
    for (let i = 0; i < units.length; i++) { const c = units.charCodeAt(i); out.push(c >> 8, c & 0xff); }
    out.push(0, 0);
    return out;
  };
  const blockCount = groups.reduce((sum, group) => sum + 2 + group.swatches.length, 0);
  for (const c of 'ASEF') parts.push(c.charCodeAt(0));
  u16(1); u16(0); u32(blockCount);
  for (const group of groups) {
    const name = nameBytes(group.name);
    u16(0xc001); u32(name.length); parts.push(...name);
    for (const swatch of group.swatches) {
      const label = nameBytes(swatch.name);
      u16(0x0001); u32(label.length + 4 + 12 + 2); parts.push(...label);
      for (const c of 'RGB ') parts.push(c.charCodeAt(0));
      f32(swatch.color.red); f32(swatch.color.green); f32(swatch.color.blue);
      u16(2);
    }
    u16(0xc002); u32(0);
  }
  return new Uint8Array(parts);
}
