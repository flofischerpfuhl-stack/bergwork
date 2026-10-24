export type PsdKnockoutMode = 'shallow' | 'deep';

export interface PsdCmykAdjustmentChannels {
  readonly levelsBlack?: { readonly black: number; readonly gamma: number; readonly white: number;
    readonly outputBlack: number; readonly outputWhite: number };
  readonly curvesBlack?: readonly { readonly x: number; readonly y: number }[];
}

function matches(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset < 0 || offset + value.length > bytes.length) return false;
  for (let index = 0; index < value.length; index++) if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  return true;
}

function blockValue(bytes: Uint8Array, offset: number, bytesNeeded: number): number | null {
  if (offset + 12 + bytesNeeded > bytes.length || !matches(bytes, offset, '8BIM')) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), length = view.getUint32(offset + 8);
  return length >= bytesNeeded && offset + 12 + length <= bytes.length ? offset + 12 : null;
}

function u64(view: DataView, offset: number): number | null {
  if (offset + 8 > view.byteLength) return null;
  const value = view.getUint32(offset) * 0x1_0000_0000 + view.getUint32(offset + 4);
  return Number.isSafeInteger(value) ? value : null;
}

function has8EleMetadata(bytes: Uint8Array, start: number, length: number): boolean {
  const end = Math.min(bytes.length, start + length);
  for (let offset = start; offset + 4 <= end; offset++) if (matches(bytes, offset, '8ELE')) return true;
  return false;
}

/**
 * Bounded compatibility pass for Photoshop layer records rejected before ag-psd can expose them.
 * Photoshop 23 writes `8ELE` metadata item lengths inside `shmd`; ag-psd 31 assumes `8BIM`
 * items and overruns the layer record. Metadata is non-visual, so its outer key is hidden from
 * ag-psd while the bytes remain intact. Photoshop also writes -1 on one axis for an empty
 * generated-fill cache; normalize only that zero-area sentinel. No pixel/composite data is read.
 */
export function preparePsdForAgParser(bytes: Uint8Array, emptyCacheLayerIds?: Set<number>): Uint8Array {
  if (bytes.length < 34 || !matches(bytes, 0, '8BPS')) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4);
  if (version !== 1 && version !== 2) return bytes;
  let offset = 26;
  const skipU32Section = (): boolean => {
    if (offset + 4 > bytes.length) return false;
    const length = view.getUint32(offset); offset += 4;
    if (offset + length > bytes.length) return false;
    offset += length; return true;
  };
  if (!skipU32Section() || !skipU32Section()) return bytes;
  const layerSectionLength = version === 2 ? u64(view, offset) : offset + 4 <= bytes.length ? view.getUint32(offset) : null;
  if (layerSectionLength === null) return bytes;
  offset += version === 2 ? 8 : 4;
  const layerSectionEnd = offset + layerSectionLength;
  if (layerSectionEnd > bytes.length || offset + (version === 2 ? 8 : 4) + 2 > layerSectionEnd) return bytes;
  const layerInfoLength = version === 2 ? u64(view, offset) : view.getUint32(offset);
  if (layerInfoLength === null) return bytes;
  offset += version === 2 ? 8 : 4;
  const layerInfoEnd = offset + layerInfoLength;
  if (layerInfoEnd > layerSectionEnd || offset + 2 > layerInfoEnd) return bytes;
  const count = Math.abs(view.getInt16(offset)); offset += 2;
  const foundEmptyCacheIds = new Set<number>();
  let output: Uint8Array | null = null;
  const writable = (): { bytes: Uint8Array; view: DataView } => {
    if (!output) output = bytes.slice();
    return { bytes: output, view: new DataView(output.buffer, output.byteOffset, output.byteLength) };
  };
  for (let layer = 0; layer < count; layer++) {
    const record = offset;
    if (offset + 18 > layerInfoEnd) return bytes;
    const top = view.getInt32(offset), left = view.getInt32(offset + 4);
    const bottom = view.getInt32(offset + 8), right = view.getInt32(offset + 12);
    offset += 16;
    const channelCount = view.getUint16(offset); offset += 2;
    const channelEntryBytes = version === 2 ? 10 : 6;
    if (offset + channelCount * channelEntryBytes + 16 > layerInfoEnd) return bytes;
    let emptyChannels = true;
    for (let channel = 0; channel < channelCount; channel++) {
      const lengthAt = offset + channel * channelEntryBytes + 2;
      const length = version === 2 ? u64(view, lengthAt) : view.getUint32(lengthAt);
      if (length !== 2) emptyChannels = false;
    }
    offset += channelCount * channelEntryBytes + 12;
    const extraLength = view.getUint32(offset); offset += 4;
    const extraEnd = offset + extraLength;
    if (extraEnd > layerInfoEnd) return bytes;
    const repairedEmptyCache = emptyChannels && ((right === left && bottom < top) || (bottom === top && right < left));
    if (emptyChannels && right === left && bottom < top) writable().view.setInt32(record + 8, top);
    if (emptyChannels && bottom === top && right < left) writable().view.setInt32(record + 12, left);

    let extra = offset;
    for (let section = 0; section < 2; section++) {
      if (extra + 4 > extraEnd) { extra = extraEnd; break; }
      const length = view.getUint32(extra); extra += 4;
      if (extra + length > extraEnd) { extra = extraEnd; break; }
      extra += length;
    }
    if (extra < extraEnd) {
      const nameLength = bytes[extra] ?? 0;
      extra += Math.min(extraEnd - extra, (nameLength + 4) & ~3);
    }
    while (extra + 12 <= extraEnd) {
      const signature = matches(bytes, extra, '8BIM') || matches(bytes, extra, '8B64');
      if (!signature) break;
      const keyOffset = extra + 4, key = String.fromCharCode(...bytes.subarray(keyOffset, keyOffset + 4));
      const large = matches(bytes, extra, '8B64') || (version === 2
        && ['LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD', 'cinf'].includes(key));
      const length = large ? u64(view, extra + 8) : view.getUint32(extra + 8);
      if (length === null) break;
      const header = large ? 16 : 12, payload = extra + header;
      if (payload + length > extraEnd) break;
      if (key === 'shmd' && has8EleMetadata(bytes, payload, length)) {
        writable().bytes.set(new Uint8Array([0x66, 0x57, 0x53, 0x4d]), keyOffset); // `fWSM`
      }
      if (repairedEmptyCache && key === 'lyid' && length >= 4 && payload + 4 <= extraEnd) {
        foundEmptyCacheIds.add(view.getUint32(payload));
      }
      extra = payload + length + (length & 1);
    }
    offset = extraEnd;
  }
  for (const id of foundEmptyCacheIds) emptyCacheLayerIds?.add(id);
  return output ?? bytes;
}

/** Native `lyid`/`knko` reader. ag-psd converts knko 1 and 2 to the same boolean. */
export function readPsdLayerKnockouts(bytes: Uint8Array): ReadonlyMap<number, PsdKnockoutMode> {
  const result = new Map<number, PsdKnockoutMode>(), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const layerIds: number[] = [];
  for (let offset = 0; offset + 16 <= bytes.length; offset++) {
    if (!matches(bytes, offset, '8BIMlyid')) continue;
    const value = blockValue(bytes, offset, 4);
    if (value !== null) layerIds.push(offset); offset += 11;
  }
  for (let index = 0; index < layerIds.length; index++) {
    const start = layerIds[index]!, end = layerIds[index + 1] ?? bytes.length;
    const idAt = blockValue(bytes, start, 4);
    if (idAt === null) continue;
    const id = view.getUint32(idAt);
    for (let offset = start + 12; offset + 13 <= end; offset++) {
      if (!matches(bytes, offset, '8BIMknko')) continue;
      const value = blockValue(bytes, offset, 1);
      if (value === null) break;
      const mode = bytes[value];
      if (mode === 1) result.set(id, 'shallow');
      else if (mode === 2) result.set(id, 'deep');
      break;
    }
  }
  return result;
}

/** Rewrites only validated `knko` payload bytes for layer IDs emitted by the product writer. */
export function patchPsdLayerKnockouts(bytes: Uint8Array,
  modes: ReadonlyMap<number, PsdKnockoutMode>): Uint8Array {
  if (!modes.size) return bytes;
  const output = bytes.slice(), view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  const layerIds: number[] = [];
  for (let offset = 0; offset + 16 <= output.length; offset++) {
    if (!matches(output, offset, '8BIMlyid')) continue;
    if (blockValue(output, offset, 4) !== null) layerIds.push(offset);
    offset += 11;
  }
  for (let index = 0; index < layerIds.length; index++) {
    const start = layerIds[index]!, end = layerIds[index + 1] ?? output.length;
    const idAt = blockValue(output, start, 4);
    if (idAt === null) continue;
    const mode = modes.get(view.getUint32(idAt));
    if (!mode) continue;
    for (let offset = start + 12; offset + 13 <= end; offset++) {
      if (!matches(output, offset, '8BIMknko')) continue;
      const value = blockValue(output, offset, 1);
      if (value !== null) output[value] = mode === 'shallow' ? 1 : 2;
      break;
    }
  }
  return output;
}

/**
 * Reads the fifth (black) channel which ag-psd 31 drops from legacy `levl`/`curv`
 * blocks. In a layer record these blocks precede `lyid`, so the next bounded layer ID
 * owns the value. The first four channels remain parsed by ag-psd.
 */
export function readPsdCmykAdjustmentChannels(bytes: Uint8Array): ReadonlyMap<number, PsdCmykAdjustmentChannels> {
  const result = new Map<number, PsdCmykAdjustmentChannels>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ids: { readonly offset: number; readonly id: number }[] = [];
  for (let offset = 0; offset + 16 <= bytes.length; offset++) {
    if (!matches(bytes, offset, '8BIMlyid')) continue;
    const value = blockValue(bytes, offset, 4);
    if (value !== null) ids.push({ offset, id: view.getUint32(value) });
    offset += 11;
  }
  const ownerAfter = (offset: number): number | null => ids.find((entry) => entry.offset > offset)?.id ?? null;
  for (let offset = 0; offset + 16 <= bytes.length; offset++) {
    const levels = matches(bytes, offset, '8BIMlevl'), curves = matches(bytes, offset, '8BIMcurv');
    if (!levels && !curves) continue;
    const payload = blockValue(bytes, offset, levels ? 52 : 7), id = ownerAfter(offset);
    if (payload === null || id === null) continue;
    if (levels && view.getUint16(payload) === 2) {
      const at = payload + 2 + 4 * 10;
      result.set(id, { ...result.get(id), levelsBlack: { black: view.getInt16(at), white: view.getInt16(at + 2),
        outputBlack: view.getInt16(at + 4), outputWhite: view.getInt16(at + 6), gamma: view.getInt16(at + 8) / 100 } });
    } else if (curves && bytes[payload] === 0 && view.getUint16(payload + 1) === 1) {
      const mask = view.getUint16(payload + 5);
      let at = payload + 7;
      for (let channel = 0; channel < 16; channel++) if ((mask & (1 << channel)) !== 0) {
        if (at + 2 > bytes.length) break;
        const count = view.getUint16(at); at += 2;
        if (at + count * 4 > bytes.length) break;
        const points: { x: number; y: number }[] = [];
        for (let point = 0; point < count; point++, at += 4) points.push({ y: view.getInt16(at), x: view.getInt16(at + 2) });
        if (channel === 4) result.set(id, { ...result.get(id), curvesBlack: points });
      }
    }
  }
  return result;
}
