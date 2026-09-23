import { test } from '@playwright/test';
import { benchmark16 } from './scenarios';

test.use({ viewport: { width: 1440, height: 900 } });

test('packaging mockup mesh warp', async ({ page }) => benchmark16(page));
