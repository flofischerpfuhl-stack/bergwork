import { test } from '@playwright/test';
import { benchmark13 } from './scenarios';

test.use({ viewport: { width: 1440, height: 900 } });

test('200 MP, 30-layer poster persistence', async ({ page }) => benchmark13(page));
