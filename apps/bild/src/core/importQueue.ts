/**
 * Per-session image import queue. Ported from EditorSession.swift
 * (`importImages` and `drainImports`); byte decoding is injected by the IO layer.
 */

import type { Point } from './geometry';
import type { Raster } from './raster';
import type { EditorSession } from './session';

export interface ImportItem {
  /** Displayed in partial-failure messages. */
  readonly name: string;
  /** Layer name after stripping a file extension; defaults to `name`. */
  readonly layerName?: string;
  /** Read only when this item reaches the head of its session's queue. */
  read(): Promise<Uint8Array>;
}

export type ImportDecoder = (bytes: Uint8Array, remainingPixels: number) => Promise<Raster>;

export interface ImportFailure {
  readonly name: string;
  readonly error: unknown;
  /** Upstream wording: "<last path component>: <localized error>". */
  readonly message: string;
}

export interface ImportResult {
  readonly layerIds: readonly string[];
  readonly failures: readonly ImportFailure[];
}

export interface ImportOptions {
  /** Document-pixel centre for every item in this request. */
  readonly point?: Point | null;
  /** Outer undo transaction name. */
  readonly transactionName?: string;
  /** Request-specific decoder, used by clipboard imports that may reuse internal pixels. */
  readonly decoder?: ImportDecoder;
  /** Override insertion for queued clipboard images or another import entry point. */
  readonly insert?: (session: EditorSession, raster: Raster, item: ImportItem, point: Point | null) => string | null;
}

interface PendingImport {
  readonly items: readonly ImportItem[];
  readonly decoder: ImportDecoder;
  readonly options: ImportOptions;
  readonly resolve: (result: ImportResult) => void;
}

interface SessionQueue {
  readonly pending: PendingImport[];
  draining: boolean;
}

// Module-level state ensures two adapters still serialize work for the same session.
const queues = new WeakMap<EditorSession, SessionQueue>();

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function queueFor(session: EditorSession): SessionQueue {
  let queue = queues.get(session);
  if (!queue) {
    queue = { pending: [], draining: false };
    queues.set(session, queue);
  }
  return queue;
}

async function waitForProjectAccess(session: EditorSession): Promise<void> {
  while (session.isProjectBusy) {
    await new Promise<void>((resolve) => {
      let off: (() => void) | null = null;
      const ready = () => {
        if (session.isProjectBusy) return;
        off?.();
        resolve();
      };
      off = session.subscribe(ready);
      ready();
    });
  }
}

function defaultInsert(session: EditorSession, raster: Raster, item: ImportItem, point: Point | null): string {
  return session.insertRaster(raster, item.layerName ?? item.name, point);
}

async function performRequest(session: EditorSession, request: PendingImport): Promise<ImportResult> {
  const layerIds: string[] = [];
  const failures: ImportFailure[] = [];
  // EditorSession.drainImports: a drop point is ignored when the first good image creates the canvas.
  const point = session.document ? request.options.point ?? null : null;
  const insert = request.options.insert ?? defaultInsert;
  session.beginEdit(request.options.transactionName ?? 'Import Images');
  try {
    for (const item of request.items) {
      try {
        const bytes = await item.read();
        const raster = await (request.options.decoder ?? request.decoder)(bytes, session.remainingPixelBudget());
        const id = insert(session, raster, item, point);
        if (id !== null) layerIds.push(id);
      } catch (error) {
        failures.push({ name: item.name, error, message: `${item.name}: ${errorText(error)}` });
      }
    }
  } finally {
    session.endEdit();
  }
  return { layerIds, failures };
}

async function drainImports(session: EditorSession, queue: SessionQueue): Promise<void> {
  try {
    while (queue.pending.length) {
      await waitForProjectAccess(session);
      const request = queue.pending.shift();
      if (!request) continue;
      request.resolve(await performRequest(session, request));
    }
  } finally {
    queue.draining = false;
    session.isImporting = false;
    session.notify('ui');
    // A request cannot normally arrive in this synchronous tail, but keep the queue lossless
    // if an observer enqueues from the final notification.
    if (queue.pending.length) startDrain(session, queue);
  }
}

function startDrain(session: EditorSession, queue: SessionQueue): void {
  if (queue.draining) return;
  queue.draining = true;
  session.isImporting = true;
  session.notify('ui');
  void drainImports(session, queue);
}

export class ImportQueue {
  constructor(private readonly decoder: ImportDecoder) {}

  /** Enqueues one request; all of its successful images form one undo step. */
  enqueue(session: EditorSession, items: readonly ImportItem[], options: ImportOptions = {}): Promise<ImportResult> {
    if (!items.length) return Promise.resolve({ layerIds: [], failures: [] });
    // EditorSession.importImages resolves pending direct-manipulation state before waiting.
    session.cancelCrop();
    session.commitTransform();
    const queue = queueFor(session);
    const result = new Promise<ImportResult>((resolve) => {
      queue.pending.push({ items: [...items], decoder: this.decoder, options, resolve });
    });
    startDrain(session, queue);
    return result;
  }
}

export function failureMessage(result: ImportResult): string | null {
  return result.failures.length ? result.failures.map((failure) => failure.message).join('\n\n') : null;
}
