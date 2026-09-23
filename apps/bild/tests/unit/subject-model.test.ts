import { describe, expect, it } from 'vitest';
import { ModelDownloadError, downloadSubjectModel } from '../../src/core/subject/modelCache';
import type { SubjectModelSpec } from '../../src/core/subject/models';
import { sha256Hex } from '../../src/io/sha256';

class MemoryCache {
  readonly values = new Map<string, Response>();
  async match(key: RequestInfo | URL): Promise<Response | undefined> {
    return this.values.get(cacheKey(key))?.clone();
  }
  async put(key: RequestInfo | URL, response: Response): Promise<void> {
    this.values.set(cacheKey(key), response.clone());
  }
  async delete(key: RequestInfo | URL): Promise<boolean> { return this.values.delete(cacheKey(key)); }
}

function cacheKey(value: RequestInfo | URL): string {
  return typeof value === 'string' ? value : value instanceof URL ? value.href : value.url;
}

describe('best-quality model download cache', () => {
  it('persists an interrupted prefix, resumes with Range, verifies SHA-256, then serves the cache', async () => {
    const expected = Uint8Array.from([1, 2, 3, 4]);
    const spec: SubjectModelSpec = {
      kind: 'best', inputSize: 1024, byteLength: expected.byteLength,
      sha256: sha256Hex(expected), defaultUrl: 'https://models.example/best.onnx',
    };
    const cache = new MemoryCache();
    const storage = { open: async () => cache } as unknown as CacheStorage;
    let calls = 0;
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls++;
      if (calls === 1) {
        let sent = false;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) { sent = true; controller.enqueue(expected.slice(0, 2)); }
            else controller.error(new Error('offline'));
          },
        });
        return new Response(body, { headers: { 'content-length': '4' } });
      }
      expect(new Headers(init?.headers).get('range')).toBe('bytes=2-');
      return new Response(expected.slice(2).buffer, { status: 206,
        headers: { 'content-range': 'bytes 2-3/4', 'content-length': '2' } });
    }) as typeof fetch;

    await expect(downloadSubjectModel(spec, spec.defaultUrl, () => {}, undefined,
      { cacheStorage: storage, fetcher })).rejects.toMatchObject({
        name: 'ModelDownloadError', downloadedBytes: 2, totalBytes: 4, resumable: true,
      } satisfies Partial<ModelDownloadError>);
    const progress: number[] = [];
    const resumed = await downloadSubjectModel(spec, spec.defaultUrl,
      ({ downloadedBytes }) => progress.push(downloadedBytes), undefined, { cacheStorage: storage, fetcher });
    expect(resumed.bytes).toEqual(expected);
    expect(resumed.cacheHit).toBe(false);
    expect(progress).toContain(2);

    const cached = await downloadSubjectModel(spec, spec.defaultUrl, () => {
      // Cached reads still report a completed byte count for deterministic host progress.
    }, undefined, { cacheStorage: storage, fetcher });
    expect(cached).toMatchObject({ cacheHit: true });
    expect(calls).toBe(2);
  });
});
