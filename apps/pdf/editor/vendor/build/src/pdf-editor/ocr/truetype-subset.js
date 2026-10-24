// Minimal glyf/loca TrueType subsetter. subsetTrueTypeFont (the invisible
// OCR text font) keeps the glyphs of the given code points (plus .notdef and
// composite components), renumbers them, and writes a font with only the
// tables PDF embedding needs: a cmap for the kept characters (PDFium derives
// the ToUnicode map and glyph widths from it), metrics, outlines and the name
// table with a subset-tagged PostScript name ("ABCDEF+NotoSans-Regular").
// subsetTrueTypeGlyphs keeps glyph ids instead, for CIDFontType2 fonts whose
// CIDToGIDMap already addresses glyphs of the full font.

const SFNT_CHECKSUM_MAGIC = 0xb1b0afba;
const KEPT_TABLES = ['OS/2', 'cmap', 'gasp', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post', 'prep', 'cvt ', 'fpgm'];

const align4 = value => (value + 3) & ~3;

function fail(message) {
  throw new TypeError(`Cannot subset font: ${message}`);
}

function checksum(bytes) {
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const word = ((bytes[offset] || 0) << 24) | ((bytes[offset + 1] || 0) << 16) |
      ((bytes[offset + 2] || 0) << 8) | (bytes[offset + 3] || 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}

function readTables(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || view.getUint32(0) !== 0x00010000) fail('only TrueType (glyf) fonts are supported');
  const count = view.getUint16(4);
  const tables = new Map();
  for (let index = 0; index < count; index += 1) {
    const record = 12 + index * 16;
    if (record + 16 > bytes.byteLength) fail('table directory is truncated');
    const tag = String.fromCharCode(...bytes.subarray(record, record + 4));
    const offset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    if (offset + length > bytes.byteLength) fail(`table ${tag} is out of bounds`);
    tables.set(tag, bytes.subarray(offset, offset + length));
  }
  for (const tag of ['cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post']) {
    if (!tables.has(tag)) fail(`required table ${tag} is missing`);
  }
  return tables;
}

const viewOf = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// The best Unicode cmap subtable: format 12 if present, else format 4.
function unicodeCmapSubtable(view) {
  const count = view.getUint16(2);
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const platform = view.getUint16(4 + index * 8);
    const encoding = view.getUint16(6 + index * 8);
    const offset = view.getUint32(8 + index * 8);
    const format = view.getUint16(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (unicode && (format === 4 || format === 12)) candidates.push({ format, offset });
  }
  const table = candidates.find(item => item.format === 12) || candidates.find(item => item.format === 4);
  if (!table) fail('no Unicode cmap');
  return table;
}

// All [code point, glyph id] pairs of the best Unicode subtable, by code.
function readCmapEntries(cmap) {
  const view = viewOf(cmap);
  const { format, offset: base } = unicodeCmapSubtable(view);
  const entries = [];
  if (format === 12) {
    const groups = view.getUint32(base + 12);
    for (let group = 0; group < groups; group += 1) {
      const record = base + 16 + group * 12;
      const start = view.getUint32(record);
      const end = view.getUint32(record + 4);
      const glyph = view.getUint32(record + 8);
      for (let code = start; code <= end && code <= 0x10ffff; code += 1) entries.push([code, glyph + code - start]);
    }
  } else {
    const segments = view.getUint16(base + 6) / 2;
    const ends = base + 14;
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
        entries.push([code, glyph]);
      }
    }
  }
  return entries.filter(([code, glyph]) => code > 0 && glyph > 0).sort((a, b) => a[0] - b[0]);
}

// Unicode code point -> glyph id from the best Unicode cmap subtable.
function readCmap(cmap) {
  const view = viewOf(cmap);
  const table = unicodeCmapSubtable(view);
  return code => {
    const base = table.offset;
    if (table.format === 12) {
      const groups = view.getUint32(base + 12);
      let low = 0;
      let high = groups - 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const record = base + 16 + middle * 12;
        const start = view.getUint32(record);
        const end = view.getUint32(record + 4);
        if (code < start) high = middle - 1;
        else if (code > end) low = middle + 1;
        else return view.getUint32(record + 8) + code - start;
      }
      return 0;
    }
    if (code > 0xffff) return 0;
    const segments = view.getUint16(base + 6) / 2;
    const ends = base + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const rangeOffsets = deltas + segments * 2;
    for (let segment = 0; segment < segments; segment += 1) {
      if (code > view.getUint16(ends + segment * 2)) continue;
      const start = view.getUint16(starts + segment * 2);
      if (code < start) return 0;
      const delta = view.getInt16(deltas + segment * 2);
      const rangeOffset = view.getUint16(rangeOffsets + segment * 2);
      if (!rangeOffset) return (code + delta) & 0xffff;
      const glyph = view.getUint16(rangeOffsets + segment * 2 + rangeOffset + (code - start) * 2);
      return glyph ? (glyph + delta) & 0xffff : 0;
    }
    return 0;
  };
}

function glyphLocations(tables, numGlyphs) {
  const head = viewOf(tables.get('head'));
  const loca = viewOf(tables.get('loca'));
  const long = head.getInt16(50) === 1;
  const locations = new Uint32Array(numGlyphs + 1);
  for (let index = 0; index <= numGlyphs; index += 1) {
    locations[index] = long ? loca.getUint32(index * 4) : loca.getUint16(index * 2) * 2;
  }
  return locations;
}

// Visits the components of a composite glyph: (glyphIdOffset) => void.
function forEachComponent(glyph, visit) {
  const view = viewOf(glyph);
  if (glyph.byteLength < 10 || view.getInt16(0) >= 0) return;
  let offset = 10;
  for (;;) {
    const flags = view.getUint16(offset);
    visit(offset + 2);
    offset += 4 + ((flags & 0x0001) ? 4 : 2);
    if (flags & 0x0008) offset += 2;
    else if (flags & 0x0040) offset += 4;
    else if (flags & 0x0080) offset += 8;
    if (!(flags & 0x0020)) break;
  }
}

function makeCmap(entries) {
  // entries: sorted [code, glyph]; format 4 for the BMP, format 12 when needed.
  const bmp = entries.filter(([code]) => code <= 0xffff);
  const runs = [];
  for (const [code, glyph] of bmp) {
    const run = runs[runs.length - 1];
    if (run && code === run.end + 1) {
      run.end = code;
      run.glyphs.push(glyph);
    } else {
      runs.push({ start: code, end: code, glyphs: [glyph] });
    }
  }
  runs.push({ start: 0xffff, end: 0xffff, glyphs: null });
  const segments = runs.length;
  const glyphArray = runs.reduce((sum, run) => sum + (run.glyphs ? run.glyphs.length : 0), 0);
  const format4Length = 16 + segments * 8 + glyphArray * 2;
  const format4 = new Uint8Array(format4Length);
  const f4 = viewOf(format4);
  const searchRange = 2 * 2 ** Math.floor(Math.log2(segments));
  f4.setUint16(0, 4);
  f4.setUint16(2, format4Length);
  f4.setUint16(6, segments * 2);
  f4.setUint16(8, searchRange);
  f4.setUint16(10, Math.log2(searchRange / 2));
  f4.setUint16(12, segments * 2 - searchRange);
  const ends = 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  let glyphCursor = rangeOffsets + segments * 2;
  runs.forEach((run, index) => {
    f4.setUint16(ends + index * 2, run.end);
    f4.setUint16(starts + index * 2, run.start);
    if (!run.glyphs) {
      f4.setInt16(deltas + index * 2, 1);
      f4.setUint16(rangeOffsets + index * 2, 0);
      return;
    }
    f4.setUint16(rangeOffsets + index * 2, glyphCursor - (rangeOffsets + index * 2));
    for (const glyph of run.glyphs) {
      f4.setUint16(glyphCursor, glyph);
      glyphCursor += 2;
    }
  });
  const subtables = [{ platform: 3, encoding: 1, bytes: format4 }];
  if (entries.some(([code]) => code > 0xffff)) {
    const format12 = new Uint8Array(16 + entries.length * 12);
    const f12 = viewOf(format12);
    f12.setUint16(0, 12);
    f12.setUint32(4, format12.byteLength);
    f12.setUint32(12, entries.length);
    entries.forEach(([code, glyph], index) => {
      f12.setUint32(16 + index * 12, code);
      f12.setUint32(20 + index * 12, code);
      f12.setUint32(24 + index * 12, glyph);
    });
    subtables.push({ platform: 3, encoding: 10, bytes: format12 });
  }
  const headerLength = 4 + subtables.length * 8;
  const out = new Uint8Array(headerLength + subtables.reduce((sum, table) => sum + table.bytes.byteLength, 0));
  const view = viewOf(out);
  view.setUint16(2, subtables.length);
  let offset = headerLength;
  subtables.forEach((table, index) => {
    view.setUint16(4 + index * 8, table.platform);
    view.setUint16(6 + index * 8, table.encoding);
    view.setUint32(8 + index * 8, offset);
    out.set(table.bytes, offset);
    offset += table.bytes.byteLength;
  });
  return out;
}

// Copies the name table with the PostScript name (ID 6) replaced.
function renameFont(name, postScriptName) {
  const view = viewOf(name);
  const count = view.getUint16(2);
  const storage = view.getUint16(4);
  const records = [];
  for (let index = 0; index < count; index += 1) {
    const record = 6 + index * 12;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const language = view.getUint16(record + 4);
    const nameId = view.getUint16(record + 6);
    const length = view.getUint16(record + 8);
    const offset = view.getUint16(record + 10);
    let bytes = name.subarray(storage + offset, storage + offset + length);
    if (nameId === 6) {
      bytes = platform === 3 || platform === 0
        ? Uint8Array.from([...postScriptName].flatMap(char => [0, char.charCodeAt(0)]))
        : Uint8Array.from([...postScriptName].map(char => char.charCodeAt(0)));
    }
    records.push({ platform, encoding, language, nameId, bytes });
  }
  const headerLength = 6 + records.length * 12;
  const out = new Uint8Array(headerLength + records.reduce((sum, record) => sum + record.bytes.byteLength, 0));
  const outView = viewOf(out);
  outView.setUint16(2, records.length);
  outView.setUint16(4, headerLength);
  let offset = 0;
  records.forEach((record, index) => {
    const at = 6 + index * 12;
    outView.setUint16(at, record.platform);
    outView.setUint16(at + 2, record.encoding);
    outView.setUint16(at + 4, record.language);
    outView.setUint16(at + 6, record.nameId);
    outView.setUint16(at + 8, record.bytes.byteLength);
    outView.setUint16(at + 10, offset);
    out.set(record.bytes, headerLength + offset);
    offset += record.bytes.byteLength;
  });
  return out;
}

function readPostScriptName(name) {
  const view = viewOf(name);
  const count = view.getUint16(2);
  const storage = view.getUint16(4);
  for (let index = 0; index < count; index += 1) {
    const record = 6 + index * 12;
    if (view.getUint16(record + 6) !== 6) continue;
    const platform = view.getUint16(record);
    const bytes = name.subarray(storage + view.getUint16(record + 10), storage + view.getUint16(record + 10) + view.getUint16(record + 8));
    if (platform === 3 || platform === 0) {
      let text = '';
      for (let offset = 0; offset + 1 < bytes.length; offset += 2) text += String.fromCharCode((bytes[offset] << 8) | bytes[offset + 1]);
      return text;
    }
    return String.fromCharCode(...bytes);
  }
  return 'Font';
}

/**
 * Advance width of a string in em (sum of the glyph advances of its
 * characters, no kerning), for placing text by its advance box.
 * @param {Uint8Array} fontBytes a TrueType (glyf) font
 */
export function createAdvanceMeasurer(fontBytes) {
  const tables = readTables(fontBytes instanceof Uint8Array ? fontBytes : new Uint8Array(fontBytes));
  const lookup = readCmap(tables.get('cmap'));
  const unitsPerEm = viewOf(tables.get('head')).getUint16(18) || 1000;
  const metrics = viewOf(tables.get('hhea')).getUint16(34);
  const hmtx = viewOf(tables.get('hmtx'));
  return text => {
    let units = 0;
    for (const char of String(text || '')) {
      const glyph = lookup(char.codePointAt(0));
      units += hmtx.getUint16(Math.min(glyph, metrics - 1) * 4);
    }
    return units / unitsPerEm;
  };
}

/** Six upper-case letters derived from the kept characters (PDF subset tag). */
export function subsetTag(codePoints) {
  let hash = 0x811c9dc5;
  for (const code of [...codePoints].sort((a, b) => a - b)) {
    hash ^= code;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let tag = '';
  for (let index = 0; index < 6; index += 1) {
    tag += String.fromCharCode(65 + (hash % 26));
    hash = (Math.floor(hash / 26) ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  }
  return tag;
}

/**
 * @param {Uint8Array} fontBytes a TrueType (glyf) font
 * @param {Iterable<number>} codePoints characters to keep
 * @returns {{ bytes: Uint8Array, postScriptName: string, glyphCount: number }}
 */
export function subsetTrueTypeFont(fontBytes, codePoints) {
  const source = fontBytes instanceof Uint8Array ? fontBytes : new Uint8Array(fontBytes);
  const tables = readTables(source);
  const numGlyphs = viewOf(tables.get('maxp')).getUint16(4);
  const locations = glyphLocations(tables, numGlyphs);
  const glyf = tables.get('glyf');
  const glyphData = id => glyf.subarray(locations[id], Math.max(locations[id], locations[id + 1]));
  const lookup = readCmap(tables.get('cmap'));
  const codes = [...new Set([...codePoints].map(Number))]
    .filter(code => Number.isInteger(code) && code > 0 && code <= 0x10ffff)
    .sort((a, b) => a - b);

  // Old glyph ids to keep, closed over composite components.
  const keep = new Set([0]);
  const mapped = [];
  for (const code of codes) {
    const glyph = lookup(code);
    if (glyph > 0 && glyph < numGlyphs) {
      keep.add(glyph);
      mapped.push([code, glyph]);
    }
  }
  const queue = [...keep];
  while (queue.length) {
    const data = glyphData(queue.pop());
    forEachComponent(data, offset => {
      const component = viewOf(data).getUint16(offset);
      if (component < numGlyphs && !keep.has(component)) {
        keep.add(component);
        queue.push(component);
      }
    });
  }
  const order = [...keep].sort((a, b) => a - b);
  const newId = new Map(order.map((oldId, index) => [oldId, index]));

  // glyf + loca (long offsets), components renumbered.
  const glyphs = order.map(oldId => {
    const data = new Uint8Array(glyphData(oldId));
    forEachComponent(data, offset => {
      const view = viewOf(data);
      view.setUint16(offset, newId.get(view.getUint16(offset)) ?? 0);
    });
    return data;
  });
  const glyfOut = new Uint8Array(glyphs.reduce((sum, data) => sum + align4(data.byteLength), 0));
  const locaOut = new Uint8Array((order.length + 1) * 4);
  let cursor = 0;
  glyphs.forEach((data, index) => {
    viewOf(locaOut).setUint32(index * 4, cursor);
    glyfOut.set(data, cursor);
    cursor += align4(data.byteLength);
  });
  viewOf(locaOut).setUint32(order.length * 4, cursor);

  // hmtx with one long metric per kept glyph.
  const hhea = new Uint8Array(tables.get('hhea'));
  const metrics = viewOf(hhea).getUint16(34);
  const hmtx = viewOf(tables.get('hmtx'));
  const hmtxOut = new Uint8Array(order.length * 4);
  order.forEach((oldId, index) => {
    const advance = hmtx.getUint16(Math.min(oldId, metrics - 1) * 4);
    const lsb = oldId < metrics ? hmtx.getInt16(oldId * 4 + 2) : hmtx.getInt16(metrics * 4 + (oldId - metrics) * 2);
    viewOf(hmtxOut).setUint16(index * 4, advance);
    viewOf(hmtxOut).setInt16(index * 4 + 2, lsb);
  });
  viewOf(hhea).setUint16(34, order.length);

  const maxp = new Uint8Array(tables.get('maxp'));
  viewOf(maxp).setUint16(4, order.length);
  const head = new Uint8Array(tables.get('head'));
  viewOf(head).setUint32(8, 0);
  viewOf(head).setInt16(50, 1);
  // post format 3: no glyph names.
  const post = new Uint8Array(32);
  post.set(tables.get('post').subarray(0, 32));
  viewOf(post).setUint32(0, 0x00030000);

  const postScriptName = `${subsetTag(mapped.map(([code]) => code))}+${readPostScriptName(tables.get('name')).replace(/^[A-Z]{6}\+/, '')}`;
  const out = new Map(tables);
  out.set('glyf', glyfOut);
  out.set('loca', locaOut);
  out.set('hmtx', hmtxOut);
  out.set('hhea', hhea);
  out.set('maxp', maxp);
  out.set('head', head);
  out.set('post', post);
  out.set('cmap', makeCmap(mapped.map(([code, glyph]) => [code, newId.get(glyph)])));
  out.set('name', renameFont(tables.get('name'), postScriptName));
  return { bytes: writeFont(out), postScriptName, glyphCount: order.length };
}

// Closes a glyph id set over composite-glyph components.
function withComponents(ids, glyphData, numGlyphs) {
  const closed = new Set(ids);
  const queue = [...closed];
  while (queue.length) {
    const data = glyphData(queue.pop());
    forEachComponent(data, offset => {
      const component = viewOf(data).getUint16(offset);
      if (component < numGlyphs && !closed.has(component)) {
        closed.add(component);
        queue.push(component);
      }
    });
  }
  return closed;
}

/**
 * Glyph-id preserving subset: every glyph keeps its id, glyphs outside the
 * kept set become empty and have no metrics, and the cmap maps only
 * characters whose glyph is kept (so shaping new text with the subset reports
 * those characters as missing rather than drawing nothing). Layout and
 * variation tables are dropped: the subset is only drawn through an explicit
 * CIDToGIDMap. The output is a pure function of the source font and the kept
 * glyph set, and retainedSubsetGlyphIds(subset) returns that set, so the
 * subset can later be proven to derive from a given full font. Exported PDFs
 * depend on that: keep the output byte-stable (GOLDEN_SUBSETS in
 * test/unit/pdf-editor/bundled-font-subset.test.mjs).
 * @param {Uint8Array} fontBytes a TrueType (glyf) font
 * @param {Iterable<number>} glyphIds glyphs to keep (.notdef and composite
 *   components are added)
 * @returns {{ bytes: Uint8Array, postScriptName: string, glyphIds: number[],
 *   outlinedGlyphIds: number[] }} the kept glyphs, and those with an outline
 */
export function subsetTrueTypeGlyphs(fontBytes, glyphIds) {
  const source = fontBytes instanceof Uint8Array ? fontBytes : new Uint8Array(fontBytes);
  const tables = readTables(source);
  const numGlyphs = viewOf(tables.get('maxp')).getUint16(4);
  const locations = glyphLocations(tables, numGlyphs);
  const glyf = tables.get('glyf');
  const glyphData = id => glyf.subarray(locations[id], Math.max(locations[id], locations[id + 1]));
  const requested = [0];
  for (const value of glyphIds) {
    const id = Number(value);
    if (!Number.isInteger(id) || id < 0 || id >= numGlyphs) fail(`glyph ${value} is out of range`);
    requested.push(id);
  }
  const closed = withComponents(requested, glyphData, numGlyphs);
  const mapped = readCmapEntries(tables.get('cmap')).filter(([, glyph]) => closed.has(glyph));
  const mappedGlyphs = new Set(mapped.map(([, glyph]) => glyph));
  // Canonical kept set: what retainedSubsetGlyphIds can read back from the
  // output (outlined or mapped glyphs; unmapped empty glyphs stay empty).
  const kept = [...closed]
    .filter(id => id === 0 || glyphData(id).byteLength > 0 || mappedGlyphs.has(id))
    .sort((a, b) => a - b);
  const keep = new Set(kept);

  const glyfOut = new Uint8Array(kept.reduce((sum, id) => sum + align4(glyphData(id).byteLength), 0));
  const locaOut = new Uint8Array((numGlyphs + 1) * 4);
  let cursor = 0;
  for (let id = 0; id < numGlyphs; id += 1) {
    viewOf(locaOut).setUint32(id * 4, cursor);
    if (!keep.has(id)) continue;
    const data = glyphData(id);
    glyfOut.set(data, cursor);
    cursor += align4(data.byteLength);
  }
  viewOf(locaOut).setUint32(numGlyphs * 4, cursor);

  const hhea = new Uint8Array(tables.get('hhea'));
  const metrics = viewOf(hhea).getUint16(34);
  const hmtx = viewOf(tables.get('hmtx'));
  const hmtxOut = new Uint8Array(numGlyphs * 4);
  for (const id of kept) {
    const advance = hmtx.getUint16(Math.min(id, metrics - 1) * 4);
    const lsb = id < metrics ? hmtx.getInt16(id * 4 + 2) : hmtx.getInt16(metrics * 4 + (id - metrics) * 2);
    viewOf(hmtxOut).setUint16(id * 4, advance);
    viewOf(hmtxOut).setInt16(id * 4 + 2, lsb);
  }
  viewOf(hhea).setUint16(34, numGlyphs);

  const head = new Uint8Array(tables.get('head'));
  viewOf(head).setUint32(8, 0);
  viewOf(head).setInt16(50, 1);
  const post = new Uint8Array(32);
  post.set(tables.get('post').subarray(0, 32));
  viewOf(post).setUint32(0, 0x00030000);

  const postScriptName = `${subsetTag(kept)}+${readPostScriptName(tables.get('name')).replace(/^[A-Z]{6}\+/, '')}`;
  const out = new Map(tables);
  out.set('glyf', glyfOut);
  out.set('loca', locaOut);
  out.set('hmtx', hmtxOut);
  out.set('hhea', hhea);
  out.set('head', head);
  out.set('post', post);
  out.set('cmap', makeCmap(mapped));
  out.set('name', renameFont(tables.get('name'), postScriptName));
  return {
    bytes: writeFont(out),
    postScriptName,
    glyphIds: kept,
    outlinedGlyphIds: kept.filter(id => glyphData(id).byteLength > 0),
  };
}

/**
 * The kept glyph set of a subsetTrueTypeGlyphs result (.notdef, outlined and
 * mapped glyphs).
 * @param {Uint8Array} fontBytes a TrueType (glyf) font
 */
export function retainedSubsetGlyphIds(fontBytes) {
  const tables = readTables(fontBytes instanceof Uint8Array ? fontBytes : new Uint8Array(fontBytes));
  const numGlyphs = viewOf(tables.get('maxp')).getUint16(4);
  const locations = glyphLocations(tables, numGlyphs);
  const ids = new Set([0, ...readCmapEntries(tables.get('cmap')).map(([, glyph]) => glyph)]);
  for (let id = 0; id < numGlyphs; id += 1) {
    if (locations[id + 1] > locations[id]) ids.add(id);
  }
  return [...ids].filter(id => id < numGlyphs).sort((a, b) => a - b);
}

function writeFont(out) {
  const tags = KEPT_TABLES.filter(tag => out.has(tag)).sort();
  const directoryLength = 12 + tags.length * 16;
  const total = directoryLength + tags.reduce((sum, tag) => sum + align4(out.get(tag).byteLength), 0);
  const bytes = new Uint8Array(total);
  const view = viewOf(bytes);
  const entrySelector = Math.floor(Math.log2(tags.length));
  view.setUint32(0, 0x00010000);
  view.setUint16(4, tags.length);
  view.setUint16(6, 16 * 2 ** entrySelector);
  view.setUint16(8, entrySelector);
  view.setUint16(10, tags.length * 16 - 16 * 2 ** entrySelector);
  let offset = directoryLength;
  let headOffset = 0;
  tags.forEach((tag, index) => {
    const table = out.get(tag);
    const record = 12 + index * 16;
    for (let char = 0; char < 4; char += 1) bytes[record + char] = tag.charCodeAt(char);
    view.setUint32(record + 4, checksum(table));
    view.setUint32(record + 8, offset);
    view.setUint32(record + 12, table.byteLength);
    bytes.set(table, offset);
    if (tag === 'head') headOffset = offset;
    offset += align4(table.byteLength);
  });
  view.setUint32(headOffset + 8, (SFNT_CHECKSUM_MAGIC - checksum(bytes)) >>> 0);
  return bytes;
}
