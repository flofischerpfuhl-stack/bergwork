import { uuid } from '../ids';
import type { CanvasDocument } from '../document';
import type { EditorSession } from '../session';
import { parseCubeLut, type CubeLut } from './cube';

export interface InstalledCube { readonly document: CanvasDocument; readonly resourceId: string; readonly lut: CubeLut }

/** Validates and stores the original `.cube` bytes; parsed float tables are only a runtime cache. */
export function installCubeLut(document: CanvasDocument, source: string | Uint8Array, resourceId = uuid()): InstalledCube {
  if (document.resources?.some((resource) => resource.id === resourceId)) throw new RangeError(`Duplicate resource id ${resourceId}`);
  const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : source.slice(), lut = parseCubeLut(bytes);
  return { document: { ...document, resources: [...document.resources ?? [], {
    id: resourceId, role: 'lut', mime: 'application/x-cube', bytes,
  }] }, resourceId, lut };
}

/** Installs a LUT and its adjustment layer as one nested session transaction. */
export function addColourLookupAdjustment(session: EditorSession, source: string | Uint8Array,
  interpolation: 'trilinear' | 'tetrahedral' = 'tetrahedral'): string | null {
  const document = session.document; if (!document || !session.canEditLayers) return null;
  const installed = installCubeLut(document, source);
  session.beginEdit('New Colour Lookup Adjustment');
  try {
    session.replaceDocument(installed.document);
    session.addAdjustment('Colour Lookup');
    const id = session.activeLayerId, layer = id ? session.layer(id) : null;
    if (!id || layer?.adjustment?.kind !== 'Colour Lookup') return null;
    session.updateAdjustment(id, { kind: 'Colour Lookup', schemaVersion: 1,
      parameters: { resourceId: installed.resourceId, interpolation } });
    return id;
  } finally { session.endEdit(); }
}
