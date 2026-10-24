import { test } from '@playwright/test';
import { benchmark02 } from './scenarios';

test.use({ viewport: { width: 1440, height: 900 } });

test('campaign key visual with four artboards', async ({ page }) => benchmark02(page));
