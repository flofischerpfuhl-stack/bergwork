/**
 * Browser HostAdapter: file pickers through <input type=file>, downloads through an object URL.
 * Desktop shells (Tauri/Electron) supply their own adapter with native dialogs.
 */

import type { ImageDecoderHost } from './imageDecoder';
import { sha256Hex } from '../io/sha256';
import type {
  CapabilityHost, CodecHost, ComputeHost, FileSaveKind, FileSaveTarget, FileSystemHost, FontHost,
  HostCapabilityMap, ModelHost, SystemFont,
} from './hosts/types';
import { bindCapabilityRegistry } from './hosts/types';
import { BrowserScratchHost, OpfsScratchHost } from './opfsScratchHost';
import type { ScratchHostCapability } from './scratchHost';

export type { HostDecodedImage, ImageDecoderHost } from './imageDecoder';

/** A place a file was saved to, which Save can overwrite later without asking again. */
export type SaveTarget = FileSaveTarget;
export interface FileByteSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export type SaveKind = FileSaveKind;

/**
 * Optional host capabilities beyond the shared contract: choosing where to save (null when the user cancels) and
 * writing to that place, now or again later (ProjectController.save / ProjectStore atomic replacement).
 * Choosing comes first and on its own: a browser only shows its save dialog while it still counts the user's click
 * or key press, so the (possibly slow) encoding must happen afterwards.
 */
export interface FileTargetHost extends CapabilityHost, ImageDecoderHost, Partial<ScratchHostCapability> {
  chooseContent?(): Promise<File[]>;
  chooseSaveTarget?(suggestedName: string, kind: SaveKind): Promise<SaveTarget | null>;
  saveFileTo?(target: SaveTarget, blob: Blob): Promise<void>;
  openFileSink?(target: SaveTarget): Promise<FileByteSink | null>;
}

const PICKER_TYPES = {
  project: { description: 'Fernwork image project or PSD', accept: {
    'application/zip': ['.fwimg', '.zip'], 'image/vnd.adobe.photoshop': ['.psd', '.psb'],
  } },
  png: { description: 'PNG image', accept: { 'image/png': ['.png'] } },
  jpeg: { description: 'JPEG image', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } },
  webp: { description: 'WebP image', accept: { 'image/webp': ['.webp'] } },
  avif: { description: 'AVIF image', accept: { 'image/avif': ['.avif'] } },
  tiff: { description: 'TIFF image', accept: { 'image/tiff': ['.tif', '.tiff'] } },
  zip: { description: 'Exported images (ZIP)', accept: { 'application/zip': ['.zip'] } },
} as const;

interface HandleTarget extends SaveTarget { readonly handle: FileSystemFileHandle }

interface LocalFontData { readonly family: string; readonly fullName: string; readonly postscriptName: string; blob(): Promise<Blob> }
type QueryLocalFonts = () => Promise<readonly LocalFontData[]>;

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

function browserFonts(): FontHost {
  const query = (globalThis as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts?.bind(globalThis);
  const cache = new Map<string, LocalFontData>();
  return {
    version: 1,
    async listSystemFonts(): Promise<readonly SystemFont[]> {
      if (!query) return [];
      const fonts = await query().catch(() => []);
      cache.clear();
      return fonts.map((font, index) => {
        const id = `${font.postscriptName}\u0000${index}`;
        cache.set(id, font);
        return { id, family: font.family, fullName: font.fullName,
          style: font.fullName.slice(font.family.length).trim() || 'Regular', postscriptName: font.postscriptName };
      });
    },
    async loadSystemFont(id: string): Promise<Uint8Array> {
      let font = cache.get(id);
      if (!font) { await this.listSystemFonts(); font = cache.get(id); }
      if (!font) throw new Error('The selected system font is no longer available.');
      return new Uint8Array(await (await font.blob()).arrayBuffer());
    },
  };
}

function browserCompute(): ComputeHost {
  return {
    version: 1,
    async run(job, input) {
      if (job !== 'checksum-sha256') return null;
      return { bytes: new TextEncoder().encode(sha256Hex(input)), metadata: { algorithm: 'sha256' } };
    },
  };
}

function browserModels(): ModelHost {
  const cacheName = 'fernwork-models-v1';
  return {
    version: 1,
    async resolveModel(request, progress, signal) {
      const key = new Request(`https://fernwork-model-cache.invalid/${encodeURIComponent(request.id)}/${request.sha256}`);
      const storage = typeof caches === 'undefined' ? null : await caches.open(cacheName).catch(() => null);
      const saved = await storage?.match(key);
      if (saved) {
        const bytes = new Uint8Array(await saved.arrayBuffer());
        if (sha256Hex(bytes) === request.sha256) return { bytes, cacheHit: true };
        await storage?.delete(key).catch(() => false);
      }
      const source = request.url;
      if (!source || !request.userInitiated) return null;
      const response = await fetch(source, { signal });
      if (!response.ok) throw new Error(`Model download failed with HTTP ${response.status}.`);
      const totalHeader = Number(response.headers.get('content-length'));
      const total = Number.isFinite(totalHeader) && totalHeader >= 0 ? totalHeader : null;
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          chunks.push(item.value); length += item.value.byteLength; progress?.(length, total);
        }
      } else {
        const bytes = new Uint8Array(await response.arrayBuffer()); chunks.push(bytes); length = bytes.byteLength;
      }
      const bytes = new Uint8Array(length); let at = 0;
      for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
      if (sha256Hex(bytes) !== request.sha256) throw new Error('Downloaded model checksum does not match its manifest.');
      await storage?.put(key, new Response(bytes.slice())).catch(() => undefined);
      return { bytes, cacheHit: false };
    },
  };
}

export function createBrowserHost(): FileTargetHost {
  // Bound to window: called detached, the browser throws "Illegal invocation".
  const pickerFunction = (globalThis as { showSaveFilePicker?: (options: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  const picker = pickerFunction?.bind(globalThis);
  const openFunction = (globalThis as { showOpenFilePicker?: (options: unknown) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker?.bind(globalThis);
  const listeners = new Set<(files: readonly { name: string; id: string }[]) => void>();
  const recent: { name: string; id: string }[] = [];
  const openHandles = new Map<string, FileSystemFileHandle>();
  let nextHandle = 1;
  const saveTargets = picker ? {
    async chooseSaveTarget(suggestedName: string, kind: SaveKind): Promise<SaveTarget | null> {
      let handle: FileSystemFileHandle;
      try { handle = await picker({ suggestedName, types: [PICKER_TYPES[kind]] }); } catch (error) {
        if ((error as DOMException).name === 'AbortError') return null;
        throw error;
      }
      return { name: handle.name, handle } as HandleTarget;
    },
    async saveFileTo(target: SaveTarget, blob: Blob): Promise<void> { await writeHandle((target as HandleTarget).handle, blob); },
  } : null;
  const files: FileSystemHost | undefined = saveTargets && openFunction ? {
    version: 1,
    async chooseFiles(kind) {
      let handles: FileSystemFileHandle[];
      try {
        handles = await openFunction({ multiple: kind === 'images', types: kind === 'project' ? [PICKER_TYPES.project]
          : kind === 'content' ? [{ description: 'Placeable content', accept: {
            'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.tif', '.tiff', '.heic', '.heif', '.svg'],
            'application/pdf': ['.pdf'], 'application/zip': ['.fwimg'],
          } }] : [{ description: 'Images', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.tif', '.tiff', '.heic', '.heif'],
            'image/vnd.adobe.photoshop': ['.psd', '.psb'] } }] });
      } catch (error) { if ((error as DOMException).name === 'AbortError') return []; throw error; }
      return handles.map((handle) => { const id = `browser-handle-${nextHandle++}`; openHandles.set(id, handle); return { id, name: handle.name }; });
    },
    chooseSaveTarget: saveTargets.chooseSaveTarget,
    writeFile: saveTargets.saveFileTo,
    async recentFiles() { return recent.slice(); },
    async recordRecentFile(file) { const index = recent.findIndex((item) => item.id === file.id); if (index >= 0) recent.splice(index, 1); recent.unshift(file); recent.splice(20); },
    onOpenFiles(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async readFile(file) { const handle = openHandles.get(file.id); if (!handle) throw new Error('The browser file handle has expired.'); return handle.getFile(); },
    saveTargetFor(file) { const handle = openHandles.get(file.id); return handle ? { name: file.name, handle } as HandleTarget : null; },
  } : undefined;
  const codecs: CodecHost = { version: 1 };
  const capabilities: HostCapabilityMap = {
    files,
    fonts: browserFonts(),
    codecs,
    compute: browserCompute(),
    models: browserModels(),
    color: { version: 1, async displayProfile() { return { name: 'sRGB', bytes: null, assumed: true }; } },
  };
  // Choosing a save destination needs only the save picker (B1); the full FileSystemHost also needs the open picker.
  const targets = saveTargets ?? {};
  const host: FileTargetHost = {
    defaultProfile: 'lite',
    capabilities,
    ...targets,
    ...(picker ? {
      async openFileSink(target: SaveTarget): Promise<FileByteSink | null> {
        if (!('handle' in target)) return null;
        const writable = await (target as HandleTarget).handle.createWritable();
        return {
          async write(chunk) { await writable.write(chunk.slice() as Uint8Array<ArrayBuffer>); },
          async close() { await writable.close(); },
          async abort() { await writable.abort(); },
        };
      },
    } : {}),
    ...(OpfsScratchHost.available() || typeof indexedDB !== 'undefined'
      ? { scratchHost: new BrowserScratchHost(), editorProfile: 'lite' as const } : {}),
    async chooseImages() {
      return pick('image/jpeg,image/png,image/heic,image/heif,image/tiff,image/webp,image/avif,image/gif,image/vnd.adobe.photoshop,.heic,.heif,.tif,.tiff,.webp,.avif,.gif,.psd,.psb', true);
    },
    async chooseContent() {
      return pick('image/jpeg,image/png,image/heic,image/heif,image/tiff,image/webp,image/avif,image/gif,image/svg+xml,application/pdf,application/zip,.heic,.heif,.tif,.tiff,.webp,.avif,.gif,.svg,.pdf,.fwimg', false);
    },
    async chooseProject() { return (await pick('.fwimg,.zip,.comp,.psd,.psb,application/zip,image/vnd.adobe.photoshop', false))[0] ?? null; },
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
  return bindCapabilityRegistry(host);
}
