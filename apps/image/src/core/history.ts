/**
 * Snapshot undo history, ported from DocumentHistory.swift. Snapshots share immutable rasters;
 * retained memory is the raster tiles only history keeps alive, capped at 256 MiB, and at most
 * 100 entries.
 */

import { documentsEqual, type CanvasDocument } from './document';
import type { PixelArray } from './pixel/format';
import type { Raster } from './raster';

export interface HistorySnapshot {
  readonly document: CanvasDocument | null;
  readonly activeLayerId: string | null;
  readonly revision: number;
}

export interface HistoryCommand { readonly name: string; readonly before: HistorySnapshot; readonly after: HistorySnapshot }
export interface PersistedHistoryState {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
  readonly retainedByteLimit: number;
  readonly past: readonly HistoryCommand[];
  readonly future: readonly HistoryCommand[];
}

export interface HistoryPerformanceCounters {
  readonly retainedScans: number;
  readonly scannedDocuments: number;
  readonly scannedRasters: number;
  readonly scannedTiles: number;
  readonly trimmedEntries: number;
  readonly retainedScanMs: number;
}

let revisionCounter = 1;

export class DocumentHistory {
  private past: HistoryCommand[] = [];
  private future: HistoryCommand[] = [];
  private revision = revisionCounter++;
  private savedRevision: number | null;
  private pending: HistorySnapshot | null = null;
  private pendingName = 'Edit';
  private depth = 0;
  readonly entryLimit: number;
  retainedByteLimit: number;
  private enabledValue: boolean;
  private performanceValue: HistoryPerformanceCounters = {
    retainedScans: 0, scannedDocuments: 0, scannedRasters: 0, scannedTiles: 0, trimmedEntries: 0, retainedScanMs: 0,
  };

  constructor(entryLimit = 100, retainedByteLimit = 256 * 1024 * 1024, enabled = true) {
    this.entryLimit = Math.max(0, entryLimit);
    this.retainedByteLimit = Math.max(0, retainedByteLimit);
    this.enabledValue = enabled;
    this.savedRevision = this.revision;
  }

  get enabled(): boolean { return this.enabledValue; }
  get canUndo(): boolean { return this.enabledValue && this.depth === 0 && this.past.length > 0; }
  get canRedo(): boolean { return this.enabledValue && this.depth === 0 && this.future.length > 0; }
  get undoName(): string { return this.past.at(-1)?.name ?? ''; }
  get redoName(): string { return this.future.at(-1)?.name ?? ''; }
  get isModified(): boolean { return this.revision !== this.savedRevision; }
  get undoCount(): number { return this.past.length; }
  /** Names of the steps that can be undone, oldest first (History panel). */
  get pastNames(): string[] { return this.past.map((c) => c.name); }
  /** Names of the steps that can be redone, next first. */
  get futureNames(): string[] { return this.future.map((c) => c.name).reverse(); }
  get isInTransaction(): boolean { return this.depth > 0; }
  /** Cumulative diagnostics used by the editing-tools performance audit and regression tests. */
  get performanceCounters(): HistoryPerformanceCounters { return { ...this.performanceValue }; }
  markSaved(): void { this.savedRevision = this.revision; }
  /** Marks the current state as not matching any saved file. */
  markUnsaved(): void { this.savedRevision = null; }

  /** Disabling history drops retained snapshots immediately; edits continue normally. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabledValue) return;
    this.enabledValue = enabled;
    this.past = [];
    this.future = [];
    this.pending = null;
    this.depth = 0;
  }

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
    if (!this.enabledValue) return;
    this.past.push({ name: this.pendingName, before, after: { document, activeLayerId: selection, revision: this.revision } });
    this.future = [];
    this.trim(document);
  }

  /** Serializable command log. Immutable document/raster references are intentionally shared. */
  exportState(): PersistedHistoryState {
    return { schemaVersion: 1, enabled: this.enabledValue, retainedByteLimit: this.retainedByteLimit,
      past: this.past.slice(), future: this.future.slice() };
  }

  /** Installs a validated project history and preserves the saved current revision. */
  importState(state: PersistedHistoryState, current: CanvasDocument | null): void {
    this.retainedByteLimit = Math.max(0, state.retainedByteLimit);
    this.past = state.enabled ? state.past.slice(0, this.entryLimit) : [];
    this.future = state.enabled ? state.future.slice(0, Math.max(0, this.entryLimit - this.past.length)) : [];
    this.enabledValue = state.enabled;
    this.pending = null;
    this.depth = 0;
    const currentSnapshot = this.past.at(-1)?.after ?? this.future.at(-1)?.before;
    this.revision = currentSnapshot?.revision ?? revisionCounter++;
    this.savedRevision = this.revision;
    this.trim(current);
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
    const started = performance.now();
    const currentRasters = new Set<Raster>(), historyRasters = new Set<Raster>(), documents = new Set<CanvasDocument>();
    const collect = (document: CanvasDocument | null, target: Set<Raster>): void => {
      if (!document) return;
      for (const layer of document.layers) {
        if (layer.raster) target.add(layer.raster);
        if (layer.mask) target.add(layer.mask.raster);
      }
      if (document.selection) target.add(document.selection.mask);
    };
    collect(current, currentRasters);
    const collectHistory = (document: CanvasDocument | null): void => {
      if (!document || documents.has(document)) return;
      documents.add(document); collect(document, historyRasters);
    };
    for (const entry of this.past) { collectHistory(entry.before.document); collectHistory(entry.after.document); }
    for (const entry of this.future) { collectHistory(entry.before.document); collectHistory(entry.after.document); }

    const seen = new Set<PixelArray>();
    let scannedTiles = 0;
    const visit = (raster: Raster, count: boolean): number => {
      let bytes = 0;
      for (let index = 0; index < raster.cols * raster.rows; index++) {
        scannedTiles++;
        // Swapped history tiles occupy no RAM and must not be faulted in just to enforce the RAM cap.
        if (raster.tileResidency(index) === 'swapped') continue;
        const tile = raster.tiles[index];
        if (tile && !seen.has(tile)) { seen.add(tile); if (count) bytes += tile.byteLength; }
      }
      return bytes;
    };
    for (const raster of currentRasters) visit(raster, false);
    let bytes = 0;
    for (const raster of historyRasters) if (!currentRasters.has(raster)) bytes += visit(raster, true);
    const old = this.performanceValue;
    this.performanceValue = { ...old, retainedScans: old.retainedScans + 1,
      scannedDocuments: old.scannedDocuments + documents.size,
      scannedRasters: old.scannedRasters + currentRasters.size + historyRasters.size,
      scannedTiles: old.scannedTiles + scannedTiles, retainedScanMs: old.retainedScanMs + performance.now() - started };
    return bytes;
  }

  private trim(current: CanvasDocument | null): void {
    while (this.past.length + this.future.length > this.entryLimit || this.retainedBytes(current) > this.retainedByteLimit) {
      if (this.past.length) this.past.shift();
      else if (this.future.length) this.future.shift();
      else break;
      this.performanceValue = { ...this.performanceValue, trimmedEntries: this.performanceValue.trimmedEntries + 1 };
    }
  }
}
