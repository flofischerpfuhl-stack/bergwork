export type PsdKnockoutMode = 'shallow' | 'deep';

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
