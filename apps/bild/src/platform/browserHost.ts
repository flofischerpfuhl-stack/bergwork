/**
 * Browser HostAdapter: file pickers through <input type=file>, downloads through an object URL.
 * Desktop shells (Tauri/Electron) supply their own adapter with native dialogs.
 */

import type { HostAdapter } from '../../contracts';
import type { ImageDecoderHost } from './imageDecoder';

export type { HostDecodedImage, ImageDecoderHost } from './imageDecoder';

/** A place a file was saved to, which Save can overwrite later without asking again. */
export interface SaveTarget { readonly name: string }

/**
 * Optional host capabilities beyond the shared contract: choosing where to save (null when the user cancels) and
 * overwriting that place again (ProjectController.save / ProjectStore atomic replacement).
 */
export interface FileTargetHost extends HostAdapter, ImageDecoderHost {
  saveFileAs?(blob: Blob, suggestedName: string, kind: 'project' | 'png' | 'jpeg'): Promise<SaveTarget | null>;
  saveFileTo?(target: SaveTarget, blob: Blob): Promise<void>;
}

const PICKER_TYPES = {
  project: { description: 'Compositor project', accept: { 'application/zip': ['.zip'] } },
  png: { description: 'PNG image', accept: { 'image/png': ['.png'] } },
  jpeg: { description: 'JPEG image', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } },
} as const;

interface HandleTarget extends SaveTarget { readonly handle: FileSystemFileHandle }

/** Writes through a writable stream: the browser swaps the file in only when the stream closes, so a failed save leaves the old file. */
async function writeHandle(handle: FileSystemFileHandle, blob: Blob): Promise<void> {
  const writable = await (handle as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
  try { await writable.write(blob); await writable.close(); } catch (error) { await writable.abort().catch(() => {}); throw error; }
}

function pick(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    let settled = false;
    const finish = (files: File[]) => { if (settled) return; settled = true; input.remove(); resolve(files); };
    input.addEventListener('change', () => finish([...(input.files ?? [])]));
    input.addEventListener('cancel', () => finish([]));
    document.body.append(input);
    input.click();
  });
}

export function createBrowserHost(): FileTargetHost {
  const picker = (globalThis as { showSaveFilePicker?: (options: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  const targets = picker ? {
    async saveFileAs(blob: Blob, suggestedName: string, kind: 'project' | 'png' | 'jpeg'): Promise<SaveTarget | null> {
      let handle: FileSystemFileHandle;
      try { handle = await picker({ suggestedName, types: [PICKER_TYPES[kind]] }); } catch (error) {
        if ((error as DOMException).name === 'AbortError') return null;
        throw error;
      }
      await writeHandle(handle, blob);
      return { name: handle.name, handle } as HandleTarget;
    },
    async saveFileTo(target: SaveTarget, blob: Blob): Promise<void> { await writeHandle((target as HandleTarget).handle, blob); },
  } : {};
  return {
    ...targets,
    async chooseImages() { return pick('image/jpeg,image/png,image/heic,image/heif,image/tiff,.heic,.heif,.tif,.tiff', true); },
    async chooseProject() { return (await pick('.zip,.comp,application/zip', false))[0] ?? null; },
    async saveFile(blob, suggestedName) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = suggestedName;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    reportError(error) { console.warn(`[compositor] ${error.code}: ${error.message}`); },
  };
}
