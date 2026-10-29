// berg:work: hit test and fitting for "drop an image onto an image" (node --test apps/pdf/tests/unit/).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  annotationFrameQuad, fillCrop, imageFrameAspect, pointInAnnotationFrame, pointInQuad, topmostImageHit,
} from '../../editor/vendor/build/src/pdf-editor/interaction/bergwork-image-drop-replace.js';

test('pointInQuad accepts either winding and rejects outside points', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.equal(pointInQuad({ x: 5, y: 5 }, square), true);
  assert.equal(pointInQuad({ x: 5, y: 5 }, [...square].reverse()), true);
  assert.equal(pointInQuad({ x: 11, y: 5 }, square), false);
  const diamond = [{ x: 5, y: 0 }, { x: 10, y: 5 }, { x: 5, y: 10 }, { x: 0, y: 5 }];
  assert.equal(pointInQuad({ x: 1, y: 1 }, diamond), false);
  assert.equal(pointInQuad({ x: 5, y: 5 }, diamond), true);
});

test('annotation frames turn about their top-left corner', () => {
  const ann = { x: 100, y: 100, w: 40, h: 20, angle: Math.PI / 2 };
  // Turned a quarter clockwise (y down): the frame now spans x 80..100, y 100..140.
  assert.equal(pointInAnnotationFrame({ x: 90, y: 130 }, ann), true);
  assert.equal(pointInAnnotationFrame({ x: 120, y: 110 }, ann), false);
  const quad = annotationFrameQuad(ann).map(point => ({ x: Math.round(point.x), y: Math.round(point.y) }));
  assert.deepEqual(quad, [{ x: 100, y: 100 }, { x: 100, y: 140 }, { x: 80, y: 140 }, { x: 80, y: 100 }]);
});

test('imageFrameAspect reads the image matrix, also turned', () => {
  assert.equal(imageFrameAspect({ matrix: [200, 0, 0, 100, 0, 0] }), 2);
  const c = Math.cos(Math.PI / 6);
  const s = Math.sin(Math.PI / 6);
  assert.ok(Math.abs(imageFrameAspect({ matrix: { a: 200 * c, b: 200 * s, c: -100 * s, d: 100 * c } }) - 2) < 1e-9);
  assert.equal(imageFrameAspect({ w: 30, h: 60 }), 0.5);
});

test('fillCrop cuts the middle to the frame proportions', () => {
  assert.deepEqual(fillCrop(400, 200, 1), { sx: 100, sy: 0, sw: 200, sh: 200 });
  assert.deepEqual(fillCrop(120, 300, 1), { sx: 0, sy: 90, sw: 120, sh: 120 });
  assert.deepEqual(fillCrop(400, 200, 2), { sx: 0, sy: 0, sw: 400, sh: 200 });
});

test('topmostImageHit prefers inserted images, then the later PDF draw', () => {
  assert.equal(topmostImageHit([], []), null);
  assert.equal(topmostImageHit([{ id: 'a' }, { id: 'b' }], [{ objectIndex: 9 }]).id, 'b');
  assert.equal(topmostImageHit([], [{ objectIndex: 2, id: 'low' }, { objectIndex: 7, id: 'high' }]).id, 'high');
});
