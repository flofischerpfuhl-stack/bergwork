import { ancestorIds, type BlendMode, type CanvasDocument, type ColorLabel, type Layer } from './document';
import { effectiveLayerLocks } from './locks';

export interface LayerSearchQuery {
  readonly text?: string;
  readonly kinds?: ReadonlySet<Layer['kind']> | readonly Layer['kind'][];
  readonly labels?: ReadonlySet<ColorLabel> | readonly ColorLabel[];
  readonly visible?: boolean;
  readonly locked?: boolean;
  readonly blendModes?: ReadonlySet<BlendMode> | readonly BlendMode[];
}

export interface LayerSearchResult {
  readonly matchingIds: ReadonlySet<string>;
  readonly ancestorIds: ReadonlySet<string>;
}

const fold = (value: string): string => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase('de').replaceAll('ß', 'ss');
const includes = <T>(values: ReadonlySet<T> | readonly T[] | undefined, value: T): boolean =>
  values === undefined || (Array.isArray(values) ? values.includes(value) : (values as ReadonlySet<T>).has(value));

/** Pure layer-panel filtering; ancestors are returned separately so matching descendants remain reachable. */
export function filterLayers(document: CanvasDocument, query: LayerSearchQuery): LayerSearchResult {
  const needle = fold(query.text?.trim() ?? '');
  const matchingIds = new Set<string>();
  const neededAncestors = new Set<string>();
  for (const layer of document.layers) {
    if (needle && !fold(layer.name).includes(needle)) continue;
    if (!includes(query.kinds, layer.kind) || !includes(query.labels, layer.colorLabel)
      || !includes(query.blendModes, layer.blendMode)) continue;
    if (query.visible !== undefined && layer.visible !== query.visible) continue;
    const locks = effectiveLayerLocks(document, layer.id);
    const locked = locks.all || locks.pixels || locks.position || locks.transparency;
    if (query.locked !== undefined && locked !== query.locked) continue;
    matchingIds.add(layer.id);
    for (const ancestor of ancestorIds(document.layers, layer.id)) neededAncestors.add(ancestor);
  }
  return { matchingIds, ancestorIds: neededAncestors };
}
