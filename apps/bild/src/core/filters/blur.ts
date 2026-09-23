import { Raster } from '../raster';

const DIRECT_SAMPLE_LIMIT = 32_000_000;
const DIRECT_PIXEL_LIMIT = 250_000;

function gaussianKernel(sigma: number): Float64Array {
  const safeSigma = Math.max(0.01, sigma);
  const radius = Math.ceil(safeSigma * 3);
  const weights = new Float64Array(radius * 2 + 1);
  let total = 0;
  for (let offset = -radius; offset <= radius; offset++) {
    const weight = Math.exp(-0.5 * (offset / safeSigma) ** 2);
    weights[offset + radius] = weight;
    total += weight;
  }
  for (let i = 0; i < weights.length; i++) weights[i] = weights[i]! / total;
  return weights;
}

function firHorizontal(source: Float32Array, target: Float32Array, width: number, height: number,
  kernel: Float64Array): void {
  const radius = (kernel.length - 1) >> 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const first = Math.max(-radius, -x), last = Math.min(radius, width - 1 - x);
      let sum = 0;
      for (let offset = first; offset <= last; offset++) sum += source[row + x + offset]! * kernel[offset + radius]!;
      target[row + x] = sum;
    }
  }
}

function firVertical(source: Float32Array, target: Float32Array, width: number, height: number,
  kernel: Float64Array): void {
  const radius = (kernel.length - 1) >> 1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const first = Math.max(-radius, -y), last = Math.min(radius, height - 1 - y);
    let sum = 0;
    for (let offset = first; offset <= last; offset++) sum += source[(y + offset) * width + x]! * kernel[offset + radius]!;
    target[y * width + x] = sum;
  }
}

interface RecursiveCoefficients {
  readonly feed: number;
  readonly one: number;
  readonly two: number;
  readonly three: number;
  readonly padding: number;
}

/** Young-van Vliet third-order approximation, used only when a direct 6-sigma FIR would be too costly. */
function recursiveCoefficients(sigma: number): RecursiveCoefficients {
  const q = sigma >= 2.5
    ? 0.98711 * sigma - 0.96330
    : 3.97156 - 4.14554 * Math.sqrt(1 - 0.26891 * sigma);
  const q2 = q * q, q3 = q2 * q;
  const divisor = 1.57825 + 2.44413 * q + 1.4281 * q2 + 0.422205 * q3;
  const one = (2.44413 * q + 2.85619 * q2 + 1.26661 * q3) / divisor;
  const two = -(1.4281 * q2 + 1.26661 * q3) / divisor;
  const three = 0.422205 * q3 / divisor;
  return { feed: 1 - one - two - three, one, two, three, padding: Math.ceil(8 * sigma) + 3 };
}

function recursiveHorizontal(source: Float32Array, target: Float32Array, width: number, height: number,
  coefficients: RecursiveCoefficients): void {
  const { feed, one, two, three, padding } = coefficients;
  const forward = new Float64Array(width + padding);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let previous1 = 0, previous2 = 0, previous3 = 0;
    for (let x = 0; x < forward.length; x++) {
      const value = feed * (x < width ? source[row + x]! : 0)
        + one * previous1 + two * previous2 + three * previous3;
      forward[x] = value; previous3 = previous2; previous2 = previous1; previous1 = value;
    }
    previous1 = 0; previous2 = 0; previous3 = 0;
    for (let x = forward.length - 1; x >= 0; x--) {
      const value = feed * forward[x]! + one * previous1 + two * previous2 + three * previous3;
      if (x < width) target[row + x] = value;
      previous3 = previous2; previous2 = previous1; previous1 = value;
    }
  }
}

function recursiveVertical(source: Float32Array, target: Float32Array, width: number, height: number,
  coefficients: RecursiveCoefficients): void {
  const { feed, one, two, three, padding } = coefficients;
  const forward = new Float64Array(height + padding);
  for (let x = 0; x < width; x++) {
    let previous1 = 0, previous2 = 0, previous3 = 0;
    for (let y = 0; y < forward.length; y++) {
      const value = feed * (y < height ? source[y * width + x]! : 0)
        + one * previous1 + two * previous2 + three * previous3;
      forward[y] = value; previous3 = previous2; previous2 = previous1; previous1 = value;
    }
    previous1 = 0; previous2 = 0; previous3 = 0;
    for (let y = forward.length - 1; y >= 0; y--) {
      const value = feed * forward[y]! + one * previous1 + two * previous2 + three * previous3;
      if (y < height) target[y * width + x] = value;
      previous3 = previous2; previous2 = previous1; previous1 = value;
    }
  }
}

type PlaneBlur = (source: Float32Array, scratch: Float32Array) => void;

function gaussianPlane(width: number, height: number, sigma: number, horizontal: boolean, vertical: boolean): PlaneBlur {
  const kernel = gaussianKernel(sigma);
  const directions = Number(horizontal) + Number(vertical);
  // Keep reference-sized images exact even at a large sigma; large production grids use the bounded-cost IIR.
  const direct = width * height <= DIRECT_PIXEL_LIMIT
    || width * height * kernel.length * directions <= DIRECT_SAMPLE_LIMIT;
  if (direct) return (source, scratch) => {
    if (horizontal && vertical) {
      firHorizontal(source, scratch, width, height, kernel);
      firVertical(scratch, source, width, height, kernel);
    } else if (horizontal) {
      firHorizontal(source, scratch, width, height, kernel); source.set(scratch);
    } else {
      firVertical(source, scratch, width, height, kernel); source.set(scratch);
    }
  };
  const coefficients = recursiveCoefficients(Math.max(0.5, sigma));
  return (source, scratch) => {
    if (horizontal && vertical) {
      recursiveHorizontal(source, scratch, width, height, coefficients);
      recursiveVertical(scratch, source, width, height, coefficients);
    } else if (horizontal) {
      recursiveHorizontal(source, scratch, width, height, coefficients); source.set(scratch);
    } else {
      recursiveVertical(source, scratch, width, height, coefficients); source.set(scratch);
    }
  };
}

function fromBlurredPlanes(raster: Raster, blur: PlaneBlur): Raster {
  const bytes = raster.toPixels(), count = raster.width * raster.height;
  const alpha = new Float32Array(count), plane = new Float32Array(count), scratch = new Float32Array(count);
  for (let i = 0; i < count; i++) alpha[i] = bytes[i * 4 + 3]! / 255;
  blur(alpha, scratch);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < count; i++) out[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, alpha[i]!)) * 255);
  for (let channel = 0; channel < 3; channel++) {
    for (let i = 0; i < count; i++) plane[i] = bytes[i * 4 + channel]! / 255 * (bytes[i * 4 + 3]! / 255);
    blur(plane, scratch);
    for (let i = 0; i < count; i++) {
      const a = alpha[i]!;
      if (a > 0) out[i * 4 + channel] = Math.round(Math.min(1, Math.max(0, plane[i]! / a)) * 255);
    }
  }
  return Raster.fromPixels(raster.width, raster.height, 4, out);
}

/** `Filters.swift` `PixelFilter.run(.gaussianBlur)`: transparent-edge, premultiplied-sRGB Gaussian. */
export function gaussianBlur(raster: Raster, sigma: number): Raster {
  if (raster.channels !== 4) throw new RangeError('Gaussian blur requires an RGBA raster');
  return fromBlurredPlanes(raster, gaussianPlane(raster.width, raster.height, Math.max(0.01, sigma), true, true));
}

function premultiplied(raster: Raster): Float32Array {
  const bytes = raster.toPixels(), out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 4) {
    const alpha = bytes[i + 3]! / 255;
    out[i] = bytes[i]! / 255 * alpha; out[i + 1] = bytes[i + 1]! / 255 * alpha;
    out[i + 2] = bytes[i + 2]! / 255 * alpha; out[i + 3] = alpha;
  }
  return out;
}

function fromPremultiplied(data: Float32Array, width: number, height: number): Raster {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const alpha = Math.min(1, Math.max(0, data[i + 3]!)); out[i + 3] = Math.round(alpha * 255);
    if (alpha > 0) {
      out[i] = Math.round(Math.min(1, Math.max(0, data[i]! / alpha)) * 255);
      out[i + 1] = Math.round(Math.min(1, Math.max(0, data[i + 1]! / alpha)) * 255);
      out[i + 2] = Math.round(Math.min(1, Math.max(0, data[i + 2]! / alpha)) * 255);
    }
  }
  return Raster.fromPixels(width, height, 4, out);
}

/** `Filters.swift` `PixelFilter.run(.motionBlur)`: CIMotionBlur's radius is distance / sqrt(12). */
export function motionBlur(raster: Raster, distance: number, angle: number): Raster {
  if (raster.channels !== 4) throw new RangeError('Motion blur requires an RGBA raster');
  const sigma = Math.max(0.01, distance / Math.sqrt(12));
  const horizontal = Math.abs(angle) < 1e-9, vertical = Math.abs(Math.abs(angle) - 90) < 1e-9;
  if (horizontal || vertical) {
    return fromBlurredPlanes(raster, gaussianPlane(raster.width, raster.height, sigma, horizontal, vertical));
  }

  const source = premultiplied(raster), out = new Float32Array(source.length), kernel = gaussianKernel(sigma);
  const radius = (kernel.length - 1) >> 1, radians = angle * Math.PI / 180;
  const dx = Math.cos(radians), dy = -Math.sin(radians), width = raster.width, height = raster.height;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let red = 0, green = 0, blue = 0, alpha = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const sx = x + offset * dx, sy = y + offset * dy;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      const weight = kernel[offset + radius]!;
      for (let yy = 0; yy < 2; yy++) {
        const py = y0 + yy;
        if (py < 0 || py >= height) continue;
        const wy = yy === 0 ? 1 - fy : fy;
        for (let xx = 0; xx < 2; xx++) {
          const px = x0 + xx;
          if (px < 0 || px >= width) continue;
          const sampleWeight = weight * wy * (xx === 0 ? 1 - fx : fx), index = (py * width + px) * 4;
          red += source[index]! * sampleWeight; green += source[index + 1]! * sampleWeight;
          blue += source[index + 2]! * sampleWeight; alpha += source[index + 3]! * sampleWeight;
        }
      }
    }
    const destination = (y * width + x) * 4;
    out[destination] = red; out[destination + 1] = green; out[destination + 2] = blue; out[destination + 3] = alpha;
  }
  return fromPremultiplied(out, width, height);
}
