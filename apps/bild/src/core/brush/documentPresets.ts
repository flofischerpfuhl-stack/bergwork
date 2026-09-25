/**
 * Brush presets kept in a document (PRODUCT-PLAN 6.3): one `brushes` resource holding the portable preset JSON
 * (presets.ts), saved in `.fwimg` and in history snapshots like any document resource. Edits are undo steps.
 */

import type { CanvasDocument } from '../document';
import type { EditorSession } from '../session';
import { uuid } from '../ids';
import { parseBrushPresets, serializeBrushPresets, type BrushPreset } from './presets';

export const BRUSH_PRESETS_MIME = 'application/vnd.fernwork.brush-presets+json';

/** Parsed presets per resource bytes, so tips keep their identity (GPU tip atlases, worker tip caches). */
const parsed = new WeakMap<Uint8Array, readonly BrushPreset[]>();

export function documentBrushPresets(document: CanvasDocument | null): readonly BrushPreset[] {
  const resource = document?.resources?.find((value) => value.role === 'brushes');
  if (!resource) return [];
  let presets = parsed.get(resource.bytes);
  if (!presets) {
    try { presets = parseBrushPresets(JSON.parse(new TextDecoder().decode(resource.bytes))); } catch { presets = []; }
    parsed.set(resource.bytes, presets);
  }
  return presets;
}

export function canEditDocumentBrushPresets(session: EditorSession): boolean {
  return !!session.document && session.canUseHistory && !session.isProjectBusy;
}

/** Replaces the document's presets as one undo step; an empty list removes the resource. */
export function editDocumentBrushPresets(session: EditorSession, stepName: string,
  update: (presets: readonly BrushPreset[]) => readonly BrushPreset[]): boolean {
  const document = session.document;
  if (!document || !canEditDocumentBrushPresets(session)) return false;
  const current = documentBrushPresets(document);
  const next = update(current);
  if (next === current) return false;
  const existing = document.resources?.find((value) => value.role === 'brushes');
  const others = (document.resources ?? []).filter((value) => value !== existing);
  let resources = others;
  if (next.length) {
    const bytes = new TextEncoder().encode(JSON.stringify(serializeBrushPresets(next)));
    parsed.set(bytes, next);
    resources = [...others, { id: existing?.id ?? `brushes-${uuid()}`, role: 'brushes', mime: BRUSH_PRESETS_MIME, bytes }];
  }
  session.edit(stepName, () => { session.replaceDocument({ ...session.document!, resources }); });
  return true;
}
