import type { EffectFill, EffectGradient, LayerEffect, RGB } from '../model';

const MODES = new Set<string>([
  'normal', 'dissolve', 'darken', 'multiply', 'colorBurn', 'linearBurn', 'darkerColor', 'lighten', 'screen',
  'colorDodge', 'linearDodge', 'lighterColor', 'overlay', 'softLight', 'hardLight', 'vividLight', 'linearLight',
  'pinLight', 'hardMix', 'difference', 'exclusion', 'subtract', 'divide', 'hue', 'saturation', 'color', 'luminosity',
]);

function number(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function range(value: unknown, low: number, high: number): value is number { return number(value) && value >= low && value <= high; }
function rgb(value: unknown): value is RGB {
  const color = value as Partial<RGB> | null;
  return !!color && range(color.red, 0, 1) && range(color.green, 0, 1) && range(color.blue, 0, 1);
}
function gradient(value: unknown): value is EffectGradient {
  const candidate = value as Partial<EffectGradient> | null;
  return !!candidate && Array.isArray(candidate.stops) && candidate.stops.length >= 2
    && candidate.stops.every((stop) => range(stop.offset, 0, 1) && rgb(stop.color) && range(stop.opacity, 0, 1))
    && (candidate.reverse === undefined || typeof candidate.reverse === 'boolean');
}
function fill(value: unknown): value is EffectFill {
  const candidate = value as Partial<EffectFill> | null;
  return !!candidate && (candidate.kind === 'color' ? rgb(candidate.color)
    : candidate.kind === 'gradient' && gradient(candidate.gradient) && number(candidate.angle) && range(candidate.scale, 1, 10_000));
}
function mode(value: unknown): boolean { return typeof value === 'string' && MODES.has(value); }

/** Strict live/project validation for the schema-versioned Phase-2 style records. */
export function isValidLayerEffect(value: unknown): value is LayerEffect {
  const effect = value as Partial<LayerEffect> | null;
  if (!effect || effect.schemaVersion !== 1 || typeof effect.enabled !== 'boolean') return false;
  if (effect.kind === 'dropShadow') return range(effect.opacity, 0, 1) && number(effect.angle)
    && range(effect.distance, 0, 10_000) && range(effect.blur, 0, 10_000) && rgb(effect.color)
    && (effect.blendMode === undefined || mode(effect.blendMode))
    && (effect.useGlobalLight === undefined || typeof effect.useGlobalLight === 'boolean')
    && (effect.spread === undefined || range(effect.spread, 0, 100))
    && (effect.size === undefined || range(effect.size, 0, 10_000))
    && (effect.contour === undefined || effect.contour === 'linear')
    && (effect.noise === undefined || effect.noise === 0)
    && (effect.knockout === undefined || typeof effect.knockout === 'boolean');
  if (effect.kind === 'stroke') return range(effect.width, 0, 10_000)
    && ['inside', 'center', 'outside'].includes(effect.position ?? '')
    && (rgb(effect.color) || fill(effect.fill)) && (effect.opacity === undefined || range(effect.opacity, 0, 1))
    && (effect.blendMode === undefined || mode(effect.blendMode));
  if (effect.kind === 'outerGlow') return range(effect.opacity, 0, 1) && rgb(effect.color)
    && mode(effect.blendMode) && range(effect.spread, 0, 100) && range(effect.size, 0, 10_000)
    && effect.contour === 'linear' && effect.noise === 0;
  if (effect.kind === 'colorOverlay') return range(effect.opacity, 0, 1) && rgb(effect.color)
    && (effect.blendMode === undefined || mode(effect.blendMode));
  if (effect.kind === 'gradientOverlay') return range(effect.opacity, 0, 1) && mode(effect.blendMode)
    && number(effect.angle) && range(effect.scale, 1, 10_000) && gradient(effect.gradient);
  if (effect.kind === 'innerShadow') return range(effect.opacity, 0, 1) && mode(effect.blendMode) && rgb(effect.color)
    && number(effect.angle) && typeof effect.useGlobalLight === 'boolean' && range(effect.distance, 0, 10_000)
    && range(effect.choke, 0, 100) && range(effect.size, 0, 10_000) && effect.contour === 'linear';
  if (effect.kind === 'innerGlow') return range(effect.opacity, 0, 1) && mode(effect.blendMode) && rgb(effect.color)
    && ['edge', 'center'].includes(effect.source ?? '') && range(effect.choke, 0, 100)
    && range(effect.size, 0, 10_000) && effect.contour === 'linear';
  if (effect.kind === 'bevelEmboss') return ['innerBevel', 'outerBevel', 'emboss', 'pillowEmboss'].includes(effect.style ?? '')
    && ['smooth', 'chiselHard', 'chiselSoft'].includes(effect.technique ?? '') && range(effect.depth, 1, 1000)
    && ['up', 'down'].includes(effect.direction ?? '') && range(effect.size, 0, 250) && range(effect.soften, 0, 16)
    && number(effect.angle) && range(effect.altitude, 0, 90) && typeof effect.useGlobalLight === 'boolean'
    && mode(effect.highlightMode) && rgb(effect.highlightColor) && range(effect.highlightOpacity, 0, 1)
    && mode(effect.shadowMode) && rgb(effect.shadowColor) && range(effect.shadowOpacity, 0, 1)
    && effect.glossContour === 'linear';
  if (effect.kind === 'satin') return range(effect.opacity, 0, 1) && mode(effect.blendMode) && rgb(effect.color)
    && number(effect.angle) && range(effect.distance, 0, 10_000) && range(effect.size, 0, 250)
    && typeof effect.invert === 'boolean' && effect.contour === 'linear';
  return effect.kind === 'patternOverlay' && range(effect.opacity, 0, 1) && mode(effect.blendMode)
    && typeof effect.resourceId === 'string' && effect.resourceId.length > 0
    && Number.isInteger(effect.patternWidth) && range(effect.patternWidth, 1, 30_000)
    && Number.isInteger(effect.patternHeight) && range(effect.patternHeight, 1, 30_000)
    && range(effect.scale, 1, 10_000) && number(effect.angle) && typeof effect.linkWithLayer === 'boolean'
    && (effect.phase === undefined || (number(effect.phase.x) && number(effect.phase.y)));
}
