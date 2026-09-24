import { expect, test, type Page } from '@playwright/test';
import { decodePng, encodePng } from '../../src/io/png';
import { composite, specialFill, type RGB } from '../qa-tools/blendRef';

/**
 * QA: all 27 blend modes against an independent reference (tests/qa-tools/blendRef.ts, W3C + Photoshop formulas).
 * Bottom layer: 8 backdrop colours × {opaque, alpha 128}; top layer: 8 source colours × {opaque, alpha 153}; every
 * combination is a 3×3 cell. Checked on the exported PNG (GPU renderer read-back) and on the CPU compositor.
 */
test.use({ viewport: { width: 1280, height: 800 } });

const CELL = 3;
const BACK: [number, number, number][] = [[0, 0, 0], [255, 255, 255], [48, 130, 205], [200, 33, 90], [128, 128, 128], [12, 240, 118], [66, 64, 60], [250, 180, 20]];
const SRC: [number, number, number][] = [[255, 0, 0], [0, 0, 255], [102, 153, 49], [230, 229, 20], [128, 128, 128], [30, 60, 90], [255, 255, 255], [0, 0, 0]];
const BACK_ALPHA = [255, 128], SRC_ALPHA = [255, 153];
const ROWS = BACK.length * BACK_ALPHA.length, COLS = SRC.length * SRC_ALPHA.length;
const W = COLS * CELL, H = ROWS * CELL;

function gridPng(cellColour: (row: number, col: number) => [number, number, number, number]): Buffer {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set(cellColour(Math.floor(y / CELL), Math.floor(x / CELL)), (y * W + x) * 4);
  return Buffer.from(encodePng(data, W, H, 4));
}
const backOf = (row: number) => ({ c: BACK[row % BACK.length]!, a: BACK_ALPHA[Math.floor(row / BACK.length)]! });
const srcOf = (col: number) => ({ c: SRC[col % SRC.length]!, a: SRC_ALPHA[Math.floor(col / SRC.length)]! });
const bottom = gridPng((r) => { const b = backOf(r); return [...b.c, b.a]; });
const top = gridPng((_r, c) => { const s = srcOf(c); return [...s.c, s.a]; });

const MODES = ['normal', 'dissolve', 'darken', 'multiply', 'colorBurn', 'linearBurn', 'darkerColor', 'lighten', 'screen',
  'colorDodge', 'linearDodge', 'lighterColor', 'overlay', 'softLight', 'hardLight', 'vividLight', 'linearLight', 'pinLight',
  'hardMix', 'difference', 'exclusion', 'subtract', 'divide', 'hue', 'saturation', 'color', 'luminosity'];

async function build(page: Page, width: number, height: number, layers: { png: Buffer; name: string }[]): Promise<string[]> {
  await page.goto('/?harness=qa-blend');
  return page.evaluate(async ({ width, height, layers }) => {
    const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
    const { mountEditor } = await load('/src/index.ts');
    const w = window as any;
    const host = { async chooseImages() { return []; }, async chooseProject() { return null; }, async saveFile() {}, reportError() {} };
    w.__handle = await mountEditor(document.getElementById('root')!, { host });
    await w.__handle.newProject({ name: 'blend', width, height });
    const ids: string[] = [];
    for (const layer of layers) ids.push(await w.__handle.importImage(new Blob([Uint8Array.from(atob(layer.b64), (c) => c.charCodeAt(0))]), layer.name));
    return ids;
  }, { width, height, layers: layers.map((l) => ({ name: l.name, b64: l.png.toString('base64') })) });
}

async function setAppearance(page: Page, id: string, mode: string, opacity = 1, fill = 1): Promise<void> {
  await page.evaluate(({ id, mode, opacity, fill }) => {
    const s = (window as any).__editorForTests.session;
    s.selectLayer(id);
    s.setLayerBlendMode(mode);
    s.setLayerOpacity(opacity);
    s.setFillOpacity([id], fill);
  }, { id, mode, opacity, fill });
}

/** Exported PNG (GPU read-back) and the CPU compositor, both as straight RGBA8. */
async function render(page: Page): Promise<{ exported: Uint8Array; cpu: Uint8Array; width: number; height: number }> {
  const out = await page.evaluate(async () => {
    const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
    const { compositeRegion } = await load('/src/core/composite.ts');
    const { applyAdjustment } = await load('/src/core/adjust/apply.ts');
    const s = (window as any).__editorForTests.session;
    const doc = s.document;
    const blob: Blob = await (window as any).__handle.exportImage({ format: 'png' });
    const toB64 = (bytes: Uint8Array) => { let t = ''; for (let i = 0; i < bytes.length; i += 0x8000) t += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(t); };
    const cpu = compositeRegion(doc, { x: 0, y: 0, width: doc.width, height: doc.height }, { adjust: applyAdjustment }).rgba as Uint8Array;
    return { png: toB64(new Uint8Array(await blob.arrayBuffer())), cpu: toB64(cpu), width: doc.width, height: doc.height };
  });
  const png = decodePng(new Uint8Array(Buffer.from(out.png, 'base64'))) as any;
  const data: Uint8Array = png.pixels ?? png.data;
  const channels = png.channels ?? data.length / (png.width * png.height);
  const exported = new Uint8Array(out.width * out.height * 4);
  for (let i = 0; i < out.width * out.height; i++) {
    for (let c = 0; c < 3; c++) exported[i * 4 + c] = data[i * channels + (channels >= 3 ? c : 0)]!;
    exported[i * 4 + 3] = channels === 4 || channels === 2 ? data[i * channels + channels - 1]! : 255;
  }
  return { exported, cpu: new Uint8Array(Buffer.from(out.cpu, 'base64')), width: out.width, height: out.height };
}

/** Largest colour error (in 1/255) over cells where the result is not nearly transparent, plus the worst cell. */
function worst(pixels: Uint8Array, width: number, expected: (row: number, col: number) => [number, number, number, number] | null) {
  let max = 0, at = '';
  for (let row = 0; row < ROWS; row++) for (let col = 0; col < COLS; col++) {
    const e = expected(row, col);
    if (!e) continue;
    const o = ((row * CELL + 1) * width + col * CELL + 1) * 4;
    const got = [pixels[o]!, pixels[o + 1]!, pixels[o + 2]!, pixels[o + 3]!];
    const want = e.map((v, i) => (i < 3 ? v * 255 : v * 255));
    const da = Math.abs(got[3]! - want[3]!);
    // Premultiplied storage makes straight colour at alpha < 1 imprecise: compare premultiplied colour.
    const dc = Math.max(...[0, 1, 2].map((i) => Math.abs(got[i]! * got[3]! / 255 - want[i]! * want[3]! / 255)));
    const d = Math.max(da, dc);
    if (d > max) { max = d; at = `back ${JSON.stringify(backOf(row))} src ${JSON.stringify(srcOf(col))} got ${got} want ${want.map((v) => v.toFixed(1))}`; }
  }
  return { max, at };
}

const n = (v: number) => v / 255;
/**
 * Cells where the published formulas do not decide the result: Hard Mix ties (b + s = 1, rounding decides) and the
 * Vivid Light 0/0 endpoints (black base under a white blend, white base under a black blend), which the team
 * calibrated against Photoshop's own composites to resolve to the blend colour.
 */
function ambiguous(mode: string, b: number[], s: number[]): boolean {
  if (mode === 'hardMix') return b.some((v, i) => Math.abs(v + s[i]! - 255) <= 2);
  if (mode === 'vividLight') return b.some((v, i) => (v === 0 && s[i] === 255) || (v === 255 && s[i] === 0));
  return false;
}
for (const mode of MODES.filter((m) => m !== 'dissolve')) {
  test(`QA blend ${mode}: export and CPU match the W3C/Photoshop reference, incl. semi-transparent layers`, async ({ page }) => {
    const [bottomId, topId] = await build(page, W, H, [{ png: bottom, name: 'bottom' }, { png: top, name: 'top' }]);
    await setAppearance(page, topId!, mode, 0.8);
    const { exported, cpu, width } = await render(page);
    const expected = (row: number, col: number) => {
      const b = backOf(row), s = srcOf(col);
      if (ambiguous(mode, b.c, s.c)) return null;
      // Darker/Lighter Color compare luminance: skip near-ties.
      const l = (c: number[]) => 0.3 * c[0]! + 0.59 * c[1]! + 0.11 * c[2]!;
      if ((mode === 'darkerColor' || mode === 'lighterColor') && Math.abs(l(b.c) - l(s.c)) < 2) return null;
      return composite(mode, b.c.map(n) as RGB, n(b.a), s.c.map(n) as RGB, n(s.a) * 0.8);
    };
    const e = worst(exported, width, expected), c = worst(cpu, width, expected);
    console.log(`QA blend ${mode}: export max ${e.max.toFixed(1)} ${e.at}; cpu max ${c.max.toFixed(1)} ${c.at}`);
    expect.soft(e.max, `export: ${e.at}`).toBeLessThanOrEqual(3);
    expect.soft(c.max, `cpu: ${c.at}`).toBeLessThanOrEqual(3);
    void bottomId;
  });
}

test('QA blend dissolve: opaque source equals Normal; alpha 153 shows the pure source colour on about 60 % of pixels', async ({ page }) => {
  const size = 64;
  const back = Buffer.from(encodePng(new Uint8Array(size * size * 4).map((_, i) => [0, 0, 255, 255][i % 4]!), size, size, 4));
  const front = Buffer.from(encodePng(new Uint8Array(size * size * 4).map((_, i) => [255, 0, 0, 153][i % 4]!), size, size, 4));
  const [, topId] = await build(page, size, size, [{ png: back, name: 'back' }, { png: front, name: 'front' }]);
  await setAppearance(page, topId!, 'dissolve');
  const { exported, cpu } = await render(page);
  for (const [name, px] of [['export', exported], ['cpu', cpu]] as const) {
    let red = 0, blue = 0, other = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] === 255 && px[i + 2] === 0) red++; else if (px[i] === 0 && px[i + 2] === 255) blue++; else other++;
    }
    console.log(`QA dissolve ${name}: red ${red}, blue ${blue}, other ${other}`);
    expect(other).toBe(0);
    expect(red / (size * size)).toBeGreaterThan(0.54);
    expect(red / (size * size)).toBeLessThan(0.66);
  }
});

// Photoshop's Fill differs from Opacity for eight modes: e.g. Linear Dodge at Fill 50 % adds half the source.
for (const mode of ['colorBurn', 'linearBurn', 'colorDodge', 'linearDodge', 'vividLight', 'linearLight', 'hardMix', 'difference', 'multiply', 'screen']) {
  test(`QA fill vs opacity ${mode}: Fill 50 % follows Photoshop's rule, Opacity 50 % a plain mix`, async ({ page }) => {
    const [, topId] = await build(page, W, H, [{ png: bottom, name: 'bottom' }, { png: top, name: 'top' }]);
    const opaqueOnly = (row: number, col: number) => backOf(row).a === 255 && srcOf(col).a === 255;
    await setAppearance(page, topId!, mode, 1, 0.5);
    const fill = await render(page);
    await setAppearance(page, topId!, mode, 0.5, 1);
    const opacity = await render(page);
    const fillExpected = (row: number, col: number): [number, number, number, number] | null => {
      if (!opaqueOnly(row, col)) return null;
      const b = backOf(row).c.map(n), s = srcOf(col).c.map(n);
      const special = ['colorBurn', 'linearBurn', 'colorDodge', 'linearDodge', 'vividLight', 'linearLight', 'hardMix', 'difference'].includes(mode);
      if (!special) return composite(mode, b as RGB, 1, s as RGB, 0.5);
      const v = b.map((bv, i) => specialFill(mode, bv, s[i]!, 0.5));
      return v.some((x) => x === null) ? null : [v[0]!, v[1]!, v[2]!, 1];
    };
    const opacityExpected = (row: number, col: number) => opaqueOnly(row, col) && !ambiguous(mode, backOf(row).c, srcOf(col).c)
      ? composite(mode, backOf(row).c.map(n) as RGB, 1, srcOf(col).c.map(n) as RGB, 0.5) : null;
    const f = worst(fill.exported, fill.width, fillExpected), fc = worst(fill.cpu, fill.width, fillExpected);
    const o = worst(opacity.exported, opacity.width, opacityExpected);
    console.log(`QA fill ${mode}: fill export ${f.max.toFixed(1)} ${f.at} | fill cpu ${fc.max.toFixed(1)} | opacity export ${o.max.toFixed(1)} ${o.at}`);
    expect.soft(f.max, `fill export: ${f.at}`).toBeLessThanOrEqual(3);
    expect.soft(fc.max, 'fill cpu').toBeLessThanOrEqual(3);
    expect.soft(o.max, `opacity export: ${o.at}`).toBeLessThanOrEqual(3);
    if (['vividLight', 'hardMix'].includes(mode)) {
      // No closed-form reference: Fill must at least differ from Opacity somewhere (Photoshop's special behaviour).
      let differs = 0;
      for (let i = 0; i < fill.exported.length; i++) if (Math.abs(fill.exported[i]! - opacity.exported[i]!) > 3) differs++;
      expect(differs).toBeGreaterThan(0);
    }
  });
}

/**
 * Colour Burn/Dodge amplify backdrop errors by 1/s. Over a semi-transparent backdrop an 8-bit premultiplied layer
 * texture loses the backdrop colour's precision; the CPU compositor does not. Measures export (GPU) vs reference.
 */
for (const [mode, backColour, srcColour] of [['colorBurn', 250, 10], ['colorDodge', 5, 245]] as const) {
  test(`QA bug: GPU ${mode} over a semi-transparent layer deviates from the CPU compositor and the reference`, async ({ page }) => {
    const alphas = [6, 12, 24, 48, 96, 160];
    const w = alphas.length * CELL, h = CELL;
    const px = (fn: (i: number) => number[]) => {
      const data = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fn(Math.floor(x / CELL)), (y * w + x) * 4);
      return Buffer.from(encodePng(data, w, h, 4));
    };
    const [, topId] = await build(page, w, h, [
      { png: px((i) => [backColour, backColour, backColour, alphas[i]!]), name: 'back' },
      { png: px(() => [srcColour, srcColour, srcColour, 255]), name: 'front' }]);
    await setAppearance(page, topId!, mode);
    const { exported, cpu } = await render(page);
    let gpuMax = 0, cpuMax = 0;
    const lines: string[] = [];
    alphas.forEach((a, i) => {
      const [r] = composite(mode, [n(backColour), n(backColour), n(backColour)], n(a), [n(srcColour), n(srcColour), n(srcColour)], 1);
      const o = (w + i * CELL + 1) * 4;
      gpuMax = Math.max(gpuMax, Math.abs(exported[o]! - r * 255));
      cpuMax = Math.max(cpuMax, Math.abs(cpu[o]! - r * 255));
      lines.push(`alpha ${a}: ref ${(r * 255).toFixed(1)} export ${exported[o]} cpu ${cpu[o]}`);
    });
    console.log(`QA ${mode} precision:\n  ${lines.join('\n  ')}`);
    expect(cpuMax).toBeLessThanOrEqual(1.5);
    expect(gpuMax).toBeLessThanOrEqual(2);
  });
}

test('QA blend menu: hovering previews a mode, Escape restores it, a click sets it as one undo step', async ({ page }) => {
  const { mountForTest, importThroughMenu, solidPng } = await import('./helpers');
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('60');
  await page.getByTestId('heightInput').fill('40');
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'top.png', mimeType: 'image/png', buffer: solidPng(60, 40, [0, 128, 255, 255]) }]);
  await expect(page.getByTestId('layer-row')).toHaveCount(2);
  await page.getByTestId('layer-row').first().click();
  const state = () => page.evaluate(() => {
    const s = (window as any).__editorForTests.session;
    return { stored: s.activeLayer.blendMode, shown: s.displayedBlendMode(s.activeLayer), steps: s.history.undoCount };
  });
  const start = await state();
  await page.getByTestId('blend-mode').click();
  await page.getByRole('menuitem', { name: 'Multiply' }).hover();
  await expect.poll(async () => (await state()).shown).toBe('multiply');
  expect((await state()).stored).toBe('normal');
  await page.keyboard.press('Escape');
  await expect.poll(state).toEqual(start);
  await page.getByTestId('blend-mode').click();
  await page.getByRole('menuitem', { name: 'Screen' }).click();
  await expect.poll(state).toEqual({ stored: 'screen', shown: 'screen', steps: start.steps + 1 });
  await expect(page.getByTestId('blend-mode')).toHaveText('Screen');
});

test('QA fill: the eight special Fill modes at 50 % render the same in the export (GPU) as on the CPU, incl. semi-transparent pixels', async ({ page }) => {
  const [, topId] = await build(page, W, H, [{ png: bottom, name: 'bottom' }, { png: top, name: 'top' }]);
  const lines: string[] = [];
  let worstAll = 0;
  for (const mode of ['colorBurn', 'linearBurn', 'colorDodge', 'linearDodge', 'vividLight', 'linearLight', 'hardMix', 'difference']) {
    await setAppearance(page, topId!, mode, 1, 0.5);
    const { exported, cpu } = await render(page);
    let max = 0, at = -1;
    for (let i = 0; i < exported.length; i += 4) {
      const a = exported[i + 3]! / 255, b = cpu[i + 3]! / 255;
      for (let c = 0; c < 3; c++) { const d = Math.abs(exported[i + c]! * a - cpu[i + c]! * b); if (d > max) { max = d; at = i; } }
      const da = Math.abs(exported[i + 3]! - cpu[i + 3]!); if (da > max) { max = da; at = i; }
    }
    const x = (at / 4) % W, y = Math.floor(at / 4 / W);
    lines.push(`${mode}: max ${max.toFixed(1)} at back ${JSON.stringify(backOf(Math.floor(y / CELL)))} src ${JSON.stringify(srcOf(Math.floor(x / CELL)))} export ${Array.from(exported.slice(at, at + 4))} cpu ${Array.from(cpu.slice(at, at + 4))}`);
    worstAll = Math.max(worstAll, max);
  }
  console.log('QA fill GPU vs CPU\n  ' + lines.join('\n  '));
  // Premultiplied 8-bit layer textures cost a little precision over semi-transparent pixels; 3/255 is visually nil.
  expect(worstAll).toBeLessThanOrEqual(3);
});
