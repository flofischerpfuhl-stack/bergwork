/** Independent Lanczos-3 baseline used for AI-strength blending and quality measurements. */
export function lanczosRgba(source: Uint8Array, width: number, height: number, outputWidth: number, outputHeight: number): Uint8Array {
  if (source.length !== width * height * 4 || [width, height, outputWidth, outputHeight].some((v) => !Number.isInteger(v) || v < 1)) {
    throw new RangeError('Invalid RGBA resize');
  }
  const horizontal = new Float32Array(outputWidth * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < outputWidth; x++) {
    const position = (x + 0.5) * width / outputWidth - 0.5;
    let sum = 0;
    for (let sx = Math.ceil(position - 3); sx <= Math.floor(position + 3); sx++) {
      const weight = lanczos(position - sx); if (weight === 0) continue;
      const clamped = Math.max(0, Math.min(width - 1, sx)), input = (y * width + clamped) * 4;
      for (let c = 0; c < 4; c++) {
        const at = (y * outputWidth + x) * 4 + c;
        horizontal[at] = horizontal[at]! + source[input + c]! * weight;
      }
      sum += weight;
    }
    for (let c = 0; c < 4; c++) {
      const at = (y * outputWidth + x) * 4 + c;
      horizontal[at] = horizontal[at]! / sum;
    }
  }
  const output = new Uint8Array(outputWidth * outputHeight * 4);
  for (let y = 0; y < outputHeight; y++) for (let x = 0; x < outputWidth; x++) {
    const position = (y + 0.5) * height / outputHeight - 0.5;
    let sum = 0, rgba = [0, 0, 0, 0];
    for (let sy = Math.ceil(position - 3); sy <= Math.floor(position + 3); sy++) {
      const weight = lanczos(position - sy); if (weight === 0) continue;
      const clamped = Math.max(0, Math.min(height - 1, sy)), input = (clamped * outputWidth + x) * 4;
      for (let c = 0; c < 4; c++) rgba[c] = rgba[c]! + horizontal[input + c]! * weight;
      sum += weight;
    }
    for (let c = 0; c < 4; c++) output[(y * outputWidth + x) * 4 + c] = Math.max(0, Math.min(255, Math.round(rgba[c]! / sum)));
  }
  return output;
}

function lanczos(x: number): number {
  const absolute = Math.abs(x);
  if (absolute < 1e-7) return 1;
  if (absolute >= 3) return 0;
  return Math.sin(Math.PI * x) * Math.sin(Math.PI * x / 3) / (Math.PI * Math.PI * x * x / 3);
}

export function blendRgba(a: Uint8Array, b: Uint8Array, amount: number): Uint8Array {
  if (a.length !== b.length) throw new RangeError('RGBA buffers differ');
  const t = Math.max(0, Math.min(1, amount)), output = new Uint8Array(a.length);
  for (let i = 0; i < output.length; i++) output[i] = Math.round(a[i]! * (1 - t) + b[i]! * t);
  return output;
}
