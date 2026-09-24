import { Raster } from '../raster';
import { gaussianBlur } from './blur';

const clamp = (v: number): number => Math.min(1, Math.max(0, v));
function floatPixels(raster: Raster): Float32Array {
  const source = raster.toPixelsNative(), out = new Float32Array(source.length), maximum = raster.maximum;
  for (let i = 0; i < source.length; i++) out[i] = source[i]! / maximum;
  return out;
}
function rasterFromFloat(source: Raster, values: Float32Array): Raster {
  const out = source.format === 'rgba16' ? new Uint16Array(values.length) : new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Math.round(clamp(values[i]!) * source.maximum);
  return Raster.fromPixels(source.width, source.height, 4, out, { format: source.format });
}

/** Photoshop-style unsharp mask: original + amount × high-frequency, gated by an 8-bit threshold. */
export function unsharpMask(raster: Raster, amount: number, radius: number, threshold = 0): Raster {
  if (raster.channels !== 4) throw new RangeError('Unsharp Mask requires an RGBA raster');
  const source = floatPixels(raster), blurred = floatPixels(gaussianBlur(raster, radius)), out = source.slice();
  const strength = Math.max(0, amount) / 100, gate = Math.max(0, threshold) / 255;
  for (let i = 0; i < source.length; i += 4) {
    for (let c = 0; c < 3; c++) { const detail = source[i + c]! - blurred[i + c]!;
      out[i + c] = Math.abs(detail) >= gate ? clamp(source[i + c]! + detail * strength) : source[i + c]!; }
  }
  return rasterFromFloat(raster, out);
}

/** High Pass uses Photoshop's neutral 0.5 plus the radius-separated detail and keeps alpha. */
export function highPass(raster: Raster, radius: number): Raster {
  if (raster.channels !== 4) throw new RangeError('High Pass requires an RGBA raster');
  const source = floatPixels(raster), blurred = floatPixels(gaussianBlur(raster, radius)), out = source.slice();
  for (let i = 0; i < source.length; i += 4) for (let c = 0; c < 3; c++) out[i + c] = clamp(0.5 + source[i + c]! - blurred[i + c]!);
  return rasterFromFloat(raster, out);
}

/** Edge-aware 3×3 luminance/chroma denoise; strengths are percentages and alpha is untouched. */
export function denoise(raster: Raster, luminanceStrength: number, colourStrength: number): Raster {
  if (raster.channels !== 4) throw new RangeError('Denoise requires an RGBA raster');
  const source = floatPixels(raster), out = source.slice(), w = raster.width, h = raster.height;
  const ls = clamp(luminanceStrength / 100), cs = clamp(colourStrength / 100);
  if (ls === 0 && cs === 0) return raster;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const at = (y * w + x) * 4, cr = source[at]!, cg = source[at + 1]!, cb = source[at + 2]!;
    const centerY = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
    let sumW = 0, sumY = 0, sumCb = 0, sumCr = 0;
    for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
      const i = (yy * w + xx) * 4, r = source[i]!, g = source[i + 1]!, b = source[i + 2]!;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b, weight = Math.exp(-Math.abs(lum - centerY) * 20);
      sumW += weight; sumY += lum * weight; sumCb += (b - lum) * weight; sumCr += (r - lum) * weight;
    }
    const smoothY = sumY / sumW, smoothCb = sumCb / sumW, smoothCr = sumCr / sumW;
    const oldCb = cb - centerY, oldCr = cr - centerY, nextY = centerY + (smoothY - centerY) * ls;
    const nextCb = oldCb + (smoothCb - oldCb) * cs, nextCr = oldCr + (smoothCr - oldCr) * cs;
    out[at] = clamp(nextY + nextCr); out[at + 2] = clamp(nextY + nextCb);
    out[at + 1] = clamp((nextY - 0.2126 * out[at]! - 0.0722 * out[at + 2]!) / 0.7152);
  }
  return rasterFromFloat(raster, out);
}

export function smartSharpen(raster: Raster, amount: number, radius: number, threshold: number, reduceNoise: number): Raster {
  const prepared = reduceNoise > 0 ? denoise(raster, reduceNoise * 0.35, reduceNoise) : raster;
  return unsharpMask(prepared, amount, radius, threshold);
}
