const MAX_FONT_BYTES = 64 * 1024 * 1024;
const MAX_TABLES = 128;
const MAX_MAPPINGS = 65536;
const SFNT_CHECKSUM_MAGIC = 0xb1b0afba;

const u16 = (view, offset) => view.getUint16(offset, false);
const u32 = (view, offset) => view.getUint32(offset, false);
const put16 = (view, offset, value) => view.setUint16(offset, value, false);
const put32 = (view, offset, value) => view.setUint32(offset, value >>> 0, false);
const align4 = value => (value + 3) & ~3;

function tagAt(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function tagBytes(tag) {
  return Uint8Array.from([...tag].map(char => char.charCodeAt(0)));
}

function checksum(bytes) {
  let sum = 0;
  for (let offset = 0; offset < align4(bytes.length); offset += 4) {
    const word = ((bytes[offset] || 0) << 24) | ((bytes[offset + 1] || 0) << 16) |
      ((bytes[offset + 2] || 0) << 8) | (bytes[offset + 3] || 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}

function fail(message) {
  throw new TypeError(`Cannot derive TrueType cmap: ${message}`);
}

function parseSfnt(input) {
  if (!(input instanceof Uint8Array)) fail('font bytes must be a Uint8Array');
  if (input.byteLength < 12 || input.byteLength > MAX_FONT_BYTES) fail('font byte length is invalid');
  const bytes = new Uint8Array(input);
  const view = new DataView(bytes.buffer);
  if (u32(view, 0) !== 0x00010000) fail('only glyf/loca TrueType sfnt fonts are supported');
  const count = u16(view, 4);
  const directoryEnd = 12 + count * 16;
  if (!count || count >= MAX_TABLES || directoryEnd > bytes.length) fail('table directory is invalid');
  const tables = [];
  const tags = new Set();
  for (let index = 0; index < count; index += 1) {
    const record = 12 + index * 16;
    const tag = tagAt(bytes, record);
    const declaredChecksum = u32(view, record + 4);
    const offset = u32(view, record + 8);
    const length = u32(view, record + 12);
    if (tags.has(tag)) fail(`duplicate table ${tag}`);
    if (offset % 4 !== 0) fail(`table ${tag} offset is not aligned`);
    if (offset < directoryEnd || offset > bytes.length || length > bytes.length - offset) fail(`table ${tag} is out of bounds`);
    tags.add(tag);
    const tableBytes = bytes.slice(offset, offset + length);
    const checksumBytes = new Uint8Array(tableBytes);
    if (tag === 'head' && checksumBytes.length >= 12) checksumBytes.fill(0, 8, 12);
    if (checksum(checksumBytes) !== declaredChecksum) fail(`table ${tag} checksum is invalid`);
    tables.push({ tag, offset, length, bytes: tableBytes });
  }
  const ranges = tables.filter(table => table.length).sort((a, b) => a.offset - b.offset);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].offset < ranges[index - 1].offset + ranges[index - 1].length) fail('font tables overlap');
  }
  if (tags.has('cmap')) fail('an existing cmap table must never be replaced');
  for (const required of ['head', 'maxp', 'loca', 'glyf']) if (!tags.has(required)) fail(`required ${required} table is missing`);
  const head = tables.find(table => table.tag === 'head');
  const maxp = tables.find(table => table.tag === 'maxp');
  const loca = tables.find(table => table.tag === 'loca');
  const glyf = tables.find(table => table.tag === 'glyf');
  if (head.length < 54 || maxp.length < 6) fail('head or maxp table is truncated');
  if (checksum(bytes) !== SFNT_CHECKSUM_MAGIC) fail('full-font checksum is invalid');
  const numGlyphs = u16(new DataView(maxp.bytes.buffer), 4);
  const locaFormat = new DataView(head.bytes.buffer).getInt16(50, false);
  if (!numGlyphs || ![0, 1].includes(locaFormat)) fail('maxp glyph count or loca format is invalid');
  const locaEntryBytes = locaFormat ? 4 : 2;
  if (loca.length !== (numGlyphs + 1) * locaEntryBytes) fail('loca length disagrees with maxp glyph count');
  const locaView = new DataView(loca.bytes.buffer);
  let previousOffset = 0;
  for (let index = 0; index <= numGlyphs; index += 1) {
    const glyphOffset = locaFormat ? u32(locaView, index * 4) : u16(locaView, index * 2) * 2;
    if (glyphOffset < previousOffset || glyphOffset > glyf.length) fail('loca offsets are invalid for the glyf table');
    previousOffset = glyphOffset;
  }
  return { bytes, tables, numGlyphs };
}

function normalizeMappings(input, numGlyphs) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_MAPPINGS) fail('mapping list is invalid');
  const byScalar = new Map();
  for (const pair of input) {
    const scalar = Array.isArray(pair) ? pair[0] : pair?.unicode;
    const glyphId = Array.isArray(pair) ? pair[1] : pair?.glyphId;
    if (!Number.isSafeInteger(scalar) || scalar < 0 || scalar > 0x10ffff || (scalar >= 0xd800 && scalar <= 0xdfff)) {
      fail('mapping contains an invalid Unicode scalar');
    }
    if (!Number.isSafeInteger(glyphId) || glyphId <= 0 || glyphId >= numGlyphs || glyphId > 0xffff) {
      fail('mapping contains an invalid glyph ID');
    }
    if (byScalar.has(scalar) && byScalar.get(scalar) !== glyphId) fail('mapping contains conflicting glyph IDs');
    byScalar.set(scalar, glyphId);
  }
  return [...byScalar].sort((left, right) => left[0] - right[0]);
}

function makeCmap(mappings) {
  const groups = [];
  for (const [scalar, glyphId] of mappings) {
    const previous = groups.at(-1);
    if (previous && scalar === previous.end + 1 && glyphId === previous.startGlyph + scalar - previous.start) {
      previous.end = scalar;
    } else {
      groups.push({ start: scalar, end: scalar, startGlyph: glyphId });
    }
  }
  const bytes = new Uint8Array(28 + groups.length * 12);
  const view = new DataView(bytes.buffer);
  put16(view, 0, 0); put16(view, 2, 1);
  put16(view, 4, 3); put16(view, 6, 10); put32(view, 8, 12);
  put16(view, 12, 12); put16(view, 14, 0);
  put32(view, 16, 16 + groups.length * 12); put32(view, 20, 0); put32(view, 24, groups.length);
  groups.forEach((group, index) => {
    const offset = 28 + index * 12;
    put32(view, offset, group.start); put32(view, offset + 4, group.end); put32(view, offset + 8, group.startGlyph);
  });
  return bytes;
}

export function deriveTrueTypeCmap(fontBytes, verifiedMappings) {
  const sfnt = parseSfnt(fontBytes);
  const mappings = normalizeMappings(verifiedMappings, sfnt.numGlyphs);
  const sourceForProvenance = new Uint8Array(sfnt.bytes);
  const sourceHead = sfnt.tables.find(table => table.tag === 'head');
  sourceForProvenance.fill(0, sourceHead.offset + 8, sourceHead.offset + 12);
  const tables = [...sfnt.tables.map(table => ({ ...table, bytes: new Uint8Array(table.bytes) })),
    { tag: 'cmap', bytes: makeCmap(mappings) }].sort((a, b) => a.tag.localeCompare(b.tag));
  const count = tables.length;
  const highestPower = 2 ** Math.floor(Math.log2(count));
  let cursor = align4(12 + count * 16);
  for (const table of tables) {
    table.offset = cursor;
    table.length = table.bytes.length;
    cursor += align4(table.length);
    if (!Number.isSafeInteger(cursor) || cursor > MAX_FONT_BYTES) fail('derived font byte length exceeds the limit');
  }
  const output = new Uint8Array(cursor);
  const view = new DataView(output.buffer);
  put32(view, 0, 0x00010000); put16(view, 4, count);
  put16(view, 6, highestPower * 16); put16(view, 8, Math.log2(highestPower)); put16(view, 10, count * 16 - highestPower * 16);
  tables.forEach((table, index) => {
    const record = 12 + index * 16;
    output.set(tagBytes(table.tag), record);
    const content = new Uint8Array(table.bytes);
    if (table.tag === 'head') content.fill(0, 8, 12);
    put32(view, record + 4, checksum(content)); put32(view, record + 8, table.offset); put32(view, record + 12, table.length);
    output.set(content, table.offset);
  });
  const head = tables.find(table => table.tag === 'head');
  put32(view, head.offset + 8, (SFNT_CHECKSUM_MAGIC - checksum(output)) >>> 0);
  if (checksum(output) !== SFNT_CHECKSUM_MAGIC) fail('derived full-font checksum is invalid');
  return Object.freeze({
    bytes: output,
    provenance: Object.freeze({
      kind: 'verified-unicode-glyph-map-v1',
      sourceChecksum: checksum(sourceForProvenance) >>> 0,
      mappingChecksum: checksum(makeCmap(mappings)) >>> 0,
      mappings: mappings.length,
    }),
  });
}
