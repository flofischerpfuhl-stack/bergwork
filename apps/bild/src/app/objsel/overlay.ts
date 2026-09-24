/**
 * Document-sized pictures drawn over the canvas (Quick Mask tint, Refine Edge views, Color Range preview) and the
 * mask resampling between document and layer grids that Refine Edge's layer outputs need.
 */

import { apply, pixelToDocument, type LayerTransform, type Point } from '../../core/geometry';
import type { EditorSession } from '../../core/session';

/** Past this side the picture is kept at a lower resolution; the committed result is always full size. */
const MAX_SIDE = 4096;

export interface DocRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** An RGBA picture covering the document, rewritten in parts while painting. */
export class DocumentOverlay {
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  private readonly image: ImageData;
  private readonly context: CanvasRenderingContext2D;

  constructor(readonly docWidth: number, readonly docHeight: number, maxSide = MAX_SIDE) {
    this.scale = Math.min(1, maxSide / Math.max(docWidth, docHeight));
    this.width = Math.max(1, Math.round(docWidth * this.scale));
    this.height = Math.max(1, Math.round(docHeight * this.scale));
    this.canvas = Object.assign(document.createElement('canvas'), { width: this.width, height: this.height });
    this.context = this.canvas.getContext('2d')!;
    this.image = this.context.createImageData(this.width, this.height);
  }

  /** Rewrites a document rectangle (everything without one); `write` fills out[o…o+3] for the document pixel `index`. */
  update(write: (out: Uint8ClampedArray, o: number, index: number) => void, rect?: DocRect | null): void {
    const s = this.scale;
    const x0 = rect ? Math.max(0, Math.floor(rect.x * s)) : 0, y0 = rect ? Math.max(0, Math.floor(rect.y * s)) : 0;
    const x1 = rect ? Math.min(this.width, Math.ceil((rect.x + rect.width) * s)) : this.width;
    const y1 = rect ? Math.min(this.height, Math.ceil((rect.y + rect.height) * s)) : this.height;
    if (x1 <= x0 || y1 <= y0) return;
    const data = this.image.data, w = this.docWidth, h = this.docHeight;
    for (let y = y0; y < y1; y++) {
      const dy = Math.min(h - 1, Math.floor((y + 0.5) / s)) * w;
      for (let x = x0; x < x1; x++) write(data, (y * this.width + x) * 4, dy + Math.min(w - 1, Math.floor((x + 0.5) / s)));
    }
    this.context.putImageData(this.image, 0, 0, x0, y0, x1 - x0, y1 - y0);
  }

  draw(context: CanvasRenderingContext2D, session: EditorSession): void {
    const document = session.document;
    if (!document) return;
    const origin = session.viewport.viewPoint({ x: 0, y: 0 }, document), ppp = session.viewport.pointsPerPixel;
    context.imageSmoothingEnabled = ppp * this.scale < 1;
    context.drawImage(this.canvas, origin.x, origin.y, document.width * ppp, document.height * ppp);
  }
}

let checker: CanvasPattern | null = null;
/** The transparency checkerboard under the document (On Layers). */
export function drawChecker(context: CanvasRenderingContext2D, session: EditorSession): void {
  const document = session.document;
  if (!document) return;
  if (!checker) {
    const tile = Object.assign(window.document.createElement('canvas'), { width: 16, height: 16 });
    const c = tile.getContext('2d')!;
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, 16, 16);
    c.fillStyle = '#cccccc'; c.fillRect(0, 0, 8, 8); c.fillRect(8, 8, 8, 8);
    checker = context.createPattern(tile, 'repeat');
  }
  const origin = session.viewport.viewPoint({ x: 0, y: 0 }, document), ppp = session.viewport.pointsPerPixel;
  context.fillStyle = checker ?? '#ffffff';
  context.fillRect(origin.x, origin.y, document.width * ppp, document.height * ppp);
}

/** A round brush outline at the hover point, `diameter` in document pixels. */
export function drawBrushOutline(context: CanvasRenderingContext2D, session: EditorSession, point: Point | null, diameter: number): void {
  if (!point || !session.document) return;
  const radius = Math.max(1, diameter / 2 * session.viewport.pointsPerPixel);
  context.beginPath();
  context.arc(point.x, point.y, radius, 0, Math.PI * 2);
  context.lineWidth = 1;
  context.strokeStyle = 'rgba(0,0,0,0.75)';
  context.stroke();
  context.beginPath();
  context.arc(point.x, point.y, Math.max(0.5, radius - 1), 0, Math.PI * 2);
  context.strokeStyle = 'rgba(255,255,255,0.9)';
  context.stroke();
}

/**
 * Stamps a round dab into a document-sized coverage buffer, keeping the maximum per pixel (one stroke never builds
 * up past its opacity). Returns the touched rectangle.
 */
export function stampDab(coverage: Uint8Array, width: number, height: number, center: Point, diameter: number,
  hardness: number, opacity: number): DocRect | null {
  const radius = Math.max(0.5, diameter / 2);
  const x0 = Math.max(0, Math.floor(center.x - radius)), y0 = Math.max(0, Math.floor(center.y - radius));
  const x1 = Math.min(width, Math.ceil(center.x + radius)), y1 = Math.min(height, Math.ceil(center.y + radius));
  if (x1 <= x0 || y1 <= y0) return null;
  const inner = radius * Math.min(0.999, Math.max(0, hardness)), peak = Math.round(255 * Math.max(0, Math.min(1, opacity)));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const distance = Math.hypot(x + 0.5 - center.x, y + 0.5 - center.y);
      if (distance >= radius) continue;
      const falloff = distance <= inner ? 1 : 1 - (distance - inner) / (radius - inner);
      const value = Math.round(peak * falloff * falloff * (3 - 2 * falloff)), at = y * width + x;
      if (value > coverage[at]!) coverage[at] = value;
    }
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Dabs spaced a quarter diameter apart along a segment, as brushes do. */
export function stampSegment(coverage: Uint8Array, width: number, height: number, from: Point, to: Point, diameter: number,
  hardness: number, opacity: number): DocRect | null {
  const length = Math.hypot(to.x - from.x, to.y - from.y), step = Math.max(0.5, diameter / 4);
  const count = Math.max(1, Math.ceil(length / step));
  let rect: DocRect | null = null;
  for (let i = 1; i <= count; i++) {
    const t = i / count;
    rect = unionRect(rect, stampDab(coverage, width, height, { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, diameter, hardness, opacity));
  }
  return rect;
}

export function unionRect(a: DocRect | null, b: DocRect | null): DocRect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Resamples a document-sized mask onto a layer's pixel grid (bilinear; outside the document is unselected). */
export function documentMaskToLayer(mask: Uint8Array, docWidth: number, docHeight: number, transform: LayerTransform,
  width: number, height: number): Uint8Array {
  const map = pixelToDocument(transform, width, height), output = new Uint8Array(width * height);
  const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= docWidth || y >= docHeight ? 0 : mask[y * docWidth + x]!);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = apply(map, { x: x + 0.5, y: y + 0.5 }), px = p.x - 0.5, py = p.y - 0.5;
      const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
      output[y * width + x] = Math.round(at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy)
        + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy);
    }
  }
  return output;
}
