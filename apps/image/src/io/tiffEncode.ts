/**
 * Baseline TIFF writer for exports: chunky RGB/RGBA or CMYK, 8 or 16 bits per sample, unassociated
 * alpha (ExtraSamples = 2, matching the straight-alpha pipeline), LZW/Adobe Deflate/uncompressed,
 * resolution tags, an optional ICC profile (tag 34675) and creator tags.
 * Little-endian ("II"), one IFD, strips of about 256 KB of raw samples.
 */

import { zlibSync } from 'fflate';
import { infoTags, type ExportInfo } from './exportMetadata';

export interface TiffEncodeOptions {
  /** Write the alpha channel (RGBA) or drop it (RGB; the caller has flattened onto a matte). */
  readonly alpha: boolean;
  readonly colorModel?: 'rgb' | 'cmyk';
  readonly compression?: 'lzw' | 'deflate' | 'none';
  readonly level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  readonly dpi?: number | null;
  readonly iccProfile?: Uint8Array | null;
  readonly info?: ExportInfo | null;
}

const SHORT = 3, LONG = 4, RATIONAL = 5, ASCII = 2, UNDEFINED = 7;

interface Tag { readonly tag: number; readonly type: number; readonly count: number; readonly data: Uint8Array }

export function encodeTiff(data: Uint8Array | Uint16Array, width: number, height: number, options: TiffEncodeOptions): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError('Invalid TIFF size');
  if (data.length !== width * height * 4) throw new RangeError('TIFF pixels must be RGBA');
  const bits = data instanceof Uint16Array ? 16 : 8;
  const cmyk = options.colorModel === 'cmyk';
  if (cmyk && options.alpha) throw new RangeError('CMYK TIFF does not support an alpha channel.');
  const samples = cmyk || options.alpha ? 4 : 3;
  const bytesPerSample = bits / 8;
  const rowBytes = width * samples * bytesPerSample;
  const compression = options.compression ?? 'deflate';
  const deflate = compression === 'deflate', lzw = compression === 'lzw';
  const rowsPerStrip = Math.max(1, Math.min(height, Math.floor((256 * 1024) / rowBytes)));
  const strips: Uint8Array[] = [];
  for (let y = 0; y < height; y += rowsPerStrip) {
    const rows = Math.min(rowsPerStrip, height - y);
    const raw = new Uint8Array(rows * rowBytes);
    const view = new DataView(raw.buffer);
    for (let row = 0; row < rows; row++) {
      const source = (y + row) * width * 4, target = row * rowBytes;
      for (let x = 0; x < width; x++) {
        for (let s = 0; s < samples; s++) {
          let value = data[source + x * 4 + s]!;
          if ((deflate || lzw) && x > 0) value -= data[source + (x - 1) * 4 + s]!;
          const at = target + (x * samples + s) * bytesPerSample;
          if (bits === 16) view.setUint16(at, value & 0xffff, true); else raw[at] = value & 255;
        }
      }
    }
    strips.push(deflate ? zlibSync(raw, { level: options.level ?? 6 }) : lzw ? lzwEncode(raw) : raw);
  }

  // Layout: header, strips, IFD, out-of-line tag values.
  let at = 8;
  const stripOffsets: number[] = [];
  for (const strip of strips) { stripOffsets.push(at); at += strip.length + (strip.length & 1); }

  const tags: Tag[] = [];
  const shorts = (values: number[]) => { const b = new Uint8Array(values.length * 2); const v = new DataView(b.buffer); values.forEach((x, i) => v.setUint16(i * 2, x, true)); return b; };
  const longs = (values: number[]) => { const b = new Uint8Array(values.length * 4); const v = new DataView(b.buffer); values.forEach((x, i) => v.setUint32(i * 4, x, true)); return b; };
  const add = (tag: number, type: number, count: number, bytes: Uint8Array) => tags.push({ tag, type, count, data: bytes });
  const ascii = (value: string) => { const b = new Uint8Array(value.length + 1); for (let i = 0; i < value.length; i++) { const c = value.charCodeAt(i); b[i] = c < 0x20 || c > 0xff ? 0x3f : c; } return b; };

  add(256, LONG, 1, longs([width]));
  add(257, LONG, 1, longs([height]));
  add(258, SHORT, samples, shorts(new Array(samples).fill(bits)));
  add(259, SHORT, 1, shorts([deflate ? 8 : lzw ? 5 : 1]));
  add(262, SHORT, 1, shorts([cmyk ? 5 : 2]));
  add(273, LONG, strips.length, longs(stripOffsets));
  add(277, SHORT, 1, shorts([samples]));
  add(278, LONG, 1, longs([rowsPerStrip]));
  add(279, LONG, strips.length, longs(strips.map((strip) => strip.length)));
  if (options.dpi) {
    const rational = longs([Math.round(options.dpi * 1000), 1000]);
    add(282, RATIONAL, 1, rational); add(283, RATIONAL, 1, rational); add(296, SHORT, 1, shorts([2]));
  }
  add(284, SHORT, 1, shorts([1]));
  if (options.info) for (const [tag, value] of infoTags(options.info)) { const b = ascii(value); add(tag, ASCII, b.length, b); }
  if (deflate || lzw) add(317, SHORT, 1, shorts([2]));
  if (options.alpha) add(338, SHORT, 1, shorts([2]));
  if (options.iccProfile) add(34675, UNDEFINED, options.iccProfile.length, options.iccProfile);
  tags.sort((a, b) => a.tag - b.tag);

  const ifdAt = at;
  at += 2 + tags.length * 12 + 4;
  const valueOffsets = new Map<Tag, number>();
  for (const tag of tags) if (tag.data.length > 4) { valueOffsets.set(tag, at); at += tag.data.length + (tag.data.length & 1); }

  const out = new Uint8Array(at);
  const view = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0]);
  view.setUint32(4, ifdAt, true);
  strips.forEach((strip, index) => out.set(strip, stripOffsets[index]!));
  view.setUint16(ifdAt, tags.length, true);
  tags.forEach((tag, index) => {
    const entry = ifdAt + 2 + index * 12;
    view.setUint16(entry, tag.tag, true);
    view.setUint16(entry + 2, tag.type, true);
    view.setUint32(entry + 4, tag.count, true);
    const offset = valueOffsets.get(tag);
    if (offset === undefined) out.set(tag.data, entry + 8);
    else { view.setUint32(entry + 8, offset, true); out.set(tag.data, offset); }
  });
  view.setUint32(ifdAt + 2 + tags.length * 12, 0, true);
  return out;
}

/** A bounded TIFF 6.0 early-change LZW stream. Literal codes are intentional: predictor 2 does
 * most of the work for continuous-tone rows and this keeps the writer compact and deterministic. */
function lzwEncode(raw: Uint8Array): Uint8Array {
  const output: number[] = [];
  let byte = 0, used = 0, codeSize = 9, nextCode = 258, previous = false;
  const write = (code: number): void => {
    for (let bit = codeSize - 1; bit >= 0; bit--) {
      byte = (byte << 1) | ((code >>> bit) & 1); used++;
      if (used === 8) { output.push(byte); byte = 0; used = 0; }
    }
  };
  const clear = (): void => { write(256); codeSize = 9; nextCode = 258; previous = false; };
  clear();
  for (const value of raw) {
    write(value);
    if (previous) {
      nextCode++;
      if (nextCode === (1 << codeSize) - 1 && codeSize < 12) codeSize++;
      if (nextCode === 4096) clear();
    } else previous = true;
  }
  write(257);
  if (used) output.push(byte << (8 - used));
  return Uint8Array.from(output);
}
