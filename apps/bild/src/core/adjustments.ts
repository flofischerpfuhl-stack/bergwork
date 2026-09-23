/**
 * Adjustment settings (LayerAdjustment.swift and the settings structs it embeds).
 * Placeholder shape until the adjustment/filter module lands: only `kind` plus the defaults
 * `addAdjustment` sets upstream (Gradient Map from foreground to background, a random Grain seed).
 */

import type { AdjustmentKind, LayerAdjustment } from './document';

export interface RGB { readonly red: number; readonly green: number; readonly blue: number }

export function defaultAdjustment(kind: AdjustmentKind, foreground: RGB, background: RGB): LayerAdjustment {
  if (kind === 'Gradient Map') {
    return { kind, gradientMapSettings: { shadows: { ...foreground }, highlights: { ...background } } };
  }
  if (kind === 'Grain') {
    return { kind, grainSettings: { seed: Math.floor(Math.random() * 0xffffffff) } };
  }
  return { kind };
}
