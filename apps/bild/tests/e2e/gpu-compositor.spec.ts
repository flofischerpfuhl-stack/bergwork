import { expect, test } from '@playwright/test';

/**
 * Pixel checks of the WebGL2 compositor in a real browser: orientation, straight-alpha readback,
 * blend formulas, masks, folder masks, clipping stacks and live masks (LiveMaskRenderer semantics).
 */
test('GPU compositor reproduces upstream compositing semantics', async ({ page }) => {
  await page.goto('/?harness=gpu');
  const results = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { GpuCompositor } = await load('/src/render/gpuCompositor.ts');
    const { Raster } = await load('/src/core/raster.ts');
    const { newLayer } = await load('/src/core/document.ts');
    const { makeTransform } = await load('/src/core/geometry.ts');
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const gpu = await GpuCompositor.create(canvas, 4, 4);
    let n = 0;
    const layer = (pixels: number[], width: number, height: number, extra: Record<string, unknown> = {}) =>
      newLayer({ id: `L${n++}`, name: 'l', raster: Raster.fromPixels(width, height, 4, pixels),
        transform: makeTransform({ x: 0, y: 0 }, { width, height }), ...extra });
    const doc = (width: number, height: number, layers: unknown[]) =>
      ({ id: 'd', width, height, resolution: 72, layers, selection: null }) as never;
    const read = (d: never, w: number, h: number): number[] => Array.from(gpu.readRegion(d, 0, 0, w, h) as Uint8Array);
    const out: Record<string, number[]> = {};
    out.orientation = read(doc(2, 2, [layer([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255], 2, 2)]), 2, 2);
    out.translucent = read(doc(1, 1, [layer([200, 100, 50, 128], 1, 1)]), 1, 1);
    out.multiply = read(doc(1, 1, [layer([200, 100, 50, 255], 1, 1), layer([128, 128, 255, 255], 1, 1, { blendMode: 'multiply' })]), 1, 1);
    out.screenHalf = read(doc(1, 1, [layer([100, 100, 100, 255], 1, 1), layer([200, 0, 0, 128], 1, 1, { blendMode: 'screen' })]), 1, 1);
    out.opacity = read(doc(1, 1, [layer([0, 0, 0, 255], 1, 1), layer([255, 255, 255, 255], 1, 1, { opacity: 0.5 })]), 1, 1);
    out.mask = read(doc(2, 1, [layer([255, 0, 0, 255, 255, 0, 0, 255], 2, 1, {
      mask: { raster: Raster.fromPixels(2, 1, 1, [255, 0]), enabled: true, placement: null, linked: true } })]), 2, 1);
    out.disabledMask = read(doc(2, 1, [layer([255, 0, 0, 255, 255, 0, 0, 255], 2, 1, {
      mask: { raster: Raster.fromPixels(2, 1, 1, [255, 0]), enabled: false, placement: null, linked: true } })]), 2, 1);
    const base = layer([255, 0, 0, 255, 0, 0, 0, 0], 2, 1);
    out.clippingStack = read(doc(2, 1, [base, layer([0, 0, 255, 255, 0, 0, 255, 255], 2, 1, { maskSourceId: base.id })]), 2, 1);
    const hiddenBase = layer([255, 0, 0, 255, 0, 0, 0, 0], 2, 1, { visible: false });
    out.liveMaskHiddenBase = read(doc(2, 1, [hiddenBase, layer([0, 255, 0, 255, 0, 255, 0, 255], 2, 1, { maskSourceId: hiddenBase.id })]), 2, 1);
    const folder = newLayer({ id: 'F', name: 'f', isGroup: true, transform: makeTransform({ x: 0, y: 0 }, { width: 2, height: 1 }),
      mask: { raster: Raster.fromPixels(2, 1, 1, [0, 255]), enabled: true, placement: null, linked: true } });
    out.folderMask = read(doc(2, 1, [folder, layer([9, 9, 9, 255, 9, 9, 9, 255], 2, 1, { parentId: 'F' })]), 2, 1);
    out.rotated = read(doc(1, 2, [newLayer({ id: 'R', name: 'r', raster: Raster.fromPixels(2, 1, 4, [255, 0, 0, 255, 0, 0, 255, 255]),
      transform: makeTransform({ x: -0.5, y: 0.5 }, { width: 2, height: 1 }, { rotation: 90, sampling: 'Nearest' }) })]), 1, 2);
    out.dodge = read(doc(1, 1, [layer([128, 128, 128, 255], 1, 1), layer([128, 128, 128, 255], 1, 1, { blendMode: 'colorDodge' })]), 1, 1);
    out.hueMode = read(doc(1, 1, [layer([200, 100, 50, 255], 1, 1), layer([50, 100, 200, 255], 1, 1, { blendMode: 'hue' })]), 1, 1);
    const info = { float: gpu.floatTargets, max: gpu.maxTextureSize };
    gpu.destroy();
    return { out, info };
  });
  const near = (actual: number[], expected: number[], tolerance = 1) => {
    expect(actual.length).toBe(expected.length);
    actual.forEach((v, i) => expect(Math.abs(v - expected[i]!), `channel ${i}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance));
  };
  const o = results.out;
  near(o.orientation!, [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255], 0);
  near(o.translucent!, [200, 100, 50, 128]);
  near(o.multiply!, [100, 50, 50, 255]);
  // Screen at 50% alpha: B = 1-(1-b)(1-s); co = s(1-ab)+b(1-as)+as·ab·B with ab = 1.
  const b = 100 / 255, s = [200 / 255, 0, 0], as = 128 / 255;
  near(o.screenHalf!, s.map((sc) => Math.round(255 * (b * (1 - as) + as * (1 - (1 - b) * (1 - sc))))).concat(255));
  near(o.opacity!, [128, 128, 128, 255]);
  near(o.mask!, [255, 0, 0, 255, 0, 0, 0, 0]);
  near(o.disabledMask!, [255, 0, 0, 255, 255, 0, 0, 255]);
  near(o.clippingStack!, [0, 0, 255, 255, 0, 0, 0, 0]);
  near(o.liveMaskHiddenBase!, [0, 255, 0, 255, 0, 0, 0, 0]);
  near(o.folderMask!, [0, 0, 0, 0, 9, 9, 9, 255]);
  near(o.rotated!, [255, 0, 0, 255, 0, 0, 255, 255], 0);
  // Colour Dodge on sRGB values (LayerAppearanceTests pins dodge/burn to the sRGB formula): 0.502/(1-0.502) → 1.
  near(o.dodge!, [255, 255, 255, 255], 1);
  // Hue: SetLum(SetSat(s, Sat(b)), Lum(b)).
  near(o.hueMode!, hueExpected([200, 100, 50], [50, 100, 200]), 2);
  console.log('GPU info', results.info);
});

function hueExpected(backdrop: number[], source: number[]): number[] {
  const bb = backdrop.map((v) => v / 255), ss = source.map((v) => v / 255);
  const lum = (c: number[]) => 0.3 * c[0]! + 0.59 * c[1]! + 0.11 * c[2]!;
  const sat = (c: number[]) => Math.max(...c) - Math.min(...c);
  const setSat = (c: number[], sv: number) => {
    const mx = Math.max(...c), mn = Math.min(...c);
    return c.map((v) => (mx > mn ? (v - mn) * sv / (mx - mn) : 0));
  };
  const clip = (c: number[]) => {
    const l = lum(c), n = Math.min(...c), x = Math.max(...c);
    if (n < 0) c = c.map((v) => l + (v - l) * l / (l - n));
    if (x > 1) c = c.map((v) => l + (v - l) * (1 - l) / (x - l));
    return c;
  };
  const setLum = (c: number[], l: number) => clip(c.map((v) => v + l - lum(c)));
  return setLum(setSat(ss, sat(bb)), lum(bb)).map((v) => Math.round(v * 255)).concat(255);
}
