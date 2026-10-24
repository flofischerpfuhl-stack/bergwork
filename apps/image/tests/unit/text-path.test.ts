import fs from 'node:fs';
import path from 'node:path';
import { writePsdUint8Array, type Psd } from 'ag-psd';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_TEXT_STYLE, newLayer, type CanvasDocument, type TextLayer, type TextOnPath, type TextWarp, type VectorPath } from '../../src/core/document';
import { makeTransform, type Point } from '../../src/core/geometry';
import { EditorSession } from '../../src/core/session';
import {
  invertWarp, layoutTextLayer, PathMeasure, PathTextMapping, scaleTextWithTransform, TEXT_WARP_STYLES, TextFontRegistry, warpFunction,
  type TextLayerLayout,
} from '../../src/core/text';
import { decodePng } from '../../src/io/png';
import { readArchive, writeArchive } from '../../src/io/project';
import { readPsdDocument } from '../../src/io/psd';
import { TextRasterCache } from '../../src/render/textRasterCache';
import { loadTextEngine, type TextEngine } from '../../src/text';

const wasmPath = path.resolve('node_modules/canvaskit-wasm/bin/canvaskit.wasm');
const fontFiles = new Map([
  ['Noto Sans', 'public/fonts/NotoSans-Variable.ttf'],
  ['Noto Sans Arabic', 'public/fonts/NotoSansArabic-Variable.ttf'],
  ['Noto Sans Devanagari', 'public/fonts/NotoSansDevanagari-Variable.ttf'],
]);

const corner = (x: number, y: number) => ({ anchor: { x, y }, in: { x, y }, out: { x, y }, kind: 'corner' as const });
function line(x0: number, y0: number, x1: number, y1: number): VectorPath {
  return { schemaVersion: 1, closed: false, fillRule: 'nonzero', points: [corner(x0, y0), corner(x1, y1)] };
}
/** A clockwise circle (y down) starting at its top, from four cubic quarter arcs. */
function circle(cx: number, cy: number, r: number): VectorPath {
  const k = 0.5522847498 * r;
  const p = (x: number, y: number, ix: number, iy: number, ox: number, oy: number) => ({ anchor: { x, y }, in: { x: ix, y: iy },
    out: { x: ox, y: oy }, kind: 'smooth' as const });
  return { schemaVersion: 1, closed: true, fillRule: 'nonzero', points: [
    p(cx, cy - r, cx - k, cy - r, cx + k, cy - r), p(cx + r, cy, cx + r, cy - k, cx + r, cy + k),
    p(cx, cy + r, cx + k, cy + r, cx - k, cy + r), p(cx - r, cy, cx - r, cy + k, cx - r, cy - k)] };
}
function sCurve(): VectorPath {
  return { schemaVersion: 1, closed: false, fillRule: 'nonzero', points: [
    { anchor: { x: 20, y: 150 }, in: { x: 20, y: 150 }, out: { x: 150, y: -50 }, kind: 'smooth' },
    { anchor: { x: 380, y: 150 }, in: { x: 250, y: 350 }, out: { x: 380, y: 150 }, kind: 'smooth' }] };
}

function textLayer(text: string, fields: Partial<TextLayer> = {}, size = 32): TextLayer {
  return newLayer({ id: 'path-text', name: 'Text', kind: 'text', text, transform: makeTransform({ x: 0, y: 0 }, { width: 400, height: 400 }),
    runs: [{ from: 0, to: text.length, style: { ...DEFAULT_TEXT_STYLE, fontSize: size } }], ...fields }) as TextLayer;
}
const onPath = (pathValue: VectorPath, patch: Partial<TextOnPath> = {}): TextOnPath => ({ schemaVersion: 1, path: pathValue, start: 0,
  end: pathValue.closed ? 0 : 1, flipped: false, baselineOffset: 0, ...patch });
const documentOf = (layer: TextLayer): CanvasDocument => ({ id: 'doc', width: 400, height: 400, resolution: 72, layers: [layer], selection: null });

/** Ink pixels (alpha ≥ threshold) of a shaped layout in frame pixels: raster pixel centres shifted by the raster offset. */
function ink(layout: TextLayerLayout, threshold = 128): Point[] {
  const pixels = layout.raster.toPixels(), width = layout.raster.width, result: Point[] = [];
  const sx = layout.rasterSize.width / width, sy = layout.rasterSize.height / layout.raster.height;
  for (let y = 0; y < layout.raster.height; y++) for (let x = 0; x < width; x++) {
    if (pixels[(y * width + x) * 4 + 3]! >= threshold) result.push({ x: layout.rasterOffset.x + (x + 0.5) * sx, y: layout.rasterOffset.y + (y + 0.5) * sy });
  }
  return result;
}
function alphaSum(layout: TextLayerLayout): number {
  const pixels = layout.raster.toPixels();
  let sum = 0;
  for (let i = 3; i < pixels.length; i += 4) sum += pixels[i]!;
  return sum;
}
async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer as ArrayBuffer);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

describe('path measurement and placement maths', () => {
  it('measures a straight line exactly and projects points onto it with a signed normal distance', () => {
    const measure = new PathMeasure(line(0, 0, 100, 0));
    expect(measure.length).toBeCloseTo(100, 6);
    expect(measure.at(25).point.x).toBeCloseTo(25, 6);
    expect(measure.at(25).tangent).toEqual({ x: 1, y: 0 });
    const hit = measure.project({ x: 30, y: 5 });
    expect(hit.s).toBeCloseTo(30, 6);
    // Right-hand normal of a rightward path points down (y grows downward).
    expect(hit.normalDistance).toBeCloseTo(5, 6);
    // Open paths continue straight past their ends.
    expect(measure.at(110).point.x).toBeCloseTo(110, 6);
  });

  it('measures a cubic circle by arc length, with tangents perpendicular to the radius, wrapping when closed', () => {
    const measure = new PathMeasure(circle(200, 200, 150));
    expect(Math.abs(measure.length - 2 * Math.PI * 150) / (2 * Math.PI * 150)).toBeLessThan(5e-4);
    for (let i = 0; i < 24; i++) {
      const { point, tangent } = measure.at(measure.length * i / 24);
      const radial = { x: point.x - 200, y: point.y - 200 };
      expect(Math.abs(Math.hypot(radial.x, radial.y) - 150)).toBeLessThan(0.05);
      expect(Math.abs(radial.x * tangent.x + radial.y * tangent.y) / 150).toBeLessThan(2e-3);
      // Equal arc steps are equal angle steps on a circle (to the cubic approximation).
      const angle = Math.atan2(radial.y, radial.x), expected = -Math.PI / 2 + 2 * Math.PI * i / 24;
      expect(Math.abs(Math.atan2(Math.sin(angle - expected), Math.cos(angle - expected)))).toBeLessThan(2e-3);
    }
    const wrapped = measure.at(measure.length + 10).point, early = measure.at(10).point;
    expect(wrapped.x).toBeCloseTo(early.x, 6);
    expect(wrapped.y).toBeCloseTo(early.y, 6);
  });

  it('places clusters by arc length within the start/end range, aligned, hidden past the range, lifted and flipped', () => {
    const measure = new PathMeasure(line(0, 100, 200, 100));
    const lines = [{ top: -30, bottom: 10, baseline: 0, left: 0, right: 50, alignment: 'left' as const }];
    const left = new PathTextMapping(measure, { start: 0.1, end: 1, flipped: false, baselineOffset: 0 }, lines);
    const m = left.clusterMatrix(25, 0);
    // The cluster's centre (x = 25 on the baseline) sits 25 px after the start marker at 20 px, unrotated.
    expect([m[0], m[1], m[2], m[3]]).toEqual([1, 0, -0, 1]);
    expect(m[0] * 25 + m[4]).toBeCloseTo(45, 6);
    expect(m[1] * 25 + m[3] * 0 + m[5]).toBeCloseTo(100, 6);
    const centred = new PathTextMapping(measure, { start: 0.1, end: 1, flipped: false, baselineOffset: 0 }, [{ ...lines[0]!, alignment: 'center' }]);
    expect(centred.map({ x: 0, y: 0 }).x).toBeCloseTo(20 + (180 - 50) / 2, 6);
    const right = new PathTextMapping(measure, { start: 0, end: 0.5, flipped: false, baselineOffset: 0 }, [{ ...lines[0]!, alignment: 'right' }]);
    expect(right.map({ x: 50, y: 0 }).x).toBeCloseTo(100, 6);
    // Overflowing clusters on an open path are hidden (Photoshop).
    const short = new PathTextMapping(measure, { start: 0, end: 0.2, flipped: false, baselineOffset: 0 }, lines);
    expect(short.fits(0, 30, 0)).toBe(true);
    expect(short.fits(30, 45, 0)).toBe(false);
    // Baseline offset lifts the text off the path.
    const lifted = new PathTextMapping(measure, { start: 0, end: 1, flipped: false, baselineOffset: 6 }, lines);
    expect(lifted.map({ x: 10, y: 0 }).y).toBeCloseTo(94, 6);
    // Flip: the text starts at the range's other end, runs backwards and hangs below the path.
    const flipped = new PathTextMapping(measure, { start: 0, end: 1, flipped: true, baselineOffset: 0 }, lines);
    expect(flipped.map({ x: 0, y: 0 }).x).toBeCloseTo(200, 6);
    expect(flipped.map({ x: 10, y: 0 }).x).toBeCloseTo(190, 6);
    expect(flipped.map({ x: 10, y: -20 }).y).toBeCloseTo(120, 6);
  });

  it('maps layout points onto a circle and back', () => {
    const measure = new PathMeasure(circle(200, 200, 150));
    const lines = [{ top: -30, bottom: 10, baseline: 0, left: 0, right: 300, alignment: 'left' as const }];
    for (const flipped of [false, true]) {
      const mapping = new PathTextMapping(measure, { start: 0.1, end: 0.1, flipped, baselineOffset: 3 }, lines);
      for (const point of [{ x: 10, y: -12 }, { x: 150, y: 4 }, { x: 290, y: -25 }]) {
        const back = mapping.inverse(mapping.map(point));
        expect(back.x).toBeCloseTo(point.x, 1);
        expect(back.y).toBeCloseTo(point.y, 1);
      }
    }
  });
});

describe('warp maths', () => {
  const box = { x: 0, y: 0, width: 400, height: 100 };
  const warp = (style: TextWarp['style'], patch: Partial<TextWarp> = {}): TextWarp => ({ schemaVersion: 1, style, orientation: 'horizontal',
    bend: 50, horizontalDistortion: 0, verticalDistortion: 0, ...patch });
  const grid: Point[] = [];
  for (let j = 0; j <= 4; j++) for (let i = 0; i <= 8; i++) grid.push({ x: 400 * i / 8, y: 100 * j / 4 });

  it('every style is the identity at zero bend and distortion and moves the box otherwise', () => {
    expect(TEXT_WARP_STYLES).toHaveLength(15);
    for (const style of TEXT_WARP_STYLES) {
      const identity = warpFunction(warp(style, { bend: 0 }), box);
      for (const point of grid) {
        const q = identity(point);
        expect(q.x).toBeCloseTo(point.x, 9);
        expect(q.y).toBeCloseTo(point.y, 9);
      }
      const bent = warpFunction(warp(style), box);
      const largest = Math.max(...grid.map((point) => { const q = bent(point); return Math.hypot(q.x - point.x, q.y - point.y); }));
      expect(largest, style).toBeGreaterThan(5);
    }
  });

  it('Arc bends the centre line onto a circle of the text width', () => {
    const map = warpFunction(warp('arc', { bend: 50 }), box);
    const radius = 2 * 200 / (Math.PI / 2), centre = { x: 200, y: 50 + radius };
    for (let i = 0; i <= 10; i++) {
      const q = map({ x: 40 * i, y: 50 });
      expect(Math.hypot(q.x - centre.x, q.y - centre.y)).toBeCloseTo(radius, 6);
    }
    // Positive bend raises the middle above the ends (Photoshop's Arc).
    expect(map({ x: 200, y: 50 }).y).toBeLessThan(map({ x: 0, y: 50 }).y);
  });

  it('inverts every style numerically, in both orientations and with distortion', () => {
    for (const style of TEXT_WARP_STYLES) for (const orientation of ['horizontal', 'vertical'] as const) {
      const map = warpFunction(warp(style, { bend: -60, orientation, horizontalDistortion: 30, verticalDistortion: -20 }), box);
      for (const point of grid) {
        const back = invertWarp(map, map(point), point);
        expect(Math.hypot(back.x - point.x, back.y - point.y), `${style} ${orientation}`).toBeLessThan(1e-2);
      }
    }
  });

  it('vertical orientation is the horizontal envelope turned a quarter; distortion grows one side', () => {
    const square = { x: 0, y: 0, width: 100, height: 100 };
    const vertical = warpFunction(warp('flag', { orientation: 'vertical' }), square);
    const horizontal = warpFunction(warp('flag'), square);
    // Turning (x, y) → (y, −x) about the centre maps the vertical warp onto the horizontal one.
    const turn = (p: Point) => ({ x: 50 + (p.y - 50), y: 50 - (p.x - 50) });
    for (const point of [{ x: 10, y: 20 }, { x: 70, y: 40 }, { x: 50, y: 90 }]) {
      const a = turn(vertical(point)), b = horizontal(turn(point));
      expect(a.x).toBeCloseTo(b.x, 9);
      expect(a.y).toBeCloseTo(b.y, 9);
    }
    const perspective = warpFunction(warp('arc', { bend: 0, horizontalDistortion: 60 }), box);
    const height = (x: number) => perspective({ x, y: 100 }).y - perspective({ x, y: 0 }).y;
    expect(height(400)).toBeGreaterThan(height(0) * 1.5);
  });
});

describe('text on a path and warped text through CanvasKit', () => {
  let engine: TextEngine;
  let fonts: TextFontRegistry;
  beforeAll(async () => {
    engine = await loadTextEngine({ wasmUrl: wasmPath });
    fonts = new TextFontRegistry(engine, null, async (font) => fs.readFileSync(fontFiles.get(font.family)!));
    await fonts.loadBundledFallbacks();
  });
  afterAll(() => engine.dispose());

  const shape = (layer: TextLayer, scale = 1) => layoutTextLayer(engine, fonts, documentOf(layer), layer, scale);

  it('text on a straight path draws the same shaped glyphs as the line (kerning and ligatures kept)', () => {
    const text = 'AVATAR office Wolke';
    const flat = shape(textLayer(text));
    const straight = shape(textLayer(text, { textPath: onPath(line(10, 200, 790, 200)), transform: makeTransform({ x: 0, y: 0 }, { width: 800, height: 400 }) }));
    try {
      const a = ink(flat, 1), b = ink(straight, 1);
      const minA = { x: Math.min(...a.map((p) => p.x)), y: Math.min(...a.map((p) => p.y)) };
      const minB = { x: Math.min(...b.map((p) => p.x)), y: Math.min(...b.map((p) => p.y)) };
      // Text starts at the path's start with its baseline on the path.
      expect(minB.x - 10).toBeCloseTo(minA.x, 0);
      expect(alphaSum(straight)).toBe(alphaSum(flat));
      const fa = flat.raster.toPixels(), fb = straight.raster.toPixels();
      const dx = Math.round(minB.x - straight.rasterOffset.x - minA.x), dy = Math.round(minB.y - straight.rasterOffset.y - minA.y);
      let worst = 0;
      for (let y = 0; y < flat.raster.height; y++) for (let x = 0; x < flat.raster.width; x++) {
        const tx = x + dx, ty = y + dy;
        const other = tx >= 0 && ty >= 0 && tx < straight.raster.width && ty < straight.raster.height ? fb[(ty * straight.raster.width + tx) * 4 + 3]! : 0;
        worst = Math.max(worst, Math.abs(fa[(y * flat.raster.width + x) * 4 + 3]! - other));
      }
      expect(worst).toBe(0);
    } finally { flat.dispose(); straight.dispose(); }
  });

  it('ligatures reach the path as one cluster: "office" has fewer glyphs than letters unless liga is off', () => {
    const count = (liga: boolean) => {
      const layer = textLayer('office', { textPath: onPath(line(0, 200, 400, 200)) });
      const styled = { ...layer, runs: [{ from: 0, to: 6, style: { ...DEFAULT_TEXT_STYLE, fontSize: 32, features: { liga } } }] };
      const layout = engine.layoutParagraph({ text: 'office', width: 30_000, pointText: true, fontFamilies: ['Noto Sans'], fontSize: 32,
        spans: [{ from: 0, to: 6, fontFamilies: ['Noto Sans'], fontSize: 32, fontFeatures: [{ name: 'liga', value: liga ? 1 : 0 }] }] });
      const glyphs = layout.shapedLines().flatMap((value) => value.runs).reduce((total, run) => total + run.glyphs.length, 0);
      layout.dispose();
      const shaped = shape(styled);
      const sum = alphaSum(shaped);
      shaped.dispose();
      return { glyphs, sum };
    };
    const on = count(true), off = count(false);
    expect(on.glyphs).toBeLessThan(6);
    expect(off.glyphs).toBe(6);
    expect(on.sum).not.toBe(off.sum);
  });

  it('text on a circle stands outside it with its glyphs turned; flipped it hangs inside', () => {
    const text = 'Rund um den Kreis läuft der Text';
    const outside = shape(textLayer(text, { textPath: onPath(circle(200, 200, 150)) }));
    const inside = shape(textLayer(text, { textPath: onPath(circle(200, 200, 150), { flipped: true }) }));
    try {
      const size = 32, radius = (p: Point) => Math.hypot(p.x - 200, p.y - 200);
      const out = ink(outside), ins = ink(inside);
      expect(out.length).toBeGreaterThan(2000);
      // Ink between the descender below the path and the ascender above it.
      for (const p of out) { expect(radius(p)).toBeGreaterThan(150 - size * 0.35); expect(radius(p)).toBeLessThan(150 + size * 1.1); }
      // Nearly all ink stands beyond the path (only round letters' overshoot and the descender of "ä"/"f" cross it).
      expect(out.filter((p) => radius(p) > 150).length / out.length).toBeGreaterThan(0.97);
      for (const p of ins) { expect(radius(p)).toBeLessThan(150 + size * 0.35); expect(radius(p)).toBeGreaterThan(150 - size * 1.1); }
      expect(ins.filter((p) => radius(p) < 150).length / ins.length).toBeGreaterThan(0.97);
      // The text runs clockwise from the top (about half a turn at this length): turned upright at 3 o'clock, upside
      // down at 6 o'clock.
      const quadrants = new Set(out.map((p) => `${p.x > 200 ? 'r' : 'l'}${p.y > 200 ? 'b' : 't'}`));
      expect(quadrants.has('rt') && quadrants.has('rb')).toBe(true);
      expect(out.some((p) => p.x > 355 && Math.abs(p.y - 200) < 10)).toBe(true);
      expect(out.some((p) => p.y > 355 && Math.abs(p.x - 200) < 20)).toBe(true);
    } finally { outside.dispose(); inside.dispose(); }
  });

  it('text on an S-curve follows the curve; start/end offsets move and clip it', () => {
    const text = 'Wellen und Kurven folgen dem Pfad';
    const curve = sCurve(), measure = new PathMeasure(curve);
    const shaped = shape(textLayer(text, { textPath: onPath(curve) }, 28));
    const moved = shape(textLayer(text, { textPath: onPath(curve, { start: 0.3 }) }, 28));
    const clipped = shape(textLayer(text, { textPath: onPath(curve, { end: 0.3 }) }, 28));
    try {
      const points = ink(shaped);
      expect(points.length).toBeGreaterThan(1000);
      for (const p of points) expect(Math.abs(measure.project(p).normalDistance)).toBeLessThan(28 * 1.15);
      // Ink rises on the first bend and falls on the second: the text is not a straight line.
      const early = points.filter((p) => { const s = measure.project(p).s; return s > measure.length * 0.1 && s < measure.length * 0.25; });
      const late = points.filter((p) => { const s = measure.project(p).s; return s > measure.length * 0.6 && s < measure.length * 0.8; });
      expect(early.length).toBeGreaterThan(100);
      expect(late.length).toBeGreaterThan(100);
      const mean = (values: Point[]) => values.reduce((sum, p) => sum + p.y, 0) / values.length;
      expect(mean(early)).toBeLessThan(mean(late) - 40);
      const firstS = (values: Point[]) => Math.min(...values.map((p) => measure.project(p).s));
      expect(firstS(ink(moved))).toBeGreaterThan(measure.length * 0.3 - 2);
      expect(alphaSum(clipped)).toBeLessThan(alphaSum(shaped) * 0.6);
    } finally { shaped.dispose(); moved.dispose(); clipped.dispose(); }
  });

  it('caret and hit testing follow the path', () => {
    const text = 'Kreistext';
    const layer = textLayer(text, { textPath: onPath(circle(200, 200, 150), { start: 0.125 }) });
    const layout = shape(layer);
    try {
      // The caret at index 0 stands at the start marker (45° clockwise from the top), turned radially.
      const [top, bottom] = layout.caretSegment(0).map((p) => ({ x: p.x - layout.transform.origin.x + layout.rasterOffset.x, y: p.y - layout.transform.origin.y + layout.rasterOffset.y }));
      const start = { x: 200 + 150 * Math.sin(Math.PI / 4), y: 200 - 150 * Math.cos(Math.PI / 4) };
      expect(Math.hypot(bottom!.x - start.x, bottom!.y - start.y)).toBeLessThan(16);
      const outward = { x: top!.x - bottom!.x, y: top!.y - bottom!.y }, radial = { x: start.x - 200, y: start.y - 200 };
      expect((outward.x * radial.x + outward.y * radial.y) / Math.hypot(outward.x, outward.y) / 150).toBeGreaterThan(0.98);
      for (let index = 1; index < text.length; index++) {
        const [a, b] = layout.caretSegment(index);
        const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        expect(layout.caretPosition(middle)).toBe(index);
      }
    } finally { layout.dispose(); }
  });

  it('every warp style changes the pixels, differently, and renders sharp at the target resolution', async () => {
    const text = 'Verkrümmt';
    const flatLayout = shape(textLayer(text, {}, 48));
    const flat = await digest(flatLayout.raster.toPixels());
    flatLayout.dispose();
    const hashes = new Set<string>([flat]);
    for (const style of TEXT_WARP_STYLES) {
      const layout = shape(textLayer(text, { textWarp: { schemaVersion: 1, style, orientation: 'horizontal', bend: 50, horizontalDistortion: 0, verticalDistortion: 0 } }, 48));
      expect(alphaSum(layout), style).toBeGreaterThan(0);
      hashes.add(await digest(layout.raster.toPixels()));
      layout.dispose();
    }
    expect(hashes.size).toBe(16);
    // Shaped again at 2× instead of resampled: the antialiased fringe stays about one target pixel wide.
    const arc = textLayer(text, { textWarp: { schemaVersion: 1, style: 'arc', orientation: 'horizontal', bend: 40, horizontalDistortion: 0, verticalDistortion: 0 } }, 48);
    const fringe = (layout: TextLayerLayout) => {
      const pixels = layout.raster.toPixels();
      let partial = 0, solid = 0;
      for (let i = 3; i < pixels.length; i += 4) { if (pixels[i]! === 255) solid++; else if (pixels[i]! > 0) partial++; }
      return partial / Math.sqrt(solid);
    };
    const one = shape(arc, 1), two = shape(arc, 2);
    try {
      expect(two.raster.width).toBeGreaterThan(one.raster.width * 1.9);
      // The same logical size (the rasters' 2-pixel margins round differently).
      expect(Math.abs(two.rasterSize.width - one.rasterSize.width)).toBeLessThan(3);
      expect(fringe(two)).toBeLessThan(fringe(one) * 1.25);
    } finally { one.dispose(); two.dispose(); }
  });

  it('the warp mesh tiles without seams or overlaps (a near-identity warp matches the flat text)', () => {
    const text = 'HIHO III';
    const style = { ...DEFAULT_TEXT_STYLE, fontSize: 90, fontWeight: 900, axes: { wght: 900 }, color: { red: 0, green: 0, blue: 0, alpha: 0.5 } };
    const base = textLayer(text);
    const flatLayer = { ...base, runs: [{ from: 0, to: text.length, style }] };
    const warped = { ...flatLayer, textWarp: { schemaVersion: 1 as const, style: 'bulge' as const, orientation: 'horizontal' as const, bend: 0.0001,
      horizontalDistortion: 0, verticalDistortion: 0 } };
    const flat = shape(flatLayer), mesh = shape(warped);
    try {
      const a = flat.raster.toPixels(), b = mesh.raster.toPixels();
      // Half-transparent ink: a doubly drawn pixel would exceed half coverage, a gap would drop inside a stem.
      let maxAlpha = 0;
      for (let i = 3; i < b.length; i += 4) maxAlpha = Math.max(maxAlpha, b[i]!);
      expect(maxAlpha).toBeLessThanOrEqual(129);
      const dx = Math.round(-mesh.rasterOffset.x), dy = Math.round(-mesh.rasterOffset.y);
      let worst = 0, total = 0;
      for (let y = 0; y < flat.raster.height; y++) for (let x = 0; x < flat.raster.width; x++) {
        const other = b[((y + dy) * mesh.raster.width + x + dx) * 4 + 3]!, own = a[(y * flat.raster.width + x) * 4 + 3]!;
        worst = Math.max(worst, Math.abs(own - other)); total += Math.abs(own - other);
      }
      expect(worst).toBeLessThanOrEqual(3);
      expect(total / alphaSum(flat)).toBeLessThan(0.01);
    } finally { flat.dispose(); mesh.dispose(); }
  });

  it('the raster cache places bent text by its frame and keeps it when the layer moves', async () => {
    const layer = textLayer('Auf dem Pfad', { textPath: onPath(circle(200, 200, 150)), transform: makeTransform({ x: 50, y: 60 }, { width: 400, height: 400 }) });
    const cache = new TextRasterCache(engine, fonts);
    const document = documentOf(layer);
    await cache.prepare(document, 1);
    const shaped = cache.layout(layer.id)!;
    const placed = cache.transform(layer);
    expect(placed.origin.x).toBeCloseTo(50 + shaped.rasterOffset.x, 6);
    expect(placed.origin.y).toBeCloseTo(60 + shaped.rasterOffset.y, 6);
    const moved = { ...layer, transform: { ...layer.transform, origin: { x: 150, y: 60 } } };
    cache.update({ ...document, layers: [moved] }, 1);
    expect(cache.layout(layer.id)).toBe(shaped);
    expect(cache.transform(moved).origin.x).toBeCloseTo(150 + shaped.rasterOffset.x, 6);
    // A transform dragged to twice the size places the pixels at twice the offset.
    const dragged = cache.placementFor(moved, { ...moved.transform, size: { width: 800, height: 800 }, origin: { x: -50, y: -140 } })!;
    expect(dragged.size.width).toBeCloseTo(shaped.rasterSize.width * 2, 6);
    cache.dispose();
  });
});

describe('text path and warp model', () => {
  it('format v2 round-trips text on a path and warps, and rejects invalid records', async () => {
    const pathLayer = textLayer('Pfad', { textPath: onPath(sCurve(), { start: 0.2, end: 0.9, flipped: true, baselineOffset: -4 }) });
    const warpLayer = { ...textLayer('Warp'), id: 'warp', textWarp: { schemaVersion: 1 as const, style: 'twist' as const, orientation: 'vertical' as const,
      bend: -35, horizontalDistortion: 12, verticalDistortion: -8 } };
    const document: CanvasDocument = { ...documentOf(pathLayer), layers: [pathLayer, warpLayer] };
    const decode = async (bytes: Uint8Array) => { const png = decodePng(bytes); return { width: png.width, height: png.height, channels: png.channels, data: png.data }; };
    const loaded = await readArchive(writeArchive(document, 'Pfad', pathLayer.id).blob, decode);
    const [readPath, readWarp] = loaded.document.layers as TextLayer[];
    expect(readPath!.textPath).toEqual(pathLayer.textPath);
    expect(readWarp!.textWarp).toEqual(warpLayer.textWarp);
    const broken = { ...warpLayer, textWarp: { ...warpLayer.textWarp, bend: 500 } };
    await expect(readArchive(writeArchive({ ...document, layers: [broken] }, 'Bad', 'warp').blob, decode)).rejects.toThrow(/text warp/);
    const badPath = { ...pathLayer, textPath: { ...pathLayer.textPath!, start: 2 } };
    await expect(readArchive(writeArchive({ ...document, layers: [badPath] }, 'Bad', pathLayer.id).blob, decode)).rejects.toThrow(/text path/);
    // Files without the fields (before Phase 3) read as plain text.
    const plain = await readArchive(writeArchive({ ...document, layers: [textLayer('Alt')] }, 'Alt', 'path-text').blob, decode);
    expect((plain.document.layers[0] as TextLayer).textPath ?? null).toBeNull();
  });

  it('scaling a path text layer scales its path; path and warp edits are single undo steps', () => {
    const layer = textLayer('Pfad', { textPath: onPath(line(0, 50, 200, 50)), transform: makeTransform({ x: 10, y: 10 }, { width: 200, height: 100 }) });
    const scaled = scaleTextWithTransform({ ...layer, transform: { ...layer.transform, size: { width: 400, height: 200 } } }, layer.transform) as TextLayer;
    expect(scaled.textPath!.path.points[1]!.anchor).toEqual({ x: 400, y: 100 });
    expect(scaled.runs[0]!.style.fontSize).toBe(64);
    const session = new EditorSession();
    session.createDocument(400, 400);
    const id = session.createPointText({ x: 20, y: 20 }, 'Kurve', DEFAULT_TEXT_STYLE)!;
    session.edit('Warp Text', () => {
      const current = session.layer(id) as TextLayer;
      session.replaceDocument({ ...session.document!, layers: session.document!.layers.map((value) => value.id === id
        ? { ...current, textWarp: { schemaVersion: 1 as const, style: 'flag' as const, orientation: 'horizontal' as const, bend: 40,
          horizontalDistortion: 0, verticalDistortion: 0 } } : value) });
    });
    expect((session.layer(id) as TextLayer).textWarp?.style).toBe('flag');
    expect(session.history.undoName).toBe('Warp Text');
    expect(session.undo()).toBe(true);
    expect((session.layer(id) as TextLayer).textWarp ?? null).toBeNull();
  });

  it('imports Photoshop warp presets from PSD text', () => {
    const width = 200, height = 80;
    const psd: Psd = { width, height, imageData: { width, height, data: new Uint8ClampedArray(width * height * 4) },
      children: [{ name: 'Bogen', left: 10, top: 10, right: 190, bottom: 70, imageData: { width: 180, height: 60, data: new Uint8ClampedArray(180 * 60 * 4) },
        text: { text: 'Bogen', transform: [1, 0, 0, 1, 12, 48], style: { font: { name: 'NotoSans-Regular' }, fontSize: 32 },
          warp: { style: 'arcLower', value: 35, perspective: -10, perspectiveOther: 20, rotate: 'vertical' } } }] };
    const imported = readPsdDocument(writePsdUint8Array(psd, { generateThumbnail: false, invalidateTextLayers: false }));
    const layer = imported.document.layers[0] as TextLayer;
    expect(layer.textWarp).toEqual({ schemaVersion: 1, style: 'arcLower', orientation: 'vertical', bend: 35, horizontalDistortion: -10,
      verticalDistortion: 20 });
    expect(imported.unsupported.find((value) => value.code === 'text-warp')?.impact).toBe('approximated');
  });
});
