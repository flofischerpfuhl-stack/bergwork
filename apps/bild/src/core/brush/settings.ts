export type BrushMode = 'paint' | 'erase' | 'dodge' | 'burn' | 'sponge';
export type BrushRange = 'shadows' | 'midtones' | 'highlights';
export type SpongeMode = 'saturate' | 'desaturate';

/** `BrushSettings` from Document/BrushStroke.swift. Colours and opacity are 0...1. */
export interface BrushSettings {
  readonly diameter: number;
  readonly hardness: number;
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly opacity: number;
  readonly mode: BrushMode;
  readonly range?: BrushRange;
  readonly exposure?: number;
  readonly spongeMode?: SpongeMode;
  readonly flow?: number;
  readonly vibrance?: boolean;
}

export const DEFAULT_BRUSH_SETTINGS: BrushSettings = {
  diameter: 40,
  hardness: 1,
  red: 0,
  green: 0,
  blue: 0,
  opacity: 1,
  mode: 'paint',
  range: 'midtones', exposure: 0.5, spongeMode: 'saturate', flow: 0.5, vibrance: false,
};

/** Clone Stamp owns a soft parked tip (`EditorSession.selectTool`). */
export const DEFAULT_CLONE_SETTINGS: BrushSettings = {
  ...DEFAULT_BRUSH_SETTINGS,
  hardness: 0,
};

/** Normalized Gaussian used by `BrushRaster.falloff`. */
export function falloff(u: number): number {
  const k = 2.5;
  return Math.max(0, (Math.exp(-k * u * u) - Math.exp(-k)) / (1 - Math.exp(-k)));
}

export function validateBrushSettings(settings: BrushSettings): void {
  const colour = [settings.red, settings.green, settings.blue];
  if (!Number.isFinite(settings.diameter) || settings.diameter < 1 || settings.diameter > 2000
    || !Number.isFinite(settings.hardness) || settings.hardness < 0 || settings.hardness > 1
    || !Number.isFinite(settings.opacity) || settings.opacity < 0.01 || settings.opacity > 1
    || !['paint', 'erase', 'dodge', 'burn', 'sponge'].includes(settings.mode)
    || !['shadows', 'midtones', 'highlights'].includes(settings.range ?? 'midtones')
    || !Number.isFinite(settings.exposure ?? 0.5) || (settings.exposure ?? 0.5) < 0.01 || (settings.exposure ?? 0.5) > 1
    || !['saturate', 'desaturate'].includes(settings.spongeMode ?? 'saturate')
    || !Number.isFinite(settings.flow ?? 0.5) || (settings.flow ?? 0.5) < 0.01 || (settings.flow ?? 0.5) > 1
    || (settings.vibrance !== undefined && typeof settings.vibrance !== 'boolean')
    || colour.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new RangeError('Invalid brush settings');
  }
}

/** Shift-[ / Shift-] quarter steps from EditorSession+Brush.swift. */
export function changeBrushHardness(settings: BrushSettings, increase: boolean): BrushSettings {
  const quarter = settings.hardness * 4;
  const step = increase ? Math.floor(quarter + 0.001) + 1 : Math.ceil(quarter - 0.001) - 1;
  return { ...settings, hardness: Math.min(4, Math.max(0, step)) / 4 };
}

/** [ / ] fifth steps from EditorSession+Brush.swift, always moving by at least one pixel. */
export function changeBrushSize(settings: BrushSettings, increase: boolean): BrushSettings {
  const current = settings.diameter;
  const stepped = increase
    ? Math.max(current + 1, Math.round(current * 1.2))
    : Math.min(current - 1, Math.round(current / 1.2));
  return { ...settings, diameter: Math.min(2000, Math.max(1, stepped)) };
}
