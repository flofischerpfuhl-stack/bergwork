import type { Layer, VectorPath } from '../model';
import { apply, concat, invert, transformsEqual, unitToDocument, type LayerTransform, type Point } from '../geometry';
import { primitivePaths } from './primitives';

function scaledPaths(paths: readonly VectorPath[], scaleX: number, scaleY: number): readonly VectorPath[] {
  return paths.map((path) => ({ ...path, points: path.points.map((point) => ({ ...point,
    anchor: { x: point.anchor.x * scaleX, y: point.anchor.y * scaleY },
    in: { x: point.in.x * scaleX, y: point.in.y * scaleY },
    out: { x: point.out.x * scaleX, y: point.out.y * scaleY },
  })) }));
}

/** Keeps editable layer-local geometry in step with the session's transform resize. */
export function vectorLayerWithTransform(layer: Layer, transform: LayerTransform): Layer {
  const old = layer.transform.size, next = transform.size;
  let moved: Layer = { ...layer, transform };
  if (layer.warp && !transformsEqual(layer.transform, transform)) {
    const carry = concat(invert(unitToDocument(layer.transform)), unitToDocument(transform));
    const corners = layer.warp.corners.map((point) => apply(carry, point)) as [Point, Point, Point, Point];
    moved = { ...moved, warp: { ...layer.warp, corners } };
  }
  if (old.width === next.width && old.height === next.height) return moved;
  const scaleX = next.width / old.width, scaleY = next.height / old.height;
  const vectorMask = layer.vectorMask ? { ...layer.vectorMask, paths: scaledPaths(layer.vectorMask.paths, scaleX, scaleY) } : null;
  if (layer.kind !== 'vector') return { ...moved, vectorMask };
  const paths = layer.sourceShape ? primitivePaths(layer.sourceShape, next.width, next.height)
    : scaledPaths(layer.paths, scaleX, scaleY);
  return { ...layer, transform, warp: moved.warp, paths, vectorMask };
}
