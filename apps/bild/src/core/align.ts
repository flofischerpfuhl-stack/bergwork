/**
 * Align and distribute layers (PRODUCT-PLAN 6.1). Photoshop's rules: several selected layers align to the box around all
 * of them; a single layer aligns to the selection when there is one, otherwise to the canvas. Distributing needs three
 * or more layers and spaces either their centres or the gaps between them evenly.
 */

import { boundingBox, type Rect } from './geometry';
import { descendantIds, type CanvasDocument, type Layer } from './document';

export type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
export type DistributeMode = 'hcenters' | 'vcenters' | 'hspacing' | 'vspacing';

/** One unit that moves as a whole: a layer, or a folder with everything inside it. */
export interface AlignUnit { readonly ids: readonly string[]; readonly box: Rect }

export function unionRect(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null;
  const x0 = Math.min(...rects.map((r) => r.x)), y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width)), y1 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Units for the selected ids; folders stand for every displayed descendant. */
export function alignUnits(document: CanvasDocument, selected: readonly string[], box: (layer: Layer) => Rect = (l) => boundingBox(l.transform)): AlignUnit[] {
  const byId = new Map(document.layers.map((l) => [l.id, l]));
  const units: AlignUnit[] = [];
  const covered = new Set<string>();
  for (const id of selected) {
    const layer = byId.get(id);
    if (!layer || covered.has(id)) continue;
    const members = layer.kind === 'group' ? [...descendantIds(document.layers, id)].map((d) => byId.get(d)!).filter((l) => l && l.kind !== 'group') : [layer];
    const rect = unionRect(members.map(box));
    if (!rect) continue;
    for (const m of members) covered.add(m.id);
    units.push({ ids: members.map((m) => m.id), box: rect });
  }
  return units;
}

/** Offsets per unit for aligning to `target` (or to the units' own union when target is null). */
export function alignOffsets(units: readonly AlignUnit[], edge: AlignEdge, target: Rect | null): { dx: number; dy: number }[] {
  const reference = target ?? unionRect(units.map((u) => u.box));
  if (!reference) return units.map(() => ({ dx: 0, dy: 0 }));
  return units.map(({ box }) => {
    switch (edge) {
      case 'left': return { dx: reference.x - box.x, dy: 0 };
      case 'right': return { dx: reference.x + reference.width - (box.x + box.width), dy: 0 };
      case 'hcenter': return { dx: reference.x + reference.width / 2 - (box.x + box.width / 2), dy: 0 };
      case 'top': return { dx: 0, dy: reference.y - box.y };
      case 'bottom': return { dx: 0, dy: reference.y + reference.height - (box.y + box.height) };
      case 'vcenter': return { dx: 0, dy: reference.y + reference.height / 2 - (box.y + box.height / 2) };
    }
  });
}

/** Offsets for distributing ≥ 3 units; the outermost two stay where they are. */
export function distributeOffsets(units: readonly AlignUnit[], mode: DistributeMode): { dx: number; dy: number }[] {
  const zero = units.map(() => ({ dx: 0, dy: 0 }));
  if (units.length < 3) return zero;
  const horizontal = mode === 'hcenters' || mode === 'hspacing';
  const start = (r: Rect) => (horizontal ? r.x : r.y), size = (r: Rect) => (horizontal ? r.width : r.height);
  const order = units.map((u, i) => i).sort((a, b) => start(units[a]!.box) + size(units[a]!.box) / 2 - (start(units[b]!.box) + size(units[b]!.box) / 2));
  const first = units[order[0]!]!.box, last = units[order.at(-1)!]!.box;
  const result = zero.slice();
  if (mode === 'hcenters' || mode === 'vcenters') {
    const c0 = start(first) + size(first) / 2, c1 = start(last) + size(last) / 2;
    order.forEach((index, k) => {
      const box = units[index]!.box;
      const want = c0 + (c1 - c0) * k / (order.length - 1);
      const d = Math.round(want - (start(box) + size(box) / 2));
      result[index] = horizontal ? { dx: d, dy: 0 } : { dx: 0, dy: d };
    });
  } else {
    const span = start(last) + size(last) - start(first);
    const total = order.reduce((sum, i) => sum + size(units[i]!.box), 0);
    const gap = (span - total) / (order.length - 1);
    let cursor = start(first);
    order.forEach((index) => {
      const box = units[index]!.box;
      const d = Math.round(cursor - start(box));
      result[index] = horizontal ? { dx: d, dy: 0 } : { dx: 0, dy: d };
      cursor += size(box) + gap;
    });
  }
  return result;
}
