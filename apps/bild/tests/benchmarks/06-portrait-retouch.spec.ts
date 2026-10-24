import { test } from '@playwright/test';
import { benchmark06 } from './scenarios';

test.use({ viewport: { width: 1440, height: 900 } });

test('portrait retouch, correction, and color lookup', async ({ page }) => benchmark06(page));
