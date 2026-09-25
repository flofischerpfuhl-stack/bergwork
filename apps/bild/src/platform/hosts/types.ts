import type { HostAdapter } from '../../../contracts';
import type { PdfPlacementHost } from '../../io/pdf';

export interface VersionedCapability { readonly version: number }

export interface HostFileReference {
  readonly name: string;
  /** Opaque to the engine; native hosts commonly use an absolute path. */
  readonly id: string;
}

export interface FileSaveTarget { readonly name: string }
/** `zip` holds several exported files (one export request with several targets or sizes). */
export type FileSaveKind = 'project' | 'png' | 'jpeg' | 'webp' | 'avif' | 'tiff' | 'zip';

/** Fallback: HostAdapter pickers/downloads remain usable when this capability is absent. */
export interface FileSystemHost extends VersionedCapability {
  readonly version: 1;
  chooseFiles(kind: 'images' | 'project' | 'content'): Promise<readonly HostFileReference[]>;
  chooseSaveTarget(suggestedName: string, kind: FileSaveKind): Promise<FileSaveTarget | null>;
  writeFile(target: FileSaveTarget, blob: Blob): Promise<void>;
  recentFiles(): Promise<readonly HostFileReference[]>;
  recordRecentFile(file: HostFileReference): Promise<void>;
  onOpenFiles(listener: (files: readonly HostFileReference[]) => void): () => void;
  readFile?(file: HostFileReference): Promise<Blob>;
  saveTargetFor?(file: HostFileReference): FileSaveTarget | null;
}

export interface SystemFont {
  readonly id: string;
  readonly family: string;
  readonly fullName?: string;
  readonly style: string;
  readonly postscriptName?: string;
}

/** Fallback: bundled OFL fonts only. */
export interface FontHost extends VersionedCapability {
  readonly version: 1;
  listSystemFonts(): Promise<readonly SystemFont[]>;
  loadSystemFont(id: string): Promise<Uint8Array>;
}

export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export interface HostDecodedImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
  readonly orientation?: ExifOrientation;
}

/** Fallback: browser and opt-in WASM codecs. */
export interface CodecHost extends VersionedCapability {
  readonly version: 1;
  decodeImage?(bytes: Uint8Array, mime: string): Promise<HostDecodedImage | null>;
  readonly heicDecoder?: 'lgpl-wasm';
}

export interface ComputeResult { readonly bytes: Uint8Array; readonly metadata?: Readonly<Record<string, string | number | boolean>> }
/** Fallback: the corresponding Worker/WASM implementation, if one exists. */
export interface ComputeHost extends VersionedCapability {
  readonly version: 1;
  run(job: string, input: Uint8Array, options?: Readonly<Record<string, string | number | boolean>>): Promise<ComputeResult | null>;
}

export interface ModelRequest {
  readonly id: string;
  readonly sha256: string;
  readonly url?: string;
  /** A remote URL may only be fetched in direct response to a user action. */
  readonly userInitiated: boolean;
}
export interface ResolvedModel { readonly bytes: Uint8Array; readonly cacheHit: boolean }
/** Fallback: unavailable. Callers must not fetch a remote model on their own. */
export interface ModelHost extends VersionedCapability {
  readonly version: 1;
  resolveModel(request: ModelRequest, progress?: (loaded: number, total: number | null) => void,
    signal?: AbortSignal): Promise<ResolvedModel | null>;
}

export interface DisplayColorProfile { readonly name: string; readonly bytes: Uint8Array | null; readonly assumed: boolean }
/** Fallback: assume an sRGB display. */
export interface ColorHost extends VersionedCapability {
  readonly version: 1;
  displayProfile(): Promise<DisplayColorProfile>;
}

/** 8-bit sRGB from the screen. */
export interface ScreenColor { readonly red: number; readonly green: number; readonly blue: number }
/**
 * Screen eyedropper outside the webview (PRODUCT-PLAN 6.1, A0). The next left click anywhere on the screen picks a
 * pixel; null when the user cancelled (right click, Escape, timeout). Rejects with `wayland-unsupported`,
 * `unsupported` or `busy` when this system cannot pick. Fallback: the browser EyeDropper API, then the canvas
 * eyedropper.
 */
export interface ScreenColorHost extends VersionedCapability {
  readonly version: 1;
  pickScreenColor(): Promise<ScreenColor | null>;
}

/** Scratch is structural so the concurrently-developed A4 interface can register without an import cycle. */
export interface ScratchCapability extends VersionedCapability { readonly version: number }

export interface HostCapabilityMap {
  readonly files?: FileSystemHost;
  readonly fonts?: FontHost;
  readonly codecs?: CodecHost;
  readonly compute?: ComputeHost;
  readonly models?: ModelHost;
  readonly color?: ColorHost;
  readonly scratch?: ScratchCapability;
  readonly screenColor?: ScreenColorHost;
  /** Optional lazy PDFium adapter; absent hosts expose PDF placement as unavailable. */
  readonly pdf?: PdfPlacementHost;
}

export interface CapabilityHost extends HostAdapter {
  readonly capabilities?: HostCapabilityMap;
  readonly defaultProfile?: 'pro' | 'lite';
  /** @deprecated URL override retained for embedders; ModelHost remains responsible for fetching and caching. */
  readonly subjectModelUrls?: Readonly<{ fast?: string; best?: string }>;
}

export type CapabilityName = keyof HostCapabilityMap;
export type CapabilityFor<K extends CapabilityName> = NonNullable<HostCapabilityMap[K]>;

const capabilityOwners = new WeakMap<object, HostAdapter>();

/** Binds stateful capabilities to their adapter so cloning/wrapping an adapter cannot leak native handles. */
export function bindCapabilityRegistry<T extends CapabilityHost>(host: T): T {
  for (const capability of Object.values(host.capabilities ?? {})) {
    if (capability && typeof capability === 'object') capabilityOwners.set(capability, host);
  }
  return host;
}

export function getCapability<K extends CapabilityName>(host: HostAdapter | HostCapabilityMap, name: K,
  minimumVersion = 1): CapabilityFor<K> | null {
  const registry = 'chooseImages' in host ? (host as CapabilityHost).capabilities : host;
  const value = registry?.[name] as CapabilityFor<K> | undefined;
  return value && value.version >= minimumVersion ? value : null;
}

export function hasCapability<K extends CapabilityName>(host: HostAdapter | HostCapabilityMap, name: K,
  minimumVersion = 1): boolean {
  return getCapability(host, name, minimumVersion) !== null;
}

export function capabilitiesOf(host: HostAdapter): HostCapabilityMap {
  const declared = (host as CapabilityHost).capabilities ?? {};
  // Compatibility for pre-A0 hosts. New controller code still consumes the registry only.
  const legacy = host as HostAdapter & {
    chooseSaveTarget?: FileSystemHost['chooseSaveTarget']; saveFileTo?: FileSystemHost['writeFile'];
    decodeImage?: CodecHost['decodeImage']; heicDecoder?: CodecHost['heicDecoder'];
    subjectModelUrls?: CapabilityHost['subjectModelUrls'];
  };
  const declaredFiles = declared.files && (!capabilityOwners.has(declared.files) || capabilityOwners.get(declared.files) === host)
    ? declared.files : undefined;
  const files = declaredFiles ?? (legacy.chooseSaveTarget && legacy.saveFileTo ? {
    version: 1 as const,
    async chooseFiles() { return []; },
    chooseSaveTarget: legacy.chooseSaveTarget.bind(host), writeFile: legacy.saveFileTo.bind(host),
    async recentFiles() { return []; }, async recordRecentFile() {}, onOpenFiles() { return () => {}; },
  } : undefined);
  const codecs = declared.codecs ?? (legacy.decodeImage || legacy.heicDecoder ? {
    version: 1 as const, decodeImage: legacy.decodeImage?.bind(host), heicDecoder: legacy.heicDecoder,
  } : undefined);
  const models = declared.models ? {
    version: declared.models.version,
    resolveModel(request: ModelRequest, progress?: Parameters<ModelHost['resolveModel']>[1], signal?: AbortSignal) {
      const modelUrls = legacy.subjectModelUrls;
      const override = modelUrls?.[request.id === 'u2netp' ? 'fast' : 'best'];
      return declared.models!.resolveModel(override ? { ...request, url: override } : request, progress, signal);
    },
  } satisfies ModelHost : declared.models;
  return { ...declared, files, codecs, models };
}
