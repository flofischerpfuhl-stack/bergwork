import { expect, test } from '@playwright/test';
import { mountForTest } from './helpers';

test('every lazy feature module loads without a feature-load-failed report', async ({ page }) => {
  await mountForTest(page);
  const result = await page.evaluate(async () => {
    const w = window as any;
    await w.__editorForTests.loadAllFeatures();
    const controller = w.__editorForTests;
    return {
      errors: w.__errors.filter((error: { code?: string }) => error.code === 'feature-load-failed'),
      tools: ['artboard', 'marquee', 'brush', 'spotHealing', 'objectSelect']
        .filter((tool) => controller.availableTools.has(tool)),
      commands: ['canvasSize', 'selectAll', 'contentAwareFill', 'levels', 'removeBackground', 'toggleRulers',
        'placeEmbedded', 'quickMask'].filter((command) => typeof controller.features[command]?.run === 'function'),
      panels: controller.sidePanels.map((panel: { id: string }) => panel.id),
    };
  });
  expect(result.errors).toEqual([]);
  expect(result.tools).toEqual(['artboard', 'marquee', 'brush', 'spotHealing', 'objectSelect']);
  expect(result.commands).toEqual(['canvasSize', 'selectAll', 'contentAwareFill', 'levels', 'removeBackground', 'toggleRulers',
    'placeEmbedded', 'quickMask']);
  expect(result.panels).toContain('color');
});

test('a live lazy-module import failure identifies its feature', async ({ page }) => {
  await page.route('**/src/app/layerStylesFeature.tsx', (route) => route.abort('failed'));
  await mountForTest(page);
  await page.evaluate(async () => { await (window as any).__editorForTests.loadAllFeatures(); });
  const errors = await page.evaluate(() => (window as any).__errors
    .filter((error: { code?: string }) => error.code === 'feature-load-failed'));
  expect(errors).toEqual([{ code: 'feature-load-failed', message: expect.stringMatching(/^styles: /) }]);
});
