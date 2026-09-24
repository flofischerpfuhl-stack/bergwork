import type { FileTargetHost, SaveTarget } from '../../src/platform/browserHost';
import { sha256Hex } from '../../src/io/sha256';
import type { ColorHost, ComputeHost, FileSystemHost, FontHost, HostCapabilityMap, HostFileReference, ModelHost } from '../../src/platform/hosts';
import { bindCapabilityRegistry } from '../../src/platform/hosts';

interface NativeTarget extends SaveTarget { readonly path: string }
const IMAGE_FILTER = { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'heic', 'heif', 'psd'] };
const PROJECT_FILTER = { name: 'Fernwork image project', extensions: ['fwimg', 'zip'] };
const baseName = (path: string) => path.split(/[\\/]/).at(-1) || path;
const ownedBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);
async function asFiles(paths: readonly string[]): Promise<File[]> {
  return Promise.all(paths.map(async (path) => new File([ownedBytes(await window.__TAURI__.fs.readFile(path))], baseName(path))));
}
async function write(path: string, blob: Blob): Promise<void> {
  await window.__TAURI__.fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
}

function nativeFiles(): FileSystemHost {
  const files: FileSystemHost = {
    version: 1,
    async chooseFiles(kind) {
      const selected = await window.__TAURI__.dialog.open({ multiple: kind === 'images', directory: false,
        filters: kind === 'project' ? [PROJECT_FILTER] : [IMAGE_FILTER] });
      const paths = typeof selected === 'string' ? [selected] : selected ?? [];
      return paths.map((id) => ({ id, name: baseName(id) }));
    },
    async chooseSaveTarget(suggestedName, kind) {
      const filters = kind === 'project' ? [PROJECT_FILTER]
        : [{ name: kind === 'png' ? 'PNG image' : 'JPEG image', extensions: kind === 'png' ? ['png'] : ['jpg', 'jpeg'] }];
      const path = await window.__TAURI__.dialog.save({ defaultPath: suggestedName, filters });
      return path ? { name: baseName(path), path } as NativeTarget : null;
    },
    async writeFile(target, blob) { await write((target as NativeTarget).path, blob); },
    recentFiles: () => window.__TAURI__.core.invoke<HostFileReference[]>('recent_files'),
    recordRecentFile: (file) => window.__TAURI__.core.invoke<void>('record_recent_file', { file }),
    async readFile(file) { return new Blob([ownedBytes(await window.__TAURI__.fs.readFile(file.id))]); },
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
};

/** Tauri implementation of the same optional capability registry as the browser host. */
export function createTauriHost(): FileTargetHost {
  const files = nativeFiles();
  const capabilities: HostCapabilityMap = { files, fonts, codecs: { version: 1 }, compute, models, color };
  const host: FileTargetHost = {
    defaultProfile: 'pro', capabilities,
    async chooseImages() {
      const selected = await window.__TAURI__.dialog.open({ multiple: true, directory: false, filters: [IMAGE_FILTER] });
      return asFiles(typeof selected === 'string' ? [selected] : selected ?? []);
    },
    async chooseProject() {
      const selected = await window.__TAURI__.dialog.open({ multiple: false, directory: false, filters: [PROJECT_FILTER] });
      if (typeof selected !== 'string') return null;
      return (await asFiles([selected]))[0] ?? null;
    },
    chooseSaveTarget: files.chooseSaveTarget.bind(files),
    saveFileTo: files.writeFile.bind(files),
    async saveFile(blob, suggestedName) {
      const target = await files.chooseSaveTarget(suggestedName, 'project');
      if (target) await files.writeFile(target, blob);
    },
    reportError(error) { console.warn(`[Fernwork Bildeditor] ${error.code}: ${error.message}`); },
  };
  return bindCapabilityRegistry(host);
}
