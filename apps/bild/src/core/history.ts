/**
 * Snapshot undo history, ported from DocumentHistory.swift. Snapshots share immutable rasters;
 * retained memory is the raster tiles only history keeps alive, capped at 256 MiB, and at most
 * 100 entries.
 */

import { documentsEqual, type CanvasDocument } from './document';
import type { PixelArray } from './pixel/format';

export interface HistorySnapshot {
  readonly document: CanvasDocument | null;
  readonly activeLayerId: string | null;
  readonly revision: number;
}

interface Entry { readonly name: string; readonly before: HistorySnapshot; readonly after: HistorySnapshot }

let revisionCounter = 1;

export class DocumentHistory {
  private past: Entry[] = [];
  private future: Entry[] = [];
  private revision = revisionCounter++;
  private savedRevision: number | null;
  private pending: HistorySnapshot | null = null;
  private pendingName = 'Edit';
  private depth = 0;
  readonly entryLimit: number;
  readonly retainedByteLimit: number;

  constructor(entryLimit = 100, retainedByteLimit = 256 * 1024 * 1024) {
    this.entryLimit = Math.max(0, entryLimit);
    this.retainedByteLimit = Math.max(0, retainedByteLimit);
    this.savedRevision = this.revision;
  }

  get canUndo(): boolean { return this.depth === 0 && this.past.length > 0; }
  get canRedo(): boolean { return this.depth === 0 && this.future.length > 0; }
  get undoName(): string { return this.past.at(-1)?.name ?? ''; }
  get redoName(): string { return this.future.at(-1)?.name ?? ''; }
  get isModified(): boolean { return this.revision !== this.savedRevision; }
  get undoCount(): number { return this.past.length; }
  get isInTransaction(): boolean { return this.depth > 0; }
  markSaved(): void { this.savedRevision = this.revision; }
  /** Marks the current state as not matching any saved file. */
  markUnsaved(): void { this.savedRevision = null; }

  reset(): void {
    this.past = [];
    this.future = [];
    this.pending = null;
    this.depth = 0;
    this.revision = revisionCounter++;
    this.savedRevision = this.revision;
  }

  begin(name: string, document: CanvasDocument | null, selection: string | null): void {
    if (this.depth === 0) {
      this.pending = { document, activeLayerId: selection, revision: this.revision };
      this.pendingName = name;
    }
    this.depth++;
  }

  end(document: CanvasDocument | null, selection: string | null): void {
    if (this.depth === 0) return;
    this.depth--;
    if (this.depth > 0 || !this.pending) return;
    const before = this.pending;
    this.pending = null;
    // Selecting, navigating and no-op edits preserve redo history.
    if (documentsEqual(before.document, document)) return;
    this.revision = revisionCounter++;
    this.past.push({ name: this.pendingName, before, after: { document, activeLayerId: selection, revision: this.revision } });
    this.future = [];
    this.trim(document);
  }

  /** Abandons an open transaction without recording it (the caller restores the document). */
  abandon(): HistorySnapshot | null {
    const pending = this.pending;
    this.pending = null;
    this.depth = 0;
    return pending;
  }

  undo(): HistorySnapshot | null {
    if (!this.canUndo) return null;
    const entry = this.past.pop()!;
    this.future.push(entry);
    this.revision = entry.before.revision;
    this.trim(entry.before.document);
    return entry.before;
  }

  redo(): HistorySnapshot | null {
    if (!this.canRedo) return null;
    const entry = this.future.pop()!;
    this.past.push(entry);
    this.revision = entry.after.revision;
    this.trim(entry.after.document);
    return entry.after;
  }

  /** Bytes of raster tiles retained only by history, excluding tiles in the live document. */
  retainedBytes(current: CanvasDocument | null): number {
    const seen = new Set<PixelArray>();
    const visit = (document: CanvasDocument | null, count: boolean): number => {
      let bytes = 0;
      if (!document) return 0;
      const rasters = [];
      for (const layer of document.layers) {
        if (layer.raster) rasters.push(layer.raster);
        if (layer.mask) rasters.push(layer.mask.raster);
      }
      if (document.selection) rasters.push(document.selection.mask);
      for (const raster of rasters) {
        for (const tile of raster.tiles) {
          if (tile && !seen.has(tile)) { seen.add(tile); if (count) bytes += tile.byteLength; }
        }
      }
      return bytes;
    };
    visit(current, false);
    let bytes = 0;
    for (const entry of [...this.past, ...this.future]) {
      bytes += visit(entry.before.document, true) + visit(entry.after.document, true);
    }
    return bytes;
  }

  private trim(current: CanvasDocument | null): void {
    while (this.past.length + this.future.length > this.entryLimit || this.retainedBytes(current) > this.retainedByteLimit) {
      if (this.past.length) this.past.shift();
      else if (this.future.length) this.future.shift();
      else break;
    }
  }
}
