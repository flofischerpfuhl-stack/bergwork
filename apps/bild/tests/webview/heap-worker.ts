interface HeapRequest { readonly ceilingMB: number }

self.onmessage = (event: MessageEvent<HeapRequest>) => {
  const blocks: number[][] = [];
  let allocatedMB = 0;
  try {
    while (allocatedMB < event.data.ceilingMB) {
      const block = new Array<number>(1024 * 1024);
      for (let i = 0; i < block.length; i += 1024) block[i] = i + allocatedMB;
      blocks.push(block);
      allocatedMB += 8;
      if (allocatedMB % 128 === 0) self.postMessage({ progressMB: allocatedMB });
    }
    self.postMessage({ allocatedMB, failed: false, ceilingMB: event.data.ceilingMB });
  } catch (error) {
    self.postMessage({ allocatedMB, failed: true, ceilingMB: event.data.ceilingMB, error: String(error) });
  }
};

export {};
