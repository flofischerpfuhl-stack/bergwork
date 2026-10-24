import { describe, expect, it } from 'vitest';
import { ImportQueue, failureMessage, type ImportDecoder, type ImportItem } from '../../src/core/importQueue';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import { ProjectWorkspace } from '../../src/core/workspace';

function solid(width: number, height: number, rgba: readonly [number, number, number, number]): Raster {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) pixels.set(rgba, i * 4);
  return Raster.fromPixels(width, height, 4, pixels);
}

function item(name: string, key: number): ImportItem {
  return { name, layerName: name.replace(/\.[^.]+$/, ''), read: async () => new Uint8Array([key]) };
}

function fixtureDecoder(fail = new Set<number>()): ImportDecoder {
  return async (bytes) => {
    const key = bytes[0] ?? 0;
    if (fail.has(key)) throw new Error('The image could not be read. It may be damaged or unavailable.');
    return solid(64, 32, [key, key + 1, key + 2, 255]);
  };
}

async function turn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ImportQueue (EditorSession.drainImports)', () => {
  it('ImageImportTests.importPlacementAndPartialFailure', async () => {
    const queue = new ImportQueue(fixtureDecoder(new Set([9])));
    const session = new EditorSession();

    const initial = await queue.enqueue(session, [item('first.png', 1), item('second.png', 2)]);
    expect(initial.failures).toEqual([]);
    expect(session.document && { width: session.document.width, height: session.document.height }).toEqual({ width: 64, height: 32 });
    expect(session.document?.layers.map((layer) => layer.name)).toEqual(['first', 'second']);
    expect(session.document?.layers[0]?.raster?.pixel(0, 0)).toEqual([1, 2, 3, 255]);
    expect(session.activeLayerId).toBe(initial.layerIds[1]);

    session.createDocument(128, 128);
    const partial = await queue.enqueue(session, [item('good.png', 3), item('missing.png', 9)]);
    expect(partial.layerIds).toHaveLength(1);
    expect(session.document?.layers).toHaveLength(1);
    expect(session.document?.layers[0]?.transform.origin).toEqual({ x: 32, y: 48 });
    expect(failureMessage(partial)).toBe('missing.png: The image could not be read. It may be damaged or unavailable.');
    expect(session.history.undoName).toBe('Import Images');
    expect(session.isImporting).toBe(false);
  });

  it('ImageImportTests.dropPositionUsesDocumentCoordinates', async () => {
    const queue = new ImportQueue(fixtureDecoder());
    const session = new EditorSession();
    session.createDocument(1000, 800);
    const document = session.document!;
    session.viewport.resize({ width: 700, height: 500 }, 2, document);
    session.zoomTo(2.5);
    session.viewport.translate(70, -35);
    const location = session.viewport.viewPoint({ x: 300, y: 250 }, document);
    const dropPoint = session.viewport.documentPoint(location, document);

    await queue.enqueue(session, [item('drop.png', 4)], { point: dropPoint });

    expect(session.document?.layers[0]?.transform.origin).toEqual({ x: 268, y: 234 });
    expect(session.document && { width: session.document.width, height: session.document.height }).toEqual({ width: 1000, height: 800 });
  });

  it('ImageImportTests.queuedImportsAreNotLost, including a paste during decode', async () => {
    type Gate = { promise: Promise<Raster>; resolve: (raster: Raster) => void };
    const gates = new Map<number, Gate>();
    for (const key of [1, 2, 3]) {
      let resolve!: (raster: Raster) => void;
      const promise = new Promise<Raster>((done) => { resolve = done; });
      gates.set(key, { promise, resolve });
    }
    const order: number[] = [];
    const queue = new ImportQueue(async (bytes) => {
      const key = bytes[0]!;
      order.push(key);
      return gates.get(key)!.promise;
    });
    const session = new EditorSession();
    const first = queue.enqueue(session, [item('one.png', 1), item('two.png', 2)], { point: { x: 999, y: 999 } });
    await turn();
    const pasted = queue.enqueue(session, [item('clipboard.png', 3)], {
      transactionName: 'Paste',
      insert: (target, raster) => {
        const document = target.document!;
        return target.addPixelLayer(raster, {
          x: Math.floor((document.width - raster.width) / 2),
          y: Math.floor((document.height - raster.height) / 2),
        }, target.nextLayerName(), 'Paste');
      },
    });
    expect(order).toEqual([1]);

    gates.get(1)!.resolve(solid(64, 32, [10, 0, 0, 255]));
    await turn();
    expect(order).toEqual([1, 2]);
    gates.get(2)!.resolve(solid(64, 32, [20, 0, 0, 255]));
    gates.get(3)!.resolve(solid(64, 32, [30, 0, 0, 255]));
    await Promise.all([first, pasted]);

    expect(order).toEqual([1, 2, 3]);
    expect(session.document?.layers.map((layer) => layer.raster?.pixel(0, 0)[0])).toEqual([10, 20, 30]);
    expect(session.document?.layers[0]?.transform.origin).toEqual({ x: 0, y: 0 });
    expect(session.history.undoCount).toBe(2);
    expect(session.history.undoName).toBe('Paste');
    expect(session.isImporting).toBe(false);
    expect(session.undo()).toBe(true);
    expect(session.document?.layers).toHaveLength(2);
    expect(session.undo()).toBe(true);
    expect(session.document).toBeNull();
  });

  it('ImageImportTests.fileDropProvidersReachImporterInOrder', async () => {
    const decoded: number[] = [];
    const budgets: number[] = [];
    const queue = new ImportQueue(async (bytes, remainingPixels) => {
      decoded.push(bytes[0]!);
      budgets.push(remainingPixels);
      return solid(64, 32, [bytes[0]!, 0, 0, 255]);
    });
    const session = new EditorSession();

    await queue.enqueue(session, [item('first.png', 7), item('second.jpeg', 8)]);

    expect(decoded).toEqual([7, 8]);
    expect(budgets).toEqual([100_000_000, 100_000_000 - 64 * 32]);
    expect(session.document?.layers.map((layer) => layer.name)).toEqual(['first', 'second']);
    expect(session.document?.layers.map((layer) => layer.raster?.pixel(4, 4)[0])).toEqual([7, 8]);
  });

  it('ProjectWorkspaceTests targeted imports serialize per tab, not across tabs', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started: string[] = [];
    const queue = new ImportQueue(async (bytes) => {
      const key = bytes[0]!;
      started.push(String(key));
      if (key === 1) await firstGate;
      return solid(8, 6, [key, 0, 0, 255]);
    });
    const workspace = new ProjectWorkspace();
    const first = workspace.current;
    const second = workspace.addTab(false);
    const delayed = queue.enqueue(first.session, [item('first.png', 1)]);
    await turn();
    const independent = queue.enqueue(second.session, [item('second.png', 2)]);
    await independent;

    expect(started).toEqual(['1', '2']);
    expect(workspace.tabs).toHaveLength(2);
    expect(second.session.document?.layers[0]?.raster?.pixel(0, 0)).toEqual([2, 0, 0, 255]);
    expect(first.session.document).toBeNull();
    releaseFirst();
    await delayed;
    expect(first.session.document?.layers[0]?.raster?.pixel(0, 0)).toEqual([1, 0, 0, 255]);
    expect(second.session.document?.layers).toHaveLength(1);
    workspace.destroy();
  });

  it('keeps a request queued while a project operation is busy', async () => {
    const decoded: number[] = [];
    const queue = new ImportQueue(async (bytes) => {
      decoded.push(bytes[0]!);
      return solid(2, 2, [bytes[0]!, 0, 0, 255]);
    });
    const session = new EditorSession();
    session.isProjectBusy = true;
    const pending = queue.enqueue(session, [item('waiting.png', 5)]);
    await turn();
    expect(decoded).toEqual([]);
    expect(session.isImporting).toBe(true);

    session.isProjectBusy = false;
    session.notify('ui');
    await pending;
    expect(decoded).toEqual([5]);
    expect(session.document?.layers[0]?.raster?.pixel(0, 0)).toEqual([5, 0, 0, 255]);
  });
});
