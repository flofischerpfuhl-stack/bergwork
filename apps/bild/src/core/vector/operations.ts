import type { TextEngine } from '../../text';
import type { VectorPath } from '../model';
import { pathsToSvg, svgToPaths } from './path';

export type VectorBooleanOperation = 'unite' | 'subtract' | 'intersect' | 'exclude';

/** PRODUCT-PLAN A5: CanvasKit/Skia PathOps remains the single boolean geometry implementation. */
export function booleanPaths(engine: TextEngine, first: readonly VectorPath[], second: readonly VectorPath[],
  operation: VectorBooleanOperation): readonly VectorPath[] {
  if (!first.length || !second.length) {
    if (operation === 'unite' || operation === 'exclude') return [...first, ...second];
    if (operation === 'subtract') return first;
    return [];
  }
  const mapped = operation === 'unite' ? 'union' : operation === 'subtract' ? 'difference'
    : operation === 'intersect' ? 'intersect' : 'xor';
  return svgToPaths(engine.combinePaths(pathsToSvg(first), pathsToSvg(second), mapped));
}

export function combinePathSets(engine: TextEngine, sets: readonly (readonly VectorPath[])[],
  operation: VectorBooleanOperation): readonly VectorPath[] {
  if (!sets.length) return [];
  let result = sets[0]!;
  for (let i = 1; i < sets.length; i++) result = booleanPaths(engine, result, sets[i]!, operation);
  return result;
}
