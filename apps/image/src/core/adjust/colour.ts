import type { ColourBalanceTone, ColourSettings, SelectiveColourRange, SelectiveColourValues } from '../model/types';

const clamp = (v: number): number => Math.min(1, Math.max(0, v));
export const colourLuminance = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function hueWeights(r: number, g: number, b: number): readonly [number, number, number, number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), chroma = max - min;
  if (chroma <= 1e-8) return [0, 0, 0, 0, 0, 0];
  let h = max === r ? ((g - b) / chroma + (g < b ? 6 : 0)) : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
  h *= 60;
  const weights = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 6; i++) {
    const center = i * 60, d = Math.abs(((h - center + 540) % 360) - 180);
    weights[i] = Math.max(0, 1 - d / 60);
  }
  return weights as unknown as readonly [number, number, number, number, number, number];
}
function balance(r: number, g: number, b: number, tone: ColourBalanceTone, weight: number): [number, number, number] {
  const scale = weight / 100 * 0.35;
  return [r + tone.cyanRed * scale, g + tone.magentaGreen * scale, b + tone.yellowBlue * scale];
}
function rangeWeight(name: SelectiveColourRange, r: number, g: number, b: number, hue: readonly number[]): number {
  const index = ['Reds', 'Yellows', 'Greens', 'Cyans', 'Blues', 'Magentas'].indexOf(name);
  if (index >= 0) return hue[index]! * (Math.max(r, g, b) - Math.min(r, g, b));
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (name === 'Whites') return Math.max(0, (min - 0.5) * 2);
  if (name === 'Blacks') return Math.max(0, (0.5 - max) * 2);
  return Math.max(0, 1 - Math.abs(colourLuminance(r, g, b) - 0.5) * 2);
}
function selective(r: number, g: number, b: number, values: SelectiveColourValues,
  weight: number, relative: boolean): [number, number, number] {
  const cyan = values.cyan / 100, magenta = values.magenta / 100, yellow = values.yellow / 100, black = values.black / 100;
  const change = (v: number, ink: number): number => {
    const amount = relative ? (ink >= 0 ? v : 1 - v) * ink : ink;
    return clamp(v - weight * (amount + black * (relative ? v : 1)));
  };
  return [change(r, cyan), change(g, magenta), change(b, yellow)];
}

/** Photoshop-compatible panel approximation: B&W mix, Color Balance tonal masks, then Selective Color CMYK deltas. */
export function colourPanelColor(red: number, green: number, blue: number, settings: ColourSettings): [number, number, number] {
  let r = red, g = green, b = blue;
  const originalLuma = colourLuminance(r, g, b), hue = hueWeights(r, g, b), bw = settings.blackAndWhite;
  const mixers = [bw.reds, bw.yellows, bw.greens, bw.cyans, bw.blues, bw.magentas];
  if (bw.enabled) {
    let gray = 0;
    for (let i = 0; i < 6; i++) gray += hue[i]! * mixers[i]! / 100;
    if (Math.max(r, g, b) - Math.min(r, g, b) < 1e-8) gray = originalLuma;
    else gray *= Math.max(r, g, b);
    gray = clamp(gray);
    if (bw.tint) { r = gray * bw.tintColor.red; g = gray * bw.tintColor.green; b = gray * bw.tintColor.blue; }
    else r = g = b = gray;
  }
  const l = colourLuminance(r, g, b), shadows = clamp((0.5 - l) * 2), highlights = clamp((l - 0.5) * 2);
  const midtones = clamp(1 - shadows - highlights);
  if (settings.colourBalance.enabled) {
    [r, g, b] = balance(r, g, b, settings.colourBalance.shadows, shadows);
    [r, g, b] = balance(r, g, b, settings.colourBalance.midtones, midtones);
    [r, g, b] = balance(r, g, b, settings.colourBalance.highlights, highlights);
  }
  r = clamp(r); g = clamp(g); b = clamp(b);
  if (settings.colourBalance.enabled && settings.colourBalance.preserveLuminosity) {
    const now = colourLuminance(r, g, b), scale = now > 1e-6 ? originalLuma / now : 1;
    r = clamp(r * scale); g = clamp(g * scale); b = clamp(b * scale);
  }
  const currentHue = hueWeights(r, g, b);
  for (const [name, values] of Object.entries(settings.selectiveColour.ranges) as [SelectiveColourRange, SelectiveColourValues][]) {
    [r, g, b] = selective(r, g, b, values, rangeWeight(name, r, g, b, currentHue), settings.selectiveColour.mode === 'relative');
  }
  return [r, g, b];
}
