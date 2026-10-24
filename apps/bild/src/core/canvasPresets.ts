/**
 * New Canvas sizes (UI/NewCanvasSheet.swift, Compositor 1.3.6 and 1.4.6): preset sizes, print units at a resolution,
 * and the colour a new canvas starts with.
 */

export type CanvasUnit = 'px' | 'in' | 'cm' | 'mm';
export const CANVAS_UNITS: readonly CanvasUnit[] = ['px', 'in', 'cm', 'mm'];
const PER_INCH: Record<CanvasUnit, number | null> = { px: null, in: 1, cm: 2.54, mm: 25.4 };

/** Whole pixels for a typed size, or null when it is not a size a canvas can have. Accepts a decimal comma. */
export function canvasPixels(text: string, unit: CanvasUnit, resolution: number, maxSide: number): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (!/^\d*\.?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed), perInch = PER_INCH[unit];
  if (!Number.isFinite(value) || value <= 0) return null;
  // Print sizes round to the nearest pixel; a pixel count must already be whole.
  const pixels = perInch === null ? value : Math.round(value / perInch * resolution);
  return Number.isInteger(pixels) && pixels >= 1 && pixels <= maxSide ? pixels : null;
}

/** A pixel size written in a unit: whole pixels, or print sizes to two decimals at most. */
export function canvasText(pixels: number, unit: CanvasUnit, resolution: number): string {
  const perInch = PER_INCH[unit];
  if (perInch === null) return String(pixels);
  return String(Math.round(pixels / resolution * perInch * 100) / 100);
}

export type CanvasBackground = 'transparent' | 'white' | 'black';
export const CANVAS_BACKGROUNDS: readonly CanvasBackground[] = ['transparent', 'white', 'black'];
export function backgroundColor(background: CanvasBackground): { red: number; green: number; blue: number } | null {
  return background === 'white' ? { red: 1, green: 1, blue: 1 } : background === 'black' ? { red: 0, green: 0, blue: 0 } : null;
}

export interface CanvasPreset {
  readonly id: string;
  /** English name; the UI translates it like every other label. */
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Set for print sizes, which are only those pixels at this resolution. */
  readonly resolution?: number;
}
export interface CanvasPresetGroup { readonly name: string; readonly presets: readonly CanvasPreset[] }

/** Compositor's groups, plus the print sheets the artboard presets already know (ISO 216 / ANSI at 300 ppi). */
export const CANVAS_PRESET_GROUPS: readonly CanvasPresetGroup[] = [
  { name: 'Screens', presets: [
    { id: '4k', name: '4K', width: 3840, height: 2160 },
    { id: '1440p', name: '1440p', width: 2560, height: 1440 },
    { id: '1080p', name: '1080p', width: 1920, height: 1080 },
    { id: '720p', name: '720p', width: 1280, height: 720 },
  ] },
  { name: 'Devices', presets: [
    { id: 'iphone-pro', name: 'iPhone 18 Pro', width: 1206, height: 2622 },
    { id: 'iphone-pro-max', name: 'iPhone 18 Pro Max', width: 1320, height: 2868 },
    { id: 'macbook-14', name: 'MacBook Pro 14"', width: 3024, height: 1964 },
    { id: 'macbook-16', name: 'MacBook Pro 16"', width: 3456, height: 2234 },
    { id: 'studio-display', name: 'Studio Display', width: 5120, height: 2880 },
  ] },
  { name: 'Social media', presets: [
    { id: 'instagram-square', name: 'Instagram Square', width: 1080, height: 1080 },
    { id: 'instagram-portrait', name: 'Instagram Portrait', width: 1080, height: 1350 },
    { id: 'instagram-story', name: 'Instagram Story', width: 1080, height: 1920 },
    { id: 'youtube-thumbnail', name: 'YouTube Thumbnail', width: 1280, height: 720 },
    { id: 'facebook-cover', name: 'Facebook Cover', width: 851, height: 315 },
    { id: 'linkedin-banner', name: 'LinkedIn Banner', width: 1584, height: 396 },
  ] },
  { name: 'Print (300 ppi)', presets: [
    { id: 'a3', name: 'A3', width: 3508, height: 4961, resolution: 300 },
    { id: 'a4', name: 'A4', width: 2480, height: 3508, resolution: 300 },
    { id: 'a5', name: 'A5', width: 1748, height: 2480, resolution: 300 },
    { id: 'us-letter', name: 'US Letter', width: 2550, height: 3300, resolution: 300 },
  ] },
];
export const CANVAS_PRESETS: readonly CanvasPreset[] = CANVAS_PRESET_GROUPS.flatMap((group) => group.presets);

/** The preset the size matches (and its resolution, for print sizes), or undefined for a custom size. */
export function matchingPreset(width: number | null, height: number | null, resolution: number): CanvasPreset | undefined {
  return CANVAS_PRESETS.find((preset) => preset.width === width && preset.height === height
    && (preset.resolution === undefined || preset.resolution === resolution));
}
