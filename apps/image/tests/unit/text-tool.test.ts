import { describe, expect, it } from 'vitest';
import { autoName, nextGrapheme, nextWord, previousGrapheme, previousWord, resizedPlacement } from '../../src/app/text/editor';
import { DEFAULT_TEXT_STYLE, defaultTextParagraphs, newLayer, type TextLayer } from '../../src/core/document';
import { makeTransform, unitPoint } from '../../src/core/geometry';
import { derivedLayerSources, EditorSession } from '../../src/core/session';
import { Raster } from '../../src/core/raster';

function pointText(alignment: 'left' | 'center' | 'right', rotation = 0): TextLayer {
  const layer = newLayer({ id: 't', name: 'Text 1', kind: 'text', text: 'Hi', runs: [{ from: 0, to: 2, style: DEFAULT_TEXT_STYLE }],
    paragraphs: defaultTextParagraphs('Hi', alignment), transform: makeTransform({ x: 100, y: 50 }, { width: 40, height: 20 }, { rotation }) });
  return layer as TextLayer;
}

describe('Type tool helpers (PRODUCT-PLAN A5/6.6)', () => {
  it('names text layers after their first non-empty line, like Photoshop', () => {
    expect(autoName('\n  Grüße   aus Köln \nzweite')).toBe('Grüße aus Köln');
    expect(autoName('')).toBe('');
    expect(autoName('x'.repeat(70))).toBe(`${'x'.repeat(60)}…`);
  });

  it('grows point text from its alignment anchor, also when rotated', () => {
    for (const [alignment, unit] of [['left', 0], ['center', 0.5], ['right', 1]] as const) {
      for (const rotation of [0, 30]) {
        const layer = pointText(alignment, rotation);
        const next = resizedPlacement(layer, { width: 90, height: 20 });
        expect(next.size).toEqual({ width: 90, height: 20 });
        const before = unitPoint(layer.transform, { x: unit, y: 0 }), after = unitPoint(next, { x: unit, y: 0 });
        expect(after.x).toBeCloseTo(before.x, 6);
        expect(after.y).toBeCloseTo(before.y, 6);
      }
    }
    const layer = pointText('left');
    expect(resizedPlacement(layer, { width: 40, height: 20 })).toBe(layer.transform);
  });

  it('resizing a text layer with the Move tool scales its type, not its pixels (one undo step)', () => {
    const session = new EditorSession();
    session.createDocument(400, 300);
    const id = session.createAreaText({ x: 10, y: 20, width: 100, height: 50 }, 'Hallo', { ...DEFAULT_TEXT_STYLE, fontSize: 20, leading: 24 })!;
    session.selectLayer(id);
    session.history.reset();
    // Shaped pixels normally come from the lazily loaded engine (app/text/runtime.ts).
    const shaped = (_: EditorSession, layer: { kind: string; transform: TextLayer['transform'] }) =>
      (layer.kind === 'text' ? { raster: Raster.fromPixels(1, 1, 4, new Uint8Array([0, 0, 0, 255])), transform: layer.transform } : null);
    derivedLayerSources.push(shaped);
    try { session.beginTransform(); } finally { derivedLayerSources.splice(derivedLayerSources.indexOf(shaped), 1); }
    const draft = session.transformEdit!.draft;
    session.previewTransform({ ...draft, size: { width: 200, height: 100 } });
    session.commitTransform();
    const layer = session.layer(id) as TextLayer;
    expect(layer.runs[0]!.style.fontSize).toBe(40);
    expect(layer.runs[0]!.style.leading).toBe(48);
    expect(layer.box).toEqual({ width: 200, height: 100 });
    expect(layer.transform.size).toEqual({ width: 200, height: 100 });
    expect(session.history.undoCount).toBe(1);
  });

  it('moves by grapheme and word across umlauts, emoji and Arabic', () => {
    const text = 'Köln 👍🏽 مرحبا';
    expect(nextGrapheme(text, 5)).toBe(9);
    expect(previousGrapheme(text, 9)).toBe(5);
    expect(nextWord(text, 0)).toBe(4);
    expect(previousWord(text, text.length)).toBe(10);
    expect(nextWord(text, 10)).toBe(text.length);
  });

  it('a whole text editing session is one undo step when wrapped in one transaction', () => {
    const session = new EditorSession();
    session.createDocument(400, 300);
    session.history.reset();
    session.beginEdit('Edit Text');
    const id = session.createPointText({ x: 10, y: 20 }, '', DEFAULT_TEXT_STYLE)!;
    session.replaceText(id, 0, 0, 'Hallo');
    session.applyTextStyle(id, 0, 5, { fontWeight: 700 });
    session.replaceText(id, 5, 5, '!');
    session.endEdit();
    expect(session.history.undoCount).toBe(1);
    expect(session.history.undoName).toBe('Edit Text');
    expect(session.undo()).toBe(true);
    expect(session.document!.layers).toHaveLength(0);
  });
});
