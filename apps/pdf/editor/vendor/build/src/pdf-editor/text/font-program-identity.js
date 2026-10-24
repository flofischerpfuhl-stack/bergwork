const asBytes = value => value instanceof Uint8Array ? value : new Uint8Array(value);

/** Reads display identity from the first sfnt face. The PDFium worker parses
 * and independently verifies the same bytes when the resource is registered. */
export function fontProgramIdentity(value) {
  const bytes = asBytes(value);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = offset => offset >= 0 && offset + 4 <= bytes.length
    ? String.fromCharCode(...bytes.subarray(offset, offset + 4)) : '';
  const sfnt = tag(0) === 'ttcf' && bytes.length >= 16 ? view.getUint32(12, false) : 0;
  if (sfnt < 0 || sfnt + 12 > bytes.length) throw new TypeError('Font directory is truncated.');
  const count = view.getUint16(sfnt + 4, false);
  if (!count || count > 4096 || sfnt + 12 + count * 16 > bytes.length) throw new TypeError('Font table directory is invalid.');
  const tables = new Map();
  for (let index = 0; index < count; index += 1) {
    const record = sfnt + 12 + index * 16;
    const offset = view.getUint32(record + 8, false);
    const length = view.getUint32(record + 12, false);
    if (offset > bytes.length || length > bytes.length - offset) throw new TypeError('Font table is truncated.');
    tables.set(tag(record), { offset, length });
  }
  const os2 = tables.get('OS/2');
  let weight = '400';
  let style = 'normal';
  if (os2?.length >= 64) {
    const weightClass = view.getUint16(os2.offset + 4, false);
    const selection = view.getUint16(os2.offset + 62, false);
    weight = weightClass >= 600 || Boolean(selection & 0x20) ? '700' : '400';
    style = selection & 0x01 ? 'italic' : 'normal';
  }
  const name = tables.get('name');
  if (!name || name.length < 6) throw new TypeError('Font family name is unavailable.');
  const nameCount = view.getUint16(name.offset + 2, false);
  const storage = name.offset + view.getUint16(name.offset + 4, false);
  if (nameCount > 4096 || name.offset + 6 + nameCount * 12 > name.offset + name.length || storage > name.offset + name.length) {
    throw new TypeError('Font name table is invalid.');
  }
  const candidates = [];
  for (let index = 0; index < nameCount; index += 1) {
    const record = name.offset + 6 + index * 12;
    const platform = view.getUint16(record, false);
    const language = view.getUint16(record + 4, false);
    const nameId = view.getUint16(record + 6, false);
    if (nameId !== 1 && nameId !== 16) continue;
    const length = view.getUint16(record + 8, false);
    const start = storage + view.getUint16(record + 10, false);
    if (start < storage || start + length > name.offset + name.length) continue;
    let family = '';
    if (platform === 0 || platform === 3) {
      if (length % 2) continue;
      for (let cursor = start; cursor < start + length; cursor += 2) family += String.fromCharCode(view.getUint16(cursor, false));
    } else if (platform === 1) family = new TextDecoder('windows-1252').decode(bytes.subarray(start, start + length));
    family = family.replace(/\0/gu, '').trim();
    if (family) candidates.push({ family, score: (nameId === 16 ? 8 : 0) + (platform === 3 ? 4 : 0) + (language === 0x0409 ? 2 : 0) });
  }
  candidates.sort((left, right) => right.score - left.score);
  if (!candidates[0]?.family) throw new TypeError('Font family name is unavailable.');
  return Object.freeze({ family: candidates[0].family, weight, style });
}
