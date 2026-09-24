import { MAX_LAYERS, MAX_PIXELS, newLayer, type Layer, type LayerShape } from './document';
import type { VectorPath } from './model';
import { makeTransform, roundHalfAway, type Point, type Rect } from './geometry';
import { uuid } from './ids';
import { Raster, TILE } from './raster';
import type { EditorSession, PaletteColor } from './session';

export type ShapeKind = 'Rectangle' | 'Ellipse';

/** ShapeTool.swift `LayerShapeStyle`, using the exact Codable field names and raw kind values. */
export interface LayerShapeStyle extends LayerShape {
  readonly kind: ShapeKind;
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  /** Document pixels, not a percentage of the current bounds. */
  readonly cornerRadius: number;
}

export interface ShapeDraft {
  readonly kind: ShapeKind;
  readonly anchor: Point;
  readonly rect: Rect;
  readonly cornerRadius: number;
}

export const MAX_SHAPE_PIXELS = 100_000_000;

/** Selection.swift `DragBox.rect`: whole-pixel box, Shift square and Option from centre. */
export function shapeDragRect(anchor: Point, point: Point, square = false, fromCenter = false): Rect {
  let dx = roundHalfAway(point.x) - anchor.x, dy = roundHalfAway(point.y) - anchor.y;
  if (square) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = dx < 0 ? -side : side;
    dy = dy < 0 ? -side : side;
  }
  return fromCenter
    ? { x: anchor.x - Math.abs(dx), y: anchor.y - Math.abs(dy), width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 }
    : { x: Math.min(anchor.x, anchor.x + dx), y: Math.min(anchor.y, anchor.y + dy), width: Math.abs(dx), height: Math.abs(dy) };
}

/** ShapeTool.shapeImage: filled sRGB shape with antialiased curved edges. */
export function rasterizeShape(kind: ShapeKind, width: number, height: number, color: PaletteColor,
  cornerRadius = 0): Raster {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width * height > MAX_SHAPE_PIXELS) throw new RangeError('Invalid shape size');
  const red = byteColor(color.red), green = byteColor(color.green), blue = byteColor(color.blue);
  const radius = kind === 'Rectangle' ? Math.min(Math.max(0, cornerRadius), width / 2, height / 2) : 0;
  const cols = Math.ceil(width / TILE), rows = Math.ceil(height / TILE);
  const tiles: (Uint8Array | null)[] = [];
  for (let row = 0; row < rows; row++) {
    const tileHeight = Math.min(TILE, height - row * TILE);
    for (let col = 0; col < cols; col++) {
      const tileWidth = Math.min(TILE, width - col * TILE);
      const pixels = new Uint8Array(tileWidth * tileHeight * 4);
      let any = false;
      for (let y = 0; y < tileHeight; y++) {
        for (let x = 0; x < tileWidth; x++) {
          const alpha = kind === 'Rectangle' && radius <= 0 ? 1
            : shapeCoverage(kind, col * TILE + x, row * TILE + y, width, height, radius);
          if (alpha <= 0) continue;
          const p = (y * tileWidth + x) * 4;
          pixels[p] = red; pixels[p + 1] = green; pixels[p + 2] = blue; pixels[p + 3] = clampByte(alpha * 255);
          any = true;
        }
      }
      tiles.push(any ? pixels : null);
    }
  }
  return new Raster(width, height, 4, tiles);
}

function shapeCoverage(kind: ShapeKind, x: number, y: number, width: number, height: number, radius: number): number {
  const cx = x + 0.5, cy = y + 0.5;
  let signed: number;
  if (kind === 'Ellipse') {
    const rx = width / 2, ry = height / 2;
    signed = Math.hypot((cx - rx) / rx, (cy - ry) / ry) - 1;
    const margin = Math.SQRT1_2 / Math.max(0.5, Math.min(rx, ry));
    if (signed <= -margin) return 1;
    if (signed >= margin) return 0;
  } else {
    const nearCorner = (cx < radius || cx > width - radius) && (cy < radius || cy > height - radius);
    if (!nearCorner) return 1;
    const centerX = cx < radius ? radius : width - radius;
    const centerY = cy < radius ? radius : height - radius;
    signed = Math.hypot(cx - centerX, cy - centerY) - radius;
    if (signed <= -Math.SQRT1_2) return 1;
    if (signed >= Math.SQRT1_2) return 0;
  }
  // CoreGraphics-style edge coverage. Supersampling only ambiguous edge pixels keeps large shapes linear-time.
  const samples = 4;
  let inside = 0;
  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      const px = x + (sx + 0.5) / samples, py = y + (sy + 0.5) / samples;
      if (kind === 'Ellipse') {
        const rx = width / 2, ry = height / 2;
        if (((px - rx) / rx) ** 2 + ((py - ry) / ry) ** 2 <= 1) inside++;
      } else {
        const qx = px < radius ? radius : px > width - radius ? width - radius : px;
        const qy = py < radius ? radius : py > height - radius ? height - radius : py;
        if ((px - qx) ** 2 + (py - qy) ** 2 <= radius * radius) inside++;
      }
    }
  }
  return inside / (samples * samples);
}

function byteColor(value: number): number { return clampByte(Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)) * 255); }
function clampByte(value: number): number { return Math.max(0, Math.min(255, Math.round(value))); }

export function isLayerShapeStyle(shape: LayerShape | null): shape is LayerShapeStyle {
  if (!shape) return false;
  const value = shape as Partial<LayerShapeStyle>;
  return (value.kind === 'Rectangle' || value.kind === 'Ellipse')
    && [value.red, value.green, value.blue, value.cornerRadius].every((part) => typeof part === 'number' && Number.isFinite(part));
}

/** Rebuilds a live shape at the rounded transform size, keeping rounded corners in document pixels. */
export function redrawShapeLayer(layer: Layer): Layer {
  if (layer.kind !== 'vector' || !isLayerShapeStyle(layer.sourceShape)) return layer;
  const width = Math.max(1, roundHalfAway(layer.transform.size.width));
  const height = Math.max(1, roundHalfAway(layer.transform.size.height));
  if (layer.raster?.width === width && layer.raster.height === height) return layer;
  if (width * height > MAX_SHAPE_PIXELS) return layer;
  const style = layer.sourceShape;
  const raster = rasterizeShape(style.kind, width, height,
    { red: style.red, green: style.green, blue: style.blue }, style.cornerRadius);
  return { ...layer, raster };
}

/** Re-rasterises in the same transaction as a caller's scale operation. */
export function redrawShape(session: EditorSession, layerId: string): boolean {
  const document = session.document, layer = session.layer(layerId);
  if (!document || !layer) return false;
  const redrawn = redrawShapeLayer(layer);
  if (redrawn === layer) return false;
  session.replaceDocument({ ...document, layers: document.layers.map((item) => item.id === layerId ? redrawn : item) });
  session.notify('document');
  return true;
}

const drafts = new WeakMap<EditorSession, ShapeDraft>();
export function currentShapeDraft(session: EditorSession): ShapeDraft | null { return drafts.get(session) ?? null; }

export function beginShape(session: EditorSession, point: Point, kind: ShapeKind = 'Rectangle', cornerRadius = 0): boolean {
  if (session.tool !== 'shape' || !session.canEditLayers || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  const anchor = { x: roundHalfAway(point.x), y: roundHalfAway(point.y) };
  drafts.set(session, { kind, anchor, rect: { ...anchor, width: 0, height: 0 },
    cornerRadius: kind === 'Rectangle' ? Math.min(5000, Math.max(0, Number.isFinite(cornerRadius) ? cornerRadius : 0)) : 0 });
  session.notify('ui');
  return true;
}

export function updateShape(session: EditorSession, point: Point, square = false, fromCenter = false): ShapeDraft | null {
  const draft = drafts.get(session);
  if (!draft || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const updated = { ...draft, rect: shapeDragRect(draft.anchor, point, square, fromCenter) };
  drafts.set(session, updated);
  session.notify('ui');
  return updated;
}

export function cancelShape(session: EditorSession): boolean {
  if (!drafts.delete(session)) return false;
  session.notify('ui');
  return true;
}

/** ShapeTool.finishShape: a new live shape layer, one undo step, selection preserved. */
export function commitShape(session: EditorSession, color: PaletteColor = session.foregroundColor): string | null {
  const draft = drafts.get(session);
  if (!draft) return null;
  drafts.delete(session);
  const document = session.document, rect = draft.rect;
  if (!document || !session.canEditLayers || rect.width < 1 || rect.height < 1
      || rect.width * rect.height > Math.min(MAX_SHAPE_PIXELS, MAX_PIXELS)
      || document.layers.length >= MAX_LAYERS) return null;
  const raster = rasterizeShape(draft.kind, rect.width, rect.height, color, draft.cornerRadius);
  const style: LayerShapeStyle = { kind: draft.kind, red: color.red, green: color.green,
    blue: color.blue, cornerRadius: draft.cornerRadius };
  const active = session.activeLayer;
  const layer = newLayer({ id: uuid(), name: nextShapeName(document.layers, draft.kind), kind: 'vector', raster,
    paths: vectorPathsForShape(draft.kind, rect.width, rect.height, draft.cornerRadius),
    style: { fill: { kind: 'solid', schemaVersion: 1, color: { red: color.red, green: color.green, blue: color.blue } }, stroke: null },
    sourceShape: style,
    transform: makeTransform({ x: rect.x, y: rect.y }, { width: rect.width, height: rect.height }),
    parentId: active?.kind === 'group' ? active.id : active?.parentId ?? null });
  const layers = document.layers.slice();
  const index = layers.findIndex((item) => item.id === session.activeLayerId);
  session.beginEdit(draft.kind);
  layers.splice(index >= 0 ? index + 1 : layers.length, 0, layer);
  session.replaceDocument({ ...document, layers });
  session.setActiveLayer(layer.id);
  session.endEdit();
  return layer.id;
}

/** A5 consumes these paths directly; A2 keeps the existing raster cache for pixel-identical rendering. */
export function vectorPathsForShape(kind: ShapeKind, width: number, height: number, cornerRadius: number): readonly VectorPath[] {
  const point = (x: number, y: number, inX = x, inY = y, outX = x, outY = y) => ({
    anchor: { x, y }, in: { x: inX, y: inY }, out: { x: outX, y: outY },
  });
  if (kind === 'Ellipse') {
    const cx = width / 2, cy = height / 2, k = 0.5522847498307936;
    return [{ closed: true, points: [
      point(cx, 0, cx - cx * k, 0, cx + cx * k, 0),
      point(width, cy, width, cy - cy * k, width, cy + cy * k),
      point(cx, height, cx + cx * k, height, cx - cx * k, height),
      point(0, cy, 0, cy + cy * k, 0, cy - cy * k),
    ] }];
  }
  const radius = Math.min(Math.max(0, cornerRadius), width / 2, height / 2);
  if (radius === 0) return [{ closed: true, points: [point(0, 0), point(width, 0), point(width, height), point(0, height)] }];
  const handle = radius * 0.5522847498307936;
  return [{ closed: true, points: [
    point(radius, 0, radius - handle, 0), point(width - radius, 0, width - radius, 0, width - radius + handle, 0),
    point(width, radius, width, radius - handle), point(width, height - radius, width, height - radius, width, height - radius + handle),
    point(width - radius, height, width - radius + handle, height), point(radius, height, radius, height, radius - handle, height),
    point(0, height - radius, 0, height - radius + handle), point(0, radius, 0, radius, 0, radius - handle),
  ] }];
}

export function nextShapeName(layers: readonly Layer[], kind: ShapeKind): string {
  const names = new Set(layers.map((layer) => layer.name));
  let number = 1;
  while (names.has(`${kind} ${number}`)) number++;
  return `${kind} ${number}`;
}
