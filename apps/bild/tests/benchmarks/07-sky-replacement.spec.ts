import { test } from '@playwright/test';
import { benchmark07 } from './scenarios';

test.use({ viewport: { width: 1440, height: 900 } });

test('sky replacement with refined object selection', async ({ page }) => benchmark07(page));
