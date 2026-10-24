/**
 * Brush tips and dynamics (PRODUCT-PLAN 6.3: presets, flow, spacing, scatter, `.abr` sampled tips).
 *
 * A tip is either procedural (round/elliptic with hardness, angle and roundness) or a sampled grayscale image. A brush
 * without a tip and dynamics keeps the continuous round engine in stroke.ts; anything that needs discrete stamps
 * (spacing, flow, jitter, scatter, elliptic or sampled tips) is placed as dabs by `DabPlacer` and rasterized by
 * dabs.ts (exact CPU/worker) and the dab shader (GPU preview) from the same dab list.
 */

import { falloff } from './settings';

export const MAX_TIP_SIZE = 2500;

/** 8-bit coverage image: 255 paints fully, 0 not at all (Photoshop's inverted brush sample). */
export interface BrushTipImage {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export type BrushTip =
  | { readonly kind: 'round'; readonly angle: number; readonly roundness: number }
  | { readonly kind: 'sampled'; readonly image: BrushTipImage; readonly angle: number; readonly roundness: number };

export type PenControl = 'off' | 'pressure' | 'tilt';

export interface BrushDynamics {
  /** Distance between dabs as a fraction of the diameter; null is the smooth continuous stroke. */
  readonly spacing: number | null;
  /** Per-dab strength 0.01…1; overlapping dabs build up to the opacity. */
  readonly flow: number;
  readonly sizeJitter: number;
  readonly sizeControl: PenControl;
  /** Smallest size the pen control can reach, 0…1 of the diameter. */
  readonly minimumDiameter: number;
  /** 0…1 of a full turn either way. */
  readonly angleJitter: number;
  /** Maximum offset from the path as a fraction of the diameter, 0…10. */
  readonly scatter: number;
  readonly scatterBothAxes: boolean;
  /** Dabs per spacing step, 1…16. */
  readonly count: number;
  readonly opacityJitter: number;
  readonly opacityControl: PenControl;
}

export const DEFAULT_BRUSH_DYNAMICS: BrushDynamics = {
  spacing: null, flow: 1, sizeJitter: 0, sizeControl: 'off', minimumDiameter: 0, angleJitter: 0,
  scatter: 0, scatterBothAxes: false, count: 1, opacityJitter: 0, opacityControl: 'pressure',
};

/** Spacing used when a dab brush has Spacing switched off (smooth). */
export const SMOOTH_DAB_SPACING = 0.1;

const controls: readonly PenControl[] = ['off', 'pressure', 'tilt'];
const unit = (value: unknown, min = 0, max = 1) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

export function validTipImage(value: unknown): value is BrushTipImage {
  const image = value as BrushTipImage | null;
  return !!image && typeof image === 'object' && typeof image.id === 'string' && image.id.length > 0 && image.id.length <= 128
    && Number.isInteger(image.width) && Number.isInteger(image.height) && image.width >= 1 && image.height >= 1
    && image.width <= MAX_TIP_SIZE && image.height <= MAX_TIP_SIZE && image.data instanceof Uint8Array
    && image.data.length === image.width * image.height;
}

export function validBrushTip(value: unknown): value is BrushTip {
  const tip = value as BrushTip | null;
  if (!tip || typeof tip !== 'object' || !unit(tip.roundness, 0.01, 1) || !unit(tip.angle, -360, 360)) return false;
  return tip.kind === 'round' || (tip.kind === 'sampled' && validTipImage(tip.image));
}

export function validBrushDynamics(value: unknown): value is BrushDynamics {
  const d = value as BrushDynamics | null;
  return !!d && typeof d === 'object' && (d.spacing === null || unit(d.spacing, 0.01, 10)) && unit(d.flow, 0.01, 1)
    && unit(d.sizeJitter) && controls.includes(d.sizeControl) && unit(d.minimumDiameter) && unit(d.angleJitter)
    && unit(d.scatter, 0, 10) && typeof d.scatterBothAxes === 'boolean' && Number.isInteger(d.count) && d.count >= 1 && d.count <= 16
    && unit(d.opacityJitter) && controls.includes(d.opacityControl);
}

/** Whether a brush needs discrete dabs; plain round brushes keep the continuous engine byte for byte. */
export function usesDabs(settings: { readonly tip?: BrushTip; readonly dynamics?: BrushDynamics }): boolean {
  const tip = settings.tip, d = settings.dynamics;
  if (tip && (tip.kind === 'sampled' || tip.roundness < 1)) return true;
  if (!d) return false;
  return d.spacing !== null || d.flow < 1 || d.sizeJitter > 0 || d.sizeControl !== 'off' || d.scatter > 0 || d.count > 1
    || d.opacityJitter > 0 || d.opacityControl !== 'pressure';
}

/** Document-space distance from a path point that one stroke can reach (dirty rects, tile loading). */
export function brushReach(settings: { readonly diameter: number; readonly tip?: BrushTip; readonly dynamics?: BrushDynamics }): number {
  if (!usesDabs(settings)) return settings.diameter / 2 + 2;
  const d = settings.dynamics ?? DEFAULT_BRUSH_DYNAMICS;
  const tip = settings.tip ?? { kind: 'round', angle: 0, roundness: 1 };
  const tipReach = tip.kind === 'sampled' ? settings.diameter * Math.SQRT1_2 : settings.diameter / 2;
  return tipReach + d.scatter * settings.diameter * (d.scatterBothAxes ? Math.SQRT2 : 1) + 3;
}

// MARK: Dabs

/** One stamp in document coordinates. */
export interface BrushDab {
  readonly x: number;
  readonly y: number;
  /** Diameter in document pixels after pen control and jitter. */
  readonly size: number;
  /** Radians. */
  readonly angle: number;
  /** Per-dab strength 0…1 (flow, opacity jitter and pen control). */
  readonly alpha: number;
}

export interface DabSegment {
  readonly x0: number; readonly y0: number; readonly length: number; readonly ux: number; readonly uy: number;
  readonly pressure: number; readonly tilt?: number;
}

interface PlacerSettings {
  readonly diameter: number;
  readonly tip?: BrushTip;
  readonly dynamics?: BrushDynamics;
}

/** Integer hash (lowbias32) mapped to [0, 1). Deterministic in every JS engine, the worker and the main thread. */
export function dabRandom(seed: number, index: number, channel: number): number {
  let x = (seed ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(channel + 1, 0x85ebca77)) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function pointSeed(x: number, y: number): number {
  return (Math.imul(Math.round(x * 64) | 0, 0x27d4eb2d) ^ Math.imul(Math.round(y * 64) | 0, 0x165667b1)) >>> 0;
}

/**
 * Walks settled path segments at the spacing distance and emits dabs (Photoshop's brush engine model). The state
 * carries across calls, so the main thread (GPU preview), every worker partition and the synchronous CPU replay
 * produce the same dab list from the same segment stream; randomness is keyed by the stroke's first point and
 * the dab index, never by time.
 */
export class DabPlacer {
  private travelled = 0;
  private started = false;
  private index = 0;
  private seed = 0;
  private readonly dynamics: BrushDynamics;
  private readonly baseAngle: number;

  constructor(private readonly settings: PlacerSettings) {
    this.dynamics = settings.dynamics ?? DEFAULT_BRUSH_DYNAMICS;
    this.baseAngle = (settings.tip?.angle ?? 0) * Math.PI / 180;
  }

  /** Dabs of permanent segments; advances the state. */
  place(segments: readonly DabSegment[], output: BrushDab[] = []): BrushDab[] {
    for (const segment of segments) this.walk(segment, output);
    return output;
  }

  /** Dabs a provisional tail would add, without advancing the state. */
  peek(segments: readonly DabSegment[]): BrushDab[] {
    const saved = { travelled: this.travelled, started: this.started, index: this.index, seed: this.seed };
    const output = this.place(segments);
    Object.assign(this, saved);
    return output;
  }

  private step(segment: DabSegment): number {
    const d = this.dynamics;
    const spacing = d.spacing ?? SMOOTH_DAB_SPACING;
    return Math.max(0.5, spacing * this.settings.diameter * this.controlledSize(segment));
  }

  private controlledSize(segment: DabSegment): number {
    const d = this.dynamics;
    if (d.sizeControl === 'off') return 1;
    const value = d.sizeControl === 'pressure' ? segment.pressure : segment.tilt ?? 1;
    return d.minimumDiameter + (1 - d.minimumDiameter) * Math.min(1, Math.max(0, value));
  }

  private walk(segment: DabSegment, output: BrushDab[]): void {
    if (!this.started) {
      this.started = true;
      this.seed = pointSeed(segment.x0, segment.y0);
      this.emit(segment, 0, output);
      this.travelled = 0;
    }
    const length = segment.length;
    if (!(length > 0)) return;
    const step = this.step(segment);
    let position = 0;
    // At most one dab per half pixel; the guard only protects against a runaway loop on absurd input.
    for (let guard = 0; length - position >= step - this.travelled && guard < 1_000_000; guard++) {
      position += step - this.travelled;
      this.travelled = 0;
      this.emit(segment, position, output);
    }
    this.travelled += length - position;
  }

  private emit(segment: DabSegment, position: number, output: BrushDab[]): void {
    const d = this.dynamics, diameter = this.settings.diameter;
    const cx = segment.x0 + segment.ux * position, cy = segment.y0 + segment.uy * position;
    const nx = segment.length > 0 ? -segment.uy : 0, ny = segment.length > 0 ? segment.ux : 1;
    const opacityInput = d.opacityControl === 'off' ? 1 : d.opacityControl === 'pressure' ? segment.pressure : segment.tilt ?? 1;
    const controlled = this.controlledSize(segment);
    for (let copy = 0; copy < d.count; copy++) {
      const index = this.index++, seed = this.seed;
      const size = diameter * controlled * (1 - d.sizeJitter * dabRandom(seed, index, 0));
      const alpha = d.flow * Math.min(1, Math.max(0, opacityInput)) * (1 - d.opacityJitter * dabRandom(seed, index, 4));
      if (size < 0.25 || alpha <= 0) continue;
      const angle = this.baseAngle + d.angleJitter * (dabRandom(seed, index, 1) * 2 - 1) * Math.PI;
      const across = d.scatter * diameter * (dabRandom(seed, index, 2) * 2 - 1);
      const along = d.scatterBothAxes ? d.scatter * diameter * (dabRandom(seed, index, 3) * 2 - 1) : 0;
      output.push({ x: cx + nx * across + segment.ux * along, y: cy + ny * across + segment.uy * along, size, angle, alpha });
    }
  }
}

// MARK: Tip sampling (shared by the CPU rasterizer; the GPU dab shader mirrors it)

export interface TipLevel {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  /** Position inside the GPU atlas (level 0 on top, the smaller levels side by side below it). */
  readonly atlasX: number;
  readonly atlasY: number;
}

const levelCache = new WeakMap<BrushTipImage, readonly TipLevel[]>();

/** Box-filtered halvings down to 1 px (integer rounding, so the CPU and the uploaded GPU atlas hold equal bytes). */
export function tipLevels(image: BrushTipImage): readonly TipLevel[] {
  const cached = levelCache.get(image);
  if (cached) return cached;
  const levels: TipLevel[] = [{ width: image.width, height: image.height, data: image.data, atlasX: 0, atlasY: 0 }];
  let atlasX = 0;
  while (levels.length < 16) {
    const previous = levels.at(-1)!;
    if (previous.width === 1 && previous.height === 1) break;
    const width = Math.max(1, Math.ceil(previous.width / 2)), height = Math.max(1, Math.ceil(previous.height / 2));
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let sum = 0, count = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const sx = x * 2 + dx, sy = y * 2 + dy;
        if (sx < previous.width && sy < previous.height) { sum += previous.data[sy * previous.width + sx]!; count++; }
      }
      data[y * width + x] = Math.round(sum / count);
    }
    levels.push({ width, height, data, atlasX, atlasY: image.height });
    atlasX += width;
  }
  levelCache.set(image, levels);
  return levels;
}

/** One texture holding every level (width = level 0, height = level 0 + level 1). */
export function tipAtlas(image: BrushTipImage): { width: number; height: number; data: Uint8Array } {
  const levels = tipLevels(image);
  const width = image.width, height = image.height + (levels[1]?.height ?? 0);
  const data = new Uint8Array(width * height);
  for (const level of levels) {
    for (let y = 0; y < level.height; y++) data.set(level.data.subarray(y * level.width, (y + 1) * level.width), (level.atlasY + y) * width + level.atlasX);
  }
  return { width, height, data };
}

/** The mip level whose resolution is closest above the dab size. */
export function tipLevelIndex(image: BrushTipImage, size: number, levels = tipLevels(image).length): number {
  const scale = size / Math.max(image.width, image.height);
  if (scale >= 1) return 0;
  return Math.min(levels - 1, Math.max(0, Math.floor(Math.log2(1 / scale))));
}

/** Per-dab constants for the per-pixel coverage function. */
export interface PreparedDab {
  readonly x: number; readonly y: number;
  readonly cos: number; readonly sin: number;
  readonly radius: number; readonly minor: number;
  readonly alpha: number;
  /** Half extent of the bounding square in document pixels. */
  readonly reach: number;
  readonly level: TipLevel | null;
  /** Tip-image pixels per document pixel along the tip axes (level space). */
  readonly scaleX: number; readonly scaleY: number;
}

export function prepareDab(dab: BrushDab, tip: BrushTip | undefined, antialias: number): PreparedDab {
  const roundness = tip?.roundness ?? 1;
  const radius = dab.size / 2;
  const cos = Math.cos(dab.angle), sin = Math.sin(dab.angle);
  if (tip?.kind === 'sampled') {
    const levels = tipLevels(tip.image);
    const level = levels[tipLevelIndex(tip.image, dab.size, levels.length)]!;
    const scale = dab.size / Math.max(tip.image.width, tip.image.height);
    return { x: dab.x, y: dab.y, cos, sin, radius, minor: radius * roundness, alpha: dab.alpha,
      reach: dab.size * Math.SQRT1_2 + 1, level,
      scaleX: level.width / tip.image.width / scale, scaleY: level.height / tip.image.height / (scale * roundness) };
  }
  return { x: dab.x, y: dab.y, cos, sin, radius, minor: radius * roundness, alpha: dab.alpha,
    reach: radius + antialias + 1, level: null, scaleX: 0, scaleY: 0 };
}

/** Coverage 0…1 of one dab at a document point (before flow/opacity). */
export function dabCoverage(dab: PreparedDab, px: number, py: number, hardness: number, antialias: number): number {
  const dx = px - dab.x, dy = py - dab.y;
  const lx = dab.cos * dx + dab.sin * dy, ly = -dab.sin * dx + dab.cos * dy;
  const level = dab.level;
  if (level) {
    const tx = lx * dab.scaleX + level.width / 2 - 0.5, ty = ly * dab.scaleY + level.height / 2 - 0.5;
    const x0 = Math.floor(tx), y0 = Math.floor(ty), fx = tx - x0, fy = ty - y0;
    if (x0 < -1 || y0 < -1 || x0 >= level.width || y0 >= level.height) return 0;
    const w = level.width, h = level.height, data = level.data;
    const left = x0 >= 0, right = x0 + 1 < w, upper = y0 >= 0, lower = y0 + 1 < h;
    const row0 = y0 * w, row1 = row0 + w;
    const a = left && upper ? data[row0 + x0]! : 0, b = right && upper ? data[row0 + x0 + 1]! : 0;
    const c = left && lower ? data[row1 + x0]! : 0, d = right && lower ? data[row1 + x0 + 1]! : 0;
    const top = a * (1 - fx) + b * fx;
    const bottom = c * (1 - fx) + d * fx;
    return (top * (1 - fy) + bottom * fy) / 255;
  }
  const nx = lx / dab.radius, ny = ly / dab.minor;
  const u = Math.sqrt(nx * nx + ny * ny);
  if (hardness >= 1) return Math.min(1, Math.max(0, (1 - u) * dab.minor / antialias + 0.5));
  if (u >= 1) return 0;
  return falloff(Math.min(1, Math.max(0, (u - hardness) / (1 - hardness))));
}
