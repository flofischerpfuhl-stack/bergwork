// berg:work: Save as PDF/A and the OCR additions (node --test apps/pdf/tests/unit/).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  convertPdfBytesToPdfA, naiveCmykIccProfile, parseFontName, replacementFontFile, scanContentColours, srgbIccProfile,
  symbolicStandardFont,
} from '../../editor/vendor/build/src/pdf-editor/persistence/bergwork-pdfa.js';
import { estimateSkewDegrees, rotatedToSource } from '../../editor/vendor/build/src/pdf-editor/ocr/bergwork-deskew.js';
import { OCR_EXTRA_LANGUAGES, extraOcrLanguageUrl, isExtraOcrLanguage } from '../../editor/vendor/build/src/pdf-editor/ocr/bergwork-ocr-languages.js';

const require = createRequire(import.meta.url);
const PDFLib = require('pdf-lib');
const FONTS = new URL('../../upstream/tools/vendor/pdf-tools/fallback-fonts/latin/', import.meta.url);
const haveFonts = fs.existsSync(new URL('LiberationSans-Regular.ttf', FONTS));

test('missing fonts map to metric-compatible bundled faces', () => {
  assert.equal(replacementFontFile('Helvetica-Oblique').file, 'LiberationSans-Italic.ttf');
  assert.equal(replacementFontFile('ABCDEF+Arial,BoldItalic').file, 'LiberationSans-BoldItalic.ttf');
  assert.equal(replacementFontFile('TimesNewRomanPS-BoldMT').file, 'LiberationSerif-Bold.ttf');
  assert.equal(replacementFontFile('Times New Roman').file, 'LiberationSerif-Regular.ttf');
  assert.equal(replacementFontFile('Times-Roman').file, 'LiberationSerif-Regular.ttf');
  assert.equal(replacementFontFile('CourierNewPSMT').file, 'LiberationMono-Regular.ttf');
  assert.equal(replacementFontFile('HelveticaLTStd-Bold').file, 'LiberationSans-Bold.ttf');
  assert.equal(replacementFontFile('Calibri,Italic').file, 'Carlito-Italic.ttf');
  assert.equal(replacementFontFile('SegoeUI-Italic').file, 'Selawik-Regular.ttf');
  assert.equal(replacementFontFile('Verdana'), null);
  assert.equal(parseFontName('Arial-BoldMT').family, 'arial');
  assert.equal(symbolicStandardFont('ZapfDingbats'), 'ZapfDingbats');
  assert.equal(symbolicStandardFont('SymbolMT'), 'Symbol');
  assert.equal(symbolicStandardFont('Helvetica'), null);
});

test('content scan finds device colours outside strings and in inline images', () => {
  const scan = text => [...scanContentColours(new TextEncoder().encode(text), new Set())].sort();
  assert.deepEqual(scan('BT (0 0 0 1 k) Tj ET 0.5 g'), ['gray']);
  assert.deepEqual(scan('0 0 0 1 k 1 0 0 rg'), ['cmyk', 'rgb']);
  assert.deepEqual(scan('/DeviceCMYK cs 0 0 0 1 sc'), ['cmyk']);
  assert.deepEqual(scan('BI /W 1 /H 1 /CS /CMYK /BPC 8 ID \x00\x01\x02\x03 EI Q'), ['cmyk']);
});

test('generated ICC profiles have valid headers', () => {
  const rgb = srgbIccProfile();
  const view = new DataView(rgb.buffer);
  assert.equal(view.getUint32(0), rgb.length);
  assert.equal(String.fromCharCode(...rgb.subarray(36, 40)), 'acsp');
  assert.equal(String.fromCharCode(...rgb.subarray(12, 20)), 'mntrRGB ');
  const cmyk = naiveCmykIccProfile();
  assert.equal(new DataView(cmyk.buffer).getUint32(0), cmyk.length);
  assert.equal(String.fromCharCode(...cmyk.subarray(12, 20)), 'scnrCMYK');
});

test('a PDF with standard fonts, JavaScript and a bare note becomes PDF/A-2b', { skip: !haveFonts && 'run npm run sync:install for the bundled fonts' }, async () => {
  const pdf = await PDFLib.PDFDocument.create();
  const page = pdf.addPage([300, 200]);
  page.drawText('Grüße – “PDF/A”', { x: 20, y: 150, size: 14, font: await pdf.embedFont(PDFLib.StandardFonts.Helvetica) });
  page.drawText('\u2714', { x: 20, y: 100, size: 14, font: await pdf.embedFont(PDFLib.StandardFonts.ZapfDingbats) });
  const { context } = pdf;
  pdf.catalog.set(PDFLib.PDFName.of('OpenAction'), context.obj({ S: 'JavaScript', JS: PDFLib.PDFString.of('app.alert(1)') }));
  page.node.set(PDFLib.PDFName.of('Annots'), context.obj([context.register(context.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [200, 150, 220, 170], Contents: PDFLib.PDFString.of('note'),
  }))]));
  const bytes = await pdf.save();
  const result = await convertPdfBytesToPdfA(PDFLib, bytes, {
    loadFont: file => new Uint8Array(fs.readFileSync(new URL(file, FONTS))),
    now: new Date('2026-10-30T10:00:00Z'),
  });
  assert.equal(result.part, 2);
  assert.deepEqual(result.report.fontsEmbedded.map(entry => entry.to).sort(), ['DejaVu Sans glyphs', 'LiberationSans-Regular']);
  const out = await PDFLib.PDFDocument.load(result.bytes, { updateMetadata: false });
  const catalog = out.catalog;
  assert.equal(catalog.get(PDFLib.PDFName.of('OpenAction')), undefined);
  assert.ok(catalog.lookup(PDFLib.PDFName.of('OutputIntents')));
  const xmp = new TextDecoder().decode(catalog.lookup(PDFLib.PDFName.of('Metadata')).getContents());
  assert.match(xmp, /<pdfaid:part>2<\/pdfaid:part>/);
  assert.match(xmp, /<pdfaid:conformance>B<\/pdfaid:conformance>/);
  for (const [, object] of out.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFLib.PDFDict) || object.get(PDFLib.PDFName.of('Type'))?.toString() !== '/Font') continue;
    const descriptor = object.lookup(PDFLib.PDFName.of('FontDescriptor'));
    assert.ok(descriptor?.get(PDFLib.PDFName.of('FontFile2')), `${object.get(PDFLib.PDFName.of('BaseFont'))} is embedded`);
  }
  const note = out.getPages()[0].node.lookup(PDFLib.PDFName.of('Annots')).lookup(0);
  assert.equal(note.get(PDFLib.PDFName.of('F')).asNumber() & 4, 4);
  assert.ok(note.lookup(PDFLib.PDFName.of('AP')).get(PDFLib.PDFName.of('N')));
});

test('skew of synthetic text lines is found within 0.15°', () => {
  const width = 800;
  const height = 600;
  for (const degrees of [0, 2.5, -4]) {
    const gray = new Uint8Array(width * height).fill(255);
    const slope = Math.tan(degrees * Math.PI / 180);
    for (let line = 0; line < 14; line += 1) {
      for (let x = 60; x < 740; x += 1) {
        if ((x >> 4) % 5 === 4) continue; // gaps between "words"
        const y0 = Math.round(70 + line * 34 + x * slope);
        for (let y = y0; y < y0 + 9; y += 1) if (y >= 0 && y < height) gray[y * width + x] = 20;
      }
    }
    assert.ok(Math.abs(estimateSkewDegrees(gray, width, height) - degrees) <= 0.15, `skew ${degrees}`);
  }
  assert.equal(estimateSkewDegrees(new Uint8Array(width * height).fill(255), width, height), 0);
});

test('points of the straightened image map back onto the source', () => {
  const map = rotatedToSource(90, 100, 50, 50, 100);
  const [x, y] = map([25, 50]);
  assert.ok(Math.abs(x - 50) < 1e-9 && Math.abs(y - 25) < 1e-9);
  const [cx, cy] = rotatedToSource(3, 100, 50, 120, 80)([60, 40]);
  assert.ok(Math.abs(cx - 50) < 1e-9 && Math.abs(cy - 25) < 1e-9);
});

test('OCR languages on demand are pinned', () => {
  assert.equal(OCR_EXTRA_LANGUAGES.length, 40);
  for (const entry of OCR_EXTRA_LANGUAGES) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.ok(entry.size > 100_000);
  }
  assert.equal(isExtraOcrLanguage('pol'), true);
  assert.equal(isExtraOcrLanguage('eng'), false);
  assert.equal(extraOcrLanguageUrl('pol'), 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/pol@1.0.0/4.0.0_best_int');
});
