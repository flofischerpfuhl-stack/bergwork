import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1100, height: 760 } });

async function mountPro(page: Page): Promise<void> {
  await page.goto('/?harness=cmyk');
  await page.evaluate(async () => {
    document.body.style.cssText = 'margin:0;width:100vw;height:100vh;overflow:hidden';
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const [{ mountEditor }, { createBrowserHost }, { Raster }] = await Promise.all([
      load('/src/index.ts'), load('/src/platform/browserHost.ts'), load('/src/core/raster.ts'),
    ]);
    const w = window as any; w.__errors = [];
    const host = { ...createBrowserHost(), async saveFile() {}, reportError(error: unknown) { w.__errors.push(error); } };
    w.__handle = await mountEditor(document.getElementById('root')!, { host, profile: 'pro', locale: 'en', theme: 'dark' });
    await w.__handle.newProject({ name: 'CMYK pixels', width: 64, height: 64 });
    const pixels = new Uint8Array(64 * 64 * 4);
    for (let at = 0; at < pixels.length; at += 4) pixels.set([255, 0, 0, 255], at);
    w.__editorForTests.session.insertRaster(Raster.fromPixels(64, 64, 4, pixels), 'Saturated RGB red');
  });
  await page.waitForFunction(() => !!(window as any).__editorForTests?.canvasView?.gpu);
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
}

async function screenshotPixels(page: Page): Promise<number[]> {
  const box = await page.getByTestId('editor-canvas').boundingBox();
  if (!box) throw new Error('Canvas has no bounds.');
  const side = Math.min(256, box.width, box.height);
  const png = await page.screenshot({ clip: { x: box.x + (box.width - side) / 2, y: box.y + (box.height - side) / 2, width: side, height: side } });
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    return Array.from(context.getImageData(0, 0, bitmap.width, bitmap.height).data);
  }, png.toString('base64'));
}

test('Proof Colors changes displayed pixels and Gamut Warning marks saturated RGB', async ({ page }) => {
  test.setTimeout(180_000);
  await mountPro(page);
  const original = await screenshotPixels(page);
  await page.getByTestId('menu-View').click();
  await page.getByTestId('menu-proof-setup').click();
  await expect(page.getByTestId('proof-setup-dialog')).toBeVisible();
  await page.getByTestId('proof-profile').selectOption('swop-approx');
  await page.getByTestId('proof-intent').selectOption('relative-colorimetric');
  await page.getByTestId('proof-paper-white').check();
  await page.getByTestId('proof-apply').click();
  await expect(page.getByTestId('proof-setup-dialog')).toBeHidden({ timeout: 60_000 });
  await page.getByTestId('menu-View').click();
  await page.getByTestId('menu-proof-colors').click();
  await page.waitForFunction(() => (window as any).__editorForTests.session.proofColors === true);
  await page.evaluate(() => { (window as any).__editorForTests.canvasView.renderNow(); });
  const proofed = await screenshotPixels(page);
  let changed = 0;
  for (let at = 0; at < original.length; at += 4) {
    if (Math.abs(original[at]! - proofed[at]!) + Math.abs(original[at + 1]! - proofed[at + 1]!) + Math.abs(original[at + 2]! - proofed[at + 2]!) > 6) changed++;
  }
  expect(changed).toBeGreaterThan(1_000);

  await page.getByTestId('menu-View').click();
  await page.getByTestId('menu-gamut-warning').click();
  await page.waitForFunction(() => (window as any).__editorForTests.session.gamutWarning === true);
  const warningMax = await page.evaluate(() => {
    const controller = (window as any).__editorForTests;
    controller.canvasView.renderNow();
    let maximum = 0; for (let at = 3; at < controller.session.proofLut.proof.length; at += 4) maximum = Math.max(maximum, controller.session.proofLut.proof[at]);
    return maximum;
  });
  expect(warningMax).toBeGreaterThan(38);
  const warned = await screenshotPixels(page);
  let magenta = 0;
  for (let at = 0; at < warned.length; at += 4) if (warned[at]! > 130 && warned[at + 1]! < 25 && warned[at + 2]! > 130) magenta++;
  expect(magenta).toBeGreaterThan(1_000);
});

test('Export As pipeline emits decodable CMYK TIFF 8/16 and CMYK JPEG with ICC', async ({ page }) => {
  await mountPro(page);
  const result = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const [{ decodeTiffNative }, { decodeJpegSamples }, { readJpegIccProfile }] = await Promise.all([
      load('/src/io/tiff.ts'), load('/src/io/jpeg.ts'), load('/src/io/jpegMeta.ts'),
    ]);
    const controller = (window as any).__editorForTests;
    await controller.ensureProofSetup();
    const profile = controller.session.proofProfile, options = controller.session.proofOptions;
    const cmyk = { profile, intent: options.intent, blackPointCompensation: options.blackPointCompensation };
    const output: any = {};
    for (const bitDepth of [8, 16] as const) {
      try {
        const [file] = await controller.exportFiles(controller.exportRequest('tiff', {
          bitDepth, transparent: false, tiffCompression: 'lzw', cmyk, metadata: { colorProfile: 'embed' },
        }));
        const decoded = await decodeTiffNative(file.bytes);
        output[`tiff${bitDepth}`] = { bitDepth: decoded.bitDepth, hasIcc: decoded.hasIcc,
          pixel: Array.from(decoded.data.slice(0, 4)), bytes: file.bytes.length };
      } catch (error) { throw new Error(`CMYK TIFF ${bitDepth}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    try {
      const [jpeg] = await controller.exportFiles(controller.exportRequest('jpeg', {
        quality: 0.92, transparent: false, cmyk, metadata: { colorProfile: 'embed' },
      }));
      const decodedJpeg = await decodeJpegSamples(jpeg.bytes);
      output.jpeg = { model: decodedJpeg.model, icc: readJpegIccProfile(jpeg.bytes)?.length ?? 0,
        pixel: Array.from(decodedJpeg.data.slice(0, 4)), bytes: jpeg.bytes.length };
    } catch (error) { throw new Error(`CMYK JPEG: ${error instanceof Error ? error.message : String(error)}`); }
    return output;
  });
  expect(result.tiff8).toMatchObject({ bitDepth: 8, hasIcc: true });
  expect(result.tiff16).toMatchObject({ bitDepth: 16, hasIcc: true });
  expect(result.jpeg.model).toBe('cmyk');
  expect(result.jpeg.icc).toBeGreaterThan(128);
  expect(result.tiff8.pixel).toHaveLength(4);
  expect(result.tiff16.pixel).toHaveLength(4);
  expect(result.jpeg.pixel).toHaveLength(4);
  expect(result.jpeg.bytes).toBeGreaterThan(500);
});

test('a user-loaded CMYK ICC drives the exact proof LUT and export profile', async ({ page }) => {
  await mountPro(page);
  const bytes = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const lcms = await (await load('/src/wasm/lcms/index.ts')).loadLittleCms();
    return Array.from(lcms.createCmykProfile()) as number[];
  });
  await page.getByTestId('menu-View').click();
  await page.getByTestId('menu-proof-setup').click();
  await page.getByTestId('proof-icc-file').setInputFiles({ name: 'Press Output.icc', mimeType: 'application/vnd.iccprofile',
    buffer: Buffer.from(bytes) });
  await expect(page.getByTestId('proof-profile')).toHaveValue('user');
  await page.getByTestId('proof-apply').click();
  await expect(page.getByTestId('proof-setup-dialog')).toHaveCount(0);
  const result = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const controller = (window as any).__editorForTests, session = controller.session;
    const lcms = await (await load('/src/wasm/lcms/index.ts')).loadLittleCms();
    const rgb = new Uint8Array([0, 0, 0, 255, 128, 64, 192, 255, 255, 255, 255, 255]);
    lcms.transformRgbToCmykInPlace(session.proofProfile.icc, rgb, session.proofOptions.intent,
      session.proofOptions.blackPointCompensation);
    const [file] = await controller.exportFiles(controller.exportRequest('tiff', { transparent: false,
      cmyk: { profile: session.proofProfile, intent: session.proofOptions.intent,
        blackPointCompensation: session.proofOptions.blackPointCompensation }, metadata: { colorProfile: 'embed' } }));
    const { decodeTiffNative } = await load('/src/io/tiff.ts');
    const decoded = await decodeTiffNative(file.bytes);
    return { name: session.proofProfile.name, exactDevice: Array.from(rgb), hasIcc: decoded.hasIcc,
      exportedProfile: Array.from(session.proofProfile.icc) };
  });
  expect(result.name).toBe('Press Output');
  expect(result.exactDevice).not.toEqual([0, 0, 0, 255, 128, 64, 192, 255, 255, 255, 255, 255]);
  expect(result.hasIcc).toBe(true);
  expect(result.exportedProfile).toEqual(bytes);
});
