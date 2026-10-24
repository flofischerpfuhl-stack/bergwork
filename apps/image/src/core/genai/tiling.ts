export interface AiTile {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Feather on each interior edge; document edges remain full weight. */
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Deterministic coverage with overlap. Every source pixel is covered and no tile exceeds tileSize. */
export function aiTiles(width: number, height: number, tileSize = 512, overlap = 64): AiTile[] {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError('Invalid image size');
  if (!Number.isInteger(tileSize) || tileSize < 16 || overlap < 0 || overlap * 2 >= tileSize) throw new RangeError('Invalid tile geometry');
  const xs = starts(width, tileSize, overlap), ys = starts(height, tileSize, overlap), result: AiTile[] = [];
  for (const y of ys) for (const x of xs) {
    const w = Math.min(tileSize, width - x), h = Math.min(tileSize, height - y);
    result.push({ x, y, width: w, height: h,
      left: x === 0 ? 0 : overlap, top: y === 0 ? 0 : overlap,
      right: x + w === width ? 0 : overlap, bottom: y + h === height ? 0 : overlap });
  }
  return result;
}

function starts(length: number, tileSize: number, overlap: number): number[] {
  if (length <= tileSize) return [0];
  const step = tileSize - overlap * 2, result: number[] = [];
  for (let value = 0; value < length; value += step) {
    const next = Math.min(value, length - tileSize);
    if (result.at(-1) !== next) result.push(next);
    if (next + tileSize >= length) break;
  }
  return result;
}

/** Raised-cosine feather. Adjacent tiles are normalized during assembly, so seams do not darken. */
export function tileWeight(tile: AiTile, x: number, y: number): number {
  const edge = (distance: number, feather: number) => feather > 0 && distance < feather
    ? 0.5 - 0.5 * Math.cos(Math.PI * (distance + 0.5) / feather) : 1;
  return edge(x, tile.left) * edge(y, tile.top)
    * edge(tile.width - 1 - x, tile.right) * edge(tile.height - 1 - y, tile.bottom);
}

export function extractRgba(source: Uint8Array, sourceWidth: number, tile: AiTile): Uint8Array {
  const output = new Uint8Array(tile.width * tile.height * 4);
  for (let y = 0; y < tile.height; y++) {
    const from = ((tile.y + y) * sourceWidth + tile.x) * 4;
    output.set(source.subarray(from, from + tile.width * 4), y * tile.width * 4);
  }
  return output;
}

export function extractMask(source: Uint8Array, sourceWidth: number, tile: AiTile): Uint8Array {
  const output = new Uint8Array(tile.width * tile.height);
  for (let y = 0; y < tile.height; y++) {
    const from = (tile.y + y) * sourceWidth + tile.x;
    output.set(source.subarray(from, from + tile.width), y * tile.width);
  }
  return output;
}

/** Pads a partial fixed-size model tile by repeating edge pixels; padded mask pixels remain known/unselected. */
export function padFixedTile(rgba: Uint8Array, mask: Uint8Array, width: number, height: number, size: number): {
  readonly rgba: Uint8Array; readonly mask: Uint8Array;
} {
  if (![width, height, size].every((value) => Number.isInteger(value) && value > 0)
    || width > size || height > size || rgba.length !== width * height * 4 || mask.length !== width * height) {
    throw new RangeError('Invalid fixed model tile');
  }
  if (width === size && height === size) return { rgba, mask };
  const padded = new Uint8Array(size * size * 4), paddedMask = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sourceX = Math.min(x, width - 1), sourceY = Math.min(y, height - 1);
    const from = (sourceY * width + sourceX) * 4, to = (y * size + x) * 4;
    padded.set(rgba.subarray(from, from + 4), to);
    if (x < width && y < height) paddedMask[y * size + x] = mask[y * width + x]!;
  }
  return { rgba: padded, mask: paddedMask };
}

export function cropFixedTile(rgba: Uint8Array, size: number, width: number, height: number): Uint8Array {
  if (![width, height, size].every((value) => Number.isInteger(value) && value > 0)
    || width > size || height > size || rgba.length !== size * size * 4) throw new RangeError('Invalid fixed model output');
  if (width === size && height === size) return rgba;
  const output = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) output.set(rgba.subarray(y * size * 4, y * size * 4 + width * 4), y * width * 4);
  return output;
}

/** Accumulates an RGBA tile into float sums; output-space scale may be 1, 2 or 4. */
export function accumulateTile(sums: Float32Array, weights: Float32Array, outputWidth: number,
  rgba: Uint8Array, tile: AiTile, scale: number): void {
  const w = tile.width * scale, h = tile.height * scale;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const weight = tileWeight(tile, (x + 0.5) / scale - 0.5, (y + 0.5) / scale - 0.5);
    const destination = ((tile.y * scale + y) * outputWidth + tile.x * scale + x);
    const source = (y * w + x) * 4;
    weights[destination] = weights[destination]! + weight;
    for (let c = 0; c < 4; c++) {
      const at = destination * 4 + c;
      sums[at] = sums[at]! + rgba[source + c]! * weight;
    }
  }
}

export function finishTiles(sums: Float32Array, weights: Float32Array): Uint8Array {
  const output = new Uint8Array(sums.length);
  for (let i = 0; i < weights.length; i++) {
    const weight = weights[i] || 1;
    for (let c = 0; c < 4; c++) output[i * 4 + c] = Math.max(0, Math.min(255, Math.round(sums[i * 4 + c]! / weight)));
  }
  return output;
}
