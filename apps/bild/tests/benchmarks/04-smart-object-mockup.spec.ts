import { test } from '@playwright/test';
import { benchmark04 } from './scenarios';

test.use({ viewport: { width: 1440, height: 900 } });

test('PSD mockup Smart Object replacement', async ({ page }) => benchmark04(page));
