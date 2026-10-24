/**
 * Warp Text (PRODUCT-PLAN 6.6, Phase 3): Photoshop's fifteen envelope styles with bend and horizontal/vertical
 * distortion, as a smooth map of the unwarped text box onto the warped shape. The layout renders the shaped glyph
 * outlines through a fine piecewise-affine mesh of this map at the target resolution (layout.ts), so warped text stays
 * sharp at every zoom. Adobe does not publish the preset formulas; these envelopes follow each preset's documented shape
 * (and icon), are continuous in their parameters and are the identity at zero bend and distortion. New product work.
 */

import type { Point, Rect } from '../geometry';
import type { TextWarp, TextWarpStyle } from '../model';

export const TEXT_WARP_STYLES: readonly TextWarpStyle[] = ['arc', 'arcLower', 'arcUpper', 'arch', 'bulge', 'shellLower', 'shellUpper',
  'flag', 'wave', 'fish', 'rise', 'fisheye', 'inflate', 'squeeze', 'twist'];

/** Photoshop's names (English UI keys; German in i18n). */
export const TEXT_WARP_LABELS: Readonly<Record<TextWarpStyle, string>> = {
  arc: 'Arc', arcLower: 'Arc Lower', arcUpper: 'Arc Upper', arch: 'Arch', bulge: 'Bulge', shellLower: 'Shell Lower',
  shellUpper: 'Shell Upper', flag: 'Flag', wave: 'Wave', fish: 'Fish', rise: 'Rise', fisheye: 'Fish Eye', inflate: 'Inflate',
  squeeze: 'Squeeze', twist: 'Twist',
};

export function defaultTextWarp(style: TextWarpStyle = 'arc'): TextWarp {
  return { schemaVersion: 1, style, orientation: 'horizontal', bend: 50, horizontalDistortion: 0, verticalDistortion: 0 };
}

export function validTextWarp(value: TextWarp): boolean {
  const percent = (number: number) => Number.isFinite(number) && number >= -100 && number <= 100;
  return value.schemaVersion === 1 && TEXT_WARP_STYLES.includes(value.style) && ['horizontal', 'vertical'].includes(value.orientation)
    && percent(value.bend) && percent(value.horizontalDistortion) && percent(value.verticalDistortion);
}

/** A warp that leaves every point where it is. */
export function isIdentityWarp(value: TextWarp): boolean {
  return Math.abs(value.bend) < 1e-9 && Math.abs(value.horizontalDistortion) < 1e-9 && Math.abs(value.verticalDistortion) < 1e-9;
}

/**
 * The style's envelope on normalised box coordinates u, v ∈ −1…1 (y down), bend b ∈ −1…1. `a` and `h` are the
 * half-width and half-height in pixels for the two styles that work in true angles (Arc, Twist).
 */
function envelope(style: TextWarpStyle, u: number, v: number, b: number, a: number, h: number): [number, number] {
  const bow = 1 - u * u;
  switch (style) {
    case 'arc': {
      // The centre line becomes a circular arc of its own length; the text box's other lines are concentric (radial glyphs).
      const angle = b * Math.PI;
      if (Math.abs(angle) < 1e-9) return [u, v];
      const radius = 2 * a / angle, theta = u * angle / 2, rho = radius - v * h;
      return [rho * Math.sin(theta) / a, (radius - rho * Math.cos(theta)) / h];
    }
    case 'arcLower': return [u, v + b * bow * (1 + v) / 2];
    case 'arcUpper': return [u, v - b * bow * (1 - v) / 2];
    case 'arch': return [u, v - b * bow];
    case 'bulge': return [u, v * (1 + 0.6 * b * bow)];
    case 'shellLower': return [u * (1 - 0.35 * b * (1 - v) / 2), v + b * bow * (1 + v) / 2];
    case 'shellUpper': return [u * (1 - 0.35 * b * (1 + v) / 2), v - b * bow * (1 - v) / 2];
    case 'flag': return [u, v - 0.5 * b * Math.sin(Math.PI * u)];
    case 'wave': return [u, v - 0.5 * b * Math.sin(Math.PI * u + Math.PI / 2 * v)];
    case 'fish': return [u, v * (1 + 0.6 * b * Math.sin(Math.PI * (u + 1) * 0.75))];
    case 'rise': return [u, v - 0.8 * b * Math.sin(Math.PI * u / 2)];
    case 'fisheye': {
      const r2 = u * u + v * v;
      const factor = r2 < 1 ? 1 + 0.5 * b * (1 - r2) : 1;
      return [u * factor, v * factor];
    }
    case 'inflate': return [u * (1 + 0.3 * b * (1 - v * v)), v * (1 + 0.5 * b * bow)];
    case 'squeeze': return [u * (1 + 0.3 * b * (1 - v * v)), v * (1 - 0.5 * b * bow)];
    case 'twist': {
      // A swirl about the centre in true pixels: strongest in the middle, fading to nothing at the ellipse's rim.
      const r = Math.sqrt(u * u + v * v), turn = r < 1 ? b * Math.PI / 2 * (1 - r) ** 2 : 0;
      if (!turn) return [u, v];
      const x = u * a, y = v * h, cos = Math.cos(turn), sin = Math.sin(turn);
      return [(x * cos - y * sin) / a, (x * sin + y * cos) / h];
    }
  }
}

/** The warp as a map of pixel positions for a text box (layout pixels). */
export function warpFunction(warp: TextWarp, box: Rect): (point: Point) => Point {
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const vertical = warp.orientation === 'vertical';
  // Vertical warps bend along the other axis: the same envelope in a frame turned a quarter.
  const a = Math.max(1e-6, (vertical ? box.height : box.width) / 2), h = Math.max(1e-6, (vertical ? box.width : box.height) / 2);
  const b = warp.bend / 100, horizontal = warp.horizontalDistortion / 100, verticalDistortion = warp.verticalDistortion / 100;
  const style = warp.style;
  return (point) => {
    let x = point.x - cx, y = point.y - cy;
    if (vertical) [x, y] = [y, -x];
    const [u1, v1] = envelope(style, x / a, y / h, b, a, h);
    // Horizontal/vertical distortion: perspective-like growth of one side, with the far half compressed.
    const uu = u1 - 0.25 * horizontal * (1 - u1 * u1), vv = v1 - 0.25 * verticalDistortion * (1 - v1 * v1);
    const u2 = uu * (1 + 0.5 * verticalDistortion * v1), v2 = vv * (1 + 0.5 * horizontal * u1);
    let X = u2 * a, Y = v2 * h;
    if (vertical) [X, Y] = [-Y, X];
    return { x: cx + X, y: cy + Y };
  };
}

/** Numerical inverse (Newton with a finite-difference Jacobian): the unwarped point that lands on `target`. */
export function invertWarp(map: (point: Point) => Point, target: Point, guess: Point = target): Point {
  let p = { ...guess };
  for (let iteration = 0; iteration < 30; iteration++) {
    const q = map(p), ex = q.x - target.x, ey = q.y - target.y;
    if (Math.hypot(ex, ey) < 1e-4) return p;
    const step = 1e-3 * Math.max(1, Math.abs(p.x) + Math.abs(p.y)) + 1e-3;
    const qx = map({ x: p.x + step, y: p.y }), qy = map({ x: p.x, y: p.y + step });
    const j11 = (qx.x - q.x) / step, j21 = (qx.y - q.y) / step, j12 = (qy.x - q.x) / step, j22 = (qy.y - q.y) / step;
    const det = j11 * j22 - j12 * j21;
    if (!(Math.abs(det) > 1e-12)) break;
    let dx = (j22 * ex - j12 * ey) / det, dy = (-j21 * ex + j11 * ey) / det;
    // Damped steps keep the iteration inside strongly curved envelopes.
    const length = Math.hypot(dx, dy), limit = 50 + Math.hypot(p.x, p.y);
    if (length > limit) { dx *= limit / length; dy *= limit / length; }
    p = { x: p.x - dx, y: p.y - dy };
  }
  return p;
}

/** Bounding box of the warped box (sampled over its whole area: Twist and Fish Eye move interior points outward). */
export function warpedBounds(map: (point: Point) => Point, box: Rect, steps = 32): Rect {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (let j = 0; j <= steps; j++) for (let i = 0; i <= steps; i++) {
    const q = map({ x: box.x + box.width * i / steps, y: box.y + box.height * j / steps });
    left = Math.min(left, q.x); right = Math.max(right, q.x); top = Math.min(top, q.y); bottom = Math.max(bottom, q.y);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}
