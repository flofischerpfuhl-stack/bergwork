import type { FileTargetHost, SaveTarget } from '../../src/platform/browserHost';
import { requireScratchKey, type ScratchHost } from '../../src/platform/scratchHost';

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

class TauriScratchHost implements ScratchHost {
  readonly kind = 'tauri' as const;

  async read(key: string): Promise<Uint8Array | null> {
    requireScratchKey(key);
    const response = new Uint8Array(await window.__TAURI__.core.invoke<ArrayBuffer>('scratch_read', { key }));
    return response[0] === 0 ? null : response.slice(1);
  }

  async write(key: string, bytes: Uint8Array, options: { append?: boolean } = {}): Promise<void> {
    requireScratchKey(key);
    const encoded = new TextEncoder().encode(key);
    const body = new Uint8Array(3 + encoded.byteLength + bytes.byteLength);
    body[0] = options.append ? 1 : 0;
    new DataView(body.buffer).setUint16(1, encoded.byteLength, true);
    body.set(encoded, 3);
    body.set(bytes, 3 + encoded.byteLength);
    await window.__TAURI__.core.invoke('scratch_write', body);
  }

  async remove(key: string): Promise<void> {
    requireScratchKey(key);
    await window.__TAURI__.core.invoke('scratch_remove', { key });
  }
  async list(prefix = ''): Promise<readonly string[]> {
    return window.__TAURI__.core.invoke<string[]>('scratch_list', { prefix });
  }
  async flush(): Promise<void> { await window.__TAURI__.core.invoke('scratch_flush'); }
  async close(): Promise<void> { await this.flush(); }
}

/** Tauri implementation of HostAdapter + FileTargetHost; paths come only from native dialogs. */
export function createTauriHost(): FileTargetHost {
  return {
    scratchHost: new TauriScratchHost(),
    editorProfile: 'pro',
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
    // Choosing and writing are separate (B1): the editor asks for the path first and encodes afterwards.
    async chooseSaveTarget(suggestedName, kind) {
      const filters = kind === 'project' ? [PROJECT_FILTER]
        : [{ name: kind === 'png' ? 'PNG image' : 'JPEG image', extensions: kind === 'png' ? ['png'] : ['jpg', 'jpeg'] }];
      const path = await window.__TAURI__.dialog.save({ defaultPath: suggestedName, filters });
      if (!path) return null;
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
