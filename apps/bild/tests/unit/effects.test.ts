import { describe, expect, it } from 'vitest';
import { writePsdUint8Array, type LayerEffectsInfo, type Psd } from 'ag-psd';
import { compositeRegion } from '../../src/core/composite';
import { documentWithLayerEffects } from '../../src/core/effects/document';
import { renderEffectPasses } from '../../src/core/effects/render';
import { newLayer, type CanvasDocument, type LayerEffect } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import { decodePng } from '../../src/io/png';
import { readArchive, writeArchive } from '../../src/io/project';
import { readPsdDocument } from '../../src/io/psd';

const red = { red: 1, green: 0, blue: 0 };
const green = { red: 0, green: 1, blue: 0 };
const blue = { red: 0, green: 0, blue: 1 };

function generatedEffectPsd(effects: LayerEffectsInfo, hidden = false): ReturnType<typeof readPsdDocument> {
  const imageData = { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) };
  return readPsdDocument(writePsdUint8Array({ width: 1, height: 1, imageData,
    children: [{ name: 'Flag', top: 0, left: 0, bottom: 1, right: 1, imageData, hidden, effects }] },
  { generateThumbnail: false }));
}

function at(pass: ReturnType<typeof renderEffectPasses>[number], x: number, y: number): number[] {
  return pass.raster.pixel(x - pass.sourceX, y - pass.sourceY);
}

describe('layer effects (PRODUCT-PLAN 6.7)', () => {
  it('renders a hand-computed one-pixel drop shadow and honours knockout/global light', () => {
    const effect: LayerEffect = { kind: 'dropShadow', schemaVersion: 1, enabled: true, opacity: 0.5,
      angle: 90, useGlobalLight: true, distance: 1, blur: 0, size: 0, spread: 0, color: red,
      blendMode: 'multiply', contour: 'linear', noise: 0, knockout: true };
    const [pass] = renderEffectPasses(new Uint8Array([255]), 1, 1, [effect], { globalLightAngle: 0 });
    expect(pass).toMatchObject({ placement: 'behind', blendMode: 'multiply', opacity: 0.5 });
    expect(at(pass!, -1, 0)).toEqual([255, 0, 0, 255]);
    expect(at(pass!, 0, 0)[3]).toBe(0);
  });

  it('renders inside/center/outside stroke geometry with colour and gradient fills', () => {
    const alpha = new Uint8Array([0, 255, 0]);
    const outside: LayerEffect = { kind: 'stroke', schemaVersion: 1, enabled: true, width: 1,
      position: 'outside', fill: { kind: 'color', color: green }, opacity: 1, blendMode: 'normal' };
    const [pass] = renderEffectPasses(alpha, 3, 1, [outside]);
    expect(at(pass!, 0, 0)).toEqual([0, 255, 0, 255]);
    expect(at(pass!, 1, 0)[3]).toBe(0);
    expect(at(pass!, 2, 0)).toEqual([0, 255, 0, 255]);

    const gradientStroke: LayerEffect = { kind: 'stroke', schemaVersion: 1, enabled: true, width: 1,
      position: 'inside', fill: { kind: 'gradient', angle: 0, scale: 100, gradient: { stops: [
        { offset: 0, color: red, opacity: 1 }, { offset: 1, color: blue, opacity: 1 },
      ] } } };
    const [gradient] = renderEffectPasses(new Uint8Array([255, 255]), 2, 1, [gradientStroke]);
    expect(at(gradient!, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(at(gradient!, 1, 0)).toEqual([0, 0, 255, 255]);
  });

  it('positions an antialiased stroke edge from source coverage', () => {
    const effect: LayerEffect = { kind: 'stroke', schemaVersion: 1, enabled: true, width: 1,
      position: 'outside', color: red };
    const [pass] = renderEffectPasses(new Uint8Array([255, 64, 0, 0]), 4, 1, [effect]);
    // The 25%-covered edge pixel moves the outer boundary by 0.25 px, leaving 25% in the next pixel.
    expect(at(pass!, 2, 0)).toEqual([255, 0, 0, 64]);
    expect(at(pass!, 3, 0)[3]).toBe(0);
  });

  it('renders the linear distance contour for an outer glow', () => {
    const effect: LayerEffect = { kind: 'outerGlow', schemaVersion: 1, enabled: true, opacity: 0.75,
      color: blue, blendMode: 'screen', spread: 0, size: 2, contour: 'linear', noise: 0 };
    const [pass] = renderEffectPasses(new Uint8Array([255]), 1, 1, [effect]);
    expect(pass).toMatchObject({ placement: 'behind', blendMode: 'screen', opacity: 0.75 });
    expect(at(pass!, 1, 0)).toEqual([0, 0, 255, 128]);
    expect(at(pass!, 2, 0)[3]).toBe(0);
  });

  it('applies an imported Photoshop contour curve to effect coverage', () => {
    const effect = Object.assign({ kind: 'outerGlow' as const, schemaVersion: 1 as const, enabled: true, opacity: 1,
      color: blue, blendMode: 'screen' as const, spread: 0, size: 2, contour: 'linear' as const, noise: 0 as const }, {
      psdContour: [{ x: 0, y: 0 }, { x: 128, y: 64 }, { x: 255, y: 255 }],
    }) as LayerEffect;
    const [pass] = renderEffectPasses(new Uint8Array([255]), 1, 1, [effect]);
    expect(at(pass!, 1, 0)).toEqual([0, 0, 255, 64]);
  });

  it('maps an imported Photoshop glow gradient over contour coverage', () => {
    const effect = Object.assign({ kind: 'outerGlow' as const, schemaVersion: 1 as const, enabled: true, opacity: 1,
      color: blue, blendMode: 'screen' as const, spread: 0, size: 2, contour: 'linear' as const, noise: 0 as const }, {
      psdGradient: { stops: [
        { offset: 0, color: red, opacity: 0.5 },
        { offset: 1, color: blue, opacity: 1 },
      ] }, psdRange: 0.5,
    }) as LayerEffect;
    const [pass] = renderEffectPasses(new Uint8Array([255]), 1, 1, [effect]);
    expect(at(pass!, 1, 0)).toEqual([128, 0, 128, 96]);
  });

  it('renders colour and gradient overlays from source alpha and marks them as Fill Opacity content', () => {
    const effects: LayerEffect[] = [
      { kind: 'colorOverlay', schemaVersion: 1, enabled: true, opacity: 0.4, color: green, blendMode: 'normal' },
      { kind: 'gradientOverlay', schemaVersion: 1, enabled: true, opacity: 1, blendMode: 'normal', angle: 0,
        scale: 100, gradient: { stops: [{ offset: 0, color: red, opacity: 1 }, { offset: 1, color: blue, opacity: 0.5 }] } },
    ];
    const passes = renderEffectPasses(new Uint8Array([255, 128]), 2, 1, effects);
    expect(passes[0]).toMatchObject({ scalesWithFillOpacity: true, opacity: 0.4, stackOrder: 2 });
    expect(at(passes[0]!, 1, 0)).toEqual([0, 255, 0, 128]);
    expect(passes[1]).toMatchObject({ scalesWithFillOpacity: true, opacity: 1, stackOrder: 3 });
    expect(at(passes[1]!, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(at(passes[1]!, 1, 0)).toEqual([0, 0, 255, 64]);
  });

  it('renders hand-computed inner shadow and edge/centre inner glow pixels', () => {
    const alpha = new Uint8Array(25);
    for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) alpha[y * 5 + x] = 255;
    const innerShadow: LayerEffect = { kind: 'innerShadow', schemaVersion: 1, enabled: true, opacity: 1,
      blendMode: 'multiply', color: red, angle: 0, useGlobalLight: false, distance: 0, choke: 0, size: 2, contour: 'linear' };
    const edgeGlow: LayerEffect = { kind: 'innerGlow', schemaVersion: 1, enabled: true, opacity: 1,
      blendMode: 'screen', color: green, source: 'edge', choke: 0, size: 2, contour: 'linear' };
    const centreGlow: LayerEffect = { ...edgeGlow, color: blue, source: 'center' };
    const [edge, centre, shadow] = renderEffectPasses(alpha, 5, 5, [innerShadow, edgeGlow, centreGlow]);
    // Boundary pixels are one pixel from transparency: the two-pixel linear contour is exactly 50%.
    expect(at(shadow!, 1, 2)).toEqual([255, 0, 0, 128]);
    expect(at(edge!, 1, 2)).toEqual([0, 255, 0, 128]);
    expect(at(edge!, 2, 2)[3]).toBe(0);
    expect(at(centre!, 1, 2)).toEqual([0, 0, 255, 128]);
    expect(at(centre!, 2, 2)).toEqual([0, 0, 255, 255]);
  });

  it('renders hand-computed bevel highlight/shadow sides and satin lobes', () => {
    const alpha = new Uint8Array([0, 255, 255, 255, 0]);
    const bevel: LayerEffect = { kind: 'bevelEmboss', schemaVersion: 1, enabled: true, style: 'innerBevel',
      technique: 'chiselHard', depth: 100, direction: 'up', size: 1, soften: 0, angle: 0, altitude: 0,
      useGlobalLight: false, highlightMode: 'screen', highlightColor: green, highlightOpacity: 1,
      shadowMode: 'multiply', shadowColor: red, shadowOpacity: 1, glossContour: 'linear' };
    const satin: LayerEffect = { kind: 'satin', schemaVersion: 1, enabled: true, opacity: 1, blendMode: 'multiply',
      color: blue, angle: 0, distance: 1, size: 1, invert: false, contour: 'linear' };
    const [satinPass, highlight, shadow] = renderEffectPasses(alpha, 5, 1, [bevel, satin]);
    // A 0° light sees the right outward normal and shades the left; hard chisel makes both full coverage.
    expect(at(highlight!, 3, 0)).toEqual([0, 255, 0, 255]);
    expect(at(shadow!, 1, 0)).toEqual([255, 0, 0, 255]);
    // Satin compares the two one-pixel-shifted edge ramps: the two inner edge pixels differ by one.
    expect(at(satinPass!, 1, 0)).toEqual([0, 0, 255, 255]);
    expect(at(satinPass!, 2, 0)[3]).toBe(0);
    expect(at(satinPass!, 3, 0)).toEqual([0, 0, 255, 255]);
  });

  it('tiles a hand-computed embedded pattern resource through the live pattern overlay', () => {
    const pattern = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
    const effect: LayerEffect = { kind: 'patternOverlay', schemaVersion: 1, enabled: true, opacity: 1,
      blendMode: 'normal', resourceId: 'pattern', patternWidth: 2, patternHeight: 1,
      scale: 100, angle: 0, linkWithLayer: false };
    const layer = newLayer({ id: 'patterned', name: 'Patterned', raster: Raster.fromPixels(4, 1, 4,
      new Uint8Array(16).fill(255)), transform: makeTransform({ x: 0, y: 0 }, { width: 4, height: 1 }), effects: [effect] });
    const document: CanvasDocument = { id: 'pattern-doc', width: 4, height: 1, resolution: 72, selection: null,
      resources: [{ id: 'pattern', role: 'pattern', mime: 'application/x-fernwork-rgba8', bytes: pattern }], layers: [layer] };
    const expanded = documentWithLayerEffects(document, { transform: (value) => value.transform,
      maskPlacement: (value) => value.mask?.placement ?? null, raster: (value) => value.raster,
      maskRaster: (value) => value.mask?.raster });
    expect(expanded.layers[1]!.raster!.toPixels()).toEqual(new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255,
    ]));

    const disabled = { ...effect, enabled: false };
    const color: LayerEffect = { kind: 'colorOverlay', schemaVersion: 1, enabled: true, opacity: 1,
      blendMode: 'normal', color: blue };
    const disabledLayer = { ...layer, effects: [disabled, color] };
    const withoutPattern = documentWithLayerEffects({ ...document, layers: [disabledLayer] }, {
      transform: (value) => value.transform, maskPlacement: (value) => value.mask?.placement ?? null,
      raster: (value) => value.raster, maskRaster: (value) => value.mask?.raster,
    });
    expect(withoutPattern.layers).toHaveLength(2);
    expect(withoutPattern.layers[1]!.raster!.pixel(0, 0)).toEqual([0, 0, 255, 255]);
  });

  it('enlarges render bounds and keeps stroke independent from Fill Opacity', () => {
    const layer = newLayer({ id: 'styled', name: 'Styled', raster: Raster.fromPixels(1, 1, 4, [255, 0, 0, 255]),
      transform: makeTransform({ x: 1, y: 0 }, { width: 1, height: 1 }, { sampling: 'Nearest' }), fillOpacity: 0,
      effects: [{ kind: 'stroke', schemaVersion: 1, enabled: true, width: 1, position: 'outside', color: green }] });
    const document: CanvasDocument = { id: 'doc', width: 3, height: 1, resolution: 72, selection: null, layers: [layer] };
    const hooks = { transform: (value: typeof layer) => value.transform,
      maskPlacement: (value: typeof layer) => value.mask?.placement ?? null,
      raster: (value: typeof layer) => value.raster, maskRaster: (value: typeof layer) => value.mask?.raster };
    const expanded = documentWithLayerEffects(document, hooks);
    expect(expanded.layers).toHaveLength(2);
    expect(compositeRegion(expanded, { x: 0, y: 0, width: 3, height: 1 }).rgba).toEqual(
      new Uint8Array([0, 255, 0, 255, 0, 0, 0, 0, 0, 255, 0, 255]));
  });

  it('builds a group effect source from the unbounded descendant surface', () => {
    const group = newLayer({ id: 'group', name: 'Group', kind: 'group',
      transform: makeTransform({ x: 0, y: 0 }, { width: 2, height: 1 }),
      effects: [{ kind: 'stroke', schemaVersion: 1, enabled: true, width: 1,
        position: 'outside', color: green }] });
    const child = newLayer({ id: 'child', parentId: 'group', name: 'Off canvas',
      raster: Raster.fromPixels(1, 1, 4, [255, 0, 0, 255]),
      transform: makeTransform({ x: -1, y: 0 }, { width: 1, height: 1 }, { sampling: 'Nearest' }) });
    const document: CanvasDocument = { id: 'group-style', width: 2, height: 1, resolution: 72,
      selection: null, layers: [group, child] };
    const expanded = documentWithLayerEffects(document, { transform: (value) => value.transform,
      maskPlacement: (value) => value.mask?.placement ?? null, raster: (value) => value.raster,
      maskRaster: (value) => value.mask?.raster });
    expect(compositeRegion(expanded, { x: 0, y: 0, width: 2, height: 1 }).rgba.slice(0, 4))
      .toEqual(new Uint8Array([0, 255, 0, 255]));
  });

  it('traces vector effects from editable path coverage rather than a stale raster alpha cache', () => {
    const point = (x: number, y: number) => ({ in: { x, y }, anchor: { x, y }, out: { x, y }, kind: 'corner' as const });
    const layer = newLayer({ id: 'vector', name: 'Vector', kind: 'vector',
      raster: Raster.fromPixels(2, 1, 4, [0, 0, 0, 255, 0, 0, 0, 0]),
      transform: makeTransform({ x: 0, y: 0 }, { width: 2, height: 1 }),
      paths: [{ schemaVersion: 1, closed: true, fillRule: 'nonzero',
        points: [point(0, 0), point(2, 0), point(2, 1), point(0, 1)] }],
      style: { schemaVersion: 1, fill: null, stroke: null },
      effects: [{ kind: 'colorOverlay', schemaVersion: 1, enabled: true, opacity: 1, color: red }] });
    const document: CanvasDocument = { id: 'vector-style', width: 2, height: 1, resolution: 72,
      selection: null, layers: [layer] };
    const expanded = documentWithLayerEffects(document, { transform: (value) => value.transform,
      maskPlacement: (value) => value.mask?.placement ?? null, raster: (value) => value.raster,
      maskRaster: (value) => value.mask?.raster });
    expect(expanded.layers[1]!.raster!.toPixels()).toEqual(new Uint8Array([
      255, 0, 0, 255, 255, 0, 0, 255,
    ]));
  });

  it('clips effects on clipped layers only when the PSD base groups clipped elements', () => {
    const raster = Raster.fromPixels(1, 1, 4, [255, 255, 255, 255]);
    const transform = makeTransform({ x: 0, y: 0 }, { width: 1, height: 1 });
    const clipped = newLayer({ id: 'clip', name: 'Clip', raster, transform, maskSourceId: 'base',
      effects: [{ kind: 'colorOverlay', schemaVersion: 1, enabled: true, opacity: 1, color: red }] });
    const hooks = { transform: (value: typeof clipped) => value.transform,
      maskPlacement: (value: typeof clipped) => value.mask?.placement ?? null,
      raster: (value: typeof clipped) => value.raster, maskRaster: (value: typeof clipped) => value.mask?.raster };
    const expanded = (blendClippedElements: boolean) => {
      const base = { ...newLayer({ id: 'base', name: 'Base', raster, transform }),
        psdBlendClippedElements: blendClippedElements };
      return documentWithLayerEffects({ id: `clip-${blendClippedElements}`, width: 1, height: 1, resolution: 72,
        selection: null, layers: [base, clipped] }, hooks);
    };
    expect(expanded(true).layers[2]!.maskSourceId).toBe('base');
    expect(expanded(false).layers[2]!.maskSourceId).toBeNull();
  });

  it('scales document-pixel effects to an oversampled derived raster', () => {
    const raster = Raster.fromPixels(16, 16, 4, new Uint8Array(16 * 16 * 4).fill(255));
    const layer = newLayer({ id: 'text', name: 'Text', kind: 'text', text: 'A', raster,
      transform: makeTransform({ x: 2, y: 2 }, { width: 4, height: 4 }),
      effects: [{ kind: 'stroke', schemaVersion: 1, enabled: true, width: 1,
        position: 'outside', color: green }] });
    const hooks = { transform: (value: typeof layer) => value.transform,
      maskPlacement: (value: typeof layer) => value.mask?.placement ?? null,
      raster: (value: typeof layer) => value.raster, maskRaster: (value: typeof layer) => value.mask?.raster };
    const expanded = documentWithLayerEffects({ id: 'doc', width: 8, height: 8, resolution: 72,
      selection: null, layers: [layer] }, hooks);
    const effect = expanded.layers[1]!;
    // One document pixel is four cache pixels; transparent padding stays aligned to that cache grid.
    expect(effect.raster?.width).toBe(32);
    expect(effect.transform.size.width).toBeCloseTo(8);
  });

  it('FIX-PERF: regenerates no effects and reuses the expanded document across 60 unchanged frames', () => {
    const layer = newLayer({ id: 'stable-style', name: 'Stable', raster: Raster.fromPixels(2, 1, 4,
      [255, 0, 0, 255, 0, 0, 0, 0]), transform: makeTransform({ x: 0, y: 0 }, { width: 2, height: 1 }), effects: [
      { kind: 'stroke', schemaVersion: 1, enabled: true, width: 1, position: 'outside', color: green },
    ] });
    const document: CanvasDocument = { id: 'stable-effects', width: 2, height: 1, resolution: 72,
      selection: null, layers: [layer] };
    const hooks = { transform: (value: typeof layer) => value.transform,
      maskPlacement: (value: typeof layer) => value.mask?.placement ?? null,
      raster: (value: typeof layer) => value.raster, maskRaster: (value: typeof layer) => value.mask?.raster };
    const diagnostics = { effectRegenerations: 0 };
    const first = documentWithLayerEffects(document, hooks, diagnostics);
    expect(diagnostics.effectRegenerations).toBe(1);
    for (let frame = 0; frame < 60; frame++) expect(documentWithLayerEffects(document, hooks, diagnostics)).toBe(first);
    expect(diagnostics.effectRegenerations).toBe(1);
  });

  it('caches a scaled text effect across unchanged frames', () => {
    const raster = Raster.fromPixels(16, 16, 4, new Uint8Array(16 * 16 * 4).fill(255));
    const layer = newLayer({ id: 'cached-text', name: 'Cached text', kind: 'text', text: 'A', raster,
      transform: makeTransform({ x: 2, y: 2 }, { width: 4, height: 4 }),
      effects: [{ kind: 'stroke', schemaVersion: 1, enabled: true, width: 1,
        position: 'outside', color: green }] });
    const document: CanvasDocument = { id: 'cached-scaled-effects', width: 8, height: 8, resolution: 72,
      selection: null, layers: [layer] };
    const hooks = { transform: (value: typeof layer) => value.transform,
      maskPlacement: (value: typeof layer) => value.mask?.placement ?? null,
      raster: (value: typeof layer) => value.raster, maskRaster: (value: typeof layer) => value.mask?.raster };
    const diagnostics = { effectRegenerations: 0 };
    const first = documentWithLayerEffects(document, hooks, diagnostics);
    expect(first.layers[1]!.raster?.width).toBe(32);
    for (let frame = 0; frame < 60; frame++) expect(documentWithLayerEffects(document, hooks, diagnostics)).toBe(first);
    expect(diagnostics.effectRegenerations).toBe(1);
  });

  it('derives effects from alpha after the layer mask', () => {
    const layer = newLayer({ id: 'masked', name: 'Masked', raster: Raster.fromPixels(2, 1, 4,
      [255, 255, 255, 255, 255, 255, 255, 255]), transform: makeTransform({ x: 0, y: 0 }, { width: 2, height: 1 }),
      mask: { raster: Raster.fromPixels(2, 1, 1, [255, 0]), enabled: true, placement: null, linked: true },
      effects: [{ kind: 'colorOverlay', schemaVersion: 1, enabled: true, opacity: 1, color: red }] });
    const hooks = { transform: (value: typeof layer) => value.transform,
      maskPlacement: (value: typeof layer) => value.mask?.placement ?? null,
      raster: (value: typeof layer) => value.raster, maskRaster: (value: typeof layer) => value.mask?.raster };
    const expanded = documentWithLayerEffects({ id: 'doc', width: 2, height: 1, resolution: 72,
      selection: null, layers: [layer] }, hooks);
    expect(expanded.layers[1]!.raster!.toPixels()).toEqual(new Uint8Array([255, 0, 0, 255, 255, 0, 0, 0]));
  });

  it('makes style editing, live dragging, copy/paste, clear and global light undoable', () => {
    const transform = makeTransform({ x: 0, y: 0 }, { width: 1, height: 1 });
    const layers = ['a', 'b'].map((id) => newLayer({ id, name: id, transform, raster: Raster.fromPixels(1, 1, 4, [1, 2, 3, 255]) }));
    const session = new EditorSession();
    session.installProject({ id: 'doc', width: 1, height: 1, resolution: 72, selection: null, layers }, 'a', 'Style');
    const shadow: LayerEffect = { kind: 'dropShadow', schemaVersion: 1, enabled: true, opacity: 1,
      angle: 120, distance: 2, blur: 3, color: red };
    expect(session.addLayerEffect('a', shadow)).toBe(true);
    expect(session.addLayerEffect('a', { ...shadow, opacity: Number.NaN })).toBe(false);
    expect(session.beginLayerEffectEdit('a')).toBe(true);
    expect(session.setLayerEffectParameters('a', 0, { distance: 5 })).toBe(true);
    expect(session.setLayerEffectParameters('a', 0, { distance: 8 })).toBe(true);
    session.finishLayerEffectEdit();
    expect((session.layer('a')!.effects[0] as typeof shadow).distance).toBe(8);
    expect(session.copyLayerStyle('a')).toHaveLength(1);
    expect(session.pasteLayerStyle('b')).toBe(true);
    expect(session.clearLayerStyle('a')).toBe(true);
    expect(session.setGlobalLightAngle(725)).toBe(true);
    expect(session.document!.globalLightAngle).toBe(5);
    expect(session.undo()).toBe(true);
    expect(session.document!.globalLightAngle).toBeUndefined();
  });

  it('copies an embedded pattern resource with a layer style across documents', () => {
    const transform = makeTransform({ x: 0, y: 0 }, { width: 1, height: 1 });
    const effect: LayerEffect = { kind: 'patternOverlay', schemaVersion: 1, enabled: true, opacity: 1,
      blendMode: 'normal', resourceId: 'copied-pattern', patternWidth: 1, patternHeight: 1,
      scale: 100, angle: 0, linkWithLayer: true };
    const session = new EditorSession();
    session.installProject({ id: 'source', width: 1, height: 1, resolution: 72, selection: null,
      resources: [{ id: 'copied-pattern', role: 'pattern', mime: 'application/x-fernwork-rgba8',
        bytes: new Uint8Array([4, 8, 12, 255]) }], layers: [newLayer({ id: 'a', name: 'a', transform,
        raster: Raster.fromPixels(1, 1, 4, [255, 255, 255, 255]), effects: [effect] })] }, 'a', 'Source');
    session.copyLayerStyle('a');
    session.installProject({ id: 'target', width: 1, height: 1, resolution: 72, selection: null,
      layers: [newLayer({ id: 'b', name: 'b', transform, raster: Raster.fromPixels(1, 1, 4, [255, 255, 255, 255]) })] }, 'b', 'Target');
    expect(session.pasteLayerStyle('b')).toBe(true);
    expect(session.layer('b')!.effects).toEqual([effect]);
    expect(session.document!.resources).toEqual([{ id: 'copied-pattern', role: 'pattern',
      mime: 'application/x-fernwork-rgba8', bytes: new Uint8Array([4, 8, 12, 255]) }]);
  });

  it('round-trips every editable style parameter, pattern resource and global light in format v2', async () => {
    const effects: LayerEffect[] = [
      { kind: 'dropShadow', schemaVersion: 1, enabled: true, opacity: 0.8, angle: 30, useGlobalLight: true,
        distance: 4, blur: 6, size: 6, spread: 25, color: red, blendMode: 'multiply', contour: 'linear', noise: 0, knockout: true },
      { kind: 'stroke', schemaVersion: 1, enabled: true, width: 2, position: 'center', opacity: 0.6,
        blendMode: 'screen', fill: { kind: 'gradient', angle: 45, scale: 80, gradient: { reverse: true, stops: [
          { offset: 0, color: red, opacity: 1 }, { offset: 1, color: blue, opacity: 0.5 },
        ] } } },
      { kind: 'outerGlow', schemaVersion: 1, enabled: true, opacity: 0.5, color: green,
        blendMode: 'screen', spread: 10, size: 7, contour: 'linear', noise: 0 },
      { kind: 'colorOverlay', schemaVersion: 1, enabled: false, opacity: 0.4, color: blue, blendMode: 'color' },
      { kind: 'gradientOverlay', schemaVersion: 1, enabled: true, opacity: 0.7, blendMode: 'overlay', angle: 90,
        scale: 120, gradient: { stops: [{ offset: 0, color: red, opacity: 1 }, { offset: 1, color: green, opacity: 1 }] } },
      { kind: 'innerShadow', schemaVersion: 1, enabled: true, opacity: 0.4, blendMode: 'multiply', color: red,
        angle: 30, useGlobalLight: true, distance: 4, choke: 12, size: 8, contour: 'linear' },
      { kind: 'innerGlow', schemaVersion: 1, enabled: true, opacity: 0.6, blendMode: 'screen', color: green,
        source: 'center', choke: 3, size: 9, contour: 'linear' },
      { kind: 'bevelEmboss', schemaVersion: 1, enabled: true, style: 'pillowEmboss', technique: 'chiselSoft',
        depth: 220, direction: 'down', size: 7, soften: 2, angle: 40, altitude: 25, useGlobalLight: false,
        highlightMode: 'screen', highlightColor: green, highlightOpacity: 0.8,
        shadowMode: 'multiply', shadowColor: red, shadowOpacity: 0.65, glossContour: 'linear' },
      { kind: 'satin', schemaVersion: 1, enabled: true, opacity: 0.45, blendMode: 'multiply', color: blue,
        angle: 19, distance: 11, size: 14, invert: true, contour: 'linear' },
      { kind: 'patternOverlay', schemaVersion: 1, enabled: true, opacity: 0.9, blendMode: 'normal',
        resourceId: 'roundtrip-pattern', patternWidth: 1, patternHeight: 1, scale: 125, angle: 15,
        linkWithLayer: true, phase: { x: 2, y: 3 } },
    ];
    const layer = newLayer({ id: 'styled', name: 'Styled', effects,
      raster: Raster.fromPixels(1, 1, 4, [10, 20, 30, 255]), transform: makeTransform({ x: 0, y: 0 }, { width: 1, height: 1 }) });
    const document: CanvasDocument = { id: 'roundtrip', width: 1, height: 1, resolution: 72,
      globalLightAngle: 215, selection: null, layers: [layer], resources: [{ id: 'roundtrip-pattern', role: 'pattern',
        mime: 'application/x-fernwork-rgba8', bytes: new Uint8Array([2, 4, 6, 255]) }] };
    const archive = writeArchive(document, 'Styles', 'styled');
    const loaded = await readArchive(archive.blob, async (bytes) => {
      const decoded = decodePng(bytes); return { width: decoded.width, height: decoded.height, channels: decoded.channels, data: decoded.data };
    });
    expect(loaded.document.globalLightAngle).toBe(215);
    expect(loaded.document.layers[0]!.effects).toEqual(effects);
    expect(loaded.document.resources).toEqual(document.resources);
  });

  it('imports the Phase-2 PSD effects as live records and preserves Photoshop global light', () => {
    const imageData = { width: 2, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]) };
    const psd: Psd = { width: 2, height: 1, imageResources: { globalAngle: 33 }, imageData,
      children: [{ name: 'Styled', top: 0, left: 0, bottom: 1, right: 2, imageData, effects: { scale: 2,
        dropShadow: [{ enabled: true, useGlobalLight: true, opacity: 0.7, angle: 10,
          distance: { units: 'Pixels', value: 4 }, size: { units: 'Pixels', value: 6 },
          choke: { units: 'Pixels', value: 20 }, color: { r: 10, g: 20, b: 30 }, blendMode: 'multiply' }],
        outerGlow: { enabled: true, opacity: 0.4, size: { units: 'Pixels', value: 3 },
          choke: { units: 'Pixels', value: 5 }, color: { r: 20, g: 40, b: 80 }, blendMode: 'screen' },
        solidFill: [{ enabled: true, opacity: 0.5, color: { r: 0, g: 255, b: 0 }, blendMode: 'normal' }],
        gradientOverlay: [{ enabled: true, opacity: 0.6, angle: 45, scale: 0.8, blendMode: 'overlay',
          gradient: { name: 'BW', type: 'solid', colorStops: [
            { location: 0, midpoint: 0.5, color: { r: 0, g: 0, b: 0 } },
            { location: 1, midpoint: 0.5, color: { r: 255, g: 255, b: 255 } },
          ], opacityStops: [{ location: 0, midpoint: 0.5, opacity: 1 }, { location: 1, midpoint: 0.5, opacity: 1 }] } }],
        stroke: [{ enabled: true, size: { units: 'Pixels', value: 2 }, position: 'outside', fillType: 'color',
          opacity: 1, color: { r: 255, g: 0, b: 0 }, blendMode: 'normal' }],
      } }] };
    const imported = readPsdDocument(writePsdUint8Array(psd, { generateThumbnail: false }));
    expect(imported.document.globalLightAngle).toBe(33);
    const importedEffects = imported.document.layers[0]!.effects;
    expect(importedEffects.map((effect) => effect.kind))
      .toEqual(['dropShadow', 'outerGlow', 'colorOverlay', 'gradientOverlay', 'stroke']);
    expect(importedEffects.find((effect) => effect.kind === 'stroke')).toMatchObject({ width: 2 });
    expect(importedEffects.find((effect) => effect.kind === 'gradientOverlay')).toMatchObject({ scale: 80,
      gradient: { stops: [{ offset: 0 }, { offset: 1 }] } });
    expect(imported.unsupported.some((issue) => issue.code === 'layer-effects')).toBe(false);
  });

  it('honours the PSD layer-effects master switch', () => {
    const imported = generatedEffectPsd({ disabled: true, solidFill: [{ enabled: true, present: true,
      opacity: 1, color: { r: 255, g: 0, b: 0 }, blendMode: 'normal' }] });
    expect(imported.document.layers[0]!.effects).toEqual([]);
  });

  it('preserves a present but disabled PSD effect without rendering it', () => {
    const imported = generatedEffectPsd({ solidFill: [{ enabled: false, present: true,
      opacity: 1, color: { r: 255, g: 0, b: 0 }, blendMode: 'normal' }] });
    expect(imported.document.layers[0]!.effects).toMatchObject([{ kind: 'colorOverlay', enabled: false }]);
    expect(renderEffectPasses(new Uint8Array([255]), 1, 1, imported.document.layers[0]!.effects)).toEqual([]);
  });

  it('omits a PSD effect whose present flag is false', () => {
    const imported = generatedEffectPsd({ solidFill: [{ enabled: true, present: false,
      opacity: 1, color: { r: 255, g: 0, b: 0 }, blendMode: 'normal' }] });
    expect(imported.document.layers[0]!.effects).toEqual([]);
  });

  it('preserves but does not expand effects on a hidden PSD layer', () => {
    const imported = generatedEffectPsd({ solidFill: [{ enabled: true, present: true,
      opacity: 1, color: { r: 255, g: 0, b: 0 }, blendMode: 'normal' }] }, true);
    const layer = imported.document.layers[0]!;
    expect(layer).toMatchObject({ visible: false, effects: [{ kind: 'colorOverlay', enabled: true }] });
    const expanded = documentWithLayerEffects(imported.document, { transform: (value) => value.transform,
      maskPlacement: (value) => value.mask?.placement ?? null, raster: (value) => value.raster,
      maskRaster: (value) => value.mask?.raster });
    expect(expanded.layers).toHaveLength(1);
  });
});
