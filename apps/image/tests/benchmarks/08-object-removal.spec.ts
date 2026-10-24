import { test } from '@playwright/test';
import { benchmark08 } from './scenarios';

test.use({ viewport: { width: 1440, height: 900 } });

test('content-aware object removal', async ({ page }) => benchmark08(page));
