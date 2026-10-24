/** Adobe/IRIDAS `.cube` parser and CPU lookup. LUT rows use the file's red-fastest order. */
export interface CubeLut {
  readonly title: string;
  readonly domainMin: readonly [number, number, number];
  readonly domainMax: readonly [number, number, number];
  readonly size1D: number;
  readonly size3D: number;
  readonly data1D: Float32Array | null;
  readonly data3D: Float32Array | null;
}

function triple(parts: readonly string[], line: number): [number, number, number] {
  if (parts.length !== 3) throw new SyntaxError(`Invalid .cube row at line ${line}`);
  const values = parts.map(Number);
  if (!values.every(Number.isFinite)) throw new SyntaxError(`Invalid .cube number at line ${line}`);
  return [values[0]!, values[1]!, values[2]!];
}

/** Parses UTF-8 LUT text. 1D and 3D sizes are independently limited to the product maximum 65. */
export function parseCubeLut(source: string | Uint8Array): CubeLut {
  const text = typeof source === 'string' ? source : new TextDecoder('utf-8', { fatal: true }).decode(source);
  let title = '', size1D = 0, size3D = 0;
  let domainMin: [number, number, number] = [0, 0, 0], domainMax: [number, number, number] = [1, 1, 1];
  const rows: number[] = [];
  for (const [index, raw] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const firstSpace = line.search(/\s/), keyword = firstSpace < 0 ? line : line.slice(0, firstSpace);
    const rest = firstSpace < 0 ? '' : line.slice(firstSpace).trim();
    if (keyword === 'TITLE') {
      const match = /^"(.*)"$/.exec(rest); if (!match) throw new SyntaxError(`Invalid .cube TITLE at line ${index + 1}`);
      title = match[1]!;
    } else if (keyword === 'DOMAIN_MIN') domainMin = triple(rest.split(/\s+/), index + 1);
    else if (keyword === 'DOMAIN_MAX') domainMax = triple(rest.split(/\s+/), index + 1);
    else if (keyword === 'LUT_1D_SIZE' || keyword === 'LUT_3D_SIZE') {
      const size = Number(rest);
      if (!Number.isInteger(size) || size < 2 || size > 65) throw new RangeError(`.cube size must be 2…65 at line ${index + 1}`);
      if (keyword === 'LUT_1D_SIZE') size1D = size; else size3D = size;
    } else if (/^[+-.0-9]/.test(keyword)) rows.push(...triple(line.split(/\s+/), index + 1));
    else throw new SyntaxError(`Unsupported .cube directive ${keyword} at line ${index + 1}`);
  }
  if (!size1D && !size3D) throw new SyntaxError('.cube file has no LUT size');
  if (domainMin.some((v, i) => !(v < domainMax[i]!))) throw new RangeError('.cube domain minimum must be below maximum');
  const values1D = size1D * 3, values3D = size3D * size3D * size3D * 3;
  if (rows.length !== values1D + values3D) throw new SyntaxError(`.cube has ${rows.length / 3} rows; expected ${(values1D + values3D) / 3}`);
  return { title, domainMin, domainMax, size1D, size3D,
    data1D: size1D ? new Float32Array(rows.slice(0, values1D)) : null,
    data3D: size3D ? new Float32Array(rows.slice(values1D)) : null };
}

function clamp(value: number, lo = 0, hi = 1): number { return Math.min(hi, Math.max(lo, value)); }
function sample1d(data: Float32Array, size: number, channel: number, value: number): number {
  const x = clamp(value) * (size - 1), lo = Math.floor(x), hi = Math.min(size - 1, lo + 1), t = x - lo;
  return data[lo * 3 + channel]! + (data[hi * 3 + channel]! - data[lo * 3 + channel]!) * t;
}
function fetch3d(data: Float32Array, size: number, r: number, g: number, b: number, channel: number): number {
  return data[((b * size + g) * size + r) * 3 + channel]!;
}

export function lookupCube(lut: CubeLut, red: number, green: number, blue: number,
  interpolation: 'trilinear' | 'tetrahedral' = 'tetrahedral'): [number, number, number] {
  let r = clamp((red - lut.domainMin[0]) / (lut.domainMax[0] - lut.domainMin[0]));
  let g = clamp((green - lut.domainMin[1]) / (lut.domainMax[1] - lut.domainMin[1]));
  let b = clamp((blue - lut.domainMin[2]) / (lut.domainMax[2] - lut.domainMin[2]));
  if (lut.data1D) {
    r = sample1d(lut.data1D, lut.size1D, 0, r); g = sample1d(lut.data1D, lut.size1D, 1, g); b = sample1d(lut.data1D, lut.size1D, 2, b);
  }
  const data = lut.data3D;
  if (!data) return [clamp(r), clamp(g), clamp(b)];
  const n = lut.size3D, xr = clamp(r) * (n - 1), xg = clamp(g) * (n - 1), xb = clamp(b) * (n - 1);
  const r0 = Math.floor(xr), g0 = Math.floor(xg), b0 = Math.floor(xb);
  const r1 = Math.min(n - 1, r0 + 1), g1 = Math.min(n - 1, g0 + 1), b1 = Math.min(n - 1, b0 + 1);
  const fr = xr - r0, fg = xg - g0, fb = xb - b0, out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    if (interpolation === 'trilinear') {
      let sum = 0;
      for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        sum += fetch3d(data, n, dx ? r1 : r0, dy ? g1 : g0, dz ? b1 : b0, c)
          * (dx ? fr : 1 - fr) * (dy ? fg : 1 - fg) * (dz ? fb : 1 - fb);
      }
      out[c] = clamp(sum); continue;
    }
    const c000 = fetch3d(data, n, r0, g0, b0, c), c111 = fetch3d(data, n, r1, g1, b1, c);
    let value: number;
    // Six tetrahedra of the unit cube; this is the common Adobe/Resolve ordering.
    if (fr >= fg) {
      if (fg >= fb) value = c000 + fr * (fetch3d(data, n, r1, g0, b0, c) - c000)
        + fg * (fetch3d(data, n, r1, g1, b0, c) - fetch3d(data, n, r1, g0, b0, c))
        + fb * (c111 - fetch3d(data, n, r1, g1, b0, c));
      else if (fr >= fb) value = c000 + fr * (fetch3d(data, n, r1, g0, b0, c) - c000)
        + fb * (fetch3d(data, n, r1, g0, b1, c) - fetch3d(data, n, r1, g0, b0, c))
        + fg * (c111 - fetch3d(data, n, r1, g0, b1, c));
      else value = c000 + fb * (fetch3d(data, n, r0, g0, b1, c) - c000)
        + fr * (fetch3d(data, n, r1, g0, b1, c) - fetch3d(data, n, r0, g0, b1, c))
        + fg * (c111 - fetch3d(data, n, r1, g0, b1, c));
    } else if (fr >= fb) value = c000 + fg * (fetch3d(data, n, r0, g1, b0, c) - c000)
      + fr * (fetch3d(data, n, r1, g1, b0, c) - fetch3d(data, n, r0, g1, b0, c))
      + fb * (c111 - fetch3d(data, n, r1, g1, b0, c));
    else if (fg >= fb) value = c000 + fg * (fetch3d(data, n, r0, g1, b0, c) - c000)
      + fb * (fetch3d(data, n, r0, g1, b1, c) - fetch3d(data, n, r0, g1, b0, c))
      + fr * (c111 - fetch3d(data, n, r0, g1, b1, c));
    else value = c000 + fb * (fetch3d(data, n, r0, g0, b1, c) - c000)
      + fg * (fetch3d(data, n, r0, g1, b1, c) - fetch3d(data, n, r0, g0, b1, c))
      + fr * (c111 - fetch3d(data, n, r0, g1, b1, c));
    out[c] = clamp(value);
  }
  return out;
}
