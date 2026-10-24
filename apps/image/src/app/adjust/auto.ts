/** Automatic settings the Phase-2 panels compute from the pixels under an adjustment layer. */
import type { BlackAndWhiteSettings } from '../../core/model/types';

/** Gray each pure hue has at equal luminance (Rec. 709): reds, yellows, greens, cyans, blues, magentas. */
const NATURAL: readonly number[] = [21, 93, 72, 79, 7, 28];
const KEYS = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as const;

/**
 * Black & White "Auto": colours that occur in the image get mix values spread evenly from 20 % to 100 % in the
 * order of their natural luminance, so neighbouring colours stay apart in gray; absent colours keep their
 * luminance-matching value. Photoshop's own Auto is proprietary; this is a documented, deterministic stand-in.
 * `rgba` is straight 8-bit RGBA.
 */
export function autoBlackAndWhite(rgba: Uint8Array, current: BlackAndWhiteSettings): BlackAndWhiteSettings {
  const coverage = [0, 0, 0, 0, 0, 0];
  let total = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3]! / 255; if (!alpha) continue;
    const r = rgba[i]! / 255, g = rgba[i + 1]! / 255, b = rgba[i + 2]! / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), chroma = max - min;
    total += alpha;
    if (chroma < 0.04) continue;
    let h = max === r ? (g - b) / chroma + (g < b ? 6 : 0) : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
    h *= 60;
    for (let k = 0; k < 6; k++) {
      const d = Math.abs(((h - k * 60 + 540) % 360) - 180);
      coverage[k]! += Math.max(0, 1 - d / 60) * chroma * alpha;
    }
  }
  const present = [0, 1, 2, 3, 4, 5].filter((k) => total > 0 && coverage[k]! / total >= 0.02).sort((a, b) => NATURAL[a]! - NATURAL[b]!);
  const values: number[] = NATURAL.map((n) => Math.min(100, Math.max(20, n)));
  present.forEach((k, rank) => { values[k] = present.length === 1 ? NATURAL[k]! : Math.round(20 + 80 * rank / (present.length - 1)); });
  const next = { ...current, enabled: true };
  KEYS.forEach((key, k) => { (next as Record<string, unknown>)[key] = values[k]; });
  return next;
}
