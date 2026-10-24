import { test } from '@playwright/test';
import { benchmark05 } from './scenarios';

test.use({ viewport: { width: 1440, height: 900 } });

test('editable client PSD round-trip', async ({ page }) => benchmark05(page));
