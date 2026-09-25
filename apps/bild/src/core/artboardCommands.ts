/**
 * Undoable artboard commands (PRODUCT-PLAN 6.1). Each command is one history step through
 * `session.edit`; the membership rule is documented in `./artboards`.
 *
 * Photoshop semantics: moving an artboard moves its content; resizing does not move or scale content;
 * duplicating copies the artboard with its content next to the rightmost artboard; deleting removes
 * the content unless `contents: 'keep'` is asked for (the layers then become loose).
 */

import type { Artboard, CanvasDocument, Layer } from './document';
import type { ColorLabel } from './model';
import type { Rect } from './geometry';
import type { EditorSession } from './session';
import { uuid } from './ids';
import { clearLayerPixelsOutsideRect, translated } from './canvasOps';
import { artboardPreset } from './artboardPresets';
import {
  ARTBOARD_GAP, ArtboardError, artboardUnits, DEFAULT_ARTBOARD_BACKGROUND, findArtboard, isValidArtboardRect,
  isValidBackground, nextArtboardOrigin, roundedRect, withCanvasFittingArtboards, type ArtboardBackground,
} from './artboards';

export interface CreateArtboardOptions {
  /** A preset id from `ARTBOARD_PRESETS`; its size is used when `rect` has no size. */
  readonly preset?: string;
  /** Document-space rect; the position defaults to the right of the rightmost artboard. */
  readonly rect?: Partial<Rect>;
  readonly name?: string;
  readonly background?: ArtboardBackground;
  readonly colorLabel?: ColorLabel;
}

/** Last refusal, for the UI to show (commands return false/null when they refuse). */
export let lastArtboardError: ArtboardError | null = null;

function refuse(error: ArtboardError): false { lastArtboardError = error; return false; }

function canEdit(session: EditorSession): boolean {
  if (!session.document) return refuse(new ArtboardError('no-document', 'There is no document.'));
  return session.canEditLayers;
}

/** Applies `change` as one undo step; the canvas grows to fit the artboards. */
function commit(session: EditorSession, name: string, change: (document: CanvasDocument) => CanvasDocument): boolean {
  let next: CanvasDocument;
  try { next = withCanvasFittingArtboards(change(session.document!)); } catch (error) {
    if (error instanceof ArtboardError) return refuse(error);
    throw error;
  }
  session.commitTransform();
  session.edit(name, () => session.replaceDocument(next));
  lastArtboardError = null;
  return true;
}

function replaceArtboard(document: CanvasDocument, id: string, update: (artboard: Artboard) => Artboard): CanvasDocument {
  return { ...document, artboards: (document.artboards ?? []).map((artboard) => (artboard.id === id ? update(artboard) : artboard)) };
}

function uniqueArtboardName(document: CanvasDocument, prefix: string): string {
  const names = new Set((document.artboards ?? []).map((artboard) => artboard.name));
  if (!names.has(prefix)) return prefix;
  for (let n = 2; ; n++) if (!names.has(`${prefix} ${n}`)) return `${prefix} ${n}`;
}

/** Creates an artboard from a preset or rect. Returns its id, or null when refused. */
export function createArtboard(session: EditorSession, options: CreateArtboardOptions = {}): string | null {
  if (!canEdit(session)) return null;
  const document = session.document!;
  const preset = options.preset ? artboardPreset(options.preset) : undefined;
  if (options.preset && !preset) { refuse(new ArtboardError('invalid-rect', `Unknown artboard preset “${options.preset}”.`)); return null; }
  const origin = options.rect?.x !== undefined && options.rect?.y !== undefined ? { x: options.rect.x, y: options.rect.y } : nextArtboardOrigin(document);
  const width = options.rect?.width ?? preset?.width ?? document.width;
  const height = options.rect?.height ?? preset?.height ?? document.height;
  const rect = roundedRect({ x: origin.x, y: origin.y, width, height });
  if (!isValidArtboardRect(rect)) { refuse(new ArtboardError('invalid-rect', 'Artboards need a positive size inside 30,000 pixels.')); return null; }
  if (options.background && !isValidBackground(options.background)) { refuse(new ArtboardError('invalid-rect', 'Invalid artboard background.')); return null; }
  const artboard: Artboard = {
    id: uuid(),
    name: options.name ?? uniqueArtboardName(document, preset ? session.label(preset.name) : session.label('Artboard')),
    rect, background: options.background ?? DEFAULT_ARTBOARD_BACKGROUND, colorLabel: options.colorLabel ?? 'none',
  };
  return commit(session, 'New Artboard', (d) => ({ ...d, artboards: [...(d.artboards ?? []), artboard] })) ? artboard.id : null;
}

export function renameArtboard(session: EditorSession, id: string, name: string): boolean {
  const artboard = findArtboard(session.document, id);
  if (!canEdit(session) || !artboard) return refuse(new ArtboardError('not-found', 'No such artboard.'));
  const trimmed = name.trim();
  if (!trimmed || trimmed === artboard.name) return false;
  return commit(session, 'Rename Artboard', (d) => replaceArtboard(d, id, (a) => ({ ...a, name: trimmed })));
}

export function setArtboardBackground(session: EditorSession, id: string, background: ArtboardBackground): boolean {
  if (!canEdit(session) || !findArtboard(session.document, id)) return refuse(new ArtboardError('not-found', 'No such artboard.'));
  if (!isValidBackground(background)) return refuse(new ArtboardError('invalid-rect', 'Invalid artboard background.'));
  return commit(session, 'Artboard Background', (d) => replaceArtboard(d, id, (a) => ({ ...a, background: { ...background } })));
}

export function setArtboardColorLabel(session: EditorSession, id: string, colorLabel: ColorLabel): boolean {
  if (!canEdit(session) || !findArtboard(session.document, id)) return refuse(new ArtboardError('not-found', 'No such artboard.'));
  return commit(session, 'Artboard Color', (d) => replaceArtboard(d, id, (a) => ({ ...a, colorLabel })));
}

/** Moves the artboard and its content by whole pixels. Artboards cannot leave the canvas origin. */
export function moveArtboard(session: EditorSession, id: string, dx: number, dy: number): boolean {
  const document = session.document, artboard = findArtboard(document, id);
  if (!canEdit(session) || !artboard) return refuse(new ArtboardError('not-found', 'No such artboard.'));
  const mx = Math.max(Math.round(dx), -artboard.rect.x), my = Math.max(Math.round(dy), -artboard.rect.y);
  if (!mx && !my) return false;
  const members = memberIds(document!, id);
  for (const layerId of members) {
    if (session.refuseLayerEdit(layerId, 'position')) return refuse(new ArtboardError('locked', 'A layer on this artboard is locked in position.'));
  }
  return commit(session, 'Move Artboard', (d) => ({
    ...replaceArtboard(d, id, (a) => ({ ...a, rect: { ...a.rect, x: a.rect.x + mx, y: a.rect.y + my } })),
    layers: d.layers.map((layer) => (members.has(layer.id) ? translated(layer, mx, my) : layer)),
  }));
}

/** Sets the artboard rect; content keeps its place (Photoshop's artboard resize). */
export function resizeArtboard(session: EditorSession, id: string, rect: Rect): boolean {
  if (!canEdit(session) || !findArtboard(session.document, id)) return refuse(new ArtboardError('not-found', 'No such artboard.'));
  const next = roundedRect(rect);
  if (!isValidArtboardRect(next)) return refuse(new ArtboardError('invalid-rect', 'Artboards need a positive size inside 30,000 pixels.'));
  return commit(session, 'Resize Artboard', (d) => replaceArtboard(d, id, (a) => ({ ...a, rect: next })));
}

/** Crops one artboard without moving its content; optional deletion clears only that artboard's member pixels. */
export function cropArtboard(session: EditorSession, id: string, rect: Rect, deletePixels = false): boolean {
  const document = session.document, artboard = findArtboard(document, id);
  if (!canEdit(session) || !artboard) return refuse(new ArtboardError('not-found', 'No such artboard.'));
  const next = roundedRect(rect);
  if (!isValidArtboardRect(next)) return refuse(new ArtboardError('invalid-rect', 'Artboards need a positive size inside 30,000 pixels.'));
  const members = memberIds(document!, id);
  if (deletePixels) {
    for (const layerId of members) {
      if (session.refuseLayerEdit(layerId, 'pixels')) return refuse(new ArtboardError('locked', 'A layer on this artboard has locked pixels.'));
    }
  }
  return commit(session, 'Crop Artboard', (value) => ({
    ...replaceArtboard(value, id, (candidate) => ({ ...candidate, rect: next })),
    layers: deletePixels ? value.layers.map((layer) => members.has(layer.id)
      ? clearLayerPixelsOutsideRect(layer, next) : layer) : value.layers,
  }));
}

/** Moves the artboard to `index` in the artboard order (panel and export order). */
export function reorderArtboard(session: EditorSession, id: string, index: number): boolean {
  const artboards = session.document?.artboards ?? [];
  const from = artboards.findIndex((artboard) => artboard.id === id);
  if (!canEdit(session) || from < 0) return refuse(new ArtboardError('not-found', 'No such artboard.'));
  const to = Math.max(0, Math.min(artboards.length - 1, Math.round(index)));
  if (to === from) return false;
  const next = artboards.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return commit(session, 'Reorder Artboards', (d) => ({ ...d, artboards: next }));
}

export interface DeleteArtboardOptions { readonly contents?: 'delete' | 'keep' }

/** Deletes the artboard; its layers go too unless `contents: 'keep'`. Live masks on deleted layers are unlinked. */
export function deleteArtboard(session: EditorSession, id: string, options: DeleteArtboardOptions = {}): boolean {
  const document = session.document;
  if (!canEdit(session) || !findArtboard(document, id)) return refuse(new ArtboardError('not-found', 'No such artboard.'));
  const removed = options.contents === 'keep' ? new Set<string>() : memberIds(document!, id);
  const ok = commit(session, 'Delete Artboard', (d) => ({
    ...d,
    artboards: (d.artboards ?? []).filter((artboard) => artboard.id !== id),
    layers: d.layers.filter((layer) => !removed.has(layer.id))
      .map((layer) => (layer.maskSourceId && removed.has(layer.maskSourceId) ? { ...layer, maskSourceId: null } : layer)),
  }));
  if (ok && session.activeLayerId && removed.has(session.activeLayerId)) session.setActiveLayer(null);
  return ok;
}

/** Copies the artboard and its content to the right of the rightmost artboard. Returns the new id. */
export function duplicateArtboard(session: EditorSession, id: string, name?: string): string | null {
  const document = session.document, source = findArtboard(document, id);
  if (!canEdit(session) || !source) { refuse(new ArtboardError('not-found', 'No such artboard.')); return null; }
  const right = Math.max(...(document!.artboards ?? []).map((a) => a.rect.x + a.rect.width));
  const dx = right + ARTBOARD_GAP - source.rect.x, dy = 0;
  const members = memberIds(document!, id);
  const ids = new Map<string, string>();
  for (const layerId of members) ids.set(layerId, uuid());
  const copies: Layer[] = [];
  for (const layer of document!.layers) {
    if (!members.has(layer.id)) continue;
    const moved = translated(layer, dx, dy);
    copies.push({
      ...moved, id: ids.get(layer.id)!,
      parentId: layer.parentId ? ids.get(layer.parentId) ?? layer.parentId : null,
      maskSourceId: layer.maskSourceId ? ids.get(layer.maskSourceId) ?? layer.maskSourceId : null,
    } as Layer);
  }
  const copy: Artboard = {
    ...source, id: uuid(), rect: { ...source.rect, x: source.rect.x + dx, y: source.rect.y + dy },
    name: name ?? uniqueArtboardName(document!, `${source.name} ${session.label('copy')}`),
  };
  // The copies go right above the source's topmost layer, so loose layers above keep applying to them.
  const insertAt = document!.layers.reduce((last, layer, index) => (members.has(layer.id) ? index + 1 : last), document!.layers.length);
  const ok = commit(session, 'Duplicate Artboard', (d) => ({
    ...d, layers: [...d.layers.slice(0, insertAt), ...copies, ...d.layers.slice(insertAt)], artboards: [...(d.artboards ?? []), copy],
  }));
  return ok ? copy.id : null;
}

function memberIds(document: CanvasDocument, artboardId: string): Set<string> {
  const result = new Set<string>();
  for (const unit of artboardUnits(document)) if (unit.artboardId === artboardId) for (const id of unit.ids) result.add(id);
  return result;
}
