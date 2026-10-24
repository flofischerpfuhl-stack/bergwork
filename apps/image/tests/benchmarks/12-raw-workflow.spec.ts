import { test } from '@playwright/test';
import { benchmark12 } from './scenarios';

test.use({ viewport: { width: 1440, height: 900 } });

test('RAW correction and 16-bit TIFF export', async ({ page }) => benchmark12(page));
