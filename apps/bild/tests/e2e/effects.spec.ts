import { expect, test } from '@playwright/test';

test('layer effects render identically through WebGL2 and the software reference', async ({ page }) => {
  await page.goto('/?harness=gpu');
  const result = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { GpuCompositor, DEFAULT_HOOKS } = await load('/src/render/gpuCompositor.ts');
    const { documentWithLayerEffects } = await load('/src/core/effects/document.ts');
    const { compositeRegion } = await load('/src/core/composite.ts');
    const { Raster } = await load('/src/core/raster.ts');
    const { newLayer } = await load('/src/core/document.ts');
    const { makeTransform } = await load('/src/core/geometry.ts');
    const width = 24, height = 18, pixels = new Uint8Array(8 * 6 * 4);
    for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) {
      const offset = (y * 8 + x) * 4;
      pixels[offset] = 180; pixels[offset + 1] = 90; pixels[offset + 2] = 30;
      pixels[offset + 3] = x === 0 || y === 0 || x === 7 || y === 5 ? 128 : 255;
    }
    const effects = [
      { kind: 'dropShadow', schemaVersion: 1, enabled: true, opacity: 0.7, angle: 15, useGlobalLight: true,
        distance: 3, blur: 3, size: 3, spread: 20, color: { red: 0, green: 0, blue: 0 }, blendMode: 'multiply',
        contour: 'linear', noise: 0, knockout: true },
      { kind: 'outerGlow', schemaVersion: 1, enabled: true, opacity: 0.6, color: { red: 0.2, green: 0.6, blue: 1 },
        blendMode: 'screen', spread: 10, size: 2, contour: 'linear', noise: 0 },
      { kind: 'stroke', schemaVersion: 1, enabled: true, width: 1, position: 'outside', opacity: 0.9,
        blendMode: 'normal', fill: { kind: 'gradient', angle: 0, scale: 100, gradient: { stops: [
          { offset: 0, color: { red: 1, green: 0, blue: 0 }, opacity: 1 },
          { offset: 1, color: { red: 0, green: 0, blue: 1 }, opacity: 1 },
        ] } } },
      { kind: 'colorOverlay', schemaVersion: 1, enabled: true, opacity: 0.25,
        blendMode: 'color', color: { red: 0, green: 1, blue: 0 } },
      { kind: 'gradientOverlay', schemaVersion: 1, enabled: true, opacity: 0.35, blendMode: 'overlay', angle: 90,
        scale: 100, gradient: { stops: [
          { offset: 0, color: { red: 0, green: 0, blue: 0 }, opacity: 1 },
          { offset: 1, color: { red: 1, green: 1, blue: 1 }, opacity: 1 },
        ] } },
    ];
    const background = newLayer({ id: 'bg', name: 'Background', raster: Raster.fromPixels(width, height, 4,
      new Uint8Array(width * height * 4).fill(255)), transform: makeTransform({ x: 0, y: 0 }, { width, height }, { sampling: 'Nearest' }) });
    const styled = newLayer({ id: 'styled', name: 'Styled', raster: Raster.fromPixels(8, 6, 4, pixels), effects,
      opacity: 0.8, fillOpacity: 0.65, transform: makeTransform({ x: 8, y: 6 }, { width: 8, height: 6 }, { sampling: 'Nearest' }) });
    const document = { id: 'effects', width, height, resolution: 72, globalLightAngle: 210,
      layers: [background, styled], selection: null };
    const canvas = globalThis.document.createElement('canvas'); globalThis.document.body.append(canvas);
    const gpu = await GpuCompositor.create(canvas, 1, 1);
    const actual = gpu.readRegion(document, 0, 0, width, height) as Uint8Array;
    const expanded = documentWithLayerEffects(document, DEFAULT_HOOKS);
    const expected = compositeRegion(expanded, { x: 0, y: 0, width, height }).rgba as Uint8Array;
    let maximum = 0, mismatches = 0;
    for (let i = 0; i < actual.length; i++) {
      const difference = Math.abs(actual[i]! - expected[i]!);
      maximum = Math.max(maximum, difference); if (difference > 1) mismatches++;
    }
    let changedOutsideSource = false;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (x >= 8 && x < 16 && y >= 6 && y < 12) continue;
      const offset = (y * width + x) * 4;
      if (actual[offset] !== 255 || actual[offset + 1] !== 255 || actual[offset + 2] !== 255) changedOutsideSource = true;
    }
    gpu.destroy();
    return { maximum, mismatches, changedOutsideSource };
  });
  expect(result.maximum).toBeLessThanOrEqual(1);
  expect(result.mismatches).toBe(0);
  expect(result.changedOutsideSource).toBe(true);
});

test('adding a layer style does not re-round the layer own translucent pixels', async ({ page }) => {
  await page.goto('/?harness=gpu');
  const result = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { GpuCompositor } = await load('/src/render/gpuCompositor.ts');
    const { Raster } = await load('/src/core/raster.ts');
    const { newLayer } = await load('/src/core/document.ts');
    const { makeTransform } = await load('/src/core/geometry.ts');
    const bytes = new Uint8Array(3 * 3 * 4);
    for (let i = 0; i < 9; i++) bytes.set([31, 79, 191, 126], i * 4);
    const raster = Raster.fromPixels(3, 3, 4, bytes);
    const transform = makeTransform({ x: 1, y: 1 }, { width: 3, height: 3 }, { sampling: 'Nearest' });
    const plain = newLayer({ id: 'pixel', name: 'Pixel', raster, transform });
    const styled = { ...plain, effects: [{ kind: 'dropShadow', schemaVersion: 1, enabled: true,
      opacity: 1, angle: 0, distance: 10, blur: 0, size: 0, color: { red: 0, green: 0, blue: 0 },
      knockout: true }] };
    const base = { id: 'rounding', width: 20, height: 20, resolution: 72, selection: null };
    const canvas = globalThis.document.createElement('canvas'); globalThis.document.body.append(canvas);
    const gpu = await GpuCompositor.create(canvas, 20, 20);
    const before = gpu.readRegion({ ...base, layers: [plain] }, 2, 2, 1, 1);
    const after = gpu.readRegion({ ...base, layers: [styled] }, 2, 2, 1, 1);
    gpu.destroy();
    return { before: Array.from(before), after: Array.from(after) };
  }) as { before: number[]; after: number[] };
  expect(result.before[3]).toBe(126);
  expect(result.after).toEqual(result.before);
});
