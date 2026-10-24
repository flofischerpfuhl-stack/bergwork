import { describe, expect, it } from 'vitest';
import { readPsd } from 'ag-psd';
import { DEFAULT_TEXT_STYLE, newLayer, type CanvasDocument, type LayerEffect } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { createMeshWarp } from '../../src/core/meshWarp';
import { Raster } from '../../src/core/raster';
import { srgbIccProfile } from '../../src/io/iccProfile';
import { readPsdDocument, writePsdDocument } from '../../src/io/psd';
import { readRawPsdComposite } from '../../src/io/psd/composite';
import { encodePng } from '../../src/io/png';
import { cpuCompositeRegion } from '../../src/render/cpuRender';

function solid(width: number, height: number, rgba: readonly [number, number, number, number], sixteen = false): Raster {
  const data = sixteen ? new Uint16Array(width * height * 4) : new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) for (let channel = 0; channel < 4; channel++) {
    data[pixel * 4 + channel] = sixteen ? rgba[channel]! * 257 : rgba[channel]!;
  }
  return Raster.fromPixels(width, height, 4, data, sixteen ? { format: 'rgba16' } : {});
}

function document(layers: CanvasDocument['layers'], extra: Partial<CanvasDocument> = {}): CanvasDocument {
  return { id: 'write-test', width: 4, height: 2, resolution: 144, layers, selection: null, ...extra };
}

function maximumDifference(a: Uint8Array, b: Uint8Array): number {
  expect(a).toHaveLength(b.length);
  let maximum = 0;
  for (let index = 0; index < a.length; index++) maximum = Math.max(maximum, Math.abs(a[index]! - b[index]!));
  return maximum;
}

function comparableEffects(values: readonly LayerEffect[]): unknown {
  const withoutResourceIdentity = values.map((effect) => effect.kind === 'patternOverlay'
    ? { ...effect, resourceId: '<pattern>' } : effect);
  // ag-psd's percent descriptors can return binary tails such as 114.99999999999999; 1e-9 is well below
  // the PSD percentage descriptor's 0.01 model tolerance.
  return JSON.parse(JSON.stringify(withoutResourceIdentity, (_key, value) => typeof value === 'number'
    ? Math.round(value * 1e9) / 1e9 : value));
}

describe('PRODUCT-PLAN A7 PSD writer', () => {
  it('round-trips editable per-channel split Blend If ranges and their rendered pixels', () => {
    const full = makeTransform({ x: 0, y: 0 }, { width: 2, height: 1 }, { sampling: 'Nearest' });
    const identity = { black0: 0, black1: 0, white0: 255, white1: 255 };
    const blendIf = { source: { gray: identity, red: identity, green: identity, blue: identity },
      destination: { gray: identity, red: { black0: 100, black1: 200, white0: 255, white1: 255 }, green: identity, blue: identity } };
    const base = newLayer({ id: 'base', name: 'Base', transform: full, raster: Raster.fromPixels(2, 1, 4,
      new Uint8Array([50, 0, 0, 255, 200, 0, 0, 255])) });
    const top = newLayer({ id: 'top', name: 'Top', transform: full, blendIf,
      raster: solid(2, 1, [0, 0, 255, 255]) });
    const input = document([base, top], { width: 2, height: 1 });
    expect(cpuCompositeRegion(input, { x: 0, y: 0, width: 2, height: 1 }))
      .toEqual(new Uint8Array([50, 0, 0, 255, 0, 0, 255, 255]));
    const output = writePsdDocument(input), reopened = readPsdDocument(output.bytes);
    const raw = readPsd(output.bytes, { useImageData: true, skipThumbnail: true });
    const ranges = raw.children?.find((layer) => layer.name === 'Top')?.blendingRanges;
    expect(ranges?.compositeGrayBlendSource).toEqual([0, 0, 255, 255]);
    expect(ranges?.ranges[0]).toEqual({ sourceRange: [0, 0, 255, 255], destRange: [100, 200, 255, 255] });
    expect(reopened.document.layers.find((layer) => layer.name === 'Top')?.blendIf).toEqual(blendIf);
    expect(cpuCompositeRegion(reopened.document, { x: 0, y: 0, width: 2, height: 1 }))
      .toEqual(new Uint8Array([50, 0, 0, 255, 0, 0, 255, 255]));
  });

  it('writes and reimports Photoshop smart-filter descriptors with blending options', () => {
    const transform = makeTransform({ x: 0, y: 0 }, { width: 3, height: 1 }, { sampling: 'Nearest' });
    const sourceRaster = Raster.fromPixels(3, 1, 4, new Uint8Array([
      0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255,
    ]));
    const bytes = encodePng(sourceRaster.toPixels(), 3, 1, 4);
    const filterMask = Raster.fromPixels(3, 1, 1, new Uint8Array([0, 128, 255]));
    const filters = [
      { kind: 'gaussianBlur' as const, schemaVersion: 1 as const, enabled: true, radius: 1.5, opacity: 0.65, blendMode: 'screen' as const },
      { kind: 'unsharpMask' as const, schemaVersion: 1 as const, enabled: true, amount: 125, radius: 0.8, threshold: 3,
        opacity: 0.8, blendMode: 'luminosity' as const },
      { kind: 'noise' as const, schemaVersion: 1 as const, enabled: false, amount: 7, gaussian: true, monochromatic: true },
      { kind: 'motionBlur' as const, schemaVersion: 1 as const, enabled: true, angle: 25, distance: 4 },
      { kind: 'highPass' as const, schemaVersion: 1 as const, enabled: true, radius: 2 },
      { kind: 'smartSharpen' as const, schemaVersion: 1 as const, enabled: true, amount: 90, radius: 0.6,
        threshold: 2, reduceNoise: 0 },
      { kind: 'denoise' as const, schemaVersion: 1 as const, enabled: true, luminance: 15, colour: 20, detail: 40 },
    ];
    const placed = newLayer({ id: 'smart', name: 'Smart filters', kind: 'embedded', transform, raster: sourceRaster,
      filters, filterMask: { raster: filterMask, enabled: true, placement: null, linked: false, defaultColor: 255 },
      content: { mode: 'embedded', mediaType: 'image', assetId: 'source', sourceName: 'source.png', width: 3, height: 1 } });
    const input = document([placed], { width: 3, height: 1, resources: [
      { id: 'source', role: 'embedded', mime: 'image/png', bytes },
    ] });
    const output = writePsdDocument(input), reopened = readPsdDocument(output.bytes);
    const raw = readPsd(output.bytes, { useImageData: true, skipThumbnail: true });
    expect(output.notices).toEqual([]);
    expect(raw.children?.[0]?.placedLayer?.filter).toMatchObject({ maskEnabled: true, maskLinked: false, maskExtendWithWhite: true });
    expect(raw.children?.[0]?.filterEffectsMasks?.[0]?.extra?.data).toEqual(filterMask.toPixels());
    expect(raw.children?.[0]?.placedLayer?.filter?.list.map((filter) => [filter.type, filter.opacity, filter.blendMode, filter.enabled]))
      .toEqual([
        ['gaussian blur', 0.65, 'screen', true], ['unsharp mask', 0.8, 'luminosity', true],
        ['add noise', 1, 'normal', false], ['motion blur', 1, 'normal', true], ['high pass', 1, 'normal', true],
        ['smart sharpen', 1, 'normal', true], ['reduce noise', 1, 'normal', true],
      ]);
    const imported = reopened.document.layers[0]?.filters ?? [];
    expect(imported.map((filter) => filter.kind)).toEqual(filters.map((filter) => filter.kind));
    expect(imported).toMatchObject(filters.map((filter) => ({ ...filter,
      opacity: filter.opacity ?? 1, blendMode: filter.blendMode ?? 'normal',
      ...(filter.kind === 'noise' ? { amount: expect.closeTo(filter.amount, 9) } : {}) })));
    expect(reopened.document.layers[0]?.filterMask).toMatchObject({ enabled: true, linked: false, defaultColor: 255 });
    expect(reopened.document.layers[0]?.filterMask?.raster.toPixels()).toEqual(filterMask.toPixels());
    const expected = cpuCompositeRegion(input, { x: 0, y: 0, width: 3, height: 1 });
    const actual = cpuCompositeRegion(reopened.document, { x: 0, y: 0, width: 3, height: 1 });
    expect(maximumDifference(actual, expected)).toBeLessThanOrEqual(1);
  });
  it('round-trips hierarchy, clipping, blend/opacity/fill, locks, labels, masks, guides and CPU composite pixels', () => {
    const full = makeTransform({ x: 0, y: 0 }, { width: 4, height: 2 }, { sampling: 'Nearest' });
    const base = newLayer({ id: 'base', name: 'Base', transform: full, raster: solid(4, 2, [80, 120, 180, 255]),
      locks: { transparency: true, pixels: false, position: false, all: false }, colorLabel: 'red' });
    const group = newLayer({ id: 'group', name: 'Folder', kind: 'group', transform: full, opacity: 0.75 });
    const mask = Raster.fromPixels(4, 2, 1, new Uint8Array([255, 255, 0, 0, 255, 255, 0, 0]));
    const child = newLayer({ id: 'child', name: 'Clipped', parentId: 'group', transform: full,
      raster: solid(4, 2, [200, 40, 20, 200]), blendMode: 'multiply', opacity: 0.8, fillOpacity: 0.6,
      mask: { raster: mask, enabled: true, placement: null, linked: true } });
    const input = document([base, group, child], { guides: [
      { id: 'v', orientation: 'vertical', position: 1.5 }, { id: 'h', orientation: 'horizontal', position: 1 },
    ] });
    const expected = cpuCompositeRegion(input, { x: 0, y: 0, width: 4, height: 2 });
    const output = writePsdDocument(input);
    const reopened = readPsdDocument(output.bytes);
    expect(output.format).toBe('psd');
    expect(output.notices).toEqual([]);
    expect(reopened.document.resolution).toBe(144);
    expect(reopened.document.layers.map((layer) => [layer.name, layer.kind, layer.parentId !== null]))
      .toEqual([['Base', 'pixel', false], ['Folder', 'group', false], ['Clipped', 'pixel', true]]);
    expect(reopened.document.layers[0]).toMatchObject({ colorLabel: 'red', locks: { transparency: true } });
    expect(reopened.document.layers[2]).toMatchObject({ blendMode: 'multiply', opacity: 0.8, fillOpacity: 0.6,
      mask: { enabled: true } });
    const actual = cpuCompositeRegion(reopened.document, { x: 0, y: 0, width: 4, height: 2 });
    expect(maximumDifference(actual, expected)).toBeLessThanOrEqual(1);
    expect(readRawPsdComposite(output.bytes).rgba).toEqual(expected);
    expect(readRawPsdComposite(output.bytes).iccProfile).toEqual(srgbIccProfile());
  });

  it('round-trips the PSD Blend Clipped Layers as Group flag and its effect pixels', () => {
    const full = makeTransform({ x: 0, y: 0 }, { width: 2, height: 1 }, { sampling: 'Nearest' });
    const base = { ...newLayer({ id: 'base', name: 'Base', transform: full,
      raster: Raster.fromPixels(2, 1, 4, [255, 0, 0, 255, 0, 0, 0, 0]) }), psdBlendClippedElements: false };
    const clipped = newLayer({ id: 'clip', name: 'Clip', transform: full, maskSourceId: 'base',
      raster: solid(2, 1, [255, 255, 255, 255]), effects: [
        { kind: 'colorOverlay', schemaVersion: 1, enabled: true, opacity: 1, color: { red: 0, green: 0, blue: 1 } },
      ] });
    const input = document([base, clipped], { width: 2, height: 1 });
    const expected = cpuCompositeRegion(input, { x: 0, y: 0, width: 2, height: 1 });
    const reopened = readPsdDocument(writePsdDocument(input).bytes).document;
    expect((reopened.layers[0] as typeof reopened.layers[number]
      & { readonly psdBlendClippedElements?: boolean }).psdBlendClippedElements).toBe(false);
    expect(maximumDifference(cpuCompositeRegion(reopened, { x: 0, y: 0, width: 2, height: 1 }), expected))
      .toBeLessThanOrEqual(1);
  });

  it('writes editable text, shape, adjustment, layer-style and embedded-content records with rendered caches', () => {
    const full = makeTransform({ x: 0, y: 0 }, { width: 4, height: 2 }, { sampling: 'Nearest' });
    const effects: LayerEffect[] = [
      { kind: 'dropShadow', schemaVersion: 1, enabled: true, opacity: 0.5, angle: 120, distance: 2, blur: 3,
        color: { red: 0, green: 0, blue: 0 } },
      { kind: 'stroke', schemaVersion: 1, enabled: true, width: 1, position: 'inside', color: { red: 1, green: 0, blue: 0 } },
      { kind: 'outerGlow', schemaVersion: 1, enabled: true, opacity: 0.4, color: { red: 1, green: 1, blue: 0 },
        blendMode: 'screen', spread: 0, size: 2, contour: 'linear', noise: 0 },
      { kind: 'colorOverlay', schemaVersion: 1, enabled: true, opacity: 0.2, color: { red: 0, green: 1, blue: 0 } },
      { kind: 'gradientOverlay', schemaVersion: 1, enabled: true, opacity: 0.3, blendMode: 'normal', angle: 45, scale: 100,
        gradient: { stops: [{ offset: 0, color: { red: 0, green: 0, blue: 0 }, opacity: 1 },
          { offset: 1, color: { red: 1, green: 1, blue: 1 }, opacity: 1 }] } },
    ];
    const text = newLayer({ id: 'text', name: 'Editable text', kind: 'text', transform: full, text: 'Hi',
      runs: [{ from: 0, to: 2, style: { ...DEFAULT_TEXT_STYLE, fontFamily: 'Noto Sans', fontSize: 18,
        color: { red: 0.2, green: 0.4, blue: 0.8, alpha: 1 } } }], raster: solid(4, 2, [10, 20, 30, 255]), effects });
    const path = { schemaVersion: 1 as const, closed: true, fillRule: 'nonzero' as const, points: [
      { anchor: { x: 0, y: 0 }, in: { x: 0, y: 0 }, out: { x: 0, y: 0 }, kind: 'corner' as const },
      { anchor: { x: 4, y: 0 }, in: { x: 4, y: 0 }, out: { x: 4, y: 0 }, kind: 'corner' as const },
      { anchor: { x: 4, y: 2 }, in: { x: 4, y: 2 }, out: { x: 4, y: 2 }, kind: 'corner' as const },
    ] };
    const vector = newLayer({ id: 'vector', name: 'Editable shape', kind: 'vector', transform: full, paths: [path],
      style: { fill: { kind: 'solid', schemaVersion: 1, color: { red: 1, green: 0, blue: 0 } }, stroke: null },
      raster: solid(4, 2, [255, 0, 0, 255]) });
    const invert = newLayer({ id: 'invert', name: 'Invert', transform: full,
      adjustment: { kind: 'Invert', schemaVersion: 1, parameters: {} } });
    const source = encodePng(solid(1, 1, [30, 40, 50, 255]).toPixels(), 1, 1, 4);
    const embedded = newLayer({ id: 'placed', name: 'Placed', kind: 'embedded', transform: full,
      raster: solid(4, 2, [30, 40, 50, 255]), content: { mode: 'embedded', mediaType: 'image', assetId: 'placed-source',
        sourceName: 'source.png', width: 1, height: 1 } });
    const input = document([text, vector, invert, embedded], { resources: [
      { id: 'placed-source', role: 'embedded', mime: 'image/png', bytes: source },
    ] });
    const output = writePsdDocument(input);
    const raw = readPsd(output.bytes, { useImageData: true, skipThumbnail: true, skipLinkedFilesData: false });
    const byName = new Map(raw.children!.map((layer) => [layer.name, layer]));

    expect(byName.get('Editable text')).toMatchObject({ text: { text: 'Hi' },
      effects: { dropShadow: [{ enabled: true }], stroke: [{ enabled: true }], outerGlow: { enabled: true },
        solidFill: [{ enabled: true }], gradientOverlay: [{ enabled: true }] } });
    expect(byName.get('Editable text')?.text?.style?.fontSize).toBe(18);
    expect(byName.get('Editable shape')).toMatchObject({ vectorFill: { type: 'color' }, vectorMask: { paths: [{ open: false }] } });
    expect(byName.get('Invert')).toMatchObject({ adjustment: { type: 'invert' } });
    expect(byName.get('Placed')).toMatchObject({ placedLayer: { type: 'raster', width: 1, height: 1 } });
    expect(raw.linkedFiles?.[0]?.data).toEqual(source);
    expect(output.notices).toEqual([]);
  });

  it('round-trips all ten live styles, writes the referenced pattern block, and preserves CPU pixels', () => {
    const red = { red: 0.8, green: 0.1, blue: 0.2 }, green = { red: 0.1, green: 0.8, blue: 0.3 };
    const blue = { red: 0.2, green: 0.3, blue: 0.9 };
    const pattern = new Uint8Array([
      255, 20, 30, 255, 10, 240, 50, 255,
      30, 40, 250, 255, 230, 220, 10, 255,
    ]);
    // Keep this in the reader's canonical Photoshop stack order. Descriptor percentages round to 0.01;
    // colours and pixel-unit values retain their double precision through ag-psd.
    const effects: LayerEffect[] = [
      { kind: 'dropShadow', schemaVersion: 1, enabled: true, opacity: 0.75, angle: 35, useGlobalLight: false,
        distance: 2, blur: 4, size: 4, spread: 12, color: red, blendMode: 'multiply', contour: 'linear', noise: 0, knockout: true },
      Object.assign({ kind: 'outerGlow' as const, schemaVersion: 1 as const, enabled: true, opacity: 0.45, color: green,
        blendMode: 'screen' as const, spread: 8, size: 3, contour: 'linear' as const, noise: 0 as const }, {
        psdRange: 0.43, psdGradient: { stops: [
          { offset: 0, color: red, opacity: 1 }, { offset: 1, color: green, opacity: 0.25 },
        ] },
      }) as LayerEffect,
      { kind: 'colorOverlay', schemaVersion: 1, enabled: false, opacity: 0.3, color: blue, blendMode: 'color' },
      { kind: 'gradientOverlay', schemaVersion: 1, enabled: true, opacity: 0.55, blendMode: 'overlay', angle: 70,
        scale: 115, gradient: { reverse: false, stops: [
          { offset: 0, color: red, opacity: 1 }, { offset: 1, color: blue, opacity: 0.5 },
        ] } },
      { kind: 'patternOverlay', schemaVersion: 1, enabled: true, opacity: 0.85, blendMode: 'normal',
        resourceId: 'style-pattern', patternWidth: 2, patternHeight: 2, scale: 125, angle: 15,
        linkWithLayer: false, phase: { x: 2, y: -1 } },
      { kind: 'satin', schemaVersion: 1, enabled: true, opacity: 0.4, blendMode: 'multiply', color: blue,
        angle: 22, distance: 3, size: 5, invert: true, contour: 'linear' },
      { kind: 'innerGlow', schemaVersion: 1, enabled: true, opacity: 0.6, blendMode: 'screen', color: green,
        source: 'center', choke: 4, size: 5, contour: 'linear' },
      { kind: 'innerShadow', schemaVersion: 1, enabled: true, opacity: 0.5, blendMode: 'multiply', color: red,
        angle: 125, useGlobalLight: true, distance: 2, choke: 6, size: 4, contour: 'linear' },
      { kind: 'stroke', schemaVersion: 1, enabled: true, width: 1, position: 'inside',
        fill: { kind: 'color', color: green }, opacity: 0.65, blendMode: 'normal' },
      { kind: 'bevelEmboss', schemaVersion: 1, enabled: true, style: 'pillowEmboss', technique: 'chiselSoft',
        depth: 225, direction: 'down', size: 3, soften: 1, angle: 40, altitude: 25, useGlobalLight: false,
        highlightMode: 'screen', highlightColor: green, highlightOpacity: 0.8,
        shadowMode: 'multiply', shadowColor: red, shadowOpacity: 0.65, glossContour: 'linear' },
    ];
    const raster = solid(8, 8, [90, 120, 170, 220]);
    const styled = newLayer({ id: 'styled', name: 'All styles', raster,
      transform: makeTransform({ x: 6, y: 6 }, { width: 8, height: 8 }), effects });
    const input = document([styled], { width: 20, height: 20, resources: [
      { id: 'style-pattern', role: 'pattern', mime: 'application/x-fernwork-rgba8', bytes: pattern },
    ] });
    const expected = cpuCompositeRegion(input, { x: 0, y: 0, width: 20, height: 20 });
    const output = writePsdDocument(input);
    const raw = readPsd(output.bytes, { useImageData: true, skipThumbnail: true });
    const rawPattern = raw.patterns?.[0];
    expect(rawPattern).toMatchObject({ bounds: { w: 2, h: 2 }, data: pattern });
    expect(raw.children?.[0]?.effects?.patternOverlay?.pattern?.id).toBe(rawPattern?.id);

    const reopened = readPsdDocument(output.bytes);
    const actualEffects = reopened.document.layers[0]!.effects;
    expect(actualEffects.map((effect) => effect.kind)).toEqual(effects.map((effect) => effect.kind));
    expect(comparableEffects(actualEffects)).toEqual(comparableEffects(effects));
    expect(reopened.document.resources?.[0]?.bytes).toEqual(pattern);
    const actual = cpuCompositeRegion(reopened.document, { x: 0, y: 0, width: 20, height: 20 });
    expect(maximumDifference(actual, expected)).toBeLessThanOrEqual(1);
    expect(output.notices).toEqual([]);
  });

  it('writes editable Photoshop text warp descriptors and rasterizes text paths with a notice', () => {
    const transform = makeTransform({ x: 1, y: 1 }, { width: 4, height: 2 }, { sampling: 'Nearest' });
    const textBase = { kind: 'text' as const, transform, text: 'Bent',
      runs: [{ from: 0, to: 4, style: { ...DEFAULT_TEXT_STYLE, fontFamily: 'Noto Sans', fontSize: 18 } }],
      raster: solid(4, 2, [40, 80, 120, 255]) };
    const textWarp = { schemaVersion: 1 as const, style: 'arcUpper' as const, orientation: 'vertical' as const, bend: 37,
      horizontalDistortion: -12, verticalDistortion: 18 };
    const warped = newLayer({ id: 'warped', name: 'Warped', ...textBase, textWarp });
    const path = { schemaVersion: 1 as const, closed: false, fillRule: 'nonzero' as const, points: [
      { anchor: { x: 0, y: 1 }, in: { x: 0, y: 1 }, out: { x: 1, y: 0 }, kind: 'smooth' as const },
      { anchor: { x: 4, y: 1 }, in: { x: 3, y: 2 }, out: { x: 4, y: 1 }, kind: 'smooth' as const },
    ] };
    const onPath = newLayer({ id: 'path', name: 'On path', ...textBase,
      textPath: { schemaVersion: 1, path, start: 0.1, end: 0.9, flipped: false, baselineOffset: 2 } });
    const output = writePsdDocument(document([warped, onPath], { width: 8, height: 4 }));
    const raw = readPsd(output.bytes, { useImageData: true, skipThumbnail: true });
    expect(raw.children?.find((layer) => layer.name === 'Warped')?.text?.warp).toMatchObject({
      style: 'arcUpper', rotate: 'vertical', value: 37, perspective: -12, perspectiveOther: 18,
    });
    expect(raw.children?.find((layer) => layer.name === 'On path')?.text).toBeUndefined();
    const reopened = readPsdDocument(output.bytes);
    expect(reopened.document.layers.find((layer) => layer.name === 'Warped')).toMatchObject({
      kind: 'text', textWarp,
    });
    expect(reopened.document.layers.find((layer) => layer.name === 'On path')?.kind).toBe('pixel');
    expect(output.notices).toContainEqual(expect.objectContaining({ code: 'text-path-rasterized', layerPath: 'On path' }));
  });

  it('bakes a non-destructive crop into real layer pixels and notices an unresolved pattern resource', () => {
    const raster = Raster.fromPixels(3, 1, 4, new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
    ]));
    const missingPattern: LayerEffect = { kind: 'patternOverlay', schemaVersion: 1, enabled: true, opacity: 1,
      blendMode: 'normal', resourceId: 'absent', patternWidth: 2, patternHeight: 2, scale: 100, angle: 0,
      linkWithLayer: true };
    const cropped = newLayer({ id: 'cropped', name: 'Cropped', raster,
      transform: makeTransform({ x: 0, y: 0 }, { width: 3, height: 1 }, { sampling: 'Nearest' }),
      crop: { rect: { x: 1, y: 0, width: 1, height: 1 }, feather: 0 }, effects: [missingPattern] });
    const input = document([cropped], { width: 3, height: 1 });
    const expected = cpuCompositeRegion(input, { x: 0, y: 0, width: 3, height: 1 });
    const output = writePsdDocument(input);
    expect(output.notices).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'pattern-overlay-resource', layerPath: 'Cropped' }),
      expect.objectContaining({ code: 'non-destructive-crop', layerPath: 'Cropped' }),
    ]));
    const reopened = readPsdDocument(output.bytes);
    expect(reopened.document.layers[0]).toMatchObject({ kind: 'pixel', crop: null });
    const actual = cpuCompositeRegion(reopened.document, { x: 0, y: 0, width: 3, height: 1 });
    expect(maximumDifference(actual, expected)).toBeLessThanOrEqual(1);
  });

  it('writes quad and mesh warps of placed layers so they reopen as the same warp', () => {
    const transform = makeTransform({ x: 0, y: 0 }, { width: 4, height: 2 }, { sampling: 'Nearest' });
    const base = createMeshWarp(transform);
    const mesh = { ...base, points: base.points.map((point, index) => (index % 4 === 2 ? { ...point, y: point.y - 0.5 } : point)) };
    const quad = { kind: 'quad' as const, schemaVersion: 1 as const,
      corners: [{ x: 0.5, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 2 }] as const };
    const source = encodePng(solid(1, 1, [30, 40, 50, 255]).toPixels(), 1, 1, 4);
    const placed = (id: string, warp: typeof mesh | typeof quad) => newLayer({ id, name: id, kind: 'embedded', transform, warp,
      raster: solid(4, 2, [30, 40, 50, 255]), content: { mode: 'embedded', mediaType: 'image', assetId: 'placed-source',
        sourceName: 'source.png', width: 1, height: 1 } });
    const input = document([placed('Mesh', mesh), placed('Quad', quad)], { resources: [
      { id: 'placed-source', role: 'embedded', mime: 'image/png', bytes: source },
    ] });
    const reopened = readPsdDocument(writePsdDocument(input).bytes).document.layers;
    const byName = new Map(reopened.map((layer) => [layer.name, layer]));
    const meshBack = byName.get('Mesh')?.warp, quadBack = byName.get('Quad')?.warp;
    expect(meshBack?.kind).toBe('mesh');
    if (meshBack?.kind === 'mesh') meshBack.points.forEach((point, index) => {
      expect(point.x).toBeCloseTo(mesh.points[index]!.x, 3);
      expect(point.y).toBeCloseTo(mesh.points[index]!.y, 3);
    });
    expect(quadBack?.kind).toBe('quad');
    if (quadBack?.kind === 'quad') quadBack.corners.forEach((point, index) => {
      expect(point.x).toBeCloseTo(quad.corners[index]!.x, 3);
      expect(point.y).toBeCloseTo(quad.corners[index]!.y, 3);
    });
  });

  it('preserves 16-bit layer samples, writes PSB headers, and reports every rasterized unsupported feature', () => {
    const full = makeTransform({ x: 0, y: 0 }, { width: 1, height: 1 });
    const wide = Raster.fromPixels(1, 1, 4, new Uint16Array([1234, 23456, 45678, 65535]), { format: 'rgba16' });
    const pixel = newLayer({ id: 'wide', name: 'Wide', transform: full, raster: wide });
    const filtered = newLayer({ id: 'filtered', name: 'Filtered', transform: full, raster: solid(1, 1, [18, 52, 86, 255]),
      filters: [{ kind: 'gaussianBlur', schemaVersion: 1, enabled: true, radius: 2 }],
      crop: { rect: { x: 0, y: 0, width: 1, height: 1 }, feather: 0 } });
    const grain = newLayer({ id: 'grain', name: 'Grain', transform: full,
      adjustment: { kind: 'Grain', schemaVersion: 1, parameters: { amount: 10, size: 2, roughness: 50, seed: 1 } } });
    const output = writePsdDocument({ ...document([pixel, filtered, grain]), width: 1, height: 1 }, { format: 'psb' });
    expect(output.bitsPerChannel).toBe(16);
    expect(new DataView(output.bytes.buffer, output.bytes.byteOffset).getUint16(4)).toBe(2);
    expect(output.notices.map((entry) => entry.code)).toEqual(expect.arrayContaining(
      ['live-filters', 'non-destructive-crop', 'adjustment:Grain']));
    expect(output.notices.map((entry) => entry.code)).not.toContain('16-bit-precision');
    const reopened = readPsdDocument(output.bytes);
    expect(reopened.source).toMatchObject({ bitsPerChannel: 16, isPsb: true });
    expect(reopened.document.layers.map((layer) => [layer.name, layer.raster?.format, layer.kind]))
      .toEqual([['Wide', 'rgba16', 'pixel'], ['Filtered', 'rgba16', 'pixel'], ['Grain', 'rgba16', 'pixel']]);
    expect(reopened.document.layers[0]?.raster?.toPixelsNative()).toEqual(wide.toPixelsNative());
  });

  it('keeps transformed layer and merged composite precision native in 16-bit output', () => {
    const source = Raster.fromPixels(2, 1, 4, new Uint16Array([
      1_001, 20_003, 40_007, 65_535, 50_009, 30_011, 10_013, 50_015,
    ]), { format: 'rgba16' });
    const transformed = newLayer({ id: 'wide-transform', name: 'Wide transform', raster: source,
      transform: makeTransform({ x: 0, y: 0 }, { width: 3, height: 1 }, { sampling: 'Smooth' }) });
    const background = newLayer({ id: 'background', name: 'Background', raster: solid(3, 1, [0, 0, 0, 255]),
      transform: makeTransform({ x: 0, y: 0 }, { width: 3, height: 1 }) });
    const input = document([background, transformed], { width: 3, height: 1 });
    const output = writePsdDocument(input, { bitsPerChannel: 16 });
    const reopened = readPsdDocument(output.bytes);
    const samples = reopened.document.layers.find((layer) => layer.name === 'Wide transform')?.raster?.toPixelsNative();
    expect(samples).toBeInstanceOf(Uint16Array);
    expect([...samples!].some((value) => value % 257 !== 0)).toBe(true);
    expect(output.notices.map((entry) => entry.code)).not.toEqual(expect.arrayContaining([
      'rasterized-16-bit-transform', '16-bit-precision',
    ]));
    const composite = readRawPsdComposite(output.bytes);
    expect(composite.bitsPerChannel).toBe(16);
    const raw = readPsd(output.bytes, { useImageData: true, skipThumbnail: true });
    expect(raw.imageData?.data).toBeInstanceOf(Uint16Array);
    expect([...raw.imageData!.data].some((value) => value % 257 !== 0)).toBe(true);
  });
});
