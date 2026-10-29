// berg:work: an image file dropped onto an image on the page replaces that image (Canva frames). Pure helpers for
// the hit test and the fitting; the shell finds the candidates (native PDF images from the PDFium inspection,
// inserted image annotations) and commits the replacement as one image edit.

// Is the point inside the convex quad (four {x, y} corners in order, either winding)?
export function pointInQuad(point, quad) {
  if (!Array.isArray(quad) || quad.length !== 4) return false;
  let sign = 0;
  for (let index = 0; index < 4; index += 1) {
    const a = quad[index];
    const b = quad[(index + 1) % 4];
    const cross = (Number(b.x) - Number(a.x)) * (point.y - Number(a.y)) -
      (Number(b.y) - Number(a.y)) * (point.x - Number(a.x));
    if (Math.abs(cross) < 1e-9) continue;
    const next = cross > 0 ? 1 : -1;
    if (sign && next !== sign) return false;
    sign = next;
  }
  return true;
}

// Is the point inside an annotation's frame {x, y, w, h}? A turned annotation turns by `angle` (radians) about its
// top-left corner, as the page draws it.
export function pointInAnnotationFrame(point, ann = {}) {
  const w = Number(ann.w);
  const h = Number(ann.h);
  if (!(w > 0) || !(h > 0)) return false;
  const angle = -(Number(ann.angle) || 0);
  const dx = point.x - Number(ann.x);
  const dy = point.y - Number(ann.y);
  const lx = dx * Math.cos(angle) - dy * Math.sin(angle);
  const ly = dx * Math.sin(angle) + dy * Math.cos(angle);
  return lx >= 0 && lx <= w && ly >= 0 && ly <= h;
}

// The corners of that frame, for the drop outline.
export function annotationFrameQuad(ann = {}) {
  const angle = Number(ann.angle) || 0;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const x = Number(ann.x) || 0;
  const y = Number(ann.y) || 0;
  return [[0, 0], [ann.w, 0], [ann.w, ann.h], [0, ann.h]].map(([u, v]) => ({
    x: x + u * cos - v * sin,
    y: y + u * sin + v * cos,
  }));
}

// A picture cut to the frame's proportions (fillCrop) as a PNG data URL, at most `maxSide` pixels on its long side.
export async function fillImageForFrame(image, aspect, maxSide = 4096) {
  const width = Math.max(1, image.naturalWidth || image.width || 1);
  const height = Math.max(1, image.naturalHeight || image.height || 1);
  const crop = fillCrop(width, height, aspect);
  const scale = Math.min(1, maxSide / Math.max(crop.sw, crop.sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(crop.sw * scale));
  canvas.height = Math.max(1, Math.round(crop.sh * scale));
  canvas.getContext('2d').drawImage(image, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height);
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
}

// Width / height of an image's own frame. A PDF image fills the unit square of its matrix [a b c d e f], so the
// frame's sides are the lengths of (a, b) and (c, d); that also holds for turned and skewed images. Without a
// matrix the frame is the box.
export function imageFrameAspect({ matrix, w, h } = {}) {
  const m = Array.isArray(matrix) ? matrix
    : matrix && typeof matrix === 'object' ? [matrix.a, matrix.b, matrix.c, matrix.d] : null;
  if (m && m.length >= 4) {
    const width = Math.hypot(Number(m[0]) || 0, Number(m[1]) || 0);
    const height = Math.hypot(Number(m[2]) || 0, Number(m[3]) || 0);
    if (width > 0 && height > 0) return width / height;
  }
  return Number(w) > 0 && Number(h) > 0 ? Number(w) / Number(h) : 1;
}

// The part of a `width` × `height` picture that fills a frame of `aspect` (Canva's "fill"): the middle, cut to
// the frame's proportions. Returns the source rectangle in pixels.
export function fillCrop(width, height, aspect) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const target = Number(aspect) > 0 ? Number(aspect) : w / h;
  if (Math.abs(w / h - target) < 0.005) return { sx: 0, sy: 0, sw: w, sh: h };
  if (w / h > target) {
    const sw = Math.max(1, Math.round(h * target));
    return { sx: Math.round((w - sw) / 2), sy: 0, sw, sh: h };
  }
  const sh = Math.max(1, Math.round(w / target));
  return { sx: 0, sy: Math.round((h - sh) / 2), sw: w, sh };
}

// The topmost hit: inserted images lie above the page content; among native images a later draw (higher object
// index) is on top; among annotations the later one.
export function topmostImageHit(annotationHits = [], nativeHits = []) {
  if (annotationHits.length) return annotationHits[annotationHits.length - 1];
  if (!nativeHits.length) return null;
  return nativeHits.reduce((best, hit) => (
    Number(hit.objectIndex) > Number(best.objectIndex) ? hit : best
  ));
}
