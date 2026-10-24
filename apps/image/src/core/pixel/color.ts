/** Shared straight/premultiplied RGBA8 and IEC 61966-2-1 transfer helpers. */

export function premultiplyRgba8InPlace(pixels: Uint8Array): Uint8Array {
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3]!;
    pixels[i] = Math.round(pixels[i]! * alpha / 255);
    pixels[i + 1] = Math.round(pixels[i + 1]! * alpha / 255);
    pixels[i + 2] = Math.round(pixels[i + 2]! * alpha / 255);
  }
  return pixels;
}

export function unpremultiplyRgba8InPlace(pixels: Uint8Array): Uint8Array {
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3]!;
    if (!alpha) {
      pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
      continue;
    }
    pixels[i] = Math.min(255, Math.round(pixels[i]! * 255 / alpha));
    pixels[i + 1] = Math.min(255, Math.round(pixels[i + 1]! * 255 / alpha));
    pixels[i + 2] = Math.min(255, Math.round(pixels[i + 2]! * 255 / alpha));
  }
  return pixels;
}

export function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}
