/**
 * Recipes (PRODUCT-PLAN 6.9 „Rezepte“, Phase 3): a saved, ordered stack of non-destructive steps captured from a
 * layer — its live filters, its layer style and the adjustment layers directly above it — plus optional output
 * steps for batch runs (crop to an aspect ratio, resize, an export preset). A recipe is applied to other layers
 * (one undo step, see `applyRecipeInSession`) or to files in File › Batch… (src/io/batch.ts).
 *
 * Deliberately not an action recorder (6.9 row 3, Phase 4): a recipe holds the parameters of live steps, never
 * a replay of commands, so applying it is deterministic and stays editable on the target.
 *
 * File format `.fwrecipe`: UTF-8 JSON of `Recipe` (`format: "fernwork-recipe"`, `version: 1`). Steps reuse the
 * document model's schema-versioned records (`LiveFilter`, `LayerEffect`, `LayerAdjustment`); a Colour Lookup
 * step carries its `.cube` bytes as base64 because the document resource it points at is not part of the recipe.
 * Readers reject unknown versions and invalid steps instead of guessing.
 */

import { isValidAdjustment } from './adjustments';
import { cropDocument } from './canvasOps';
import { BLEND_MODE_SET, newLayer, type CanvasDocument, type Layer } from './document';
import { isValidLayerEffect } from './effects/validate';
import { makeTransform, type Rect } from './geometry';
import { uuid } from './ids';
import type { BlendMode, DocumentResource, LayerAdjustment, LayerEffect, LiveFilter } from './model/types';
import type { EditorSession } from './session';

export const RECIPE_FORMAT = 'fernwork-recipe';
export const RECIPE_VERSION = 1;
export const RECIPE_EXTENSION = 'fwrecipe';
export const RECIPE_MIME = 'application/vnd.fernwork.recipe+json';

/** The `.cube` bytes of a Colour Lookup step. */
export interface RecipeLut { readonly mime: string; readonly base64: string }

export type RecipeStep =
  | { readonly kind: 'filter'; readonly filter: LiveFilter }
  | { readonly kind: 'effect'; readonly effect: LayerEffect }
  | { readonly kind: 'adjustment'; readonly name: string; readonly adjustment: LayerAdjustment;
      readonly opacity: number; readonly blendMode: BlendMode; readonly lut?: RecipeLut };

/** Centred crop to this aspect ratio (width : height), before resizing. */
export interface RecipeCrop { readonly width: number; readonly height: number }
/** Output size: the long edge, the width or the height in pixels (the other side keeps the aspect ratio). */
export interface RecipeResize { readonly mode: 'longEdge' | 'width' | 'height'; readonly pixels: number }
/** Export As settings without targets (the export dialog's format, quality, sizes, metadata). */
export interface RecipeExportPreset {
  readonly format: 'png' | 'jpeg' | 'webp' | 'avif' | 'tiff';
  readonly quality?: number;
  readonly lossless?: boolean;
  readonly bitDepth?: 8 | 16;
  readonly transparent?: boolean;
  readonly matte?: { readonly red: number; readonly green: number; readonly blue: number };
  readonly sizes?: readonly ({ readonly scale: number } | { readonly width: number; readonly height?: number } | { readonly height: number; readonly width?: number })[];
  readonly metadata?: { readonly colorProfile?: 'embed' | 'strip'; readonly resolution?: boolean;
    readonly info?: { readonly copyright?: string; readonly artist?: string } | null };
}

export interface Recipe {
  readonly format: typeof RECIPE_FORMAT;
  readonly version: typeof RECIPE_VERSION;
  readonly id: string;
  readonly name: string;
  /** Rendering order: live filters, then the layer style, then the adjustment layers bottom to top. */
  readonly steps: readonly RecipeStep[];
  readonly crop: RecipeCrop | null;
  readonly resize: RecipeResize | null;
  readonly export: RecipeExportPreset | null;
}

export class RecipeError extends Error {
  constructor(message: string) { super(message); this.name = 'RecipeError'; }
}

// MARK: Base64 (LUT bytes)

function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}
function fromBase64(text: string): Uint8Array {
  const raw = atob(text), bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

// MARK: Capture

/** Layers that can receive a recipe: content layers (not folders, not adjustment layers). */
export function acceptsRecipe(layer: Layer): boolean {
  return layer.kind === 'pixel' || layer.kind === 'vector' || layer.kind === 'text' || layer.kind === 'embedded' || layer.kind === 'fill';
}
/** Layer styles render on these kinds (the Layer Style dialog's `styleable`); fill layers take no style. */
function acceptsStyle(layer: Layer): boolean { return layer.kind !== 'fill' && acceptsRecipe(layer); }

function siblingsOf(document: CanvasDocument, layer: Layer): Layer[] {
  return document.layers.filter((candidate) => candidate.parentId === layer.parentId);
}

/**
 * The layer a recipe is captured from: the layer itself, or for an adjustment layer the layer it corrects — its
 * clipping base, else the first content layer below it.
 */
export function recipeSourceLayer(document: CanvasDocument, id: string): Layer | null {
  const layer = document.layers.find((candidate) => candidate.id === id);
  if (!layer) return null;
  if (acceptsRecipe(layer)) return layer;
  if (layer.kind !== 'adjustment') return null;
  if (layer.maskSourceId) {
    const base = document.layers.find((candidate) => candidate.id === layer.maskSourceId);
    return base && acceptsRecipe(base) ? base : null;
  }
  const siblings = siblingsOf(document, layer);
  for (let index = siblings.indexOf(layer) - 1; index >= 0; index--) {
    const below = siblings[index]!;
    if (below.kind === 'adjustment') continue;
    return acceptsRecipe(below) ? below : null;
  }
  return null;
}

/** The visible adjustment layers directly above a layer (clipped to it or not), bottom to top. */
function adjustmentsAbove(document: CanvasDocument, base: Layer): Layer[] {
  const siblings = siblingsOf(document, base);
  const result: Layer[] = [];
  for (let index = siblings.indexOf(base) + 1; index < siblings.length; index++) {
    const layer = siblings[index]!;
    if (layer.kind !== 'adjustment' || (layer.maskSourceId !== null && layer.maskSourceId !== base.id)) break;
    if (layer.visible) result.push(layer);
  }
  return result;
}

/** Every step the layer (see `recipeSourceLayer`) contributes, in rendering order. */
export function captureRecipeSteps(document: CanvasDocument, id: string): RecipeStep[] {
  const base = recipeSourceLayer(document, id);
  if (!base) return [];
  const steps: RecipeStep[] = [
    ...base.filters.map((filter): RecipeStep => ({ kind: 'filter', filter: structuredClone(filter) })),
    ...base.effects.map((effect): RecipeStep => ({ kind: 'effect', effect: structuredClone(effect) })),
  ];
  for (const layer of adjustmentsAbove(document, base)) {
    const adjustment = layer.adjustment!;
    let lut: RecipeLut | undefined;
    if (adjustment.kind === 'Colour Lookup') {
      const resource = document.resources?.find((candidate) => candidate.id === adjustment.parameters.resourceId);
      if (!resource) continue;
      lut = { mime: resource.mime, base64: toBase64(resource.bytes) };
    }
    steps.push({ kind: 'adjustment', name: layer.name, adjustment: structuredClone(adjustment), opacity: layer.opacity,
      blendMode: layer.blendMode, ...(lut ? { lut } : {}) });
  }
  return steps;
}

export function createRecipe(name: string, steps: readonly RecipeStep[],
  output: { crop?: RecipeCrop | null; resize?: RecipeResize | null; export?: RecipeExportPreset | null } = {}, id = uuid()): Recipe {
  const recipe: Recipe = { format: RECIPE_FORMAT, version: RECIPE_VERSION, id, name: name.trim() || 'Recipe',
    steps: steps.map((step) => structuredClone(step)), crop: output.crop ?? null, resize: output.resize ?? null,
    export: output.export ?? null };
  validateRecipe(recipe);
  return recipe;
}

/** Captures a layer's steps as a new recipe; null when the layer has nothing to capture. */
export function captureRecipe(document: CanvasDocument, id: string, name: string): Recipe | null {
  const steps = captureRecipeSteps(document, id);
  return steps.length ? createRecipe(name, steps) : null;
}

/** Whether the recipe changes pixels of a layer (it has steps), as opposed to only output settings. */
export function recipeHasLayerSteps(recipe: Recipe): boolean { return recipe.steps.length > 0; }

// MARK: Apply

export interface RecipeApplication {
  readonly document: CanvasDocument;
  /** Layers the recipe was applied to. */
  readonly applied: readonly string[];
  /** New adjustment layers, per target. */
  readonly added: readonly string[];
  /** Targets left alone, with the reason (English, translated by the UI). */
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
}

/** Installs a LUT once per document: identical bytes reuse the existing resource. */
function lutResource(resources: DocumentResource[], lut: RecipeLut): string {
  const bytes = fromBase64(lut.base64);
  const same = resources.find((resource) => resource.role === 'lut' && resource.bytes.length === bytes.length
    && resource.bytes.every((value, index) => value === bytes[index]));
  if (same) return same.id;
  const id = uuid();
  resources.push({ id, role: 'lut', mime: lut.mime || 'application/x-cube', bytes });
  return id;
}

/**
 * Applies a recipe to layers of a document (pure; the session wrapper makes it one undo step):
 * - live filters are appended to the target's filter stack (after its own);
 * - a layer style replaces the target's style, as Paste Layer Style does;
 * - adjustment layers are added clipped to the target, on top of its clipping stack, so they correct only it.
 */
export function applyRecipeToLayers(document: CanvasDocument, ids: readonly string[], recipe: Recipe): RecipeApplication {
  validateRecipe(recipe);
  const filters = recipe.steps.flatMap((step) => (step.kind === 'filter' ? [step.filter] : []));
  const effects = recipe.steps.flatMap((step) => (step.kind === 'effect' ? [step.effect] : []));
  const adjustments = recipe.steps.flatMap((step) => (step.kind === 'adjustment' ? [step] : []));
  let layers = document.layers.slice();
  const resources = (document.resources ?? []).slice();
  const applied: string[] = [], added: string[] = [], skipped: { id: string; reason: string }[] = [];
  for (const id of ids) {
    const index = layers.findIndex((layer) => layer.id === id);
    const target = layers[index];
    if (!target) { skipped.push({ id, reason: 'The layer no longer exists.' }); continue; }
    if (!acceptsRecipe(target)) { skipped.push({ id, reason: 'Recipes apply to image, shape, text and embedded layers.' }); continue; }
    let next: Layer = target;
    if (filters.length) next = { ...next, filters: [...next.filters, ...filters.map((filter) => structuredClone(filter))] };
    if (effects.length && acceptsStyle(target)) next = { ...next, effects: effects.map((effect) => structuredClone(effect)) };
    layers[index] = next;
    if (adjustments.length) {
      // Above the target's existing clipping stack (contiguous siblings clipped to it).
      let at = index;
      for (let i = index + 1; i < layers.length; i++) {
        const layer = layers[i]!;
        if (layer.parentId !== target.parentId) continue;
        if (layer.maskSourceId !== target.id) break;
        at = i;
      }
      const created = adjustments.map((step) => {
        const adjustment: LayerAdjustment = step.adjustment.kind === 'Colour Lookup' && step.lut
          ? { ...step.adjustment, parameters: { ...step.adjustment.parameters, resourceId: lutResource(resources, step.lut) } }
          : structuredClone(step.adjustment);
        return newLayer({ id: uuid(), name: step.name, adjustment, opacity: step.opacity, blendMode: step.blendMode,
          parentId: target.parentId, maskSourceId: target.id,
          transform: makeTransform({ x: 0, y: 0 }, { width: document.width, height: document.height }) });
      });
      layers = [...layers.slice(0, at + 1), ...created, ...layers.slice(at + 1)];
      added.push(...created.map((layer) => layer.id));
    }
    applied.push(id);
  }
  const changed = applied.length > 0;
  return {
    document: changed ? { ...document, layers, ...(resources.length ? { resources } : {}) } : document,
    applied, added, skipped,
  };
}

/** Apply Recipe on layers of the open document: one undo step; locked layers are skipped (and reported). */
export function applyRecipeInSession(session: EditorSession, ids: readonly string[], recipe: Recipe): RecipeApplication | null {
  const document = session.document;
  if (!document || !session.canEditLayers) return null;
  const allowed = ids.filter((id) => !session.editBlocker(id, 'appearance'));
  const locked = ids.filter((id) => !allowed.includes(id)).map((id) => ({ id, reason: 'The layer is locked.' }));
  const result = applyRecipeToLayers(document, allowed, recipe);
  if (result.applied.length) {
    const active = session.activeLayerId;
    session.edit('Apply Recipe', () => {
      session.replaceDocument(result.document);
      session.setActiveLayer(active);
    });
  }
  return { ...result, skipped: [...locked, ...result.skipped] };
}

// MARK: Output steps (batch)

/** The centred rectangle of the canvas with the recipe's aspect ratio (whole pixels, at least 1 × 1). */
export function aspectCropRect(width: number, height: number, crop: RecipeCrop): Rect {
  const ratio = crop.width / crop.height;
  if (width / height > ratio) {
    const w = Math.max(1, Math.min(width, Math.round(height * ratio)));
    return { x: Math.floor((width - w) / 2), y: 0, width: w, height };
  }
  const h = Math.max(1, Math.min(height, Math.round(width / ratio)));
  return { x: 0, y: Math.floor((height - h) / 2), width, height: h };
}

/** Crops a document to the recipe's aspect ratio (unchanged when it already has it). */
export function cropToAspect(document: CanvasDocument, crop: RecipeCrop): CanvasDocument {
  const rect = aspectCropRect(document.width, document.height, crop);
  if (rect.width === document.width && rect.height === document.height) return document;
  return cropDocument(document, rect);
}

/** Output pixel size of a region under the recipe's resize step. */
export function resizedSize(width: number, height: number, resize: RecipeResize): { width: number; height: number } {
  const byWidth = resize.mode === 'width' || (resize.mode === 'longEdge' && width >= height);
  return byWidth
    ? { width: resize.pixels, height: Math.max(1, Math.round(height * resize.pixels / width)) }
    : { width: Math.max(1, Math.round(width * resize.pixels / height)), height: resize.pixels };
}

// MARK: Validation and files

function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

/** Live-filter records as the project reader accepts them. */
export function isValidLiveFilter(value: unknown): value is LiveFilter {
  const f = value as Record<string, unknown> | null;
  if (!isObject(f) || f.schemaVersion !== 1 || typeof f.enabled !== 'boolean') return false;
  switch (f.kind) {
    case 'gaussianBlur': case 'highPass': return finite(f.radius) && f.radius >= 0;
    case 'motionBlur': return finite(f.angle) && finite(f.distance) && f.distance >= 0;
    case 'noise': return finite(f.amount) && typeof f.gaussian === 'boolean' && typeof f.monochromatic === 'boolean';
    case 'lensCorrection': return finite(f.distortion);
    case 'unsharpMask': return finite(f.amount) && finite(f.radius) && finite(f.threshold);
    case 'smartSharpen': return finite(f.amount) && finite(f.radius) && finite(f.threshold) && finite(f.reduceNoise);
    case 'denoise': return finite(f.luminance) && finite(f.colour) && (f.detail === undefined || finite(f.detail));
    case 'vignette': {
      const color = f.color as Record<string, unknown> | null;
      return isObject(color) && [color.red, color.green, color.blue].every((v) => finite(v) && v >= 0 && v <= 1)
        && [f.amount, f.midpoint, f.roundness, f.feather, f.highlights].every(finite);
    }
    case 'bloom': return [f.threshold, f.radius, f.amount].every(finite);
    case 'tonalContrast': return [f.radius, f.amount, f.shadows, f.midtones, f.highlights].every(finite);
    case 'progressiveBlur': return [f.angle, f.start, f.end, f.radius].every(finite);
    case 'rgbSplit': return [f.distance, f.blur, f.angle].every(finite) && typeof f.radial === 'boolean';
    default: return false;
  }
}

function validStep(step: unknown): boolean {
  if (!isObject(step)) return false;
  if (step.kind === 'filter') return isValidLiveFilter(step.filter);
  if (step.kind === 'effect') return isValidLayerEffect(step.effect);
  if (step.kind !== 'adjustment') return false;
  const adjustment = step.adjustment as LayerAdjustment;
  if (typeof step.name !== 'string' || !isObject(adjustment) || !isValidAdjustment(adjustment)) return false;
  if (!finite(step.opacity) || step.opacity < 0 || step.opacity > 1 || typeof step.blendMode !== 'string' || !BLEND_MODE_SET.has(step.blendMode)) return false;
  if (adjustment.kind === 'Colour Lookup') {
    const lut = step.lut as RecipeLut | undefined;
    if (!isObject(lut) || typeof lut.base64 !== 'string' || typeof lut.mime !== 'string') return false;
  } else if (step.lut !== undefined) return false;
  return true;
}

function validPreset(value: unknown): boolean {
  if (!isObject(value) || !['png', 'jpeg', 'webp', 'avif', 'tiff'].includes(value.format as string)) return false;
  if (value.quality !== undefined && !(finite(value.quality) && value.quality >= 0 && value.quality <= 1)) return false;
  if (value.bitDepth !== undefined && value.bitDepth !== 8 && value.bitDepth !== 16) return false;
  if (value.sizes !== undefined && !(Array.isArray(value.sizes) && value.sizes.length > 0 && value.sizes.every((size: unknown) => isObject(size)
    && ('scale' in size ? finite(size.scale) && size.scale > 0 && size.scale <= 64
      : [size.width, size.height].every((n) => n === undefined || (Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 30_000))
        && (size.width !== undefined || size.height !== undefined))))) return false;
  for (const key of ['lossless', 'transparent'] as const) if (value[key] !== undefined && typeof value[key] !== 'boolean') return false;
  if (value.matte !== undefined) {
    const m = value.matte as Record<string, unknown>;
    if (!isObject(m) || ![m.red, m.green, m.blue].every((c) => finite(c) && c >= 0 && c <= 1)) return false;
  }
  if (value.metadata !== undefined && !isObject(value.metadata)) return false;
  return true;
}

/** Throws `RecipeError` when a recipe (typed or parsed) is not a valid version-1 recipe. */
export function validateRecipe(value: unknown): asserts value is Recipe {
  if (!isObject(value) || value.format !== RECIPE_FORMAT) throw new RecipeError('This file is not a Fernwork recipe.');
  if (value.version !== RECIPE_VERSION) throw new RecipeError('This recipe was saved by a newer version and cannot be used here.');
  if (typeof value.id !== 'string' || !value.id || typeof value.name !== 'string') throw new RecipeError('The recipe is damaged.');
  if (!Array.isArray(value.steps) || !value.steps.every(validStep)) throw new RecipeError('The recipe contains a step this version cannot use.');
  const crop = value.crop as Record<string, unknown> | null;
  if (crop !== null && !(isObject(crop) && finite(crop.width) && finite(crop.height) && crop.width > 0 && crop.height > 0)) {
    throw new RecipeError('The recipe is damaged.');
  }
  const resize = value.resize as Record<string, unknown> | null;
  if (resize !== null && !(isObject(resize) && ['longEdge', 'width', 'height'].includes(resize.mode as string)
    && Number.isInteger(resize.pixels) && (resize.pixels as number) >= 1 && (resize.pixels as number) <= 30_000)) {
    throw new RecipeError('The recipe is damaged.');
  }
  if (value.export !== null && !validPreset(value.export)) throw new RecipeError('The recipe is damaged.');
  if (!value.steps.length && crop === null && resize === null && value.export === null) throw new RecipeError('The recipe is empty.');
}

/** `.fwrecipe` bytes (pretty-printed JSON, stable key order). */
export function serializeRecipe(recipe: Recipe): string {
  validateRecipe(recipe);
  return `${JSON.stringify(recipe, null, 2)}\n`;
}

/** Reads a `.fwrecipe` file; a fresh id is given so an imported copy never replaces a library entry by accident. */
export function parseRecipe(text: string, freshId = true): Recipe {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new RecipeError('This file is not a Fernwork recipe.'); }
  validateRecipe(value);
  return freshId ? { ...value, id: uuid() } : value;
}

/** File name stem for exporting a recipe. */
export function recipeFileName(recipe: Recipe): string {
  // eslint-disable-next-line no-control-regex
  const stem = recipe.name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '-').trim() || 'Recipe';
  return `${stem}.${RECIPE_EXTENSION}`;
}
