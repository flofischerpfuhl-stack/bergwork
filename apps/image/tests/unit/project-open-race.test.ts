import { describe, expect, it } from 'vitest';
import type { HostAdapter } from '../../contracts';
import type { CanvasDocument } from '../../src/core/document';
import { uuid } from '../../src/core/ids';
import { writeCompZip } from '../../src/io/compPackage';
import { writeArchive } from '../../src/io/project';
import { EditorController } from '../../src/ui/controller';

const host: HostAdapter = {
  chooseImages: async () => [], chooseProject: async () => null,
  saveFile: async () => undefined, reportError: () => undefined,
};

function archive(name: string): Blob {
  return writeArchive(document(name), name, null).blob;
}

function document(name: string): CanvasDocument {
  return {
    id: name, width: 7, height: 5, resolution: 72, layers: [], artboards: [], selection: null,
  };
}

async function deferredComp(name: string): Promise<{ blob: Blob; release: () => void }> {
  const bytes = await writeCompZip({ ...document(name), id: uuid() }, { name });
  let resolve!: (bytes: ArrayBuffer) => void;
  const pending = new Promise<ArrayBuffer>((done) => { resolve = done; });
  return {
    blob: { arrayBuffer: () => pending } as Blob,
    release: () => resolve(bytes.slice().buffer as ArrayBuffer),
  };
}

describe('project-open transaction', () => {
  it('selects a blank loading tab before asynchronous archive decoding can expose stale project state', async () => {
    const controller = new EditorController(host, 'en', 'dark');
    controller.session.createNewProject(30, 20);
    controller.session.addBlankLayer();
    controller.session.addBlankLayer();
    const previous = controller.workspace.current;
    expect(previous.session.document?.layers).toHaveLength(3);

    const opening = controller.openArchive(archive('dropped'), 'dropped.fwimg');
    const reserved = controller.workspace.current;
    expect(reserved).not.toBe(previous);
    expect(reserved.title).toBe('dropped');
    expect(reserved.session.isProjectBusy).toBe(true);
    expect(reserved.session.document).toBeNull();

    await opening;
    expect(controller.workspace.current).toBe(reserved);
    expect(reserved.session.isProjectBusy).toBe(false);
    expect(reserved.session.document).toMatchObject({ id: 'dropped', width: 7, height: 5, layers: [] });
  });

  it('keeps the last of concurrent drops selected regardless of decode completion order', async () => {
    const controller = new EditorController(host, 'en', 'dark');
    controller.session.createNewProject(10, 10);
    const firstArchive = await deferredComp('first');
    const secondArchive = await deferredComp('second');
    const first = controller.openArchive(firstArchive.blob, 'first.comp');
    const firstTab = controller.workspace.current;
    const second = controller.openArchive(secondArchive.blob, 'second.comp');
    const secondTab = controller.workspace.current;

    expect(secondTab).not.toBe(firstTab);
    secondArchive.release();
    await second;
    expect(controller.workspace.current).toBe(secondTab);
    firstArchive.release();
    await first;
    expect(controller.workspace.current).toBe(secondTab);
    expect(controller.workspace.tabs.map((tab) => tab.title)).toEqual(['Untitled', 'first', 'second']);
  });
});
