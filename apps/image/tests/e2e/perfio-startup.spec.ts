import { expect, test } from '@playwright/test';

test('records startup work through the first idle window', async ({ page }) => {
  await page.addInitScript(() => {
    const record = { longTasks: [] as number[], gaps: [] as number[] };
    (window as any).__perfIoStartup = record;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) record.longTasks.push(entry.duration);
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* WebKit does not expose the Long Tasks API. */ }
    let previous = performance.now();
    const pulse = () => {
      const now = performance.now();
      record.gaps.push(now - previous);
      previous = now;
      setTimeout(pulse, 10);
    };
    setTimeout(pulse, 10);
  });
  const started = Date.now();
  await page.goto('/');
  await page.getByTestId('compositor-editor').waitFor();
  const interactiveMs = Date.now() - started;
  const immediate = await page.evaluate(() => performance.getEntriesByType('resource').length);
  await page.waitForTimeout(2_000);
  const result = await page.evaluate(({ interactiveMs, immediate }) => {
    const record = (window as any).__perfIoStartup as { longTasks: number[]; gaps: number[] };
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const wasm = resources.filter((entry) => /\.wasm(?:$|\?)/.test(entry.name));
    return {
      interactiveMs,
      resourcesImmediate: immediate,
      resourcesAfterIdle: resources.length,
      transferredAfterIdle: resources.reduce((sum, entry) => sum + entry.transferSize, 0),
      wasm: wasm.map((entry) => entry.name.split('/').at(-1)),
      longTasks: record.longTasks,
      maxTimerGapMs: Math.max(0, ...record.gaps),
    };
  }, { interactiveMs, immediate });
  console.info('PERFIO startup', JSON.stringify(result));
  expect(result.wasm).toEqual([]);
  expect(result.interactiveMs).toBeLessThan(10_000);
});
