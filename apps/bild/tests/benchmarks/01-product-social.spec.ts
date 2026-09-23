import { test } from '@playwright/test';
import { benchmark01 } from './scenarios';

test.use({ viewport: { width: 1440, height: 900 } });

test('product cutout, shadow, and three social exports', async ({ page }) => benchmark01(page));
