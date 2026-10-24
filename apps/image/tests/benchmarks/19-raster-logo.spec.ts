import { test } from '@playwright/test';
import { benchmark19 } from './scenarios';

test.use({ viewport: { width: 1440, height: 900 } });

test('transparent raster logo with contour', async ({ page }) => benchmark19(page));
