/** Guided mask refinement from Document/GuidedMatte.swift. */

const GUIDE_RED = 0.299;
const GUIDE_GREEN = 0.587;
const GUIDE_BLUE = 0.114;
const GUIDE_WEIGHTS = [GUIDE_RED, GUIDE_GREEN, GUIDE_BLUE] as const;

/** Mean over a clamped (2r+1)^2 square, using two running-sum passes. */
export function boxMean(source: Float32Array, width: number, height: number, radius: number): Float32Array {
  if (source.length !== width * height) throw new RangeError('Level buffer size does not match its dimensions');
  const r = Math.max(0, Math.trunc(radius));
  const span = r * 2 + 1;
  const pass = new Float32Array(source.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += source[row + Math.min(width - 1, Math.max(0, x))]!;
    for (let x = 0; x < width; x++) {
      pass[row + x] = sum / span;
      sum -= source[row + Math.min(width - 1, Math.max(0, x - r))]!;
      sum += source[row + Math.min(width - 1, Math.max(0, x + r + 1))]!;
    }
  }
  const result = new Float32Array(source.length);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += pass[Math.min(height - 1, Math.max(0, y)) * width + x]!;
    for (let y = 0; y < height; y++) {
      result[y * width + x] = sum / span;
      sum -= pass[Math.min(height - 1, Math.max(0, y - r)) * width + x]!;
      sum += pass[Math.min(height - 1, Math.max(0, y + r + 1)) * width + x]!;
    }
  }
  return result;
}

/** He, Sun & Tang guided filter, matching `GuidedMatte.filter`. */
export function guidedFilter(mask: Float32Array, guide: Float32Array, width: number, height: number,
  radius: number, epsilon = 1e-4): Float32Array {
  const count = width * height;
  if (mask.length !== count || guide.length !== count) throw new RangeError('Guided-filter buffer size mismatch');
  const meanGuide = boxMean(guide, width, height, radius);
  const meanMask = boxMean(mask, width, height, radius);
  const squares = new Float32Array(count), products = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    squares[i] = guide[i]! * guide[i]!;
    products[i] = guide[i]! * mask[i]!;
  }
  const meanSquares = boxMean(squares, width, height, radius);
  const meanProducts = boxMean(products, width, height, radius);
  const slope = new Float32Array(count), offset = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const variance = meanSquares[i]! - meanGuide[i]! * meanGuide[i]!;
    const covariance = meanProducts[i]! - meanGuide[i]! * meanMask[i]!;
    slope[i] = covariance / (variance + epsilon);
    offset[i] = meanMask[i]! - slope[i]! * meanGuide[i]!;
  }
  const meanSlope = boxMean(slope, width, height, radius);
  const meanOffset = boxMean(offset, width, height, radius);
  const result = new Float32Array(count);
  for (let i = 0; i < count; i++) result[i] = Math.min(1, Math.max(0, meanSlope[i]! * guide[i]! + meanOffset[i]!));
  return result;
}

/** Bilinear, pixel-centred scaling used in place of CGContext's high-quality interpolation. */
export function resizeLevels(source: Float32Array, sourceWidth: number, sourceHeight: number,
  width: number, height: number): Float32Array {
  if (source.length !== sourceWidth * sourceHeight) throw new RangeError('Level buffer size mismatch');
  if (sourceWidth === width && sourceHeight === height) return source.slice();
  const result = new Float32Array(width * height);
  const sx = sourceWidth / width, sy = sourceHeight / height;
  for (let y = 0; y < height; y++) {
    const py = (y + 0.5) * sy - 0.5;
    const y0 = Math.floor(py), y1 = y0 + 1, fy = py - y0;
    const ay = Math.min(sourceHeight - 1, Math.max(0, y0));
    const by = Math.min(sourceHeight - 1, Math.max(0, y1));
    for (let x = 0; x < width; x++) {
      const px = (x + 0.5) * sx - 0.5;
      const x0 = Math.floor(px), x1 = x0 + 1, fx = px - x0;
      const ax = Math.min(sourceWidth - 1, Math.max(0, x0));
      const bx = Math.min(sourceWidth - 1, Math.max(0, x1));
      const top = source[ay * sourceWidth + ax]! * (1 - fx) + source[ay * sourceWidth + bx]! * fx;
      const bottom = source[by * sourceWidth + ax]! * (1 - fx) + source[by * sourceWidth + bx]! * fx;
      result[y * width + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return result;
}

/** Bilinear scaling directly to mask bytes, avoiding a full-size Float32 intermediate. */
export function resizeLevelsToBytes(source: Float32Array, sourceWidth: number, sourceHeight: number,
  width: number, height: number): Uint8Array {
  if (source.length !== sourceWidth * sourceHeight) throw new RangeError('Level buffer size mismatch');
  const result = new Uint8Array(width * height), sx = sourceWidth / width, sy = sourceHeight / height;
  for (let y = 0; y < height; y++) {
    const py = (y + 0.5) * sy - 0.5, y0 = Math.floor(py), fy = py - y0;
    const ay = Math.min(sourceHeight - 1, Math.max(0, y0)), by = Math.min(sourceHeight - 1, Math.max(0, y0 + 1));
    for (let x = 0; x < width; x++) {
      const px = (x + 0.5) * sx - 0.5, x0 = Math.floor(px), fx = px - x0;
      const ax = Math.min(sourceWidth - 1, Math.max(0, x0)), bx = Math.min(sourceWidth - 1, Math.max(0, x0 + 1));
      const top = source[ay * sourceWidth + ax]! * (1 - fx) + source[ay * sourceWidth + bx]! * fx;
      const bottom = source[by * sourceWidth + ax]! * (1 - fx) + source[by * sourceWidth + bx]! * fx;
      result[y * width + x] = Math.min(255, Math.max(0, Math.floor((top * (1 - fy) + bottom * fy) * 255 + 0.5)));
    }
  }
  return result;
}

export function rgbaGrayLevels(rgba: Uint8Array, width: number, height: number): Float32Array {
  if (rgba.length !== width * height * 4) throw new RangeError('RGBA buffer size mismatch');
  const result = new Float32Array(width * height);
  for (let i = 0, p = 0; i < result.length; i++, p += 4) {
    result[i] = (rgba[p]! * GUIDE_RED + rgba[p + 1]! * GUIDE_GREEN + rgba[p + 2]! * GUIDE_BLUE) / 255;
  }
  return result;
}

function scaleGuide(rgba: Uint8Array, sourceWidth: number, sourceHeight: number, width: number, height: number): Float32Array {
  if (rgba.length !== sourceWidth * sourceHeight * 4) throw new RangeError('RGBA buffer size mismatch');
  const result = new Float32Array(width * height), sx = sourceWidth / width, sy = sourceHeight / height;
  for (let y = 0; y < height; y++) {
    const py = (y + 0.5) * sy - 0.5, y0 = Math.floor(py), fy = py - y0;
    const ay = Math.min(sourceHeight - 1, Math.max(0, y0)), by = Math.min(sourceHeight - 1, Math.max(0, y0 + 1));
    for (let x = 0; x < width; x++) {
      const px = (x + 0.5) * sx - 0.5, x0 = Math.floor(px), fx = px - x0;
      const ax = Math.min(sourceWidth - 1, Math.max(0, x0)), bx = Math.min(sourceWidth - 1, Math.max(0, x0 + 1));
      let gray = 0;
      for (let channel = 0; channel < 3; channel++) {
        const top = rgba[(ay * sourceWidth + ax) * 4 + channel]! * (1 - fx)
          + rgba[(ay * sourceWidth + bx) * 4 + channel]! * fx;
        const bottom = rgba[(by * sourceWidth + ax) * 4 + channel]! * (1 - fx)
          + rgba[(by * sourceWidth + bx) * 4 + channel]! * fx;
        gray += (top * (1 - fy) + bottom * fy) * GUIDE_WEIGHTS[channel]!;
      }
      result[y * width + x] = gray / 255;
    }
  }
  return result;
}

function scaleMask(mask: Uint8Array, sourceWidth: number, sourceHeight: number, width: number, height: number): Float32Array {
  const result = new Float32Array(width * height), sx = sourceWidth / width, sy = sourceHeight / height;
  for (let y = 0; y < height; y++) {
    const py = (y + 0.5) * sy - 0.5, y0 = Math.floor(py), fy = py - y0;
    const ay = Math.min(sourceHeight - 1, Math.max(0, y0)), by = Math.min(sourceHeight - 1, Math.max(0, y0 + 1));
    for (let x = 0; x < width; x++) {
      const px = (x + 0.5) * sx - 0.5, x0 = Math.floor(px), fx = px - x0;
      const ax = Math.min(sourceWidth - 1, Math.max(0, x0)), bx = Math.min(sourceWidth - 1, Math.max(0, x0 + 1));
      const top = mask[ay * sourceWidth + ax]! * (1 - fx) + mask[ay * sourceWidth + bx]! * fx;
      const bottom = mask[by * sourceWidth + ax]! * (1 - fx) + mask[by * sourceWidth + bx]! * fx;
      result[y * width + x] = (top * (1 - fy) + bottom * fy) / 255;
    }
  }
  return result;
}

/**
 * `GuidedMatte.refine`: work at `limit`, shrink the radius with the image, then scale back.
 * Large full-resolution jobs are divided into exact 512px interiors with a 2r halo, bounding peak memory.
 */
export function refineGuidedMask(mask: Uint8Array, guideRgba: Uint8Array, width: number, height: number,
  radius: number, limit = Number.MAX_VALUE): Uint8Array {
  if (mask.length !== width * height) throw new RangeError('Mask buffer size mismatch');
  const factor = Math.min(1, limit / Math.max(width, height));
  const smallWidth = Math.max(1, Math.round(width * factor));
  const smallHeight = Math.max(1, Math.round(height * factor));
  const steps = Math.max(1, Math.round(radius * factor));
  if (factor === 1 && mask.length > 4_000_000) return guidedFilterBytesTiled(mask, guideRgba, width, height, steps);
  const smallMask = scaleMask(mask, width, height, smallWidth, smallHeight);
  const smallGuide = scaleGuide(guideRgba, width, height, smallWidth, smallHeight);
  const refined = smallMask.length > 4_000_000
    ? guidedFilterTiled(smallMask, smallGuide, smallWidth, smallHeight, steps)
    : guidedFilter(smallMask, smallGuide, smallWidth, smallHeight, steps);
  return resizeLevelsToBytes(refined, smallWidth, smallHeight, width, height);
}

function guidedFilterBytesTiled(mask: Uint8Array, guideRgba: Uint8Array, width: number, height: number,
  radius: number): Uint8Array {
  const result = new Uint8Array(mask.length), tileSize = 512, halo = radius * 2;
  for (let top = 0; top < height; top += tileSize) for (let left = 0; left < width; left += tileSize) {
    const innerWidth = Math.min(tileSize, width - left), innerHeight = Math.min(tileSize, height - top);
    const localWidth = innerWidth + halo * 2, localHeight = innerHeight + halo * 2;
    const localMask = new Float32Array(localWidth * localHeight), localGuide = new Float32Array(localMask.length);
    for (let y = 0; y < localHeight; y++) {
      const sourceY = Math.min(height - 1, Math.max(0, top + y - halo));
      for (let x = 0; x < localWidth; x++) {
        const sourceX = Math.min(width - 1, Math.max(0, left + x - halo));
        const source = sourceY * width + sourceX, target = y * localWidth + x, rgba = source * 4;
        localMask[target] = mask[source]! / 255;
        localGuide[target] = (guideRgba[rgba]! * GUIDE_RED + guideRgba[rgba + 1]! * GUIDE_GREEN
          + guideRgba[rgba + 2]! * GUIDE_BLUE) / 255;
      }
    }
    const local = guidedFilter(localMask, localGuide, localWidth, localHeight, radius);
    for (let y = 0; y < innerHeight; y++) for (let x = 0; x < innerWidth; x++) {
      result[(top + y) * width + left + x] = Math.min(255, Math.max(0,
        Math.floor(local[(y + halo) * localWidth + x + halo]! * 255 + 0.5)));
    }
  }
  return result;
}

function guidedFilterTiled(mask: Float32Array, guide: Float32Array, width: number, height: number, radius: number): Float32Array {
  const result = new Float32Array(mask.length);
  const tileSize = 512, halo = radius * 2;
  for (let top = 0; top < height; top += tileSize) for (let left = 0; left < width; left += tileSize) {
    const innerWidth = Math.min(tileSize, width - left), innerHeight = Math.min(tileSize, height - top);
    const localWidth = innerWidth + halo * 2, localHeight = innerHeight + halo * 2;
    const localMask = new Float32Array(localWidth * localHeight), localGuide = new Float32Array(localMask.length);
    for (let y = 0; y < localHeight; y++) {
      const sourceY = Math.min(height - 1, Math.max(0, top + y - halo));
      for (let x = 0; x < localWidth; x++) {
        const sourceX = Math.min(width - 1, Math.max(0, left + x - halo));
        const source = sourceY * width + sourceX, target = y * localWidth + x;
        localMask[target] = mask[source]!; localGuide[target] = guide[source]!;
      }
    }
    const local = guidedFilter(localMask, localGuide, localWidth, localHeight, radius);
    for (let y = 0; y < innerHeight; y++) {
      result.set(local.subarray((y + halo) * localWidth + halo, (y + halo) * localWidth + halo + innerWidth), (top + y) * width + left);
    }
  }
  return result;
}
