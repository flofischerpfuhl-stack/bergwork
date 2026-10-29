// berg:work: comment markups written with pdf-lib (polyline, polygon, cloud, stamp, callout).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as PDFLib from 'pdf-lib';
import {
  calloutAppearance, cloudPath, readPageMarkup, removeAnnotationObject, stampDetail, translateMarkupAnnotation,
  wrapText, writeCalloutAnnotation, writeShapeAnnotation, writeStampAnnotation,
} from '../../editor/vendor/build/src/pdf-editor/engine/markup-annotations.js';
import { writeMeasurement } from '../../editor/vendor/build/src/pdf-editor/engine/measure-annotations.js';
import { scaleFromRatio } from '../../editor/vendor/build/src/pdf-editor/model/pdf-measure.js';

const hasTool = name => { try { execFileSync('which', [name], { stdio: 'ignore' }); return true; } catch { return false; } };
// 1×1 red PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

async function blankPdf() {
  const document = await PDFLib.PDFDocument.create();
  document.addPage([595.28, 841.89]);
  return new Uint8Array(await document.save({ useObjectStreams: false }));
}

function qpdfObjects(bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'bw-markup-'));
  const file = join(dir, 'out.pdf');
  writeFileSync(file, bytes);
  execFileSync('qpdf', ['--check', file], { stdio: 'pipe' });
  const json = JSON.parse(execFileSync('qpdf', ['--json', '--json-key=qpdf', file]).toString());
  return { file, objects: Object.values(json.qpdf[1]).map(entry => entry.value || entry.stream?.dict).filter(Boolean) };
}

test('cloud path bulges outward for both orientations', () => {
  const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  for (const points of [square, [...square].reverse()]) {
    const path = cloudPath(points, 5);
    const ys = [...path.matchAll(/(-?[\d.]+) (-?[\d.]+) c/gu)].map(match => Number(match[2]));
    // The bottom edge's arcs reach below y = 0, so they lie outside the square.
    assert.ok(Math.min(...ys) < -3, `min y ${Math.min(...ys)}`);
  }
});

test('text wrapping and callout geometry', () => {
  assert.deepEqual(wrapText('aaa bbb ccc', 30, 10), ['aaa', 'bbb', 'ccc']);
  assert.deepEqual(wrapText('one\ntwo', 200, 10), ['one', 'two']);
  const callout = calloutAppearance({ tip: { x: 100, y: 100 }, anchor: { x: 200, y: 150 }, value: 'Check this', style: {} });
  assert.equal(callout.callout[0].x, 100);
  assert.ok(callout.box[0] >= 200);
  assert.ok(callout.rect[0] <= 100 - 5 && callout.rect[2] >= callout.box[2]);
});

test('writes polyline, polygon, cloud, stamps and a callout that qpdf accepts and read them back', async () => {
  let bytes = await blankPdf();
  const write = async (fn, args) => { const result = await fn(PDFLib, bytes, { pageIndex: 0, author: 'Florian', ...args }); bytes = result.bytes; return result; };
  const polyline = await write(writeShapeAnnotation, { kind: 'polyline', points: [{ x: 50, y: 50 }, { x: 150, y: 80 }, { x: 200, y: 40 }] });
  const polygon = await write(writeShapeAnnotation, { kind: 'polygon', points: [{ x: 50, y: 200 }, { x: 150, y: 200 }, { x: 120, y: 300 }] });
  const cloud = await write(writeShapeAnnotation, { kind: 'cloud', points: [{ x: 300, y: 200 }, { x: 450, y: 200 }, { x: 450, y: 320 }, { x: 300, y: 320 }] });
  const stamp = await write(writeStampAnnotation, { center: { x: 300, y: 600 }, preset: { id: 'approved', text: 'APPROVED', color: '#2b8a3e' },
    detail: stampDetail({ author: 'Florian', locale: 'de-DE', now: new Date('2026-10-29T10:00:00Z') }) });
  const image = await write(writeStampAnnotation, { center: { x: 300, y: 700 }, image: { dataUrl: PNG, width: 1, height: 1, name: 'logo.png' } });
  const callout = await write(writeCalloutAnnotation, { tip: { x: 100, y: 500 }, anchor: { x: 180, y: 540 }, value: 'Grenzabstand prüfen' });
  // Measurements stay measurements.
  const measure = await writeMeasurement(PDFLib, bytes, { pageIndex: 0, kind: 'area', scale: scaleFromRatio(100, 'm'),
    points: [{ x: 400, y: 400 }, { x: 500, y: 400 }, { x: 500, y: 500 }] });
  bytes = measure.bytes;

  const data = await readPageMarkup(PDFLib, bytes);
  assert.deepEqual(data.markups.map(item => item.kind), ['polyline', 'polygon', 'cloud', 'stamp', 'stamp']);
  assert.ok(data.markups.every(item => item.own && item.author === 'Florian'));
  assert.equal(data.markups[3].stampName, 'Approved');
  assert.equal(data.pages[0].items.length, 1);
  assert.match(stampDetail({ author: 'Flo', locale: 'de-DE', now: new Date('2026-10-29T10:00:00Z') }), /29\.10\.2026.*Flo/u);

  if (hasTool('qpdf')) {
    const { objects, file } = qpdfObjects(bytes);
    const annots = objects.filter(value => value['/Type'] === '/Annot');
    const bySubtype = subtype => annots.filter(value => value['/Subtype'] === subtype);
    assert.equal(bySubtype('/PolyLine').length, 1);
    assert.equal(bySubtype('/Polygon').length, 3);
    const cloudDict = bySubtype('/Polygon').find(value => value['/IT'] === '/PolygonCloud');
    assert.deepEqual(cloudDict['/BE'], { '/S': '/C', '/I': 1 });
    assert.equal(bySubtype('/Stamp').length, 2);
    const freeText = bySubtype('/FreeText')[0];
    assert.equal(freeText['/IT'], '/FreeTextCallout');
    assert.equal(freeText['/CL'].length, 6);
    assert.equal(freeText['/LE'], '/OpenArrow');
    assert.ok(annots.every(value => value['/AP'] && value['/F'] === 4));
    if (hasTool('mutool')) execFileSync('mutool', ['draw', '-q', '-o', join(tmpdir(), 'bw-markup.png'), '-r', '72', file, '1'], { stdio: 'pipe' });
  }

  const moved = await translateMarkupAnnotation(PDFLib, bytes, { pageIndex: 0, objectNumber: stamp.objectNumber, dx: 10, dy: -20 });
  const movedStamp = moved.data.markups.find(item => item.objectNumber === stamp.objectNumber);
  const before = data.markups.find(item => item.objectNumber === stamp.objectNumber);
  assert.equal(movedStamp.rect[0], before.rect[0] + 10);
  assert.equal(movedStamp.rect[1], before.rect[1] - 20);
  const edited = await writeShapeAnnotation(PDFLib, moved.bytes, { pageIndex: 0, kind: 'polygon', objectNumber: polygon.objectNumber,
    points: [{ x: 50, y: 200 }, { x: 160, y: 200 }, { x: 120, y: 310 }, { x: 40, y: 260 }] });
  assert.equal(edited.data.markups.find(item => item.objectNumber === polygon.objectNumber).points.length, 4);
  const removed = await removeAnnotationObject(PDFLib, edited.bytes, { pageIndex: 0, objectNumber: image.objectNumber });
  assert.equal(removed.data.markups.length, 4);
  assert.equal(removed.annotationIndexMaps[0][4], -1);
  assert.equal(removed.annotationIndexMaps[0][5], 4);
  void polyline; void cloud; void callout;
});
