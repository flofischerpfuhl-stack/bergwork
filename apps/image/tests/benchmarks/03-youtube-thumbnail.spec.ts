import { test } from '@playwright/test';
import { benchmark03 } from './scenarios';

test.use({ viewport: { width: 1440, height: 900 } });

test('YouTube thumbnail with extracted subject and effects', async ({ page }) => benchmark03(page));
