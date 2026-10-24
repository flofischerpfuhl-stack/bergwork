import { expect, test, type Browser, type Page } from '@playwright/test';
import { exportedPixels, importThroughMenu, mountForTest, solidPng } from './helpers';

async function workflow(page: Page): Promise<{ renderer: string; pixels: Awaited<ReturnType<typeof exportedPixels>> }> {
  await mountForTest(page);
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.canvasView.rendererKind)).not.toBe('none');
  await page.getByTestId('widthInput').fill('96');
  await page.getByTestId('heightInput').fill('64');
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'orange.png', mimeType: 'image/png', buffer: solidPng(24, 20, [220, 90, 30, 255]) }]);
  await expect(page.getByTestId('layerCount')).toHaveText('2');

  // Move through the same session command used by keyboard nudging.
  await page.evaluate(() => (window as any).__editorForTests.session.nudgeLayer(7, 3));

  // Exercise the exact CPU stroke replay used by the fallback while a recorded GPU stroke would
  // normally provide the live preview. Waiting includes the background commit.
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const brush = await load('/src/core/brush/index.ts');
    const session = (window as any).__editorForTests.session;
    session.selectTool('brush');
    const settings = { ...brush.DEFAULT_BRUSH_SETTINGS, diameter: 9, hardness: .25,
      red: 0, green: 0.4, blue: 1, opacity: .8 };
    brush.beginBrushStroke(session, { x: 47, y: 32 }, { settings });
    for (const x of [51, 55, 59, 63, 67]) brush.extendBrushStroke(session, { x, y: 32 });
    brush.finishBrushStroke(session);
    await brush.waitForBrushStroke(session);
  });

  // A live adjustment layer must be handled by applyAdjustment in the software compositor.
  await page.getByTestId('menu-Layer').click();
  await page.getByRole('menuitem', { name: 'New Adjustment Layer' }).hover();
  await page.getByRole('menuitem', { name: 'Hue/Saturation…' }).click();
  await page.getByTestId('hueSaturation').fill('-45');
  await page.getByTestId('adjustment-ok').click();
  await expect(page.getByTestId('adjustment-panel')).toHaveCount(0);
  const renderer = await page.evaluate(() => (window as any).__editorForTests.canvasView.rendererKind);
  return { renderer, pixels: await exportedPixels(page) };
}

async function pages(browser: Browser): Promise<{ gpu: Page; software: Page; close(): Promise<void> }> {
  const gpuContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const softwareContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await softwareContext.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (type === 'webgl2') return null;
      return Reflect.apply(original, this, [type, ...args]);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  return {
    gpu: await gpuContext.newPage(), software: await softwareContext.newPage(),
    async close() { await softwareContext.close(); await gpuContext.close(); },
  };
}

test('forced software fallback completes edit/export workflow and matches WebGL', async ({ browser }) => {
  const pair = await pages(browser);
  try {
    const [gpu, software] = await Promise.all([workflow(pair.gpu), workflow(pair.software)]);
    expect(gpu.renderer).toBe('webgl2');
    expect(software.renderer).toBe('software');
    expect(software.pixels.width).toBe(gpu.pixels.width);
    expect(software.pixels.height).toBe(gpu.pixels.height);
    let sum = 0, compared = 0, over3 = 0;
    for (let i = 0; i < gpu.pixels.data.length; i++) {
      const pixel = i - i % 4;
      if (gpu.pixels.data[pixel + 3] === 0 && software.pixels.data[pixel + 3] === 0) continue;
      const difference = Math.abs(gpu.pixels.data[i]! - software.pixels.data[i]!);
      if (difference > 3) over3++;
      sum += difference; compared++;
    }
    // Match the repository's GPU-vs-CPU tolerance: straight colours at almost-transparent soft
    // brush edges can amplify one premultiplied-byte rounding difference.
    expect(over3 / compared).toBeLessThan(.001);
    expect(sum / compared).toBeLessThan(.25);
  } finally {
    await pair.close();
  }
});
