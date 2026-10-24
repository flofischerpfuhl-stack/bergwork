import { expect, test } from '@playwright/test';
import { mountForTest } from './helpers';

test('large PNG Export As writes ordered chunks through FileByteSink', async ({ page }) => {
  await mountForTest(page, { fileTargets: true });
  await page.getByTestId('widthInput').fill('1024');
  await page.getByTestId('heightInput').fill('1024');
  await page.getByTestId('createCanvas').click();
  const result = await page.evaluate(async () => {
    const w = window as any, controller = w.__editorForTests;
    const chunks: Uint8Array[] = [];
    let closed = false, aborted = false;
    controller.host.openFileSink = async () => ({
      async write(chunk: Uint8Array) { chunks.push(chunk.slice()); },
      async close() { closed = true; },
      async abort() { aborted = true; },
    });
    const saved = await controller.exportWith(controller.exportRequest('png'));
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0), bytes = new Uint8Array(length);
    let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const load = (module: string): Promise<any> => import(/* @vite-ignore */ module);
    const { decodePng } = await load('/src/io/png.ts');
    const decoded = decodePng(bytes);
    return { saved, closed, aborted, chunks: chunks.length, width: decoded.width, height: decoded.height,
      bytes: length, nonzero: decoded.data.some((value: number) => value !== 0), writes: w.__targetWrites };
  });
  expect(result).toMatchObject({ saved: true, closed: true, aborted: false, width: 1024, height: 1024, nonzero: false });
  expect(result.chunks).toBeGreaterThan(3);
  expect(result.bytes).toBeGreaterThan(100);
  expect(result.writes.map((write: { op: string }) => write.op)).toEqual(['as']);
});
