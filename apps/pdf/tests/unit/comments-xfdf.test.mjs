// berg:work: comment list (replies, review status) and XFDF export/import.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as PDFLib from 'pdf-lib';
import { readComments, writeCommentReply } from '../../editor/vendor/build/src/pdf-editor/engine/comment-index.js';
import { exportXfdf, importXfdf, parseXml } from '../../editor/vendor/build/src/pdf-editor/engine/xfdf.js';
import { writeCalloutAnnotation, writeShapeAnnotation, writeStampAnnotation } from '../../editor/vendor/build/src/pdf-editor/engine/markup-annotations.js';
import { readMeasureData, writeMeasurement } from '../../editor/vendor/build/src/pdf-editor/engine/measure-annotations.js';
import { scaleFromRatio } from '../../editor/vendor/build/src/pdf-editor/model/pdf-measure.js';

const hasTool = name => { try { execFileSync('which', [name], { stdio: 'ignore' }); return true; } catch { return false; } };

async function blankPdf(pages = 2) {
  const document = await PDFLib.PDFDocument.create();
  for (let index = 0; index < pages; index += 1) document.addPage([595.28, 841.89]);
  return new Uint8Array(await document.save({ useObjectStreams: false }));
}

async function sampleWithComments() {
  let bytes = await blankPdf();
  const step = async (fn, args) => { const result = await fn(PDFLib, bytes, args); bytes = result.bytes; return result; };
  const cloud = await step(writeShapeAnnotation, { pageIndex: 0, kind: 'cloud', author: 'Florian', points: [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }] });
  await step(writeStampAnnotation, { pageIndex: 1, center: { x: 300, y: 400 }, preset: { id: 'draft', text: 'DRAFT', color: '#1c7ed6' }, author: 'Anna' });
  await step(writeCalloutAnnotation, { pageIndex: 0, tip: { x: 50, y: 500 }, anchor: { x: 120, y: 520 }, value: 'Hier & dort <prüfen>', author: 'Florian' });
  await step(writeMeasurement, { pageIndex: 0, kind: 'distance', scale: scaleFromRatio(500, 'm'), points: [{ x: 100, y: 700 }, { x: 241.732, y: 700 }], author: 'Florian' });
  await step(writeCommentReply, { pageIndex: 0, parentObjectNumber: cloud.objectNumber, value: 'Einverstanden', author: 'Anna', now: new Date('2026-10-29T10:00:00Z') });
  await step(writeCommentReply, { pageIndex: 0, parentObjectNumber: cloud.objectNumber, state: 'Rejected', author: 'Anna', now: new Date('2026-10-29T10:05:00Z') });
  await step(writeCommentReply, { pageIndex: 0, parentObjectNumber: cloud.objectNumber, state: 'Accepted', author: 'Florian', now: new Date('2026-10-29T11:00:00Z') });
  return { bytes, cloud };
}

test('XML parser handles entities, CDATA, namespaces and > inside attributes', () => {
  const root = parseXml('<?xml version="1.0"?><x:a xmlns:x="u" b="1 &gt; 0"><c><![CDATA[<raw>]]> &amp; text</c><d e=\'q"\'/></x:a>');
  const a = root.children[0];
  assert.equal(a.name, 'a');
  assert.equal(a.attributes.b, '1 > 0');
  assert.equal(a.children[0].text, '<raw> & text');
  assert.equal(a.children[1].attributes.e, 'q"');
  assert.throws(() => parseXml('<a><b></a>'));
});

test('comment list: types, replies in order, latest review status', async () => {
  const { bytes } = await sampleWithComments();
  const comments = await readComments(PDFLib, bytes);
  assert.deepEqual(comments.map(item => item.type), ['Cloud', 'Callout', 'Distance', 'Stamp']);
  const cloud = comments[0];
  assert.equal(cloud.author, 'Florian');
  assert.deepEqual(cloud.replies.map(reply => [reply.author, reply.contents]), [['Anna', 'Einverstanden']]);
  assert.equal(cloud.status, 'Accepted');
  assert.equal(cloud.statusAuthor, 'Florian');
  assert.equal(comments[3].pageIndex, 1);
});

test('XFDF export and import round trip into another copy of the document', async () => {
  const { bytes } = await sampleWithComments();
  const xfdf = await exportXfdf(PDFLib, bytes, { fileName: 'plan.pdf' });
  assert.match(xfdf, /<polygon [^>]*style="cloudy"/u);
  assert.match(xfdf, /<freetext [^>]*callout="/u);
  assert.match(xfdf, /<contents>Hier &amp; dort &lt;prüfen&gt;<\/contents>/u);
  assert.match(xfdf, /<line [^>]*intent="LineDimension"[^>]*>.*<measure rateValue="1:500">/su);
  assert.match(xfdf, /<text [^>]*inreplyto="bergwork-markup-/u);
  assert.match(xfdf, /state="Accepted" statemodel="Review"/u);
  assert.match(xfdf, /<f href="plan.pdf"\/>/u);

  const target = await blankPdf();
  const imported = await importXfdf(PDFLib, target, xfdf);
  assert.equal(imported.added, 7);
  assert.equal(imported.skipped, 0);
  const comments = await readComments(PDFLib, imported.bytes);
  assert.deepEqual(comments.map(item => item.type), ['Cloud', 'Callout', 'Distance', 'Stamp']);
  assert.equal(comments[0].status, 'Accepted');
  assert.equal(comments[0].replies.length, 1);
  assert.equal(comments[1].contents, 'Hier & dort <prüfen>');
  // The measurement keeps its scale.
  const measured = await readMeasureData(PDFLib, imported.bytes);
  assert.ok(Math.abs(measured.pages[0].items[0].value - 25) < 0.01);
  // A second import of the same file adds nothing.
  const again = await importXfdf(PDFLib, imported.bytes, xfdf);
  assert.equal(again.added, 0);
  assert.equal(again.skipped, 7);
  if (hasTool('qpdf')) {
    const file = join(mkdtempSync(join(tmpdir(), 'bw-xfdf-')), 'imported.pdf');
    writeFileSync(file, imported.bytes);
    execFileSync('qpdf', ['--check', file], { stdio: 'pipe' });
    if (hasTool('mutool')) execFileSync('mutool', ['draw', '-q', '-o', join(tmpdir(), 'bw-xfdf.png'), '-r', '72', file, '1'], { stdio: 'pipe' });
  }
});

test('imports an Acrobat-style XFDF with shapes, ink, highlight and a note', async () => {
  const xfdf = `<?xml version="1.0" encoding="UTF-8" ?>
<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve"><annots>
<square color="#FF0000" creationdate="D:20261020101010+02'00'" flags="print" date="D:20261020101010+02'00'" name="sq1" page="0" rect="100,100,200,180" subject="Rectangle" title="Reviewer" width="2"><contents>Box</contents></square>
<circle color="#0000FF" flags="print" name="ci1" page="0" rect="250,100,330,180" title="Reviewer" interior-color="#FFFF00"/>
<ink color="#00AA00" flags="print" name="in1" page="0" rect="50,300,150,360" title="Reviewer" width="1.5"><inklist><gesture>50,300;80,340;150,360</gesture></inklist></ink>
<highlight color="#FFFF00" flags="print" name="hl1" page="0" rect="50,400,200,415" coords="50,415,200,415,50,400,200,400" title="Reviewer"/>
<text color="#FFFF00" flags="print,nozoom,norotate" name="tx1" page="1" rect="20,780,40,800" icon="Comment" title="Reviewer"><contents>Note on page 2</contents></text>
<text name="r1" page="1" rect="20,780,40,800" inreplyto="tx1" title="Florian"><contents>Reply</contents></text>
<square page="7" rect="0,0,10,10" name="off"/>
</annots></xfdf>`;
  const imported = await importXfdf(PDFLib, await blankPdf(), xfdf);
  assert.equal(imported.added, 6);
  assert.equal(imported.skipped, 1);
  const comments = await readComments(PDFLib, imported.bytes);
  assert.deepEqual(comments.map(item => item.type), ['Rectangle', 'Ellipse', 'Drawing', 'Highlight', 'Note']);
  assert.equal(comments[4].replies[0].contents, 'Reply');
  const document = await PDFLib.PDFDocument.load(imported.bytes);
  const annots = document.getPage(0).node.lookup(PDFLib.PDFName.of('Annots')).asArray().map(ref => document.context.lookup(ref));
  // Shapes, ink and highlight got an appearance; flags came across.
  assert.ok(annots.every(dict => dict.get(PDFLib.PDFName.of('AP'))));
  assert.equal(annots[0].lookup(PDFLib.PDFName.of('F')).asNumber(), 4);
});
