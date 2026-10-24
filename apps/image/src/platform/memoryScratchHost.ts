import { requireScratchKey, type ScratchHost } from './scratchHost';

/** Deterministic ScratchHost for engine tests and non-persistent embeddings. */
export class MemoryScratchHost implements ScratchHost {
  readonly kind = 'memory' as const;
  private readonly values = new Map<string, Uint8Array>();
  flushCount = 0;

  async read(key: string): Promise<Uint8Array | null> {
    requireScratchKey(key);
    return this.values.get(key)?.slice() ?? null;
  }

  async write(key: string, bytes: Uint8Array, options: { append?: boolean } = {}): Promise<void> {
    requireScratchKey(key);
    const old = options.append ? this.values.get(key) : undefined;
    if (!old) { this.values.set(key, bytes.slice()); return; }
    const joined = new Uint8Array(old.byteLength + bytes.byteLength);
    joined.set(old);
    joined.set(bytes, old.byteLength);
    this.values.set(key, joined);
  }

  async remove(key: string): Promise<void> { requireScratchKey(key); this.values.delete(key); }
  async list(prefix = ''): Promise<readonly string[]> {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
  async flush(): Promise<void> { this.flushCount++; }
  async close(): Promise<void> { /* nothing to release */ }
}
