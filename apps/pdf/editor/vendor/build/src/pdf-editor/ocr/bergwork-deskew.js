// berg:work: straightening a skewed scan before OCR. The skew is found by a
// projection profile: dark pixels are projected along candidate angles, and the
// angle whose row histogram changes most sharply (text lines and the gaps
// between them line up) wins. Recognition then reads the rotated image, and
// every recognised point is mapped back, so the invisible text follows the
// lines as they lie on the page.

const DARK = 150;
const MAX_POINTS = 120_000;

/**
 * @param {Uint8Array|Uint8ClampedArray} gray one byte per pixel, row by row
 * @returns {number} the skew in degrees: text baselines run along
 *   y = y0 + x * tan(angle) (image coordinates, y down); 0 when none is found.
 */
export function estimateSkewDegrees(gray, width, height, { maxDegrees = 6 } = {}) {
  let count = 0;
  for (let index = 0; index < gray.length; index += 1) if (gray[index] < DARK) count += 1;
  // Blank or almost black pages have no lines to measure.
  if (count < 200 || count > gray.length * 0.6) return 0;
  const stride = Math.max(1, Math.ceil(count / MAX_POINTS));
  const xs = new Float32Array(Math.ceil(count / stride) + 1);
  const ys = new Float32Array(xs.length);
  let points = 0;
  let seen = 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (gray[row + x] >= DARK) continue;
      if (seen++ % stride === 0) { xs[points] = x; ys[points] = y; points += 1; }
    }
  }
  const span = Math.ceil(height + width * Math.tan(maxDegrees * Math.PI / 180)) + 2;
  const offset = Math.ceil(width * Math.tan(maxDegrees * Math.PI / 180)) + 1;
  const histogram = new Float64Array(span + offset + 2);
  const score = degrees => {
    const slope = Math.tan(degrees * Math.PI / 180);
    histogram.fill(0);
    for (let index = 0; index < points; index += 1) {
      const bin = Math.round(ys[index] - xs[index] * slope) + offset;
      if (bin >= 0 && bin < histogram.length) histogram[bin] += 1;
    }
    let sum = 0;
    for (let bin = 1; bin < histogram.length; bin += 1) {
      const step = histogram[bin] - histogram[bin - 1];
      sum += step * step;
    }
    return sum;
  };
  const search = (from, to, step) => {
    let best = 0;
    let bestScore = -1;
    for (let degrees = from; degrees <= to + step / 2; degrees += step) {
      const value = score(degrees);
      if (value > bestScore) { bestScore = value; best = degrees; }
    }
    return { best, bestScore };
  };
  const coarse = search(-maxDegrees, maxDegrees, 0.25);
  const fine = search(coarse.best - 0.25, coarse.best + 0.25, 0.05);
  // A flat profile (no clear lines) gives no reliable angle.
  if (fine.bestScore <= score(0) * 1.02) return 0;
  return Math.round(fine.best * 100) / 100;
}

/** Below this the rotation would cost more sharpness than it gains. */
export const MIN_DESKEW_DEGREES = 0.3;

/**
 * Straightens `source` (a canvas) by `degrees`. Returns the rotated canvas and
 * a function mapping a point of it back to the source canvas.
 */
export function straightenCanvas(source, degrees, createCanvas = () => document.createElement('canvas')) {
  const angle = degrees * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const width = Math.ceil(Math.abs(source.width * cos) + Math.abs(source.height * sin));
  const height = Math.ceil(Math.abs(source.width * sin) + Math.abs(source.height * cos));
  const canvas = createCanvas();
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.translate(width / 2, height / 2);
  context.rotate(-angle);
  context.drawImage(source, -source.width / 2, -source.height / 2);
  return { canvas, toSource: rotatedToSource(degrees, source.width, source.height, width, height) };
}

export function rotatedToSource(degrees, sourceWidth, sourceHeight, width, height) {
  const angle = degrees * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return ([x, y]) => {
    const dx = x - width / 2;
    const dy = y - height / 2;
    return [sourceWidth / 2 + cos * dx - sin * dy, sourceHeight / 2 + sin * dx + cos * dy];
  };
}

/** Grey values of a canvas scaled down to at most `maxSide` pixels. */
export function canvasGray(source, maxSide = 1600, createCanvas = () => document.createElement('canvas')) {
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = createCanvas();
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  const gray = new Uint8Array(width * height);
  for (let index = 0; index < gray.length; index += 1) {
    gray[index] = (data[index * 4] * 77 + data[index * 4 + 1] * 150 + data[index * 4 + 2] * 29) >> 8;
  }
  return { gray, width, height };
}
