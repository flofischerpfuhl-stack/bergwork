// berg:work: Word and many other producers draw an underline as a separate thin path below the text, so moving or
// turning the text left the line behind. This finds that path for a text object, and the matrix that carries it along.
// Everything here is in PDF page space; matrices are [a, b, c, d, e, f] with row vectors, as in the PDF model.

const INLINE_SLACK_PT = 6;

const quadCenter = quad => ({
  x: quad.reduce((sum, point) => sum + Number(point.x), 0) / quad.length,
  y: quad.reduce((sum, point) => sum + Number(point.y), 0) / quad.length,
});

const unit = (x, y) => {
  const length = Math.hypot(x, y);
  return length > 1e-9 ? { x: x / length, y: y / length } : null;
};

function quadExtents(quad, axis) {
  const along = quad.map(point => Number(point.x) * axis.x + Number(point.y) * axis.y);
  return Math.max(...along) - Math.min(...along);
}

/**
 * The path that underlines a text object, or null.
 * @param {object} input
 * @param {number[]} input.textMatrix  the text's page matrix; its first row gives the reading direction
 * @param {{x: number, y: number}} input.center  centre of the text box
 * @param {number} input.inlineSize  width of the text box along its reading direction
 * @param {number} input.blockSize  height of the text box
 * @param {number} input.fontSize
 * @param {object[]} input.objects  the page's native object descriptors
 */
export function findUnderlineCompanion({ textMatrix, center, inlineSize, blockSize, fontSize, objects = [] }) {
  const inline = unit(Number(textMatrix?.[0]), Number(textMatrix?.[1]));
  const block = unit(Number(textMatrix?.[2]), Number(textMatrix?.[3]));
  if (!inline || !block || !(inlineSize > 0) || !(blockSize > 0) || !(fontSize > 0)) return null;
  const thickest = Math.max(2.5, fontSize * 0.25);
  const candidates = [];
  for (const object of objects) {
    if (object?.typeName !== 'path' || object.nested || !object.stableId || object.pageQuad?.length !== 4) continue;
    const thickness = quadExtents(object.pageQuad, block);
    const length = quadExtents(object.pageQuad, inline);
    if (thickness > thickest || Math.abs(length - inlineSize) > INLINE_SLACK_PT) continue;
    const middle = quadCenter(object.pageQuad);
    const dx = middle.x - center.x;
    const dy = middle.y - center.y;
    const alongInline = dx * inline.x + dy * inline.y;
    const alongBlock = dx * block.x + dy * block.y;
    const bottom = -blockSize / 2;
    if (Math.abs(alongInline) > INLINE_SLACK_PT) continue;
    if (alongBlock > bottom + fontSize * 0.3 || alongBlock < bottom - fontSize * 0.35) continue;
    candidates.push({ object, distance: Math.abs(alongBlock - bottom) });
  }
  candidates.sort((left, right) => left.distance - right.distance);
  return candidates[0]?.object || null;
}

const multiply = (left, right) => [
  left[0] * right[0] + left[1] * right[2],
  left[0] * right[1] + left[1] * right[3],
  left[2] * right[0] + left[3] * right[2],
  left[2] * right[1] + left[3] * right[3],
  left[4] * right[0] + left[5] * right[2] + right[4],
  left[4] * right[1] + left[5] * right[3] + right[5],
];

function invert(matrix) {
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 1e-12) return null;
  return [
    d / determinant, -b / determinant, -c / determinant, a / determinant,
    (c * f - d * e) / determinant, (b * e - a * f) / determinant,
  ];
}

/** The companion's new matrix for a text object going from `before` to `after`: the same page-space motion. */
export function companionMatrix(companion, before, after) {
  const inverse = invert(before);
  return inverse ? multiply(companion, multiply(inverse, after)) : null;
}
