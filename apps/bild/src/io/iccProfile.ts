/**
 * The document working-space ICC profile written into exports (PRODUCT-PLAN A3 "Export mit eingebettetem
 * Profil"). Documents are sRGB today (`ProjectManifestV2.colorSpace`), so this builds a compact ICC v2.1
 * display profile for IEC 61966-2.1 sRGB: Bradford-adapted D50 colorants and a 1024-entry sRGB tone
 * curve shared by the three TRC tags (≈ 2.5 KB). ICC v2 rather than v4 because older viewers and
 * Windows' photo stack still ignore v4 profiles. Built in TypeScript so exports need no Little CMS load.
 */

let cached: Uint8Array | null = null;

/** sRGB → XYZ(D50) colorant columns (Bradford), as in the ICC's sRGB v2 reference profiles. */
const COLORANTS = {
  red: [0.4360747, 0.2225045, 0.0139322],
  green: [0.3850649, 0.7168786, 0.0971045],
  blue: [0.1430804, 0.0606169, 0.7141733],
} as const;
const D50 = [0.9642, 1.0, 0.8249] as const;
const D65 = [0.9505, 1.0, 1.089] as const;

export function srgbIccProfile(): Uint8Array {
  if (cached) return cached.slice();
  const description = 'sRGB IEC61966-2.1 (Fernwork)';
  const tags: [string, Uint8Array][] = [];
  const desc = textDescription(description);
  const curve = srgbCurve(1024);
  tags.push(['desc', desc], ['cprt', text('No copyright, use freely')], ['wtpt', xyz(D65)], ['bkpt', xyz([0, 0, 0])],
    ['rXYZ', xyz(COLORANTS.red)], ['gXYZ', xyz(COLORANTS.green)], ['bXYZ', xyz(COLORANTS.blue)],
    ['rTRC', curve], ['gTRC', curve], ['bTRC', curve]);
  // Tag data is laid out once per distinct payload (the three TRC tags share one curve).
  const tableSize = 4 + tags.length * 12;
  const offsets = new Map<Uint8Array, number>();
  let at = align4(128 + tableSize);
  for (const [, data] of tags) if (!offsets.has(data)) { offsets.set(data, at); at = align4(at + data.length); }
  const profile = new Uint8Array(at);
  const view = new DataView(profile.buffer);
  view.setUint32(0, at);
  ascii(profile, 4, 'lcms');
  view.setUint32(8, 0x02100000);
  ascii(profile, 12, 'mntr'); ascii(profile, 16, 'RGB '); ascii(profile, 20, 'XYZ ');
  // Fixed creation date keeps exports byte-reproducible.
  [2026, 1, 1, 0, 0, 0].forEach((value, index) => view.setUint16(24 + index * 2, value));
  ascii(profile, 36, 'acsp');
  view.setUint32(64, 0); // perceptual
  writeXyz(view, 68, D50);
  ascii(profile, 80, 'FWRK');
  view.setUint32(128, tags.length);
  tags.forEach(([signature, data], index) => {
    const entry = 132 + index * 12;
    ascii(profile, entry, signature);
    view.setUint32(entry + 4, offsets.get(data)!);
    view.setUint32(entry + 8, data.length);
  });
  for (const [data, offset] of offsets) profile.set(data, offset);
  cached = profile;
  return profile.slice();
}

function align4(value: number): number { return (value + 3) & ~3; }

function ascii(target: Uint8Array, at: number, value: string): void {
  for (let i = 0; i < value.length; i++) target[at + i] = value.charCodeAt(i);
}

function s15Fixed16(view: DataView, at: number, value: number): void { view.setInt32(at, Math.round(value * 65536)); }
function writeXyz(view: DataView, at: number, value: readonly number[]): void {
  s15Fixed16(view, at, value[0]!); s15Fixed16(view, at + 4, value[1]!); s15Fixed16(view, at + 8, value[2]!);
}

function xyz(value: readonly number[]): Uint8Array {
  const data = new Uint8Array(20);
  ascii(data, 0, 'XYZ ');
  writeXyz(new DataView(data.buffer), 8, value);
  return data;
}

function text(value: string): Uint8Array {
  const data = new Uint8Array(8 + value.length + 1);
  ascii(data, 0, 'text'); ascii(data, 8, value);
  return data;
}

/** ICC v2 textDescriptionType: ASCII part, empty Unicode and ScriptCode parts. */
function textDescription(value: string): Uint8Array {
  const count = value.length + 1;
  const data = new Uint8Array(12 + count + 4 + 4 + 2 + 1 + 67);
  const view = new DataView(data.buffer);
  ascii(data, 0, 'desc');
  view.setUint32(8, count);
  ascii(data, 12, value);
  return data;
}

function srgbCurve(entries: number): Uint8Array {
  const data = new Uint8Array(12 + entries * 2);
  const view = new DataView(data.buffer);
  ascii(data, 0, 'curv');
  view.setUint32(8, entries);
  for (let i = 0; i < entries; i++) {
    const encoded = i / (entries - 1);
    const linear = encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
    view.setUint16(12 + i * 2, Math.round(linear * 65535));
  }
  return data;
}
