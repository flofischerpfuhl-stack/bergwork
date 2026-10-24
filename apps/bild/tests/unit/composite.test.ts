import { describe, expect, it } from 'vitest';
import { bakeLiveMask, compositeRegion, flattenDocument, trimToAlpha, type AdjustmentApplier } from '../../src/core/composite';
import type { BlendMode, CanvasDocument, Layer, LayerAdjustment } from '../../src/core/document';
import { newLayer } from '../../src/core/document';
import { makeTransform, type LayerSampling, type LayerTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';

function rgba(width: number, height: number, pixels: readonly number[]): Raster {
  return Raster.fromPixels(width, height, 4, pixels);
}
function mask(width: number, height: number, pixels: readonly number[]): Raster {
  return Raster.fromPixels(width, height, 1, pixels);
}
function transform(x: number, y: number, width: number, height: number,
  sampling: LayerSampling = 'Nearest', extra: Partial<LayerTransform> = {}): LayerTransform {
  return makeTransform({ x, y }, { width, height }, { sampling, ...extra });
}
function layer(id: string, raster: Raster | null, t: LayerTransform,
  extra: Partial<Layer> & { isGroup?: boolean } = {}): Layer {
  const { isGroup, ...fields } = extra;
  const kind = isGroup ? 'group' : fields.adjustment ? 'adjustment' : 'pixel';
  return newLayer({ id, name: id, raster, transform: t, ...fields, kind });
}
function document(width: number, height: number, layers: readonly Layer[]): CanvasDocument {
  return { id: 'document', width, height, resolution: 72, layers, selection: null };
}
function render(doc: CanvasDocument, options = {}): Uint8Array {
  return compositeRegion(doc, { x: 0, y: 0, width: doc.width, height: doc.height }, options).rgba;
}
function alphas(bytes: Uint8Array): number[] {
  const result: number[] = [];
  for (let i = 3; i < bytes.length; i += 4) result.push(bytes[i]!);
  return result;
}

describe('blend modes (LayerAppearanceTests.blendModesAndOpacityMatchKnownPixels)', () => {
  const modes = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference',
    'colorDodge', 'colorBurn', 'hue', 'saturation', 'color', 'luminosity'] as const satisfies readonly BlendMode[];
  const expected: Record<(typeof modes)[number], readonly number[]> = {
    normal: [149, 85, 149, 192], multiply: [101, 75, 139, 192], screen: [155, 117, 181, 192],
    overlay: [117, 86, 171, 192], darken: [107, 85, 149, 192], lighten: [149, 107, 171, 192],
    difference: [128, 85, 128, 192], colorDodge: [171, 121, 192, 192], colorBurn: [86, 64, 150, 192],
    hue: [152, 87, 151, 192], saturation: [107, 107, 171, 192], color: [152, 87, 151, 192],
    luminosity: [104, 105, 169, 192],
  };

  it('upstream known pixels: 0.8 over 0.4 (LayerAppearanceTests.blendModesAndOpacityMatchKnownPixels)', () => {
    const cases: [BlendMode, number][] = [['normal', 0.8], ['multiply', 0.32], ['screen', 0.88], ['overlay', 0.64], ['darken', 0.4],
      ['lighten', 0.8], ['difference', 0.4], ['colorDodge', 1], ['colorBurn', 0.25]];
    for (const [mode, value] of cases) {
      const g = (v: number) => rgba(4, 4, Array.from({ length: 16 }, () => [v, v, v, 255]).flat());
      const back = layer('back', g(Math.round(0.4 * 255)), transform(0, 0, 4, 4));
      const top = layer('top', g(Math.round(0.8 * 255)), transform(0, 0, 4, 4), { blendMode: mode });
      const pixel = render(document(4, 4, [back, top]));
      expect(Math.abs(pixel[0]! / 255 - value), mode).toBeLessThan(0.02);
      expect(pixel[3]).toBe(255);
    }
  });

  for (const mode of modes) it(`${mode} matches the PDF/W3C formula over a translucent backdrop`, () => {
    const back = layer('back', rgba(1, 1, [64, 128, 192, 128]), transform(0, 0, 1, 1));
    const top = layer('top', rgba(1, 1, [192, 64, 128, 128]), transform(0, 0, 1, 1), { blendMode: mode });
    const actual = Array.from(render(document(1, 1, [back, top])));
    expect(actual).toEqual(expected[mode]);
  });

  it('applies layer opacity before source-over', () => {
    const doc = document(1, 1, [
      layer('black', rgba(1, 1, [0, 0, 0, 255]), transform(0, 0, 1, 1)),
      layer('white', rgba(1, 1, [255, 255, 255, 255]), transform(0, 0, 1, 1), { opacity: 0.5 }),
    ]);
    expect(Array.from(render(doc))).toEqual([128, 128, 128, 255]);
  });
});

describe('masks and hierarchy (LayerMaskTests, GroupTests)', () => {
  it('renders linked, disabled, and uniform 1x1 masks', () => {
    const red = layer('red', rgba(2, 1, [255, 0, 0, 255, 255, 0, 0, 255]), transform(0, 0, 2, 1), {
      mask: { raster: mask(2, 1, [255, 0]), enabled: true, placement: null, linked: true },
    });
    expect(alphas(render(document(2, 1, [red])))).toEqual([255, 0]);
    expect(alphas(render(document(2, 1, [{ ...red, mask: { ...red.mask!, enabled: false } }])))).toEqual([255, 255]);
    expect(alphas(render(document(2, 1, [{ ...red, mask: { ...red.mask!, raster: Raster.solidMask(false) } }])))).toEqual([0, 0]);
  });

  it('uses the placed mask edge majority as its background (MaskTransformTests)', () => {
    const red = layer('red', rgba(5, 1, new Array(5).fill([255, 0, 0, 255]).flat()),
      transform(0, 0, 5, 1), { mask: { raster: mask(1, 1, [255]), enabled: true,
        placement: transform(2, 0, 1, 1, 'High quality'), linked: false } });
    expect(alphas(render(document(5, 1, [red])))).toEqual([255, 255, 255, 255, 255]);
    const hidden = { ...red, mask: { ...red.mask!, raster: mask(3, 1, [0, 255, 0]),
      placement: transform(1, 0, 3, 1, 'High quality') } };
    expect(alphas(render(document(5, 1, [hidden])))).toEqual([0, 0, 255, 0, 0]);
  });

  it('folder masks clip outside their rectangle and hidden folders suppress descendants', () => {
    const folder = layer('folder', null, transform(1, 0, 1, 1), { isGroup: true,
      mask: { raster: Raster.solidMask(true), enabled: true, placement: null, linked: true } });
    const red = layer('red', rgba(3, 1, [255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]),
      transform(0, 0, 3, 1), { parentId: 'folder' });
    expect(alphas(render(document(3, 1, [folder, red])))).toEqual([0, 255, 0]);
    expect(alphas(render(document(3, 1, [{ ...folder, visible: false }, red])))).toEqual([0, 0, 0]);
  });

  it('uses a PSD folder mask default outside its stored rectangle', () => {
    const folder = layer('folder', null, transform(0, 0, 3, 1), { isGroup: true,
      mask: { raster: mask(1, 1, [0]), enabled: true, placement: transform(1, 0, 1, 1),
        linked: false, defaultColor: 255 } });
    const red = layer('red', rgba(3, 1, [255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]),
      transform(0, 0, 3, 1), { parentId: 'folder' });
    expect(alphas(render(document(3, 1, [folder, red])))).toEqual([255, 0, 255]);
  });

  it('multiplies folder and layer masks before isolated group opacity', () => {
    // PSD group semantics: the children form one isolated surface, then folder opacity is applied once.
    const folder = layer('folder', null, transform(0, 0, 1, 1), { isGroup: true, opacity: 0.5,
      mask: { raster: mask(1, 1, [128]), enabled: true, placement: null, linked: true } });
    const red = layer('red', rgba(1, 1, [255, 0, 0, 255]), transform(0, 0, 1, 1), { parentId: 'folder',
      mask: { raster: mask(1, 1, [128]), enabled: true, placement: null, linked: true } });
    expect(alphas(render(document(1, 1, [folder, red])))).toEqual([32]);
  });
});

describe('live masks (LiveMaskTests)', () => {
  it('a clipping stack keeps the base alpha and lets children blend onto its opaque colour', () => {
    const base = layer('base', rgba(2, 1, [128, 128, 128, 255, 128, 128, 128, 128]), transform(0, 0, 2, 1),
      { blendMode: 'normal' });
    const child = layer('child', rgba(2, 1, [255, 0, 0, 255, 255, 0, 0, 255]), transform(0, 0, 2, 1),
      { maskSourceId: 'base', blendMode: 'multiply' });
    const out = render(document(2, 1, [base, child]));
    expect(alphas(out)).toEqual([255, 128]);
    expect(Array.from(out)).toEqual([128, 0, 0, 255, 128, 0, 0, 128]);
  });

  it('applies the base blend mode to the completed stack', () => {
    const background = layer('background', rgba(1, 1, [0, 255, 0, 255]), transform(0, 0, 1, 1));
    const base = layer('base', rgba(1, 1, [255, 255, 255, 255]), transform(0, 0, 1, 1), { blendMode: 'multiply' });
    const child = layer('child', rgba(1, 1, [255, 0, 0, 255]), transform(0, 0, 1, 1), { maskSourceId: 'base' });
    expect(Array.from(render(document(1, 1, [background, base, child])))).toEqual([0, 0, 0, 255]);
  });

  it('a hidden source still supplies recursive live alpha', () => {
    const target = layer('target', rgba(2, 1, [255, 255, 255, 255, 255, 255, 255, 255]), transform(0, 0, 2, 1),
      { maskSourceId: 'source' });
    const source = layer('source', rgba(2, 1, [0, 0, 0, 255, 0, 0, 0, 64]), transform(0, 0, 2, 1), { visible: false });
    expect(alphas(render(document(2, 1, [target, source])))).toEqual([255, 64]);
  });

  it('uses the complete live group surface as a clipping base', () => {
    const group = layer('group', null, transform(0, 0, 2, 1), { isGroup: true });
    const left = layer('left', rgba(2, 1, [255, 0, 0, 255, 0, 0, 0, 0]), transform(0, 0, 2, 1),
      { parentId: group.id });
    const right = layer('right', rgba(2, 1, [0, 0, 0, 0, 0, 0, 255, 255]), transform(0, 0, 2, 1),
      { parentId: group.id });
    const clipped = layer('clipped', rgba(2, 1, [0, 255, 0, 255, 0, 255, 0, 255]), transform(0, 0, 2, 1),
      { maskSourceId: group.id });
    expect(Array.from(render(document(2, 1, [group, left, right, clipped]))))
      .toEqual([0, 255, 0, 255, 0, 255, 0, 255]);
  });

  it('keeps sole-child stack blending when the clipped sibling has no paint', () => {
    const background = layer('background', rgba(1, 1, [255, 255, 255, 128]), transform(0, 0, 1, 1));
    const group = layer('group', null, transform(0, 0, 1, 1), { isGroup: true });
    const base = layer('base', rgba(1, 1, [255, 0, 0, 128]), transform(0, 0, 1, 1),
      { parentId: group.id, blendMode: 'linearDodge' });
    const empty = layer('empty', null, transform(0, 0, 1, 1), { maskSourceId: group.id });
    expect(Array.from(render(document(1, 1, [background, group, base, empty])))).toEqual([255, 170, 170, 192]);
  });

  it('uses a masked adjustment-only group as a clipping base', () => {
    const inverse: LayerAdjustment = { kind: 'Invert', schemaVersion: 1, parameters: {} };
    const applyInverse: AdjustmentApplier = (_settings, input) => {
      const output = input.slice();
      for (let offset = 0; offset < output.length; offset += 4) for (let channel = 0; channel < 3; channel++) {
        output[offset + channel] = 1 - output[offset + channel]!;
      }
      return output;
    };
    const background = layer('background', rgba(2, 1, [255, 0, 0, 255, 255, 0, 0, 255]), transform(0, 0, 2, 1));
    const group = layer('group', null, transform(0, 0, 2, 1), { isGroup: true,
      mask: { raster: mask(2, 1, [255, 0]), enabled: true, placement: null, linked: true } });
    const change = layer('adjust', null, transform(0, 0, 2, 1), { parentId: group.id, adjustment: inverse });
    const clipped = layer('clipped', rgba(2, 1, [0, 0, 255, 255, 0, 0, 255, 255]), transform(0, 0, 2, 1),
      { maskSourceId: group.id });
    expect(Array.from(render(document(2, 1, [background, group, change, clipped]), { adjust: applyInverse })))
      .toEqual([0, 0, 255, 255, 255, 0, 0, 255]);
  });

  it('multiplies a hidden source opacity and raster mask into live coverage', () => {
    const target = layer('target', rgba(2, 1, [255, 255, 255, 255, 255, 255, 255, 255]), transform(0, 0, 2, 1),
      { maskSourceId: 'source' });
    const source = layer('source', rgba(2, 1, [0, 0, 0, 255, 0, 0, 0, 128]), transform(0, 0, 2, 1), {
      visible: false, opacity: 0.5,
      mask: { raster: mask(2, 1, [128, 255]), enabled: true, placement: null, linked: true },
    });
    expect(alphas(render(document(2, 1, [target, source])))).toEqual([64, 64]);
  });

  it('bakes only the live dependency into target pixels', () => {
    const target = layer('target', rgba(2, 1, [10, 20, 30, 255, 40, 50, 60, 128]), transform(0, 0, 2, 1),
      { maskSourceId: 'source', opacity: 0.25, mask: { raster: Raster.solidMask(false), enabled: true, placement: null, linked: true } });
    const source = layer('source', rgba(2, 1, [0, 0, 0, 255, 0, 0, 0, 128]), transform(0, 0, 2, 1), { visible: false });
    const baked = bakeLiveMask(document(2, 1, [target, source]), 'target')!;
    expect(baked.toPixels()).toEqual(new Uint8Array([10, 20, 30, 255, 40, 50, 60, 64]));
  });

  it('treats cyclic live dependencies as no coverage', () => {
    const pixel = rgba(1, 1, [200, 100, 50, 255]);
    const a = layer('a', pixel, transform(0, 0, 1, 1), { maskSourceId: 'b' });
    const b = layer('b', pixel, transform(0, 0, 1, 1), { maskSourceId: 'a', visible: false });
    expect(alphas(render(document(1, 1, [a, b])))).toEqual([0]);
  });
});

describe('adjustment surface (AdjustmentLayerTests)', () => {
  const adjustment: LayerAdjustment = { kind: 'Curves', schemaVersion: 1,
    parameters: { channel: 'RGB', channels: Array.from({ length: 4 }, () => [{ x: 0, y: 0 }, { x: 255, y: 255 }]) } };
  const invert: AdjustmentApplier = (_settings, input) => {
    const result = input.slice();
    for (let i = 0; i < result.length; i += 4) {
      result[i] = 1 - result[i]!; result[i + 1] = 1 - result[i + 1]!; result[i + 2] = 1 - result[i + 2]!;
    }
    return result;
  };

  it('reports a skipped default adjustment and accepts an identity applier', () => {
    const base = layer('base', rgba(1, 1, [255, 0, 0, 255]), transform(0, 0, 1, 1));
    const change = layer('adjust', null, transform(0, 0, 1, 1), { adjustment });
    const doc = document(1, 1, [base, change]);
    expect(compositeRegion(doc, { x: 0, y: 0, width: 1, height: 1 })).toEqual({
      rgba: new Uint8Array([255, 0, 0, 255]), adjustmentsApplied: false,
    });
    const result = compositeRegion(doc, { x: 0, y: 0, width: 1, height: 1 }, { adjust: (_a, input) => input });
    expect(result.adjustmentsApplied).toBe(true);
    expect(result.rgba).toEqual(new Uint8Array([255, 0, 0, 255]));
  });

  it('applies adjustment opacity as an sRGB lerp and copies through its mask', () => {
    const base = layer('base', rgba(2, 1, [255, 0, 0, 255, 255, 0, 0, 255]), transform(0, 0, 2, 1));
    const change = layer('adjust', null, transform(0, 0, 2, 1), { adjustment, opacity: 0.5,
      mask: { raster: mask(2, 1, [255, 0]), enabled: true, placement: null, linked: true } });
    expect(Array.from(render(document(2, 1, [base, change]), { adjust: invert })))
      .toEqual([128, 128, 128, 255, 255, 0, 0, 255]);
  });

  it('uses the adjustment blend mode at full coverage and skips linked adjustments outside stacks', () => {
    const base = layer('base', rgba(1, 1, [255, 0, 0, 255]), transform(0, 0, 1, 1));
    const multiply = layer('adjust', null, transform(0, 0, 1, 1), { adjustment, blendMode: 'multiply' });
    expect(Array.from(render(document(1, 1, [base, multiply]), { adjust: invert }))).toEqual([0, 0, 0, 255]);
    const separator = layer('separator', null, transform(0, 0, 1, 1));
    expect(Array.from(render(document(1, 1, [base, separator, { ...multiply, maskSourceId: 'base' }]), { adjust: invert })))
      .toEqual([255, 0, 0, 255]);
  });

  it('runs a clipped adjustment inside a stack and applies only the base folder clip', () => {
    const folder = layer('folder', null, transform(0, 0, 1, 1), { isGroup: true,
      mask: { raster: Raster.solidMask(true), enabled: true, placement: null, linked: true } });
    const base = layer('base', rgba(2, 1, [255, 0, 0, 255, 255, 0, 0, 255]), transform(0, 0, 2, 1),
      { parentId: 'folder' });
    const change = layer('adjust', null, transform(0, 0, 2, 1),
      { parentId: 'folder', adjustment, maskSourceId: 'base' });
    expect(Array.from(render(document(2, 1, [folder, base, change]), { adjust: invert })))
      .toEqual([0, 255, 255, 255, 0, 0, 0, 0]);
  });

  it('evaluates pass-through adjustments against the entry backdrop before group opacity', () => {
    const background = layer('background', rgba(1, 1, [200, 200, 200, 255]), transform(0, 0, 1, 1));
    const group = { ...layer('group', null, transform(0, 0, 1, 1), { isGroup: true, opacity: 0.5 }),
      psdIsolated: false };
    const change = layer('adjust', null, transform(0, 0, 1, 1), { parentId: group.id, adjustment });
    expect(Array.from(render(document(1, 1, [background, group, change]), { adjust: invert })))
      .toEqual([128, 128, 128, 255]);
  });

  it('treats an adjustment clipping base as full-canvas coverage', () => {
    const base = layer('base', rgba(1, 1, [255, 0, 0, 255]), transform(0, 0, 1, 1));
    const first = layer('first', null, transform(0, 0, 1, 1), { adjustment });
    const clipped = layer('clipped', null, transform(0, 0, 1, 1), { adjustment, maskSourceId: first.id });
    expect(Array.from(render(document(1, 1, [base, first, clipped]), { adjust: invert })))
      .toEqual([255, 0, 0, 255]);
  });
});

describe('sampling, transforms, and output (ExportTests, DownsampleTests)', () => {
  it('distinguishes nearest from premultiplied bilinear sampling', () => {
    const source = rgba(2, 1, [0, 0, 0, 255, 255, 255, 255, 255]);
    const nearest = layer('source', source, transform(0, 0, 4, 1));
    const smooth = { ...nearest, transform: transform(0, 0, 4, 1, 'Smooth') };
    expect(Array.from(render(document(4, 1, [nearest])).filter((_v, i) => i % 4 === 0))).toEqual([0, 0, 255, 255]);
    expect(Array.from(render(document(4, 1, [smooth])).filter((_v, i) => i % 4 === 0))).toEqual([0, 64, 191, 255]);
  });

  it('box-filtered halving removes fine-stripe shimmer', () => {
    const pixels: number[] = [];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      pixels.push(x % 2 ? 255 : 0, x % 2 ? 255 : 0, x % 2 ? 255 : 0, 255);
    }
    const tiny = layer('stripes', rgba(8, 8, pixels), transform(0, 0, 1, 1, 'High quality'));
    expect(Array.from(render(document(1, 1, [tiny])))).toEqual([128, 128, 128, 255]);
  });

  it('places rotation and flips like ExportTests.pngPreservesDimensionsAlphaOrientationAndTransforms', () => {
    const source = rgba(2, 2, [255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0]);
    const flipped = layer('flip', source, transform(1, 1, 4, 4, 'Nearest', { flipX: true }));
    const fp = render(document(6, 6, [flipped]));
    expect(fp[(1 * 6 + 4) * 4]).toBe(255);
    expect(fp[(1 * 6 + 1) * 4 + 3]).toBe(0);
    const rotated = { ...flipped, transform: transform(1, 1, 4, 4, 'Nearest', { rotation: 90 }) };
    const rp = render(document(6, 6, [rotated]));
    expect(rp[(1 * 6 + 1) * 4]).toBe(255);
    expect(rp[(4 * 6 + 1) * 4 + 3]).toBe(0);
  });

  it('antialiases fractional rectangle edges by signed distance', () => {
    const white = layer('white', rgba(1, 1, [255, 255, 255, 255]), transform(0.25, 0, 1, 1, 'Smooth'));
    expect(alphas(render(document(2, 1, [white])))).toEqual([191, 64]);
  });

  it('flattens and trims exact document pixels', () => {
    const dot = layer('dot', rgba(1, 1, [7, 8, 9, 255]), transform(1, 1, 1, 1));
    const flat = flattenDocument(document(3, 3, [dot]));
    expect(flat.pixel(1, 1)).toEqual([7, 8, 9, 255]);
    const trimmed = trimToAlpha(flat)!;
    expect({ x: trimmed.x, y: trimmed.y, width: trimmed.raster.width, height: trimmed.raster.height })
      .toEqual({ x: 1, y: 1, width: 1, height: 1 });
    expect(trimToAlpha(Raster.blank(2, 2, 4))).toBeNull();
  });

  it('uses transform, mask-placement, and blend preview hooks without mutating the document', () => {
    const back = layer('back', rgba(2, 1, [0, 255, 0, 255, 0, 255, 0, 255]), transform(0, 0, 2, 1));
    const top = layer('top', rgba(1, 1, [255, 0, 0, 255]), transform(0, 0, 1, 1), {
      mask: { raster: Raster.solidMask(true), enabled: true, placement: null, linked: false },
    });
    const output = render(document(2, 1, [back, top]), {
      transform: (candidate: Layer) => candidate.id === 'top' ? transform(1, 0, 1, 1) : candidate.transform,
      maskPlacement: (candidate: Layer) => candidate.id === 'top' ? transform(1, 0, 1, 1) : candidate.mask?.placement ?? null,
      blendMode: (candidate: Layer) => candidate.id === 'top' ? 'multiply' as const : candidate.blendMode,
    });
    expect(Array.from(output)).toEqual([0, 255, 0, 255, 0, 0, 0, 255]);
    expect(top.transform.origin.x).toBe(0);
  });
});
