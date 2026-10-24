/**
 * View state of artboards shared by the artboard tool, the canvas overlay and the Layers panel: which artboard is
 * selected and which are collapsed in the panel. Per session (document tab), never saved, never undoable.
 * The artboards themselves are document data (`core/artboards`, `core/artboardCommands`).
 */

import { artboardMembership, findArtboard } from '../core/artboards';
import { deleteArtboard } from '../core/artboardCommands';
import type { Artboard, HierarchyEntry } from '../core/document';
import type { Rect } from '../core/geometry';
import type { EditorSession } from '../core/session';
import type { EditorController } from './controller';

const selected = new WeakMap<EditorSession, string>();
const collapsed = new WeakMap<EditorSession, Set<string>>();

/** The selected artboard, or null (also when it was deleted or undone away). */
export function selectedArtboard(session: EditorSession): Artboard | null {
  const id = selected.get(session);
  return id ? findArtboard(session.document, id) ?? null : null;
}

export function selectArtboard(session: EditorSession, id: string | null): void {
  if ((selected.get(session) ?? null) === id) return;
  if (id) selected.set(session, id); else selected.delete(session);
  session.notify('ui');
}

const renameRequests = new WeakMap<EditorSession, string>();

/** Asks the artboard's Layers panel row to start renaming (menu command). */
export function requestArtboardRename(session: EditorSession, id: string): void {
  renameRequests.set(session, id);
  session.notify('ui');
}

/** True once for the row a rename was requested for. */
export function takeArtboardRename(session: EditorSession, id: string): boolean {
  if (renameRequests.get(session) !== id) return false;
  renameRequests.delete(session);
  return true;
}

export function isArtboardCollapsed(session: EditorSession, id: string): boolean { return collapsed.get(session)?.has(id) ?? false; }

export function toggleArtboardCollapsed(session: EditorSession, id: string): void {
  let set = collapsed.get(session);
  if (!set) { set = new Set(); collapsed.set(session, set); }
  if (set.has(id)) set.delete(id); else set.add(id);
  session.notify('ui');
}

/** Asks whether the artboard's layers go too (Photoshop: delete removes the content), then deletes as one undo step. */
export async function confirmDeleteArtboard(controller: EditorController, id: string): Promise<void> {
  const t = controller.t, session = controller.session;
  const artboard = findArtboard(session.document, id);
  if (!artboard) return;
  const answer = await controller.confirm(t('Delete artboard?'),
    t('Delete the layers on “{name}” too, or keep them as layers outside any artboard?').replace('{name}', artboard.name),
    [{ label: t('Artboard Only'), value: 'keep', role: 'default' }, { label: t('Cancel'), value: 'cancel', role: 'cancel' },
      { label: t('Artboard and Contents'), value: 'delete', role: 'destructive' }]);
  if (answer === 'cancel') return;
  if (deleteArtboard(session, id, { contents: answer === 'delete' ? 'delete' : 'keep' })) selectArtboard(session, null);
}

/** One row of the grouped Layers panel: an artboard header or a layer row (members indented one level). */
export type PanelRow =
  | { readonly kind: 'artboard'; readonly artboard: Artboard; readonly count: number }
  | { readonly kind: 'layer'; readonly entry: HierarchyEntry };

/**
 * Groups the top-first layer rows under their artboards (membership is geometric: `artboardMembership`).
 * Each artboard appears where its topmost member is in the stack, followed by all its members in stack order;
 * loose layers stay where they are. The stack order itself is unchanged. Artboards without members come first.
 */
export function groupRowsByArtboard(session: EditorSession, rows: readonly HierarchyEntry[]): PanelRow[] {
  const document = session.document;
  const artboards = document?.artboards ?? [];
  if (!document || !artboards.length) return rows.map((entry) => ({ kind: 'layer', entry }));
  const membership = artboardMembership(document);
  // Top-level chunks: a root row and the rows below it that are deeper.
  const chunks: { artboardId: string | null; rows: HierarchyEntry[] }[] = [];
  for (const entry of rows) {
    if (entry.depth === 0 || !chunks.length) chunks.push({ artboardId: membership.get(entry.layer.id) ?? null, rows: [entry] });
    else chunks[chunks.length - 1]!.rows.push(entry);
  }
  const byArtboard = new Map<string, HierarchyEntry[]>();
  for (const chunk of chunks) if (chunk.artboardId) byArtboard.set(chunk.artboardId, [...(byArtboard.get(chunk.artboardId) ?? []), ...chunk.rows]);
  const counts = new Map<string, number>();
  for (const artboardId of membership.values()) if (artboardId) counts.set(artboardId, (counts.get(artboardId) ?? 0) + 1);
  const result: PanelRow[] = [];
  const header = (artboard: Artboard) => {
    result.push({ kind: 'artboard', artboard, count: counts.get(artboard.id) ?? 0 });
    if (isArtboardCollapsed(session, artboard.id)) return;
    for (const entry of byArtboard.get(artboard.id) ?? []) result.push({ kind: 'layer', entry: { ...entry, depth: entry.depth + 1 } });
  };
  // Topmost artboard first, like the layer stack.
  for (const artboard of [...artboards].reverse()) if (!byArtboard.has(artboard.id)) header(artboard);
  const shown = new Set<string>();
  for (const chunk of chunks) {
    if (!chunk.artboardId) { for (const entry of chunk.rows) result.push({ kind: 'layer', entry }); continue; }
    if (shown.has(chunk.artboardId)) continue;
    shown.add(chunk.artboardId);
    const artboard = artboards.find((a) => a.id === chunk.artboardId);
    if (artboard) header(artboard);
  }
  return result;
}

/** The origin rect with one handle dragged by (dx, dy); Shift keeps the aspect ratio on corners. Never flips, never leaves x/y ≥ 0. */
export function resizedRect(origin: Rect, handle: number, dx: number, dy: number, keepRatio: boolean): Rect {
  let left = origin.x, top = origin.y, right = origin.x + origin.width, bottom = origin.y + origin.height;
  const moves = { left: [0, 6, 7].includes(handle), right: [2, 3, 4].includes(handle), top: [0, 1, 2].includes(handle), bottom: [4, 5, 6].includes(handle) };
  if (moves.left) left = Math.min(right - 1, Math.max(0, left + dx));
  if (moves.right) right = Math.max(left + 1, right + dx);
  if (moves.top) top = Math.min(bottom - 1, Math.max(0, top + dy));
  if (moves.bottom) bottom = Math.max(top + 1, bottom + dy);
  if (keepRatio && handle % 2 === 0) {
    const ratio = origin.width / origin.height;
    let width = right - left, height = bottom - top;
    if (width / height > ratio) height = Math.max(1, Math.round(width / ratio)); else width = Math.max(1, Math.round(height * ratio));
    if (moves.left) left = Math.max(0, right - width); else right = left + width;
    if (moves.top) top = Math.max(0, bottom - height); else bottom = top + height;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}
