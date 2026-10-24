/**
 * Brush presets (PRODUCT-PLAN 6.3): a preset is a tip plus dynamics plus size, hardness and opacity. The default set
 * is generated here (round tips and procedurally made textured tips — no third-party brush images). Presets are app
 * state; `serializeBrushPresets`/`parseBrushPresets` give the portable JSON form used for storage and documents.
 */

import { unzlibSync, zlibSync } from 'fflate';
import { uuid } from '../ids';
import type { AbrParseResult } from '../../io/abr';
import type { BrushSettings } from './settings';
import {
  DEFAULT_BRUSH_DYNAMICS, dabRandom, validBrushDynamics, validBrushTip,
  type BrushDynamics, type BrushTip, type BrushTipImage,
} from './tip';

export interface BrushPreset {
  readonly id: string;
  readonly name: string;
  readonly diameter: number;
  readonly hardness: number;
  readonly opacity: number;
  readonly tip: BrushTip;
  readonly dynamics: BrushDynamics;
}

export const MAX_PRESET_NAME = 256;
export const MAX_PRESETS = 2_000;

const ROUND: BrushTip = { kind: 'round', angle: 0, roundness: 1 };

/** The preset's look applied to the current brush; colour, mode and toning options stay. */
export function applyBrushPreset(settings: BrushSettings, preset: BrushPreset): BrushSettings {
  return { ...settings, diameter: preset.diameter, hardness: preset.hardness, opacity: preset.opacity, tip: preset.tip, dynamics: preset.dynamics };
}

export function presetFromSettings(settings: BrushSettings, name: string): BrushPreset {
  return { id: uuid(), name: name.slice(0, MAX_PRESET_NAME), diameter: settings.diameter, hardness: settings.hardness,
    opacity: settings.opacity, tip: settings.tip ?? ROUND, dynamics: settings.dynamics ?? DEFAULT_BRUSH_DYNAMICS };
}

/** Whether the brush currently is this preset (the picker highlights it; editing a setting leaves it). */
export function settingsMatchPreset(settings: BrushSettings, preset: BrushPreset): boolean {
  const tip = settings.tip ?? ROUND, dynamics = settings.dynamics ?? DEFAULT_BRUSH_DYNAMICS;
  const sameTip = tip.kind === preset.tip.kind && tip.angle === preset.tip.angle && tip.roundness === preset.tip.roundness
    && (tip.kind !== 'sampled' || (preset.tip.kind === 'sampled' && tip.image.id === preset.tip.image.id));
  return sameTip && settings.diameter === preset.diameter && settings.hardness === preset.hardness && settings.opacity === preset.opacity
    && JSON.stringify(dynamics) === JSON.stringify(preset.dynamics);
}

export function validBrushPreset(value: unknown): value is BrushPreset {
  const p = value as BrushPreset | null;
  return !!p && typeof p === 'object' && typeof p.id === 'string' && p.id.length > 0 && p.id.length <= 128
    && typeof p.name === 'string' && p.name.length <= MAX_PRESET_NAME
    && Number.isFinite(p.diameter) && p.diameter >= 1 && p.diameter <= 2000
    && Number.isFinite(p.hardness) && p.hardness >= 0 && p.hardness <= 1
    && Number.isFinite(p.opacity) && p.opacity >= 0.01 && p.opacity <= 1
    && validBrushTip(p.tip) && validBrushDynamics(p.dynamics);
}

// MARK: Default set

const dynamics = (patch: Partial<BrushDynamics>): BrushDynamics => ({ ...DEFAULT_BRUSH_DYNAMICS, ...patch });

function generatedTip(id: string, size: number, value: (x: number, y: number, random: (n: number) => number) => number): BrushTipImage {
  const data = new Uint8Array(size * size);
  let seed = 0;
  for (const char of id) seed = (Math.imul(seed, 31) + char.charCodeAt(0)) >>> 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const index = y * size + x;
    const v = value((x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1, (n) => dabRandom(seed, index, n));
    data[index] = Math.round(Math.min(1, Math.max(0, v)) * 255);
  }
  return { id, width: size, height: size, data };
}

const smooth = (edge0: number, edge1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0))); return t * t * (3 - 2 * t); };

/** Chalk: a grainy disc with a ragged rim. */
function chalkTip(): BrushTipImage {
  return generatedTip('builtin-chalk', 96, (x, y, random) => {
    const r = Math.hypot(x, y);
    return (1 - smooth(0.7, 1, r + (random(1) - 0.5) * 0.25)) * (random(0) < 0.62 ? 0.55 + random(2) * 0.45 : 0);
  });
}

/** Spatter: a cluster of soft droplets of different sizes. */
function spatterTip(): BrushTipImage {
  const drops: [number, number, number][] = [];
  for (let i = 0; i < 26; i++) {
    const angle = dabRandom(7, i, 0) * Math.PI * 2, distance = Math.sqrt(dabRandom(7, i, 1)) * 0.78;
    drops.push([Math.cos(angle) * distance, Math.sin(angle) * distance, 0.04 + dabRandom(7, i, 2) * 0.13]);
  }
  return generatedTip('builtin-spatter', 128, (x, y) => {
    let v = 0;
    for (const [dx, dy, radius] of drops) v = Math.max(v, 1 - smooth(radius * 0.6, radius, Math.hypot(x - dx, y - dy)));
    return v;
  });
}

/** Dry bristles: parallel streaks of varying strength inside an ellipse. */
function bristleTip(): BrushTipImage {
  const strands = Array.from({ length: 40 }, (_, i) => 0.25 + dabRandom(11, i, 0) * 0.75);
  return generatedTip('builtin-bristle', 128, (x, y) => {
    const inside = 1 - smooth(0.82, 1, Math.hypot(x, y * 1.8));
    const strand = strands[Math.min(strands.length - 1, Math.floor((x + 1) / 2 * strands.length))]!;
    const gap = Math.abs(((x + 1) / 2 * strands.length) % 1 - 0.5) < 0.18 ? 0.15 : 1;
    return inside * strand * gap;
  });
}

/** Grass: tall thin blades fanning out from the bottom. */
function grassTip(): BrushTipImage {
  const blades = Array.from({ length: 9 }, (_, i) => ({ lean: (dabRandom(13, i, 0) - 0.5) * 0.9, base: (dabRandom(13, i, 1) - 0.5) * 0.5,
    height: 0.55 + dabRandom(13, i, 2) * 0.4 }));
  return generatedTip('builtin-grass', 128, (x, y) => {
    let v = 0;
    const up = (1 - y) / 2; // 0 at the bottom, 1 at the top
    for (const blade of blades) {
      if (up > blade.height) continue;
      const centre = blade.base + blade.lean * up * up;
      const width = 0.05 * (1 - up / blade.height);
      v = Math.max(v, 1 - smooth(width * 0.5, width, Math.abs(x - centre)));
    }
    return v;
  });
}

let defaults: readonly BrushPreset[] | null = null;

/** Built-in presets; names are English keys translated by the UI. Ids are stable across sessions. */
export function defaultBrushPresets(): readonly BrushPreset[] {
  if (defaults) return defaults;
  const sampled = (image: BrushTipImage, angle = 0): BrushTip => ({ kind: 'sampled', image, angle, roundness: 1 });
  defaults = [
    { id: 'builtin-hard-round', name: 'Hard Round', diameter: 40, hardness: 1, opacity: 1, tip: ROUND, dynamics: DEFAULT_BRUSH_DYNAMICS },
    { id: 'builtin-soft-round', name: 'Soft Round', diameter: 60, hardness: 0, opacity: 1, tip: ROUND, dynamics: DEFAULT_BRUSH_DYNAMICS },
    { id: 'builtin-pressure-size', name: 'Hard Round Pressure Size', diameter: 30, hardness: 1, opacity: 1, tip: ROUND,
      dynamics: dynamics({ spacing: 0.1, sizeControl: 'pressure', minimumDiameter: 0.1, opacityControl: 'off' }) },
    { id: 'builtin-airbrush', name: 'Soft Airbrush', diameter: 90, hardness: 0, opacity: 1, tip: ROUND, dynamics: dynamics({ spacing: 0.1, flow: 0.1 }) },
    { id: 'builtin-calligraphy', name: 'Calligraphy', diameter: 28, hardness: 1, opacity: 1, tip: { kind: 'round', angle: 45, roundness: 0.2 },
      dynamics: dynamics({ spacing: 0.05 }) },
    { id: 'builtin-chalk', name: 'Chalk', diameter: 40, hardness: 1, opacity: 1, tip: sampled(chalkTip()),
      dynamics: dynamics({ spacing: 0.25, angleJitter: 1 }) },
    { id: 'builtin-spatter', name: 'Spatter', diameter: 70, hardness: 1, opacity: 1, tip: sampled(spatterTip()),
      dynamics: dynamics({ spacing: 0.6, scatter: 0.6, count: 2, sizeJitter: 0.5, angleJitter: 1, opacityJitter: 0.3 }) },
    { id: 'builtin-bristle', name: 'Dry Brush', diameter: 50, hardness: 1, opacity: 1, tip: sampled(bristleTip(), 90),
      dynamics: dynamics({ spacing: 0.08, flow: 0.6 }) },
    { id: 'builtin-grass', name: 'Grass', diameter: 80, hardness: 1, opacity: 1, tip: sampled(grassTip()),
      dynamics: dynamics({ spacing: 0.35, scatter: 0.4, sizeJitter: 0.4, angleJitter: 0.05 }) },
  ];
  return defaults;
}

// MARK: .abr import

/** Photoshop brushes as presets: sampled tips keep their image, computed tips become procedural round tips. */
export function presetsFromAbr(result: AbrParseResult, fallbackName: string): BrushPreset[] {
  return result.brushes.map((brush, index) => {
    const name = (brush.name || `${fallbackName} ${index + 1}`).slice(0, MAX_PRESET_NAME);
    const spacing = brush.spacing;
    const tip: BrushTip = brush.kind === 'sampled' && brush.image
      ? { kind: 'sampled', image: { id: uuid(), width: brush.image.width, height: brush.image.height, data: brush.image.data },
        angle: brush.angle, roundness: brush.roundness }
      : { kind: 'round', angle: brush.angle, roundness: brush.roundness };
    return { id: uuid(), name, diameter: Math.min(2000, Math.max(1, Math.round(brush.diameter))), hardness: brush.kind === 'sampled' ? 1 : brush.hardness,
      opacity: 1, tip, dynamics: dynamics({ spacing: tip.kind === 'sampled' ? spacing ?? 0.25 : spacing }) };
  });
}

// MARK: Portable form

interface SerializedTip { readonly id: string; readonly width: number; readonly height: number; readonly zlib: string }
interface SerializedPreset extends Omit<BrushPreset, 'tip'> {
  readonly tip: { readonly kind: 'round'; readonly angle: number; readonly roundness: number }
    | { readonly kind: 'sampled'; readonly image: SerializedTip; readonly angle: number; readonly roundness: number };
}
export interface SerializedBrushPresets { readonly format: 'fernwork-brush-presets'; readonly version: 1; readonly presets: readonly SerializedPreset[] }

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
function fromBase64(text: string): Uint8Array {
  const binary = atob(text), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Tips are zlib-compressed and base64-encoded, everything else is plain JSON. */
export function serializeBrushPresets(presets: readonly BrushPreset[]): SerializedBrushPresets {
  return { format: 'fernwork-brush-presets', version: 1, presets: presets.map((preset) => ({
    ...preset,
    tip: preset.tip.kind === 'sampled'
      ? { kind: 'sampled', angle: preset.tip.angle, roundness: preset.tip.roundness, image: { id: preset.tip.image.id,
        width: preset.tip.image.width, height: preset.tip.image.height, zlib: base64(zlibSync(preset.tip.image.data, { level: 6 })) } }
      : { kind: 'round', angle: preset.tip.angle, roundness: preset.tip.roundness },
  })) };
}

/** Validates untrusted input (storage, documents); invalid presets are dropped, never half-applied. */
export function parseBrushPresets(value: unknown): BrushPreset[] {
  const source = value as SerializedBrushPresets | null;
  if (!source || typeof source !== 'object' || source.format !== 'fernwork-brush-presets' || source.version !== 1 || !Array.isArray(source.presets)) return [];
  const result: BrushPreset[] = [];
  const ids = new Set<string>();
  for (const item of source.presets.slice(0, MAX_PRESETS)) {
    try {
      let tip: BrushTip = item.tip as BrushTip;
      if (item.tip?.kind === 'sampled') {
        const image = item.tip.image;
        const data = unzlibSync(fromBase64(image.zlib));
        tip = { kind: 'sampled', angle: item.tip.angle, roundness: item.tip.roundness, image: { id: image.id, width: image.width, height: image.height, data } };
      } else if (item.tip) tip = { kind: 'round', angle: item.tip.angle, roundness: item.tip.roundness };
      const preset: BrushPreset = { id: item.id, name: item.name, diameter: item.diameter, hardness: item.hardness, opacity: item.opacity,
        tip, dynamics: knownDynamics(item.dynamics) };
      if (validBrushPreset(preset) && !ids.has(preset.id)) { ids.add(preset.id); result.push(preset); }
    } catch { /* a damaged tip drops only its preset */ }
  }
  return result;
}

/** Missing fields take their defaults; unknown keys from files are dropped. */
function knownDynamics(value: Partial<BrushDynamics> | undefined): BrushDynamics {
  if (!value || typeof value !== 'object') return DEFAULT_BRUSH_DYNAMICS;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_BRUSH_DYNAMICS) as (keyof BrushDynamics)[]) result[key] = key in value ? value[key] : DEFAULT_BRUSH_DYNAMICS[key];
  return result as unknown as BrushDynamics;
}
