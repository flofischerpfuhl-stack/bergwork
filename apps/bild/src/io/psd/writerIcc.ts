/** PSD image-resource 1039 (ICC profile), which ag-psd 31 deliberately leaves as a mock handler. */

function resource(profile: Uint8Array): Uint8Array {
  const padded = profile.length + (profile.length & 1);
  const output = new Uint8Array(12 + padded);
  output.set([0x38, 0x42, 0x49, 0x4d], 0); // 8BIM
  const view = new DataView(output.buffer);
  view.setUint16(4, 0x040f); // ICC profile
  // Empty Pascal name occupies two bytes: length plus even padding.
  view.setUint32(8, profile.length);
  output.set(profile, 12);
  return output;
}

/** Inserts an ICC image resource without changing any layer/image offsets stored inside later sections. */
export function attachPsdIccProfile(psd: Uint8Array, profile: Uint8Array): Uint8Array {
  if (!profile.length) throw new RangeError('PSD ICC profile must not be empty');
  if (psd.length < 34 || String.fromCharCode(...psd.subarray(0, 4)) !== '8BPS') {
    throw new Error('Invalid PSD output');
  }
  const input = new DataView(psd.buffer, psd.byteOffset, psd.byteLength);
  const colorLength = input.getUint32(26);
  const resourcesLengthAt = 30 + colorLength;
  if (resourcesLengthAt + 4 > psd.length) throw new Error('Truncated PSD colour-mode section');
  const resourcesLength = input.getUint32(resourcesLengthAt);
  const resourcesEnd = resourcesLengthAt + 4 + resourcesLength;
  if (resourcesEnd > psd.length) throw new Error('Truncated PSD image-resource section');
  const added = resource(profile);
  const output = new Uint8Array(psd.length + added.length);
  output.set(psd.subarray(0, resourcesEnd), 0);
  output.set(added, resourcesEnd);
  output.set(psd.subarray(resourcesEnd), resourcesEnd + added.length);
  new DataView(output.buffer).setUint32(resourcesLengthAt, resourcesLength + added.length);
  return output;
}
