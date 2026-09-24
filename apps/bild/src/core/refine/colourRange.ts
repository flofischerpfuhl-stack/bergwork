import { Raster } from '../raster';
import type { DocumentSelection, SelectionMode } from '../selection';
import { applySelection } from '../selectionCommands';
import type { EditorSession } from '../session';

export type ColourRangePreset = 'sampled' | 'skinTones' | 'midtones' | 'highlights' | 'shadows';
export interface SampledColour { readonly red: number; readonly green: number; readonly blue: number }
export interface ColourRangeSettings {
  readonly preset: ColourRangePreset;
  readonly samples: readonly SampledColour[];
  /** Photoshop-compatible control range, 0...200. */
  readonly fuzziness: number;
  readonly localized: boolean;
  readonly samplePoint?: { readonly x: number; readonly y: number } | null;
  readonly range?: number;
  readonly invert?: boolean;
}

/** Pure Select > Colour Range engine with perceptual sampled-colour distance. */
export function colourRangeMask(rgba: Uint8Array, width: number, height: number,
  settings: ColourRangeSettings): Uint8Array {
  if (rgba.length !== width * height * 4) throw new RangeError('RGBA buffer size mismatch');
  if (settings.preset === 'sampled' && !settings.samples.length) throw new RangeError('Sampled Colour Range needs at least one colour');
  const fuzziness = Math.max(0, Math.min(200, settings.fuzziness));
  const labs = settings.samples.map((sample) => rgbToLab(sample.red, sample.green, sample.blue));
  const output = new Uint8Array(width * height), localizedRange = Math.max(1, settings.range ?? Math.max(width, height));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x, p = index * 4;
    let coverage: number;
    if (settings.preset === 'skinTones') coverage = skinCoverage(rgba[p]!, rgba[p + 1]!, rgba[p + 2]!, fuzziness);
    else if (settings.preset === 'midtones') coverage = midtoneCoverage(rgba[p]!, rgba[p + 1]!, rgba[p + 2]!, fuzziness);
    else if (settings.preset === 'highlights' || settings.preset === 'shadows') {
      coverage = toneCoverage(rgba[p]!, rgba[p + 1]!, rgba[p + 2]!, fuzziness, settings.preset === 'highlights');
    }
    else {
      const lab = rgbToLab(rgba[p]!, rgba[p + 1]!, rgba[p + 2]!); let distance = Infinity;
      for (const sample of labs) distance = Math.min(distance, deltaE(lab, sample));
      const inner = fuzziness * 0.22, outer = inner + 2 + fuzziness * 0.18;
      coverage = 1 - smoothstep(inner, outer, distance);
    }
    if (settings.localized && settings.samplePoint) {
      const distance = Math.hypot(x + 0.5 - settings.samplePoint.x, y + 0.5 - settings.samplePoint.y);
      coverage *= 1 - smoothstep(localizedRange * 0.6, localizedRange, distance);
    }
    coverage *= rgba[p + 3]! / 255;
    output[index] = Math.round((settings.invert ? 1 - coverage : coverage) * 255);
  }
  return output;
}

export function colourRangeSelection(rgba: Uint8Array, width: number, height: number,
  settings: ColourRangeSettings): DocumentSelection {
  return { mask: Raster.fromPixels(width, height, 1, colourRangeMask(rgba, width, height, settings)),
    x: 0, y: 0, antialiased: true };
}

export function selectColourRange(session: EditorSession, rgba: Uint8Array, width: number, height: number,
  settings: ColourRangeSettings, mode: SelectionMode = 'New'): boolean {
  const document = session.document;
  if (!document || width !== document.width || height !== document.height) return false;
  return applySelection(session, colourRangeSelection(rgba, width, height, settings), mode, 'Colour Range');
}

type Lab = readonly [number, number, number];
function rgbToLab(red: number, green: number, blue: number): Lab {
  const linear = (value: number): number => { const v = value / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const r = linear(red), g = linear(green), b = linear(blue);
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const f = (v: number): number => v > 216 / 24389 ? Math.cbrt(v) : (24389 / 27 * v + 16) / 116;
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function deltaE(a: Lab, b: Lab): number { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function smoothstep(low: number, high: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - low) / Math.max(1e-6, high - low)));
  return t * t * (3 - 2 * t);
}
function skinCoverage(red: number, green: number, blue: number, fuzziness: number): number {
  const cb = 128 - 0.168736 * red - 0.331264 * green + 0.5 * blue;
  const cr = 128 + 0.5 * red - 0.418688 * green - 0.081312 * blue;
  const distance = Math.hypot((cb - 108) / 1.35, cr - 153);
  return 1 - smoothstep(13 + fuzziness * 0.06, 24 + fuzziness * 0.12, distance);
}
function midtoneCoverage(red: number, green: number, blue: number, fuzziness: number): number {
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  const halfWidth = 0.22 + fuzziness / 1000;
  return 1 - smoothstep(halfWidth * 0.55, halfWidth, Math.abs(luminance - 0.5));
}
/** Photoshop's Highlights/Shadows ranges: the bright or dark quarter of luminance, widened by fuzziness. */
function toneCoverage(red: number, green: number, blue: number, fuzziness: number, highlights: boolean): number {
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255, tone = highlights ? luminance : 1 - luminance;
  const edge = 0.75 - fuzziness / 1000;
  return smoothstep(edge - 0.12, edge, tone);
}
