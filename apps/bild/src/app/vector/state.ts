/**
 * Per-project vector tool state (PRODUCT-PLAN A5, 6.6): the Shape tool's primitive and its parameters, the shared
 * fill and stroke settings of the Shape and Pen tools, the path operation, the Pen's path in progress and the Direct
 * Selection tool's selected anchors. Settings follow Photoshop's options bar: they apply to the selected shape layer
 * and are remembered for the next shape.
 */

import type { FillParameters, Layer, LayerShape, RGB, VectorPath, VectorStyle } from '../../core/model';
import type { Point, Rect } from '../../core/geometry';
import type { EditorSession } from '../../core/session';
import type { VectorBooleanOperation } from '../../core/vector';

export type ShapeKind = LayerShape['kind'];
export const SHAPE_KINDS: readonly ShapeKind[] = ['Rectangle', 'Ellipse', 'Polygon', 'Star', 'Line'];
export type PathOperation = 'new' | VectorBooleanOperation;
export const PATH_OPERATIONS: readonly PathOperation[] = ['new', 'unite', 'subtract', 'intersect', 'exclude'];
export type Marker = NonNullable<NonNullable<VectorStyle['stroke']>['startMarker']>;
export const MARKERS: readonly Marker[] = ['none', 'arrow', 'openArrow', 'circle', 'square'];

/** Every stroke option except its paint; kept while the stroke is off so turning it on again restores them. */
export interface StrokeOptions {
  readonly width: number;
  readonly alignment: 'inside' | 'center' | 'outside';
  readonly cap: 'butt' | 'round' | 'square';
  readonly join: 'miter' | 'round' | 'bevel';
  readonly miterLimit: number;
  readonly dash: readonly number[];
  readonly dashOffset: number;
  readonly startMarker: Marker;
  readonly endMarker: Marker;
  /** Marker size as a multiple of the stroke width. */
  readonly markerSize: number;
}

export interface PenPoint { anchor: Point; in: Point; out: Point; kind: 'corner' | 'smooth' }

export interface VectorToolState {
  kind: ShapeKind;
  radii: [number, number, number, number];
  radiiLinked: boolean;
  sides: number;
  polygonRadius: number;
  points: number;
  innerRatio: number;
  starRadius: number;
  fill: FillParameters | null;
  strokePaint: FillParameters | null;
  stroke: StrokeOptions;
  operation: PathOperation;
  /** Direct Selection (A) or Path Selection (Shift-A). */
  selectMode: 'direct' | 'path';
  /** Layer whose vector mask is the path target (its thumbnail was clicked). */
  maskTarget: string | null;
  /** The last vector layer worked with: the "current path" for masks, selections and Fill/Stroke Path. */
  pathLayerId: string | null;
  /** Shape being dragged, in document pixels. */
  shapeDraft: { kind: ShapeKind; rect: Rect; from: Point; to: Point } | null;
  /** Pen path in progress, in document pixels. */
  pen: { points: PenPoint[]; closed: boolean } | null;
  /** Selected anchors of the path target, as `path:point`. */
  selected: Set<string>;
  selectedFor: string | null;
  marquee: Rect | null;
  /** Active layer id the bar last synchronised the shape kind to. */
  syncedLayerId: string | null;
}

export const DEFAULT_STROKE: StrokeOptions = {
  width: 3, alignment: 'inside', cap: 'butt', join: 'miter', miterLimit: 4, dash: [], dashOffset: 0,
  startMarker: 'none', endMarker: 'none', markerSize: 3,
};

const states = new WeakMap<EditorSession, VectorToolState>();

export function solid(color: RGB): FillParameters { return { kind: 'solid', schemaVersion: 1, color: { ...color } }; }

export function vectorState(session: EditorSession): VectorToolState {
  let state = states.get(session);
  if (!state) {
    const fg = session.foregroundColor;
    state = {
      kind: 'Rectangle', radii: [0, 0, 0, 0], radiiLinked: true, sides: 6, polygonRadius: 0, points: 5, innerRatio: 0.5,
      starRadius: 0, fill: solid(fg), strokePaint: null, stroke: DEFAULT_STROKE, operation: 'new', selectMode: 'direct',
      maskTarget: null, pathLayerId: null, shapeDraft: null, pen: null, selected: new Set(), selectedFor: null, marquee: null,
      syncedLayerId: null,
    };
    states.set(session, state);
  }
  return state;
}

/** The colour a paint shows as a single colour (the first stop of a gradient). */
export function paintColor(paint: FillParameters | null | undefined, fallback: RGB = { red: 0, green: 0, blue: 0 }): RGB {
  if (!paint) return fallback;
  if (paint.kind === 'solid') return paint.color;
  if (paint.kind === 'gradient') return [...paint.stops].sort((a, b) => a.offset - b.offset)[0]?.color ?? fallback;
  return fallback;
}

export function strokeOf(paint: FillParameters | null, options: StrokeOptions): VectorStyle['stroke'] {
  if (!paint) return null;
  return {
    paint, color: paintColor(paint), width: options.width, alignment: options.alignment, cap: options.cap, join: options.join,
    miterLimit: options.miterLimit, dash: options.dash.length ? [...options.dash] : undefined, dashOffset: options.dashOffset || undefined,
    startMarker: options.startMarker, endMarker: options.endMarker, markerSize: options.markerSize,
  };
}

export function strokeOptionsOf(stroke: VectorStyle['stroke'], fallback: StrokeOptions = DEFAULT_STROKE): StrokeOptions {
  if (!stroke) return fallback;
  return {
    width: stroke.width, alignment: stroke.alignment, cap: stroke.cap ?? 'butt', join: stroke.join ?? 'miter',
    miterLimit: stroke.miterLimit ?? 4, dash: stroke.dash ?? [], dashOffset: stroke.dashOffset ?? 0,
    startMarker: stroke.startMarker ?? 'none', endMarker: stroke.endMarker ?? 'none', markerSize: stroke.markerSize ?? 3,
  };
}

export function strokePaintOf(stroke: VectorStyle['stroke']): FillParameters | null {
  if (!stroke) return null;
  return stroke.paint ?? solid(stroke.color);
}

/**
 * The tool's style for a new shape; a line always strokes (its weight is the stroke width). Arrowheads belong to open
 * paths only: closed shapes get none.
 */
export function toolStyle(state: VectorToolState, kind: ShapeKind | 'Path', foreground: RGB, open = kind === 'Line'): VectorStyle {
  if (kind === 'Line') {
    const paint = state.strokePaint ?? state.fill ?? solid(foreground);
    return { schemaVersion: 1, fill: null, stroke: strokeOf(paint, { ...state.stroke, alignment: 'center' }) };
  }
  const options = open ? state.stroke : { ...state.stroke, startMarker: 'none' as const, endMarker: 'none' as const };
  return { schemaVersion: 1, fill: state.fill, stroke: strokeOf(state.strokePaint, options) };
}

/** The primitive's parameters in the model's `LayerShape` form. */
export function shapeRecord(state: VectorToolState, kind: ShapeKind, color: RGB): LayerShape {
  const base = { schemaVersion: 1 as const, kind, red: color.red, green: color.green, blue: color.blue };
  switch (kind) {
    case 'Rectangle': return { ...base, cornerRadius: state.radii[0], cornerRadii: [...state.radii] };
    case 'Ellipse': return { ...base, cornerRadius: 0 };
    case 'Polygon': return { ...base, cornerRadius: state.polygonRadius, sides: state.sides };
    case 'Star': return { ...base, cornerRadius: state.starRadius, sides: state.points, innerRatio: state.innerRatio };
    case 'Line': return { ...base, cornerRadius: 0, lineWidth: state.stroke.width };
  }
}

/** Where the path tools draw and edit: the targeted vector mask, else the active shape layer's paths. */
export interface PathTarget { readonly layer: Layer; readonly mask: boolean }

export function pathTarget(session: EditorSession): PathTarget | null {
  const layer = session.activeLayer;
  if (!layer || session.selectedLayerIds.size > 1) return null;
  const state = vectorState(session);
  if (layer.vectorMask && (state.maskTarget === layer.id || layer.kind !== 'vector')) return { layer, mask: true };
  if (layer.kind === 'vector') return { layer, mask: false };
  return null;
}

export function targetKey(target: PathTarget | null): string | null {
  return target ? `${target.layer.id}:${target.mask ? 'mask' : 'paths'}` : null;
}

export function targetPaths(target: PathTarget): readonly VectorPath[] {
  if (target.mask) return target.layer.vectorMask?.paths ?? [];
  return target.layer.kind === 'vector' ? target.layer.paths : [];
}

/** Selected anchors, cleared when the target changes. */
export function selectedAnchors(session: EditorSession): Set<string> {
  const state = vectorState(session), key = targetKey(pathTarget(session));
  if (state.selectedFor !== key) { state.selected = new Set(); state.selectedFor = key; }
  return state.selected;
}
