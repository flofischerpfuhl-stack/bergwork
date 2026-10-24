/** How recipes and their steps are named in the UI (Save Recipe…, the Recipes panel, File › Batch…). */

import type { Recipe, RecipeStep } from '../../core/recipes';
import type { EditorController } from '../../ui/controller';
import { LIVE_FILTER_NAMES } from '../adjust/liveFilters';

export function fill(text: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((s, [key, value]) => s.replaceAll(`{${key}}`, String(value)), text);
}

export function stepLabel(controller: EditorController, step: RecipeStep): string {
  const t = controller.t;
  if (step.kind === 'filter') return t(LIVE_FILTER_NAMES[step.filter.kind]);
  if (step.kind === 'effect') return controller.layerStyles?.label(step.effect.kind) ?? step.effect.kind;
  const kind = t(step.adjustment.kind);
  return step.name && step.name !== kind && step.name !== step.adjustment.kind ? `${step.name} (${kind})` : kind;
}

/** "3 steps · Crop 4:5 · Long edge 2048 px · JPEG" */
export function recipeSummary(controller: EditorController, recipe: Recipe): string {
  const t = controller.t, parts: string[] = [];
  if (recipe.steps.length) parts.push(recipe.steps.length === 1 ? t('1 step') : fill(t('{n} steps'), { n: recipe.steps.length }));
  if (recipe.crop) parts.push(fill(t('Crop {w}:{h}'), { w: recipe.crop.width, h: recipe.crop.height }));
  if (recipe.resize) {
    const text = recipe.resize.mode === 'longEdge' ? 'Long edge {n} px' : recipe.resize.mode === 'width' ? 'Width {n} px' : 'Height {n} px';
    parts.push(fill(t(text), { n: recipe.resize.pixels.toLocaleString(controller.locale) }));
  }
  if (recipe.export) parts.push({ png: 'PNG', jpeg: 'JPEG', webp: 'WebP', avif: 'AVIF', tiff: 'TIFF' }[recipe.export.format]);
  return parts.join(' · ');
}
