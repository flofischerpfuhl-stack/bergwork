/** Durable byte storage used for decoded tile spill and crash journals. */
export interface ScratchHost {
  readonly kind: 'memory' | 'opfs' | 'indexeddb' | 'tauri';
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, bytes: Uint8Array, options?: { append?: boolean }): Promise<void>;
  remove(key: string): Promise<void>;
  list(prefix?: string): Promise<readonly string[]>;
  /** Makes all writes issued before this call durable. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** Optional A0 host capability. Presence enables the Pro document limits. */
export interface ScratchHostCapability {
  readonly scratchHost: ScratchHost;
  readonly editorProfile?: 'lite' | 'pro';
  /** Optional deployment override; defaults remain 1.5 GiB Lite / 4 GiB Pro. */
  readonly tileBudgetBytes?: number;
  /** Separate WebGL texture cap. Defaults to one quarter of the tile budget, at most 1 GiB. */
  readonly gpuTextureBudgetBytes?: number;
}

export const LITE_TILE_BUDGET = 1536 * 1024 * 1024;
export const PRO_TILE_BUDGET = 4 * 1024 * 1024 * 1024;
export const PRO_MAX_SIDE = 60_000;
export const PRO_MAX_PIXELS = 300_000_000;

export function validScratchKey(key: string): boolean {
  return key.length > 0 && key.length <= 512 && !key.startsWith('/') && !key.includes('\\')
    && key.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
    && !/[\u0000-\u001f]/.test(key);
}

export function requireScratchKey(key: string): void {
  if (!validScratchKey(key)) throw new RangeError('Invalid scratch key');
}
