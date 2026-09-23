import type { FileTargetHost, SaveTarget } from '../../src/platform/browserHost';

interface NativeTarget extends SaveTarget { readonly path: string }

const IMAGE_FILTER = { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'heic', 'heif', 'psd'] };
const PROJECT_FILTER = { name: 'Fernwork image project', extensions: ['fwimg', 'zip'] };

function baseName(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}

async function asFiles(paths: readonly string[]): Promise<File[]> {
  return Promise.all(paths.map(async (path) => {
    const bytes = await window.__TAURI__.fs.readFile(path);
    return new File([bytes], baseName(path));
  }));
}

async function write(path: string, blob: Blob): Promise<void> {
  await window.__TAURI__.fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
}

/** Tauri implementation of HostAdapter + FileTargetHost; paths come only from native dialogs. */
export function createTauriHost(): FileTargetHost {
  return {
    async chooseImages() {
      const selected = await window.__TAURI__.dialog.open({ multiple: true, directory: false, filters: [IMAGE_FILTER] });
      return asFiles(typeof selected === 'string' ? [selected] : selected ?? []);
    },
    async chooseProject() {
      const selected = await window.__TAURI__.dialog.open({ multiple: false, directory: false, filters: [PROJECT_FILTER] });
      if (typeof selected !== 'string') return null;
      const [file] = await asFiles([selected]);
      return file ?? null;
    },
    async saveFileAs(blob, suggestedName, kind) {
      const filters = kind === 'project' ? [PROJECT_FILTER]
        : [{ name: kind === 'png' ? 'PNG image' : 'JPEG image', extensions: kind === 'png' ? ['png'] : ['jpg', 'jpeg'] }];
      const path = await window.__TAURI__.dialog.save({ defaultPath: suggestedName, filters });
      if (!path) return null;
      await write(path, blob);
      return { name: baseName(path), path } as NativeTarget;
    },
    async saveFileTo(target, blob) { await write((target as NativeTarget).path, blob); },
    async saveFile(blob, suggestedName) {
      const path = await window.__TAURI__.dialog.save({ defaultPath: suggestedName, filters: [PROJECT_FILTER] });
      if (path) await write(path, blob);
    },
    reportError(error) { console.warn(`[Fernwork Bildeditor] ${error.code}: ${error.message}`); },
  };
}
