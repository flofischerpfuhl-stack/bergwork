import { describe, expect, it } from 'vitest';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import {
  beginGradient, cancelGradient, commitGradient, defaultGradientSettings, endGradientDrag, gradientPreview,
  rasterizeGradient, snapGradientPoint, updateGradient,
} from '../../src/core/gradient';

const black = { red: 0, green: 0, blue: 0 }, white = { red: 1, green: 1, blue: 1 };

describe('gradient (GradientTests.swift)', () => {
  it('foregroundToBackgroundFillsCanvasAndCommitsOneUndo', () => {
    const session = new EditorSession();
    session.createNewProject(101, 4);
    session.tool = 'gradient';
    const count = session.history.undoCount;
    const settings = { ...defaultGradientSettings(black, white), style: 'Foreground to Background' as const };
    expect(beginGradient(session, { x: 0.5, y: 2 }, settings)).toBe(true);
    updateGradient(session, { x: 100.5, y: 2 }, { settings });
    expect(gradientPreview(session)!.pixel(0, 0)).toEqual([0, 0, 0, 255]);
    expect(gradientPreview(session)!.pixel(100, 3)).toEqual([255, 255, 255, 255]);
    expect(session.activeLayer!.raster).toBeNull();
    expect(commitGradient(session)).toBe(true);
    expect(session.history.undoCount).toBe(count + 1);
    expect(session.activeLayer!.raster!.pixel(50, 1)[0]).toBeCloseTo(128, 0);
    session.undo();
    expect(session.activeLayer!.raster).toBeNull();
  });

  it('radialSpreadsFromStartToRimInEveryDirection', () => {
    const settings = { ...defaultGradientSettings(black, white), shape: 'Radial' as const,
      style: 'Foreground to Background' as const };
    const result = rasterizeGradient({ base: Raster.blank(101, 101, 4),
      transform: makeTransform({ x: 0, y: 0 }, { width: 101, height: 101 }),
      start: { x: 50.5, y: 50.5 }, end: { x: 90.5, y: 50.5 }, settings });
    expect(result.pixel(50, 50)).toEqual([0, 0, 0, 255]);
    const halfway = [[70, 50], [30, 50], [50, 70], [50, 30]].map(([x, y]) => result.pixel(x!, y!)[0]!);
    expect(Math.max(...halfway) - Math.min(...halfway)).toBeLessThanOrEqual(1);
    expect(halfway[0]).toBeCloseTo(128, 0);
    expect(result.pixel(0, 0)).toEqual([255, 255, 255, 255]);
  });

  it('reverseOpacityAndDirectionFollowSettings and transparent preserves underlying pixels', () => {
    const red = new Uint8Array(101 * 4 * 4);
    for (let i = 0; i < 101 * 4; i++) red.set([255, 0, 0, 255], i * 4);
    const base = Raster.fromPixels(101, 4, 4, red);
    const transparent = { ...defaultGradientSettings(black, white), opacity: 1 };
    const result = rasterizeGradient({ base, transform: makeTransform({ x: 0, y: 0 }, { width: 101, height: 4 }),
      start: { x: 0.5, y: 2 }, end: { x: 100.5, y: 2 }, settings: transparent });
    expect(result.pixel(0, 2)).toEqual([0, 0, 0, 255]);
    expect(result.pixel(100, 2)).toEqual([255, 0, 0, 255]);
    expect(result.pixel(50, 2)[0]).toBeCloseTo(128, 0);

    const reversed = rasterizeGradient({ base: Raster.blank(101, 1, 4),
      transform: makeTransform({ x: 0, y: 0 }, { width: 101, height: 1 }), start: { x: 0.5, y: 0.5 },
      end: { x: 100.5, y: 0.5 }, settings: { ...defaultGradientSettings(black, white),
        style: 'Foreground to Background', reversed: true, opacity: 0.5 } });
    expect(reversed.pixel(0, 0)).toEqual([255, 255, 255, 128]);
    expect(reversed.pixel(100, 0)).toEqual([0, 0, 0, 128]);
  });

  it('cancelUndoAndClicksLeaveDocumentUntouched', () => {
    const session = new EditorSession();
    session.createNewProject(20, 10);
    session.tool = 'gradient';
    const before = session.document;
    beginGradient(session, { x: 2, y: 2 });
    expect(endGradientDrag(session)).toBe(false);
    expect(session.document).toBe(before);
    beginGradient(session, { x: 0, y: 2 }); updateGradient(session, { x: 10, y: 2 });
    expect(cancelGradient(session)).toBe(true);
    beginGradient(session, { x: 0, y: 2 }); updateGradient(session, { x: 10, y: 2 });
    expect(session.undo()).toBe(true);
    expect(session.document).toBe(before);
  });

  it('Shift constrains an endpoint to 45-degree steps', () => {
    const snapped = snapGradientPoint({ x: 7, y: 5 }, { x: 0, y: 0 });
    expect(snapped.x).toBeCloseTo(snapped.y);
    expect(Math.hypot(snapped.x, snapped.y)).toBeCloseTo(Math.hypot(7, 5));
  });

  it('clips rasterisation to selection coverage', () => {
    const selection = { mask: Raster.fromPixels(2, 1, 1, new Uint8Array([255, 128])), x: 1, y: 0, antialiased: true };
    const result = rasterizeGradient({ base: Raster.blank(4, 1, 4),
      transform: makeTransform({ x: 0, y: 0 }, { width: 4, height: 1 }), start: { x: 0.5, y: 0.5 }, end: { x: 3.5, y: 0.5 },
      settings: { ...defaultGradientSettings(white, black), style: 'Foreground to Background' }, selection });
    expect(result.pixel(0, 0)[3]).toBe(0);
    expect(result.pixel(1, 0)[3]).toBe(255);
    expect(result.pixel(2, 0)[3]).toBeCloseTo(128, 0);
    expect(result.pixel(3, 0)[3]).toBe(0);
  });

  it('maskGradientWritesCoverageInsideLayerBounds', () => {
    const session = new EditorSession();
    session.createNewProject(101, 4);
    session.addLayerMask(true);
    session.tool = 'gradient';
    const settings = { ...defaultGradientSettings(black, white), style: 'Foreground to Background' as const };
    beginGradient(session, { x: 0.5, y: 2 }, settings);
    updateGradient(session, { x: 100.5, y: 2 }, { settings });
    expect(commitGradient(session)).toBe(true);
    const mask = session.activeLayer!.mask!.raster;
    expect(mask.pixel(0, 2)[0]).toBe(0);
    expect(mask.pixel(50, 2)[0]).toBeCloseTo(128, 0);
    expect(mask.pixel(100, 2)[0]).toBe(255);
    expect(session.history.undoName).toBe('Gradient Mask');
  });

  it('paletteChangesUpdatePendingPreview', () => {
    const session = new EditorSession();
    session.createNewProject(11, 1);
    session.tool = 'gradient';
    const settings = { ...defaultGradientSettings(session.foregroundColor, session.backgroundColor),
      style: 'Foreground to Background' as const };
    beginGradient(session, { x: 0.5, y: 0.5 }, settings);
    updateGradient(session, { x: 10.5, y: 0.5 }, { settings });
    expect(gradientPreview(session)!.pixel(0, 0)[0]).toBe(0);
    session.swapPaletteColors();
    expect(gradientPreview(session)!.pixel(0, 0)[0]).toBe(255);
    cancelGradient(session);
  });

  it('grows a small color layer grid to the canvas like BrushStroke.init', () => {
    const session = new EditorSession();
    session.createNewProject(20, 10);
    const dot = Raster.fromPixels(2, 2, 4, new Uint8Array(16).fill(255));
    const id = session.insertRaster(dot, 'dot', { x: 10, y: 5 });
    session.tool = 'gradient';
    const settings = { ...defaultGradientSettings(black, white), style: 'Foreground to Background' as const };
    beginGradient(session, { x: 0.5, y: 5 }, settings);
    updateGradient(session, { x: 19.5, y: 5 }, { settings });
    commitGradient(session);
    expect(session.layer(id)!.raster).toMatchObject({ width: 20, height: 10 });
    expect(session.layer(id)!.transform.origin).toEqual({ x: 0, y: 0 });
    expect(session.layer(id)!.raster!.pixel(0, 5)[3]).toBe(255);
  });
});
