import { test } from '@playwright/test';
import { benchmark09 } from './scenarios';

test.use({ viewport: { width: 1440, height: 900 } });

test('five-format artboard banner set', async ({ page }) => benchmark09(page));
