import { sha256Hex } from '../../io/sha256';
import type { SubjectModelSpec } from './models';

const CACHE_NAME = 'compositor-subject-models-v1';
const CACHE_ORIGIN = 'https://compositor-model-cache.invalid';

export interface ModelDownloadProgress {
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
  readonly resumedBytes: number;
}

export interface DownloadedModel {
  readonly bytes: Uint8Array;
  readonly cacheHit: boolean;
  readonly downloadMs: number;
}

export class ModelDownloadError extends Error {
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
  readonly resumable: boolean;

  constructor(message: string, downloadedBytes: number, totalBytes: number | null, resumable: boolean,
    options?: ErrorOptions) {
    super(message, options);
    this.name = 'ModelDownloadError';
    this.downloadedBytes = downloadedBytes;
    this.totalBytes = totalBytes;
    this.resumable = resumable;
  }
}

interface DownloadDependencies {
  readonly cacheStorage?: CacheStorage | null;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
}

/**
 * Downloads an immutable model with byte progress and a persistent partial entry. A retry asks for
 * the remaining Range and joins it to the saved prefix; servers that ignore Range restart safely.
 */
export async function downloadSubjectModel(spec: SubjectModelSpec, url: string,
  report: (progress: ModelDownloadProgress) => void, signal?: AbortSignal,
  dependencies: DownloadDependencies = {}): Promise<DownloadedModel> {
  const started = (dependencies.now ?? performance.now.bind(performance))();
  const storage = dependencies.cacheStorage === undefined
    ? (typeof caches === 'undefined' ? null : caches) : dependencies.cacheStorage;
  const fetcher = dependencies.fetcher ?? fetch;
  const cache = await openCache(storage);
  const fullKey = `${CACHE_ORIGIN}/${spec.sha256}.onnx`;
  const partialKey = `${CACHE_ORIGIN}/${spec.sha256}.partial`;

  const cached = await cache?.match(fullKey);
  if (cached) {
    const bytes = new Uint8Array(await cached.arrayBuffer());
    if (validModel(bytes, spec)) {
      report({ downloadedBytes: bytes.byteLength, totalBytes: bytes.byteLength, resumedBytes: bytes.byteLength });
      return { bytes, cacheHit: true, downloadMs: elapsed(started, dependencies.now) };
    }
    if (cache) await ignoreCacheFailure(cache.delete(fullKey));
  }

  let prefix = new Uint8Array(0);
  const saved = await cache?.match(partialKey);
  if (saved?.headers.get('x-compositor-source-url') === url) prefix = new Uint8Array(await saved.arrayBuffer());
  if (prefix.byteLength >= spec.byteLength) {
    prefix = new Uint8Array(0);
    if (cache) await ignoreCacheFailure(cache.delete(partialKey));
  }

  const resumedBytes = prefix.byteLength;
  report({ downloadedBytes: resumedBytes, totalBytes: spec.byteLength, resumedBytes });
  let response: Response;
  try {
    response = await fetcher(url, {
      signal,
      headers: resumedBytes > 0 ? { Range: `bytes=${resumedBytes}-` } : undefined,
    });
  } catch (error) {
    throw downloadFailure(error, resumedBytes, spec.byteLength, resumedBytes > 0);
  }
  if (!response.ok) {
    throw new ModelDownloadError(`Subject model download failed with HTTP ${response.status}.`, resumedBytes,
      responseTotal(response, resumedBytes, spec.byteLength), resumedBytes > 0);
  }

  const acceptedResume = resumedBytes > 0 && response.status === 206
    && contentRangeStart(response.headers.get('content-range')) === resumedBytes;
  if (resumedBytes > 0 && !acceptedResume) prefix = new Uint8Array(0);
  const base = prefix.byteLength;
  const total = responseTotal(response, base, spec.byteLength);
  const chunks: Uint8Array[] = prefix.byteLength ? [prefix] : [];
  let received = base;
  try {
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
        received += next.value.byteLength;
        report({ downloadedBytes: received, totalBytes: total, resumedBytes: base });
      }
    } else {
      const value = new Uint8Array(await response.arrayBuffer());
      chunks.push(value); received += value.byteLength;
      report({ downloadedBytes: received, totalBytes: total, resumedBytes: base });
    }
  } catch (error) {
    const partial = joinChunks(chunks, received);
    const resumable = await savePartial(cache, partialKey, url, partial);
    if (isAbort(error) || signal?.aborted) throw abortError();
    throw downloadFailure(error, received, total, resumable);
  }

  const bytes = joinChunks(chunks, received);
  const actual = bytes.byteLength === spec.byteLength ? sha256Hex(bytes) : 'not computed (wrong size)';
  if (bytes.byteLength !== spec.byteLength || actual !== spec.sha256) {
    if (cache) await ignoreCacheFailure(cache.delete(partialKey));
    throw new ModelDownloadError(
      `Subject model verification failed (expected ${spec.byteLength} bytes / ${spec.sha256}, got ${bytes.byteLength} bytes / ${actual}).`,
      bytes.byteLength, total, false);
  }
  if (cache) {
    await ignoreCacheFailure(cache.put(fullKey, new Response(bodyBuffer(bytes), { headers: {
      'content-type': 'application/octet-stream', 'x-compositor-source-url': url,
    } })));
    await ignoreCacheFailure(cache.delete(partialKey));
  }
  report({ downloadedBytes: bytes.byteLength, totalBytes: bytes.byteLength, resumedBytes: base });
  return { bytes, cacheHit: false, downloadMs: elapsed(started, dependencies.now) };
}

function validModel(bytes: Uint8Array, spec: SubjectModelSpec): boolean {
  return bytes.byteLength === spec.byteLength && sha256Hex(bytes) === spec.sha256;
}

async function openCache(storage: CacheStorage | null): Promise<Cache | null> {
  if (!storage) return null;
  try { return await storage.open(CACHE_NAME); } catch { return null; }
}

async function savePartial(cache: Cache | null, key: string, url: string, bytes: Uint8Array): Promise<boolean> {
  if (!cache || bytes.byteLength === 0) return false;
  try {
    await cache.put(key, new Response(bodyBuffer(bytes), { headers: {
      'content-type': 'application/octet-stream', 'x-compositor-source-url': url,
    } }));
    return true;
  } catch { return false; }
}

function joinChunks(chunks: readonly Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]?.byteLength === length) return chunks[0];
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function responseTotal(response: Response, offset: number, fallback: number): number | null {
  const range = response.headers.get('content-range')?.match(/\/([0-9]+)$/);
  if (range?.[1]) return Number(range[1]);
  const header = response.headers.get('content-length');
  const length = header === null ? NaN : Number(header);
  return Number.isFinite(length) && length >= 0 ? offset + length : fallback || null;
}

function contentRangeStart(value: string | null): number | null {
  const match = value?.match(/^bytes ([0-9]+)-/);
  return match?.[1] ? Number(match[1]) : null;
}

function downloadFailure(error: unknown, received: number, total: number | null, resumable: boolean): Error {
  if (isAbort(error)) return abortError();
  const amount = total === null ? `${received} bytes` : `${received} of ${total} bytes`;
  const retry = resumable ? ' Retry to resume the download.' : ' Retry to download it again.';
  return new ModelDownloadError(`Subject model download stopped after ${amount}.${retry}`, received, total, resumable,
    { cause: error });
}

function abortError(): DOMException {
  return new DOMException('Background removal was cancelled.', 'AbortError');
}
function bodyBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
function isAbort(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError'; }
function elapsed(started: number, now?: () => number): number { return (now ?? performance.now.bind(performance))() - started; }
async function ignoreCacheFailure(operation: Promise<unknown>): Promise<void> { try { await operation; } catch { /* cache is optional */ } }
