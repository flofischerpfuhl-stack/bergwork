import { test } from '@playwright/test';
import { benchmark10 } from './scenarios';

test.use({ viewport: { width: 1440, height: 900 } });

test('vector icon with boolean operations and multi-scale export', async ({ page }) => benchmark10(page));
