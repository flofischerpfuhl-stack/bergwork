import { test } from '@playwright/test';
import { benchmark14 } from './scenarios';

test.use({ viewport: { width: 1440, height: 900 } });

test('50-image recipe and batch export', async ({ page }) => benchmark14(page));
