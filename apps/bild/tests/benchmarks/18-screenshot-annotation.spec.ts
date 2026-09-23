import { test } from '@playwright/test';
import { benchmark18 } from './scenarios';

test.use({ viewport: { width: 1440, height: 900 } });

test('screenshot instructions with blur and annotations', async ({ page }) => benchmark18(page));
