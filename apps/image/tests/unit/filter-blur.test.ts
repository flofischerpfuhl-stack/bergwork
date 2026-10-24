import { describe, expect, it } from 'vitest';
import { Raster } from '../../src/core/raster';
import { gaussianBlur, motionBlur } from '../../src/core/filters/apply';

function kernel(sigma: number): Float64Array {
  const radius = Math.ceil(sigma * 3), result = new Float64Array(radius * 2 + 1);
  let total = 0;
  for (let i = -radius; i <= radius; i++) { const value = Math.exp(-0.5 * (i / sigma) ** 2); result[i + radius] = value; total += value; }
  for (let i = 0; i < result.length; i++) result[i] = result[i]! / total;
  return result;
}

function directGaussianAlpha(source: Uint8Array, width: number, height: number, sigma: number): Uint8Array {
  const weights = kernel(sigma), radius = (weights.length - 1) >> 1;
  const horizontal = new Float64Array(width * height), result = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const sampleX = x + offset;
      if (sampleX >= 0 && sampleX < width) sum += source[(y * width + sampleX) * 4 + 3]! / 255 * weights[offset + radius]!;
    }
    horizontal[y * width + x] = sum;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const sampleY = y + offset;
      if (sampleY >= 0 && sampleY < height) sum += horizontal[sampleY * width + x]! * weights[offset + radius]!;
    }
    result[y * width + x] = Math.round(sum * 255);
  }
  return result;
}

function directMotionAlpha(source: Uint8Array, width: number, height: number, distance: number, angle: number): Uint8Array {
  const weights = kernel(distance / Math.sqrt(12)), radius = (weights.length - 1) >> 1;
  const radians = angle * Math.PI / 180, dx = Math.cos(radians), dy = -Math.sin(radians), result = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const sx = x + offset * dx, sy = y + offset * dy, x0 = Math.floor(sx), y0 = Math.floor(sy);
      const fx = sx - x0, fy = sy - y0;
      for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < 2; xx++) {
        const px = x0 + xx, py = y0 + yy;
        if (px >= 0 && py >= 0 && px < width && py < height) {
          sum += source[(py * width + px) * 4 + 3]! / 255 * weights[offset + radius]!
            * (xx === 0 ? 1 - fx : fx) * (yy === 0 ? 1 - fy : fy);
        }
      }
    }
    result[y * width + x] = Math.round(sum * 255);
  }
  return result;
}

describe('Core Image-style blur kernels', () => {
  it('Filters.swift PixelFilter.run Gaussian Blur matches direct convolution within 1/255 at large sigma', () => {
    const width = 83, height = 79, pixels = new Uint8Array(width * height * 4);
    let state = 0x12345678;
    for (let i = 0; i < width * height; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      pixels.set([210, 90, 35, state >>> 24], i * 4);
    }
    const made = gaussianBlur(Raster.fromPixels(width, height, 4, pixels), 20).toPixels();
    const reference = directGaussianAlpha(pixels, width, height, 20);
    let maximumError = 0;
    for (let i = 0; i < reference.length; i++) maximumError = Math.max(maximumError, Math.abs(made[i * 4 + 3]! - reference[i]!));
    expect(maximumError).toBeLessThanOrEqual(1);
  });

  it('Young-van Vliet large-raster path stays within 1/255 of a direct Gaussian impulse', () => {
    const width = 513, height = 513, pixels = new Uint8Array(width * height * 4), middle = (height >> 1) * width + (width >> 1);
    pixels.set([255, 255, 255, 255], middle * 4);
    const made = gaussianBlur(Raster.fromPixels(width, height, 4, pixels), 50).toPixels();
    const reference = directGaussianAlpha(pixels, width, height, 50);
    let maximumError = 0;
    for (let i = 0; i < reference.length; i++) maximumError = Math.max(maximumError, Math.abs(made[i * 4 + 3]! - reference[i]!));
    expect(maximumError).toBeLessThanOrEqual(1);
  });

  it('Filters.swift Gaussian Blur impulse response is symmetric', () => {
    const size = 61, pixels = new Uint8Array(size * size * 4), center = (size >> 1) * size + (size >> 1);
    pixels.set([255, 80, 20, 255], center * 4);
    const made = gaussianBlur(Raster.fromPixels(size, size, 4, pixels), 3).toPixels();
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const alpha = made[(y * size + x) * 4 + 3]!;
      expect(alpha).toBe(made[((size - 1 - y) * size + (size - 1 - x)) * 4 + 3]);
    }
  });

  it('Filters.swift Gaussian Blur preserves alpha energy apart from RGBA8 quantization', () => {
    const size = 61, pixels = new Uint8Array(size * size * 4);
    for (let y = 20; y < 41; y++) for (let x = 20; x < 41; x++) pixels[(y * size + x) * 4 + 3] = 255;
    const made = gaussianBlur(Raster.fromPixels(size, size, 4, pixels), 3).toPixels();
    let energy = 0;
    for (let i = 3; i < made.length; i += 4) energy += made[i]!;
    expect(Math.abs(energy - 21 * 21 * 255) / (21 * 21 * 255)).toBeLessThan(0.002);
  });

  it('Filters.swift Gaussian Blur works in premultiplied sRGB without transparent-color bleed', () => {
    const pixels = new Uint8Array(17 * 5 * 4);
    pixels.set([255, 0, 0, 255], (2 * 17 + 7) * 4);
    pixels.set([0, 0, 255, 0], (2 * 17 + 8) * 4);
    const made = gaussianBlur(Raster.fromPixels(17, 5, 4, pixels), 1.5);
    const sample = made.pixel(8, 2);
    expect(sample[0]).toBe(255); expect(sample[1]).toBe(0); expect(sample[2]).toBe(0);
    expect(sample[3]).toBeGreaterThan(0);
  });

  it('Filters.swift CIMotionBlur uses Gaussian weights and the counterclockwise image angle', () => {
    const size = 65, pixels = new Uint8Array(size * size * 4), center = size >> 1;
    pixels.set([255, 255, 255, 255], (center * size + center) * 4);
    const horizontal = motionBlur(Raster.fromPixels(size, size, 4, pixels), 24, 0);
    const expected = kernel(24 / Math.sqrt(12)), radius = (expected.length - 1) >> 1;
    for (let offset = -radius; offset <= radius; offset++) {
      expect(Math.abs(horizontal.pixel(center + offset, center)[3]! - Math.round(expected[offset + radius]! * 255))).toBeLessThanOrEqual(1);
    }
    const diagonal = motionBlur(Raster.fromPixels(size, size, 4, pixels), 24, 30);
    expect(diagonal.pixel(center + 6, center - 3)[3]).toBeGreaterThan(diagonal.pixel(center + 6, center + 3)[3]! + 2);
  });

  it('Filters.swift CIMotionBlur matches a bilinear directional reference within 1/255', () => {
    const width = 31, height = 29, pixels = new Uint8Array(width * height * 4); let state = 0x89abcdef;
    for (let i = 0; i < width * height; i++) { state = (Math.imul(state, 1103515245) + 12345) >>> 0; pixels[i * 4 + 3] = state >>> 24; }
    const made = motionBlur(Raster.fromPixels(width, height, 4, pixels), 8, 37).toPixels();
    const reference = directMotionAlpha(pixels, width, height, 8, 37); let maximumError = 0;
    for (let i = 0; i < reference.length; i++) maximumError = Math.max(maximumError, Math.abs(made[i * 4 + 3]! - reference[i]!));
    expect(maximumError).toBeLessThanOrEqual(1);
  });
});
