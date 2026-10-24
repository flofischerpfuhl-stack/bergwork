import { expect, test } from '@playwright/test';

// Resource-timing assertions below: the dev server loads more than the default 250 entries, after which the browser stops
// recording, so a late lazy load (libheif, CanvasKit) would look absent.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => performance.setResourceTimingBufferSize(100_000)); });

const EXPECTED_TEXT_SHA256 = '522e3687d43de15bfeb1eff5842eda1283c6d4248db2932a0b97979aaddec978';

test('A5 rich text model is deterministic, lazy, editable, and within the 500-character budget', async ({ page }, info) => {
  test.setTimeout(300_000);
  await page.goto('/?harness=text-engine');
  const result = await page.evaluate(async () => {
    const before = performance.getEntriesByType('resource').some((entry) => /canvaskit/i.test(entry.name));
    const loadText = (url: string): Promise<typeof import('../../src/text')> => import(/* @vite-ignore */ url) as Promise<typeof import('../../src/text')>;
    const loadCore = (url: string): Promise<typeof import('../../src/core/text')> => import(/* @vite-ignore */ url) as Promise<typeof import('../../src/core/text')>;
    const loadGeometry = (url: string): Promise<typeof import('../../src/core/geometry')> => import(/* @vite-ignore */ url) as Promise<typeof import('../../src/core/geometry')>;
    const loadCheck = (url: string): Promise<typeof import('../../src/text/checkSheet')> => import(/* @vite-ignore */ url) as Promise<typeof import('../../src/text/checkSheet')>;
    const [{ loadTextEngine }, core, geometry, check] = await Promise.all([
      loadText('/src/text/index.ts'), loadCore('/src/core/text/index.ts'), loadGeometry('/src/core/geometry.ts'),
      loadCheck('/src/text/checkSheet.ts'),
    ]);
    const engine = await loadTextEngine();
    const fonts = new core.TextFontRegistry(engine);
    const text = 'AVATAR office affine · Übergrößenträger\nالعربية جميلة\nदेवनागरी क्ष त्र ज्ञ';
    const base = { schemaVersion: 1 as const, fontFamily: 'Noto Sans', fontStyle: 'normal' as const, fontWeight: 400,
      fontSize: 24, color: { red: 0.05, green: 0.1, blue: 0.2, alpha: 1 }, tracking: 0,
      kerning: 'metric' as const, leading: null, baselineShift: 0, features: { liga: true, tnum: true }, axes: {} };
    const layer = { kind: 'text' as const, id: 'reference', name: 'Reference', visible: true,
      parentId: null, opacity: 1, fillOpacity: 1, blendMode: 'normal' as const,
      locks: { transparency: false, pixels: false, position: false, all: false }, colorLabel: 'none' as const,
      transform: geometry.makeTransform({ x: 20, y: 30 }, { width: 620, height: 180 }), warp: null, crop: null,
      mask: null, vectorMask: null, maskSourceId: null, effects: [], filters: [], raster: null, renderedTransform: null, text,
      runs: [{ from: 0, to: 48, style: { ...base, axes: { wght: 675, wdth: 90 } } },
        { from: 48, to: 63, style: { ...base, fontFamily: 'Noto Sans Arabic', fontSize: 28,
          color: { red: 0, green: 0.35, blue: 0.45, alpha: 1 } } },
        { from: 63, to: text.length, style: { ...base, fontFamily: 'Noto Sans Devanagari', fontSize: 20,
          tracking: 15, color: { red: 0.45, green: 0.1, blue: 0.35, alpha: 1 } } }],
      paragraphs: [{ from: 0, to: 48, style: { schemaVersion: 1 as const, alignment: 'justify' as const,
        direction: 'ltr' as const, firstLineIndent: 10, startIndent: 4, endIndent: 4, spaceBefore: 0, spaceAfter: 5 } },
        { from: 48, to: 63, style: { schemaVersion: 1 as const, alignment: 'right' as const,
          direction: 'rtl' as const, firstLineIndent: 0, startIndent: 0, endIndent: 0, spaceBefore: 0, spaceAfter: 3 } },
        { from: 63, to: text.length, style: { schemaVersion: 1 as const, alignment: 'left' as const,
          direction: 'ltr' as const, firstLineIndent: 0, startIndent: 0, endIndent: 0, spaceBefore: 0, spaceAfter: 0 } }],
      box: { width: 620, height: 180 }, alignment: 'justify' as const };
    const document = { id: 'text-doc', width: 700, height: 240, resolution: 72, layers: [layer], selection: null };
    const missing = await fonts.prepareDocument(document);
    const layout = core.layoutTextLayer(engine, fonts, document, layer, 1, missing);
    const pixels = layout.raster.toPixels();
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(pixels).buffer as ArrayBuffer);
    const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
    const hit = layout.caretPosition({ x: 35, y: 45 });
    const selection = layout.selectionRectangles(0, 6);
    const caret = layout.caretRectangle(3);
    layout.dispose();
    const performanceResult = check.measureParagraphPerformance(engine, 50);
    engine.dispose();
    return { before, hash, missing, hit, selection, caret, performanceResult };
  });

  expect(result.before).toBe(false);
  expect(result.hash).toBe(EXPECTED_TEXT_SHA256);
  expect(result.missing).toEqual([]);
  expect(result.hit).toBeGreaterThanOrEqual(0);
  expect(result.selection.length).toBeGreaterThan(0);
  expect(result.caret.height).toBeGreaterThan(5);
  expect(result.performanceResult.characterCount).toBe(500);
  expect(result.performanceResult.p95Ms).toBeGreaterThan(0);
  console.log(`${info.project.name} 500-character paragraph median ${result.performanceResult.medianMs.toFixed(2)} ms, `
    + `p95 ${result.performanceResult.p95Ms.toFixed(2)} ms, max ${result.performanceResult.maxMs.toFixed(2)} ms `
    + `(layout p95 ${result.performanceResult.layoutP95Ms.toFixed(2)} ms, raster p95 `
    + `${result.performanceResult.rasterP95Ms.toFixed(2)} ms)`);
});
