import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../editor/vendor/build/src');
const { companionMatrix, findUnderlineCompanion } = await import(path.join(src, 'pdf-editor/model/bergwork-underline-companion.js'));

const rect = (left, bottom, right, top) => [
  { x: left, y: bottom }, { x: right, y: bottom }, { x: right, y: top }, { x: left, y: top },
];
const path_ = (stableId, quad, extra = {}) => ({ typeName: 'path', stableId, nested: false, pageQuad: quad, ...extra });
// The heading of bezuege.pdf: text box 71–361 × 596.4–605.9, line 70.8–361.44 × 596.4–597.48.
const heading = {
  textMatrix: [9.96, 0, 0, 9.96],
  center: { x: 216, y: 601.15 },
  inlineSize: 290,
  blockSize: 9.5,
  fontSize: 9.96,
};

test('the thin path under the whole text is its underline', () => {
  const objects = [path_('table-line', rect(71.3, 561.2, 410.8, 561.7)), path_('line', rect(70.8, 596.4, 361.44, 597.48))];
  assert.equal(findUnderlineCompanion({ ...heading, objects })?.stableId, 'line');
});

test('a table rule, a shorter line, a tall box, a nested path or a line above are not', () => {
  const none = objects => assert.equal(findUnderlineCompanion({ ...heading, objects }), null);
  none([path_('wider', rect(70, 596.4, 500, 597))]);
  none([path_('short', rect(71, 596.4, 200, 597))]);
  none([path_('box', rect(70.8, 590, 361.4, 597.5))]);
  none([path_('nested', rect(70.8, 596.4, 361.4, 597.4), { nested: true })]);
  none([path_('above', rect(70.8, 607, 361.4, 608))]);
  none([path_('far-below', rect(70.8, 590, 361.4, 591))]);
  none([{ ...path_('text', rect(70.8, 596.4, 361.4, 597.4)), typeName: 'text' }]);
});

test('a turned text finds its turned line', () => {
  const cos = Math.cos(Math.PI / 6);
  const sin = Math.sin(Math.PI / 6);
  const turn = point => ({ x: point.x * cos + point.y * sin, y: -point.x * sin + point.y * cos });
  const objects = [path_('line', rect(-145, -5.2, 145, -4.2).map(turn))];
  assert.equal(findUnderlineCompanion({
    textMatrix: [9.96 * cos, -9.96 * sin, 9.96 * sin, 9.96 * cos],
    center: { x: 0, y: 0 }, inlineSize: 290, blockSize: 9.5, fontSize: 9.96, objects,
  })?.stableId, 'line');
});

test('the companion follows the text through a move and a turn', () => {
  const close = (actual, expected) => actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-9, `${index}: ${value}`));
  close(companionMatrix([1, 0, 0, 1, 0, 0], [10, 0, 0, 10, 70, 600], [10, 0, 0, 10, 110, 570]), [1, 0, 0, 1, 40, -30]);
  // Turned by 90° about the text's origin (70, 600), a point of the line at (70, 596) ends at (74, 600).
  const turned = companionMatrix([1, 0, 0, 1, 0, 0], [10, 0, 0, 10, 70, 600], [0, -10, 10, 0, 70, 600]);
  close([turned[0] * 70 + turned[2] * 596 + turned[4], turned[1] * 70 + turned[3] * 596 + turned[5]], [66, 600]);
});
