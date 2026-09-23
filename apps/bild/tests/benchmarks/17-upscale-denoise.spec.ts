import { test } from '@playwright/test';
import { benchmark17 } from './scenarios';

test.use({ viewport: { width: 1440, height: 900 } });

test('old-photo upscale and denoise', async ({ page }) => benchmark17(page));
