import { expect, test } from '@playwright/test';
import type { MatrixResult } from './matrix';

test('A1 WebView matrix uses the real editor scenario', async ({ page }) => {
  test.setTimeout(900_000);
  await page.goto('/tests/webview/index.html');
  await expect(page).toHaveTitle(/complete/, { timeout: 850_000 });
  const text = await page.locator('#matrix-result').textContent();
  const result = JSON.parse(text ?? '') as MatrixResult;
  console.log(`FERNWORK_MATRIX_RESULT=${JSON.stringify(result)}`);
  expect(result.capabilities.webgl2).toBe(true);
  expect(result.capabilities.maxTextureSize).toBeGreaterThan(0);
  expect(result.jpeg46MP.width).toBe(10_109);
  expect(result.jpeg46MP.height).toBe(4_542);
  expect(result.jpeg46MP.error).toBeUndefined();
  expect(result.performance.panMs.p95).toBeGreaterThan(0);
  expect(result.performance.brushFeedbackMs.p95).toBeGreaterThan(0);
});
