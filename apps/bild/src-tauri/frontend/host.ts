import type { FileByteSink, FileTargetHost, SaveTarget } from '../../src/platform/browserHost';
import { requireScratchKey, type ScratchHost } from '../../src/platform/scratchHost';
import type { EditorController } from '../../src/ui/controller';

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

function nativeProjectBlobRange(path: string, start: number, end: number, type: string): Blob {
  const size = Math.max(0, end - start);
  const stream = () => {
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (offset >= size) { controller.close(); return; }
        const bytes = new Uint8Array(await window.__TAURI__.core.invoke<ArrayBuffer>('read_file_chunk',
          { path, offset: start + offset, length: Math.min(1024 * 1024, size - offset) }));
        if (!bytes.byteLength) { controller.error(new Error('Project file ended unexpectedly')); return; }
        offset += bytes.byteLength; controller.enqueue(bytes);
      },
    });
  };
  return {
    name: baseName(path), size, type, stream,
    slice(relativeStart = 0, relativeEnd = size, contentType = '') {
      const normalize = (value: number) => value < 0 ? Math.max(size + value, 0) : Math.min(value, size);
      const from = normalize(relativeStart), to = Math.max(from, normalize(relativeEnd));
      return nativeProjectBlobRange(path, start + from, start + to, contentType);
    },
    async arrayBuffer() {
      const output = new Uint8Array(size), reader = stream().getReader();
      let offset = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          output.set(value, offset); offset += value.byteLength;
        }
      } finally { reader.releaseLock(); }
      return output.buffer;
    },
  } as unknown as Blob;
}

export async function nativeProjectBlob(path: string): Promise<Blob> {
  const size = await window.__TAURI__.core.invoke<number>('file_size', { path });
  return nativeProjectBlobRange(path, 0, size, 'application/zip');
}

async function writeChunk(path: string, chunk: Uint8Array, append: boolean): Promise<void> {
  const encoded = new TextEncoder().encode(path);
  if (encoded.byteLength > 0xffff) throw new RangeError('Save path is too long');
  const body = new Uint8Array(3 + encoded.byteLength + chunk.byteLength);
  body[0] = append ? 1 : 0; new DataView(body.buffer).setUint16(1, encoded.byteLength, true);
  body.set(encoded, 3); body.set(chunk, 3 + encoded.byteLength);
  await window.__TAURI__.core.invoke('save_file_chunk', body);
}

async function write(path: string, blob: Blob): Promise<void> {
  const reader = blob.stream().getReader();
  let append = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      await writeChunk(path, value, append); append = true;
    }
    if (!append) {
      await writeChunk(path, new Uint8Array(), false);
    }
  } finally { reader.releaseLock(); }
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

export interface TauriHostOptions {
  readonly acceptanceArchivePath?: string;
  readonly tileBudgetBytes?: number;
  readonly controllerReady?: (controller: EditorController) => void;
}

/** Tauri implementation of HostAdapter + FileTargetHost; paths come only from native dialogs. */
export function createTauriHost(options: TauriHostOptions = {}): FileTargetHost {
  const acceptance = options.acceptanceArchivePath;
  return {
    scratchHost: new TauriScratchHost(),
    editorProfile: 'pro',
    ...(options.tileBudgetBytes === undefined ? {} : { tileBudgetBytes: options.tileBudgetBytes }),
    ...(options.controllerReady ? { controllerReady: options.controllerReady } : {}),
    async chooseImages() {
      const selected = await window.__TAURI__.dialog.open({ multiple: true, directory: false, filters: [IMAGE_FILTER] });
      return asFiles(typeof selected === 'string' ? [selected] : selected ?? []);
    },
    async chooseProject() {
      if (acceptance) return nativeProjectBlob(acceptance);
      const selected = await window.__TAURI__.dialog.open({ multiple: false, directory: false, filters: [PROJECT_FILTER] });
      if (typeof selected !== 'string') return null;
      return nativeProjectBlob(selected);
    },
    // Choosing and writing are separate (B1): the editor asks for the path first and encodes afterwards.
    async chooseSaveTarget(suggestedName, kind) {
      if (acceptance && kind === 'project') return { name: baseName(acceptance), path: acceptance } as NativeTarget;
      const filters = kind === 'project' ? [PROJECT_FILTER]
        : [{ name: kind === 'png' ? 'PNG image' : 'JPEG image', extensions: kind === 'png' ? ['png'] : ['jpg', 'jpeg'] }];
      const path = await window.__TAURI__.dialog.save({ defaultPath: suggestedName, filters });
      if (!path) return null;
      return { name: baseName(path), path } as NativeTarget;
    },
    async saveFileTo(target, blob) { await write((target as NativeTarget).path, blob); },
    async openFileSink(target): Promise<FileByteSink> {
      const path = (target as NativeTarget).path;
      let append = false;
      return {
        async write(chunk) { await writeChunk(path, chunk, append); append = true; },
        async close() { if (!append) await writeChunk(path, new Uint8Array(), false); },
        async abort() { /* a failed stream remains visibly incomplete and is never marked saved */ },
      };
    },
    async saveFile(blob, suggestedName) {
      const path = await window.__TAURI__.dialog.save({ defaultPath: suggestedName, filters: [PROJECT_FILTER] });
      if (path) await write(path, blob);
    },
    reportError(error) { console.warn(`[Fernwork Bildeditor] ${error.code}: ${error.message}`); },
  };
}
