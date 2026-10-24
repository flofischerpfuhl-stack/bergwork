import { test } from '@playwright/test';
import { benchmark20 } from './scenarios';

test.use({ viewport: { width: 1440, height: 900 } });

test('crash recovery with continuing undo history', async ({ page }) => benchmark20(page));
