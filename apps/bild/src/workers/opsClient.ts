/**
 * Runs document operations off the main thread. A request that is superseded or whose editor was
 * destroyed resolves but is never applied by callers; the pure functions cannot be interrupted
 * mid-way, so cancellation discards results instead.
 */

import type { OpsRequest, OpsResponse } from './opsProtocol';
import { runOp } from './opsRun';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (response: OpsResponse) => void>();

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./opsWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<OpsResponse>) => {
      const resolve = pending.get(event.data.id);
      pending.delete(event.data.id);
      resolve?.(event.data);
    };
    worker.onerror = () => {
      for (const [id, resolve] of pending) resolve({ id, ok: false, error: 'The background worker stopped unexpectedly.' });
      pending.clear();
      worker = null;
    };
    return worker;
  } catch { return null; }
}

export function runInWorker(request: OpsRequest): Promise<OpsResponse> {
  const id = nextId++;
  const target = ensureWorker();
  if (!target) return Promise.resolve(runOp(request, id));
  return new Promise((resolve) => {
    pending.set(id, resolve);
    target.postMessage({ id, request });
  });
}
