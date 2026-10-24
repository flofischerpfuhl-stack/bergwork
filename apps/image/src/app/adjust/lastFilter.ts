/**
 * Filter › Last Filter (Compositor 1.5, Photoshop ⌃⌘F / Ctrl+Alt+F): the last Filter-menu filter applied in this editor,
 * run again on the active layer with the same settings and no panel, as one undo step. It takes the route its menu
 * command would: with a selection (or Vignette on an empty layer) it changes the pixels, otherwise it adds the same
 * smart filter. Nothing is remembered until a filter was applied, so the command starts disabled.
 */

import type { EditorSession } from '../../core/session';
import { adjustmentCommands, type AdjustmentCommandName } from '../../core/adjust';
import { applyFilterEdit, beginFilterEdit, cancelFilterEdit, filterEditState, startsOnEmptyLayer } from '../../core/filters/editing';
import { normalizeFilterSettings, repeatsAsLastFilter, type FilterKind, type FilterSettings } from '../../core/filters/settings';
import { canAddLiveFilter, LIVE_FILTER_COMMANDS, LIVE_FILTER_NAMES, liveFilterEditState, liveFilterFrom, liveFilterKindOf } from './liveFilters';

export interface LastFilter { readonly kind: FilterKind; readonly settings: FilterSettings }

const remembered = new WeakMap<object, LastFilter>();

/** `scope` is the editor (controller), so the last filter carries across its document tabs as Photoshop's does. */
export function lastFilter(scope: object): LastFilter | null { return remembered.get(scope) ?? null; }
export function recordLastFilter(scope: object, kind: FilterKind, settings: FilterSettings): void {
  if (repeatsAsLastFilter(kind) && liveFilterKindOf(kind)) remembered.set(scope, { kind, settings: normalizeFilterSettings(settings) });
}

/** Whether a Filter-menu filter goes straight into the pixels rather than onto the layer's smart filter stack. */
export function filterChangesPixels(session: EditorSession, kind: FilterKind): boolean {
  return !!session.selection || startsOnEmptyLayer(kind, session.activeLayer);
}

function pixelCommandEnabled(session: EditorSession, kind: FilterKind): boolean {
  const live = liveFilterKindOf(kind);
  return !!live && adjustmentCommands(session)[LIVE_FILTER_COMMANDS[live] as AdjustmentCommandName].enabled();
}

export function canRepeatLastFilter(scope: object, session: EditorSession): boolean {
  const last = lastFilter(scope);
  if (!last || filterEditState(session) || liveFilterEditState(session)) return false;
  return filterChangesPixels(session, last.kind) ? pixelCommandEnabled(session, last.kind) : canAddLiveFilter(session);
}

export async function repeatLastFilter(scope: object, session: EditorSession): Promise<boolean> {
  const last = lastFilter(scope), layer = session.activeLayer, live = last && liveFilterKindOf(last.kind);
  if (!last || !layer || !live || !canRepeatLastFilter(scope, session)) return false;
  if (filterChangesPixels(session, last.kind)) {
    if (session.refuseLayerEdit(layer.id, 'pixels') || !beginFilterEdit(session, last.kind, last.settings, { repeating: true })) return false;
    const applied = await applyFilterEdit(session);
    // There is no panel to show a failure in, so a failed repeat must not stay open and keep the document locked.
    if (!applied && filterEditState(session)) cancelFilterEdit(session);
    return applied;
  }
  if (session.refuseLayerEdit(layer.id, 'appearance')) return false;
  session.beginEdit(LIVE_FILTER_NAMES[live]);
  try { return session.addLayerLiveFilter(liveFilterFrom(live, last.settings, true), layer.id); } finally { session.endEdit(); }
}
