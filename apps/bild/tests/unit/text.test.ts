import fs from 'node:fs';
import path from 'node:path';
import { writePsdUint8Array, type Psd } from 'ag-psd';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_TEXT_STYLE, type CanvasDocument, type TextLayer } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { EditorSession } from '../../src/core/session';
import { addDocumentFont, layoutTextLayer, TextFontRegistry } from '../../src/core/text';
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

function textLayer(): TextLayer {
  const text = 'office Übergröße\nمرحبا देवनागरी';
  return {
    kind: 'text', id: 'text-1', name: 'Text', visible: true, locked: false, parentId: null, opacity: 1,
    fillOpacity: 1, blendMode: 'normal', locks: { transparency: false, pixels: false, position: false, all: false },
    colorLabel: 'none', transform: makeTransform({ x: 40, y: 30 }, { width: 260, height: 100 }), warp: null,
    crop: null, mask: null, vectorMask: null, maskSourceId: null, effects: [], filters: [], raster: null, text,
    runs: [
      { from: 0, to: 17, style: { ...DEFAULT_TEXT_STYLE, fontFamily: 'Unavailable Grotesk', fontSize: 22,
        tracking: 20, axes: { wght: 650 }, features: { liga: true, tnum: true } } },
      { from: 17, to: text.length, style: { ...DEFAULT_TEXT_STYLE, fontFamily: 'Noto Sans Arabic', fontSize: 18,
        color: { red: 0.1, green: 0.2, blue: 0.7, alpha: 1 }, leading: 25, baselineShift: 2 } },
    ],
    renderedTransform: null, paragraphs: [
      { from: 0, to: 18, style: { schemaVersion: 1, alignment: 'justify', direction: 'ltr', firstLineIndent: 8,
        startIndent: 3, endIndent: 4, spaceBefore: 2, spaceAfter: 5 } },
      { from: 18, to: text.length, style: { schemaVersion: 1, alignment: 'right', direction: 'rtl', firstLineIndent: 0,
        startIndent: 0, endIndent: 0, spaceBefore: 0, spaceAfter: 0 } },
    ], box: { width: 260, height: 100 }, alignment: 'justify',
  };
}

describe('P2 text engine integration', () => {
  let engine: TextEngine;
  let fonts: TextFontRegistry;

  beforeAll(async () => {
    engine = await loadTextEngine({ wasmUrl: wasmPath });
    fonts = new TextFontRegistry(engine, null, async (font) => fs.readFileSync(fontFiles.get(font.family)!));
  });
  afterAll(() => engine.dispose());

  it('A5 lays out rich multilingual area text, reports substitution, and maps hit tests to document space', async () => {
    const layer = textLayer();
    const document = { id: 'doc', width: 500, height: 300, resolution: 72, layers: [layer], selection: null };
    const missing = await fonts.prepareDocument(document);
    expect(missing).toEqual([{ family: 'Unavailable Grotesk', substitute: 'Noto Sans', layerIds: ['text-1'] }]);
    const layout = layoutTextLayer(engine, fonts, document, layer, 2, missing);
    try {
      expect(layout.raster.width).toBe(520);
      expect(layout.raster.height).toBe(200);
      expect(layout.missingFonts[0]?.family).toBe('Unavailable Grotesk');
      let alpha = 0;
      for (let y = 0; y < layout.raster.height; y += 4) for (let x = 0; x < layout.raster.width; x += 4) {
        alpha += layout.raster.pixel(x, y)[3]!;
      }
      expect(alpha).toBeGreaterThan(10_000);
      const caret = layout.caretPosition({ x: 45, y: 40 });
      expect(caret).toBeGreaterThanOrEqual(0);
      expect(caret).toBeLessThanOrEqual(layer.text.length);
      const rectangles = layout.selectionRectangles(0, 6);
      expect(rectangles.length).toBeGreaterThan(0);
      expect(rectangles[0]!.x).toBeGreaterThanOrEqual(40);
      expect(layout.caretRectangle(3).height).toBeGreaterThan(5);
    } finally { layout.dispose(); }
  });

  it('resolves a bundled PSD font by its PostScript name', async () => {
    await fonts.loadBundledFallbacks();
    expect(fonts.resolution('NotoSans-Regular')).toEqual({
      requested: 'NotoSans-Regular',
      families: ['Noto Sans', 'Noto Sans Arabic', 'Noto Sans Devanagari'],
      substitute: null,
    });
  });

  it('A5 renderer hook reshapes at the target resolution instead of resampling its prior cache', async () => {
    const layer = textLayer();
    const document: CanvasDocument = { id: 'doc', width: 500, height: 300, resolution: 72, layers: [layer], selection: null };
    const cache = new TextRasterCache(engine, fonts);
    try {
      await cache.prepare(document, 1);
      const first = cache.raster(layer)!;
      expect(first.width).toBe(260);
      await cache.prepare(document, 2);
      const second = cache.raster(layer)!;
      expect(second.width).toBe(520);
      expect(second).not.toBe(first);
      expect(cache.transform(layer).size).toEqual({ width: 260, height: 100 });
    } finally { cache.dispose(); }
  });

  it('A5 text session commands are one undo step each and rasterization is destructive only on request', () => {
    const session = new EditorSession();
    session.createDocument(500, 300);
    session.history.reset();
    const id = session.createPointText({ x: 20, y: 30 }, 'office', DEFAULT_TEXT_STYLE)!;
    expect(session.history.undoCount).toBe(1);
    session.replaceText(id, 1, 4, 'FFIC');
    expect((session.layer(id) as TextLayer).text).toBe('oFFICce');
    session.applyTextStyle(id, 0, 2, { fontWeight: 700, features: { liga: false, smcp: true } });
    session.changeParagraphSettings(id, 0, 0, { alignment: 'center', spaceAfter: 4 });
    session.convertTextKind(id, { width: 180, height: 80 });
    expect(session.history.undoCount).toBe(5);
    expect((session.layer(id) as TextLayer).box).toEqual({ width: 180, height: 80 });
    expect(session.undo()).toBe(true);
    expect((session.layer(id) as TextLayer).box).toBeNull();
    expect(session.undo()).toBe(true);
    expect((session.layer(id) as TextLayer).paragraphs[0]!.style.alignment).toBe('left');
  });

  it('A5 format v2 preserves rich records and embeds bytes only with permission', async () => {
    const layer = textLayer();
    let document: CanvasDocument = { id: 'doc', width: 500, height: 300, resolution: 72, layers: [layer], selection: null };
    document = addDocumentFont(document, { id: 'licensed', family: 'Licensed Font', style: 'Regular', weight: 400,
      source: 'embedded', embeddingAllowed: true, bytes: new Uint8Array([1, 2, 3, 4]) });
    document = addDocumentFont(document, { id: 'system', family: 'System Font', style: 'Regular', weight: 400,
      source: 'system', embeddingAllowed: false, bytes: new Uint8Array([9, 9, 9]) });
    const archive = writeArchive(document, 'Text', layer.id);
    const loaded = await readArchive(archive.blob, async (bytes) => {
      const png = decodePng(bytes); return { width: png.width, height: png.height, channels: png.channels, data: png.data };
    });
    const result = loaded.document.layers[0] as TextLayer;
    expect(result.runs[0]!.style.axes).toEqual({ wght: 650 });
    expect(result.paragraphs[1]!.style.direction).toBe('rtl');
    expect(loaded.document.fonts).toHaveLength(2);
    expect(loaded.document.resources?.filter((value) => value.role === 'font')).toHaveLength(1);
    expect(loaded.document.fonts?.find((value) => value.id === 'system')?.resourceId).toBeUndefined();
    const revoked = addDocumentFont(document, { id: 'licensed', family: 'Licensed Font', style: 'Regular', weight: 400,
      source: 'system', embeddingAllowed: false, bytes: new Uint8Array([8, 8]) });
    expect(revoked.fonts?.find((value) => value.id === 'licensed')?.resourceId).toBeUndefined();
    expect(revoked.resources?.some((value) => value.id === 'font-licensed')).toBe(false);
  });

  it('A7 imports ag-psd text runs as editable text instead of flattening them', () => {
    const pixels = new Uint8ClampedArray(120 * 60 * 4);
    const psd: Psd = { width: 120, height: 60, imageData: { width: 120, height: 60, data: pixels }, children: [{
      name: 'Headline', left: 10, top: 10, right: 110, bottom: 50,
      imageData: { width: 100, height: 40, data: new Uint8ClampedArray(100 * 40 * 4) },
      text: { text: 'Hallo\rWelt', shapeType: 'box', boxBounds: [0, 0, 100, 40], transform: [1, 0, 0, 1, 10, 10],
        styleRuns: [{ length: 10, style: { font: { name: 'Missing PSD Font' }, fontSize: 24, tracking: 50,
          leading: 30, autoLeading: false, fillColor: { r: 255, g: 20, b: 10, a: 128 }, ligatures: true } }],
        paragraphStyleRuns: [{ length: 10, style: { justification: 'center', firstLineIndent: 3 } }] },
    }] };
    const imported = readPsdDocument(writePsdUint8Array(psd, { generateThumbnail: false }));
    const layer = imported.document.layers[0];
    expect(layer?.kind).toBe('text');
    expect((layer as TextLayer).text).toBe('Hallo\nWelt');
    expect((layer as TextLayer).runs[0]!.style).toMatchObject({ fontFamily: 'Missing PSD Font', fontSize: 24,
      tracking: 50, leading: 30 });
    expect((layer as TextLayer).runs[0]!.style.color.alpha).toBeCloseTo(128 / 255);
    expect((layer as TextLayer).paragraphs[0]!.style.alignment).toBe('center');
    expect(imported.unsupported.some((value) => value.code === 'text')).toBe(false);
  });

  it('positions PSD point text from its baseline transform when no area-text box exists', async () => {
    const width = 200, height = 70;
    const psd: Psd = { width, height, imageData: { width, height, data: new Uint8ClampedArray(width * height * 4) },
      children: [{ name: 'Headline', left: 10, top: 10, right: 190, bottom: 60,
        imageData: { width: 180, height: 50, data: new Uint8ClampedArray(180 * 50 * 4) },
        text: { text: 'Summer Sale', transform: [1, 0, 0, 1, 12, 48],
          style: { font: { name: 'NotoSans-Regular' }, fontSize: 32,
            fillColor: { r: 20, g: 30, b: 120 } } } }] };
    const imported = readPsdDocument(writePsdUint8Array(psd,
      { generateThumbnail: false, invalidateTextLayers: false }));
    const layer = imported.document.layers[0] as TextLayer;
    expect(layer.kind).toBe('text');
    expect(layer.box).toBeNull();
    expect(layer.transform.origin.x).toBe(12);
    expect(layer.transform.origin.y).toBeGreaterThanOrEqual(0);
    expect(layer.transform.origin.y).toBeLessThan(48);
    expect(layer.transform.size.width).toBeGreaterThan(100);
    const missing = await fonts.prepareDocument(imported.document);
    expect(missing).toEqual([]);
    const layout = layoutTextLayer(engine, fonts, imported.document, layer, 1, missing);
    try {
      expect(layout.transform.origin.y).toBe(layer.transform.origin.y);
      expect(layout.raster.width).toBeGreaterThan(100);
      expect(layout.raster.height).toBeGreaterThan(20);
    } finally { layout.dispose(); }
  });
});
