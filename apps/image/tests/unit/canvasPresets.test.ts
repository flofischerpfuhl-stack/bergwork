import { describe, expect, it } from 'vitest';
import { backgroundColor, canvasPixels, canvasText, matchingPreset } from '../../src/core/canvasPresets';
import { EditorSession } from '../../src/core/session';

describe('New Canvas units (NewCanvasSheet.swift)', () => {
  it('turns print sizes into pixels at the resolution and back', () => {
    expect(canvasPixels('210', 'mm', 300, 30_000)).toBe(2480);
    expect(canvasPixels('8,5', 'in', 300, 30_000)).toBe(2550);
    expect(canvasPixels('2.54', 'cm', 72, 30_000)).toBe(72);
    expect(canvasText(2480, 'mm', 300)).toBe('209.97');
    expect(canvasText(2550, 'in', 300)).toBe('8.5');
    expect(canvasText(1920, 'px', 300)).toBe('1920');
  });

  it('refuses fractional pixels, zero, junk and sizes past the profile limit', () => {
    expect(canvasPixels('12.5', 'px', 72, 30_000)).toBeNull();
    expect(canvasPixels('0', 'px', 72, 30_000)).toBeNull();
    expect(canvasPixels('1e3', 'px', 72, 30_000)).toBeNull();
    expect(canvasPixels('3000', 'mm', 300, 30_000)).toBeNull();
  });

  it('recognises a preset, print sizes only at their resolution', () => {
    expect(matchingPreset(1080, 1350, 72)?.id).toBe('instagram-portrait');
    expect(matchingPreset(2480, 3508, 300)?.id).toBe('a4');
    expect(matchingPreset(2480, 3508, 72)).toBeUndefined();
  });
});

describe('a new canvas with a background', () => {
  it('starts with an opaque Background layer of that colour and stores the resolution', () => {
    const session = new EditorSession();
    session.createNewProject(4, 3, undefined, { resolution: 300, background: backgroundColor('white') });
    const document = session.document!;
    expect(document.resolution).toBe(300);
    expect(document.layers).toHaveLength(1);
    expect(document.layers[0]!.name).toBe('Background');
    expect([...document.layers[0]!.raster!.pixel(3, 2)]).toEqual([255, 255, 255, 255]);
    expect(session.canUndo).toBe(false);
  });

  it('keeps the empty transparent layer without one', () => {
    const session = new EditorSession();
    session.createNewProject(4, 3);
    expect(session.document!.resolution).toBe(72);
    expect(session.document!.layers[0]!.raster ?? null).toBeNull();
  });
});
