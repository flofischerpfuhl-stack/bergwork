// berg:work: unit tests for the page tools (crop, resize, split plans). Run: node --test apps/pdf/tests/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as PDFLib from 'pdf-lib';
import {
  applyPageBoxes, boxInsetsForVisualMargins, croppedBox, inkMarginsFromRaster, marginsFromFractions, orientedTarget,
  pagesInsertedAt, resizedPagePlan, splitAtBookmarks, splitBySize, splitEveryN, splitPartFileNames,
} from '../editor/vendor/build/src/pdf-editor/model/bergwork-page-tools.js';

const margins = { top: 1, right: 2, bottom: 3, left: 4 };

test('a format keeps the orientation of each page when asked to', () => {
  const a4 = { width: 595, height: 842, matchOrientation: true };
  assert.deepEqual(orientedTarget(a4, { width: 842, height: 595 }, 0), { ...a4, width: 842, height: 595 });
  assert.deepEqual(orientedTarget(a4, { width: 595, height: 842 }, 0), a4);
  // A portrait box turned by 90° is seen landscape.
  assert.deepEqual(orientedTarget(a4, { width: 595, height: 842 }, 90), { ...a4, width: 842, height: 595 });
  assert.equal(orientedTarget({ width: 595, height: 842 }, { width: 842, height: 595 }, 0).width, 595);
});

test('detected ink becomes margins with a little air, never negative', () => {
  assert.deepEqual(marginsFromFractions({ top: 0.1, bottom: 0, left: 0.5, right: 0.25 }, { width: 100, height: 200 }),
    { top: 18, bottom: 0, left: 48, right: 23 });
  assert.equal(marginsFromFractions(null, { width: 1, height: 1 }), null);
});

test('applyPageBoxes crops each page by its own margins', async () => {
  const { bytes, changed } = await applyPageBoxes(PDFLib, await samplePdf(), {
    pageIndices: [0, 1], cropByIndex: { 0: { left: 100 } },
  });
  assert.deepEqual(changed, [0]);
  const pdf = await PDFLib.PDFDocument.load(bytes);
  assert.equal(pdf.getPage(0).getCropBox().x, 100);
  assert.equal(pdf.getPage(1).getCropBox().x, 0);
});

test('visual margins map to the unrotated box for each quarter turn', () => {
  assert.deepEqual(boxInsetsForVisualMargins(margins, 0), { left: 4, top: 1, right: 2, bottom: 3 });
  assert.deepEqual(boxInsetsForVisualMargins(margins, 90), { left: 1, top: 2, right: 3, bottom: 4 });
  assert.deepEqual(boxInsetsForVisualMargins(margins, 180), { left: 2, top: 3, right: 4, bottom: 1 });
  assert.deepEqual(boxInsetsForVisualMargins(margins, 270), { left: 3, top: 4, right: 1, bottom: 2 });
  assert.deepEqual(boxInsetsForVisualMargins(margins, -90), boxInsetsForVisualMargins(margins, 270));
});

test('cropping cuts the visible box and refuses a page that would vanish', () => {
  assert.deepEqual(croppedBox({ x: 10, y: 20, width: 100, height: 200 }, margins, 0), { x: 14, y: 23, width: 94, height: 196 });
  assert.equal(croppedBox({ x: 0, y: 0, width: 100, height: 100 }, { left: 50, right: 45 }, 0), null);
});

test('resizing scales content to fit and centres it, or grows the page around it', () => {
  const fit = resizedPagePlan({ x: 0, y: 0, width: 842, height: 1191 }, 0, { width: 595, height: 842 });
  assert.ok(Math.abs(fit.scale - Math.min(595 / 842, 842 / 1191)) < 1e-9);
  assert.deepEqual(fit.box, { x: 0, y: 0, width: 595, height: 842 });
  // Centred: the offsets split the free space evenly.
  assert.ok(Math.abs(fit.matrix[4] - (595 - 842 * fit.scale) / 2) < 1e-9);
  assert.ok(Math.abs(fit.matrix[5] - (842 - 1191 * fit.scale) / 2) < 1e-9);
  const grow = resizedPagePlan({ x: 0, y: 0, width: 100, height: 100 }, 0, { width: 200, height: 300 }, { scaleContent: false });
  assert.deepEqual(grow, { box: { x: -50, y: -100, width: 200, height: 300 }, matrix: null });
  // A page turned by 90° is seen landscape: the requested landscape size is portrait in its own box.
  const turned = resizedPagePlan({ x: 0, y: 0, width: 100, height: 200 }, 90, { width: 400, height: 200 }, { scaleContent: false });
  assert.equal(turned.box.width, 200);
  assert.equal(turned.box.height, 400);
});

test('ink margins come from the darkest pixels of a raster', () => {
  const width = 10;
  const height = 20;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 5; y <= 14; y += 1) for (let x = 2; x <= 6; x += 1) data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
  assert.deepEqual(inkMarginsFromRaster(data, width, height), { top: 5 / 20, bottom: 5 / 20, left: 2 / 10, right: 3 / 10 });
  assert.equal(inkMarginsFromRaster(new Uint8ClampedArray(width * height * 4).fill(255), width, height), null);
});

test('split plans: every N pages, top-level bookmarks, size', async () => {
  assert.deepEqual(splitEveryN(7, 3), [{ from: 0, to: 2 }, { from: 3, to: 5 }, { from: 6, to: 6 }]);
  assert.deepEqual(splitEveryN(0, 3), []);
  assert.deepEqual(splitAtBookmarks(10, [
    { title: 'B', pageIndex: 5, depth: 0 },
    { title: 'A', pageIndex: 2, depth: 0 },
    { title: 'A.1', pageIndex: 3, depth: 1 },
    { title: 'A again', pageIndex: 2, depth: 0 },
  ]), [{ from: 0, to: 1, title: '' }, { from: 2, to: 4, title: 'A' }, { from: 5, to: 9, title: 'B' }]);
  // Page i weighs i+1 bytes; parts of at most 6 bytes.
  const measure = async (from, to) => { let sum = 0; for (let i = from; i <= to; i += 1) sum += i + 1; return sum; };
  assert.deepEqual(await splitBySize(5, 6, measure), [
    { from: 0, to: 2 }, { from: 3, to: 3 }, { from: 4, to: 4 },
  ]);
  assert.deepEqual(await splitBySize(2, 1, measure), [{ from: 0, to: 0 }, { from: 1, to: 1, oversize: true }]);
});

test('split part names are safe and unique', () => {
  assert.deepEqual(splitPartFileNames('Report.pdf', [
    { from: 0, to: 1, title: '' }, { from: 2, to: 2, title: 'Intro: a/b' }, { from: 3, to: 9, title: 'Intro: a/b' },
  ]), ['Report - 1 pages 1-2.pdf', 'Report - 2 Intro a b.pdf', 'Report - 3 Intro a b.pdf']);
});

test('pages are inserted at a clamped position', () => {
  assert.deepEqual(pagesInsertedAt([1, 2, 3], ['a', 'b'], 1), [1, 'a', 'b', 2, 3]);
  assert.deepEqual(pagesInsertedAt([1, 2], ['a'], 99), [1, 2, 'a']);
  assert.deepEqual(pagesInsertedAt([1, 2], ['a'], undefined), [1, 2, 'a']);
});

async function samplePdf() {
  const pdf = await PDFLib.PDFDocument.create();
  const a = pdf.addPage([600, 800]);
  a.drawRectangle({ x: 100, y: 100, width: 50, height: 50 });
  const b = pdf.addPage([600, 800]);
  b.setRotation(PDFLib.degrees(90));
  const annots = pdf.context.obj([pdf.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [100, 100, 200, 200] })]);
  a.node.set(PDFLib.PDFName.of('Annots'), annots);
  return pdf.save();
}

test('applyPageBoxes crops the CropBox only and keeps the MediaBox', async () => {
  const { bytes, changed } = await applyPageBoxes(PDFLib, await samplePdf(), { pageIndices: [0, 1], crop: { top: 10, left: 20 } });
  assert.deepEqual(changed, [0, 1]);
  const pdf = await PDFLib.PDFDocument.load(bytes);
  const [a, b] = pdf.getPages();
  assert.deepEqual(a.getCropBox(), { x: 20, y: 0, width: 580, height: 790 });
  assert.deepEqual(a.getMediaBox(), { x: 0, y: 0, width: 600, height: 800 });
  // Turned by 90°: the visual top is the box's left edge, the visual left its bottom.
  assert.deepEqual(b.getCropBox(), { x: 10, y: 20, width: 590, height: 780 });
});

test('applyPageBoxes resizes with scaled content and annotations', async () => {
  const { bytes } = await applyPageBoxes(PDFLib, await samplePdf(), { pageIndices: [0], resize: { width: 300, height: 400 } });
  const pdf = await PDFLib.PDFDocument.load(bytes);
  const page = pdf.getPage(0);
  assert.deepEqual(page.getMediaBox(), { x: 0, y: 0, width: 300, height: 400 });
  assert.deepEqual(page.getCropBox(), { x: 0, y: 0, width: 300, height: 400 });
  const rect = page.node.Annots().lookup(0).lookup(PDFLib.PDFName.of('Rect')).asArray().map(item => item.asNumber());
  assert.deepEqual(rect, [50, 50, 100, 100]);
  assert.equal(pdf.getPage(1).getMediaBox().width, 600);
});
