import type { Layer, VectorPath } from '../model';
import type { LayerTransform } from '../geometry';
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
  if (old.width === next.width && old.height === next.height) return { ...layer, transform };
  const scaleX = next.width / old.width, scaleY = next.height / old.height;
  const vectorMask = layer.vectorMask ? { ...layer.vectorMask, paths: scaledPaths(layer.vectorMask.paths, scaleX, scaleY) } : null;
  if (layer.kind !== 'vector') return { ...layer, transform, vectorMask };
  const paths = layer.sourceShape ? primitivePaths(layer.sourceShape, next.width, next.height)
    : scaledPaths(layer.paths, scaleX, scaleY);
  return { ...layer, transform, paths, vectorMask };
}
