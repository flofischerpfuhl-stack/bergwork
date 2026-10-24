import { describe, expect, it } from 'vitest';
import { newLayer, type CanvasDocument, type Layer, type LayerAdjustment } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import { defaultHueSaturation, defaultLevels } from '../../src/core/adjustments';
import {
  applyRecipeInSession, applyRecipeToLayers, aspectCropRect, captureRecipe, captureRecipeSteps, cropToAspect, parseRecipe,
  recipeSourceLayer, resizedSize, RecipeError, serializeRecipe, type Recipe,
} from '../../src/core/recipes';
import { cpuExportRenderer, planExport, renderExportItem, type ExportRequest, type ExportTarget } from '../../src/io/exportPipeline';

const renderer = cpuExportRenderer();

/** A 40 × 30 photo-like gradient with some texture, opaque. */
function photo(seed = 0): Raster {
  const data = new Uint8Array(40 * 30 * 4);
  for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) {
    const o = (y * 40 + x) * 4, n = ((x * 7919 + y * 104729 + seed) % 23) * 3;
    data.set([Math.min(255, 40 + x * 4 + n), Math.min(255, 30 + y * 5), (x * y + seed) & 255, 255], o);
  }
  return Raster.fromPixels(40, 30, 4, data);
}
const pixelLayer = (id: string, raster: Raster, x: number, y: number, extra: Partial<Parameters<typeof newLayer>[0]> = {}): Layer =>
  newLayer({ id, name: id, raster, transform: makeTransform({ x, y }, { width: raster.width, height: raster.height }), ...extra });
const adjustmentLayer = (id: string, adjustment: LayerAdjustment, extra: Partial<Parameters<typeof newLayer>[0]> = {}): Layer =>
  newLayer({ id, name: id, adjustment, transform: makeTransform({ x: 0, y: 0 }, { width: 60, height: 50 }), ...extra });

const levels = (white: number): LayerAdjustment => {
  const settings = defaultLevels();
  return { kind: 'Levels', schemaVersion: 1, parameters: { ...settings, ranges: settings.ranges.map((range, i) => (i === 0 ? { ...range, white } : range)) } };
};
const hue: LayerAdjustment = { kind: 'Hue/Saturation', schemaVersion: 1,
  parameters: { hue: 30, saturation: -20, lightness: 0, colorize: false, settings: defaultHueSaturation(30, -20, 0) } };

/** A 2 × 2 × 2 cube that swaps red and blue. */
const SWAP_CUBE = ['LUT_3D_SIZE 2', '0 0 0', '0 0 1', '0 1 0', '0 1 1', '1 0 0', '1 0 1', '1 1 0', '1 1 1'].join('\n');

/** Source: the photo with a live blur, a drop shadow + stroke, and clipped Levels (80 %) and Hue/Saturation above. */
function sourceDocument(): CanvasDocument {
  return {
    id: 'source', width: 60, height: 50, resolution: 72, selection: null, artboards: [],
    layers: [
      pixelLayer('photo', photo(), 10, 10, {
        filters: [{ kind: 'gaussianBlur', schemaVersion: 1, enabled: true, radius: 1.5 }],
        effects: [
          { kind: 'dropShadow', schemaVersion: 1, enabled: true, opacity: 0.6, angle: 120, distance: 3, blur: 2, color: { red: 0, green: 0, blue: 0 } },
          { kind: 'stroke', schemaVersion: 1, enabled: true, width: 2, position: 'outside', color: { red: 1, green: 0.8, blue: 0 } },
        ],
      }),
      adjustmentLayer('levels', levels(170), { maskSourceId: 'photo', opacity: 0.8 }),
      adjustmentLayer('hue', hue, { maskSourceId: 'photo' }),
    ],
  };
}

/** Target: a different layer below, and the same photo pixels in a layer of its own. */
function targetDocument(): CanvasDocument {
  const back = Raster.fromPixels(60, 50, 4, new Uint8Array(60 * 50 * 4).fill(200));
  return {
    id: 'target', width: 60, height: 50, resolution: 72, selection: null, artboards: [],
    layers: [pixelLayer('background', back, 0, 0), pixelLayer('other', photo(), 10, 10)],
  };
}

function render(document: CanvasDocument, target: ExportTarget): Uint8Array {
  const request: ExportRequest = { targets: [target], format: 'png' };
  const [item] = planExport(document, request);
  return renderExportItem(document, item!, request, renderer) as Uint8Array;
}

function differing(a: Uint8Array, b: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) count++;
  return count;
}

describe('recipes (PRODUCT-PLAN 6.9)', () => {
  it('captures filters, style and the adjustment layers above a layer in rendering order', () => {
    const document = sourceDocument();
    const steps = captureRecipeSteps(document, 'photo');
    expect(steps.map((step) => step.kind)).toEqual(['filter', 'effect', 'effect', 'adjustment', 'adjustment']);
    expect(steps.flatMap((step) => (step.kind === 'adjustment' ? [[step.name, step.adjustment.kind, step.opacity]] : [])))
      .toEqual([['levels', 'Levels', 0.8], ['hue', 'Hue/Saturation', 1]]);
    // From an adjustment layer, the layer it corrects is the source.
    expect(recipeSourceLayer(document, 'levels')?.id).toBe('photo');
    expect(recipeSourceLayer(document, 'hue')?.id).toBe('photo');
    // Unclipped adjustment layers directly above count too (they correct the layer as it is seen).
    const unclipped = { ...document, layers: document.layers.map((l) => (l.id === 'hue' ? { ...l, maskSourceId: null } : l)) };
    expect(captureRecipeSteps(unclipped, 'photo').filter((s) => s.kind === 'adjustment')).toHaveLength(2);
    expect(recipeSourceLayer(unclipped, 'hue')?.id).toBe('photo');
    // Hidden adjustment layers do not contribute to the rendering, so they are not captured.
    const hidden = { ...document, layers: document.layers.map((l) => (l.id === 'hue' ? { ...l, visible: false } : l)) };
    expect(captureRecipeSteps(hidden, 'photo').filter((s) => s.kind === 'adjustment')).toHaveLength(1);
  });

  it('applied to another layer, renders that layer exactly like the source layer', () => {
    const source = sourceDocument();
    const recipe = captureRecipe(source, 'photo', 'Wedding')!;
    const target = targetDocument();
    const before = render(target, { kind: 'layer', id: 'other' });
    const applied = applyRecipeToLayers(target, ['other'], recipe);
    expect(applied.applied).toEqual(['other']);
    expect(applied.added).toHaveLength(2);
    const result = applied.document;
    // The adjustments are clipped to the target, directly above it, bottom to top.
    expect(result.layers.map((l) => [l.kind, l.maskSourceId])).toEqual([
      ['pixel', null], ['pixel', null], ['adjustment', 'other'], ['adjustment', 'other']]);
    const expected = render(source, { kind: 'layer', id: 'photo' });
    const actual = render(result, { kind: 'layer', id: 'other' });
    expect(actual.length).toBe(expected.length);
    expect(differing(actual, expected)).toBe(0);
    // Each step matters: without the Hue/Saturation step the result differs.
    const withoutHue = applyRecipeToLayers(target, ['other'], { ...recipe, steps: recipe.steps.slice(0, -1) }).document;
    expect(differing(render(withoutHue, { kind: 'layer', id: 'other' }), expected)).toBeGreaterThan(500);
    // The recipe did change the pixels, and the layer below is untouched by the clipped adjustments.
    expect(differing(before, actual)).toBeGreaterThan(1000);
    expect(render(result, { kind: 'layer', id: 'background' })).toEqual(render(target, { kind: 'layer', id: 'background' }));
  });

  it('carries Colour Lookup tables in the recipe and installs them once in the target', () => {
    const lut = new TextEncoder().encode(SWAP_CUBE);
    const lookup: LayerAdjustment = { kind: 'Colour Lookup', schemaVersion: 1, parameters: { resourceId: 'lut-1', interpolation: 'tetrahedral' } };
    const source: CanvasDocument = { ...sourceDocument(), resources: [{ id: 'lut-1', role: 'lut', mime: 'application/x-cube', bytes: lut }],
      layers: [pixelLayer('photo', photo(), 10, 10), adjustmentLayer('lookup', lookup, { maskSourceId: 'photo' })] };
    const recipe = parseRecipe(serializeRecipe(captureRecipe(source, 'photo', 'Swap')!));
    const target = targetDocument();
    const once = applyRecipeToLayers(target, ['other', 'background'], recipe).document;
    expect(once.resources?.filter((r) => r.role === 'lut')).toHaveLength(1);
    expect([...once.resources![0]!.bytes]).toEqual([...lut]);
    const expected = render(source, { kind: 'layer', id: 'photo' });
    expect(differing(render(once, { kind: 'layer', id: 'other' }), expected)).toBe(0);
    // Red and blue really swapped (the table is not a no-op).
    const plain = render(targetDocument(), { kind: 'layer', id: 'other' });
    expect([expected[0], expected[2]]).toEqual([plain[2], plain[0]]);
  });

  it('round-trips as a versioned .fwrecipe and rejects what it cannot use', () => {
    const recipe = captureRecipe(sourceDocument(), 'photo', 'Serie')!;
    const withOutput: Recipe = { ...recipe, crop: { width: 4, height: 5 }, resize: { mode: 'longEdge', pixels: 2048 },
      export: { format: 'jpeg', quality: 0.9, sizes: [{ scale: 1 }] } };
    const text = serializeRecipe(withOutput);
    const back = parseRecipe(text, false);
    expect(back).toEqual(withOutput);
    expect(parseRecipe(text).id).not.toBe(withOutput.id);
    expect(JSON.parse(text)).toMatchObject({ format: 'fernwork-recipe', version: 1 });
    expect(() => parseRecipe('{')).toThrow(RecipeError);
    expect(() => parseRecipe(JSON.stringify({ ...withOutput, version: 2 }))).toThrow(/newer version/);
    const badStep = { ...withOutput, steps: [{ kind: 'filter', filter: { kind: 'gaussianBlur', schemaVersion: 1, enabled: true, radius: 'x' } }] };
    expect(() => parseRecipe(JSON.stringify(badStep))).toThrow(/step/);
    const badLevels = { ...withOutput, steps: [{ kind: 'adjustment', name: 'L', opacity: 1, blendMode: 'normal',
      adjustment: { kind: 'Levels', schemaVersion: 1, parameters: { channel: 'RGB', ranges: [] } } }] };
    expect(() => parseRecipe(JSON.stringify(badLevels))).toThrow(RecipeError);
    expect(() => parseRecipe(JSON.stringify({ ...withOutput, steps: [], crop: null, resize: null, export: null }))).toThrow(/empty/);
  });

  it('applies to the selected layers as one undo step and skips locked layers', () => {
    const recipe = captureRecipe(sourceDocument(), 'photo', 'R')!;
    const session = new EditorSession();
    session.installProject(targetDocument(), 'other', 'Target');
    session.setLayerLocks(['background'], { all: true });
    const undoBefore = session.history.undoCount;
    const before = session.document!;
    const result = applyRecipeInSession(session, ['other', 'background'], recipe)!;
    expect(result.applied).toEqual(['other']);
    expect(result.skipped).toEqual([{ id: 'background', reason: 'The layer is locked.' }]);
    expect(session.history.undoCount).toBe(undoBefore + 1);
    expect(session.history.undoName).toBe('Apply Recipe');
    expect(session.activeLayerId).toBe('other');
    expect(session.layer('other')!.filters).toHaveLength(1);
    expect(session.document!.layers).toHaveLength(4);
    session.undo();
    expect(session.document!.layers.map((l) => l.id)).toEqual(before.layers.map((l) => l.id));
    expect(session.layer('other')!.filters).toHaveLength(0);
  });

  it('keeps filters of the target, replaces its style, and stacks adjustments on top of its clipping group', () => {
    const recipe = captureRecipe(sourceDocument(), 'photo', 'R')!;
    const own = { kind: 'noise', schemaVersion: 1, enabled: true, amount: 5, gaussian: false, monochromatic: true } as const;
    const target: CanvasDocument = { ...targetDocument(), layers: [
      ...targetDocument().layers.map((l) => (l.id === 'other' ? { ...l, filters: [own],
        effects: [{ kind: 'colorOverlay', schemaVersion: 1, enabled: true, opacity: 1, color: { red: 0, green: 1, blue: 0 } }] } as Layer : l)),
      adjustmentLayer('existing', levels(200), { maskSourceId: 'other' }),
    ] };
    const result = applyRecipeToLayers(target, ['other'], recipe).document;
    const other = result.layers.find((l) => l.id === 'other')!;
    expect(other.filters.map((f) => f.kind)).toEqual(['noise', 'gaussianBlur']);
    expect(other.effects.map((e) => e.kind)).toEqual(['dropShadow', 'stroke']);
    expect(result.layers.map((l) => l.id).slice(0, 3)).toEqual(['background', 'other', 'existing']);
    expect(result.layers.slice(3).every((l) => l.kind === 'adjustment' && l.maskSourceId === 'other')).toBe(true);
    // Folders and adjustment layers do not take recipes.
    expect(applyRecipeToLayers(target, ['existing'], recipe).skipped[0]?.reason).toMatch(/Recipes apply/);
  });

  it('crops to an aspect ratio around the centre and computes resized sizes', () => {
    expect(aspectCropRect(60, 50, { width: 1, height: 1 })).toEqual({ x: 5, y: 0, width: 50, height: 50 });
    expect(aspectCropRect(40, 80, { width: 4, height: 5 })).toEqual({ x: 0, y: 15, width: 40, height: 50 });
    const cropped = cropToAspect(targetDocument(), { width: 1, height: 1 });
    expect([cropped.width, cropped.height]).toEqual([50, 50]);
    expect(cropped.layers.find((l) => l.id === 'other')!.transform.origin).toEqual({ x: 5, y: 10 });
    expect(resizedSize(4000, 3000, { mode: 'longEdge', pixels: 2000 })).toEqual({ width: 2000, height: 1500 });
    expect(resizedSize(3000, 4000, { mode: 'longEdge', pixels: 2000 })).toEqual({ width: 1500, height: 2000 });
    expect(resizedSize(3000, 4000, { mode: 'width', pixels: 300 })).toEqual({ width: 300, height: 400 });
    expect(resizedSize(3000, 4000, { mode: 'height', pixels: 100 })).toEqual({ width: 75, height: 100 });
  });
});
