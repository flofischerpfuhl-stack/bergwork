/**
 * Artboard size presets (PRODUCT-PLAN 6.1 "Zeichenflächen mit Formatvorlagen: Social, Web, Druck").
 * Pure data: the artboard tool and the New dialog list these; `createArtboard` accepts a preset id.
 *
 * Print sizes are the ISO 216 / ANSI sheet sizes at 300 ppi, rounded to whole pixels
 * (mm / 25.4 × 300). Social sizes follow the networks' published upload recommendations (2026).
 */

export type ArtboardPresetCategory = 'social' | 'web' | 'print';

export interface ArtboardPreset {
  readonly id: string;
  readonly category: ArtboardPresetCategory;
  /** English display name; the UI translates it like every other label. */
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Pixels per inch the size was computed for (print) or the screen default (72). */
  readonly resolution: number;
}

export const ARTBOARD_PRESETS: readonly ArtboardPreset[] = [
  { id: 'instagram-post', category: 'social', name: 'Instagram Post', width: 1080, height: 1080, resolution: 72 },
  { id: 'instagram-portrait', category: 'social', name: 'Instagram Portrait', width: 1080, height: 1350, resolution: 72 },
  { id: 'instagram-story', category: 'social', name: 'Instagram Story', width: 1080, height: 1920, resolution: 72 },
  { id: 'facebook-cover', category: 'social', name: 'Facebook Cover', width: 851, height: 315, resolution: 72 },
  { id: 'linkedin-banner', category: 'social', name: 'LinkedIn Banner', width: 1584, height: 396, resolution: 72 },
  { id: 'web-1920', category: 'web', name: 'Web 1920 × 1080', width: 1920, height: 1080, resolution: 72 },
  { id: 'web-1440', category: 'web', name: 'Web 1440 × 900', width: 1440, height: 900, resolution: 72 },
  { id: 'web-1280', category: 'web', name: 'Web 1280 × 720', width: 1280, height: 720, resolution: 72 },
  { id: 'mobile-390', category: 'web', name: 'Mobile 390 × 844', width: 390, height: 844, resolution: 72 },
  { id: 'print-a3', category: 'print', name: 'A3', width: 3508, height: 4961, resolution: 300 },
  { id: 'print-a4', category: 'print', name: 'A4', width: 2480, height: 3508, resolution: 300 },
  { id: 'print-a5', category: 'print', name: 'A5', width: 1748, height: 2480, resolution: 300 },
  { id: 'print-us-letter', category: 'print', name: 'US Letter', width: 2550, height: 3300, resolution: 300 },
];

export function artboardPreset(id: string): ArtboardPreset | undefined {
  return ARTBOARD_PRESETS.find((preset) => preset.id === id);
}

export function artboardPresetsIn(category: ArtboardPresetCategory): ArtboardPreset[] {
  return ARTBOARD_PRESETS.filter((preset) => preset.category === category);
}
