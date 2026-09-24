import { refineGuidedMask, resizeLevelsToBytes } from '../subject/guidedMatte';

export function bestPromptMask(logits: Float32Array, scores: Float32Array, width: number, height: number): {
  readonly mask: Uint8Array; readonly score: number;
} {
  const plane = width * height;
  if (!plane || logits.length % plane !== 0) throw new RangeError('Unexpected promptable-mask tensor');
  const masks = logits.length / plane;
  let best = 0;
  for (let i = 1; i < Math.min(masks, scores.length); i++) if (scores[i]! > scores[best]!) best = i;
  const levels = new Float32Array(plane), offset = best * plane;
  // A narrow logistic transition preserves antialiasing while keeping SAM's zero-logit boundary.
  for (let i = 0; i < plane; i++) {
    const value = logits[offset + i]! * 4;
    levels[i] = value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
  }
  return { mask: resizeLevelsToBytes(levels, width, height, width, height), score: scores[best] ?? 0 };
}

export function upscaleObjectMask(mask: Uint8Array, maskWidth: number, maskHeight: number,
  rgba: Uint8Array, width: number, height: number, radius = 6): Uint8Array {
  const levels = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) levels[i] = mask[i]! / 255;
  const upsampled = resizeLevelsToBytes(levels, maskWidth, maskHeight, width, height);
  // Reuses upstream GuidedMatte.refine: the low-resolution model boundary is pulled onto image edges.
  return refineGuidedMask(upsampled, rgba, width, height, radius, Math.min(1800, Math.max(width, height)));
}
