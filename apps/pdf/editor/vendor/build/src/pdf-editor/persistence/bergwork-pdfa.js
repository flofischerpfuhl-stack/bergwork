// berg:work: PDF/A-2b (or -3b when the PDF carries attachments) from finished
// export bytes, in pdf-lib alone (no engine change). What the conversion does:
//   - fonts: every font is embedded. A missing Helvetica/Times/Courier (and
//     Arial, Times New Roman, Courier New, Calibri, Cambria, Georgia, Segoe UI)
//     is replaced by the metric-compatible bundled face (Liberation, Carlito,
//     Caladea, Gelasio, Selawik) as an embedded TrueType subset; any other
//     missing font stops the conversion with its name.
//   - colour: an sRGB OutputIntent (a generated ICC v2 profile) unless the PDF
//     already has a PDF/A OutputIntent; DeviceCMYK content without a CMYK
//     intent stops the conversion (no colour conversion here).
//   - XMP metadata with pdfaid, consistent with the Info dictionary.
//   - JavaScript and other forbidden actions, additional actions (/AA), XFA,
//     NeedAppearances, transfer functions and image interpolation are removed;
//     annotations get the Print flag and an appearance.
// Encrypted PDFs are refused; the caller decrypts before (the export does).

import { subsetTrueTypeFont } from '../ocr/truetype-subset.js';
import { classifySourceFont } from '../text/standard-font-fallback.js';

export class PdfAConversionError extends Error {
  constructor(reasons) {
    super(`This PDF cannot be saved as PDF/A: ${reasons.join(' ')}`);
    this.name = 'PdfAConversionError';
    this.reasons = reasons;
  }
}

// ---------------------------------------------------------------------------
// Font replacement table: normalised family name -> bundled file stem.

const STANDARD_SANS = 'LiberationSans';
const REPLACEMENT_FAMILIES = [
  [/^(helvetica|helveticalt|helveticaltstd|helveticastd|arial|arialmt|arimo|liberationsans|nimbussans|nimbussansl)$/u, STANDARD_SANS],
  [/^(arialnarrow|helveticanarrow|liberationsansnarrow|nimbussansnarrow)$/u, 'LiberationSansNarrow'],
  [/^(times|timesroman|timesltstd|timesnewroman|timesnewromanps|timesnewromanpsmt|timesnewromanmt|tinos|liberationserif|nimbusroman|nimbusromno9l)$/u, 'LiberationSerif'],
  [/^(courier|courierstd|courierltstd|couriernew|couriernewps|couriernewpsmt|cousine|liberationmono|nimbusmono|nimbusmonl)$/u, 'LiberationMono'],
  [/^calibri$/u, 'Carlito'],
  [/^cambria$/u, 'Caladea'],
  [/^georgia$/u, 'Gelasio'],
  [/^segoeui$/u, 'Selawik'],
];
// Faces a family has in the bundle (Selawik has no italics).
const FAMILY_FACES = { Selawik: ['Regular', 'Bold'] };

// "Roman" stays: it is part of "Times New Roman" ("Times-Roman" is split at the hyphen).
const STYLE_WORDS = /(boldoblique|bolditalic|bold|italic|oblique|regular|normal|mt|ps)$/u;

// Symbol and ZapfDingbats have no metric-compatible free face. Their glyphs
// come from DejaVu Sans, embedded as a symbolic TrueType whose advance widths
// are set to the original widths, so the text keeps its layout.
const SYMBOLIC_STANDARD = [[/^(symbol|symbolmt)$/u, 'Symbol'], [/^(zapfdingbats|zapfdingbatsitc|dingbats|itczapfdingbats)$/u, 'ZapfDingbats']];
export const SYMBOL_SOURCE_FONT = 'DejaVuSans.ttf';
export function symbolicStandardFont(baseFont) {
  const family = String(baseFont || '').replace(/^[A-Z]{6}\+/u, '').toLowerCase().replace(/[\s_-]/gu, '');
  return SYMBOLIC_STANDARD.find(([pattern]) => pattern.test(family))?.[1] || null;
}

// "ABCDEF+Arial,BoldItalic" -> { family: 'arial', bold: true, italic: true }
export function parseFontName(baseFont) {
  let name = String(baseFont || '').replace(/^[A-Z]{6}\+/u, '');
  const lower = name.toLowerCase();
  const bold = /bold|black|heavy|semibold|demi/u.test(lower);
  const italic = /italic|oblique|kursiv/u.test(lower);
  name = lower.split(/[,]/u)[0];
  let family = name.replace(/[\s_]/gu, '');
  // "timesnewromanps-bolditalicmt", "helvetica-boldoblique", "arial-boldmt"
  family = family.split('-')[0];
  let previous;
  do {
    previous = family;
    if (family.length > 4) family = family.replace(STYLE_WORDS, '');
  } while (family !== previous && family.length > 4);
  if (lower.startsWith('times-') || lower === 'times-roman') family = 'times';
  return { family, bold, italic };
}

export function replacementFontFile(baseFont, flags = 0) {
  const { family, bold: nameBold, italic: nameItalic } = parseFontName(baseFont);
  const match = REPLACEMENT_FAMILIES.find(([pattern]) => pattern.test(family));
  if (!match) return null;
  const stem = match[1];
  const bold = nameBold || Boolean(flags & (1 << 18));
  const italic = nameItalic || Boolean(flags & 64);
  let face = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular';
  const faces = FAMILY_FACES[stem];
  if (faces && !faces.includes(face)) face = bold ? 'Bold' : 'Regular';
  return { file: `${stem}-${face}.ttf`, stem, face, serif: stem === 'LiberationSerif' || stem === 'Caladea' || stem === 'Gelasio', mono: stem === 'LiberationMono' };
}

// Any other missing font that gives its widths: the closest Liberation face
// (sans, serif or mono, bold, italic), its advances set to those widths.
export function lookalikeFontFile(baseFont, flags = 0) {
  const traits = { fixedPitch: Boolean(flags & 1), serif: Boolean(flags & 2), italic: Boolean(flags & 64), bold: Boolean(flags & (1 << 18)) };
  const { family, bold, italic } = classifySourceFont(baseFont, traits);
  const stem = family === 'courier' ? 'LiberationMono' : family === 'times' ? 'LiberationSerif' : STANDARD_SANS;
  const face = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular';
  return { file: `${stem}-${face}.ttf`, stem, face, serif: stem === 'LiberationSerif', mono: stem === 'LiberationMono', lookalike: true };
}

// ---------------------------------------------------------------------------
// Encodings and glyph names.

const AGL = (() => {
  const map = new Map();
  for (let code = 65; code <= 90; code += 1) map.set(String.fromCharCode(code), code);
  for (let code = 97; code <= 122; code += 1) map.set(String.fromCharCode(code), code);
  ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
    .forEach((name, index) => map.set(name, 48 + index));
  const pairs = `space 20 exclam 21 quotedbl 22 numbersign 23 dollar 24 percent 25 ampersand 26 quotesingle 27
    quoteright 2019 parenleft 28 parenright 29 asterisk 2a plus 2b comma 2c hyphen 2d period 2e slash 2f colon 3a
    semicolon 3b less 3c equal 3d greater 3e question 3f at 40 bracketleft 5b backslash 5c bracketright 5d
    asciicircum 5e underscore 5f grave 60 quoteleft 2018 braceleft 7b bar 7c braceright 7d asciitilde 7e
    exclamdown a1 cent a2 sterling a3 currency a4 yen a5 brokenbar a6 section a7 dieresis a8 copyright a9
    ordfeminine aa guillemotleft ab logicalnot ac registered ae macron af degree b0 plusminus b1 twosuperior b2
    threesuperior b3 acute b4 mu b5 paragraph b6 periodcentered b7 cedilla b8 onesuperior b9 ordmasculine ba
    guillemotright bb onequarter bc onehalf bd threequarters be questiondown bf Agrave c0 Aacute c1
    Acircumflex c2 Atilde c3 Adieresis c4 Aring c5 AE c6 Ccedilla c7 Egrave c8 Eacute c9 Ecircumflex ca
    Edieresis cb Igrave cc Iacute cd Icircumflex ce Idieresis cf Eth d0 Ntilde d1 Ograve d2 Oacute d3
    Ocircumflex d4 Otilde d5 Odieresis d6 multiply d7 Oslash d8 Ugrave d9 Uacute da Ucircumflex db Udieresis dc
    Yacute dd Thorn de germandbls df agrave e0 aacute e1 acircumflex e2 atilde e3 adieresis e4 aring e5 ae e6
    ccedilla e7 egrave e8 eacute e9 ecircumflex ea edieresis eb igrave ec iacute ed icircumflex ee idieresis ef
    eth f0 ntilde f1 ograve f2 oacute f3 ocircumflex f4 otilde f5 odieresis f6 divide f7 oslash f8 ugrave f9
    uacute fa ucircumflex fb udieresis fc yacute fd thorn fe ydieresis ff fraction 2044 florin 192
    quotedblleft 201c guilsinglleft 2039 guilsinglright 203a fi fb01 fl fb02 endash 2013 dagger 2020
    daggerdbl 2021 bullet 2022 quotesinglbase 201a quotedblbase 201e quotedblright 201d ellipsis 2026
    perthousand 2030 circumflex 2c6 tilde 2dc breve 2d8 dotaccent 2d9 ring 2da hungarumlaut 2dd ogonek 2db
    caron 2c7 emdash 2014 Lslash 141 lslash 142 OE 152 oe 153 dotlessi 131 Scaron 160 scaron 161 Zcaron 17d
    zcaron 17e Ydieresis 178 Euro 20ac trademark 2122 minus 2212 notequal 2260 infinity 221e lessequal 2264
    greaterequal 2265 partialdiff 2202 summation 2211 product 220f pi 3c0 integral 222b Omega 2126 radical 221a
    approxequal 2248 Delta 2206 lozenge 25ca Omegagreek 3a9 nbspace a0 mugreek 3bc`.trim().split(/\s+/u);
  for (let index = 0; index + 1 < pairs.length; index += 2) map.set(pairs[index], parseInt(pairs[index + 1], 16));
  return map;
})();

const AGL_NAME = (() => {
  const names = new Map();
  for (const [name, code] of AGL) if (!names.has(code)) names.set(code, name);
  return names;
})();

export function glyphNameToUnicode(name) {
  const value = String(name || '');
  if (AGL.has(value)) return AGL.get(value);
  const uni = /^uni([0-9A-Fa-f]{4})$/u.exec(value) || /^u([0-9A-Fa-f]{4,6})$/u.exec(value);
  if (uni) return parseInt(uni[1], 16);
  return 0;
}

const STANDARD_ENCODING = (() => {
  const table = new Array(256).fill('');
  for (let code = 32; code <= 126; code += 1) {
    const name = AGL_NAME.get(code);
    if (name) table[code] = name;
  }
  table[39] = 'quoteright';
  table[96] = 'quoteleft';
  const high = `161 exclamdown 162 cent 163 sterling 164 fraction 165 yen 166 florin 167 section 168 currency
    169 quotesingle 170 quotedblleft 171 guillemotleft 172 guilsinglleft 173 guilsinglright 174 fi 175 fl
    177 endash 178 dagger 179 daggerdbl 180 periodcentered 182 paragraph 183 bullet 184 quotesinglbase
    185 quotedblbase 186 quotedblright 187 guillemotright 188 ellipsis 189 perthousand 191 questiondown 193 grave
    194 acute 195 circumflex 196 tilde 197 macron 198 breve 199 dotaccent 200 dieresis 202 ring 203 cedilla
    205 hungarumlaut 206 ogonek 207 caron 208 emdash 225 AE 227 ordfeminine 232 Lslash 233 Oslash 234 OE
    235 ordmasculine 241 ae 245 dotlessi 248 lslash 249 oslash 250 oe 251 germandbls`.trim().split(/\s+/u);
  for (let index = 0; index + 1 < high.length; index += 2) table[Number(high[index])] = high[index + 1];
  return table;
})();

function singleByteTable(label) {
  const table = new Array(256).fill(0);
  let decoder = null;
  try { decoder = new TextDecoder(label); } catch { decoder = null; }
  for (let code = 32; code < 256; code += 1) {
    if (!decoder) { table[code] = code; continue; }
    const text = decoder.decode(new Uint8Array([code]));
    table[code] = text.length === 1 ? text.charCodeAt(0) : 0;
  }
  return table;
}
let winAnsiTable = null;
let macRomanTable = null;
const winAnsiUnicode = () => (winAnsiTable ||= singleByteTable('windows-1252'));
const macRomanUnicode = () => (macRomanTable ||= singleByteTable('macintosh'));
const standardUnicode = () => STANDARD_ENCODING.map(name => glyphNameToUnicode(name));

// ---------------------------------------------------------------------------
// TrueType metrics (the subsetter in ../ocr writes the embedded program).

const viewOf = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export function parseTrueType(bytes, { symbolic = false } = {}) {
  const view = viewOf(bytes);
  if (view.getUint32(0) !== 0x00010000) throw new Error('Only TrueType outlines can be embedded.');
  const tables = new Map();
  for (let index = 0; index < view.getUint16(4); index += 1) {
    const record = 12 + index * 16;
    const tag = String.fromCharCode(...bytes.subarray(record, record + 4));
    tables.set(tag, { offset: view.getUint32(record + 8), length: view.getUint32(record + 12) });
  }
  const table = tag => {
    const entry = tables.get(tag);
    if (!entry) throw new Error(`The font has no ${tag} table.`);
    return entry.offset;
  };
  const head = table('head');
  const unitsPerEm = view.getUint16(head + 18) || 1000;
  const bbox = [view.getInt16(head + 36), view.getInt16(head + 38), view.getInt16(head + 40), view.getInt16(head + 42)];
  const hhea = table('hhea');
  const longMetrics = view.getUint16(hhea + 34);
  const hmtx = table('hmtx');
  const post = table('post');
  const italicAngle = view.getInt32(post + 4) / 65536;
  const fixedPitch = view.getUint32(post + 12) !== 0;
  let ascent = view.getInt16(hhea + 4);
  let descent = view.getInt16(hhea + 6);
  let capHeight = ascent * 0.7;
  if (tables.has('OS/2')) {
    const os2 = table('OS/2');
    const version = view.getUint16(os2);
    ascent = view.getInt16(os2 + 68);
    descent = view.getInt16(os2 + 70);
    if (version >= 2) capHeight = view.getInt16(os2 + 88);
  }
  // Unicode -> glyph from the (3,1) or (0,x) format 4 subtable.
  const cmap = table('cmap');
  const glyphForCode = new Map();
  for (let index = 0; index < view.getUint16(cmap + 2); index += 1) {
    const platform = view.getUint16(cmap + 4 + index * 8);
    const encoding = view.getUint16(cmap + 6 + index * 8);
    const sub = cmap + view.getUint32(cmap + 8 + index * 8);
    const wanted = symbolic ? platform === 3 && encoding === 0 : platform === 0 || (platform === 3 && encoding === 1);
    if (!wanted || view.getUint16(sub) !== 4) continue;
    const segments = view.getUint16(sub + 6) / 2;
    const ends = sub + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const rangeOffsets = deltas + segments * 2;
    for (let segment = 0; segment < segments; segment += 1) {
      const start = view.getUint16(starts + segment * 2);
      const end = view.getUint16(ends + segment * 2);
      const delta = view.getInt16(deltas + segment * 2);
      const rangeOffset = view.getUint16(rangeOffsets + segment * 2);
      for (let code = start; code <= end && code < 0xffff; code += 1) {
        let glyph = (code + delta) & 0xffff;
        if (rangeOffset) {
          const raw = view.getUint16(rangeOffsets + segment * 2 + rangeOffset + (code - start) * 2);
          glyph = raw ? (raw + delta) & 0xffff : 0;
        }
        if (glyph && !glyphForCode.has(code)) glyphForCode.set(code, glyph);
      }
    }
    break;
  }
  const advance = glyph => view.getUint16(hmtx + Math.min(glyph, longMetrics - 1) * 4);
  const scale = 1000 / unitsPerEm;
  return {
    bytes,
    unitsPerEm,
    bbox: bbox.map(value => Math.round(value * scale)),
    ascent: Math.round(ascent * scale),
    descent: Math.round(descent * scale),
    capHeight: Math.round(capHeight * scale),
    italicAngle,
    fixedPitch,
    glyphFor: code => glyphForCode.get(code) || 0,
    // Width in glyph space (1/1000 em) as PDF writes it.
    widthOf: glyph => Math.round(advance(glyph) * scale * 1000) / 1000,
  };
}

function readSfntTables(bytes) {
  const view = viewOf(bytes);
  const tables = new Map();
  for (let index = 0; index < view.getUint16(4); index += 1) {
    const record = 12 + index * 16;
    const offset = view.getUint32(record + 8);
    tables.set(String.fromCharCode(...bytes.subarray(record, record + 4)), bytes.slice(offset, offset + view.getUint32(record + 12)));
  }
  return tables;
}

function sfntChecksum(bytes) {
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    sum = (sum + ((((bytes[offset] || 0) << 24) | ((bytes[offset + 1] || 0) << 16) |
      ((bytes[offset + 2] || 0) << 8) | (bytes[offset + 3] || 0)) >>> 0)) >>> 0;
  }
  return sum;
}

function writeSfnt(tables) {
  const tags = [...tables.keys()].sort();
  const headerLength = 12 + tags.length * 16;
  const total = headerLength + tags.reduce((sum, tag) => sum + ((tables.get(tag).length + 3) & ~3), 0);
  const out = new Uint8Array(total);
  const view = viewOf(out);
  const power = 2 ** Math.floor(Math.log2(tags.length));
  view.setUint32(0, 0x00010000);
  view.setUint16(4, tags.length);
  view.setUint16(6, power * 16);
  view.setUint16(8, Math.log2(power));
  view.setUint16(10, tags.length * 16 - power * 16);
  let offset = headerLength;
  let headOffset = -1;
  tags.forEach((tag, index) => {
    const data = tables.get(tag);
    if (tag === 'head') { viewOf(data).setUint32(8, 0); headOffset = offset; }
    const record = 12 + index * 16;
    out.set(new TextEncoder().encode(tag), record);
    view.setUint32(record + 4, sfntChecksum(data));
    view.setUint32(record + 8, offset);
    view.setUint32(record + 12, data.length);
    out.set(data, offset);
    offset += (data.length + 3) & ~3;
  });
  if (headOffset >= 0) view.setUint32(headOffset + 8, (0xb1b0afba - sfntChecksum(out)) >>> 0);
  return out;
}

// The font with each listed glyph's advance set (1/1000 em); the first width
// given for a glyph wins.
function withAdvances(fontBytes, advances) {
  const parsed = parseTrueType(fontBytes);
  const tables = readSfntTables(fontBytes);
  const hmtx = tables.get('hmtx');
  const longMetrics = viewOf(tables.get('hhea')).getUint16(34);
  for (const [glyph, width] of advances) {
    if (glyph > 0 && glyph < longMetrics && Number.isFinite(width)) {
      viewOf(hmtx).setUint16(glyph * 4, Math.min(0xffff, Math.max(0, Math.round(width * parsed.unitsPerEm / 1000))));
    }
  }
  return writeSfnt(tables);
}

/**
 * A symbolic TrueType for single-byte codes: a (3,0) cmap mapping 0xF000+code
 * to the glyph of each code's character, and each glyph's advance set to the
 * code's width (1/1000 em). Returns the font and the widths it really has.
 */
export function buildSymbolicTrueType(sourceBytes, glyphsByCode, widthsByCode) {
  const unicodes = [...new Set([...glyphsByCode.values()])];
  const subset = subsetTrueTypeFont(sourceBytes, unicodes);
  const parsed = parseTrueType(subset.bytes);
  const tables = readSfntTables(subset.bytes);
  const unitsPerEm = parsed.unitsPerEm;
  const hmtx = tables.get('hmtx');
  const longMetrics = viewOf(tables.get('hhea')).getUint16(34);
  const codes = [];
  const advanceSet = new Set();
  for (const [code, unicode] of [...glyphsByCode.entries()].sort((a, b) => a[0] - b[0])) {
    const glyph = parsed.glyphFor(unicode);
    if (!glyph || glyph >= longMetrics) continue;
    codes.push([0xf000 + code, glyph]);
    if (!advanceSet.has(glyph)) {
      const units = Math.max(0, Math.round((widthsByCode.get(code) ?? 0) * unitsPerEm / 1000));
      viewOf(hmtx).setUint16(glyph * 4, Math.min(0xffff, units));
      advanceSet.add(glyph);
    }
  }
  // cmap: one format 4 subtable (3,0), one segment per code.
  const segments = codes.length + 1;
  const length = 16 + segments * 8;
  const format4 = new Uint8Array(length);
  const f4 = viewOf(format4);
  const searchRange = 2 * 2 ** Math.floor(Math.log2(segments));
  f4.setUint16(0, 4);
  f4.setUint16(2, length);
  f4.setUint16(6, segments * 2);
  f4.setUint16(8, searchRange);
  f4.setUint16(10, Math.log2(searchRange / 2));
  f4.setUint16(12, segments * 2 - searchRange);
  const ends = 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  [...codes, [0xffff, 1]].forEach(([code, glyph], index) => {
    f4.setUint16(ends + index * 2, code);
    f4.setUint16(starts + index * 2, code);
    f4.setUint16(deltas + index * 2, (glyph - code) & 0xffff);
  });
  const cmap = new Uint8Array(12 + length);
  viewOf(cmap).setUint16(2, 1);
  viewOf(cmap).setUint16(4, 3);
  viewOf(cmap).setUint16(6, 0);
  viewOf(cmap).setUint32(8, 12);
  cmap.set(format4, 12);
  tables.set('cmap', cmap);
  tables.set('hmtx', hmtx);
  const bytes = writeSfnt(tables);
  return { bytes, postScriptName: subset.postScriptName, parsed: parseTrueType(bytes, { symbolic: true }) };
}

// ---------------------------------------------------------------------------
// sRGB ICC profile (version 2.1, matrix/TRC display profile, ~2.6 KB).

// A CMYK "input" profile (ICC v2, lut16 A2B0) with the plain conversion most
// viewers use for DeviceCMYK without a profile: RGB = (1 - C)(1 - K) … read as
// sRGB. As /DefaultCMYK it makes DeviceCMYK content device independent, which
// PDF/A allows next to an sRGB OutputIntent (6.2.4.3).
export function naiveCmykIccProfile() {
  const grid = 7;
  const s15 = value => Math.round(value * 65536);
  const linear = value => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const clutLength = grid ** 4 * 3 * 2;
  const lut = new Uint8Array(52 + 4 * 2 * 2 + clutLength + 3 * 2 * 2);
  const view = viewOf(lut);
  lut.set([0x6d, 0x66, 0x74, 0x32]); // mft2
  lut[8] = 4;
  lut[9] = 3;
  lut[10] = grid;
  [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((value, index) => view.setInt32(12 + index * 4, s15(value)));
  view.setUint16(48, 2);
  view.setUint16(50, 2);
  let offset = 52;
  for (let channel = 0; channel < 4; channel += 1) { view.setUint16(offset, 0); view.setUint16(offset + 2, 65535); offset += 4; }
  for (let c = 0; c < grid; c += 1) for (let m = 0; m < grid; m += 1) for (let y = 0; y < grid; y += 1) for (let k = 0; k < grid; k += 1) {
    const black = 1 - k / (grid - 1);
    const red = linear((1 - c / (grid - 1)) * black);
    const green = linear((1 - m / (grid - 1)) * black);
    const blue = linear((1 - y / (grid - 1)) * black);
    const xyz = [
      0.4361 * red + 0.3851 * green + 0.1431 * blue,
      0.2225 * red + 0.7169 * green + 0.0606 * blue,
      0.0139 * red + 0.0971 * green + 0.7141 * blue,
    ];
    for (const value of xyz) { view.setUint16(offset, Math.min(65535, Math.round(value * 32768))); offset += 2; }
  }
  for (let channel = 0; channel < 3; channel += 1) { view.setUint16(offset, 0); view.setUint16(offset + 2, 65535); offset += 4; }
  const description = new TextEncoder().encode('Uncalibrated CMYK (berg:work)');
  const desc = new Uint8Array(12 + description.length + 1 + 4 + 4 + 2 + 1 + 67);
  desc.set([0x64, 0x65, 0x73, 0x63]);
  viewOf(desc).setUint32(8, description.length + 1);
  desc.set(description, 12);
  const copyright = new TextEncoder().encode('No copyright, use freely');
  const cprt = new Uint8Array(8 + copyright.length + 1);
  cprt.set([0x74, 0x65, 0x78, 0x74]);
  cprt.set(copyright, 8);
  const wtpt = new Uint8Array(20);
  wtpt.set([0x58, 0x59, 0x5a, 0x20]);
  viewOf(wtpt).setInt32(8, s15(0.9642));
  viewOf(wtpt).setInt32(12, s15(1));
  viewOf(wtpt).setInt32(16, s15(0.8249));
  const tags = [['desc', desc], ['cprt', cprt], ['wtpt', wtpt], ['A2B0', lut]];
  let position = 128 + 4 + tags.length * 12;
  const placed = tags.map(([signature, data]) => {
    const entry = { signature, data, offset: position };
    position += (data.length + 3) & ~3;
    return entry;
  });
  const out = new Uint8Array(position);
  const header = viewOf(out);
  header.setUint32(0, position);
  header.setUint32(8, 0x02100000);
  out.set([0x73, 0x63, 0x6e, 0x72], 12); // scnr
  out.set([0x43, 0x4d, 0x59, 0x4b], 16); // CMYK
  out.set([0x58, 0x59, 0x5a, 0x20], 20); // XYZ
  [2026, 1, 1, 0, 0, 0].forEach((value, index) => header.setUint16(24 + index * 2, value));
  out.set([0x61, 0x63, 0x73, 0x70], 36);
  header.setInt32(68, s15(0.9642));
  header.setInt32(72, s15(1));
  header.setInt32(76, s15(0.8249));
  header.setUint32(128, placed.length);
  placed.forEach((entry, index) => {
    out.set(new TextEncoder().encode(entry.signature), 132 + index * 12);
    header.setUint32(136 + index * 12, entry.offset);
    header.setUint32(140 + index * 12, entry.data.length);
    out.set(entry.data, entry.offset);
  });
  return out;
}

export function srgbIccProfile() {
  const s15 = value => Math.round(value * 65536);
  const tags = [];
  const textDescription = text => {
    const ascii = new TextEncoder().encode(text);
    const out = new Uint8Array(12 + ascii.length + 1 + 4 + 4 + 2 + 1 + 67);
    const view = viewOf(out);
    out.set([0x64, 0x65, 0x73, 0x63]);
    view.setUint32(8, ascii.length + 1);
    out.set(ascii, 12);
    return out;
  };
  const text = value => {
    const ascii = new TextEncoder().encode(value);
    const out = new Uint8Array(8 + ascii.length + 1);
    out.set([0x74, 0x65, 0x78, 0x74]);
    out.set(ascii, 8);
    return out;
  };
  const xyz = (x, y, z) => {
    const out = new Uint8Array(20);
    const view = viewOf(out);
    out.set([0x58, 0x59, 0x5a, 0x20]);
    view.setInt32(8, s15(x));
    view.setInt32(12, s15(y));
    view.setInt32(16, s15(z));
    return out;
  };
  const points = 1024;
  const curve = new Uint8Array(12 + points * 2);
  curve.set([0x63, 0x75, 0x72, 0x76]);
  viewOf(curve).setUint32(8, points);
  for (let index = 0; index < points; index += 1) {
    const value = index / (points - 1);
    const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    viewOf(curve).setUint16(12 + index * 2, Math.round(linear * 65535));
  }
  tags.push(['desc', textDescription('sRGB IEC61966-2.1')]);
  tags.push(['cprt', text('No copyright, use freely')]);
  tags.push(['wtpt', xyz(0.9505, 1, 1.0891)]);
  tags.push(['rXYZ', xyz(0.4361, 0.2225, 0.0139)]);
  tags.push(['gXYZ', xyz(0.3851, 0.7169, 0.0971)]);
  tags.push(['bXYZ', xyz(0.1431, 0.0606, 0.7141)]);
  tags.push(['rTRC', curve], ['gTRC', curve], ['bTRC', curve]);
  const tableLength = 4 + tags.length * 12;
  let offset = 128 + tableLength;
  const placed = new Map();
  const entries = tags.map(([signature, data]) => {
    if (!placed.has(data)) {
      placed.set(data, offset);
      offset += (data.length + 3) & ~3;
    }
    return { signature, data, offset: placed.get(data) };
  });
  const out = new Uint8Array(offset);
  const view = viewOf(out);
  view.setUint32(0, offset);
  view.setUint32(8, 0x02100000);
  out.set([0x6d, 0x6e, 0x74, 0x72], 12); // mntr
  out.set([0x52, 0x47, 0x42, 0x20], 16); // RGB
  out.set([0x58, 0x59, 0x5a, 0x20], 20); // XYZ
  [2026, 1, 1, 0, 0, 0].forEach((value, index) => view.setUint16(24 + index * 2, value));
  out.set([0x61, 0x63, 0x73, 0x70], 36); // acsp
  view.setInt32(68, s15(0.9642));
  view.setInt32(72, s15(1));
  view.setInt32(76, s15(0.8249));
  view.setUint32(128, entries.length);
  entries.forEach((entry, index) => {
    const record = 132 + index * 12;
    out.set(new TextEncoder().encode(entry.signature), record);
    view.setUint32(record + 4, entry.offset);
    view.setUint32(record + 8, entry.data.length);
    out.set(entry.data, entry.offset);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Content streams: which device colour spaces the page operators use.

const WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITERS = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

export function scanContentColours(bytes, found) {
  const length = bytes.length;
  let index = 0;
  const operands = [];
  const readRegular = () => {
    const start = index;
    while (index < length && !WHITESPACE.has(bytes[index]) && !DELIMITERS.has(bytes[index])) index += 1;
    return String.fromCharCode(...bytes.subarray(start, index));
  };
  while (index < length) {
    const byte = bytes[index];
    if (WHITESPACE.has(byte)) { index += 1; continue; }
    if (byte === 37) { // % comment
      while (index < length && bytes[index] !== 10 && bytes[index] !== 13) index += 1;
      continue;
    }
    if (byte === 40) { // (string)
      let depth = 0;
      for (; index < length; index += 1) {
        const current = bytes[index];
        if (current === 92) { index += 1; continue; }
        if (current === 40) depth += 1;
        else if (current === 41 && --depth === 0) { index += 1; break; }
      }
      operands.push('(str)');
      continue;
    }
    if (byte === 60 && bytes[index + 1] !== 60) { // <hex>
      while (index < length && bytes[index] !== 62) index += 1;
      index += 1;
      operands.push('<hex>');
      continue;
    }
    if (byte === 60 || byte === 62) { index += 2; continue; } // << >>
    if (byte === 91 || byte === 93 || byte === 123 || byte === 125) { index += 1; continue; }
    if (byte === 47) {
      index += 1;
      operands.push(`/${readRegular()}`);
      continue;
    }
    if (byte === 41) { index += 1; continue; }
    const token = readRegular();
    if (!token) { index += 1; continue; }
    if (/^[+\-.\d]/u.test(token)) { operands.push(token); continue; }
    if (token === 'true' || token === 'false' || token === 'null') { operands.push(token); continue; }
    // An operator.
    if (token === 'k' || token === 'K') found.add('cmyk');
    else if (token === 'rg' || token === 'RG') found.add('rgb');
    else if (token === 'g' || token === 'G') found.add('gray');
    else if (token === 'cs' || token === 'CS') {
      const name = operands[operands.length - 1];
      if (name === '/DeviceCMYK') found.add('cmyk');
      else if (name === '/DeviceRGB') found.add('rgb');
      else if (name === '/DeviceGray') found.add('gray');
    } else if (token === 'BI') {
      // Inline image: dictionary up to ID, then binary data up to EI.
      const dict = [];
      while (index < length) {
        while (index < length && WHITESPACE.has(bytes[index])) index += 1;
        if (bytes[index] === 47) { index += 1; dict.push(`/${readRegular()}`); continue; }
        const word = readRegular();
        if (word === 'ID') break;
        if (!word) { index += 1; continue; }
        dict.push(word);
      }
      for (let key = 0; key < dict.length - 1; key += 1) {
        if (dict[key] !== '/CS' && dict[key] !== '/ColorSpace') continue;
        const value = dict[key + 1];
        if (value === '/CMYK' || value === '/DeviceCMYK') found.add('cmyk');
        if (value === '/RGB' || value === '/DeviceRGB') found.add('rgb');
      }
      index += 1;
      while (index < length) {
        if (bytes[index] === 69 && bytes[index + 1] === 73 && WHITESPACE.has(bytes[index - 1]) &&
            (index + 2 >= length || WHITESPACE.has(bytes[index + 2]))) { index += 2; break; }
        index += 1;
      }
    }
    operands.length = 0;
  }
  return found;
}

// ---------------------------------------------------------------------------
// XMP and dates.

function pdfDateToIso(value) {
  const match = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?/u.exec(String(value || '').trim());
  if (!match) return null;
  const [, year, month = '01', day = '01', hour, minute, second, zone, zoneHour, zoneMinute] = match;
  let iso = `${year}-${month}-${day}`;
  if (hour !== undefined) iso += `T${hour}:${minute || '00'}:${second || '00'}`;
  else return { iso: `${iso}T00:00:00`, ok: Number(month) >= 1 && Number(month) <= 12 };
  if (zone === 'Z' || zone === 'z') iso += 'Z';
  else if (zone) iso += `${zone}${zoneHour || '00'}:${zoneMinute || '00'}`;
  const ok = Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= 31 &&
    Number(hour) < 24 && Number(minute || 0) < 60 && Number(second || 0) < 60;
  return { iso, ok };
}

function dateToPdf(date) {
  const pad = (value, size = 2) => String(Math.abs(Math.trunc(value))).padStart(size, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return `D:${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}` +
    `${pad(date.getMinutes())}${pad(date.getSeconds())}${sign}${pad(offset / 60)}'${pad(offset % 60)}'`;
}

const xmlText = value => String(value)
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/gu, '')
  .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return '00000000-0000-4000-8000-000000000000'.replace(/0/gu, () => Math.floor(Math.random() * 16).toString(16));
}

export function buildPdfAXmp({ part, conformance, info }) {
  const lines = [];
  if (info.Title !== undefined) lines.push(`<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlText(info.Title)}</rdf:li></rdf:Alt></dc:title>`);
  if (info.Author !== undefined) lines.push(`<dc:creator><rdf:Seq><rdf:li>${xmlText(info.Author)}</rdf:li></rdf:Seq></dc:creator>`);
  if (info.Subject !== undefined) lines.push(`<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlText(info.Subject)}</rdf:li></rdf:Alt></dc:description>`);
  if (info.Keywords !== undefined) lines.push(`<pdf:Keywords>${xmlText(info.Keywords)}</pdf:Keywords>`);
  if (info.Producer !== undefined) lines.push(`<pdf:Producer>${xmlText(info.Producer)}</pdf:Producer>`);
  if (info.Creator !== undefined) lines.push(`<xmp:CreatorTool>${xmlText(info.Creator)}</xmp:CreatorTool>`);
  if (info.CreationDate) lines.push(`<xmp:CreateDate>${info.CreationDate}</xmp:CreateDate>`);
  if (info.ModDate) lines.push(`<xmp:ModifyDate>${info.ModDate}</xmp:ModifyDate>`, `<xmp:MetadataDate>${info.ModDate}</xmp:MetadataDate>`);
  const id = uuid();
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about=""
 xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:xmp="http://ns.adobe.com/xap/1.0/"
 xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
 xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/">
<pdfaid:part>${part}</pdfaid:part>
<pdfaid:conformance>${conformance}</pdfaid:conformance>
<dc:format>application/pdf</dc:format>
${lines.join('\n')}
<xmpMM:DocumentID>uuid:${id}</xmpMM:DocumentID>
<xmpMM:InstanceID>uuid:${id}</xmpMM:InstanceID>
</rdf:Description>
</rdf:RDF>
</x:xmpmeta>
${' '.repeat(100).concat('\n').repeat(20)}<?xpacket end="w"?>`;
}

// ---------------------------------------------------------------------------
// The conversion.

const FORBIDDEN_ACTIONS = new Set(['Launch', 'Sound', 'Movie', 'ResetForm', 'ImportData', 'Hide', 'SetOCGState',
  'Rendition', 'Trans', 'GoTo3DView', 'JavaScript']);
const FORBIDDEN_ANNOTATIONS = new Set(['3D', 'Sound', 'Screen', 'Movie', 'RichMedia']);
// ISO 32000-1 annotation types; others are not allowed in PDF/A-2 and -3.
const KNOWN_ANNOTATIONS = new Set(['Text', 'Link', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine',
  'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink', 'Popup', 'FileAttachment', 'Widget',
  'PrinterMark', 'TrapNet', 'Watermark', 'Redact']);
const RENDERING_INTENTS = new Set(['RelativeColorimetric', 'AbsoluteColorimetric', 'Perceptual', 'Saturation']);
const AF_RELATIONSHIPS = new Set(['Source', 'Data', 'Alternative', 'Supplement', 'EncryptedPayload', 'FormData', 'Schema', 'Unspecified']);
// PDF/A limits (6.1.13): 32-bit integers, reals up to 3.403e38.
const numberInRange = value => (Number.isInteger(value) ? value >= -2147483648 && value <= 2147483647 : Math.abs(value) <= 3.403e38);
const clampNumber = value => (Number.isInteger(value) ? Math.max(-2147483648, Math.min(2147483647, value)) : Math.sign(value) * 3.403e38);
const FONT_SUBTYPES = new Set(['Type1', 'MMType1', 'TrueType', 'Type3', 'Type0', 'CIDFontType0', 'CIDFontType2']);
const MIME_BY_EXTENSION = {
  pdf: 'application/pdf', xml: 'text/xml', txt: 'text/plain', csv: 'text/csv', json: 'application/json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', zip: 'application/zip', html: 'text/html',
};

/**
 * @param {object} PDFLib the pdf-lib namespace
 * @param {Uint8Array} bytes an unencrypted PDF
 * @param {{ loadFont: (file: string) => Promise<Uint8Array>, now?: Date, part?: 2|3 }} options
 * @returns {Promise<{ bytes: Uint8Array, part: number, conformance: string, report: object }>}
 */
export async function convertPdfBytesToPdfA(PDFLib, bytes, options = {}) {
  const { PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFString, PDFHexString, PDFNumber, decodePDFRawStream } = PDFLib;
  const now = options.now || new Date();
  const pdf = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  const { context } = pdf;
  const catalog = pdf.catalog;
  const name = value => PDFName.of(value);
  const lookup = value => (value instanceof PDFRef ? context.lookup(value) : value);
  const get = (dict, key) => (dict instanceof PDFDict ? lookup(dict.get(name(key))) : undefined);
  const nameOf = value => (value instanceof PDFName ? value.decodeText() : undefined);
  const reasons = [];
  const report = { fontsEmbedded: [], actionsRemoved: 0, annotationsRemoved: 0, annotationsFixed: 0, appearancesAdded: 0, attachments: 0 };

  if (context.trailerInfo.Encrypt) throw new PdfAConversionError(['It is encrypted. Remove the password protection first.']);

  // Walk every object (and the direct objects inside) once.
  const fonts = new Set();
  const annotations = new Set();
  const contentStreams = new Set();
  const colourHits = new Set();
  const seen = new Set();
  // Transfer functions and halftone phases are not allowed in graphics states.
  const fixExtGState = state => {
    if (!(state instanceof PDFDict)) return;
    state.delete(name('TR'));
    state.delete(name('HTP'));
    const tr2 = state.get(name('TR2'));
    if (tr2 && nameOf(tr2) !== 'Default') state.set(name('TR2'), name('Default'));
  };
  const pending = [];
  const visit = (object, parentKey) => { pending.push([object, parentKey]); };
  const visitOne = (object, parentKey) => {
    if (!object || seen.has(object)) return;
    if (object instanceof PDFStream) {
      seen.add(object);
      visit(object.dict, parentKey);
      const subtype = nameOf(object.dict.get(name('Subtype')));
      if (subtype === 'Form' || object.dict.has(name('PatternType'))) contentStreams.add(object);
      return;
    }
    if (object instanceof PDFArray) {
      seen.add(object);
      object.asArray().forEach((item, index) => {
        if (item instanceof PDFNumber && !numberInRange(item.asNumber())) object.set(index, PDFNumber.of(clampNumber(item.asNumber())));
      });
      object.asArray().forEach(item => {
        if (item instanceof PDFName) {
          const value = item.decodeText();
          if (value === 'DeviceCMYK' && parentKey !== 'Alternate') colourHits.add('cmyk');
          if (value === 'DeviceRGB' && parentKey !== 'Alternate') colourHits.add('rgb');
        }
        visit(item, parentKey);
      });
      return;
    }
    if (!(object instanceof PDFDict)) return;
    seen.add(object);
    const type = nameOf(object.get(name('Type')));
    const subtype = nameOf(object.get(name('Subtype')));
    if (type === 'Font' || (FONT_SUBTYPES.has(subtype) && (object.has(name('BaseFont')) || object.has(name('FontMatrix'))))) fonts.add(object);
    if (type === 'Annot') annotations.add(object);
    // Actions and additional actions.
    if (object.has(name('AA'))) { object.delete(name('AA')); report.actionsRemoved += 1; }
    for (const key of ['A', 'OpenAction', 'Next']) {
      const action = get(object, key);
      if (action instanceof PDFDict && FORBIDDEN_ACTIONS.has(nameOf(action.get(name('S'))))) {
        object.delete(name(key));
        report.actionsRemoved += 1;
      } else if (action instanceof PDFArray && key === 'Next') {
        const kept = action.asArray().filter(item => !FORBIDDEN_ACTIONS.has(nameOf(get(lookup(item), 'S'))));
        if (kept.length !== action.size()) { object.set(name(key), context.obj(kept)); report.actionsRemoved += 1; }
      }
    }
    // Image and form XObjects, graphics states.
    for (const key of ['Intent', 'RI']) {
      const intent = object.get(name(key));
      if (intent instanceof PDFName && !RENDERING_INTENTS.has(intent.decodeText())) object.set(name(key), name('RelativeColorimetric'));
    }
    for (const [key, value] of object.entries()) {
      if (value instanceof PDFNumber && !numberInRange(value.asNumber())) object.set(key, PDFNumber.of(clampNumber(value.asNumber())));
    }
    if (subtype === 'Image') {
      if (object.get(name('Interpolate'))) object.set(name('Interpolate'), PDFLib.PDFBool.False);
      object.delete(name('Alternates'));
      object.delete(name('OPI'));
    }
    if (subtype === 'Form') {
      object.delete(name('OPI'));
      object.delete(name('Ref'));
      if (nameOf(object.get(name('Subtype2'))) === 'PS') reasons.push('It contains PostScript code, which PDF/A does not allow.');
    }
    if (subtype === 'PS') reasons.push('It contains PostScript code, which PDF/A does not allow.');
    if (type === 'ExtGState') fixExtGState(object);
    const extGStates = get(object, 'ExtGState');
    if (extGStates instanceof PDFDict) {
      for (const [, value] of extGStates.entries()) fixExtGState(lookup(value));
    }
    for (const [key, value] of object.entries()) {
      const keyName = key.decodeText();
      if (value instanceof PDFName) {
        const text = value.decodeText();
        if (text === 'DeviceCMYK' && keyName !== 'Alternate') colourHits.add('cmyk');
        if (text === 'DeviceRGB' && keyName !== 'Alternate') colourHits.add('rgb');
      }
      if (keyName === 'CharProcs' && lookup(value) instanceof PDFDict) {
        for (const [, proc] of lookup(value).entries()) if (lookup(proc) instanceof PDFStream) contentStreams.add(lookup(proc));
      }
      if (!(value instanceof PDFRef)) visit(value, keyName);
    }
  };
  for (const [, object] of context.enumerateIndirectObjects()) {
    visit(object);
    while (pending.length) visitOne(...pending.pop());
  }

  // Catalog.
  for (const key of ['AA', 'Requirements', 'NeedsRendering']) catalog.delete(name(key));
  const version = nameOf(catalog.get(name('Version')));
  if (version && Number(version) > 1.7) catalog.delete(name('Version'));
  const names = get(catalog, 'Names');
  if (names instanceof PDFDict && names.has(name('JavaScript'))) { names.delete(name('JavaScript')); report.actionsRemoved += 1; }
  const acroForm = get(catalog, 'AcroForm');
  if (acroForm instanceof PDFDict) {
    acroForm.delete(name('XFA'));
    acroForm.delete(name('NeedAppearances'));
  }
  // A signed signature field would be broken by the rewrite. Usage rights
  // (/Perms /UR3, Reader extensions as in many tax forms) only unlock Reader
  // features; they go, as they would be invalid afterwards.
  const signedField = [...seen].some(object => object instanceof PDFDict &&
    nameOf(object.get(name('FT'))) === 'Sig' && lookup(object.get(name('V'))) instanceof PDFDict);
  if (signedField && options.refuseSigned !== false) reasons.push('It is digitally signed, and converting it would break the signature.');
  catalog.delete(name('Perms'));

  // Optional content configurations need a Name and no AS.
  const ocProperties = get(catalog, 'OCProperties');
  if (ocProperties instanceof PDFDict) {
    const configs = [get(ocProperties, 'D'), ...(get(ocProperties, 'Configs')?.asArray?.() || []).map(lookup)];
    const groups = (get(ocProperties, 'OCGs')?.asArray?.() || []).filter(item => item instanceof PDFRef);
    const listed = order => (order?.asArray?.() || []).flatMap(item => (item instanceof PDFRef ? [item] : listed(lookup(item))));
    configs.forEach((config, index) => {
      if (!(config instanceof PDFDict)) return;
      if (!config.has(name('Name'))) config.set(name('Name'), PDFHexString.fromText(index ? `Configuration ${index}` : 'Default'));
      config.delete(name('AS'));
      // An Order array has to list every optional content group.
      const order = get(config, 'Order');
      if (order instanceof PDFArray) {
        const present = new Set(listed(order).map(ref => ref.toString()));
        for (const group of groups) if (!present.has(group.toString())) order.push(group);
      }
    });
  }

  // Pages: contents, annotations.
  for (const page of pdf.getPages()) {
    const node = page.node;
    node.delete(name('AA'));
    node.delete(name('PresSteps'));
    const contents = get(node, 'Contents');
    if (contents instanceof PDFStream) contentStreams.add(contents);
    else if (contents instanceof PDFArray) contents.asArray().forEach(item => { if (lookup(item) instanceof PDFStream) contentStreams.add(lookup(item)); });
    const annots = get(node, 'Annots');
    if (annots instanceof PDFArray) {
      const kept = [];
      for (const item of annots.asArray()) {
        const annotation = lookup(item);
        if (!(annotation instanceof PDFDict)) continue;
        const annotationType = nameOf(annotation.get(name('Subtype')));
        if (FORBIDDEN_ANNOTATIONS.has(annotationType) || !KNOWN_ANNOTATIONS.has(annotationType)) { report.annotationsRemoved += 1; continue; }
        annotations.add(annotation);
        kept.push(item);
      }
      if (kept.length !== annots.size()) node.set(name('Annots'), context.obj(kept));
    }
  }

  // Annotations: printable, visible, with a normal appearance only.
  for (const annotation of annotations) {
    const subtype = nameOf(annotation.get(name('Subtype')));
    if (subtype === 'Popup') continue;
    const flags = Number(get(annotation, 'F')?.asNumber?.() || 0);
    const fixed = (flags | 4) & ~(1 | 2 | 32 | 256);
    if (fixed !== flags) { annotation.set(name('F'), PDFNumber.of(fixed)); report.annotationsFixed += 1; }
    const rect = (get(annotation, 'Rect')?.asArray?.() || []).map(item => Number(lookup(item)?.asNumber?.() ?? 0));
    const width = Math.abs((rect[2] ?? 0) - (rect[0] ?? 0));
    const height = Math.abs((rect[3] ?? 0) - (rect[1] ?? 0));
    const appearance = get(annotation, 'AP');
    if (appearance instanceof PDFDict) {
      appearance.delete(name('R'));
      appearance.delete(name('D'));
    }
    const normal = appearance instanceof PDFDict ? get(appearance, 'N') : undefined;
    if (!normal && subtype !== 'Link' && width > 0 && height > 0) {
      // A sticky note gets a small note icon; other annotations an empty appearance.
      let content = '';
      if (subtype === 'Text') {
        const colour = (get(annotation, 'C')?.asArray?.() || []).map(item => Number(lookup(item)?.asNumber?.() ?? 0));
        const fill = colour.length === 3 ? colour.join(' ') : '1 0.85 0.3';
        content = `${fill} rg 0.3 0.3 0.3 RG 0.6 w 0.5 0.5 ${width - 1} ${height - 1} re B ` +
          [0.3, 0.5, 0.7].map(at => `${width * 0.2} ${height * at} m ${width * 0.8} ${height * at} l`).join(' ') + ' S';
      }
      const stream = context.flateStream(content, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, width, height] });
      annotation.set(name('AP'), context.obj({ N: context.register(stream) }));
      contentStreams.add(stream);
      report.appearancesAdded += 1;
    }
  }

  // Attachments: PDF/A-3 with AFRelationship and an AF array; PDF/A-2 cannot
  // carry arbitrary files.
  const fileSpecs = [];
  const collectFileSpec = spec => {
    const dict = lookup(spec);
    if (dict instanceof PDFDict && get(dict, 'EF') instanceof PDFDict) fileSpecs.push(spec);
  };
  const walkNameTree = (node, depth = 0) => {
    const dict = lookup(node);
    if (!(dict instanceof PDFDict) || depth > 32) return;
    const entries = get(dict, 'Names')?.asArray?.() || [];
    for (let index = 1; index < entries.length; index += 2) collectFileSpec(entries[index]);
    for (const kid of get(dict, 'Kids')?.asArray?.() || []) walkNameTree(kid, depth + 1);
  };
  if (names instanceof PDFDict) walkNameTree(names.get(name('EmbeddedFiles')));
  for (const annotation of annotations) {
    if (nameOf(annotation.get(name('Subtype'))) === 'FileAttachment') collectFileSpec(annotation.get(name('FS')));
  }
  const part = fileSpecs.length ? 3 : (options.part || 2);
  if (fileSpecs.length) {
    report.attachments = fileSpecs.length;
    const af = [];
    for (const spec of fileSpecs) {
      const dict = lookup(spec);
      if (!AF_RELATIONSHIPS.has(nameOf(dict.get(name('AFRelationship'))))) dict.set(name('AFRelationship'), name('Unspecified'));
      const fileName = dict.get(name('UF')) || dict.get(name('F'));
      if (fileName) {
        if (!dict.has(name('F'))) dict.set(name('F'), fileName);
        if (!dict.has(name('UF'))) dict.set(name('UF'), fileName);
      }
      const stream = lookup(get(dict, 'EF').get(name('F')));
      if (stream instanceof PDFStream) {
        // pdf-lib re-escapes a lower-case "#2f" in a name as "#232f": the MIME type is written anew.
        const mime = nameOf(stream.dict.get(name('Subtype')))?.replace(/#([0-9a-fA-F]{2})/gu, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        if (mime && /^[a-z]+\/[\w.+-]+$/iu.test(mime)) stream.dict.set(name('Subtype'), name(mime.toLowerCase()));
        else if (mime) stream.dict.delete(name('Subtype'));
        if (!stream.dict.has(name('Subtype'))) {
          const text = lookup(fileName)?.decodeText?.() || '';
          const extension = /\.([a-z0-9]+)$/iu.exec(text)?.[1]?.toLowerCase() || '';
          stream.dict.set(name('Subtype'), name(MIME_BY_EXTENSION[extension] || 'application/octet-stream'));
        }
        let params = get(stream.dict, 'Params');
        if (!(params instanceof PDFDict)) { params = context.obj({}); stream.dict.set(name('Params'), params); }
        if (!params.has(name('ModDate'))) params.set(name('ModDate'), PDFString.of(dateToPdf(now)));
      }
      af.push(spec);
    }
    catalog.set(name('AF'), context.obj(af));
  }

  // Colour: device colour spaces need a matching OutputIntent.
  for (const stream of contentStreams) {
    try {
      const decoded = stream instanceof PDFLib.PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
      scanContentColours(decoded, colourHits);
    } catch {
      // Undecodable content: veraPDF judges it; the conversion does not guess.
    }
  }
  let intentComponents = 0;
  const intents = get(catalog, 'OutputIntents');
  const pdfaIntent = (intents?.asArray?.() || []).map(lookup)
    .find(intent => intent instanceof PDFDict && nameOf(intent.get(name('S'))) === 'GTS_PDFA1' && get(intent, 'DestOutputProfile') instanceof PDFStream);
  if (pdfaIntent) {
    const profile = get(pdfaIntent, 'DestOutputProfile');
    intentComponents = Number(get(profile.dict, 'N')?.asNumber?.() || 0);
    catalog.set(name('OutputIntents'), context.obj([pdfaIntent]));
  } else {
    const profile = context.register(context.flateStream(srgbIccProfile(), { N: 3 }));
    const intent = context.obj({
      Type: 'OutputIntent', S: 'GTS_PDFA1',
      OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'),
      Info: PDFString.of('sRGB IEC61966-2.1'),
      RegistryName: PDFString.of('http://www.color.org'),
      DestOutputProfile: profile,
    });
    catalog.set(name('OutputIntents'), context.obj([context.register(intent)]));
    intentComponents = 3;
  }
  if (colourHits.has('cmyk') && intentComponents !== 4) {
    // DeviceCMYK gets a default colour space in every resource dictionary
    // (pages, forms, patterns, Type 3 glyphs), so it is device independent.
    const profile = context.register(context.flateStream(naiveCmykIccProfile(), { N: 4, Alternate: 'DeviceCMYK' }));
    const defaultCmyk = context.register(context.obj([name('ICCBased'), profile]));
    const resourceDicts = new Set();
    for (const page of pdf.getPages()) {
      page.node.normalize();
      const resources = get(page.node, 'Resources');
      if (resources instanceof PDFDict) resourceDicts.add(resources);
    }
    for (const object of seen) {
      if (!(object instanceof PDFDict)) continue;
      const subtype = nameOf(object.get(name('Subtype')));
      if (subtype === 'Form' || object.has(name('PatternType')) || (subtype === 'Type3' && object.has(name('CharProcs')))) {
        const resources = get(object, 'Resources');
        if (resources instanceof PDFDict) resourceDicts.add(resources);
      }
    }
    for (const resources of resourceDicts) {
      let spaces = get(resources, 'ColorSpace');
      if (!(spaces instanceof PDFDict)) { spaces = context.obj({}); resources.set(name('ColorSpace'), spaces); }
      if (!spaces.has(name('DefaultCMYK'))) spaces.set(name('DefaultCMYK'), defaultCmyk);
    }
    for (const object of seen) {
      if (object instanceof PDFDict && Number(get(object, 'OPM')?.asNumber?.() || 0) === 1) object.set(name('OPM'), PDFNumber.of(0));
    }
    report.cmykProfiled = true;
  }
  if (colourHits.has('rgb') && intentComponents !== 3) {
    reasons.push('It uses RGB colours, but its existing PDF/A colour profile is not RGB.');
  }

  // Fonts.
  const fontCache = new Map();
  const loadParsedFont = async file => {
    if (!fontCache.has(file)) {
      fontCache.set(file, Promise.resolve(options.loadFont(file)).then(fontBytes => parseTrueType(new Uint8Array(fontBytes))));
    }
    return fontCache.get(file);
  };
  const missing = new Set();
  const replacements = [];
  for (const font of fonts) {
    const subtype = nameOf(font.get(name('Subtype')));
    const baseFont = nameOf(font.get(name('BaseFont'))) || '(unnamed)';
    if (subtype === 'Type3') continue;
    if (subtype === 'Type0') {
      const descendant = lookup(get(font, 'DescendantFonts')?.asArray?.()?.[0]);
      const descriptor = descendant instanceof PDFDict ? get(descendant, 'FontDescriptor') : undefined;
      const embedded = descriptor instanceof PDFDict && ['FontFile', 'FontFile2', 'FontFile3'].some(key => descriptor.has(name(key)));
      if (!embedded) { missing.add(baseFont.replace(/^[A-Z]{6}\+/u, '')); continue; }
      descriptor.delete(name('CIDSet'));
      if (nameOf(descendant.get(name('Subtype'))) === 'CIDFontType2' && !descendant.has(name('CIDToGIDMap'))) {
        descendant.set(name('CIDToGIDMap'), name('Identity'));
      }
      continue;
    }
    if (subtype === 'CIDFontType0' || subtype === 'CIDFontType2') continue; // checked through their Type0 parent
    const descriptor = get(font, 'FontDescriptor');
    if (descriptor instanceof PDFDict && ['FontFile', 'FontFile2', 'FontFile3'].some(key => descriptor.has(name(key)))) {
      descriptor.delete(name('CharSet'));
      continue;
    }
    const flags = Number(get(descriptor, 'Flags')?.asNumber?.() || 0);
    const standardSymbolic = symbolicStandardFont(baseFont);
    if (standardSymbolic && PDFLib.StandardFontEmbedder?.for) {
      replacements.push({ font, baseFont, flags, symbolic: standardSymbolic });
      continue;
    }
    // Without widths in the PDF a look-alike would change the layout.
    const replacement = replacementFontFile(baseFont, flags) ||
      (get(font, 'Widths') instanceof PDFArray ? lookalikeFontFile(baseFont, flags) : null);
    if (!replacement) { missing.add(baseFont.replace(/^[A-Z]{6}\+/u, '')); continue; }
    replacements.push({ font, baseFont, flags, replacement });
  }
  if (missing.size) {
    const list = [...missing].sort();
    reasons.push(`${list.length === 1 ? 'The font' : 'The fonts'} ${list.join(', ')} ${list.length === 1 ? 'is' : 'are'} not embedded, and berg:work has no free replacement with the same widths.`);
  }
  if (reasons.length) throw new PdfAConversionError(reasons);

  const subsetCache = new Map();
  let symbolSourceBytes = null;
  for (const { font, baseFont, flags, replacement, symbolic: symbolicFont } of replacements) {
    if (symbolicFont) {
      // Codes -> characters and widths of the standard font (or the widths the PDF gives).
      const embedder = PDFLib.StandardFontEmbedder.for(symbolicFont);
      const glyphsByCode = new Map();
      const widthsByCode = new Map();
      for (const [unicode, [code, glyphName]] of Object.entries(embedder.encoding.unicodeMappings)) {
        if (code < 0 || code > 255 || Number(unicode) === 0xa0) continue;
        if (!glyphsByCode.has(code)) glyphsByCode.set(code, Number(unicode));
        if (!widthsByCode.has(code)) widthsByCode.set(code, embedder.font.getWidthOfGlyph(glyphName) || 0);
      }
      const firstChar = Number(get(font, 'FirstChar')?.asNumber?.() ?? 0);
      (get(font, 'Widths')?.asArray?.() || []).forEach((item, index) => {
        const width = lookup(item)?.asNumber?.();
        if (Number.isFinite(width) && glyphsByCode.has(firstChar + index)) widthsByCode.set(firstChar + index, width);
      });
      symbolSourceBytes ||= new Uint8Array(await options.loadFont(SYMBOL_SOURCE_FONT));
      const built = buildSymbolicTrueType(symbolSourceBytes, glyphsByCode, widthsByCode);
      const fontFile = context.register(context.flateStream(built.bytes, { Length1: built.bytes.length }));
      const widths = [];
      for (let code = 0; code < 256; code += 1) widths.push(built.parsed.widthOf(built.parsed.glyphFor(0xf000 + code)));
      font.set(name('Subtype'), name('TrueType'));
      font.set(name('BaseFont'), name(built.postScriptName));
      font.set(name('FirstChar'), PDFNumber.of(0));
      font.set(name('LastChar'), PDFNumber.of(255));
      font.set(name('Widths'), context.obj(widths));
      font.delete(name('Encoding'));
      font.set(name('FontDescriptor'), context.register(context.obj({
        Type: 'FontDescriptor', FontName: built.postScriptName, Flags: 4, FontBBox: built.parsed.bbox, ItalicAngle: 0,
        Ascent: built.parsed.ascent, Descent: built.parsed.descent, CapHeight: built.parsed.capHeight, StemV: 80,
        FontFile2: fontFile,
      })));
      report.fontsEmbedded.push({ from: baseFont.replace(/^[A-Z]{6}\+/u, ''), to: 'DejaVu Sans glyphs' });
      continue;
    }
    const parsed = await loadParsedFont(replacement.file);
    // The text's codes and the characters they stand for, as the source font
    // encoded them.
    const encoding = get(font, 'Encoding');
    const symbolic = Boolean(flags & 4) && !(flags & 32);
    const baseName = nameOf(encoding instanceof PDFDict ? encoding.get(name('BaseEncoding')) : encoding);
    let unicodes = baseName === 'WinAnsiEncoding' ? winAnsiUnicode().slice()
      : baseName === 'MacRomanEncoding' ? macRomanUnicode().slice()
        : baseName === 'StandardEncoding' ? standardUnicode()
          : symbolic || nameOf(font.get(name('Subtype'))) === 'TrueType' && !(flags & 32) ? winAnsiUnicode().slice()
            : standardUnicode();
    const differenceNames = new Map();
    if (encoding instanceof PDFDict) {
      let code = 0;
      for (const item of get(encoding, 'Differences')?.asArray?.() || []) {
        const value = lookup(item);
        if (value instanceof PDFNumber) code = value.asNumber();
        else if (value instanceof PDFName) {
          if (code >= 0 && code < 256) {
            unicodes[code] = glyphNameToUnicode(value.decodeText());
            differenceNames.set(code, value.decodeText());
          }
          code += 1;
        }
      }
    }
    unicodes = unicodes.map(code => (code && parsed.glyphFor(code) ? code : 0));
    const codePoints = [...new Set(unicodes.filter(Boolean))];
    // A look-alike keeps the PDF's widths: its glyph advances are set to them.
    const dictWidths = new Map();
    if (replacement.lookalike) {
      const firstChar = Number(get(font, 'FirstChar')?.asNumber?.() ?? 0);
      (get(font, 'Widths')?.asArray?.() || []).forEach((item, index) => {
        const width = lookup(item)?.asNumber?.();
        if (Number.isFinite(width)) dictWidths.set(firstChar + index, width);
      });
    }
    const key = `${replacement.file}:${codePoints.sort((a, b) => a - b).join(',')}${replacement.lookalike ? `:${[...dictWidths].join(';')}` : ''}`;
    if (!subsetCache.has(key)) {
      const subset = subsetTrueTypeFont(parsed.bytes, codePoints);
      let programBytes = subset.bytes;
      if (replacement.lookalike) {
        const subsetParsed = parseTrueType(programBytes);
        const advances = new Map();
        unicodes.forEach((unicode, code) => {
          const glyph = unicode ? subsetParsed.glyphFor(unicode) : 0;
          if (glyph && dictWidths.has(code) && !advances.has(glyph)) advances.set(glyph, dictWidths.get(code));
        });
        programBytes = withAdvances(programBytes, advances);
      }
      const fontFile = context.register(context.flateStream(programBytes, { Length1: programBytes.length }));
      subsetCache.set(key, { fontFile, postScriptName: subset.postScriptName, program: parseTrueType(programBytes) });
    }
    const { fontFile, postScriptName, program } = subsetCache.get(key);
    // WinAnsi with differences where the text's characters sit elsewhere.
    const winAnsi = winAnsiUnicode();
    const differences = [];
    let last = -2;
    for (let code = 0; code < 256; code += 1) {
      const unicode = unicodes[code];
      if (!unicode || unicode === winAnsi[code]) continue;
      // PDF/A wants Adobe Glyph List names here; a character without one is left out (.notdef).
      const sourceName = differenceNames.get(code);
      const glyphName = AGL_NAME.get(unicode) || (sourceName && AGL.has(sourceName) ? sourceName : '');
      if (!glyphName) { unicodes[code] = 0; continue; }
      if (code !== last + 1) differences.push(PDFNumber.of(code));
      differences.push(name(glyphName));
      last = code;
    }
    const widths = [];
    for (let code = 0; code < 256; code += 1) {
      // The embedded program's widths; codes without a glyph show .notdef.
      widths.push(program.widthOf(unicodes[code] ? program.glyphFor(unicodes[code]) : 0));
    }
    const newFlags = 32 | (replacement.mono ? 1 : 0) | (replacement.serif ? 2 : 0) | (/Italic/u.test(replacement.face) ? 64 : 0);
    const newDescriptor = context.obj({
      Type: 'FontDescriptor',
      FontName: postScriptName,
      Flags: newFlags,
      FontBBox: parsed.bbox,
      ItalicAngle: parsed.italicAngle,
      Ascent: parsed.ascent,
      Descent: parsed.descent,
      CapHeight: parsed.capHeight,
      StemV: /Bold/u.test(replacement.face) ? 120 : 80,
      FontFile2: fontFile,
    });
    font.set(name('Subtype'), name('TrueType'));
    font.set(name('BaseFont'), name(postScriptName));
    font.set(name('FirstChar'), PDFNumber.of(0));
    font.set(name('LastChar'), PDFNumber.of(255));
    font.set(name('Widths'), context.obj(widths));
    font.set(name('Encoding'), differences.length
      ? context.obj({ Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: differences })
      : name('WinAnsiEncoding'));
    font.set(name('FontDescriptor'), context.register(newDescriptor));
    report.fontsEmbedded.push({ from: baseFont.replace(/^[A-Z]{6}\+/u, ''), to: replacement.file.replace(/\.ttf$/u, ''), lookalike: Boolean(replacement.lookalike) });
  }

  // Metadata: Info and XMP agree; object-level XMP is dropped (it would need
  // PDF/A extension schemas for any non-standard property).
  for (const stream of seen) {
    if (stream instanceof PDFDict && stream !== catalog && stream.has(name('Metadata')) && lookup(stream.get(name('Metadata'))) instanceof PDFStream) {
      stream.delete(name('Metadata'));
    }
  }
  let infoDict = lookup(context.trailerInfo.Info);
  if (!(infoDict instanceof PDFDict)) {
    infoDict = context.obj({});
    context.trailerInfo.Info = context.register(infoDict);
  }
  const info = {};
  for (const key of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer']) {
    const value = lookup(infoDict.get(name(key)));
    if (value instanceof PDFString || value instanceof PDFHexString) {
      const text = value.decodeText();
      if (text.trim()) {
        info[key] = text;
        infoDict.set(name(key), PDFHexString.fromText(text));
      } else infoDict.delete(name(key));
    } else if (value !== undefined) infoDict.delete(name(key));
  }
  infoDict.delete(name('Trapped'));
  const nowPdf = dateToPdf(now);
  const created = pdfDateToIso(lookup(infoDict.get(name('CreationDate')))?.decodeText?.());
  if (created?.ok) info.CreationDate = created.iso;
  else {
    infoDict.set(name('CreationDate'), PDFString.of(nowPdf));
    info.CreationDate = pdfDateToIso(nowPdf).iso;
  }
  infoDict.set(name('ModDate'), PDFString.of(nowPdf));
  info.ModDate = pdfDateToIso(nowPdf).iso;
  const xmp = new TextEncoder().encode(buildPdfAXmp({ part, conformance: 'B', info }));
  const metadata = context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' });
  catalog.set(name('Metadata'), context.register(metadata));

  const saved = await pdf.save({ addDefaultPage: false, useObjectStreams: false, updateFieldAppearances: false });
  const out = new Uint8Array(saved);
  // PDF/A-2 and -3 are based on PDF 1.7: a 2.0 header is lowered in place.
  if (out[5] === 0x32 && out[6] === 0x2e) { out[5] = 0x31; out[7] = 0x37; }
  return { bytes: out, part, conformance: 'B', report };
}
