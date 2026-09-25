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
