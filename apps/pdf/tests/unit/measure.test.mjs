// berg:work: measurement model and the pdf-lib writer (node --test apps/pdf/tests/unit/).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as PDFLib from 'pdf-lib';
import {
  constrainTo45, defaultScale, formatMeasure, makeScale, measureDictValues, measurementsToCsv, measureValue,
  pathVerticesFromObjects, polygonArea, ratioLabel, scaleForPoint, scaleFromCalibration, scaleFromMeasureDict,
  scaleFromRatio,
} from '../../editor/vendor/build/src/pdf-editor/model/pdf-measure.js';
import {
  bytesMayHaveMeasurements, measurementAppearance, readMeasureData, removeMeasurement, writeMeasurement,
  writePageScale,
} from '../../editor/vendor/build/src/pdf-editor/engine/measure-annotations.js';

const close = (actual, expected, epsilon = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= epsilon * Math.max(1, Math.abs(expected)), `${actual} ≈ ${expected}`);

const hasTool = name => { try { execFileSync('which', [name], { stdio: 'ignore' }); return true; } catch { return false; } };

async function blankPdf(width = 841.89, height = 595.28) {
  const document = await PDFLib.PDFDocument.create();
  const page = document.addPage([width, height]);
  page.drawLine({ start: { x: 100, y: 100 }, end: { x: 400, y: 100 }, thickness: 1 });
  return new Uint8Array(await document.save({ useObjectStreams: false }));
}

function qpdfJson(bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'bw-measure-'));
  const file = join(dir, 'out.pdf');
  writeFileSync(file, bytes);
  execFileSync('qpdf', ['--check', file], { stdio: 'pipe' });
  // qpdf JSON v2: { qpdf: [header, { 'obj:N 0 R': { value } | { stream: { dict } } }] }
  const json = JSON.parse(execFileSync('qpdf', ['--json', '--json-key=qpdf', file]).toString());
  const objects = Object.values(json.qpdf[1]).map(entry => entry.value || entry.stream?.dict).filter(Boolean);
  return { file, objects };
}

test('scale from ratio and calibration', () => {
  const scale = scaleFromRatio(500, 'm');
  close(scale.factor, 500 * 0.0254 / 72);
  assert.equal(scale.label, '1:500');
  // 72 pt on paper at 1:500 is 0.0254 m * 500 = 12.7 m.
  close(measureValue('distance', [{ x: 0, y: 0 }, { x: 72, y: 0 }], scale).value, 12.7);
  const calibrated = scaleFromCalibration(141.732, 25, 'm');
  assert.equal(calibrated.label, '1:500'); // 141.732 pt = 50 mm on paper, 25 m in reality
  assert.equal(ratioLabel(0.5), '2:1');
  assert.throws(() => scaleFromCalibration(0.1, 5, 'm'));
  assert.throws(() => scaleFromCalibration(100, -1, 'm'));
  const fallback = defaultScale();
  assert.equal(fallback.unit, 'mm');
  assert.equal(fallback.label, '1:1');
});

test('area, perimeter and 45° constraint', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.equal(polygonArea(square), 100);
  const scale = makeScale({ unit: 'm', factor: 2 });
  const measured = measureValue('area', square, scale);
  assert.equal(measured.value, 400);
  assert.equal(measured.perimeter, 80);
  assert.equal(formatMeasure('area', square, scale, 'de-DE'), '400,00 m²');
  assert.equal(formatMeasure('perimeter', square, scale, 'en-US'), '60.00 m');
  const snapped = constrainTo45({ x: 0, y: 0 }, { x: 10, y: 1 });
  close(snapped.y, 0);
  close(snapped.x, 10);
  const diagonal = constrainTo45({ x: 0, y: 0 }, { x: 10, y: 9 });
  close(diagonal.x, diagonal.y);
});

test('/Measure dictionary round trip, Acrobat and CAD style', () => {
  const scale = scaleFromRatio(250, 'm');
  const back = scaleFromMeasureDict(measureDictValues(scale));
  close(back.factor, scale.factor);
  close(back.areaFactor, scale.areaFactor);
  assert.equal(back.unit, 'm');
  assert.equal(back.label, '1:250');
  // Acrobat: 1 in = 1 ft -> X C = 1/72 ft per pt; area in sq ft.
  const acrobat = scaleFromMeasureDict({ Type: 'Measure', Subtype: 'RL', R: '1 in = 1 ft',
    X: [{ U: 'ft', C: 0.0138889, D: 100 }], D: [{ U: 'ft', C: 1 }], A: [{ U: 'sq ft', C: 1 }] });
  assert.equal(acrobat.unit, 'ft');
  assert.equal(acrobat.areaLabel, 'ft²');
  close(measureValue('distance', [{ x: 0, y: 0 }, { x: 72, y: 0 }], acrobat).value, 1.0000008);
  assert.equal(scaleFromMeasureDict({ Subtype: 'GEO' }), null);
});

test('path vertices for snapping skip Bézier control points', () => {
  const points = pathVerticesFromObjects([{
    typeName: 'path', pageMatrix: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 },
    path: { sampledSegments: [
      { type: 2, point: { x: 0, y: 0 } }, { type: 0, point: { x: 5, y: 0 } },
      { type: 1, point: { x: 6, y: 1 } }, { type: 1, point: { x: 7, y: 2 } }, { type: 1, point: { x: 8, y: 3 } },
    ] },
  }, { typeName: 'text' }]);
  assert.deepEqual(points, [{ x: 10, y: 20 }, { x: 15, y: 20 }, { x: 18, y: 23 }]);
});

test('viewport lookup: the last viewport containing the point wins', () => {
  const page = { bbox: [0, 0, 800, 600], scale: scaleFromRatio(1000, 'm') };
  const detail = { bbox: [100, 100, 200, 200], scale: scaleFromRatio(100, 'm') };
  assert.equal(scaleForPoint([page, detail], { x: 150, y: 150 }).label, '1:100');
  assert.equal(scaleForPoint([page, detail], { x: 500, y: 150 }).label, '1:1000');
  assert.equal(scaleForPoint([], { x: 1, y: 1 }).label, '1:1');
});

test('appearance stays inside its rect', () => {
  const { content, rect } = measurementAppearance('distance', [{ x: 100, y: 100 }, { x: 300, y: 180 }], '12,34 m', {});
  assert.match(content, / l S/u);
  assert.match(content, /Tj/u);
  assert.ok(rect[0] < 100 && rect[1] < 100 && rect[2] > 300 && rect[3] > 180);
});

test('writes standard distance, perimeter and area annotations with /Measure and reads them back', async () => {
  let bytes = await blankPdf();
  const scale = scaleFromRatio(500, 'm');
  const distance = await writeMeasurement(PDFLib, bytes, { pageIndex: 0, kind: 'distance', scale, locale: 'de-DE',
    points: [{ x: 100, y: 100 }, { x: 241.732, y: 100 }], author: 'Florian (VBP)\\x' });
  bytes = distance.bytes;
  assert.equal(distance.annotationIndex, 0);
  const area = await writeMeasurement(PDFLib, bytes, { pageIndex: 0, kind: 'area', scale, locale: 'de-DE',
    points: [{ x: 100, y: 200 }, { x: 241.732, y: 200 }, { x: 241.732, y: 341.732 }, { x: 100, y: 341.732 }] });
  bytes = area.bytes;
  const perimeter = await writeMeasurement(PDFLib, bytes, { pageIndex: 0, kind: 'perimeter', scale, locale: 'en-US',
    points: [{ x: 400, y: 100 }, { x: 400, y: 241.732 }, { x: 541.732, y: 241.732 }] });
  bytes = perimeter.bytes;
  assert.ok(bytesMayHaveMeasurements(bytes));

  const data = await readMeasureData(PDFLib, bytes);
  const items = data.pages[0].items;
  assert.deepEqual(items.map(item => item.kind), ['distance', 'area', 'perimeter']);
  close(items[0].value, 25, 1e-4);
  close(items[1].value, 625, 1e-3);
  close(items[1].perimeter, 100, 1e-4);
  close(items[2].value, 50, 1e-4);
  assert.equal(items[0].author, 'Florian (VBP)\\x');
  assert.equal(items[0].contents, '25,00 m (1:500)');
  assert.ok(items.every(item => item.own));

  if (hasTool('qpdf')) {
    const { objects, file } = qpdfJson(bytes);
    const annots = objects.filter(value => value['/Type'] === '/Annot');
    assert.deepEqual(annots.map(value => value['/Subtype']).sort(), ['/Line', '/PolyLine', '/Polygon']);
    const line = annots.find(value => value['/Subtype'] === '/Line');
    assert.equal(line['/IT'], '/LineDimension');
    assert.equal(line['/Measure']['/Subtype'], '/RL');
    assert.equal(line['/Measure']['/Type'], '/Measure');
    assert.ok(line['/Measure']['/X'][0]['/C'] > 0.176 && line['/Measure']['/X'][0]['/C'] < 0.1765);
    assert.deepEqual(line['/L'], [100, 100, 241.732, 100]);
    const polygon = annots.find(value => value['/Subtype'] === '/Polygon');
    assert.equal(polygon['/IT'], '/PolygonDimension');
    assert.equal(polygon['/Vertices'].length, 8);
    if (hasTool('mutool')) {
      // MuPDF renders the appearance streams without complaints.
      execFileSync('mutool', ['draw', '-q', '-o', join(tmpdir(), 'bw-measure-render.png'), '-r', '72', file, '1'], { stdio: 'pipe' });
    }
  }

  // Editing keeps the object, replaces the appearance without orphans.
  const objectCount = (await PDFLib.PDFDocument.load(bytes)).context.enumerateIndirectObjects().length;
  const edited = await writeMeasurement(PDFLib, bytes, { pageIndex: 0, kind: 'distance', scale, locale: 'en-US',
    objectNumber: distance.objectNumber, points: [{ x: 100, y: 100 }, { x: 383.464, y: 100 }] });
  assert.equal(edited.objectNumber, distance.objectNumber);
  assert.equal((await PDFLib.PDFDocument.load(edited.bytes)).context.enumerateIndirectObjects().length, objectCount);
  close(edited.data.pages[0].items[0].value, 50, 1e-4);

  const removed = await removeMeasurement(PDFLib, edited.bytes, { pageIndex: 0, objectNumber: area.objectNumber });
  assert.deepEqual(removed.annotationIndexMaps[0], [0, -1, 1]);
  assert.deepEqual(removed.data.pages[0].items.map(item => item.kind), ['distance', 'perimeter']);
});

test('page scale as a viewport; detail viewports keep theirs', async () => {
  let bytes = await blankPdf();
  const first = await writePageScale(PDFLib, bytes, { pageIndex: 0, scale: scaleFromRatio(500, 'm') });
  assert.equal(first.data.pages[0].viewports.length, 1);
  assert.equal(first.data.pages[0].viewports[0].scale.label, '1:500');
  bytes = first.bytes;
  // A CAD-style file with a detail viewport.
  const document = await PDFLib.PDFDocument.load(bytes);
  const vp = document.getPage(0).node.lookup(PDFLib.PDFName.of('VP'));
  const detail = document.context.obj({ Type: 'Viewport', BBox: [100, 100, 300, 300] });
  detail.set(PDFLib.PDFName.of('Measure'), document.context.obj({ Type: 'Measure', Subtype: 'RL',
    X: [{ U: PDFLib.PDFString.of('m'), C: scaleFromRatio(50, 'm').factor }] }));
  vp.push(detail);
  bytes = new Uint8Array(await document.save({ useObjectStreams: false }));
  const read = await readMeasureData(PDFLib, bytes);
  assert.equal(scaleForPoint(read.pages[0].viewports, { x: 200, y: 200 }).label, '1:50');
  assert.equal(scaleForPoint(read.pages[0].viewports, { x: 600, y: 200 }).label, '1:500');
  // Recalibrating inside the detail changes only the detail.
  const recalibrated = await writePageScale(PDFLib, bytes, { pageIndex: 0, scale: scaleFromRatio(20, 'm'), at: { x: 150, y: 150 } });
  const viewports = recalibrated.data.pages[0].viewports;
  assert.equal(scaleForPoint(viewports, { x: 150, y: 150 }).label, '1:20');
  assert.equal(scaleForPoint(viewports, { x: 600, y: 200 }).label, '1:500');
});

test('CSV export', () => {
  const scale = scaleFromRatio(500, 'm');
  const csv = measurementsToCsv([
    { pageNumber: 1, kind: 'distance', value: 25, unitLabel: 'm', scale, points: [{}, {}], author: 'A', contents: 'x' },
    { pageNumber: 2, kind: 'area', value: 625.5, perimeter: 100, unitLabel: 'm²', scale, points: [{}, {}, {}] },
  ], { locale: 'de-DE' });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'Page;Type;Value;Unit;Perimeter;Perimeter unit;Scale;Points;Author;Modified;Label');
  assert.equal(lines[1], '1;Distance;25,00;m;;;1:500;2;A;;x');
  assert.equal(lines[2], '2;Area;625,50;m²;100,00;m;1:500;3;;;');
  assert.match(measurementsToCsv([], { locale: 'en-US' }), /^Page,Type,/u);
});
