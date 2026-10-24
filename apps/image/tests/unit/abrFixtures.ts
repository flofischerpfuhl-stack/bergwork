/**
 * Byte-by-byte writers for test `.abr` files (v1, v2, v6 subversions 1/2), built from the published layout — no
 * third-party brush files are used. Shared by the unit tests and the brush-presets e2e spec.
 */

export class ByteWriter {
  private chunks: number[] = [];
  get length(): number { return this.chunks.length; }
  u8(value: number): this { this.chunks.push(value & 255); return this; }
  i16(value: number): this { return this.u8(value >> 8).u8(value); }
  i32(value: number): this { return this.u8(value >>> 24).u8(value >>> 16).u8(value >>> 8).u8(value); }
  f64(value: number): this { const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value); for (let i = 0; i < 8; i++) this.u8(view.getUint8(i)); return this; }
  ascii(text: string): this { for (const char of text) this.u8(char.charCodeAt(0)); return this; }
  unicode(text: string): this { this.i32(text.length + 1); for (const char of text) this.i16(char.charCodeAt(0)); return this.i16(0); }
  pascal(text: string): this { this.u8(text.length); return this.ascii(text); }
  bytes(data: ArrayLike<number>): this { for (let i = 0; i < data.length; i++) this.u8(data[i]!); return this; }
  pad(multiple: number): this { while (this.chunks.length % multiple) this.u8(0); return this; }
  toBytes(): Uint8Array { return Uint8Array.from(this.chunks); }
}

/** PackBits: runs of 3+ equal bytes become repeat packets, the rest literal packets. */
export function packBits(row: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < row.length) {
    let run = 1;
    while (i + run < row.length && run < 128 && row[i + run] === row[i]) run++;
    if (run >= 3) { out.push((1 - run) & 255, row[i]!); i += run; continue; }
    const start = i;
    while (i < row.length && i - start < 128) {
      if (i + 2 < row.length && row[i] === row[i + 1] && row[i] === row[i + 2]) break;
      i++;
    }
    out.push(i - start - 1, ...row.subarray(start, i));
  }
  return Uint8Array.from(out);
}

export interface SampleSpec {
  readonly width: number;
  readonly height: number;
  /** 8-bit values; 16-bit files store value × 257. */
  readonly data: Uint8Array;
  readonly depth?: 8 | 16 | 32;
  readonly rle?: boolean;
}

function writeSamplePixels(writer: ByteWriter, sample: SampleSpec): void {
  const depth = sample.depth ?? 8;
  writer.i16(depth).u8(sample.rle ? 1 : 0);
  const rows: Uint8Array[] = [];
  for (let y = 0; y < sample.height; y++) {
    const row = sample.data.subarray(y * sample.width, (y + 1) * sample.width);
    if (depth === 8) rows.push(row);
    else {
      const wide = new Uint8Array(row.length * (depth / 8));
      for (let x = 0; x < row.length; x++) {
        if (depth === 16) { wide[x * 2] = row[x]!; wide[x * 2 + 1] = row[x]!; } else wide.fill(row[x]!, x * 4, x * 4 + 4);
      }
      rows.push(wide);
    }
  }
  if (!sample.rle) { for (const row of rows) writer.bytes(row); return; }
  const packed = rows.map(packBits);
  for (const row of packed) writer.i16(row.length);
  for (const row of packed) writer.bytes(row);
}

export type V12Brush =
  | { readonly computed: { spacing: number; diameter: number; roundness: number; angle: number; hardness: number }; readonly name?: string }
  | { readonly sampled: SampleSpec & { spacing: number }; readonly name?: string };

/** ABR v1 (no names) or v2 (UCS-2 names for sampled brushes). */
export function abrV12(version: 1 | 2, brushes: readonly V12Brush[]): Uint8Array {
  const writer = new ByteWriter().i16(version).i16(brushes.length);
  for (const brush of brushes) {
    const body = new ByteWriter();
    if ('computed' in brush) {
      const c = brush.computed;
      body.i32(0).i16(c.spacing).i16(c.diameter).i16(c.roundness).i16(c.angle).i16(c.hardness);
      writer.i16(1);
    } else {
      const s = brush.sampled;
      body.i32(0).i16(s.spacing);
      if (version === 2) body.unicode(brush.name ?? '');
      body.u8(1).i16(0).i16(0).i16(s.height).i16(s.width).i32(0).i32(0).i32(s.height).i32(s.width);
      writeSamplePixels(body, s);
      writer.i16(2);
    }
    const bytes = body.toBytes();
    writer.i32(bytes.length).bytes(bytes);
  }
  return writer.toBytes();
}

// Descriptor values for the v6 `desc` section.
export type Desc =
  | { readonly Objc: string; readonly items: readonly (readonly [string, Desc])[] }
  | { readonly VlLs: readonly Desc[] }
  | { readonly TEXT: string }
  | { readonly UntF: string; readonly value: number }
  | { readonly bool: boolean }
  | { readonly long: number }
  | { readonly doub: number }
  | { readonly enum: readonly [string, string] };

function key(writer: ByteWriter, name: string): void {
  if (name.length === 4) writer.i32(0).ascii(name); else writer.i32(name.length).ascii(name);
}

function descValue(writer: ByteWriter, value: Desc, typed = true): void {
  if ('Objc' in value) {
    if (typed) writer.ascii('Objc');
    writer.unicode(''); key(writer, value.Objc); writer.i32(value.items.length);
    for (const [name, item] of value.items) { key(writer, name); descValue(writer, item); }
  } else if ('VlLs' in value) { writer.ascii('VlLs').i32(value.VlLs.length); for (const item of value.VlLs) descValue(writer, item); }
  else if ('TEXT' in value) writer.ascii('TEXT').unicode(value.TEXT);
  else if ('UntF' in value) writer.ascii('UntF').ascii(value.UntF).f64(value.value);
  else if ('bool' in value) writer.ascii('bool').u8(value.bool ? 1 : 0);
  else if ('long' in value) writer.ascii('long').i32(value.long);
  else if ('doub' in value) writer.ascii('doub').f64(value.doub);
  else { writer.ascii('enum'); key(writer, value.enum[0]); key(writer, value.enum[1]); }
}

export interface V6Preset {
  readonly name: string;
  /** Sampled: the sample's UUID; computed: omitted. */
  readonly uuid?: string;
  readonly diameter: number;
  readonly spacing: number;
  readonly angle?: number;
  readonly roundness?: number;
  readonly hardness?: number;
}

/** ABR v6 (Photoshop 7+): `8BIM samp` with UUID-tagged samples, then `8BIM desc` with the preset descriptor. */
export function abrV6(subversion: 1 | 2, samples: readonly (SampleSpec & { uuid: string })[], presets: readonly V6Preset[] | null,
  options: { version?: number; extraSection?: boolean } = {}): Uint8Array {
  const writer = new ByteWriter().i16(options.version ?? 6).i16(subversion);
  if (options.extraSection) writer.ascii('8BIM').ascii('phry').i32(6).bytes([1, 2, 3, 4, 5, 6]);
  const samp = new ByteWriter();
  for (const sample of samples) {
    const record = new ByteWriter().pascal(sample.uuid);
    for (let i = 0; i < (subversion === 1 ? 10 : 264); i++) record.u8(i === 0 ? 0 : 7);
    record.i32(0).i32(0).i32(sample.height).i32(sample.width);
    writeSamplePixels(record, sample);
    const bytes = record.toBytes();
    samp.i32(bytes.length).bytes(bytes).pad(4);
  }
  const sampBytes = samp.toBytes();
  writer.ascii('8BIM').ascii('samp').i32(sampBytes.length).bytes(sampBytes);
  if (presets) {
    const tip = (preset: V6Preset): Desc => ({ Objc: preset.uuid ? 'sampledBrush' : 'computedBrush', items: [
      ['Dmtr', { UntF: '#Pxl', value: preset.diameter }],
      ['Angl', { UntF: '#Ang', value: preset.angle ?? 0 }],
      ['Rndn', { UntF: '#Prc', value: preset.roundness ?? 100 }],
      ...(preset.uuid ? [] : [['Hrdn', { UntF: '#Prc', value: preset.hardness ?? 100 }] as const]),
      ['Spcn', { UntF: '#Prc', value: preset.spacing }],
      ['Intr', { bool: true }],
      ['flipX', { bool: false }],
      ...(preset.uuid ? [['sampledData', { TEXT: preset.uuid }] as const] : []),
    ] });
    const root: Desc = { Objc: 'null', items: [['Brsh', { VlLs: presets.map((preset): Desc => ({ Objc: 'brushPreset', items: [
      ['Nm  ', { TEXT: preset.name }],
      ['Brsh', tip(preset)],
      ['useTipDynamics', { bool: false }],
      ['szVr', { Objc: 'brVr', items: [['bVTy', { long: 0 }], ['jitter', { UntF: '#Prc', value: 0 }]] }],
      ['brushGroup', { enum: ['BlnM', 'Nrml'] }],
      ['opVr', { Objc: 'brVr', items: [['bVTy', { long: 2 }], ['doub', { doub: 0.5 }]] }],
    ] })) }]] };
    const desc = new ByteWriter().i32(16);
    descValue(desc, root, false);
    const bytes = desc.toBytes();
    writer.ascii('8BIM').ascii('desc').i32(bytes.length).bytes(bytes);
  }
  return writer.toBytes();
}

/** Test tips with recognisable structure. */
export function checkerTip(width: number, height: number, cell: number): Uint8Array {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? 255 : 0;
  return data;
}

export function ringTipData(size: number): Uint8Array {
  const data = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
    data[y * size + x] = d > 0.5 && d < 0.95 ? 255 : 0;
  }
  return data;
}

export function gradientTip(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = Math.round(x * 255 / Math.max(1, width - 1));
  return data;
}
