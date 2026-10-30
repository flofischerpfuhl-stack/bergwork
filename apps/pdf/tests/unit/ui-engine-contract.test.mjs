// Every value a control offers must be one the engine accepts, so a button can never run into a validation error.
// The test reads the lists out of the shell's own source as well: a value hard-coded next to the shared lists fails here.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../editor/vendor/build/src');
const load = file => import(path.join(src, file));
const controls = await load('pdf-editor/model/bergwork-text-controls.js');
const { layoutTextBlock } = await load('pdf-editor/model/text-layout.js');
const shell = await readFile(path.join(src, 'pdf-tools-shell.jsx'), 'utf8');

const layout = options => layoutTextBlock({ text: 'one two three four five six seven', width: 60, height: 200, fontSize: 10, ...options });

test('every text alignment offered is accepted by the text layout', () => {
  for (const [value] of controls.TEXT_ALIGNMENT_OFFERS) assert.ok(layout({ align: value }).lines.length > 0, value);
  assert.deepEqual(controls.TEXT_ALIGNMENT_OFFERS.map(([value]) => value), [...controls.TEXT_ENGINE_VALUES.alignments]);
});

test('every vertical alignment and overflow policy offered is accepted by the text layout', () => {
  for (const { value } of controls.TEXT_VERTICAL_OFFERS) assert.ok(layout({ verticalAlign: value }).lines.length > 0, value);
  for (const { value } of controls.TEXT_OVERFLOW_OFFERS) assert.ok(layout({ overflow: value }).lines.length > 0, value);
  for (const { value } of controls.TEXT_VERTICAL_OFFERS) assert.ok(controls.TEXT_ENGINE_VALUES.verticalAlignments.includes(value));
  for (const { value } of controls.TEXT_OVERFLOW_OFFERS) assert.ok(controls.TEXT_ENGINE_VALUES.overflowPolicies.includes(value));
});

test('a worker without justified text blocks gets no Justify button', () => {
  const values = features => controls.textBlockAlignmentChoices(features).map(([value]) => value);
  assert.deepEqual(values({}), ['left', 'center', 'right']);
  assert.deepEqual(values(undefined), ['left', 'center', 'right']);
  assert.deepEqual(values({ justifiedTextBlocks: true }), ['left', 'center', 'right', 'justify']);
});

test('the shell takes its text control values from the shared lists', () => {
  assert.doesNotMatch(shell, /\['justify', 'align-justify'/u);
  assert.match(shell, /textBlockAlignmentChoices\(pdfiumRuntime\?\.engineFeatures\)/u);
  assert.match(shell, /label="Vertical"[^\n]*\n[^\n]*options=\{TEXT_VERTICAL_OFFERS\}/u);
});

test('a text-align value set anywhere in the shell is one the layout accepts', () => {
  const set = [...shell.matchAll(/textAlign:\s*'([a-z]+)'/gu)].map(match => match[1]);
  for (const value of new Set(set)) assert.ok(controls.TEXT_ENGINE_VALUES.alignments.includes(value), value);
});

test('justified lines fill the frame through their word spaces, paragraph ends keep natural width', () => {
  const measureText = value => value.length * 6;
  const { lines } = layoutTextBlock({
    text: 'aa bb cc dd ee ff gg\nhh ii', width: 60, height: 200, fontSize: 10, align: 'justify', measureText,
  });
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map(line => line.text), ['aa bb cc', 'dd ee ff', 'gg', 'hh ii']);
  assert.equal(lines[0].wordSpacing, 6);
  assert.equal(lines[0].x, 0);
  assert.equal(lines[0].width, 60);
  assert.equal(lines[1].wordSpacing, 6);
  assert.equal(lines[2].wordSpacing, undefined);
  assert.equal(lines[3].wordSpacing, undefined);
});
