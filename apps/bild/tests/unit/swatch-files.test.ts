import { describe, expect, it } from 'vitest';
import { parseAco, parseAse, parseSwatchFile, refineCmyk, SwatchFileError, writeAse } from '../../src/io/swatchFiles';
import { cmykToRgbNaive, labToRgb, rgbToHex, rgbToLab } from '../../src/core/color/convert';

/*
 * Fixtures are written here byte by byte from the published format descriptions (Adobe Photoshop File Formats
 * Specification, "Color Swatches"; the Adobe Swatch Exchange layout), independent of the parser and writer under test.
 */

class Bytes {
  readonly parts: number[] = [];
  u16(v: number) { this.parts.push((v >> 8) & 0xff, v & 0xff); return this; }
  i16(v: number) { return this.u16(v < 0 ? v + 65536 : v); }
  u32(v: number) { this.parts.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); return this; }
  f32(v: number) { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v); this.parts.push(...new Uint8Array(b.buffer)); return this; }
  ascii(s: string) { for (const c of s) this.parts.push(c.charCodeAt(0)); return this; }
  utf16z(s: string) { for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i)); return this.u16(0); }
  bytes() { return new Uint8Array(this.parts); }
}

type AcoEntry = { space: number; w: number; x: number; y: number; z?: number; name?: string };

function aco(entries: AcoEntry[], withV2: boolean, v2Only = false): Uint8Array {
  const out = new Bytes();
  if (!v2Only) {
    out.u16(1).u16(entries.length);
    for (const e of entries) out.u16(e.space).u16(e.w).u16(e.x).u16(e.y).u16(e.z ?? 0);
  }
  if (withV2 || v2Only) {
    out.u16(2).u16(entries.length);
    for (const e of entries) {
      out.u16(e.space).u16(e.w).u16(e.x).u16(e.y).u16(e.z ?? 0);
      const name = e.name ?? '';
      out.u32(name.length + 1).utf16z(name);
    }
  }
  return out.bytes();
}

type AseEntry = { name: string; model: 'RGB ' | 'CMYK' | 'LAB ' | 'Gray'; values: number[]; type?: number };
type AseBlock = { group: string; entries: AseEntry[] } | AseEntry;

function aseEntry(out: Bytes, e: AseEntry) {
  const data = new Bytes().u16(e.name.length + 1).utf16z(e.name).ascii(e.model);
  for (const v of e.values) data.f32(v);
  data.u16(e.type ?? 2);
  out.u16(0x0001).u32(data.parts.length);
  out.parts.push(...data.parts);
}

function ase(blocks: AseBlock[]): Uint8Array {
  const count = blocks.reduce((n, b) => n + ('group' in b ? b.entries.length + 2 : 1), 0);
  const out = new Bytes().ascii('ASEF').u16(1).u16(0).u32(count);
  for (const block of blocks) {
    if ('group' in block) {
      const name = new Bytes().u16(block.group.length + 1).utf16z(block.group);
      out.u16(0xc001).u32(name.parts.length);
      out.parts.push(...name.parts);
      for (const e of block.entries) aseEntry(out, e);
      out.u16(0xc002).u32(0);
    } else aseEntry(out, block);
  }
  return out.bytes();
}

const hex = (c: { red: number; green: number; blue: number }) => rgbToHex(c);

describe('.aco (Photoshop Color Swatches)', () => {
  const entries: AcoEntry[] = [
    { space: 0, w: 65535, x: 0, y: 0, name: 'Red' },
    // HSB: hue 120° (65535 × 120/360), full saturation and brightness.
    { space: 1, w: Math.round(65535 * 120 / 360), x: 65535, y: 65535, name: 'Green HSB' },
    // CMYK: 0 = 100 % ink; 100 % cyan only.
    { space: 2, w: 0, x: 65535, y: 65535, z: 65535, name: 'Cyan' },
    // Lab: L 50.00, a −20.00, b 30.00 (signed hundredths).
    { space: 7, w: 5000, x: -2000 + 65536, y: 3000, name: 'Lab Olive' },
    // Grayscale: 2500 of 10000 black = 75 % luminance.
    { space: 8, w: 2500, x: 0, y: 0, name: 'Gray 25' },
    // Pantone (book colour): no colour values, skipped.
    { space: 3, w: 1, x: 2, y: 3, name: 'PANTONE 123' },
  ];

  it('reads version 1 (no names) and converts every colour space into sRGB', () => {
    const result = parseAco(aco(entries, false), 'Palette');
    expect(result.format).toBe('aco');
    expect(result.skipped).toBe(1);
    expect(result.approximated).toBe(true);
    const swatches = result.groups[0]!.swatches;
    expect(result.groups[0]!.name).toBe('Palette');
    expect(swatches.map((s) => s.model)).toEqual(['rgb', 'hsb', 'cmyk', 'lab', 'gray']);
    expect(swatches.map((s) => s.name)).toEqual(['Palette 1', 'Palette 2', 'Palette 3', 'Palette 4', 'Palette 5']);
    expect(hex(swatches[0]!.color)).toBe('FF0000');
    expect(hex(swatches[1]!.color)).toBe('00FF00');
    expect(hex(swatches[2]!.color)).toBe('00FFFF');
    expect(swatches[3]!.values).toEqual([50, -20, 30]);
    expect(hex(swatches[3]!.color)).toBe(hex(labToRgb({ l: 50, a: -20, b: 30 })));
    expect(hex(swatches[4]!.color)).toBe('BFBFBF');
  });

  it('prefers the named version 2 section that follows version 1', () => {
    const result = parseAco(aco(entries, true));
    expect(result.groups[0]!.swatches.map((s) => s.name)).toEqual(['Red', 'Green HSB', 'Cyan', 'Lab Olive', 'Gray 25']);
  });

  it('reads a file that holds only version 2, with non-ASCII names', () => {
    const result = parseAco(aco([{ space: 0, w: 0, x: 0, y: 65535, name: 'Blau – Grün ü' }], false, true));
    expect(result.groups[0]!.swatches[0]).toMatchObject({ name: 'Blau – Grün ü', model: 'rgb' });
    expect(hex(result.groups[0]!.swatches[0]!.color)).toBe('0000FF');
  });

  it('rejects truncated and foreign data', () => {
    const bytes = aco(entries, true);
    expect(() => parseAco(bytes.subarray(0, bytes.length - 3))).toThrow(SwatchFileError);
    expect(() => parseAco(new Uint8Array([0, 9, 0, 0]))).toThrow(SwatchFileError);
    expect(() => parseAco(new Uint8Array([0]))).toThrow(SwatchFileError);
  });
});

describe('.ase (Adobe Swatch Exchange)', () => {
  const file = ase([
    { name: 'Loose White', model: 'RGB ', values: [1, 1, 1] },
    { group: 'Brand', entries: [
      { name: 'Signal Red', model: 'RGB ', values: [0.9, 0.1, 0.2] },
      { name: 'Print Magenta', model: 'CMYK', values: [0, 1, 0, 0], type: 1 },
      { name: 'Lab Blue', model: 'LAB ', values: [0.3, 20, -60], type: 0 },
      { name: 'Mid Gray', model: 'Gray', values: [0.5] },
    ] },
  ]);

  it('reads groups, loose entries and RGB/CMYK/Lab/Gray colours', () => {
    const result = parseAse(file, 'brand-file');
    expect(result.format).toBe('ase');
    expect(result.groups.map((g) => g.name)).toEqual(['brand-file', 'Brand']);
    expect(hex(result.groups[0]!.swatches[0]!.color)).toBe('FFFFFF');
    const [red, magenta, blue, gray] = result.groups[1]!.swatches;
    expect(red!.name).toBe('Signal Red');
    expect(hex(red!.color)).toBe(hex({ red: Math.fround(0.9), green: Math.fround(0.1), blue: Math.fround(0.2) }));
    expect(magenta!.model).toBe('cmyk');
    expect(hex(magenta!.color)).toBe('FF00FF');
    // L is stored as a fraction (0.3 = 30 %).
    expect(blue!.values[0]).toBeCloseTo(30, 5);
    expect(hex(blue!.color)).toBe(hex(labToRgb({ l: 30, a: 20, b: -60 })));
    expect(hex(gray!.color)).toBe('808080');
    expect(result.approximated).toBe(true);
    expect(result.skipped).toBe(0);
  });

  it('writes .ase that matches the published layout byte for byte and reads back', () => {
    const groups = [{ name: 'Brand', swatches: [
      { id: 'a', name: 'Signal Red', color: { red: 0.9, green: 0.1, blue: 0.2 } },
      { id: 'b', name: 'Ünïcode Blue', color: { red: 0, green: 0.25, blue: 1 } },
    ] }, { name: 'Empty', swatches: [] }];
    const written = writeAse(groups);
    const expected = ase([
      { group: 'Brand', entries: [
        { name: 'Signal Red', model: 'RGB ', values: [0.9, 0.1, 0.2] },
        { name: 'Ünïcode Blue', model: 'RGB ', values: [0, 0.25, 1] },
      ] },
      { group: 'Empty', entries: [] },
    ]);
    expect(Array.from(written)).toEqual(Array.from(expected));
    const back = parseAse(written);
    expect(back.groups.map((g) => g.name)).toEqual(['Brand', 'Empty']);
    expect(back.groups[0]!.swatches.map((s) => s.name)).toEqual(['Signal Red', 'Ünïcode Blue']);
    back.groups[0]!.swatches.forEach((s, i) => {
      const source = groups[0]!.swatches[i]!.color;
      expect(s.color.red).toBeCloseTo(source.red, 6);
      expect(s.color.green).toBeCloseTo(source.green, 6);
      expect(s.color.blue).toBeCloseTo(source.blue, 6);
    });
  });

  it('detects the format by content and skips unknown models', () => {
    expect(parseSwatchFile(file).format).toBe('ase');
    expect(parseSwatchFile(aco([{ space: 0, w: 0, x: 0, y: 0 }], false)).format).toBe('aco');
    const unknown = ase([{ name: 'Odd', model: 'Gray', values: [0] }]);
    unknown.set([0x48, 0x53, 0x42, 0x20], unknown.length - 2 - 4 - 4); // model "HSB " replaces "Gray"
    expect(parseAse(unknown).skipped).toBe(1);
    expect(() => parseAse(new TextEncoder().encode('NOPE0000000000'))).toThrow(SwatchFileError);
  });

  it('converts CMYK with Little CMS and the generic CMYK profile, close to the subtractive formula', async () => {
    const result = await refineCmyk(parseAse(ase([{ name: 'Mixed', model: 'CMYK', values: [0.2, 0.5, 0.1, 0.3] }])));
    expect(result.cmykMethod).toBe('lcms');
    const color = result.groups[0]!.swatches[0]!.color, formula = cmykToRgbNaive({ c: 0.2, m: 0.5, y: 0.1, k: 0.3 });
    // The generic profile is the same subtractive model sampled through Lab, so it stays within a few 8-bit steps.
    expect(Math.abs(color.red - formula.red)).toBeLessThan(6 / 255);
    expect(Math.abs(color.green - formula.green)).toBeLessThan(6 / 255);
    expect(Math.abs(color.blue - formula.blue)).toBeLessThan(6 / 255);
    const fallback = await refineCmyk(parseAse(ase([{ name: 'M', model: 'CMYK', values: [0, 1, 0, 0] }])), async () => { throw new Error('no wasm'); });
    expect(fallback.cmykMethod).toBe('formula');
    expect(hex(fallback.groups[0]!.swatches[0]!.color)).toBe('FF00FF');
  });
});

describe('Lab conversion (D50, like Photoshop)', () => {
  it('matches reference values and round-trips', () => {
    const red = rgbToLab({ red: 1, green: 0, blue: 0 });
    expect(red.l).toBeCloseTo(54.29, 1);
    expect(red.a).toBeCloseTo(80.8, 0);
    expect(red.b).toBeCloseTo(69.89, 0);
    const white = rgbToLab({ red: 1, green: 1, blue: 1 });
    expect(white.l).toBeCloseTo(100, 3);
    expect(Math.abs(white.a)).toBeLessThan(0.01);
    for (const c of [{ red: 0.2, green: 0.6, blue: 0.4 }, { red: 0.9, green: 0.85, blue: 0.1 }, { red: 0.05, green: 0.05, blue: 0.3 }]) {
      const back = labToRgb(rgbToLab(c));
      expect(back.red).toBeCloseTo(c.red, 4);
      expect(back.green).toBeCloseTo(c.green, 4);
      expect(back.blue).toBeCloseTo(c.blue, 4);
    }
  });
});
