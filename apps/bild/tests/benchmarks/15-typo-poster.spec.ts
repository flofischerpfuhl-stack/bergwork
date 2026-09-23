import { test } from '@playwright/test';
import { benchmark15 } from './scenarios';

test.use({ viewport: { width: 1440, height: 900 } });

test('variable-font typography poster', async ({ page }) => benchmark15(page));
