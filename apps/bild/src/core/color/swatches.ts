/**
 * Swatch groups (PRODUCT-PLAN 6.1): the document's own groups (saved in `.fwimg` v2 and in history snapshots) and the
 * app-wide library share one shape and these pure operations. Document edits go through the session as undo steps;
 * the library is app state and is persisted by the UI.
 */

import type { RGB, Swatch, SwatchGroup } from '../model/types';
import type { EditorSession } from '../session';
import { uuid } from '../ids';

export type { Swatch, SwatchGroup };

export const MAX_SWATCH_GROUPS = 1_000;
export const MAX_SWATCHES = 20_000;
export const MAX_SWATCH_NAME = 256;

const channel = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const name = (value: unknown) => typeof value === 'string' && value.length <= MAX_SWATCH_NAME;
const id = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 128;

export function validSwatchColor(value: unknown): value is RGB {
  const color = value as RGB | null;
  return !!color && typeof color === 'object' && channel(color.red) && channel(color.green) && channel(color.blue);
}

/** Validates untrusted groups (files, local storage): structure, limits, unique ids. */
export function validSwatchGroups(value: unknown): value is SwatchGroup[] {
  if (!Array.isArray(value) || value.length > MAX_SWATCH_GROUPS) return false;
  const ids = new Set<string>();
  let total = 0;
  for (const group of value as SwatchGroup[]) {
    if (!group || typeof group !== 'object' || !id(group.id) || !name(group.name) || !Array.isArray(group.swatches) || ids.has(group.id)) return false;
    ids.add(group.id);
    total += group.swatches.length;
    if (total > MAX_SWATCHES) return false;
    for (const swatch of group.swatches) {
      if (!swatch || typeof swatch !== 'object' || !id(swatch.id) || !name(swatch.name) || !validSwatchColor(swatch.color) || ids.has(swatch.id)) return false;
      ids.add(swatch.id);
    }
  }
  return true;
}

/** Plain copies with only the known fields (drops extra keys from files). */
export function normalizeSwatchGroups(groups: readonly SwatchGroup[]): SwatchGroup[] {
  return groups.map((group) => ({ id: group.id, name: group.name, swatches: group.swatches.map((swatch) => ({
    id: swatch.id, name: swatch.name, color: { red: swatch.color.red, green: swatch.color.green, blue: swatch.color.blue } })) }));
}

export function swatchesEqual(a: readonly SwatchGroup[] | undefined, b: readonly SwatchGroup[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

// MARK: Pure edits (return a new array; the input is never changed)

export function newSwatch(color: RGB, swatchName: string): Swatch {
  return { id: uuid(), name: swatchName.slice(0, MAX_SWATCH_NAME), color: { red: color.red, green: color.green, blue: color.blue } };
}

export function addGroup(groups: readonly SwatchGroup[], groupName: string, swatches: readonly Swatch[] = []): { groups: SwatchGroup[]; id: string } {
  const group: SwatchGroup = { id: uuid(), name: groupName.slice(0, MAX_SWATCH_NAME), swatches };
  return { groups: [...groups, group], id: group.id };
}

/** Adds a swatch to a group (or to a new group named `fallbackGroupName` when there is none). */
export function addSwatch(groups: readonly SwatchGroup[], groupId: string | null, swatch: Swatch, fallbackGroupName: string): { groups: SwatchGroup[]; groupId: string } {
  const target = groups.find((group) => group.id === groupId) ?? groups[0];
  if (!target) {
    const created = addGroup(groups, fallbackGroupName, [swatch]);
    return { groups: created.groups, groupId: created.id };
  }
  return { groups: groups.map((group) => (group === target ? { ...group, swatches: [...group.swatches, swatch] } : group)), groupId: target.id };
}

export function renameSwatch(groups: readonly SwatchGroup[], swatchId: string, swatchName: string): SwatchGroup[] {
  return groups.map((group) => group.swatches.some((s) => s.id === swatchId)
    ? { ...group, swatches: group.swatches.map((s) => (s.id === swatchId ? { ...s, name: swatchName.slice(0, MAX_SWATCH_NAME) } : s)) } : group);
}

export function deleteSwatch(groups: readonly SwatchGroup[], swatchId: string): SwatchGroup[] {
  return groups.map((group) => group.swatches.some((s) => s.id === swatchId) ? { ...group, swatches: group.swatches.filter((s) => s.id !== swatchId) } : group);
}

export function renameGroup(groups: readonly SwatchGroup[], groupId: string, groupName: string): SwatchGroup[] {
  return groups.map((group) => (group.id === groupId ? { ...group, name: groupName.slice(0, MAX_SWATCH_NAME) } : group));
}

export function deleteGroup(groups: readonly SwatchGroup[], groupId: string): SwatchGroup[] {
  return groups.filter((group) => group.id !== groupId);
}

/** Appends imported groups with fresh ids (a file imported twice gives two groups, never an id clash). */
export function appendGroups(groups: readonly SwatchGroup[], imported: readonly { name: string; swatches: readonly { name: string; color: RGB }[] }[]): SwatchGroup[] {
  const room = Math.max(0, MAX_SWATCHES - groups.reduce((sum, group) => sum + group.swatches.length, 0));
  let left = room;
  const added: SwatchGroup[] = [];
  for (const group of imported) {
    if (left <= 0 || groups.length + added.length >= MAX_SWATCH_GROUPS) break;
    const swatches = group.swatches.slice(0, left).map((swatch) => newSwatch(swatch.color, swatch.name));
    left -= swatches.length;
    added.push({ id: uuid(), name: group.name.slice(0, MAX_SWATCH_NAME), swatches });
  }
  return [...groups, ...added];
}

// MARK: Document swatches (undo steps)

export function documentSwatches(session: EditorSession): readonly SwatchGroup[] {
  return session.document?.swatches ?? [];
}

export function canEditDocumentSwatches(session: EditorSession): boolean {
  return !!session.document && session.canUseHistory && !session.isProjectBusy;
}

/**
 * Replaces the document's swatch groups as one undo step named `name`. Swatches are document state: they are saved
 * with the project and restored by undo, unlike the foreground/background colours (app state, no undo step).
 */
export function editDocumentSwatches(session: EditorSession, stepName: string, update: (groups: readonly SwatchGroup[]) => readonly SwatchGroup[]): boolean {
  const document = session.document;
  if (!document || !canEditDocumentSwatches(session)) return false;
  const next = update(document.swatches ?? []);
  if (swatchesEqual(next, document.swatches)) return false;
  session.edit(stepName, () => {
    const { swatches: _previous, ...rest } = session.document!;
    session.replaceDocument(next.length ? { ...rest, swatches: next } : rest);
  });
  return true;
}
