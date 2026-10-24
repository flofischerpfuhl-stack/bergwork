/// <reference lib="webworker" />
import { runOp } from './opsRun';
import type { OpsRequest } from './opsProtocol';

self.onmessage = (event: MessageEvent<{ id: number; request: OpsRequest }>) => {
  const response = runOp(event.data.request, event.data.id);
  (self as unknown as Worker).postMessage(response);
};
