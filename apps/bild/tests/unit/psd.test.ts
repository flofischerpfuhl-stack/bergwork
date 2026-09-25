import { describe, expect, it } from 'vitest';
import { writePsdUint8Array, type Layer as AgLayer, type Psd } from 'ag-psd';
import type { HostAdapter } from '../../contracts';
import { applyAdjustment } from '../../src/core/adjust/apply';
import { curvesTables } from '../../src/core/adjust/levels';
import { defaultCurves, defaultHueSaturation } from '../../src/core/adjustments';
import { newLayer, type CanvasDocument, type LayerAdjustment } from '../../src/core/document';
import { renderPsdInnerEffectPasses } from '../../src/core/effects/render';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { readRawPsdComposite } from '../../src/io/psd/composite';
import { decodePsdLayerChannels } from '../../src/io/psd/layerChannels';
import { readPsdDocument, readPsdDocumentManaged } from '../../src/io/psd';
import { cpuCompositeRegion } from '../../src/render/cpuRender';
import { adjustmentProgram } from '../../src/render/adjustPrograms';
import { EditorController } from '../../src/ui/controller';
import { loadLittleCms } from '../../src/wasm/lcms';

function u16(value: number): Uint8Array { return new Uint8Array([value >>> 8, value]); }
function u32(value: number): Uint8Array { return new Uint8Array([value >>> 24, value >>> 16, value >>> 8, value]); }
function join(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length; } return output;
}
function rawPsd(mode: number, channels: readonly Uint8Array[], colorData = new Uint8Array()): Uint8Array {
  return join([new TextEncoder().encode('8BPS'), u16(1), new Uint8Array(6), u16(channels.length), u32(1), u32(1),
    u16(8), u16(mode), u32(colorData.length), colorData, u32(0), u32(0), u16(0), ...channels]);
}
function image(values: readonly number[]): { width: number; height: number; data: Uint8ClampedArray } {
  return { width: 2, height: 1, data: new Uint8ClampedArray(values) };
}

describe('PSD colour modes and product wiring', () => {
  it('A7: applies Photoshop modern Brightness/Contrast and channel-wise Hue/Saturation lightness', () => {
    const source = new Float32Array([0.2, 0.4, 0.8, 1]);
    const brightness = { kind: 'Brightness/Contrast' as const, schemaVersion: 1 as const,
      parameters: { brightness: 0, contrast: 0, legacy: false } };
    const neutral = applyAdjustment(brightness, source, 1, 1, 0, 0);
    expect(neutral[0]).toBeCloseTo(0.2, 6); expect(neutral[1]).toBeCloseTo(0.4, 6);
    expect(neutral[2]).toBeCloseTo(0.8, 6); expect(neutral[3]).toBe(1);
    const hue = { kind: 'Hue/Saturation' as const, schemaVersion: 1 as const,
      parameters: { hue: 0, saturation: 0, lightness: 50, colorize: false,
        settings: defaultHueSaturation(0, 0, 50) } };
    const adjusted = applyAdjustment(hue, source, 1, 1, 0, 0);
    expect(adjusted[0]).toBeCloseTo(0.6, 5); expect(adjusted[1]).toBeCloseTo(0.7, 5);
    expect(adjusted[2]).toBeCloseTo(0.9, 5); expect(adjusted[3]).toBe(1);
  });

  it('A7: renders PSD inner styles from source alpha and embedded pattern-overlay pixels', () => {
    const alpha = new Uint8Array(25);
    for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) alpha[y * 5 + x] = 255;
    const pass = renderPsdInnerEffectPasses(alpha, 5, 5, [{ kind: 'innerGlow', opacity: 1,
      blendMode: 'screen', color: { red: 1, green: 0, blue: 0 }, size: 2, choke: 0,
      angle: 0, distance: 0, useGlobalLight: false, source: 'edge' }])[0]!;
    const glow = pass.raster.toPixels();
    expect(glow[(2 * 5 + 2) * 4 + 3]).toBeLessThan(glow[(1 * 5 + 2) * 4 + 3]!);
    expect(glow[3]).toBe(0);

    const transform = makeTransform({ x: 0, y: 0 }, { width: 2, height: 1 });
    const base = newLayer({ id: 'pattern', name: 'pattern', transform,
      raster: Raster.fromPixels(2, 1, 4, new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255])) });
    const patterned = { ...base, effects: [{ kind: 'patternOverlay' as const, schemaVersion: 1 as const, enabled: true,
      opacity: 1, blendMode: 'normal' as const, resourceId: 'psd-pattern', patternWidth: 2, patternHeight: 1,
      scale: 100, angle: 0, linkWithLayer: true }] };
    const document: CanvasDocument = { id: 'psd-style', width: 2, height: 1, resolution: 72,
      resources: [{ id: 'psd-pattern', role: 'pattern', mime: 'application/x-fernwork-rgba8',
        bytes: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]) }], layers: [patterned], selection: null };
    expect(cpuCompositeRegion(document, { x: 0, y: 0, width: 2, height: 1 }))
      .toEqual(new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]));
  });

  it('A7: Photoshop Threshold, Posterize and Curves formulas match GPU programs', () => {
    const source = new Float32Array([1, 0, 0, 1, 0.2, 0.2, 0.2, 1]);
    const threshold = { kind: 'Threshold' as const, schemaVersion: 1 as const, parameters: { level: 70 } };
    const posterize = { kind: 'Posterize' as const, schemaVersion: 1 as const, parameters: { levels: 4 } };
    expect(Array.from(applyAdjustment(threshold, source, 2, 1, 0, 0)))
      .toEqual([1, 1, 1, 1, 0, 0, 0, 1]);
    expect(Array.from(applyAdjustment(posterize, source, 2, 1, 0, 0)))
      .toEqual([1, 0, 0, 1, 0, 0, 0, 1]);

    const transform = makeTransform({ x: 0, y: 0 }, { width: 2, height: 1 });
    const thresholdLayer = newLayer({ id: 'threshold', name: 'threshold', transform, adjustment: threshold });
    const posterizeLayer = newLayer({ id: 'posterize', name: 'posterize', transform, adjustment: posterize });
    const thresholdGpu = adjustmentProgram(thresholdLayer)!;
    const posterizeGpu = adjustmentProgram(posterizeLayer)!;
    expect(Array.from(thresholdGpu.params(thresholdLayer).slice(0, 1))).toEqual([70]);
    expect(thresholdGpu.glsl).toContain('0.299,0.587,0.114');
    expect(Array.from(posterizeGpu.params(posterizeLayer).slice(0, 1))).toEqual([4]);
    expect(posterizeGpu.glsl).toContain('floor(clamp(c,0.0,1.0)*levels)');

    const defaults = defaultCurves();
    const curves = { ...defaults, channels: [[{ x: 0, y: 0 }, { x: 80, y: 220 }, { x: 160, y: 20 },
      { x: 255, y: 255 }], ...defaults.channels.slice(1)] };
    const adjustment = { kind: 'Curves' as const, schemaVersion: 1 as const, parameters: curves };
    const tables = curvesTables(curves);
    const curvesLayer = newLayer({ id: 'curves', name: 'curves', transform, adjustment });
    const gpuTable = adjustmentProgram(curvesLayer)!.lut!(curvesLayer)!;
    for (let index = 0; index < 256; index++) {
      expect(gpuTable.data[index * 4]).toBeCloseTo(Math.min(1, Math.max(0, tables[index]!)), 7);
    }

    const grayAdjustment = Object.assign({}, adjustment, { psdColorMode: 1 }) as LayerAdjustment;
    const grayLayer = newLayer({ id: 'gray-curves', name: 'gray curves', transform, adjustment: grayAdjustment });
    const grayProgram = adjustmentProgram(grayLayer)!;
    expect(grayProgram.key).toBe('generic-cube-65:Curves');
    const grayLut = grayProgram.lut!(grayLayer)!;
    const sample = 13 / 64, expected = applyAdjustment(grayAdjustment,
      new Float32Array([sample, sample, sample, 1]), 1, 1, 0, 0);
    const textureIndex = (78 * grayLut.width + 273) * 4;
    expect(grayLut.data[textureIndex]).toBeCloseTo(expected[0]!, 7);
    expect(grayLut.data[textureIndex + 1]).toBeCloseTo(expected[1]!, 7);
    expect(grayLut.data[textureIndex + 2]).toBeCloseTo(expected[2]!, 7);
  });

  it('decodes CMYK pixels from layer-owned channels without consulting the merged composite', () => {
    const layer = { name: 'CMYK layer', top: 0, left: 0, bottom: 1, right: 1,
      rawData: { channels: [255, 128, 64, 200].map((value, id) =>
        ({ id, compression: 0, data: new Uint8Array([value]) })) } } as AgLayer;
    decodePsdLayerChannels(layer, { colorMode: 4, bitsPerChannel: 8, isPsb: false,
      palette: null, iccProfile: null, lcms: null });
    expect(layer.imageData?.data).toEqual(new Uint8ClampedArray([200, 100, 50, 255]));
  });

  it('decodes raw CMYK and indexed merged channels when ag-psd cannot parse the colour mode', () => {
    const cmyk = rawPsd(4, [new Uint8Array([255]), new Uint8Array([128]), new Uint8Array([64]), new Uint8Array([200])]);
    expect(readRawPsdComposite(cmyk).rgba).toEqual(new Uint8Array([200, 100, 50, 255]));
    const imported = readPsdDocument(cmyk);
    expect(imported.document.layers.map((layer) => layer.name)).toEqual(['Photoshop composite (flattened)']);
    expect(cpuCompositeRegion(imported.document, { x: 0, y: 0, width: 1, height: 1 })).toEqual(imported.oracle!.toPixels());

    const palette = new Uint8Array(768); palette[7] = 12; palette[256 + 7] = 34; palette[512 + 7] = 56;
    expect(readRawPsdComposite(rawPsd(2, [new Uint8Array([7])], palette)).rgba)
      .toEqual(new Uint8Array([12, 34, 56, 255]));
  });

  it('uses the Little CMS default CMYK profile on the product-open path', async () => {
    const bytes = rawPsd(4, [new Uint8Array([255]), new Uint8Array([128]), new Uint8Array([64]), new Uint8Array([200])]);
    const lcms = await loadLittleCms();
    const expected = lcms.transform(lcms.createCmykProfile(), new Uint8Array([0, 127, 191, 55]), 'cmyk', 8);
    const imported = await readPsdDocumentManaged(bytes);
    expect(imported.document.layers[0]?.raster?.toPixels()).toEqual(expected);
  });

  it('A3/A7: preserves 16-bit Little CMS output for PSD layer channels', async () => {
    const lcms = await loadLittleCms();
    const layer = { name: '16-bit gray', top: 0, left: 0, bottom: 1, right: 2,
      rawData: { channels: [{ id: 0, compression: 0,
        data: new Uint8Array([0x12, 0x34, 0xab, 0xcd]) }] } } as AgLayer;
    decodePsdLayerChannels(layer, { colorMode: 1, bitsPerChannel: 16, isPsb: false,
      palette: null, iccProfile: null, lcms });
    expect(layer.imageData?.data).toBeInstanceOf(Uint16Array);
    const expected = lcms.transform16(lcms.createGrayProfile([0.3127, 0.329], 2.2),
      new Uint16Array([0x1234, 0xabcd]), 'gray');
    expect(layer.imageData?.data).toEqual(expected);
    expect(new Set(Array.from(layer.imageData!.data as Uint16Array).map((value) => value & 0xff)).size)
      .toBeGreaterThan(1);
  });

  it('A7: renders a cache-less generated vector layer from its own descriptor and path', () => {
    const knot = (x: number, y: number) => ({ linked: false, points: [x, y, x, y, x, y] });
    const shape: AgLayer = { name: 'Generated rectangle', vectorFill: { type: 'color', color: { r: 0, g: 0, b: 0 } },
      vectorMask: { paths: [{ open: false, fillRule: 'non-zero', operation: 'combine',
        knots: [knot(1, 1), knot(3, 1), knot(3, 3), knot(1, 3)] }] } };
    const oracle = { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4) };
    for (let y = 1; y < 3; y++) for (let x = 1; x < 3; x++) oracle.data[(y * 4 + x) * 4 + 3] = 255;
    const imported = readPsdDocument(writePsdUint8Array({ width: 4, height: 4, children: [shape], imageData: oracle },
      { generateThumbnail: false }));
    const layer = imported.document.layers[0]!;
    expect(layer.kind).toBe('vector');
    expect(layer.transform).toMatchObject({ origin: { x: 1, y: 1 }, size: { width: 2, height: 2 } });
    expect(layer.raster?.toPixels()).toEqual(new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255,
      0, 0, 0, 255, 0, 0, 0, 255]));
    expect(cpuCompositeRegion(imported.document, { x: 0, y: 0, width: 4, height: 4 }))
      .toEqual(new Uint8Array(oracle.data));
  });

  it('A7: clips an isolated PSD group to the preceding sibling base', () => {
    const background: AgLayer = { name: 'Background', imageData: image([255, 255, 255, 255, 255, 255, 255, 255]) };
    const base: AgLayer = { name: 'Base', imageData: image([0, 0, 0, 255, 0, 0, 0, 0]) };
    const red: AgLayer = { name: 'Red', imageData: image([255, 0, 0, 255, 255, 0, 0, 255]) };
    const group: AgLayer = { name: 'Clipped group', clipping: true, blendMode: 'normal', children: [red] };
    const expected = image([255, 0, 0, 255, 255, 255, 255, 255]);
    const imported = readPsdDocument(writePsdUint8Array({ width: 2, height: 1,
      children: [background, base, group], imageData: expected }, { generateThumbnail: false }));
    const importedGroup = imported.document.layers.find((layer) => layer.kind === 'group')!;
    expect(importedGroup.maskSourceId).toBe(imported.document.layers.find((layer) => layer.name === 'Base')!.id);
    expect(cpuCompositeRegion(imported.document, { x: 0, y: 0, width: 2, height: 1 }))
      .toEqual(new Uint8Array(expected.data));
  });

  it('A7: renders a custom artboard background and clips children to its independent rectangle', () => {
    const pixels = { width: 3, height: 1, data: new Uint8ClampedArray([
      0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 255, 255,
    ]) };
    const artboard: AgLayer = { name: 'Board', blendMode: 'pass through', artboard: {
      rect: { top: 0, left: 0, bottom: 1, right: 2 }, color: { r: 10, g: 20, b: 30 }, backgroundType: 4,
    }, children: [{ name: 'Paint', top: 0, left: 0, bottom: 1, right: 3, imageData: pixels }] };
    const expected = { width: 3, height: 1, data: new Uint8ClampedArray([
      10, 20, 30, 255, 255, 0, 0, 255, 0, 0, 0, 0,
    ]) };
    const imported = readPsdDocument(writePsdUint8Array({ width: 3, height: 1,
      children: [artboard], imageData: expected }, { generateThumbnail: false }));
    expect(imported.document.layers.map((layer) => layer.name))
      .toEqual(['Board', 'Artboard background', 'Paint']);
    expect(imported.document.layers[0]?.mask).toMatchObject({ enabled: true, linked: false,
      placement: { origin: { x: 0, y: 0 }, size: { width: 2, height: 1 } } });
    expect(cpuCompositeRegion(imported.document, { x: 0, y: 0, width: 3, height: 1 }))
      .toEqual(new Uint8Array(expected.data));

    const bleed = { width: 6, height: 1, data: new Uint8ClampedArray(Array(6).fill([255, 255, 255, 255]).flat()) };
    const content = image([255, 0, 0, 255, 255, 0, 0, 255]);
    const legacyExpected = { width: 4, height: 1, data: new Uint8ClampedArray([
      0, 0, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0,
    ]) };
    const legacy = readPsdDocument(writePsdUint8Array({ width: 4, height: 1, children: [{
      name: 'Legacy board', nameSource: 'artb', blendMode: 'pass through', children: [
        { name: 'Bleed', top: 0, left: -1, bottom: 1, right: 5, imageData: bleed },
        { name: 'Content', top: 0, left: 1, bottom: 1, right: 3, imageData: content },
      ],
    }], imageData: legacyExpected }, { generateThumbnail: false }));
    expect(cpuCompositeRegion(legacy.document, { x: 0, y: 0, width: 4, height: 1 }))
      .toEqual(new Uint8Array(legacyExpected.data));
  });

  it('places an adjustment mask from its PSD bounds instead of the empty adjustment-layer bounds', () => {
    const base: AgLayer = { name: 'Base', top: 0, left: 0, bottom: 1, right: 2,
      imageData: image([10, 20, 30, 255, 40, 50, 60, 255]) };
    const invert: AgLayer = { name: 'Invert', adjustment: { type: 'invert' },
      mask: { top: 0, left: 1, bottom: 1, right: 2, defaultColor: 0,
        imageData: image([255, 255, 255, 255, 255, 255, 255, 255]) } };
    const psd: Psd = { width: 2, height: 1, children: [base, invert],
      imageData: image([10, 20, 30, 255, 215, 205, 195, 255]) };
    const imported = readPsdDocument(writePsdUint8Array(psd, { generateThumbnail: false }));
    const adjustment = imported.document.layers.find((layer) => layer.adjustment);
    expect(adjustment?.transform.origin).toEqual({ x: 1, y: 0 });
    expect(cpuCompositeRegion(imported.document, { x: 0, y: 0, width: 2, height: 1 }))
      .toEqual(new Uint8Array(psd.imageData!.data));
  });

  it('opens PSD as a document and imports PSD through Import as layers', async () => {
    const notices: string[] = [];
    const host: HostAdapter = {
      chooseImages: async () => [], chooseProject: async () => null,
      saveFile: async () => undefined, reportError: (error) => notices.push(error.code),
    };
    const bytes = rawPsd(4, [new Uint8Array([255]), new Uint8Array([128]), new Uint8Array([64]), new Uint8Array([200])]);
    const file = new File([bytes as Uint8Array<ArrayBuffer>], 'fixture.psd', { type: 'image/vnd.adobe.photoshop' });
    const controller = new EditorController(host, 'en', 'dark');
    await controller.importFiles([file]);
    expect(controller.session.projectName).toBe('fixture');
    expect(controller.session.document?.layers).toHaveLength(1);

    const imported = new EditorController(host, 'en', 'dark');
    imported.newCanvasTab(2, 1);
    const before = imported.session.document!.layers.length;
    const ids = await imported.importFiles([file], imported.workspace.current, null, true);
    expect(ids).toHaveLength(1);
    expect(imported.session.document!.layers).toHaveLength(before + 1);
    expect(notices).toContain('psd-import-notice');
  });
});
