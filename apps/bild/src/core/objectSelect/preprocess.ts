import type { ObjectPrompt } from './types';

export interface PreparedImage {
  readonly tensor: Float32Array;
  readonly width: number;
  readonly height: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

/** SlimSAM/SAM preprocessing: resize the long edge, ImageNet-normalize, then pad bottom/right to 1024². */
export function prepareSlimSamImage(rgba: Uint8Array, width: number, height: number, limit = 1024): PreparedImage {
  if (rgba.length !== width * height * 4) throw new RangeError('RGBA buffer size mismatch');
  const scale = Math.min(1, limit / Math.max(width, height));
  const outWidth = Math.max(1, Math.round(width * scale)), outHeight = Math.max(1, Math.round(height * scale));
  const plane = limit * limit, tensor = new Float32Array(plane * 3);
  const means = [0.485, 0.456, 0.406] as const, deviations = [0.229, 0.224, 0.225] as const;
  const sx = width / outWidth, sy = height / outHeight;
  for (let y = 0; y < outHeight; y++) {
    const py = (y + 0.5) * sy - 0.5, y0 = Math.floor(py), fy = py - y0;
    const ay = Math.max(0, Math.min(height - 1, y0)), by = Math.max(0, Math.min(height - 1, y0 + 1));
    for (let x = 0; x < outWidth; x++) {
      const px = (x + 0.5) * sx - 0.5, x0 = Math.floor(px), fx = px - x0;
      const ax = Math.max(0, Math.min(width - 1, x0)), bx = Math.max(0, Math.min(width - 1, x0 + 1));
      const output = y * limit + x;
      for (let channel = 0; channel < 3; channel++) {
        const top = rgba[(ay * width + ax) * 4 + channel]! * (1 - fx) + rgba[(ay * width + bx) * 4 + channel]! * fx;
        const bottom = rgba[(by * width + ax) * 4 + channel]! * (1 - fx) + rgba[(by * width + bx) * 4 + channel]! * fx;
        tensor[channel * plane + output] = ((top * (1 - fy) + bottom * fy) / 255 - means[channel]!) / deviations[channel]!;
      }
    }
  }
  return { tensor, width: outWidth, height: outHeight, scaleX: outWidth / width, scaleY: outHeight / height };
}

export function encodePrompts(prompts: readonly ObjectPrompt[], scaleX: number, scaleY: number): {
  readonly coordinates: Float32Array; readonly labels: Float32Array;
} {
  if (!prompts.length) throw new RangeError('At least one object-selection prompt is required');
  let count = 0;
  for (const prompt of prompts) count += prompt.kind === 'box' ? 2 : 1;
  const coordinates = new Float32Array(count * 2), labels = new Float32Array(count);
  let at = 0;
  for (const prompt of prompts) {
    if (prompt.kind === 'point') {
      coordinates[at * 2] = prompt.x * scaleX; coordinates[at * 2 + 1] = prompt.y * scaleY;
      labels[at++] = prompt.positive ? 1 : 0;
    } else {
      coordinates[at * 2] = Math.min(prompt.x0, prompt.x1) * scaleX;
      coordinates[at * 2 + 1] = Math.min(prompt.y0, prompt.y1) * scaleY; labels[at++] = 2;
      coordinates[at * 2] = Math.max(prompt.x0, prompt.x1) * scaleX;
      coordinates[at * 2 + 1] = Math.max(prompt.y0, prompt.y1) * scaleY; labels[at++] = 3;
    }
  }
  return { coordinates, labels };
}
