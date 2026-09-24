/**
 * Browser HostAdapter: file pickers through <input type=file>, downloads through an object URL.
 * Desktop shells (Tauri/Electron) supply their own adapter with native dialogs.
 */

import type { HostAdapter } from '../../contracts';
import type { ImageDecoderHost } from './imageDecoder';

export type { HostDecodedImage, ImageDecoderHost } from './imageDecoder';

/** A place a file was saved to, which Save can overwrite later without asking again. */
export interface SaveTarget { readonly name: string }

export type SaveKind = 'project' | 'png' | 'jpeg';

/**
 * Optional host capabilities beyond the shared contract: choosing where to save (null when the user cancels) and
 * writing to that place, now or again later (ProjectController.save / ProjectStore atomic replacement).
 * Choosing comes first and on its own: a browser only shows its save dialog while it still counts the user's click
 * or key press, so the (possibly slow) encoding must happen afterwards.
 */
export interface FileTargetHost extends HostAdapter, ImageDecoderHost {
  chooseSaveTarget?(suggestedName: string, kind: SaveKind): Promise<SaveTarget | null>;
  saveFileTo?(target: SaveTarget, blob: Blob): Promise<void>;
}

const PICKER_TYPES = {
  project: { description: 'Fernwork image project', accept: { 'application/zip': ['.fwimg', '.zip'] } },
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
  // Bound to window: called detached, the browser throws "Illegal invocation".
  const pickerFunction = (globalThis as { showSaveFilePicker?: (options: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  const picker = pickerFunction?.bind(globalThis);
  const targets = picker ? {
    async chooseSaveTarget(suggestedName: string, kind: SaveKind): Promise<SaveTarget | null> {
      let handle: FileSystemFileHandle;
      try { handle = await picker({ suggestedName, types: [PICKER_TYPES[kind]] }); } catch (error) {
        if ((error as DOMException).name === 'AbortError') return null;
        throw error;
      }
      return { name: handle.name, handle } as HandleTarget;
    },
    async saveFileTo(target: SaveTarget, blob: Blob): Promise<void> { await writeHandle((target as HandleTarget).handle, blob); },
  } : {};
  return {
    ...targets,
    async chooseImages() {
      return pick('image/jpeg,image/png,image/heic,image/heif,image/tiff,image/webp,image/avif,image/gif,.heic,.heif,.tif,.tiff,.webp,.avif,.gif', true);
    },
    async chooseProject() { return (await pick('.fwimg,.zip,.comp,application/zip', false))[0] ?? null; },
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
