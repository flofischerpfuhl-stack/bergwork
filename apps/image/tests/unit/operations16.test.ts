import { describe, expect, it } from 'vitest';
import { defaultAdjustment, defaultLevelRange } from '../../src/core/adjustments';
import type { CanvasDocument, LayerAdjustment, LayerAdjustmentKind } from '../../src/core/document';
import { newLayer } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { adjustRaster } from '../../src/core/adjust/raster';
import { beginStroke } from '../../src/core/brush/stroke';
import { DEFAULT_BRUSH_SETTINGS, type BrushMode } from '../../src/core/brush/settings';
import { applyFilter } from '../../src/core/filters/apply';
import { defaultFilterSettings, FILTER_KINDS } from '../../src/core/filters/settings';
import { BlurStroke } from '../../src/core/retouch/blur';
import { WarpStroke } from '../../src/core/retouch/warp';
import { applyContentAwareFill, beginContentAwareFill } from '../../src/core/contentFill';
import { createSpotHealingStroke } from '../../src/core/heal';
import { EditorSession } from '../../src/core/session';
import { rectangleSelection } from '../../src/core/selectionOps';
import {
  applySelection, beginPixelMove, clearSelectedPixels, fillSelection, finishPixelMove, movePixels,
} from '../../src/core/selectionCommands';
import { loadLittleCms } from '../../src/wasm/lcms';
import { createMainThreadKernelClient } from '../../src/workers/kernelClient';

const WIDTH = 1024;
const transform = makeTransform({ x: 0, y: 0 }, { width: WIDTH, height: 8 });

function ramp(): Raster {
  const pixels = new Uint16Array(WIDTH * 8 * 4);
  for (let y = 0; y < 8; y++) for (let x = 0; x < WIDTH; x++) {
    const value = Math.round(x / (WIDTH - 1) * 65535), at = (y * WIDTH + x) * 4;
    pixels[at] = value; pixels[at + 1] = value; pixels[at + 2] = value; pixels[at + 3] = 65535;
  }
  return Raster.fromPixels(WIDTH, 8, 4, pixels, { format: 'rgba16' });
}

function distinctRed(raster: Raster): number {
  const pixels = raster.toPixels16(), levels = new Set<number>();
  for (let x = 0; x < raster.width; x++) levels.add(pixels[x * 4]!);
  return levels.size;
}

function sessionWithRamp(): EditorSession {
  const session = new EditorSession(), raster = ramp();
  const layer = newLayer({ id: 'ramp-16', name: 'Ramp', raster, transform });
  const document: CanvasDocument = { id: 'doc-16', width: WIDTH, height: 8, resolution: 72,
    layers: [layer], selection: null };
  session.installProject(document, layer.id, null);
  return session;
}

const adjustmentKinds: readonly LayerAdjustmentKind[] = [
  'Levels', 'Curves', 'Hue/Saturation', 'Exposure', 'Invert', 'Threshold', 'Posterize',
  'Brightness/Contrast', 'Basic', 'Colour', 'Colour Lookup', 'Gradient Map', 'Grain',
  'Photo Filter', 'Channel Mixer',
];

function adjustment(kind: LayerAdjustmentKind): LayerAdjustment {
  const value = defaultAdjustment(kind, { red: 0, green: 0, blue: 0 }, { red: 1, green: 1, blue: 1 });
  if (value.kind !== 'Levels') return value;
  return { ...value, parameters: { ...value.parameters, ranges: [
    { ...defaultLevelRange(), white: 128, gamma: 0.8 }, defaultLevelRange(), defaultLevelRange(), defaultLevelRange(),
  ] } };
}

describe('A3 destructive operations retain native RGBA16 precision', () => {
  it.each(adjustmentKinds)('%s keeps the 16-bit format and continuous precision', (kind) => {
    const result = adjustRaster(ramp(), transform, adjustment(kind));
    expect(result.format).toBe('rgba16');
    // Threshold and Posterize intentionally quantize by definition; their storage must still remain RGBA16.
    if (kind !== 'Threshold' && kind !== 'Posterize') expect(distinctRed(result)).toBeGreaterThan(256);
  });

  it.each(FILTER_KINDS)('%s keeps the 16-bit format', (kind) => {
    const result = applyFilter(kind, ramp(), transform, defaultFilterSettings(), { expand: false, seed: 7 }).raster;
    expect(result.format).toBe('rgba16');
    if (kind !== 'High Pass') expect(distinctRed(result)).toBeGreaterThan(256);
  });

  it.each(['paint', 'erase', 'dodge', 'burn', 'sponge'] satisfies readonly BrushMode[])
  ('Brush %s writes native RGBA16 tiles', (mode) => {
    const source = ramp(), layer = newLayer({ id: `brush-${mode}`, name: mode, raster: source, transform });
    const stroke = beginStroke({ layer, canvas: { width: WIDTH, height: 8 },
      settings: { ...DEFAULT_BRUSH_SETTINGS, mode, diameter: 6, hardness: 1, opacity: 1 } });
    stroke.addPoints([{ x: 500, y: 4 }, { x: 524, y: 4 }]);
    const result = stroke.finish().raster;
    expect(result.format).toBe('rgba16');
    expect(result.tiles.some((tile) => tile instanceof Uint16Array)).toBe(true);
    expect(distinctRed(result)).toBeGreaterThan(256);
  });

  it('Clone Stamp writes native RGBA16 tiles', () => {
    const source = ramp(), layer = newLayer({ id: 'clone-16', name: 'clone', raster: source, transform });
    const stroke = beginStroke({ layer, canvas: { width: WIDTH, height: 8 },
      settings: { ...DEFAULT_BRUSH_SETTINGS, diameter: 6, hardness: 1 },
      clone: { offset: { width: 100, height: 0 }, sample: (point) => {
        const value = source.readRegionNative(Math.floor(point.x), Math.floor(point.y), 1, 1);
        return [value[0]!, value[1]!, value[2]!, value[3]!] as const;
      }, maximum: 65535 } });
    stroke.addPoints([{ x: 400, y: 4 }, { x: 420, y: 4 }]);
    const result = stroke.finish().raster;
    expect(result.format).toBe('rgba16');
    expect(distinctRed(result)).toBeGreaterThan(256);
  });

  it('Blur and Smudge retain native RGBA16 samples', () => {
    const source = ramp();
    const blur = new BlurStroke(source, transform, { diameter: 8, hardness: 1, strength: 0.5 });
    blur.addPoints([{ x: 480, y: 4 }, { x: 544, y: 4 }]);
    const blurred = blur.finish();
    expect(blurred.format).toBe('rgba16'); expect(distinctRed(blurred)).toBeGreaterThan(256);

    const smudge = new WarpStroke(source, transform, 'smudge', { diameter: 8, hardness: 0.5, strength: 0.5 });
    smudge.addPoints([{ x: 480, y: 4 }, { x: 544, y: 4 }]);
    const smeared = smudge.finish();
    expect(smeared.format).toBe('rgba16'); expect(distinctRed(smeared)).toBeGreaterThan(256);
  });

  it('Spot Healing retains RGBA16 storage and untouched native precision', async () => {
    const source = ramp(), layer = newLayer({ id: 'heal-16', name: 'heal', raster: source, transform });
    const kernels = createMainThreadKernelClient();
    try {
      const stroke = createSpotHealingStroke({ layer, canvas: { width: WIDTH, height: 8 }, kernels,
        settings: { diameter: 6, hardness: 1, opacity: 1, mode: 'proximityMatch', seed: 7 } });
      stroke.addPoints([{ x: 500, y: 4 }, { x: 524, y: 4 }]);
      const result = (await stroke.finish()).raster;
      expect(result.format).toBe('rgba16');
      expect(distinctRed(result)).toBeGreaterThan(256);
    } finally { kernels.destroy(); }
  });

  it('Content-Aware Fill retains RGBA16 storage and untouched native precision', async () => {
    const session = sessionWithRamp(), kernels = createMainThreadKernelClient();
    applySelection(session, rectangleSelection({ x: 496, y: 2, width: 32, height: 4 }, session.document!), 'New', 'Select');
    try {
      expect(beginContentAwareFill(session, { kernels })).not.toBeNull();
      expect(await applyContentAwareFill(session)).toBe(true);
      expect(session.activeLayer!.raster!.format).toBe('rgba16');
      expect(distinctRed(session.activeLayer!.raster!)).toBeGreaterThan(256);
    } finally { kernels.destroy(); }
  });

  it('Fill, Clear, and a resampled pixel move keep RGBA16 storage and the untouched ramp precision', () => {
    const session = sessionWithRamp();
    applySelection(session, rectangleSelection({ x: 0, y: 0, width: 128, height: 8 }, session.document!), 'New', 'Select');
    session.foregroundColor = { red: 1, green: 0, blue: 0 };
    expect(fillSelection(session, 'foreground')).toBe(true);
    expect(session.activeLayer!.raster!.format).toBe('rgba16');
    expect(clearSelectedPixels(session)).toBe(true);
    expect(session.activeLayer!.raster!.format).toBe('rgba16');
    applySelection(session, rectangleSelection({ x: 256, y: 0, width: 128, height: 8 }, session.document!), 'New', 'Select');
    expect(beginPixelMove(session, true)).toBe(true);
    expect(movePixels(session, 16.5, 0)).toBe(true);
    expect(finishPixelMove(session)).toBe(true);
    expect(session.activeLayer!.raster!.format).toBe('rgba16');
    expect(distinctRed(session.activeLayer!.raster!)).toBeGreaterThan(256);
  });

  it('Little CMS TYPE_RGB_16 conversion retains more than 256 levels', async () => {
    const lcms = await loadLittleCms();
    const profile = lcms.createRgbProfile({ white: [0.3127, 0.329], red: [0.64, 0.33],
      green: [0.3, 0.6], blue: [0.15, 0.06] }, 2.4, 'srgb');
    const colors = new Uint16Array(WIDTH * 3);
    for (let x = 0; x < WIDTH; x++) colors.fill(Math.round(x / (WIDTH - 1) * 65535), x * 3, x * 3 + 3);
    const converted = lcms.transform16(profile, colors, 'rgb');
    const levels = new Set<number>(); for (let x = 0; x < WIDTH; x++) levels.add(converted[x * 4]!);
    expect(converted).toBeInstanceOf(Uint16Array);
    expect(levels.size).toBeGreaterThan(900);
  });
});
