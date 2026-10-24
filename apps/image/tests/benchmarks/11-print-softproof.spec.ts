import { test } from '@playwright/test';
import { benchmark11 } from './scenarios';

test.use({ viewport: { width: 1440, height: 900 } });

test('AdobeRGB print image, CMYK soft-proof, and TIFF export', async ({ page }) => benchmark11(page));
