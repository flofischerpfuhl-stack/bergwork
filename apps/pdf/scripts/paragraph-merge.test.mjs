// "Edit as paragraph" planning (apps/pdf/editor/vendor/build/src/pdf-editor/model/paragraph-merge.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { joinParagraphLines, planParagraphMerge, texProducedDocument } from '../editor/vendor/build/src/pdf-editor/model/paragraph-merge.js';

const PAGE = 'p1';
const style = (font = 'g_d0_f1', size = 11, weight = '400', fontStyle = 'normal') =>
  ({ pdfFontName: font, fontSize: size, fontWeight: weight, fontStyle });

// One detected block with one item (and layer) per line, 11 pt with a 16 pt line pitch, left-aligned at x = 50.
function fixture(lines, { pitch = 16, x = () => 50, runStyle = () => style() } = {}) {
  const layers = [];
  const blockLines = lines.map((text, index) => {
    const id = String(index * 2);
    const width = text.length * 5;
    const item = {
      sourceId: `${PAGE}:txt:${id}`, pageId: PAGE, text, str: text, originalText: text,
      sourceX: x(index, width), sourceY: 100 + index * pitch, sourceW: width, sourceH: 13,
      sourceBaselineX: x(index, width), sourceBaselineY: 110 + index * pitch,
      ...style(), ...runStyle(index),
    };
    layers.push({ key: `text:${item.sourceId}`, type: 'text', pageId: PAGE, item });
    return { id: `line-${index}`, itemIds: [id], text, runs: [{ itemIds: [id], text, style: runStyle(index) }] };
  });
  const blocks = [{ id: 'block', itemIds: blockLines.flatMap(line => line.itemIds), lines: blockLines,
    writingMode: 'horizontal', direction: 'ltr' }];
  return { pageId: PAGE, blocks, layers };
}

test('joins lines with single spaces, keeps inner spacing and undoes layout hyphenation', () => {
  assert.equal(joinParagraphLines(['nothing.  The PDF ', 'is read by']), 'nothing.  The PDF is read by');
  assert.equal(joinParagraphLines(['an exam-', 'ple']), 'an example');
  assert.equal(joinParagraphLines(['soft­', 'hyphen']), 'softhyphen');
  assert.equal(joinParagraphLines(['Ein-', 'und Ausgang']), 'Ein- und Ausgang');
  assert.equal(joinParagraphLines(['Baden-', 'Württemberg']), 'Baden-Württemberg');
});

test('plans one frame from the first line with the paragraph text, width, pitch and alignment', () => {
  const input = fixture(['The survey covers the plot', 'boundary and the access road.']);
  const plan = planParagraphMerge({ ...input, sourceId: `${PAGE}:txt:2` });
  assert.equal(plan.ok, true);
  assert.equal(plan.first.item.sourceId, `${PAGE}:txt:0`);
  assert.deepEqual(plan.others.map(layer => layer.item.sourceId), [`${PAGE}:txt:2`]);
  assert.equal(plan.text, 'The survey covers the plot boundary and the access road.');
  assert.equal(plan.block.align, 'left');
  assert.ok(Math.abs(plan.block.lineHeight - 16 / 11) < 1e-9);
  assert.ok(plan.block.width > 29 * 5 && plan.block.width < 29 * 5 + 3);
  assert.equal(plan.block.height, 32);
});

test('reads centred paragraphs as centred', () => {
  const input = fixture(['A centred title line that is long', 'and a short one'], { x: (index, width) => 300 - width / 2 });
  assert.equal(planParagraphMerge({ ...input, sourceId: `${PAGE}:txt:0` }).block.align, 'center');
});

test('a centred paragraph takes its short last line from the next detected block', () => {
  const input = fixture(['A centred title line that is long', 'and a second one as long as it', 'short end'],
    { x: (index, width) => 300 - width / 2 });
  const [first, second, third] = input.blocks[0].lines;
  input.blocks = [
    { ...input.blocks[0], itemIds: [...first.itemIds, ...second.itemIds], lines: [first, second] },
    { id: 'tail', itemIds: third.itemIds, lines: [third], writingMode: 'horizontal', direction: 'ltr' },
  ];
  const plan = planParagraphMerge({ ...input, sourceId: `${PAGE}:txt:0` });
  assert.equal(plan.block.align, 'center');
  assert.equal(plan.lineCount, 3);
  assert.equal(plan.text, 'A centred title line that is long and a second one as long as it short end');
});

test('an indented, justified paragraph stays left-aligned and places the frame at the body edge', () => {
  const lines = ['Indented first line of a justified', 'paragraph whose body lines all end at', 'the same right margin as each other', 'end.'];
  // Body lines span 50..250, the first line starts 15 pt in; the last line is short.
  const input = fixture(lines, { x: index => (index === 0 ? 65 : 50) });
  input.layers.forEach((layer, index) => {
    layer.item.sourceW = index === 3 ? 20 : 250 - layer.item.sourceX;
  });
  const plan = planParagraphMerge({ ...input, sourceId: `${PAGE}:txt:2` });
  assert.equal(plan.block.align, 'left');
  assert.equal(plan.block.justified, true);
  assert.deepEqual(plan.block.placement, { x: 50, y: 110 - 11 });
  assert.equal(plan.first.item.sourceId, `${PAGE}:txt:0`);
  assert.equal(plan.text, lines.join(' '));
  assert.ok(plan.block.width > 200 && plan.block.width < 203);
});

test('prefers the native string where PDF.js collapsed repeated spaces', () => {
  const input = fixture(['End.  Next sentence', 'continues here.']);
  Object.assign(input.layers[0].item, { text: 'End. Next sentence', str: 'End. Next sentence', originalText: 'End. Next sentence' });
  const plan = planParagraphMerge({ ...input, sourceId: `${PAGE}:txt:0`,
    nativeText: item => (item.sourceId.endsWith(':0') ? 'End.  Next sentence' : '') });
  assert.equal(plan.text, 'End.  Next sentence continues here.');
});

test('a wider gap between lines ends the paragraph', () => {
  const input = fixture(['First paragraph line one', 'first paragraph ends.', 'Second paragraph line one', 'second ends.']);
  // Word's "space after": 6 pt more between the second and third line.
  input.layers.slice(2).forEach(layer => { layer.item.sourceBaselineY += 6; layer.item.sourceY += 6; });
  const plan = planParagraphMerge({ ...input, sourceId: `${PAGE}:txt:6` });
  assert.equal(plan.lineCount, 2);
  assert.equal(plan.text, 'Second paragraph line one second ends.');
  assert.equal(planParagraphMerge({ ...input, sourceId: `${PAGE}:txt:0` }).text, 'First paragraph line one first paragraph ends.');
});

test('a line set wholly in another font starts another paragraph', () => {
  const input = fixture(['First paragraph line one', 'first paragraph line two', 'Second paragraph in f3', 'still second'],
    { runStyle: index => style(index < 2 ? 'g_d0_f1' : 'g_d0_f3') });
  const plan = planParagraphMerge({ ...input, sourceId: `${PAGE}:txt:0` });
  assert.equal(plan.ok, true);
  assert.equal(plan.lineCount, 2);
});

test('refuses single lines, mixed formatting, deleted lines and existing frames', () => {
  const single = fixture(['Only one line']);
  assert.equal(planParagraphMerge({ ...single, sourceId: `${PAGE}:txt:0` }).reason, 'single-line');

  const superscript = fixture(['between the 240th and', 'the 260th character']);
  superscript.blocks[0].lines[0].runs.push({ itemIds: ['0'], text: 'th', style: style('g_d0_f1', 7) });
  assert.equal(planParagraphMerge({ ...superscript, sourceId: `${PAGE}:txt:0` }).reason, 'mixed-style');

  const averaged = fixture(['between the 240th and', 'the 260th character']);
  averaged.layers[0].item.fontSize = 10.8;
  assert.equal(planParagraphMerge({ ...averaged, sourceId: `${PAGE}:txt:2` }).reason, 'mixed-style');

  const deleted = fixture(['line one of two', 'line two of two']);
  deleted.layers[1].deleted = true;
  assert.equal(planParagraphMerge({ ...deleted, sourceId: `${PAGE}:txt:0` }).reason, 'deleted');

  const frame = fixture(['line one of two', 'line two of two']);
  frame.layers[0].item.textFrame = true;
  assert.equal(planParagraphMerge({ ...frame, sourceId: `${PAGE}:txt:0` }).reason, 'frame');
});

test('TeX output stays as lines: its fonts have no space glyph for the frame to lay out', () => {
  assert.equal(texProducedDocument({ creator: 'LaTeX with hyperref', producer: 'pdfTeX-1.40.23' }), true);
  assert.equal(texProducedDocument({ creator: ' XeTeX output 2024.12.10:1556', producer: 'xdvipdfmx (20240305)' }), true);
  assert.equal(texProducedDocument({ producer: 'luahbtex-1.24.0' }), true);
  assert.equal(texProducedDocument({ creator: 'Microsoft® Word for Microsoft 365', producer: 'Skia/PDF m152' }), false);
  const input = fixture(['line one of two', 'line two of two']);
  assert.equal(planParagraphMerge({ ...input, sourceId: `${PAGE}:txt:0`, texDocument: true }).reason, 'tex-spacing');
});
