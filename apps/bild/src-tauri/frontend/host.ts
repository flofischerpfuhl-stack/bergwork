/// <reference path="./tauri-globals.d.ts" />

import type { FileByteSink, FileTargetHost, SaveTarget } from '../../src/platform/browserHost';
import { sha256Hex } from '../../src/io/sha256';
import type { CodecHost, ColorHost, ComputeHost, FileSystemHost, FontHost, HostCapabilityMap, HostFileReference, ModelHost, ScreenColorHost } from '../../src/platform/hosts';
import { bindCapabilityRegistry } from '../../src/platform/hosts';
import { requireScratchKey, type ScratchHost } from '../../src/platform/scratchHost';
import { webKitGtkMemoryBudgets } from '../../src/platform/runtimeMemory';
import type { EditorController } from '../../src/ui/controller';
import { invokeRawDecoder, rawBackendFor } from './rawCodec';

interface NativeTarget extends SaveTarget { readonly path: string }
const RAW_EXTENSIONS = ['dng', '3fr', 'arw', 'cr2', 'cr3', 'erf', 'kdc', 'mos', 'mrw', 'nef', 'nrw', 'orf', 'pef', 'raf', 'raw', 'rw2', 'rwl', 'srw'];
const IMAGE_FILTER = { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'tif', 'tiff', 'heic', 'heif', 'psd', 'psb', ...RAW_EXTENSIONS] };
const CONTENT_FILTER = { name: 'Placeable content', extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'tif', 'tiff', 'heic', 'heif', 'svg', 'pdf', 'fwimg'] };
const PROJECT_FILTER = { name: 'Fernwork image project or PSD', extensions: ['fwimg', 'zip', 'psd', 'psb'] };
const BATCH_FILTER = { name: 'Images and projects', extensions: ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'heic', 'heif', 'psd', 'psb', 'fwimg'] };
interface NativeFolder { readonly name: string; readonly path: string }

async function nativeFileExists(path: string): Promise<boolean> {
  try { await window.__TAURI__.core.invoke<number>('file_size', { path }); return true; } catch { return false; }
}

/** Joins a folder chosen in the native dialog and a file name with the folder's own separator. */
function inFolder(folder: string, name: string): string {
  const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return folder.endsWith(separator) ? `${folder}${name}` : `${folder}${separator}${name}`;
}
const SAVE_FILTERS: Record<'png' | 'jpeg' | 'webp' | 'avif' | 'tiff' | 'zip' | 'recipe', { name: string; extensions: string[] }> = {
  png: { name: 'PNG image', extensions: ['png'] }, jpeg: { name: 'JPEG image', extensions: ['jpg', 'jpeg'] },
  webp: { name: 'WebP image', extensions: ['webp'] }, avif: { name: 'AVIF image', extensions: ['avif'] },
  tiff: { name: 'TIFF image', extensions: ['tif', 'tiff'] }, zip: { name: 'Exported images (ZIP)', extensions: ['zip'] },
  recipe: { name: 'Fernwork recipe', extensions: ['fwrecipe'] },
};
const baseName = (path: string) => path.split(/[\\/]/).at(-1) || path;
async function asFiles(paths: readonly string[]): Promise<File[]> {
  // A Blob-shaped range reader keeps native input lazy and bounded. The previous fs.readFile →
  // Uint8Array copy → File path held two complete encoded files in WebKit/JSC and eagerly read every
  // file in a multi-import before the sequential import queue could start.
  return Promise.all(paths.map(async (path) => nativeProjectBlob(path, '') as unknown as File));
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

export async function nativeProjectBlob(path: string, type = 'application/zip'): Promise<Blob> {
  const size = await window.__TAURI__.core.invoke<number>('file_size', { path });
  return nativeProjectBlobRange(path, 0, size, type);
}

const NATIVE_TRANSFER_CHUNK = 256 * 1024;

async function writeNativeChunk(path: string, chunk: Uint8Array, append: boolean): Promise<void> {
  const encoded = new TextEncoder().encode(path);
  if (encoded.byteLength > 0xffff) throw new RangeError('Save path is too long');
  const body = new Uint8Array(3 + encoded.byteLength + chunk.byteLength);
  body[0] = append ? 1 : 0; new DataView(body.buffer).setUint16(1, encoded.byteLength, true);
  body.set(encoded, 3); body.set(chunk, 3 + encoded.byteLength);
  await window.__TAURI__.core.invoke('save_file_chunk', body);
}

/** WebKitGTK copies raw IPC bodies into JSC and GLib storage, so never send a PNG band as one body. */
async function writeChunk(path: string, chunk: Uint8Array, append: boolean): Promise<void> {
  if (!chunk.byteLength) {
    await writeNativeChunk(path, chunk, append);
    return;
  }
  for (let offset = 0; offset < chunk.byteLength; offset += NATIVE_TRANSFER_CHUNK) {
    await writeNativeChunk(path, chunk.subarray(offset, offset + NATIVE_TRANSFER_CHUNK), append || offset > 0);
  }
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
  readonly gpuTextureBudgetBytes?: number;
  readonly gpuTextureChunkSize?: number;
  readonly controllerReady?: (controller: EditorController) => void;
  readonly reportError?: (error: { readonly code: string; readonly message: string }) => void;
}

function nativeFiles(acceptanceProjectPath?: string): FileSystemHost {
  const files: FileSystemHost = {
    version: 1,
    async chooseFiles(kind) {
      const selected = await window.__TAURI__.dialog.open({ multiple: kind === 'images' || kind === 'batch', directory: false,
        filters: kind === 'project' ? [PROJECT_FILTER] : kind === 'content' ? [CONTENT_FILTER] : kind === 'batch' ? [BATCH_FILTER]
          : kind === 'brushes' ? [{ name: 'Photoshop Brushes', extensions: ['abr', 'ABR'] }] : [IMAGE_FILTER] });
      const paths = typeof selected === 'string' ? [selected] : selected ?? [];
      return paths.map((id) => ({ id, name: baseName(id) }));
    },
    async chooseSaveTarget(suggestedName, kind) {
      if (acceptanceProjectPath && kind === 'project') {
        return { name: baseName(acceptanceProjectPath), path: acceptanceProjectPath } as NativeTarget;
      }
      const filters = kind === 'project' ? [PROJECT_FILTER] : [SAVE_FILTERS[kind]];
      const path = await window.__TAURI__.dialog.save({ defaultPath: suggestedName, filters });
      return path ? { name: baseName(path), path } as NativeTarget : null;
    },
    async writeFile(target, blob) { await write((target as NativeTarget).path, blob); },
    // Batch export into a real folder: files are written by path (save_file_chunk), never over an existing file.
    async chooseFolder() {
      const selected = await window.__TAURI__.dialog.open({ multiple: false, directory: true, filters: [] });
      return typeof selected === 'string' ? { name: baseName(selected), path: selected } as NativeFolder : null;
    },
    async writeFileInFolder(folder, name, blob) {
      const directory = (folder as NativeFolder).path;
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name, extension = dot > 0 ? name.slice(dot) : '';
      let candidate = name;
      for (let n = 2; await nativeFileExists(inFolder(directory, candidate)); n++) candidate = `${stem} ${n}${extension}`;
      await write(inFolder(directory, candidate), blob);
      return candidate;
    },
    recentFiles: () => window.__TAURI__.core.invoke<HostFileReference[]>('recent_files'),
    recordRecentFile: (file) => window.__TAURI__.core.invoke<void>('record_recent_file', { file }),
    async readFile(file) { return nativeProjectBlob(file.id); },
    saveTargetFor(file) { return { name: file.name, path: file.id } as NativeTarget; },
    onOpenFiles(listener) {
      let active = true;
      let unlisten: (() => void) | undefined;
      void window.__TAURI__.event.listen<HostFileReference[]>('fernwork-open-files', (event) => { if (active) listener(event.payload); })
        .then((off) => { if (active) unlisten = off; else off(); });
      void window.__TAURI__.core.invoke<HostFileReference[]>('startup_files').then((files) => { if (active && files.length) listener(files); });
      return () => { active = false; unlisten?.(); };
    },
  };
  return files;
}

const fonts: FontHost = {
  version: 1,
  listSystemFonts: () => window.__TAURI__.core.invoke('list_system_fonts'),
  loadSystemFont: (id) => window.__TAURI__.core.invoke('load_system_font', { id }),
};
const compute: ComputeHost = {
  version: 1,
  async run(job, input) {
    const result = await window.__TAURI__.core.invoke<{ bytes: number[] } | null>('run_compute_job', { job, input: Array.from(input) });
    return result ? { bytes: Uint8Array.from(result.bytes), metadata: { native: true } } : null;
  },
};
const models: ModelHost = {
  version: 1,
  async resolveModel(request, progress, signal) {
    const cached = await window.__TAURI__.core.invoke<number[] | null>('read_cached_model', { id: request.id, sha256: request.sha256 });
    if (cached) return { bytes: Uint8Array.from(cached), cacheHit: true };
    if (!request.url || !request.userInitiated) return null;
    const response = await fetch(request.url, { signal });
    if (!response.ok) throw new Error(`Model download failed with HTTP ${response.status}.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    progress?.(bytes.byteLength, bytes.byteLength);
    if (sha256Hex(bytes) !== request.sha256) throw new Error('Downloaded model checksum does not match its manifest.');
    await window.__TAURI__.core.invoke<void>('write_cached_model', { id: request.id, sha256: request.sha256, bytes: Array.from(bytes) });
    return { bytes, cacheHit: false };
  },
};
const color: ColorHost = {
  version: 1,
  async displayProfile() {
    const profile = await window.__TAURI__.core.invoke<{ name: string; bytes: number[] | null; assumed: boolean }>('display_icc_profile');
    return { ...profile, bytes: profile.bytes ? Uint8Array.from(profile.bytes) : null };
  },
  async outputProfiles() {
    const profiles = await window.__TAURI__.core.invoke<{ name: string; bytes: number[] }[]>('list_output_profiles');
    return profiles.map((profile) => ({ name: profile.name, bytes: Uint8Array.from(profile.bytes) }));
  },
};

/** Screen eyedropper in Rust (X11 XGetImage, Windows GetPixel); WebView2 usually has the EyeDropper API first. */
const screenColor: ScreenColorHost = {
  version: 1,
  async pickScreenColor() {
    const rgb = await window.__TAURI__.core.invoke<[number, number, number] | null>('pick_screen_color');
    return rgb ? { red: rgb[0], green: rgb[1], blue: rgb[2] } : null;
  },
};

const isWindows = rawBackendFor(navigator.userAgent) === 'wic';
const rawPreferenceKey = 'fernwork.useSystemLibRaw';
const codecs: CodecHost = {
  version: 1,
  rawBackend: isWindows ? 'wic' : 'system-libraw',
  systemRawEnabled: () => isWindows || globalThis.localStorage?.getItem(rawPreferenceKey) === 'on',
  setSystemRawEnabled(enabled) { if (!isWindows) globalThis.localStorage?.setItem(rawPreferenceKey, enabled ? 'on' : 'off'); },
  decodeRaw(bytes, options) {
    const enabled = this.systemRawEnabled?.() ?? false;
    if (!isWindows && !enabled) return Promise.resolve(null);
    return invokeRawDecoder(window.__TAURI__.core.invoke, bytes, options, enabled, isWindows ? 'srgb' : 'linear-prophoto');
  },
};

/** Tauri implementation of the same optional capability registry as the browser host. */
export function createTauriHost(options: TauriHostOptions = {}): FileTargetHost {
  const acceptance = options.acceptanceArchivePath;
  const files = nativeFiles(acceptance);
  const constrained = webKitGtkMemoryBudgets(navigator.userAgent);
  const capabilities: HostCapabilityMap = { files, fonts, codecs, compute, models, color, screenColor };
  const host: FileTargetHost = {
    defaultProfile: 'pro', capabilities,
    scratchHost: new TauriScratchHost(),
    editorProfile: 'pro',
    ...({ tileBudgetBytes: options.tileBudgetBytes ?? constrained?.tileBudgetBytes,
      gpuTextureBudgetBytes: options.gpuTextureBudgetBytes ?? constrained?.gpuTextureBudgetBytes,
      gpuTextureChunkSize: options.gpuTextureChunkSize ?? constrained?.gpuTextureChunkSize,
      saveWithoutCompositorBarrier: !!constrained }),
    ...(options.controllerReady ? { controllerReady: options.controllerReady } : {}),
    async chooseImages() {
      const selected = await window.__TAURI__.dialog.open({ multiple: true, directory: false, filters: [IMAGE_FILTER] });
      return asFiles(typeof selected === 'string' ? [selected] : selected ?? []);
    },
    async chooseContent() {
      const selected = await window.__TAURI__.dialog.open({ multiple: false, directory: false, filters: [CONTENT_FILTER] });
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
      const filters = kind === 'project' ? [PROJECT_FILTER] : [SAVE_FILTERS[kind]];
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
      const target = await host.chooseSaveTarget?.(suggestedName, 'project');
      if (target) await host.saveFileTo?.(target, blob);
    },
    reportError(error) {
      if (options.reportError) options.reportError(error);
      else console.warn(`[Fernwork Bildeditor] ${error.code}: ${error.message}`);
    },
  };
  return bindCapabilityRegistry(host);
}
